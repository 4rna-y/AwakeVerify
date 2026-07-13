using Awaver.Backend.Controllers;
using Awaver.Backend.Data;
using Awaver.Backend.Dto;
using Awaver.Backend.Models;
using Awaver.Backend.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Awaver.Backend.Tests;

public sealed class AdminTeachersControllerTests
{
    [Fact]
    public async Task Login_ReturnsSuccessForValidCredentials()
    {
        await using var dbContext = CreateDbContext();
        await SeedAdminAsync(dbContext, "admin1", "correct-password");
        var controller = CreateController(dbContext);

        var result = await controller.Login(
            new AdminLoginRequest { AdminId = "admin1", Password = "correct-password" },
            CancellationToken.None);

        var okResult = Assert.IsType<OkObjectResult>(result.Result);
        var response = Assert.IsType<AdminLoginResponse>(okResult.Value);
        Assert.True(response.Success);
    }

    [Fact]
    public async Task Login_ReturnsFailureForInvalidPassword()
    {
        await using var dbContext = CreateDbContext();
        await SeedAdminAsync(dbContext, "admin1", "correct-password");
        var controller = CreateController(dbContext);

        var result = await controller.Login(
            new AdminLoginRequest { AdminId = "admin1", Password = "wrong-password" },
            CancellationToken.None);

        var okResult = Assert.IsType<OkObjectResult>(result.Result);
        var response = Assert.IsType<AdminLoginResponse>(okResult.Value);
        Assert.False(response.Success);
    }

    [Fact]
    public async Task Login_ReturnsFailureForUnknownAdminId()
    {
        await using var dbContext = CreateDbContext();
        var controller = CreateController(dbContext);

        var result = await controller.Login(
            new AdminLoginRequest { AdminId = "unknown-admin", Password = "whatever" },
            CancellationToken.None);

        var okResult = Assert.IsType<OkObjectResult>(result.Result);
        var response = Assert.IsType<AdminLoginResponse>(okResult.Value);
        Assert.False(response.Success);
    }

    [Fact]
    public async Task CreateTeacher_SavesValidTeacherAndHashesPassword()
    {
        await using var dbContext = CreateDbContext();
        await SeedAdminAsync(dbContext, "admin1", "admin-password");
        var controller = CreateController(dbContext);

        var result = await controller.CreateTeacher(
            new CreateTeacherRequest { AdminId = "admin1", TeacherId = "teacher1", Password = "teacher-password" },
            CancellationToken.None);

        Assert.IsType<CreatedAtActionResult>(result.Result);

        var teacher = await dbContext.Teachers.SingleAsync();
        Assert.Equal("teacher1", teacher.TeacherId);
        Assert.Equal("admin1", teacher.CreatedByAdminId);
        Assert.NotEqual("teacher-password", teacher.PasswordHash);
        Assert.True(PasswordHasher.Verify("teacher-password", teacher.PasswordHash));
    }

    [Fact]
    public async Task CreateTeacher_ReturnsConflictForDuplicateTeacherId()
    {
        await using var dbContext = CreateDbContext();
        await SeedAdminAsync(dbContext, "admin1", "admin-password");
        var controller = CreateController(dbContext);

        await controller.CreateTeacher(
            new CreateTeacherRequest { AdminId = "admin1", TeacherId = "teacher1", Password = "teacher-password" },
            CancellationToken.None);

        var result = await controller.CreateTeacher(
            new CreateTeacherRequest { AdminId = "admin1", TeacherId = "teacher1", Password = "another-password" },
            CancellationToken.None);

        Assert.IsType<ConflictObjectResult>(result.Result);
        Assert.Single(dbContext.Teachers);
    }

    [Fact]
    public async Task CreateTeacher_ReturnsUnauthorizedForUnknownAdmin()
    {
        await using var dbContext = CreateDbContext();
        var controller = CreateController(dbContext);

        var result = await controller.CreateTeacher(
            new CreateTeacherRequest { AdminId = "unknown-admin", TeacherId = "teacher1", Password = "teacher-password" },
            CancellationToken.None);

        Assert.IsType<UnauthorizedObjectResult>(result.Result);
        Assert.Empty(dbContext.Teachers);
    }

    [Fact]
    public async Task CreateTeacher_ReturnsBadRequestForBlankTeacherId()
    {
        await using var dbContext = CreateDbContext();
        await SeedAdminAsync(dbContext, "admin1", "admin-password");
        var controller = CreateController(dbContext);

        var result = await controller.CreateTeacher(
            new CreateTeacherRequest { AdminId = "admin1", TeacherId = "   ", Password = "teacher-password" },
            CancellationToken.None);

        Assert.IsType<BadRequestObjectResult>(result.Result);
        Assert.Empty(dbContext.Teachers);
    }

    [Fact]
    public async Task CreateTeacher_ReturnsBadRequestForEmptyPassword()
    {
        await using var dbContext = CreateDbContext();
        await SeedAdminAsync(dbContext, "admin1", "admin-password");
        var controller = CreateController(dbContext);

        var result = await controller.CreateTeacher(
            new CreateTeacherRequest { AdminId = "admin1", TeacherId = "teacher1", Password = "" },
            CancellationToken.None);

        Assert.IsType<BadRequestObjectResult>(result.Result);
        Assert.Empty(dbContext.Teachers);
    }

    [Fact]
    public async Task GetTeachers_ReturnsTeachersWithoutPasswordHash()
    {
        await using var dbContext = CreateDbContext();
        await SeedAdminAsync(dbContext, "admin1", "admin-password");
        var controller = CreateController(dbContext);
        await controller.CreateTeacher(
            new CreateTeacherRequest { AdminId = "admin1", TeacherId = "teacher1", Password = "teacher-password" },
            CancellationToken.None);

        var result = await controller.GetTeachers(CancellationToken.None);

        var okResult = Assert.IsType<OkObjectResult>(result.Result);
        var teachers = Assert.IsAssignableFrom<IEnumerable<TeacherSummaryResponse>>(okResult.Value);
        var teacher = Assert.Single(teachers);
        Assert.Equal("teacher1", teacher.TeacherId);
        Assert.Equal("admin1", teacher.CreatedByAdminId);
        Assert.DoesNotContain("passwordHash", teacher.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    private static AwaverDbContext CreateDbContext()
    {
        var options = new DbContextOptionsBuilder<AwaverDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .Options;

        return new AwaverDbContext(options);
    }

    private static AdminController CreateController(AwaverDbContext dbContext)
    {
        return new AdminController(dbContext);
    }

    private static async Task SeedAdminAsync(AwaverDbContext dbContext, string adminId, string password)
    {
        dbContext.Admins.Add(new Admin
        {
            AdminId = adminId,
            PasswordHash = PasswordHasher.Hash(password),
            CreatedAt = DateTimeOffset.UtcNow,
        });
        await dbContext.SaveChangesAsync();
    }
}
