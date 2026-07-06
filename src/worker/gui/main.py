# pyright: reportAny=false, reportExplicitAny=false, reportImplicitRelativeImport=false, reportImplicitStringConcatenation=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnnecessaryCast=false, reportUnusedCallResult=false
from __future__ import annotations

import argparse
import glob
import os
import time
from pathlib import Path
from typing import Any, cast

os.environ.setdefault("LIBGL_ALWAYS_SOFTWARE", "1")

from shared.tracking.calibration import CalibrationTracker
from shared.tracking.drowsiness import DrowsinessScorer
from shared.tracking.face_analyzer import FaceAnalyzer, LEFT_EYE_IDX, RIGHT_EYE_IDX
from shared.tracking.models import DrowsinessResult, FaceMetrics


WORKER_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL_PATH = WORKER_ROOT / "models" / "face_landmarker.task"
WINDOW_NAME = "AwakeVerify Worker GUI"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="OpenCV GUI for local validation of Worker face tracking logic."
    )
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL_PATH)
    parser.add_argument("--camera", type=int, default=0)
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--analysis-fps", type=float, default=5.0)
    return parser.parse_args()


def put_lines(frame: Any, lines: list[str], *, origin: tuple[int, int] = (16, 28)) -> None:
    cv2 = cast(Any, __import__("cv2"))
    x, y = origin
    line_height = 24
    for index, line in enumerate(lines):
        pos = (x, y + index * line_height)
        cv2.putText(
            frame,
            line,
            pos,
            cv2.FONT_HERSHEY_SIMPLEX,
            0.62,
            (0, 0, 0),
            4,
            cv2.LINE_AA,
        )
        cv2.putText(
            frame,
            line,
            pos,
            cv2.FONT_HERSHEY_SIMPLEX,
            0.62,
            (255, 255, 255),
            1,
            cv2.LINE_AA,
        )


def draw_eye_landmarks(frame: Any, metrics: FaceMetrics | None) -> None:
    if metrics is None or not metrics.landmarks:
        return

    cv2 = cast(Any, __import__("cv2"))
    height, width = frame.shape[:2]
    for idx in RIGHT_EYE_IDX + LEFT_EYE_IDX:
        if idx >= len(metrics.landmarks):
            continue
        landmark = metrics.landmarks[idx]
        point = (int(landmark.x * width), int(landmark.y * height))
        cv2.circle(frame, point, 1, (0, 255, 255), -1, cv2.LINE_AA)


def overlay(
    frame: Any,
    *,
    metrics: FaceMetrics | None,
    calibration: CalibrationTracker,
    drowsiness: DrowsinessResult | None,
) -> None:
    draw_eye_landmarks(frame, metrics)

    progress = calibration.progress
    result = progress.result
    lines: list[str] = []

    if metrics is None:
        lines.append("EAR: - | Pitch: - | Yaw: -")
    else:
        lines.append(
            f"EAR: {metrics.ear:.3f} | Pitch: {metrics.pitch_deg:+.1f} deg | Yaw: {metrics.yaw_deg:+.1f} deg"
        )

    lines.append(
        f"Calibration: {progress.status} | valid/total: {progress.valid_frames}/{progress.total_frames}/{progress.target_frames}"
    )
    if result is not None:
        lines.append(
            f"EAR_open: {result.ear_open:.3f} | EAR_threshold: {result.ear_threshold:.3f}"
        )
    elif progress.status == "failed":
        lines.append("Calibration failed. Face the camera.")

    if drowsiness is None:
        lines.append("PERCLOS: - | score: - | level: - | shouldPause: -")
    else:
        lines.append(
            f"PERCLOS: {drowsiness.perclos:.3f} ({drowsiness.window_frames}f) | "
            f"score: {drowsiness.score:.3f} | level: {drowsiness.level} | "
            f"shouldPause: {drowsiness.should_pause} | closed: {drowsiness.is_closed}"
        )

    put_lines(frame, lines)


def visible_camera_devices() -> list[str]:
    return sorted(glob.glob("/dev/video*"))


def open_camera(camera_index: int, width: int, height: int) -> Any:
    devices = visible_camera_devices()
    expected_device = f"/dev/video{camera_index}"
    if expected_device not in devices:
        visible = ", ".join(devices) if devices else "none"
        raise SystemExit(
            f"Camera device is not visible: {expected_device}\n"
            f"Visible camera devices in this container: {visible}\n"
            "If you are in a devcontainer, pass the host camera device to Docker "
            "or run with --camera <index> matching a visible /dev/videoN device."
        )

    cv2 = cast(Any, __import__("cv2"))
    capture = cv2.VideoCapture(camera_index, cv2.CAP_V4L2)
    capture.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    capture.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    if not capture.isOpened():
        capture.release()
        raise SystemExit(
            f"Failed to open camera index {camera_index} ({expected_device}).\n"
            "The device is visible but OpenCV could not open it. Check host camera permissions "
            "and whether another application is using the camera."
        )
    return capture


def main() -> int:
    args = parse_args()
    model_path = args.model.expanduser().resolve()
    if not model_path.exists():
        raise SystemExit(
            f"MediaPipe model file not found: {model_path}\n"
            "Download face_landmarker.task and place it under src/worker/models/, "
            "or pass --model /path/to/face_landmarker.task."
        )
    if args.analysis_fps <= 0:
        raise SystemExit("--analysis-fps must be positive")

    cv2 = cast(Any, __import__("cv2"))
    capture = open_camera(args.camera, args.width, args.height)
    analyzer = FaceAnalyzer.create(str(model_path))
    calibration = CalibrationTracker()
    scorer = DrowsinessScorer()

    paused = False
    frame: Any | None = None
    metrics: FaceMetrics | None = None
    drowsiness: DrowsinessResult | None = None
    analysis_interval = 1.0 / args.analysis_fps
    last_analysis_at = 0.0

    cv2.namedWindow(WINDOW_NAME, cv2.WINDOW_NORMAL)

    try:
        while True:
            if not paused:
                ok, next_frame = capture.read()
                if not ok:
                    raise SystemExit("Failed to read a frame from the camera")
                frame = next_frame

                now = time.monotonic()
                if now - last_analysis_at >= analysis_interval:
                    last_analysis_at = now
                    metrics = analyzer.analyze(frame)
                    calibration.add_frame(metrics)
                    if calibration.result is not None:
                        drowsiness = scorer.update(
                            metrics,
                            ear_threshold=calibration.result.ear_threshold,
                        )

            if frame is None:
                continue

            display_frame = frame.copy()
            overlay(
                display_frame,
                metrics=metrics,
                calibration=calibration,
                drowsiness=drowsiness,
            )
            cv2.imshow(WINDOW_NAME, display_frame)

            key = cv2.waitKey(1) & 0xFF
            if key == ord("q"):
                break
            if key == ord("c"):
                calibration.start()
                scorer.reset()
                drowsiness = None
            elif key == ord("r"):
                scorer.reset()
                drowsiness = None
            elif key == ord(" "):
                paused = not paused
    finally:
        capture.release()
        analyzer.close()
        cv2.destroyAllWindows()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
