using System.Net;
using Awaver.Backend.Data;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Awaver.Backend.Tests;

public sealed class HealthEndpointsTests
{
    [Fact]
    public async Task Liveness_RemainsHealthyWhenExternalDependenciesAreUnavailable()
    {
        await using var factory = new HealthApplicationFactory();
        using var client = factory.CreateClient(new WebApplicationFactoryClientOptions
        {
            BaseAddress = new Uri("https://localhost"),
        });

        var response = await client.GetAsync("/health/live");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("live", await response.Content.ReadAsStringAsync());
    }

    private sealed class HealthApplicationFactory : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseEnvironment("Testing");
            builder.UseSetting("ConnectionStrings:DefaultConnection", "Host=localhost;Database=awaver;Username=awaver;Password=unavailable");
            builder.UseSetting("Azure:BlobStorage:ConnectionString", "UseDevelopmentStorage=true");
            builder.UseSetting("Azure:ServiceBus:ConnectionString", "Endpoint=sb://localhost/;SharedAccessKeyName=test;SharedAccessKey=unavailable");
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<DbContextOptions<AwaverDbContext>>();
                services.RemoveAll<IDbContextOptionsConfiguration<AwaverDbContext>>();
                services.RemoveAll<AwaverDbContext>();
                services.AddDbContext<AwaverDbContext>(options =>
                    options.UseInMemoryDatabase(Guid.NewGuid().ToString()));
            });
        }
    }
}
