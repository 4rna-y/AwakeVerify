using Awaver.Backend.Services;
using Microsoft.Extensions.Configuration;

namespace Awaver.Backend.Tests;

public sealed class BackendTopologyOptionsTests
{
    [Fact]
    public void LocalSingleInstance_AllowsProcessLocalSignalR()
    {
        var options = BackendTopologyOptions.Load(new ConfigurationBuilder().Build());

        options.ValidateDistributedDependencies(hasAzureSignalRConnectionString: false, hasRedisConnectionString: false);

        Assert.Equal(1, options.ExpectedInstanceCount);
        Assert.False(options.RequiresDistributedSignalR);
    }

    [Fact]
    public void MultipleInstances_RequireAzureSignalRAndRedis()
    {
        var options = BackendTopologyOptions.Load(new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Backend:ExpectedInstanceCount"] = "2" })
            .Build());

        var signalRException = Assert.Throws<InvalidOperationException>(() =>
            options.ValidateDistributedDependencies(hasAzureSignalRConnectionString: false, hasRedisConnectionString: true));
        var redisException = Assert.Throws<InvalidOperationException>(() =>
            options.ValidateDistributedDependencies(hasAzureSignalRConnectionString: true, hasRedisConnectionString: false));

        Assert.Contains("AZURE_SIGNALR_CONNECTION_STRING", signalRException.Message);
        Assert.Contains("REDIS_CONNECTION_STRING", redisException.Message);
        options.ValidateDistributedDependencies(hasAzureSignalRConnectionString: true, hasRedisConnectionString: true);
    }

    [Theory]
    [InlineData("0")]
    [InlineData("invalid")]
    public void ExpectedInstanceCount_RejectsNonPositiveOrInvalidValues(string value)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Backend:ExpectedInstanceCount"] = value })
            .Build();

        var exception = Assert.Throws<InvalidOperationException>(() => BackendTopologyOptions.Load(configuration));

        Assert.Contains("BACKEND_EXPECTED_INSTANCE_COUNT", exception.Message);
    }

    [Theory]
    [InlineData("0")]
    [InlineData("invalid")]
    public void ReadinessTimeout_RejectsInvalidValues(string value)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Health:ReadinessTimeoutMs"] = value })
            .Build();

        var exception = Assert.Throws<InvalidOperationException>(() => BackendReadinessProbe.ReadTimeoutMs(configuration));

        Assert.Contains("READINESS_TIMEOUT_MS", exception.Message);
    }
}
