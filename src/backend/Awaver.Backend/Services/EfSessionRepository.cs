using Awaver.Backend.Data;
using Awaver.Backend.Models;
using Microsoft.EntityFrameworkCore;

namespace Awaver.Backend.Services;

public sealed class EfSessionRepository(AwaverDbContext dbContext) : ISessionRepository
{
    public Task<SessionStartResult> StartSessionAsync(string studentId, CancellationToken cancellationToken) =>
        StartSessionAsync(studentId, "default", cancellationToken);

    public async Task<SessionStartResult> StartSessionAsync(string studentId, string videoId, CancellationToken cancellationToken)
    {
        var normalizedStudentId = NormalizeStudentId(studentId);
        var normalizedVideoId = NormalizeVideoId(videoId);
        var now = DateTimeOffset.UtcNow;

        var studentExists = await dbContext.Students
            .AnyAsync(student => student.StudentId == normalizedStudentId, cancellationToken);

        if (!studentExists)
        {
            dbContext.Students.Add(new Student
            {
                StudentId = normalizedStudentId,
                CreatedAt = now,
            });
        }

        var session = new LearningSession
        {
            SessionId = Guid.NewGuid(),
            StudentId = normalizedStudentId,
            VideoId = normalizedVideoId,
            StartedAt = now,
        };

        dbContext.LearningSessions.Add(session);
        await dbContext.SaveChangesAsync(cancellationToken);

        return new SessionStartResult(session.SessionId, normalizedStudentId, session.StartedAt);
    }

    public Task<bool> SessionExistsAsync(Guid sessionId, CancellationToken cancellationToken)
    {
        return dbContext.LearningSessions
            .AnyAsync(session => session.SessionId == sessionId, cancellationToken);
    }

    private static string NormalizeStudentId(string studentId) => studentId.Trim();
    private static string NormalizeVideoId(string videoId) => videoId.Trim();
}
