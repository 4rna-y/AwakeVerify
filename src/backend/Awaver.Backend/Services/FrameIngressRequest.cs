using System.Globalization;
using Microsoft.Extensions.Primitives;

namespace Awaver.Backend.Services;

public static class FrameIngressRequest
{
    public const int MaxJpegBytes = 1_000_000;

    public static bool TryCreate(
        Guid sessionId,
        int sequenceNo,
        string? contentType,
        StringValues capturedAtHeader,
        StringValues videoTimeSecHeader,
        byte[] payload,
        DateTimeOffset receivedAt,
        out ReceivedFrame? frame,
        out string? error)
    {
        frame = null;
        error = null;

        if (sequenceNo <= 0)
        {
            error = "sequenceNo must be positive.";
            return false;
        }
        if (!string.Equals(contentType, "image/jpeg", StringComparison.OrdinalIgnoreCase))
        {
            error = "Content-Type must be image/jpeg.";
            return false;
        }
        if (!TryGetSingleHeader(capturedAtHeader, out var capturedAtText) ||
            !DateTimeOffset.TryParse(capturedAtText, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var capturedAt) ||
            capturedAt.Offset != TimeSpan.Zero)
        {
            error = "X-Frame-Captured-At is required and must be a UTC timestamp.";
            return false;
        }
        if (!TryGetSingleHeader(videoTimeSecHeader, out var videoTimeText) ||
            !double.TryParse(videoTimeText, NumberStyles.Float, CultureInfo.InvariantCulture, out var videoTimeSec) ||
            !double.IsFinite(videoTimeSec) || videoTimeSec < 0)
        {
            error = "X-Frame-Video-Time-Sec is required and must be a finite value greater than or equal to 0.";
            return false;
        }
        if (payload.Length == 0 || payload.Length > MaxJpegBytes || !IsJpeg(payload))
        {
            error = "Request body must contain a JPEG image no larger than 1 MiB.";
            return false;
        }

        frame = new ReceivedFrame(sessionId, sequenceNo, capturedAt, videoTimeSec, receivedAt, "image/jpeg", payload);
        return true;
    }

    public static async Task<byte[]> ReadBoundedAsync(Stream body, long? contentLength, CancellationToken cancellationToken)
    {
        if (contentLength is > MaxJpegBytes) throw new FramePayloadTooLargeException();

        using var buffer = new MemoryStream(contentLength is > 0 and <= MaxJpegBytes ? (int)contentLength.Value : 0);
        var readBuffer = new byte[16 * 1024];
        while (true)
        {
            var read = await body.ReadAsync(readBuffer.AsMemory(), cancellationToken);
            if (read == 0) break;
            if (buffer.Length + read > MaxJpegBytes) throw new FramePayloadTooLargeException();
            await buffer.WriteAsync(readBuffer.AsMemory(0, read), cancellationToken);
        }
        return buffer.ToArray();
    }

    private static bool TryGetSingleHeader(StringValues values, out string value)
    {
        value = values.ToString();
        return values.Count == 1 && !string.IsNullOrWhiteSpace(value);
    }

    private static bool IsJpeg(byte[] payload) => payload.Length >= 4 &&
        payload[0] == 0xff && payload[1] == 0xd8 && payload[2] == 0xff &&
        payload[^2] == 0xff && payload[^1] == 0xd9;
}

public sealed class FramePayloadTooLargeException : Exception;
