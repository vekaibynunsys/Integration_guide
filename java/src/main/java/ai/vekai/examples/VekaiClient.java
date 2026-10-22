package ai.vekai.examples;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Consumer;

public final class VekaiClient implements AutoCloseable {
    private final HttpClient http;
    private final ObjectMapper json = new ObjectMapper();
    private final URI baseUri;
    private final String username;
    private final String password;
    private String token;

    public VekaiClient(String baseUrl, String token, String username, String password) {
        this.baseUri = URI.create(baseUrl.replaceAll("/+$", "") + "/");
        this.token = blankToNull(token);
        this.username = blankToNull(username);
        this.password = blankToNull(password);
        this.http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(15))
            .build();
    }

    public static VekaiClient fromEnvironment() {
        return new VekaiClient(
            System.getenv().getOrDefault("VEKAI_BASE_URL", "https://demo.vekai.ai"),
            System.getenv("VEKAI_TOKEN"),
            System.getenv("VEKAI_USERNAME"),
            System.getenv("VEKAI_PASSWORD"));
    }

    public String authenticate() throws IOException, InterruptedException {
        if (token != null) return token;
        if (username == null || password == null) {
            throw new VekaiException("Define VEKAI_TOKEN o VEKAI_USERNAME y VEKAI_PASSWORD.");
        }
        String body = json.writeValueAsString(Map.of(
            "username", username, "password", password, "rememberMe", false));
        HttpRequest request = request("api/authenticate")
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build();
        JsonNode response = sendJson(request);
        token = response.path("id_token").asText(null);
        if (token == null) throw new VekaiException("La autenticación no devolvió id_token.");
        return token;
    }

    public JsonNode createDomain(String name) throws IOException, InterruptedException {
        return sendJson("POST", "api/domains", Map.of(
            "name", name,
            "description", "",
            "instructions", "",
            "lengthyResponse", false,
            "llmKnowledge", false,
            "reactRag", false,
            "advancedTables", false));
    }

    public JsonNode listDomains(int size) throws IOException, InterruptedException {
        return sendJson(authenticated("api/domains?page=0&size=" + size).GET().build());
    }

    public JsonNode uploadDocument(long domainId, Path path) throws IOException, InterruptedException {
        if (!Files.isRegularFile(path)) throw new VekaiException("No existe el archivo: " + path);
        String fileName = path.getFileName().toString();
        int dot = fileName.lastIndexOf('.');
        String type = dot >= 0 ? fileName.substring(dot + 1).toLowerCase() : "binary";
        String document = json.writeValueAsString(Map.of(
            "name", fileName,
            "url", fileName,
            "documentType", type,
            "documentSize", Files.size(path),
            "domain", Map.of("id", domainId)));

        String boundary = "vekai-" + UUID.randomUUID();
        String safeName = fileName.replace("\"", "_");
        String prefix = "--" + boundary + "\r\n"
            + "Content-Disposition: form-data; name=\"uploadFile\"; filename=\"" + safeName + "\"\r\n"
            + "Content-Type: application/octet-stream\r\n\r\n";
        String middle = "\r\n--" + boundary + "\r\n"
            + "Content-Disposition: form-data; name=\"document\"\r\n"
            + "Content-Type: application/json; charset=UTF-8\r\n\r\n"
            + document + "\r\n--" + boundary + "--\r\n";
        var body = HttpRequest.BodyPublishers.concat(
            HttpRequest.BodyPublishers.ofString(prefix),
            HttpRequest.BodyPublishers.ofFile(path),
            HttpRequest.BodyPublishers.ofString(middle));
        HttpRequest request = authenticated("api/domains/" + domainId + "/documents")
            .header("Content-Type", "multipart/form-data; boundary=" + boundary)
            .POST(body)
            .build();
        return sendJson(request);
    }

    public JsonNode createChat(long domainId, String name) throws IOException, InterruptedException {
        return sendJson("POST", "api/domains/" + domainId + "/chat", Map.of("name", name));
    }

    public JsonNode ask(long domainId, long chatId, String question) throws IOException, InterruptedException {
        return sendJson("POST", "api/domains/" + domainId + "/chat/" + chatId + "/messages",
            Map.of("question", question, "subdomainIds", List.of()));
    }

    public JsonNode getSources(long domainId, long chatId, long messageId)
        throws IOException, InterruptedException {
        String path = "api/domains/%d/chat/%d/messages/%d/source".formatted(domainId, chatId, messageId);
        return sendJson(authenticated(path).GET().build());
    }

    public JsonNode getMessages(long domainId, long chatId) throws IOException, InterruptedException {
        String path = "api/domains/%d/chat/%d/messages?page=0&size=20&sort=questionAskedAt,desc"
            .formatted(domainId, chatId);
        return sendJson(authenticated(path).GET().build());
    }

    public JsonNode getMcpSources(long domainId, long chatId, long messageId)
        throws IOException, InterruptedException {
        JsonNode messages = getMessages(domainId, chatId);
        JsonNode selected = null;
        for (JsonNode message : messages) {
            if (message.path("id").asLong(-1) == messageId) {
                selected = message;
                break;
            }
        }
        if (selected == null) {
            throw new VekaiException("El mensaje " + messageId + " no aparece entre los mensajes recientes.");
        }
        ArrayNode sources = json.createArrayNode();
        for (JsonNode step : selected.path("reasoningSteps")) {
            if (step.path("kind").asText().equals("tool") && !step.path("toolOutput").isMissingNode()
                && !step.path("toolOutput").isNull()) {
                sources.add(step.deepCopy());
            }
        }
        return sources;
    }

    public void stream(long domainId, long chatId, String question, Consumer<StreamEvent> consumer)
        throws IOException, InterruptedException {
        String encoded = URLEncoder.encode(question, StandardCharsets.UTF_8).replace("+", "%20");
        String path = "api/domains/%d/chats/%d/messages/stream?question=%s"
            .formatted(domainId, chatId, encoded);
        HttpRequest request = authenticatedStream(path)
            .header("Accept", "text/event-stream")
            .GET().build();
        HttpResponse<java.io.InputStream> response = http.send(
            request, HttpResponse.BodyHandlers.ofInputStream());
        ensureSuccess(response.statusCode(), () -> readBody(response.body()));

        try (BufferedReader reader = new BufferedReader(
            new InputStreamReader(response.body(), StandardCharsets.UTF_8))) {
            List<String> data = new ArrayList<>();
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isEmpty()) {
                    if (data.isEmpty()) continue;
                    String value = String.join("\n", data);
                    data.clear();
                    if (value.equals("[DONE]") || value.equals("end_of_stream")) return;
                    consumer.accept(StreamEvent.parse(value, json));
                } else if (line.startsWith("data:")) {
                    data.add(line.substring(5).stripLeading());
                }
            }
            if (!data.isEmpty()) consumer.accept(StreamEvent.parse(String.join("\n", data), json));
        }
    }

    private JsonNode sendJson(String method, String path, Object body)
        throws IOException, InterruptedException {
        HttpRequest request = authenticated(path)
            .header("Content-Type", "application/json")
            .method(method, HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)))
            .build();
        return sendJson(request);
    }

    private JsonNode sendJson(HttpRequest request) throws IOException, InterruptedException {
        HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
        ensureSuccess(response.statusCode(), response::body);
        try {
            return json.readTree(response.body());
        } catch (IOException error) {
            throw new VekaiException("VEKAI devolvió una respuesta no JSON (" + response.statusCode() + ").", error);
        }
    }

    private HttpRequest.Builder authenticated(String path) throws IOException, InterruptedException {
        return request(path)
            .header("Authorization", "Bearer " + authenticate())
            .header("Accept", "application/json");
    }

    private HttpRequest.Builder authenticatedStream(String path) throws IOException, InterruptedException {
        // Sin timeout total: un SSE puede permanecer abierto durante respuestas largas.
        return HttpRequest.newBuilder(baseUri.resolve(path))
            .header("Authorization", "Bearer " + authenticate());
    }

    private HttpRequest.Builder request(String path) {
        return HttpRequest.newBuilder(baseUri.resolve(path)).timeout(Duration.ofSeconds(30));
    }

    private static void ensureSuccess(int status, BodySupplier body) throws IOException {
        if (status >= 200 && status < 300) return;
        String value = body.get();
        throw new VekaiException("VEKAI respondió " + status + ": "
            + value.substring(0, Math.min(value.length(), 1000)));
    }

    private static String readBody(java.io.InputStream stream) throws IOException {
        return new String(stream.readNBytes(1000), StandardCharsets.UTF_8);
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }

    @Override public void close() { /* HttpClient no necesita cierre en Java 17. */ }

    @FunctionalInterface private interface BodySupplier { String get() throws IOException; }

    public record StreamEvent(String raw, JsonNode json) {
        static StreamEvent parse(String raw, ObjectMapper mapper) {
            try { return new StreamEvent(raw, mapper.readTree(raw)); }
            catch (IOException ignored) { return new StreamEvent(raw, null); }
        }
    }

    public static final class VekaiException extends IOException {
        public VekaiException(String message) { super(message); }
        public VekaiException(String message, Throwable cause) { super(message, cause); }
    }
}
