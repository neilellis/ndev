#!/usr/bin/env python3
"""Report every difference between the Claude and Codex harness trees.

Two harnesses read the same skills. They store some facts in different files,
and neither harness reads the other notation:

    fact                  Claude                       Codex
    skill body            .claude/skills/<s>/SKILL.md  .agents/skills/<s>/SKILL.md
    invocation policy     frontmatter key              agents/openai.yaml
    agent definitions     .claude/agents/*.md          .codex/agents/*.toml
    hook wiring           .claude/settings.json        .codex/hooks.json

A copy of one tree onto the other carries the source notation with it. The
destination harness then reads nothing, and every test stays green because no
test compares the notations.

This reports. It changes nothing. The caller decides each fix, because a
difference is sometimes deliberate: a skill can be implicit-invocable on
purpose, and a harness can hold a skill the other does not.

Usage:

    check.py [REPO]        REPO defaults to the git top level of the current directory

Exit codes:

    0   the trees agree
    1   at least one difference found
    2   could not compare — a skill tree is missing or empty, or an agent tree is an
        unfetched submodule, so the comparison would read nothing
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

#: Names that are documentation of a tree, not a member of it.
NOT_A_SKILL = frozenset({"README.md", "README", "MIGRATION.md"})

CLAUDE_REFUSES = re.compile(r"^disable-model-invocation:\s*true\s*$", re.MULTILINE)
CLAUDE_ALLOWS = re.compile(r"^disable-model-invocation:\s*false\s*$", re.MULTILINE)
CODEX_REFUSES = re.compile(r"^\s+allow_implicit_invocation:\s*false\s*$", re.MULTILINE)
BACKTICKED = re.compile(r"`([a-z0-9][a-z0-9:-]*)`")


class CannotCompare(Exception):
    """A state where any comparison would read nothing and agree with everything."""


def repo_root(argv: list[str]) -> Path:
    if len(argv) > 2:
        raise CannotCompare("usage: check.py [REPO]")
    if len(argv) == 2:
        root = Path(argv[1]).resolve()
        if not root.is_dir():
            raise CannotCompare(f"repo not found: {root}")
        return root
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True
    )
    if result.returncode != 0:
        raise CannotCompare(
            "not in a git repository and no REPO given. "
            f"Fix: run inside the checkout, or pass its path. git said: {result.stderr.strip()}"
        )
    return Path(result.stdout.strip())


def frontmatter(skill_md: Path) -> str:
    """Return the frontmatter block, or an empty string when there is none."""
    text = skill_md.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        return ""
    end = text.find("\n---", 4)
    if end == -1:
        return ""
    return text[4:end]


def skill_names(root: Path) -> set[str]:
    return {
        path.parent.name
        for path in root.glob("*/SKILL.md")
        if path.parent.name not in NOT_A_SKILL
    }


def claude_matching(skills: Path, pattern: re.Pattern[str]) -> set[str]:
    return {
        path.parent.name
        for path in skills.glob("*/SKILL.md")
        if pattern.search(frontmatter(path))
    }


def codex_refusers(skills: Path) -> set[str]:
    return {
        path.parents[1].name
        for path in skills.glob("*/agents/openai.yaml")
        if CODEX_REFUSES.search(path.read_text(encoding="utf-8"))
    }


def agent_names(root: Path, suffix: str) -> set[str]:
    return {p.stem for p in root.glob(f"*{suffix}") if p.stem not in NOT_A_SKILL}


def is_submodule(repo: Path, rel: str) -> bool:
    gitmodules = repo / ".gitmodules"
    if not gitmodules.is_file():
        return False
    return re.search(
        rf"^\s*path\s*=\s*{re.escape(rel)}\s*$",
        gitmodules.read_text(encoding="utf-8"),
        re.MULTILINE,
    ) is not None


def agents_difference(repo: Path) -> list[str]:
    """Compare agent definitions. Both trees absent is agreement, not a gap."""
    claude_dir = repo / ".claude" / "agents"
    codex_dir = repo / ".codex" / "agents"
    if not claude_dir.is_dir() and not codex_dir.is_dir():
        return []
    claude = agent_names(claude_dir, ".md") if claude_dir.is_dir() else set()
    codex = agent_names(codex_dir, ".toml") if codex_dir.is_dir() else set()
    for rel, names in ((".claude/agents", claude), (".codex/agents", codex)):
        if not names and is_submodule(repo, rel):
            # An unfetched submodule is a tree that was never checked out. A
            # comparison against it names every agent on the other side, which
            # is a false report and worse than no report.
            raise CannotCompare(
                f"{rel} is a git submodule with no agent files, so it is not checked out. "
                f"Fix: git -C {repo} submodule update --init {rel}"
            )
    return [
        f"{name}: .claude/agents/{name}.md has no .codex/agents/{name}.toml"
        for name in sorted(claude - codex)
    ] + [
        f"{name}: .codex/agents/{name}.toml has no .claude/agents/{name}.md"
        for name in sorted(codex - claude)
    ]


def rules_difference(repo: Path, known: set[str]) -> list[str]:
    """Report a skill that one instruction file names and the other does not.

    Each harness reads its own instruction file (CLAUDE.md, AGENTS.md). A skill
    named in one file alone is invisible to the other harness. Only backticked
    words that are real skill names count, so other code spans are ignored.
    """
    claude_md = repo / "CLAUDE.md"
    agents_md = repo / "AGENTS.md"
    if not claude_md.is_file() and not agents_md.is_file():
        return ["neither CLAUDE.md nor AGENTS.md exists, so no harness is told which skill to load"]
    if not claude_md.is_file():
        return ["AGENTS.md exists, CLAUDE.md does not. Claude Code reads CLAUDE.md (one line `@AGENTS.md` imports it)"]
    if not agents_md.is_file():
        return ["CLAUDE.md exists, AGENTS.md does not. Codex reads AGENTS.md"]
    claude_text = claude_md.read_text(encoding="utf-8")
    if re.search(r"^@AGENTS\.md\s*$", claude_text, re.MULTILINE):
        return []  # CLAUDE.md imports AGENTS.md, so both harnesses read one text.
    claude_named = set(BACKTICKED.findall(claude_text)) & known
    codex_named = set(BACKTICKED.findall(agents_md.read_text(encoding="utf-8"))) & known
    return [
        f"{name}: named in CLAUDE.md, not in AGENTS.md"
        for name in sorted(claude_named - codex_named)
    ] + [
        f"{name}: named in AGENTS.md, not in CLAUDE.md"
        for name in sorted(codex_named - claude_named)
    ]


def report(title: str, lines: list[str]) -> int:
    """Print one section. Return the number of differences in it."""
    if not lines:
        print(f"OK   {title}")
        return 0
    print(f"DIFF {title}")
    for line in lines:
        print(f"       {line}")
    return len(lines)


def compare(repo: Path) -> int:
    claude_skills = repo / ".claude" / "skills"
    codex_skills = repo / ".agents" / "skills"
    missing = [str(p.relative_to(repo)) for p in (claude_skills, codex_skills) if not p.is_dir()]
    if missing:
        raise CannotCompare(
            "these skill trees do not exist, so this comparison reads nothing: "
            + ", ".join(missing)
            + ". If the repo serves only one harness, this check does not apply."
        )
    claude = skill_names(claude_skills)
    codex = skill_names(codex_skills)
    if not claude or not codex:
        raise CannotCompare(
            f"found {len(claude)} Claude skills and {len(codex)} Codex skills. "
            "An empty side makes every comparison below agree."
        )

    differences = 0
    differences += report(
        "both trees hold the same skills",
        [f"{name}: in .claude/skills, not in .agents/skills" for name in sorted(claude - codex)]
        + [f"{name}: in .agents/skills, not in .claude/skills" for name in sorted(codex - claude)],
    )

    shared = claude & codex
    claude_refuse = claude_matching(claude_skills, CLAUDE_REFUSES)
    claude_allow = claude_matching(claude_skills, CLAUDE_ALLOWS)
    codex_refuse = codex_refusers(codex_skills)
    # A skill that states `disable-model-invocation: false` refuses nothing on
    # purpose. Codex writes no file for that, so the absence agrees.
    unstated = (codex_refuse & shared) - claude_refuse - claude_allow
    stated_only_by_claude = (claude_refuse & shared) - codex_refuse
    differences += report(
        "implicit invocation is refused in both notations",
        [
            f"{name}: Codex refuses it, Claude does not. Add "
            f"`disable-model-invocation: true` to .claude/skills/{name}/SKILL.md"
            for name in sorted(unstated)
        ]
        + [
            f"{name}: Claude refuses it, Codex does not. Add `policy:` with "
            f"`allow_implicit_invocation: false` to .agents/skills/{name}/agents/openai.yaml"
            for name in sorted(stated_only_by_claude)
        ],
    )

    differences += report("both harnesses define the same agents", agents_difference(repo))
    differences += report(
        "both instruction files name the same skills", rules_difference(repo, claude | codex)
    )

    # A Codex policy file inside the Claude tree is read by nothing. It is a
    # second copy of a fact, and a second copy goes stale in silence.
    inert = sorted(str(p.relative_to(repo)) for p in claude_skills.glob("*/agents/openai.yaml"))
    differences += report(
        "no Codex policy file sits in the Claude tree",
        [f"{path}: Claude reads no `agents/openai.yaml`" for path in inert],
    )

    print()
    if differences:
        print(f"{differences} differences. Each one needs a decision, not a copy.")
        return 1
    print(f"The harness trees agree. {len(shared)} skills compared.")
    return 0


def main(argv: list[str]) -> int:
    try:
        return compare(repo_root(argv))
    except CannotCompare as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
