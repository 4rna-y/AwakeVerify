from __future__ import annotations

from unittest import TestCase

from shared.tracking.drowsiness import DrowsinessScorer, calculate_score, classify_level
from shared.tracking.models import FaceMetrics


class DrowsinessScorerTests(TestCase):
    def test_face_not_detected_is_skipped(self) -> None:
        scorer = DrowsinessScorer(window_size=3)

        self.assertIsNone(scorer.update(None, ear_threshold=0.2))
        self.assertEqual(scorer.perclos, 0.0)

    def test_perclos_uses_sliding_window(self) -> None:
        scorer = DrowsinessScorer(window_size=3)

        scorer.update(FaceMetrics(ear=0.10, pitch_deg=0, yaw_deg=0), ear_threshold=0.2)
        scorer.update(FaceMetrics(ear=0.30, pitch_deg=0, yaw_deg=0), ear_threshold=0.2)
        result = scorer.update(
            FaceMetrics(ear=0.10, pitch_deg=0, yaw_deg=0), ear_threshold=0.2
        )

        assert result is not None
        self.assertAlmostEqual(result.perclos, 2 / 3)
        self.assertEqual(result.level, "danger")
        self.assertTrue(result.should_pause)

        result = scorer.update(
            FaceMetrics(ear=0.30, pitch_deg=0, yaw_deg=0), ear_threshold=0.2
        )

        assert result is not None
        self.assertAlmostEqual(result.perclos, 1 / 3)

    def test_level_thresholds(self) -> None:
        self.assertEqual(classify_level(0.24), "normal")
        self.assertEqual(classify_level(0.25), "caution")
        self.assertEqual(classify_level(0.50), "warning")
        self.assertEqual(classify_level(0.75), "danger")

    def test_score_formula_uses_yaw_weight(self) -> None:
        self.assertAlmostEqual(calculate_score(0.50, pitch_deg=0, yaw_deg=0), 1.0)
        self.assertAlmostEqual(calculate_score(0.50, pitch_deg=0, yaw_deg=45), 0.0)
