from __future__ import annotations

import json
from types import SimpleNamespace
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from email.message import Message
from typing import Any, cast
from unittest import TestCase
from unittest.mock import MagicMock, call, patch
from urllib.error import HTTPError

import app.main as worker_main
from app.analyzer.frame_decoder import FrameDecoder, FrameReference
from app.auth import EntraWorkerAuthProvider
from app.main import (
    AnalysisResultPublisher,
    BlobDownloadError,
    FrameEnvelope,
    AzureFrameEnvelope,
    AzureServiceBusFrameSource,
    DEFAULT_SERVICE_BUS_RECEIVE_WAIT_SECONDS,
    DEFAULT_SERVICE_BUS_SESSION_LOCK_RENEWAL_SECONDS,
    RejectedResultPublishError,
    SessionLockLostSettlementError,
    ResultPublisher,
    RetryableResultPublishError,
    SCORE_AGGREGATION_FRAMES,
    SessionAnalysisState,
    parse_frame_reference,
    process_frame,
    restore_calibration,
    run_worker_loop,
    stop_event,
)
from app.perclos import MINIMUM_TTL_SECONDS, PERCLOS_APPEND_SCRIPT, RedisPerclosWindow
from shared.tracking.calibration import CalibrationTracker
from shared.tracking.models import FaceMetrics


class RedisDouble:
    """A test double for Redis EVAL; no local Redis or E2E fallback is used."""

    def __init__(self) -> None:
        self.values: dict[str, list[str]] = {}
        self.ttl: dict[str, int] = {}
        self.scripts: list[str] = []

    def eval(self, script: str, numkeys: int, *keys_and_args: object) -> list[object]:
        self.scripts.append(script)
        assert numkeys == 1
        key = cast(str, keys_and_args[0])
        sequence_no = cast(int, keys_and_args[1])
        record = cast(str, keys_and_args[2])
        window_size = cast(int, keys_and_args[3])
        ttl_seconds = cast(int, keys_and_args[4])
        captured_at_ms = cast(int, keys_and_args[5])
        window_ms = cast(int, keys_and_args[6])
        frames = self.values.setdefault(key, [])
        cutoff_ms = captured_at_ms - window_ms
        frames[:] = [frame for frame in frames if json.loads(frame)["capturedAtUnixMs"] >= cutoff_ms]
        duplicate = any(json.loads(frame)["sequenceNo"] == sequence_no for frame in frames)
        if not duplicate:
            frames.insert(0, record)
            del frames[window_size:]
        self.ttl[key] = ttl_seconds
        return [int(duplicate), [frame.encode("utf-8") for frame in frames]]


class RecordingPublisher:
    def __init__(self) -> None:
        self.payloads: list[dict[str, object]] = []

    def publish(self, session_id: str, payload: dict[str, object]) -> None:
        assert payload["sessionId"] == session_id
        self.payloads.append(payload)


class MetricsAnalyzer:
    def __init__(self, metrics: FaceMetrics | None) -> None:
        self.metrics = metrics

    def analyze(self, bgr_image: Any) -> FaceMetrics | None:
        _ = bgr_image
        return self.metrics


class SettlingSource:
    def __init__(self, envelope: FrameEnvelope) -> None:
        self.envelope = envelope
        self.returned = False
        self.completed = 0
        self.abandoned: list[Exception] = []
        self.dead_letters: list[tuple[str, Exception]] = []

    def receive(self) -> list[FrameEnvelope]:
        if self.returned:
            return []
        self.returned = True
        return [self.envelope]

    def complete(self, envelope: FrameEnvelope) -> None:
        _ = envelope
        self.completed += 1
        stop_event.set()

    def abandon(self, envelope: FrameEnvelope, error: Exception) -> None:
        _ = envelope
        self.abandoned.append(error)
        stop_event.set()

    def dead_letter(self, envelope: FrameEnvelope, reason: str, error: Exception) -> None:
        _ = envelope
        self.dead_letters.append((reason, error))
        stop_event.set()

    def close(self) -> None:
        pass


class WorkerReliabilityTests(TestCase):
    session_id = "0d8f17be-1240-4e94-97da-8e410d1b41bb"

    def test_redis_window_uses_lua_dedup_trim_lrange_expire_and_ttl(self) -> None:
        redis = RedisDouble()
        window = RedisPerclosWindow(redis, ttl_seconds=MINIMUM_TTL_SECONDS, window_size=2)
        captured_at = datetime(2026, 6, 14, 10, 0, tzinfo=UTC)

        first = window.append(
            session_id=self.session_id,
            sequence_no=10,
            captured_at=captured_at,
            is_closed=True,
        )
        duplicate = window.append(
            session_id=self.session_id,
            sequence_no=10,
            captured_at=captured_at,
            is_closed=True,
        )
        latest = window.append(
            session_id=self.session_id,
            sequence_no=11,
            captured_at=captured_at,
            is_closed=False,
        )

        self.assertFalse(first.duplicate)
        self.assertTrue(duplicate.duplicate)
        self.assertEqual(len(latest.frames), 2)
        self.assertAlmostEqual(latest.perclos, 0.5)
        self.assertEqual(redis.ttl[window.key_for(self.session_id)], MINIMUM_TTL_SECONDS)
        self.assertIn("LPUSH", PERCLOS_APPEND_SCRIPT)
        self.assertIn("LTRIM", PERCLOS_APPEND_SCRIPT)
        self.assertIn("LRANGE", PERCLOS_APPEND_SCRIPT)
        self.assertIn("EXPIRE", PERCLOS_APPEND_SCRIPT)

    def test_perclos_is_limited_by_captured_time_frame_count_and_session(self) -> None:
        redis = RedisDouble()
        window = RedisPerclosWindow(redis)
        first_session = self.session_id
        second_session = "eb6f5601-cbca-4cee-9c96-c2fa92321da8"
        started_at = datetime(2026, 6, 14, 10, 0, tzinfo=UTC)

        for sequence_no in range(1, 77):
            _ = window.append(
                session_id=first_session,
                sequence_no=sequence_no,
                captured_at=started_at + timedelta(milliseconds=sequence_no),
                is_closed=sequence_no % 2 == 0,
            )
        stored_count = len(redis.values[window.key_for(first_session)])
        other = window.append(
            session_id=second_session,
            sequence_no=1,
            captured_at=started_at,
            is_closed=True,
        )
        after_gap = window.append(
            session_id=first_session,
            sequence_no=77,
            captured_at=started_at + timedelta(seconds=16),
            is_closed=False,
        )

        self.assertEqual(stored_count, 75)
        self.assertEqual(len(other.frames), 1)
        self.assertEqual(other.perclos, 1.0)
        self.assertEqual(len(after_gap.frames), 1)
        self.assertEqual(after_gap.frames[0].sequence_no, 77)

    def test_calibration_contains_source_sequence_and_scored_result_uses_captured_second(self) -> None:
        redis = RedisDouble()
        perclos = RedisPerclosWindow(redis)
        publisher = RecordingPublisher()
        states: dict[str, SessionAnalysisState] = {
            self.session_id: SessionAnalysisState(
                calibration=CalibrationTracker(target_frames=1, min_valid_frames=1)
            )
        }
        decoder = FrameDecoder(decode_payload=lambda payload, codec: payload)
        calibration_time = datetime(2026, 6, 14, 10, 0, microsecond=500_000, tzinfo=UTC)

        process_frame(
            self.envelope(1, calibration_time),
            analyzer=MetricsAnalyzer(FaceMetrics(ear=0.4, pitch_deg=0, yaw_deg=0)),
            decoder=decoder,
            publisher=publisher,  # type: ignore[arg-type]
            perclos_window=perclos,
            states=states,
        )
        calibration = publisher.payloads[0]
        self.assertEqual(calibration["type"], "calibration_status")
        self.assertEqual(calibration["sourceSequenceNo"], 1)
        self.assertEqual(calibration["calibratedAt"], "2026-06-14T10:00:00.500000Z")

        for sequence_no in range(2, 2 + SCORE_AGGREGATION_FRAMES):
            process_frame(
                self.envelope(
                    sequence_no,
                    calibration_time + timedelta(microseconds=(sequence_no - 2) * 100_000),
                ),
                analyzer=MetricsAnalyzer(FaceMetrics(ear=0.1, pitch_deg=0, yaw_deg=0)),
                decoder=decoder,
                publisher=publisher,  # type: ignore[arg-type]
                perclos_window=perclos,
                states=states,
            )

        score = publisher.payloads[-1]
        self.assertEqual(score["type"], "drowsiness_score")
        self.assertEqual(score["sourceSequenceNo"], 6)
        self.assertEqual(score["scoredAt"], "2026-06-14T10:00:00Z")
        self.assertEqual(score["videoTimeSec"], 1.2)
        self.assertTrue(score["shouldPause"])

    def test_service_bus_frame_reference_restores_required_video_time_sec(self) -> None:
        message = {
            "sessionId": self.session_id,
            "sequenceNo": 2,
            "blobPath": f"sessions/{self.session_id}/frames/2.bin",
            "capturedAt": "2026-06-14T10:00:00.200Z",
            "receivedAt": "2026-06-14T10:00:00.250Z",
            "videoTimeSec": 123.45,
            "codec": "image/jpeg",
        }

        reference = parse_frame_reference(json.dumps(message))

        self.assertEqual(reference.video_time_sec, 123.45)

    def test_service_bus_frame_reference_rejects_missing_or_invalid_video_time_sec(self) -> None:
        message = {
            "sessionId": self.session_id,
            "sequenceNo": 2,
            "blobPath": f"sessions/{self.session_id}/frames/2.bin",
            "capturedAt": "2026-06-14T10:00:00.200Z",
            "receivedAt": "2026-06-14T10:00:00.250Z",
            "videoTimeSec": 0,
            "codec": "image/jpeg",
        }
        invalid_values: tuple[object, ...] = (None, True, "123.45", -0.01, float("nan"), float("inf"), -float("inf"))

        missing = dict(message)
        del missing["videoTimeSec"]
        with self.assertRaisesRegex(ValueError, "videoTimeSec must be a finite non-negative number"):
            parse_frame_reference(json.dumps(missing))

        for value in invalid_values:
            with self.subTest(video_time_sec=value):
                invalid = dict(message, videoTimeSec=value)
                with self.assertRaisesRegex(ValueError, "videoTimeSec must be a finite non-negative number"):
                    parse_frame_reference(json.dumps(invalid))

    def test_logs_every_decoded_frame_after_face_analysis(self) -> None:
        captured_at = datetime(2026, 6, 14, 10, 0, tzinfo=UTC)
        decoder = FrameDecoder(decode_payload=lambda payload, codec: payload)

        with patch.object(worker_main, "logger") as logger:
            process_frame(
                self.envelope(1, captured_at),
                analyzer=MetricsAnalyzer(FaceMetrics(ear=0.4, pitch_deg=2.0, yaw_deg=-3.0)),
                decoder=decoder,
                publisher=RecordingPublisher(),  # type: ignore[arg-type]
                perclos_window=RedisPerclosWindow(RedisDouble()),
                states={},
            )
            process_frame(
                self.envelope(2, captured_at + timedelta(milliseconds=200)),
                analyzer=MetricsAnalyzer(None),
                decoder=decoder,
                publisher=RecordingPublisher(),  # type: ignore[arg-type]
                perclos_window=RedisPerclosWindow(RedisDouble()),
                states={},
            )

        logger.info.assert_has_calls(
            [
                call(
                    "Analyzed image frame: session=%s sequence=%s face_detected=%s ear=%s pitch_deg=%s yaw_deg=%s",
                    self.session_id,
                    1,
                    True,
                    0.4,
                    2.0,
                    -3.0,
                ),
                call(
                    "Analyzed image frame: session=%s sequence=%s face_detected=%s ear=%s pitch_deg=%s yaw_deg=%s",
                    self.session_id,
                    2,
                    False,
                    None,
                    None,
                    None,
                ),
            ]
        )

    def test_face_not_detected_does_not_mutate_perclos_and_posts_tracking_status(self) -> None:
        redis = RedisDouble()
        perclos = RedisPerclosWindow(redis)
        publisher = RecordingPublisher()
        states: dict[str, SessionAnalysisState] = {}

        process_frame(
            self.envelope(1, datetime(2026, 6, 14, 10, 0, tzinfo=UTC)),
            analyzer=MetricsAnalyzer(None),
            decoder=FrameDecoder(decode_payload=lambda payload, codec: payload),
            publisher=publisher,  # type: ignore[arg-type]
            perclos_window=perclos,
            states=states,
        )

        self.assertEqual(redis.values, {})
        self.assertEqual(publisher.payloads[0]["type"], "tracking_status")
        self.assertEqual(publisher.payloads[0]["status"], "face_not_detected")

    def test_publisher_sends_api_key_and_requires_202(self) -> None:
        seen: dict[str, Any] = {}

        class AcceptedResponse:
            status = 202

            def __enter__(self) -> AcceptedResponse:
                return self

            def __exit__(self, *args: object) -> None:
                return None

        def accepted_opener(request: Any, *, timeout: float) -> AcceptedResponse:
            seen["request"] = request
            seen["timeout"] = timeout
            return AcceptedResponse()

        publisher = AnalysisResultPublisher(
            "http://backend",
            api_key="worker-secret",
            timeout_seconds=2,
            opener=accepted_opener,
        )
        publisher.publish(self.session_id, {"type": "tracking_status", "sessionId": self.session_id})
        request = seen["request"]
        self.assertEqual(request.get_header("X-worker-api-key"), "worker-secret")

        class OkResponse(AcceptedResponse):
            status = 200

        with self.assertRaises(RejectedResultPublishError):
            AnalysisResultPublisher(
                "http://backend",
                api_key="worker-secret",
                timeout_seconds=2,
                opener=lambda request, *, timeout: OkResponse(),
            ).publish(self.session_id, {})

        def unavailable(request: Any, *, timeout: float) -> object:
            raise HTTPError("http://backend", 503, "unavailable", Message(), None)

        with self.assertRaises(RetryableResultPublishError):
            AnalysisResultPublisher(
                "http://backend",
                api_key="worker-secret",
                timeout_seconds=2,
                opener=unavailable,
            ).publish(self.session_id, {})

    def test_entra_auth_provider_sends_bearer_and_caches_token_in_memory(self) -> None:
        calls: list[str] = []

        class Credential:
            def get_token(self, scope: str) -> Any:
                calls.append(scope)
                return SimpleNamespace(token="access-token", expires_on=datetime.now(UTC).timestamp() + 3600)

        provider = EntraWorkerAuthProvider("api://backend/.default", credential=Credential())
        self.assertEqual(provider.authorization_headers(), {"Authorization": "Bearer access-token"})
        self.assertEqual(provider.authorization_headers(), {"Authorization": "Bearer access-token"})
        self.assertEqual(calls, ["api://backend/.default"])

    def test_restored_calibration_is_used_without_recalibrating(self) -> None:
        state = SessionAnalysisState()
        restore_calibration(
            state,
            {
                "earOpen": 0.4,
                "earThreshold": 0.3,
                "validFrames": 17,
                "totalFrames": 25,
                "sourceSequenceNo": 25,
                "calibratedAt": "2026-06-14T10:00:05Z",
            },
        )
        self.assertTrue(state.calibration_loaded)
        self.assertEqual(state.calibration.status, "succeeded")
        self.assertEqual(state.calibration.result.ear_threshold if state.calibration.result else None, 0.3)

    def test_incomplete_second_window_is_discarded_instead_of_mixed(self) -> None:
        redis = RedisDouble()
        perclos = RedisPerclosWindow(redis)
        publisher = RecordingPublisher()
        state = SessionAnalysisState()
        restore_calibration(
            state,
            {
                "earOpen": 0.4,
                "earThreshold": 0.3,
                "validFrames": 15,
                "totalFrames": 25,
                "sourceSequenceNo": 25,
                "calibratedAt": "2026-06-14T10:00:05Z",
            },
        )
        decoder = FrameDecoder(decode_payload=lambda payload, codec: payload)
        base = datetime(2026, 6, 14, 10, 0, 0, 100_000, tzinfo=UTC)
        for sequence_no in range(2, 6):
            process_frame(self.envelope(sequence_no, base), analyzer=MetricsAnalyzer(FaceMetrics(0.2, 0, 0)), decoder=decoder, publisher=publisher, perclos_window=perclos, states={self.session_id: state})
        process_frame(self.envelope(6, base + timedelta(seconds=1)), analyzer=MetricsAnalyzer(FaceMetrics(0.2, 0, 0)), decoder=decoder, publisher=publisher, perclos_window=perclos, states={self.session_id: state})
        self.assertFalse(any(payload["type"] == "drowsiness_score" for payload in publisher.payloads))

    def test_sequence_gap_is_analyzed_as_an_independent_jpeg(self) -> None:
        class RecordingAnalyzer:
            def __init__(self) -> None:
                self.images: list[object] = []

            def analyze(self, bgr_image: Any) -> FaceMetrics | None:
                self.images.append(bgr_image)
                return None

        analyzer = RecordingAnalyzer()
        decoder = FrameDecoder(decode_payload=lambda payload, codec: payload)
        publisher = RecordingPublisher()
        states: dict[str, SessionAnalysisState] = {}
        captured_at = datetime(2026, 6, 14, 10, 0, tzinfo=UTC)

        process_frame(self.envelope(1, captured_at), analyzer=analyzer, decoder=decoder, publisher=publisher, perclos_window=RedisPerclosWindow(RedisDouble()), states=states)  # type: ignore[arg-type]
        process_frame(self.envelope(3, captured_at + timedelta(milliseconds=400)), analyzer=analyzer, decoder=decoder, publisher=publisher, perclos_window=RedisPerclosWindow(RedisDouble()), states=states)  # type: ignore[arg-type]

        self.assertEqual(analyzer.images, [b"frame", b"frame"])
        self.assertEqual([payload["type"] for payload in publisher.payloads], ["tracking_status", "tracking_status"])

    def test_service_bus_settlement_classifies_retry_and_dead_letter_failures(self) -> None:
        captured_at = datetime(2026, 6, 14, 10, 0, tzinfo=UTC)

        transient = self.envelope(1, captured_at)
        transient = FrameEnvelope(
            reference=transient.reference,
            payload=None,
            payload_error=BlobDownloadError(OSError("temporary storage outage"), permanent=False),
        )
        source = self.run_once(transient)
        self.assertEqual(len(source.abandoned), 1)
        self.assertEqual(source.dead_letters, [])

        exhausted = FrameEnvelope(
            reference=transient.reference,
            payload=None,
            payload_error=BlobDownloadError(OSError("temporary storage outage"), permanent=False),
            delivery_count=10,
        )
        source = self.run_once(exhausted)
        self.assertEqual(source.dead_letters[0][0], "RetryLimitExceeded")

        invalid_codec = self.envelope(1, captured_at)
        invalid_codec = FrameEnvelope(
            reference=replace(invalid_codec.reference, codec="image/png"),
            payload=b"frame",
        )
        source = self.run_once(invalid_codec, decoder=FrameDecoder())
        self.assertEqual(source.dead_letters[0][0], "UnsupportedCodec")

        class RejectedPublisher:
            def publish(self, session_id: str, payload: dict[str, object]) -> None:
                _ = session_id
                _ = payload
                raise RejectedResultPublishError("HTTP 401")

        source = self.run_once(
            self.envelope(1, captured_at),
            analyzer=MetricsAnalyzer(None),
            publisher=RejectedPublisher(),  # type: ignore[arg-type]
        )
        self.assertEqual(source.dead_letters[0][0], "AnalysisResultRejected")

        class RetryPublisher:
            def publish(self, session_id: str, payload: dict[str, object]) -> None:
                _ = session_id
                _ = payload
                raise RetryableResultPublishError("HTTP 503")

        source = self.run_once(
            self.envelope(1, captured_at),
            analyzer=MetricsAnalyzer(None),
            publisher=RetryPublisher(),  # type: ignore[arg-type]
        )
        self.assertEqual(source.completed, 0)
        self.assertEqual(len(source.abandoned), 1)

    def test_next_available_session_uses_bounded_acquisition_wait(self) -> None:
        receiver = MagicMock()
        receiver.receive_messages.return_value = []
        service_bus_client = MagicMock()
        service_bus_client.get_queue_receiver.return_value = receiver
        lock_renewer = MagicMock()
        auto_lock_renewer = MagicMock(return_value=lock_renewer)
        service_bus = SimpleNamespace(
            NEXT_AVAILABLE_SESSION="next-available-session",
            AutoLockRenewer=auto_lock_renewer,
            ServiceBusClient=SimpleNamespace(from_connection_string=MagicMock(return_value=service_bus_client)),
        )
        blob_service_client = MagicMock()
        blob = SimpleNamespace(
            BlobServiceClient=SimpleNamespace(from_connection_string=MagicMock(return_value=blob_service_client))
        )

        def import_azure(name: str, *args: object, **kwargs: object) -> object:
            _ = args
            _ = kwargs
            if name == "azure.servicebus":
                return service_bus
            if name == "azure.storage.blob":
                return blob
            raise AssertionError(f"unexpected import: {name}")

        with patch.object(worker_main, "__import__", side_effect=import_azure, create=True):
            source = AzureServiceBusFrameSource(
                service_bus_connection_string="Endpoint=sb://example/;SharedAccessKeyName=name;SharedAccessKey=key",
                queue_name="frame-processing-queue",
                blob_connection_string="UseDevelopmentStorage=true",
                blob_container_name="frames",
            )

        self.assertEqual(source.receive(), [])
        auto_lock_renewer.assert_called_once()
        self.assertEqual(
            auto_lock_renewer.call_args.kwargs["max_lock_renewal_duration"],
            DEFAULT_SERVICE_BUS_SESSION_LOCK_RENEWAL_SECONDS,
        )
        self.assertTrue(callable(auto_lock_renewer.call_args.kwargs["on_lock_renew_failure"]))
        service_bus_client.get_queue_receiver.assert_called_once_with(
            queue_name="frame-processing-queue",
            session_id="next-available-session",
            max_wait_time=DEFAULT_SERVICE_BUS_RECEIVE_WAIT_SECONDS,
            auto_lock_renewer=lock_renewer,
        )
        receiver.receive_messages.assert_called_once_with(
            max_message_count=10,
            max_wait_time=DEFAULT_SERVICE_BUS_RECEIVE_WAIT_SECONDS,
        )
        receiver.close.assert_called_once_with()

        receiver.reset_mock()
        receiver.receive_messages.side_effect = type("OperationTimeoutError", (Exception,), {})(
            "If trying to receive from NEXT_AVAILABLE_SESSION, use max_wait_time on the ServiceBusReceiver to control the timeout."
        )
        with patch.object(worker_main, "logger") as logger:
            self.assertEqual(source.receive(), [])
        logger.warning.assert_not_called()
        logger.debug.assert_called_once_with("No active Service Bus session is available; retrying on the next poll")
        receiver.close.assert_called_once_with()

    def test_async_lock_renewal_failure_skips_settlement(self) -> None:
        source = object.__new__(AzureServiceBusFrameSource)
        source._session_lock_lost = worker_main.threading.Event()
        receiver = MagicMock()
        source._receiver = receiver
        source._on_lock_renew_failure(None, RuntimeError("lock renewal failed"))
        envelope = self.envelope(1, datetime(2026, 6, 14, 10, 0, tzinfo=UTC))

        with self.assertRaises(SessionLockLostSettlementError):
            source.complete(AzureFrameEnvelope(reference=envelope.reference, payload=envelope.payload, message=MagicMock()))

        receiver.complete_message.assert_not_called()
        receiver.close.assert_called_once_with()

    def test_session_lock_loss_skips_settlement_and_continues_receiving(self) -> None:
        envelope = self.envelope(1, datetime(2026, 6, 14, 10, 0, tzinfo=UTC))

        class LockLostSource:
            def __init__(self) -> None:
                self.has_returned = False
                self.complete_attempts = 0
                self.abandon_attempts = 0
                self.dead_letter_attempts = 0

            def receive(self) -> list[FrameEnvelope]:
                if not self.has_returned:
                    self.has_returned = True
                    return [envelope]
                stop_event.set()
                return []

            def complete(self, envelope: FrameEnvelope) -> None:
                _ = envelope
                self.complete_attempts += 1
                raise SessionLockLostSettlementError("Service Bus session lock expired")

            def abandon(self, envelope: FrameEnvelope, error: Exception) -> None:
                _ = envelope
                _ = error
                self.abandon_attempts += 1

            def dead_letter(self, envelope: FrameEnvelope, reason: str, error: Exception) -> None:
                _ = envelope
                _ = reason
                _ = error
                self.dead_letter_attempts += 1

            def close(self) -> None:
                pass

        source = LockLostSource()
        stop_event.clear()
        try:
            run_worker_loop(
                source=source,  # type: ignore[arg-type]
                analyzer=MetricsAnalyzer(None),
                decoder=FrameDecoder(decode_payload=lambda payload, codec: payload),
                publisher=RecordingPublisher(),
                perclos_window=RedisPerclosWindow(RedisDouble()),
                states={},
                poll_interval_seconds=0.001,
            )
        finally:
            stop_event.clear()

        self.assertEqual(source.complete_attempts, 1)
        self.assertEqual(source.abandon_attempts, 0)
        self.assertEqual(source.dead_letter_attempts, 0)

    def run_once(
        self,
        envelope: FrameEnvelope,
        *,
        analyzer: MetricsAnalyzer | None = None,
        publisher: ResultPublisher | None = None,
        decoder: FrameDecoder | None = None,
    ) -> SettlingSource:
        source = SettlingSource(envelope)
        stop_event.clear()
        try:
            run_worker_loop(
                source=source,
                analyzer=analyzer or MetricsAnalyzer(None),
                decoder=decoder or FrameDecoder(decode_payload=lambda payload, codec: payload),
                publisher=publisher or RecordingPublisher(),
                perclos_window=RedisPerclosWindow(RedisDouble()),
                states={},
                poll_interval_seconds=0.001,
                max_delivery_count=10,
            )
        finally:
            stop_event.clear()
        return source

    def envelope(self, sequence_no: int, captured_at: datetime) -> FrameEnvelope:
        return FrameEnvelope(
            reference=FrameReference(
                session_id=self.session_id,
                sequence_no=sequence_no,
                blob_path=f"sessions/{self.session_id}/frames/{sequence_no}.bin",
                captured_at=captured_at,
                received_at=captured_at,
                video_time_sec=sequence_no / SCORE_AGGREGATION_FRAMES,
                codec="image/jpeg",
            ),
            payload=b"frame",
        )
