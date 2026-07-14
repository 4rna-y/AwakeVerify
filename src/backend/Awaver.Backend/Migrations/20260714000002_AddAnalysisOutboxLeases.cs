using Awaver.Backend.Data;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Awaver.Backend.Migrations;

[DbContext(typeof(AwaverDbContext))]
[Migration("20260714000002_AddAnalysisOutboxLeases")]
public partial class AddAnalysisOutboxLeases : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<Guid>(
            name: "lease_id",
            table: "analysis_event_outbox",
            type: "uuid",
            nullable: true);

        migrationBuilder.AddColumn<DateTimeOffset>(
            name: "locked_until",
            table: "analysis_event_outbox",
            type: "timestamp with time zone",
            nullable: true);

        migrationBuilder.AddColumn<string>(
            name: "processing_owner",
            table: "analysis_event_outbox",
            type: "character varying(128)",
            maxLength: 128,
            nullable: true);

        migrationBuilder.CreateIndex(
            name: "IX_analysis_event_outbox_delivered_at_next_attempt_at_locked_until",
            table: "analysis_event_outbox",
            columns: new[] { "delivered_at", "next_attempt_at", "locked_until" });
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropIndex(
            name: "IX_analysis_event_outbox_delivered_at_next_attempt_at_locked_until",
            table: "analysis_event_outbox");
        migrationBuilder.DropColumn(name: "lease_id", table: "analysis_event_outbox");
        migrationBuilder.DropColumn(name: "locked_until", table: "analysis_event_outbox");
        migrationBuilder.DropColumn(name: "processing_owner", table: "analysis_event_outbox");
    }
}
