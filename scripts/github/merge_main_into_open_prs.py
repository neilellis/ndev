#!/usr/bin/env python3
# Copyright (c) 2026 Neil Ellis. Licensed under the MIT License.
"""Merge the base branch (default origin/<default branch>) into open PR branches, one worktree each.

Pushes through the repository's normal push (hooks run; never --no-verify) or --push-cmd.
Never force-pushes. Stops at the first failure."""
from __future__ import annotations

import argparse
from contextlib import contextmanager, nullcontext
from collections.abc import Generator
import json
import logging
import os
import shlex
import subprocess
from pathlib import Path
from typing import TypedDict, cast

logger = logging.getLogger(__name__)
LIMIT = 1000


class PullRequest(TypedDict):
    number: int
    headRefName: str
    headRefOid: str
    baseRefName: str
    isCrossRepository: bool


class State(TypedDict):
    branch: str
    original: str
    worktree: str


class UpdateError(Exception):
    """Stop the batch with evidence that identifies the failed operation."""

GH_SH = Path(__file__).resolve().parent / 'gh.sh'


class Commands:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.env = dict(os.environ)
        if self.env.get('GH_USE_KEYRING') == '1':
            self.env.pop('GITHUB_TOKEN', None)
        names = subprocess.check_output(['git', 'rev-parse', '--local-env-vars'], cwd=root, text=True)
        for name in names.splitlines():
            self.env.pop(name, None)

    def run(self, args: list[str], cwd: Path | None = None, log: Path | None = None) -> str:
        if log is not None:
            with log.open('a') as stream:
                stream.write(f'COMMAND: {args!r}\n')
                stream.flush()
                result = subprocess.run(args, cwd=cwd or self.root, env=self.env,
                                        stdout=stream, stderr=subprocess.STDOUT, check=False)
            if result.returncode:
                raise UpdateError(f'{args[0]} failed ({result.returncode}). Read {log}.')
            return ''
        result = subprocess.run(args, cwd=cwd or self.root, env=self.env,
                                capture_output=True, text=True, check=False)
        if result.returncode:
            raise UpdateError(f'{args!r} failed ({result.returncode}): {result.stderr.strip()}')
        return result.stdout.strip()

    def git(self, *args: str, cwd: Path | None = None) -> str:
        return self.run(['git', *args], cwd=cwd)

    def ancestor(self, base: str, head: str, cwd: Path | None = None) -> bool:
        result = subprocess.run(['git', 'merge-base', '--is-ancestor', base, head],
                                cwd=cwd or self.root, env=self.env, capture_output=True,
                                text=True, check=False)
        if result.returncode not in (0, 1):
            raise UpdateError(f'Cannot measure ancestry for {base} and {head}: {result.stderr}')
        return result.returncode == 0


def read_prs(commands: Commands, slug: str, requested: list[int], base: str) -> list[PullRequest]:
    # gh.sh: the gh command first, REST when it fails. It prints one JSON object for each line.
    commands.env['GH_REPO'] = slug
    out = commands.run(['bash', str(GH_SH), 'view-json', 'pr', '--open', '--limit', str(LIMIT), '--fields',
        'number,headRefName,headRefOid,baseRefName,isCrossRepository'])
    raw: object = [json.loads(line) for line in out.splitlines() if line.strip()]
    if not isinstance(raw, list):
        raise UpdateError('The PR list is invalid. No branch was updated.')
    prs = cast(list[PullRequest], raw)
    if len(prs) >= LIMIT:
        raise UpdateError('The PR list reached its limit. No branch was updated.')
    if requested:
        missing = set(requested) - {pr['number'] for pr in prs}
        if missing:
            raise UpdateError(f'Requested PRs are not open: {sorted(missing)}.')
        prs = [pr for pr in prs if pr['number'] in requested]
    for pr in prs:
        if pr['isCrossRepository'] or pr['baseRefName'] != base:
            raise UpdateError(f"PR #{pr['number']} needs a separate workflow: fork, or base {pr['baseRefName']!r} is not {base!r}. "
                              f"Exclude it, or rerun with --pr for the others.")
        commands.git('check-ref-format', f"refs/heads/{pr['headRefName']}")
        if pr['headRefName'] == base:
            raise UpdateError(f"PR #{pr['number']} names {base} as its head. Refusing to push {base}.")
    return prs


def update(commands: Commands, pr: PullRequest, args: argparse.Namespace) -> str:
    dry_run = args.dry_run
    base = f'origin/{args.base}'
    number = pr['number']
    remote = f"origin/{pr['headRefName']}"
    original = commands.git('rev-parse', remote)
    if commands.ancestor(base, original):
        return 'current'
    if dry_run:
        return 'needs update'
    directory = args.worktree_dir.resolve() if args.worktree_dir else commands.root / '.claude/worktrees'
    tree = directory / f'merge-main-pr-{number}'
    evidence = directory / 'merge-main-evidence'
    evidence.mkdir(parents=True, exist_ok=True)
    state_path = evidence / f'{number}.json'
    log = evidence / f'{number}.log'
    branch = f'merge-main/pr-{number}'
    if state_path.exists():
        state = cast(State, json.loads(state_path.read_text()))
        if state != dict(branch=pr['headRefName'], original=original, worktree=str(tree)):
            raise UpdateError(f'PR #{number} changed since preparation. Preserve {tree} and inspect {state_path}.')
        if commands.git('rev-parse', '--show-toplevel', cwd=tree) != str(tree):
            raise UpdateError(f'PR #{number} worktree is missing or invalid: {tree}.')
        if commands.git('branch', '--show-current', cwd=tree) != branch:
            raise UpdateError(f'PR #{number} worktree branch changed: {tree}.')
    else:
        if tree.exists():
            raise UpdateError(f'PR #{number} has an unowned path: {tree}. Preserve it and choose a separate checkout.')
        commands.run(['git', 'worktree', 'add', '-b', branch, str(tree), original], log=log)
        state_path.write_text(json.dumps(dict(branch=pr['headRefName'], original=original,
                                              worktree=str(tree)), indent=2) + '\n')
    if commands.git('status', '--porcelain', '--untracked-files=all', cwd=tree):
        raise UpdateError(f'PR #{number} has pending changes or conflicts in {tree}. Resolve and commit them, then rerun.')
    if not commands.ancestor(original, 'HEAD', cwd=tree):
        raise UpdateError(f'PR #{number} no longer contains its original tip. Inspect {tree}.')
    message = f'Merge {base} into ' + pr['headRefName']
    if args.trailer:
        message += '\n\n' + '\n'.join(args.trailer)
    try:
        commands.run(['git', 'merge', '--no-edit', '-m', message, base], cwd=tree, log=log)
    except UpdateError as exc:
        raise UpdateError(f'PR #{number} merge failed. Resolve conflicts in {tree}, commit, and rerun. {exc}') from exc
    # Automation must use the reviewed gate from the base, not a gate altered by the candidate.
    for gate in args.trusted_file:
        trusted = commands.git('show', f'{base}:{gate}')
        if (tree / gate).read_text().strip() != trusted:
            raise UpdateError(f'PR #{number} changes the push gate {gate}. Review that gate before updating this branch.')
    if args.install_cmd:
        # Each worktree owns its dependencies. A shared editable install can import another branch.
        logger.info('PR #%s: installing dependencies; log %s', number, log)
        commands.run(shlex.split(args.install_cmd), cwd=tree, log=log)
    current_remote = commands.git('ls-remote', 'origin', f"refs/heads/{pr['headRefName']}").split()
    if not current_remote or current_remote[0] != original:
        raise UpdateError(f'PR #{number} remote changed during preparation. Preserve {tree} and inspect {log}.')
    logger.info('PR #%s: pushing (hooks run); log %s', number, log)
    push = shlex.split(args.push_cmd) if args.push_cmd else ['git', 'push']
    if any(part.startswith('--no-ver') for part in push):
        raise UpdateError('Refusing a push command that bypasses hooks (--no-verify).')
    commands.run([*push, 'origin', f"HEAD:refs/heads/{pr['headRefName']}"], cwd=tree, log=log)
    commands.git('fetch', '--no-tags', 'origin', f"+refs/heads/{pr['headRefName']}:{remote}")
    if commands.git('rev-parse', remote) != commands.git('rev-parse', 'HEAD', cwd=tree):
        raise UpdateError(f'PR #{number} remote tip differs from the checked commit. Inspect {tree}.')
    if not commands.ancestor(base, remote):
        raise UpdateError(f'PR #{number} does not contain {base} after push. Inspect {tree}.')
    return 'updated (local guards passed; CI not checked)'


@contextmanager
def batch_lock(commands: Commands) -> Generator[None]:
    logger.debug('Acquiring the update lock for %s', commands.root)
    common = Path(commands.git('rev-parse', '--path-format=absolute', '--git-common-dir'))
    lock = common / 'merge-main-open-prs.lock'
    try:
        lock.mkdir()
    except FileExistsError as exc:
        raise UpdateError(f'Another update owns {lock}. If its process exited, remove this empty lock and rerun.') from exc
    try:
        yield
    finally:
        lock.rmdir()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, epilog='Stops at the first failure. '
        'Resolve and commit conflicts in the reported worktree, then rerun. Never force-pushes.')
    parser.add_argument('--repo', type=Path, default=Path.cwd(), help='local repository checkout')
    parser.add_argument('--github-repo', required=True, help='GitHub OWNER/REPO (set by the wrapper)')
    parser.add_argument('--base', default='main', help='base branch name (set by the wrapper)')
    parser.add_argument('--worktree-dir', type=Path, help='parent of the per-PR worktrees (default <repo>/.claude/worktrees)')
    parser.add_argument('--install-cmd', help='dependency install command to run in each worktree, e.g. "pnpm install --frozen-lockfile"')
    parser.add_argument('--push-cmd', help='push command; receives "origin HEAD:refs/heads/<branch>" (default: git push)')
    parser.add_argument('--trusted-file', action='append', default=[], help='file that must equal the base copy; repeatable')
    parser.add_argument('--trailer', action='append', default=[], help='commit trailer line for the merge commit; repeatable')
    parser.add_argument('--pr', type=int, action='append', default=[], help='update only this open PR; repeatable')
    parser.add_argument('--dry-run', action='store_true', help='fetch and list needed updates without creating worktrees')
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
    try:
        commands = Commands(args.repo.resolve())
        commands.root = Path(commands.git('rev-parse', '--show-toplevel'))
        prs = read_prs(commands, args.github_repo, args.pr, args.base)
        commands.git('fetch', '--no-tags', 'origin')
        logger.info('Updating open PR branches: %s items', len(prs))
        with nullcontext() if args.dry_run else batch_lock(commands):
            for pr in prs:
                logger.info('PR #%s: checking origin/%s ancestry', pr['number'], args.base)
                print(f"PR #{pr['number']}: {update(commands, pr, args)}", flush=True)
        print(f'Processed {len(prs)} open PRs.', flush=True)
    except (UpdateError, OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
        logger.error('PR update batch stopped: %s', exc)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
