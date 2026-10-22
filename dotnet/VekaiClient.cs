using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace VekaiExamples;

public sealed class VekaiClient : IDisposable
{
    private readonly HttpClient _http;
    private readonly string? _username;
    private readonly string? _password;
    private string? _token;

    public VekaiClient(string baseUrl, string? token, string? username, string? password)
    {
        _token = string.IsNullOrWhiteSpace(token) ? null : token;
        _username = username;
        _password = password;
        _http = new HttpClient
        {
            BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/"),
            Timeout = TimeSpan.FromSeconds(30)
        };
    }

    public static VekaiClient FromEnvironment() => new(
        Environment.GetEnvironmentVariable("VEKAI_BASE_URL") ?? "https://demo.vekai.ai",
        Environment.GetEnvironmentVariable("VEKAI_TOKEN"),
        Environment.GetEnvironmentVariable("VEKAI_USERNAME"),
        Environment.GetEnvironmentVariable("VEKAI_PASSWORD"));

    public async Task<string> AuthenticateAsync(CancellationToken cancellationToken = default)
    {
        if (_token is not null) return _token;
        if (string.IsNullOrWhiteSpace(_username) || string.IsNullOrWhiteSpace(_password))
            throw new VekaiException("Define VEKAI_TOKEN o VEKAI_USERNAME y VEKAI_PASSWORD.");

        using var response = await _http.PostAsJsonAsync("api/authenticate", new
        {
            username = _username,
            password = _password,
            rememberMe = false
        }, cancellationToken);
        using var json = await ReadJsonAsync(response, cancellationToken);
        _token = json.RootElement.GetProperty("id_token").GetString()
            ?? throw new VekaiException("La autenticación no devolvió id_token.");
        return _token;
    }

    public Task<JsonDocument> CreateDomainAsync(
        string name, string description = "", string instructions = "",
        CancellationToken cancellationToken = default) => SendJsonAsync(
            HttpMethod.Post, "api/domains", new
            {
                name, description, instructions,
                lengthyResponse = false,
                llmKnowledge = false,
                reactRag = false,
                advancedTables = false
            }, cancellationToken);

    public Task<JsonDocument> ListDomainsAsync(
        int size = 20, CancellationToken cancellationToken = default) =>
        SendAsync(HttpMethod.Get, $"api/domains?page=0&size={size}", null, cancellationToken);

    public async Task<JsonDocument> UploadDocumentAsync(
        long domainId, string filePath, CancellationToken cancellationToken = default)
    {
        var info = new FileInfo(filePath);
        if (!info.Exists) throw new VekaiException($"No existe el archivo: {filePath}");
        var documentType = info.Extension.TrimStart('.').ToLowerInvariant();
        if (documentType.Length == 0) documentType = "binary";

        var document = JsonSerializer.Serialize(new
        {
            name = info.Name,
            url = info.Name,
            documentType,
            documentSize = info.Length,
            domain = new { id = domainId }
        });

        await using var stream = info.OpenRead();
        using var content = new MultipartFormDataContent();
        var fileContent = new StreamContent(stream);
        fileContent.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        content.Add(fileContent, "uploadFile", info.Name);
        content.Add(new StringContent(document, Encoding.UTF8, "application/json"), "document");
        return await SendAsync(
            HttpMethod.Post, $"api/domains/{domainId}/documents", content, cancellationToken);
    }

    public Task<JsonDocument> CreateChatAsync(
        long domainId, string name, CancellationToken cancellationToken = default) =>
        SendJsonAsync(HttpMethod.Post, $"api/domains/{domainId}/chat", new { name }, cancellationToken);

    public Task<JsonDocument> AskAsync(
        long domainId, long chatId, string question,
        CancellationToken cancellationToken = default) => SendJsonAsync(
            HttpMethod.Post, $"api/domains/{domainId}/chat/{chatId}/messages",
            new { question, subdomainIds = Array.Empty<long>() }, cancellationToken);

    public Task<JsonDocument> GetSourcesAsync(
        long domainId, long chatId, long messageId,
        CancellationToken cancellationToken = default) => SendAsync(
            HttpMethod.Get,
            $"api/domains/{domainId}/chat/{chatId}/messages/{messageId}/source",
            null, cancellationToken);

    public Task<JsonDocument> GetMessagesAsync(
        long domainId, long chatId, CancellationToken cancellationToken = default) =>
        SendAsync(HttpMethod.Get,
            $"api/domains/{domainId}/chat/{chatId}/messages?page=0&size=20&sort=questionAskedAt,desc",
            null, cancellationToken);

    public async Task<JsonDocument> GetMcpSourcesAsync(
        long domainId, long chatId, long messageId, CancellationToken cancellationToken = default)
    {
        using var messages = await GetMessagesAsync(domainId, chatId, cancellationToken);
        var result = new JsonArray();
        var message = messages.RootElement.EnumerateArray()
            .FirstOrDefault(item => item.TryGetProperty("id", out var id) && id.GetInt64() == messageId);
        if (message.ValueKind == JsonValueKind.Undefined)
            throw new VekaiException($"El mensaje {messageId} no aparece entre los mensajes recientes.");
        if (message.TryGetProperty("reasoningSteps", out var steps))
        {
            foreach (var step in steps.EnumerateArray())
            {
                var isTool = step.TryGetProperty("kind", out var kind) && kind.GetString() == "tool";
                if (isTool && step.TryGetProperty("toolOutput", out var output)
                    && output.ValueKind is not JsonValueKind.Null and not JsonValueKind.Undefined)
                    result.Add(JsonNode.Parse(step.GetRawText()));
            }
        }
        return JsonDocument.Parse(result.ToJsonString());
    }

    public async IAsyncEnumerable<StreamEvent> StreamAsync(
        long domainId, long chatId, string question,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var url = $"api/domains/{domainId}/chats/{chatId}/messages/stream?question={Uri.EscapeDataString(question)}";
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await AuthenticateAsync(cancellationToken));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        using var response = await _http.SendAsync(
            request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var reader = new StreamReader(stream);
        var data = new List<string>();
        while (await reader.ReadLineAsync(cancellationToken) is { } line)
        {
            if (line.Length == 0)
            {
                if (data.Count == 0) continue;
                var value = string.Join("\n", data);
                data.Clear();
                if (value is "[DONE]" or "end_of_stream") yield break;
                yield return StreamEvent.Parse(value);
            }
            else if (line.StartsWith("data:", StringComparison.Ordinal))
            {
                data.Add(line[5..].TrimStart());
            }
        }
        if (data.Count > 0) yield return StreamEvent.Parse(string.Join("\n", data));
    }

    private async Task<JsonDocument> SendJsonAsync(
        HttpMethod method, string path, object body, CancellationToken cancellationToken) =>
        await SendAsync(method, path,
            new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"),
            cancellationToken);

    private async Task<JsonDocument> SendAsync(
        HttpMethod method, string path, HttpContent? content, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(method, path) { Content = content };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await AuthenticateAsync(cancellationToken));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        using var response = await _http.SendAsync(request, cancellationToken);
        return await ReadJsonAsync(response, cancellationToken);
    }

    private static async Task<JsonDocument> ReadJsonAsync(
        HttpResponseMessage response, CancellationToken cancellationToken)
    {
        await EnsureSuccessAsync(response, cancellationToken);
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        try { return await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken); }
        catch (JsonException error)
        {
            throw new VekaiException($"VEKAI devolvió una respuesta no JSON ({(int)response.StatusCode}).", error);
        }
    }

    private static async Task EnsureSuccessAsync(
        HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (response.IsSuccessStatusCode) return;
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (body.Length > 1000) body = body[..1000];
        throw new VekaiException($"VEKAI respondió {(int)response.StatusCode}: {body}");
    }

    public void Dispose() => _http.Dispose();
}

public sealed record StreamEvent(string Raw, JsonDocument? Json)
{
    public static StreamEvent Parse(string value)
    {
        try { return new StreamEvent(value, JsonDocument.Parse(value)); }
        catch (JsonException) { return new StreamEvent(value, null); }
    }
}

public sealed class VekaiException : Exception
{
    public VekaiException(string message) : base(message) { }
    public VekaiException(string message, Exception inner) : base(message, inner) { }
}
