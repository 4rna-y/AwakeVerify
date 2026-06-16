using System.Collections.Concurrent;

namespace Awaver.Backend.Services;

public sealed class InMemorySessionRepository : ISessionRepository
{
    private readonly ConcurrentDictionary<string, DateTimeOffset> _students = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<Guid, SessionStartResult> _sessions = new();

    public Task<SessionStartResult> StartSessionAsync(string studentId, CancellationToken cancellationToken)
    {
        var normalizedStudentId = studentId.Trim();
        var now = DateTimeOffset.UtcNow;

        _students.TryAdd(normalizedStudentId, now);

        var result = new SessionStartResult(Guid.NewGuid(), normalizedStudentId, now);
        _sessions[result.SessionId] = result;

        return Task.FromResult(result);
    }

    public Task<bool> SessionExistsAsync(Guid sessionId, CancellationToken cancellationToken)
    {
        return Task.FromResult(_sessions.ContainsKey(sessionId));
    }
}
