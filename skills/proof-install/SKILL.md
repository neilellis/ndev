---
name: proof-install
description: "Install Proof, the check of each pull request before merge, in a project: write the GitHub workflow with ndev proof install, confirm the dev servers and routes with the human, start each server once, and try ndev proof run --local on a recent pull request. Use when the user asks to set up, install or add Proof to a project."
---

# Install Proof

Proof checks each pull request before merge. This skill sets it up in one project and proves that it runs there.

## Steps

1. Run `ndev proof install <project-path> --dry-run`. Read the files that it lists and the dev servers that it found.
2. Show the human each dev server: its name, command, folder, port and routes. Ask which routes the snapshots must cover. A route is a page path, for example `/` or `/settings`. Add the routes that the human names.
3. Run `ndev proof install <project-path> --yes`. When the human changed the dev servers, edit `devServers` in `.ndev.json` after the install, not before: the install keeps dev servers that the file already has.
4. Start each dev server once: `ndev project dev-servers start <name>`. When it fails, show the log that the error gives, fix the command, port or `ready` value with the human, and start it again. Stop it with `${CLAUDE_PLUGIN_ROOT}/scripts/work/worktree-env.sh stop --name <name>`.
5. When the result names a missing Playwright, give the human the add command that it prints. Do not add it yourself.
6. When the `ANTHROPIC_API_KEY` secret is missing or unknown, give the human the command that the result prints. Never ask for the key, and never write it to a file.
7. Check out a recent pull request branch (`gh pr checkout <n>`) and run `ndev proof run --local --base origin/<base branch>`. Show the human the table and the tier. A check that fails is a fact about that pull request, not about the install.
8. Tell the human to commit `.github/workflows/ndev-proof.yml` and `.ndev.json` in one pull request, and to add `ndev proof` as a required check after its first run.

## Limits

- A pull request from a fork gets no secret, so Proof skips it. A second job writes the reason to the job summary. To run Proof, a maintainer pushes the branch to the repository.
- The workflow installs dependencies with npm, pnpm or yarn. The command stops for bun.
- A workflow that the human changed is not replaced without `--force`.

## The workflow

Installing Proof is project setup, outside the development workflow, and calls no workflow tool. In a development session, `ndev proof run --local` runs before `mcp__ndev__finishedDevelopment`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
