namespace Awaver.Backend.Services;

public sealed record FrameQueueMessage(
    Guid SessionId,
    int SequenceNo,
    string BlobPath,
    DateTimeOffset CapturedAt,
    double VideoTimeSec,
    DateTimeOffset ReceivedAt,
    string Codec);
