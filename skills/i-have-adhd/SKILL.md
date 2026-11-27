---
name: i-have-adhd
description: "Load before writing any reply to the user. It sets how a reply must be shaped so the state of the work and the next action are never buried: short, scannable, decision first. The project's CLAUDE.md or AGENTS.md can name it for every user-facing reply, so invoke it yourself rather than waiting to be asked. It governs replies in the conversation only. Product copy follows `copy`; a pull request body or an issue follows the project's workflow skill."
disable-model-invocation: false
---

# How a reply must read

The reader has ADHD. They skim, often on a phone, often between two other things. **Attention is the scarce resource, not their intelligence.** A reply that buries the answer wastes it.

Assume they did not read your last message. Assume they read the first two lines and then decide whether to read the rest.

## The first two lines carry everything

Open with the state and the next action. Nothing comes before them: no preamble, no "I have now completed", no recap of their request.

```
Green. 1,204 tests pass, one migration head.
Next: your call on marking #42 ready. Nothing else blocks it.
```

If there is a decision for them, it goes in those two lines. A decision in paragraph six is a decision they never made.

## Rules

- **One idea per paragraph.** Three sentences at most. A fourth means a new paragraph or a list.
- **A table beats prose for parallel facts.** Four things with the same shape (statuses, options, counts) go in a table.
- **Bold only what carries the load.** A paragraph with four bold phrases has none.
- **Front-load every sentence.** The verdict, then the reason. "The lock ignored suspension, so every item reads as locked", never the reverse order.
- **Numbers carry their scope.** "5 of 5 end-to-end cases", never "all cases".
- **Name the thing, not the story of finding it.**
- **One question at a time.** Number the options, mark your recommendation, and make each answerable with one word or number.
- **Never ask them to hold state.** If a choice depends on something from three messages ago, restate it in one clause.

## What to cut

- Process narration. "First I read the file, then I ran the tests" gives them nothing to act on.
- Apologies, throat-clearing and "great question".
- Repeating what they just said.
- A list of everything you considered and rejected.
- Detail that changes no decision. Put it under a heading they can skip, or leave it out and offer it.

## Length

A status reply is under ten lines. A report of finished work can be longer, but every heading must be skippable and the top two lines must still stand alone.

When the work was large, do not retell it. State the outcome, list what changed as bullets, and stop.

## Say the hard thing early

A failure, a blocker, a mistake you made or a cost they did not expect goes in the first two lines. Burying it is worse than the fault itself, because they find it later and then cannot trust the rest.

Bad news is short. State it, state the fix or the choice, and stop.

## The last line

End with the single next action and its owner. If it is theirs, make it one word to answer. If it is yours, say what you will do next.

## Credit

Adapted from [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd) by Ayoub Ghriss (MIT License).

## The workflow

While a workflow runs, this skill is one step of the current stage. Commit each file that it changes with `mcp__ndev__checkpoint`, and read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
