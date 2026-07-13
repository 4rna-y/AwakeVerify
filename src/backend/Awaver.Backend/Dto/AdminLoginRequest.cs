using System.ComponentModel.DataAnnotations;

namespace Awaver.Backend.Dto;

public sealed class AdminLoginRequest
{
    [Required]
    public string? AdminId { get; init; }

    [Required]
    public string? Password { get; init; }
}
