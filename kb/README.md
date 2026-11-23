# Knowledge base — the development method

This knowledge base holds the development method that the plugin's skills and agents apply. Each page states a rule, the reason for it, and how to apply it in any repository. The pages are project-neutral. A project records its own paths and commands in its own `CLAUDE.md` (start from [the template](../templates/CLAUDE.md)).

## Read order

1. [core-beliefs.md](core-beliefs.md) — the rules that you must not break. Read this first, always.
2. [agent-collaboration.md](agent-collaboration.md) — one owner, small helpers, briefs, review, the finish loop, token use.
3. [failure-handling.md](failure-handling.md) — fail fast, and record every failure.
4. [testing.md](testing.md) — the test taxonomy, how tests lie, where a test lives.
5. [guards.md](guards.md) — how to design a guard that can fail and can pass.
6. [verification-policy.md](verification-policy.md) — verify against what the change touches, not its description.
7. [precheck-and-push.md](precheck-and-push.md) — the local gates and the pre-push hook.
8. [git-and-worktrees.md](git-and-worktrees.md) — worktrees, branches, Orca.
9. [ci.md](ci.md) — what CI proves, what it does not, and what it costs.
10. [writing.md](writing.md) — the house style for every text you write.
11. The remaining pages, when the task touches their subject.

## The pages

| Page | What it holds |
|---|---|
| [core-beliefs.md](core-beliefs.md) | Eleven rules, each with its reason and how to apply it. |
| [agent-collaboration.md](agent-collaboration.md) | One owner, helpers and briefs, independent review, the finish loop, skill upkeep with `LEARNED.md`, token use, harness sync. |
| [failure-handling.md](failure-handling.md) | The failure contract: stop, fail the run, recovery is a design choice, log every failure. Handler outcomes and levels. |
| [testing.md](testing.md) | Test first, the test taxonomy, the ways a test passes without proof, where each test lives, live tests, browser checks. |
| [guards.md](guards.md) | Guard design, "never in a position to fail", hollow gates, the guard pathology catalogue, edited-file guards, shell guards. |
| [verification-policy.md](verification-policy.md) | Verify against what the change touches: list entry points and siblings, close plan rows on evidence, adversarial review. |
| [libraries.md](libraries.md) | The approved libraries. The `iNeedA` tool reads this page. |
| [workflow.md](workflow.md) | The workflow tools: the state machine and its flow chart, stage hooks, checks, project levels, the heartbeat. Shown by `/flow guide`. |
| [north-star.md](north-star.md) | When to read the project's `NORTH_STAR.md` and how to verify work against it. |
| [precheck-and-push.md](precheck-and-push.md) | The precheck script, the pre-push hook, the shared hook dispatcher, the checked push. |
| [git-and-worktrees.md](git-and-worktrees.md) | One worktree per unit of work, the shared main checkout, branch rules, `git mv` and `git rm`, Orca. |
| [ci.md](ci.md) | The gates and what each proves, proof that each test ran, local gate versus CI, diff scoping, main health, cost, preview and deploy gates, self-hosted runners. |
| [logging.md](logging.md) | The level ladder, the healthy ratio, the write rules, the logging guard. |
| [type-safety.md](type-safety.md) | Every rule at zero, one command, typed JSON boundaries, the traps. |
| [comments.md](comments.md) | No comments in code by default; the one exception, and the deletion test. |
| [architecture.md](architecture.md) | Layering, transaction size, sessions across network calls. |
| [local-dev.md](local-dev.md) | The local stack refuses to start half-configured; run commands from the tree you test. |
| [deployment.md](deployment.md) | Vercel lessons: production and previews, migrations versus merges, a build that fails closed, checks before a release tag. |
| [issue-tracking.md](issue-tracking.md) | Board columns, issues and sub-issues, PR conventions. |
| [llm-wiki.md](llm-wiki.md) | The LLM-wiki method: sections, the routing test, ingest, query, lint, the `.log/` folder. |
| [docs-screenshots.md](docs-screenshots.md) | Project screenshot manifests, capture commands, freshness receipts and docs build checks. |
| [adr.md](adr.md) | Architecture decision records, and the rules that ADRs and PDRs share: human approval, numbering, supersession, search, the template. |
| [pdr.md](pdr.md) | Product decision records: amendments to scope and requirements, who decides, the template. |
| [ui-components.md](ui-components.md) | The approved UI component sources, the map from each component type to one registry item, and the uniformity rules. |
| [writing.md](writing.md) | ASD-STE100 house style, instructions that work as written, the readability check. |
| [hooks/README.md](hooks/README.md) | Reusable hook scripts and how to wire them in. |

## Templates

- [templates/CLAUDE.md](../templates/CLAUDE.md) — a starter project `CLAUDE.md` that adopts this plugin.
- [templates/wiki/](../templates/wiki/wiki.md) — a minimal LLM-wiki skeleton.

## How to change this knowledge base

- Write the present state only. Git holds the history ([core-beliefs.md](core-beliefs.md#11-forget-history)).
- Keep each page project-neutral. Put a project fact in that project's wiki.
- Use an example only when it teaches the rule.
- Follow [writing.md](writing.md).
