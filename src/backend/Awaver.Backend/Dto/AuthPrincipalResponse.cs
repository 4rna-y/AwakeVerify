using System.Text.Json.Serialization;
using Awaver.Backend.Services;

namespace Awaver.Backend.Dto;

public sealed record AuthPrincipalResponse(string Role, string PrincipalId, DateTimeOffset ExpiresAt)
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? TeacherId => Role == AuthSessionService.TeacherRole ? PrincipalId : null;

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? AdminId => Role == AuthSessionService.AdminRole ? PrincipalId : null;

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? StudentSessionId => Role == AuthSessionService.StudentRole ? PrincipalId : null;
}

public sealed record AuthLoginResponse(bool Authenticated, AuthPrincipalResponse? Principal = null);
