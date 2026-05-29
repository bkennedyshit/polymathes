"""Human-facing CLI: serve / index / search / info.

MCP hosts use the ``mneme-mcp`` entry point (stdio). This ``mneme`` CLI is for
people: seed a catalog, run a quick search from the terminal, or check status.
"""

from __future__ import annotations

import argparse
import json
import sys

from .config import Config
from .embedder import get_embedder
from .indexer import Indexer
from .store import Store


def _add_common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--db-path", help="SQLite catalog path (default: ~/.mneme/mneme.db)")
    p.add_argument("--backend", choices=["auto", "openclip", "hash", "native"],
                   help="embedding backend")


def _config_from_args(args: argparse.Namespace) -> Config:
    cfg = Config.from_env()
    if getattr(args, "db_path", None):
        from pathlib import Path
        cfg.db_path = Path(args.db_path).expanduser()
    if getattr(args, "backend", None):
        cfg.backend = args.backend
    return cfg


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="mneme", description="Local visual memory for AI agents.")
    sub = parser.add_subparsers(dest="command", required=True)

    p_serve = sub.add_parser("serve", help="run the MCP server over stdio")
    _add_common(p_serve)

    p_index = sub.add_parser("index", help="index a directory")
    p_index.add_argument("path")
    p_index.add_argument("--force", action="store_true")
    p_index.add_argument("--exclude", default="")
    _add_common(p_index)

    p_search = sub.add_parser("search", help="text search")
    p_search.add_argument("query", nargs="+")
    p_search.add_argument("--top-k", type=int, default=10)
    p_search.add_argument("--min-score", type=float, default=0.25)
    _add_common(p_search)

    p_info = sub.add_parser("info", help="show catalog status")
    _add_common(p_info)

    args = parser.parse_args(argv)
    cfg = _config_from_args(args)

    if args.command == "serve":
        from .server import build_server
        build_server(cfg).run()
        return 0

    if args.command == "info":
        cfg.ensure_dirs()
        store = Store(cfg.db_path)
        print(json.dumps({
            "db_path": str(cfg.db_path),
            "backend": cfg.backend,
            "assets": store.count(),
        }, indent=2))
        return 0

    if args.command == "index":
        cfg.ensure_dirs()
        store = Store(cfg.db_path)
        embedder = get_embedder(cfg)
        stats = Indexer(store, embedder, cfg).scan_directory(
            args.path, force=args.force, exclude=args.exclude
        )
        print(json.dumps({"backend": embedder.name, **stats.as_dict()}, indent=2))
        return 0

    if args.command == "search":
        cfg.ensure_dirs()
        store = Store(cfg.db_path)
        embedder = get_embedder(cfg)
        vec = embedder.embed_text(" ".join(args.query))
        results = store.search(vec, top_k=args.top_k, min_score=args.min_score)
        if not results:
            print("No results.", file=sys.stderr)
            return 0
        for r in results:
            ts = f" @ {r.timestamp:.1f}s" if r.timestamp else ""
            brand = r.metadata.get("brand", "")
            tag = f" [{brand}]" if brand else ""
            print(f"[{r.score:.3f}] [{r.type}]{tag} {r.path}{ts}")
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
