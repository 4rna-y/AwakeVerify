using Microsoft.Extensions.Configuration;

namespace Awaver.Backend.Services;

/// <summary>
/// Bounded work for one outbox dispatcher instance. The defaults keep a single
/// instance responsive while allowing several sessions to make progress in one
/// poll; production values are deliberately deployment configuration.
/// </summary>
public sealed record OutboxDispatchOptions
{
    public const int DefaultBatchSize = 100;
    public const int DefaultPollIntervalMs = 250;
    public const int DefaultLeaseSeconds = 30;

    public int BatchSize { get; init; } = DefaultBatchSize;
    public int PollIntervalMs { get; init; } = DefaultPollIntervalMs;
    public int LeaseSeconds { get; init; } = DefaultLeaseSeconds;

    public TimeSpan PollInterval => TimeSpan.FromMilliseconds(PollIntervalMs);
    public TimeSpan LeaseDuration => TimeSpan.FromSeconds(LeaseSeconds);

    public static OutboxDispatchOptions Load(IConfiguration configuration)
    {
        var options = new OutboxDispatchOptions
        {
            BatchSize = ReadPositiveInt(configuration["Outbox:BatchSize"], Environment.GetEnvironmentVariable("OUTBOX_BATCH_SIZE"), DefaultBatchSize, "OUTBOX_BATCH_SIZE"),
            PollIntervalMs = ReadPositiveInt(configuration["Outbox:PollIntervalMs"], Environment.GetEnvironmentVariable("OUTBOX_POLL_INTERVAL_MS"), DefaultPollIntervalMs, "OUTBOX_POLL_INTERVAL_MS"),
            LeaseSeconds = ReadPositiveInt(configuration["Outbox:LeaseSeconds"], Environment.GetEnvironmentVariable("OUTBOX_LEASE_SECONDS"), DefaultLeaseSeconds, "OUTBOX_LEASE_SECONDS"),
        };
        return options;
    }

    private static int ReadPositiveInt(string? configuredValue, string? environmentValue, int defaultValue, string settingName)
    {
        var value = !string.IsNullOrWhiteSpace(environmentValue) ? environmentValue : configuredValue;
        if (string.IsNullOrWhiteSpace(value)) return defaultValue;
        if (!int.TryParse(value, out var parsed) || parsed <= 0)
        {
            throw new InvalidOperationException($"Invalid {settingName}: expected a positive integer.");
        }
        return parsed;
    }
}
