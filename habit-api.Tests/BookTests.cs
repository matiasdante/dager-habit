using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

sealed class FakeSource : IBookSource
{
    public List<BookInfo> Hits { get; } = [];
    public Dictionary<string, BookInfo> ByIsbn { get; } = [];
    public bool Fails { get; set; }

    public Task<IReadOnlyList<BookInfo>> SearchAsync(string query, CancellationToken cancellation) =>
        Fails ? throw new HttpRequestException() : Task.FromResult<IReadOnlyList<BookInfo>>(Hits.ToList());

    public Task<BookInfo?> ByIsbnAsync(string isbn, CancellationToken cancellation) =>
        Fails ? throw new HttpRequestException() : Task.FromResult(ByIsbn.GetValueOrDefault(isbn));
}

sealed class StubHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation) =>
        Task.FromResult(respond(request));
}

sealed class StubClients(HttpMessageHandler handler) : IHttpClientFactory
{
    public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
}

public sealed class BookApiFactory : ApiFactory
{
    public static readonly byte[] Jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3];
    internal FakeSource Source { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder) => builder.ConfigureTestServices(services =>
    {
        foreach (var item in services.Where(item => item.ServiceType == typeof(IBookSource) ||
            item.ImplementationType == typeof(MetadataWorker)).ToList()) services.Remove(item);
        services.AddSingleton<IBookSource>(Source);
        services.AddHttpClient("covers").ConfigurePrimaryHttpMessageHandler(() => new StubHandler(request =>
            request.RequestUri!.AbsolutePath.EndsWith(".jpg")
                ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Jpeg) }
                : new HttpResponseMessage(HttpStatusCode.NotFound)));
    });
}

public sealed class IsbnTests
{
    [Theory]
    [InlineData("978-84-376-0494-7", "9788437604947")]
    [InlineData("843760494X", "9788437604947")]
    [InlineData(" 978 84 376 0494 7 ", "9788437604947")]
    public void NormalizesToIsbn13(string input, string expected) => Assert.Equal(expected, Isbn.Normalize(input));

    [Theory]
    [InlineData("9788437604948")]
    [InlineData("hola")]
    [InlineData("12345")]
    [InlineData(null)]
    public void RejectsWhatIsNotAnIsbn(string? input) => Assert.Null(Isbn.Normalize(input));
}

public sealed class LookupTests
{
    [Fact]
    public void MergeKeepsTheFirstValueOfEachFieldAndTheRequestedIsbn()
    {
        var merged = BookLookup.Merge([
            new BookInfo("Cien", "Autor no informado", CoverUrl: "https://covers.openlibrary.org/b/id/1-M.jpg"),
            null,
            new BookInfo("Cien años", "García Márquez", TotalPages: 550, Language: "spa")], "9788437604947")!;
        Assert.Equal("Cien", merged.Title);
        Assert.Equal("García Márquez", merged.Author);
        Assert.Equal(550, merged.TotalPages);
        Assert.Equal("spa", merged.Language);
        Assert.Equal("9788437604947", merged.Isbn);
        Assert.NotNull(merged.CoverUrl);
    }

    [Fact]
    public void MergeOfNothingIsNull() => Assert.Null(BookLookup.Merge([null, null]));

    [Fact]
    public async Task ASourceThatFailsDoesNotBreakTheOthersAndDuplicatesAreDropped()
    {
        var broken = new FakeSource { Fails = true };
        var working = new FakeSource();
        working.Hits.AddRange([new BookInfo("Rayuela", "Julio Cortázar"), new BookInfo("RAYUELA", "Julio Cortazar")]);
        var lookup = new BookLookup([broken, working], NullLogger<BookLookup>.Instance);

        var hits = await lookup.SearchAsync("rayuela", CancellationToken.None);

        Assert.Single(hits);
        Assert.Null(await lookup.ByIsbnAsync("9788437604947", CancellationToken.None));
    }

    [Fact]
    public async Task ASearchByIsbnAsksForThatBook()
    {
        var source = new FakeSource();
        source.ByIsbn["9788437604947"] = new BookInfo("Cien años de soledad", "García Márquez", TotalPages: 550);
        var lookup = new BookLookup([source], NullLogger<BookLookup>.Instance);
        Assert.Equal(550, (await lookup.SearchAsync("843760494X", CancellationToken.None)).Single().TotalPages);
    }

    [Fact]
    public async Task AManualBookOnlyMatchesAnExactTitle()
    {
        var source = new FakeSource();
        source.Hits.AddRange([new BookInfo("Dune Messiah", "Frank Herbert", TotalPages: 300), new BookInfo("Dune", "Frank Herbert", TotalPages: 600)]);
        var lookup = new BookLookup([source], NullLogger<BookLookup>.Instance);
        var found = await lookup.FindAsync(new Book { Title = "Dune", Author = "Frank Herbert" }, CancellationToken.None);
        Assert.Equal(600, found?.TotalPages);
        Assert.Null(await lookup.FindAsync(new Book { Title = "Duna", Author = "Frank Herbert" }, CancellationToken.None));
    }
}

public sealed class CoverStoreTests : IDisposable
{
    private readonly string dir = Directory.CreateTempSubdirectory("habit-covers-").FullName;
    public void Dispose() => Directory.Delete(dir, recursive: true);

    private CoverStore Store(Func<HttpRequestMessage, HttpResponseMessage> respond) =>
        new(new StubClients(new StubHandler(respond)), new DataPaths(dir));

    private static HttpResponseMessage Ok(byte[] bytes) => new(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) };

    [Theory]
    [InlineData("https://covers.openlibrary.org/b/id/1-M.jpg", true)]
    [InlineData("https://books.google.com/books/content?id=x", true)]
    [InlineData("https://ia800000.us.archive.org/x.jpg", true)]
    [InlineData("http://covers.openlibrary.org/b/id/1-M.jpg", false)]
    [InlineData("https://covers.openlibrary.org.evil.com/x.jpg", false)]
    [InlineData("https://127.0.0.1/x.jpg", false)]
    [InlineData(null, false)]
    public void OnlyKnownHostsOverHttpsAreAllowed(string? url, bool allowed) => Assert.Equal(allowed, CoverStore.Allowed(url));

    [Fact]
    public async Task SavesAValidImage()
    {
        var store = Store(_ => Ok(BookApiFactory.Jpeg));
        Assert.Equal("image/jpeg", await store.SaveAsync(7, "https://covers.openlibrary.org/b/id/1-M.jpg", CancellationToken.None));
        Assert.Equal(BookApiFactory.Jpeg, await File.ReadAllBytesAsync(store.PathFor(7)));
    }

    [Fact]
    public async Task RejectsWhatIsNotAnImage() =>
        Assert.Null(await Store(_ => Ok("<html>"u8.ToArray())).SaveAsync(7, "https://covers.openlibrary.org/b/id/1-M.jpg", CancellationToken.None));

    [Fact]
    public async Task RejectsAnImageOverTheLimit() =>
        Assert.Null(await Store(_ => Ok([0xFF, 0xD8, 0xFF, .. new byte[400_000]])).SaveAsync(7, "https://covers.openlibrary.org/b/id/1-M.jpg", CancellationToken.None));

    [Fact]
    public async Task FollowsARedirectOnlyToAnAllowedHost()
    {
        var toArchive = Store(request => request.RequestUri!.Host == "covers.openlibrary.org"
            ? new HttpResponseMessage(HttpStatusCode.Found) { Headers = { Location = new Uri("https://ia800000.us.archive.org/x.jpg") } }
            : Ok(BookApiFactory.Jpeg));
        Assert.Equal("image/jpeg", await toArchive.SaveAsync(8, "https://covers.openlibrary.org/b/id/1-M.jpg", CancellationToken.None));

        var toEvil = Store(_ => new HttpResponseMessage(HttpStatusCode.Found) { Headers = { Location = new Uri("http://169.254.169.254/x.jpg") } });
        Assert.Null(await toEvil.SaveAsync(9, "https://covers.openlibrary.org/b/id/1-M.jpg", CancellationToken.None));
    }
}

public sealed class BookApiTests(BookApiFactory factory) : IClassFixture<BookApiFactory>
{
    private static HttpRequestMessage Json(HttpMethod method, string url, object body, bool browser = true)
    {
        var request = new HttpRequestMessage(method, url) { Content = JsonContent.Create(body) };
        if (browser) request.Headers.Add("X-Habit-Request", "1");
        return request;
    }

    private async Task<JsonElement> Add(object body)
    {
        var response = await factory.CreateClient().SendAsync(Json(HttpMethod.Post, "/api/books", body));
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    [Fact]
    public async Task AddsABookPickedFromTheSearchWithItsCover()
    {
        var book = await Add(new { title = "Rayuela", author = "Julio Cortázar", isbn = "978-950-07-3255-0", totalPages = 600,
            coverUrl = "https://covers.openlibrary.org/b/id/1-M.jpg" });
        Assert.Equal("Complete", book.GetProperty("metadataStatus").GetString());
        Assert.True(book.GetProperty("hasCover").GetBoolean());

        var cover = await factory.CreateClient().GetAsync($"/api/books/{book.GetProperty("id").GetInt32()}/cover");
        Assert.Equal("image/jpeg", cover.Content.Headers.ContentType?.MediaType);
        Assert.Equal(BookApiFactory.Jpeg, await cover.Content.ReadAsByteArrayAsync());
    }

    [Fact]
    public async Task ACompleteBookWithAnIsbnIsEnrichedByLookup()
    {
        factory.Source.ByIsbn["9788437604947"] = new BookInfo("Cien años de soledad", "García Márquez", TotalPages: 550, Language: "spa");
        var book = await Add(new { title = "Cien años de soledad", author = "G. G. Márquez", isbn = "843760494X" });
        Assert.Equal(550, book.GetProperty("totalPages").GetInt32());
        Assert.Equal("spa", book.GetProperty("language").GetString());
        Assert.Equal("Complete", book.GetProperty("metadataStatus").GetString());
    }

    [Fact]
    public async Task ABookAddedByIsbnTakesTheAuthorFromTheSource()
    {
        factory.Source.ByIsbn["9780142410370"] = new BookInfo("Matilda", "Roald Dahl", TotalPages: 240);
        var book = await Add(new { title = "Matilda", isbn = "9780142410370" });
        Assert.Equal("Roald Dahl", book.GetProperty("author").GetString());
    }

    [Fact]
    public async Task AManualBookWithoutAMatchStaysPendingWithoutError()
    {
        var book = await Add(new { title = "Libro que nadie conoce" });
        Assert.Equal("Pending", book.GetProperty("metadataStatus").GetString());
        Assert.Equal("Autor no informado", book.GetProperty("author").GetString());
        var cover = await factory.CreateClient().GetAsync($"/api/books/{book.GetProperty("id").GetInt32()}/cover");
        Assert.Equal(HttpStatusCode.NotFound, cover.StatusCode);
    }

    [Fact]
    public async Task RejectsInvalidDuplicatedAndNonBrowserRequests()
    {
        var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(Json(HttpMethod.Post, "/api/books", new { title = "X" }, browser: false))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.SendAsync(Json(HttpMethod.Post, "/api/books", new { title = "" }))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.SendAsync(Json(HttpMethod.Post, "/api/books", new { title = "X", isbn = "9788437604948" }))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.SendAsync(Json(HttpMethod.Post, "/api/books",
            new { title = "X", coverUrl = "https://evil.example/x.jpg" }))).StatusCode);

        await Add(new { title = "Duplicado", isbn = "9780140328721", totalPages = 100 });
        Assert.Equal(HttpStatusCode.Conflict, (await client.SendAsync(Json(HttpMethod.Post, "/api/books",
            new { title = "Duplicado", isbn = "0-14-032872-6", totalPages = 100 }))).StatusCode);
    }

    [Fact]
    public async Task EditsThePageAndArchivesWithinTheBookLimits()
    {
        var client = factory.CreateClient();
        var id = (await Add(new { title = "Con páginas", totalPages = 200 })).GetProperty("id").GetInt32();

        Assert.Equal(HttpStatusCode.BadRequest, (await client.SendAsync(Json(HttpMethod.Patch, $"/api/books/{id}", new { page = 201 }))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.SendAsync(Json(HttpMethod.Patch, "/api/books/999999", new { page = 1 }))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Json(HttpMethod.Patch, $"/api/books/{id}", new { page = 120 }))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Json(HttpMethod.Patch, $"/api/books/{id}", new { archived = true }))).StatusCode);

        var active = await client.GetFromJsonAsync<JsonElement[]>("/api/books");
        var archived = await client.GetFromJsonAsync<JsonElement[]>("/api/books?archived=true");
        Assert.DoesNotContain(active!, book => book.GetProperty("id").GetInt32() == id);
        Assert.Equal(120, archived!.Single(book => book.GetProperty("id").GetInt32() == id).GetProperty("page").GetInt32());
    }

    [Fact]
    public async Task SearchReturnsTheHitsOfTheSources()
    {
        factory.Source.Hits.Clear();
        factory.Source.Hits.Add(new BookInfo("Ficciones", "Jorge Luis Borges"));
        var hits = await factory.CreateClient().GetFromJsonAsync<JsonElement[]>("/api/books/search?q=ficciones");
        Assert.Equal("Ficciones", hits!.Single().GetProperty("title").GetString());
        Assert.Equal(HttpStatusCode.BadRequest, (await factory.CreateClient().GetAsync("/api/books/search?q=a")).StatusCode);
    }

    [Fact]
    public async Task TheWorkerCompletesPendingBooksAndStopsAtTheAttemptLimit()
    {
        factory.Source.Hits.Clear();
        var worker = new MetadataWorker(factory.Services.GetRequiredService<IServiceScopeFactory>(), NullLogger<MetadataWorker>.Instance);
        var id = (await Add(new { title = "Libro tardío", author = "Ana Pérez" })).GetProperty("id").GetInt32();

        for (var run = 0; run < 7; run++) await worker.RunOnceAsync(CancellationToken.None);
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var book = await scope.ServiceProvider.GetRequiredService<HabitDb>().Books.IgnoreQueryFilters().SingleAsync(item => item.Id == id);
            Assert.Equal(BookEnricher.MaxAttempts, book.MetadataAttempts);
            Assert.Equal(MetadataStatus.Pending, book.MetadataStatus);
        }

        factory.Source.Hits.Add(new BookInfo("Libro tardío", "Ana Pérez", TotalPages: 321));
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HabitDb>();
            var book = await db.Books.IgnoreQueryFilters().SingleAsync(item => item.Id == id);
            book.MetadataAttempts = 0;
            await db.SaveChangesAsync();
        }
        await worker.RunOnceAsync(CancellationToken.None);
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var book = await scope.ServiceProvider.GetRequiredService<HabitDb>().Books.IgnoreQueryFilters().SingleAsync(item => item.Id == id);
            Assert.Equal(MetadataStatus.Complete, book.MetadataStatus);
            Assert.Equal(321, book.TotalPages);
        }
    }
}
