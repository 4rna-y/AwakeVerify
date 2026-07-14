namespace Awaver.Backend.Services;

public sealed class FramePipeline(IFrameStorage storage, IFrameQueue queue)
{
    public async Task HandleAsync(ReceivedFrame frame, CancellationToken cancellationToken)
    {
        var blobPath = await storage.SaveAsync(frame, cancellationToken);
        var message = new FrameQueueMessage(
            frame.SessionId,
            frame.SequenceNo,
            blobPath,
            frame.CapturedAt,
            frame.VideoTimeSec,
            frame.ReceivedAt,
            frame.Codec);

        await queue.EnqueueAsync(message, cancellationToken);
    }
}
