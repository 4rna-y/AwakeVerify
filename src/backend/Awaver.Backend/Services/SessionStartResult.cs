namespace Awaver.Backend.Services;

public sealed record SessionStartResult(Guid SessionId, string StudentId, DateTimeOffset StartedAt);
