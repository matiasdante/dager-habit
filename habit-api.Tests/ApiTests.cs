using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

// Las pruebas comparten la variable de entorno del directorio de datos: se corren de a una.
[assembly: CollectionBehavior(DisableTestParallelization = true)]

public class ApiFactory : WebApplicationFactory<Program>
{
    public string DataDir { get; } = Directory.CreateTempSubdirectory("habit-test-").FullName;

    public ApiFactory() => Environment.SetEnvironmentVariable("HABIT_DATA_DIR", DataDir);

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(DataDir, recursive: true); } catch (IOException) { }
    }
}

public sealed class ApiTests(ApiFactory factory) : IClassFixture<ApiFactory>
{
    private HttpRequestMessage Put(string zone, bool browser = true)
    {
        var request = new HttpRequestMessage(HttpMethod.Put, "/api/me/time-zone") { Content = JsonContent.Create(new { timeZone = zone }) };
        if (browser) request.Headers.Add("X-Habit-Request", "1");
        return request;
    }

    [Fact]
    public async Task HealthResponds()
    {
        var response = await factory.CreateClient().GetAsync("/health");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task StartsWithTheImplicitLocalUserAndCreatesTheDatabase()
    {
        var me = await factory.CreateClient().GetFromJsonAsync<JsonElement>("/api/me");
        Assert.Equal(1, me.GetProperty("id").GetInt32());
        Assert.Equal("local", me.GetProperty("username").GetString());
        Assert.True(File.Exists(Path.Combine(factory.DataDir, "habit.db")));
    }

    [Fact]
    public async Task ChangesTheTimeZoneOnlyForBrowserRequestsWithAKnownZone()
    {
        var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(Put("America/Argentina/Buenos_Aires", browser: false))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.SendAsync(Put("Marte/Olympus"))).StatusCode);
        Assert.Equal("UTC", (await client.GetFromJsonAsync<JsonElement>("/api/me")).GetProperty("timeZone").GetString());

        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(Put("America/Argentina/Buenos_Aires"))).StatusCode);
        Assert.Equal("America/Argentina/Buenos_Aires",
            (await client.GetFromJsonAsync<JsonElement>("/api/me")).GetProperty("timeZone").GetString());
    }
}

public sealed class DataIsolationTests
{
    [Fact]
    public async Task EachPersonOnlySeesTheirOwnBooks()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var options = new DbContextOptionsBuilder<HabitDb>().UseSqlite(connection).Options;

        await using (var setup = new HabitDb(options, new CurrentUser { Id = HabitDb.LocalUserId }))
        {
            await setup.Database.MigrateAsync();
            setup.Users.Add(new User { Id = 2, Username = "ana" });
            setup.Books.Add(new Book { UserId = 1, Title = "Libro de local", Author = "A" });
            setup.Books.Add(new Book { UserId = 2, Title = "Libro de Ana", Author = "B" });
            await setup.SaveChangesAsync();
        }

        await using var asLocal = new HabitDb(options, new CurrentUser { Id = 1 });
        await using var asAna = new HabitDb(options, new CurrentUser { Id = 2 });
        Assert.Equal(["Libro de local"], await asLocal.Books.Select(book => book.Title).ToListAsync());
        Assert.Equal(["Libro de Ana"], await asAna.Books.Select(book => book.Title).ToListAsync());
    }
}
