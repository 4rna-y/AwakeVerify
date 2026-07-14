using Awaver.Backend.Data;
using Awaver.Backend.Services;
using Azure.Messaging.ServiceBus;
using Azure.Storage.Blobs;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Awaver.Backend.Tests;

public sealed class BackendReadinessProbeTests
{
    [Fact]
    public async Task ShutdownStart_MakesReadinessNotReadyBeforeDependencyChecks()
    {
        await using var dbContext = new AwaverDbContext(new DbContextOptionsBuilder<AwaverDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .Options);
        await using var serviceBusClient = new ServiceBusClient("Endpoint=sb://localhost/;SharedAccessKeyName=test;SharedAccessKey=readiness-secret");
        using var services = new ServiceCollection().BuildServiceProvider();
        using var lifetime = new TestApplicationLifetime();
        lifetime.StopApplication();
        var probe = new BackendReadinessProbe(
            dbContext,
            new BlobContainerClient("UseDevelopmentStorage=true", "readiness"),
            serviceBusClient.CreateSender("frame-processing-queue"),
            services,
            new BackendTopologyOptions(1),
            lifetime,
            new ConfigurationBuilder().Build());

        var report = await probe.CheckAsync(CancellationToken.None);

        Assert.False(report.IsReady);
        Assert.Equal("stopping", report.Checks["application"]);
    }

    [Fact]
    public async Task RequiredDependencyFailure_MakesReadinessNotReadyWithoutExposingConnectionStrings()
    {
        await using var dbContext = new AwaverDbContext(new DbContextOptionsBuilder<AwaverDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .Options);
        await using var serviceBusClient = new ServiceBusClient("Endpoint=sb://localhost/;SharedAccessKeyName=test;SharedAccessKey=readiness-secret");
        using var services = new ServiceCollection().BuildServiceProvider();
        using var lifetime = new TestApplicationLifetime();
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Health:ReadinessTimeoutMs"] = "20" })
            .Build();
        var probe = new BackendReadinessProbe(
            dbContext,
            new BlobContainerClient("UseDevelopmentStorage=true", "readiness"),
            serviceBusClient.CreateSender("frame-processing-queue"),
            services,
            new BackendTopologyOptions(1),
            lifetime,
            configuration);

        var report = await probe.CheckAsync(CancellationToken.None);
        var response = System.Text.Json.JsonSerializer.Serialize(report);

        Assert.False(report.IsReady);
        Assert.Contains(report.Checks.Values, value => value is "unhealthy" or "timeout");
        Assert.DoesNotContain("readiness-secret", response, StringComparison.Ordinal);
        Assert.DoesNotContain("UseDevelopmentStorage", response, StringComparison.Ordinal);
    }

    private sealed class TestApplicationLifetime : IHostApplicationLifetime, IDisposable
    {
        private readonly CancellationTokenSource stopping = new();
        public CancellationToken ApplicationStarted => CancellationToken.None;
        public CancellationToken ApplicationStopping => stopping.Token;
        public CancellationToken ApplicationStopped => CancellationToken.None;
        public void StopApplication() => stopping.Cancel();
        public void Dispose() => stopping.Dispose();
    }
}
