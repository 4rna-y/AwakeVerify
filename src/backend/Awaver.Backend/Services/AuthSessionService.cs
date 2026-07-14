using System.Security.Cryptography;
using Awaver.Backend.Data;
using Awaver.Backend.Models;
using Microsoft.EntityFrameworkCore;

namespace Awaver.Backend.Services;

public sealed class AuthSessionService(AwaverDbContext dbContext, AuthCookieOptions cookieOptions, IAnalysisConnectionRegistry? connections = null)
{
    public const string AdminRole = "admin";
    public const string TeacherRole = "teacher";
    public const string StudentRole = "student_session";

    public async Task<AuthSession> CreateAsync(string role, string principalId, TimeSpan absoluteLifetime, TimeSpan idleLifetime, CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var session = new AuthSession
        {
            SessionId = Guid.NewGuid(),
            PrincipalType = role,
            PrincipalId = principalId,
            IssuedAt = now,
            IdleExpiresAt = now.Add(idleLifetime),
            AbsoluteExpiresAt = now.Add(absoluteLifetime),
        };
        dbContext.AuthSessions.Add(session);
        await dbContext.SaveChangesAsync(cancellationToken);
        return session;
    }

    public async Task<AuthSession?> ValidateAndRefreshAsync(Guid sessionId, CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var session = await dbContext.AuthSessions.SingleOrDefaultAsync(item => item.SessionId == sessionId, cancellationToken);
        if (session is null || session.RevokedAt is not null || session.IdleExpiresAt <= now || session.AbsoluteExpiresAt <= now)
        {
            return null;
        }

        var refreshedIdleExpiry = now.AddMinutes(30);
        var nextIdleExpiry = refreshedIdleExpiry < session.AbsoluteExpiresAt ? refreshedIdleExpiry : session.AbsoluteExpiresAt;
        if (nextIdleExpiry > session.IdleExpiresAt)
        {
            session.IdleExpiresAt = nextIdleExpiry;
            await dbContext.SaveChangesAsync(cancellationToken);
        }

        return session;
    }

    public async Task RevokeAsync(Guid sessionId, CancellationToken cancellationToken)
    {
        var session = await dbContext.AuthSessions.SingleOrDefaultAsync(item => item.SessionId == sessionId, cancellationToken);
        if (session is not null && session.RevokedAt is null)
        {
            session.RevokedAt = DateTimeOffset.UtcNow;
            await dbContext.SaveChangesAsync(cancellationToken);
        }
        if (connections is not null) await connections.RemoveAuthSessionAsync(sessionId, cancellationToken);
    }

    public async Task RevokeCookiesAsync(HttpRequest request, CancellationToken cancellationToken)
    {
        var cookieNames = new[] { cookieOptions.BrowserCookieName, AuthCookieOptions.StudentCookieName };
        foreach (var cookieName in cookieNames)
        {
            if (Guid.TryParse(request.Cookies[cookieName], out var sessionId))
            {
                await RevokeAsync(sessionId, cancellationToken);
            }
        }
    }

    public void AppendCookies(HttpResponse response, AuthSession session)
    {
        var cookieName = session.PrincipalType == StudentRole ? AuthCookieOptions.StudentCookieName : cookieOptions.BrowserCookieName;
        var expiresAt = session.PrincipalType == StudentRole ? session.AbsoluteExpiresAt : session.AbsoluteExpiresAt;
        response.Cookies.Append(cookieName, session.SessionId.ToString("D"), new CookieOptions
        {
            HttpOnly = true,
            Secure = !cookieOptions.IsDevelopment,
            SameSite = SameSiteMode.Lax,
            Path = "/",
            Expires = expiresAt,
            IsEssential = true,
        });

        var csrfToken = CreateCsrfToken();
        response.Cookies.Append(AuthCookieOptions.CsrfCookieName, csrfToken, new CookieOptions
        {
            HttpOnly = false,
            Secure = !cookieOptions.IsDevelopment,
            SameSite = SameSiteMode.Lax,
            Path = "/",
            Expires = expiresAt,
            IsEssential = true,
        });
        response.Headers[AuthCookieOptions.CsrfHeaderName] = csrfToken;
    }

    public void DeleteCookies(HttpResponse response, HttpRequest? request = null, params string[] keepCookieNames)
    {
        var options = new CookieOptions { Secure = !cookieOptions.IsDevelopment, SameSite = SameSiteMode.Lax, Path = "/" };
        var names = new[] { cookieOptions.BrowserCookieName, AuthCookieOptions.StudentCookieName, AuthCookieOptions.CsrfCookieName };
        foreach (var name in names)
        {
            if (keepCookieNames.Contains(name, StringComparer.Ordinal)) continue;
            if (request is not null && !request.Cookies.ContainsKey(name)) continue;
            response.Cookies.Delete(name, options);
        }
    }

    public string BrowserCookieName => cookieOptions.BrowserCookieName;

    private static string CreateCsrfToken() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
}
