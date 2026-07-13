namespace Awaver.Backend.Models;

public sealed class Teacher
{
    public required string TeacherId { get; init; }
    public required string PasswordHash { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
    public string? CreatedByAdminId { get; init; }
}
