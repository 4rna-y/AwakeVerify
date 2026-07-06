from __future__ import annotations

from statistics import median

from .models import CalibrationProgress, CalibrationResult, CalibrationStatus, FaceMetrics


class CalibrationTracker:
    def __init__(
        self,
        *,
        target_frames: int = 25,
        min_valid_frames: int = 15,
        front_yaw_limit_deg: float = 15.0,
        front_pitch_limit_deg: float = 15.0,
        threshold_ratio: float = 0.75,
    ) -> None:
        if target_frames <= 0:
            raise ValueError("target_frames must be positive")
        if min_valid_frames <= 0:
            raise ValueError("min_valid_frames must be positive")
        if min_valid_frames > target_frames:
            raise ValueError("min_valid_frames must be <= target_frames")
        if threshold_ratio <= 0:
            raise ValueError("threshold_ratio must be positive")

        self.target_frames: int = target_frames
        self.min_valid_frames: int = min_valid_frames
        self.front_yaw_limit_deg: float = front_yaw_limit_deg
        self.front_pitch_limit_deg: float = front_pitch_limit_deg
        self.threshold_ratio: float = threshold_ratio
        self.reset()

    def reset(self) -> None:
        self.status: CalibrationStatus = "ready"
        self._total_frames: int = 0
        self._valid_ears: list[float] = []
        self.result: CalibrationResult | None = None

    def start(self) -> CalibrationProgress:
        self.status = "calibrating"
        self._total_frames = 0
        self._valid_ears = []
        self.result = None
        return self.progress

    @property
    def progress(self) -> CalibrationProgress:
        return CalibrationProgress(
            status=self.status,
            valid_frames=len(self._valid_ears),
            total_frames=self._total_frames,
            target_frames=self.target_frames,
            result=self.result,
        )

    def add_frame(self, metrics: FaceMetrics | None) -> CalibrationProgress:
        if self.status != "calibrating":
            return self.progress

        self._total_frames += 1
        if metrics is not None and self.is_valid_frame(metrics):
            self._valid_ears.append(metrics.ear)

        if self._total_frames >= self.target_frames:
            self._finish()

        return self.progress

    def is_valid_frame(self, metrics: FaceMetrics) -> bool:
        return (
            abs(metrics.yaw_deg) <= self.front_yaw_limit_deg
            and abs(metrics.pitch_deg) <= self.front_pitch_limit_deg
        )

    def _finish(self) -> None:
        valid_frames = len(self._valid_ears)
        if valid_frames >= self.min_valid_frames:
            ear_open = float(median(self._valid_ears))
            self.result = CalibrationResult(
                ear_open=ear_open,
                ear_threshold=ear_open * self.threshold_ratio,
                valid_frames=valid_frames,
                total_frames=self._total_frames,
            )
            self.status = "succeeded"
            return

        self.result = None
        self.status = "failed"
