# Setup: resume, health, label, worktree (F0, F0b, F0c, F1)

Part of the `work-heavy` skill. This file covers the steps before any code. `$REPO` and `$BASE` come from
`SKILL.md`.

## F0 — Resume check (do this first)

Before work on an issue or an existing branch, look for work in flight: an open PR on the
conventional branch, or a PR whose body says `Closes #<n>`.

```bash
gh pr list --repo "$REPO" --state open --head claude/issue-<n> \
  --json number,url,isDraft,statusCheckRollup
```

If one exists, this is a **resume, not a fresh start**. Read its latest `<!-- work-heavy-auto:state -->`
comment and the plan in the PR body. Base the worktree on `origin/<branch>`, not `origin/$BASE`, and
continue from the pickup point. Read the issue comments for a questions marker. Replies after it
are the human's answers. Use them and do not ask again.

**Then read what blocks the issue**, and record a block that GitHub does not hold:

```bash
gh.sh blocked-by list <n>              # ${CLAUDE_PLUGIN_ROOT}/scripts/github/gh.sh
gh.sh blocked-by add <n> <blocker#>
```

An open blocker means the work does not start. Say which issue blocks it and stop. Record a new
blocker when you find it: a dependency that exists only in a session is invisible to the
maintainer. Record only a block you have evidence for, and only between issues. A batch fold, a
resource or a pending decision is not a block. GitHub clears the block when the blocker closes.

## F0b — Is the default branch broken? Repair it first

Do this every pass. A branch cut from a broken `$BASE` goes red for a fault that is not its own.

```bash
gh run list --repo "$REPO" --branch "$BASE" --limit 30 \
  --json databaseId,headSha,conclusion,status,workflowName,createdAt
git rev-parse "origin/$BASE"
```

Read the result as one of three states:

- **Healthy**: the newest completed CI run is a success *and* its `headSha` is the current tip.
- **Broken**: the newest completed CI run failed. The suspects are the commits merged since the last
  pass (`git log <last-green-sha>..origin/$BASE --merges --oneline`). That is a list, not a culprit.
  Narrow it with `gh run view <run-id> --log-failed`.
- **Unknown**: no run in the window has a verdict, or the newest verdict is for an older commit (the
  tip's run is still queued). **Unknown is not healthy.** Widen the window, wait for the run with the
  `${CLAUDE_PLUGIN_ROOT}/scripts/github/wait-for-run.sh`, or say that health is unknown. Do not read an older pass as
  current.

If the project ships a health script (named in its `CLAUDE.md`), use it instead and read its
`status` field, not a boolean.

**Repair.** If the suspect PR is already merged, cut a fresh branch from `origin/$BASE`, fix it there
and open a PR that says `Refs #<n>` for the suspect. A closing keyword would close another person's
issue. If the suspect is still open, merge `$BASE` into its branch and fix it there. In both cases,
find the cause before the fix, and do not merge the repair yourself.

**A cancelled run on `$BASE`.** Read the workflow's `concurrency:` block before you decide what it
means:

```bash
git show "origin/$BASE:.github/workflows/<ci>.yml" | grep -A2 '^concurrency:'
```

- A group that includes the commit sha on `$BASE` gives each merge its own group. A cancelled run is
  unexpected and has a cause to find.
- A group keyed only on the ref holds at most one *pending* run. A newer run evicts the pending one,
  whatever `cancel-in-progress` says. A cancelled run there carries no information.
- A bare `cancel-in-progress: true`: the next merge cancels the run before it.

A run evicted while queued has zero jobs. A run cancelled while it executed has jobs:
`gh api repos/$REPO/actions/runs/<id>/jobs --jq .total_count`.

On a PR branch, a cancelled run means a newer push replaced it.

## F0c — The `incomprehensible` label

The maintainer puts `incomprehensible` on an issue or a PR when they cannot understand it. It means:
rewrite this for clarity before you do anything else.

```bash
gh.sh labelled incomprehensible     # the github skill; open issues and PRs with the label
```

If your item has the label, the rewrite is the first task. Read enough code and history to know what
the item is about: its own text does not tell you. Rewrite it with [F2b](prose.md#f2b--writing-for-humans),
post it with `gh.sh issue-edit` or `gh.sh pr-edit`, read the result once, then remove the label.
The orchestrators (`work-heavy-auto`, `work-light-auto`) clear these before they survey the board.

## F1 — Worktree, branch and draft PR

While a workflow runs, `mcp__ndev__started` has done all of F1, so go on to F2. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`. With no workflow, follow this fragment.

Claim the worktree with the guard. It is the only approved way to get one:

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/work/worktree_claim.sh "$PWD" <issue> "origin/$BASE"   # resume: origin/<branch>
cd .claude/worktrees/issue-<issue>
git rev-parse --show-toplevel     # MUST print the worktree path. If not, STOP.
```

If the session runs in Orca, the `orca-cli` skill can create and open the worktree. Run the claim
guard and the `rev-parse` check all the same.

**A non-zero exit means the worktree is not yours.** Exit 3 is uncommitted work, exit 4 is unpushed
commits, exit 2 means git could not answer. Stop, touch nothing, and report the issue as owned by
another session.

**Leave an existing worktree and its branch in place.** These commands delete a live session's work:

```bash
git worktree remove --force …    # deletes another session's working directory
git branch -D <branch>           # deletes their branch
git worktree add … -B …          # RESETS the branch and discards unpushed commits
```

The loss is silent: `git worktree add -B` reports the discard as `was at <sha>`. Treat an existing
worktree as another session's until the guard proves otherwise.

**Install only what your change touches.** A worktree install loads the whole machine (inode
creation and file-system events), and other jobs on the machine pay for it. Install the toolchain of
the packages you change. A change to docs, plans or issue text needs no install.

**Remove your worktree when the branch is pushed and merged**: `git worktree remove
.claude/worktrees/<name>`. The branch lives on the remote.

**Run `git rev-parse --show-toplevel` before your first edit, every time**, also when you were given
an existing worktree. An absolute path that drops the worktree prefix puts the work in the shared
checkout.

**If work already landed in the shared checkout, the cleanup is the dangerous part.** The shared
checkout usually holds another person's uncommitted state. A wide `git checkout -- .`, `git restore .`
or `git clean` destroys it. Recover in this order:

1. **Touch nothing.** Back the work up outside the repository twice. Make sure both copies are not
   empty.
2. **List** which paths are yours and which were there before. Get two independent lists that agree.
3. **Port** with `git apply --3way` into the real worktree.
4. **Revert by name, one path at a time.** No globs, no `.`, no `clean`.
5. **Verify** that the shared checkout matches its state at session start.

Do all remaining work inside the worktree. For issue work, open a draft PR at once so that the work
is visible and can be resumed:

```bash
git commit --allow-empty -m "chore: start <issue title> (#<n>)"
git push -u origin <branch>
gh pr create --repo "$REPO" --draft --base "$BASE" --head <branch> \
  --title "<conventional-commit title> (#<n>)" --body "WIP — plan incoming. Closes #<n>"
```

**Stay in draft while you implement, and push freely.** If the project's preview deployments start
only on ready PRs, you pay for the preview once, at F4.

**Draft is a state you must leave.** A draft is invisible to review and looks like an abandoned
branch. You may not end your turn on a draft PR unless the PR body says why it is still a draft. See
the exit check in [F6](state.md#f6--continuation-state-and-handoff).

For a **batched PR**: name the branch after the lead issue, title the epic or cluster, and add one
`Closes #<k>` per member.

**A closing keyword anywhere in the body closes that issue on merge.** GitHub reads the keyword, not
your intent. Use `Refs #<n>` for a reference you do not want to close. Put any literal keyword you
must quote in a code span. Then check what you declared:

```bash
gh pr view <pr> --repo "$REPO" --json closingIssuesReferences \
  --jq '[.closingIssuesReferences[].number]'
```
