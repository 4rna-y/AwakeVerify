using Awaver.Backend.Data;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Awaver.Backend.Migrations;

[DbContext(typeof(AwaverDbContext))]
[Migration("20260714000000_AddVideoIdToLearningSessions")]
public partial class AddVideoIdToLearningSessions : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<string>(
            name: "video_id",
            table: "learning_sessions",
            type: "character varying(128)",
            maxLength: 128,
            nullable: false,
            defaultValue: "default");

        migrationBuilder.CreateIndex(
            name: "IX_learning_sessions_video_id_started_at",
            table: "learning_sessions",
            columns: new[] { "video_id", "started_at" });
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropIndex(
            name: "IX_learning_sessions_video_id_started_at",
            table: "learning_sessions");

        migrationBuilder.DropColumn(
            name: "video_id",
            table: "learning_sessions");
    }
}
