namespace Awaver.Backend.Models;

public enum DrowsinessLevel
{
    Normal,
    Caution,
    Warning,
    Danger,
}

public static class DrowsinessLevelExtensions
{
    public static string ToApiValue(this DrowsinessLevel level) => level switch
    {
        DrowsinessLevel.Normal => "normal",
        DrowsinessLevel.Caution => "caution",
        DrowsinessLevel.Warning => "warning",
        DrowsinessLevel.Danger => "danger",
        _ => throw new ArgumentOutOfRangeException(nameof(level), level, "Unsupported drowsiness level."),
    };

    public static bool TryParseApiValue(string value, out DrowsinessLevel level)
    {
        level = value switch
        {
            "normal" => DrowsinessLevel.Normal,
            "caution" => DrowsinessLevel.Caution,
            "warning" => DrowsinessLevel.Warning,
            "danger" => DrowsinessLevel.Danger,
            _ => default,
        };
        return value is "normal" or "caution" or "warning" or "danger";
    }
}
