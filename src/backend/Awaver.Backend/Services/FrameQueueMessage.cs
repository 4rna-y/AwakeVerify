namespace Awaver.Backend.Services;

public sealed record FrameQueueMessage(
    Guid SessionId,
    int SequenceNo,
    string FrameType,
    int BaseIFrameSequenceNo,
    string BlobPath,
    DateTimeOffset CapturedAt,
    DateTimeOffset ReceivedAt,
    string Codec);
