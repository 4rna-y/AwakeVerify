using Awaver.Backend.Data;
using Awaver.Backend.Models;
using Awaver.Backend.Services;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Awaver.Backend.Tests;

/// <summary>
/// These assertions exercise PostgreSQL's FOR UPDATE SKIP LOCKED behavior. Set
/// OUTBOX_TEST_POSTGRES_CONNECTION_STRING in CI or the devcontainer to run them;
/// unit-test environments without PostgreSQL retain the fast in-memory suite.
/// </summary>
public sealed class AnalysisOutboxPostgresIntegrationTests
{
    [Fact]
    public async Task Claiming_IsBatchConfigurable_AndDoesNotOverlapAcrossDispatchers()
    {
        await using var database = await PostgresOutboxDatabase.CreateAsync();
        if (!database.IsAvailable) return;
        var now = DateTimeOffset.UtcNow;
        await database.SeedAsync(30, now);

        await using var first = database.CreateContext();
        await using var second = database.CreateContext();
        var firstClaim = AnalysisOutboxDispatcher.ClaimDueEventsAsync(first, 20, Guid.NewGuid(), "dispatcher-a", now, TimeSpan.FromSeconds(30), CancellationToken.None);
        var secondClaim = AnalysisOutboxDispatcher.ClaimDueEventsAsync(second, 20, Guid.NewGuid(), "dispatcher-b", now, TimeSpan.FromSeconds(30), CancellationToken.None);
        var claims = await Task.WhenAll(firstClaim, secondClaim);

        Assert.Equal(30, claims.Sum(items => items.Count));
        Assert.Equal(30, claims.SelectMany(items => items).Select(item => item.EventId).Distinct().Count());
        Assert.All(claims.SelectMany(items => items), item => Assert.Equal(now.AddSeconds(30), item.LockedUntil));
    }

    [Fact]
    public async Task ExpiredLease_CanBeClaimedByAnotherDispatcher()
    {
        await using var database = await PostgresOutboxDatabase.CreateAsync();
        if (!database.IsAvailable) return;
        var now = DateTimeOffset.UtcNow;
        await database.SeedAsync(1, now);
        var firstLease = Guid.NewGuid();

        await using (var first = database.CreateContext())
        {
            var claimed = await AnalysisOutboxDispatcher.ClaimDueEventsAsync(first, 1, firstLease, "dispatcher-a", now, TimeSpan.FromSeconds(1), CancellationToken.None);
            Assert.Single(claimed);
        }

        await using var second = database.CreateContext();
        var secondLease = Guid.NewGuid();
        var reclaimed = await AnalysisOutboxDispatcher.ClaimDueEventsAsync(second, 1, secondLease, "dispatcher-b", now.AddSeconds(1), TimeSpan.FromSeconds(30), CancellationToken.None);

        var item = Assert.Single(reclaimed);
        Assert.Equal(secondLease, item.LeaseId);
        Assert.Equal("dispatcher-b", item.ProcessingOwner);
    }

    private sealed class PostgresOutboxDatabase : IAsyncDisposable
    {
        private readonly string? connectionString;
        private readonly string? schema;
        public bool IsAvailable => connectionString is not null;

        private PostgresOutboxDatabase(string? connectionString, string? schema)
        {
            this.connectionString = connectionString;
            this.schema = schema;
        }

        public static async Task<PostgresOutboxDatabase> CreateAsync()
        {
            var configuredConnectionString = Environment.GetEnvironmentVariable("OUTBOX_TEST_POSTGRES_CONNECTION_STRING");
            if (string.IsNullOrWhiteSpace(configuredConnectionString)) return new(null, null);
            var schema = $"outbox_test_{Guid.NewGuid():N}";
            await using var connection = new NpgsqlConnection(configuredConnectionString);
            await connection.OpenAsync();
            await using var command = new NpgsqlCommand($"CREATE SCHEMA {schema}; CREATE TABLE {schema}.analysis_event_outbox (event_id uuid PRIMARY KEY, session_id uuid NOT NULL, idempotency_key varchar(256) NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL, delivered_at timestamptz NULL, attempt_count integer NOT NULL, next_attempt_at timestamptz NOT NULL, last_error text NULL, lease_id uuid NULL, locked_until timestamptz NULL, processing_owner varchar(128) NULL);", connection);
            await command.ExecuteNonQueryAsync();
            var builder = new NpgsqlConnectionStringBuilder(configuredConnectionString) { SearchPath = schema };
            return new(builder.ConnectionString, schema);
        }

        public AwaverDbContext CreateContext() => new(new DbContextOptionsBuilder<AwaverDbContext>().UseNpgsql(connectionString!).Options);

        public async Task SeedAsync(int count, DateTimeOffset now)
        {
            await using var dbContext = CreateContext();
            dbContext.AnalysisEventOutbox.AddRange(Enumerable.Range(0, count).Select(index => new AnalysisEventOutbox
            {
                EventId = Guid.NewGuid(),
                SessionId = Guid.NewGuid(),
                IdempotencyKey = $"outbox-test-{index}",
                Payload = "{}",
                CreatedAt = now,
                NextAttemptAt = now,
            }));
            await dbContext.SaveChangesAsync();
        }

        public async ValueTask DisposeAsync()
        {
            if (!IsAvailable) return;
            await using var connection = new NpgsqlConnection(connectionString!);
            await connection.OpenAsync();
            await using var command = new NpgsqlCommand($"DROP SCHEMA IF EXISTS {schema} CASCADE;", connection);
            await command.ExecuteNonQueryAsync();
        }
    }
}
