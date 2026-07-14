using System.Text.Json;
using Awaver.Backend.Controllers;
using Awaver.Backend.Data;
using Awaver.Backend.Models;
using Awaver.Backend.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Awaver.Backend.Tests;

public sealed class AnalysisResultsControllerTests
{
    [Fact]
    public async Task AcceptedScore_IsPersistedWithOneOutboxRecordAndIsIdempotent()
    {
        await using var db = CreateDb();
        var session = await SeedSessionAsync(db);
        db.Calibrations.Add(new Calibration { SessionId = session.SessionId, SourceSequenceNo = 1, EarOpen = .30m, EarThreshold = .225m, CalibratedAt = DateTimeOffset.Parse("2026-06-14T10:00:00Z") });
        await db.SaveChangesAsync();
        var controller = new AnalysisResultsController(db, new AnalysisResultBroadcaster());
        var payload = Payload(session.SessionId, 10);

        var first = await controller.PublishAnalysisResult(session.SessionId, payload, CancellationToken.None);
        var replay = await controller.PublishAnalysisResult(session.SessionId, payload, CancellationToken.None);

        Assert.IsType<AcceptedResult>(first);
        Assert.IsType<AcceptedResult>(replay);
        var score = Assert.Single(db.DrowsinessScores);
        Assert.Equal(123.45, score.VideoTimeSec);
        var outboxEvent = Assert.Single(db.AnalysisEventOutbox);
        using var outboxPayload = JsonDocument.Parse(outboxEvent.Payload);
        Assert.Equal(123.45, outboxPayload.RootElement.GetProperty("videoTimeSec").GetDouble());
    }

    [Fact]
    public async Task ReusedSequenceWithDifferentScore_IsConflict()
    {
        await using var db = CreateDb();
        var session = await SeedSessionAsync(db);
        db.Calibrations.Add(new Calibration { SessionId = session.SessionId, SourceSequenceNo = 1, EarOpen = .30m, EarThreshold = .225m, CalibratedAt = DateTimeOffset.Parse("2026-06-14T10:00:00Z") });
        await db.SaveChangesAsync();
        var controller = new AnalysisResultsController(db, new AnalysisResultBroadcaster());

        await controller.PublishAnalysisResult(session.SessionId, Payload(session.SessionId, 10), CancellationToken.None);
        var conflict = await controller.PublishAnalysisResult(session.SessionId, Payload(session.SessionId, 10, .9m), CancellationToken.None);

        Assert.IsType<ConflictObjectResult>(conflict);
        Assert.Single(db.DrowsinessScores);
    }

    [Fact]
    public async Task ReusedSequenceWithDifferentVideoTimeSec_IsConflict()
    {
        await using var db = CreateDb();
        var session = await SeedSessionAsync(db);
        db.Calibrations.Add(new Calibration { SessionId = session.SessionId, SourceSequenceNo = 1, EarOpen = .30m, EarThreshold = .225m, CalibratedAt = DateTimeOffset.Parse("2026-06-14T10:00:00Z") });
        await db.SaveChangesAsync();
        var controller = new AnalysisResultsController(db, new AnalysisResultBroadcaster());

        await controller.PublishAnalysisResult(session.SessionId, Payload(session.SessionId, 10), CancellationToken.None);
        var conflict = await controller.PublishAnalysisResult(session.SessionId, Payload(session.SessionId, 10, videoTimeSec: 123.46), CancellationToken.None);

        Assert.IsType<ConflictObjectResult>(conflict);
        Assert.Single(db.DrowsinessScores);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"videoTimeSec\":-0.01}")]
    [InlineData("{\"videoTimeSec\":1e999}")]
    public async Task ScoreRequiresNonNegativeFiniteVideoTimeSec(string replacement)
    {
        await using var db = CreateDb();
        var session = await SeedSessionAsync(db);
        db.Calibrations.Add(new Calibration { SessionId = session.SessionId, SourceSequenceNo = 1, EarOpen = .30m, EarThreshold = .225m, CalibratedAt = DateTimeOffset.Parse("2026-06-14T10:00:00Z") });
        await db.SaveChangesAsync();
        var controller = new AnalysisResultsController(db, new AnalysisResultBroadcaster());
        var payload = Payload(session.SessionId, 10);
        var invalidPayload = JsonSerializer.Deserialize<JsonElement>(replacement == "{}"
            ? payload.GetRawText().Replace(",\"videoTimeSec\":123.45", string.Empty)
            : payload.GetRawText().Replace("\"videoTimeSec\":123.45", replacement.Trim('{', '}')));

        Assert.IsType<BadRequestObjectResult>(await controller.PublishAnalysisResult(session.SessionId, invalidPayload, CancellationToken.None));
        Assert.Empty(db.DrowsinessScores);
        Assert.Empty(db.AnalysisEventOutbox);
    }

    [Fact]
    public async Task SuccessfulCalibration_IsPersistedWithOutboxAndRetryIsIdempotent()
    {
        await using var db = CreateDb();
        var session = await SeedSessionAsync(db);
        var controller = new AnalysisResultsController(db, new AnalysisResultBroadcaster());
        var payload = CalibrationPayload(session.SessionId, "succeeded");

        var first = await controller.PublishAnalysisResult(session.SessionId, payload, CancellationToken.None);
        var retry = await controller.PublishAnalysisResult(session.SessionId, payload, CancellationToken.None);

        Assert.IsType<AcceptedResult>(first);
        Assert.IsType<AcceptedResult>(retry);
        var calibration = Assert.Single(db.Calibrations);
        Assert.Equal(25, calibration.SourceSequenceNo);
        Assert.Equal(DateTimeOffset.Parse("2026-06-14T10:00:05Z"), calibration.CalibratedAt);
        Assert.Equal(.31m, calibration.EarOpen);
        Assert.Equal(.2325m, calibration.EarThreshold);
        Assert.Single(db.AnalysisEventOutbox);
    }

    [Fact]
    public async Task FailedCalibration_IsNotPersistedButIsQueuedForNotification()
    {
        await using var db = CreateDb();
        var session = await SeedSessionAsync(db);
        var controller = new AnalysisResultsController(db, new AnalysisResultBroadcaster());

        var result = await controller.PublishAnalysisResult(session.SessionId, CalibrationPayload(session.SessionId, "failed"), CancellationToken.None);

        Assert.IsType<AcceptedResult>(result);
        Assert.Empty(db.Calibrations);
        Assert.Single(db.AnalysisEventOutbox);
    }

    [Fact]
    public async Task SuccessfulCalibrationRequiresExactly25FramesAndAtLeast15ValidFrames()
    {
        await using var db = CreateDb();
        var session = await SeedSessionAsync(db);
        var controller = new AnalysisResultsController(db, new AnalysisResultBroadcaster());

        var rejected = await controller.PublishAnalysisResult(session.SessionId, CalibrationPayload(session.SessionId, "succeeded", validFrames: 14), CancellationToken.None);
        Assert.IsType<BadRequestObjectResult>(rejected);
        Assert.Empty(db.Calibrations);
        Assert.Empty(db.AnalysisEventOutbox);

        var accepted = await controller.PublishAnalysisResult(session.SessionId, CalibrationPayload(session.SessionId, "succeeded", validFrames: 15), CancellationToken.None);
        Assert.IsType<AcceptedResult>(accepted);
        Assert.Single(db.Calibrations);
    }

    [Fact]
    public async Task SuccessfulCalibrationRejectsWrongFrameCountsAndThresholdRatio()
    {
        await using var db = CreateDb();
        var session = await SeedSessionAsync(db);
        var controller = new AnalysisResultsController(db, new AnalysisResultBroadcaster());

        var wrongTarget = CalibrationPayload(session.SessionId, "succeeded");
        wrongTarget = JsonSerializer.Deserialize<JsonElement>(wrongTarget.GetRawText().Replace("\"targetFrames\":25", "\"targetFrames\":24"));
        Assert.IsType<BadRequestObjectResult>(await controller.PublishAnalysisResult(session.SessionId, wrongTarget, CancellationToken.None));

        var wrongRatio = CalibrationPayload(session.SessionId, "succeeded");
        wrongRatio = JsonSerializer.Deserialize<JsonElement>(wrongRatio.GetRawText().Replace("\"earThreshold\":0.2325", "\"earThreshold\":0.2"));
        Assert.IsType<BadRequestObjectResult>(await controller.PublishAnalysisResult(session.SessionId, wrongRatio, CancellationToken.None));
        Assert.Empty(db.Calibrations);
        Assert.Empty(db.AnalysisEventOutbox);
    }

    [Fact]
    public async Task TrackingStatusUsesSourceSequenceAsDurableIdempotencyKey()
    {
        await using var db = CreateDb();
        var session = await SeedSessionAsync(db);
        var controller = new AnalysisResultsController(db, new AnalysisResultBroadcaster());
        var payload = JsonSerializer.Deserialize<JsonElement>($"{{\"type\":\"tracking_status\",\"sessionId\":\"{session.SessionId}\",\"sourceSequenceNo\":42,\"detectedAt\":\"2026-06-14T10:00:00Z\",\"status\":\"face_not_detected\"}}");

        Assert.IsType<AcceptedResult>(await controller.PublishAnalysisResult(session.SessionId, payload, CancellationToken.None));
        Assert.IsType<AcceptedResult>(await controller.PublishAnalysisResult(session.SessionId, payload, CancellationToken.None));
        Assert.Single(db.AnalysisEventOutbox);

        var conflict = JsonSerializer.Deserialize<JsonElement>(payload.GetRawText().Replace("10:00:00", "10:00:01"));
        Assert.IsType<ConflictObjectResult>(await controller.PublishAnalysisResult(session.SessionId, conflict, CancellationToken.None));
        Assert.Single(db.AnalysisEventOutbox);
    }

    private static JsonElement Payload(Guid sessionId, long sequence, decimal score = .8m, double videoTimeSec = 123.45) => JsonSerializer.Deserialize<JsonElement>($"{{\"type\":\"drowsiness_score\",\"sessionId\":\"{sessionId}\",\"sourceSequenceNo\":{sequence},\"scoredAt\":\"2026-06-14T10:00:10Z\",\"score\":{score},\"level\":\"danger\",\"perclos\":0.6,\"ear\":0.18,\"pitchDeg\":12.4,\"yawDeg\":4.2,\"videoTimeSec\":{videoTimeSec},\"shouldPause\":true}}");
    private static JsonElement CalibrationPayload(Guid sessionId, string status, int validFrames = 18) => status == "succeeded"
        ? JsonSerializer.Deserialize<JsonElement>($"{{\"type\":\"calibration_status\",\"sessionId\":\"{sessionId}\",\"status\":\"succeeded\",\"validFrames\":{validFrames},\"totalFrames\":25,\"targetFrames\":25,\"sourceSequenceNo\":25,\"calibratedAt\":\"2026-06-14T10:00:05Z\",\"earOpen\":0.31,\"earThreshold\":0.2325}}")
        : JsonSerializer.Deserialize<JsonElement>($"{{\"type\":\"calibration_status\",\"sessionId\":\"{sessionId}\",\"status\":\"failed\",\"validFrames\":14,\"totalFrames\":25,\"targetFrames\":25}}");
    private static async Task<LearningSession> SeedSessionAsync(AwaverDbContext db)
    {
        var session = await new EfSessionRepository(db).StartSessionAsync("student", CancellationToken.None);
        return await db.LearningSessions.SingleAsync(item => item.SessionId == session.SessionId);
    }
    private static AwaverDbContext CreateDb() => new(new DbContextOptionsBuilder<AwaverDbContext>().UseInMemoryDatabase(Guid.NewGuid().ToString()).Options);
}
