---
title: Proof
description: Check each pull request before merge with ndev Proof, an agent run in GitHub Actions that gates the merge.
---

# Proof

Proof checks each pull request before it merges. A GitHub Actions job runs `ndev proof run`. The job collects facts about the change, starts a Claude Code agent to judge them, and posts the result. The result is a comment on the pull request and a check run named `ndev proof`. When `ndev proof` is a required check, a pull request that fails Proof cannot merge.

## Install Proof

Install Proof once in each repository:

```sh
ndev proof install <project-path> --dry-run
ndev proof install <project-path> --yes
```

The command writes `.github/workflows/ndev-proof.yml` and adds a `proof` section to `.ndev.json`. It finds the dev servers of the web apps in the repository and writes them to `devServers`. The [project setup guide](/guides/project-setup/#install-proof-in-a-project) gives each step. The `proof-install` skill does the install with you.

After the install, do these steps:

1. Set the `ANTHROPIC_API_KEY` secret: `gh secret set ANTHROPIC_API_KEY --repo <owner>/<repo>`.
2. Commit the workflow and `.ndev.json` in one pull request.
3. After the first run, add `ndev proof` as a required status check, in the repository settings under Rules.

## The checks

| Check | What it proves |
|---|---|
| requirements | The change meets each requirement record that it touches, and `ndev requirements verify` passes. |
| code | The code does what the pull request says, with no defect that the agent can show. |
| visual | The snapshots of the changed pages look correct at each viewport, in light and dark. The snapshots go to the `ndev-proof-assets` branch. |
| tests | Each changed source file has a test. |
| model | A complex change has a Quint model, and `ndev requirements model-check` passes. |
| docs | A change that users can see changes the docs site too. |
| lessons | The pull request body has a `## Lessons` section that states a lesson, or says that there is none and why. |

A check that fails fails Proof. A check that the plan runs and that then gets no result also fails Proof. A check that the plan skips does not fail Proof. The comment gives the reason for each skip.

## The tiers

The tier sets how deep Proof goes. `ndev proof plan` chooses the tier from the diff against the base branch.

| Tier | When | What runs |
|---|---|---|
| trivial | Fewer than 50 changed lines, with no new export, risk path, requirement record or deleted file. A change of docs only is also trivial. | No agent. Proof judges the facts only. The requirements, code and lessons checks are skipped. |
| standard | 50 changed lines or more, a new export, a touched requirement record, or a deleted file. | The agent, with a limit of 40 turns and 3 US dollars. |
| complex | 400 changed lines or more, a risk path (migrations, schema, auth, locks, workflows), or the label `proof:complex`. | The agent, with a limit of 100 turns and 10 US dollars. Only this tier runs the model check. |

Set other limits in `.ndev.json`:

```json
{
  "proof": {
    "tiers": { "small": 50, "large": 400 },
    "limits": { "standard": { "turns": 40, "budget": 3 }, "complex": { "turns": 100, "budget": 10 } }
  }
}
```

## Opt out

Proof is on by default. These settings turn it off:

| To turn off | Do this |
|---|---|
| Proof in the repository | Set `"proof": { "enabled": false }` in `.ndev.json`. |
| One check | Set the check to false, for example `"proof": { "checks": { "visual": false } }`. |
| Proof on one pull request | Add the label `no-proof`. Set a different label with `"proof": { "label": "<name>" }`. |

Proof reads these settings from the base branch, not from the pull request. A pull request cannot turn Proof off for itself. A draft pull request gets no run.

## Cost

Each run of the agent has the budget of its tier. A standard change has 3 US dollars, and a complex change has 10 US dollars. A trivial change starts no agent and costs nothing for the model. Each new push to a pull request starts a new run. The new run cancels the run that is in progress. Each run also uses GitHub Actions minutes, for up to 90 minutes.

## Run Proof on your computer

Run Proof on your branch before you push:

```sh
ndev proof run --local --base origin/main --body <file>
```

`--body` gives the text of the pull request body, for the lessons check. The local run posts nothing. It prints the table and the tier.

## Security limits

- The code of the pull request runs in the job that holds `ANTHROPIC_API_KEY` and a token with write access. The install of the dependencies, the requirement checks and the dev servers run that code. Proof removes the key and the tokens from the environment of the dev servers. Code that the pull request changes can still read the files and the memory of the job. Merge only pull requests from people that you trust to run code with your key.
- A pull request from a fork gets no run. Its code does not get the key. It gets no `ndev proof` check either, so it cannot merge while the check is required. A maintainer can push the branch to the repository to run Proof on it.
- The workflow pins ndev, Claude Code and each action to a fixed version. Run `ndev proof install` again to move the pins.
