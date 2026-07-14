using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Awaver.Backend.Migrations
{
    /// <inheritdoc />
    public partial class AddVideoTimeSecToDrowsinessScores : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<double>(
                name: "video_time_sec",
                table: "drowsiness_scores",
                type: "double precision",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "video_time_sec",
                table: "drowsiness_scores");
        }
    }
}
