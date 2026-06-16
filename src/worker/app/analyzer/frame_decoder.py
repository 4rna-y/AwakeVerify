from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from importlib import import_module
from typing import Any, Callable, Literal, cast

FrameType = Literal["I", "P"]


@dataclass(frozen=True)
class FrameReference:
    session_id: str
    sequence_no: int
    frame_type: FrameType
    base_i_frame_sequence_no: int
    blob_path: str
    captured_at: datetime
    received_at: datetime
    codec: str


@dataclass
class DecoderState:
    base_i_frame_sequence_no: int
    last_sequence_no: int
    accepting_p_frames: bool = True


@dataclass(frozen=True)
class DecodedFrame:
    reference: FrameReference
    image: object


class FrameDecodeError(Exception):
    pass


class UnsupportedCodecError(FrameDecodeError):
    pass


class FrameDecoder:
    def __init__(
        self, decode_payload: Callable[[bytes, str], object] | None = None
    ) -> None:
        self._states: dict[str, DecoderState] = {}
        self._decode_payload: Callable[[bytes, str], object] = (
            decode_payload or decode_frame_payload
        )

    def decode(self, reference: FrameReference, payload: bytes) -> DecodedFrame | None:
        self._validate_reference(reference)

        if reference.frame_type == "I":
            image = self._decode_payload(payload, reference.codec)
            self._states[reference.session_id] = DecoderState(
                base_i_frame_sequence_no=reference.sequence_no,
                last_sequence_no=reference.sequence_no,
                accepting_p_frames=True,
            )
            return DecodedFrame(reference=reference, image=image)

        state = self._states.get(reference.session_id)
        if state is None or not state.accepting_p_frames:
            return None

        is_expected_p_frame = (
            reference.base_i_frame_sequence_no == state.base_i_frame_sequence_no
            and reference.sequence_no == state.last_sequence_no + 1
        )
        if not is_expected_p_frame:
            state.accepting_p_frames = False
            return None

        image = self._decode_payload(payload, reference.codec)
        state.last_sequence_no = reference.sequence_no
        return DecodedFrame(reference=reference, image=image)

    @staticmethod
    def _validate_reference(reference: FrameReference) -> None:
        if reference.sequence_no <= 0:
            raise FrameDecodeError("sequence_no must be positive")
        if reference.base_i_frame_sequence_no <= 0:
            raise FrameDecodeError("base_i_frame_sequence_no must be positive")
        if (
            reference.frame_type == "I"
            and reference.base_i_frame_sequence_no != reference.sequence_no
        ):
            raise FrameDecodeError(
                "I frame base_i_frame_sequence_no must equal sequence_no"
            )
        if (
            reference.frame_type == "P"
            and reference.base_i_frame_sequence_no >= reference.sequence_no
        ):
            raise FrameDecodeError(
                "P frame base_i_frame_sequence_no must be lower than sequence_no"
            )


def decode_frame_payload(payload: bytes, codec: str) -> object:
    normalized_codec = codec.strip().lower()
    if normalized_codec not in {"image/jpeg", "image/jpg"}:
        raise UnsupportedCodecError(f"unsupported frame codec: {codec}")

    cv2 = cast(Any, import_module("cv2"))
    np = cast(Any, import_module("numpy"))

    buffer = np.frombuffer(payload, dtype=np.uint8)
    image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    if image is None:
        raise FrameDecodeError("failed to decode image/jpeg frame")

    return image
