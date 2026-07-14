using System.ComponentModel.DataAnnotations;

namespace Awaver.Backend.Dto;

public sealed class CreateTeacherRequest
{
    [Required]
    public string? TeacherId { get; init; }

    [Required]
    public string? Password { get; init; }
}
