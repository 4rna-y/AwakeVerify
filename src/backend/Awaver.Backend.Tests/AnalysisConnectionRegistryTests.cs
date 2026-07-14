using Awaver.Backend.Data;
using Awaver.Backend.Models;
using Awaver.Backend.Services;
using Microsoft.EntityFrameworkCore;
using StackExchange.Redis;

namespace Awaver.Backend.Tests;

public sealed class AnalysisConnectionRegistryTests
{
    [Fact]
    public async Task RegistrationFromOneBackendScope_IsVisibleToAnotherScope()
    {
        IAnalysisConnectionRegistry sharedRegistry = new InMemoryAnalysisConnectionRegistry();
        var sessionId = Guid.NewGuid();
        var authSessionId = Guid.NewGuid();

        await sharedRegistry.RegisterAsync("connection-from-instance-a", authSessionId, sessionId);

        var connectionsObservedByInstanceB = await sharedRegistry.GetConnectionsForSessionAsync(sessionId);

        var connection = Assert.Single(connectionsObservedByInstanceB);
        Assert.Equal("connection-from-instance-a", connection.ConnectionId);
        Assert.Equal(authSessionId, connection.AuthSessionId);
    }

    [Fact]
    public async Task GetConnectionsForSession_DoesNotReturnOtherSessions()
    {
        var registry = new InMemoryAnalysisConnectionRegistry();
        var observedSessionId = Guid.NewGuid();
        await registry.RegisterAsync("target", Guid.NewGuid(), observedSessionId);
        await registry.RegisterAsync("other", Guid.NewGuid(), Guid.NewGuid());

        var connections = await registry.GetConnectionsForSessionAsync(observedSessionId);

        Assert.Equal(["target"], connections.Select(item => item.ConnectionId));
    }

    [Fact]
    public async Task RemoveConnection_RemovesEveryObservedSession()
    {
        var registry = new InMemoryAnalysisConnectionRegistry();
        var authSessionId = Guid.NewGuid();
        var firstSessionId = Guid.NewGuid();
        var secondSessionId = Guid.NewGuid();
        await registry.RegisterAsync("connection", authSessionId, firstSessionId);
        await registry.RegisterAsync("connection", authSessionId, secondSessionId);

        await registry.RemoveConnectionAsync("connection");

        Assert.Empty(await registry.GetConnectionsForSessionAsync(firstSessionId));
        Assert.Empty(await registry.GetConnectionsForSessionAsync(secondSessionId));
    }

    [Fact]
    public async Task Revoke_RemovesAllRegistrationsForAuthSession()
    {
        await using var dbContext = CreateDb();
        var registry = new InMemoryAnalysisConnectionRegistry();
        var authSessionId = Guid.NewGuid();
        var observedSessionId = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;
        dbContext.AuthSessions.Add(new AuthSession
        {
            SessionId = authSessionId,
            PrincipalType = AuthSessionService.StudentRole,
            PrincipalId = observedSessionId.ToString("D"),
            IssuedAt = now,
            IdleExpiresAt = now.AddMinutes(30),
            AbsoluteExpiresAt = now.AddHours(8),
        });
        await dbContext.SaveChangesAsync();
        await registry.RegisterAsync("connection", authSessionId, observedSessionId);
        var authSessions = new AuthSessionService(dbContext, new AuthCookieOptions { IsDevelopment = true }, registry);

        await authSessions.RevokeAsync(authSessionId, CancellationToken.None);

        Assert.Empty(await registry.GetConnectionsForSessionAsync(observedSessionId));
    }

    [Fact]
    public async Task IdleExpiredAuthSession_IsExcludedAndCleanedUpBeforeDelivery()
    {
        await using var dbContext = CreateDb();
        var registry = new InMemoryAnalysisConnectionRegistry();
        var sessionId = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;
        var authSessionId = await AddAuthSessionAsync(dbContext, sessionId, now.AddMinutes(-1), now.AddHours(1));
        await registry.RegisterAsync("idle-expired", authSessionId, sessionId);

        var connectionIds = await AnalysisOutboxDispatcher.GetAuthorizedConnectionIdsAsync(registry, sessionId, dbContext, now, CancellationToken.None);

        Assert.Empty(connectionIds);
        Assert.Empty(await registry.GetConnectionsForSessionAsync(sessionId));
    }

    [Fact]
    public async Task AbsoluteExpiredAuthSession_IsExcludedAndCleanedUpBeforeDelivery()
    {
        await using var dbContext = CreateDb();
        var registry = new InMemoryAnalysisConnectionRegistry();
        var sessionId = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;
        var authSessionId = await AddAuthSessionAsync(dbContext, sessionId, now.AddHours(1), now.AddSeconds(-1));
        await registry.RegisterAsync("absolute-expired", authSessionId, sessionId);

        var connectionIds = await AnalysisOutboxDispatcher.GetAuthorizedConnectionIdsAsync(registry, sessionId, dbContext, now, CancellationToken.None);

        Assert.Empty(connectionIds);
        Assert.Empty(await registry.GetConnectionsForSessionAsync(sessionId));
    }

    [Fact]
    public async Task ExpiredRegistration_IsNotReturned()
    {
        var now = DateTimeOffset.UtcNow;
        var clock = new MutableTimeProvider(now);
        var registry = new InMemoryAnalysisConnectionRegistry(clock, TimeSpan.FromMinutes(1));
        var sessionId = Guid.NewGuid();
        await registry.RegisterAsync("stale", Guid.NewGuid(), sessionId);
        clock.UtcNow = now.AddMinutes(1);

        await registry.CleanupStaleConnectionsAsync(sessionId);

        Assert.Empty(await registry.GetConnectionsForSessionAsync(sessionId));
    }

    [Fact]
    public async Task Reconnect_LeavesOnlyTheNewConnectionIdRegistered()
    {
        var registry = new InMemoryAnalysisConnectionRegistry();
        var sessionId = Guid.NewGuid();
        var authSessionId = Guid.NewGuid();
        await registry.RegisterAsync("old-connection", authSessionId, sessionId);
        await registry.RemoveConnectionAsync("old-connection");
        await registry.RegisterAsync("new-connection", authSessionId, sessionId);

        var connections = await registry.GetConnectionsForSessionAsync(sessionId);

        Assert.Equal(["new-connection"], connections.Select(item => item.ConnectionId));
    }

    [Fact]
    public async Task RegistryFailure_PropagatesToOutboxDeliveryResolution()
    {
        await using var dbContext = CreateDb();

        await Assert.ThrowsAsync<RedisException>(() => AnalysisOutboxDispatcher.GetAuthorizedConnectionIdsAsync(
            new UnavailableRegistry(), Guid.NewGuid(), dbContext, DateTimeOffset.UtcNow, CancellationToken.None));
    }

    private static AwaverDbContext CreateDb() => new(new DbContextOptionsBuilder<AwaverDbContext>()
        .UseInMemoryDatabase(Guid.NewGuid().ToString())
        .Options);

    private static async Task<Guid> AddAuthSessionAsync(AwaverDbContext dbContext, Guid observedSessionId, DateTimeOffset idleExpiresAt, DateTimeOffset absoluteExpiresAt)
    {
        var authSessionId = Guid.NewGuid();
        dbContext.AuthSessions.Add(new AuthSession
        {
            SessionId = authSessionId,
            PrincipalType = AuthSessionService.StudentRole,
            PrincipalId = observedSessionId.ToString("D"),
            IssuedAt = DateTimeOffset.UtcNow.AddHours(-1),
            IdleExpiresAt = idleExpiresAt,
            AbsoluteExpiresAt = absoluteExpiresAt,
        });
        await dbContext.SaveChangesAsync();
        return authSessionId;
    }

    private sealed class MutableTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public DateTimeOffset UtcNow { get; set; } = utcNow;
        public override DateTimeOffset GetUtcNow() => UtcNow;
    }

    private sealed class UnavailableRegistry : IAnalysisConnectionRegistry
    {
        public Task RegisterAsync(string connectionId, Guid authSessionId, Guid observedSessionId, CancellationToken cancellationToken = default) => Task.FromException(new RedisException("unavailable"));
        public Task RemoveConnectionAsync(string connectionId, CancellationToken cancellationToken = default) => Task.FromException(new RedisException("unavailable"));
        public Task RemoveAsync(string connectionId, Guid observedSessionId, CancellationToken cancellationToken = default) => Task.FromException(new RedisException("unavailable"));
        public Task RemoveAuthSessionAsync(Guid authSessionId, CancellationToken cancellationToken = default) => Task.FromException(new RedisException("unavailable"));
        public Task<IReadOnlyList<AnalysisConnectionRegistration>> GetConnectionsForSessionAsync(Guid observedSessionId, CancellationToken cancellationToken = default) => Task.FromException<IReadOnlyList<AnalysisConnectionRegistration>>(new RedisException("unavailable"));
        public Task CleanupStaleConnectionsAsync(Guid observedSessionId, CancellationToken cancellationToken = default) => Task.FromException(new RedisException("unavailable"));
    }
}
