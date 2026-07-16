export type ScoreNotificationEvent = {
    type?: unknown;
    status?: unknown;
    sourceSequenceNo?: unknown;
    scoredAt?: unknown;
};

type PendingScoreWindow = {
    frames: Array<{ sourceSequenceNo: number; sentAtMs: number }>;
};

/**
 * Uses Feature 08's unique scoredAt second as the notification identity and
 * sourceSequenceNo only to find the precise frame-send timestamp for latency.
 */
export class ScoreWindowTracker {
    private readonly pendingByWindow = new Map<number, PendingScoreWindow>();
    private readonly sentAtBySequence = new Map<number, number>();
    private calibrationSourceSequence: number | undefined;
    private latestCapturedWindow: number | undefined;

    public recordAcceptedFrame(sourceSequenceNo: number, capturedAt: string, sentAtMs: number): void {
        const window = unixSecond(capturedAt);
        if (window === undefined) return;
        this.sentAtBySequence.set(sourceSequenceNo, sentAtMs);
        const pending = this.pendingByWindow.get(window) ?? { frames: [] };
        pending.frames.push({ sourceSequenceNo, sentAtMs });
        this.pendingByWindow.set(window, pending);
        this.latestCapturedWindow = this.latestCapturedWindow === undefined
            ? window
            : Math.max(this.latestCapturedWindow, window);
    }

    /** Returns latency only for the score notification that closes a tracked UTC second. */
    public recordAnalysisEvent(event: ScoreNotificationEvent, receivedAtMs: number): number | undefined {
        if (event.type === "calibration_status" && event.status === "succeeded" && isPositiveInteger(event.sourceSequenceNo)) {
            this.calibrationSourceSequence = event.sourceSequenceNo;
            return undefined;
        }
        if (event.type !== "drowsiness_score" || !isPositiveInteger(event.sourceSequenceNo) || typeof event.scoredAt !== "string") {
            return undefined;
        }
        if (this.calibrationSourceSequence === undefined || event.sourceSequenceNo <= this.calibrationSourceSequence) {
            return undefined;
        }
        const window = unixSecond(event.scoredAt);
        if (window === undefined) return undefined;
        const pending = this.pendingByWindow.get(window);
        if (!pending || !this.scoreSampleFor(pending)) return undefined;
        this.pendingByWindow.delete(window);
        const sentAtMs = this.sentAtBySequence.get(event.sourceSequenceNo);
        return sentAtMs === undefined ? undefined : Math.max(0, receivedAtMs - sentAtMs);
    }

    /**
     * The latest captured second is deliberately excluded: Worker publishes a
     * score only after it receives the first frame of the next UTC second.
     */
    public consumeSealedTimeouts(): number {
        if (this.calibrationSourceSequence === undefined || this.latestCapturedWindow === undefined) return 0;
        let timeouts = 0;
        for (const [window, pending] of this.pendingByWindow) {
            if (window < this.latestCapturedWindow && this.scoreSampleFor(pending)) {
                this.pendingByWindow.delete(window);
                timeouts += 1;
            }
        }
        return timeouts;
    }

    private scoreSampleFor(window: PendingScoreWindow): { sourceSequenceNo: number; sentAtMs: number } | undefined {
        const calibrationSourceSequence = this.calibrationSourceSequence;
        if (calibrationSourceSequence === undefined) return undefined;
        const samples = window.frames.filter((frame) => frame.sourceSequenceNo > calibrationSourceSequence).slice(0, 5);
        return samples.at(-1);
    }
}

function unixSecond(value: string): number | undefined {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : undefined;
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
