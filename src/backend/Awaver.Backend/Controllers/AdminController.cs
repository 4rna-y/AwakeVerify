using Awaver.Backend.Data;
using Awaver.Backend.Dto;
using Awaver.Backend.Models;
using Awaver.Backend.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Awaver.Backend.Controllers;

[ApiController]
[Route("api/admin")]
public sealed class AdminController(AwaverDbContext dbContext) : ControllerBase
{
    [HttpPost("login")]
    [ProducesResponseType<AdminLoginResponse>(StatusCodes.Status200OK)]
    public async Task<ActionResult<AdminLoginResponse>> Login(
        AdminLoginRequest request,
        CancellationToken cancellationToken)
    {
        var adminId = request.AdminId?.Trim();
        if (string.IsNullOrEmpty(adminId) || string.IsNullOrEmpty(request.Password))
        {
            return Ok(new AdminLoginResponse(false));
        }

        var admin = await dbContext.Admins.SingleOrDefaultAsync(a => a.AdminId == adminId, cancellationToken);
        var success = admin is not null && PasswordHasher.Verify(request.Password, admin.PasswordHash);

        return Ok(new AdminLoginResponse(success));
    }

    [HttpGet("teachers")]
    [ProducesResponseType<TeacherSummaryResponse[]>(StatusCodes.Status200OK)]
    public async Task<ActionResult<IEnumerable<TeacherSummaryResponse>>> GetTeachers(CancellationToken cancellationToken)
    {
        var teachers = await dbContext.Teachers
            .OrderBy(teacher => teacher.CreatedAt)
            .Select(teacher => new TeacherSummaryResponse(teacher.TeacherId, teacher.CreatedAt, teacher.CreatedByAdminId))
            .ToListAsync(cancellationToken);

        return Ok(teachers);
    }

    [HttpPost("teachers")]
    [ProducesResponseType<TeacherSummaryResponse>(StatusCodes.Status201Created)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<TeacherSummaryResponse>> CreateTeacher(
        CreateTeacherRequest request,
        CancellationToken cancellationToken)
    {
        var adminId = request.AdminId?.Trim();
        if (string.IsNullOrEmpty(adminId) ||
            !await dbContext.Admins.AnyAsync(admin => admin.AdminId == adminId, cancellationToken))
        {
            return Unauthorized("Admin authentication is required.");
        }

        var teacherId = request.TeacherId?.Trim();
        if (string.IsNullOrEmpty(teacherId))
        {
            return BadRequest("teacherId is required.");
        }

        if (string.IsNullOrEmpty(request.Password))
        {
            return BadRequest("password is required.");
        }

        if (await dbContext.Teachers.AnyAsync(teacher => teacher.TeacherId == teacherId, cancellationToken))
        {
            return Conflict("teacherId already exists.");
        }

        var teacher = new Teacher
        {
            TeacherId = teacherId,
            PasswordHash = PasswordHasher.Hash(request.Password),
            CreatedAt = DateTimeOffset.UtcNow,
            CreatedByAdminId = adminId,
        };

        dbContext.Teachers.Add(teacher);
        await dbContext.SaveChangesAsync(cancellationToken);

        var response = new TeacherSummaryResponse(teacher.TeacherId, teacher.CreatedAt, teacher.CreatedByAdminId);
        return CreatedAtAction(nameof(GetTeachers), null, response);
    }
}
