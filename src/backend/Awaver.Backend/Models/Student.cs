namespace Awaver.Backend.Models;

public sealed class Student
{
    public required string StudentId { get; init; }
    public DateTimeOffset CreatedAt { get; init; }

    public ICollection<LearningSession> LearningSessions { get; } = new List<LearningSession>();
}
