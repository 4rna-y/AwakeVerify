from __future__ import annotations

from unittest import TestCase

from shared.tracking.calibration import CalibrationTracker
from shared.tracking.models import FaceMetrics


class CalibrationTrackerTests(TestCase):
    def test_success_uses_median_ear_and_threshold_ratio(self) -> None:
        tracker = CalibrationTracker(target_frames=5, min_valid_frames=3)
        tracker.start()

        for ear in [0.30, 0.40, 0.50, 0.60, 0.70]:
            progress = tracker.add_frame(FaceMetrics(ear=ear, pitch_deg=0, yaw_deg=0))

        self.assertEqual(progress.status, "succeeded")
        assert progress.result is not None
        self.assertAlmostEqual(progress.result.ear_open, 0.50)
        self.assertAlmostEqual(progress.result.ear_threshold, 0.375)
        self.assertEqual(progress.result.valid_frames, 5)
        self.assertEqual(progress.result.total_frames, 5)

    def test_failure_when_valid_frames_are_less_than_minimum(self) -> None:
        tracker = CalibrationTracker(target_frames=5, min_valid_frames=3)
        tracker.start()

        tracker.add_frame(None)
        tracker.add_frame(FaceMetrics(ear=0.30, pitch_deg=20, yaw_deg=0))
        tracker.add_frame(FaceMetrics(ear=0.30, pitch_deg=0, yaw_deg=20))
        tracker.add_frame(FaceMetrics(ear=0.30, pitch_deg=0, yaw_deg=0))
        progress = tracker.add_frame(None)

        self.assertEqual(progress.status, "failed")
        self.assertIsNone(progress.result)
        self.assertEqual(progress.valid_frames, 1)
        self.assertEqual(progress.total_frames, 5)
