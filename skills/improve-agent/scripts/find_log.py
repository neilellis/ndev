#!/usr/bin/env python3
"""Select the most recently modified log of one automated agent across a repo's worktrees.

Usage:

    find_log.py AGENT --repo PATH [--pattern GLOB]... [--worktree PATH]

    AGENT       agent name, such as reviewer or judge (lower case, digits, hyphens)
    --repo      any checkout of the repository that holds the run logs
    --pattern   glob relative to each worktree; {agent} is replaced by AGENT.
                Repeat it for several layouts. Default: '**/{agent}.log'
    --worktree  search only this registered worktree. A missing log there is a
                failure; the search does not widen.

Selection: the newest non-empty match by file modification time, ties by path.
Size does not count. Each log belongs to the deepest registered worktree that
contains it, so a worktree nested inside another is not counted twice. This is
a discovery rule, not proof of the latest run: check the timestamps inside.

Exit codes: 0 found (JSON on stdout); 1 no non-empty log; 2 bad input or git error.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_PATTERNS = ("**/{agent}.log",)


class NotFound(Exception):
    """No non-empty log matched. Exit 1."""


def registered_worktrees(repo: Path) -> list[Path]:
    result = subprocess.run(
        ["git", "-C", str(repo), "worktree", "list", "--porcelain", "-z"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise ValueError(
            f"git worktree list failed in {repo} (exit {result.returncode}): "
            f"{result.stderr.strip()}. Fix: pass --repo <a git checkout>."
        )
    return [
        Path(field.removeprefix("worktree ")).resolve()
        for field in result.stdout.split("\0")
        if field.startswith("worktree ")
    ]


def owner(log: Path, worktrees: list[Path]) -> Path:
    """The deepest worktree that contains the log."""
    return max((w for w in worktrees if log.is_relative_to(w)), key=lambda w: len(w.parts))


def find(agent: str, repo: Path, patterns: list[str], only: Path | None) -> dict:
    registered = registered_worktrees(repo)
    if only is not None:
        if only not in registered:
            raise ValueError(f"Not a registered worktree of {repo}: {only}. "
                             f"Fix: pick one from `git -C {repo} worktree list`.")
        search = [only]
        basis = "log modification time in explicit --worktree"
    else:
        search = registered
        basis = "log modification time across registered worktrees"

    owners: dict[Path, Path] = {}
    for worktree in search:
        for pattern in patterns:
            for log in worktree.glob(pattern.replace("{agent}", agent)):
                log = log.resolve()
                if ".git" in log.relative_to(worktree).parts:
                    continue
                home = owner(log, registered)
                if only is not None and home != only:
                    continue  # belongs to a nested worktree, not the one asked for
                owners[log] = home

    stats = {log: log.stat() for log in owners if log.is_file()}
    stats = {log: st for log, st in stats.items() if st.st_size > 0}
    if not stats:
        scope = str(only) if only is not None else f"the {len(search)} registered worktrees of {repo}"
        raise NotFound(
            f"No non-empty log for agent '{agent}' matching {list(patterns)} in {scope}. "
            "Fix: check the run wrote a log, or pass --pattern for this layout."
        )
    log = max(stats, key=lambda p: (stats[p].st_mtime_ns, str(p)))
    stat = stats[log]
    worktree = owners[log]
    return {
        "agent": agent,
        "worktree": str(worktree),
        "selection_basis": basis,
        "log": str(log),
        "relative_path": str(log.relative_to(worktree)),
        "bytes": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
        "modified_utc": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
        "matching_nonempty_logs": len(stats),
        "scope": "most recently modified matching log across the selected worktrees; not every run",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("agent")
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--pattern", action="append", dest="patterns")
    parser.add_argument("--worktree", type=Path)
    args = parser.parse_args(argv)  # argparse exits 2 on bad usage
    try:
        if not re.fullmatch(r"[a-z][a-z0-9-]*", args.agent):
            raise ValueError(f"bad agent name {args.agent!r}: use lower case, digits and hyphens, such as reviewer")
        patterns = args.patterns or list(DEFAULT_PATTERNS)
        for pattern in patterns:
            if "{agent}" not in pattern:
                raise ValueError(f"--pattern {pattern!r} has no {{agent}}, so it would match every agent's log")
        repo = args.repo.resolve(strict=True)
        only = args.worktree.resolve(strict=True) if args.worktree else None
        print(json.dumps(find(args.agent, repo, patterns, only), indent=2))
        return 0
    except NotFound as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    except (OSError, ValueError) as error:
        print(f"ERROR: agent log discovery failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
