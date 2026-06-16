namespace Awaver.Backend.Services;

public sealed class LocalFrameStorage(IConfiguration configuration) : IFrameStorage
{
    private readonly string _rootPath = configuration["Frames:LocalRoot"] ?? "data/blobs";

    public async Task<string> SaveAsync(ReceivedFrame frame, CancellationToken cancellationToken)
    {
        var blobPath = FrameBlobPath.Create(frame);
        var fullPath = Path.Combine(_rootPath, blobPath.Replace('/', Path.DirectorySeparatorChar));
        var directory = Path.GetDirectoryName(fullPath);

        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }

        await File.WriteAllBytesAsync(fullPath, frame.Payload, cancellationToken);
        return blobPath;
    }
}
