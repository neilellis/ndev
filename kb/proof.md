# Proof — the check of a pull request before merge

Proof is a GitHub Actions job that checks each pull request and gates the merge. This page tells an agent what Proof expects from a pull request, and how to run Proof before a push. The user guide is `docs-site/content/guides/proof.md`.

## What Proof checks

| Check | The pull request passes when |
|---|---|
| requirements | It meets each requirement record that it touches, and `ndev requirements verify` passes. |
| code | The code does what the body says, and the agent finds no defect that it can show. |
| visual | The snapshots of the changed pages look correct at each viewport and in each scheme. |
| tests | Each changed source file has a test in the same folder, or a test with the same name. |
| model | A complex change has a Quint model, and `ndev requirements model-check` passes. |
| docs | A change that users can see changes the docs site too. |
| lessons | The body has a `## Lessons` section, and the agent finds that it states a lesson, or says that there is none and why. |

A check that fails fails Proof. A check that the plan runs and that then gets no result (`not-run`) also fails Proof. `ndev proof plan --base <ref>` shows the tier and each check that runs, with no agent and no cost.

## Write the Lessons section

Put a `## Lessons` section in each pull request body. State what the work taught that the next person needs: a cause that was not obvious, a guard that lied, a rule that you found. Give the evidence, as the [dev-wiki skill](../skills/dev-wiki/SKILL.md) says for a lesson. When there is no lesson, say so in one line and give the reason, for example "None: a one-line fix with a known cause." An empty section fails the check.

## Run Proof before the push

```sh
ndev proof run --local --base origin/<base branch> --body <file with the pull request body>
```

Run it after the last change and before the push. Read the table. Fix each check that fails, then run it again. A check that is `not-run` is not a pass: the result says what to install or set. The local run posts nothing.

## Rules

- Never add the opt-out label (`no-proof` by default) or turn off a check to make Proof pass. Only a human opts out.
- Proof reads its settings from the base branch. A change to `proof` in `.ndev.json` takes effect after it merges.
- The judging agent follows `skills/proof/SKILL.md`. Do not edit the verdict or the plan by hand.
