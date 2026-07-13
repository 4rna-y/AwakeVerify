using System.Text.Json;
using Awaver.Backend.Hubs;
using Awaver.Backend.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;

namespace Awaver.Backend.Controllers;

[ApiController]
[Route("api/sessions/{sessionId:guid}")]
public sealed class AnalysisResultsController(
    ISessionRepository sessions,
    AnalysisResultBroadcaster broadcaster,
    IHubContext<AnalysisEventsHub> hubContext) : ControllerBase
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    [HttpGet("analysis-events")]
    public async Task GetAnalysisEvents(Guid sessionId, CancellationToken cancellationToken)
    {
        if (!await sessions.SessionExistsAsync(sessionId, cancellationToken))
        {
            Response.StatusCode = StatusCodes.Status404NotFound;
            await Response.WriteAsync("Session not found.", cancellationToken);
            return;
        }

        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";
        Response.ContentType = "text/event-stream";

        var reader = broadcaster.Subscribe(sessionId, out var subscriptionId);
        try
        {
            await Response.WriteAsync(": connected\n\n", cancellationToken);
            await Response.Body.FlushAsync(cancellationToken);

            await foreach (var json in reader.ReadAllAsync(cancellationToken))
            {
                await Response.WriteAsync($"data: {json}\n\n", cancellationToken);
                await Response.Body.FlushAsync(cancellationToken);
            }
        }
        finally
        {
            broadcaster.Unsubscribe(sessionId, subscriptionId);
        }
    }

    [HttpPost("analysis-results")]
    [ProducesResponseType(StatusCodes.Status202Accepted)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> PublishAnalysisResult(
        Guid sessionId,
        JsonElement payload,
        CancellationToken cancellationToken)
    {
        if (!await sessions.SessionExistsAsync(sessionId, cancellationToken))
        {
            return NotFound("Session not found.");
        }

        if (payload.ValueKind != JsonValueKind.Object)
        {
            return BadRequest("Analysis result must be a JSON object.");
        }

        if (!TryGetString(payload, "type", out var type) ||
            type is not ("drowsiness_score" or "tracking_status" or "calibration_status"))
        {
            return BadRequest("type must be drowsiness_score, tracking_status, or calibration_status.");
        }

        if (!TryGetString(payload, "sessionId", out var payloadSessionId) ||
            !Guid.TryParse(payloadSessionId, out var parsedSessionId) ||
            parsedSessionId != sessionId)
        {
            return BadRequest("sessionId must match the route sessionId.");
        }

        var json = JsonSerializer.Serialize(payload, JsonOptions);

        // SignalR is the primary delivery path; the SSE broadcaster is kept as a fallback for
        // local tooling (e.g. the /test pipeline page) that has not migrated off EventSource.
        await hubContext.Clients.Group(AnalysisEventsHub.GroupName(sessionId))
            .SendAsync(AnalysisEventsHub.ReceiveAnalysisEventMethod, payload, cancellationToken);
        var subscribers = broadcaster.Publish(sessionId, json);

        return Accepted(new { subscribers });
    }

    private static bool TryGetString(JsonElement payload, string propertyName, out string value)
    {
        value = string.Empty;
        return payload.TryGetProperty(propertyName, out var property) &&
            property.ValueKind == JsonValueKind.String &&
            !string.IsNullOrWhiteSpace(value = property.GetString() ?? string.Empty);
    }
}
