using Awaver.Backend.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Awaver.Backend.Data;

// Keeps migration generation independent from runtime Azure/devcontainer configuration.
public sealed class AwaverDbContextFactory : IDesignTimeDbContextFactory<AwaverDbContext>
{
    public AwaverDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<AwaverDbContext>()
            .UseNpgsql("Host=localhost;Database=awaver_design;Username=awaver;Password=awaver", npgsql => npgsql.MapEnum<DrowsinessLevel>("drowsiness_level"))
            .Options;
        return new AwaverDbContext(options);
    }
}
