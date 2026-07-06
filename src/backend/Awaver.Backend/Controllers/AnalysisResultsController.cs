using System.Text.Json;
using Awaver.Backend.Services;
using Microsoft.AspNetCore.Mvc;

namespace Awaver.Backend.Controllers;

[ApiController]
[Route("api/sessions/{sessionId:guid}")]
public sealed class AnalysisResultsController(
    ISessionRepository sessions,
    AnalysisResultBroadcaster broadcaster) : ControllerBase
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
            type is not ("drowsiness_score" or "tracking_status"))
        {
            return BadRequest("type must be drowsiness_score or tracking_status.");
        }

        if (!TryGetString(payload, "sessionId", out var payloadSessionId) ||
            !Guid.TryParse(payloadSessionId, out var parsedSessionId) ||
            parsedSessionId != sessionId)
        {
            return BadRequest("sessionId must match the route sessionId.");
        }

        var json = JsonSerializer.Serialize(payload, JsonOptions);
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
