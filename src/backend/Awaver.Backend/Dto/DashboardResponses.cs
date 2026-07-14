namespace Awaver.Backend.Dto;

public sealed record DashboardSessionResponse(Guid SessionId, string StudentId, string VideoId, DateTimeOffset StartedAt, DateTimeOffset? EndedAt, string? LatestLevel);
public sealed record DashboardSessionDetailResponse(Guid SessionId, string StudentId, string VideoId, DateTimeOffset StartedAt, DateTimeOffset? EndedAt);
public sealed record DashboardScoreResponse(DateTimeOffset ScoredAt, decimal Score, string Level, decimal Perclos, decimal Ear, decimal PitchDeg, decimal YawDeg, double? VideoTimeSec);
public sealed record DashboardPlaybackEventResponse(Guid EventId, string Type, DateTimeOffset OccurredAt, double? VideoTimeSec);
