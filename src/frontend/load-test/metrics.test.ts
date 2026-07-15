import assert from "node:assert/strict";
import test from "node:test";
import { frameToResultSlo, meetsFrameToResultSlo, Metrics } from "./metrics";

test("summarizes counters and frame-to-result latency percentiles", () => {
    const metrics = new Metrics();
    metrics.increment("sessionsCreated");
    metrics.increment("framesOffered");
    metrics.increment("framesSent");
    metrics.increment("framesNotSentDueToInFlightLimit");
    metrics.increment("acceptedFrames");
    metrics.recordLatency(10);
    metrics.recordLatency(20);
    metrics.recordLatency(30);
    metrics.recordLatency(40);

    const summary = metrics.summarize(1234);

    assert.equal(summary.sessionsCreated, 1);
    assert.equal(summary.framesOffered, 1);
    assert.equal(summary.framesSent, 1);
    assert.equal(summary.framesNotSentDueToInFlightLimit, 1);
    assert.equal(summary.acceptedFrames, 1);
    assert.equal(summary.totalDurationMs, 1234);
    assert.deepEqual(summary.frameToResultLatencyMs, { samples: 4, p50: 20, p95: 40, p99: 40, max: 40 });
    assert.equal(meetsFrameToResultSlo(summary.frameToResultLatencyMs), true);
});

test("uses null latency statistics when no result contains a source sequence", () => {
    const summary = new Metrics().summarize(0);

    assert.equal(summary.framesOffered, 0);
    assert.equal(summary.framesNotSentDueToInFlightLimit, 0);
    assert.deepEqual(summary.frameToResultLatencyMs, { samples: 0, p50: null, p95: null, p99: null, max: null });
    assert.equal(meetsFrameToResultSlo(summary.frameToResultLatencyMs), false);
});

test("rejects a latency distribution that exceeds either SLO percentile", () => {
    assert.equal(meetsFrameToResultSlo({ samples: 100, p50: 10, p95: frameToResultSlo.p95Ms + 1, p99: 100, max: 2_100 }), false);
    assert.equal(meetsFrameToResultSlo({ samples: 100, p50: 10, p95: 100, p99: frameToResultSlo.p99Ms + 1, max: 5_100 }), false);
});
