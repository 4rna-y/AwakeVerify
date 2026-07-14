using Awaver.Backend.Hubs;
using Awaver.Backend.Services;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Awaver.Backend.Tests;

public sealed class AnalysisOutboxDispatcherShutdownTests
{
    [Fact]
    public async Task Shutdown_PreventsAnySubsequentOutboxClaim()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSignalR();
        await using var provider = services.BuildServiceProvider();
        var dispatcher = new AnalysisOutboxDispatcher(
            provider.GetRequiredService<IServiceScopeFactory>(),
            provider.GetRequiredService<IHubContext<AnalysisEventsHub>>(),
            new AnalysisResultBroadcaster(),
            new InMemoryAnalysisConnectionRegistry(),
            new OutboxDispatchOptions(),
            provider.GetRequiredService<ILogger<AnalysisOutboxDispatcher>>());

        await dispatcher.StopAsync(CancellationToken.None);
        await dispatcher.DispatchDueEventsAsync(CancellationToken.None);
    }
}
