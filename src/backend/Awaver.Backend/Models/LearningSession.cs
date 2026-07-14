namespace Awaver.Backend.Models;

public sealed class LearningSession
{
    public Guid SessionId { get; init; }
    public required string StudentId { get; init; }
    public string VideoId { get; init; } = "default";
    public DateTimeOffset StartedAt { get; init; }
    public DateTimeOffset? EndedAt { get; set; }

    public Student? Student { get; init; }
    public ICollection<PlaybackEvent> PlaybackEvents { get; } = new List<PlaybackEvent>();
}
