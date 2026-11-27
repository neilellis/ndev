#!/usr/bin/env python3
# Copyright (c) 2026 Neil Ellis. Licensed under the MIT License.
"""Collect one bounded work snapshot without creating or claiming worktrees."""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, cast

logger = logging.getLogger(__name__)
PR_LIMIT = 1000
# All GitHub reads go through gh.sh: the gh command first, REST when it fails (see scripts/github/gh.sh).
GH_SH = Path(__file__).resolve().parent.parent / "github" / "gh.sh"
ATTENTION_LIMIT = 10
PR_FIELDS = (
    "number,title,url,state,headRefName,headRefOid,isDraft,mergeable,mergeStateStatus,"
    "reviewDecision,statusCheckRollup,closingIssuesReferences,isCrossRepository,headRepositoryOwner"
)


class StatusError(Exception):
    """The snapshot could not be measured. Never interpret this as new work."""


class Commands:
    def __init__(self, repo: Path, timeout: int) -> None:
        logger.debug("Preparing status commands for %s", repo)
        self.repo = repo
        self.timeout = timeout
        self.env = os.environ.copy()
        if self.env.get("GH_USE_KEYRING") == "1":
            self.env.pop("GITHUB_TOKEN", None)  # Use the gh keyring login (see scripts/github/lib.sh).
        names = self.run(["git", "rev-parse", "--local-env-vars"])
        for name in names.splitlines():
            self.env.pop(name, None)
        self.env["GIT_OPTIONAL_LOCKS"] = "0"
        self.repo = Path(self.git("rev-parse", "--show-toplevel").strip()).resolve()

    def run(self, argv: list[str], cwd: Path | None = None) -> str:
        logger.debug("Running %s in %s", argv[0], cwd or self.repo)
        result = subprocess.run(argv, cwd=cwd or self.repo, env=self.env,
                                capture_output=True, text=True, timeout=self.timeout, check=False)
        if result.returncode:
            raise StatusError(f"{argv[0]} failed ({result.returncode}): {result.stderr.strip()[:1000]}")
        return result.stdout

    def git(self, *args: str, cwd: Path | None = None) -> str:
        return self.run(["git", *args], cwd)

    def gh_lines(self, slug: str, *args: str) -> list[Any]:
        """One JSON value for each line gh.sh prints."""
        self.env["GH_REPO"] = slug
        return [json.loads(line) for line in self.run(["bash", str(GH_SH), *args]).splitlines() if line.strip()]

    def gh(self, slug: str, *args: str) -> Any:
        values = self.gh_lines(slug, *args)
        if len(values) != 1:
            raise StatusError(f"gh.sh {args[0]} printed {len(values)} values, expected one")
        return values[0]


def require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise StatusError(f"Invalid {label}: expected an object")
    return cast(dict[str, Any], value)


def require_list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise StatusError(f"Invalid {label}: expected an array")
    return cast(list[Any], value)


def github_repo(commands: Commands, override: str | None) -> str:
    logger.debug("Resolving GitHub repository")
    if override:
        slug = override
    else:
        origin = commands.git("remote", "get-url", "origin").strip()
        match = re.fullmatch(r"(?:git@github\.com:|https://github\.com/|ssh://git@github\.com/)([^/]+/[^/]+?)(?:\.git)?", origin)
        if not match:
            raise StatusError("Cannot infer GitHub repository from origin. Supply --github-repo OWNER/REPO.")
        slug = match.group(1)
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", slug):
        raise StatusError("--github-repo must be OWNER/REPO")
    return slug


def default_base(commands: Commands) -> str:
    """The remote default branch from origin/HEAD, else main."""
    result = subprocess.run(["git", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
                            cwd=commands.repo, env=commands.env, capture_output=True, text=True, check=False)
    name = result.stdout.strip().removeprefix("origin/")
    return name or "main"


def branch_matches(branch: str, args: argparse.Namespace) -> bool:
    if args.branch:
        return branch == args.branch
    leaf = branch.rsplit("/", 1)[-1]
    if args.issue:
        return bool(re.fullmatch(rf"issue-{args.issue}(?:-.+)?", leaf))
    return args.task is not None and leaf in {args.task, f"issue-{args.task}"}


def check_summary(checks: Any) -> tuple[str, dict[str, int], list[dict[str, Any]]]:
    counts = dict(passed=0, failed=0, pending=0, skipped=0)
    attention: list[dict[str, Any]] = []
    for value in require_list(checks, "statusCheckRollup"):
        check = require_object(value, "check")
        state = check.get("conclusion") or check.get("state") or check.get("status")
        if state in {"FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"}:
            counts["failed"] += 1
        elif state == "SUCCESS":
            counts["passed"] += 1
        elif state in {"SKIPPED", "NEUTRAL"}:
            counts["skipped"] += 1
        else:
            counts["pending"] += 1
        if state not in {"SUCCESS", "SKIPPED", "NEUTRAL"}:
            attention.append({"name": check.get("name") or check.get("context"), "state": state,
                              "url": check.get("detailsUrl") or check.get("targetUrl")})
    status = "fail" if counts["failed"] else "pending" if counts["pending"] else "pass" if counts["passed"] else "none"
    return status, counts, attention


def issue_reference_matches(value: Any, number: int, slug: str) -> bool:
    ref = require_object(value, "closing issue")
    if ref.get("number") != number:
        return False
    url = ref.get("url")
    repository = ref.get("repository", {})
    full_name = require_object(repository, "issue repository").get("nameWithOwner")
    if not url and not full_name:
        raise StatusError("Closing issue reference lacks repository identity")
    return (isinstance(url, str) and url.casefold() == f"https://github.com/{slug}/issues/{number}".casefold()) or (
        isinstance(full_name, str) and full_name.casefold() == slug.casefold())


def pull_requests(commands: Commands, slug: str, args: argparse.Namespace) -> list[dict[str, Any]]:
    logger.info("Reading GitHub work status for %s", slug)
    if args.pr:
        values = [commands.gh(slug, "view-json", "pr", str(args.pr), "--fields", PR_FIELDS)]
    else:
        values = commands.gh_lines(slug, "view-json", "pr", "--open", "--limit", str(PR_LIMIT), "--fields", PR_FIELDS)
        if len(values) >= PR_LIMIT:
            raise StatusError("PR query reached its 1000-result limit. Use --pr for an exact snapshot.")
    matches: list[dict[str, Any]] = []
    for value in values:
        pr = require_object(value, "PR")
        if not isinstance(pr.get("number"), int) or pr.get("state") not in {"OPEN", "CLOSED", "MERGED"}:
            raise StatusError("Invalid PR number or state")
        if args.pr and pr["number"] != args.pr:
            raise StatusError("GitHub returned a different PR")
        if pr["state"] == "OPEN" and not isinstance(pr.get("headRefName"), str):
            raise StatusError("Open PR has no branch")
        branch = pr.get("headRefName", "")
        refs = require_list(pr.get("closingIssuesReferences", []), "closing issues")
        linked = args.issue and any(issue_reference_matches(ref, args.issue, slug) for ref in refs)
        if args.pr or branch_matches(branch, args) or linked:
            checks, counts, attention = check_summary(pr.get("statusCheckRollup", []))
            matches.append({"number": pr["number"], "title": pr.get("title"), "url": pr.get("url"),
                            "state": pr["state"], "branch": branch, "head": pr.get("headRefOid"),
                            "fork": pr.get("isCrossRepository", False), "draft": pr.get("isDraft"),
                            "mergeable": pr.get("mergeable"), "merge_state": pr.get("mergeStateStatus"),
                            "review": pr.get("reviewDecision"), "checks": checks, "check_counts": counts,
                            "attention_checks": attention[:ATTENTION_LIMIT],
                            "attention_truncated": len(attention) > ATTENTION_LIMIT})
    return matches


def git_worktrees(commands: Commands) -> list[dict[str, str]]:
    logger.debug("Reading registered worktrees")
    records: list[dict[str, str]] = []
    for record in commands.git("worktree", "list", "--porcelain", "-z").split("\0\0"):
        fields: dict[str, str] = {}
        for field in record.split("\0"):
            if field:
                key, _, value = field.partition(" ")
                fields[key] = value
        if fields:
            records.append(fields)
    return records


def worktree_status(commands: Commands, record: dict[str, str], owned: Path | None, base: str) -> dict[str, Any]:
    path = Path(record["worktree"]).resolve()
    logger.info("Inspecting matching worktree %s", path)
    branch = record.get("branch", "").removeprefix("refs/heads/") or None
    if not path.is_dir():
        raise StatusError(f"Registered worktree is missing: {path}. Resolve its state before starting work.")
    dirty = bool(commands.git("status", "--porcelain=v1", "-z", "--untracked-files=normal", cwd=path))
    git_dir = Path(commands.git("rev-parse", "--absolute-git-dir", cwd=path).strip())
    inflight = [name for name in ("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-apply", "rebase-merge", "sequencer", "BISECT_LOG")
                if (git_dir / name).exists()]
    ahead = commands.git("rev-list", "--left-right", "--count", f"origin/{base}...HEAD", cwd=path).split()
    return {"path": str(path), "branch": branch, "head": record.get("HEAD"), "dirty": dirty,
            "inflight": inflight, "locked": "locked" in record, "prunable": "prunable" in record,
            "behind_base": int(ahead[0]), "ahead_base": int(ahead[1]),
            "ownership": "confirmed" if owned == path else "unknown"}


def collect(args: argparse.Namespace) -> dict[str, Any]:
    logger.info("Collecting one work snapshot")
    commands = Commands(Path(args.repo).resolve(), args.timeout)
    slug = github_repo(commands, args.github_repo)
    if args.fetch:
        commands.git("fetch", "--no-tags", "origin")
    selector = next((name, getattr(args, name)) for name in ("issue", "pr", "task", "branch") if getattr(args, name) is not None)
    report: dict[str, Any] = {"schema_version": 1, "status": "new", "can_start": True, "reasons": [],
                              "repo": str(commands.repo), "github_repo": slug, "selector": dict([selector]),
                              "observed_at": datetime.now(timezone.utc).isoformat(),
                              "prs": [], "branches": [], "worktrees": [], "ownership_probe": "caller confirmation only"}
    if args.issue:
        issue = require_object(commands.gh(slug, "issue-read", str(args.issue)), "issue")
        issue = {"number": issue.get("number"), "title": issue.get("title"), "url": issue.get("url"),
                 "state": str(issue.get("state", "")).upper()}
        if issue.get("number") != args.issue or issue.get("state") not in {"OPEN", "CLOSED"}:
            raise StatusError("Invalid issue number or state")
        report["issue"] = issue
        if issue["state"] == "CLOSED":
            report.update(status="closed", can_start=False, reasons=["The issue is closed. Do not create duplicate work."])
            return report
    prs = pull_requests(commands, slug, args)
    report["prs"] = prs
    if args.pr and prs[0]["state"] != "OPEN":
        report.update(status="closed", can_start=False, reasons=["The PR is closed or merged. Do not create duplicate work."])
        return report
    refs = dict(line.split("\t", 1) for line in commands.git("for-each-ref", "--format=%(refname)\t%(objectname)",
                                                           "refs/heads", "refs/remotes/origin").splitlines())
    # ls-remote is read-only and finds work pushed since this checkout's last fetch.
    remote_refs = {ref: sha for sha, ref in (line.split("\t", 1) for line in
                   commands.git("ls-remote", "--heads", "origin").splitlines())}
    base_name = args.base or default_base(commands)
    base = refs.get(f"refs/remotes/origin/{base_name}")
    if not base:
        raise StatusError(f"origin/{base_name} is missing. Run with --fetch to measure the base, or pass --base.")
    if f"refs/heads/{base_name}" not in remote_refs:
        raise StatusError(f"Origin has no {base_name} branch. Pass --base <branch> or resolve the remote before starting work.")
    report["base"] = {"ref": f"origin/{base_name}", "sha": base, "remote_sha": remote_refs[f"refs/heads/{base_name}"], "fetched": args.fetch}
    fork_names = {pr["branch"] for pr in prs if pr["fork"]}
    names = {pr["branch"] for pr in prs if not pr["fork"]}
    for ref in set(remote_refs) | {ref for ref in refs if ref.startswith("refs/heads/")}:
        name = ref.removeprefix("refs/heads/")
        if branch_matches(name, args) and name not in fork_names:
            names.add(name)
    report["branches"] = [{"name": name, "local": f"refs/heads/{name}" in refs,
                            "remote": f"refs/heads/{name}" in remote_refs} for name in sorted(names)]
    heads = {pr["head"] for pr in prs if pr["head"] and not pr["fork"]}
    owned = Path(args.owned_worktree).resolve() if args.owned_worktree else None
    matched = [record for record in git_worktrees(commands)
               if record.get("branch", "").removeprefix("refs/heads/") in names
               or ("detached" in record and record.get("HEAD") in heads)]
    logger.info("Inspecting %d matching worktrees", len(matched))
    trees = [worktree_status(commands, record, owned, base_name) for record in matched]
    report["worktrees"] = trees
    reasons: list[str] = []
    if len(prs) > 1 or len(names) > 1 or len(trees) > 1:
        reasons.append("Several matches exist. Select the exact --pr or --branch before acting.")
    if fork_names:
        reasons.append("A fork PR needs its own checkout. A same-name local branch is not ownership evidence.")
    if any(tree["inflight"] or tree["locked"] or tree["prunable"] or not tree["branch"] for tree in trees):
        reasons.append("A matching worktree is locked, detached, prunable, or has a Git operation in progress.")
    if owned and not any(tree["ownership"] == "confirmed" for tree in trees):
        reasons.append("--owned-worktree does not identify a matching worktree.")
    if reasons:
        report.update(status="blocked", can_start=False, reasons=reasons)
    elif trees and trees[0]["ownership"] == "confirmed":
        report.update(status="resume", reasons=["Caller confirmed ownership. Preserve all pending changes."])
    elif prs or names or trees:
        report.update(status="existing", can_start=False, reasons=["Existing work found. Use known session ownership before resuming; a clean tree does not prove ownership."])
    else:
        report["reasons"] = ["No matching open PR, known branch, or registered worktree. Use the safe claim helper; this snapshot does not claim ownership."]
    return report


def positive(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be positive")
    return number


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, epilog="Exit: 0 snapshot, 2 cannot measure, 3 blocked/closed. No model CLI, worktree creation, or polling.")
    parser.add_argument("--repo", default=".", help="local checkout (default: cwd)")
    selector = parser.add_mutually_exclusive_group(required=True)
    selector.add_argument("--issue", type=positive)
    selector.add_argument("--pr", type=positive)
    selector.add_argument("--task", help="exact branch leaf, with optional issue- prefix")
    selector.add_argument("--branch", help="exact branch name")
    parser.add_argument("--github-repo", help="OWNER/REPO override; otherwise inferred from origin")
    parser.add_argument("--base", help="base branch name (default: origin/HEAD, else main)")
    parser.add_argument("--owned-worktree", help="path whose ownership the caller already confirmed")
    parser.add_argument("--fetch", action="store_true", help="refresh origin refs once; otherwise local refs are cached")
    parser.add_argument("--timeout", type=positive, default=60, help="seconds per Git/GitHub command (default: 60)")
    parser.add_argument("--json", action="store_true", help="emit one machine-readable snapshot")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    logger.info("Checking requested work status")
    report: dict[str, Any]
    try:
        if args.task is not None and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", args.task):
            raise StatusError("--task must be a nonempty branch slug. Use --branch for a full branch name.")
        if args.branch == "":
            raise StatusError("--branch must not be empty")
        report = collect(args)
    except (StatusError, OSError, ValueError, subprocess.TimeoutExpired) as exc:
        logger.error("Work status could not be measured: %s", exc)
        report = {"schema_version": 1, "status": "error", "can_start": False, "error": str(exc)}
    if args.json:
        print(json.dumps(report, separators=(",", ":")))
    elif report["status"] == "error":
        print(f"error: {report['error']}")
    else:
        print(f"{report['status']}: {' '.join(report['reasons'])}")
        for pr in report["prs"]:
            print(f"PR #{pr['number']} {pr['branch']}: {pr['checks']} {pr['url']}")
        for tree in report["worktrees"]:
            print(f"Worktree {tree['path']}: dirty={tree['dirty']}, ownership={tree['ownership']}, behind_base={tree['behind_base']}")
    return 2 if report["status"] == "error" else 3 if report["status"] in {"blocked", "closed"} else 0


if __name__ == "__main__":
    raise SystemExit(main())
