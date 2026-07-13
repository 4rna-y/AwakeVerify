using Awaver.Backend.Data;
using Awaver.Backend.Hubs;
using Awaver.Backend.Models;
using Awaver.Backend.Services;
using Awaver.Backend.WebSockets;
using Azure.Messaging.ServiceBus;
using Azure.Storage.Blobs;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddOpenApi();
builder.Services.AddCors(options =>
{
    options.AddPolicy("Frontend", policy =>
    {
        var origins = builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>();
        if (origins is { Length: > 0 })
        {
            // AllowCredentials is required for the SignalR negotiate handshake; it can only be
            // combined with explicit origins (never AllowAnyOrigin), which is why the two CORS
            // branches diverge here.
            policy.WithOrigins(origins).AllowAnyHeader().AllowAnyMethod().AllowCredentials();
        }
        else if (builder.Environment.IsDevelopment())
        {
            policy.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod();
        }
    });
});

var postgresConnectionString = RequireConfigurationValue(
    FirstNonWhiteSpace(
        builder.Configuration.GetConnectionString("DefaultConnection"),
        builder.Configuration["Postgres:ConnectionString"],
        Environment.GetEnvironmentVariable("DATABASE_CONNECTION_STRING"),
        BuildDevcontainerPostgresConnectionString()),
    "ConnectionStrings:DefaultConnection / Postgres:ConnectionString / DATABASE_CONNECTION_STRING / POSTGRES_DB + POSTGRES_USER + POSTGRES_PASSWORD");
builder.Services.AddDbContext<AwaverDbContext>(options => options.UseNpgsql(postgresConnectionString));
builder.Services.AddScoped<ISessionRepository, EfSessionRepository>();

var blobConnectionString = RequireConfigurationValue(
    FirstNonWhiteSpace(
        builder.Configuration["Azure:BlobStorage:ConnectionString"],
        Environment.GetEnvironmentVariable("BLOB_CONNECTION_STRING"),
        Environment.GetEnvironmentVariable("AZURE_BLOB_STORAGE_CONNECTION_STRING"),
        BuildDevcontainerAzuriteConnectionString()),
    "Azure:BlobStorage:ConnectionString / BLOB_CONNECTION_STRING / AZURE_BLOB_STORAGE_CONNECTION_STRING / AZURITE_ACCOUNT_KEY");
var blobContainerName = RequireConfigurationValue(
    FirstNonWhiteSpace(
        builder.Configuration["Azure:BlobStorage:ContainerName"],
        Environment.GetEnvironmentVariable("AZURE_BLOB_STORAGE_CONTAINER_NAME"),
        Environment.GetEnvironmentVariable("BLOB_CONTAINER_NAME"),
        "frames"),
    "Azure:BlobStorage:ContainerName");
builder.Services.AddSingleton(new BlobContainerClient(blobConnectionString, blobContainerName));
builder.Services.AddSingleton<IFrameStorage, AzureBlobFrameStorage>();

var serviceBusConnectionString = RequireConfigurationValue(
    FirstNonWhiteSpace(
        builder.Configuration["Azure:ServiceBus:ConnectionString"],
        Environment.GetEnvironmentVariable("SERVICEBUS_CONNECTION_STRING"),
        Environment.GetEnvironmentVariable("AZURE_SERVICE_BUS_CONNECTION_STRING"),
        BuildDevcontainerServiceBusConnectionString()),
    "Azure:ServiceBus:ConnectionString / SERVICEBUS_CONNECTION_STRING / AZURE_SERVICE_BUS_CONNECTION_STRING / SERVICEBUS_SAS_KEY");
var frameQueueName = RequireConfigurationValue(
    FirstNonWhiteSpace(
        builder.Configuration["Azure:ServiceBus:FrameQueueName"],
        Environment.GetEnvironmentVariable("AZURE_SERVICE_BUS_FRAME_QUEUE_NAME"),
        Environment.GetEnvironmentVariable("SERVICEBUS_QUEUE_NAME"),
        "frame-processing-queue"),
    "Azure:ServiceBus:FrameQueueName");
builder.Services.AddSingleton(new ServiceBusClient(serviceBusConnectionString));
builder.Services.AddSingleton(provider => provider.GetRequiredService<ServiceBusClient>().CreateSender(frameQueueName));
builder.Services.AddSingleton<IFrameQueue, AzureServiceBusFrameQueue>();

builder.Services.AddSingleton<FramePipeline>();
builder.Services.AddSingleton<AnalysisResultBroadcaster>();

var azureSignalRConnectionString = FirstNonWhiteSpace(
    builder.Configuration["Azure:SignalR:ConnectionString"],
    Environment.GetEnvironmentVariable("AZURE_SIGNALR_CONNECTION_STRING"));
var signalRServerBuilder = builder.Services.AddSignalR();
if (!string.IsNullOrWhiteSpace(azureSignalRConnectionString))
{
    // Azure SignalR Service is used when configured (e.g. production); otherwise SignalR falls
    // back to plain ASP.NET Core SignalR served directly by this app, which is sufficient for
    // local development.
    signalRServerBuilder.AddAzureSignalR(azureSignalRConnectionString);
}

var app = builder.Build();

using (var scope = app.Services.CreateScope())
{
    var dbContext = scope.ServiceProvider.GetRequiredService<AwaverDbContext>();
    dbContext.Database.Migrate();

    var adminId = FirstNonWhiteSpace(Environment.GetEnvironmentVariable("ADMIN_ID"));
    var adminPassword = FirstNonWhiteSpace(Environment.GetEnvironmentVariable("ADMIN_PASSWORD"));
    if (adminId is not null && adminPassword is not null)
    {
        await SeedAdminAsync(dbContext, adminId, adminPassword);
    }
}

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.UseHttpsRedirection();
app.UseCors("Frontend");
app.UseAuthorization();
app.UseWebSockets();

app.MapControllers();
app.MapHub<AnalysisEventsHub>("/hubs/analysis-events");
app.Map("/ws/sessions/{sessionId:guid}/frames", FrameWebSocketEndpoint.HandleAsync);

app.Run();

static string? BuildDevcontainerPostgresConnectionString()
{
    var database = Environment.GetEnvironmentVariable("POSTGRES_DB");
    var username = Environment.GetEnvironmentVariable("POSTGRES_USER");
    var password = Environment.GetEnvironmentVariable("POSTGRES_PASSWORD");

    if (string.IsNullOrWhiteSpace(database) ||
        string.IsNullOrWhiteSpace(username) ||
        string.IsNullOrWhiteSpace(password))
    {
        return null;
    }

    return $"Host=postgres;Port=5432;Database={database};Username={username};Password={password}";
}

static string? BuildDevcontainerAzuriteConnectionString()
{
    var accountKey = Environment.GetEnvironmentVariable("AZURITE_ACCOUNT_KEY");
    if (string.IsNullOrWhiteSpace(accountKey))
    {
        return null;
    }

    return string.Join(
        ';',
        "DefaultEndpointsProtocol=http",
        "AccountName=devstoreaccount1",
        $"AccountKey={accountKey}",
        "BlobEndpoint=http://azurite:10000/devstoreaccount1");
}

static string? BuildDevcontainerServiceBusConnectionString()
{
    var sharedAccessKey = Environment.GetEnvironmentVariable("SERVICEBUS_SAS_KEY");
    if (string.IsNullOrWhiteSpace(sharedAccessKey))
    {
        return null;
    }

    return string.Join(
        ';',
        "Endpoint=sb://servicebus",
        "SharedAccessKeyName=RootManageSharedAccessKey",
        $"SharedAccessKey={sharedAccessKey}",
        "UseDevelopmentEmulator=true");
}

static string? FirstNonWhiteSpace(params string?[] values)
{
    foreach (var value in values)
    {
        if (!string.IsNullOrWhiteSpace(value))
        {
            return value;
        }
    }

    return null;
}

static async Task SeedAdminAsync(AwaverDbContext dbContext, string adminId, string adminPassword)
{
    var alreadyExists = await dbContext.Admins.AnyAsync(admin => admin.AdminId == adminId);
    if (alreadyExists)
    {
        return;
    }

    dbContext.Admins.Add(new Admin
    {
        AdminId = adminId,
        PasswordHash = PasswordHasher.Hash(adminPassword),
        CreatedAt = DateTimeOffset.UtcNow,
    });
    await dbContext.SaveChangesAsync();
}

static string RequireConfigurationValue(string? value, string settingName)
{
    if (string.IsNullOrWhiteSpace(value))
    {
        throw new InvalidOperationException(
            $"Required configuration is missing: {settingName}. Local execution must use the production-equivalent dependency services.");
    }

    return value;
}

public partial class Program;
