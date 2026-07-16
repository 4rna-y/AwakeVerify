# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnnecessaryCast=false
from __future__ import annotations

import argparse
import json
import logging
import math
import os
import re
import signal
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Protocol, cast, override
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

from app.analyzer.frame_decoder import FrameDecodeError, FrameDecoder, FrameReference, UnsupportedCodecError
from app.auth import WorkerAuthProvider, WorkerAuthenticationError, create_worker_auth_provider
from app.perclos import (
    MINIMUM_TTL_SECONDS,
    PendingScoreAggregation,
    RedisPerclosWindow,
    RedisProcessedFrameStore,
    RedisScoreAggregationWindow,
)
from shared.tracking.calibration import CalibrationTracker
from shared.tracking.drowsiness import classify_level, result_for_perclos, should_pause
from shared.tracking.face_analyzer import FaceAnalyzer
from shared.tracking.models import CalibrationProgress, CalibrationResult, FaceMetrics

WORKER_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL_PATH = WORKER_ROOT / "models" / "face_landmarker.task"
DEFAULT_BACKEND_BASE_URL = "http://localhost:5194"
DEFAULT_HEALTH_HOST = "0.0.0.0"
DEFAULT_HEALTH_PORT = 8000
DEFAULT_POLL_INTERVAL_SECONDS = 0.2
DEFAULT_POST_TIMEOUT_SECONDS = 3.0
DEFAULT_SERVICE_BUS_RECEIVE_WAIT_SECONDS = 5.0
DEFAULT_SERVICE_BUS_SESSION_LOCK_RENEWAL_SECONDS = 300
DEFAULT_MAX_DELIVERY_COUNT = 10
DEFAULT_SESSION_CONCURRENCY = 1
DEFAULT_SHUTDOWN_TIMEOUT_SECONDS = 30.0
DEFAULT_STAGE_METRICS_INTERVAL_SECONDS = 10.0
SCORE_AGGREGATION_FRAMES = 5
_FRAME_BLOB_PATH = re.compile(r"^sessions/([^/]+)/frames/(\d+)\.bin$")

logger = logging.getLogger("worker")
stop_event = threading.Event()


class RetryableProcessingError(RuntimeError):
    """The message can be safely retried by abandoning it."""


class SessionLockLostSettlementError(RuntimeError):
    """The Service Bus session lock expired, so this message cannot be settled."""


class DeadLetterProcessingError(RuntimeError):
    """The message is invalid or permanently rejected and must be dead-lettered."""


class BlobDownloadError(RetryableProcessingError):
    def __init__(self, error: Exception, *, permanent: bool) -> None:
        super().__init__("unable to download frame blob")
        self.error: Exception = error
        self.permanent: bool = permanent


class InvalidBlobProcessingError(DeadLetterProcessingError):
    pass


class UnsupportedCodecProcessingError(DeadLetterProcessingError):
    pass


class InvalidFramePayloadError(DeadLetterProcessingError):
    pass


class ResultPublishError(RuntimeError):
    pass


class RetryableResultPublishError(RetryableProcessingError, ResultPublishError):
    pass


class RejectedResultPublishError(DeadLetterProcessingError, ResultPublishError):
    pass


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
    redis_connection_string: str | None = None
    redis_cluster_mode: bool = False
    worker_api_key: str | None = None
    worker_auth_mode: str = "api_key"
    worker_backend_token_scope: str | None = None
    worker_backend_client_id: str | None = None
    perclos_ttl_seconds: int = MINIMUM_TTL_SECONDS
    max_delivery_count: int = DEFAULT_MAX_DELIVERY_COUNT
    session_concurrency: int = DEFAULT_SESSION_CONCURRENCY
    shutdown_timeout_seconds: float = DEFAULT_SHUTDOWN_TIMEOUT_SECONDS


@dataclass
class WorkerSlot:
    """Resources owned by one serial Service Bus Session processing slot."""

    source: FrameSource
    analyzer: FrameAnalyzer
    decoder: FrameDecoder
    publisher: ResultPublisher
    perclos_window: RedisPerclosWindow
    processed_frames: RedisProcessedFrameStore | None
    calibration_loader: CalibrationLoader | None
    poll_interval_seconds: float
    max_delivery_count: int
    stage_metrics: WorkerStageMetrics | None = None
    states: dict[str, SessionAnalysisState] = field(default_factory=dict)
    score_aggregation: RedisScoreAggregationWindow | None = None


@dataclass(frozen=True)
class FrameEnvelope:
    reference: FrameReference
    payload: bytes | None
    payload_error: Exception | None = None
    delivery_count: int = 1
    blob_download_duration_ms: float | None = None


@dataclass(frozen=True)
class ScoreSample:
    session_id: str
    sequence_no: int
    captured_at: datetime
    video_time_sec: float
    perclos: float
    score: float
    ear: float
    pitch_deg: float
    yaw_deg: float


@dataclass(frozen=True)
class PendingAnalysisResult:
    payload: dict[str, object]
    score_window_unix_second: int | None = None


@dataclass
class SessionAnalysisState:
    calibration: CalibrationTracker = field(default_factory=CalibrationTracker)
    calibration_loaded: bool = False
    pending_results: dict[int, list[PendingAnalysisResult]] = field(default_factory=dict)
    completed_sequences: set[int] = field(default_factory=set)
    completed_order: deque[int] = field(default_factory=lambda: deque(maxlen=150))

    def mark_completed(self, sequence_no: int) -> None:
        if sequence_no in self.completed_sequences:
            return
        if len(self.completed_order) == self.completed_order.maxlen:
            oldest = self.completed_order.popleft()
            self.completed_sequences.discard(oldest)
        self.completed_order.append(sequence_no)
        self.completed_sequences.add(sequence_no)


@dataclass(frozen=True)
class DependencyCheckResult:
    name: str
    reachable: bool
    detail: str


class WorkerStageMetrics:
    """Emit fixed-name, payload-free p95 stage timings at a bounded interval."""

    def __init__(self, interval_seconds: float = DEFAULT_STAGE_METRICS_INTERVAL_SECONDS) -> None:
        self._interval_seconds = interval_seconds
        self._lock = threading.Lock()
        self._started_at = time.monotonic()
        self._samples: dict[str, list[float]] = {
            "queue_wait": [],
            "blob_download": [],
            "decode": [],
            "inference": [],
            "result_publish": [],
        }

    def record(self, **durations_ms: float | None) -> None:
        now = time.monotonic()
        with self._lock:
            for stage, duration_ms in durations_ms.items():
                if stage in self._samples and duration_ms is not None and math.isfinite(duration_ms) and duration_ms >= 0:
                    self._samples[stage].append(duration_ms)
            if now - self._started_at < self._interval_seconds:
                return
            samples = self._samples
            self._samples = {stage: [] for stage in samples}
            self._started_at = now

        frame_count = len(samples["queue_wait"])
        if frame_count == 0:
            return
        summary = " ".join(
            f"{stage}_p95_ms={_percentile(samples[stage], 0.95):.1f}"
            for stage in ("queue_wait", "blob_download", "decode", "inference", "result_publish")
            if samples[stage]
        )
        logger.info("Worker stage latency snapshot: frames=%s %s", frame_count, summary)


def _percentile(samples: list[float], quantile: float) -> float:
    ordered = sorted(samples)
    index = max(0, min(len(ordered) - 1, math.ceil(len(ordered) * quantile) - 1))
    return ordered[index]


class FrameAnalyzer(Protocol):
    def analyze(self, bgr_image: Any) -> FaceMetrics | None: ...


class ResultPublisher(Protocol):
    def publish(self, session_id: str, payload: dict[str, object]) -> None: ...


class CalibrationLoader(Protocol):
    def load_calibration(self, session_id: str) -> dict[str, object] | None: ...


class FrameSource(Protocol):
    def receive(self) -> list[FrameEnvelope]: ...

    def complete(self, envelope: FrameEnvelope) -> None: ...

    def abandon(self, envelope: FrameEnvelope, error: Exception) -> None: ...

    def dead_letter(self, envelope: FrameEnvelope, reason: str, error: Exception) -> None: ...

    def close(self) -> None: ...


@dataclass(frozen=True)
class AzureFrameEnvelope(FrameEnvelope):
    message: Any = None


class AzureServiceBusFrameSource:
    """Session-aware Service Bus source backed by the configured Blob container."""

    def __init__(
        self,
        *,
        service_bus_connection_string: str,
        queue_name: str,
        blob_connection_string: str,
        blob_container_name: str,
    ) -> None:
        self._azure_servicebus: Any = cast(Any, __import__("azure.servicebus", fromlist=["ServiceBusClient"]))
        azure_blob = cast(Any, __import__("azure.storage.blob", fromlist=["BlobServiceClient"]))
        self._service_bus_client: Any = self._azure_servicebus.ServiceBusClient.from_connection_string(
            service_bus_connection_string
        )
        self._queue_name: str = queue_name
        self._receiver: Any | None = None
        self._session_lock_lost: threading.Event = threading.Event()
        self._lock_renewer: Any = self._azure_servicebus.AutoLockRenewer(
            max_lock_renewal_duration=DEFAULT_SERVICE_BUS_SESSION_LOCK_RENEWAL_SECONDS,
            on_lock_renew_failure=self._on_lock_renew_failure,
        )
        self._blob_service_client: Any = azure_blob.BlobServiceClient.from_connection_string(
            blob_connection_string
        )
        self._container_client: Any = self._blob_service_client.get_container_client(blob_container_name)

    def receive(self) -> list[FrameEnvelope]:
        if self._session_lock_lost.is_set():
            self._close_receiver()
            self._session_lock_lost.clear()
            return []
        try:
            receiver = self._get_receiver()
            messages = receiver.receive_messages(
                max_message_count=10,
                max_wait_time=DEFAULT_SERVICE_BUS_RECEIVE_WAIT_SECONDS,
            )
        except Exception as error:
            # The SDK reports an elapsed NEXT_AVAILABLE_SESSION acquisition timeout as an
            # OperationTimeoutError. No active session is an expected idle-queue state.
            if _is_no_available_session_timeout(error):
                logger.debug("No active Service Bus session is available; retrying on the next poll")
            else:
                logger.warning("Unable to receive Service Bus session messages: %s", short_error_message(error))
            self._close_receiver()
            return []

        if self._session_lock_lost.is_set():
            # AutoLockRenewer reports asynchronously. Do not hand a batch to the
            # processor after the Session lock has become invalid.
            self._close_receiver()
            self._session_lock_lost.clear()
            return []

        if not messages:
            # Releasing an idle session lets another worker own it and lets this worker accept
            # a different active session on the next polling cycle.
            self._close_receiver()
            return []

        envelopes: list[FrameEnvelope] = []
        for message in messages:
            try:
                reference = parse_frame_reference(_service_bus_message_to_text(message))
            except Exception as error:
                self._dead_letter_message(message, "InvalidFrameReference", error)
                continue

            try:
                blob_download_started_at = time.monotonic()
                blob_client = self._container_client.get_blob_client(reference.blob_path)
                payload = cast(bytes, blob_client.download_blob().readall())
                payload_error: Exception | None = None
            except Exception as error:
                payload = None
                payload_error = BlobDownloadError(error, permanent=_is_blob_not_found(error))

            envelopes.append(
                AzureFrameEnvelope(
                    reference=reference,
                    payload=payload,
                    payload_error=payload_error,
                    delivery_count=int(getattr(message, "delivery_count", 1) or 1),
                    blob_download_duration_ms=(time.monotonic() - blob_download_started_at) * 1000,
                    message=message,
                )
            )
        return envelopes

    def complete(self, envelope: FrameEnvelope) -> None:
        if not isinstance(envelope, AzureFrameEnvelope):
            return
        self._raise_if_session_lock_lost(RuntimeError("session lock was lost before completion"))
        try:
            self._require_receiver().complete_message(envelope.message)
        except Exception as error:
            self._raise_if_session_lock_lost(error)
            raise

    def abandon(self, envelope: FrameEnvelope, error: Exception) -> None:
        logger.warning(
            "Abandoning frame for retry: session=%s sequence=%s error=%s",
            envelope.reference.session_id,
            envelope.reference.sequence_no,
            short_error_message(error),
        )
        if not isinstance(envelope, AzureFrameEnvelope):
            return
        self._raise_if_session_lock_lost(RuntimeError("session lock was lost before abandon"))
        try:
            self._require_receiver().abandon_message(envelope.message)
        except Exception as settlement_error:
            self._raise_if_session_lock_lost(settlement_error)
            raise

    def dead_letter(self, envelope: FrameEnvelope, reason: str, error: Exception) -> None:
        if not isinstance(envelope, AzureFrameEnvelope):
            return
        self._raise_if_session_lock_lost(RuntimeError("session lock was lost before dead-letter"))
        try:
            self._dead_letter_message(envelope.message, reason, error)
        except Exception as settlement_error:
            self._raise_if_session_lock_lost(settlement_error)
            raise

    def close(self) -> None:
        self._close_receiver()
        self._lock_renewer.close()
        self._service_bus_client.close()
        self._blob_service_client.close()

    def has_session_lock_lost(self) -> bool:
        return self._session_lock_lost.is_set()

    def release_lost_session(self) -> None:
        self._close_receiver()
        self._session_lock_lost.clear()

    def _get_receiver(self) -> Any:
        if self._receiver is None:
            self._session_lock_lost.clear()
            next_session = getattr(self._azure_servicebus, "NEXT_AVAILABLE_SESSION", "$all")
            self._receiver = self._service_bus_client.get_queue_receiver(
                queue_name=self._queue_name,
                session_id=next_session,
                # For NEXT_AVAILABLE_SESSION, this controls session acquisition rather
                # than receive_messages(). Without it, the SDK waits indefinitely and
                # the broker closes the connection after its idle-link timeout.
                max_wait_time=DEFAULT_SERVICE_BUS_RECEIVE_WAIT_SECONDS,
                auto_lock_renewer=self._lock_renewer,
            )
        return self._receiver

    def _require_receiver(self) -> Any:
        if self._receiver is None:
            raise RuntimeError("Service Bus session receiver is not active")
        return self._receiver

    def _close_receiver(self) -> None:
        if self._receiver is not None:
            self._receiver.close()
            self._receiver = None

    def _raise_if_session_lock_lost(self, error: Exception) -> None:
        if not self._session_lock_lost.is_set() and not _is_session_lock_lost(error):
            return
        self._close_receiver()
        raise SessionLockLostSettlementError("Service Bus session lock expired") from error

    def _on_lock_renew_failure(self, renewable: Any, error: Exception | None) -> None:
        _ = renewable
        self._session_lock_lost.set()
        logger.warning("Service Bus session lock renewal failed; receiver will be released: %s", short_error_message(error or RuntimeError("unknown lock renewal failure")))

    def _dead_letter_message(self, message: Any, reason: str, error: Exception) -> None:
        logger.warning("Dead-lettering Service Bus message: reason=%s error=%s", reason, short_error_message(error))
        receiver = self._require_receiver()
        receiver.dead_letter_message(
            message,
            reason=reason,
            error_description=short_error_message(error),
        )


class AnalysisResultPublisher:
    def __init__(
        self,
        backend_base_url: str,
        *,
        api_key: str | None = None,
        auth_provider: WorkerAuthProvider | None = None,
        timeout_seconds: float,
        opener: Callable[..., Any] = urlopen,
    ) -> None:
        self._backend_base_url: str = backend_base_url.rstrip("/")
        self._auth_provider: WorkerAuthProvider = auth_provider or create_worker_auth_provider(
            mode="api_key",
            api_key=api_key,
            token_scope=None,
        )
        self._timeout_seconds: float = timeout_seconds
        self._opener: Callable[..., Any] = opener

    def publish(self, session_id: str, payload: dict[str, object]) -> None:
        url = f"{self._backend_base_url}/api/sessions/{session_id}/analysis-results"
        try:
            auth_headers = self._auth_provider.authorization_headers()
        except WorkerAuthenticationError as error:
            raise RetryableResultPublishError("worker authentication token is temporarily unavailable") from error
        request = Request(
            url,
            data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                **auth_headers,
            },
            method="POST",
        )
        try:
            with self._opener(request, timeout=self._timeout_seconds) as response:
                status = int(response.status)
        except HTTPError as error:
            self._raise_for_status(error.code)
            raise AssertionError("unreachable")
        except TimeoutError as error:
            raise RetryableResultPublishError("analysis result API request timed out") from error
        except URLError as error:
            if isinstance(error.reason, TimeoutError):
                raise RetryableResultPublishError("analysis result API request timed out") from error
            raise RetryableResultPublishError("analysis result API connection failed") from error
        except OSError as error:
            raise RetryableResultPublishError("analysis result API connection failed") from error

        # The API's 202 is the persistence + Outbox acceptance boundary. Any other 2xx
        # response is intentionally not treated as success.
        if status != 202:
            self._raise_for_status(status)

    def load_calibration(self, session_id: str) -> dict[str, object] | None:
        url = f"{self._backend_base_url}/api/sessions/{session_id}/calibration"
        try:
            auth_headers = self._auth_provider.authorization_headers()
        except WorkerAuthenticationError as error:
            raise RetryableResultPublishError("worker authentication token is temporarily unavailable") from error
        request = Request(url, headers=auth_headers, method="GET")
        try:
            with self._opener(request, timeout=self._timeout_seconds) as response:
                status = int(response.status)
                if status == 204:
                    return None
                if status != 200:
                    self._raise_for_status(status)
                raw = response.read()
        except HTTPError as error:
            self._raise_for_status(error.code)
            raise AssertionError("unreachable")
        except TimeoutError as error:
            raise RetryableResultPublishError("calibration API request timed out") from error
        except URLError as error:
            if isinstance(error.reason, TimeoutError):
                raise RetryableResultPublishError("calibration API request timed out") from error
            raise RetryableResultPublishError("calibration API connection failed") from error
        except OSError as error:
            raise RetryableResultPublishError("calibration API connection failed") from error

        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RejectedResultPublishError("calibration API returned invalid JSON") from error
        if not isinstance(payload, dict):
            raise RejectedResultPublishError("calibration API returned an invalid object")
        return cast(dict[str, object], payload)

    @staticmethod
    def _raise_for_status(status: int) -> None:
        if status == 429 or status >= 500:
            raise RetryableResultPublishError(f"analysis result API returned HTTP {status}")
        raise RejectedResultPublishError(f"analysis result API returned HTTP {status}; expected 202")


def main() -> int:
    configure_logging()
    config = load_config(parse_args())
    validate_config(config)
    check_startup_dependencies(config)
    stop_event.clear()
    install_signal_handlers()
    ready_event = threading.Event()
    health_server = start_health_server(config.health_host, config.health_port, readiness_event=ready_event)

    logger.info("Starting worker")
    logger.info("Model path: %s", config.model_path)
    logger.info("Backend base URL: %s", config.backend_base_url)
    logger.info("Session processing slots: %s", config.session_concurrency)

    try:
        run_worker_slots(
            session_concurrency=config.session_concurrency,
            slot_factory=lambda slot_index: create_worker_slot(config, slot_index),
            shutdown_event=stop_event,
            shutdown_timeout_seconds=config.shutdown_timeout_seconds,
            on_ready=ready_event.set,
        )
    finally:
        ready_event.clear()
        if health_server is not None:
            health_server.shutdown()
            health_server.server_close()

    logger.info("Worker stopped")
    return 0


def create_worker_slot(config: WorkerConfig, slot_index: int) -> WorkerSlot:
    """Create isolated mutable resources for one Session slot.

    The Service Bus receiver, session state, and MediaPipe landmarker are deliberately
    not shared between slot threads. This preserves receiver-bound settlement and avoids
    relying on MediaPipe thread safety. The frame decoder is stateless.
    """
    logger.debug("Creating Session processing slot %s", slot_index)
    source = create_frame_source(config)
    analyzer = FaceAnalyzer.create(str(config.model_path))
    auth_provider = create_worker_auth_provider(
        mode=config.worker_auth_mode,
        api_key=config.worker_api_key,
        token_scope=config.worker_backend_token_scope,
        client_id=config.worker_backend_client_id,
    )
    publisher = AnalysisResultPublisher(
        config.backend_base_url,
        auth_provider=auth_provider,
        timeout_seconds=config.post_timeout_seconds,
    )
    return WorkerSlot(
        source=source,
        analyzer=analyzer,
        decoder=FrameDecoder(),
        publisher=publisher,
        perclos_window=create_perclos_window(config),
        processed_frames=create_processed_frame_store(config),
        score_aggregation=create_score_aggregation_window(config),
        calibration_loader=publisher,
        poll_interval_seconds=config.poll_interval_seconds,
        max_delivery_count=config.max_delivery_count,
        stage_metrics=WorkerStageMetrics(),
    )


def run_worker_slots(
    *,
    session_concurrency: int,
    slot_factory: Callable[[int], WorkerSlot],
    shutdown_event: threading.Event,
    shutdown_timeout_seconds: float,
    on_ready: Callable[[], None] | None = None,
) -> None:
    """Run independent Session slots until shutdown, with a bounded shutdown wait."""
    if session_concurrency <= 0:
        raise ValueError("session_concurrency must be positive")
    if shutdown_timeout_seconds <= 0:
        raise ValueError("shutdown_timeout_seconds must be positive")

    slots = [slot_factory(slot_index) for slot_index in range(session_concurrency)]
    threads = [
        threading.Thread(
            target=run_worker_slot,
            kwargs={
                "slot": slot,
                "shutdown_event": shutdown_event,
                "poll_interval_seconds": slot.poll_interval_seconds,
                "max_delivery_count": slot.max_delivery_count,
            },
            name=f"worker-session-slot-{slot_index}",
            daemon=True,
        )
        for slot_index, slot in enumerate(slots)
    ]
    for thread in threads:
        thread.start()
    if on_ready is not None:
        on_ready()

    try:
        while any(thread.is_alive() for thread in threads) and not shutdown_event.is_set():
            for thread in threads:
                thread.join(timeout=0.1)
    finally:
        shutdown_event.set()
        deadline = time.monotonic() + shutdown_timeout_seconds
        for thread in threads:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            thread.join(timeout=remaining)
        unfinished = [thread.name for thread in threads if thread.is_alive()]
        if unfinished:
            logger.warning("Worker shutdown deadline elapsed; closing unfinished Session slot receivers: %s", ", ".join(unfinished))
            for slot in slots:
                try:
                    slot.source.close()
                except Exception as error:
                    logger.warning("Unable to close Session slot source during forced shutdown: %s", short_error_message(error))


def run_worker_slot(
    *,
    slot: WorkerSlot,
    shutdown_event: threading.Event,
    poll_interval_seconds: float,
    max_delivery_count: int,
) -> None:
    try:
        run_worker_loop(
            source=slot.source,
            analyzer=slot.analyzer,
            decoder=slot.decoder,
            publisher=slot.publisher,
            perclos_window=slot.perclos_window,
            processed_frames=slot.processed_frames,
            score_aggregation=slot.score_aggregation,
            calibration_loader=slot.calibration_loader,
            stage_metrics=slot.stage_metrics,
            states=slot.states,
            poll_interval_seconds=poll_interval_seconds,
            max_delivery_count=max_delivery_count,
            shutdown_event=shutdown_event,
        )
    finally:
        try:
            _ = slot.source.close()
        finally:
            try:
                _close_slot_resource(slot.perclos_window)
                _close_slot_resource(slot.processed_frames)
                _close_slot_resource(slot.score_aggregation)
            finally:
                close = getattr(slot.analyzer, "close", None)
                if callable(close):
                    _ = close()


def _close_slot_resource(resource: object | None) -> None:
    close = getattr(resource, "close", None)
    if callable(close):
        _ = close()


def run_worker_loop(
    *,
    source: FrameSource,
    analyzer: FrameAnalyzer,
    decoder: FrameDecoder,
    publisher: ResultPublisher,
    perclos_window: RedisPerclosWindow,
    processed_frames: RedisProcessedFrameStore | None = None,
    score_aggregation: RedisScoreAggregationWindow | None = None,
    calibration_loader: CalibrationLoader | None = None,
    stage_metrics: WorkerStageMetrics | None = None,
    states: dict[str, SessionAnalysisState],
    poll_interval_seconds: float,
    max_delivery_count: int = DEFAULT_MAX_DELIVERY_COUNT,
    shutdown_event: threading.Event | None = None,
) -> None:
    active_stop_event = shutdown_event or stop_event
    while not active_stop_event.is_set():
        envelopes = source.receive()
        # A signal while NEXT_AVAILABLE_SESSION was being acquired must not start
        # work for the newly acquired Session.
        if active_stop_event.is_set():
            break
        if not envelopes:
            _ = active_stop_event.wait(poll_interval_seconds)
            continue

        for envelope in envelopes:
            # Already-running work may settle during shutdown, but pre-fetched work
            # that has not begun is released for Service Bus redelivery.
            if active_stop_event.is_set():
                break
            if _source_session_lock_lost(source):
                _release_lost_source_session(source)
                break
            try:
                state = states.setdefault(envelope.reference.session_id, SessionAnalysisState())
                if calibration_loader is not None and not state.calibration_loaded:
                    restore_calibration(state, calibration_loader.load_calibration(envelope.reference.session_id))
                process_frame(
                    envelope,
                    analyzer=analyzer,
                    decoder=decoder,
                    publisher=publisher,
                    perclos_window=perclos_window,
                    processed_frames=processed_frames,
                    score_aggregation=score_aggregation,
                    stage_metrics=stage_metrics,
                    states=states,
                )
                source.complete(envelope)
            except SessionLockLostSettlementError as error:
                _log_session_lock_lost(envelope, error)
                break
            except DeadLetterProcessingError as error:
                if not _settle_dead_letter(source, envelope, _dead_letter_reason(error), error):
                    break
            except BlobDownloadError as error:
                if error.permanent:
                    if not _settle_dead_letter(source, envelope, "BlobNotFound", error):
                        break
                elif not _settle_retry(source, envelope, error, max_delivery_count):
                    break
            except RetryableProcessingError as error:
                if not _settle_retry(source, envelope, error, max_delivery_count):
                    break
            except Exception as error:
                # Unclassified faults (e.g. model or network library failures) are retried;
                # they must never be acknowledged as an accepted analysis result.
                if not _settle_retry(source, envelope, error, max_delivery_count):
                    break


def _source_session_lock_lost(source: FrameSource) -> bool:
    check = getattr(source, "has_session_lock_lost", None)
    return bool(check()) if callable(check) else False


def _release_lost_source_session(source: FrameSource) -> None:
    release = getattr(source, "release_lost_session", None)
    if callable(release):
        _ = release()


def _settle_retry(source: FrameSource, envelope: FrameEnvelope, error: Exception, max_delivery_count: int) -> bool:
    try:
        if envelope.delivery_count >= max_delivery_count:
            source.dead_letter(envelope, "RetryLimitExceeded", error)
        else:
            source.abandon(envelope, error)
    except SessionLockLostSettlementError as settlement_error:
        _log_session_lock_lost(envelope, settlement_error)
        return False
    return True


def _settle_dead_letter(source: FrameSource, envelope: FrameEnvelope, reason: str, error: Exception) -> bool:
    try:
        source.dead_letter(envelope, reason, error)
    except SessionLockLostSettlementError as settlement_error:
        _log_session_lock_lost(envelope, settlement_error)
        return False
    return True


def _log_session_lock_lost(envelope: FrameEnvelope, error: Exception) -> None:
    logger.warning(
        "Service Bus session lock lost; releasing receiver for redelivery: session=%s sequence=%s error=%s",
        envelope.reference.session_id,
        envelope.reference.sequence_no,
        short_error_message(error),
    )


def _dead_letter_reason(error: DeadLetterProcessingError) -> str:
    if isinstance(error, RejectedResultPublishError):
        return "AnalysisResultRejected"
    if isinstance(error, InvalidBlobProcessingError):
        return "BlobNotFound"
    if isinstance(error, UnsupportedCodecProcessingError):
        return "UnsupportedCodec"
    if isinstance(error, InvalidFramePayloadError):
        return "InvalidFramePayload"
    return "InvalidFrameProcessing"


def process_frame(
    envelope: FrameEnvelope,
    *,
    analyzer: FrameAnalyzer,
    decoder: FrameDecoder,
    publisher: ResultPublisher,
    perclos_window: RedisPerclosWindow,
    states: dict[str, SessionAnalysisState],
    processed_frames: RedisProcessedFrameStore | None = None,
    score_aggregation: RedisScoreAggregationWindow | None = None,
    stage_metrics: WorkerStageMetrics | None = None,
) -> None:
    reference = envelope.reference
    state = states.setdefault(reference.session_id, SessionAnalysisState())

    if reference.sequence_no in state.completed_sequences:
        return
    if processed_frames is not None and processed_frames.is_processed(session_id=reference.session_id, sequence_no=reference.sequence_no):
        state.mark_completed(reference.sequence_no)
        return
    if reference.sequence_no in state.pending_results:
        _publish_pending_results(publisher, reference.session_id, state, reference.sequence_no, score_aggregation)
        if processed_frames is not None:
            _ = processed_frames.mark_processed(session_id=reference.session_id, sequence_no=reference.sequence_no)
        state.mark_completed(reference.sequence_no)
        return
    if envelope.payload_error is not None:
        if isinstance(envelope.payload_error, BlobDownloadError) and envelope.payload_error.permanent:
            raise InvalidBlobProcessingError("frame blob was not found") from envelope.payload_error
        raise RetryableProcessingError("frame blob download failed") from envelope.payload_error
    if envelope.payload is None:
        raise RetryableProcessingError("frame blob payload is unavailable")

    decode_started_at = time.monotonic()
    try:
        decoded = decoder.decode(reference, envelope.payload)
    except UnsupportedCodecError as error:
        raise UnsupportedCodecProcessingError(str(error)) from error
    except FrameDecodeError as error:
        raise InvalidFramePayloadError(str(error)) from error
    decode_duration_ms = (time.monotonic() - decode_started_at) * 1000



    if state.calibration.status in {"ready", "failed"}:
        _ = state.calibration.start()
        if score_aggregation is not None:
            score_aggregation.clear(session_id=reference.session_id)

    inference_started_at = time.monotonic()
    metrics = analyzer.analyze(decoded.image)
    inference_duration_ms = (time.monotonic() - inference_started_at) * 1000
    logger.info(
        "Analyzed image frame: session=%s sequence=%s face_detected=%s ear=%s pitch_deg=%s yaw_deg=%s",
        reference.session_id,
        reference.sequence_no,
        metrics is not None,
        metrics.ear if metrics is not None else None,
        metrics.pitch_deg if metrics is not None else None,
        metrics.yaw_deg if metrics is not None else None,
    )
    was_calibrating = state.calibration.status == "calibrating"
    progress = state.calibration.add_frame(metrics)
    results: list[PendingAnalysisResult] = []

    if metrics is None:
        results.append(PendingAnalysisResult(tracking_status_payload(reference)))

    if was_calibrating and progress.status in {"succeeded", "failed"}:
        results.append(PendingAnalysisResult(calibration_status_payload(reference, progress)))

    # The terminal calibration frame establishes the threshold but is not itself scored.
    # Subsequent frames update PERCLOS individually. A transition to the next UTC
    # second flushes the preceding second's aggregate, including when this frame has
    # no detected face.
    if progress.status == "succeeded" and not was_calibrating:
        calibration = state.calibration.result
        if calibration is None:
            raise RuntimeError("successful calibration has no result")
        pending_scores = update_drowsiness(
            reference=reference,
            metrics=metrics,
            calibration=calibration,
            perclos_window=perclos_window,
            score_aggregation=score_aggregation,
        )
        results.extend(
            PendingAnalysisResult(
                drowsiness_score_payload(pending_score),
                score_window_unix_second=pending_score.window_unix_second,
            )
            for pending_score in pending_scores
        )

    if results:
        state.pending_results[reference.sequence_no] = results
        publish_started_at = time.monotonic()
        _publish_pending_results(publisher, reference.session_id, state, reference.sequence_no, score_aggregation)
        publish_duration_ms: float | None = (time.monotonic() - publish_started_at) * 1000
    else:
        publish_duration_ms = None
    if processed_frames is not None:
        _ = processed_frames.mark_processed(session_id=reference.session_id, sequence_no=reference.sequence_no)
    state.mark_completed(reference.sequence_no)
    if stage_metrics is not None:
        queue_wait_ms = max(0.0, (datetime.now(UTC) - reference.received_at).total_seconds() * 1000)
        stage_metrics.record(
            queue_wait=queue_wait_ms,
            blob_download=envelope.blob_download_duration_ms,
            decode=decode_duration_ms,
            inference=inference_duration_ms,
            result_publish=publish_duration_ms,
        )


def restore_calibration(state: SessionAnalysisState, payload: dict[str, object] | None) -> None:
    """Restore Backend-owned calibration before the first frame is analyzed."""
    if payload is None:
        state.calibration_loaded = True
        return
    try:
        ear_open = float(cast(float | int | str, payload["earOpen"]))
        ear_threshold = float(cast(float | int | str, payload["earThreshold"]))
        valid_frames = int(cast(int | str | bytes, payload["validFrames"]))
        total_frames = int(cast(int | str | bytes, payload["totalFrames"]))
        source_sequence_no = int(cast(int | str | bytes, payload["sourceSequenceNo"]))
    except (KeyError, TypeError, ValueError) as error:
        raise RejectedResultPublishError("Backend returned an invalid calibration") from error
    if (
        ear_open <= 0
        or ear_threshold <= 0
        or valid_frames < 15
        or valid_frames > total_frames
        or total_frames != 25
        or source_sequence_no <= 0
        or not isinstance(payload.get("calibratedAt"), str)
        or abs(ear_threshold - ear_open * 0.75) > max(1e-6, abs(ear_open * 0.75) * 1e-5)
    ):
        raise RejectedResultPublishError("Backend returned an invalid calibration")
    _ = state.calibration.restore(
        CalibrationResult(
            ear_open=ear_open,
            ear_threshold=ear_threshold,
            valid_frames=valid_frames,
            total_frames=total_frames,
        )
    )
    state.calibration_loaded = True


def update_drowsiness(
    *,
    reference: FrameReference,
    metrics: FaceMetrics | None,
    calibration: CalibrationResult,
    perclos_window: RedisPerclosWindow,
    score_aggregation: RedisScoreAggregationWindow | None,
) -> tuple[PendingScoreAggregation, ...]:
    if score_aggregation is None:
        raise RuntimeError("score aggregation Redis state is required after successful calibration")

    sample_record: str | None = None
    if metrics is not None:
        is_closed = metrics.ear < calibration.ear_threshold
        update = perclos_window.append(
            session_id=reference.session_id,
            sequence_no=reference.sequence_no,
            captured_at=reference.captured_at,
            is_closed=is_closed,
        )
        if not update.duplicate:
            drowsiness = result_for_perclos(
                perclos=update.perclos,
                metrics=metrics,
                is_closed=is_closed,
                window_frames=len(update.frames),
            )
            sample_record = score_sample_record(
                ScoreSample(
                    session_id=reference.session_id,
                    sequence_no=reference.sequence_no,
                    captured_at=reference.captured_at,
                    video_time_sec=reference.video_time_sec,
                    perclos=drowsiness.perclos,
                    score=drowsiness.score,
                    ear=metrics.ear,
                    pitch_deg=metrics.pitch_deg,
                    yaw_deg=metrics.yaw_deg,
                )
            )

    return score_aggregation.advance(
        session_id=reference.session_id,
        captured_at=reference.captured_at,
        sample_record=sample_record,
    )


def _publish_pending_results(
    publisher: ResultPublisher,
    session_id: str,
    state: SessionAnalysisState,
    sequence_no: int,
    score_aggregation: RedisScoreAggregationWindow | None,
) -> None:
    results = state.pending_results[sequence_no]
    for result in results:
        publisher.publish(session_id, result.payload)
        if result.score_window_unix_second is not None:
            if score_aggregation is None:
                raise RuntimeError("score aggregation Redis state is required to acknowledge a score")
            _ = score_aggregation.acknowledge(
                session_id=session_id,
                window_unix_second=result.score_window_unix_second,
            )
    del state.pending_results[sequence_no]


def tracking_status_payload(reference: FrameReference) -> dict[str, object]:
    return {
        "type": "tracking_status",
        "sessionId": reference.session_id,
        "sourceSequenceNo": reference.sequence_no,
        "detectedAt": iso_timestamp(reference.captured_at),
        "status": "face_not_detected",
    }


def calibration_status_payload(reference: FrameReference, progress: CalibrationProgress) -> dict[str, object]:
    payload: dict[str, object] = {
        "type": "calibration_status",
        "sessionId": reference.session_id,
        "status": progress.status,
        "validFrames": progress.valid_frames,
        "totalFrames": progress.total_frames,
        "targetFrames": progress.target_frames,
    }
    if progress.status == "succeeded" and progress.result is not None:
        payload.update(
            {
                "earOpen": progress.result.ear_open,
                "earThreshold": progress.result.ear_threshold,
                "sourceSequenceNo": reference.sequence_no,
                "calibratedAt": iso_timestamp(reference.captured_at),
            }
        )
    return payload


def score_sample_record(sample: ScoreSample) -> str:
    return json.dumps(
        {
            "sessionId": sample.session_id,
            "sequenceNo": sample.sequence_no,
            "capturedAt": iso_timestamp(sample.captured_at),
            "videoTimeSec": sample.video_time_sec,
            "perclos": sample.perclos,
            "score": sample.score,
            "ear": sample.ear,
            "pitchDeg": sample.pitch_deg,
            "yawDeg": sample.yaw_deg,
        },
        separators=(",", ":"),
    )


def drowsiness_score_payload(pending: PendingScoreAggregation) -> dict[str, object]:
    samples = [score_sample_from_record(record) for record in pending.sample_records]
    if not 1 <= len(samples) <= SCORE_AGGREGATION_FRAMES:
        raise ValueError("drowsiness score payload requires one to five samples")

    source = samples[-1]
    count = len(samples)
    if any(sample.session_id != source.session_id for sample in samples):
        raise ValueError("drowsiness score samples must belong to one session")
    perclos = sum(sample.perclos for sample in samples) / count
    score = sum(sample.score for sample in samples) / count
    level = classify_level(score)
    return {
        "type": "drowsiness_score",
        "sessionId": source.session_id,
        "sourceSequenceNo": source.sequence_no,
        "scoredAt": scored_at_timestamp(source.captured_at),
        "score": score,
        "level": level,
        "perclos": perclos,
        "ear": sum(sample.ear for sample in samples) / count,
        "pitchDeg": sum(sample.pitch_deg for sample in samples) / count,
        "yawDeg": sum(sample.yaw_deg for sample in samples) / count,
        "videoTimeSec": source.video_time_sec,
        "shouldPause": should_pause(level, score),
    }


def score_sample_from_record(record: str) -> ScoreSample:
    try:
        payload = cast(object, json.loads(record))
        if not isinstance(payload, dict):
            raise ValueError("score sample is not an object")
        session_id = payload.get("sessionId")
        sequence_no = payload.get("sequenceNo")
        captured_at = payload.get("capturedAt")
        numeric_names = ("videoTimeSec", "perclos", "score", "ear", "pitchDeg", "yawDeg")
        numeric_values = [payload.get(name) for name in numeric_names]
        if (
            not isinstance(session_id, str)
            or not session_id
            or not isinstance(sequence_no, int)
            or sequence_no <= 0
            or not isinstance(captured_at, str)
            or any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)) for value in numeric_values)
        ):
            raise ValueError("score sample has invalid fields")
        parsed_captured_at = datetime.fromisoformat(captured_at.replace("Z", "+00:00"))
        video_time_sec, perclos, score, ear, pitch_deg, yaw_deg = (float(value) for value in numeric_values)
        if video_time_sec < 0 or not 0 <= perclos <= 1 or not 0 <= score <= 1:
            raise ValueError("score sample has out-of-range fields")
        return ScoreSample(
            session_id=session_id,
            sequence_no=sequence_no,
            captured_at=parsed_captured_at,
            video_time_sec=video_time_sec,
            perclos=perclos,
            score=score,
            ear=ear,
            pitch_deg=pitch_deg,
            yaw_deg=yaw_deg,
        )
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise ValueError("score aggregation Redis sample is invalid") from error


def create_perclos_window(config: WorkerConfig) -> RedisPerclosWindow:
    return RedisPerclosWindow(create_redis_client(config), ttl_seconds=config.perclos_ttl_seconds)


def create_processed_frame_store(config: WorkerConfig) -> RedisProcessedFrameStore:
    return RedisProcessedFrameStore(create_redis_client(config), ttl_seconds=config.perclos_ttl_seconds)


def create_score_aggregation_window(config: WorkerConfig) -> RedisScoreAggregationWindow:
    return RedisScoreAggregationWindow(
        create_redis_client(config),
        ttl_seconds=config.perclos_ttl_seconds,
        maximum_samples=SCORE_AGGREGATION_FRAMES,
    )


def create_redis_client(config: WorkerConfig) -> Any:
    redis_module = cast(Any, __import__("redis"))
    connection_url = normalize_redis_connection_string(cast(str, config.redis_connection_string))
    if config.redis_cluster_mode:
        # Azure Managed Redis OSS Cluster advertises node IPs during discovery while
        # presenting a certificate for the configured DNS endpoint. Keep TLS enabled
        # but avoid rejecting those discovered IPs solely on hostname mismatch.
        return redis_module.RedisCluster.from_url(connection_url, decode_responses=False, ssl_check_hostname=False)
    return redis_module.Redis.from_url(connection_url, decode_responses=False)


def _boolean_env(name: str, *, default: bool) -> bool:
    raw_value = os.getenv(name)
    if raw_value is None or raw_value == "":
        return default
    normalized = raw_value.strip().lower()
    if normalized == "true":
        return True
    if normalized == "false":
        return False
    raise ValueError(f"{name} must be true or false")


def normalize_redis_connection_string(value: str) -> str:
    """Accept Redis URLs and the devcontainer's legacy StackExchange.Redis format."""
    connection_string = value.strip()
    parsed_url = urlparse(connection_string)
    if parsed_url.scheme in {"redis", "rediss", "unix"} and connection_string.startswith(f"{parsed_url.scheme}://"):
        return connection_string

    segments = [segment.strip() for segment in connection_string.split(",") if segment.strip()]
    if not segments:
        raise ValueError("REDIS_CONNECTION_STRING must be a Redis URL or host:port,password=<password>")

    if "=" in segments[0]:
        raise ValueError("REDIS_CONNECTION_STRING must begin with a Redis host or URL")

    endpoint = urlparse(f"//{segments[0]}")
    try:
        host = endpoint.hostname
        port = endpoint.port
    except ValueError as error:
        raise ValueError("REDIS_CONNECTION_STRING has an invalid Redis host or port") from error
    if not host:
        raise ValueError("REDIS_CONNECTION_STRING must be a Redis URL or host:port,password=<password>")

    options: dict[str, str] = {}
    for segment in segments[1:]:
        key, separator, option_value = segment.partition("=")
        if separator:
            options[key.strip().lower()] = option_value.strip()

    scheme = "rediss" if options.get("ssl", "").lower() in {"true", "1", "yes"} else "redis"
    host_for_url = f"[{host}]" if ":" in host else host
    password = options.get("password")
    credentials = f":{quote(password, safe='')}@" if password else ""
    port_for_url = f":{port}" if port is not None else ""
    return f"{scheme}://{credentials}{host_for_url}{port_for_url}/0"


def create_frame_source(config: WorkerConfig) -> FrameSource:
    if not is_azure_frame_source_enabled(config):
        raise SystemExit("Azure Service Bus / Blob Storage settings are required; local fallback is disabled")
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
        backend_base_url=args.backend_base_url or os.getenv("WORKER_BACKEND_BASE_URL") or DEFAULT_BACKEND_BASE_URL,
        backend_health_url=first_non_empty_env("WORKER_BACKEND_HEALTH_URL"),
        poll_interval_seconds=args.poll_interval if args.poll_interval is not None else float(os.getenv("WORKER_POLL_INTERVAL_SECONDS", DEFAULT_POLL_INTERVAL_SECONDS)),
        post_timeout_seconds=float(os.getenv("WORKER_POST_TIMEOUT_SECONDS", DEFAULT_POST_TIMEOUT_SECONDS)),
        startup_check_timeout_seconds=float(os.getenv("WORKER_STARTUP_CHECK_TIMEOUT_SECONDS", DEFAULT_POST_TIMEOUT_SECONDS)),
        health_host=args.health_host or os.getenv("WORKER_HEALTH_HOST", DEFAULT_HEALTH_HOST),
        health_port=args.health_port if args.health_port is not None else int(os.getenv("WORKER_HEALTH_PORT", DEFAULT_HEALTH_PORT)),
        service_bus_connection_string=first_non_empty_env("AZURE_SERVICE_BUS_CONNECTION_STRING", "Azure__ServiceBus__ConnectionString", "SERVICEBUS_CONNECTION_STRING"),
        service_bus_queue_name=first_non_empty_env("AZURE_SERVICE_BUS_FRAME_QUEUE_NAME", "Azure__ServiceBus__FrameQueueName", "SERVICEBUS_QUEUE_NAME"),
        blob_connection_string=first_non_empty_env("AZURE_BLOB_STORAGE_CONNECTION_STRING", "Azure__BlobStorage__ConnectionString", "BLOB_CONNECTION_STRING"),
        blob_container_name=first_non_empty_env("AZURE_BLOB_STORAGE_CONTAINER_NAME", "Azure__BlobStorage__ContainerName", "BLOB_CONTAINER_NAME") or "frames",
        redis_connection_string=first_non_empty_env("REDIS_CONNECTION_STRING"),
        redis_cluster_mode=_boolean_env("REDIS_CLUSTER_MODE", default=False),
        worker_api_key=first_non_empty_env("WORKER_API_KEY"),
        worker_auth_mode=first_non_empty_env("WORKER_AUTH_MODE") or (
            "entra_id" if (os.getenv("WORKER_ENVIRONMENT") or os.getenv("ASPNETCORE_ENVIRONMENT", "")).lower() == "production" else "api_key"
        ),
        worker_backend_token_scope=first_non_empty_env("WORKER_BACKEND_TOKEN_SCOPE"),
        worker_backend_client_id=first_non_empty_env("WORKER_BACKEND_CLIENT_ID"),
        perclos_ttl_seconds=_positive_int_env("WORKER_PERCLOS_TTL_SECONDS", MINIMUM_TTL_SECONDS),
        max_delivery_count=_positive_int_env("WORKER_MAX_DELIVERY_COUNT", DEFAULT_MAX_DELIVERY_COUNT),
        session_concurrency=_positive_int_env("WORKER_SESSION_CONCURRENCY", DEFAULT_SESSION_CONCURRENCY),
        shutdown_timeout_seconds=_positive_float_env("WORKER_SHUTDOWN_TIMEOUT_SECONDS", DEFAULT_SHUTDOWN_TIMEOUT_SECONDS),
    )


def validate_config(config: WorkerConfig) -> None:
    if not config.model_path.exists():
        raise SystemExit(f"MediaPipe model file not found: {config.model_path}")
    if config.poll_interval_seconds <= 0 or config.post_timeout_seconds <= 0 or config.startup_check_timeout_seconds <= 0:
        raise SystemExit("worker timeout and poll settings must be positive")
    if config.health_port <= 0 or config.max_delivery_count <= 0:
        raise SystemExit("health port and maximum delivery count must be positive")
    if config.session_concurrency <= 0:
        raise SystemExit("WORKER_SESSION_CONCURRENCY must be a positive integer")
    if config.shutdown_timeout_seconds <= 0:
        raise SystemExit("WORKER_SHUTDOWN_TIMEOUT_SECONDS must be positive")
    if config.perclos_ttl_seconds < MINIMUM_TTL_SECONDS:
        raise SystemExit("WORKER_PERCLOS_TTL_SECONDS must be at least 86400 seconds")

    missing_azure_settings: list[str] = []
    if not config.service_bus_connection_string:
        missing_azure_settings.append("AZURE_SERVICE_BUS_CONNECTION_STRING / Azure__ServiceBus__ConnectionString / SERVICEBUS_CONNECTION_STRING")
    if not config.service_bus_queue_name:
        missing_azure_settings.append("AZURE_SERVICE_BUS_FRAME_QUEUE_NAME / Azure__ServiceBus__FrameQueueName / SERVICEBUS_QUEUE_NAME")
    if not config.blob_connection_string:
        missing_azure_settings.append("AZURE_BLOB_STORAGE_CONNECTION_STRING / Azure__BlobStorage__ConnectionString / BLOB_CONNECTION_STRING")
    if missing_azure_settings:
        raise SystemExit("Azure Service Bus / Blob Storage settings are required; local fallback is disabled:\n" + "\n".join(f"- {name}" for name in missing_azure_settings))
    if not config.redis_connection_string:
        raise SystemExit("REDIS_CONNECTION_STRING is required for PERCLOS state")
    auth_mode = config.worker_auth_mode.strip().lower()
    if auth_mode in {"api_key", "local", "development"} and not config.worker_api_key:
        raise SystemExit("WORKER_API_KEY is required for local Backend analysis result authentication")
    if auth_mode in {"entra_id", "entra", "production", "managed_identity", "workload_identity"} and not config.worker_backend_token_scope:
        raise SystemExit("WORKER_BACKEND_TOKEN_SCOPE is required for production Entra ID authentication")


def check_startup_dependencies(config: WorkerConfig) -> None:
    try:
        auth_provider = create_worker_auth_provider(
            mode=config.worker_auth_mode,
            api_key=config.worker_api_key,
            token_scope=config.worker_backend_token_scope,
            client_id=config.worker_backend_client_id,
        )
    except ValueError as error:
        raise SystemExit(str(error)) from error
    checks = [
        check_backend_dependency(base_url=config.backend_base_url, health_url=config.backend_health_url, timeout_seconds=config.startup_check_timeout_seconds, auth_provider=auth_provider),
        check_service_bus_dependency(service_bus_connection_string=cast(str, config.service_bus_connection_string), queue_name=cast(str, config.service_bus_queue_name), timeout_seconds=config.startup_check_timeout_seconds),
        check_blob_storage_dependency(blob_connection_string=cast(str, config.blob_connection_string), timeout_seconds=config.startup_check_timeout_seconds),
        check_redis_dependency(redis_connection_string=cast(str, config.redis_connection_string), timeout_seconds=config.startup_check_timeout_seconds),
    ]
    failures = [check for check in checks if not check.reachable]
    for check in checks:
        if check.reachable:
            logger.info("Startup dependency OK: %s (%s)", check.name, check.detail)
    if failures:
        raise SystemExit("Unable to connect to required dependency services; worker will exit.\n" + "\n".join(f"- {failure.name}: {failure.detail}" for failure in failures))


def check_backend_dependency(*, base_url: str, health_url: str | None, timeout_seconds: float, api_key: str | None = None, auth_provider: WorkerAuthProvider | None = None) -> DependencyCheckResult:
    probe_url = health_url or base_url
    try:
        headers = auth_provider.authorization_headers() if auth_provider is not None else ({"X-Worker-Api-Key": api_key} if api_key else {})
    except WorkerAuthenticationError as error:
        return DependencyCheckResult("Backend", False, f"worker authentication unavailable: {short_error_message(error)}")
    request = Request(probe_url, headers=headers, method="GET")
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            if response.status in {401, 403} or response.status >= 500:
                return DependencyCheckResult("Backend", False, f"HTTP {response.status} from {probe_url}")
            return DependencyCheckResult("Backend", True, f"HTTP {response.status} from {probe_url}")
    except HTTPError as error:
        if health_url is None and error.code in {400, 404}:
            return DependencyCheckResult("Backend", True, f"HTTP {error.code} from {probe_url}")
        return DependencyCheckResult("Backend", False, f"HTTP {error.code} from {probe_url}")
    except (URLError, TimeoutError) as error:
        return DependencyCheckResult("Backend", False, f"cannot reach {probe_url}: {short_error_message(error)}")


def is_azure_frame_source_enabled(config: WorkerConfig) -> bool:
    return bool(config.service_bus_connection_string and config.service_bus_queue_name and config.blob_connection_string)


def check_service_bus_dependency(*, service_bus_connection_string: str, queue_name: str, timeout_seconds: float) -> DependencyCheckResult:
    try:
        azure_servicebus = cast(Any, __import__("azure.servicebus", fromlist=["ServiceBusClient", "NEXT_AVAILABLE_SESSION"]))
        with azure_servicebus.ServiceBusClient.from_connection_string(service_bus_connection_string, socket_timeout=int(max(1.0, timeout_seconds)), retry_total=0) as service_bus_client:
            # The Worker is intentionally granted Listen only. Opening a receiver verifies
            # the same permission and AMQP path used for frame processing. An empty session
            # queue may time out while acquiring NEXT_AVAILABLE_SESSION; that is healthy.
            next_session = getattr(azure_servicebus, "NEXT_AVAILABLE_SESSION", "$all")
            try:
                with service_bus_client.get_queue_receiver(
                    queue_name=queue_name,
                    session_id=next_session,
                    max_wait_time=timeout_seconds,
                ):
                    pass
            except Exception as error:
                if _is_no_available_session_timeout(error):
                    return DependencyCheckResult("Service Bus", True, f"queue receiver idle={queue_name}")
                raise
        return DependencyCheckResult("Service Bus", True, f"queue receiver link={queue_name}")
    except Exception as error:
        return DependencyCheckResult("Service Bus", False, f"cannot reach queue {queue_name}: {short_error_message(error)}")


def check_blob_storage_dependency(*, blob_connection_string: str, timeout_seconds: float) -> DependencyCheckResult:
    try:
        azure_blob = cast(Any, __import__("azure.storage.blob", fromlist=["BlobServiceClient"]))
        timeout = int(max(1.0, timeout_seconds))
        client = azure_blob.BlobServiceClient.from_connection_string(blob_connection_string, connection_timeout=timeout, read_timeout=timeout, retry_total=0)
        account_info = client.get_account_information()
        kind = account_info.get("account_kind") or account_info.get("sku_name") or "reachable"
        return DependencyCheckResult("Blob Storage", True, f"account={kind}")
    except Exception as error:
        return DependencyCheckResult("Blob Storage", False, f"cannot reach storage account: {short_error_message(error)}")


def check_redis_dependency(*, redis_connection_string: str, timeout_seconds: float) -> DependencyCheckResult:
    try:
        redis_module = cast(Any, __import__("redis"))
        client = redis_module.Redis.from_url(
            normalize_redis_connection_string(redis_connection_string),
            socket_connect_timeout=timeout_seconds,
            socket_timeout=timeout_seconds,
        )
        if not client.ping():
            return DependencyCheckResult("Redis", False, "PING returned false")
        return DependencyCheckResult("Redis", True, "PING")
    except Exception as error:
        return DependencyCheckResult("Redis", False, f"cannot PING Redis: {short_error_message(error)}")


def parse_frame_reference(value: str) -> FrameReference:
    try:
        payload = json.loads(value)
    except json.JSONDecodeError as error:
        raise ValueError("message body must be JSON") from error
    if not isinstance(payload, dict):
        raise ValueError("message body must be a JSON object")

    session_id = _required_str(payload, "sessionId")
    try:
        _ = uuid.UUID(session_id)
    except ValueError as error:
        raise ValueError("sessionId must be a UUID") from error
    sequence_no = _required_positive_int(payload, "sequenceNo")
    blob_path = _required_str(payload, "blobPath")
    match = _FRAME_BLOB_PATH.fullmatch(blob_path)
    if not match or match.group(1) != session_id or int(match.group(2)) != sequence_no:
        raise ValueError("blobPath must match the session and sequenceNo")

    return FrameReference(
        session_id=session_id,
        sequence_no=sequence_no,
        blob_path=blob_path,
        captured_at=parse_datetime(_required_str(payload, "capturedAt")),
        received_at=parse_datetime(_required_str(payload, "receivedAt")),
        video_time_sec=_required_nonnegative_finite_number(payload, "videoTimeSec"),
        codec=_required_str(payload, "codec"),
    )


def parse_datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamp must include a timezone")
    return parsed.astimezone(UTC)


def _required_str(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} is required")
    return value


def _required_positive_int(payload: dict[str, Any], key: str) -> int:
    value = payload.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{key} must be a positive integer")
    return value


def _required_nonnegative_finite_number(payload: dict[str, Any], key: str) -> float:
    value = payload.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{key} must be a finite non-negative number")
    number = float(value)
    if not math.isfinite(number) or number < 0:
        raise ValueError(f"{key} must be a finite non-negative number")
    return number



def _service_bus_message_to_text(message: Any) -> str:
    body = message.body
    if isinstance(body, bytes):
        return body.decode("utf-8")
    if isinstance(body, str):
        return body
    return b"".join(chunk if isinstance(chunk, bytes) else bytes(chunk) for chunk in body).decode("utf-8")


def _is_blob_not_found(error: Exception) -> bool:
    return getattr(error, "status_code", None) == 404 or error.__class__.__name__ == "ResourceNotFoundError"


def iso_timestamp(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def scored_at_timestamp(value: datetime) -> str:
    return iso_timestamp(value.astimezone(UTC).replace(microsecond=0))


def _positive_int_env(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None or not value.strip():
        return default
    try:
        parsed = int(value)
    except ValueError as error:
        raise SystemExit(f"{name} must be a positive integer") from error
    if parsed <= 0:
        raise SystemExit(f"{name} must be a positive integer")
    return parsed


def _positive_float_env(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None or not value.strip():
        return default
    try:
        parsed = float(value)
    except ValueError as error:
        raise SystemExit(f"{name} must be positive") from error
    if not math.isfinite(parsed) or parsed <= 0:
        raise SystemExit(f"{name} must be positive")
    return parsed


def first_non_empty_env(*names: str) -> str | None:
    for name in names:
        value = os.getenv(name)
        if value and value.strip():
            return value.strip()
    return None


def short_error_message(error: Exception) -> str:
    message = str(error).strip().replace("\n", " ")
    return message or error.__class__.__name__


def _is_no_available_session_timeout(error: Exception) -> bool:
    return error.__class__.__name__ == "OperationTimeoutError" and "NEXT_AVAILABLE_SESSION" in str(error)


def _is_session_lock_lost(error: Exception) -> bool:
    return error.__class__.__name__ == "SessionLockLostError"


def configure_logging() -> None:
    logging.basicConfig(level=os.getenv("WORKER_LOG_LEVEL", "INFO").upper(), format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
    logging.getLogger("azure").setLevel(logging.WARNING)


def install_signal_handlers() -> None:
    def handle_signal(signum: int, frame: object) -> None:
        _ = frame
        logger.info("Received signal %s; stopping worker", signum)
        stop_event.set()
    _ = signal.signal(signal.SIGINT, handle_signal)
    _ = signal.signal(signal.SIGTERM, handle_signal)


def start_health_server(
    host: str,
    port: int,
    *,
    readiness_event: threading.Event | None = None,
) -> ThreadingHTTPServer | None:
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
            if self.path not in {"/health", "/health/live", "/health/ready"}:
                self.send_response(404)
                self.send_cors_headers()
                self.end_headers()
                return
            if self.path == "/health/ready" and readiness_event is not None and not readiness_event.is_set():
                body = b'{"status":"starting"}\n'
                self.send_response(503)
                self.send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                _ = self.wfile.write(body)
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
    threading.Thread(target=server.serve_forever, daemon=True).start()
    logger.info("Health endpoint listening on http://%s:%s/health", host, port)
    return server


if __name__ == "__main__":
    raise SystemExit(main())
