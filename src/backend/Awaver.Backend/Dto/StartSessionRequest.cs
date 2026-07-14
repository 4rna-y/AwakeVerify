using System.ComponentModel.DataAnnotations;

namespace Awaver.Backend.Dto;

public sealed class StartSessionRequest
{
    [Required]
    [StringLength(64, MinimumLength = 1)]
    public required string StudentId { get; init; }

    [StringLength(128, MinimumLength = 1)]
    public string? VideoId { get; init; }
}
