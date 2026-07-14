using Awaver.Backend.Data;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Awaver.Backend.Migrations;

[DbContext(typeof(AwaverDbContext))]
[Migration("20260713120000_AddAnalysisEventIdempotency")]
public partial class AddAnalysisEventIdempotency : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<string>(
            name: "idempotency_key",
            table: "analysis_event_outbox",
            type: "character varying(256)",
            maxLength: 256,
            nullable: true);

        migrationBuilder.Sql("UPDATE analysis_event_outbox SET idempotency_key = 'legacy:' || event_id::text WHERE idempotency_key IS NULL;");

        migrationBuilder.AlterColumn<string>(
            name: "idempotency_key",
            table: "analysis_event_outbox",
            type: "character varying(256)",
            maxLength: 256,
            nullable: false,
            oldClrType: typeof(string),
            oldType: "character varying(256)",
            oldMaxLength: 256,
            oldNullable: true);

        migrationBuilder.CreateIndex(
            name: "IX_analysis_event_outbox_idempotency_key",
            table: "analysis_event_outbox",
            column: "idempotency_key",
            unique: true);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropIndex(
            name: "IX_analysis_event_outbox_idempotency_key",
            table: "analysis_event_outbox");
        migrationBuilder.DropColumn(
            name: "idempotency_key",
            table: "analysis_event_outbox");
    }
}
