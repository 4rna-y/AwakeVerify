using System.Text.Json;
using Awaver.Backend.Services;
using Awaver.Backend.WebSockets;

namespace Awaver.Backend.Tests;

public class UnitTest1
{
    [Fact]
    public async Task StartSessionAsync_CreatesUniqueLearningSessionsForSameStudent()
    {
        var repository = new InMemorySessionRepository();

        var first = await repository.StartSessionAsync(" s12345 ", CancellationToken.None);
        var second = await repository.StartSessionAsync("s12345", CancellationToken.None);

        Assert.Equal("s12345", first.StudentId);
        Assert.Equal("s12345", second.StudentId);
        Assert.NotEqual(first.SessionId, second.SessionId);
        Assert.True(await repository.SessionExistsAsync(first.SessionId, CancellationToken.None));
        Assert.True(await repository.SessionExistsAsync(second.SessionId, CancellationToken.None));
    }

    [Fact]
    public void TryParse_AcceptsValidIndependentJpegMessage()
    {
        var sessionId = Guid.NewGuid();
        var message = JsonSerializer.Serialize(new
        {
            sessionId,
            sequenceNo = 1,
            capturedAt = DateTimeOffset.Parse("2026-06-14T10:00:00Z"),
            videoTimeSec = 12.5,
            codec = "image/jpeg",
            payloadBase64 = Convert.ToBase64String([0xff, 0xd8, 0xff, 0xd9]),
        });

        var result = FrameMessageParser.TryParse(
            message,
            sessionId,
            DateTimeOffset.Parse("2026-06-14T10:00:00.050Z"),
            out var frame,
            out var error);

        Assert.True(result, error);
        Assert.NotNull(frame);
        Assert.Equal(sessionId, frame.SessionId);
        Assert.Equal(1, frame.SequenceNo);
        Assert.Equal(DateTimeOffset.Parse("2026-06-14T10:00:00Z"), frame.CapturedAt);
        Assert.Equal(12.5, frame.VideoTimeSec);
        Assert.Equal("image/jpeg", frame.Codec);
        Assert.Equal([0xff, 0xd8, 0xff, 0xd9], frame.Payload);
    }

    [Theory]
    [InlineData("frameType", "I")]
    [InlineData("baseIFrameSequenceNo", 1)]
    public void TryParse_RejectsLegacyFrameProperties(string propertyName, object propertyValue)
    {
        var sessionId = Guid.NewGuid();
        var properties = new Dictionary<string, object?>
        {
            ["sessionId"] = sessionId,
            ["sequenceNo"] = 1,
            ["capturedAt"] = DateTimeOffset.Parse("2026-06-14T10:00:00Z"),
            ["videoTimeSec"] = 12.5,
            ["codec"] = "image/jpeg",
            ["payloadBase64"] = Convert.ToBase64String([0xff, 0xd8, 0xff, 0xd9]),
            [propertyName] = propertyValue,
        };

        var result = FrameMessageParser.TryParse(
            JsonSerializer.Serialize(properties),
            sessionId,
            DateTimeOffset.UtcNow,
            out var frame,
            out var error);

        Assert.False(result);
        Assert.Null(frame);
        Assert.Equal("Invalid JSON frame message.", error);
    }

    [Fact]
    public void TryParse_RejectsMismatchedSessionId()
    {
        var message = JsonSerializer.Serialize(new
        {
            sessionId = Guid.NewGuid(),
            sequenceNo = 1,
            capturedAt = DateTimeOffset.Parse("2026-06-14T10:00:00Z"),
            videoTimeSec = 12.5,
            codec = "image/jpeg",
            payloadBase64 = Convert.ToBase64String([0xff, 0xd8, 0xff, 0xd9]),
        });

        var result = FrameMessageParser.TryParse(
            message,
            Guid.NewGuid(),
            DateTimeOffset.UtcNow,
            out var frame,
            out var error);

        Assert.False(result);
        Assert.Null(frame);
        Assert.Equal("sessionId does not match WebSocket path.", error);
    }

    [Fact]
    public void TryParse_RejectsNonUtcCodecAndNonJpegPayloads()
    {
        var sessionId = Guid.NewGuid();
        var baseMessage = new
        {
            sessionId,
            sequenceNo = 1,
            capturedAt = DateTimeOffset.Parse("2026-06-14T10:00:00Z"),
            videoTimeSec = 12.5,
            codec = "image/png",
            payloadBase64 = Convert.ToBase64String([0xff, 0xd8, 0xff, 0xd9]),
        };

        Assert.False(FrameMessageParser.TryParse(JsonSerializer.Serialize(baseMessage), sessionId, DateTimeOffset.UtcNow, out _, out var codecError));
        Assert.Equal("codec must be image/jpeg.", codecError);

        var invalidPayload = JsonSerializer.Serialize(new
        {
            baseMessage.sessionId,
            baseMessage.sequenceNo,
            baseMessage.capturedAt,
            baseMessage.videoTimeSec,
            codec = "image/jpeg",
            payloadBase64 = Convert.ToBase64String([1, 2, 3, 4]),
        });
        Assert.False(FrameMessageParser.TryParse(invalidPayload, sessionId, DateTimeOffset.UtcNow, out _, out var payloadError));
        Assert.Equal("payloadBase64 must contain a JPEG image.", payloadError);

        var localTimestamp = JsonSerializer.Serialize(new
        {
            baseMessage.sessionId,
            baseMessage.sequenceNo,
            capturedAt = DateTimeOffset.Parse("2026-06-14T10:00:00+09:00"),
            baseMessage.videoTimeSec,
            codec = "image/jpeg",
            payloadBase64 = Convert.ToBase64String([0xff, 0xd8, 0xff, 0xd9]),
        });
        Assert.False(FrameMessageParser.TryParse(localTimestamp, sessionId, DateTimeOffset.UtcNow, out _, out var timestampError));
        Assert.Equal("capturedAt is required and must be a UTC timestamp.", timestampError);
    }

    [Fact]
    public void TryParse_RejectsMissingOrNegativeVideoTimeSec()
    {
        var sessionId = Guid.NewGuid();
        var missingVideoTime = JsonSerializer.Serialize(new
        {
            sessionId,
            sequenceNo = 1,
            capturedAt = DateTimeOffset.Parse("2026-06-14T10:00:00Z"),
            codec = "image/jpeg",
            payloadBase64 = Convert.ToBase64String([0xff, 0xd8, 0xff, 0xd9]),
        });
        var negativeVideoTime = JsonSerializer.Serialize(new
        {
            sessionId,
            sequenceNo = 1,
            capturedAt = DateTimeOffset.Parse("2026-06-14T10:00:00Z"),
            videoTimeSec = -0.1,
            codec = "image/jpeg",
            payloadBase64 = Convert.ToBase64String([0xff, 0xd8, 0xff, 0xd9]),
        });

        Assert.False(FrameMessageParser.TryParse(missingVideoTime, sessionId, DateTimeOffset.UtcNow, out _, out var missingError));
        Assert.Equal("videoTimeSec is required and must be a finite value greater than or equal to 0.", missingError);
        Assert.False(FrameMessageParser.TryParse(negativeVideoTime, sessionId, DateTimeOffset.UtcNow, out _, out var negativeError));
        Assert.Equal("videoTimeSec is required and must be a finite value greater than or equal to 0.", negativeError);
    }

    [Fact]
    public void FrameBlobPath_Create_UsesZeroPaddedSequenceNumber()
    {
        var frame = CreateFrame(sequenceNo: 123);

        var path = FrameBlobPath.Create(frame);

        Assert.Equal($"sessions/{frame.SessionId}/frames/000123.bin", path);
    }

    [Fact]
    public async Task HandleAsync_ForwardsIndependentJpegMetadataToQueueJson()
    {
        var frame = CreateFrame();
        var storage = new RecordingFrameStorage();
        var queue = new RecordingFrameQueue();

        await new FramePipeline(storage, queue).HandleAsync(frame, CancellationToken.None);

        Assert.Same(frame, storage.SavedFrame);
        var queueMessage = Assert.IsType<FrameQueueMessage>(queue.EnqueuedMessage);
        Assert.Equal(12.5, queueMessage.VideoTimeSec);
        Assert.Equal($"sessions/{frame.SessionId}/frames/000001.bin", queueMessage.BlobPath);

        using var document = JsonDocument.Parse(JsonSerializer.Serialize(queueMessage, new JsonSerializerOptions(JsonSerializerDefaults.Web)));
        Assert.Equal(12.5, document.RootElement.GetProperty("videoTimeSec").GetDouble());
        Assert.False(document.RootElement.TryGetProperty("frameType", out _));
        Assert.False(document.RootElement.TryGetProperty("baseIFrameSequenceNo", out _));
    }

    private static ReceivedFrame CreateFrame(int sequenceNo = 1)
    {
        return new ReceivedFrame(
            Guid.NewGuid(),
            sequenceNo,
            DateTimeOffset.Parse("2026-06-14T10:00:00Z"),
            12.5,
            DateTimeOffset.Parse("2026-06-14T10:00:00.050Z"),
            "image/jpeg",
            [0xff, 0xd8, 0xff, 0xd9]);
    }

    private sealed class RecordingFrameStorage : IFrameStorage
    {
        public ReceivedFrame? SavedFrame { get; private set; }

        public Task<string> SaveAsync(ReceivedFrame frame, CancellationToken cancellationToken)
        {
            SavedFrame = frame;
            return Task.FromResult(FrameBlobPath.Create(frame));
        }
    }

    private sealed class RecordingFrameQueue : IFrameQueue
    {
        public FrameQueueMessage? EnqueuedMessage { get; private set; }

        public Task EnqueueAsync(FrameQueueMessage message, CancellationToken cancellationToken)
        {
            EnqueuedMessage = message;
            return Task.CompletedTask;
        }
    }
}
