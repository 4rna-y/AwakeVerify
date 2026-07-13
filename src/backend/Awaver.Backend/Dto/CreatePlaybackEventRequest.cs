using System.ComponentModel.DataAnnotations;

namespace Awaver.Backend.Dto;

public sealed class CreatePlaybackEventRequest
{
    [Required]
    public string? Type { get; init; }

    [Required]
    public DateTimeOffset? OccurredAt { get; init; }

    public double? VideoTimeSec { get; init; }
}
