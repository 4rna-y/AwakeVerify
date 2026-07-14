namespace Awaver.Backend.Models;

public sealed class Calibration
{
    public Guid SessionId { get; init; }
    public decimal EarOpen { get; init; }
    public decimal EarThreshold { get; init; }
    public int ValidFrames { get; init; }
    public int TotalFrames { get; init; }
    public DateTimeOffset CalibratedAt { get; init; }
    public long SourceSequenceNo { get; init; }

    public LearningSession? LearningSession { get; init; }
}
