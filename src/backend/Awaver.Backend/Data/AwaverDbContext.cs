using Awaver.Backend.Models;
using Microsoft.EntityFrameworkCore;

namespace Awaver.Backend.Data;

public sealed class AwaverDbContext(DbContextOptions<AwaverDbContext> options) : DbContext(options)
{
    public DbSet<Student> Students => Set<Student>();
    public DbSet<LearningSession> LearningSessions => Set<LearningSession>();

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
    }
}
