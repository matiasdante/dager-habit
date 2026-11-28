using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Caching.Memory;

internal sealed partial class BookCatalog(HttpClient client, IMemoryCache cache, CatalogThrottle throttle)
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/catalog", async (string? q, BookCatalog catalog, CancellationToken cancellation) =>
        {
            var query = q?.Trim();
            if (query is not { Length: >= 2 and <= 120 }) return Results.BadRequest();
            try { return Results.Ok(await catalog.SearchAsync(query, cancellation)); }
            catch (Exception error) when (Upstream(error))
            { return Results.Problem("Open Library no está disponible.", statusCode: 502); }
        });

        app.MapGet("/api/catalog/book", async (string? work, string? edition, BookCatalog catalog, CancellationToken cancellation) =>
        {
            if (work is null || !WorkId().IsMatch(work) || (edition is not null && !EditionId().IsMatch(edition)))
                return Results.BadRequest();
            try { return Results.Ok(await catalog.DetailAsync(work, edition, cancellation)); }
            catch (Exception error) when (Upstream(error))
            { return Results.Problem("No se pudo consultar la edición.", statusCode: 502); }
        });

        app.MapGet("/api/catalog/editions", async (string? work, string? edition, int? offset, BookCatalog catalog,
            CancellationToken cancellation) =>
        {
            if (work is null || !WorkId().IsMatch(work) || (edition is not null && !EditionId().IsMatch(edition)) ||
                offset is < 0 or > int.MaxValue - EditionPageSize) return Results.BadRequest();
            try { return Results.Ok(await catalog.EditionsAsync(work, edition, offset ?? 0, cancellation)); }
            catch (Exception error) when (Upstream(error))
            { return Results.Problem("No se pudieron consultar las ediciones.", statusCode: 502); }
        });
    }

    private const int EditionPageSize = 20;

    private async Task<CatalogMatch[]> SearchAsync(string query, CancellationToken cancellation)
    {
        var isbn = IsbnSeparators().Replace(query, "");
        var search = Isbn().IsMatch(isbn) ? "isbn:" + isbn.ToUpperInvariant() : query;
        var path = "search.json?limit=8&lang=es&fields=key,title,author_name,cover_i,editions,editions.key,editions.title&q=" +
            Uri.EscapeDataString(search);
        var root = await GetAsync(path, cancellation);
        var matches = new List<CatalogMatch>();
        foreach (var item in ArrayAt(root, "docs"))
        {
            var work = TextAt(item, "key")?.Split('/').Last();
            var edition = item.TryGetProperty("editions", out var editions) ? ArrayAt(editions, "docs").FirstOrDefault() : default;
            var editionKey = TextAt(edition, "key")?.Split('/').Last();
            var title = TextAt(edition, "title") ?? TextAt(item, "title");
            var author = string.Join(", ", ArrayAt(item, "author_name").Where(name => name.ValueKind == JsonValueKind.String)
                .Select(name => name.GetString()));
            if (work is null || !WorkId().IsMatch(work) || string.IsNullOrWhiteSpace(title)) continue;
            matches.Add(new CatalogMatch(work, editionKey is not null && EditionId().IsMatch(editionKey) ? editionKey : null,
                Shorten(title.Trim(), 150), string.IsNullOrWhiteSpace(author) ? "Autor no informado" : Shorten(author.Trim(), 100),
                PositiveAt(item, "cover_i")));
        }
        return matches.ToArray();
    }

    private async Task<CatalogEditions> EditionsAsync(string work, string? preferred, int offset, CancellationToken cancellation)
    {
        var root = await GetAsync($"works/{work}/editions.json?limit={EditionPageSize}&offset={offset}", cancellation);
        var entries = ArrayAt(root, "entries").Take(EditionPageSize).ToArray();
        var editions = entries.Select(ReadEdition).OfType<CatalogEdition>().DistinctBy(item => item.Id).ToList();
        if (offset == 0 && preferred is not null)
        {
            var edition = editions.Find(item => item.Id == preferred);
            if (edition is null)
            {
                try
                {
                    var data = await GetAsync("books/" + preferred + ".json", cancellation);
                    if (ArrayAt(data, "works").Any(link => TextAt(link, "key") == "/works/" + work))
                        edition = ReadEdition(data);
                }
                catch (HttpRequestException error) when (error.StatusCode == HttpStatusCode.NotFound) { }
            }
            if (edition is not null)
            {
                editions.Remove(edition);
                editions.Insert(0, edition);
            }
        }

        var size = PositiveAt(root, "size");
        var nextOffset = offset + entries.Length;
        return new CatalogEditions(editions.ToArray(),
            (size.HasValue ? nextOffset < size.Value : entries.Length == EditionPageSize) && entries.Length > 0 ? nextOffset : null);
    }

    private static CatalogEdition? ReadEdition(JsonElement data)
    {
        var id = TextAt(data, "key")?.Split('/').Last();
        var title = TextAt(data, "title")?.Trim();
        if (id is null || !EditionId().IsMatch(id) || string.IsNullOrEmpty(title)) return null;
        var published = PublicationYear().Match(TextAt(data, "publish_date") ?? "");
        var language = ArrayAt(data, "languages").Select(item => TextAt(item, "key")?.Split('/').Last())
            .FirstOrDefault(code => code is not null && LanguageCode().IsMatch(code));
        var pages = PositiveAt(data, "number_of_pages");
        return new CatalogEdition(id, Shorten(title, 150), language, published.Success ? int.Parse(published.Value) : null,
            pages <= 100_000 ? pages : null);
    }

    private async Task<CatalogDetail> DetailAsync(string work, string? edition, CancellationToken cancellation)
    {
        var item = await GetAsync("works/" + work + ".json", cancellation);
        var summary = TextAt(item, "description");
        if (summary is null && item.TryGetProperty("description", out var description)) summary = TextAt(description, "value");
        int? pages = null;
        int? cover = CoverAt(item);
        if (edition is not null)
        {
            var editionData = await GetAsync("books/" + edition + ".json", cancellation);
            var works = ArrayAt(editionData, "works");
            if (works.Length > 0 && !works.Any(link => TextAt(link, "key") == "/works/" + work))
                throw new InvalidDataException("Catalog edition does not match work");
            pages = PositiveAt(editionData, "number_of_pages");
            if (pages > 100_000) pages = null;
            cover = CoverAt(editionData) ?? cover;
        }

        return new CatalogDetail(summary is null ? null : Shorten(
            Whitespace().Replace(WebUtility.HtmlDecode(Markup().Replace(summary, " ")), " ").Trim(), 500), cover, pages);
    }

    internal async Task<JsonElement> GetAsync(string path, CancellationToken cancellation)
    {
        var key = "catalog:" + path;
        if (cache.TryGetValue<JsonElement>(key, out var cached)) return cached;
        var data = await throttle.RunAsync(async () =>
        {
            if (cache.TryGetValue<JsonElement>(key, out var found)) return found;
            using var response = await client.GetAsync(path, cancellation);
            response.EnsureSuccessStatusCode();
            using var json = JsonDocument.Parse(await response.Content.ReadAsStreamAsync(cancellation));
            var root = json.RootElement.Clone();
            cache.Set(key, root, TimeSpan.FromHours(1));
            return root;
        }, cancellation);
        return data;
    }

    private static bool Upstream(Exception error) =>
        error is HttpRequestException or TaskCanceledException or JsonException or InvalidDataException or InvalidOperationException;
    internal static string? TextAt(JsonElement node, string name) =>
        node.ValueKind == JsonValueKind.Object && node.TryGetProperty(name, out var field) && field.ValueKind == JsonValueKind.String
            ? field.GetString() : null;
    internal static JsonElement[] ArrayAt(JsonElement node, string name) =>
        node.ValueKind == JsonValueKind.Object && node.TryGetProperty(name, out var field) && field.ValueKind == JsonValueKind.Array
            ? field.EnumerateArray().ToArray() : [];
    internal static int? PositiveAt(JsonElement item, string name) =>
        item.TryGetProperty(name, out var field) && field.ValueKind == JsonValueKind.Number && field.TryGetInt32(out var value) && value > 0
            ? value : null;
    private static int? CoverAt(JsonElement item)
    {
        foreach (var cover in ArrayAt(item, "covers"))
            if (cover.ValueKind == JsonValueKind.Number && cover.TryGetInt32(out var value) && value > 0) return value;
        return null;
    }
    internal static string Shorten(string value, int length) => value.Length > length ? value[..(length - 1)].TrimEnd() + "…" : value;

    [GeneratedRegex(@"^OL[0-9]{1,12}W$")] private static partial Regex WorkId();
    [GeneratedRegex(@"^OL[0-9]{1,12}M$")] private static partial Regex EditionId();
    [GeneratedRegex(@"^(?:[0-9]{13}|[0-9]{9}[0-9Xx])$")] private static partial Regex Isbn();
    [GeneratedRegex(@"[\s\p{Pd}]")] private static partial Regex IsbnSeparators();
    [GeneratedRegex(@"\b[1-9][0-9]{3}\b")] private static partial Regex PublicationYear();
    [GeneratedRegex(@"^[a-z]{3}$")] private static partial Regex LanguageCode();
    [GeneratedRegex(@"<[^>]*>", RegexOptions.NonBacktracking)] private static partial Regex Markup();
    [GeneratedRegex(@"\s+", RegexOptions.NonBacktracking)] private static partial Regex Whitespace();

    private sealed record CatalogMatch(string WorkId, string? EditionId, string Title, string Author, int? CoverId);
    private sealed record CatalogDetail(string? Summary, int? CoverId, int? TotalPages);
    private sealed record CatalogEdition(string Id, string Title, string? Language, int? PublicationYear, int? TotalPages);
    private sealed record CatalogEditions(CatalogEdition[] Editions, int? NextOffset);
}

internal sealed class CatalogThrottle : IDisposable
{
    private readonly SemaphoreSlim gate = new(1);
    private DateTimeOffset nextRequest;

    public async Task<T> RunAsync<T>(Func<Task<T>> fetch, CancellationToken cancellation)
    {
        if (!await gate.WaitAsync(TimeSpan.FromSeconds(5), cancellation))
            throw new HttpRequestException("Catalog queue busy");
        try
        {
            var delay = nextRequest - DateTimeOffset.UtcNow;
            if (delay > TimeSpan.Zero) await Task.Delay(delay, cancellation);
            nextRequest = DateTimeOffset.UtcNow.AddSeconds(1);
            return await fetch();
        }
        finally { gate.Release(); }
    }

    public void Dispose() => gate.Dispose();
}
