from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol, cast, final


PERCLOS_KEY_PREFIX = "perclos:"
PERCLOS_KEY_SUFFIX = ":frames"
PROCESSED_FRAME_KEY_PREFIX = "processed:"
PROCESSED_FRAME_KEY_SUFFIX = ":frame:"
PERCLOS_WINDOW_SIZE = 75
PERCLOS_WINDOW_SECONDS = 15
MINIMUM_TTL_SECONDS = 24 * 60 * 60


class RedisClient(Protocol):
    def eval(self, script: str, numkeys: int, *keys_and_args: object) -> object: ...


class RedisPerclosError(RuntimeError):
    """Raised when the worker cannot atomically update PERCLOS state."""


class RedisProcessedFrameError(RuntimeError):
    """Raised when the durable frame idempotency state cannot be updated."""


@dataclass(frozen=True)
class PerclosFrame:
    sequence_no: int
    captured_at: datetime
    is_closed: bool


@dataclass(frozen=True)
class PerclosWindowUpdate:
    frames: tuple[PerclosFrame, ...]
    duplicate: bool

    @property
    def perclos(self) -> float:
        if not self.frames:
            return 0.0
        return sum(frame.is_closed for frame in self.frames) / len(self.frames)


# The script deliberately keeps de-duplication, time-based eviction, and mutation
# on the same Redis key. A repeated delivery therefore observes the exact same
# window that the first delivery produced, even when a different worker receives it.
# Frames arrive serially through a Service Bus Session, so list order is captured-time
# order (newest first); expired frames are consequently a suffix of the list.
PERCLOS_APPEND_SCRIPT = """
local existing = redis.call('LRANGE', KEYS[1], 0, -1)
local cutoff_ms = tonumber(ARGV[5]) - tonumber(ARGV[6])
local retained_count = 0
for _, item in ipairs(existing) do
  local decoded = cjson.decode(item)
  if tonumber(decoded.capturedAtUnixMs) >= cutoff_ms then
    retained_count = retained_count + 1
  else
    break
  end
end
if retained_count == 0 and #existing > 0 then
  redis.call('DEL', KEYS[1])
elseif retained_count < #existing then
  redis.call('LTRIM', KEYS[1], 0, retained_count - 1)
end

local retained = redis.call('LRANGE', KEYS[1], 0, -1)
local duplicate = 0
for _, item in ipairs(retained) do
  local decoded = cjson.decode(item)
  if decoded.sequenceNo == tonumber(ARGV[1]) then
    duplicate = 1
    break
  end
end

if duplicate == 0 then
  redis.call('LPUSH', KEYS[1], ARGV[2])
  redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[3]) - 1)
end

local frames = redis.call('LRANGE', KEYS[1], 0, -1)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
return {duplicate, frames}
"""

PROCESSED_FRAME_SCRIPT = """
if redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1]) then
  return 0
end
return 1
"""

PROCESSED_FRAME_EXISTS_SCRIPT = "return redis.call('EXISTS', KEYS[1])"


@final
class RedisPerclosWindow:
    def __init__(
        self,
        client: RedisClient,
        *,
        ttl_seconds: int = MINIMUM_TTL_SECONDS,
        window_size: int = PERCLOS_WINDOW_SIZE,
        window_seconds: int = PERCLOS_WINDOW_SECONDS,
    ) -> None:
        if ttl_seconds < MINIMUM_TTL_SECONDS:
            raise ValueError("perclos TTL must be at least 24 hours")
        if window_size <= 0:
            raise ValueError("perclos window_size must be positive")
        if window_seconds <= 0:
            raise ValueError("perclos window_seconds must be positive")
        self._client = client
        self._ttl_seconds = ttl_seconds
        self._window_size = window_size
        self._window_milliseconds = window_seconds * 1_000

    def append(
        self,
        *,
        session_id: str,
        sequence_no: int,
        captured_at: datetime,
        is_closed: bool,
    ) -> PerclosWindowUpdate:
        record = json.dumps(
            {
                "sequenceNo": sequence_no,
                "capturedAt": captured_at.isoformat().replace("+00:00", "Z"),
                "capturedAtUnixMs": int(captured_at.timestamp() * 1_000),
                "isClosed": is_closed,
            },
            separators=(",", ":"),
        )
        try:
            response = self._client.eval(
                PERCLOS_APPEND_SCRIPT,
                1,
                self.key_for(session_id),
                sequence_no,
                record,
                self._window_size,
                self._ttl_seconds,
                int(captured_at.timestamp() * 1_000),
                self._window_milliseconds,
            )
            return self._parse_response(cast(list[object], response))
        except RedisPerclosError:
            raise
        except Exception as error:
            raise RedisPerclosError("unable to update PERCLOS Redis state") from error

    def close(self) -> None:
        close = getattr(self._client, "close", None)
        if callable(close):
            _ = close()

    @staticmethod
    def key_for(session_id: str) -> str:
        return f"{PERCLOS_KEY_PREFIX}{session_id}{PERCLOS_KEY_SUFFIX}"

    @staticmethod
    def _parse_response(response: list[object]) -> PerclosWindowUpdate:
        if len(response) != 2:
            raise RedisPerclosError("unexpected PERCLOS Lua response")

        duplicate_value = response[0]
        stored_frames = response[1]
        if not isinstance(stored_frames, list):
            raise RedisPerclosError("unexpected PERCLOS Lua frame response")

        frames: list[PerclosFrame] = []
        for item in cast(list[object], stored_frames):
            text: object = item.decode("utf-8") if isinstance(item, bytes) else item
            if not isinstance(text, str):
                raise RedisPerclosError("PERCLOS Redis frame is not JSON text")
            decoded = cast(object, json.loads(text))
            if not isinstance(decoded, dict):
                raise RedisPerclosError("PERCLOS Redis frame must be a JSON object")
            payload = cast(dict[str, object], decoded)
            sequence_no = payload.get("sequenceNo")
            captured_at = payload.get("capturedAt")
            is_closed = payload.get("isClosed")
            if (
                not isinstance(sequence_no, int)
                or not isinstance(captured_at, str)
                or not isinstance(is_closed, bool)
            ):
                raise RedisPerclosError("PERCLOS Redis frame has invalid fields")
            frames.append(
                PerclosFrame(
                    sequence_no=sequence_no,
                    captured_at=datetime.fromisoformat(captured_at.replace("Z", "+00:00")),
                    is_closed=is_closed,
                )
            )

        return PerclosWindowUpdate(
            frames=tuple(frames),
            duplicate=bool(duplicate_value),
        )


@final
class RedisProcessedFrameStore:
    """Durable session/sequence idempotency independent of the PERCLOS window."""

    def __init__(self, client: RedisClient, *, ttl_seconds: int = MINIMUM_TTL_SECONDS) -> None:
        if ttl_seconds < MINIMUM_TTL_SECONDS:
            raise ValueError("processed frame TTL must be at least 24 hours")
        self._client = client
        self._ttl_seconds = ttl_seconds

    def mark_processed(self, *, session_id: str, sequence_no: int) -> bool:
        """Return True when this is the first durable completion of the frame."""
        try:
            response = self._client.eval(
                PROCESSED_FRAME_SCRIPT,
                1,
                self.key_for(session_id, sequence_no),
                self._ttl_seconds,
            )
            return int(cast(int | str | bytes, response)) == 0
        except Exception as error:
            raise RedisProcessedFrameError("unable to update processed frame state") from error

    def is_processed(self, *, session_id: str, sequence_no: int) -> bool:
        try:
            response = self._client.eval(
                PROCESSED_FRAME_EXISTS_SCRIPT,
                1,
                self.key_for(session_id, sequence_no),
            )
            return int(cast(int | str | bytes, response)) == 1
        except Exception as error:
            raise RedisProcessedFrameError("unable to read processed frame state") from error

    def close(self) -> None:
        close = getattr(self._client, "close", None)
        if callable(close):
            _ = close()

    @staticmethod
    def key_for(session_id: str, sequence_no: int) -> str:
        return f"{PROCESSED_FRAME_KEY_PREFIX}{session_id}{PROCESSED_FRAME_KEY_SUFFIX}{sequence_no}"
