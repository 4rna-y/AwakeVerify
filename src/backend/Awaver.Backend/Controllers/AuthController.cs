using System.Security.Claims;
using Awaver.Backend.Dto;
using Awaver.Backend.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Awaver.Backend.Controllers;

[ApiController]
[Route("api/auth")]
public sealed class AuthController(AuthSessionService authSessions) : ControllerBase
{
    [HttpGet("me")]
    [Authorize]
    [ProducesResponseType<AuthPrincipalResponse>(StatusCodes.Status200OK)]
    public IActionResult Me()
    {
        var sessionId = User.FindFirstValue("auth_session_id");
        var role = User.FindFirstValue(ClaimTypes.Role);
        var principalId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (sessionId is null || role is null || principalId is null)
        {
            return Unauthorized();
        }

        if (!DateTimeOffset.TryParse(User.FindFirstValue("absolute_expires_at"), out var expiresAt)) return Unauthorized();
        var csrfToken = Request.Cookies[AuthCookieOptions.CsrfCookieName];
        if (!string.IsNullOrWhiteSpace(csrfToken)) Response.Headers[AuthCookieOptions.CsrfHeaderName] = csrfToken;
        return Ok(new AuthPrincipalResponse(role, principalId, expiresAt));
    }

    [HttpPost("logout")]
    [Authorize]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public async Task<IActionResult> Logout(CancellationToken cancellationToken)
    {
        if (Guid.TryParse(User.FindFirstValue("auth_session_id"), out var sessionId))
        {
            await authSessions.RevokeAsync(sessionId, cancellationToken);
        }

        authSessions.DeleteCookies(Response);
        return NoContent();
    }
}
