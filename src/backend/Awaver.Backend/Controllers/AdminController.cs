using System.Security.Claims;
using Awaver.Backend.Data;
using Awaver.Backend.Dto;
using Awaver.Backend.Models;
using Awaver.Backend.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Awaver.Backend.Controllers;

[ApiController]
[Route("api/admin")]
public sealed class AdminController(AwaverDbContext dbContext, AuthSessionService authSessions) : ControllerBase
{
    [HttpPost("login")]
    [ProducesResponseType<AuthLoginResponse>(StatusCodes.Status200OK)]
    public async Task<ActionResult<AuthLoginResponse>> Login(AdminLoginRequest request, CancellationToken cancellationToken)
    {
        var adminId = request.AdminId?.Trim();
        if (string.IsNullOrEmpty(adminId) || string.IsNullOrEmpty(request.Password)) return Ok(new AuthLoginResponse(false));

        var admin = await dbContext.Admins.SingleOrDefaultAsync(item => item.AdminId == adminId, cancellationToken);
        if (admin is null || !PasswordHasher.Verify(request.Password, admin.PasswordHash, out var needsRehash)) return Ok(new AuthLoginResponse(false));
        if (needsRehash) admin.PasswordHash = PasswordHasher.Hash(request.Password);

        await authSessions.RevokeCookiesAsync(Request, cancellationToken);
        authSessions.DeleteCookies(Response, Request, authSessions.BrowserCookieName, AuthCookieOptions.CsrfCookieName);
        var session = await authSessions.CreateAsync(AuthSessionService.AdminRole, admin.AdminId, TimeSpan.FromHours(8), TimeSpan.FromMinutes(30), cancellationToken);
        authSessions.AppendCookies(Response, session);
        return Ok(new AuthLoginResponse(true, new AuthPrincipalResponse(AuthSessionService.AdminRole, admin.AdminId, session.AbsoluteExpiresAt)));
    }

    [HttpGet("teachers")]
    [Authorize(Roles = AuthSessionService.AdminRole)]
    public async Task<ActionResult<IEnumerable<TeacherSummaryResponse>>> GetTeachers(CancellationToken cancellationToken)
    {
        var teachers = await dbContext.Teachers.OrderBy(item => item.CreatedAt)
            .Select(item => new TeacherSummaryResponse(item.TeacherId, item.CreatedAt, item.CreatedByAdminId)).ToListAsync(cancellationToken);
        return Ok(teachers);
    }

    [HttpPost("teachers")]
    [Authorize(Roles = AuthSessionService.AdminRole)]
    [ProducesResponseType<TeacherSummaryResponse>(StatusCodes.Status201Created)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<TeacherSummaryResponse>> CreateTeacher(CreateTeacherRequest request, CancellationToken cancellationToken)
    {
        var adminId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (string.IsNullOrEmpty(adminId)) return Unauthorized();
        var teacherId = request.TeacherId?.Trim();
        if (string.IsNullOrEmpty(teacherId)) return BadRequest("teacherId is required.");
        if (string.IsNullOrEmpty(request.Password)) return BadRequest("password is required.");
        if (await dbContext.Teachers.AnyAsync(item => item.TeacherId == teacherId, cancellationToken)) return Conflict("teacherId already exists.");

        var teacher = new Teacher { TeacherId = teacherId, PasswordHash = PasswordHasher.Hash(request.Password), CreatedAt = DateTimeOffset.UtcNow, CreatedByAdminId = adminId };
        dbContext.Teachers.Add(teacher);
        await dbContext.SaveChangesAsync(cancellationToken);
        return CreatedAtAction(nameof(GetTeachers), null, new TeacherSummaryResponse(teacher.TeacherId, teacher.CreatedAt, teacher.CreatedByAdminId));
    }
}
