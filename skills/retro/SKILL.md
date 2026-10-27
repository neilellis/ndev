---
name: retro
description: "Review a completed coding session and identify improvements to navigation, checks, standards, instructions, information access and tool economy."
disable-model-invocation: true
---

# Session retrospective

Read the session's actual work and failures. Record only changes that would alter future behaviour:

- a missing navigation pointer or a hidden dependency
- an automated check that would catch a mistake the session made
- a review standard that needs to be clearer
- steering guidance that belongs in `CLAUDE.md` / `AGENTS.md`, or that does nothing and can go
- missing read-only access or a useful log
- expensive or redundant tool calls

Keep implementation guidance apart from review guidance. Prefer a short pointer to an existing doc over a copy of domain knowledge. Read `CLAUDE.md`, `AGENTS.md`, the coding standards, the wiki and the skills only where the session gives evidence that they need a change.

Do not turn a one-off preference or a story into a universal rule. For each change, name the home and the evidence. Use `remember` to write the lessons, and `forget` for guidance that the session proved false.
