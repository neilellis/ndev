---
name: second-opinion
description: "Get an independent second opinion on a design, plan or piece of code from another agent, usually Codex, through Orca orchestration. The agent and its model follow the quota that Orca reports; with too little quota left, no agent is asked. Use before a consequential design decision, when two designs compete, or when the user says \"second opinion\", \"ask Codex\" or \"sanity-check this design\"."
---

# Second opinion

**Another agent judges the question from the code, and the quota decides who that agent is.** A second opinion from another model family finds what the author's own review does not. It costs quota that the agents also need for their own work, so the helper reads each provider's quota from Orca first. It picks the agent and the model from that, or it asks nobody.

The helper is `scripts/second-opinion.mjs` in this skill's folder. Call it with `node`. It uses only the `orca` CLI.

## When to ask

- Before a design decision that is hard to change later: an interface, a data model, a schema, a migration path, a user journey.
- When two designs compete and the evidence does not choose between them.
- When the user asks for a second opinion.

Do not ask about a decision that a test, the code or the user already settles. Do not ask again about the same question with the same evidence.

## Run it

1. Write the question so that a reader with no context can answer it: the decision, the options, the constraints and what you prefer and why. Name the files that matter with `--context`.
2. Check the choice, which costs no quota:

   ```sh
   node ${CLAUDE_PLUGIN_ROOT}/skills/second-opinion/scripts/second-opinion.mjs quota
   ```

3. Ask. The call blocks until the report comes back, up to `--timeout-min` (default 30). From Claude Code, run it with `run_in_background` and wait for the notice.

   ```sh
   node ${CLAUDE_PLUGIN_ROOT}/skills/second-opinion/scripts/second-opinion.mjs ask --kind design \
     --question-file <question.md> --context <path> --context <path>
   ```

   `--kind` is `design` (the default), `plan`, `code` or `general`. `--dry-run` prints the choice and the worker's Task spec, and starts nothing.

From the command line, a person runs the same commands, or types `/second-opinion <question>` in Claude Code. For that slash command, write the question to a file with the context that the session has, then run step 3.

## How the agent is chosen

Headroom is the percent left in a provider's fullest window: the session (5-hour), weekly or monthly window, whichever has the least left. The helper keeps a reserve of 15% for the agents' own work (`--min-headroom <n>` changes it).

| Headroom | Codex (asked first) | Claude (asked when Codex is below the reserve) |
|---|---|---|
| 60% or more | `gpt-6-astra`, effort `high` (`xhigh` for design and plan) | `opus`, effort `high` (`xhigh` for design and plan) |
| 30% to 59% | `gpt-6.1-sol`, effort `high` | `sonnet`, effort `high` |
| above the reserve, below 30% | `gpt-6.1-sol`, effort `medium` | `sonnet`, effort `medium` |
| at or below the reserve | not asked | not asked |

`--agent codex` or `--agent claude` limits the choice. Repeat `--agent` to give your own order. A Claude session that asks Claude spends its own quota: prefer Codex.

## What the worker does

The helper creates one Orca Run for the question and starts one supervised worker with `orca orchestration worker-start` in the current worktree. The Task spec tells the worker:

- to read the code that the question concerns, and not to trust the question's account of it;
- to edit, create or delete no file except its report file, and not to commit, push, install or start agents;
- not to ask questions, but to state each assumption;
- to write `## Verdict`, `## Reasons`, `## Risks`, `## What I would do instead` and `## Confidence`, then send `worker_done`.

The helper answers any question from the worker with "state your assumption", and an escalation with "finish the report without help". After three empty waits it reads Orca's liveness verdict for the worker. If the worker exited without `worker_done`, the helper stops with Orca's next action. It prints only the report file that it named, and then releases the worker's terminal. If the caller's terminal was coordinating another Run, the helper binds that Run again.

## Results

| Exit | Meaning | What to do |
|---|---|---|
| 0 | The opinion is printed and saved. | Weigh it. Record what you accept, what you reject and why, in the plan or the PR. Do not adopt it without checking it against the code. |
| 1 | Failed. The message names the cause and the repair. | Fix what it names, or report that no second opinion was given. |
| 2 | Usage error. | Correct the command. |
| 3 | Skipped: no agent has quota to spare. The message gives each agent's headroom and reset time. | Go on without a second opinion and say so. Do not lower the reserve to force one unless the user asks. |
| 4 | Still waiting, or Orca could not say whether the worker started. The worker may run on. | Run the `wait` or `worker-list` command that the message prints. Never start a second worker for the same question. |

When Orca cannot read the usage of any agent that `ask` considers, `ask` exits 1, not 3: an agent that is signed out is a fault to repair, not a lack of quota.

A start can stop at a prompt in the agent's own start-up screen, for example Codex's "Hooks need review". The helper shows that screen and releases the dead terminal. Trusting hooks is the user's decision: tell the user, and never answer that prompt for them.

## Limits

- The helper needs the Orca app or `orca serve` running. `orca status` checks it.
- Model ids are in the tier table in `scripts/second-opinion-lib.mjs`. When a provider retires a model, change the table and its tests.
- The report file is outside the worktree by default (`$TMPDIR/ndev-second-opinion`). An agent whose sandbox or permission settings stop writes there stops at a prompt, and the liveness check cannot see that. If a worker does not finish, read its screen with the `worker-read` command in the message. Then set `--out` (or `SECOND_OPINION_DIR`) to a git-ignored path in the worktree.
- `--out` must name a new file, so an old opinion never stands in for a new one.
- Tests: `node --test scripts/tests/*.test.mjs` in this skill's folder. They use a stand-in for `orca`.

## The workflow

Give an opinion that is part of the review stage to `mcp__ndev__finishedReview` in `review`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
