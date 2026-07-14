using System.Security.Claims;
using Awaver.Backend.Controllers;
using Awaver.Backend.Data;
using Awaver.Backend.Dto;
using Awaver.Backend.Models;
using Awaver.Backend.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Awaver.Backend.Tests;

public sealed class PlaybackEventsControllerTests
{
    [Fact]
    public async Task CreatePlaybackEvent_SavesValidAutoPause()
    {
        await using var dbContext = CreateDbContext();
        var session = await CreateSessionAsync(dbContext);
        var controller = CreateController(dbContext, session.SessionId);
        var occurredAt = DateTimeOffset.Parse("2026-06-14T10:00:00Z");

        var result = await controller.CreatePlaybackEvent(
            session.SessionId,
            new CreatePlaybackEventRequest
            {
                Type = "auto_pause",
                OccurredAt = occurredAt,
                VideoTimeSec = 123.45,
            },
            CancellationToken.None);

        Assert.IsType<CreatedResult>(result);

        var playbackEvent = await dbContext.PlaybackEvents.SingleAsync();
        Assert.Equal(session.SessionId, playbackEvent.SessionId);
        Assert.Equal("auto_pause", playbackEvent.Type);
        Assert.Equal(occurredAt, playbackEvent.OccurredAt);
        Assert.Equal(123.45, playbackEvent.VideoTimeSec);
    }

    [Fact]
    public async Task CreatePlaybackEvent_SavesValidResume()
    {
        await using var dbContext = CreateDbContext();
        var session = await CreateSessionAsync(dbContext);
        var controller = CreateController(dbContext, session.SessionId);
        var occurredAt = DateTimeOffset.Parse("2026-06-14T10:02:00Z");

        var result = await controller.CreatePlaybackEvent(
            session.SessionId,
            new CreatePlaybackEventRequest
            {
                Type = "resume",
                OccurredAt = occurredAt,
                VideoTimeSec = 123.45,
            },
            CancellationToken.None);

        Assert.IsType<CreatedResult>(result);

        var playbackEvent = await dbContext.PlaybackEvents.SingleAsync();
        Assert.Equal(session.SessionId, playbackEvent.SessionId);
        Assert.Equal("resume", playbackEvent.Type);
        Assert.Equal(occurredAt, playbackEvent.OccurredAt);
        Assert.Equal(123.45, playbackEvent.VideoTimeSec);
    }

    [Fact]
    public async Task CreatePlaybackEvent_SavesValidManualPause()
    {
        await using var dbContext = CreateDbContext();
        var session = await CreateSessionAsync(dbContext);
        var controller = CreateController(dbContext, session.SessionId);

        var result = await controller.CreatePlaybackEvent(
            session.SessionId,
            new CreatePlaybackEventRequest
            {
                Type = "manual_pause",
                OccurredAt = DateTimeOffset.Parse("2026-06-14T10:01:00Z"),
                VideoTimeSec = 123.45,
            },
            CancellationToken.None);

        Assert.IsType<CreatedResult>(result);
        Assert.Equal("manual_pause", Assert.Single(dbContext.PlaybackEvents).Type);
    }

    [Fact]
    public async Task CreatePlaybackEvent_RejectsStudentCookieForAnotherSession()
    {
        await using var dbContext = CreateDbContext();
        var ownedSession = await CreateSessionAsync(dbContext);
        var otherSession = await CreateSessionAsync(dbContext);
        var controller = CreateController(dbContext, ownedSession.SessionId);

        var result = await controller.CreatePlaybackEvent(
            otherSession.SessionId,
            new CreatePlaybackEventRequest
            {
                Type = "auto_pause",
                OccurredAt = DateTimeOffset.UtcNow,
            },
            CancellationToken.None);

        Assert.IsType<ForbidResult>(result);
        Assert.Empty(dbContext.PlaybackEvents);
    }

    [Fact]
    public async Task CreatePlaybackEvent_ReturnsNotFoundForUnknownSessionId()
    {
        await using var dbContext = CreateDbContext();
        var unknownSessionId = Guid.NewGuid();
        var controller = CreateController(dbContext, unknownSessionId);

        var result = await controller.CreatePlaybackEvent(
            unknownSessionId,
            new CreatePlaybackEventRequest
            {
                Type = "auto_pause",
                OccurredAt = DateTimeOffset.Parse("2026-06-14T10:00:00Z"),
                VideoTimeSec = 123.45,
            },
            CancellationToken.None);

        Assert.IsType<NotFoundObjectResult>(result);
        Assert.Empty(dbContext.PlaybackEvents);
    }

    [Fact]
    public async Task CreatePlaybackEvent_ReturnsBadRequestForInvalidType()
    {
        await using var dbContext = CreateDbContext();
        var session = await CreateSessionAsync(dbContext);
        var controller = CreateController(dbContext, session.SessionId);

        var result = await controller.CreatePlaybackEvent(
            session.SessionId,
            new CreatePlaybackEventRequest
            {
                Type = "unknown",
                OccurredAt = DateTimeOffset.Parse("2026-06-14T10:00:00Z"),
                VideoTimeSec = 123.45,
            },
            CancellationToken.None);

        Assert.IsType<BadRequestObjectResult>(result);
        Assert.Empty(dbContext.PlaybackEvents);
    }

    [Fact]
    public async Task CreatePlaybackEvent_ReturnsBadRequestForMissingOccurredAt()
    {
        await using var dbContext = CreateDbContext();
        var session = await CreateSessionAsync(dbContext);
        var controller = CreateController(dbContext, session.SessionId);

        var result = await controller.CreatePlaybackEvent(
            session.SessionId,
            new CreatePlaybackEventRequest
            {
                Type = "auto_pause",
                OccurredAt = null,
                VideoTimeSec = 123.45,
            },
            CancellationToken.None);

        Assert.IsType<BadRequestObjectResult>(result);
        Assert.Empty(dbContext.PlaybackEvents);
    }

    [Fact]
    public async Task CreatePlaybackEvent_ReturnsBadRequestForInvalidVideoTimeSec()
    {
        await using var dbContext = CreateDbContext();
        var session = await CreateSessionAsync(dbContext);
        var controller = CreateController(dbContext, session.SessionId);

        var result = await controller.CreatePlaybackEvent(
            session.SessionId,
            new CreatePlaybackEventRequest
            {
                Type = "auto_pause",
                OccurredAt = DateTimeOffset.Parse("2026-06-14T10:00:00Z"),
                VideoTimeSec = -0.01,
            },
            CancellationToken.None);

        Assert.IsType<BadRequestObjectResult>(result);
        Assert.Empty(dbContext.PlaybackEvents);
    }

    [Fact]
    public async Task CreatePlaybackEvent_CompletedEndsSessionAndIsIdempotent()
    {
        await using var dbContext = CreateDbContext();
        var session = await CreateSessionAsync(dbContext);
        var controller = CreateController(dbContext, session.SessionId);
        var occurredAt = new DateTimeOffset(2026, 7, 14, 12, 0, 0, TimeSpan.FromHours(9));
        var request = new CreatePlaybackEventRequest
        {
            Type = "completed",
            OccurredAt = occurredAt,
            VideoTimeSec = 42,
        };

        var firstResult = await controller.CreatePlaybackEvent(
            session.SessionId,
            request,
            CancellationToken.None);
        var secondResult = await controller.CreatePlaybackEvent(
            session.SessionId,
            request,
            CancellationToken.None);

        Assert.IsType<CreatedResult>(firstResult);
        Assert.IsType<NoContentResult>(secondResult);
        var completedEvent = Assert.Single(dbContext.PlaybackEvents);
        Assert.Equal("completed", completedEvent.Type);
        Assert.Equal(occurredAt.ToUniversalTime(), completedEvent.OccurredAt);
        var persistedSession = await dbContext.LearningSessions.SingleAsync(
            item => item.SessionId == session.SessionId);
        Assert.Equal(occurredAt.ToUniversalTime(), persistedSession.EndedAt);
    }

    private static AwaverDbContext CreateDbContext()
    {
        var options = new DbContextOptionsBuilder<AwaverDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .Options;

        return new AwaverDbContext(options);
    }

    private static SessionsController CreateController(
        AwaverDbContext dbContext,
        Guid authorizedSessionId)
    {
        var authSessions = new AuthSessionService(
            dbContext,
            new AuthCookieOptions { IsDevelopment = true });
        return new SessionsController(new EfSessionRepository(dbContext), dbContext, authSessions)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = StudentContext(authorizedSessionId),
            },
        };
    }

    private static Task<SessionStartResult> CreateSessionAsync(AwaverDbContext dbContext)
    {
        var sessions = new EfSessionRepository(dbContext);
        return sessions.StartSessionAsync("s12345", CancellationToken.None);
    }

    private static HttpContext StudentContext(Guid sessionId) => new DefaultHttpContext
    {
        User = new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim(ClaimTypes.Role, AuthSessionService.StudentRole),
                new Claim("learning_session_id", sessionId.ToString()),
            ],
            "test")),
    };
}
