# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnnecessaryCast=false
from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Protocol, cast, override
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from app.analyzer.frame_decoder import FrameDecoder, FrameReference, FrameType
from shared.tracking.calibration import CalibrationTracker
from shared.tracking.drowsiness import DrowsinessScorer
from shared.tracking.face_analyzer import FaceAnalyzer
from shared.tracking.models import CalibrationProgress, DrowsinessResult, FaceMetrics

WORKER_ROOT = Path(__file__).resolve().parents[1]
WORKSPACE_ROOT = WORKER_ROOT.parents[1]
DEFAULT_MODEL_PATH = WORKER_ROOT / "models" / "face_landmarker.task"
DEFAULT_BACKEND_BASE_URL = "http://localhost:5194"
DEFAULT_HEALTH_HOST = "0.0.0.0"
DEFAULT_HEALTH_PORT = 8000
DEFAULT_POLL_INTERVAL_SECONDS = 0.2
DEFAULT_POST_TIMEOUT_SECONDS = 3.0

logger = logging.getLogger("worker")
stop_event = threading.Event()


@dataclass(frozen=True)
class WorkerConfig:
    model_path: Path
    backend_base_url: str
    backend_health_url: str | None
    poll_interval_seconds: float
    post_timeout_seconds: float
    startup_check_timeout_seconds: float
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


@dataclass(frozen=True)
class DependencyCheckResult:
    name: str
    reachable: bool
    detail: str


class FrameSource(Protocol):
    def receive(self) -> list[FrameEnvelope]: ...

    def complete(self, envelope: FrameEnvelope) -> None: ...

    def abandon(self, envelope: FrameEnvelope, error: Exception) -> None: ...

    def close(self) -> None: ...


@dataclass(frozen=True)
class AzureFrameEnvelope(FrameEnvelope):
    message: Any


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
            try:
                blob_client = self._container_client.get_blob_client(reference.blob_path)
                payload = cast(bytes, blob_client.download_blob().readall())
            except Exception:
                logger.exception(
                    "Failed to download frame blob: session=%s sequence=%s blob_path=%s",
                    reference.session_id,
                    reference.sequence_no,
                    reference.blob_path,
                )
                self._receiver.dead_letter_message(
                    message,
                    reason="BlobNotFound",
                    error_description=f"Blob not found: {reference.blob_path}",
                )
                continue
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
    check_startup_dependencies(config)
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

    was_calibrating = state.calibration.status == "calibrating"
    progress = state.calibration.add_frame(metrics)
    if was_calibrating:
        publish_calibration_status(publisher, reference.session_id, progress)

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


def publish_calibration_status(
    publisher: AnalysisResultPublisher,
    session_id: str,
    progress: CalibrationProgress,
) -> None:
    result = progress.result
    publisher.publish(
        session_id,
        {
            "type": "calibration_status",
            "sessionId": session_id,
            "updatedAt": utc_now_iso(),
            "status": progress.status,
            "validFrames": progress.valid_frames,
            "totalFrames": progress.total_frames,
            "targetFrames": progress.target_frames,
            "earOpen": result.ear_open if result is not None else None,
            "earThreshold": result.ear_threshold if result is not None else None,
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
    if not is_azure_frame_source_enabled(config):
        raise SystemExit("Azure Service Bus / Blob Storage settings are required; local fallback is disabled")

    logger.info("Using Azure Service Bus / Blob Storage frame source")
    return AzureServiceBusFrameSource(
        service_bus_connection_string=cast(str, config.service_bus_connection_string),
        queue_name=cast(str, config.service_bus_queue_name),
        blob_connection_string=cast(str, config.blob_connection_string),
        blob_container_name=config.blob_container_name,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="AwakeVerify Worker frame processor")
    _ = parser.add_argument("--model", type=Path, default=None)
    _ = parser.add_argument("--backend-base-url", default=None)
    _ = parser.add_argument("--poll-interval", type=float, default=None)
    _ = parser.add_argument("--health-host", default=None)
    _ = parser.add_argument("--health-port", type=int, default=None)
    return parser.parse_args()


def load_config(args: argparse.Namespace) -> WorkerConfig:
    return WorkerConfig(
        model_path=(args.model or Path(os.getenv("WORKER_MODEL_PATH", DEFAULT_MODEL_PATH))).expanduser().resolve(),
        backend_base_url=args.backend_base_url
        or os.getenv("WORKER_BACKEND_BASE_URL")
        or DEFAULT_BACKEND_BASE_URL,
        backend_health_url=first_non_empty_env("WORKER_BACKEND_HEALTH_URL"),
        poll_interval_seconds=args.poll_interval
        if args.poll_interval is not None
        else float(os.getenv("WORKER_POLL_INTERVAL_SECONDS", DEFAULT_POLL_INTERVAL_SECONDS)),
        post_timeout_seconds=float(os.getenv("WORKER_POST_TIMEOUT_SECONDS", DEFAULT_POST_TIMEOUT_SECONDS)),
        startup_check_timeout_seconds=float(
            os.getenv("WORKER_STARTUP_CHECK_TIMEOUT_SECONDS", DEFAULT_POST_TIMEOUT_SECONDS)
        ),
        health_host=args.health_host or os.getenv("WORKER_HEALTH_HOST", DEFAULT_HEALTH_HOST),
        health_port=args.health_port
        if args.health_port is not None
        else int(os.getenv("WORKER_HEALTH_PORT", DEFAULT_HEALTH_PORT)),
        service_bus_connection_string=first_non_empty_env(
            "AZURE_SERVICE_BUS_CONNECTION_STRING",
            "Azure__ServiceBus__ConnectionString",
            "SERVICEBUS_CONNECTION_STRING",
        ),
        service_bus_queue_name=first_non_empty_env(
            "AZURE_SERVICE_BUS_FRAME_QUEUE_NAME",
            "Azure__ServiceBus__FrameQueueName",
            "SERVICEBUS_QUEUE_NAME",
        ),
        blob_connection_string=first_non_empty_env(
            "AZURE_BLOB_STORAGE_CONNECTION_STRING",
            "Azure__BlobStorage__ConnectionString",
            "BLOB_CONNECTION_STRING",
        ),
        blob_container_name=first_non_empty_env(
            "AZURE_BLOB_STORAGE_CONTAINER_NAME",
            "Azure__BlobStorage__ContainerName",
            "BLOB_CONTAINER_NAME",
        )
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
    if config.startup_check_timeout_seconds <= 0:
        raise SystemExit("startup check timeout must be positive")
    if config.health_port <= 0:
        raise SystemExit("health port must be positive")

    missing_azure_settings = []
    if not config.service_bus_connection_string:
        missing_azure_settings.append(
            "AZURE_SERVICE_BUS_CONNECTION_STRING / Azure__ServiceBus__ConnectionString / SERVICEBUS_CONNECTION_STRING"
        )
    if not config.service_bus_queue_name:
        missing_azure_settings.append(
            "AZURE_SERVICE_BUS_FRAME_QUEUE_NAME / Azure__ServiceBus__FrameQueueName / SERVICEBUS_QUEUE_NAME"
        )
    if not config.blob_connection_string:
        missing_azure_settings.append(
            "AZURE_BLOB_STORAGE_CONNECTION_STRING / Azure__BlobStorage__ConnectionString / BLOB_CONNECTION_STRING"
        )
    if missing_azure_settings:
        raise SystemExit(
            "Azure Service Bus / Blob Storage settings are required; local fallback is disabled:\n"
            + "\n".join(f"- {name}" for name in missing_azure_settings)
        )


def check_startup_dependencies(config: WorkerConfig) -> None:
    checks = [
        check_backend_dependency(
            base_url=config.backend_base_url,
            health_url=config.backend_health_url,
            timeout_seconds=config.startup_check_timeout_seconds,
        ),
        check_service_bus_dependency(
            service_bus_connection_string=cast(str, config.service_bus_connection_string),
            queue_name=cast(str, config.service_bus_queue_name),
            timeout_seconds=config.startup_check_timeout_seconds,
        ),
        check_blob_storage_dependency(
            blob_connection_string=cast(str, config.blob_connection_string),
            timeout_seconds=config.startup_check_timeout_seconds,
        ),
    ]

    failures: list[DependencyCheckResult] = []
    for check in checks:
        if check.reachable:
            logger.info("Startup dependency OK: %s (%s)", check.name, check.detail)
        else:
            failures.append(check)

    if failures:
        raise SystemExit(
            "Unable to connect to required dependency services; worker will exit.\n"
            + "\n".join(f"- {failure.name}: {failure.detail}" for failure in failures)
        )


def check_backend_dependency(
    *, base_url: str, health_url: str | None, timeout_seconds: float
) -> DependencyCheckResult:
    probe_url = health_url or base_url
    request = Request(probe_url, method="GET")
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            if response.status >= 500:
                return DependencyCheckResult("Backend", False, f"HTTP {response.status} from {probe_url}")
            return DependencyCheckResult("Backend", True, f"HTTP {response.status} from {probe_url}")
    except HTTPError as error:
        if health_url is None and error.code < 500:
            return DependencyCheckResult("Backend", True, f"HTTP {error.code} from {probe_url}")
        return DependencyCheckResult("Backend", False, f"HTTP {error.code} from {probe_url}")
    except URLError as error:
        return DependencyCheckResult("Backend", False, f"cannot reach {probe_url}: {error.reason}")
    except TimeoutError as error:
        return DependencyCheckResult("Backend", False, f"timed out reaching {probe_url}: {error}")


def is_azure_frame_source_enabled(config: WorkerConfig) -> bool:
    return bool(
        config.service_bus_connection_string
        and config.service_bus_queue_name
        and config.blob_connection_string
    )


def check_service_bus_dependency(
    *, service_bus_connection_string: str, queue_name: str, timeout_seconds: float
) -> DependencyCheckResult:
    try:
        azure_servicebus = cast(Any, __import__("azure.servicebus", fromlist=["ServiceBusClient"]))
        with azure_servicebus.ServiceBusClient.from_connection_string(
            service_bus_connection_string,
            socket_timeout=int(max(1.0, timeout_seconds)),
            retry_total=0,
        ) as service_bus_client:
            with service_bus_client.get_queue_receiver(queue_name=queue_name) as receiver:
                _ = receiver.peek_messages(max_message_count=1)
        return DependencyCheckResult("Service Bus", True, f"queue={queue_name}")
    except Exception as error:
        return DependencyCheckResult(
            "Service Bus",
            False,
            f"cannot reach queue {queue_name}: {short_error_message(error)}",
        )


def check_blob_storage_dependency(
    *, blob_connection_string: str, timeout_seconds: float
) -> DependencyCheckResult:
    try:
        azure_blob = cast(Any, __import__("azure.storage.blob", fromlist=["BlobServiceClient"]))
        request_timeout = int(max(1.0, timeout_seconds))
        blob_service_client = azure_blob.BlobServiceClient.from_connection_string(
            blob_connection_string,
            connection_timeout=request_timeout,
            read_timeout=request_timeout,
            retry_total=0,
        )
        account_info = blob_service_client.get_account_information()
        account_kind = account_info.get("account_kind") or account_info.get("sku_name") or "reachable"
        return DependencyCheckResult("Blob Storage", True, f"account={account_kind}")
    except Exception as error:
        return DependencyCheckResult(
            "Blob Storage",
            False,
            f"cannot reach storage account: {short_error_message(error)}",
        )


def short_error_message(error: Exception) -> str:
    message = str(error).strip().replace("\n", " ")
    if message:
        return message
    return error.__class__.__name__


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
    logging.getLogger("azure").setLevel(logging.WARNING)


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
        def do_OPTIONS(self) -> None:
            self.send_response(204)
            self.send_cors_headers()
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def do_GET(self) -> None:
            if self.path != "/health":
                self.send_response(404)
                self.send_cors_headers()
                self.end_headers()
                return

            body = b'{"status":"ok"}\n'
            self.send_response(200)
            self.send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            _ = self.wfile.write(body)

        def send_cors_headers(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Vary", "Origin")

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
