# State and questions (F6, F6b, F7)

Part of the `work-heavy` skill.

## F6 — Continuation state and handoff

State lives in **GitHub, not in agents**. The plan in the PR body and marker comments let a new agent
resume each PR after a crash, a session end or a wait for a human. A human reads all of it too:
write it to [F2b](prose.md#f2b--writing-for-humans) and read it once for clarity.

| Marker (first line of the comment) | Meaning |
|---|---|
| `<!-- work-heavy-auto:state -->` | Continuation state on a PR (format below) |
| `<!-- work-heavy-auto:questions -->` | Blocking questions on the issue (`work-light-auto` writes `<!-- work-light-auto:questions -->`; treat both the same) |
| `<!-- work-heavy-auto:plan-confirm -->` | A non-trivial plan posted for human sign-off |
| `<!-- work-heavy-auto:revision ack:<ids> -->` | Review feedback answered; the ack ids tell the scanner it is handled |
| `<!-- work-heavy-auto:smoke -->` | A smoke report posted as a PR **review** (F4 step 5) |
| `<!-- work-heavy-auto:status -->` | Any other status comment |

**Marker rule:** an agent often posts as the **same GitHub user** as the human. The `work-heavy-auto`
skill's `pr_feedback.sh` tells agent text from human feedback only by these markers. It reads **four
surfaces**: issue comments, PR conversation comments, **review bodies** and inline review comments.
Each thing you write on those surfaces must start with a `<!-- work-heavy-auto:… -->` marker (or
`**work-heavy-auto`). This includes a **review**, which is easy to forget. Unmarked text from you is read
as human feedback on the next pass.

**The state comment:** first line exactly `<!-- work-heavy-auto:state -->`, then
`**work-heavy-auto state — <task>**` (a batched PR lists each member issue and its status), then lines
`- done:` / `- pending:` / `- assumptions:` / `- acked:` / `- attempts: <k>` /
`- next: waiting-human` (green, with the reviewer) **or** `- next: resume: <one-line pickup point>`
(anything not finished, including a failure you could not fix). Scripts read `attempts` and `next`:
keep the format exact, and add 1 to `attempts` on each resume. After **3 failed attempts** the chain
stops until a human comments or closes the PR.

### The draft exit check: do it before you report

**Before your final report, look at your PR's draft flag.** Ending a turn on a draft PR is one of
three decisions:

| Your situation | What you must do |
|---|---|
| The work is done and green | `gh pr ready <n>` (while a workflow runs, `mcp__ndev__finishedReview` has done it), **then** report. A finished PR left in draft gets no preview, no review and no attention. This is the usual failure, and it is silent. |
| The work is not finished (crash, no time, blocked) | Stay draft, and **rewrite the PR body** so that its first line is `**Draft because:** <what is left>`. Post the state comment with `- next: resume: …`. |
| You decided not to ship it | Stay draft, and **rewrite the PR body** so that its first line is `**Draft because:** <the decision, and what you measured>`. Put it in the body, not only in your report: the dispatcher's context is lost; the PR survives. |

**Never leave `WIP — plan incoming.` as the body of a PR you stopped working on.** It means "nobody
has looked at this yet", which is false on a PR that is green or parked on purpose.

**Make sure the PR still names its issue** with the `closingIssuesReferences` query from
[F1](setup.md#f1--worktree-branch-and-draft-pr). Each body rewrite above replaces the `Closes #<n>` line.

State the draft flag in your one-line report (`draft: yes — <reason>` / `draft: no`). For board
work, move the card to *In review* only when green and smoked. While a workflow runs, the plugin moves the card at `done`, when no more automated development is due. The one-line report is:
`#<n> <title> → <PR url> | tests: pass | e2e: <pass|skip> | preview: <url|n/a> | smoke: ok | wiki: <page|n/a> | docs: <page|n/a> | mergeable: yes | draft: no`.

## F6b — Act on PR review feedback (revise)

When you pick up an open PR with new human feedback, start again on the **existing branch** (F1 with
`origin/<branch>`). Do each point **test-first**: a failing test that shows the concern, then the
fix. Reply point by point in one comment under `<!-- work-heavy-auto:revision ack:<ids> -->` that lists
the comment ids you handled. The human's decision overrides your earlier plan. If the feedback makes
the plan wrong, rewrite the PR body too. Then do the verify loop (F4) again. Think again; do not
patch. A resume with feedback is never trivial.

## F7 — Questions

- **Under a workflow with interactive steering**, the state `interviewing` asks the questions that come before the plan. The `interview` skill has the method, and the answers are in the `.neil-dev.issue-*.json` files. Use the points below for a question that comes later.
- **Write the question clearly:** the decision, the options and the issue numbers. Keep it short so
  the reader can answer quickly.
- **Attended** (a user or dispatcher can answer): on a real blocking ambiguity (scope, a product
  decision, a choice between equally good designs), stop and ask. A subagent returns
  `QUESTIONS: <list>` and is resumed with SendMessage and the answers. Put all questions in one batch.
- **Unattended** (loop, cron, background): **never wait for a human**. At each point that needs a
  human, write the continuation state to GitHub (F6) and stop; the next pass resumes. For a small
  ambiguity, make the most reasonable assumption, record it under **Assumptions** in the plan, and
  continue. Only when the task is impossible without an answer: post the questions as an issue
  comment under the questions marker, move the card to *Awaiting Feedback*
  (`ndev github board move <itemId> awaiting`; while a workflow runs, `blocked` moves it), and report `PARKED`. A non-trivial plan that needs sign-off
  parks the same way under `<!-- work-heavy-auto:plan-confirm -->`, unless sign-off was waived.
- Answers already in the thread are authoritative, also short ones. Do not ask again.
- **A card moved back to *Ready* is the answer. Silence means nothing.** The human approves by moving
  the card out of *Awaiting Feedback*, usually with no comment. A Ready card that still has a
  `plan-confirm` or `questions` marker is *approved*: do the work, do not post the questions again,
  do not ask for sign-off again, and never report it blocked "awaiting a decision". Never park the
  same issue twice. Never move a card out of Ready to match what an agent reported: that cancels a
  human decision. Where a question had no answer, take the most reasonable option, record it under
  **Assumptions**, and say so in the PR body. The two columns hold the whole protocol: *needs a human*
  → **Awaiting Feedback**; *in Ready* → **do it**.
