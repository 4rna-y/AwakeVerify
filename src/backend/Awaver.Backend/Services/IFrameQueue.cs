namespace Awaver.Backend.Services;

public interface IFrameQueue
{
    Task EnqueueAsync(FrameQueueMessage message, CancellationToken cancellationToken);
}
