using System.Text.Json;
using Awaver.Backend.Services;

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

        var result = await new FramePipeline(storage, queue).HandleAsync(frame, CancellationToken.None);

        Assert.Equal(FrameIngressResult.Accepted, result);
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

        public Task<FrameStorageWriteResult> SaveAsync(ReceivedFrame frame, CancellationToken cancellationToken)
        {
            SavedFrame = frame;
            return Task.FromResult(new FrameStorageWriteResult(FrameBlobPath.Create(frame), AlreadyAccepted: false));
        }

        public Task MarkAcceptedAsync(ReceivedFrame frame, CancellationToken cancellationToken) => Task.CompletedTask;
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
