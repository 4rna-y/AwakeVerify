namespace Awaver.Backend.Services;

public sealed class FramePipeline(IFrameStorage storage, IFrameQueue queue)
{
    public async Task<FrameIngressResult> HandleAsync(ReceivedFrame frame, CancellationToken cancellationToken)
    {
        var storageResult = await storage.SaveAsync(frame, cancellationToken);
        if (storageResult.AlreadyAccepted) return FrameIngressResult.Duplicate;

        var message = new FrameQueueMessage(
            frame.SessionId,
            frame.SequenceNo,
            storageResult.BlobPath,
            frame.CapturedAt,
            frame.VideoTimeSec,
            frame.ReceivedAt,
            frame.Codec);

        await queue.EnqueueAsync(message, cancellationToken);
        await storage.MarkAcceptedAsync(frame, cancellationToken);
        return FrameIngressResult.Accepted;
    }
}

public enum FrameIngressResult
{
    Accepted,
    Duplicate,
}
