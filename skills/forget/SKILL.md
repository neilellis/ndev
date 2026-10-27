---
name: forget
description: "Remove documentation and memory claims that code proves false after a feature, path, decision or command is removed, renamed or superseded."
---

# Remove stale knowledge

Use with an explicit fact (`$ARGUMENTS`). If there is none, ask what became false. Use this skill when documented text contradicts the code, and after you remove, rename or deprecate behaviour.

The project's wiki holds current state only (the plugin's `kb/llm-wiki.md`). A fact that is no longer true must leave every home, not only the one you found.

## 1. Prove the premise

First prove that the fact is gone. Any one of these is proof:

- the fact is gone from the default branch,
- the pull request that removed it is merged,
- a migration or a run shows the new state,
- the maintainer confirmed it.

"Looks old" is not proof. Decide if the claim is false, or only true in a narrower scope. Narrow it when you can.

## 2. Sweep every home

Run `scripts/sweep.sh` in this skill's folder with each phrasing of the fact:

```bash
scripts/sweep.sh [--repo PATH] [--wiki PATH] [--memory PATH] '<old-name>' '<issue-number>' '<new-name>'
```

The script searches the agent memory, the wiki, the root guides, other docs, the skill and agent trees, code (split into comments and live lines) and tests. It defaults to the git top level, `docs/wiki` and the Claude Code project memory.

| Exit | Meaning |
|---|---|
| 0 | Hits printed. They are the work list, not a failure. |
| 1 | No hits. The fact is gone, or the term is wrong. Assume the term is wrong until you prove otherwise. |
| 2 | The sweep did not run (no `rg`, a bad path, a bad regex). Never a pass. |

Read every hit. The comment and live split is a heuristic by line shape, and the search finds text, not meaning.

- A hit in **live code** stops all deletion until you resolve the premise.
- A **guard** that pins the old behaviour: keep its intent and rewrite the assertion. Never delete a guard only to change a colour.
- A surprising zero: repeat with the old name, the new name and the issue number.

## 3. Decide each hit

Choose one action for each hit:

- **Erase** the line, row or paragraph that asserts the dead fact. This is the default.
- **Narrow** its scope.
- **Rewrite** the area as present-tense current state.
- **Mark** it only where a reader would plausibly build it again, with exactly `Removed in #<n>.`

Never replace deleted text with a note that describes what was there.

## 4. Edit the real home

- A wiki page: also update its folder note, and add a dated file to the section's `.log/`.
- The human docs site, if it derives from the page.
- Repository guides and skills.
- Agent memory: memory is not in git, so a deletion is permanent. Delete only when you are certain, and also remove the line from the memory index.

Keep decision records and corrections ledgers: they are history on purpose. Make repository changes in a worktree and pull request, unless you are already on the branch that owns them. Do not open a second pull request.

Report repository, skill and memory changes separately. Never delete a claim only because it is inconvenient, or because you prefer a different design.
