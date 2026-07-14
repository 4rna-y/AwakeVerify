using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Awaver.Backend.Controllers;
using Awaver.Backend.Data;
using Awaver.Backend.Models;
using Awaver.Backend.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Awaver.Backend.Tests;

public sealed class DashboardControllerTests
{
    [Fact]
    public async Task GetSessions_UsesPersistedLatestScoreRatherThanNotificationState()
    {
        await using var db = new AwaverDbContext(new DbContextOptionsBuilder<AwaverDbContext>().UseInMemoryDatabase(Guid.NewGuid().ToString()).Options);
        db.Students.Add(new Student { StudentId = "student1", CreatedAt = DateTimeOffset.UtcNow });
        var session = new LearningSession { SessionId = Guid.NewGuid(), StudentId = "student1", StartedAt = DateTimeOffset.Parse("2026-06-14T10:00:00Z") };
        db.LearningSessions.Add(session);
        db.DrowsinessScores.AddRange(
            new DrowsinessScore { SessionId = session.SessionId, SourceSequenceNo = 1, ScoredAt = DateTimeOffset.Parse("2026-06-14T10:00:01Z"), Score = .2m, Level = DrowsinessLevel.Normal, Perclos = .1m, Ear = .3m, PitchDeg = 0, YawDeg = 0 },
            new DrowsinessScore { SessionId = session.SessionId, SourceSequenceNo = 2, ScoredAt = DateTimeOffset.Parse("2026-06-14T10:00:02Z"), Score = .8m, Level = DrowsinessLevel.Danger, Perclos = .6m, Ear = .1m, PitchDeg = 0, YawDeg = 0, VideoTimeSec = 123.45 });
        await db.SaveChangesAsync();

        var controller = new DashboardController(db);
        var result = await controller.GetSessions(CancellationToken.None);
        var scores = await controller.GetScores(session.SessionId, CancellationToken.None);

        var response = Assert.Single(Assert.IsAssignableFrom<IReadOnlyList<Awaver.Backend.Dto.DashboardSessionResponse>>(Assert.IsType<OkObjectResult>(result.Result).Value));
        Assert.Equal("danger", response.LatestLevel);
        var scoreResponses = Assert.IsAssignableFrom<IReadOnlyList<Awaver.Backend.Dto.DashboardScoreResponse>>(Assert.IsType<OkObjectResult>(scores.Result).Value);
        Assert.Null(scoreResponses[0].VideoTimeSec);
        Assert.Equal(123.45, scoreResponses[1].VideoTimeSec);
    }

    [Fact]
    public async Task DetailEndpoints_ReturnEmptyArraysForExistingSessionWithoutData()
    {
        await using var db = CreateDb();
        var session = new LearningSession
        {
            SessionId = Guid.NewGuid(),
            StudentId = "student-empty",
            StartedAt = DateTimeOffset.Parse("2026-06-14T10:00:00Z"),
        };
        db.LearningSessions.Add(session);
        await db.SaveChangesAsync();

        var controller = new DashboardController(db);

        var scores = await controller.GetScores(session.SessionId, CancellationToken.None);
        var events = await controller.GetPlaybackEvents(session.SessionId, CancellationToken.None);

        Assert.Empty(Assert.IsAssignableFrom<IReadOnlyList<Awaver.Backend.Dto.DashboardScoreResponse>>(Assert.IsType<OkObjectResult>(scores.Result).Value));
        Assert.Empty(Assert.IsAssignableFrom<IReadOnlyList<Awaver.Backend.Dto.DashboardPlaybackEventResponse>>(Assert.IsType<OkObjectResult>(events.Result).Value));
    }

    [Fact]
    public async Task DeleteSession_RemovesTheSessionAndAllRelatedRecords()
    {
        await using var db = CreateDb();
        var sessionId = Guid.NewGuid();
        db.LearningSessions.Add(new LearningSession
        {
            SessionId = sessionId,
            StudentId = "student-delete",
            VideoId = "lecture-1",
            StartedAt = DateTimeOffset.UtcNow,
        });
        db.PlaybackEvents.Add(new PlaybackEvent { EventId = Guid.NewGuid(), SessionId = sessionId, Type = "resume", OccurredAt = DateTimeOffset.UtcNow });
        db.Calibrations.Add(new Calibration { SessionId = sessionId, EarOpen = .3m, EarThreshold = .2m, ValidFrames = 20, TotalFrames = 25, CalibratedAt = DateTimeOffset.UtcNow, SourceSequenceNo = 25 });
        db.DrowsinessScores.Add(new DrowsinessScore { SessionId = sessionId, SourceSequenceNo = 1, ScoredAt = DateTimeOffset.UtcNow, Score = .2m, Level = DrowsinessLevel.Normal, Perclos = .1m, Ear = .3m, PitchDeg = 0, YawDeg = 0 });
        db.AnalysisEventOutbox.Add(new AnalysisEventOutbox { EventId = Guid.NewGuid(), SessionId = sessionId, IdempotencyKey = "delete-test", Payload = "{}", CreatedAt = DateTimeOffset.UtcNow, NextAttemptAt = DateTimeOffset.UtcNow });
        db.AuthSessions.Add(new AuthSession { SessionId = Guid.NewGuid(), PrincipalType = AuthSessionService.StudentRole, PrincipalId = sessionId.ToString("D"), IssuedAt = DateTimeOffset.UtcNow, IdleExpiresAt = DateTimeOffset.UtcNow.AddHours(1), AbsoluteExpiresAt = DateTimeOffset.UtcNow.AddHours(8) });
        await db.SaveChangesAsync();

        var result = await new DashboardController(db).DeleteSession(sessionId, CancellationToken.None);

        Assert.IsType<NoContentResult>(result);
        Assert.False(await db.LearningSessions.AnyAsync(item => item.SessionId == sessionId));
        Assert.False(await db.PlaybackEvents.AnyAsync(item => item.SessionId == sessionId));
        Assert.False(await db.Calibrations.AnyAsync(item => item.SessionId == sessionId));
        Assert.False(await db.DrowsinessScores.AnyAsync(item => item.SessionId == sessionId));
        Assert.False(await db.AnalysisEventOutbox.AnyAsync(item => item.SessionId == sessionId));
        Assert.False(await db.AuthSessions.AnyAsync(item => item.PrincipalId == sessionId.ToString("D")));
    }

    [Fact]
    public async Task DetailEndpoints_ReturnNotFoundForUnknownSession()
    {
        await using var db = CreateDb();
        var controller = new DashboardController(db);
        var sessionId = Guid.NewGuid();

        Assert.IsType<NotFoundObjectResult>((await controller.GetSession(sessionId, CancellationToken.None)).Result);
        Assert.IsType<NotFoundObjectResult>((await controller.GetScores(sessionId, CancellationToken.None)).Result);
        Assert.IsType<NotFoundObjectResult>((await controller.GetPlaybackEvents(sessionId, CancellationToken.None)).Result);
    }

    [Fact]
    public async Task DashboardEndpoints_RequireAdminAndReturnContractForAllRoutes()
    {
        await using var factory = new BackendApplicationFactory();
        var sessionId = Guid.NewGuid();
        await factory.SeedAsync(db =>
        {
            db.Teachers.Add(new Teacher
            {
                TeacherId = "teacher-dashboard",
                PasswordHash = PasswordHasher.Hash("password"),
                CreatedAt = DateTimeOffset.UtcNow,
            });
            db.Admins.Add(new Admin
            {
                AdminId = "admin-dashboard",
                PasswordHash = PasswordHasher.Hash("password"),
                CreatedAt = DateTimeOffset.UtcNow,
            });
            db.LearningSessions.Add(new LearningSession
            {
                SessionId = sessionId,
                StudentId = "student-dashboard",
                StartedAt = DateTimeOffset.Parse("2026-06-14T10:00:00Z"),
            });
            return db.SaveChangesAsync();
        });

        using var client = factory.CreateSecureClient();
        var routes = new[]
        {
            "/api/dashboard/sessions",
            $"/api/dashboard/sessions/{sessionId}",
            $"/api/dashboard/sessions/{sessionId}/scores",
            $"/api/dashboard/sessions/{sessionId}/playback-events",
        };
        foreach (var route in routes)
        {
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(route)).StatusCode);
        }

        using var teacherClient = factory.CreateSecureClient();
        var teacherLogin = await teacherClient.PostAsJsonAsync("/api/teacher/login", new { teacherId = "teacher-dashboard", password = "password" });
        Assert.Equal(HttpStatusCode.OK, teacherLogin.StatusCode);
        ApplySessionCookies(teacherClient, teacherLogin);
        foreach (var route in routes)
        {
            Assert.Equal(HttpStatusCode.Forbidden, (await teacherClient.GetAsync(route)).StatusCode);
        }

        var adminLogin = await client.PostAsJsonAsync("/api/admin/login", new { adminId = "admin-dashboard", password = "password" });
        Assert.Equal(HttpStatusCode.OK, adminLogin.StatusCode);
        ApplySessionCookies(client, adminLogin);

        var list = await client.GetFromJsonAsync<JsonElement>(routes[0]);
        Assert.Equal(JsonValueKind.Array, list.ValueKind);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync(routes[1])).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync(routes[2])).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync(routes[3])).StatusCode);

        Assert.Equal(HttpStatusCode.Forbidden, (await teacherClient.DeleteAsync($"/api/dashboard/sessions/{sessionId}")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync($"/api/dashboard/sessions/{sessionId}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(routes[1])).StatusCode);

        var unknownSessionId = Guid.NewGuid();
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/api/dashboard/sessions/{unknownSessionId}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/api/dashboard/sessions/{unknownSessionId}/scores")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/api/dashboard/sessions/{unknownSessionId}/playback-events")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/dashboard/sessions/not-a-guid")).StatusCode);
    }

    private static AwaverDbContext CreateDb() => new(new DbContextOptionsBuilder<AwaverDbContext>().UseInMemoryDatabase(Guid.NewGuid().ToString()).Options);

    private static void ApplySessionCookies(HttpClient client, HttpResponseMessage response)
    {
        client.DefaultRequestHeaders.Remove("Cookie");
        client.DefaultRequestHeaders.Add("Cookie", $"{CookiePair(response, AuthCookieOptions.ProductionCookieName)}; {CookiePair(response, AuthCookieOptions.CsrfCookieName)}");
        client.DefaultRequestHeaders.Remove(AuthCookieOptions.CsrfHeaderName);
        client.DefaultRequestHeaders.Add(AuthCookieOptions.CsrfHeaderName, CookieValue(response, AuthCookieOptions.CsrfCookieName));
    }

    private static string CookieValue(HttpResponseMessage response, string name) => CookiePair(response, name).Split('=', 2)[1];

    private static string CookiePair(HttpResponseMessage response, string name) => response.Headers.GetValues("Set-Cookie")
        .Select(value => value.Split(';', 2)[0])
        .Single(value => value.StartsWith($"{name}=", StringComparison.Ordinal));

    private sealed class BackendApplicationFactory : WebApplicationFactory<Program>
    {
        private readonly string databaseName = Guid.NewGuid().ToString();

        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseEnvironment("Testing");
            builder.UseSetting("ConnectionStrings:DefaultConnection", "Host=localhost;Database=awaver;Username=awaver;Password=awaver");
            builder.UseSetting("Azure:BlobStorage:ConnectionString", "UseDevelopmentStorage=true");
            builder.UseSetting("Azure:ServiceBus:ConnectionString", "Endpoint=sb://localhost/;SharedAccessKeyName=test;SharedAccessKey=test");
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<DbContextOptions<AwaverDbContext>>();
                services.RemoveAll<IDbContextOptionsConfiguration<AwaverDbContext>>();
                services.RemoveAll<AwaverDbContext>();
                services.AddDbContext<AwaverDbContext>(options => options.UseInMemoryDatabase(databaseName));
            });
        }

        public HttpClient CreateSecureClient() => CreateClient(new WebApplicationFactoryClientOptions
        {
            AllowAutoRedirect = false,
            BaseAddress = new Uri("https://localhost"),
            HandleCookies = false,
        });

        public async Task SeedAsync(Func<AwaverDbContext, Task> seed)
        {
            await using var scope = Services.CreateAsyncScope();
            await seed(scope.ServiceProvider.GetRequiredService<AwaverDbContext>());
        }
    }
}
