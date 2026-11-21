using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;

internal sealed partial class AiProviders(IConfiguration config, IWebHostEnvironment environment)
{
    private static readonly Api[] Supported =
    [
        new("groq", "Groq", "https://api.groq.com/", "openai/v1/chat/completions", "strict", "openai/gpt-oss-20b"),
        new("deepseek", "DeepSeek", "https://api.deepseek.com/", "chat/completions", "json"),
        new("openrouter", "OpenRouter", "https://openrouter.ai/", "api/v1/chat/completions", "text"),
        new("anthropic", "Anthropic", "https://api.anthropic.com/", "v1/messages", "anthropic"),
        new("openai", "OpenAI", "https://api.openai.com/", "v1/chat/completions", "strict"),
        new("ollama", "Ollama", "http://127.0.0.1:11434/", "api/chat", "ollama"),
        new("lmstudio", "LM Studio", "http://127.0.0.1:1234/", "v1/chat/completions", "strict"),
        new("compatible", "API compatible con OpenAI", "", "chat/completions", "text"),
    ];

    private static readonly JsonSerializerOptions WebJson = new(JsonSerializerDefaults.Web);
    private static readonly object Schema = new
    {
        type = "object",
        properties = new
        {
            scores = new { type = new[] { "array", "null" }, items = new { type = "integer" } },
            comment = new { type = "string" },
            action = new { type = "string" },
            possibleError = new { type = "string" },
        },
        required = new[] { "scores", "comment", "action", "possibleError" },
        additionalProperties = false,
    };

    public string? DefaultId => config["AI_DEFAULT_PROVIDER"] ?? "groq";

    public Provider[] List() => Supported.Select(Get).OfType<Provider>().ToArray();

    public static bool ValidModel(string? model) => model is null || ModelName().IsMatch(model);

    private Provider? Get(Api api)
    {
        var prefix = api.Id.ToUpperInvariant();
        var key = config[prefix + "_API_KEY"];
        var model = config[prefix + "_MODEL"] ?? api.DefaultModel;
        var local = api.Id is "ollama" or "lmstudio";
        var configurable = local || api.Id == "compatible";
        var baseUrl = configurable ? config[prefix + "_BASE_URL"] ?? api.BaseUrl : api.BaseUrl;
        if (environment.IsDevelopment() && Uri.TryCreate(config[prefix + "_DEV_URL"], UriKind.Absolute, out var test) &&
            test.IsLoopback && test.Scheme == Uri.UriSchemeHttp) baseUrl = test.AbsoluteUri;

        if (model is not { Length: > 0 } || !ValidModel(model) ||
            (!configurable && string.IsNullOrWhiteSpace(key)) ||
            !Uri.TryCreate(baseUrl.TrimEnd('/') + "/", UriKind.Absolute, out var endpoint) ||
            (endpoint.Scheme != Uri.UriSchemeHttps && !(endpoint.Scheme == Uri.UriSchemeHttp &&
                (local || endpoint.IsLoopback))) ||
            endpoint.UserInfo.Length > 0 || endpoint.Fragment.Length > 0 || endpoint.Query.Length > 0) return null;

        var format = api.Format;
        if (api.Id is "openrouter" or "compatible" or "lmstudio")
            format = config[prefix + "_FORMAT"] switch
            { "json_schema" => "strict", "json_object" => "json", "text" => "text", _ => format };
        return new Provider(api.Id, api.Name, model, key, new Uri(endpoint, api.Path), format);
    }

    public HttpRequestMessage Build(Provider provider, EvaluationRequest request, string instructions)
    {
        var model = request.Model ?? provider.Model;
        var user = JsonSerializer.Serialize(new { request.Type, request.BookTitle, request.Questions, request.Content, request.Reference }, WebJson);
        var input = new { role = "user", content = user };
        var messages = new[] { new { role = "system", content = instructions }, input };
        var message = new HttpRequestMessage(HttpMethod.Post, provider.Endpoint);
        if (provider.Format == "anthropic")
        {
            message.Headers.Add("x-api-key", provider.Key);
            message.Headers.Add("anthropic-version", "2023-06-01");
            message.Content = JsonContent.Create(new
            {
                model, system = instructions, messages = new[] { input }, max_tokens = 1400,
                output_config = new { format = new { type = "json_schema", schema = Schema } },
            });
            return message;
        }

        if (!string.IsNullOrWhiteSpace(provider.Key))
            message.Headers.Authorization = new AuthenticationHeaderValue("Bearer", provider.Key);
        if (provider.Format == "ollama")
        {
            message.Content = JsonContent.Create(new { model, messages, stream = false, format = Schema, options = new { num_predict = 1400 } });
            return message;
        }

        var body = new Dictionary<string, object> { ["model"] = model, ["messages"] = messages, ["stream"] = false };
        body[provider.Id is "groq" or "openai" or "openrouter" ? "max_completion_tokens" : "max_tokens"] = 1400;
        if (provider.Format == "strict")
            body["response_format"] = new { type = "json_schema", json_schema = new { name = "evaluation", strict = true, schema = Schema } };
        else if (provider.Format == "json")
            body["response_format"] = new { type = "json_object" };
        message.Content = JsonContent.Create(body);
        return message;
    }

    public static EvaluationResult Parse(Provider provider, JsonElement root)
    {
        string? result = provider.Format switch
        {
            "anthropic" => BookCatalog.ArrayAt(root, "content")
                .Where(item => BookCatalog.TextAt(item, "type") == "text")
                .Select(item => BookCatalog.TextAt(item, "text")).FirstOrDefault(),
            "ollama" => BookCatalog.TextAt(root.GetProperty("message"), "content"),
            _ => BookCatalog.TextAt(root.GetProperty("choices")[0].GetProperty("message"), "content"),
        };
        if (string.IsNullOrWhiteSpace(result)) throw new JsonException("Empty evaluation");
        result = result.Trim();
        if (result.StartsWith("```json", StringComparison.OrdinalIgnoreCase) && result.EndsWith("```", StringComparison.Ordinal))
            result = result[7..^3].Trim();
        return JsonSerializer.Deserialize<EvaluationResult>(result, WebJson) ?? throw new JsonException("Invalid evaluation");
    }

    [GeneratedRegex(@"^[a-zA-Z0-9][a-zA-Z0-9._:/+@~-]{0,149}$")]
    private static partial Regex ModelName();

    private sealed record Api(string Id, string Name, string BaseUrl, string Path, string Format, string? DefaultModel = null);
    internal sealed record Provider(string Id, string Name, string Model, string? Key, Uri Endpoint, string Format);
}
