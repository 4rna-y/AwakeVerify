using Awaver.Backend.Data;
using Awaver.Backend.Dto;
using Awaver.Backend.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Awaver.Backend.Controllers;

[ApiController]
[Route("api/teacher")]
public sealed class TeacherController(AwaverDbContext dbContext) : ControllerBase
{
    [HttpPost("login")]
    [ProducesResponseType<TeacherLoginResponse>(StatusCodes.Status200OK)]
    public async Task<ActionResult<TeacherLoginResponse>> Login(
        TeacherLoginRequest request,
        CancellationToken cancellationToken)
    {
        var teacherId = request.TeacherId?.Trim();
        if (string.IsNullOrEmpty(teacherId) || string.IsNullOrEmpty(request.Password))
        {
            return Ok(new TeacherLoginResponse(false));
        }

        var teacher = await dbContext.Teachers.SingleOrDefaultAsync(t => t.TeacherId == teacherId, cancellationToken);
        var success = teacher is not null && PasswordHasher.Verify(request.Password, teacher.PasswordHash);

        return Ok(new TeacherLoginResponse(success));
    }
}
