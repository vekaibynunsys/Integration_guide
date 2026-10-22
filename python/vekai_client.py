"""Cliente mínimo y legible para los endpoints de ejemplo de VEKAI."""

from __future__ import annotations

import json
import mimetypes
import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx


class VekaiError(RuntimeError):
    """Error HTTP devuelto por VEKAI."""


class VekaiClient:
    def __init__(
        self,
        base_url: str,
        *,
        token: str | None = None,
        username: str | None = None,
        password: str | None = None,
        timeout: float = 30.0,
    ) -> None:
        self._token = token
        self._username = username
        self._password = password
        self._http = httpx.Client(
            base_url=base_url.rstrip("/"),
            timeout=httpx.Timeout(timeout, read=timeout),
            headers={"Accept": "application/json"},
        )

    @classmethod
    def from_env(cls) -> "VekaiClient":
        base_url = os.getenv("VEKAI_BASE_URL", "https://demo.vekai.ai")
        return cls(
            base_url,
            token=os.getenv("VEKAI_TOKEN") or None,
            username=os.getenv("VEKAI_USERNAME") or None,
            password=os.getenv("VEKAI_PASSWORD") or None,
        )

    def __enter__(self) -> "VekaiClient":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        self._http.close()

    def authenticate(self) -> str:
        if self._token:
            return self._token
        if not self._username or not self._password:
            raise VekaiError(
                "Define VEKAI_TOKEN o bien VEKAI_USERNAME y VEKAI_PASSWORD."
            )
        response = self._http.post(
            "/api/authenticate",
            json={
                "username": self._username,
                "password": self._password,
                "rememberMe": False,
            },
        )
        data = self._json(response)
        token = data.get("id_token")
        if not token:
            raise VekaiError("La autenticación no devolvió id_token.")
        self._token = str(token)
        return self._token

    def create_domain(
        self,
        name: str,
        *,
        description: str = "",
        instructions: str = "",
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            "/api/domains",
            json={
                "name": name,
                "description": description,
                "instructions": instructions,
                "lengthyResponse": False,
                "llmKnowledge": False,
                "reactRag": False,
                "advancedTables": False,
            },
        )

    def list_domains(
        self, *, page: int = 0, size: int = 20
    ) -> list[dict[str, Any]]:
        return self._request(
            "GET", "/api/domains", params={"page": page, "size": size}
        )

    def upload_document(
        self, domain_id: int, file_path: str | Path
    ) -> dict[str, Any]:
        path = Path(file_path)
        if not path.is_file():
            raise VekaiError(f"No existe el archivo: {path}")
        mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        metadata = {
            "name": path.name,
            "url": path.name,
            "documentType": path.suffix.removeprefix(".").lower() or "binary",
            "documentSize": path.stat().st_size,
            "domain": {"id": domain_id},
        }
        with path.open("rb") as file:
            return self._request(
                "POST",
                f"/api/domains/{domain_id}/documents",
                files={
                    "uploadFile": (path.name, file, mime_type),
                    "document": (None, json.dumps(metadata), "application/json"),
                },
            )

    def create_chat(self, domain_id: int, name: str) -> dict[str, Any]:
        return self._request(
            "POST", f"/api/domains/{domain_id}/chat", json={"name": name}
        )

    def ask(
        self,
        domain_id: int,
        chat_id: int,
        question: str,
        *,
        subdomain_ids: list[int] | None = None,
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/api/domains/{domain_id}/chat/{chat_id}/messages",
            json={"question": question, "subdomainIds": subdomain_ids or []},
        )

    def get_sources(
        self, domain_id: int, chat_id: int, message_id: int
    ) -> list[dict[str, Any]]:
        return self._request(
            "GET",
            f"/api/domains/{domain_id}/chat/{chat_id}/messages/{message_id}/source",
        )

    def get_messages(
        self, domain_id: int, chat_id: int, *, page: int = 0, size: int = 20
    ) -> list[dict[str, Any]]:
        return self._request(
            "GET",
            f"/api/domains/{domain_id}/chat/{chat_id}/messages",
            params={"page": page, "size": size, "sort": "questionAskedAt,desc"},
        )

    def get_mcp_sources(
        self, domain_id: int, chat_id: int, message_id: int
    ) -> list[dict[str, Any]]:
        """Extrae fuentes estructuradas producidas por herramientas MCP."""
        messages = self.get_messages(domain_id, chat_id, size=100)
        message = next((item for item in messages if item.get("id") == message_id), None)
        if message is None:
            raise VekaiError(
                f"El mensaje {message_id} no aparece entre los 100 mensajes más recientes."
            )
        return [
            {
                "toolName": step.get("toolName"),
                "status": step.get("status"),
                "toolOutput": step.get("toolOutput"),
                "rowCount": step.get("toolRowCount"),
                "truncated": step.get("toolTruncated"),
            }
            for step in message.get("reasoningSteps", [])
            if step.get("kind") == "tool" and step.get("toolOutput") is not None
        ]

    def stream(
        self,
        domain_id: int,
        chat_id: int,
        question: str,
        *,
        subdomain_ids: list[int] | None = None,
    ) -> Iterator[dict[str, Any] | str]:
        params: list[tuple[str, str | int]] = [("question", question)]
        params.extend(("subdomainIds", item) for item in subdomain_ids or [])
        with self._http.stream(
            "GET",
            f"/api/domains/{domain_id}/chats/{chat_id}/messages/stream",
            params=params,
            headers={**self._auth_headers(), "Accept": "text/event-stream"},
            timeout=httpx.Timeout(30.0, read=None),
        ) as response:
            self._raise_for_status(response)
            data_lines: list[str] = []
            for line in response.iter_lines():
                if line == "":
                    if data_lines:
                        value = "\n".join(data_lines)
                        data_lines.clear()
                        if value in {"[DONE]", "end_of_stream"}:
                            return
                        yield self._parse_stream_value(value)
                    continue
                if line.startswith("data:"):
                    data_lines.append(line[5:].lstrip())
            if data_lines:
                value = "\n".join(data_lines)
                if value not in {"[DONE]", "end_of_stream"}:
                    yield self._parse_stream_value(value)

    @staticmethod
    def _parse_stream_value(value: str) -> dict[str, Any] | str:
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else value
        except json.JSONDecodeError:
            return value

    def _auth_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.authenticate()}"}

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        headers = {**kwargs.pop("headers", {}), **self._auth_headers()}
        response = self._http.request(method, path, headers=headers, **kwargs)
        return self._json(response)

    def _json(self, response: httpx.Response) -> Any:
        self._raise_for_status(response)
        try:
            return response.json()
        except ValueError as error:
            raise VekaiError(
                f"VEKAI devolvió una respuesta no JSON ({response.status_code})."
            ) from error

    @staticmethod
    def _raise_for_status(response: httpx.Response) -> None:
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as error:
            request_id = response.headers.get("X-Request-Id")
            suffix = f" (request-id: {request_id})" if request_id else ""
            body = response.text[:1000]
            raise VekaiError(
                f"VEKAI respondió {response.status_code}{suffix}: {body}"
            ) from error
