from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol, cast, final


PERCLOS_KEY_PREFIX = "perclos:"
PERCLOS_KEY_SUFFIX = ":frames"
PROCESSED_FRAME_KEY_PREFIX = "processed:"
PROCESSED_FRAME_KEY_SUFFIX = ":frame:"
SCORE_AGGREGATION_KEY_PREFIX = "score-aggregation:"
SCORE_AGGREGATION_KEY_SUFFIX = ":state"
PERCLOS_WINDOW_SIZE = 75
PERCLOS_WINDOW_SECONDS = 15
MINIMUM_TTL_SECONDS = 24 * 60 * 60


class RedisClient(Protocol):
    def eval(self, script: str, numkeys: int, *keys_and_args: object) -> object: ...


class RedisPerclosError(RuntimeError):
    """Raised when the worker cannot atomically update PERCLOS state."""


class RedisProcessedFrameError(RuntimeError):
    """Raised when the durable frame idempotency state cannot be updated."""


class RedisScoreAggregationError(RuntimeError):
    """Raised when the worker cannot atomically update score aggregation state."""


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


@dataclass(frozen=True)
class PendingScoreAggregation:
    window_unix_second: int
    sample_records: tuple[str, ...]


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


# A Worker slot does not own a Session permanently. Keep both the current second's
# samples and sealed-but-unacknowledged seconds in Redis so a later slot publishes
# the identical aggregate instead of constructing another score for the same second.
SCORE_AGGREGATION_ADVANCE_SCRIPT = """
local state_json = redis.call('GET', KEYS[1])
local current_window = tonumber(ARGV[1])
local sample_record = ARGV[2]
local maximum_samples = tonumber(ARGV[3])
local ttl_seconds = tonumber(ARGV[4])
local state

if state_json then
  state = cjson.decode(state_json)
else
  state = { currentWindowUnixSecond = current_window, samples = {}, pending = {} }
end

state.samples = state.samples or {}
state.pending = state.pending or {}
local stored_window = tonumber(state.currentWindowUnixSecond)
if not stored_window then
  return redis.error_reply('score aggregation state has no current window')
end

if current_window > stored_window then
  if #state.samples > 0 then
    table.insert(state.pending, { windowUnixSecond = stored_window, samples = state.samples })
  end
  state.currentWindowUnixSecond = current_window
  state.samples = {}
elseif current_window < stored_window then
  sample_record = ''
end

if sample_record ~= '' then
  local sample = cjson.decode(sample_record)
  local duplicate = false
  for _, existing in ipairs(state.samples) do
    if cjson.decode(existing).sequenceNo == sample.sequenceNo then
      duplicate = true
      break
    end
  end
  if not duplicate and #state.samples < maximum_samples then
    table.insert(state.samples, sample_record)
  end
end

redis.call('SET', KEYS[1], cjson.encode(state), 'EX', ttl_seconds)
return cjson.encode(state.pending)
"""

SCORE_AGGREGATION_ACK_SCRIPT = """
local state_json = redis.call('GET', KEYS[1])
if not state_json then
  return 0
end
local state = cjson.decode(state_json)
state.pending = state.pending or {}
local acknowledged_window = tonumber(ARGV[1])
local retained = {}
local removed = 0
for _, pending in ipairs(state.pending) do
  if tonumber(pending.windowUnixSecond) == acknowledged_window then
    removed = removed + 1
  else
    table.insert(retained, pending)
  end
end
state.pending = retained
redis.call('SET', KEYS[1], cjson.encode(state), 'EX', tonumber(ARGV[2]))
return removed
"""

SCORE_AGGREGATION_CLEAR_SCRIPT = "return redis.call('DEL', KEYS[1])"


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


@final
class RedisScoreAggregationWindow:
    """Durable one-score-per-captured-second aggregation shared by Worker slots."""

    def __init__(self, client: RedisClient, *, ttl_seconds: int = MINIMUM_TTL_SECONDS, maximum_samples: int = 5) -> None:
        if ttl_seconds < MINIMUM_TTL_SECONDS:
            raise ValueError("score aggregation TTL must be at least 24 hours")
        if maximum_samples <= 0:
            raise ValueError("score aggregation maximum_samples must be positive")
        self._client = client
        self._ttl_seconds = ttl_seconds
        self._maximum_samples = maximum_samples

    def advance(
        self,
        *,
        session_id: str,
        captured_at: datetime,
        sample_record: str | None,
    ) -> tuple[PendingScoreAggregation, ...]:
        try:
            response = self._client.eval(
                SCORE_AGGREGATION_ADVANCE_SCRIPT,
                1,
                self.key_for(session_id),
                int(captured_at.timestamp()),
                sample_record or "",
                self._maximum_samples,
                self._ttl_seconds,
            )
            return self._parse_pending(response)
        except RedisScoreAggregationError:
            raise
        except Exception as error:
            raise RedisScoreAggregationError("unable to update score aggregation Redis state") from error

    def acknowledge(self, *, session_id: str, window_unix_second: int) -> bool:
        try:
            response = self._client.eval(
                SCORE_AGGREGATION_ACK_SCRIPT,
                1,
                self.key_for(session_id),
                window_unix_second,
                self._ttl_seconds,
            )
            return int(cast(int | str | bytes, response)) == 1
        except Exception as error:
            raise RedisScoreAggregationError("unable to acknowledge score aggregation Redis state") from error

    def clear(self, *, session_id: str) -> None:
        try:
            _ = self._client.eval(SCORE_AGGREGATION_CLEAR_SCRIPT, 1, self.key_for(session_id))
        except Exception as error:
            raise RedisScoreAggregationError("unable to clear score aggregation Redis state") from error

    def close(self) -> None:
        close = getattr(self._client, "close", None)
        if callable(close):
            _ = close()

    @staticmethod
    def key_for(session_id: str) -> str:
        return f"{SCORE_AGGREGATION_KEY_PREFIX}{session_id}{SCORE_AGGREGATION_KEY_SUFFIX}"

    @staticmethod
    def _parse_pending(response: object) -> tuple[PendingScoreAggregation, ...]:
        text: object = response.decode("utf-8") if isinstance(response, bytes) else response
        if not isinstance(text, str):
            raise RedisScoreAggregationError("unexpected score aggregation Lua response")
        decoded = cast(object, json.loads(text))
        # Redis Lua cjson encodes an empty table as `{}` rather than `[]`.
        # `pending` is semantically an array, but an empty response means that
        # no completed score window is awaiting publication.
        if decoded == {}:
            return ()
        if not isinstance(decoded, list):
            raise RedisScoreAggregationError("score aggregation pending state must be an array")

        pending: list[PendingScoreAggregation] = []
        for item in decoded:
            if not isinstance(item, dict):
                raise RedisScoreAggregationError("score aggregation pending entry must be an object")
            window = item.get("windowUnixSecond")
            samples = item.get("samples")
            if not isinstance(window, int) or not isinstance(samples, list) or not 1 <= len(samples) <= 5 or not all(isinstance(sample, str) for sample in samples):
                raise RedisScoreAggregationError("score aggregation pending entry has invalid fields")
            pending.append(PendingScoreAggregation(window_unix_second=window, sample_records=tuple(samples)))
        return tuple(pending)
