export type Summary = {
    sessionsCreated: number;
    framesOffered: number;
    framesSent: number;
    framesNotSentDueToInFlightLimit: number;
    acceptedFrames: number;
    retryableRejections: number;
    permanentRejections: number;
    retransmissions: number;
    signalRReconnects: number;
    analysisResultsReceived: number;
    crossSessionDeliveries: number;
    timeouts: number;
    totalDurationMs: number;
    frameToResultLatencyMs: LatencySummary;
};

export type LatencySummary = {
    samples: number;
    p50: number | null;
    p95: number | null;
    p99: number | null;
    max: number | null;
};

export const frameToResultSlo = {
    p95Ms: 2_000,
    p99Ms: 5_000,
} as const;

export function meetsFrameToResultSlo(latency: LatencySummary): boolean {
    return latency.p95 !== null
        && latency.p99 !== null
        && latency.p95 <= frameToResultSlo.p95Ms
        && latency.p99 <= frameToResultSlo.p99Ms;
}

export class Metrics {
    private readonly counters = {
        sessionsCreated: 0,
        framesOffered: 0,
        framesSent: 0,
        framesNotSentDueToInFlightLimit: 0,
        acceptedFrames: 0,
        retryableRejections: 0,
        permanentRejections: 0,
        retransmissions: 0,
        signalRReconnects: 0,
        analysisResultsReceived: 0,
        crossSessionDeliveries: 0,
        timeouts: 0,
    };
    private readonly latencySamples: number[] = [];

    public increment(name: keyof Omit<Summary, "totalDurationMs" | "frameToResultLatencyMs">): void {
        this.counters[name] += 1;
    }

    public recordLatency(latencyMs: number): void {
        if (Number.isFinite(latencyMs) && latencyMs >= 0) this.latencySamples.push(latencyMs);
    }

    public summarize(totalDurationMs: number): Summary {
        const samples = [...this.latencySamples].sort((left, right) => left - right);
        return {
            ...this.counters,
            totalDurationMs,
            frameToResultLatencyMs: {
                samples: samples.length,
                p50: percentile(samples, 0.5),
                p95: percentile(samples, 0.95),
                p99: percentile(samples, 0.99),
                max: samples.length === 0 ? null : samples.at(-1) ?? null,
            },
        };
    }
}

function percentile(sortedSamples: readonly number[], percentileValue: number): number | null {
    if (sortedSamples.length === 0) return null;
    const index = Math.ceil(sortedSamples.length * percentileValue) - 1;
    return sortedSamples[Math.max(0, Math.min(index, sortedSamples.length - 1))] ?? null;
}
