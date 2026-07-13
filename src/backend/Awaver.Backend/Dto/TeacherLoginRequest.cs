using System.ComponentModel.DataAnnotations;

namespace Awaver.Backend.Dto;

public sealed class TeacherLoginRequest
{
    [Required]
    public string? TeacherId { get; init; }

    [Required]
    public string? Password { get; init; }
}
