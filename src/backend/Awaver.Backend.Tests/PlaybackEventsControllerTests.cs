using Awaver.Backend.Controllers;
using Awaver.Backend.Data;
using Awaver.Backend.Dto;
using Awaver.Backend.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Awaver.Backend.Tests;

public sealed class PlaybackEventsControllerTests
{
    [Fact]
    public async Task CreatePlaybackEvent_SavesValidAutoPause()
    {
        await using var dbContext = CreateDbContext();
        var controller = CreateController(dbContext);
        var session = await CreateSessionAsync(dbContext);
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
        var controller = CreateController(dbContext);
        var session = await CreateSessionAsync(dbContext);
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
    public async Task CreatePlaybackEvent_ReturnsNotFoundForUnknownSessionId()
    {
        await using var dbContext = CreateDbContext();
        var controller = CreateController(dbContext);

        var result = await controller.CreatePlaybackEvent(
            Guid.NewGuid(),
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
        var controller = CreateController(dbContext);
        var session = await CreateSessionAsync(dbContext);

        var result = await controller.CreatePlaybackEvent(
            session.SessionId,
            new CreatePlaybackEventRequest
            {
                Type = "manual_pause",
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
        var controller = CreateController(dbContext);
        var session = await CreateSessionAsync(dbContext);

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
        var controller = CreateController(dbContext);
        var session = await CreateSessionAsync(dbContext);

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

    private static AwaverDbContext CreateDbContext()
    {
        var options = new DbContextOptionsBuilder<AwaverDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .Options;

        return new AwaverDbContext(options);
    }

    private static SessionsController CreateController(AwaverDbContext dbContext)
    {
        var sessions = new EfSessionRepository(dbContext);
        return new SessionsController(sessions, dbContext);
    }

    private static Task<SessionStartResult> CreateSessionAsync(AwaverDbContext dbContext)
    {
        var sessions = new EfSessionRepository(dbContext);
        return sessions.StartSessionAsync("s12345", CancellationToken.None);
    }
}
