using Awaver.Backend.Services;
using Microsoft.Extensions.Configuration;

namespace Awaver.Backend.Tests;

public sealed class OutboxDispatchOptionsTests
{
    [Fact]
    public void Load_UsesDocumentedDefaults()
    {
        var options = OutboxDispatchOptions.Load(new ConfigurationBuilder().Build());

        Assert.Equal(100, options.BatchSize);
        Assert.Equal(250, options.PollIntervalMs);
        Assert.Equal(30, options.LeaseSeconds);
    }

    [Theory]
    [InlineData("Outbox:BatchSize", "0", "OUTBOX_BATCH_SIZE")]
    [InlineData("Outbox:PollIntervalMs", "-1", "OUTBOX_POLL_INTERVAL_MS")]
    [InlineData("Outbox:LeaseSeconds", "not-a-number", "OUTBOX_LEASE_SECONDS")]
    public void Load_RejectsInvalidValuesAtStartup(string key, string value, string expectedSettingName)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { [key] = value })
            .Build();

        var exception = Assert.Throws<InvalidOperationException>(() => OutboxDispatchOptions.Load(configuration));

        Assert.Contains(expectedSettingName, exception.Message);
    }

    [Fact]
    public void Load_AcceptsPositiveValues()
    {
        var options = OutboxDispatchOptions.Load(new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Outbox:BatchSize"] = "101",
                ["Outbox:PollIntervalMs"] = "500",
                ["Outbox:LeaseSeconds"] = "45",
            })
            .Build());

        Assert.Equal(101, options.BatchSize);
        Assert.Equal(TimeSpan.FromMilliseconds(500), options.PollInterval);
        Assert.Equal(TimeSpan.FromSeconds(45), options.LeaseDuration);
    }
}
