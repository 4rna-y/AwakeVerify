namespace Awaver.Backend.Services;

public sealed record ReceivedFrame(
    Guid SessionId,
    int SequenceNo,
    FrameType FrameType,
    int BaseIFrameSequenceNo,
    DateTimeOffset CapturedAt,
    DateTimeOffset ReceivedAt,
    string Codec,
    byte[] Payload);
