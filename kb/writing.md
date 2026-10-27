# Writing

[kb](README.md) › writing

**Write in ASD-STE100 Simple English, with British spelling, and put the answer first.** This applies to documents, comments, commit messages, issues, PR bodies and messages to the user. Use the `simple-english` skill to write or rewrite text.

## The rules

- **The answer first.** The first sentence says the result or the decision. The detail follows.
- **One idea per sentence.** A procedural sentence has at most 20 words. A descriptive sentence has at most 25.
- **"Must", not "should".** A rule is a rule.
- **Active voice.** Name who does the action.
- **Simple tenses.** Use the present tense for the current state.
- **No contractions.** "Do not", not "don't".
- **One word, one meaning.** Do not use a synonym for variety.
- **No coined jargon.** Use the plain word. If a term is necessary, define it once.
- **Condition before command.** "If the check fails, read the log", not "Read the log if the check fails".
- **British spelling.** "Colour", "behaviour", "organise".
- **Bare issue numbers.** Write #1000, not the issue title.
- **Numbered options** when you ask for a decision.

## What to remove

- Filler ("it is worth noting that", "basically", "simply").
- Praise and hedges ("great question", "it seems that perhaps").
- History in a document ([core belief 11](core-beliefs.md#11-forget-history)).
- Restated content. Say it once, in the right place, and link to it.

## Instructions must work as written

Each command, configuration snippet, code snippet or request that a PR adds to a document must work as written. Run it, or trace it to the code that makes it work. A snippet that nobody ran can fail for every reader, for example a command with two filters when the tool accepts one. The [`adversarial-review` skill](../skills/adversarial-review/SKILL.md) checks this.

## The readability check

Run a readability script before you post an issue, a PR body or a document. A typical script runs Vale with a house style:

| Exit code | Meaning |
|---|---|
| 0 | Clean. |
| 1 | Errors found. Fix them. |
| 2 | Vale is not installed, or a path does not exist. Not a pass. |

A missing path must not pass. A missing tool must not pass.

## Prose that a human wrote

Prose that a human wrote in an issue or comment is theirs. Do not lint it or rewrite it unless they ask.
