namespace Awaver.Backend.Services;

public interface IFrameStorage
{
    Task<string> SaveAsync(ReceivedFrame frame, CancellationToken cancellationToken);
}
