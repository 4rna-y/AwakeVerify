using System.Collections.Concurrent;
using StackExchange.Redis;

namespace Awaver.Backend.Services;

public sealed record AnalysisConnectionRegistration(
    string ConnectionId,
    Guid AuthSessionId,
    Guid ObservedSessionId,
    DateTimeOffset RegisteredAt);

/// <summary>
/// Stores the authorization binding for SignalR connections independently of the
/// SignalR transport. Implementations must fail their operations rather than
/// silently treating an unavailable registry as empty.
/// </summary>
public interface IAnalysisConnectionRegistry
{
    Task RegisterAsync(string connectionId, Guid authSessionId, Guid observedSessionId, CancellationToken cancellationToken = default);
    Task RemoveConnectionAsync(string connectionId, CancellationToken cancellationToken = default);
    Task RemoveAsync(string connectionId, Guid observedSessionId, CancellationToken cancellationToken = default);
    Task RemoveAuthSessionAsync(Guid authSessionId, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<AnalysisConnectionRegistration>> GetConnectionsForSessionAsync(Guid observedSessionId, CancellationToken cancellationToken = default);
    Task CleanupStaleConnectionsAsync(Guid observedSessionId, CancellationToken cancellationToken = default);
}

/// <summary>
/// Test and single-process fallback implementation. Production-like environments
/// use <see cref="RedisAnalysisConnectionRegistry"/> through DI instead.
/// </summary>
public sealed class InMemoryAnalysisConnectionRegistry(TimeProvider? timeProvider = null, TimeSpan? ttl = null) : IAnalysisConnectionRegistry
{
    private static readonly TimeSpan DefaultTtl = TimeSpan.FromHours(8);
    private readonly ConcurrentDictionary<string, AnalysisConnectionRegistration> registrations = new(StringComparer.Ordinal);
    private readonly TimeProvider clock = timeProvider ?? TimeProvider.System;
    private readonly TimeSpan registrationTtl = ttl ?? DefaultTtl;

    public Task RegisterAsync(string connectionId, Guid authSessionId, Guid observedSessionId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RemoveExpired();
        registrations[Key(connectionId, observedSessionId)] = new(connectionId, authSessionId, observedSessionId, clock.GetUtcNow());
        return Task.CompletedTask;
    }

    public Task RemoveConnectionAsync(string connectionId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        foreach (var registration in registrations.Values.Where(item => item.ConnectionId == connectionId))
        {
            registrations.TryRemove(Key(registration.ConnectionId, registration.ObservedSessionId), out _);
        }
        return Task.CompletedTask;
    }

    public Task RemoveAsync(string connectionId, Guid observedSessionId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        registrations.TryRemove(Key(connectionId, observedSessionId), out _);
        return Task.CompletedTask;
    }

    public Task RemoveAuthSessionAsync(Guid authSessionId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        foreach (var registration in registrations.Values.Where(item => item.AuthSessionId == authSessionId))
        {
            registrations.TryRemove(Key(registration.ConnectionId, registration.ObservedSessionId), out _);
        }
        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<AnalysisConnectionRegistration>> GetConnectionsForSessionAsync(Guid observedSessionId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RemoveExpired();
        return Task.FromResult<IReadOnlyList<AnalysisConnectionRegistration>>(
            registrations.Values.Where(item => item.ObservedSessionId == observedSessionId).ToArray());
    }

    public Task CleanupStaleConnectionsAsync(Guid observedSessionId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var now = clock.GetUtcNow();
        foreach (var registration in registrations.Values.Where(item => item.ObservedSessionId == observedSessionId && IsExpired(item, now)))
        {
            registrations.TryRemove(Key(registration.ConnectionId, registration.ObservedSessionId), out _);
        }
        return Task.CompletedTask;
    }

    private void RemoveExpired()
    {
        var now = clock.GetUtcNow();
        foreach (var registration in registrations.Values.Where(item => IsExpired(item, now)))
        {
            registrations.TryRemove(Key(registration.ConnectionId, registration.ObservedSessionId), out _);
        }
    }

    private bool IsExpired(AnalysisConnectionRegistration registration, DateTimeOffset now) => registration.RegisteredAt + registrationTtl <= now;
    private static string Key(string connectionId, Guid observedSessionId) => $"{connectionId}:{observedSessionId:D}";
}

/// <summary>
/// Redis schema (all keys use the signalr:connection-registry namespace and a shared cluster hash tag):
/// connection:{connectionId} (hash), connection:{connectionId}:sessions (set),
/// session:{observedSessionId}:connections (set), and auth:{authSessionId}:connections (set).
/// The common hash tag keeps every Lua script key in one Redis Cluster slot while preserving atomic updates.
/// </summary>
public sealed class RedisAnalysisConnectionRegistry(IConnectionMultiplexer multiplexer, TimeSpan? ttl = null) : IAnalysisConnectionRegistry
{
    private const string Namespace = "signalr:connection-registry";
    internal const string ClusterHashTag = "{signalr-registry}";
    private static readonly TimeSpan DefaultTtl = TimeSpan.FromHours(8);
    private readonly IDatabase database = multiplexer.GetDatabase();
    private readonly TimeSpan registrationTtl = ttl ?? DefaultTtl;

    private const string RegisterScript = """
        local existing = redis.call('HGET', KEYS[1], 'authSessionId')
        if existing and existing ~= ARGV[1] then
            return redis.error_reply('connection ID is already bound to a different auth session')
        end
        redis.call('HSET', KEYS[1], 'authSessionId', ARGV[1], 'registeredAtUnixMs', ARGV[3])
        redis.call('SADD', KEYS[2], ARGV[2])
        redis.call('SADD', KEYS[3], ARGV[4])
        redis.call('SADD', KEYS[4], ARGV[4])
        local sessions = redis.call('SMEMBERS', KEYS[2])
        for _, sessionId in ipairs(sessions) do
            redis.call('PEXPIRE', ARGV[6] .. sessionId .. ':connections', ARGV[5])
        end
        redis.call('PEXPIRE', KEYS[1], ARGV[5])
        redis.call('PEXPIRE', KEYS[2], ARGV[5])
        redis.call('PEXPIRE', KEYS[3], ARGV[5])
        redis.call('PEXPIRE', KEYS[4], ARGV[5])
        return 1
        """;

    private const string RemoveObservedSessionScript = """
        local authSessionId = redis.call('HGET', KEYS[1], 'authSessionId')
        redis.call('SREM', KEYS[2], ARGV[1])
        redis.call('SREM', KEYS[3], ARGV[2])
        if redis.call('SCARD', KEYS[2]) == 0 then
            redis.call('DEL', KEYS[1])
            redis.call('DEL', KEYS[2])
            if authSessionId then redis.call('SREM', ARGV[3] .. authSessionId .. ':connections', ARGV[2]) end
        end
        return 1
        """;

    private const string RemoveConnectionScript = """
        local authSessionId = redis.call('HGET', KEYS[1], 'authSessionId')
        local sessions = redis.call('SMEMBERS', KEYS[2])
        for _, sessionId in ipairs(sessions) do
            redis.call('SREM', ARGV[1] .. sessionId .. ':connections', ARGV[2])
        end
        if authSessionId then redis.call('SREM', ARGV[3] .. authSessionId .. ':connections', ARGV[2]) end
        redis.call('DEL', KEYS[1])
        redis.call('DEL', KEYS[2])
        return 1
        """;

    private const string RemoveAuthSessionScript = """
        local connections = redis.call('SMEMBERS', KEYS[1])
        for _, connectionId in ipairs(connections) do
            local connectionKey = ARGV[1] .. connectionId
            local connectionSessionsKey = connectionKey .. ':sessions'
            local sessions = redis.call('SMEMBERS', connectionSessionsKey)
            for _, sessionId in ipairs(sessions) do
                redis.call('SREM', ARGV[2] .. sessionId .. ':connections', connectionId)
            end
            redis.call('DEL', connectionKey)
            redis.call('DEL', connectionSessionsKey)
        end
        redis.call('DEL', KEYS[1])
        return 1
        """;

    private const string GetAndCleanupScript = """
        local connections = redis.call('SMEMBERS', KEYS[1])
        local result = {}
        for _, connectionId in ipairs(connections) do
            local connectionKey = ARGV[1] .. connectionId
            local authSessionId = redis.call('HGET', connectionKey, 'authSessionId')
            local subscribed = redis.call('SISMEMBER', connectionKey .. ':sessions', ARGV[2])
            if authSessionId and subscribed == 1 then
                table.insert(result, connectionId)
                table.insert(result, authSessionId)
            else
                redis.call('SREM', KEYS[1], connectionId)
            end
        end
        return result
        """;

    public async Task RegisterAsync(string connectionId, Guid authSessionId, Guid observedSessionId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var now = DateTimeOffset.UtcNow;
        await database.ScriptEvaluateAsync(RegisterScript,
            [ConnectionKey(connectionId), ConnectionSessionsKey(connectionId), SessionConnectionsKey(observedSessionId), AuthConnectionsKey(authSessionId)],
            [authSessionId.ToString("D"), observedSessionId.ToString("D"), now.ToUnixTimeMilliseconds(), connectionId, (long)registrationTtl.TotalMilliseconds, SessionKeyPrefix]).ConfigureAwait(false);
    }

    public async Task RemoveConnectionAsync(string connectionId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await database.ScriptEvaluateAsync(RemoveConnectionScript,
            [ConnectionKey(connectionId), ConnectionSessionsKey(connectionId)],
            [SessionKeyPrefix, connectionId, AuthKeyPrefix]).ConfigureAwait(false);
    }

    public async Task RemoveAsync(string connectionId, Guid observedSessionId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await database.ScriptEvaluateAsync(RemoveObservedSessionScript,
            [ConnectionKey(connectionId), ConnectionSessionsKey(connectionId), SessionConnectionsKey(observedSessionId)],
            [observedSessionId.ToString("D"), connectionId, AuthKeyPrefix]).ConfigureAwait(false);
    }

    public async Task RemoveAuthSessionAsync(Guid authSessionId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await database.ScriptEvaluateAsync(RemoveAuthSessionScript,
            [AuthConnectionsKey(authSessionId)],
            [ConnectionKeyPrefix, SessionKeyPrefix]).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<AnalysisConnectionRegistration>> GetConnectionsForSessionAsync(Guid observedSessionId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var result = (RedisResult[])(await database.ScriptEvaluateAsync(GetAndCleanupScript,
            [SessionConnectionsKey(observedSessionId)],
            [ConnectionKeyPrefix, observedSessionId.ToString("D")]).ConfigureAwait(false))!;
        var registrations = new List<AnalysisConnectionRegistration>(result.Length / 2);
        for (var index = 0; index < result.Length; index += 2)
        {
            if (Guid.TryParse((string?)result[index + 1], out var authSessionId))
            {
                registrations.Add(new AnalysisConnectionRegistration((string)result[index]!, authSessionId, observedSessionId, DateTimeOffset.MinValue));
            }
        }
        return registrations;
    }

    public async Task CleanupStaleConnectionsAsync(Guid observedSessionId, CancellationToken cancellationToken = default)
    {
        _ = await GetConnectionsForSessionAsync(observedSessionId, cancellationToken).ConfigureAwait(false);
    }

    internal static string ConnectionKey(string connectionId) => $"{ConnectionKeyPrefix}{connectionId}";
    internal static string ConnectionSessionsKey(string connectionId) => $"{ConnectionKey(connectionId)}:sessions";
    internal static string SessionConnectionsKey(Guid observedSessionId) => $"{SessionKeyPrefix}{observedSessionId:D}:connections";
    internal static string AuthConnectionsKey(Guid authSessionId) => $"{AuthKeyPrefix}{authSessionId:D}:connections";
    private static string ConnectionKeyPrefix => $"{Namespace}:{ClusterHashTag}:connection:";
    private static string SessionKeyPrefix => $"{Namespace}:{ClusterHashTag}:session:";
    private static string AuthKeyPrefix => $"{Namespace}:{ClusterHashTag}:auth:";
}
