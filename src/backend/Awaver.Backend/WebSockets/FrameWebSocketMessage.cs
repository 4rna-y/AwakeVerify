using System.ComponentModel.DataAnnotations;

namespace Awaver.Backend.WebSockets;

public sealed class FrameWebSocketMessage
{
    [Required]
    public Guid SessionId { get; init; }

    [Range(1, int.MaxValue)]
    public int SequenceNo { get; init; }

    [Required]
    public required string FrameType { get; init; }

    [Range(1, int.MaxValue)]
    public int BaseIFrameSequenceNo { get; init; }

    [Required]
    public DateTimeOffset CapturedAt { get; init; }

    [Required]
    public required string Codec { get; init; }

    [Required]
    public required string PayloadBase64 { get; init; }
}
