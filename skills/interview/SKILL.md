---
name: interview
description: "Settle the decisions of an issue with the human before the plan or the code. Use in the workflow state interviewing, when the answer of mcp__ndev__started says to load this skill. Shows rounds of questions in the plugin's interview pane through mcp__ndev__interview."
---

# Interview

Reach a shared understanding with the human before you plan or write code. Ask only about decisions that are the human's to make.

`mcp__ndev__interview(interviewJson)` shows one round in the interview pane and holds until the human answers. `mcp__ndev__interview()` with no arguments ends the interview. Only that call leaves the state `interviewing`.

## Read first

1. Read each `.neil-dev.issue-*.json` file at the root of the worktree. Each file holds the questions and answers of one issue in `rounds` and `draft`, beside its workflow state, which is not an answer: read only those keys, with `jq '{issue, rounds, draft}'`. A parent's files come to a worker that `followUp` started.
2. Read the issue and the code that it names.
3. Do not ask again what these files answer. List those answers in the `intro` of the first round, each with its source issue, so that the human can correct one.

A parent can say in the brief that a worker asks nothing. Then call `interview()` with no arguments.

## Facts and decisions

Find each fact yourself, with a sub-agent when the search is long. Never ask the human for a fact that the files, the tools or the code can give. Each decision is the human's: put it in a round and wait.

## Light mode

Ask few questions, and only pertinent ones. The tool takes no more than 5 first questions and 5 follow-ups for each issue, across all rounds. When nothing is open, call `interview()` with no questions. You do not need to give a reason.

## Heavy mode

Ask until no decision is open. There is no limit on questions.

1. Map the work as a design tree: each decision branches into the decisions that depend on it.
2. The frontier is each decision whose prerequisites are settled. Ask the whole frontier in one round.
3. A question that depends on another open question in this round goes in a later round.
4. Each answer changes the tree. Find the new frontier, and ask the next round.
5. Stop when the frontier is empty, with no branch left unvisited and nothing silently assumed.
6. The last round states the shared understanding and asks the human to confirm it. Do not act until the human confirms it.

A heavy issue with no answered round cannot leave by itself, unless `followUp` started its worker. Only a human can skip the interview, with `/flow skip <reason>`.

## Write a round

```json
{
  "title": "Session storage",
  "intro": "From #3: sessions stay on the server.",
  "questions": [
    {
      "id": "store",
      "header": "Session store",
      "question": "Where do **sessions** live?",
      "context": "The API runs on three hosts.",
      "options": [
        { "label": "Redis", "description": "Shared by all hosts.", "recommended": true },
        { "label": "Cookie", "description": "No server state.", "preview": "`Set-Cookie: s=...`" }
      ]
    },
    {
      "id": "ttl",
      "header": "Lifetime",
      "question": "How long does a session last?",
      "followUpTo": "store",
      "suggested": "24 hours"
    }
  ]
}
```

- Give each question a recommendation: an option with `recommended: true`, or `suggested` when it has no options. Word the question so that accepting your recommendation is a full answer.
- Keep each `id` unique across all rounds of the issue. Keep `header` short.
- Use `multiSelect: true` when more than one option can apply.
- Markdown works in `question`, `context`, `description` and `preview`.
- Set `followUpTo` to the earlier question that this one follows. The pane labels the follow-up and shows the answer that it follows. The earlier question can be in this round or in an earlier one.

## Read the answer

The first line of the answer is JSON. Each entry of `answers` has `id` and `selected`, and it can have `other`, `notes` and `source`. `source` is `recommended` when the human did not change your recommendation. Read the notes, because they can change the decision.

| The result | What it means | What you do |
|---|---|---|
| No extra key | The human answered the round. | Find the new frontier. Ask again, or call `interview()`. |
| `trustMeBro: true` | The human accepts your recommendations and wants no more questions. | State each remaining decision as an assumption, then call `interview()`. |
| `dismissed: true` | The human closed the round for now. The answers so far are saved, and `notAnswered` lists the other questions. | Ask again later, or call `mcp__ndev__blocked` with what you need. |

The answers go to the file, to one comment on the issue and to one comment on the PR. If GitHub fails, the tool gives you the failed command and its output. Repair the cause and call `interview()`. It refuses until both comments are posted.

## When no human can answer

Under auto steering, the state does not ask, and a round refuses. If you run with no human and the steering is interactive, call `mcp__ndev__setSteering({ steering: "auto", reason })`. The tool puts the reason on the issue and on the PR and tells the human. You cannot change back. Never use it to avoid a question that a human can answer.

The method of the design tree and the frontier is adapted from the grilling skill by Matt Pocock (MIT licence, copyright 2026 Matt Pocock).
