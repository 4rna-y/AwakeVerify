namespace Awaver.Backend.Services;

public interface ISessionRepository
{
    Task<SessionStartResult> StartSessionAsync(string studentId, CancellationToken cancellationToken);
    Task<bool> SessionExistsAsync(Guid sessionId, CancellationToken cancellationToken);
}
