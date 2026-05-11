#!/usr/bin/env python3
"""Generate symbol-index.yaml from declared code paths in code-index.yaml.

Walks only files declared in code-index.yaml node bindings (no broad repo scans).
Dispatches each file to a per-language extractor:

- Python (.py)  via stdlib ast
- TypeScript (.ts, .tsx) via Node + ts-morph (scripts/kg/ts-symbols/)
- C# (.cs) via .NET + Roslyn (scripts/kg/csharp-symbols/)

Emits planning-mds/knowledge-graph/symbol-index.yaml keyed by canonical node.
Maintains a per-file content-hash cache under .kg-state/ so unchanged files
are not re-parsed on subsequent runs. Cross-file caller/callee edges are
resolved each run by matching called names within the same canonical node.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable

import yaml

from kg_common import (
    KG_DIR,
    REPO_ROOT,
    emit_telemetry,
    estimate_tokens,
    expand_declared_pattern,
    load_bundle,
)


SYMBOL_INDEX_PATH = KG_DIR / "symbol-index.yaml"
CACHE_DIR = REPO_ROOT / ".kg-state"
CACHE_PATH = CACHE_DIR / "symbols-cache.json"

LANGUAGE_BY_EXT = {
    ".py": "python",
    ".cs": "csharp",
    ".ts": "typescript",
    ".tsx": "typescript",
}

CS_EXTRACTOR_ROOT = REPO_ROOT / "scripts" / "kg" / "csharp-symbols"
TS_EXTRACTOR_ROOT = REPO_ROOT / "scripts" / "kg" / "ts-symbols"


# ---------------------------------------------------------------------------
# Record + ID helpers
# ---------------------------------------------------------------------------


@dataclass
class SymbolRecord:
    id: str
    node: str
    kind: str
    name: str
    file: str
    line: int
    signature: str
    visibility: str
    language: str
    container: str | None = None
    callers: list[str] = field(default_factory=list)
    callees: list[str] = field(default_factory=list)
    # Unresolved called-names harvested by the extractor; resolved into
    # callers/callees by the orchestrator. Persisted in the cache but stripped
    # from the on-disk symbol-index.yaml.
    raw_calls: list[str] = field(default_factory=list)

    def to_cache_dict(self) -> dict[str, Any]:
        return asdict(self)

    def to_index_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d.pop("raw_calls", None)
        if d.get("container") is None:
            d.pop("container", None)
        return d


_CAMEL_RE = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")


def slug(text: str) -> str:
    if not text:
        return ""
    s = _CAMEL_RE.sub("-", text)
    s = re.sub(r"[_\s]+", "-", s)
    s = re.sub(r"[^A-Za-z0-9.-]", "", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s.lower()


def symbol_id(
    node: str, container: str | None, name: str, file_rel: str | None = None
) -> str:
    """Stable symbol ID. Container (class) disambiguates members; file stem
    disambiguates top-level symbols across files bound to the same node."""
    node_slug = node.replace(":", "-")
    member = slug(name) or "anonymous"
    if container:
        member = f"{slug(container)}.{member}"
    elif file_rel:
        stem = Path(file_rel).stem
        if stem:
            member = f"{slug(stem)}.{member}"
    return f"symbol:{node_slug}:{member}"


# ---------------------------------------------------------------------------
# Extractor base + Python AST extractor
# ---------------------------------------------------------------------------


class BaseExtractor:
    language: str = ""

    def extract(
        self, files: list[Path], file_to_node: dict[str, str]
    ) -> list[SymbolRecord]:
        """Return symbol records with `raw_calls` populated.

        Each record's `raw_calls` is a best-effort list of names invoked
        inside the symbol's body. The orchestrator turns those names into
        caller/callee edges via cross-file name matching scoped to the
        symbol's canonical node.
        """
        raise NotImplementedError


def _py_visibility(name: str) -> str:
    return "private" if name.startswith("_") else "public"


def _py_signature(node: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    args = ast.unparse(node.args) if hasattr(ast, "unparse") else ""
    prefix = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
    return f"{prefix} {node.name}({args})"


class PythonAstExtractor(BaseExtractor):
    language = "python"

    def extract(
        self, files: list[Path], file_to_node: dict[str, str]
    ) -> list[SymbolRecord]:
        records: list[SymbolRecord] = []

        for path in files:
            rel = path.relative_to(REPO_ROOT).as_posix()
            node_id = file_to_node.get(rel)
            if not node_id:
                continue
            try:
                source = path.read_text(encoding="utf-8")
                tree = ast.parse(source, filename=str(path))
            except (OSError, SyntaxError) as exc:
                print(
                    f"[symbols] python parse failed {rel}: {exc}", file=sys.stderr
                )
                continue

            self._walk(tree, rel, node_id, records)

        return records

    def _walk(
        self,
        tree: ast.Module,
        rel: str,
        node_id: str,
        records: list[SymbolRecord],
    ) -> None:
        def visit(parent_name: str | None, body: list[ast.stmt]) -> None:
            for stmt in body:
                if isinstance(stmt, ast.ClassDef):
                    records.append(SymbolRecord(
                        id=symbol_id(node_id, parent_name, stmt.name, file_rel=rel),
                        node=node_id,
                        kind="class",
                        name=stmt.name,
                        file=rel,
                        line=stmt.lineno,
                        signature=f"class {stmt.name}",
                        visibility=_py_visibility(stmt.name),
                        language=self.language,
                        container=parent_name,
                    ))
                    visit(stmt.name, stmt.body)
                elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    kind = "method" if parent_name else "function"
                    referenced: list[str] = []
                    for child in ast.walk(stmt):
                        if isinstance(child, ast.Call):
                            func = child.func
                            if isinstance(func, ast.Name):
                                referenced.append(func.id)
                            elif isinstance(func, ast.Attribute):
                                referenced.append(func.attr)
                    records.append(SymbolRecord(
                        id=symbol_id(node_id, parent_name, stmt.name, file_rel=rel),
                        node=node_id,
                        kind=kind,
                        name=stmt.name,
                        file=rel,
                        line=stmt.lineno,
                        signature=_py_signature(stmt),
                        visibility=_py_visibility(stmt.name),
                        language=self.language,
                        container=parent_name,
                        raw_calls=referenced,
                    ))

        visit(None, tree.body)


# ---------------------------------------------------------------------------
# Subprocess extractor base (used by TS + C#)
# ---------------------------------------------------------------------------


class SubprocessExtractor(BaseExtractor):
    command: list[str] = []
    timeout_seconds: int = 600

    def is_available(self) -> bool:
        return bool(self.command)

    def extract(
        self, files: list[Path], file_to_node: dict[str, str]
    ) -> list[SymbolRecord]:
        if not files:
            return []
        if not self.is_available():
            print(
                f"[symbols] {self.language} extractor not available; skipping {len(files)} files",
                file=sys.stderr,
            )
            return []

        payload = [p.relative_to(REPO_ROOT).as_posix() for p in files]
        try:
            result = subprocess.run(
                self.command,
                input=json.dumps(payload),
                capture_output=True,
                text=True,
                cwd=str(REPO_ROOT),
                timeout=self.timeout_seconds,
            )
        except subprocess.TimeoutExpired:
            print(
                f"[symbols] {self.language} extractor timed out", file=sys.stderr
            )
            return []
        except FileNotFoundError as exc:
            print(
                f"[symbols] {self.language} extractor not invokable: {exc}",
                file=sys.stderr,
            )
            return []

        if result.stderr:
            for line in result.stderr.splitlines():
                print(f"[symbols/{self.language}] {line}", file=sys.stderr)
        if result.returncode != 0:
            print(
                f"[symbols] {self.language} extractor exited {result.returncode}",
                file=sys.stderr,
            )
            return []

        try:
            raw_items = json.loads(result.stdout or "[]")
        except json.JSONDecodeError as exc:
            print(
                f"[symbols] {self.language} extractor produced invalid JSON: {exc}",
                file=sys.stderr,
            )
            return []

        records: list[SymbolRecord] = []
        for item in raw_items:
            rel_file = item.get("file")
            node_id = file_to_node.get(rel_file)
            if not node_id:
                continue
            name = item.get("name")
            if not name:
                continue
            container = item.get("container") or None
            referenced = [str(r) for r in (item.get("calls") or [])]
            records.append(SymbolRecord(
                id=symbol_id(node_id, container, name, file_rel=rel_file),
                node=node_id,
                kind=item.get("kind", "function"),
                name=name,
                file=rel_file,
                line=int(item.get("line", 0)) or 0,
                signature=item.get("signature", name),
                visibility=item.get("visibility", "public"),
                language=self.language,
                container=container,
                raw_calls=referenced,
            ))
        return records


class TsExtractor(SubprocessExtractor):
    language = "typescript"

    def __init__(self) -> None:
        node = shutil.which("node")
        entry = TS_EXTRACTOR_ROOT / "extract.js"
        node_modules = TS_EXTRACTOR_ROOT / "node_modules"
        if node and entry.exists() and node_modules.exists():
            self.command = [node, str(entry)]
        else:
            self.command = []


class CsExtractor(SubprocessExtractor):
    language = "csharp"

    def __init__(self) -> None:
        dotnet = shutil.which("dotnet")
        project = CS_EXTRACTOR_ROOT / "CSharpSymbols.csproj"
        if not (dotnet and project.exists()):
            self.command = []
            return
        # Prefer a pre-built DLL for speed; otherwise fall back to `dotnet run`.
        built = list(
            (CS_EXTRACTOR_ROOT / "bin" / "Release").glob("net*/CSharpSymbols.dll")
        )
        if built:
            self.command = [dotnet, str(built[0])]
        else:
            self.command = [
                dotnet,
                "run",
                "--project",
                str(project),
                "--configuration",
                "Release",
                "--",
            ]


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------


@dataclass
class FileCacheEntry:
    sha256: str
    mtime: float
    symbols: list[dict[str, Any]]  # each dict is SymbolRecord.to_cache_dict()


def load_cache() -> dict[str, FileCacheEntry]:
    if not CACHE_PATH.exists():
        return {}
    try:
        data = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    out: dict[str, FileCacheEntry] = {}
    for rel, value in data.items():
        try:
            out[rel] = FileCacheEntry(
                sha256=value["sha256"],
                mtime=float(value.get("mtime", 0.0)),
                symbols=list(value.get("symbols", [])),
            )
        except (KeyError, TypeError, ValueError):
            continue
    return out


def save_cache(cache: dict[str, FileCacheEntry]) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    serial = {
        rel: {
            "sha256": entry.sha256,
            "mtime": entry.mtime,
            "symbols": entry.symbols,
        }
        for rel, entry in cache.items()
    }
    CACHE_PATH.write_text(
        json.dumps(serial, sort_keys=True), encoding="utf-8"
    )


def hash_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------


def resolve_files_for_binding(binding: dict[str, Any]) -> list[tuple[Path, str]]:
    seen: set[str] = set()
    out: list[tuple[Path, str]] = []
    for entry in binding.get("declared_paths", []):
        for rel in expand_declared_pattern(entry["pattern"]):
            if rel in seen:
                continue
            seen.add(rel)
            abs_path = REPO_ROOT / rel
            if not abs_path.is_file():
                continue
            lang = LANGUAGE_BY_EXT.get(abs_path.suffix.lower())
            if lang:
                out.append((abs_path, lang))
    return out


def collect_work_items(
    bundle: dict[str, Any],
    node_filter: set[str] | None,
    language_filter: set[str] | None,
) -> dict[str, dict[Path, str]]:
    """Group files by language, mapping each file to its first claiming node."""
    work_by_lang: dict[str, dict[Path, str]] = {}
    for node_id, binding in bundle["bindings"].items():
        if node_filter and node_id not in node_filter:
            continue
        for abs_path, lang in resolve_files_for_binding(binding):
            if language_filter and lang not in language_filter:
                continue
            lang_map = work_by_lang.setdefault(lang, {})
            if abs_path not in lang_map:
                lang_map[abs_path] = node_id
    return work_by_lang


def run_extractor(
    extractor: BaseExtractor,
    files: list[Path],
    file_to_node: dict[str, str],
    cache: dict[str, FileCacheEntry],
    new_cache: dict[str, FileCacheEntry],
    force: bool,
    stats: dict[str, int],
) -> list[SymbolRecord]:
    """Split files into cached vs needs-parse; return merged records.

    Each returned SymbolRecord carries its `raw_calls` list. Records loaded
    from cache reconstruct via SymbolRecord(**dict) since the cache stores
    SymbolRecord.to_cache_dict() output (which preserves raw_calls).
    """
    records: list[SymbolRecord] = []
    to_parse: list[Path] = []
    parse_file_to_node: dict[str, str] = {}

    for path in files:
        rel = path.relative_to(REPO_ROOT).as_posix()
        stats["files"] += 1
        mtime = path.stat().st_mtime
        sha = hash_file(path)
        cached = None if force else cache.get(rel)
        if cached and cached.sha256 == sha:
            for sym in cached.symbols:
                records.append(SymbolRecord(**sym))
            new_cache[rel] = cached
            stats["cached"] += 1
            continue
        to_parse.append(path)
        parse_file_to_node[rel] = file_to_node[rel]
        new_cache[rel] = FileCacheEntry(sha256=sha, mtime=mtime, symbols=[])

    if to_parse:
        new_records = extractor.extract(to_parse, parse_file_to_node)
        records.extend(new_records)

        symbols_by_file: dict[str, list[dict[str, Any]]] = {}
        for rec in new_records:
            symbols_by_file.setdefault(rec.file, []).append(rec.to_cache_dict())

        for path in to_parse:
            rel = path.relative_to(REPO_ROOT).as_posix()
            new_cache[rel].symbols = symbols_by_file.get(rel, [])
            stats["parsed"] += 1

    return records


def resolve_call_edges(records: list[SymbolRecord]) -> None:
    """Resolve each record's `raw_calls` into callers/callees, scoped to its
    canonical node. Over-linking is acceptable for a retrieval aid; raw
    artifacts remain authoritative."""
    by_node_name: dict[tuple[str, str], list[SymbolRecord]] = {}
    for rec in records:
        by_node_name.setdefault((rec.node, rec.name), []).append(rec)

    for caller in records:
        for name in caller.raw_calls:
            for callee in by_node_name.get((caller.node, name), []):
                if callee.id == caller.id:
                    continue
                if callee.id not in caller.callees:
                    caller.callees.append(callee.id)
                if caller.id not in callee.callers:
                    callee.callers.append(caller.id)

    for rec in records:
        rec.callers.sort()
        rec.callees.sort()


def disambiguate_ids(records: list[SymbolRecord]) -> int:
    """Append a -2, -3, … suffix to records whose simple id collides.

    Ordering: stable by (file, line). The first record keeps the simple id;
    subsequent records get the suffix. Returns the count of rewritten ids."""
    records.sort(key=lambda r: (r.id, r.file, r.line))
    groups: dict[str, list[SymbolRecord]] = {}
    for rec in records:
        groups.setdefault(rec.id, []).append(rec)
    rewrites = 0
    for sid, group in groups.items():
        if len(group) <= 1:
            continue
        for idx, rec in enumerate(group[1:], start=2):
            rec.id = f"{sid}-{idx}"
            rewrites += 1
    return rewrites


def build_symbol_bundle(
    bundle: dict[str, Any],
    *,
    node_filter: set[str] | None,
    language_filter: set[str] | None,
    force: bool,
) -> tuple[list[SymbolRecord], dict[str, Any], dict[str, FileCacheEntry]]:
    cache = {} if force else load_cache()
    new_cache: dict[str, FileCacheEntry] = {}

    work = collect_work_items(bundle, node_filter, language_filter)

    extractors: dict[str, BaseExtractor] = {
        "python": PythonAstExtractor(),
        "typescript": TsExtractor(),
        "csharp": CsExtractor(),
    }

    parse_stats: dict[str, dict[str, int]] = {}
    all_records: list[SymbolRecord] = []

    for lang, extractor in extractors.items():
        file_map = work.get(lang) or {}
        if not file_map:
            continue
        files = list(file_map.keys())
        file_to_node = {
            path.relative_to(REPO_ROOT).as_posix(): node_id
            for path, node_id in file_map.items()
        }
        stats = parse_stats.setdefault(
            lang, {"files": 0, "parsed": 0, "cached": 0}
        )
        all_records.extend(
            run_extractor(extractor, files, file_to_node, cache, new_cache, force, stats)
        )

    rewrites = disambiguate_ids(all_records)
    resolve_call_edges(all_records)

    summary = {
        "total_symbols": len(all_records),
        "by_language": parse_stats,
        "disambiguated_ids": rewrites,
    }
    return all_records, summary, new_cache


def write_symbol_index(records: list[SymbolRecord], summary: dict[str, Any]) -> None:
    payload = {
        "version": 0,
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "summary": {
            "total_symbols": summary["total_symbols"],
            "by_language": summary["by_language"],
            "disambiguated_ids": summary.get("disambiguated_ids", 0),
        },
        "symbols": [r.to_index_dict() for r in sorted(records, key=lambda x: x.id)],
    }
    SYMBOL_INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    SYMBOL_INDEX_PATH.write_text(
        yaml.safe_dump(payload, sort_keys=False, allow_unicode=False),
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Generate symbol-index.yaml from declared code paths in "
            "code-index.yaml. Symbols are retrieval aids; raw source files "
            "remain authoritative."
        )
    )
    parser.add_argument(
        "--node",
        action="append",
        default=[],
        help="Restrict to one or more canonical node IDs.",
    )
    parser.add_argument(
        "--language",
        action="append",
        default=[],
        choices=["python", "csharp", "typescript"],
        help="Restrict to one or more languages.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Ignore cache and re-parse every selected file.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print summary without writing symbol-index.yaml or updating the cache.",
    )
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--telemetry-file", type=Path, default=None)
    args = parser.parse_args()

    bundle = load_bundle()
    node_filter = set(args.node) if args.node else None
    language_filter = set(args.language) if args.language else None

    records, summary, new_cache = build_symbol_bundle(
        bundle,
        node_filter=node_filter,
        language_filter=language_filter,
        force=args.force,
    )

    if not args.dry_run:
        write_symbol_index(records, summary)
        save_cache(new_cache)

    print(f"Symbol index: {summary['total_symbols']} symbols")
    for lang in ("python", "typescript", "csharp"):
        stats = summary["by_language"].get(lang)
        if not stats:
            continue
        print(
            f"  {lang:11} {stats['files']:>5} files "
            f"({stats['parsed']} parsed, {stats['cached']} cached)"
        )
    if summary.get("disambiguated_ids"):
        print(f"  Disambiguated ids: {summary['disambiguated_ids']}")

    nodes_with_symbols = sorted({r.node for r in records})
    telemetry_payload = {
        "total_symbols": summary["total_symbols"],
        "by_language": summary["by_language"],
    }
    emit_telemetry(
        args.telemetry_file,
        args.run_id,
        "symbols",
        {
            "total_symbols": summary["total_symbols"],
            "by_language": summary["by_language"],
            "nodes_returned": nodes_with_symbols,
            "nodes_count": len(nodes_with_symbols),
            "empty_scope": summary["total_symbols"] == 0,
            "ambiguous_count": summary.get("disambiguated_ids", 0),
            "hint_emitted": False,
            "confidence_band": "high",
            "tokens_estimated": estimate_tokens(telemetry_payload),
        },
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
