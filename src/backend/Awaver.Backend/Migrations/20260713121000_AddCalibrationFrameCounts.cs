using Awaver.Backend.Data;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Awaver.Backend.Migrations;

[DbContext(typeof(AwaverDbContext))]
[Migration("20260713121000_AddCalibrationFrameCounts")]
public partial class AddCalibrationFrameCounts : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<int>("valid_frames", "calibrations", type: "integer", nullable: false, defaultValue: 15);
        migrationBuilder.AddColumn<int>("total_frames", "calibrations", type: "integer", nullable: false, defaultValue: 25);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropColumn("valid_frames", "calibrations");
        migrationBuilder.DropColumn("total_frames", "calibrations");
    }
}
