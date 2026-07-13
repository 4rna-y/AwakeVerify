using Awaver.Backend.Data;
using Awaver.Backend.Dto;
using Awaver.Backend.Models;
using Awaver.Backend.Services;
using Microsoft.AspNetCore.Mvc;

namespace Awaver.Backend.Controllers;

[ApiController]
[Route("api/sessions")]
public sealed class SessionsController(ISessionRepository sessions, AwaverDbContext dbContext) : ControllerBase
{
    [HttpPost]
    [ProducesResponseType<StartSessionResponse>(StatusCodes.Status201Created)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<StartSessionResponse>> StartSession(
        StartSessionRequest request,
        CancellationToken cancellationToken)
    {
        var studentId = request.StudentId.Trim();
        if (studentId.Length == 0)
        {
            return ValidationProblem("studentId is required.");
        }

        var session = await sessions.StartSessionAsync(studentId, cancellationToken);
        var response = new StartSessionResponse(session.SessionId);

        return Created($"/api/sessions/{session.SessionId}", response);
    }

    [HttpPost("{sessionId:guid}/playback-events")]
    [ProducesResponseType(StatusCodes.Status201Created)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> CreatePlaybackEvent(
        Guid sessionId,
        CreatePlaybackEventRequest request,
        CancellationToken cancellationToken)
    {
        if (!await sessions.SessionExistsAsync(sessionId, cancellationToken))
        {
            return NotFound("Session not found.");
        }

        var type = request.Type?.Trim();
        if (type is not ("auto_pause" or "resume"))
        {
            return BadRequest("type must be auto_pause or resume.");
        }

        if (request.OccurredAt is null)
        {
            return BadRequest("occurredAt is required.");
        }

        if (request.VideoTimeSec is { } videoTimeSec && (!double.IsFinite(videoTimeSec) || videoTimeSec < 0))
        {
            return BadRequest("videoTimeSec must be greater than or equal to 0 when provided.");
        }

        var playbackEvent = new PlaybackEvent
        {
            EventId = Guid.NewGuid(),
            SessionId = sessionId,
            Type = type,
            OccurredAt = request.OccurredAt.Value.ToUniversalTime(),
            VideoTimeSec = request.VideoTimeSec,
        };

        dbContext.PlaybackEvents.Add(playbackEvent);
        await dbContext.SaveChangesAsync(cancellationToken);

        return Created($"/api/sessions/{sessionId}/playback-events/{playbackEvent.EventId}", null);
    }
}
