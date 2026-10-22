# Java

```bash
mvn compile
mvn exec:java -Dexec.args="list-domains"
mvn exec:java -Dexec.args="create-domain 'Manuales de mantenimiento'"
mvn exec:java -Dexec.args="stream 123 456 'Resume el procedimiento'"
mvn exec:java -Dexec.args="mcp-sources 123 456 789"
```

Requiere Java 17 y Maven 3.9 o posteriores. Solo se usa Jackson para trabajar con JSON;
HTTP, multipart y SSE se implementan con la biblioteca estándar. Configura primero las
variables del [README principal](../README.md).
