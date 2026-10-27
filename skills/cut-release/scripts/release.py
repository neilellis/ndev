#!/usr/bin/env python3
"""Cut a tagged GitHub release: a draft until its assets are attached, then published.

  release.py changes --tag TAG [--previous TAG] [--target REF]   notes skeleton: pull requests since the last release
  release.py draft   --tag TAG --target SHA --notes-file F [--prerelease]
  release.py attach  --tag TAG --build-script PATH         build assets at the draft's commit, upload and verify them
  release.py publish --tag TAG [--require-asset NAME ...]   refuse a draft without its assets, else publish it
  release.py wait    --tag TAG --workflow FILE              block until the release-triggered workflow run ends

Every command takes --tag-pattern REGEX (default: semantic version, optional "v" prefix
and an optional "-qualifier"). Run it from a clone of the repository; gh picks the
repository from the clone. The cut-release skill holds the procedure.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

SCRIPT = "release.py"
DEFAULT_PATTERN = r"v?\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?"
FULL_SHA = re.compile(r"[0-9a-f]{40}")
MERGE = re.compile(r"^Merge pull request #(\d+) ")
SQUASH = re.compile(r"\(#(\d+)\)$")
# A release-triggered run appears a moment after publication; this bounds that wait.
RUN_APPEARS_SECONDS = 120
# git ls-remote --exit-code exits 2 when no ref matches.
NO_MATCHING_REF = 2


class ReleaseError(Exception):
    def __init__(self, message: str, code: int = 1) -> None:
        super().__init__(message)
        self.code = code


def run(command: list[str], *, cwd: Path | None = None) -> str:
    try:
        result = subprocess.run(
            command, cwd=cwd, capture_output=True, text=True, check=False
        )
    except FileNotFoundError as error:
        raise ReleaseError(
            f"{command[0]} is not installed or not on PATH. Install it, then rerun."
        ) from error
    if result.returncode != 0:
        output = (result.stderr or result.stdout).strip()
        raise ReleaseError(f"{' '.join(command)} exited {result.returncode}: {output}")
    return result.stdout


def gh(*args: str, cwd: Path | None = None) -> str:
    return run(["gh", *args], cwd=cwd)


def git(*args: str) -> str:
    return run(["git", *args]).strip()


def repo() -> str:
    return gh("repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner").strip()


def view(tag: str) -> dict[str, Any]:
    return json.loads(
        gh(
            "release",
            "view",
            tag,
            "--json",
            "tagName,isDraft,targetCommitish,assets,publishedAt,url",
        )
    )


def release_exists(tag: str) -> bool:
    result = subprocess.run(
        ["gh", "release", "view", tag, "--json", "tagName"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode == 0:
        return True
    if "not found" in (result.stderr + result.stdout).lower():
        return False
    raise ReleaseError(
        f"gh release view {tag} exited {result.returncode}: {result.stderr.strip()}"
    )


def require_tag(tag: str, pattern: str) -> None:
    try:
        matcher = re.compile(pattern)
    except re.error as error:
        raise ReleaseError(f"--tag-pattern {pattern!r} is not a valid regex: {error}", 2)
    if not matcher.fullmatch(tag):
        raise ReleaseError(
            f"Release tag {tag!r} does not match {pattern!r}. Use a tag such as 1.2.0 or 1.2.0-rc.1, or pass --tag-pattern.",
            2,
        )


def is_candidate(tag: str) -> bool:
    return "-" in tag


def require_commit(sha: str) -> str:
    try:
        return git("rev-parse", "--verify", f"{sha}^{{commit}}")
    except ReleaseError as error:
        raise ReleaseError(
            f"Commit {sha} is not in this clone. Run git fetch origin, then rerun. ({error})"
        ) from error


def default_target() -> str:
    try:
        return git("symbolic-ref", "--short", "refs/remotes/origin/HEAD")
    except ReleaseError as error:
        raise ReleaseError(
            f"Cannot find the default branch of origin. Run git remote set-head origin --auto, or pass --target. ({error})"
        ) from error


def require_new_tag(tag: str, repair: str) -> None:
    """GitHub ignores --target when the Git tag exists, so the draft would mislabel its commit."""
    result = subprocess.run(
        ["git", "ls-remote", "--exit-code", "--tags", "origin", f"refs/tags/{tag}"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode == 0:
        raise ReleaseError(
            f"Tag {tag} already exists on origin ({result.stdout.split()[0]}), so a release would use that commit, not the draft's target. {repair}"
        )
    if result.returncode != NO_MATCHING_REF:
        raise ReleaseError(
            f"git ls-remote origin refs/tags/{tag} exited {result.returncode}: {result.stderr.strip()}"
        )


def require_draft(tag: str) -> dict[str, Any]:
    release = view(tag)
    if not release.get("isDraft"):
        raise ReleaseError(
            f"Release {tag} is published, not a draft. A published tag cannot move; cut the next tag with {SCRIPT} draft."
        )
    return release


def previous_release(tag: str) -> str:
    """A final release follows the last final release; a candidate follows the last release of any kind."""
    releases: list[dict[str, Any]] = json.loads(
        gh(
            "release",
            "list",
            "--exclude-drafts",
            "--limit",
            "100",
            "--json",
            "tagName,isPrerelease,publishedAt",
        )
    )
    final = not is_candidate(tag)
    tagged = [
        r
        for r in releases
        if r["tagName"] != tag
        and not (final and (is_candidate(r["tagName"]) or r["isPrerelease"]))
    ]
    if not tagged:
        kind = "final release" if final else "release"
        raise ReleaseError(
            f"No published {kind} to compare {tag} with. Pass --previous <tag> to {SCRIPT} changes."
        )
    return max(tagged, key=lambda r: r["publishedAt"])["tagName"]


def changes(tag: str, previous: str | None, target: str | None) -> int:
    previous = previous or previous_release(tag)
    try:
        base = git("rev-parse", "--verify", f"refs/tags/{previous}^{{commit}}")
    except ReleaseError as error:
        raise ReleaseError(
            f"Tag {previous} is not in this clone. Run git fetch origin --tags, then rerun. ({error})"
        ) from error
    target = require_commit(target or default_target())
    if (
        subprocess.run(
            ["git", "merge-base", "--is-ancestor", base, target], check=False
        ).returncode
        != 0
    ):
        raise ReleaseError(
            f"Target {target} does not contain the last release {previous} ({base}). Choose a later commit, or pass --previous."
        )
    pulls: list[int] = []
    direct: list[str] = []
    for line in git(
        "log", "--first-parent", "--format=%h %s", f"{base}..{target}"
    ).splitlines():
        short, _, subject = line.partition(" ")
        match = MERGE.match(subject) or SQUASH.search(subject)
        if match:
            pulls.append(int(match.group(1)))
        else:
            direct.append(f"- {subject} ({short})")
    print(
        f"<!-- Release notes skeleton: {previous}..{target}. Rewrite for the reader before the draft. -->"
    )
    print(f"Target commit: {target}\n")
    print(f"## Pull requests since {previous}\n")
    for number in sorted(set(pulls)):
        pull = json.loads(gh("pr", "view", str(number), "--json", "number,title"))
        print(f"- {pull['title']} (#{pull['number']})")
    if not pulls:
        print("- None")
    if direct:
        print("\n## Commits without a pull request\n")
        print("\n".join(direct))
    stat = git("diff", "--shortstat", base, target)
    print(f"\nDiff {previous}..{target[:12]}: {stat or 'no file changes'}")
    return 0


def draft(tag: str, target: str, notes: Path, prerelease: bool) -> int:
    if not FULL_SHA.fullmatch(target):
        raise ReleaseError(
            f"Target {target!r} is not a full commit SHA. Use the SHA that {SCRIPT} changes printed.",
            2,
        )
    require_commit(target)
    if not notes.is_file() or not notes.read_text().strip():
        raise ReleaseError(
            f"Notes file {notes} is missing or empty. Write the release notes there first.",
            2,
        )
    if release_exists(tag):
        raise ReleaseError(
            f"Release {tag} already exists. Choose the next tag; a published tag is immutable."
        )
    require_new_tag(
        tag,
        f"Choose the next tag, or delete the stray tag with git push origin :refs/tags/{tag}.",
    )
    command = ["release", "create", tag, "--draft", "--target", target]
    command += ["--title", tag, "--notes-file", str(notes)]
    if prerelease:
        command.append("--prerelease")
    gh(*command)
    print(f"Drafted {tag} on {target}. Next: {SCRIPT} attach, or {SCRIPT} publish.")
    return 0


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def remove_worktree(checkout: Path, *, failing: bool) -> None:
    """Remove the build worktree; while another error is raising, report a removal failure instead of hiding it."""
    try:
        git("worktree", "remove", "--force", str(checkout))
    except ReleaseError as error:
        message = f"Could not remove the build worktree {checkout}. Run git worktree prune. ({error})"
        if not failing:
            raise ReleaseError(message) from error
        print(f"cut-release: {message}", file=sys.stderr)


def attach(tag: str, build_script: str) -> int:
    target = require_draft(tag)["targetCommitish"]
    if not FULL_SHA.fullmatch(target):
        raise ReleaseError(
            f"Draft {tag} targets {target!r}, not a commit SHA. Delete the draft and redo {SCRIPT} draft with --target <sha>."
        )
    require_commit(target)
    with tempfile.TemporaryDirectory(prefix=f"cut-release-{tag}-") as scratch:
        checkout = Path(scratch) / "source"
        git("worktree", "add", "--detach", "--quiet", str(checkout), target)
        try:
            script = checkout / build_script
            if not script.is_file():
                raise ReleaseError(
                    f"Commit {target} has no {build_script}, so it cannot build the release assets. Target a later commit, or fix --build-script."
                )
            dist = Path(scratch) / "dist"
            dist.mkdir()
            sys.stdout.write(run(["bash", str(script), tag, str(dist)], cwd=checkout))
            built = {p.name: sha256(p) for p in sorted(dist.iterdir()) if p.is_file()}
            if not built:
                raise ReleaseError(
                    f"{build_script} wrote no files to its output directory (argument 2). Fix the build script."
                )
            gh("release", "upload", tag, "--clobber", *(str(dist / n) for n in built))
            downloaded = Path(scratch) / "downloaded"
            downloaded.mkdir()
            for name, digest in built.items():
                gh(
                    "release",
                    "download",
                    tag,
                    "--pattern",
                    name,
                    "--dir",
                    str(downloaded),
                    "--clobber",
                )
                if sha256(downloaded / name) != digest:
                    raise ReleaseError(
                        f"Asset {name} on draft {tag} differs from the one built at {target}. Run {SCRIPT} attach again."
                    )
        except BaseException:
            remove_worktree(checkout, failing=True)
            raise
        remove_worktree(checkout, failing=False)
    for name, digest in built.items():
        print(f"Attached {name} (sha256 {digest})")
    print(f"Next: {SCRIPT} publish --tag {tag}")
    return 0


def publish(tag: str, required: list[str]) -> int:
    release = require_draft(tag)
    names = {asset["name"] for asset in release.get("assets", [])}
    missing = [name for name in required if name not in names]
    if missing:
        raise ReleaseError(
            f"Draft {tag} lacks {', '.join(missing)}. Run {SCRIPT} attach --tag {tag}, then publish."
        )
    # A tag pushed since the draft would make publication use its commit, not the draft's.
    require_new_tag(
        tag,
        f"Delete the stray tag with git push origin :refs/tags/{tag}, or cut the next tag: gh release delete {tag} --yes, then {SCRIPT} draft --tag <next>.",
    )
    gh("release", "edit", tag, "--draft=false")
    print(f"Published {tag}: {view(tag).get('url', '')}")
    return 0


def wait(tag: str, workflow: str) -> int:
    release = view(tag)
    if release.get("isDraft"):
        raise ReleaseError(
            f"Release {tag} is still a draft, so no release run exists. Run {SCRIPT} publish --tag {tag}."
        )
    target = require_commit(release["targetCommitish"])
    deadline = time.monotonic() + RUN_APPEARS_SECONDS
    while True:
        runs: list[dict[str, Any]] = json.loads(
            gh(
                "run",
                "list",
                "--workflow",
                workflow,
                "--event",
                "release",
                "--branch",
                tag,
                "--limit",
                "20",
                "--json",
                "databaseId,headSha,headBranch,url,createdAt",
            )
        )
        # Two tags on one commit (a candidate and its final) share headSha; the tag tells them apart.
        # A deleted and re-cut tag keeps its old runs; only one started by this publication counts.
        found = [
            r
            for r in runs
            if r["headBranch"] == tag and r["createdAt"] >= release["publishedAt"]
        ]
        if found:
            break
        if time.monotonic() > deadline:
            raise ReleaseError(
                f"No {workflow} release run for {tag} ({target}) after {RUN_APPEARS_SECONDS}s. Check that {workflow} runs on 'release: published': https://github.com/{repo()}/actions/workflows/{workflow}"
            )
        time.sleep(10)
    run_id = str(found[0]["databaseId"])
    if found[0]["headSha"] != target:
        raise ReleaseError(
            f"{workflow} run {run_id} for {tag} built {found[0]['headSha']}, not the release target {target}; a tag pushed by hand moved the release. Stop it with gh run cancel {run_id}, then gh release delete {tag} --cleanup-tag --yes, then cut the next tag."
        )
    print(f"Waiting for {found[0]['url']}", flush=True)
    result = subprocess.run(
        ["gh", "run", "watch", run_id, "--exit-status", "--interval", "60"],
        check=False,
    )
    if result.returncode != 0:
        raise ReleaseError(
            f"{workflow} run {run_id} for {tag} failed (exit {result.returncode}). Read gh run view {run_id} --log-failed."
        )
    print(f"{workflow} run {run_id} for {tag} passed.")
    return 0


def main(argv: list[str]) -> int:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--tag", required=True)
    common.add_argument("--tag-pattern", default=DEFAULT_PATTERN)
    parser = argparse.ArgumentParser(
        prog=SCRIPT,
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    commands = parser.add_subparsers(dest="command", required=True)
    notes = commands.add_parser("changes", parents=[common])
    notes.add_argument("--previous")
    notes.add_argument("--target")
    create = commands.add_parser("draft", parents=[common])
    create.add_argument("--target", required=True)
    create.add_argument("--notes-file", required=True, type=Path)
    create.add_argument("--prerelease", action="store_true")
    build = commands.add_parser("attach", parents=[common])
    build.add_argument("--build-script", required=True)
    release = commands.add_parser("publish", parents=[common])
    release.add_argument("--require-asset", action="append", default=[])
    watch = commands.add_parser("wait", parents=[common])
    watch.add_argument("--workflow", required=True)
    a = parser.parse_args(argv)
    try:
        require_tag(a.tag, a.tag_pattern)
        match a.command:
            case "changes":
                return changes(a.tag, a.previous, a.target)
            case "draft":
                return draft(a.tag, a.target, a.notes_file, a.prerelease)
            case "attach":
                return attach(a.tag, a.build_script)
            case "publish":
                return publish(a.tag, a.require_asset)
            case _:
                return wait(a.tag, a.workflow)
    except ReleaseError as error:
        print(f"cut-release: {error}", file=sys.stderr)
        return error.code


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
