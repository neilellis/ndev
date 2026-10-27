---
name: cut-release
description: "Cut a tagged GitHub release from the default branch. Collects the pull requests since the last release, writes the release notes, keeps the release a draft until its build assets are attached, then publishes it and waits for the release workflow. Use when the user asks to cut, make or publish a release."
disable-model-invocation: true
---

# Cut a release

A release is outward-facing. Its tag is immutable, and publication can start release workflows.
Confirm the tag, the target commit and the notes with the user before `draft`. Confirm again before `publish`.

The helper is `scripts/release.py` in this skill's folder. Run it with `python3` from a clone of the repository. `gh` picks the repository from the clone. Each step refuses a bad state and names the repair. Do not work around a refusal.

## Settings

Get these from the user's arguments, or from the repository's `CLAUDE.md` or `AGENTS.md`. Ask when neither gives them.

| Setting | Helper option | Default |
|---|---|---|
| Tag scheme | `--tag-pattern REGEX` | semantic version, optional `v`, optional `-qualifier` (`1.2.0`, `v1.2.0-rc.1`) |
| Target | `--target REF` | `origin/HEAD` (the default branch) |
| Build assets | `attach --build-script PATH` | none. The script runs as `bash PATH <tag> <out-dir>` at the target commit and writes the files to upload. |
| Required assets | `publish --require-asset NAME` (repeatable) | none |
| Release workflow | `wait --workflow FILE` | none. Skip step 9 when no workflow runs on `release: published`. |
| Notes rules | | the repository's writing rules and release-notes location, if it names them |

A tag with a `-` is a candidate. A tag without one is final.

## Steps

1. **Choose the tag and target.** Run `git fetch origin --tags`. Ask for the tag when the user did not name one. Suggest the next number after `gh release list`.
   Check that the CI of the target passed: `gh run list --commit <sha> --json workflowName,conclusion`. Report any failure and stop.
2. **Collect the changes.** Run `release.py changes --tag <tag> [--target <ref>] > <scratchpad>/notes-skeleton.md`.
   It lists the pull requests merged since the previous release, the commits without a pull request, and a diff summary.
   For a final release, the previous release is the last final release, so the notes cover every candidate since. For a candidate, it is the last release of any kind. Use `--previous <tag>` to choose another.
   It prints the full target SHA. Use that SHA in every later step.
3. **Read the pull request diffs.** Run `git diff --stat <previous>..<sha>` to find the pull requests that change what a user or operator runs or sees: the CLI, installer, deployment files, configuration, gates and UI.
   Read `gh pr diff <n>` for each of them, not only its description. A description can leave out a breaking change.
   Write down each breaking change, new setting and new step before you write the notes.
4. **Write the release notes** in `<scratchpad>/notes.md`, or the location the repository names. Start with what changed for the reader. Then add:
   - the upgrade steps, and each breaking change with its fix
   - the known limits
   - the pull request list from the skeleton, as `- Title (#n)`
   - the install or download line, if the project has one

   Do not claim more maturity than the project states (for example "GA" or "production-ready").
5. **Confirm.** Show the user the tag, the target SHA and the notes. Wait for approval.
6. **Draft.** Run `release.py draft --tag <tag> --target <sha> --notes-file <notes>`. Add `--prerelease` for a candidate when the user asks. The draft creates no tag yet.
7. **Attach assets** (only when the project builds release assets). Run `release.py attach --tag <tag> --build-script <path>`.
   It builds in a temporary worktree at the draft's commit, uploads every file the script wrote, downloads each one again and checks its SHA-256.
8. **Publish.** After the user confirms, run `release.py publish --tag <tag> [--require-asset <name> ...]`. It refuses a draft that lacks a required asset, or a tag that someone pushed by hand. Publication creates the tag.
9. **Wait for the release workflow.** Run `release.py wait --tag <tag> --workflow <file>` once, in the foreground. It blocks until the run ends and exits non-zero on a failure.
10. **Report** the release URL, the target SHA, the run URL and its result. If the run failed, say what the release lacks.

## When the release workflow fails

Read `gh run view <id> --log-failed` and report the first causal error.
Rerun with `gh run rerun <id> --failed` only for a transient failure, such as a runner or registry timeout.
For a code fault, fix it through a pull request and cut the next tag. The published tag cannot move.
Deleting the broken release is the user's decision. Ask the user.

If `gh` cannot write releases with an ambient `GITHUB_TOKEN`, unset it for the command so `gh` uses its keyring login.
