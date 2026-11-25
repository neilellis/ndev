# <project name>

<!-- Starter CLAUDE.md for a project that adopts the ndev plugin.
     Replace every <placeholder>. Keep the core beliefs short: the plugin's kb holds the detail.
     Write in Simple English (kb/writing.md). Keep AGENTS.md the same as this file, or make it point here. -->

<One sentence: what this project is and who uses it.>

## Core beliefs

These rules come from the plugin. Each line links to its full page. You must not break them.

1. **Fail fast, and record every failure.** No fallback, default or silent skip unless the specification names it. A refusal names the identifier, the detail and the repair. → `kb/core-beliefs.md`, `kb/failure-handling.md`
2. **Test first, and prove guards in both directions.** See the test fail for the intended reason, then fix. → `kb/testing.md`, `kb/guards.md`, skill `testing`
3. **Wait without polling.** One blocking wait helper, then read the result. An ended process is not a pass. → `scripts/wait-for-process-end.sh`
4. **Pull and pass the guards before a push.** Push only with `scripts/push-checked.sh`. Never use `--no-verify`. → `kb/precheck-and-push.md`
5. **Never silence a rule.** Fix it, or add a narrow inline ignore with the reason on the same line. → `kb/type-safety.md`
6. **Make a repeated script permanent.** The second copy goes in `scripts/`, with a test. Skills hold instructions only.
7. **Never spend the subscription.** No `claude -p` without the user's explicit permission for that run.
8. **Never overclaim.** Give numbers with their scope. Report passed, failed, skipped and not run separately, in a comment on the PR.
9. **Worktree and PR only.** Never commit to `<main branch>`. One PR per unit of work. A human merges. Use Orca for worktrees and handoffs. → `kb/git-and-worktrees.md`
10. **Simple English.** ASD-STE100, British spelling, the answer first. → `kb/writing.md`, skill `simple-english`
11. **Forget history.** Documents and code describe the present. Use the `forget` skill when a fact stops being true.

## Skills to use

| When | Skill |
|---|---|
| Any change from issue to PR | `work-light`, which starts the workflow with `mcp__ndev__started` |
| A pattern over the code (search, guard, refactor) | `ast-grep` |
| Writing or updating the project wiki or docs | `docs` |
| Writing or fixing tests | `testing` |
| Reviewing or checking a result before you report it | `r` |
| Removing a fact that is no longer true | `forget` |
| The user asks for short, focused, one-step output | `i-have-adhd` |
| Work through the board's Ready column | `work-heavy-auto`, `work-light-auto` |
| One issue, end to end | `work-heavy` |
| A red CI run | `fix-ci` |
| Is the work finished? | `are-we-done` |
| Keep Claude and Codex rules in step | `harness-sync` |
| Lint the project wiki | `wiki-lint`, `dev-wiki` |
| Resolve a merge conflict | `resolving-merge-conflicts` |
| Write or change HTML, CSS or client-side JavaScript | `modern-web-guidance` |

## Commands

```bash
<install command>
<dev command>
<test command>           # the unit lane, the same script CI runs
<type-check command>     # every rule at zero
./scripts/precheck.sh --base origin/<main branch>   # recommended before a push
bash scripts/push-checked.sh -u origin HEAD          # the only way to push
```

## Where the detail lives

| Subject | Where |
|---|---|
| Project wiki (start here) | `docs/wiki/wiki.md` |
| Architecture and layers | `<docs/wiki/dev/architecture.md>` |
| Testing lanes and guards | `<docs/wiki/dev/testing/testing.md>` |
| CI workflows and gates | `<docs/wiki/dev/ci/ci.md>` |
| Deployment | `<docs/wiki/dev/deployment.md>` |
| Design decisions (ADRs) | `<docs/adr/>` |
| Requirement amendments (PDRs) | `<docs/pdr/>` |
| Issue tracker and board | `<docs/agents/issue-tracker.md>` |
| The general method | the plugin's `kb/README.md` |

## Starting points

| If the task is about | Start in |
|---|---|
| <area 1> | `<path>` |
| <area 2> | `<path>` |
| <area 3> | `<path>` |
| A failing CI run | `gh pr checks <pr>`, then `gh run view <run> --log-failed` |
| A failing push | the log path that the pre-push hook prints |

## Project rules

<!-- Rules that apply to this project only. Keep each to one line, and link to the wiki page that explains it. -->

- <rule> → `<wiki page>`
- **Browser support:** <for example: Baseline Widely available features with no fallback; Newly available features with feature detection and a fallback of at most 20 lines and no new dependency>. `modern-web-guidance` reads this line.
