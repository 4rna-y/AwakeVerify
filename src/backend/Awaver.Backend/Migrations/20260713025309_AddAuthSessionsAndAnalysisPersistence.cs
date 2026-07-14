using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Awaver.Backend.Migrations
{
    /// <inheritdoc />
    public partial class AddAuthSessionsAndAnalysisPersistence : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("CREATE TYPE drowsiness_level AS ENUM ('normal', 'caution', 'warning', 'danger');");

            migrationBuilder.CreateTable(
                name: "analysis_event_outbox",
                columns: table => new
                {
                    event_id = table.Column<Guid>(type: "uuid", nullable: false),
                    session_id = table.Column<Guid>(type: "uuid", nullable: false),
                    payload = table.Column<string>(type: "jsonb", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    delivered_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    attempt_count = table.Column<int>(type: "integer", nullable: false),
                    next_attempt_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    last_error = table.Column<string>(type: "text", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_analysis_event_outbox", x => x.event_id);
                    table.ForeignKey(
                        name: "FK_analysis_event_outbox_learning_sessions_session_id",
                        column: x => x.session_id,
                        principalTable: "learning_sessions",
                        principalColumn: "session_id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "auth_sessions",
                columns: table => new
                {
                    session_id = table.Column<Guid>(type: "uuid", nullable: false),
                    principal_type = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    principal_id = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    issued_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    idle_expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    absolute_expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    revoked_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_auth_sessions", x => x.session_id);
                });

            migrationBuilder.CreateTable(
                name: "calibrations",
                columns: table => new
                {
                    session_id = table.Column<Guid>(type: "uuid", nullable: false),
                    ear_open = table.Column<decimal>(type: "numeric(12,8)", precision: 12, scale: 8, nullable: false),
                    ear_threshold = table.Column<decimal>(type: "numeric(12,8)", precision: 12, scale: 8, nullable: false),
                    calibrated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    source_sequence_no = table.Column<long>(type: "bigint", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_calibrations", x => x.session_id);
                    table.ForeignKey(
                        name: "FK_calibrations_learning_sessions_session_id",
                        column: x => x.session_id,
                        principalTable: "learning_sessions",
                        principalColumn: "session_id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "drowsiness_scores",
                columns: table => new
                {
                    session_id = table.Column<Guid>(type: "uuid", nullable: false),
                    source_sequence_no = table.Column<long>(type: "bigint", nullable: false),
                    scored_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    score = table.Column<decimal>(type: "numeric(12,8)", precision: 12, scale: 8, nullable: false),
                    level = table.Column<string>(type: "drowsiness_level", nullable: false),
                    perclos = table.Column<decimal>(type: "numeric(12,8)", precision: 12, scale: 8, nullable: false),
                    ear = table.Column<decimal>(type: "numeric(12,8)", precision: 12, scale: 8, nullable: false),
                    pitch_deg = table.Column<decimal>(type: "numeric(12,8)", precision: 12, scale: 8, nullable: false),
                    yaw_deg = table.Column<decimal>(type: "numeric(12,8)", precision: 12, scale: 8, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_drowsiness_scores", x => new { x.session_id, x.source_sequence_no });
                    table.ForeignKey(
                        name: "FK_drowsiness_scores_learning_sessions_session_id",
                        column: x => x.session_id,
                        principalTable: "learning_sessions",
                        principalColumn: "session_id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_analysis_event_outbox_delivered_at_next_attempt_at",
                table: "analysis_event_outbox",
                columns: new[] { "delivered_at", "next_attempt_at" });

            migrationBuilder.CreateIndex(
                name: "IX_analysis_event_outbox_session_id",
                table: "analysis_event_outbox",
                column: "session_id");

            migrationBuilder.CreateIndex(
                name: "IX_auth_sessions_principal_type_principal_id",
                table: "auth_sessions",
                columns: new[] { "principal_type", "principal_id" });

            migrationBuilder.CreateIndex(
                name: "IX_drowsiness_scores_session_id_scored_at",
                table: "drowsiness_scores",
                columns: new[] { "session_id", "scored_at" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "analysis_event_outbox");

            migrationBuilder.DropTable(
                name: "auth_sessions");

            migrationBuilder.DropTable(
                name: "calibrations");

            migrationBuilder.DropTable(
                name: "drowsiness_scores");

            migrationBuilder.Sql("DROP TYPE drowsiness_level;");
        }
    }
}
