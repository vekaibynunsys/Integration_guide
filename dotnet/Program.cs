using System.Text.Json;
using VekaiExamples;

static void Usage()
{
    Console.WriteLine("""
Uso:
  dotnet run -- list-domains [size]
  dotnet run -- create-domain <nombre>
  dotnet run -- upload-document <domainId> <archivo>
  dotnet run -- create-chat <domainId> <nombre>
  dotnet run -- ask <domainId> <chatId> <pregunta>
  dotnet run -- sources <domainId> <chatId> <messageId>
  dotnet run -- mcp-sources <domainId> <chatId> <messageId>
  dotnet run -- stream <domainId> <chatId> <pregunta>
  dotnet run -- messages <domainId> <chatId> [--reasoning]
""");
}

static long Id(string value, string name) =>
    long.TryParse(value, out var id) ? id : throw new ArgumentException($"{name} debe ser numérico.");

static void Print(JsonDocument document) =>
    Console.WriteLine(JsonSerializer.Serialize(document.RootElement, new JsonSerializerOptions { WriteIndented = true }));

if (args.Length == 0)
{
    Usage();
    return 2;
}

try
{
    using var client = VekaiClient.FromEnvironment();
    switch (args[0])
    {
        case "list-domains":
            using (var json = await client.ListDomainsAsync(args.Length > 1 ? int.Parse(args[1]) : 20)) Print(json);
            break;
        case "create-domain" when args.Length >= 2:
            using (var json = await client.CreateDomainAsync(args[1])) Print(json);
            break;
        case "upload-document" when args.Length >= 3:
            using (var json = await client.UploadDocumentAsync(Id(args[1], "domainId"), args[2])) Print(json);
            break;
        case "create-chat" when args.Length >= 3:
            using (var json = await client.CreateChatAsync(Id(args[1], "domainId"), args[2])) Print(json);
            break;
        case "ask" when args.Length >= 4:
            using (var json = await client.AskAsync(Id(args[1], "domainId"), Id(args[2], "chatId"), args[3])) Print(json);
            break;
        case "sources" when args.Length >= 4:
            using (var json = await client.GetSourcesAsync(Id(args[1], "domainId"), Id(args[2], "chatId"), Id(args[3], "messageId"))) Print(json);
            break;
        case "mcp-sources" when args.Length >= 4:
            using (var json = await client.GetMcpSourcesAsync(Id(args[1], "domainId"), Id(args[2], "chatId"), Id(args[3], "messageId"))) Print(json);
            break;
        case "messages" when args.Length >= 3:
            using (var json = await client.GetMessagesAsync(Id(args[1], "domainId"), Id(args[2], "chatId")))
            {
                if (!args.Contains("--reasoning")) Print(json);
                else
                {
                    foreach (var message in json.RootElement.EnumerateArray())
                    {
                        Console.WriteLine($"Mensaje {message.GetProperty("id")}");
                        if (message.TryGetProperty("reasoningSteps", out var steps))
                            Console.WriteLine(JsonSerializer.Serialize(steps, new JsonSerializerOptions { WriteIndented = true }));
                    }
                }
            }
            break;
        case "stream" when args.Length >= 4:
            await foreach (var item in client.StreamAsync(Id(args[1], "domainId"), Id(args[2], "chatId"), args[3]))
            {
                if (item.Json is null) { Console.Write(item.Raw); continue; }
                using (item.Json)
                {
                    var root = item.Json.RootElement;
                    var type = root.TryGetProperty("type", out var typeElement) ? typeElement.GetString() : null;
                    if (type == "text-delta" && root.TryGetProperty("delta", out var delta)) Console.Write(delta.GetString());
                    else if (type == "reasoning-delta") Console.WriteLine($"\n[razonamiento] {root}");
                    else if (type?.StartsWith("tool-", StringComparison.Ordinal) == true) Console.WriteLine($"\n[{type}] {root}");
                    else if (type == "error") Console.Error.WriteLine($"\n[error] {root}");
                }
            }
            Console.WriteLine();
            break;
        default:
            Usage();
            return 2;
    }
    return 0;
}
catch (Exception error) when (error is VekaiException or ArgumentException or FormatException)
{
    Console.Error.WriteLine($"Error: {error.Message}");
    return 1;
}
