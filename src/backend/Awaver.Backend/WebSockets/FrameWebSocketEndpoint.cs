using System.Net.WebSockets;
using System.Text;
using Awaver.Backend.Services;

namespace Awaver.Backend.WebSockets;

public static class FrameWebSocketEndpoint
{
    private const int ReceiveBufferSize = 64 * 1024;

    public static async Task HandleAsync(
        HttpContext context,
        Guid sessionId,
        ISessionRepository sessions,
        FramePipeline pipeline,
        ILoggerFactory loggerFactory,
        CancellationToken cancellationToken)
    {
        var logger = loggerFactory.CreateLogger("FrameWebSocketEndpoint");

        if (!context.WebSockets.IsWebSocketRequest)
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            await context.Response.WriteAsync("WebSocket request is required.", cancellationToken);
            return;
        }

        if (!await sessions.SessionExistsAsync(sessionId, cancellationToken))
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            await context.Response.WriteAsync("Session not found.", cancellationToken);
            return;
        }

        using var webSocket = await context.WebSockets.AcceptWebSocketAsync();
        var buffer = new byte[ReceiveBufferSize];

        while (!cancellationToken.IsCancellationRequested && webSocket.State == WebSocketState.Open)
        {
            var message = await ReceiveTextMessageAsync(webSocket, buffer, cancellationToken);
            if (message is null)
            {
                break;
            }

            var receivedAt = DateTimeOffset.UtcNow;
            if (!FrameMessageParser.TryParse(message, sessionId, receivedAt, out var frame, out var error))
            {
                logger.LogWarning("Invalid frame message for session {SessionId}: {Error}", sessionId, error);
                await CloseAsync(webSocket, WebSocketCloseStatus.InvalidPayloadData, error ?? "Invalid frame message.", cancellationToken);
                return;
            }

            await pipeline.HandleAsync(frame!, cancellationToken);
        }
    }

    private static async Task<string?> ReceiveTextMessageAsync(
        WebSocket webSocket,
        byte[] buffer,
        CancellationToken cancellationToken)
    {
        using var stream = new MemoryStream();

        while (true)
        {
            var result = await webSocket.ReceiveAsync(buffer, cancellationToken);

            if (result.MessageType == WebSocketMessageType.Close)
            {
                await CloseAsync(webSocket, WebSocketCloseStatus.NormalClosure, "Closed by client.", cancellationToken);
                return null;
            }

            if (result.MessageType != WebSocketMessageType.Text)
            {
                await CloseAsync(webSocket, WebSocketCloseStatus.InvalidMessageType, "Only text JSON messages are supported.", cancellationToken);
                return null;
            }

            stream.Write(buffer, 0, result.Count);

            if (result.EndOfMessage)
            {
                return Encoding.UTF8.GetString(stream.ToArray());
            }
        }
    }

    private static Task CloseAsync(WebSocket webSocket, WebSocketCloseStatus status, string description, CancellationToken cancellationToken)
    {
        return webSocket.State == WebSocketState.Open
            ? webSocket.CloseAsync(status, description, cancellationToken)
            : Task.CompletedTask;
    }
}
