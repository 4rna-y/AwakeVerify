# pyright: reportImplicitRelativeImport=false, reportUninitializedInstanceVariable=false, reportImplicitOverride=false
from __future__ import annotations

from datetime import UTC, datetime
from unittest import TestCase

from app.analyzer.frame_decoder import FrameDecoder, FrameReference


class FrameDecoderTests(TestCase):
    decoder: FrameDecoder

    def setUp(self) -> None:
        self.decoder = FrameDecoder(decode_payload=lambda payload, codec: payload)

    def test_decodes_an_independent_jpeg_without_prior_decoder_state(self) -> None:
        decoded = self.decoder.decode(self.reference(sequence_no=3), b"jpeg-3")

        self.assertEqual(b"jpeg-3", decoded.image)
        self.assertEqual(3, decoded.reference.sequence_no)

    def test_decodes_a_jpeg_after_a_sequence_gap(self) -> None:
        _ = self.decoder.decode(self.reference(sequence_no=1), b"jpeg-1")

        decoded = self.decoder.decode(self.reference(sequence_no=3), b"jpeg-3")

        self.assertEqual(b"jpeg-3", decoded.image)

    def test_fresh_decoder_decodes_the_next_jpeg_after_a_restart(self) -> None:
        restarted_decoder = FrameDecoder(decode_payload=lambda payload, codec: payload)

        decoded = restarted_decoder.decode(self.reference(sequence_no=7), b"jpeg-7")

        self.assertEqual(b"jpeg-7", decoded.image)

    @staticmethod
    def reference(sequence_no: int) -> FrameReference:
        return FrameReference(
            session_id="session-1",
            sequence_no=sequence_no,
            blob_path=f"sessions/session-1/frames/{sequence_no:06d}.bin",
            captured_at=datetime(2026, 6, 14, 10, 0, tzinfo=UTC),
            received_at=datetime(2026, 6, 14, 10, 0, tzinfo=UTC),
            video_time_sec=0.0,
            codec="image/jpeg",
        )
