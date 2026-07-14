using Awaver.Backend.Controllers;
using Awaver.Backend.Data;
using Awaver.Backend.Dto;
using Awaver.Backend.Models;
using Awaver.Backend.Services;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Awaver.Backend.Tests;

public sealed class TeacherLoginControllerTests
{
    [Fact]
    public async Task Login_CreatesTeacherSessionWithEightHourAbsoluteExpiry()
    {
        await using var db = CreateDb();
        db.Teachers.Add(new Teacher { TeacherId = "teacher1", PasswordHash = PasswordHasher.Hash("correct-password"), CreatedAt = DateTimeOffset.UtcNow });
        await db.SaveChangesAsync();
        var controller = new TeacherController(db, new AuthSessionService(db, new AuthCookieOptions { IsDevelopment = true }))
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() }
        };

        var result = await controller.Login(new TeacherLoginRequest { TeacherId = "teacher1", Password = "correct-password" }, CancellationToken.None);

        var response = Assert.IsType<AuthLoginResponse>(Assert.IsType<OkObjectResult>(result.Result).Value);
        Assert.True(response.Authenticated);
        var session = await db.AuthSessions.SingleAsync();
        Assert.Equal(AuthSessionService.TeacherRole, session.PrincipalType);
        Assert.Equal(TimeSpan.FromHours(8), session.AbsoluteExpiresAt - session.IssuedAt);
        Assert.Contains("httponly", controller.Response.Headers.SetCookie.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Login_RejectsInvalidPasswordWithoutCreatingSession()
    {
        await using var db = CreateDb();
        db.Teachers.Add(new Teacher { TeacherId = "teacher1", PasswordHash = PasswordHasher.Hash("correct-password"), CreatedAt = DateTimeOffset.UtcNow });
        await db.SaveChangesAsync();
        var controller = new TeacherController(db, new AuthSessionService(db, new AuthCookieOptions { IsDevelopment = true }))
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() }
        };

        var result = await controller.Login(new TeacherLoginRequest { TeacherId = "teacher1", Password = "wrong" }, CancellationToken.None);

        Assert.False(Assert.IsType<AuthLoginResponse>(Assert.IsType<OkObjectResult>(result.Result).Value).Authenticated);
        Assert.Empty(db.AuthSessions);
    }

    [Fact]
    public async Task Login_UpgradesLegacyPbkdf2HashToIdentityV3()
    {
        await using var db = CreateDb();
        const string password = "legacy-password";
        var salt = Enumerable.Range(1, 16).Select(value => (byte)value).ToArray();
        var hash = Rfc2898DeriveBytes.Pbkdf2(password, salt, 100_000, HashAlgorithmName.SHA256, 32);
        var legacyHash = $"100000.{Convert.ToBase64String(salt)}.{Convert.ToBase64String(hash)}";
        db.Teachers.Add(new Teacher { TeacherId = "legacy-teacher", PasswordHash = legacyHash, CreatedAt = DateTimeOffset.UtcNow });
        await db.SaveChangesAsync();
        var controller = new TeacherController(db, new AuthSessionService(db, new AuthCookieOptions { IsDevelopment = true }))
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() }
        };

        var result = await controller.Login(new TeacherLoginRequest { TeacherId = "legacy-teacher", Password = password }, CancellationToken.None);

        Assert.True(Assert.IsType<AuthLoginResponse>(Assert.IsType<OkObjectResult>(result.Result).Value).Authenticated);
        var storedHash = (await db.Teachers.SingleAsync()).PasswordHash;
        Assert.StartsWith("AQAAAA", storedHash, StringComparison.Ordinal);
        Assert.True(PasswordHasher.Verify(password, storedHash));
        Assert.False(PasswordHasher.Verify("wrong", storedHash));
    }

    private static AwaverDbContext CreateDb() => new(new DbContextOptionsBuilder<AwaverDbContext>().UseInMemoryDatabase(Guid.NewGuid().ToString()).Options);
}
