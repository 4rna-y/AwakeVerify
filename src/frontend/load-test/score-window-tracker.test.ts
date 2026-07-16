import assert from "node:assert/strict";
import test from "node:test";
import { ScoreWindowTracker } from "./score-window-tracker";

test("uses scoredAt to match a score notification and source sequence for latency", () => {
    const tracker = new ScoreWindowTracker();
    tracker.recordAcceptedFrame(25, "2026-07-16T10:00:00.100Z", 100);
    tracker.recordAcceptedFrame(26, "2026-07-16T10:00:00.900Z", 200);
    tracker.recordAcceptedFrame(27, "2026-07-16T10:00:00.950Z", 300);
    tracker.recordAcceptedFrame(28, "2026-07-16T10:00:00.960Z", 400);
    tracker.recordAcceptedFrame(29, "2026-07-16T10:00:00.970Z", 500);
    tracker.recordAcceptedFrame(30, "2026-07-16T10:00:00.980Z", 600);
    tracker.recordAcceptedFrame(31, "2026-07-16T10:00:01.100Z", 700);
    tracker.recordAnalysisEvent({ type: "calibration_status", status: "succeeded", sourceSequenceNo: 25 }, 350);

    assert.equal(
        tracker.recordAnalysisEvent({
            type: "drowsiness_score",
            sourceSequenceNo: 31,
            scoredAt: "2026-07-16T10:00:00Z",
        }, 1_000),
        300,
    );
    assert.equal(tracker.consumeSealedTimeouts(), 0);
});

test("counts only calibrated, sealed score windows that lack a notification", () => {
    const tracker = new ScoreWindowTracker();
    tracker.recordAcceptedFrame(24, "2026-07-16T10:00:00.100Z", 100);
    tracker.recordAcceptedFrame(26, "2026-07-16T10:00:01.100Z", 200);
    tracker.recordAcceptedFrame(27, "2026-07-16T10:00:02.100Z", 300);
    tracker.recordAnalysisEvent({ type: "calibration_status", status: "succeeded", sourceSequenceNo: 25 }, 350);

    assert.equal(tracker.consumeSealedTimeouts(), 1);
    assert.equal(tracker.consumeSealedTimeouts(), 0);
});
