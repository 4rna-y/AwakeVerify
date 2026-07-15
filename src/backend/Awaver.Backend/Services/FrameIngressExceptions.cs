namespace Awaver.Backend.Services;

public sealed class FrameIngressConflictException : Exception
{
    public FrameIngressConflictException() : base("The frame key is already associated with different content or metadata.") { }
}

public sealed class FrameIngressDependencyException : Exception
{
    public FrameIngressDependencyException(string dependency, Exception innerException)
        : base($"The {dependency} dependency is temporarily unavailable.", innerException) { }
}
