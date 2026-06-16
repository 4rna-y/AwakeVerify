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
    public void TryParse_AcceptsValidIFrameMessage()
    {
        var sessionId = Guid.NewGuid();
        var message = JsonSerializer.Serialize(new
        {
            sessionId,
            sequenceNo = 1,
            frameType = "I",
            baseIFrameSequenceNo = 1,
            capturedAt = DateTimeOffset.Parse("2026-06-14T10:00:00Z"),
            codec = "image/jpeg",
            payloadBase64 = Convert.ToBase64String([1, 2, 3]),
        });

        var result = FrameMessageParser.TryParse(
            message,
            sessionId,
            DateTimeOffset.Parse("2026-06-14T10:00:00.050Z"),
            out var frame,
            out var error);

        Assert.True(result, error);
        Assert.NotNull(frame);
        Assert.Equal(FrameType.I, frame.FrameType);
        Assert.Equal(1, frame.SequenceNo);
        Assert.Equal(1, frame.BaseIFrameSequenceNo);
        Assert.Equal("image/jpeg", frame.Codec);
        Assert.Equal([1, 2, 3], frame.Payload);
    }

    [Fact]
    public void TryParse_RejectsMismatchedSessionId()
    {
        var message = JsonSerializer.Serialize(new
        {
            sessionId = Guid.NewGuid(),
            sequenceNo = 1,
            frameType = "I",
            baseIFrameSequenceNo = 1,
            capturedAt = DateTimeOffset.Parse("2026-06-14T10:00:00Z"),
            codec = "image/jpeg",
            payloadBase64 = Convert.ToBase64String([1]),
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
}
