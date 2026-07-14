using System.Text.Json;
using System.Text.Json.Serialization;
using Awaver.Backend.Services;

namespace Awaver.Backend.WebSockets;

public static class FrameMessageParser
{
    public const int MaxPayloadBase64Characters = 1_400_000;
    public const int MaxDecodedJpegBytes = 1_000_000;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };

    public static bool TryParse(
        string message,
        Guid expectedSessionId,
        DateTimeOffset receivedAt,
        out ReceivedFrame? frame,
        out string? error)
    {
        frame = null;
        error = null;

        FrameWebSocketMessage? parsed;
        try
        {
            parsed = JsonSerializer.Deserialize<FrameWebSocketMessage>(message, JsonOptions);
        }
        catch (JsonException)
        {
            error = "Invalid JSON frame message.";
            return false;
        }

        if (parsed is null)
        {
            error = "Frame message is empty.";
            return false;
        }

        if (parsed.SessionId == Guid.Empty || parsed.SessionId != expectedSessionId)
        {
            error = "sessionId does not match WebSocket path.";
            return false;
        }

        if (parsed.SequenceNo <= 0)
        {
            error = "sequenceNo must be positive.";
            return false;
        }


        if (!string.Equals(parsed.Codec, "image/jpeg", StringComparison.Ordinal))
        {
            error = "codec must be image/jpeg.";
            return false;
        }

        if (parsed.CapturedAt == default || parsed.CapturedAt.Offset != TimeSpan.Zero)
        {
            error = "capturedAt is required and must be a UTC timestamp.";
            return false;
        }

        if (parsed.VideoTimeSec is not { } videoTimeSec || !double.IsFinite(videoTimeSec) || videoTimeSec < 0)
        {
            error = "videoTimeSec is required and must be a finite value greater than or equal to 0.";
            return false;
        }

        if (string.IsNullOrWhiteSpace(parsed.PayloadBase64) || parsed.PayloadBase64.Length > MaxPayloadBase64Characters || parsed.PayloadBase64.Any(char.IsWhiteSpace))
        {
            error = "payloadBase64 exceeds the allowed size or contains invalid whitespace.";
            return false;
        }

        byte[] payload;
        try
        {
            payload = Convert.FromBase64String(parsed.PayloadBase64);
        }
        catch (FormatException)
        {
            error = "payloadBase64 must be valid Base64.";
            return false;
        }

        if (payload.Length == 0 || payload.Length > MaxDecodedJpegBytes)
        {
            error = "decoded JPEG payload exceeds the allowed size.";
            return false;
        }

        if (payload.Length < 4 || payload[0] != 0xff || payload[1] != 0xd8 || payload[2] != 0xff || payload[^2] != 0xff || payload[^1] != 0xd9)
        {
            error = "payloadBase64 must contain a JPEG image.";
            return false;
        }

        frame = new ReceivedFrame(
            parsed.SessionId,
            parsed.SequenceNo,
            parsed.CapturedAt,
            videoTimeSec,
            receivedAt,
            parsed.Codec,
            payload);

        return true;
    }
}
