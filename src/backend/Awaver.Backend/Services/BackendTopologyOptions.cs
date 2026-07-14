using Microsoft.Extensions.Configuration;

namespace Awaver.Backend.Services;

/// <summary>
/// Deployment topology supplied by IaC. This is deliberately an explicit
/// contract: process-local SignalR is safe only when one Backend instance is
/// expected to receive connections.
/// </summary>
public sealed record BackendTopologyOptions(int ExpectedInstanceCount)
{
    public const int DefaultExpectedInstanceCount = 1;

    public bool RequiresDistributedSignalR => ExpectedInstanceCount > 1;

    public static BackendTopologyOptions Load(IConfiguration configuration)
    {
        var rawValue = Environment.GetEnvironmentVariable("BACKEND_EXPECTED_INSTANCE_COUNT")
            ?? configuration["Backend:ExpectedInstanceCount"];
        if (string.IsNullOrWhiteSpace(rawValue)) return new(DefaultExpectedInstanceCount);
        if (!int.TryParse(rawValue, out var expectedInstanceCount) || expectedInstanceCount <= 0)
        {
            throw new InvalidOperationException("Invalid BACKEND_EXPECTED_INSTANCE_COUNT: expected a positive integer.");
        }
        return new(expectedInstanceCount);
    }

    public void ValidateDistributedDependencies(bool hasAzureSignalRConnectionString, bool hasRedisConnectionString)
    {
        if (!RequiresDistributedSignalR) return;
        if (!hasAzureSignalRConnectionString)
        {
            throw new InvalidOperationException("AZURE_SIGNALR_CONNECTION_STRING / Azure:SignalR:ConnectionString is required when BACKEND_EXPECTED_INSTANCE_COUNT is greater than 1.");
        }
        if (!hasRedisConnectionString)
        {
            throw new InvalidOperationException("REDIS_CONNECTION_STRING / Redis:ConnectionString is required when BACKEND_EXPECTED_INSTANCE_COUNT is greater than 1.");
        }
    }
}
