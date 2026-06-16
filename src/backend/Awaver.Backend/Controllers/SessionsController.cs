using Awaver.Backend.Dto;
using Awaver.Backend.Services;
using Microsoft.AspNetCore.Mvc;

namespace Awaver.Backend.Controllers;

[ApiController]
[Route("api/sessions")]
public sealed class SessionsController(ISessionRepository sessions) : ControllerBase
{
    [HttpPost]
    [ProducesResponseType<StartSessionResponse>(StatusCodes.Status201Created)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<StartSessionResponse>> StartSession(
        StartSessionRequest request,
        CancellationToken cancellationToken)
    {
        var studentId = request.StudentId.Trim();
        if (studentId.Length == 0)
        {
            return ValidationProblem("studentId is required.");
        }

        var session = await sessions.StartSessionAsync(studentId, cancellationToken);
        var response = new StartSessionResponse(session.SessionId);

        return Created($"/api/sessions/{session.SessionId}", response);
    }
}
