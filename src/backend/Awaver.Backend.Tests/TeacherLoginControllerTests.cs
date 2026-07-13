using Awaver.Backend.Controllers;
using Awaver.Backend.Data;
using Awaver.Backend.Dto;
using Awaver.Backend.Models;
using Awaver.Backend.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Awaver.Backend.Tests;

public sealed class TeacherLoginControllerTests
{
    [Fact]
    public async Task Login_ReturnsSuccessForValidCredentials()
    {
        await using var dbContext = CreateDbContext();
        await SeedTeacherAsync(dbContext, "teacher1", "correct-password");
        var controller = CreateController(dbContext);

        var result = await controller.Login(
            new TeacherLoginRequest { TeacherId = "teacher1", Password = "correct-password" },
            CancellationToken.None);

        var okResult = Assert.IsType<OkObjectResult>(result.Result);
        var response = Assert.IsType<TeacherLoginResponse>(okResult.Value);
        Assert.True(response.Success);
    }

    [Fact]
    public async Task Login_ReturnsFailureForInvalidPassword()
    {
        await using var dbContext = CreateDbContext();
        await SeedTeacherAsync(dbContext, "teacher1", "correct-password");
        var controller = CreateController(dbContext);

        var result = await controller.Login(
            new TeacherLoginRequest { TeacherId = "teacher1", Password = "wrong-password" },
            CancellationToken.None);

        var okResult = Assert.IsType<OkObjectResult>(result.Result);
        var response = Assert.IsType<TeacherLoginResponse>(okResult.Value);
        Assert.False(response.Success);
    }

    [Fact]
    public async Task Login_ReturnsFailureForUnknownTeacherId()
    {
        await using var dbContext = CreateDbContext();
        var controller = CreateController(dbContext);

        var result = await controller.Login(
            new TeacherLoginRequest { TeacherId = "unknown-teacher", Password = "whatever" },
            CancellationToken.None);

        var okResult = Assert.IsType<OkObjectResult>(result.Result);
        var response = Assert.IsType<TeacherLoginResponse>(okResult.Value);
        Assert.False(response.Success);
    }

    private static AwaverDbContext CreateDbContext()
    {
        var options = new DbContextOptionsBuilder<AwaverDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .Options;

        return new AwaverDbContext(options);
    }

    private static TeacherController CreateController(AwaverDbContext dbContext)
    {
        return new TeacherController(dbContext);
    }

    private static async Task SeedTeacherAsync(AwaverDbContext dbContext, string teacherId, string password)
    {
        dbContext.Teachers.Add(new Teacher
        {
            TeacherId = teacherId,
            PasswordHash = PasswordHasher.Hash(password),
            CreatedAt = DateTimeOffset.UtcNow,
        });
        await dbContext.SaveChangesAsync();
    }
}
