import assert from "node:assert/strict";
import test from "node:test";
import { Metrics } from "./metrics";

test("summarizes counters and frame-to-result latency percentiles", () => {
    const metrics = new Metrics();
    metrics.increment("sessionsCreated");
    metrics.increment("framesSent");
    metrics.increment("acknowledgements");
    metrics.recordLatency(10);
    metrics.recordLatency(20);
    metrics.recordLatency(30);
    metrics.recordLatency(40);

    const summary = metrics.summarize(1234);

    assert.equal(summary.sessionsCreated, 1);
    assert.equal(summary.framesSent, 1);
    assert.equal(summary.acknowledgements, 1);
    assert.equal(summary.totalDurationMs, 1234);
    assert.deepEqual(summary.frameToResultLatencyMs, { samples: 4, p50: 20, p95: 40, max: 40 });
});

test("uses null latency statistics when no result contains a source sequence", () => {
    const summary = new Metrics().summarize(0);

    assert.deepEqual(summary.frameToResultLatencyMs, { samples: 0, p50: null, p95: null, max: null });
});
