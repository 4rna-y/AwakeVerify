using System.Text.Json;
using Awaver.Backend.Controllers;
using Awaver.Backend.Hubs;
using Awaver.Backend.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;

namespace Awaver.Backend.Tests;

public sealed class AnalysisResultsControllerTests
{
    [Fact]
    public async Task PublishAnalysisResult_BroadcastsToSessionGroupViaSignalR()
    {
        var sessions = new InMemorySessionRepository();
        var session = await sessions.StartSessionAsync("s12345", CancellationToken.None);
        var broadcaster = new AnalysisResultBroadcaster();
        var hubClients = new FakeHubClients();
        var controller = new AnalysisResultsController(sessions, broadcaster, new FakeHubContext(hubClients));

        var payload = JsonSerializer.Deserialize<JsonElement>(
            $$"""{"type":"drowsiness_score","sessionId":"{{session.SessionId}}","score":0.9}""");

        var result = await controller.PublishAnalysisResult(session.SessionId, payload, CancellationToken.None);

        Assert.IsType<AcceptedResult>(result);
        Assert.Equal(AnalysisEventsHub.GroupName(session.SessionId), hubClients.LastGroupName);
        Assert.Equal(AnalysisEventsHub.ReceiveAnalysisEventMethod, hubClients.LastGroupProxy?.LastMethod);
    }

    [Fact]
    public async Task PublishAnalysisResult_ReturnsBadRequestForInvalidType_WithoutBroadcasting()
    {
        var sessions = new InMemorySessionRepository();
        var session = await sessions.StartSessionAsync("s12345", CancellationToken.None);
        var broadcaster = new AnalysisResultBroadcaster();
        var hubClients = new FakeHubClients();
        var controller = new AnalysisResultsController(sessions, broadcaster, new FakeHubContext(hubClients));

        var payload = JsonSerializer.Deserialize<JsonElement>(
            $$"""{"type":"unknown_type","sessionId":"{{session.SessionId}}"}""");

        var result = await controller.PublishAnalysisResult(session.SessionId, payload, CancellationToken.None);

        Assert.IsType<BadRequestObjectResult>(result);
        Assert.Null(hubClients.LastGroupName);
    }

    private sealed class FakeHubContext(FakeHubClients clients) : IHubContext<AnalysisEventsHub>
    {
        public IHubClients Clients { get; } = clients;

        public IGroupManager Groups => throw new NotSupportedException();
    }

    private sealed class FakeHubClients : IHubClients
    {
        public string? LastGroupName { get; private set; }

        public FakeClientProxy? LastGroupProxy { get; private set; }

        public IClientProxy Group(string groupName)
        {
            LastGroupName = groupName;
            LastGroupProxy = new FakeClientProxy();
            return LastGroupProxy;
        }

        public IClientProxy All => throw new NotSupportedException();

        public IClientProxy AllExcept(IReadOnlyList<string> excludedConnectionIds) => throw new NotSupportedException();

        public IClientProxy Client(string connectionId) => throw new NotSupportedException();

        public IClientProxy Clients(IReadOnlyList<string> connectionIds) => throw new NotSupportedException();

        public IClientProxy Groups(IReadOnlyList<string> groupNames) => throw new NotSupportedException();

        public IClientProxy GroupExcept(string groupName, IReadOnlyList<string> excludedConnectionIds) => throw new NotSupportedException();

        public IClientProxy OthersInGroup(string groupName) => throw new NotSupportedException();

        public IClientProxy User(string userId) => throw new NotSupportedException();

        public IClientProxy Users(IReadOnlyList<string> userIds) => throw new NotSupportedException();
    }

    private sealed class FakeClientProxy : IClientProxy
    {
        public string? LastMethod { get; private set; }

        public object?[]? LastArgs { get; private set; }

        public Task SendCoreAsync(string method, object?[] args, CancellationToken cancellationToken = default)
        {
            LastMethod = method;
            LastArgs = args;
            return Task.CompletedTask;
        }
    }
}
