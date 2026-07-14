using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace Awaver.Backend.Services;

public sealed class WorkerApiKeyAuthenticationHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder,
    IConfiguration configuration,
    IHostEnvironment environment) : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "worker-api-key";

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        // A shared API key is strictly a local-development credential. Production uses the
        // WorkerBearer scheme, configured with the Entra authority/audience below.
        var configuredMode = FirstNonWhiteSpace(
            configuration["Worker:AuthMode"],
            configuration["WORKER_AUTH_MODE"],
            Environment.GetEnvironmentVariable("WORKER_AUTH_MODE"))
            ?? (environment.IsProduction() ? "entra_id" : "api_key");
        if (environment.IsProduction() || configuredMode.Trim().ToLowerInvariant() is not ("api_key" or "local" or "development"))
        {
            return Task.FromResult(AuthenticateResult.NoResult());
        }

        var expected = FirstNonWhiteSpace(
            configuration["Worker:ApiKey"],
            configuration["WORKER_API_KEY"],
            Environment.GetEnvironmentVariable("WORKER_API_KEY"));
        var supplied = Request.Headers["X-Worker-Api-Key"].ToString();
        if (string.IsNullOrWhiteSpace(supplied))
        {
            // Browser requests authenticate with the session-cookie scheme. Returning
            // NoResult prevents this optional Worker scheme from logging a false failure.
            return Task.FromResult(AuthenticateResult.NoResult());
        }
        if (string.IsNullOrWhiteSpace(expected) ||
            !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(supplied)))
        {
            return Task.FromResult(AuthenticateResult.Fail("A valid worker API key is required."));
        }

        var identity = new ClaimsIdentity(SchemeName);
        identity.AddClaim(new Claim("worker_role", "analysis_worker"));
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), SchemeName)));
    }

    private static string? FirstNonWhiteSpace(params string?[] values) => values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value));
}
