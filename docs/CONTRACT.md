# Contrato utilizado por los ejemplos

Este contrato corresponde a VEKAI `3.12.0-rc-mcp` en `https://demo.vekai.ai`.

## Autenticación

```http
POST /api/authenticate
Content-Type: application/json

{"username":"integrador@example.com","password":"...","rememberMe":false}
```

La respuesta contiene `id_token`. Se envía en las llamadas posteriores como
`Authorization: Bearer <id_token>`.

## Crear un dominio

```json
{
  "name": "Manuales de mantenimiento",
  "instructions": "Responde usando la documentación disponible.",
  "description": "Base documental del equipo de mantenimiento",
  "lengthyResponse": false,
  "llmKnowledge": false,
  "reactRag": false,
  "advancedTables": false
}
```

## Subir un documento

`POST /api/domains/{domainId}/documents` usa `multipart/form-data`:

- `uploadFile`: contenido binario;
- `document`: objeto JSON serializado como texto.

Ejemplo de la parte `document`:

```json
{
  "name": "manual.pdf",
  "url": "manual.pdf",
  "documentType": "pdf",
  "documentSize": 12345,
  "domain": {"id": 123}
}
```

`documentType` es la extensión sin punto y en minúsculas. El servidor devuelve el
documento creado, cuyo `state` puede seguir indicando que la indexación está en curso.

## Preguntar sin streaming

```http
POST /api/domains/123/chat/456/messages
Content-Type: application/json

{"question":"¿Qué indica el manual?","subdomainIds":[]}
```

El `id` de la respuesta se usa para consultar sus fuentes. La respuesta puede incluir
`documentsEmbedings` y `reasoningSteps`.

## Fuentes

```http
GET /api/domains/123/chat/456/messages/789/source
```

La respuesta es un array heterogéneo. Una fuente documental suele aportar el fragmento
en `embeding`, la página en `documentPage` y metadatos en `document`. Conviene conservar
campos desconocidos para mantener compatibilidad hacia delante.

### Fuentes MCP

Los resultados de GLPI, ServiceDesk Plus, ProactivaNET y otros conectores MCP se
persisten en el historial del mensaje:

```text
GET /api/domains/{domainId}/chat/{chatId}/messages
```

Cada paso `reasoningSteps[]` con `kind: "tool"` puede contener `toolOutput`. El contrato
estructurado genérico de fuentes tiene esta forma:

```json
{
  "source": {"type": "ticket", "title": "Incidencias relacionadas"},
  "columns": [{"field": "id", "label": "ID", "type": "integer"}],
  "records": [{"id": 1234}],
  "records_total": 1,
  "records_complete": true
}
```

El servidor limita y filtra el resultado antes de persistirlo. Comprueba también
`toolTruncated` y `toolRowCount`; no asumas que `records` contiene el conjunto completo.

### Artefactos

La respuesta y el historial pueden incluir un array `artifacts` con visualizaciones
estructuradas. En esta RC los artefactos de versión de esquema `1` incluyen el tipo
`visualization`, el tipo de gráfica, dimensiones, medidas y filas. El cliente debe ignorar
tipos o versiones de esquema que no reconozca.

## Streaming

```http
GET /api/domains/123/chats/456/messages/stream?question=...
Accept: text/event-stream
```

Cada registro SSE llega en una o varias líneas `data:`. Los ejemplos unen las líneas,
reconocen `[DONE]` y `end_of_stream`, y parsean JSON cuando el servidor devuelve el
protocolo estructurado.

No uses el `EventSource` nativo del navegador si necesitas enviar el header
`Authorization`: no permite headers personalizados. Usa `fetch` con streaming o un
polyfill que admita headers.

## Recomendaciones de producción

- Mantén el JWT solo en memoria o en un almacén seguro y renueva la sesión al recibir 401.
- Establece timeouts distintos para llamadas REST y streams largos.
- Aplica reintentos solo a operaciones idempotentes. No reintentes automáticamente altas
  o preguntas sin una clave de idempotencia definida por tu aplicación.
- Limita el tamaño y valida el tipo de los archivos antes de subirlos.
- Registra identificadores y códigos de estado, pero no tokens, contraseñas, preguntas
  sensibles, documentos ni respuestas completas.
- Tolera campos adicionales en las respuestas y eventos SSE desconocidos.
