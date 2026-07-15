using System.Diagnostics;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Awaver.Backend.Data;
using Awaver.Backend.Hubs;
using Awaver.Backend.Models;
using Awaver.Backend.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;

namespace Awaver.Backend.Controllers;

[ApiController]
[Route("api/sessions/{sessionId:guid}")]
public sealed class AnalysisResultsController(AwaverDbContext dbContext, AnalysisResultBroadcaster broadcaster, AuthSessionService? authSessions = null, IAnalysisResultObservability? observability = null) : ControllerBase
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    [HttpGet("analysis-events")]
    [Authorize]
    public async Task GetAnalysisEvents(Guid sessionId, CancellationToken cancellationToken)
    {
        if (!await dbContext.LearningSessions.AnyAsync(item => item.SessionId == sessionId, cancellationToken))
        {
            Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }
        if (!CanObserve(sessionId))
        {
            Response.StatusCode = StatusCodes.Status403Forbidden;
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
                if (authSessions is not null && Guid.TryParse(User.FindFirstValue("auth_session_id"), out var authSessionId) && await authSessions.ValidateAndRefreshAsync(authSessionId, cancellationToken) is null) break;
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
    [Authorize(Policy = "AnalysisWorker")]
    [ProducesResponseType(StatusCodes.Status202Accepted)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<IActionResult> PublishAnalysisResult(Guid sessionId, JsonElement payload, CancellationToken cancellationToken)
    {
        var requestStopwatch = Stopwatch.StartNew();
        var outcome = "persistence_error";
        IDbContextTransaction? transaction = null;

        try
        {
            var sessionCheckStopwatch = Stopwatch.StartNew();
            var sessionExists = false;
            try
            {
                sessionExists = await dbContext.LearningSessions.AnyAsync(item => item.SessionId == sessionId, cancellationToken);
            }
            finally
            {
                observability?.RecordStage("session_existence", sessionCheckStopwatch.Elapsed);
            }
            if (!sessionExists)
            {
                outcome = "not_found";
                return NotFound("Session not found.");
            }

            string type = string.Empty;
            PersistenceResult persistence;
            var persistenceStopwatch = Stopwatch.StartNew();
            try
            {
                if (payload.ValueKind != JsonValueKind.Object)
                {
                    outcome = "bad_request";
                    return BadRequest("Analysis result must be a JSON object.");
                }
                if (!TryGetString(payload, "type", out type) || type is not ("drowsiness_score" or "tracking_status" or "calibration_status"))
                {
                    outcome = "bad_request";
                    return BadRequest("Unsupported analysis result type.");
                }
                if (!TryGetString(payload, "sessionId", out var payloadSessionId) || !Guid.TryParse(payloadSessionId, out var parsedSessionId) || parsedSessionId != sessionId)
                {
                    outcome = "bad_request";
                    return BadRequest("sessionId must match the route sessionId.");
                }

                if (dbContext.Database.IsRelational()) transaction = await dbContext.Database.BeginTransactionAsync(cancellationToken);
                persistence = type switch
                {
                    "drowsiness_score" => await PersistScoreAsync(sessionId, payload, cancellationToken),
                    "calibration_status" => await PersistCalibrationAsync(sessionId, payload, cancellationToken),
                    _ => ValidateTrackingStatus(payload),
                };
            }
            finally
            {
                observability?.RecordStage("type_specific_persistence_validation", persistenceStopwatch.Elapsed);
            }

            if (persistence.Error is not null)
            {
                if (transaction is not null) await transaction.RollbackAsync(cancellationToken);
                outcome = persistence.Error is ConflictObjectResult ? "conflict" : "bad_request";
                return persistence.Error;
            }
            if (persistence.AlreadyAccepted)
            {
                await CommitTransactionAsync(transaction, cancellationToken);
                outcome = "idempotent";
                return Accepted();
            }

            var idempotencyLookupStopwatch = Stopwatch.StartNew();
            AnalysisEventOutbox? existingEvent;
            string idempotencyKey;
            try
            {
                idempotencyKey = CreateIdempotencyKey(sessionId, type, payload);
                existingEvent = await dbContext.AnalysisEventOutbox.SingleOrDefaultAsync(item => item.IdempotencyKey == idempotencyKey, cancellationToken);
            }
            finally
            {
                observability?.RecordStage("outbox_idempotency_lookup", idempotencyLookupStopwatch.Elapsed);
            }
            if (existingEvent is not null)
            {
                if (PayloadsMatch(existingEvent.Payload, payload))
                {
                    await CommitTransactionAsync(transaction, cancellationToken);
                    outcome = "idempotent";
                    return Accepted();
                }
                if (transaction is not null) await transaction.RollbackAsync(cancellationToken);
                outcome = "conflict";
                return Conflict("The analysis event idempotency key was already accepted with different data.");
            }

            dbContext.AnalysisEventOutbox.Add(new AnalysisEventOutbox
            {
                EventId = Guid.NewGuid(),
                SessionId = sessionId,
                IdempotencyKey = idempotencyKey,
                Payload = JsonSerializer.Serialize(payload, JsonOptions),
                CreatedAt = DateTimeOffset.UtcNow,
                NextAttemptAt = DateTimeOffset.UtcNow,
            });
            var saveChangesStopwatch = Stopwatch.StartNew();
            try
            {
                await dbContext.SaveChangesAsync(cancellationToken);
            }
            finally
            {
                observability?.RecordStage("save_changes", saveChangesStopwatch.Elapsed);
            }
            await CommitTransactionAsync(transaction, cancellationToken);
            outcome = "accepted";
            return Accepted();
        }
        catch (DbUpdateException)
        {
            if (transaction is not null) await transaction.RollbackAsync(cancellationToken);
            outcome = "conflict";
            return Conflict("The analysis result conflicts with an already accepted result.");
        }
        catch
        {
            outcome = "persistence_error";
            throw;
        }
        finally
        {
            try
            {
                if (transaction is not null) await transaction.DisposeAsync();
            }
            catch
            {
                outcome = "persistence_error";
                throw;
            }
            finally
            {
                observability?.RecordRequest(outcome, requestStopwatch.Elapsed);
            }
        }

        async Task CommitTransactionAsync(IDbContextTransaction? activeTransaction, CancellationToken token)
        {
            if (activeTransaction is null) return;
            var commitStopwatch = Stopwatch.StartNew();
            try
            {
                await activeTransaction.CommitAsync(token);
            }
            finally
            {
                observability?.RecordStage("transaction_commit", commitStopwatch.Elapsed);
            }
        }
    }

    [HttpGet("calibration")]
    [Authorize(Policy = "CalibrationReader")]
    public async Task<IActionResult> GetCalibration(Guid sessionId, CancellationToken cancellationToken)
    {
        if (!await dbContext.LearningSessions.AnyAsync(item => item.SessionId == sessionId, cancellationToken)) return NotFound("Session not found.");
        if (!IsAnalysisWorker() && !CanObserve(sessionId)) return Forbid();
        var calibration = await dbContext.Calibrations.SingleOrDefaultAsync(item => item.SessionId == sessionId, cancellationToken);
        if (calibration is null) return NoContent();
        return Ok(new
        {
            sessionId,
            earOpen = calibration.EarOpen,
            earThreshold = calibration.EarThreshold,
            validFrames = calibration.ValidFrames,
            totalFrames = calibration.TotalFrames,
            sourceSequenceNo = calibration.SourceSequenceNo,
            calibratedAt = calibration.CalibratedAt,
        });
    }

    private async Task<PersistenceResult> PersistScoreAsync(Guid sessionId, JsonElement payload, CancellationToken cancellationToken)
    {
        if (!TryGetPositiveInt64(payload, "sourceSequenceNo", out var sequenceNo) ||
            !TryGetTimestamp(payload, "scoredAt", out var scoredAt) ||
        scoredAt.Ticks % TimeSpan.TicksPerSecond != 0 ||
        !TryGetDecimal(payload, "score", out var score) || score is < 0 or > 1 ||
        !TryGetString(payload, "level", out var levelValue) || !DrowsinessLevelExtensions.TryParseApiValue(levelValue, out var level) || !IsExpectedLevel(score, level) ||
            !TryGetDecimal(payload, "perclos", out var perclos) || perclos is < 0 or > 1 ||
            !TryGetDecimal(payload, "ear", out var ear) || !TryGetDecimal(payload, "pitchDeg", out var pitchDeg) ||
            !TryGetDecimal(payload, "yawDeg", out var yawDeg) ||
            !TryGetNonNegativeFiniteDouble(payload, "videoTimeSec", out var videoTimeSec) ||
            !TryGetBoolean(payload, "shouldPause", out var shouldPause) || shouldPause != (level == DrowsinessLevel.Danger))
        {
            return Failure("Invalid drowsiness_score payload.");
        }

        if (!await dbContext.Calibrations.AnyAsync(item => item.SessionId == sessionId, cancellationToken)) return Failure(Conflict("A successful calibration is required before scores are accepted."));
        var existing = await dbContext.DrowsinessScores.FindAsync([sessionId, sequenceNo], cancellationToken);
        if (existing is not null)
        {
            return ScoresMatch(existing, scoredAt, score, level, perclos, ear, pitchDeg, yawDeg, videoTimeSec) ? AlreadyAccepted : Failure(Conflict("sourceSequenceNo was already accepted with different data."));
        }
        if (await dbContext.DrowsinessScores.AnyAsync(item => item.SessionId == sessionId && item.ScoredAt == scoredAt, cancellationToken)) return Failure(Conflict("scoredAt was already accepted for this session."));

        dbContext.DrowsinessScores.Add(new DrowsinessScore { SessionId = sessionId, SourceSequenceNo = sequenceNo, ScoredAt = scoredAt, Score = score, Level = level, Perclos = perclos, Ear = ear, PitchDeg = pitchDeg, YawDeg = yawDeg, VideoTimeSec = videoTimeSec });
        return NewResult;
    }

    private async Task<PersistenceResult> PersistCalibrationAsync(Guid sessionId, JsonElement payload, CancellationToken cancellationToken)
    {
        if (!TryGetString(payload, "status", out var status) || status is not ("succeeded" or "failed") ||
            !TryGetNonNegativeInt64(payload, "validFrames", out var validFrames) ||
            !TryGetPositiveInt64(payload, "totalFrames", out var totalFrames) ||
            !TryGetPositiveInt64(payload, "targetFrames", out var targetFrames) ||
            targetFrames != 25 || totalFrames != 25 || validFrames > totalFrames)
        {
            return Failure("Invalid calibration_status payload.");
        }
        if (status == "failed")
        {
            if (validFrames >= 15 || HasAnyProperty(payload, "sourceSequenceNo", "calibratedAt", "earOpen", "earThreshold"))
            {
                return Failure("Failed calibration payload must not contain successful calibration fields.");
            }
            return NewResult;
        }

        if (validFrames < 15) return Failure("Successful calibration requires at least 15 valid frames.");
        if (!TryGetPositiveInt64(payload, "sourceSequenceNo", out var sequenceNo) ||
            !TryGetTimestamp(payload, "calibratedAt", out var calibratedAt) ||
            !TryGetDecimal(payload, "earOpen", out var earOpen) || earOpen <= 0 ||
            !TryGetDecimal(payload, "earThreshold", out var earThreshold) || earThreshold <= 0)
        {
            return Failure("Successful calibration requires sourceSequenceNo, calibratedAt, earOpen, and earThreshold.");
        }
        var expectedThreshold = earOpen * .75m;
        if (Math.Abs(earThreshold - expectedThreshold) > Math.Max(.000001m, Math.Abs(expectedThreshold) * .00001m))
        {
            return Failure("earThreshold must equal earOpen multiplied by 0.75 within the allowed precision.");
        }

        var existing = await dbContext.Calibrations.FindAsync([sessionId], cancellationToken);
        if (existing is not null)
        {
            return existing.SourceSequenceNo == sequenceNo && existing.EarOpen == earOpen && existing.EarThreshold == earThreshold && existing.CalibratedAt == calibratedAt
                ? AlreadyAccepted : Failure(Conflict("A different successful calibration already exists for this session."));
        }
        dbContext.Calibrations.Add(new Calibration { SessionId = sessionId, SourceSequenceNo = sequenceNo, EarOpen = earOpen, EarThreshold = earThreshold, ValidFrames = (int)validFrames, TotalFrames = (int)totalFrames, CalibratedAt = calibratedAt });
        return NewResult;
    }

    private static PersistenceResult ValidateTrackingStatus(JsonElement payload) =>
        TryGetPositiveInt64(payload, "sourceSequenceNo", out _) && TryGetString(payload, "status", out var status) && status == "face_not_detected" && TryGetTimestamp(payload, "detectedAt", out _)
            ? NewResult : Failure("Invalid tracking_status payload.");

    private static readonly PersistenceResult NewResult = new(null, false);
    private static readonly PersistenceResult AlreadyAccepted = new(null, true);
    private static PersistenceResult Failure(string message) => new(new BadRequestObjectResult(message), false);
    private static PersistenceResult Failure(IActionResult result) => new(result, false);
    private sealed record PersistenceResult(IActionResult? Error, bool AlreadyAccepted);

    private bool CanObserve(Guid sessionId) =>
        User.IsInRole(AuthSessionService.AdminRole) ||
        (User.IsInRole(AuthSessionService.StudentRole) && Guid.TryParse(User.FindFirstValue("learning_session_id"), out var studentSessionId) && studentSessionId == sessionId);

    private bool IsAnalysisWorker() =>
        User.HasClaim("worker_role", "analysis_worker") ||
        User.HasClaim("roles", "analysis_worker");

    private static bool ScoresMatch(DrowsinessScore score, DateTimeOffset scoredAt, decimal value, DrowsinessLevel level, decimal perclos, decimal ear, decimal pitchDeg, decimal yawDeg, double videoTimeSec) =>
        score.ScoredAt == scoredAt && score.Score == value && score.Level == level && score.Perclos == perclos && score.Ear == ear && score.PitchDeg == pitchDeg && score.YawDeg == yawDeg && score.VideoTimeSec == videoTimeSec;

    private static bool IsExpectedLevel(decimal score, DrowsinessLevel level) => level == (score < .25m ? DrowsinessLevel.Normal : score < .5m ? DrowsinessLevel.Caution : score < .75m ? DrowsinessLevel.Warning : DrowsinessLevel.Danger);
    private static bool HasAnyProperty(JsonElement payload, params string[] names) => names.Any(name => payload.TryGetProperty(name, out _));
    private static bool PayloadsMatch(string existingPayload, JsonElement incomingPayload)
    {
        try
        {
            using var existingDocument = JsonDocument.Parse(existingPayload);
            return JsonElement.DeepEquals(existingDocument.RootElement, incomingPayload);
        }
        catch (JsonException)
        {
            return false;
        }
    }
    private static string CreateIdempotencyKey(Guid sessionId, string type, JsonElement payload)
    {
        if (TryGetPositiveInt64(payload, "sourceSequenceNo", out var sequenceNo)) return $"{sessionId:D}:{type}:{sequenceNo}";
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload, JsonOptions)));
        return $"{sessionId:D}:{type}:payload:{Convert.ToHexString(bytes)}";
    }
    private static bool TryGetString(JsonElement payload, string name, out string value) { value = string.Empty; return payload.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value = property.GetString() ?? string.Empty); }
    private static bool TryGetPositiveInt64(JsonElement payload, string name, out long value)
    {
        value = default;
        return payload.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.Number && property.TryGetInt64(out value) && value > 0;
    }
    private static bool TryGetNonNegativeInt64(JsonElement payload, string name, out long value)
    {
        value = default;
        return payload.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.Number && property.TryGetInt64(out value) && value >= 0;
    }
    private static bool TryGetDecimal(JsonElement payload, string name, out decimal value)
    {
        value = default;
        return payload.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.Number && property.TryGetDecimal(out value);
    }
    private static bool TryGetNonNegativeFiniteDouble(JsonElement payload, string name, out double value)
    {
        value = default;
        return payload.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.Number && property.TryGetDouble(out value) && double.IsFinite(value) && value >= 0;
    }
    private static bool TryGetBoolean(JsonElement payload, string name, out bool value)
    {
        value = default;
        return payload.TryGetProperty(name, out var property) && (property.ValueKind is JsonValueKind.True or JsonValueKind.False) && (value = property.GetBoolean()) == property.GetBoolean();
    }
    private static bool TryGetTimestamp(JsonElement payload, string name, out DateTimeOffset value)
    {
        value = default;
        return TryGetString(payload, name, out var raw) && DateTimeOffset.TryParse(raw, out value) && (value = value.ToUniversalTime()) != default;
    }
}
