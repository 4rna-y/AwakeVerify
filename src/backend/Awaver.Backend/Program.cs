using Awaver.Backend.Data;
using Awaver.Backend.Hubs;
using Awaver.Backend.Models;
using Awaver.Backend.Services;
using Awaver.Backend.WebSockets;
using Azure.Messaging.ServiceBus;
using Azure.Monitor.OpenTelemetry.Exporter;
using Azure.Storage.Blobs;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using OpenTelemetry.Metrics;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using StackExchange.Redis;

var builder = WebApplication.CreateBuilder(args);
var workerAuthMode = FirstNonWhiteSpace(builder.Configuration["Worker:AuthMode"], Environment.GetEnvironmentVariable("WORKER_AUTH_MODE"), builder.Environment.IsProduction() ? "entra_id" : "api_key");
if (IsEntraWorkerAuthMode(workerAuthMode) || builder.Environment.IsProduction())
{
    _ = RequireConfigurationValue(FirstNonWhiteSpace(builder.Configuration["Worker:Entra:Authority"], Environment.GetEnvironmentVariable("WORKER__ENTRA__AUTHORITY")), "Worker:Entra:Authority / WORKER__ENTRA__AUTHORITY");
    _ = RequireConfigurationValue(FirstNonWhiteSpace(builder.Configuration["Worker:Entra:Audience"], Environment.GetEnvironmentVariable("WORKER__ENTRA__AUDIENCE")), "Worker:Entra:Audience / WORKER__ENTRA__AUDIENCE");
}

builder.Services.AddControllers();
builder.Services.AddOpenApi();
var applicationInsightsConnectionString = Environment.GetEnvironmentVariable("APPLICATIONINSIGHTS_CONNECTION_STRING");
if (!string.IsNullOrWhiteSpace(applicationInsightsConnectionString))
{
    builder.Services.AddOpenTelemetry()
        .WithMetrics(metrics => metrics
            .AddMeter(BackendObservability.MeterName)
            .AddRuntimeInstrumentation()
            .AddAzureMonitorMetricExporter(options => options.ConnectionString = applicationInsightsConnectionString));
}
var allowedOrigins = builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>()
    ?? ["http://localhost:3000", "http://127.0.0.1:3000"];
builder.Services.AddCors(options => options.AddPolicy("Frontend", policy =>
    policy.WithOrigins(allowedOrigins).AllowAnyHeader().AllowAnyMethod().AllowCredentials().WithExposedHeaders(AuthCookieOptions.CsrfHeaderName)));

var postgresConnectionString = RequireConfigurationValue(FirstNonWhiteSpace(builder.Configuration.GetConnectionString("DefaultConnection"), builder.Configuration["Postgres:ConnectionString"], Environment.GetEnvironmentVariable("DATABASE_CONNECTION_STRING"), BuildDevcontainerPostgresConnectionString()), "ConnectionStrings:DefaultConnection / Postgres:ConnectionString / DATABASE_CONNECTION_STRING / POSTGRES_DB + POSTGRES_USER + POSTGRES_PASSWORD");
builder.Services.AddDbContext<AwaverDbContext>(options => options.UseNpgsql(postgresConnectionString, npgsql => npgsql.MapEnum<DrowsinessLevel>("drowsiness_level")));
builder.Services.AddScoped<ISessionRepository, EfSessionRepository>();
builder.Services.AddSingleton<BackendObservability>();
builder.Services.AddSingleton<IAnalysisResultObservability>(provider => provider.GetRequiredService<BackendObservability>());
builder.Services.AddSingleton<IAnalysisOutboxObservability>(provider => provider.GetRequiredService<BackendObservability>());
builder.Services.AddSingleton(new AuthCookieOptions { IsDevelopment = builder.Environment.IsDevelopment() });
builder.Services.AddScoped<AuthSessionService>();
var backendTopology = BackendTopologyOptions.Load(builder.Configuration);
builder.Services.AddSingleton(backendTopology);
var redisConnectionString = FirstNonWhiteSpace(builder.Configuration["Redis:ConnectionString"], Environment.GetEnvironmentVariable("REDIS_CONNECTION_STRING"));
if (builder.Environment.IsProduction() && string.IsNullOrWhiteSpace(redisConnectionString))
{
    throw new InvalidOperationException("Required configuration is missing: Redis:ConnectionString / REDIS_CONNECTION_STRING.");
}
if (!string.IsNullOrWhiteSpace(redisConnectionString))
{
    builder.Services.AddSingleton<IConnectionMultiplexer>(_ => ConnectionMultiplexer.Connect(redisConnectionString));
    builder.Services.AddSingleton<IAnalysisConnectionRegistry, RedisAnalysisConnectionRegistry>();
}
else
{
    builder.Services.AddSingleton<IAnalysisConnectionRegistry, InMemoryAnalysisConnectionRegistry>();
}
builder.Services.AddAuthentication(options =>
    {
        options.DefaultAuthenticateScheme = AuthSessionAuthenticationHandler.SchemeName;
        options.DefaultChallengeScheme = AuthSessionAuthenticationHandler.SchemeName;
    })
    .AddScheme<Microsoft.AspNetCore.Authentication.AuthenticationSchemeOptions, AuthSessionAuthenticationHandler>(AuthSessionAuthenticationHandler.SchemeName, _ => { })
        .AddScheme<Microsoft.AspNetCore.Authentication.AuthenticationSchemeOptions, WorkerApiKeyAuthenticationHandler>(WorkerApiKeyAuthenticationHandler.SchemeName, _ => { })
    .AddJwtBearer("worker-bearer", options =>
    {
        options.Authority = builder.Configuration["Worker:Entra:Authority"];
        options.Audience = builder.Configuration["Worker:Entra:Audience"];
        // Preserve the Entra app-role claim as `roles`; AnalysisWorker explicitly
        // authorizes the `analysis_worker` application role rather than a mapped URI claim.
        options.MapInboundClaims = false;
        options.RequireHttpsMetadata = !builder.Environment.IsDevelopment() && !builder.Environment.IsEnvironment("Testing");
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            ValidIssuer = FirstNonWhiteSpace(builder.Configuration["Worker:Entra:ValidIssuer"]),
            ValidAudience = builder.Configuration["Worker:Entra:Audience"],
            ClockSkew = TimeSpan.FromMinutes(1),
            RoleClaimType = "roles",
        };
        options.Events = new JwtBearerEvents
        {
            OnTokenValidated = context =>
            {
                var hasWorkerRole = context.Principal?.Claims.Any(claim => claim.Type == "roles" && claim.Value == "analysis_worker") == true;
                if (!hasWorkerRole || context.SecurityToken.ValidTo <= DateTime.UtcNow)
                {
                    context.Fail("The token must contain the unexpired analysis_worker app role.");
                }
                return Task.CompletedTask;
            },
        };
    });
builder.Services.AddAuthorization(options =>
{
    options.AddPolicy("AnalysisWorker", policy => policy
        .AddAuthenticationSchemes(WorkerApiKeyAuthenticationHandler.SchemeName, "worker-bearer")
        .RequireAuthenticatedUser()
        .RequireAssertion(context => context.User.HasClaim("worker_role", "analysis_worker") || context.User.HasClaim("roles", "analysis_worker")));
    options.AddPolicy("CalibrationReader", policy => policy
        .AddAuthenticationSchemes(AuthSessionAuthenticationHandler.SchemeName, WorkerApiKeyAuthenticationHandler.SchemeName, "worker-bearer")
        .RequireAuthenticatedUser()
        .RequireAssertion(context =>
            context.User.HasClaim("worker_role", "analysis_worker") ||
            context.User.HasClaim("roles", "analysis_worker") ||
            context.User.IsInRole(AuthSessionService.StudentRole) ||
            context.User.IsInRole(AuthSessionService.AdminRole)));
});

var blobConnectionString = RequireConfigurationValue(FirstNonWhiteSpace(builder.Configuration["Azure:BlobStorage:ConnectionString"], Environment.GetEnvironmentVariable("BLOB_CONNECTION_STRING"), Environment.GetEnvironmentVariable("AZURE_BLOB_STORAGE_CONNECTION_STRING"), BuildDevcontainerAzuriteConnectionString()), "Azure:BlobStorage:ConnectionString / BLOB_CONNECTION_STRING / AZURE_BLOB_STORAGE_CONNECTION_STRING / AZURITE_ACCOUNT_KEY");
var blobContainerName = RequireConfigurationValue(FirstNonWhiteSpace(builder.Configuration["Azure:BlobStorage:ContainerName"], Environment.GetEnvironmentVariable("AZURE_BLOB_STORAGE_CONTAINER_NAME"), Environment.GetEnvironmentVariable("BLOB_CONTAINER_NAME"), "frames"), "Azure:BlobStorage:ContainerName");
builder.Services.AddSingleton(new BlobContainerClient(blobConnectionString, blobContainerName));
builder.Services.AddSingleton<IFrameStorage, AzureBlobFrameStorage>();

var serviceBusConnectionString = RequireConfigurationValue(FirstNonWhiteSpace(builder.Configuration["Azure:ServiceBus:ConnectionString"], Environment.GetEnvironmentVariable("SERVICEBUS_CONNECTION_STRING"), Environment.GetEnvironmentVariable("AZURE_SERVICE_BUS_CONNECTION_STRING"), BuildDevcontainerServiceBusConnectionString()), "Azure:ServiceBus:ConnectionString / SERVICEBUS_CONNECTION_STRING / AZURE_SERVICE_BUS_CONNECTION_STRING / SERVICEBUS_SAS_KEY");
var frameQueueName = RequireConfigurationValue(FirstNonWhiteSpace(builder.Configuration["Azure:ServiceBus:FrameQueueName"], Environment.GetEnvironmentVariable("AZURE_SERVICE_BUS_FRAME_QUEUE_NAME"), Environment.GetEnvironmentVariable("SERVICEBUS_QUEUE_NAME"), "frame-processing-queue"), "Azure:ServiceBus:FrameQueueName");
builder.Services.AddSingleton(new ServiceBusClient(serviceBusConnectionString));
builder.Services.AddSingleton(provider => provider.GetRequiredService<ServiceBusClient>().CreateSender(frameQueueName));
builder.Services.AddSingleton<IFrameQueue, AzureServiceBusFrameQueue>();
builder.Services.AddSingleton<FramePipeline>();
builder.Services.AddSingleton<AnalysisResultBroadcaster>();
builder.Services.AddSingleton(OutboxDispatchOptions.Load(builder.Configuration));
builder.Services.AddHostedService<AnalysisOutboxDispatcher>();

var azureSignalRConnectionString = FirstNonWhiteSpace(builder.Configuration["Azure:SignalR:ConnectionString"], Environment.GetEnvironmentVariable("AZURE_SIGNALR_CONNECTION_STRING"));
backendTopology.ValidateDistributedDependencies(!string.IsNullOrWhiteSpace(azureSignalRConnectionString), !string.IsNullOrWhiteSpace(redisConnectionString));
var signalRServerBuilder = builder.Services.AddSignalR();
if (!string.IsNullOrWhiteSpace(azureSignalRConnectionString)) signalRServerBuilder.AddAzureSignalR(azureSignalRConnectionString);
builder.Services.AddScoped<BackendReadinessProbe>();

var app = builder.Build();
if (!app.Environment.IsEnvironment("Testing"))
{
    using var scope = app.Services.CreateScope();
    var dbContext = scope.ServiceProvider.GetRequiredService<AwaverDbContext>();
    dbContext.Database.Migrate();
    var adminId = FirstNonWhiteSpace(Environment.GetEnvironmentVariable("ADMIN_ID"));
    var adminPassword = FirstNonWhiteSpace(Environment.GetEnvironmentVariable("ADMIN_PASSWORD"));
    if (adminId is not null && adminPassword is not null) await SeedAdminAsync(dbContext, adminId, adminPassword);
}

if (app.Environment.IsDevelopment()) app.MapOpenApi();
app.UseHttpsRedirection();
app.UseCors("Frontend");
app.UseAuthentication();
app.UseMiddleware<CsrfProtectionMiddleware>();
app.UseAuthorization();
app.UseWebSockets();
app.MapGet("/health/live", () => Results.Ok(new { status = "live" }));
app.MapGet("/health/ready", async (BackendReadinessProbe readiness, CancellationToken cancellationToken) =>
{
    var report = await readiness.CheckAsync(cancellationToken);
    return report.IsReady
        ? Results.Ok(report)
        : Results.Json(report, statusCode: StatusCodes.Status503ServiceUnavailable);
});
app.MapControllers();
app.MapHub<AnalysisEventsHub>("/hubs/analysis-events").RequireAuthorization();
app.Map("/ws/sessions/{sessionId:guid}/frames", FrameWebSocketEndpoint.HandleAsync);
app.Run();

static string? BuildDevcontainerPostgresConnectionString()
{
    var database = Environment.GetEnvironmentVariable("POSTGRES_DB");
    var username = Environment.GetEnvironmentVariable("POSTGRES_USER");
    var password = Environment.GetEnvironmentVariable("POSTGRES_PASSWORD");
    return string.IsNullOrWhiteSpace(database) || string.IsNullOrWhiteSpace(username) || string.IsNullOrWhiteSpace(password) ? null : $"Host=postgres;Port=5432;Database={database};Username={username};Password={password}";
}
static string? BuildDevcontainerAzuriteConnectionString()
{
    var accountKey = Environment.GetEnvironmentVariable("AZURITE_ACCOUNT_KEY");
    return string.IsNullOrWhiteSpace(accountKey) ? null : string.Join(';', "DefaultEndpointsProtocol=http", "AccountName=devstoreaccount1", $"AccountKey={accountKey}", "BlobEndpoint=http://azurite:10000/devstoreaccount1");
}
static string? BuildDevcontainerServiceBusConnectionString()
{
    var sharedAccessKey = Environment.GetEnvironmentVariable("SERVICEBUS_SAS_KEY");
    return string.IsNullOrWhiteSpace(sharedAccessKey) ? null : string.Join(';', "Endpoint=sb://servicebus", "SharedAccessKeyName=RootManageSharedAccessKey", $"SharedAccessKey={sharedAccessKey}", "UseDevelopmentEmulator=true");
}
static string? FirstNonWhiteSpace(params string?[] values) => values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value));
static bool IsEntraWorkerAuthMode(string? mode) => mode is not null && mode.Trim().ToLowerInvariant() is "entra_id" or "entra" or "production" or "managed_identity" or "workload_identity";
static async Task SeedAdminAsync(AwaverDbContext dbContext, string adminId, string adminPassword)
{
    if (await dbContext.Admins.AnyAsync(admin => admin.AdminId == adminId)) return;
    dbContext.Admins.Add(new Admin { AdminId = adminId, PasswordHash = PasswordHasher.Hash(adminPassword), CreatedAt = DateTimeOffset.UtcNow });
    await dbContext.SaveChangesAsync();
}
static string RequireConfigurationValue(string? value, string settingName) => !string.IsNullOrWhiteSpace(value) ? value : throw new InvalidOperationException($"Required configuration is missing: {settingName}. Local execution must use the production-equivalent dependency services.");

public partial class Program;
