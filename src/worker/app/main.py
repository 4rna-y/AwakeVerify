# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnnecessaryCast=false
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import signal
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Protocol, cast, override
from urllib.error import URLError
from urllib.request import Request, urlopen

from app.analyzer.frame_decoder import FrameDecoder, FrameReference, FrameType
from shared.tracking.calibration import CalibrationTracker
from shared.tracking.drowsiness import DrowsinessScorer
from shared.tracking.face_analyzer import FaceAnalyzer
from shared.tracking.models import DrowsinessResult, FaceMetrics

WORKER_ROOT = Path(__file__).resolve().parents[1]
WORKSPACE_ROOT = WORKER_ROOT.parents[1]
DEFAULT_MODEL_PATH = WORKER_ROOT / "models" / "face_landmarker.task"
DEFAULT_LOCAL_FRAME_ROOT = WORKSPACE_ROOT / "data" / "blobs"
DEFAULT_BACKEND_BASE_URL = "http://localhost:5194"
DEFAULT_HEALTH_HOST = "0.0.0.0"
DEFAULT_HEALTH_PORT = 8000
DEFAULT_POLL_INTERVAL_SECONDS = 0.2
DEFAULT_POST_TIMEOUT_SECONDS = 3.0
LOCAL_FRAME_RE = re.compile(r"^(?P<sequence_no>\d+)_(?P<frame_type>[IP])\.bin$")

logger = logging.getLogger("worker")
stop_event = threading.Event()


@dataclass(frozen=True)
class WorkerConfig:
    model_path: Path
    backend_base_url: str
    local_frame_root: Path
    poll_interval_seconds: float
    post_timeout_seconds: float
    health_host: str
    health_port: int
    service_bus_connection_string: str | None
    service_bus_queue_name: str | None
    blob_connection_string: str | None
    blob_container_name: str


@dataclass(frozen=True)
class FrameEnvelope:
    reference: FrameReference
    payload: bytes


@dataclass
class SessionAnalysisState:
    calibration: CalibrationTracker
    scorer: DrowsinessScorer


class FrameSource(Protocol):
    def receive(self) -> list[FrameEnvelope]: ...

    def complete(self, envelope: FrameEnvelope) -> None: ...

    def abandon(self, envelope: FrameEnvelope, error: Exception) -> None: ...

    def close(self) -> None: ...


@dataclass(frozen=True)
class AzureFrameEnvelope(FrameEnvelope):
    message: Any


class LocalFrameDirectorySource:
    def __init__(self, root: Path) -> None:
        self._root: Path = root
        self._seen: set[Path] = set()

    def receive(self) -> list[FrameEnvelope]:
        if not self._root.exists():
            return []

        envelopes: list[FrameEnvelope] = []
        candidates = sorted(
            self._root.glob("sessions/*/frames/*.bin"),
            key=lambda path: (path.parts[-3], _parse_sequence_no(path.name) or 0),
        )
        for path in candidates:
            if path in self._seen:
                continue

            reference = self._reference_from_path(path)
            if reference is None:
                self._seen.add(path)
                continue

            try:
                payload = path.read_bytes()
            except OSError as error:
                logger.warning("Failed to read local frame %s: %s", path, error)
                continue

            if not payload:
                continue

            self._seen.add(path)
            envelopes.append(FrameEnvelope(reference=reference, payload=payload))

        return envelopes

    def complete(self, envelope: FrameEnvelope) -> None:
        _ = envelope
        return

    def abandon(self, envelope: FrameEnvelope, error: Exception) -> None:
        logger.warning(
            "Failed to process local frame: session=%s sequence=%s error=%s",
            envelope.reference.session_id,
            envelope.reference.sequence_no,
            error,
        )

    def close(self) -> None:
        return

    @staticmethod
    def _reference_from_path(path: Path) -> FrameReference | None:
        match = LOCAL_FRAME_RE.match(path.name)
        if not match:
            return None

        sequence_no = int(match.group("sequence_no"))
        frame_type = cast(FrameType, match.group("frame_type"))
        session_id = path.parts[-3]
        modified_at = datetime.fromtimestamp(path.stat().st_mtime, tz=UTC)
        base_i_frame_sequence_no = infer_base_i_frame_sequence_no(sequence_no, frame_type)
        blob_path = "/".join(path.parts[-4:])

        return FrameReference(
            session_id=session_id,
            sequence_no=sequence_no,
            frame_type=frame_type,
            base_i_frame_sequence_no=base_i_frame_sequence_no,
            blob_path=blob_path,
            captured_at=modified_at,
            received_at=modified_at,
            codec="image/jpeg",
        )


class AzureServiceBusFrameSource:
    def __init__(
        self,
        *,
        service_bus_connection_string: str,
        queue_name: str,
        blob_connection_string: str,
        blob_container_name: str,
    ) -> None:
        azure_servicebus = cast(Any, __import__("azure.servicebus", fromlist=["ServiceBusClient"]))
        azure_blob = cast(Any, __import__("azure.storage.blob", fromlist=["BlobServiceClient"]))

        self._service_bus_client: Any = azure_servicebus.ServiceBusClient.from_connection_string(
            service_bus_connection_string
        )
        self._receiver: Any = self._service_bus_client.get_queue_receiver(queue_name=queue_name)
        self._blob_service_client: Any = azure_blob.BlobServiceClient.from_connection_string(
            blob_connection_string
        )
        self._container_client: Any = self._blob_service_client.get_container_client(blob_container_name)

    def receive(self) -> list[FrameEnvelope]:
        messages = self._receiver.receive_messages(max_message_count=10, max_wait_time=5)
        envelopes: list[FrameEnvelope] = []
        for message in messages:
            reference = parse_frame_reference(_service_bus_message_to_text(message))
            blob_client = self._container_client.get_blob_client(reference.blob_path)
            payload = cast(bytes, blob_client.download_blob().readall())
            envelopes.append(AzureFrameEnvelope(reference=reference, payload=payload, message=message))
        return envelopes

    def complete(self, envelope: FrameEnvelope) -> None:
        if isinstance(envelope, AzureFrameEnvelope):
            self._receiver.complete_message(envelope.message)

    def abandon(self, envelope: FrameEnvelope, error: Exception) -> None:
        _ = error
        logger.exception(
            "Failed to process Azure frame: session=%s sequence=%s",
            envelope.reference.session_id,
            envelope.reference.sequence_no,
        )
        if isinstance(envelope, AzureFrameEnvelope):
            self._receiver.abandon_message(envelope.message)

    def close(self) -> None:
        self._receiver.close()
        self._service_bus_client.close()


class AnalysisResultPublisher:
    def __init__(self, backend_base_url: str, timeout_seconds: float) -> None:
        self._backend_base_url: str = backend_base_url.rstrip("/")
        self._timeout_seconds: float = timeout_seconds

    def publish(self, session_id: str, payload: dict[str, object]) -> None:
        url = f"{self._backend_base_url}/api/sessions/{session_id}/analysis-results"
        data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        request = Request(
            url,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=self._timeout_seconds) as response:
                if response.status >= 400:
                    logger.warning("Analysis result publish failed: HTTP %s", response.status)
        except URLError as error:
            logger.warning("Analysis result publish failed: %s", error)


def main() -> int:
    configure_logging()
    config = load_config(parse_args())
    validate_config(config)
    install_signal_handlers()
    health_server = start_health_server(config.health_host, config.health_port)

    logger.info("Starting worker")
    logger.info("Model path: %s", config.model_path)
    logger.info("Backend base URL: %s", config.backend_base_url)

    source = create_frame_source(config)
    analyzer = FaceAnalyzer.create(str(config.model_path))
    decoder = FrameDecoder()
    publisher = AnalysisResultPublisher(
        config.backend_base_url,
        timeout_seconds=config.post_timeout_seconds,
    )
    states: dict[str, SessionAnalysisState] = {}

    try:
        run_worker_loop(
            source=source,
            analyzer=analyzer,
            decoder=decoder,
            publisher=publisher,
            states=states,
            poll_interval_seconds=config.poll_interval_seconds,
        )
    finally:
        source.close()
        analyzer.close()
        if health_server is not None:
            health_server.shutdown()
            health_server.server_close()

    logger.info("Worker stopped")
    return 0


def run_worker_loop(
    *,
    source: FrameSource,
    analyzer: FaceAnalyzer,
    decoder: FrameDecoder,
    publisher: AnalysisResultPublisher,
    states: dict[str, SessionAnalysisState],
    poll_interval_seconds: float,
) -> None:
    while not stop_event.is_set():
        envelopes = source.receive()
        if not envelopes:
            _ = stop_event.wait(poll_interval_seconds)
            continue

        for envelope in envelopes:
            try:
                process_frame(
                    envelope,
                    analyzer=analyzer,
                    decoder=decoder,
                    publisher=publisher,
                    states=states,
                )
                source.complete(envelope)
            except Exception as error:
                source.abandon(envelope, error)


def process_frame(
    envelope: FrameEnvelope,
    *,
    analyzer: FaceAnalyzer,
    decoder: FrameDecoder,
    publisher: AnalysisResultPublisher,
    states: dict[str, SessionAnalysisState],
) -> None:
    reference = envelope.reference
    decoded = decoder.decode(reference, envelope.payload)
    if decoded is None:
        logger.info(
            "Skipped undecodable frame: session=%s sequence=%s type=%s",
            reference.session_id,
            reference.sequence_no,
            reference.frame_type,
        )
        return

    state = states.setdefault(
        reference.session_id,
        SessionAnalysisState(
            calibration=CalibrationTracker(),
            scorer=DrowsinessScorer(),
        ),
    )
    if state.calibration.progress.status in {"ready", "failed"}:
        _ = state.calibration.start()
        state.scorer.reset()

    metrics = analyzer.analyze(decoded.image)
    if metrics is None:
        publish_tracking_status(publisher, reference.session_id)
    else:
        logger.debug(
            "Frame metrics: session=%s sequence=%s ear=%.3f pitch=%.1f yaw=%.1f",
            reference.session_id,
            reference.sequence_no,
            metrics.ear,
            metrics.pitch_deg,
            metrics.yaw_deg,
        )

    progress = state.calibration.add_frame(metrics)
    if progress.status == "failed":
        logger.info(
            "Calibration failed: session=%s valid=%s total=%s",
            reference.session_id,
            progress.valid_frames,
            progress.total_frames,
        )
        return

    if progress.result is None:
        return

    drowsiness = state.scorer.update(
        metrics,
        ear_threshold=progress.result.ear_threshold,
    )
    if drowsiness is None:
        return

    publish_drowsiness_score(
        publisher,
        reference=reference,
        metrics=cast(FaceMetrics, metrics),
        drowsiness=drowsiness,
    )


def publish_tracking_status(publisher: AnalysisResultPublisher, session_id: str) -> None:
    publisher.publish(
        session_id,
        {
            "type": "tracking_status",
            "sessionId": session_id,
            "detectedAt": utc_now_iso(),
            "status": "face_not_detected",
        },
    )


def publish_drowsiness_score(
    publisher: AnalysisResultPublisher,
    *,
    reference: FrameReference,
    metrics: FaceMetrics,
    drowsiness: DrowsinessResult,
) -> None:
    publisher.publish(
        reference.session_id,
        {
            "type": "drowsiness_score",
            "sessionId": reference.session_id,
            "scoredAt": utc_now_iso(),
            "score": drowsiness.score,
            "level": drowsiness.level,
            "perclos": drowsiness.perclos,
            "ear": metrics.ear,
            "pitchDeg": metrics.pitch_deg,
            "yawDeg": metrics.yaw_deg,
            "shouldPause": drowsiness.should_pause,
        },
    )


def create_frame_source(config: WorkerConfig) -> FrameSource:
    if (
        config.service_bus_connection_string
        and config.service_bus_queue_name
        and config.blob_connection_string
    ):
        logger.info("Using Azure Service Bus / Blob Storage frame source")
        return AzureServiceBusFrameSource(
            service_bus_connection_string=config.service_bus_connection_string,
            queue_name=config.service_bus_queue_name,
            blob_connection_string=config.blob_connection_string,
            blob_container_name=config.blob_container_name,
        )

    logger.info("Using local frame directory source: %s", config.local_frame_root)
    return LocalFrameDirectorySource(config.local_frame_root)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="AwakeVerify Worker frame processor")
    _ = parser.add_argument("--model", type=Path, default=None)
    _ = parser.add_argument("--backend-base-url", default=None)
    _ = parser.add_argument("--local-frame-root", type=Path, default=None)
    _ = parser.add_argument("--poll-interval", type=float, default=None)
    _ = parser.add_argument("--health-host", default=None)
    _ = parser.add_argument("--health-port", type=int, default=None)
    return parser.parse_args()


def load_config(args: argparse.Namespace) -> WorkerConfig:
    return WorkerConfig(
        model_path=(args.model or Path(os.getenv("WORKER_MODEL_PATH", DEFAULT_MODEL_PATH))).expanduser().resolve(),
        backend_base_url=args.backend_base_url
        or os.getenv("WORKER_BACKEND_BASE_URL", DEFAULT_BACKEND_BASE_URL),
        local_frame_root=(
            args.local_frame_root
            or Path(os.getenv("WORKER_LOCAL_FRAME_ROOT", DEFAULT_LOCAL_FRAME_ROOT))
        )
        .expanduser()
        .resolve(),
        poll_interval_seconds=args.poll_interval
        if args.poll_interval is not None
        else float(os.getenv("WORKER_POLL_INTERVAL_SECONDS", DEFAULT_POLL_INTERVAL_SECONDS)),
        post_timeout_seconds=float(os.getenv("WORKER_POST_TIMEOUT_SECONDS", DEFAULT_POST_TIMEOUT_SECONDS)),
        health_host=args.health_host or os.getenv("WORKER_HEALTH_HOST", DEFAULT_HEALTH_HOST),
        health_port=args.health_port
        if args.health_port is not None
        else int(os.getenv("WORKER_HEALTH_PORT", DEFAULT_HEALTH_PORT)),
        service_bus_connection_string=first_non_empty_env(
            "AZURE_SERVICE_BUS_CONNECTION_STRING",
            "Azure__ServiceBus__ConnectionString",
        ),
        service_bus_queue_name=first_non_empty_env(
            "AZURE_SERVICE_BUS_FRAME_QUEUE_NAME",
            "Azure__ServiceBus__FrameQueueName",
        ),
        blob_connection_string=first_non_empty_env(
            "AZURE_BLOB_STORAGE_CONNECTION_STRING",
            "Azure__BlobStorage__ConnectionString",
        ),
        blob_container_name=os.getenv("AZURE_BLOB_STORAGE_CONTAINER_NAME")
        or os.getenv("Azure__BlobStorage__ContainerName")
        or "frames",
    )


def validate_config(config: WorkerConfig) -> None:
    if not config.model_path.exists():
        message = (
            f"MediaPipe model file not found: {config.model_path}\n"
            "Download face_landmarker.task and place it under src/worker/models/, "
            "or pass --model /path/to/face_landmarker.task."
        )
        raise SystemExit(message)
    if config.poll_interval_seconds <= 0:
        raise SystemExit("poll interval must be positive")
    if config.post_timeout_seconds <= 0:
        raise SystemExit("post timeout must be positive")
    if config.health_port <= 0:
        raise SystemExit("health port must be positive")


def parse_frame_reference(value: str) -> FrameReference:
    payload = json.loads(value)
    frame_type = cast(FrameType, _required_str(payload, "frameType"))
    if frame_type not in {"I", "P"}:
        raise ValueError("frameType must be I or P")

    return FrameReference(
        session_id=_required_str(payload, "sessionId"),
        sequence_no=int(payload["sequenceNo"]),
        frame_type=frame_type,
        base_i_frame_sequence_no=int(payload["baseIFrameSequenceNo"]),
        blob_path=_required_str(payload, "blobPath"),
        captured_at=parse_datetime(_required_str(payload, "capturedAt")),
        received_at=parse_datetime(_required_str(payload, "receivedAt")),
        codec=_required_str(payload, "codec"),
    )


def infer_base_i_frame_sequence_no(sequence_no: int, frame_type: FrameType) -> int:
    if frame_type == "I":
        return sequence_no
    return sequence_no - ((sequence_no - 1) % 5)


def parse_datetime(value: str) -> datetime:
    normalized = value.replace("Z", "+00:00")
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _required_str(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} is required")
    return value


def _service_bus_message_to_text(message: Any) -> str:
    body = message.body
    if isinstance(body, bytes):
        return body.decode("utf-8")
    if isinstance(body, str):
        return body

    chunks: list[bytes] = []
    for chunk in body:
        if isinstance(chunk, bytes):
            chunks.append(chunk)
        else:
            chunks.append(bytes(chunk))
    return b"".join(chunks).decode("utf-8")


def _parse_sequence_no(filename: str) -> int | None:
    match = LOCAL_FRAME_RE.match(filename)
    if not match:
        return None
    return int(match.group("sequence_no"))


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def first_non_empty_env(*names: str) -> str | None:
    for name in names:
        value = os.getenv(name)
        if value and value.strip():
            return value.strip()
    return None


def configure_logging() -> None:
    logging.basicConfig(
        level=os.getenv("WORKER_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )


def install_signal_handlers() -> None:
    def handle_signal(signum: int, frame: object) -> None:
        _ = frame
        logger.info("Received signal %s; stopping worker", signum)
        stop_event.set()

    _ = signal.signal(signal.SIGINT, handle_signal)
    _ = signal.signal(signal.SIGTERM, handle_signal)


def start_health_server(host: str, port: int) -> ThreadingHTTPServer | None:
    if port == 0:
        return None

    class HealthHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path != "/health":
                self.send_response(404)
                self.end_headers()
                return

            body = b'{"status":"ok"}\n'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            _ = self.wfile.write(body)

        @override
        def log_message(self, format: str, *args: object) -> None:
            logger.debug("health: " + format, *args)

    server = ThreadingHTTPServer((host, port), HealthHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    logger.info("Health endpoint listening on http://%s:%s/health", host, port)
    return server


if __name__ == "__main__":
    raise SystemExit(main())
