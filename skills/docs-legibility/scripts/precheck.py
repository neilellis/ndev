#!/usr/bin/env python3
"""Fast plain-English precheck for Markdown and MDX docs pages.

  precheck.py [--base REF] [--content DIR] [--glossary FILE] [--max-words 25] [PAGE ...]

Pages come from the arguments, or from the .md/.mdx files under --content that changed
since --base (committed, staged, unstaged and untracked). It reads titles, descriptions,
headings, paragraphs, list items, table cells and the alt, caption, title and label
attributes. It skips code, imports, exports and JSX expressions. Inline code counts as
one word.

Findings: unnecessary jargon (error), sentences over --max-words (warning). With
--glossary, it also checks each entry has a kebab-case id, a term, match phrases, a reason
and a complete one-sentence definition that passes the same prose checks.

Exit 0: no errors. Exit 1: errors found. Exit 2: the check could not run.
A pass does not prove a page is readable; read every warning in context.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

JARGON = re.compile(
    r"\b(?:leverage[sd]?|leveraging|utilis(?:e|es|ed|ing|ation)|utiliz(?:e|es|ed|ing|ation)|synerg(?:y|ies)|"
    r"circle back|touch base|key learnings|going forward|best-in-class|move the needle|"
    r"low-hanging fruit|deep dive|holistic|paradigm|seamless(?:ly)?|mission-critical|ideate|"
    r"operationalis(?:e|ed|ing)|empower(?:s|ed|ing)?|robust|cutting-edge|game-chang(?:er|ing)|"
    r"blast[- ]radius|sunsetting)\b",
    re.I,
)
WORD = re.compile(r"[^\W_]+(?:[-/'’][^\W_]+)*", re.U)
ATTRS = re.compile(r"\b(alt|caption|title|label|note)=\"([^\"]+)\"")


class CheckError(Exception):
    pass


def git(root: Path, *args: str) -> list[str]:
    result = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True)
    if result.returncode:
        raise CheckError(
            f"git {' '.join(args)} exited {result.returncode}: {result.stderr.strip()}"
        )
    return [line for line in result.stdout.splitlines() if line]


def blocks(text: str) -> list[tuple[int, str, str]]:
    """(line, kind, text) for each prose block, with original line numbers."""
    lines = text.splitlines()
    out: list[tuple[int, str, str]] = []
    start = 0
    if lines and lines[0].strip() == "---":
        for index in range(1, len(lines)):
            if lines[index].strip() == "---":
                for number in range(1, index):
                    m = re.match(r"^(title|description):\s*(.+)$", lines[number])
                    if m:
                        out.append((number + 1, m.group(1), m.group(2).strip().strip("'\"")))
                start = index + 1
                break
        else:
            raise CheckError("front matter opens with --- but never closes")
    fence = None
    for number in range(start, len(lines)):
        line = lines[number]
        stripped = line.strip()
        marker = re.match(r"^(```|~~~)", stripped)
        if fence:
            if stripped.startswith(fence):
                fence = None
            continue
        if marker:
            fence = marker.group(1)
            continue
        if not stripped or re.match(r"^(import|export)\s", stripped):
            continue
        for kind, value in ATTRS.findall(line):
            out.append((number + 1, kind, value))
        prose = re.sub(r"`[^`]*`", "identifier", line)
        prose = re.sub(r"\{[^{}]*\}", " ", prose)
        prose = re.sub(r"<[^>]*>", " ", prose)
        prose = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", prose)
        prose = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", prose)
        prose = re.sub(r"https?://\S+", "link", prose)
        if re.match(r"^\|?\s*:?-{3,}", prose.strip()):
            continue
        kind = "heading" if stripped.startswith("#") else "table" if stripped.startswith("|") else "text"
        cells = prose.split("|") if kind == "table" else [prose]
        for cell in cells:
            cell = re.sub(r"^\s*(?:#+|[-*+]|\d+\.|>)\s*", "", cell).strip()
            if WORD.search(cell):
                out.append((number + 1, kind, cell))
    return out


def check_text(text: str, max_words: int) -> list[tuple[str, str]]:
    findings = []
    for hit in JARGON.finditer(text):
        findings.append(("error", f"replace unnecessary jargon: {hit.group(0)}"))
    for sentence in re.split(r"(?<=[.!?])\s+|:\s+", text):
        count = len(WORD.findall(sentence))
        if count > max_words:
            findings.append(("warning", f"{count} words; split this sentence if that makes it clearer: {sentence[:80]}…"))
    return findings


def check_glossary(path: Path, max_words: int) -> list[str]:
    try:
        entries = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CheckError(f"glossary {path}: {error}") from error
    if isinstance(entries, dict):
        entries = entries.get("terms", entries.get("entries"))
    if not isinstance(entries, list):
        raise CheckError(f"glossary {path}: expected a list of entries (or a 'terms' list)")
    problems, ids, phrases = [], set(), set()
    for entry in entries:
        name = entry.get("id", "(missing id)") if isinstance(entry, dict) else "(not an object)"
        def fail(message: str) -> None:
            problems.append(f"{path}: {name}: {message}")
        if not isinstance(entry, dict):
            fail("entry must be an object")
            continue
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", str(entry.get("id", ""))) or entry["id"] in ids:
            fail("id must be unique and kebab-case")
        ids.add(entry.get("id"))
        if not isinstance(entry.get("reason"), str) or len(entry["reason"].strip()) < 12:
            fail("explain why readers need this technical term (reason)")
        definition = entry.get("definition")
        if not isinstance(definition, str) or not re.search(r"[.!?]$", definition.strip()):
            fail("give a complete plain-English definition ending in a full stop")
        elif any(level == "error" or "words" in message for level, message in check_text(definition, max_words)):
            fail("definition must pass the prose checks")
        if not isinstance(entry.get("term"), str) or not isinstance(entry.get("match", []), list):
            fail("term must be a string and match a list of phrases")
        for phrase in entry.get("match", []) or []:
            key = str(phrase).lower()
            if not key.strip() or key in phrases:
                fail(f"match phrase empty or duplicate: {phrase!r}")
            phrases.add(key)
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", default="origin/main")
    parser.add_argument("--content", help="Docs content directory, for changed-page selection.")
    parser.add_argument("--glossary", type=Path)
    parser.add_argument("--max-words", type=int, default=25)
    parser.add_argument("pages", nargs="*", type=Path)
    args = parser.parse_args()
    try:
        if args.pages:
            pages = args.pages
        else:
            if not args.content:
                raise CheckError("give PAGE arguments or --content DIR")
            root = Path(git(Path.cwd(), "rev-parse", "--show-toplevel")[0])
            content = Path(args.content).resolve()
            changed = set(git(root, "diff", "--name-only", "--no-renames", f"{args.base}...HEAD"))
            changed.update(git(root, "diff", "--name-only", "HEAD"))
            changed.update(git(root, "ls-files", "--others", "--exclude-standard"))
            pages = sorted(
                root / p
                for p in changed
                if p.endswith((".md", ".mdx"))
                and (root / p).is_file()
                and (root / p).resolve().is_relative_to(content)
            )
            if not pages:
                print(f"Docs legibility: no changed pages under {args.content} since {args.base}. Nothing was checked.")
                return 0
        errors = warnings = 0
        for page in pages:
            if page.suffix not in {".md", ".mdx"}:
                raise CheckError(f"{page}: not a .md or .mdx page")
            try:
                text = page.read_text(encoding="utf-8")
                found = blocks(text)
            except (OSError, CheckError) as error:
                raise CheckError(f"{page}: {error}") from error
            for line, kind, value in found:
                for level, message in check_text(value, args.max_words):
                    print(f"{page}:{line}: {level} ({kind}): {message}")
                    errors += level == "error"
                    warnings += level == "warning"
        problems = check_glossary(args.glossary, args.max_words) if args.glossary else []
        for problem in problems:
            print(f"{problem}")
        errors += len(problems)
        print(f"Docs legibility: {len(pages)} page(s), {errors} error(s), {warnings} warning(s).")
        return 1 if errors else 0
    except CheckError as error:
        print(f"Docs legibility could not run: {error}. Fix the input and rerun.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
