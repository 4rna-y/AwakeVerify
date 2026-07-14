using System.Security.Claims;
using Awaver.Backend.Data;
using Awaver.Backend.Dto;
using Awaver.Backend.Models;
using Awaver.Backend.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Awaver.Backend.Controllers;

[ApiController]
[Route("api/sessions")]
public sealed class SessionsController(ISessionRepository sessions, AwaverDbContext dbContext, AuthSessionService authSessions) : ControllerBase
{
    [HttpPost]
    [ProducesResponseType<StartSessionResponse>(StatusCodes.Status201Created)]
    public async Task<ActionResult<StartSessionResponse>> StartSession(StartSessionRequest request, CancellationToken cancellationToken)
    {
        var studentId = request.StudentId.Trim();
        var videoId = request.VideoId?.Trim() ?? "default";
        if (studentId.Length == 0) return ValidationProblem("studentId is required.");
        if (videoId.Length == 0) return ValidationProblem("videoId must not be empty when provided.");
        await authSessions.RevokeCookiesAsync(Request, cancellationToken);
        authSessions.DeleteCookies(Response, Request, AuthCookieOptions.StudentCookieName, AuthCookieOptions.CsrfCookieName);
        var session = await sessions.StartSessionAsync(studentId, videoId, cancellationToken);
        var authSession = await authSessions.CreateAsync(AuthSessionService.StudentRole, session.SessionId.ToString("D"), TimeSpan.FromHours(8), TimeSpan.FromHours(8), cancellationToken);
        authSessions.AppendCookies(Response, authSession);
        return Created($"/api/sessions/{session.SessionId}", new StartSessionResponse(session.SessionId));
    }

    [HttpPost("{sessionId:guid}/playback-events")]
    [Authorize(Roles = AuthSessionService.StudentRole)]
    public async Task<IActionResult> CreatePlaybackEvent(Guid sessionId, CreatePlaybackEventRequest request, CancellationToken cancellationToken)
    {
        if (!Guid.TryParse(User.FindFirstValue("learning_session_id"), out var authorizedSessionId) || authorizedSessionId != sessionId) return Forbid();
        if (!await sessions.SessionExistsAsync(sessionId, cancellationToken)) return NotFound("Session not found.");
        var type = request.Type?.Trim();
        if (type is not ("manual_pause" or "auto_pause" or "resume" or "completed")) return BadRequest("type must be manual_pause, auto_pause, resume, or completed.");
        if (request.OccurredAt is null) return BadRequest("occurredAt is required.");
        if (request.VideoTimeSec is { } videoTimeSec && (!double.IsFinite(videoTimeSec) || videoTimeSec < 0)) return BadRequest("videoTimeSec must be greater than or equal to 0 when provided.");

        if (type == "completed")
        {
            var session = await dbContext.LearningSessions.SingleOrDefaultAsync(item => item.SessionId == sessionId, cancellationToken);
            if (session is null) return NotFound("Session not found.");
            if (session.EndedAt is not null) return NoContent();

            var completedAt = request.OccurredAt.Value.ToUniversalTime();
            var completedEvent = new PlaybackEvent { EventId = Guid.NewGuid(), SessionId = sessionId, Type = type, OccurredAt = completedAt, VideoTimeSec = request.VideoTimeSec };
            session.EndedAt = completedAt;
            dbContext.PlaybackEvents.Add(completedEvent);
            await dbContext.SaveChangesAsync(cancellationToken);
            return Created($"/api/sessions/{sessionId}/playback-events/{completedEvent.EventId}", null);
        }

        var playbackEvent = new PlaybackEvent { EventId = Guid.NewGuid(), SessionId = sessionId, Type = type, OccurredAt = request.OccurredAt.Value.ToUniversalTime(), VideoTimeSec = request.VideoTimeSec };
        dbContext.PlaybackEvents.Add(playbackEvent);
        await dbContext.SaveChangesAsync(cancellationToken);
        return Created($"/api/sessions/{sessionId}/playback-events/{playbackEvent.EventId}", null);
    }
}
