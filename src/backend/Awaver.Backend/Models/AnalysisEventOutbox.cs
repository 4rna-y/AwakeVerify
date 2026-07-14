namespace Awaver.Backend.Models;

public sealed class AnalysisEventOutbox
{
    public Guid EventId { get; init; }
    public Guid SessionId { get; init; }
    public required string IdempotencyKey { get; init; }
    public required string Payload { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset? DeliveredAt { get; set; }
    public int AttemptCount { get; set; }
    public DateTimeOffset NextAttemptAt { get; set; }
    public string? LastError { get; set; }
    public Guid? LeaseId { get; set; }
    public DateTimeOffset? LockedUntil { get; set; }
    public string? ProcessingOwner { get; set; }

    public LearningSession? LearningSession { get; init; }
}
