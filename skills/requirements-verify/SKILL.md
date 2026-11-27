---
name: requirements-verify
description: "Verify that the code meets a requirement record at a commit: link its tests, have a fresh agent look for a counter-example, record its verdict, and get the state violated, stale, unverified or verified. Use when verify fails or says stale, before a pull request that touches a requirement, or when the user says verify the requirement, judge REQ, verify-brief, verify-judge or requirement verification."
---

# Verify the requirements

The records are in `${CLAUDE_PLUGIN_ROOT}/kb/requirements.md`. Read the section "Verification" first. The verification file, the states and the rules are there.

The commands are `ndev requirements <command>`. Run them from the project.

| Command | What it does |
|---|---|
| `ndev requirements verify-brief <REQ-NNNN>` | Prints what the judge gets: the Statement, the commit, the linked files and the checks. |
| `ndev requirements verify-judge <REQ-NNNN> --commit <sha> --verdict <v> --by "<who>" --evidence <file> [--base <ref>] [--overrule "<reason>"]` | Records the verdict, `no-counter-example` or `counter-example`. `--overrule` records that a human rejects a current counter-example. |
| `ndev requirements verify (<REQ-NNNN>... \| --all \| --base <git ref>) [--report <file>]` | Gives each requirement its state at the last commit. |

## Prepare

1. Choose the requirements. For a change, run `ndev requirements verify --base origin/main` and read each state and reason.
2. Check that the record links the code that implements it (`ndev requirements file`) and each model (`ndev requirements model`).
3. Write `docs/formal/verification/<REQ-NNNN>.json` with `requirement` and `checks`. Link tests that fail when the requirement is broken. Make `proof` match a count of tests above zero. Never write `judgement`.
4. **Commit** the verification file, the record and each linked file. The brief and the judgement are about a commit.
5. **Do not make a requirement pass by making a link weaker.** Do not remove a `- File:` line, a model or a check to get a better state.

## Judge with a fresh agent

Do not judge the requirement yourself. You know how the code was written, so you read it as you meant it.

1. Run `ndev requirements verify-brief <REQ-NNNN>`.
2. Start a **fresh agent** for this one requirement. Do not use an agent that worked on the change, and do not fork your own context.
3. Give it **only the brief**, read access to the linked files at the commit of the brief, and the task below. Do not give it the diff, the history, the pull request, the author's reasoning, your own opinion, the other notes of the record or an earlier verdict. It does not read `docs/formal/verification/`.

> Look for a counter-example: an input, a state or an order of events in which the code in the linked files does not do what the Statement says. Read only the linked files. Do not change a file. Answer `counter-example` with the exact case and the lines that cause it, or `no-counter-example` with each case that you tried, what you read, and what you could not judge from these files.

4. When the agent says that the linked files are not enough to judge, correct the links, commit, and start again with a new agent. That is not a `no-counter-example`.
5. Save its answer to a file outside the project, in its own words. Do not shorten it and do not change its verdict.

## Record and verify

1. Run `ndev requirements verify-judge <REQ-NNNN> --commit <sha of the brief> --verdict <its verdict> --by "<the agent and its model>" --evidence <file>`.
2. When it says that covered content differs, get a new brief and use a new agent.
3. Commit the verification file.
4. Run `ndev requirements verify <REQ-NNNN>`. Correct each reason that it gives.

## A counter-example

Read the case against the code. Report it to the human with the lines. When the code is wrong, write a test that fails for the case, correct the code, and link the test. When the Statement is wrong or not clear, ask the human: only a human agrees to a change of a Statement. **Do not ask a second agent for another opinion on unchanged content** to replace a `counter-example`. While nothing that it covers has changed, `verify-judge` refuses `no-counter-example`. In a pull request, give `verify-judge` the same `--base <ref>` as `verify`, so that it also reads the counter-example at the merge base. Change the code, or ask the human about the requirement. Only a human can reject the counter-example. Then judge again with a fresh agent, and record its answer with `--base <ref> --overrule "<the reason of the human>"`. Do not remove the `judgement` key or edit it: `verify --base` still finds the counter-example at the merge base.

## Finish

Report each requirement with its state, the commit, the checks and models that ran, and who judged it. Say what the judge could not judge. **A judgement is an opinion of an agent with its evidence, not a proof.** A check proves only what its test does, and a model check is a bounded search. To add the check to CI, follow "Add verification to CI" in the format page.

The installer resolves `${CLAUDE_PLUGIN_ROOT}` to the shared ndev release folder for each harness. Use the installed absolute paths to run shared scripts.

## The workflow

While a workflow runs, this skill is one step of the current stage. Read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
