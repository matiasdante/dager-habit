using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

/// <summary>Usuario de la petición en curso. Con el login apagado siempre es el usuario local.</summary>
internal sealed class CurrentUser
{
    public int Id { get; set; }
}

internal sealed class User
{
    public int Id { get; set; }
    public string Username { get; set; } = "";
    public bool IsAdmin { get; set; }
    /// <summary>Id IANA, por ejemplo America/Argentina/Buenos_Aires.</summary>
    public string TimeZone { get; set; } = "UTC";
}

internal enum MetadataStatus { Complete, Pending }

internal sealed class Book
{
    public int Id { get; set; }
    public int UserId { get; set; }
    public string Title { get; set; } = "";
    public string Author { get; set; } = "";
    public string? Isbn { get; set; }
    public int? TotalPages { get; set; }
    public int? Page { get; set; }
    public bool Archived { get; set; }
    public MetadataStatus MetadataStatus { get; set; } = MetadataStatus.Complete;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

internal sealed class HabitDb(DbContextOptions<HabitDb> options, CurrentUser current) : DbContext(options)
{
    public const int LocalUserId = 1;

    public DbSet<User> Users => Set<User>();
    public DbSet<Book> Books => Set<Book>();

    protected override void OnModelCreating(ModelBuilder model)
    {
        model.Entity<User>(user =>
        {
            user.HasIndex(item => item.Username).IsUnique();
            user.Property(item => item.Username).HasMaxLength(64);
            user.Property(item => item.TimeZone).HasMaxLength(64);
            user.HasData(new User { Id = LocalUserId, Username = "local", IsAdmin = true, TimeZone = "UTC" });
        });

        // Todo dato de una persona se filtra acá, así ninguna consulta se olvida de limitar por usuario.
        model.Entity<Book>(book =>
        {
            book.HasQueryFilter(item => item.UserId == current.Id);
            book.HasOne<User>().WithMany().HasForeignKey(item => item.UserId).OnDelete(DeleteBehavior.Cascade);
            book.Property(item => item.Title).HasMaxLength(200);
            book.Property(item => item.Author).HasMaxLength(150);
            book.Property(item => item.Isbn).HasMaxLength(13);
            book.Property(item => item.MetadataStatus).HasConversion<string>().HasMaxLength(16);
            book.HasIndex(item => new { item.UserId, item.Archived });
        });
    }

    public static string ConnectionString(string dataDir) =>
        $"Data Source={Path.Combine(dataDir, "habit.db")}";
}

/// <summary>Lo usa solo `dotnet ef`, sin levantar la aplicación.</summary>
internal sealed class HabitDbFactory : IDesignTimeDbContextFactory<HabitDb>
{
    public HabitDb CreateDbContext(string[] args) => new(
        new DbContextOptionsBuilder<HabitDb>().UseSqlite("Data Source=design-time.db").Options, new CurrentUser());
}
