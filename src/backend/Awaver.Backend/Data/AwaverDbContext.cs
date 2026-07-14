using Awaver.Backend.Models;
using Microsoft.EntityFrameworkCore;

namespace Awaver.Backend.Data;

public sealed class AwaverDbContext(DbContextOptions<AwaverDbContext> options) : DbContext(options)
{
    public DbSet<Student> Students => Set<Student>();
    public DbSet<LearningSession> LearningSessions => Set<LearningSession>();
    public DbSet<PlaybackEvent> PlaybackEvents => Set<PlaybackEvent>();
    public DbSet<Teacher> Teachers => Set<Teacher>();
    public DbSet<Admin> Admins => Set<Admin>();
    public DbSet<AuthSession> AuthSessions => Set<AuthSession>();
    public DbSet<Calibration> Calibrations => Set<Calibration>();
    public DbSet<DrowsinessScore> DrowsinessScores => Set<DrowsinessScore>();
    public DbSet<AnalysisEventOutbox> AnalysisEventOutbox => Set<AnalysisEventOutbox>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {


        modelBuilder.Entity<Student>(entity =>
        {
            entity.ToTable("students");
            entity.HasKey(item => item.StudentId);
            entity.Property(item => item.StudentId).HasColumnName("student_id").HasMaxLength(64);
            entity.Property(item => item.CreatedAt).HasColumnName("created_at").IsRequired();
        });

        modelBuilder.Entity<LearningSession>(entity =>
        {
            entity.ToTable("learning_sessions");
            entity.HasKey(item => item.SessionId);
            entity.Property(item => item.SessionId).HasColumnName("session_id");
            entity.Property(item => item.StudentId).HasColumnName("student_id").HasMaxLength(64).IsRequired();
            entity.Property(item => item.VideoId).HasColumnName("video_id").HasMaxLength(128).IsRequired();
            entity.Property(item => item.StartedAt).HasColumnName("started_at").IsRequired();
            entity.HasIndex(item => new { item.VideoId, item.StartedAt });
            entity.Property(item => item.EndedAt).HasColumnName("ended_at");
            entity.HasOne(item => item.Student).WithMany(item => item.LearningSessions).HasForeignKey(item => item.StudentId);
        });

        modelBuilder.Entity<PlaybackEvent>(entity =>
        {
            entity.ToTable("playback_events");
            entity.HasKey(item => item.EventId);
            entity.Property(item => item.EventId).HasColumnName("event_id");
            entity.Property(item => item.SessionId).HasColumnName("session_id").IsRequired();
            entity.Property(item => item.Type).HasColumnName("type").HasMaxLength(32).IsRequired();
            entity.Property(item => item.OccurredAt).HasColumnName("occurred_at").IsRequired();
            entity.Property(item => item.VideoTimeSec).HasColumnName("video_time_sec");
            entity.HasOne(item => item.LearningSession).WithMany(item => item.PlaybackEvents).HasForeignKey(item => item.SessionId);
        });

        modelBuilder.Entity<Teacher>(entity =>
        {
            entity.ToTable("teachers");
            entity.HasKey(item => item.TeacherId);
            entity.Property(item => item.TeacherId).HasColumnName("teacher_id").HasMaxLength(64);
            entity.Property(item => item.PasswordHash).HasColumnName("password_hash").IsRequired();
            entity.Property(item => item.CreatedAt).HasColumnName("created_at").IsRequired();
            entity.Property(item => item.CreatedByAdminId).HasColumnName("created_by_admin_id").HasMaxLength(64);
        });

        modelBuilder.Entity<Admin>(entity =>
        {
            entity.ToTable("admins");
            entity.HasKey(item => item.AdminId);
            entity.Property(item => item.AdminId).HasColumnName("admin_id").HasMaxLength(64);
            entity.Property(item => item.PasswordHash).HasColumnName("password_hash").IsRequired();
            entity.Property(item => item.CreatedAt).HasColumnName("created_at").IsRequired();
        });

        modelBuilder.Entity<AuthSession>(entity =>
        {
            entity.ToTable("auth_sessions");
            entity.HasKey(item => item.SessionId);
            entity.Property(item => item.SessionId).HasColumnName("session_id");
            entity.Property(item => item.PrincipalType).HasColumnName("principal_type").HasMaxLength(32).IsRequired();
            entity.Property(item => item.PrincipalId).HasColumnName("principal_id").HasMaxLength(128).IsRequired();
            entity.Property(item => item.IssuedAt).HasColumnName("issued_at").IsRequired();
            entity.Property(item => item.IdleExpiresAt).HasColumnName("idle_expires_at").IsRequired();
            entity.Property(item => item.AbsoluteExpiresAt).HasColumnName("absolute_expires_at").IsRequired();
            entity.Property(item => item.RevokedAt).HasColumnName("revoked_at");
            entity.HasIndex(item => new { item.PrincipalType, item.PrincipalId });
        });

        modelBuilder.Entity<Calibration>(entity =>
        {
            entity.ToTable("calibrations");
            entity.HasKey(item => item.SessionId);
            entity.Property(item => item.SessionId).HasColumnName("session_id");
            entity.Property(item => item.EarOpen).HasColumnName("ear_open").HasPrecision(12, 8);
            entity.Property(item => item.EarThreshold).HasColumnName("ear_threshold").HasPrecision(12, 8);
            entity.Property(item => item.ValidFrames).HasColumnName("valid_frames");
            entity.Property(item => item.TotalFrames).HasColumnName("total_frames");
            entity.Property(item => item.CalibratedAt).HasColumnName("calibrated_at");
            entity.Property(item => item.SourceSequenceNo).HasColumnName("source_sequence_no");
            entity.HasOne(item => item.LearningSession).WithOne().HasForeignKey<Calibration>(item => item.SessionId);
        });

        modelBuilder.Entity<DrowsinessScore>(entity =>
        {
            entity.ToTable("drowsiness_scores");
            entity.HasKey(item => new { item.SessionId, item.SourceSequenceNo });
            entity.Property(item => item.SessionId).HasColumnName("session_id");
            entity.Property(item => item.SourceSequenceNo).HasColumnName("source_sequence_no");
            entity.Property(item => item.ScoredAt).HasColumnName("scored_at");
            entity.Property(item => item.Score).HasColumnName("score").HasPrecision(12, 8);
            entity.Property(item => item.Level).HasColumnName("level").HasColumnType("drowsiness_level");
            entity.Property(item => item.Perclos).HasColumnName("perclos").HasPrecision(12, 8);
            entity.Property(item => item.Ear).HasColumnName("ear").HasPrecision(12, 8);
            entity.Property(item => item.PitchDeg).HasColumnName("pitch_deg").HasPrecision(12, 8);
            entity.Property(item => item.YawDeg).HasColumnName("yaw_deg").HasPrecision(12, 8);
            entity.Property(item => item.VideoTimeSec).HasColumnName("video_time_sec");
            entity.HasIndex(item => new { item.SessionId, item.ScoredAt }).IsUnique();
            entity.HasOne(item => item.LearningSession).WithMany().HasForeignKey(item => item.SessionId);
        });

        modelBuilder.Entity<AnalysisEventOutbox>(entity =>
        {
            entity.ToTable("analysis_event_outbox");
            entity.HasKey(item => item.EventId);
            entity.Property(item => item.EventId).HasColumnName("event_id");
            entity.Property(item => item.SessionId).HasColumnName("session_id");
            entity.Property(item => item.IdempotencyKey).HasColumnName("idempotency_key").HasMaxLength(256).IsRequired();
            entity.Property(item => item.Payload).HasColumnName("payload").HasColumnType("jsonb").IsRequired();
            entity.Property(item => item.CreatedAt).HasColumnName("created_at");
            entity.Property(item => item.DeliveredAt).HasColumnName("delivered_at");
            entity.Property(item => item.AttemptCount).HasColumnName("attempt_count");
            entity.Property(item => item.NextAttemptAt).HasColumnName("next_attempt_at");
            entity.Property(item => item.LastError).HasColumnName("last_error");
            entity.Property(item => item.LeaseId).HasColumnName("lease_id");
            entity.Property(item => item.LockedUntil).HasColumnName("locked_until");
            entity.Property(item => item.ProcessingOwner).HasColumnName("processing_owner").HasMaxLength(128);
            entity.HasIndex(item => new { item.DeliveredAt, item.NextAttemptAt });
            entity.HasIndex(item => new { item.DeliveredAt, item.NextAttemptAt, item.LockedUntil });
            entity.HasIndex(item => item.IdempotencyKey).IsUnique();
            entity.HasOne(item => item.LearningSession).WithMany().HasForeignKey(item => item.SessionId);
        });
    }
}
