namespace Awaver.Backend.Services;

public sealed record ReceivedFrame(
    Guid SessionId,
    int SequenceNo,
    DateTimeOffset CapturedAt,
    double VideoTimeSec,
    DateTimeOffset ReceivedAt,
    string Codec,
    byte[] Payload);
