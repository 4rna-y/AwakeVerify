using System.Net.WebSockets;
using System.Security.Claims;
using System.Text;
using Awaver.Backend.Services;

namespace Awaver.Backend.WebSockets;

public static class FrameWebSocketEndpoint
{
    private const int ReceiveBufferSize = 64 * 1024;
    private const int MaxMessageBytes = 2 * 1024 * 1024;

    public static async Task HandleAsync(HttpContext context, Guid sessionId, ISessionRepository sessions, FramePipeline pipeline, AuthSessionService authSessions, ILoggerFactory loggerFactory, CancellationToken cancellationToken)
    {
        var logger = loggerFactory.CreateLogger("FrameWebSocketEndpoint");
        if (!context.WebSockets.IsWebSocketRequest)
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            await context.Response.WriteAsync("WebSocket request is required.", cancellationToken);
            return;
        }
        if (context.User.Identity?.IsAuthenticated != true)
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }
        if (!context.User.IsInRole(AuthSessionService.StudentRole) ||
            !Guid.TryParse(context.User.FindFirstValue("learning_session_id"), out var authorizedSessionId) || authorizedSessionId != sessionId)
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }
        if (!await sessions.SessionExistsAsync(sessionId, cancellationToken))
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }
        if (!Guid.TryParse(context.User.FindFirstValue("auth_session_id"), out var authSessionId) ||
            await authSessions.ValidateAndRefreshAsync(authSessionId, cancellationToken) is null)
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }

        using var webSocket = await context.WebSockets.AcceptWebSocketAsync();
        var buffer = new byte[ReceiveBufferSize];
        while (!cancellationToken.IsCancellationRequested && webSocket.State == WebSocketState.Open)
        {
            if (await authSessions.ValidateAndRefreshAsync(authSessionId, cancellationToken) is null)
            {
                await CloseAsync(webSocket, WebSocketCloseStatus.PolicyViolation, "The student session is no longer active.", cancellationToken);
                return;
            }
            var message = await ReceiveTextMessageAsync(webSocket, buffer, cancellationToken);
            if (message is null) break;
            var receivedAt = DateTimeOffset.UtcNow;
            if (!FrameMessageParser.TryParse(message, sessionId, receivedAt, out var frame, out var error))
            {
                logger.LogWarning("Invalid frame message for session {SessionId}: {Error}", sessionId, error);
                await CloseAsync(webSocket, WebSocketCloseStatus.InvalidPayloadData, error ?? "Invalid frame message.", cancellationToken);
                return;
            }
            var acceptedFrame = frame!;
            try
            {
                await pipeline.HandleAsync(acceptedFrame, cancellationToken);
                await SendProtocolMessageAsync(webSocket, new { type = "frame_ack", sequenceNo = acceptedFrame.SequenceNo }, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception pipelineError)
            {
                logger.LogWarning(pipelineError, "Unable to enqueue frame {SequenceNo} for session {SessionId}", sessionId, acceptedFrame.SequenceNo);
                await SendProtocolMessageAsync(webSocket, new { type = "frame_nack", sequenceNo = acceptedFrame.SequenceNo, retryable = true }, cancellationToken);
            }
        }
    }

    private static async Task<string?> ReceiveTextMessageAsync(WebSocket webSocket, byte[] buffer, CancellationToken cancellationToken)
    {
        using var stream = new MemoryStream();
        while (true)
        {
            var result = await webSocket.ReceiveAsync(buffer, cancellationToken);
            if (result.MessageType == WebSocketMessageType.Close) { await CloseAsync(webSocket, WebSocketCloseStatus.NormalClosure, "Closed by client.", cancellationToken); return null; }
            if (result.MessageType != WebSocketMessageType.Text) { await CloseAsync(webSocket, WebSocketCloseStatus.InvalidMessageType, "Only text JSON messages are supported.", cancellationToken); return null; }
            if (stream.Length + result.Count > MaxMessageBytes)
            {
                await CloseAsync(webSocket, WebSocketCloseStatus.MessageTooBig, "Frame message is too large.", cancellationToken);
                return null;
            }
            stream.Write(buffer, 0, result.Count);
            if (result.EndOfMessage)
            {
                try
                {
                    return new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true).GetString(stream.ToArray());
                }
                catch (DecoderFallbackException)
                {
                    await CloseAsync(webSocket, WebSocketCloseStatus.InvalidPayloadData, "Frame message must be valid UTF-8.", cancellationToken);
                    return null;
                }
            }
        }
    }

    private static async Task SendProtocolMessageAsync(WebSocket webSocket, object message, CancellationToken cancellationToken)
    {
        var payload = Encoding.UTF8.GetBytes(System.Text.Json.JsonSerializer.Serialize(message));
        await webSocket.SendAsync(payload, WebSocketMessageType.Text, endOfMessage: true, cancellationToken);
    }

    private static Task CloseAsync(WebSocket webSocket, WebSocketCloseStatus status, string description, CancellationToken cancellationToken) =>
        webSocket.State == WebSocketState.Open ? webSocket.CloseAsync(status, description, cancellationToken) : Task.CompletedTask;
}
