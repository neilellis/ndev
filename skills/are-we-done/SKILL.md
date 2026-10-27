---
name: are-we-done
description: "Check whether the current work is actually finished. Use for \"are we done?\", \"anything left?\", or session closeout."
---

# Close out honestly

Answer whether the work is finished. Do not write a general activity summary. Run the checks; do not rely on conversation memory:

```bash
git status --short
git worktree list
git log --oneline @{upstream}..HEAD
git stash list
gh pr list --repo "$(gh repo view --json nameWithOwner -q .nameWithOwner)" --author @me \
  --json number,title,isDraft,mergeable,statusCheckRollup
```

Also check the relevant background jobs, agent runs, submodules and worktrees. Remove only resources that this session made. Report resources that another session owns and leave them in place.

Classify open work:

- **Mine:** finish it when that is safe, then check again.
- **Theirs:** name the decision, merge, sign-off or authorisation that the user must give.

Uncommitted or unpushed work, a draft PR, a red or unmergeable PR and an unverified deployment are unfinished.

If the session found a durable, non-obvious lesson, use the `r` skill. If it found a documented claim that the code contradicts, use the `forget` skill. Ask before `r` only when the lesson is optional and the case is close.

Answer in one paragraph. Start with "Done" or with what remains. Name each unverified claim and the concrete action the user must take. If everything is closed, say so and stop.
