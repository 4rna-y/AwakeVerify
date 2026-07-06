# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnnecessaryCast=false
from __future__ import annotations

import math
from collections.abc import Mapping
from importlib import import_module
from typing import Any, Callable, cast

from .models import FaceMetrics, LandmarkPoint

# MediaPipe Face Mesh 6-point eye landmark indices (EAR model)
# Order per eye: [outer_corner, top_outer, top_inner, inner_corner, bottom_inner, bottom_outer]
RIGHT_EYE_IDX = [33, 160, 158, 133, 153, 144]
LEFT_EYE_IDX = [362, 385, 387, 263, 373, 380]




def _lm_dist(a: Any, b: Any) -> float:
    dx = a.x - b.x
    dy = a.y - b.y
    return math.sqrt(dx * dx + dy * dy)


def _compute_ear(landmarks: Any, indices: list[int]) -> float:
    p = [landmarks[i] for i in indices]
    numerator = _lm_dist(p[1], p[5]) + _lm_dist(p[2], p[4])
    denominator = 2.0 * _lm_dist(p[0], p[3])
    return numerator / denominator if denominator > 1e-6 else 0.0


def _rotation_to_pitch_yaw(r: Any) -> tuple[float, float]:
    """Extract pitch and yaw in degrees from a 3x3 rotation matrix.

    Pitch > 0: head tilted back (face upward).
    Yaw > 0: head turned to the subject's left (right from camera).
    """
    pitch_rad = math.asin(float(-r[2, 1]))
    yaw_rad = math.atan2(float(r[2, 0]), float(r[2, 2]))
    return math.degrees(pitch_rad), math.degrees(yaw_rad)


def _bgr_to_mp_image(bgr_image: Any) -> Any:
    cv2 = cast(Any, import_module("cv2"))
    mp = cast(Any, import_module("mediapipe"))
    rgb = cv2.cvtColor(bgr_image, cv2.COLOR_BGR2RGB)
    return mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)


def _to_landmark_points(landmarks: Any) -> tuple[LandmarkPoint, ...]:
    # Unit tests often pass a sparse dict keyed by MediaPipe index; GUI drawing only
    # needs dense MediaPipe landmark sequences returned by the real landmarker.
    if isinstance(landmarks, Mapping):
        return ()

    points: list[LandmarkPoint] = []
    for landmark in landmarks:
        points.append(
            LandmarkPoint(
                x=float(landmark.x),
                y=float(landmark.y),
                z=float(getattr(landmark, "z", 0.0)),
            )
        )
    return tuple(points)


class FaceAnalyzer:
    def __init__(
        self,
        landmarker: Any,
        *,
        prepare_image: Callable[[Any], Any] | None = None,
    ) -> None:
        self._landmarker: Any = landmarker
        self._prepare_image: Callable[[Any], Any] = prepare_image or _bgr_to_mp_image

    @classmethod
    def create(cls, model_path: str) -> "FaceAnalyzer":
        mp = cast(Any, import_module("mediapipe"))
        options = mp.tasks.vision.FaceLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(model_asset_path=model_path),
            output_facial_transformation_matrixes=True,
            num_faces=1,
        )
        return cls(mp.tasks.vision.FaceLandmarker.create_from_options(options))

    def analyze(self, bgr_image: Any) -> FaceMetrics | None:
        mp_image = self._prepare_image(bgr_image)
        result = self._landmarker.detect(mp_image)

        if not result.face_landmarks or not result.facial_transformation_matrixes:
            return None

        landmarks = result.face_landmarks[0]
        ear = (
            _compute_ear(landmarks, RIGHT_EYE_IDX)
            + _compute_ear(landmarks, LEFT_EYE_IDX)
        ) / 2.0

        pitch_deg, yaw_deg = _rotation_to_pitch_yaw(
            result.facial_transformation_matrixes[0][:3, :3]
        )

        return FaceMetrics(
            ear=ear,
            pitch_deg=pitch_deg,
            yaw_deg=yaw_deg,
            landmarks=_to_landmark_points(landmarks),
        )

    def close(self) -> None:
        self._landmarker.close()
