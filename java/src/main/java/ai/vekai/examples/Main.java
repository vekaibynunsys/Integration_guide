package ai.vekai.examples;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.nio.file.Path;

public final class Main {
    private static final ObjectMapper JSON = new ObjectMapper();

    public static void main(String[] args) {
        if (args.length == 0) { usage(); System.exit(2); }
        try (VekaiClient client = VekaiClient.fromEnvironment()) {
            switch (args[0]) {
                case "list-domains" -> print(client.listDomains(args.length > 1 ? Integer.parseInt(args[1]) : 20));
                case "create-domain" -> { require(args, 2); print(client.createDomain(args[1])); }
                case "upload-document" -> {
                    require(args, 3); print(client.uploadDocument(id(args[1]), Path.of(args[2])));
                }
                case "create-chat" -> {
                    require(args, 3); print(client.createChat(id(args[1]), args[2]));
                }
                case "ask" -> {
                    require(args, 4); print(client.ask(id(args[1]), id(args[2]), args[3]));
                }
                case "sources" -> {
                    require(args, 4); print(client.getSources(id(args[1]), id(args[2]), id(args[3])));
                }
                case "mcp-sources" -> {
                    require(args, 4); print(client.getMcpSources(id(args[1]), id(args[2]), id(args[3])));
                }
                case "messages" -> {
                    require(args, 3);
                    JsonNode messages = client.getMessages(id(args[1]), id(args[2]));
                    if (args.length < 4 || !args[3].equals("--reasoning")) print(messages);
                    else for (JsonNode message : messages) {
                        System.out.println("Mensaje " + message.path("id").asText());
                        print(message.path("reasoningSteps"));
                    }
                }
                case "stream" -> {
                    require(args, 4);
                    client.stream(id(args[1]), id(args[2]), args[3], Main::showEvent);
                    System.out.println();
                }
                default -> { usage(); System.exit(2); }
            }
        } catch (Exception error) {
            System.err.println("Error: " + error.getMessage());
            System.exit(1);
        }
    }

    private static void showEvent(VekaiClient.StreamEvent event) {
        if (event.json() == null) { System.out.print(event.raw()); return; }
        JsonNode value = event.json();
        String type = value.path("type").asText();
        switch (type) {
            case "text-delta" -> System.out.print(value.path("delta").asText());
            case "reasoning-delta" -> System.out.println("\n[razonamiento] " + value);
            case "error" -> System.err.println("\n[error] " + value);
            default -> { if (type.startsWith("tool-")) System.out.println("\n[" + type + "] " + value); }
        }
    }

    private static void print(JsonNode value) throws Exception {
        System.out.println(JSON.writerWithDefaultPrettyPrinter().writeValueAsString(value));
    }

    private static long id(String value) { return Long.parseLong(value); }

    private static void require(String[] args, int count) {
        if (args.length < count) throw new IllegalArgumentException("Faltan argumentos.");
    }

    private static void usage() {
        System.out.println("""
            Uso:
              mvn exec:java -Dexec.args="list-domains"
              mvn exec:java -Dexec.args="create-domain 'Nombre'"
              mvn exec:java -Dexec.args="upload-document <domainId> <archivo>"
              mvn exec:java -Dexec.args="create-chat <domainId> 'Nombre'"
              mvn exec:java -Dexec.args="ask <domainId> <chatId> 'Pregunta'"
              mvn exec:java -Dexec.args="sources <domainId> <chatId> <messageId>"
              mvn exec:java -Dexec.args="mcp-sources <domainId> <chatId> <messageId>"
              mvn exec:java -Dexec.args="stream <domainId> <chatId> 'Pregunta'"
              mvn exec:java -Dexec.args="messages <domainId> <chatId> --reasoning"
            """);
    }
}
