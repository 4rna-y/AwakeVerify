using Microsoft.AspNetCore.Identity;
using System.Security.Cryptography;

namespace Awaver.Backend.Services;

public static class PasswordHasher
{
    private static readonly IPasswordHasher<object> Hasher = new PasswordHasher<object>();
    private static readonly object User = new();

    public static string Hash(string password) => Hasher.HashPassword(User, password);

    public static bool Verify(string password, string passwordHash) => Verify(password, passwordHash, out _);

    public static bool Verify(string password, string passwordHash, out bool needsRehash)
    {
        needsRehash = false;
        if (passwordHash.StartsWith("AQAAAA", StringComparison.Ordinal))
        {
            try
            {
                var result = Hasher.VerifyHashedPassword(User, passwordHash, password);
                needsRehash = result == PasswordVerificationResult.SuccessRehashNeeded;
                return result != PasswordVerificationResult.Failed;
            }
            catch (ArgumentException)
            {
                return false;
            }
        }

        // Compatibility for the former local format: iterations.base64(salt).base64(hash).
        // A successful legacy verification is immediately upgraded by the login controller.
        var parts = passwordHash.Split('.');
        if (parts.Length != 3 || !int.TryParse(parts[0], out var iterations) || iterations <= 0) return false;
        try
        {
            var salt = Convert.FromBase64String(parts[1]);
            var expectedHash = Convert.FromBase64String(parts[2]);
            if (salt.Length == 0 || expectedHash.Length == 0) return false;
            var actualHash = Rfc2898DeriveBytes.Pbkdf2(password, salt, iterations, HashAlgorithmName.SHA256, expectedHash.Length);
            var valid = CryptographicOperations.FixedTimeEquals(actualHash, expectedHash);
            needsRehash = valid;
            return valid;
        }
        catch (FormatException)
        {
            return false;
        }
    }
}
