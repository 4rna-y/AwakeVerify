from __future__ import annotations

import os
import threading
from datetime import UTC, datetime
from typing import Any, Callable, cast
from unittest import TestCase
from unittest.mock import patch

from app.analyzer.frame_decoder import FrameDecoder, FrameReference
from app.main import (
    DEFAULT_SESSION_CONCURRENCY,
    FrameEnvelope,
    SessionLockLostSettlementError,
    WorkerSlot,
    _positive_int_env,
    process_frame,
    run_worker_loop,
    run_worker_slots,
)


class FakeSource:
    def __init__(self, batches: list[list[FrameEnvelope]], *, on_complete: Callable[[FrameEnvelope], None] | None = None) -> None:
        self._batches = batches
        self._on_complete = on_complete
        self.receive_count = 0
        self.completed: list[int] = []
        self.abandoned: list[int] = []
        self.dead_letters: list[int] = []
        self.close_count = 0

    def receive(self) -> list[FrameEnvelope]:
        self.receive_count += 1
        if self._batches:
            return self._batches.pop(0)
        return []

    def complete(self, envelope: FrameEnvelope) -> None:
        self.completed.append(envelope.reference.sequence_no)
        if self._on_complete is not None:
            self._on_complete(envelope)

    def abandon(self, envelope: FrameEnvelope, error: Exception) -> None:
        _ = error
        self.abandoned.append(envelope.reference.sequence_no)

    def dead_letter(self, envelope: FrameEnvelope, reason: str, error: Exception) -> None:
        _ = reason
        _ = error
        self.dead_letters.append(envelope.reference.sequence_no)

    def close(self) -> None:
        self.close_count += 1


class NullPublisher:
    def publish(self, session_id: str, payload: dict[str, object]) -> None:
        _ = session_id
        _ = payload


class CoordinatedAnalyzer:
    def __init__(self, enter: Callable[[], None]) -> None:
        self._enter = enter
        self.close_count = 0

    def analyze(self, bgr_image: Any) -> None:
        _ = bgr_image
        self._enter()
        return None

    def close(self) -> None:
        self.close_count += 1


class SessionConcurrencyTests(TestCase):
    def frame(self, session_id: str, sequence_no: int) -> FrameEnvelope:
        captured_at = datetime(2026, 7, 14, 10, 0, tzinfo=UTC)
        return FrameEnvelope(
            reference=FrameReference(
                session_id=session_id,
                sequence_no=sequence_no,
                blob_path=f"sessions/{session_id}/frames/{sequence_no}.bin",
                captured_at=captured_at,
                received_at=captured_at,
                video_time_sec=float(sequence_no),
                codec="image/jpeg",
            ),
            payload=b"frame",
        )

    def slot(self, source: FakeSource, analyzer: CoordinatedAnalyzer) -> WorkerSlot:
        return WorkerSlot(
            source=cast(Any, source),
            analyzer=analyzer,
            decoder=FrameDecoder(decode_payload=lambda payload, codec: payload),
            publisher=NullPublisher(),
            perclos_window=cast(Any, None),
            processed_frames=None,
            calibration_loader=None,
            poll_interval_seconds=0.001,
            max_delivery_count=10,
        )

    def test_default_single_slot_preserves_serial_processing_for_one_session(self) -> None:
        stop = threading.Event()
        active = 0
        maximum_active = 0
        seen: list[int] = []
        lock = threading.Lock()

        def analyze() -> None:
            nonlocal active, maximum_active
            with lock:
                active += 1
                maximum_active = max(maximum_active, active)
                seen.append(len(seen) + 1)
                active -= 1

        source = FakeSource(
            [[self.frame("00000000-0000-0000-0000-000000000001", 1), self.frame("00000000-0000-0000-0000-000000000001", 2)]],
            on_complete=lambda envelope: stop.set() if envelope.reference.sequence_no == 2 else None,
        )
        analyzer = CoordinatedAnalyzer(analyze)

        run_worker_slots(
            session_concurrency=DEFAULT_SESSION_CONCURRENCY,
            slot_factory=lambda _: self.slot(source, analyzer),
            shutdown_event=stop,
            shutdown_timeout_seconds=1,
        )

        self.assertEqual(seen, [1, 2])
        self.assertEqual(maximum_active, 1)
        self.assertEqual(source.completed, [1, 2])
        self.assertEqual(source.close_count, 1)
        self.assertEqual(analyzer.close_count, 1)

    def test_distinct_sessions_overlap_and_slow_session_does_not_block_other_slot(self) -> None:
        stop = threading.Event()
        session_a_started = threading.Event()
        session_a_release = threading.Event()
        session_b_completed = threading.Event()
        overlap = threading.Event()
        active = 0
        completed = 0
        lock = threading.Lock()

        def enter_a() -> None:
            nonlocal active
            with lock:
                active += 1
            session_a_started.set()
            self.assertTrue(session_a_release.wait(timeout=1))
            with lock:
                active -= 1

        def enter_b() -> None:
            nonlocal active
            self.assertTrue(session_a_started.wait(timeout=1))
            with lock:
                active += 1
                if active == 2:
                    overlap.set()
            session_b_completed.set()
            with lock:
                active -= 1

        def mark_completed(envelope: FrameEnvelope) -> None:
            nonlocal completed
            _ = envelope
            with lock:
                completed += 1
                if completed == 2:
                    stop.set()

        source_a = FakeSource([[self.frame("00000000-0000-0000-0000-00000000000a", 1)]], on_complete=mark_completed)
        source_b = FakeSource([[self.frame("00000000-0000-0000-0000-00000000000b", 1)]], on_complete=mark_completed)
        analyzer_a = CoordinatedAnalyzer(enter_a)
        analyzer_b = CoordinatedAnalyzer(enter_b)
        slots = [self.slot(source_a, analyzer_a), self.slot(source_b, analyzer_b)]
        supervisor = threading.Thread(
            target=run_worker_slots,
            kwargs={
                "session_concurrency": 2,
                "slot_factory": lambda index: slots[index],
                "shutdown_event": stop,
                "shutdown_timeout_seconds": 1,
            },
        )
        supervisor.start()
        self.assertTrue(session_a_started.wait(timeout=1))
        self.assertTrue(session_b_completed.wait(timeout=1))
        self.assertTrue(overlap.is_set())
        self.assertEqual(source_b.completed, [1])
        self.assertEqual(source_a.completed, [])

        session_a_release.set()
        supervisor.join(timeout=1)
        self.assertFalse(supervisor.is_alive())
        self.assertEqual(source_a.completed, [1])
        self.assertEqual(source_a.close_count, 1)
        self.assertEqual(source_b.close_count, 1)
        self.assertEqual(analyzer_a.close_count, 1)
        self.assertEqual(analyzer_b.close_count, 1)

    def test_shutdown_finishes_started_message_but_does_not_acquire_another_session(self) -> None:
        stop = threading.Event()
        first = self.frame("00000000-0000-0000-0000-00000000000c", 1)
        second = self.frame("00000000-0000-0000-0000-00000000000d", 1)
        source = FakeSource([[first], [second]])
        analyzer = CoordinatedAnalyzer(stop.set)

        run_worker_slots(
            session_concurrency=1,
            slot_factory=lambda _: self.slot(source, analyzer),
            shutdown_event=stop,
            shutdown_timeout_seconds=1,
        )

        self.assertEqual(source.receive_count, 1)
        self.assertEqual(source.completed, [1])
        self.assertEqual(source.close_count, 1)

    def test_lock_loss_stops_the_batch_without_a_follow_up_settlement(self) -> None:
        stop = threading.Event()
        first = self.frame("00000000-0000-0000-0000-00000000000e", 1)
        second = self.frame("00000000-0000-0000-0000-00000000000e", 2)

        class LockLostSource(FakeSource):
            def complete(self, envelope: FrameEnvelope) -> None:
                self.completed.append(envelope.reference.sequence_no)
                raise SessionLockLostSettlementError("session lock expired")

            def receive(self) -> list[FrameEnvelope]:
                batches = super().receive()
                if not batches:
                    stop.set()
                return batches

        source = LockLostSource([[first, second]])
        analyzer = CoordinatedAnalyzer(lambda: None)
        run_worker_loop(
            source=cast(Any, source),
            analyzer=analyzer,
            decoder=FrameDecoder(decode_payload=lambda payload, codec: payload),
            publisher=NullPublisher(),
            perclos_window=cast(Any, None),
            states={},
            poll_interval_seconds=0.001,
            shutdown_event=stop,
        )

        self.assertEqual(source.completed, [1])
        self.assertEqual(source.abandoned, [])
        self.assertEqual(source.dead_letters, [])

    def test_duplicate_redelivery_after_restart_remains_idempotent(self) -> None:
        class ProcessedStore:
            def __init__(self) -> None:
                self.keys: set[tuple[str, int]] = set()

            def is_processed(self, *, session_id: str, sequence_no: int) -> bool:
                return (session_id, sequence_no) in self.keys

            def mark_processed(self, *, session_id: str, sequence_no: int) -> bool:
                key = (session_id, sequence_no)
                first = key not in self.keys
                self.keys.add(key)
                return first

        calls = 0

        def analyze() -> None:
            nonlocal calls
            calls += 1

        envelope = self.frame("00000000-0000-0000-0000-00000000000f", 1)
        store = ProcessedStore()
        for _ in range(2):
            process_frame(
                envelope,
                analyzer=CoordinatedAnalyzer(analyze),
                decoder=FrameDecoder(decode_payload=lambda payload, codec: payload),
                publisher=NullPublisher(),
                perclos_window=cast(Any, None),
                processed_frames=cast(Any, store),
                states={},
            )

        self.assertEqual(calls, 1)

    def test_invalid_session_concurrency_environment_fails_at_startup(self) -> None:
        for value in ("0", "-1", "not-a-number"):
            with self.subTest(value=value), patch.dict(os.environ, {"WORKER_SESSION_CONCURRENCY": value}):
                with self.assertRaisesRegex(SystemExit, "WORKER_SESSION_CONCURRENCY must be a positive integer"):
                    _positive_int_env("WORKER_SESSION_CONCURRENCY", DEFAULT_SESSION_CONCURRENCY)
