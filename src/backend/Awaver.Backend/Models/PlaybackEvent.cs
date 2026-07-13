namespace Awaver.Backend.Models;

public sealed class PlaybackEvent
{
    public Guid EventId { get; init; }
    public Guid SessionId { get; init; }
    public required string Type { get; init; }
    public DateTimeOffset OccurredAt { get; init; }
    public double? VideoTimeSec { get; init; }

    public LearningSession? LearningSession { get; init; }
}
