#!/usr/bin/env python3
"""Docs map from page front matter: which docs pages cite the files that changed.

  docs_map.py suggest --content DIR [--range A..B | --stdin | FILE ...] [--json]
  docs_map.py check   --content DIR

Each page (.md or .mdx under --content) lists the repository files it documents in
YAML front matter, for example:

  ---
  title: Install
  source:
    - src/cli/install.ts
    - deploy/
  wiki:
    - docs/wiki/install.md
  ---

A listed directory covers every file below it. `suggest` prints three lists: pages
to review, changed files that no page cites, and cited files that were deleted.
`check` fails when a page cites a path that does not exist. Only plain block or
inline YAML lists of strings are read; anything else is an error that names the page.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import re
import subprocess
import sys
from pathlib import Path

FRONT_MATTER = re.compile(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|\Z)", re.S)


class MapError(Exception):
    pass


def git(root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args], cwd=root, capture_output=True, text=True, check=False
    )
    if result.returncode:
        raise MapError(
            f"git {' '.join(args)} exited {result.returncode}: {result.stderr.strip()}"
        )
    return result.stdout


def repo_root() -> Path:
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        raise MapError("Not inside a git checkout. Run from the repository.")
    return Path(result.stdout.strip())


def normalise(path: str) -> str:
    return path.strip().strip("'\"").split("#", 1)[0].removeprefix("./").rstrip("/")


def read_lists(page: Path, keys: list[str], rel: str) -> dict[str, list[str]] | None:
    match = FRONT_MATTER.match(page.read_text(encoding="utf-8"))
    if not match:
        return None
    lines = match.group(1).splitlines()
    found: dict[str, list[str]] = {}
    index = 0
    while index < len(lines):
        line = lines[index]
        key_match = re.match(r"^([A-Za-z_][\w-]*):\s*(.*)$", line)
        index += 1
        if not key_match or key_match.group(1) not in keys:
            continue
        key, rest = key_match.group(1), key_match.group(2).strip()
        items: list[str] = []
        if rest.startswith("[") and rest.endswith("]"):
            items = [i for i in (s.strip() for s in rest[1:-1].split(",")) if i]
        elif rest:
            raise MapError(
                f"{rel}: front matter '{key}' must be a list of paths, not {rest!r}. Fix the YAML list."
            )
        else:
            while index < len(lines) and re.match(r"^\s+-\s+", lines[index]):
                items.append(re.sub(r"^\s+-\s+", "", lines[index]))
                index += 1
        paths = [normalise(i) for i in items]
        bad = [
            p
            for p in paths
            if not p or p.startswith("/") or "\\" in p or ".." in p.split("/")
        ]
        if bad or not paths:
            raise MapError(
                f"{rel}: front matter '{key}' needs a non-empty list of repository-relative paths without '..' (bad: {bad or 'empty list'}). Fix the YAML list."
            )
        found[key] = paths
    return found or None


def collect(root: Path, content: Path, keys: list[str]) -> list[dict]:
    if not content.is_dir():
        raise MapError(
            f"Docs content directory {content} does not exist. Pass --content <dir>."
        )
    pages = []
    for page in sorted(content.rglob("*")):
        if page.suffix not in {".md", ".mdx"} or not page.is_file():
            continue
        rel = page.relative_to(root).as_posix()
        lists = read_lists(page, keys, rel) or {}
        pages.append({"page": rel, **{k: lists.get(k, []) for k in keys}})
    if not pages:
        raise MapError(
            f"No .md or .mdx pages under {content}. Check --content; zero pages is not a pass."
        )
    return pages


def covers(cited: str, changed: str) -> bool:
    return changed == cited or changed.startswith(cited + "/")


def suggest(args: argparse.Namespace, root: Path, content: Path, keys: list[str]) -> int:
    if args.stdin:
        files = sys.stdin.read().splitlines()
    elif args.range:
        files = git(root, "diff", "--name-only", args.range).splitlines()
    else:
        files = args.files
    changed = sorted({normalise(f) for f in files if normalise(f)})
    pages = collect(root, content, keys)
    content_rel = content.relative_to(root).as_posix()
    review: list[dict] = []
    unmapped: list[str] = []
    deleted: list[dict] = []
    for page in pages:
        because = []
        for key in keys:
            for cited in page[key]:
                for f in changed:
                    if covers(cited, f):
                        gone = not (root / f).exists()
                        because.append({"kind": key, "cited": cited, "changed": f, "deleted": gone})
                        if gone:
                            deleted.append({"page": page["page"], "kind": key, "path": f})
        if because:
            review.append(
                {"page": page["page"], "touched": page["page"] in changed, "because": because}
            )
    for f in changed:
        if f == content_rel or f.startswith(content_rel + "/"):
            continue
        if any(fnmatch.fnmatch(f, pattern) for pattern in args.ignore):
            continue
        if not any(covers(c, f) for p in pages for k in keys for c in p[k]):
            unmapped.append(f)
    if args.json:
        print(json.dumps({"review": review, "unmapped": unmapped, "deleted": deleted}, indent=2))
        return 0
    todo = [p for p in review if not p["touched"]]
    done = [p for p in review if p["touched"]]
    print(f"Pages to review ({len(todo)}):")
    for p in todo:
        print(f"  - {p['page']}")
        for b in p["because"]:
            print(f"      {b['kind']}: {b['changed']}{'  [deleted]' if b['deleted'] else ''}")
    if done:
        print(f"Already edited in this range: {', '.join(p['page'] for p in done)}")
    print(f"Changed files no page cites ({len(unmapped)}):")
    print("\n".join(f"  - {f}" for f in unmapped) or "  none")
    print(f"Deleted files that pages cite ({len(deleted)}):")
    print("\n".join(f"  - {d['path']} (cited by {d['page']})" for d in deleted) or "  none")
    return 0


def check(root: Path, content: Path, keys: list[str]) -> int:
    pages = collect(root, content, keys)
    missing = [
        f"{p['page']}: {k} path {c} does not exist"
        for p in pages
        for k in keys
        for c in p[k]
        if not (root / c).exists()
    ]
    mapped = sum(1 for p in pages if any(p[k] for k in keys))
    if missing:
        print("\n".join(missing), file=sys.stderr)
        print(
            f"docs-map: {len(missing)} cited path(s) are missing. Fix or remove them in the page front matter.",
            file=sys.stderr,
        )
        return 1
    print(f"docs-map: {len(pages)} pages, {mapped} with a map, all cited paths exist.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("suggest", "check"):
        p = sub.add_parser(name)
        p.add_argument("--content", required=True, help="Docs content directory.")
        p.add_argument(
            "--keys",
            default="source,wiki",
            help="Comma-separated front-matter keys that hold cited paths (default: source,wiki).",
        )
        if name == "suggest":
            p.add_argument("--range", help="Git range such as main..HEAD.")
            p.add_argument("--stdin", action="store_true")
            p.add_argument("--json", action="store_true")
            p.add_argument(
                "--ignore",
                action="append",
                default=[],
                help="Glob of changed files that never need a page (repeatable).",
            )
            p.add_argument("files", nargs="*")
    args = parser.parse_args()
    try:
        root = repo_root()
        content = (Path.cwd() / args.content).resolve()
        if not content.is_relative_to(root):
            raise MapError(f"--content {content} is outside the repository {root}.")
        keys = [k.strip() for k in args.keys.split(",") if k.strip()]
        if args.command == "suggest":
            return suggest(args, root, content, keys)
        return check(root, content, keys)
    except (MapError, OSError, UnicodeDecodeError) as error:
        print(f"docs-map: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
