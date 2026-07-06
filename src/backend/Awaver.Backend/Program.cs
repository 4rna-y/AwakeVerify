using Awaver.Backend.Data;
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
            policy.WithOrigins(origins).AllowAnyHeader().AllowAnyMethod();
        }
        else if (builder.Environment.IsDevelopment())
        {
            policy.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod();
        }
    });
});

var postgresConnectionString = builder.Configuration.GetConnectionString("DefaultConnection")
    ?? builder.Configuration["Postgres:ConnectionString"];

if (!string.IsNullOrWhiteSpace(postgresConnectionString))
{
    builder.Services.AddDbContext<AwaverDbContext>(options => options.UseNpgsql(postgresConnectionString));
    builder.Services.AddScoped<ISessionRepository, EfSessionRepository>();
}
else
{
    builder.Services.AddSingleton<ISessionRepository, InMemorySessionRepository>();
}

var blobConnectionString = builder.Configuration["Azure:BlobStorage:ConnectionString"];
var blobContainerName = builder.Configuration["Azure:BlobStorage:ContainerName"] ?? "frames";
if (!string.IsNullOrWhiteSpace(blobConnectionString))
{
    builder.Services.AddSingleton(new BlobContainerClient(blobConnectionString, blobContainerName));
    builder.Services.AddSingleton<IFrameStorage, AzureBlobFrameStorage>();
}
else
{
    builder.Services.AddSingleton<IFrameStorage, LocalFrameStorage>();
}

var serviceBusConnectionString = builder.Configuration["Azure:ServiceBus:ConnectionString"];
var frameQueueName = builder.Configuration["Azure:ServiceBus:FrameQueueName"];
if (!string.IsNullOrWhiteSpace(serviceBusConnectionString) && !string.IsNullOrWhiteSpace(frameQueueName))
{
    builder.Services.AddSingleton(new ServiceBusClient(serviceBusConnectionString));
    builder.Services.AddSingleton(provider => provider.GetRequiredService<ServiceBusClient>().CreateSender(frameQueueName));
    builder.Services.AddSingleton<IFrameQueue, AzureServiceBusFrameQueue>();
}
else
{
    builder.Services.AddSingleton<IFrameQueue, LoggingFrameQueue>();
}

builder.Services.AddSingleton<FramePipeline>();
builder.Services.AddSingleton<AnalysisResultBroadcaster>();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.UseHttpsRedirection();
app.UseCors("Frontend");
app.UseAuthorization();
app.UseWebSockets();

app.MapControllers();
app.Map("/ws/sessions/{sessionId:guid}/frames", FrameWebSocketEndpoint.HandleAsync);

app.Run();

public partial class Program;
