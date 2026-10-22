# Ejemplos de integración con VEKAI

Ejemplos equivalentes en Python, .NET, Java, Angular y React para consumir la API REST de VEKAI
desplegada en `https://demo.vekai.ai`.
El repositorio cubre deliberadamente un conjunto pequeño de operaciones habituales:

- autenticar mediante JWT;
- crear y listar dominios;
- subir un documento a un dominio;
- crear un chat asociado a un dominio;
- preguntar sobre el dominio;
- consultar las fuentes de una respuesta;
- consumir respuestas en streaming (SSE);
- consultar los pasos de razonamiento persistidos.

> Este proyecto contiene ejemplos de integración, no un SDK oficial. Los clientes son
> intencionadamente pequeños para que sea fácil adaptarlos a una aplicación real. Estos
> ejemplos muestran únicamente una selección de casos de uso y no pretenden incluir ni
> representar toda la funcionalidad disponible en VEKAI.

## Requisitos

| Lenguaje | Requisito |
|---|---|
| Python | Python 3.11+ |
| .NET | .NET 8 SDK+ |
| Java | Java 17+ y Maven 3.9+ |
| Angular | Node 18, Angular 14 |
| React | Node 18+, React 19 |

## Configuración

Todos los ejemplos leen las mismas variables de entorno:

```bash
export VEKAI_BASE_URL="https://demo.vekai.ai"
export VEKAI_USERNAME="integrador@example.com"
export VEKAI_PASSWORD="tu-contraseña"
```

Si ya dispones de un JWT, evita enviar las credenciales:

```bash
export VEKAI_TOKEN="eyJ..."
```

`VEKAI_TOKEN` tiene prioridad sobre `VEKAI_USERNAME` y `VEKAI_PASSWORD`. Nunca subas
un archivo `.env`, credenciales o tokens al repositorio.

## Inicio rápido

Cada implementación expone los mismos comandos. Por ejemplo, con Python:

```bash
cd python
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

python main.py list-domains
python main.py create-domain "Manuales de mantenimiento"
python main.py upload-document 123 ../documentos/manual.pdf
python main.py create-chat 123 "Consulta de manuales"
python main.py ask 123 456 "¿Cada cuánto se realiza el mantenimiento preventivo?"
python main.py sources 123 456 789
python main.py mcp-sources 123 456 789
python main.py stream 123 456 "Resume el procedimiento de bloqueo"
python main.py messages 123 456 --reasoning
```

Consulta las instrucciones de [Python](python/README.md), [.NET](dotnet/README.md) o
[Java](java/README.md). También hay clientes web completos en
[Angular](angular/README.md) y [React](react/README.md).

## Flujo recomendado

```text
autenticación → dominio → documento → chat → pregunta
                                                ├─ fuentes
                                                └─ razonamiento
```

La indexación del documento es asíncrona. Que la subida responda correctamente no
implica que el documento ya esté listo para responder preguntas. En una integración de
producción se debe consultar su estado antes de iniciar el chat.

## Operaciones utilizadas

| Operación | Método y ruta |
|---|---|
| Autenticar | `POST /api/authenticate` |
| Crear/listar dominios | `POST/GET /api/domains` |
| Subir documento | `POST /api/domains/{domainId}/documents` |
| Crear chat | `POST /api/domains/{domainId}/chat` |
| Preguntar | `POST /api/domains/{domainId}/chat/{chatId}/messages` |
| Historial y razonamiento | `GET /api/domains/{domainId}/chat/{chatId}/messages` |
| Fuentes | `GET /api/domains/{domainId}/chat/{chatId}/messages/{messageId}/source` |
| Streaming | `GET /api/domains/{domainId}/chats/{chatId}/messages/stream` |

Todos los endpoints salvo autenticación reciben `Authorization: Bearer <JWT>`. Las
fuentes de herramientas MCP no proceden de `/source`: se persisten dentro de
`reasoningSteps[].toolOutput` y se muestran con el comando `mcp-sources`.

## Streaming y razonamiento

El endpoint de streaming usa Server-Sent Events. Dependiendo de la configuración del
dominio puede devolver eventos JSON estructurados o fragmentos de texto del protocolo
legacy. Los tres ejemplos admiten ambos formatos.

Entre los eventos estructurados relevantes se encuentran `text-delta`,
`reasoning-delta`, `tool-input-available`, `tool-output-available`, `error` y `finish`.
El contenido de razonamiento es una traza operativa resumida; no debe interpretarse como
la cadena de pensamiento interna del modelo. En esta versión, los pasos de tipo `tool`
pueden incluir `toolName`, `toolInput`, `toolOutput`, `toolRowCount`, `toolKeys`,
`toolTruncated`, `toolErrorText` y `durationMs`.

Al terminar el stream, VEKAI persiste la respuesta. El comando `messages --reasoning`
recupera el historial con el array `reasoningSteps` de cada mensaje.

## Notas del contrato

Los ejemplos se han contrastado con el contrato OpenAPI 3.0.1 y la implementación del
backend. La subida se envía como `multipart/form-data`, con una parte binaria
`uploadFile` y una parte textual `document`. Algunas versiones del OpenAPI describen
esta operación como JSON o sitúan `document` en la query; eso no representa el contrato
multipart que acepta actualmente el backend.

Consulta [docs/CONTRACT.md](docs/CONTRACT.md) para ver payloads y consideraciones de
producción, y [docs/VERSION.md](docs/VERSION.md) para la referencia exacta de versión.

## Licencia

Este repositorio se publica bajo la [licencia MIT](LICENSE).
