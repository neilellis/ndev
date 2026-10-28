---
name: dev-wiki
description: "Read and grow the living development wiki at ~/dev-wiki. Use at the start of development work to find lessons that apply, when you learn a reusable development lesson (a user correction, a non-obvious cause, a guard that lied, a repeated procedure), when the user runs /learn, or to promote a stable lesson into the plugin's kb/."
---

# dev-wiki

`~/dev-wiki` is the living development wiki. The plugin creates it from its `kb/` the first time
a session starts. It is a git repository on this computer. Its rules are in `~/dev-wiki/AGENTS.md`.

## Read

At the start of development work, read `~/dev-wiki/wiki.md` once. Open only the pages that fit
the task. Do not read the wiki again for each step.

## Learn

Record a lesson when one of these happens:

- The user corrects how you work, or confirms a non-obvious approach.
- A cause was not obvious, and the next person would dig for it again.
- A test, guard or gate passed when it must fail, or did not run.
- You wrote the same procedure or script a second time.

Do these steps:

1. Apply the routing test: is the lesson true in a different repository? If no, it belongs to the
   project. Use the `remember` skill. Stop here.
2. Write the lesson in one or two sentences, project-neutral. Add the reason, and the evidence:
   a number with its date, a command and its output, or a file path. Mark a guess "unverified".
3. Find the page that owns the topic (`wiki.md` lists them). Change that page in place. Correct a
   wrong fact. Do not append a contradiction. Make a new page only for a new topic, and link it
   from `wiki.md`.
4. Write one ingest file, `~/dev-wiki/.log/YYYY-MM-DD-<slug>.md`: the lesson, the evidence, the
   source repository, and the pages you changed.
5. Commit: `git -C ~/dev-wiki add -A && git -C ~/dev-wiki commit -m "learn: <slug>"`.
6. Tell the user in one line: the lesson and the page.

In interactive steering, record the lesson and tell the user. Do not ask first: the wiki is local
and git can undo it. In auto steering, do the same and name the lesson in the PR description.

## /learn

Review the session for lessons that meet the list above. Record each one with the steps above.
If there is none, say so in one line. Do not invent a lesson to fill the review.

## Promote

A lesson that has held in two or more repositories belongs in the plugin. Copy it into the
matching page in the plugin's `kb/` on a branch of the plugin repository
(`~/dev/ndev`, GitHub `neilellis/ndev`), bump the version in
`.claude-plugin/plugin.json`, and open a PR. A human merges it. Do this only when the user asks,
or as a suggestion at the end of a `/learn` review.

## If the wiki is missing

The plugin creates it at session start. To create it by hand, run
`${CLAUDE_PLUGIN_ROOT}/scripts/wiki/init.sh ~/dev-wiki`. The script refuses a folder that exists and is not empty.

`${CLAUDE_PLUGIN_ROOT}` is this plugin's root. Outside Claude Code (for example Codex through `for-codex`), use the folder two levels above this skill's folder: `<skill folder>/../../scripts/...`.
