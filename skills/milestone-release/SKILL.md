---
name: milestone-release
description: "Publish a GitHub release from committed milestone release notes when the user explicitly asks to cut or publish it."
disable-model-invocation: true
---

# Publish a milestone release

This is an outward-facing write. Use it only when the user invokes it. Confirm the exact release with the user just before you publish. Do not commit, push code or edit the release notes here.

The helper is `scripts/gh_release.sh` in this skill's folder. It takes one notes file:

```bash
scripts/gh_release.sh <notes-file.md> [--repo OWNER/NAME] [--tag TAG] [--target REF] \
                      [--latest true|false] [--draft] [--update] [--keyring]
```

- The file must exist in the repository, where `milestone-release-notes` wrote it.
- The tag is the file name without `.md`. The title is the file's first `#` heading. The body is the file, verbatim.
- `--repo` defaults to `gh repo view --json nameWithOwner -q .nameWithOwner` in the current directory.
- `--keyring` runs `gh` without `GITHUB_TOKEN`, so it uses the keyring login. Use it when the ambient token cannot write releases (gh fails with 403).
- The script refuses to overwrite an existing release unless you pass `--update`. If it cannot check for an existing release (auth or network), it stops.

| Exit | Meaning |
|---|---|
| 0 | Created or updated; the script prints the tag and title |
| 1 | `gh` failed, the repository is unknown, or the release exists without `--update` |
| 2 | Bad arguments or a missing notes file |

## Steps

1. Read the notes file. Confirm the target commit, tag, title, and whether a release already exists.
2. For a backfill, choose the target commit explicitly with `--target`.
3. Show the user the exact command, and wait for confirmation. Publishing makes a public tag and release.
4. Run the script. Report the release URL and tag.

Never use this skill to change a release's content other than from its notes file.

## The workflow

While a workflow runs, this skill is one step of the current stage. Commit each file that it changes with `mcp__ndev__checkpoint`, and read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
