namespace Awaver.Backend.Dto;

public sealed record TeacherSummaryResponse(string TeacherId, DateTimeOffset CreatedAt, string? CreatedByAdminId);
