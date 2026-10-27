# Agents

Subagent definitions for the Ready-board and issue workflows. Skills hold the method; agents set the model, tools, isolation and preloaded skills for one role.

| Agent | Role | Model / effort | Tools | Isolation | Preloads |
|---|---|---|---|---|---|
| `board-survey` | Read-only survey of the Ready column; JSON queue | sonnet / low | Read, Grep, Glob, Bash | none | github |
| `work-heavy-auto-orchestrator` | Main-session runner for `work-light-auto`; dispatches per unit | inherit / high | all | none | work, github |
| `issue-implementer` | One issue from card to PR in In review | opus / high | all | own named worktree | work, mattpocock-skills:tdd, github, docs |
| `plan-scout` | Read-only plan with a `Test entry point:` line | opus / high | Read, Grep, Glob, Bash | none | work, docs |
| `tdd-implementer` | One plan task, test-first, on the caller's branch | sonnet / medium | all except Agent | none (shares the branch) | mattpocock-skills:tdd, mattpocock-skills:diagnosing-bugs |
| `diff-reviewer` | Read-only review of a diff | opus / high | Read, Grep, Glob, Bash | none | mattpocock-skills:code-review |
| `dev-task` | A self-contained task finished as a PR | opus / high | all | `worktree` | work-light, mattpocock-skills:tdd |

## How they fit

`work-heavy-auto-orchestrator` → `board-survey` → one `issue-implementer` per unit → `plan-scout`, `tdd-implementer` (one per task) and `diff-reviewer`.

`dev-task` stands alone: `claude --agent dev-task "<task>"`.

## Rules for every agent

- PR-only. Never push the default branch. Never merge. A human merges.
- One PR per unit. A related discovery is a sub-issue carried in the same PR (`Carried by #<pr>`).
- Find the repository with `gh repo view --json nameWithOwner -q .nameWithOwner`. Take the board from `GH_PROJECT_OWNER` and `GH_PROJECT_NUMBER`. Stop and name what to set when they are missing.
- Every commit carries the commit trailer that the repository or session requires.
- Use `GH_USE_KEYRING=1` when the ambient `GITHUB_TOKEN` lacks the `project` scope.
- Only an agent that must keep its branch across runs (`issue-implementer`) manages its own worktree. `tdd-implementer` shares the caller's branch, so it has no isolation.

## Adding an agent

Put the file in this folder with `name`, a quoted `description` that says when to use it, and the smallest tool set the role needs. Preload only skills that exist in this plugin or in `mattpocock-skills`.
