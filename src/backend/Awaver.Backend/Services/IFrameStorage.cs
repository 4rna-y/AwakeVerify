namespace Awaver.Backend.Services;

public interface IFrameStorage
{
    Task<FrameStorageWriteResult> SaveAsync(ReceivedFrame frame, CancellationToken cancellationToken);
    Task MarkAcceptedAsync(ReceivedFrame frame, CancellationToken cancellationToken);
}
