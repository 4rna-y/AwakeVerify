namespace Awaver.Backend.Models;

public sealed class AuthSession
{
    public Guid SessionId { get; init; }
    public required string PrincipalType { get; init; }
    public required string PrincipalId { get; init; }
    public DateTimeOffset IssuedAt { get; init; }
    public DateTimeOffset IdleExpiresAt { get; set; }
    public DateTimeOffset AbsoluteExpiresAt { get; init; }
    public DateTimeOffset? RevokedAt { get; set; }
}
