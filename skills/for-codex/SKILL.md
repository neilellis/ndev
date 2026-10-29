---
name: for-codex
description: "Make this plugin's skills available to the OpenAI Codex CLI in one project, with symlinks into the Codex-only folder <project>/.codex/skills/. Use for \"/for-codex\", \"make the skills available to Codex\", \"link skills into a Codex project\", or to remove those links."
---

# For Codex

Evidence: codex-cli 0.164.0 `codex debug prompt-input` lists skills from `<repo>/.codex/skills/` and follows symlinked skill folders (tested 2026-10-27). The docs (https://learn.chatgpt.com/docs/build-skills, was developers.openai.com/codex/skills) name only `.agents/skills`; they also say Codex follows symlinks.

## What it links

- Each `skills/<name>/` that has a `SKILL.md` becomes `<project>/.codex/skills/<name>`, a symlink to the absolute plugin folder. This includes `for-codex`.
- The plugin's shared `scripts/` folder becomes `<project>/.codex/scripts`. Skills call shared scripts as `${CLAUDE_PLUGIN_ROOT}/scripts/<area>/<name>`; under Codex that is `<skill folder>/../../scripts/<area>/<name>`. The kernel resolves `.codex/skills/<name>/../..` through the skill link to the plugin root. A tool that shortens the path as text gets `.codex/scripts` instead, and this link makes that path work too.
- Nothing else. Codex agents (`.codex/agents/*.toml`) and hooks (`.codex/hooks.json`) use other formats than this plugin's `agents/*.md` and `hooks/`. A symlink cannot convert them.

## Why Codex-only

The user wants Codex paths only. Do not use `.agents/skills/` or `AGENTS.md`: other harnesses read them too.

Note: `.codex/skills/` in a project is not in the Codex docs. A later Codex release can stop reading it. If the skills do not show, run `codex debug prompt-input "hi"` in the project and look for the skill names.

## How to run

```bash
bash "<this skill dir>/scripts/link.sh" --dry-run [project-dir]   # show the plan
bash "<this skill dir>/scripts/link.sh" [project-dir]             # make the links
```

- The default project dir is the git root of the current folder.
- The script prints one line for each skill and for `.codex/scripts`: `linked`, `kept`, `updated` or `refused`, then a summary.
- It is safe to run again. A correct link is kept. A link to an old location of this plugin is updated.
- It refuses a real file, a real folder or a symlink to some other place. It does not change them. It continues with the other skills, then exits 1 and lists the refusals. To link that skill, move the item away and run again.
- It does not edit `.gitignore`. If `.codex/skills/` is not ignored, it prints the line to add. The links hold absolute paths for this machine, so usually do not commit them.

## How to undo

```bash
bash "<this skill dir>/scripts/link.sh" --remove [project-dir]
```

This removes only symlinks that point into this plugin, and the `.codex/scripts` link to it. Other items in `.codex/` stay. An empty `.codex/skills/` is removed.

## Plugin cache and working copy

Claude Code runs an installed plugin from its cache, `~/.claude/plugins/cache/<marketplace>/ndev/<version>/`. A plugin update changes that path and breaks links to it. So:

1. If the script runs from the cache and `~/dev/ndev` exists, it links to that working copy.
2. If no working copy exists, it links to the cache and prints a warning. Run it again after each plugin update.
3. To use some other copy, give `--source <plugin-root>`.

A link to the working copy shows your edits at once, also edits that are not committed.
