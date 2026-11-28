using System.Text.Json;
using System.Text.RegularExpressions;

internal sealed record BookInfo(string Title, string Author, string? Isbn = null, int? TotalPages = null,
    string? Language = null, int? PublicationYear = null, string? Summary = null, string? CoverUrl = null)
{
    public const string UnknownAuthor = "Autor no informado";
}

/// <summary>Una fuente pública de fichas de libros. Se suma otra implementando esta interfaz.</summary>
internal interface IBookSource
{
    Task<IReadOnlyList<BookInfo>> SearchAsync(string query, CancellationToken cancellation);
    Task<BookInfo?> ByIsbnAsync(string isbn, CancellationToken cancellation);
}

internal static partial class Isbn
{
    /// <summary>Devuelve el ISBN-13 sin separadores, o null si no es un ISBN válido (el dígito verificador tiene que cerrar).</summary>
    public static string? Normalize(string? value)
    {
        if (value is null) return null;
        var text = Separators().Replace(value, "").ToUpperInvariant();
        if (Thirteen().IsMatch(text)) return Check13(text) ? text : null;
        if (!Ten().IsMatch(text)) return null;
        var sum = 0;
        for (var i = 0; i < 10; i++) sum += (10 - i) * (text[i] == 'X' ? 10 : text[i] - '0');
        if (sum % 11 != 0) return null;
        var body = "978" + text[..9];
        return body + ((10 - body.Select((digit, i) => (digit - '0') * (i % 2 == 0 ? 1 : 3)).Sum() % 10) % 10);
    }

    private static bool Check13(string text) =>
        text.Select((digit, i) => (digit - '0') * (i % 2 == 0 ? 1 : 3)).Sum() % 10 == 0;

    [GeneratedRegex(@"[\s\p{Pd}]")] private static partial Regex Separators();
    [GeneratedRegex(@"^[0-9]{13}$")] private static partial Regex Thirteen();
    [GeneratedRegex(@"^[0-9]{9}[0-9X]$")] private static partial Regex Ten();
}

internal sealed partial class OpenLibrarySource(BookCatalog catalog) : IBookSource
{
    public async Task<IReadOnlyList<BookInfo>> SearchAsync(string query, CancellationToken cancellation)
    {
        var root = await catalog.GetAsync("search.json?limit=8&lang=es&fields=title,author_name,cover_i,first_publish_year," +
            "number_of_pages_median&q=" + Uri.EscapeDataString(query), cancellation);
        var books = new List<BookInfo>();
        foreach (var item in BookCatalog.ArrayAt(root, "docs"))
        {
            var title = BookCatalog.TextAt(item, "title")?.Trim();
            if (string.IsNullOrEmpty(title)) continue;
            var authors = string.Join(", ", BookCatalog.ArrayAt(item, "author_name")
                .Where(name => name.ValueKind == JsonValueKind.String).Select(name => name.GetString()));
            var cover = BookCatalog.PositiveAt(item, "cover_i");
            // Sin idioma: la búsqueda lista los de todas las ediciones y no dice cuál es la que se elige.
            books.Add(new BookInfo(BookCatalog.Shorten(title, 200), AuthorOrDefault(authors), null,
                Pages(BookCatalog.PositiveAt(item, "number_of_pages_median")), null,
                BookCatalog.PositiveAt(item, "first_publish_year"),
                CoverUrl: cover is null ? null : $"https://covers.openlibrary.org/b/id/{cover}-M.jpg"));
        }
        return books;
    }

    public async Task<BookInfo?> ByIsbnAsync(string isbn, CancellationToken cancellation)
    {
        var root = await catalog.GetAsync($"api/books?bibkeys=ISBN:{isbn}&format=json&jscmd=data", cancellation);
        if (!root.TryGetProperty("ISBN:" + isbn, out var item)) return null;
        var title = BookCatalog.TextAt(item, "title")?.Trim();
        if (string.IsNullOrEmpty(title)) return null;
        var authors = string.Join(", ", BookCatalog.ArrayAt(item, "authors").Select(author => BookCatalog.TextAt(author, "name"))
            .Where(name => !string.IsNullOrWhiteSpace(name)));
        var year = Year().Match(BookCatalog.TextAt(item, "publish_date") ?? "");
        var cover = item.TryGetProperty("cover", out var covers) ? BookCatalog.TextAt(covers, "medium") : null;
        return new BookInfo(BookCatalog.Shorten(title, 200), AuthorOrDefault(authors), isbn,
            Pages(BookCatalog.PositiveAt(item, "number_of_pages")), null, year.Success ? int.Parse(year.Value) : null,
            CoverUrl: cover);
    }

    internal static string AuthorOrDefault(string authors) =>
        string.IsNullOrWhiteSpace(authors) ? BookInfo.UnknownAuthor : BookCatalog.Shorten(authors.Trim(), 150);
    internal static int? Pages(int? pages) => pages is > 0 and <= 100_000 ? pages : null;

    [GeneratedRegex(@"\b[1-9][0-9]{3}\b")] private static partial Regex Year();
}

/// <summary>Solo se registra si el servidor define GOOGLE_BOOKS_API_KEY: sin clave Google responde con cuota diaria cero.</summary>
internal sealed partial class GoogleBooksSource(HttpClient client, IConfiguration config) : IBookSource
{
    private const string Fields = "items(volumeInfo(title,authors,pageCount,language,publishedDate,description," +
        "imageLinks/thumbnail,industryIdentifiers))";

    public async Task<IReadOnlyList<BookInfo>> SearchAsync(string query, CancellationToken cancellation) =>
        await QueryAsync(query, 8, cancellation);

    public async Task<BookInfo?> ByIsbnAsync(string isbn, CancellationToken cancellation) =>
        (await QueryAsync("isbn:" + isbn, 1, cancellation)).FirstOrDefault() is { } info ? info with { Isbn = isbn } : null;

    private async Task<IReadOnlyList<BookInfo>> QueryAsync(string query, int max, CancellationToken cancellation)
    {
        var url = $"books/v1/volumes?printType=books&maxResults={max}&fields={Uri.EscapeDataString(Fields)}" +
            $"&key={Uri.EscapeDataString(config["GOOGLE_BOOKS_API_KEY"]!)}&q={Uri.EscapeDataString(query)}";
        using var response = await client.GetAsync(url, cancellation);
        response.EnsureSuccessStatusCode();
        using var json = JsonDocument.Parse(await response.Content.ReadAsStreamAsync(cancellation));
        var books = new List<BookInfo>();
        foreach (var item in BookCatalog.ArrayAt(json.RootElement, "items"))
        {
            if (!item.TryGetProperty("volumeInfo", out var info)) continue;
            var title = BookCatalog.TextAt(info, "title")?.Trim();
            if (string.IsNullOrEmpty(title)) continue;
            var authors = string.Join(", ", BookCatalog.ArrayAt(info, "authors")
                .Where(name => name.ValueKind == JsonValueKind.String).Select(name => name.GetString()));
            var isbn = BookCatalog.ArrayAt(info, "industryIdentifiers")
                .Select(id => BookCatalog.TextAt(id, "type") is "ISBN_13" or "ISBN_10" ? Isbn.Normalize(BookCatalog.TextAt(id, "identifier")) : null)
                .FirstOrDefault(value => value is not null);
            var year = Year().Match(BookCatalog.TextAt(info, "publishedDate") ?? "");
            var language = BookCatalog.TextAt(info, "language");
            var thumbnail = info.TryGetProperty("imageLinks", out var links) ? BookCatalog.TextAt(links, "thumbnail") : null;
            var summary = BookCatalog.TextAt(info, "description");
            books.Add(new BookInfo(BookCatalog.Shorten(title, 200), OpenLibrarySource.AuthorOrDefault(authors), isbn,
                OpenLibrarySource.Pages(BookCatalog.PositiveAt(info, "pageCount")),
                language is not null && Code().IsMatch(language) ? language : null, year.Success ? int.Parse(year.Value) : null,
                summary is null ? null : BookCatalog.Shorten(Markup().Replace(summary, " ").Trim(), 500),
                // Google entrega la miniatura por http y con un borde curvo que sobra.
                thumbnail?.Replace("http://", "https://").Replace("&edge=curl", "")));
        }
        return books;
    }

    [GeneratedRegex(@"^[a-z]{2,3}$")] private static partial Regex Code();
    [GeneratedRegex(@"\b[1-9][0-9]{3}\b")] private static partial Regex Year();
    [GeneratedRegex(@"<[^>]*>", RegexOptions.NonBacktracking)] private static partial Regex Markup();
}

/// <summary>Consulta todas las fuentes a la vez y completa los datos que falten con las que sigan en orden.</summary>
internal sealed class BookLookup(IEnumerable<IBookSource> sources, ILogger<BookLookup> log)
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(8);

    public async Task<IReadOnlyList<BookInfo>> SearchAsync(string query, CancellationToken cancellation)
    {
        if (Isbn.Normalize(query) is { } isbn)
            return await ByIsbnAsync(isbn, cancellation) is { } found ? [found] : [];
        var results = await Task.WhenAll(sources.Select(source =>
            Safe(source, token => source.SearchAsync(query, token), [], cancellation)));
        return results.SelectMany(list => list).DistinctBy(book => Key(book.Title, book.Author)).Take(10).ToList();
    }

    public async Task<BookInfo?> ByIsbnAsync(string isbn, CancellationToken cancellation)
    {
        var found = await Task.WhenAll(sources.Select(source =>
            Safe(source, token => source.ByIsbnAsync(isbn, token), null, cancellation)));
        return Merge(found, isbn);
    }

    /// <summary>Para un libro cargado a mano: por ISBN si lo tiene, y si no, solo una coincidencia exacta de título y autor.</summary>
    public async Task<BookInfo?> FindAsync(Book book, CancellationToken cancellation)
    {
        if (book.Isbn is not null) return await ByIsbnAsync(book.Isbn, cancellation);
        var hits = await SearchAsync($"{book.Title} {book.Author}", cancellation);
        return hits.FirstOrDefault(hit => Key(hit.Title, "") == Key(book.Title, "") &&
            (book.Author == BookInfo.UnknownAuthor || Key(hit.Author, "").Contains(Key(book.Author, ""))));
    }

    internal static BookInfo? Merge(IEnumerable<BookInfo?> infos, string? isbn = null)
    {
        var list = infos.OfType<BookInfo>().ToList();
        if (list.Count == 0) return null;
        T? First<T>(Func<BookInfo, T?> pick) where T : struct => list.Select(pick).FirstOrDefault(value => value is not null);
        string? Text(Func<BookInfo, string?> pick) => list.Select(pick).FirstOrDefault(value => !string.IsNullOrWhiteSpace(value));
        var author = list.Select(info => info.Author).FirstOrDefault(name => name != BookInfo.UnknownAuthor) ?? list[0].Author;
        return new BookInfo(list[0].Title, author, isbn ?? Text(info => info.Isbn), First(info => info.TotalPages),
            Text(info => info.Language), First(info => info.PublicationYear), Text(info => info.Summary),
            Text(info => info.CoverUrl));
    }

    // Tabla propia para no depender de ICU: Normalize no descompone acentos en imágenes sin esa biblioteca.
    private const string Accented = "áàâäãåéèêëíìîïóòôöõúùûüñç";
    private const string Plain = "aaaaaaeeeeiiiiooooouuuunc";

    internal static string Key(string title, string author) =>
        new((title + " " + author).ToLowerInvariant().Where(char.IsLetterOrDigit)
            .Select(c => Accented.IndexOf(c) is var at and >= 0 ? Plain[at] : c).ToArray());

    private async Task<T> Safe<T>(IBookSource source, Func<CancellationToken, Task<T>> call, T fallback, CancellationToken cancellation)
    {
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        limit.CancelAfter(Timeout);
        try { return await call(limit.Token); }
        catch (Exception error) when (!cancellation.IsCancellationRequested &&
            error is HttpRequestException or TaskCanceledException or JsonException or InvalidDataException or InvalidOperationException)
        {
            log.LogWarning("La fuente {Source} no respondió ({Error}).", source.GetType().Name, error.GetType().Name);
            return fallback;
        }
    }
}
