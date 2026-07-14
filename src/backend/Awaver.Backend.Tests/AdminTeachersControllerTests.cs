using System.Security.Claims;
using Awaver.Backend.Controllers;
using Awaver.Backend.Data;
using Awaver.Backend.Dto;
using Awaver.Backend.Models;
using Awaver.Backend.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Awaver.Backend.Tests;

public sealed class AdminTeachersControllerTests
{
    [Fact]
    public async Task Login_CreatesOpaqueServerSessionAndHttpOnlyCookie()
    {
        await using var db = CreateDb();
        db.Admins.Add(new Admin { AdminId = "admin1", PasswordHash = PasswordHasher.Hash("correct-password"), CreatedAt = DateTimeOffset.UtcNow });
        await db.SaveChangesAsync();
        var controller = new AdminController(db, Auth(db));
        controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() };

        var result = await controller.Login(new AdminLoginRequest { AdminId = "admin1", Password = "correct-password" }, CancellationToken.None);

        var response = Assert.IsType<AuthLoginResponse>(Assert.IsType<OkObjectResult>(result.Result).Value);
        Assert.True(response.Authenticated);
        var session = await db.AuthSessions.SingleAsync();
        Assert.Equal(AuthSessionService.AdminRole, session.PrincipalType);
        Assert.Contains("awaver-auth=", controller.Response.Headers.SetCookie.ToString());
        Assert.Contains("httponly", controller.Response.Headers.SetCookie.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task CreateTeacher_UsesAuthenticatedAdminInsteadOfRequestBody()
    {
        await using var db = CreateDb();
        var controller = new AdminController(db, Auth(db));
        controller.ControllerContext = WithPrincipal(AuthSessionService.AdminRole, "admin-from-session");

        var result = await controller.CreateTeacher(new CreateTeacherRequest { TeacherId = "teacher1", Password = "teacher-password" }, CancellationToken.None);

        Assert.IsType<CreatedAtActionResult>(result.Result);
        var teacher = await db.Teachers.SingleAsync();
        Assert.Equal("admin-from-session", teacher.CreatedByAdminId);
        Assert.True(PasswordHasher.Verify("teacher-password", teacher.PasswordHash));
    }

    private static AwaverDbContext CreateDb() => new(new DbContextOptionsBuilder<AwaverDbContext>().UseInMemoryDatabase(Guid.NewGuid().ToString()).Options);
    private static AuthSessionService Auth(AwaverDbContext db) => new(db, new AuthCookieOptions { IsDevelopment = true });
    private static ControllerContext WithPrincipal(string role, string id) => new()
    {
        HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.Role, role), new Claim(ClaimTypes.NameIdentifier, id)], "test")) }
    };
}
