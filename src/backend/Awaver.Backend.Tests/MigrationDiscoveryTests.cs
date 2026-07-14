using Awaver.Backend.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Awaver.Backend.Tests;

public sealed class MigrationDiscoveryTests
{
    [Fact]
    public void SchemaMigrationsAreDiscoverable()
    {
        using var dbContext = new AwaverDbContext(new DbContextOptionsBuilder<AwaverDbContext>()
            .UseNpgsql("Host=localhost;Database=awaver;Username=awaver;Password=awaver")
            .Options);

        var migrations = dbContext.GetService<IMigrationsAssembly>().Migrations.Keys;

        Assert.Contains("20260713120000_AddAnalysisEventIdempotency", migrations);
        Assert.Contains("20260713121000_AddCalibrationFrameCounts", migrations);
        Assert.Contains("20260714000000_AddVideoIdToLearningSessions", migrations);
        Assert.Contains("20260714000001_AddVideoTimeSecToDrowsinessScores", migrations);
        Assert.Contains("20260714000002_AddAnalysisOutboxLeases", migrations);
    }
}
