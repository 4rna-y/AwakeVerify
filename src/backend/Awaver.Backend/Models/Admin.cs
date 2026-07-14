namespace Awaver.Backend.Models;

public sealed class Admin
{
    public required string AdminId { get; init; }
    public required string PasswordHash { get; set; }
    public DateTimeOffset CreatedAt { get; init; }
}
