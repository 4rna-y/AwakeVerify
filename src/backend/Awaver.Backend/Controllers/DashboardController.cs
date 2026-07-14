using Awaver.Backend.Data;
using Awaver.Backend.Dto;
using Awaver.Backend.Models;
using Awaver.Backend.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Awaver.Backend.Controllers;

[ApiController]
[Route("api/dashboard/sessions")]
[Authorize(Roles = AuthSessionService.AdminRole)]
public sealed class DashboardController(AwaverDbContext dbContext, IAnalysisConnectionRegistry? connections = null) : ControllerBase
{
    [HttpGet]
    public async Task<ActionResult<IReadOnlyList<DashboardSessionResponse>>> GetSessions(CancellationToken cancellationToken)
    {
        var sessions = await dbContext.LearningSessions
            .AsNoTracking()
            .OrderByDescending(session => session.StartedAt)
            .Select(session => new
            {
                session.SessionId,
                session.StudentId,
                session.VideoId,
                session.StartedAt,
                session.EndedAt,
                LatestLevel = dbContext.DrowsinessScores.Where(score => score.SessionId == session.SessionId)
                    .OrderByDescending(score => score.ScoredAt)
                    .ThenByDescending(score => score.SourceSequenceNo)
                    .Select(score => (DrowsinessLevel?)score.Level)
                    .FirstOrDefault(),
            })
            .ToListAsync(cancellationToken);
        return Ok(sessions.Select(session => new DashboardSessionResponse(
            session.SessionId,
            session.StudentId,
            session.VideoId,
            session.StartedAt,
            session.EndedAt,
            session.LatestLevel?.ToApiValue())).ToList());
    }

    [HttpGet("{sessionId:guid}")]
    public async Task<ActionResult<DashboardSessionDetailResponse>> GetSession(Guid sessionId, CancellationToken cancellationToken)
    {
        var session = await dbContext.LearningSessions
            .AsNoTracking()
            .Where(item => item.SessionId == sessionId)
            .Select(item => new DashboardSessionDetailResponse(item.SessionId, item.StudentId, item.VideoId, item.StartedAt, item.EndedAt))
            .SingleOrDefaultAsync(cancellationToken);
        return session is null ? NotFound("Session not found.") : Ok(session);
    }

    [HttpGet("{sessionId:guid}/scores")]
    public async Task<ActionResult<IReadOnlyList<DashboardScoreResponse>>> GetScores(Guid sessionId, CancellationToken cancellationToken)
    {
        if (!await dbContext.LearningSessions.AsNoTracking().AnyAsync(item => item.SessionId == sessionId, cancellationToken)) return NotFound("Session not found.");
        var scores = await dbContext.DrowsinessScores
            .AsNoTracking()
            .Where(item => item.SessionId == sessionId)
            .OrderBy(item => item.ScoredAt)
            .ThenBy(item => item.SourceSequenceNo)
            .Select(item => new
            {
                item.ScoredAt,
                item.Score,
                item.Level,
                item.Perclos,
                item.Ear,
                item.PitchDeg,
                item.YawDeg,
                item.VideoTimeSec,
            })
            .ToListAsync(cancellationToken);
        return Ok(scores.Select(item => new DashboardScoreResponse(item.ScoredAt, item.Score, item.Level.ToApiValue(), item.Perclos, item.Ear, item.PitchDeg, item.YawDeg, item.VideoTimeSec)).ToList());
    }

    [HttpGet("{sessionId:guid}/playback-events")]
    public async Task<ActionResult<IReadOnlyList<DashboardPlaybackEventResponse>>> GetPlaybackEvents(Guid sessionId, CancellationToken cancellationToken)
    {
        if (!await dbContext.LearningSessions.AsNoTracking().AnyAsync(item => item.SessionId == sessionId, cancellationToken)) return NotFound("Session not found.");
        var events = await dbContext.PlaybackEvents
            .AsNoTracking()
            .Where(item => item.SessionId == sessionId)
            .OrderBy(item => item.OccurredAt)
            .Select(item => new DashboardPlaybackEventResponse(item.EventId, item.Type, item.OccurredAt, item.VideoTimeSec)).ToListAsync(cancellationToken);
        return Ok(events);
    }

    [HttpDelete("{sessionId:guid}")]
    public async Task<IActionResult> DeleteSession(Guid sessionId, CancellationToken cancellationToken)
    {
        var session = await dbContext.LearningSessions.SingleOrDefaultAsync(item => item.SessionId == sessionId, cancellationToken);
        if (session is null) return NotFound("Session not found.");

        var studentAuthSessions = await dbContext.AuthSessions
            .Where(item => item.PrincipalType == AuthSessionService.StudentRole && item.PrincipalId == sessionId.ToString("D"))
            .ToListAsync(cancellationToken);

        dbContext.PlaybackEvents.RemoveRange(await dbContext.PlaybackEvents.Where(item => item.SessionId == sessionId).ToListAsync(cancellationToken));
        dbContext.Calibrations.RemoveRange(await dbContext.Calibrations.Where(item => item.SessionId == sessionId).ToListAsync(cancellationToken));
        dbContext.DrowsinessScores.RemoveRange(await dbContext.DrowsinessScores.Where(item => item.SessionId == sessionId).ToListAsync(cancellationToken));
        dbContext.AnalysisEventOutbox.RemoveRange(await dbContext.AnalysisEventOutbox.Where(item => item.SessionId == sessionId).ToListAsync(cancellationToken));
        dbContext.AuthSessions.RemoveRange(studentAuthSessions);
        dbContext.LearningSessions.Remove(session);
        await dbContext.SaveChangesAsync(cancellationToken);

        if (connections is not null)
        {
            foreach (var authSession in studentAuthSessions)
            {
                await connections.RemoveAuthSessionAsync(authSession.SessionId, cancellationToken);
            }
        }
        return NoContent();
    }
}
