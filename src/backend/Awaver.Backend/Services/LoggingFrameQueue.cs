namespace Awaver.Backend.Services;

public sealed class LoggingFrameQueue(ILogger<LoggingFrameQueue> logger) : IFrameQueue
{
    public Task EnqueueAsync(FrameQueueMessage message, CancellationToken cancellationToken)
    {
        logger.LogInformation(
            "Frame queued locally: session={SessionId} sequence={SequenceNo} type={FrameType} blob={BlobPath}",
            message.SessionId,
            message.SequenceNo,
            message.FrameType,
            message.BlobPath);

        return Task.CompletedTask;
    }
}
