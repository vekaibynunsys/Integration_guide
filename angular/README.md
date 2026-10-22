# Cliente Angular

Ejemplo compatible con Angular 14.

```bash
npm install
npm start
```

Abre `http://localhost:4200`. El servidor de desarrollo reenvía `/api` a
`https://demo.vekai.ai` mediante `proxy.conf.json`.

La interfaz reproduce el flujo principal de VEKAI: inicio de sesión, navegación por
espacios, listado y reutilización de chats, creación de conversaciones, carga de
documentos y preguntas con o sin streaming. Las fuentes, el razonamiento MCP y los
artefactos aparecen en un panel de detalle de la última respuesta.

`GET /api/domains` aplica en el backend los permisos del usuario autenticado. El cliente
no intenta reconstruir esos permisos en el navegador. El streaming acepta tanto las
tramas legacy de 3.12 (`{"t":"..."}` / `{"done":true}`) como los eventos MCP/v1.

El JWT se guarda solamente en memoria. Para producción, sirve frontend y API bajo el
mismo origen o configura un proxy/BFF propio; no publiques credenciales ni tokens en el
bundle del navegador.

Angular 14 es una dependencia heredada de la versión objetivo y `npm audit` puede avisar
de vulnerabilidades en su toolchain. No ejecutes `npm audit fix --force`: migrar Angular
requiere una decisión separada y dejaría de reproducir la rama `3.12.0-rc-mcp`.
