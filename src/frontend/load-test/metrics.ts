export type Summary = {
    sessionsCreated: number;
    framesOffered: number;
    framesSent: number;
    framesNotSentDueToInFlightLimit: number;
    acknowledgements: number;
    negativeAcknowledgements: number;
    retransmissions: number;
    webSocketConnectionFailures: number;
    webSocketReconnects: number;
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
    max: number | null;
};

export class Metrics {
    private readonly counters = {
        sessionsCreated: 0,
        framesOffered: 0,
        framesSent: 0,
        framesNotSentDueToInFlightLimit: 0,
        acknowledgements: 0,
        negativeAcknowledgements: 0,
        retransmissions: 0,
        webSocketConnectionFailures: 0,
        webSocketReconnects: 0,
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
