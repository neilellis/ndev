---
name: harness-sync
description: "Compare the Claude and Codex harness trees and reconcile a difference between them, before or after any change that copies one skill tree onto the other."
disable-model-invocation: true
---

# Keep the two harness trees in agreement

In a repository that serves both harnesses, Claude reads `.claude/`, and Codex reads `.agents/` and `.codex/`. Some facts live in a different file in each tree, and **neither harness reads the other notation**.

| Fact | Claude reads | Codex reads |
|---|---|---|
| skill body | `.claude/skills/<skill>/SKILL.md` | `.agents/skills/<skill>/SKILL.md` |
| refuse implicit invocation | `disable-model-invocation: true` in the frontmatter | `agents/openai.yaml`, `policy.allow_implicit_invocation: false` |
| agent definitions | `.claude/agents/<name>.md` | `.codex/agents/<name>.toml` |
| hook wiring | `.claude/settings.json` | `.codex/hooks.json` |
| repository rules | `CLAUDE.md` | `AGENTS.md` |

Run `scripts/check.py` in this skill's folder before and after any change that copies one tree onto the other:

```bash
python3 <this skill>/scripts/check.py [REPO]     # REPO defaults to the git top level
```

| Exit | Meaning |
|---|---|
| 0 | The trees agree. |
| 1 | Differences. Each line names the file to edit. |
| 2 | Could not compare: a skill tree is missing or empty, or an agent tree is an unfetched submodule. Never a pass. |

The script compares:

- the skill names in the two trees,
- the invocation policy in the two notations,
- the agent definitions (no agent tree on either side is agreement; one side only is a difference),
- the skill names in backticks in `CLAUDE.md` and `AGENTS.md` (a `CLAUDE.md` that is the line `@AGENTS.md` agrees),
- Codex policy files inside the Claude tree, which nothing reads.

If an agent tree is a git submodule with no files, the script stops with exit 2 and prints the `git submodule update --init` command. An empty submodule is a tree that nobody fetched, not a difference. A comparison against it would name every agent on the other side.

Its tests are `scripts/test_check.py` (`python3 -m unittest test_check` from that folder).

## Decide each difference

Never copy a file from one tree to the other to make the report clean. The notations differ, so a copy puts the source notation where the other harness cannot read it. That is the defect this skill finds.

- **A skill in one tree only.** Add it to the other tree, or record why it belongs to one harness. Both are valid answers.
- **A policy in one notation only.** Write the other notation. The table gives the key and the file.
- **A policy in neither notation.** That is the default, and the default allows implicit invocation. Confirm that the skill is safe to fire unasked. A skill that opens a pull request, publishes a release or deletes rows is not.
- **A Codex policy file inside `.claude/skills/`.** Claude reads no `agents/openai.yaml`. A second copy of a fact goes stale in silence, so remove it or explain why it stays.
- **A skill named in one instruction file only.** The other harness cannot see it. Add the same sentence to both files, or make `CLAUDE.md` import `AGENTS.md`.

## Executables are shared, never copied

Keep a skill's scripts in one place that both harnesses call, for example a top-level `scripts/<skill>/`. A copy in each tree drifts.

## The report alone does not protect the trees

A difference shows up as a test failure only when a test compares the two notations. When you add a fact that each harness stores differently, add its comparison to the project's checks and pin it with a guard. A fact that only this script checks is a fact that a push can carry away.

## The workflow

While a workflow runs, this skill is one step of the current stage. Commit each file that it changes with `mcp__ndev__checkpoint`, and read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
