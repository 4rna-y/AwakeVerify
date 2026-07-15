using System.Diagnostics;
using System.Security.Claims;
using Awaver.Backend.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Awaver.Backend.Controllers;

[ApiController]
[Route("api/sessions")]
public sealed class FrameIngressController(
    ISessionRepository sessions,
    FramePipeline pipeline,
    BackendObservability observability) : ControllerBase
{
    [HttpPost("{sessionId:guid}/frames/{sequenceNo:int}")]
    [Authorize(Roles = AuthSessionService.StudentRole)]
    [RequestSizeLimit(FrameIngressRequest.MaxJpegBytes)]
    [ProducesResponseType(StatusCodes.Status202Accepted)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    [ProducesResponseType(StatusCodes.Status413PayloadTooLarge)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<IActionResult> PostFrame(Guid sessionId, int sequenceNo, CancellationToken cancellationToken)
    {
        var stopwatch = Stopwatch.StartNew();
        try
        {
            if (!Guid.TryParse(User.FindFirstValue("learning_session_id"), out var authorizedSessionId) || authorizedSessionId != sessionId)
            {
                return Complete(Forbid(), "forbidden", stopwatch);
            }
            if (!await sessions.SessionExistsAsync(sessionId, cancellationToken))
            {
                return Complete(NotFound(), "not_found", stopwatch);
            }

            byte[] payload;
            try
            {
                payload = await FrameIngressRequest.ReadBoundedAsync(Request.Body, Request.ContentLength, cancellationToken);
            }
            catch (FramePayloadTooLargeException)
            {
                return Complete(StatusCode(StatusCodes.Status413PayloadTooLarge), "too_large", stopwatch);
            }

            if (!FrameIngressRequest.TryCreate(
                    sessionId,
                    sequenceNo,
                    Request.ContentType,
                    Request.Headers["X-Frame-Captured-At"],
                    Request.Headers["X-Frame-Video-Time-Sec"],
                    payload,
                    DateTimeOffset.UtcNow,
                    out var frame,
                    out var error))
            {
                return Complete(BadRequest(error), "invalid", stopwatch);
            }

            try
            {
                var result = await pipeline.HandleAsync(frame!, cancellationToken);
                return Complete(Accepted(), result == FrameIngressResult.Duplicate ? "duplicate" : "accepted", stopwatch, payload.Length);
            }
            catch (FrameIngressConflictException)
            {
                return Complete(Conflict(), "conflict", stopwatch);
            }
            catch (FrameIngressDependencyException)
            {
                return Complete(StatusCode(StatusCodes.Status503ServiceUnavailable), "dependency_unavailable", stopwatch);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
    }

    private IActionResult Complete(IActionResult result, string outcome, Stopwatch stopwatch, int acceptedBytes = 0)
    {
        observability.RecordFrameIngress(outcome, stopwatch.Elapsed, acceptedBytes);
        return result;
    }
}
