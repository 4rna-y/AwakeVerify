using Microsoft.AspNetCore.Authentication;

namespace Awaver.Backend.Services;

public sealed class CsrfProtectionMiddleware(RequestDelegate next)
{
    private static readonly HashSet<string> UnsafeMethods = new(StringComparer.OrdinalIgnoreCase) { HttpMethods.Post, HttpMethods.Put, HttpMethods.Patch, HttpMethods.Delete };

    public async Task InvokeAsync(HttpContext context)
    {
        if (!UnsafeMethods.Contains(context.Request.Method) || context.Request.Path.StartsWithSegments("/hubs"))
        {
            await next(context);
            return;
        }

        var authentication = await context.AuthenticateAsync(AuthSessionAuthenticationHandler.SchemeName);
        if (!authentication.Succeeded)
        {
            await next(context);
            return;
        }

        var cookieToken = context.Request.Cookies[AuthCookieOptions.CsrfCookieName];
        var headerToken = context.Request.Headers["X-CSRF-Token"].ToString();
        if (string.IsNullOrWhiteSpace(cookieToken) || string.IsNullOrWhiteSpace(headerToken) ||
            !string.Equals(cookieToken, headerToken, StringComparison.Ordinal))
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            await context.Response.WriteAsync("A valid X-CSRF-Token is required.", context.RequestAborted);
            return;
        }

        await next(context);
    }
}
