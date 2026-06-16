# pyright: reportImplicitRelativeImport=false, reportUninitializedInstanceVariable=false, reportImplicitOverride=false
from __future__ import annotations

from datetime import UTC, datetime
from unittest import TestCase

from app.analyzer.frame_decoder import FrameDecoder, FrameReference, FrameType


class FrameDecoderTests(TestCase):
    decoder: FrameDecoder

    def setUp(self) -> None:
        self.decoder = FrameDecoder(decode_payload=lambda payload, codec: payload)

    def test_i_frame_resets_session_decoder_state(self) -> None:
        reference = self.reference(
            sequence_no=1, frame_type="I", base_i_frame_sequence_no=1
        )

        decoded = self.decoder.decode(reference, b"iframe")

        assert decoded is not None
        self.assertEqual(b"iframe", decoded.image)

    def test_p_frame_after_expected_i_frame_is_decoded(self) -> None:
        _ = self.decoder.decode(
            self.reference(sequence_no=1, frame_type="I", base_i_frame_sequence_no=1),
            b"iframe",
        )

        decoded = self.decoder.decode(
            self.reference(sequence_no=2, frame_type="P", base_i_frame_sequence_no=1),
            b"pframe",
        )

        assert decoded is not None
        self.assertEqual(b"pframe", decoded.image)

    def test_p_frame_before_i_frame_is_discarded(self) -> None:
        decoded = self.decoder.decode(
            self.reference(sequence_no=2, frame_type="P", base_i_frame_sequence_no=1),
            b"pframe",
        )

        self.assertIsNone(decoded)

    def test_missing_p_frame_discards_rest_of_gop_until_next_i_frame(self) -> None:
        _ = self.decoder.decode(
            self.reference(sequence_no=1, frame_type="I", base_i_frame_sequence_no=1),
            b"iframe",
        )

        missing_sequence_decoded = self.decoder.decode(
            self.reference(sequence_no=3, frame_type="P", base_i_frame_sequence_no=1),
            b"pframe-3",
        )
        later_p_decoded = self.decoder.decode(
            self.reference(sequence_no=4, frame_type="P", base_i_frame_sequence_no=1),
            b"pframe-4",
        )
        next_i_decoded = self.decoder.decode(
            self.reference(sequence_no=6, frame_type="I", base_i_frame_sequence_no=6),
            b"iframe-6",
        )

        self.assertIsNone(missing_sequence_decoded)
        self.assertIsNone(later_p_decoded)
        assert next_i_decoded is not None
        self.assertEqual(b"iframe-6", next_i_decoded.image)

    @staticmethod
    def reference(
        sequence_no: int, frame_type: FrameType, base_i_frame_sequence_no: int
    ) -> FrameReference:
        return FrameReference(
            session_id="session-1",
            sequence_no=sequence_no,
            frame_type=frame_type,
            base_i_frame_sequence_no=base_i_frame_sequence_no,
            blob_path=f"sessions/session-1/frames/{sequence_no:06d}_{frame_type}.bin",
            captured_at=datetime(2026, 6, 14, 10, 0, tzinfo=UTC),
            received_at=datetime(2026, 6, 14, 10, 0, tzinfo=UTC),
            codec="image/jpeg",
        )
