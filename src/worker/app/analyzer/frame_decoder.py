from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from importlib import import_module
from typing import Any, Callable, cast


@dataclass(frozen=True)
class FrameReference:
    session_id: str
    sequence_no: int
    blob_path: str
    captured_at: datetime
    received_at: datetime
    video_time_sec: float
    codec: str


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
        self._decode_payload: Callable[[bytes, str], object] = (
            decode_payload or decode_frame_payload
        )

    def decode(self, reference: FrameReference, payload: bytes) -> DecodedFrame:
        self._validate_reference(reference)
        image = self._decode_payload(payload, reference.codec)
        return DecodedFrame(reference=reference, image=image)

    @staticmethod
    def _validate_reference(reference: FrameReference) -> None:
        if reference.sequence_no <= 0:
            raise FrameDecodeError("sequence_no must be positive")


def decode_frame_payload(payload: bytes, codec: str) -> object:
    if codec.strip().lower() != "image/jpeg":
        raise UnsupportedCodecError(f"unsupported frame codec: {codec}")

    cv2 = cast(Any, import_module("cv2"))
    np = cast(Any, import_module("numpy"))

    buffer = np.frombuffer(payload, dtype=np.uint8)
    image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    if image is None:
        raise FrameDecodeError("failed to decode image/jpeg frame")

    return image
