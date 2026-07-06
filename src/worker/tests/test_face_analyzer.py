# pyright: reportImplicitRelativeImport=false, reportUninitializedInstanceVariable=false, reportImplicitOverride=false
from __future__ import annotations

import math
from unittest import TestCase
from unittest.mock import MagicMock

import numpy as np

from shared.tracking.face_analyzer import (
    LEFT_EYE_IDX,
    RIGHT_EYE_IDX,
    FaceAnalyzer,
    FaceMetrics,
    _compute_ear,
    _rotation_to_pitch_yaw,
)


def _make_landmark(x: float, y: float) -> MagicMock:
    lm = MagicMock()
    lm.x = x
    lm.y = y
    return lm


def _make_eye_landmarks(
    indices: list[int],
    coords: list[tuple[float, float]],
) -> dict[int, MagicMock]:
    return {i: _make_landmark(x, y) for i, (x, y) in zip(indices, coords)}


# A symmetric open-eye geometry where EAR = 1.0:
#   p0=(0,0), p1=(0.25, 0.5), p2=(0.5, 0.5)
#   p3=(1,0), p4=(0.5,-0.5), p5=(0.25,-0.5)
#   dist(p0,p3)=1, dist(p1,p5)=1, dist(p2,p4)=1  → EAR = 2/2 = 1.0
_OPEN_EYE_COORDS = [
    (0.0, 0.0),
    (0.25, 0.5),
    (0.5, 0.5),
    (1.0, 0.0),
    (0.5, -0.5),
    (0.25, -0.5),
]

# A nearly-closed eye where EAR = 0.1:
#   p0=(0,0), p3=(1,0): width=1
#   p1=(0.25, 0.05), p5=(0.25,-0.05): height=0.1
#   p2=(0.5, 0.05), p4=(0.5,-0.05): height=0.1
_CLOSED_EYE_COORDS = [
    (0.0, 0.0),
    (0.25, 0.05),
    (0.5, 0.05),
    (1.0, 0.0),
    (0.5, -0.05),
    (0.25, -0.05),
]


class ComputeEarTests(TestCase):
    def test_symmetric_open_eye_returns_one(self) -> None:
        landmarks = _make_eye_landmarks(RIGHT_EYE_IDX, _OPEN_EYE_COORDS)
        self.assertAlmostEqual(_compute_ear(landmarks, RIGHT_EYE_IDX), 1.0)

    def test_nearly_closed_eye_returns_low_value(self) -> None:
        landmarks = _make_eye_landmarks(RIGHT_EYE_IDX, _CLOSED_EYE_COORDS)
        self.assertAlmostEqual(_compute_ear(landmarks, RIGHT_EYE_IDX), 0.1)

    def test_zero_width_eye_returns_zero(self) -> None:
        landmarks = {i: _make_landmark(0.5, 0.5) for i in RIGHT_EYE_IDX}
        self.assertEqual(_compute_ear(landmarks, RIGHT_EYE_IDX), 0.0)

    def test_left_eye_indices_are_used(self) -> None:
        landmarks = _make_eye_landmarks(LEFT_EYE_IDX, _OPEN_EYE_COORDS)
        self.assertAlmostEqual(_compute_ear(landmarks, LEFT_EYE_IDX), 1.0)


class RotationToPitchYawTests(TestCase):
    def test_identity_rotation_gives_zero_angles(self) -> None:
        pitch, yaw = _rotation_to_pitch_yaw(np.eye(3))
        self.assertAlmostEqual(pitch, 0.0)
        self.assertAlmostEqual(yaw, 0.0)

    def test_pitch_30_degrees(self) -> None:
        # R_x(-30°) produces pitch = +30°
        a = math.radians(30)
        r = np.array([
            [1.0, 0.0, 0.0],
            [0.0, math.cos(-a), -math.sin(-a)],
            [0.0, math.sin(-a), math.cos(-a)],
        ])
        pitch, yaw = _rotation_to_pitch_yaw(r)
        self.assertAlmostEqual(pitch, 30.0, places=5)
        self.assertAlmostEqual(yaw, 0.0, places=5)

    def test_yaw_45_degrees(self) -> None:
        # R_y(-45°) produces yaw = +45°
        a = math.radians(45)
        r = np.array([
            [math.cos(-a), 0.0, math.sin(-a)],
            [0.0, 1.0, 0.0],
            [-math.sin(-a), 0.0, math.cos(-a)],
        ])
        pitch, yaw = _rotation_to_pitch_yaw(r)
        self.assertAlmostEqual(pitch, 0.0, places=5)
        self.assertAlmostEqual(yaw, 45.0, places=5)


class FaceAnalyzerTests(TestCase):
    def _make_analyzer(self, detect_result: Any) -> FaceAnalyzer:
        mock_landmarker = MagicMock()
        mock_landmarker.detect.return_value = detect_result
        return FaceAnalyzer(
            landmarker=mock_landmarker,
            prepare_image=lambda img: img,
        )

    def _make_result(
        self,
        landmarks: Any,
        matrix: Any,
    ) -> MagicMock:
        result = MagicMock()
        result.face_landmarks = [landmarks] if landmarks is not None else []
        result.facial_transformation_matrixes = [matrix] if matrix is not None else []
        return result

    def test_no_face_detected_returns_none(self) -> None:
        analyzer = self._make_analyzer(self._make_result(None, None))
        self.assertIsNone(analyzer.analyze(object()))

    def test_face_detected_but_no_matrix_returns_none(self) -> None:
        lm = _make_eye_landmarks(RIGHT_EYE_IDX, _OPEN_EYE_COORDS) | _make_eye_landmarks(LEFT_EYE_IDX, _OPEN_EYE_COORDS)
        analyzer = self._make_analyzer(self._make_result(lm, None))
        self.assertIsNone(analyzer.analyze(object()))

    def test_face_detected_returns_face_metrics(self) -> None:
        landmarks = (
            _make_eye_landmarks(RIGHT_EYE_IDX, _OPEN_EYE_COORDS)
            | _make_eye_landmarks(LEFT_EYE_IDX, _OPEN_EYE_COORDS)
        )
        matrix = np.eye(4)
        analyzer = self._make_analyzer(self._make_result(landmarks, matrix))

        metrics = analyzer.analyze(object())

        self.assertIsInstance(metrics, FaceMetrics)
        assert metrics is not None
        self.assertAlmostEqual(metrics.ear, 1.0)
        self.assertAlmostEqual(metrics.pitch_deg, 0.0)
        self.assertAlmostEqual(metrics.yaw_deg, 0.0)

    def test_ear_is_average_of_both_eyes(self) -> None:
        # right eye: EAR=1.0, left eye: EAR=0.1 → average=0.55
        landmarks = (
            _make_eye_landmarks(RIGHT_EYE_IDX, _OPEN_EYE_COORDS)
            | _make_eye_landmarks(LEFT_EYE_IDX, _CLOSED_EYE_COORDS)
        )
        analyzer = self._make_analyzer(self._make_result(landmarks, np.eye(4)))

        metrics = analyzer.analyze(object())

        assert metrics is not None
        self.assertAlmostEqual(metrics.ear, 0.55)

    def test_close_calls_landmarker_close(self) -> None:
        mock_landmarker = MagicMock()
        analyzer = FaceAnalyzer(landmarker=mock_landmarker)
        analyzer.close()
        mock_landmarker.close.assert_called_once()


# Required for pyright to resolve the `Any` annotation used in _make_analyzer
from typing import Any  # noqa: E402
