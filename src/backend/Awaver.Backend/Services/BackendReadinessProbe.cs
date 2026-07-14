using Awaver.Backend.Data;
using Azure.Messaging.ServiceBus;
using Azure.Storage.Blobs;
using System.Collections.Concurrent;
using Microsoft.Extensions.DependencyInjection;
using StackExchange.Redis;

namespace Awaver.Backend.Services;

public sealed record BackendReadinessReport(string Status, IReadOnlyDictionary<string, string> Checks)
{
    public bool IsReady => Status == "ready";
}

/// <summary>
/// Checks only whether this Backend can safely accept new frame and notification
/// traffic. Check names and statuses are intentionally non-sensitive.
/// </summary>
public sealed class BackendReadinessProbe(
    AwaverDbContext dbContext,
    BlobContainerClient blobContainer,
    ServiceBusSender serviceBusSender,
    IServiceProvider services,
    BackendTopologyOptions topology,
    IHostApplicationLifetime applicationLifetime,
    IConfiguration configuration)
{
    private const int DefaultTimeoutMs = 2_000;

    public async Task<BackendReadinessReport> CheckAsync(CancellationToken cancellationToken)
    {
        var timeout = ReadTimeoutMs(configuration);
        var checks = new ConcurrentDictionary<string, string>(StringComparer.Ordinal)
        {
            ["postgresql"] = "pending",
            ["blob_storage"] = "pending",
            ["service_bus_sender"] = "pending",
            ["signalr_registry"] = "pending",
            ["azure_signalr"] = topology.RequiresDistributedSignalR ? "healthy" : "not_required",
        };

        if (applicationLifetime.ApplicationStopping.IsCancellationRequested)
        {
            checks["application"] = "stopping";
            return new("not_ready", checks);
        }

        var redis = services.GetService<IConnectionMultiplexer>();
        checks["signalr_registry"] = redis is null ? "not_required" : "pending";

        var tasks = new[]
        {
            SetCheckAsync(checks, "postgresql", token => dbContext.Database.CanConnectAsync(token), timeout, cancellationToken),
            SetCheckAsync(checks, "blob_storage", async token =>
            {
                await blobContainer.CreateIfNotExistsAsync(cancellationToken: token);
            }, timeout, cancellationToken),
            SetCheckAsync(checks, "service_bus_sender", async token =>
            {
                using var batch = await serviceBusSender.CreateMessageBatchAsync(cancellationToken: token);
            }, timeout, cancellationToken),
        };

        if (redis is not null)
        {
            tasks = [.. tasks, SetCheckAsync(checks, "signalr_registry", async token =>
            {
                await redis.GetDatabase().PingAsync(CommandFlags.DemandMaster).WaitAsync(token);
            }, timeout, cancellationToken)];
        }

        await Task.WhenAll(tasks);
        var status = checks.Values.All(value => value is "healthy" or "not_required") ? "ready" : "not_ready";
        return new(status, checks);
    }

    internal static int ReadTimeoutMs(IConfiguration configuration)
    {
        var rawValue = Environment.GetEnvironmentVariable("READINESS_TIMEOUT_MS")
            ?? configuration["Health:ReadinessTimeoutMs"];
        if (string.IsNullOrWhiteSpace(rawValue)) return DefaultTimeoutMs;
        if (!int.TryParse(rawValue, out var timeoutMs) || timeoutMs <= 0)
        {
            throw new InvalidOperationException("Invalid READINESS_TIMEOUT_MS: expected a positive integer.");
        }
        return timeoutMs;
    }

    private static async Task SetCheckAsync(
        ConcurrentDictionary<string, string> checks,
        string name,
        Func<CancellationToken, Task> check,
        int timeoutMs,
        CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(timeoutMs);
        try
        {
            await check(timeout.Token);
            checks[name] = "healthy";
        }
        catch (OperationCanceledException) when (timeout.IsCancellationRequested)
        {
            checks[name] = "timeout";
        }
        catch
        {
            checks[name] = "unhealthy";
        }
    }
}
