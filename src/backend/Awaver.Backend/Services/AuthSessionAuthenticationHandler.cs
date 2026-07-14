using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace Awaver.Backend.Services;

public sealed class AuthSessionAuthenticationHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder,
    AuthSessionService authSessions,
    AuthCookieOptions cookieOptions) : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "auth-session";

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var rawSessionId = Request.Cookies[cookieOptions.BrowserCookieName] ?? Request.Cookies[AuthCookieOptions.StudentCookieName];
        if (!Guid.TryParse(rawSessionId, out var sessionId))
        {
            return AuthenticateResult.NoResult();
        }

        var session = await authSessions.ValidateAndRefreshAsync(sessionId, Context.RequestAborted);
        if (session is null)
        {
            return AuthenticateResult.Fail("The server session is invalid, expired, or revoked.");
        }

        var identity = new ClaimsIdentity(SchemeName);
        identity.AddClaim(new Claim(ClaimTypes.NameIdentifier, session.PrincipalId));
        identity.AddClaim(new Claim(ClaimTypes.Role, session.PrincipalType));
        identity.AddClaim(new Claim("auth_session_id", session.SessionId.ToString("D")));
        identity.AddClaim(new Claim("absolute_expires_at", session.AbsoluteExpiresAt.ToString("O")));
        if (session.PrincipalType == AuthSessionService.StudentRole)
        {
            identity.AddClaim(new Claim("learning_session_id", session.PrincipalId));
        }

        return AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), SchemeName));
    }
}
