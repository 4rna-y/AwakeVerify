from __future__ import annotations

from collections import deque

from .models import DrowsinessLevel, DrowsinessResult, FaceMetrics


def classify_level(score: float) -> DrowsinessLevel:
    if score < 0.25:
        return "normal"
    if score < 0.50:
        return "caution"
    if score < 0.75:
        return "warning"
    return "danger"


def calculate_score(perclos: float, pitch_deg: float, yaw_deg: float) -> float:
    w_yaw = max(1.0 - abs(yaw_deg) / 45.0, 0.0)
    ear_score = min(perclos / 0.5, 1.0) * w_yaw
    pitch_factor = 1.0 + 0.3 * min(pitch_deg / 30.0, 1.0)
    return max(min(ear_score * pitch_factor, 1.0), 0.0)


def should_pause(level: DrowsinessLevel, score: float) -> bool:
    return level == "danger" or score >= 0.75


class DrowsinessScorer:
    def __init__(self, *, window_size: int = 75) -> None:
        if window_size <= 0:
            raise ValueError("window_size must be positive")
        self.window_size: int = window_size
        self._closed_window: deque[bool] = deque(maxlen=window_size)

    def reset(self) -> None:
        self._closed_window.clear()

    def update(
        self,
        metrics: FaceMetrics | None,
        *,
        ear_threshold: float,
    ) -> DrowsinessResult | None:
        if metrics is None:
            return None
        if ear_threshold <= 0:
            raise ValueError("ear_threshold must be positive")

        is_closed = metrics.ear < ear_threshold
        self._closed_window.append(is_closed)
        perclos = self.perclos
        score = calculate_score(perclos, metrics.pitch_deg, metrics.yaw_deg)
        level = classify_level(score)

        return DrowsinessResult(
            perclos=perclos,
            score=score,
            level=level,
            should_pause=should_pause(level, score),
            is_closed=is_closed,
            window_frames=len(self._closed_window),
        )

    @property
    def perclos(self) -> float:
        if not self._closed_window:
            return 0.0
        return sum(1 for is_closed in self._closed_window if is_closed) / len(
            self._closed_window
        )
