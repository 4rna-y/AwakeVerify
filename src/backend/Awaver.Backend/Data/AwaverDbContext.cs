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

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Student>(entity =>
        {
            entity.ToTable("students");
            entity.HasKey(student => student.StudentId);
            entity.Property(student => student.StudentId)
                .HasColumnName("student_id")
                .HasMaxLength(64);
            entity.Property(student => student.CreatedAt)
                .HasColumnName("created_at")
                .IsRequired();
        });

        modelBuilder.Entity<LearningSession>(entity =>
        {
            entity.ToTable("learning_sessions");
            entity.HasKey(session => session.SessionId);
            entity.Property(session => session.SessionId)
                .HasColumnName("session_id");
            entity.Property(session => session.StudentId)
                .HasColumnName("student_id")
                .HasMaxLength(64)
                .IsRequired();
            entity.Property(session => session.StartedAt)
                .HasColumnName("started_at")
                .IsRequired();
            entity.Property(session => session.EndedAt)
                .HasColumnName("ended_at");

            entity.HasOne(session => session.Student)
                .WithMany(student => student.LearningSessions)
                .HasForeignKey(session => session.StudentId);
        });

        modelBuilder.Entity<PlaybackEvent>(entity =>
        {
            entity.ToTable("playback_events");
            entity.HasKey(playbackEvent => playbackEvent.EventId);
            entity.Property(playbackEvent => playbackEvent.EventId)
                .HasColumnName("event_id");
            entity.Property(playbackEvent => playbackEvent.SessionId)
                .HasColumnName("session_id")
                .IsRequired();
            entity.Property(playbackEvent => playbackEvent.Type)
                .HasColumnName("type")
                .HasMaxLength(32)
                .IsRequired();
            entity.Property(playbackEvent => playbackEvent.OccurredAt)
                .HasColumnName("occurred_at")
                .IsRequired();
            entity.Property(playbackEvent => playbackEvent.VideoTimeSec)
                .HasColumnName("video_time_sec");

            entity.HasOne(playbackEvent => playbackEvent.LearningSession)
                .WithMany(session => session.PlaybackEvents)
                .HasForeignKey(playbackEvent => playbackEvent.SessionId);
        });

        modelBuilder.Entity<Teacher>(entity =>
        {
            entity.ToTable("teachers");
            entity.HasKey(teacher => teacher.TeacherId);
            entity.Property(teacher => teacher.TeacherId)
                .HasColumnName("teacher_id")
                .HasMaxLength(64);
            entity.Property(teacher => teacher.PasswordHash)
                .HasColumnName("password_hash")
                .IsRequired();
            entity.Property(teacher => teacher.CreatedAt)
                .HasColumnName("created_at")
                .IsRequired();
            entity.Property(teacher => teacher.CreatedByAdminId)
                .HasColumnName("created_by_admin_id")
                .HasMaxLength(64);
        });

        modelBuilder.Entity<Admin>(entity =>
        {
            entity.ToTable("admins");
            entity.HasKey(admin => admin.AdminId);
            entity.Property(admin => admin.AdminId)
                .HasColumnName("admin_id")
                .HasMaxLength(64);
            entity.Property(admin => admin.PasswordHash)
                .HasColumnName("password_hash")
                .IsRequired();
            entity.Property(admin => admin.CreatedAt)
                .HasColumnName("created_at")
                .IsRequired();
        });
    }
}
