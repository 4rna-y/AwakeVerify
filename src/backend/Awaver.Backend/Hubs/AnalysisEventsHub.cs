using Microsoft.AspNetCore.SignalR;

namespace Awaver.Backend.Hubs;

public sealed class AnalysisEventsHub : Hub
{
    public const string ReceiveAnalysisEventMethod = "ReceiveAnalysisEvent";

    public Task JoinSession(Guid sessionId) =>
        Groups.AddToGroupAsync(Context.ConnectionId, GroupName(sessionId));

    public Task LeaveSession(Guid sessionId) =>
        Groups.RemoveFromGroupAsync(Context.ConnectionId, GroupName(sessionId));

    public static string GroupName(Guid sessionId) => $"session-{sessionId}";
}
