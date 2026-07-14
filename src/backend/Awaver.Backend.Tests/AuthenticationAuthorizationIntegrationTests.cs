using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Awaver.Backend.Data;
using Awaver.Backend.Models;
using Awaver.Backend.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Awaver.Backend.Tests;

public sealed class AuthenticationAuthorizationIntegrationTests
{
    [Fact]
    public async Task AdminSession_AllowsOnlyAdminToListAndCreateTeachers()
    {
        await using var factory = new BackendApplicationFactory();
        await factory.SeedAsync(db =>
        {
            db.Admins.Add(new Admin { AdminId = "admin1", PasswordHash = PasswordHasher.Hash("correct-password"), CreatedAt = DateTimeOffset.UtcNow });
            return db.SaveChangesAsync();
        });
        using var client = factory.CreateSecureClient();

        var login = await client.PostAsJsonAsync("/api/admin/login", new { adminId = "admin1", password = "correct-password" });

        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        Assert.Contains("\"authenticated\":true", await login.Content.ReadAsStringAsync());
        ApplySessionCookies(client, login);

        var currentPrincipal = await client.GetAsync("/api/auth/me");
        Assert.Equal(HttpStatusCode.OK, currentPrincipal.StatusCode);
        Assert.Equal(CookieValue(login, AuthCookieOptions.CsrfCookieName), currentPrincipal.Headers.GetValues(AuthCookieOptions.CsrfHeaderName).Single());

        var create = await client.PostAsJsonAsync("/api/admin/teachers", new { teacherId = "teacher-created", password = "teacher-password" });
        Assert.Equal(HttpStatusCode.Created, create.StatusCode);

        var teachers = await client.GetAsync("/api/admin/teachers");
        Assert.Equal(HttpStatusCode.OK, teachers.StatusCode);
        Assert.Contains("teacher-created", await teachers.Content.ReadAsStringAsync());

        await using var scope = factory.Services.CreateAsyncScope();
        var createdTeacher = await scope.ServiceProvider.GetRequiredService<AwaverDbContext>().Teachers.SingleAsync(teacher => teacher.TeacherId == "teacher-created");
        Assert.Equal("admin1", createdTeacher.CreatedByAdminId);
        Assert.True(PasswordHasher.Verify("teacher-password", createdTeacher.PasswordHash));
    }

    [Fact]
    public async Task AuthenticationFailuresAndWrongRoles_AreRejectedAtProtectedEndpoints()
    {
        await using var factory = new BackendApplicationFactory();
        await factory.SeedAsync(db =>
        {
            db.Teachers.Add(new Teacher { TeacherId = "teacher1", PasswordHash = PasswordHasher.Hash("correct-password"), CreatedAt = DateTimeOffset.UtcNow });
            db.Admins.Add(new Admin { AdminId = "admin1", PasswordHash = PasswordHasher.Hash("correct-password"), CreatedAt = DateTimeOffset.UtcNow });
            return db.SaveChangesAsync();
        });
        using var anonymousClient = factory.CreateSecureClient();

        var failedAdminLogin = await anonymousClient.PostAsJsonAsync("/api/admin/login", new { adminId = "missing", password = "wrong-password" });
        Assert.Equal(HttpStatusCode.OK, failedAdminLogin.StatusCode);
        Assert.Contains("\"authenticated\":false", await failedAdminLogin.Content.ReadAsStringAsync());
        Assert.False(failedAdminLogin.Headers.TryGetValues("Set-Cookie", out var failedLoginCookies) && failedLoginCookies.Any(value => value.StartsWith(AuthCookieOptions.ProductionCookieName, StringComparison.Ordinal)));

        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymousClient.GetAsync("/api/admin/teachers")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymousClient.PostAsJsonAsync("/api/admin/teachers", new { teacherId = "forbidden", password = "password" })).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymousClient.GetAsync("/api/dashboard/sessions")).StatusCode);

        var failedTeacherLogin = await anonymousClient.PostAsJsonAsync("/api/teacher/login", new { teacherId = "teacher1", password = "wrong-password" });
        Assert.Equal(HttpStatusCode.OK, failedTeacherLogin.StatusCode);
        Assert.Contains("\"authenticated\":false", await failedTeacherLogin.Content.ReadAsStringAsync());

        var teacherLogin = await anonymousClient.PostAsJsonAsync("/api/teacher/login", new { teacherId = "teacher1", password = "correct-password" });
        Assert.Equal(HttpStatusCode.OK, teacherLogin.StatusCode);
        Assert.Contains("\"authenticated\":true", await teacherLogin.Content.ReadAsStringAsync());
        ApplySessionCookies(anonymousClient, teacherLogin);

        Assert.Equal(HttpStatusCode.Forbidden, (await anonymousClient.GetAsync("/api/admin/teachers")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await anonymousClient.PostAsJsonAsync("/api/admin/teachers", new { teacherId = "forbidden", password = "password" })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await anonymousClient.GetAsync("/api/dashboard/sessions")).StatusCode);

        var adminLogin = await anonymousClient.PostAsJsonAsync("/api/admin/login", new { adminId = "admin1", password = "correct-password" });
        Assert.Equal(HttpStatusCode.OK, adminLogin.StatusCode);
        ApplySessionCookies(anonymousClient, adminLogin);
        Assert.Equal(HttpStatusCode.OK, (await anonymousClient.GetAsync("/api/dashboard/sessions")).StatusCode);
    }

    [Fact]
    public async Task WorkerApiKeyFromEnvironmentStyleConfiguration_AcceptsAnalysisResultsWhenJsonDefaultsAreBlank()
    {
        await using var factory = new BackendApplicationFactory();
        var sessionId = Guid.NewGuid();
        await factory.SeedAsync(db =>
        {
            db.LearningSessions.Add(new LearningSession
            {
                SessionId = sessionId,
                StudentId = "worker-test-student",
                StartedAt = DateTimeOffset.UtcNow,
            });
            return db.SaveChangesAsync();
        });
        using var client = factory.CreateSecureClient();
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/sessions/{sessionId}/analysis-results")
        {
            Content = JsonContent.Create(new
            {
                type = "tracking_status",
                sessionId,
                sourceSequenceNo = 1,
                detectedAt = "2026-07-13T08:26:46Z",
                status = "face_not_detected",
            }),
        };
        request.Headers.Add("X-Worker-Api-Key", "worker-test-key");

        using var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
    }

    [Fact]
    public async Task StudentSession_RemainsBoundToItsServerSession()
    {
        await using var factory = new BackendApplicationFactory();
        using var client = factory.CreateSecureClient();

        var start = await client.PostAsJsonAsync("/api/sessions", new { studentId = "student1" });
        Assert.Equal(HttpStatusCode.Created, start.StatusCode);
        var sessionId = JsonDocument.Parse(await start.Content.ReadAsStringAsync()).RootElement.GetProperty("sessionId").GetGuid();
        ApplySessionCookies(client, start, AuthCookieOptions.StudentCookieName);

        var principal = await client.GetAsync("/api/auth/me");
        Assert.Equal(HttpStatusCode.OK, principal.StatusCode);
        Assert.Contains("\"role\":\"student_session\"", await principal.Content.ReadAsStringAsync());

        var playbackEvent = await client.PostAsJsonAsync($"/api/sessions/{sessionId}/playback-events", new { type = "resume", occurredAt = DateTimeOffset.UtcNow, videoTimeSec = 3.5 });
        Assert.Equal(HttpStatusCode.Created, playbackEvent.StatusCode);
    }

    [Fact]
    public async Task StudentSession_CanReadOnlyItsPersistedCalibration()
    {
        await using var factory = new BackendApplicationFactory();
        using var client = factory.CreateSecureClient();

        var start = await client.PostAsJsonAsync("/api/sessions", new { studentId = "calibrated-student" });
        var sessionId = JsonDocument.Parse(await start.Content.ReadAsStringAsync()).RootElement.GetProperty("sessionId").GetGuid();
        ApplySessionCookies(client, start, AuthCookieOptions.StudentCookieName);
        var otherSessionId = Guid.NewGuid();
        await factory.SeedAsync(async db =>
        {
            db.Calibrations.Add(new Calibration
            {
                SessionId = sessionId,
                SourceSequenceNo = 25,
                EarOpen = .31m,
                EarThreshold = .2325m,
                ValidFrames = 18,
                TotalFrames = 25,
                CalibratedAt = DateTimeOffset.Parse("2026-07-13T08:26:46Z"),
            });
            db.LearningSessions.Add(new LearningSession
            {
                SessionId = otherSessionId,
                StudentId = "other-student",
                StartedAt = DateTimeOffset.UtcNow,
            });
            await db.SaveChangesAsync();
        });

        var calibration = await client.GetAsync($"/api/sessions/{sessionId}/calibration");
        Assert.Equal(HttpStatusCode.OK, calibration.StatusCode);
        Assert.Contains("\"sourceSequenceNo\":25", await calibration.Content.ReadAsStringAsync());

        var otherCalibration = await client.GetAsync($"/api/sessions/{otherSessionId}/calibration");
        Assert.Equal(HttpStatusCode.Forbidden, otherCalibration.StatusCode);
    }

    [Fact]
    public async Task StudentPlaybackEventsRequireCsrfToken()
    {
        await using var factory = new BackendApplicationFactory();
        using var client = factory.CreateSecureClient();
        var start = await client.PostAsJsonAsync("/api/sessions", new { studentId = "csrf-student" });
        var sessionId = JsonDocument.Parse(await start.Content.ReadAsStringAsync()).RootElement.GetProperty("sessionId").GetGuid();
        ApplySessionCookies(client, start, AuthCookieOptions.StudentCookieName);

        client.DefaultRequestHeaders.Remove(AuthCookieOptions.CsrfHeaderName);
        var missingToken = await client.PostAsJsonAsync($"/api/sessions/{sessionId}/playback-events", new { type = "auto_pause", occurredAt = DateTimeOffset.UtcNow });
        Assert.Equal(HttpStatusCode.BadRequest, missingToken.StatusCode);

        client.DefaultRequestHeaders.Add(AuthCookieOptions.CsrfHeaderName, CookieValue(start, AuthCookieOptions.CsrfCookieName));
        var autoPause = await client.PostAsJsonAsync($"/api/sessions/{sessionId}/playback-events", new { type = "auto_pause", occurredAt = DateTimeOffset.UtcNow });
        var resume = await client.PostAsJsonAsync($"/api/sessions/{sessionId}/playback-events", new { type = "resume", occurredAt = DateTimeOffset.UtcNow });
        Assert.Equal(HttpStatusCode.Created, autoPause.StatusCode);
        Assert.Equal(HttpStatusCode.Created, resume.StatusCode);
    }

    private static void ApplySessionCookies(HttpClient client, HttpResponseMessage response, string sessionCookieName = AuthCookieOptions.ProductionCookieName)
    {
        client.DefaultRequestHeaders.Remove("Cookie");
        client.DefaultRequestHeaders.Add("Cookie", $"{CookiePair(response, sessionCookieName)}; {CookiePair(response, AuthCookieOptions.CsrfCookieName)}");
        client.DefaultRequestHeaders.Remove(AuthCookieOptions.CsrfHeaderName);
        client.DefaultRequestHeaders.Add(AuthCookieOptions.CsrfHeaderName, response.Headers.GetValues(AuthCookieOptions.CsrfHeaderName).Single());
    }

    private static string CookiePair(HttpResponseMessage response, string name) => response.Headers.GetValues("Set-Cookie")
        .Select(value => value.Split(';', 2)[0])
        .Single(value => value.StartsWith($"{name}=", StringComparison.Ordinal));

    private static string CookieValue(HttpResponseMessage response, string name) => CookiePair(response, name).Split('=', 2)[1];

    private sealed class BackendApplicationFactory : WebApplicationFactory<Program>
    {
        private readonly string databaseName = Guid.NewGuid().ToString();

        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseEnvironment("Testing");
            builder.UseSetting("ConnectionStrings:DefaultConnection", "Host=localhost;Database=awaver;Username=awaver;Password=awaver");
            builder.UseSetting("Azure:BlobStorage:ConnectionString", "UseDevelopmentStorage=true");
            builder.UseSetting("Azure:ServiceBus:ConnectionString", "Endpoint=sb://localhost/;SharedAccessKeyName=test;SharedAccessKey=test");
            // Mirrors the local environment variable while appsettings.json contains blank Worker defaults.
            builder.UseSetting("WORKER_API_KEY", "worker-test-key");
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
