using Microsoft.EntityFrameworkCore;

internal sealed record DataPaths(string Root);

internal sealed record AddBook(string? Title, string? Author, string? Isbn, int? TotalPages, string? Language,
    int? PublicationYear, string? Summary, string? CoverUrl);

internal sealed record EditBook(int? Page, int? TotalPages, bool? Archived, string? Title, string? Author);

/// <summary>Guarda en el volumen la portada de cada libro. Solo baja imágenes chicas de hosts conocidos.</summary>
internal sealed class CoverStore(IHttpClientFactory clients, DataPaths paths)
{
    private const int MaxBytes = 300_000;

    public string PathFor(int bookId) => Path.Combine(paths.Root, "covers", bookId.ToString());

    public static bool Allowed(string? url) =>
        url is { Length: <= 500 } && Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps &&
        (uri.Host is "covers.openlibrary.org" or "books.google.com" or "archive.org" || uri.Host.EndsWith(".archive.org"));

    /// <summary>Devuelve el tipo MIME guardado, o null si la portada no se pudo bajar o no es una imagen válida.</summary>
    public async Task<string?> SaveAsync(int bookId, string url, CancellationToken cancellation)
    {
        try
        {
            var client = clients.CreateClient("covers");
            for (var hop = 0; hop < 3 && Allowed(url); hop++)
            {
                using var response = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellation);
                if ((int)response.StatusCode is >= 300 and < 400 && response.Headers.Location is { } next)
                {
                    url = new Uri(new Uri(url), next).ToString();
                    continue;
                }
                if (!response.IsSuccessStatusCode || response.Content.Headers.ContentLength > MaxBytes) return null;
                var bytes = await ReadAsync(response, cancellation);
                if (bytes is null || Sniff(bytes) is not { } type) return null;
                Directory.CreateDirectory(Path.GetDirectoryName(PathFor(bookId))!);
                await File.WriteAllBytesAsync(PathFor(bookId), bytes, cancellation);
                return type;
            }
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException or IOException or UriFormatException)
        {
            // La portada es opcional: sin ella el libro igual queda guardado.
        }
        return null;
    }

    internal static string? Sniff(byte[] bytes) => bytes switch
    {
        [0xFF, 0xD8, 0xFF, ..] => "image/jpeg",
        [0x89, 0x50, 0x4E, 0x47, ..] => "image/png",
        [0x52, 0x49, 0x46, 0x46, _, _, _, _, 0x57, 0x45, 0x42, 0x50, ..] => "image/webp",
        _ => null
    };

    private static async Task<byte[]?> ReadAsync(HttpResponseMessage response, CancellationToken cancellation)
    {
        await using var stream = await response.Content.ReadAsStreamAsync(cancellation);
        using var buffer = new MemoryStream();
        var chunk = new byte[16_384];
        int read;
        while ((read = await stream.ReadAsync(chunk, cancellation)) > 0)
        {
            buffer.Write(chunk, 0, read);
            if (buffer.Length > MaxBytes) return null;
        }
        return buffer.ToArray();
    }
}

/// <summary>Completa los datos que le faltan a un libro. Se usa al agregarlo y desde el reintento en segundo plano.</summary>
internal sealed class BookEnricher(BookLookup lookup, CoverStore covers)
{
    public const int MaxAttempts = 5;

    public async Task EnrichAsync(Book book, string? coverUrl, CancellationToken cancellation)
    {
        if (book.TotalPages is null)
        {
            book.MetadataAttempts++;
            var info = await lookup.FindAsync(book, cancellation);
            if (info is not null)
            {
                if (book.Author == BookInfo.UnknownAuthor) book.Author = info.Author;
                book.Isbn ??= info.Isbn;
                book.TotalPages = info.TotalPages;
                book.Language ??= info.Language;
                book.PublicationYear ??= info.PublicationYear;
                book.Summary ??= info.Summary;
                coverUrl ??= info.CoverUrl;
            }
        }
        if (book.CoverType is null && coverUrl is not null)
            book.CoverType = await covers.SaveAsync(book.Id, coverUrl, cancellation);
        if (book.TotalPages is not null) book.MetadataStatus = MetadataStatus.Complete;
    }
}

/// <summary>Reintenta cada pocas horas los libros que quedaron sin datos, con un tope de intentos por libro.</summary>
internal sealed class MetadataWorker(IServiceScopeFactory scopes, ILogger<MetadataWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromHours(6));
        do
        {
            try { await RunOnceAsync(stop); }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                log.LogWarning("No se pudieron completar los datos de los libros ({Error}).", error.GetType().Name);
            }
        } while (await timer.WaitForNextTickAsync(stop));
    }

    internal async Task RunOnceAsync(CancellationToken cancellation)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<HabitDb>();
        var enricher = scope.ServiceProvider.GetRequiredService<BookEnricher>();
        // Es una tarea del servidor, sin persona de por medio: recorre los libros de todos.
        var pending = await db.Books.IgnoreQueryFilters()
            .Where(book => book.MetadataStatus == MetadataStatus.Pending && book.MetadataAttempts < BookEnricher.MaxAttempts)
            .OrderBy(book => book.Id).Take(10).ToListAsync(cancellation);
        foreach (var book in pending)
        {
            await enricher.EnrichAsync(book, null, cancellation);
            await db.SaveChangesAsync(cancellation);
        }
    }
}

internal static class BookEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/books/search", async (string? q, BookLookup lookup, CancellationToken cancellation) =>
            q?.Trim() is { Length: >= 2 and <= 120 } query ? Results.Ok(await lookup.SearchAsync(query, cancellation)) : Results.BadRequest());

        app.MapGet("/api/books", async (bool? archived, HabitDb db, CancellationToken cancellation) =>
            Results.Ok((await db.Books.Where(book => book.Archived == (archived ?? false))
                .OrderByDescending(book => book.CreatedAt).ToListAsync(cancellation)).Select(Dto)));

        app.MapPost("/api/books", async (HttpContext context, AddBook request, HabitDb db, CurrentUser current,
            BookEnricher enricher, CancellationToken cancellation) =>
        {
            if (!AppAccess.IsBrowserRequest(context)) return Results.StatusCode(403);
            var title = request.Title?.Trim();
            var author = request.Author?.Trim();
            var isbn = Isbn.Normalize(request.Isbn);
            var problems = new Dictionary<string, string[]>();
            if (title is not { Length: > 0 and <= 200 }) problems["title"] = ["Escribí el título (hasta 200 caracteres)."];
            if (author is { Length: > 150 }) problems["author"] = ["El autor admite hasta 150 caracteres."];
            if (request.Isbn is { Length: > 0 } && isbn is null) problems["isbn"] = ["El ISBN no es válido."];
            if (request.TotalPages is < 1 or > 100_000) problems["totalPages"] = ["Las páginas van de 1 a 100000."];
            if (request.Language is not null && !System.Text.RegularExpressions.Regex.IsMatch(request.Language, "^[a-z]{2,3}$"))
                problems["language"] = ["El idioma no es válido."];
            if (request.PublicationYear is < 1000 or > 3000) problems["publicationYear"] = ["El año no es válido."];
            if (request.Summary is { Length: > 1000 }) problems["summary"] = ["El resumen admite hasta 1000 caracteres."];
            if (request.CoverUrl is not null && !CoverStore.Allowed(request.CoverUrl)) problems["coverUrl"] = ["La portada no es válida."];
            if (problems.Count > 0) return Results.ValidationProblem(problems);

            if (isbn is not null && await db.Books.FirstOrDefaultAsync(book => book.Isbn == isbn, cancellation) is { } existing)
                return Results.Conflict(new { id = existing.Id });

            var book = new Book
            {
                UserId = current.Id, Title = title!, Author = string.IsNullOrEmpty(author) ? BookInfo.UnknownAuthor : author,
                Isbn = isbn, TotalPages = request.TotalPages, Language = request.Language,
                PublicationYear = request.PublicationYear, Summary = request.Summary,
                MetadataStatus = MetadataStatus.Pending
            };
            db.Books.Add(book);
            await db.SaveChangesAsync(cancellation);
            await enricher.EnrichAsync(book, request.CoverUrl, cancellation);
            await db.SaveChangesAsync(cancellation);
            return Results.Created($"/api/books/{book.Id}", Dto(book));
        });

        app.MapPatch("/api/books/{id:int}", async (HttpContext context, int id, EditBook change, HabitDb db,
            CancellationToken cancellation) =>
        {
            if (!AppAccess.IsBrowserRequest(context)) return Results.StatusCode(403);
            // Se busca con consulta y no con Find: Find salteaba el filtro por persona.
            if (await db.Books.FirstOrDefaultAsync(book => book.Id == id, cancellation) is not { } book) return Results.NotFound();
            var title = change.Title?.Trim();
            var author = change.Author?.Trim();
            var total = change.TotalPages ?? book.TotalPages;
            var problems = new Dictionary<string, string[]>();
            if (change.Title is not null && title is not { Length: > 0 and <= 200 }) problems["title"] = ["Escribí el título (hasta 200 caracteres)."];
            if (change.Author is not null && author is not { Length: > 0 and <= 150 }) problems["author"] = ["Escribí el autor (hasta 150 caracteres)."];
            if (change.TotalPages is < 1 or > 100_000) problems["totalPages"] = ["Las páginas van de 1 a 100000."];
            if (change.Page is < 0 || change.Page > (total ?? 100_000)) problems["page"] = ["La página tiene que estar entre 0 y el total del libro."];
            if (change.TotalPages is not null && book.Page > change.TotalPages && change.Page is null)
                problems["totalPages"] = ["El total no puede ser menor que la página que ya leíste."];
            if (problems.Count > 0) return Results.ValidationProblem(problems);

            if (title is not null) book.Title = title;
            if (author is not null) book.Author = author;
            if (change.TotalPages is not null) book.TotalPages = change.TotalPages;
            if (change.Page is not null) book.Page = change.Page;
            if (change.Archived is not null) book.Archived = change.Archived.Value;
            if (book.TotalPages is not null) book.MetadataStatus = MetadataStatus.Complete;
            await db.SaveChangesAsync(cancellation);
            return Results.Ok(Dto(book));
        });

        app.MapGet("/api/books/{id:int}/cover", async (int id, HabitDb db, CoverStore covers, CancellationToken cancellation) =>
            await db.Books.FirstOrDefaultAsync(book => book.Id == id, cancellation) is { CoverType: { } type } && File.Exists(covers.PathFor(id))
                ? Results.File(covers.PathFor(id), type) : Results.NotFound());
    }

    private static object Dto(Book book) => new
    {
        book.Id, book.Title, book.Author, book.Isbn, book.TotalPages, book.Page, book.Language, book.PublicationYear,
        book.Summary, book.Archived, MetadataStatus = book.MetadataStatus.ToString(), HasCover = book.CoverType is not null,
        book.CreatedAt
    };
}
