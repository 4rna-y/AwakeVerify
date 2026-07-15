using System.Diagnostics;
using System.Text.Json;
using Awaver.Backend.Data;
using Awaver.Backend.Hubs;
using Awaver.Backend.Models;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using StackExchange.Redis;

namespace Awaver.Backend.Services;

/// <summary>
/// Delivers transactional-outbox records with an expiring database lease.
/// Claiming is deliberately separate from notification I/O: a dispatcher crash
/// can therefore cause a retry, but never holds row locks while it waits on
/// SignalR, Redis, or SSE subscribers.
/// </summary>
public sealed class AnalysisOutboxDispatcher(
    IServiceScopeFactory scopeFactory,
    IHubContext<AnalysisEventsHub> hubContext,
    AnalysisResultBroadcaster broadcaster,
    IAnalysisConnectionRegistry connections,
    OutboxDispatchOptions options,
    ILogger<AnalysisOutboxDispatcher> logger,
    IAnalysisOutboxObservability? observability = null) : BackgroundService
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly string processingOwner = $"{Environment.MachineName}:{Guid.NewGuid():N}";
    private readonly SemaphoreSlim claimGate = new(1, 1);
    private int acceptingClaims = 1;

    private bool IsAcceptingClaims => Volatile.Read(ref acceptingClaims) == 1;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(options.PollInterval);
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            if (!IsAcceptingClaims) return;
            try
            {
                // Once claimed, complete the bounded batch during normal host
                // shutdown. The host shutdown timeout still bounds a stuck
                // external dependency; its lease then makes the work available
                // to another instance.
                await DispatchDueEventsAsync(CancellationToken.None);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception exception)
            {
                logger.LogError("Failed to dispatch analysis outbox events. Error type: {ErrorType}.", exception.GetType().Name);
            }
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        Interlocked.Exchange(ref acceptingClaims, 0);

        // A claim already in its short database transaction may finish, but no
        // later transaction can begin after this point.
        await claimGate.WaitAsync(cancellationToken);
        claimGate.Release();

        await base.StopAsync(cancellationToken);
    }

    internal async Task DispatchDueEventsAsync(CancellationToken cancellationToken)
    {
        if (!IsAcceptingClaims) return;
        var batchStopwatch = Stopwatch.StartNew();
        var batchOutcome = "success";
        var claimedCount = 0;
        try
        {
            var leaseId = Guid.NewGuid();
            IReadOnlyList<AnalysisEventOutbox> claimed = [];
            var claimStopwatch = Stopwatch.StartNew();
            var claimOutcome = "success";

            await claimGate.WaitAsync(cancellationToken);
            try
            {
                if (!IsAcceptingClaims) return;
                await using var claimScope = scopeFactory.CreateAsyncScope();
                var dbContext = claimScope.ServiceProvider.GetRequiredService<AwaverDbContext>();
                claimed = await ClaimDueEventsAsync(dbContext, options.BatchSize, leaseId, processingOwner, DateTimeOffset.UtcNow, options.LeaseDuration, cancellationToken);
                claimedCount = claimed.Count;
            }
            catch
            {
                claimOutcome = "error";
                throw;
            }
            finally
            {
                claimGate.Release();
                if (claimedCount > 0 || claimOutcome != "success") observability?.RecordClaim(claimStopwatch.Elapsed, claimOutcome, claimedCount);
            }

            foreach (var outboxEvent in claimed)
            {
                var deliveryStopwatch = Stopwatch.StartNew();
                var deliveryOutcome = "delivered";
                try
                {
                    // No claim transaction remains open while the registry, SignalR,
                    // or SSE broadcaster performs network or subscriber work.
                    await DeliverAsync(outboxEvent, cancellationToken);
                    if (!await MarkDeliveredAsync(outboxEvent.EventId, leaseId, cancellationToken)) deliveryOutcome = "lease_lost";
                }
                catch (Exception exception)
                {
                    deliveryOutcome = "failed";
                    await MarkFailedAsync(outboxEvent.EventId, leaseId, exception, cancellationToken);
                }
                finally
                {
                    observability?.RecordDelivery(deliveryStopwatch.Elapsed, deliveryOutcome);
                }
            }

            var health = await ReadHealthAsync(cancellationToken);
            observability?.SetUndeliveredHealth(health.UndeliveredCount, health.OldestAge);
        }
        catch
        {
            batchOutcome = "error";
            throw;
        }
        finally
        {
            if (claimedCount > 0 || batchOutcome != "success") observability?.RecordBatch(batchStopwatch.Elapsed, batchOutcome);
        }
    }

    internal static async Task<IReadOnlyList<AnalysisEventOutbox>> ClaimDueEventsAsync(
        AwaverDbContext dbContext,
        int batchSize,
        Guid leaseId,
        string processingOwner,
        DateTimeOffset now,
        TimeSpan leaseDuration,
        CancellationToken cancellationToken)
    {
        await using var transaction = await dbContext.Database.BeginTransactionAsync(cancellationToken);
        var lockedUntil = now.Add(leaseDuration);
        var events = await dbContext.AnalysisEventOutbox.FromSqlInterpolated($"""
            WITH due_events AS (
                SELECT event_id
                FROM analysis_event_outbox
                WHERE delivered_at IS NULL
                  AND next_attempt_at <= {now}
                  AND (locked_until IS NULL OR locked_until <= {now})
                ORDER BY next_attempt_at, created_at
                LIMIT {batchSize}
                FOR UPDATE SKIP LOCKED
            )
            UPDATE analysis_event_outbox AS outbox
            SET lease_id = {leaseId},
                locked_until = {lockedUntil},
                processing_owner = {processingOwner}
            FROM due_events
            WHERE outbox.event_id = due_events.event_id
            RETURNING outbox.*
            """).ToListAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return events;
    }

    private async Task DeliverAsync(AnalysisEventOutbox outboxEvent, CancellationToken cancellationToken)
    {
        using var document = JsonDocument.Parse(outboxEvent.Payload);
        var payload = document.RootElement.Clone();
        await using var scope = scopeFactory.CreateAsyncScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<AwaverDbContext>();
        var connectionIds = await GetAuthorizedConnectionIdsAsync(connections, outboxEvent.SessionId, dbContext, DateTimeOffset.UtcNow, cancellationToken);
        foreach (var connectionId in connectionIds)
        {
            await hubContext.Clients.Client(connectionId)
                .SendAsync(AnalysisEventsHub.ReceiveAnalysisEventMethod, payload, cancellationToken);
        }

        // Zero SignalR connections and zero SSE subscribers are normal: retained
        // events are not a historical-notification replay mechanism.
        broadcaster.Publish(outboxEvent.SessionId, JsonSerializer.Serialize(payload, JsonOptions));
    }

    private async Task<bool> MarkDeliveredAsync(Guid eventId, Guid leaseId, CancellationToken cancellationToken)
    {
        var stopwatch = Stopwatch.StartNew();
        var outcome = "error";
        try
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var dbContext = scope.ServiceProvider.GetRequiredService<AwaverDbContext>();
            var changed = await dbContext.Database.ExecuteSqlInterpolatedAsync($"""
                UPDATE analysis_event_outbox
                SET delivered_at = {DateTimeOffset.UtcNow},
                    lease_id = NULL,
                    locked_until = NULL,
                    processing_owner = NULL,
                    last_error = NULL
                WHERE event_id = {eventId}
                  AND delivered_at IS NULL
                  AND lease_id = {leaseId}
                """, cancellationToken);
            outcome = changed == 1 ? "recorded" : "lease_lost";
            return changed == 1;
        }
        finally
        {
            observability?.RecordMark(stopwatch.Elapsed, "delivered", outcome);
        }
    }

    private async Task<bool> MarkFailedAsync(Guid eventId, Guid leaseId, Exception exception, CancellationToken cancellationToken)
    {
        var stopwatch = Stopwatch.StartNew();
        var outcome = "error";
        try
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var dbContext = scope.ServiceProvider.GetRequiredService<AwaverDbContext>();
            var error = exception is RedisException
                ? "SignalR connection registry is unavailable."
                : exception.Message[..Math.Min(exception.Message.Length, 1024)];
            var currentAttempt = await dbContext.AnalysisEventOutbox
                .Where(item => item.EventId == eventId && item.DeliveredAt == null && item.LeaseId == leaseId)
                .Select(item => (int?)item.AttemptCount)
                .SingleOrDefaultAsync(cancellationToken);
            if (currentAttempt is null)
            {
                outcome = "lease_lost";
                return false;
            }

            var nextAttemptCount = currentAttempt.Value + 1;
            var delaySeconds = Math.Min(300, 1 << Math.Min(8, nextAttemptCount));
            var changed = await dbContext.Database.ExecuteSqlInterpolatedAsync($"""
                UPDATE analysis_event_outbox
                SET attempt_count = {nextAttemptCount},
                    next_attempt_at = {DateTimeOffset.UtcNow.AddSeconds(delaySeconds)},
                    last_error = {error},
                    lease_id = NULL,
                    locked_until = NULL,
                    processing_owner = NULL
                WHERE event_id = {eventId}
                  AND delivered_at IS NULL
                  AND lease_id = {leaseId}
                """, cancellationToken);
            outcome = changed == 1 ? "recorded" : "lease_lost";
            if (changed == 1)
            {
                logger.LogWarning("Analysis outbox delivery failed; the event will be retried. Error type: {ErrorType}.", exception.GetType().Name);
            }
            return changed == 1;
        }
        finally
        {
            observability?.RecordMark(stopwatch.Elapsed, "failed", outcome);
        }
    }

    private async Task<(int UndeliveredCount, TimeSpan? OldestAge)> ReadHealthAsync(CancellationToken cancellationToken)
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<AwaverDbContext>();
        var pending = dbContext.AnalysisEventOutbox.Where(item => item.DeliveredAt == null);
        var oldestCreatedAt = await pending.Select(item => (DateTimeOffset?)item.CreatedAt).MinAsync(cancellationToken);
        var count = await pending.CountAsync(cancellationToken);
        return (count, oldestCreatedAt is null ? null : DateTimeOffset.UtcNow - oldestCreatedAt.Value);
    }

    internal static async Task<IReadOnlyList<string>> GetAuthorizedConnectionIdsAsync(
        IAnalysisConnectionRegistry connections,
        Guid observedSessionId,
        AwaverDbContext dbContext,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var candidates = await connections.GetConnectionsForSessionAsync(observedSessionId, cancellationToken);
        var candidateAuthSessionIds = candidates.Select(item => item.AuthSessionId).Distinct().ToArray();
        var activeAuthSessionIds = candidateAuthSessionIds.Length == 0
            ? []
            : await dbContext.AuthSessions
                .Where(item => candidateAuthSessionIds.Contains(item.SessionId) && item.RevokedAt == null && item.IdleExpiresAt > now && item.AbsoluteExpiresAt > now)
                .Select(item => item.SessionId)
                .ToListAsync(cancellationToken);
        var activeAuthSessionIdSet = activeAuthSessionIds.ToHashSet();
        foreach (var authSessionId in candidateAuthSessionIds.Where(item => !activeAuthSessionIdSet.Contains(item)))
        {
            await connections.RemoveAuthSessionAsync(authSessionId, cancellationToken);
        }
        return candidates
            .Where(item => item.ObservedSessionId == observedSessionId && activeAuthSessionIdSet.Contains(item.AuthSessionId))
            .Select(item => item.ConnectionId)
            .ToArray();
    }
}
