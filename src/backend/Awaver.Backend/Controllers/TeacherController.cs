using Awaver.Backend.Data;
using Awaver.Backend.Dto;
using Awaver.Backend.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Awaver.Backend.Controllers;

[ApiController]
[Route("api/teacher")]
public sealed class TeacherController(AwaverDbContext dbContext, AuthSessionService authSessions) : ControllerBase
{
    [HttpPost("login")]
    [ProducesResponseType<AuthLoginResponse>(StatusCodes.Status200OK)]
    public async Task<ActionResult<AuthLoginResponse>> Login(TeacherLoginRequest request, CancellationToken cancellationToken)
    {
        var teacherId = request.TeacherId?.Trim();
        if (string.IsNullOrEmpty(teacherId) || string.IsNullOrEmpty(request.Password)) return Ok(new AuthLoginResponse(false));

        var teacher = await dbContext.Teachers.SingleOrDefaultAsync(item => item.TeacherId == teacherId, cancellationToken);
        if (teacher is null || !PasswordHasher.Verify(request.Password, teacher.PasswordHash, out var needsRehash)) return Ok(new AuthLoginResponse(false));
        if (needsRehash) teacher.PasswordHash = PasswordHasher.Hash(request.Password);

        await authSessions.RevokeCookiesAsync(Request, cancellationToken);
        authSessions.DeleteCookies(Response, Request, authSessions.BrowserCookieName, AuthCookieOptions.CsrfCookieName);
        var session = await authSessions.CreateAsync(AuthSessionService.TeacherRole, teacher.TeacherId, TimeSpan.FromHours(8), TimeSpan.FromMinutes(30), cancellationToken);
        authSessions.AppendCookies(Response, session);
        return Ok(new AuthLoginResponse(true, new AuthPrincipalResponse(AuthSessionService.TeacherRole, teacher.TeacherId, session.AbsoluteExpiresAt)));
    }
}
