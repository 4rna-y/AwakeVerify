using Azure.Storage.Blobs;

namespace Awaver.Backend.Services;

public sealed class AzureBlobFrameStorage(BlobContainerClient containerClient) : IFrameStorage
{
    public async Task<string> SaveAsync(ReceivedFrame frame, CancellationToken cancellationToken)
    {
        var blobPath = FrameBlobPath.Create(frame);
        var blobClient = containerClient.GetBlobClient(blobPath);

        await containerClient.CreateIfNotExistsAsync(cancellationToken: cancellationToken);
        await using var stream = new MemoryStream(frame.Payload, writable: false);
        await blobClient.UploadAsync(stream, overwrite: true, cancellationToken);

        return blobPath;
    }
}
