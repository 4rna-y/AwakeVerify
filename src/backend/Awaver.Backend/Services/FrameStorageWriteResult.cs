namespace Awaver.Backend.Services;

/// <summary>
/// Result of atomically reserving the deterministic Blob name for a frame.
/// </summary>
public sealed record FrameStorageWriteResult(string BlobPath, bool AlreadyAccepted);
