from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from vekai_client import VekaiClient, VekaiError


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="Ejemplos de integración con VEKAI")
    commands = root.add_subparsers(dest="command", required=True)

    commands.add_parser("list-domains").add_argument("--size", type=int, default=20)

    create_domain = commands.add_parser("create-domain")
    create_domain.add_argument("name")
    create_domain.add_argument("--description", default="")
    create_domain.add_argument("--instructions", default="")

    upload = commands.add_parser("upload-document")
    upload.add_argument("domain_id", type=int)
    upload.add_argument("file")

    create_chat = commands.add_parser("create-chat")
    create_chat.add_argument("domain_id", type=int)
    create_chat.add_argument("name")

    for name in ("ask", "stream"):
        command = commands.add_parser(name)
        command.add_argument("domain_id", type=int)
        command.add_argument("chat_id", type=int)
        command.add_argument("question")

    for name in ("sources", "mcp-sources"):
        sources = commands.add_parser(name)
        sources.add_argument("domain_id", type=int)
        sources.add_argument("chat_id", type=int)
        sources.add_argument("message_id", type=int)

    messages = commands.add_parser("messages")
    messages.add_argument("domain_id", type=int)
    messages.add_argument("chat_id", type=int)
    messages.add_argument("--reasoning", action="store_true")
    return root


def pretty(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def show_stream(client: VekaiClient, args: argparse.Namespace) -> None:
    for event in client.stream(args.domain_id, args.chat_id, args.question):
        if isinstance(event, str):
            print(event, end="", flush=True)
            continue
        event_type = event.get("type")
        if event_type == "text-delta":
            print(event.get("delta", ""), end="", flush=True)
        elif event_type == "reasoning-delta":
            print(f"\n[razonamiento] {event.get('delta', event.get('text', ''))}")
        elif event_type and event_type.startswith("tool-"):
            print(f"\n[{event_type}] {json.dumps(event, ensure_ascii=False)}")
        elif event_type == "error":
            print(f"\n[error] {event}", file=sys.stderr)
    print()


def main() -> int:
    args = parser().parse_args()
    try:
        with VekaiClient.from_env() as client:
            if args.command == "list-domains":
                result = client.list_domains(size=args.size)
            elif args.command == "create-domain":
                result = client.create_domain(
                    args.name,
                    description=args.description,
                    instructions=args.instructions,
                )
            elif args.command == "upload-document":
                result = client.upload_document(args.domain_id, args.file)
            elif args.command == "create-chat":
                result = client.create_chat(args.domain_id, args.name)
            elif args.command == "ask":
                result = client.ask(args.domain_id, args.chat_id, args.question)
            elif args.command == "sources":
                result = client.get_sources(
                    args.domain_id, args.chat_id, args.message_id
                )
            elif args.command == "mcp-sources":
                result = client.get_mcp_sources(
                    args.domain_id, args.chat_id, args.message_id
                )
            elif args.command == "stream":
                show_stream(client, args)
                return 0
            elif args.command == "messages":
                result = client.get_messages(args.domain_id, args.chat_id)
                if args.reasoning:
                    result = [
                        {"id": item.get("id"), "reasoningSteps": item.get("reasoningSteps", [])}
                        for item in result
                    ]
            else:
                raise AssertionError(f"Comando no implementado: {args.command}")
            pretty(result)
        return 0
    except VekaiError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
