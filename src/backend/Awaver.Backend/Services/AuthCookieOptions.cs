namespace Awaver.Backend.Services;

public sealed class AuthCookieOptions
{
    public const string ProductionCookieName = "__Host-awaver-auth";
    public const string DevelopmentCookieName = "awaver-auth";
    public const string StudentCookieName = "student_session";
    public const string CsrfCookieName = "awaver-csrf";
    public const string CsrfHeaderName = "X-CSRF-Token";

    public required bool IsDevelopment { get; init; }
    public string BrowserCookieName => IsDevelopment ? DevelopmentCookieName : ProductionCookieName;
}
