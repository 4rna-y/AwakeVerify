namespace Awaver.Backend.Services;

public static class FrameBlobPath
{
    public static string Create(ReceivedFrame frame)
    {
        return $"sessions/{frame.SessionId}/frames/{frame.SequenceNo:000000}.bin";
    }
}
