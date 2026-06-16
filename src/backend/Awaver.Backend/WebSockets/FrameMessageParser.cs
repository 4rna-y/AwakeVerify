using System.Text.Json;
using Awaver.Backend.Services;

namespace Awaver.Backend.WebSockets;

public static class FrameMessageParser
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

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

        if (parsed.SessionId != expectedSessionId)
        {
            error = "sessionId does not match WebSocket path.";
            return false;
        }

        if (parsed.SequenceNo <= 0)
        {
            error = "sequenceNo must be positive.";
            return false;
        }

        if (parsed.BaseIFrameSequenceNo <= 0)
        {
            error = "baseIFrameSequenceNo must be positive.";
            return false;
        }

        if (!Enum.TryParse<FrameType>(parsed.FrameType, ignoreCase: false, out var frameType))
        {
            error = "frameType must be I or P.";
            return false;
        }

        if (frameType == FrameType.I && parsed.BaseIFrameSequenceNo != parsed.SequenceNo)
        {
            error = "I frame baseIFrameSequenceNo must equal sequenceNo.";
            return false;
        }

        if (frameType == FrameType.P && parsed.BaseIFrameSequenceNo >= parsed.SequenceNo)
        {
            error = "P frame baseIFrameSequenceNo must be lower than sequenceNo.";
            return false;
        }

        if (string.IsNullOrWhiteSpace(parsed.Codec))
        {
            error = "codec is required.";
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

        if (payload.Length == 0)
        {
            error = "payloadBase64 must not be empty.";
            return false;
        }

        frame = new ReceivedFrame(
            parsed.SessionId,
            parsed.SequenceNo,
            frameType,
            parsed.BaseIFrameSequenceNo,
            parsed.CapturedAt,
            receivedAt,
            parsed.Codec.Trim(),
            payload);

        return true;
    }
}
