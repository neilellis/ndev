---
name: what-do-you-need
description: "State exactly what input or approval you need from the user as clear, numbered questions with brief background. Use when the user asks what you need from them or asks you to explain the decisions that block a task."
---

# What do you need?

Tell the user exactly what you need from them to continue the current task. Load `simple-english` and `i-have-adhd` before you write the reply. Do not depend on a particular question tool or command syntax.

## The workflow

While a workflow runs, `mcp__ndev__status` gives the next step, and `mcp__ndev__blocked(message)` tells the human what the agent needs. `mcp__ndev__requestSecret(name)` finds a secret. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

## Ask only what the user must supply

- Read the current task, earlier answers and existing permissions first.
- Ask only for information, a decision or an approval that the user must give.
- Do not ask again for an answer or a permission that still covers the action.
- Do not present a check that you are waiting for as a question, unless the user must act.

## Shape the reply

Open with the current state and the exact decision that the user must make. Give all independent questions together as a numbered list, with one decision in each. This list overrides the one-question-at-a-time rule of `i-have-adhd`.

For each question, give:

- **Background:** the relevant facts in one or two short sentences. Assume the user did not read earlier messages.
- **Why it matters:** what the answer lets you do, and the task or action that it blocks.
- **Question:** one direct question with one clear meaning. Name the action, target and limit where relevant.
- **Answer:** short, distinct choices when useful, with the result of each. Mark a recommendation only when you have a reason. Accept a written answer.

## Order

- Put required questions first.
- Include an optional question only when its answer changes the result. Label it optional, and say what you will do without an answer.
- If one answer decides the next question, ask the first question alone.

## Approval

For an approval, name the exact action and its scope: the number of runs, the affected files or service, and any known cost. Say why existing permission does not cover it. Name the rule or skill that requires the approval. Do not invent a restriction. Silence is not approval.

## Words

Use ordinary words, short sentences and one idea per paragraph. Explain a necessary technical term at its first use. Avoid vague questions such as "Can you clarify?" or "Shall I proceed?".

End with one clear instruction for the reply, for example: "Reply with an answer for each question number." If you need no input, say so and name your next action. Continue the work that does not depend on the answers.
