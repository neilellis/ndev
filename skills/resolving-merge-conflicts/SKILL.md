---
name: resolving-merge-conflicts
description: "Use when you need to resolve an in-progress git merge/rebase conflict."
---

# Resolve merge conflicts

1. **See the current state** of the merge or rebase: `git status`, the recent history on both sides, and the conflicting files.
2. **Find the primary sources** for each conflict. Learn why each change was made and what its intent was. Read the commit messages, the PRs and the original issues.
3. **Resolve each hunk.** Keep both intents where you can. Where they are incompatible, choose the one that matches the merge's stated goal and record the trade-off. Do not invent new behaviour. Always resolve; never `--abort`.
4. **Run the project's automated checks**, usually type check, then tests, then format (the commands named in its CLAUDE.md or AGENTS.md). Fix anything the merge broke. Record a baseline failure that also fails on the base branch; do not count it as a pass.
5. **Finish the merge or rebase.** Stage your resolutions by name and commit. For a rebase, continue until every commit is rebased.
