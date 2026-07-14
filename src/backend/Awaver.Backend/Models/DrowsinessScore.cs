namespace Awaver.Backend.Models;

public sealed class DrowsinessScore
{
    public Guid SessionId { get; init; }
    public long SourceSequenceNo { get; init; }
    public DateTimeOffset ScoredAt { get; init; }
    public decimal Score { get; init; }
    public DrowsinessLevel Level { get; init; }
    public decimal Perclos { get; init; }
    public decimal Ear { get; init; }
    public decimal PitchDeg { get; init; }
    public decimal YawDeg { get; init; }
    public double? VideoTimeSec { get; init; }

    public LearningSession? LearningSession { get; init; }
}
