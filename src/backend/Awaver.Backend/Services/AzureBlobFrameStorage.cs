using System.Globalization;
using System.Security.Cryptography;
using Azure;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;

namespace Awaver.Backend.Services;

public sealed class AzureBlobFrameStorage(BlobContainerClient containerClient) : IFrameStorage
{
    private const string AcceptanceStateKey = "acceptanceState";
    private const string AcceptedState = "accepted";

    public async Task<FrameStorageWriteResult> SaveAsync(ReceivedFrame frame, CancellationToken cancellationToken)
    {
        var blobPath = FrameBlobPath.Create(frame);
        var blobClient = containerClient.GetBlobClient(blobPath);
        var metadata = MetadataFor(frame, pending: true);

        try
        {
            await containerClient.CreateIfNotExistsAsync(cancellationToken: cancellationToken);
            await using var stream = new MemoryStream(frame.Payload, writable: false);
            await blobClient.UploadAsync(stream, new BlobUploadOptions
            {
                Conditions = new BlobRequestConditions { IfNoneMatch = ETag.All },
                Metadata = metadata,
            }, cancellationToken);
            return new FrameStorageWriteResult(blobPath, AlreadyAccepted: false);
        }
        catch (RequestFailedException exception) when (exception.Status is 409 or 412)
        {
            return await ReadExistingResultAsync(blobClient, metadata, blobPath, cancellationToken);
        }
        catch (RequestFailedException exception)
        {
            throw new FrameIngressDependencyException("Blob Storage", exception);
        }
    }

    public async Task MarkAcceptedAsync(ReceivedFrame frame, CancellationToken cancellationToken)
    {
        var blobClient = containerClient.GetBlobClient(FrameBlobPath.Create(frame));
        var expectedMetadata = MetadataFor(frame, pending: true);
        try
        {
            var properties = await blobClient.GetPropertiesAsync(cancellationToken: cancellationToken);
            EnsureMatches(properties.Value.Metadata, expectedMetadata);
            if (IsAccepted(properties.Value.Metadata)) return;

            var acceptedMetadata = MetadataFor(frame, pending: false);
            await blobClient.SetMetadataAsync(acceptedMetadata,
                conditions: new BlobRequestConditions { IfMatch = properties.Value.ETag },
                cancellationToken: cancellationToken);
        }
        catch (RequestFailedException exception) when (exception.Status == 412)
        {
            // Another request for this exact idempotency key may have committed
            // the acceptance marker first. Only that exact marker is success.
            var properties = await blobClient.GetPropertiesAsync(cancellationToken: cancellationToken);
            EnsureMatches(properties.Value.Metadata, expectedMetadata);
            if (!IsAccepted(properties.Value.Metadata))
            {
                throw new FrameIngressDependencyException("Blob Storage", exception);
            }
        }
        catch (RequestFailedException exception)
        {
            throw new FrameIngressDependencyException("Blob Storage", exception);
        }
    }

    private static async Task<FrameStorageWriteResult> ReadExistingResultAsync(BlobClient blobClient, IDictionary<string, string> expectedMetadata, string blobPath, CancellationToken cancellationToken)
    {
        try
        {
            var properties = await blobClient.GetPropertiesAsync(cancellationToken: cancellationToken);
            EnsureMatches(properties.Value.Metadata, expectedMetadata);
            return new FrameStorageWriteResult(blobPath, IsAccepted(properties.Value.Metadata));
        }
        catch (RequestFailedException exception)
        {
            throw new FrameIngressDependencyException("Blob Storage", exception);
        }
    }

    private static Dictionary<string, string> MetadataFor(ReceivedFrame frame, bool pending) => new(StringComparer.OrdinalIgnoreCase)
    {
        ["codec"] = frame.Codec,
        ["capturedAt"] = frame.CapturedAt.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture),
        ["videoTimeSec"] = frame.VideoTimeSec.ToString("R", CultureInfo.InvariantCulture),
        ["payloadSha256"] = Convert.ToHexString(SHA256.HashData(frame.Payload)),
        [AcceptanceStateKey] = pending ? "pending" : AcceptedState,
    };

    private static void EnsureMatches(IDictionary<string, string> actual, IDictionary<string, string> expected)
    {
        foreach (var (key, expectedValue) in expected)
        {
            if (key.Equals(AcceptanceStateKey, StringComparison.OrdinalIgnoreCase)) continue;
            if (!actual.TryGetValue(key, out var actualValue) || !string.Equals(actualValue, expectedValue, StringComparison.Ordinal))
            {
                throw new FrameIngressConflictException();
            }
        }
    }

    private static bool IsAccepted(IDictionary<string, string> metadata) =>
        metadata.TryGetValue(AcceptanceStateKey, out var state) && string.Equals(state, AcceptedState, StringComparison.Ordinal);
}
