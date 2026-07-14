namespace Awaver.Backend.Services;

public interface ISessionRepository
{
    Task<SessionStartResult> StartSessionAsync(string studentId, string videoId, CancellationToken cancellationToken);
    Task<bool> SessionExistsAsync(Guid sessionId, CancellationToken cancellationToken);
}
