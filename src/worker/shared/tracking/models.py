from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

DrowsinessLevel = Literal["normal", "caution", "warning", "danger"]
CalibrationStatus = Literal["ready", "calibrating", "succeeded", "failed"]


@dataclass(frozen=True)
class LandmarkPoint:
    x: float
    y: float
    z: float = 0.0


@dataclass(frozen=True)
class FaceMetrics:
    ear: float
    pitch_deg: float
    yaw_deg: float
    landmarks: tuple[LandmarkPoint, ...] = ()


@dataclass(frozen=True)
class CalibrationResult:
    ear_open: float
    ear_threshold: float
    valid_frames: int
    total_frames: int


@dataclass(frozen=True)
class CalibrationProgress:
    status: CalibrationStatus
    valid_frames: int
    total_frames: int
    target_frames: int
    result: CalibrationResult | None = None


@dataclass(frozen=True)
class DrowsinessResult:
    perclos: float
    score: float
    level: DrowsinessLevel
    should_pause: bool
    is_closed: bool
    window_frames: int
