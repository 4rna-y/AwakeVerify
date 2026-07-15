using System.Diagnostics;
using System.Diagnostics.Metrics;

namespace Awaver.Backend.Services;

/// <summary>
/// Low-cardinality, payload-free metrics for analysis result persistence and
/// transactional outbox delivery. These instruments deliberately use only
/// fixed stage and outcome tags so they are safe under sustained request load.
/// </summary>
public sealed class BackendObservability : IAnalysisResultObservability, IAnalysisOutboxObservability, IDisposable
{
    public const string MeterName = "Awaver.Backend.Observability";

    private readonly Meter meter = new(MeterName, "1.0.0");
    private readonly Counter<long> analysisResultRequests;
    private readonly Histogram<double> analysisResultDuration;
    private readonly Histogram<double> analysisResultStageDuration;
    private readonly Counter<long> outboxClaimed;
    private readonly Histogram<double> outboxClaimDuration;
    private readonly Histogram<double> outboxDeliveryDuration;
    private readonly Histogram<double> outboxMarkDuration;
    private readonly Histogram<double> outboxBatchDuration;
    private long undeliveredCount;
    private long oldestUndeliveredAgeMilliseconds;

    public BackendObservability()
    {
        analysisResultRequests = meter.CreateCounter<long>("awaver.backend.analysis_results.requests", description: "Analysis-results requests by outcome.");
        analysisResultDuration = meter.CreateHistogram<double>("awaver.backend.analysis_results.duration", unit: "ms", description: "End-to-end analysis-results request duration.");
        analysisResultStageDuration = meter.CreateHistogram<double>("awaver.backend.analysis_results.stage.duration", unit: "ms", description: "Analysis-results persistence stage duration.");
        outboxClaimed = meter.CreateCounter<long>("awaver.backend.outbox.claimed", description: "Outbox events successfully claimed.");
        outboxClaimDuration = meter.CreateHistogram<double>("awaver.backend.outbox.claim.duration", unit: "ms", description: "Outbox claim duration.");
        outboxDeliveryDuration = meter.CreateHistogram<double>("awaver.backend.outbox.delivery.duration", unit: "ms", description: "Per-event outbox delivery duration.");
        outboxMarkDuration = meter.CreateHistogram<double>("awaver.backend.outbox.mark.duration", unit: "ms", description: "Outbox delivery/failure marking duration.");
        outboxBatchDuration = meter.CreateHistogram<double>("awaver.backend.outbox.batch.duration", unit: "ms", description: "Outbox dispatch batch duration.");
        _ = meter.CreateObservableGauge<long>("awaver.backend.outbox.undelivered.count", () => Volatile.Read(ref undeliveredCount), description: "Current undelivered outbox record count for this backend instance.");
        _ = meter.CreateObservableGauge<long>("awaver.backend.outbox.oldest_undelivered.age", () => Volatile.Read(ref oldestUndeliveredAgeMilliseconds), unit: "ms", description: "Age of the oldest undelivered outbox record for this backend instance; zero when none exist.");
    }

    public void RecordRequest(string outcome, TimeSpan duration)
    {
        var tags = new TagList { { "outcome", outcome } };
        analysisResultRequests.Add(1, tags);
        analysisResultDuration.Record(duration.TotalMilliseconds, tags);
    }

    public void RecordStage(string stage, TimeSpan duration) =>
        analysisResultStageDuration.Record(duration.TotalMilliseconds, new TagList { { "stage", stage } });

    public void RecordClaim(TimeSpan duration, string outcome, int claimedCount)
    {
        outboxClaimDuration.Record(duration.TotalMilliseconds, new TagList { { "outcome", outcome } });
        if (claimedCount > 0) outboxClaimed.Add(claimedCount);
    }

    public void RecordDelivery(TimeSpan duration, string outcome) =>
        outboxDeliveryDuration.Record(duration.TotalMilliseconds, new TagList { { "outcome", outcome } });

    public void RecordMark(TimeSpan duration, string operation, string outcome) =>
        outboxMarkDuration.Record(duration.TotalMilliseconds, new TagList { { "operation", operation }, { "outcome", outcome } });

    public void RecordBatch(TimeSpan duration, string outcome) =>
        outboxBatchDuration.Record(duration.TotalMilliseconds, new TagList { { "outcome", outcome } });

    public void SetUndeliveredHealth(int count, TimeSpan? oldestAge)
    {
        Volatile.Write(ref undeliveredCount, Math.Max(0, count));
        Volatile.Write(ref oldestUndeliveredAgeMilliseconds, oldestAge is null ? 0 : Math.Max(0, (long)oldestAge.Value.TotalMilliseconds));
    }

    public void Dispose() => meter.Dispose();
}

public interface IAnalysisResultObservability
{
    void RecordRequest(string outcome, TimeSpan duration);
    void RecordStage(string stage, TimeSpan duration);
}

public interface IAnalysisOutboxObservability
{
    void RecordClaim(TimeSpan duration, string outcome, int claimedCount);
    void RecordDelivery(TimeSpan duration, string outcome);
    void RecordMark(TimeSpan duration, string operation, string outcome);
    void RecordBatch(TimeSpan duration, string outcome);
    void SetUndeliveredHealth(int count, TimeSpan? oldestAge);
}
