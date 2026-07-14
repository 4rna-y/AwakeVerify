using System.Security.Claims;
using Awaver.Backend.Data;
using Awaver.Backend.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Awaver.Backend.Hubs;

[Authorize]
public sealed class AnalysisEventsHub(
    AwaverDbContext dbContext,
    AuthSessionService authSessions,
    IAnalysisConnectionRegistry connections,
    ILogger<AnalysisEventsHub> logger) : Hub
{
    public const string ReceiveAnalysisEventMethod = "ReceiveAnalysisEvent";

    public async Task JoinSession(Guid sessionId)
    {
        if (!Guid.TryParse(Context.User?.FindFirstValue("auth_session_id"), out var authSessionId) ||
            await authSessions.ValidateAndRefreshAsync(authSessionId, Context.ConnectionAborted) is null ||
            !await dbContext.LearningSessions.AnyAsync(item => item.SessionId == sessionId, Context.ConnectionAborted) || !CanObserve(sessionId))
        {
            throw new HubException("You are not authorized to observe this session.");
        }
        await Groups.AddToGroupAsync(Context.ConnectionId, GroupName(sessionId), Context.ConnectionAborted);
        await connections.RegisterAsync(Context.ConnectionId, authSessionId, sessionId, Context.ConnectionAborted);
    }

    public async Task LeaveSession(Guid sessionId)
    {
        await connections.RemoveAsync(Context.ConnectionId, sessionId, Context.ConnectionAborted);
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, GroupName(sessionId), Context.ConnectionAborted);
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        try
        {
            await connections.RemoveConnectionAsync(Context.ConnectionId, CancellationToken.None);
        }
        catch (Exception cleanupException)
        {
            // The TTL remains the fallback for abrupt disconnects and failed cleanup.
            logger.LogWarning(cleanupException, "Failed to remove SignalR connection registry entries after disconnect.");
        }
        await base.OnDisconnectedAsync(exception);
    }

    public static string GroupName(Guid sessionId) => $"session-{sessionId}";

    private bool CanObserve(Guid sessionId) =>
        Context.User?.IsInRole(AuthSessionService.AdminRole) == true ||
        (Context.User?.IsInRole(AuthSessionService.StudentRole) == true &&
         Guid.TryParse(Context.User.FindFirstValue("learning_session_id"), out var studentSessionId) && studentSessionId == sessionId);
}
