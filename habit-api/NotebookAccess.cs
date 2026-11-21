using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Caching.Memory;

internal sealed partial class NotebookAccess(HttpClient client, IMemoryCache cache, IConfiguration config, IWebHostEnvironment environment)
{
    private const string Scope = "https://www.googleapis.com/auth/discoveryengine.readwrite";
    private const string StateCookie = "__Host-habit-google-state";
    private const string SessionCookie = "__Host-habit-google";
    private const string Callback = "/api/notebook/callback";
    private const string NotebookPage = "/#/notebook";
    private static readonly TimeSpan StateAge = TimeSpan.FromMinutes(10);

    public static void Map(WebApplication app)
    {
        app.MapGet("/api/notebook/status", async (HttpContext context, NotebookAccess access, CancellationToken cancellation) =>
            await access.StatusAsync(context, cancellation));
        app.MapPost("/api/notebook/connect", (HttpContext context, NotebookAccess access) => access.Begin(context));
        app.MapGet(Callback, async (HttpContext context, string? code, string? state, NotebookAccess access, CancellationToken cancellation) =>
            await access.CompleteAsync(context, code, state, cancellation));
        app.MapPost("/api/notebook/sync", async (HttpContext context, NotebookSync request, NotebookAccess access, CancellationToken cancellation) =>
            await access.SyncAsync(context, request, cancellation));
        app.MapPost("/api/notebook/logout", (HttpContext context, NotebookAccess access) => access.Logout(context));
    }

    private async Task<IResult> StatusAsync(HttpContext context, CancellationToken cancellation)
    {
        var options = Options();
        var appConnected = AppAccess.HasCookie(context, config);
        var google = appConnected ? AccessToken(context) : null;
        if (options is null || google is null)
            return Results.Ok(new NotebookStatus(options is not null, appConnected, false, false, [], options?.Home));

        try
        {
            using var response = await ListAsync(options, google, cancellation);
            if (response.StatusCode == HttpStatusCode.Unauthorized)
            {
                SignOut(context, cache);
                return Results.Ok(new NotebookStatus(true, true, false, false, [], options.Home));
            }
            if (response.StatusCode == HttpStatusCode.Forbidden)
                return Results.Ok(new NotebookStatus(true, true, true, false, [], options.Home));
            response.EnsureSuccessStatusCode();
            return Results.Ok(new NotebookStatus(true, true, true, true,
                await ReadNotebooksAsync(response, cancellation), options.Home));
        }
        catch (Exception error) when (Upstream(error)) { return Unavailable(); }
    }

    private IResult Begin(HttpContext context)
    {
        if (!AppAccess.IsBrowserRequest(context) || !AppAccess.HasCookie(context, config))
            return Results.StatusCode(403);
        var options = Options();
        if (options is null) return Unavailable();

        var state = NewSecret();
        var verifier = NewSecret();
        cache.Set("google-state:" + state, verifier, StateAge);
        context.Response.Cookies.Append(StateCookie, state, Cookie(StateAge, SameSiteMode.Lax));
        var url = QueryHelpers.AddQueryString("https://accounts.google.com/o/oauth2/v2/auth", new Dictionary<string, string?>
        {
            ["client_id"] = options.ClientId, ["redirect_uri"] = options.RedirectUri,
            ["response_type"] = "code", ["scope"] = Scope, ["state"] = state, ["access_type"] = "online",
            ["code_challenge"] = WebEncoders.Base64UrlEncode(SHA256.HashData(Encoding.ASCII.GetBytes(verifier))),
            ["code_challenge_method"] = "S256", ["prompt"] = "select_account",
        });
        return Results.Ok(new { url });
    }

    private IResult Logout(HttpContext context)
    {
        if (!AppAccess.IsBrowserRequest(context) || !AppAccess.HasCookie(context, config))
            return Results.StatusCode(403);
        SignOut(context, cache);
        return Results.NoContent();
    }

    private async Task<IResult> CompleteAsync(HttpContext context, string? code, string? state, CancellationToken cancellation)
    {
        context.Response.Headers["Referrer-Policy"] = "no-referrer";
        var failure = Results.Redirect(NotebookPage + "?google=error");
        var options = Options();
        if (options is null || state is not { Length: 43 } ||
            !context.Request.Cookies.TryGetValue(StateCookie, out var expected) ||
            !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(state), Encoding.UTF8.GetBytes(expected)) ||
            !cache.TryGetValue<string>("google-state:" + state, out var verifier) || verifier is null) return failure;

        cache.Remove("google-state:" + state);
        context.Response.Cookies.Delete(StateCookie, Cookie(null, SameSiteMode.Lax));
        if (code is not { Length: > 0 and <= 4096 }) return failure;

        try
        {
            using var form = new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["client_id"] = options.ClientId, ["client_secret"] = options.ClientSecret,
                ["redirect_uri"] = options.RedirectUri, ["grant_type"] = "authorization_code",
                ["code"] = code, ["code_verifier"] = verifier,
            });
            var tokenUrl = DevelopmentEndpoint("NOTEBOOK_DEV_URL", "token") ?? new Uri("https://oauth2.googleapis.com/token");
            using var response = await client.PostAsync(tokenUrl, form, cancellation);
            if (!response.IsSuccessStatusCode) return failure;
            using var document = JsonDocument.Parse(await response.Content.ReadAsStreamAsync(cancellation));
            var root = document.RootElement;
            var token = BookCatalog.TextAt(root, "access_token");
            var scopes = BookCatalog.TextAt(root, "scope")?.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (string.IsNullOrWhiteSpace(token) || scopes?.Contains(Scope) != true ||
                !root.TryGetProperty("expires_in", out var expires) || !expires.TryGetInt32(out var seconds) || seconds <= 0)
                return failure;
            var age = TimeSpan.FromSeconds(Math.Min(seconds, 3600));
            SignOut(context, cache);
            var sessionId = NewSecret();
            cache.Set("google-session:" + sessionId, token, age);
            context.Response.Cookies.Append(SessionCookie, sessionId, Cookie(age, SameSiteMode.Strict));
            return Results.Redirect(NotebookPage);
        }
        catch (Exception error) when (Upstream(error)) { return failure; }
    }

    private async Task<IResult> SyncAsync(HttpContext context, NotebookSync request, CancellationToken cancellation)
    {
        if (!AppAccess.IsBrowserRequest(context)) return Results.StatusCode(403);
        if (!AppAccess.HasCookie(context, config) || AccessToken(context) is not { } google) return Results.Unauthorized();
        var options = Options();
        if (options is null) return Unavailable();
        if (request.NotebookId is null || !NotebookId().IsMatch(request.NotebookId) ||
            string.IsNullOrWhiteSpace(request.Title) || request.Title.Length > 150 ||
            string.IsNullOrWhiteSpace(request.Summary) || request.Summary.Length > 20_000 ||
            Encoding.UTF8.GetByteCount(request.Summary) > 70_000) return Results.BadRequest();

        try
        {
            using var list = await ListAsync(options, google, cancellation);
            if (list.StatusCode == HttpStatusCode.Unauthorized) return Results.Unauthorized();
            if (list.StatusCode == HttpStatusCode.Forbidden) return Results.StatusCode(403);
            list.EnsureSuccessStatusCode();
            if (!(await ReadNotebooksAsync(list, cancellation)).Any(notebook => notebook.Id == request.NotebookId))
                return Results.StatusCode(403);
            var body = new
            {
                userContents = new[] { new { textContent = new
                {
                    sourceName = "Dager Habit · " + request.Title + " · " + DateTime.UtcNow.ToString("yyyy-MM-dd"),
                    content = request.Summary,
                } } },
            };
            using var message = Request(HttpMethod.Post, NotebookEndpoint(options, "/notebooks/" + request.NotebookId + "/sources:batchCreate"), google);
            message.Content = JsonContent.Create(body);
            using var response = await client.SendAsync(message, cancellation);
            if (response.StatusCode == HttpStatusCode.Unauthorized) return Results.Unauthorized();
            if (response.StatusCode == HttpStatusCode.Forbidden) return Results.StatusCode(403);
            response.EnsureSuccessStatusCode();
            return Results.Ok(new { url = $"https://notebook.cloud.google.com/{options.Region}/notebook/{request.NotebookId}?project={options.Project}" });
        }
        catch (Exception error) when (Upstream(error)) { return Unavailable(); }
    }

    private async Task<HttpResponseMessage> ListAsync(NotebookOptions options, string token, CancellationToken cancellation)
    {
        using var request = Request(HttpMethod.Get, NotebookEndpoint(options, "/notebooks:listRecentlyViewed?pageSize=50"), token);
        return await client.SendAsync(request, cancellation);
    }

    private Uri NotebookEndpoint(NotebookOptions options, string path)
    {
        var relative = $"v1alpha/projects/{options.Project}/locations/{options.Region}" + path;
        return DevelopmentEndpoint("NOTEBOOK_DEV_URL", relative) ??
            new Uri($"https://{options.Region}-discoveryengine.googleapis.com/{relative}");
    }

    private Uri? DevelopmentEndpoint(string key, string path) =>
        environment.IsDevelopment() && Uri.TryCreate(config[key], UriKind.Absolute, out var local) &&
        local.IsLoopback && local.Scheme == Uri.UriSchemeHttp ? new Uri(local, path) : null;

    private static HttpRequestMessage Request(HttpMethod method, Uri endpoint, string token)
    {
        var request = new HttpRequestMessage(method, endpoint);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return request;
    }

    private static async Task<NotebookItem[]> ReadNotebooksAsync(HttpResponseMessage response, CancellationToken cancellation)
    {
        using var json = JsonDocument.Parse(await response.Content.ReadAsStreamAsync(cancellation));
        var root = json.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw new JsonException("Invalid notebooks response");
        var items = new List<NotebookItem>();
        foreach (var item in BookCatalog.ArrayAt(root, "notebooks"))
        {
            var id = BookCatalog.TextAt(item, "notebookId");
            var title = BookCatalog.TextAt(item, "title");
            if (id is null || !NotebookId().IsMatch(id) || string.IsNullOrWhiteSpace(title) ||
                !item.TryGetProperty("metadata", out var metadata)) continue;
            if (BookCatalog.TextAt(metadata, "userRole") is "PROJECT_ROLE_OWNER" or "PROJECT_ROLE_WRITER")
                items.Add(new NotebookItem(id, title));
        }
        return items.ToArray();
    }

    private NotebookOptions? Options()
    {
        var project = config["NOTEBOOK_PROJECT_NUMBER"];
        var region = config["NOTEBOOK_LOCATION"] ?? "global";
        var clientId = config["GOOGLE_OAUTH_CLIENT_ID"];
        var secret = config["GOOGLE_OAUTH_CLIENT_SECRET"];
        if (project is null || !ProjectNumber().IsMatch(project) || region is not ("global" or "us" or "eu") ||
            string.IsNullOrWhiteSpace(clientId) || string.IsNullOrWhiteSpace(secret) ||
            !Uri.TryCreate(config["GOOGLE_OAUTH_REDIRECT_URI"], UriKind.Absolute, out var redirect) ||
            (redirect.Scheme != Uri.UriSchemeHttps && !(environment.IsDevelopment() && redirect.IsLoopback && redirect.Scheme == Uri.UriSchemeHttp)) ||
            redirect.AbsolutePath != Callback || redirect.Query.Length > 0 || redirect.Fragment.Length > 0 || redirect.UserInfo.Length > 0)
            return null;
        return new NotebookOptions(project, region, clientId, secret, redirect.AbsoluteUri);
    }

    private string? AccessToken(HttpContext context) =>
        context.Request.Cookies.TryGetValue(SessionCookie, out var id) && id.Length == 43 &&
        cache.TryGetValue<string>("google-session:" + id, out var token) ? token : null;

    internal static void SignOut(HttpContext context, IMemoryCache cache)
    {
        if (context.Request.Cookies.TryGetValue(SessionCookie, out var id) && id.Length == 43)
            cache.Remove("google-session:" + id);
        context.Response.Cookies.Delete(SessionCookie, Cookie(null, SameSiteMode.Strict));
    }

    private static string NewSecret() => WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
    private static CookieOptions Cookie(TimeSpan? age, SameSiteMode sameSite) => new()
    { Secure = true, HttpOnly = true, Path = "/", SameSite = sameSite, MaxAge = age };
    private static bool Upstream(Exception error) =>
        error is HttpRequestException or TaskCanceledException or JsonException or InvalidOperationException;
    private static IResult Unavailable() => Results.Problem("NotebookLM Enterprise no está disponible.", statusCode: 502);

    [GeneratedRegex(@"^[0-9]{6,20}$")] private static partial Regex ProjectNumber();
    [GeneratedRegex(@"^[A-Za-z0-9_-]{1,128}$")] private static partial Regex NotebookId();
    private sealed record NotebookSync(string? NotebookId, string? Title, string? Summary);
    private sealed record NotebookItem(string Id, string Title);
    private sealed record NotebookStatus(bool Configured, bool AppConnected, bool GoogleConnected, bool Eligible, NotebookItem[] Notebooks, string? EnterpriseUrl);
    private sealed record NotebookOptions(string Project, string Region, string ClientId, string ClientSecret, string RedirectUri)
    { public string Home => $"https://notebook.cloud.google.com/{Region}/?project={Project}"; }
}
