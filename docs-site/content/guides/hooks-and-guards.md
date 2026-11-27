---
title: Hooks, watcher and chat guard
description: How ndev forwards native harness events to the CLI, watches PR checks in Orca and protects idle native chats.
---

# Hooks, watcher and chat guard

Harness hooks forward native lifecycle events to `ndev hook <event>`. Every harness calls the same shared CLI handlers and receives responses formatted in its own native wire protocol.

## Native hook event map

| ndev event | Duties | Claude Code | Codex | opencode |
| --- | --- | --- | --- | --- |
| `session-start` | Bind the session, copy missing linked-worktree settings and credentials, provide issue guidance and start or reuse the watcher. | `SessionStart` | `SessionStart` | `session.created` and first context hook on resume |
| `prompt-submit` | Reload setup when needed and detect corrections. | `UserPromptSubmit` | `UserPromptSubmit` | Session prompt hook |
| `prompt-context` | Inject mode, steering, branding, repo, wiki, workflow and epic context. | `UserPromptSubmit`, plus `SessionStart` on startup/resume/compact | `UserPromptSubmit` and `SessionStart` on `compact` | Session context hook |
| `pre-tool-use` | Enforce walk-doc limits and the shell Git guard before quality checks. | `PreToolUse` | `PreToolUse` | Tool execute before |
| `post-tool-use` | Report check hints, review component changes, flag pushes for learning and refresh panels. | `PostToolUse` | `PostToolUse` | Tool execute after |
| `turn-start` | Record activity and distinguish human answers from watcher prompts. | `UserPromptSubmit` and tool activity | `UserPromptSubmit` and model activity | Session execution start |
| `turn-complete` | Record idle state, clear dead waits and service walk-doc and the PR queue. | `Stop`, `SubagentStop` | `Stop`, `SubagentStop` | Session execution end |
| `session-end` | Stop walk resources, apply worktree stop policy and release ownership. | `SessionEnd` | `SessionEnd` | Session close or delete |
| `compact` | Mark skill context for reload after compaction. | `PostCompact` or `SessionStart` (`compact`) | `PostCompact` | Session compaction events |

When `pre-tool-use` blocks a direct `git commit` or `git push` during an active workflow, the denial tells the agent to run `ndev flow checkpoint` instead.

## The Orca watcher (`ndev watch`)

`ndev` runs one watcher per Orca session and worktree in an Orca terminal titled `ndev-watch`:

```sh
ndev watch --once
```

The watcher performs four recurring checks:

1. **Pull request checks.** Reads the PR head SHA and check results every 3 minutes by default, sends each failure or completion fingerprint once, and names failed or stuck checks.
2. **Idle and early turn-end nudges.** Detects a main turn that ends without advancing the workflow or an idle session with no active wait (default: 1 idle nudge after 20 minutes or 3 early turn-end nudges). Suppresses reminders when blocked or turned off.
3. **Done-PR revisit.** Checks open PRs of `done` workflows via `ndev flow revisit` and returns the workflow to `revising` on new unanswered feedback or merge conflicts. Stops watching once the PR merges or closes.
4. **Background queues.** Services stored `triage` and `fix-prs` schedules using their own wait, backoff and retry state.

## Native Orca chat guard (`ndev chat-guard`)

The native chat guard protects local Codex and Claude Code native Orca chats from expensive sends after long idle periods. It is **off by default** and enabled per project in `.ndev.json` (`"chatGuard": true`).

```sh
ndev chat-guard on
ndev chat-guard status
ndev chat-guard off
```

When enabled, the prompt hook blocks a send after **more than 50 minutes of inactivity** and stores the blocked message locally for that chat. Reply with one of three actions:

| Reply | Result |
| --- | --- |
| `continue` | Passes the saved request into the current chat once without compaction and keeps the guard enabled. |
| `hand-off` | Starts a new Orca chat in the same workspace with up to three recent assistant excerpts plus the saved message. |
| `new-session` | Starts a new Orca chat with only the saved message. |

To compact the existing chat first, run `/compact`, wait for compaction to finish, and resend the message.
