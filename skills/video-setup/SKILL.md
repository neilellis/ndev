---
name: video-setup
description: "Set up the video kit in a project, start a new narrated video, update a project to the plugin's kit, or check that a project's copy of the kit is current. Use when a project needs its first video, when `npm run check` says the kit is stale or edited, or after the kit changes in the plugin."
---

# Set up or update the video kit

The plugin holds the shared engine in `skills/video-setup/scripts/`. A project keeps a copy of the engine, so its own checks, CI and hosting work without the plugin:

- `scripts/video-kit/`: the engine. Never edit it in a project. Change the plugin, then sync.
- `scripts/video-kit/kit.lock.json`: the kit version (from `scripts/kit.json`) and a hash of every copied file.

## Sync the kit into a project

Run this from the top folder of the project's repository:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/video-setup/scripts/sync.mjs" .
```

Outside Claude Code, use a local clone of the plugin in place of `${CLAUDE_PLUGIN_ROOT}`. The project check finds the plugin through `VIDEO_KIT_SOURCE` (the path of `skills/video-setup/scripts`), then the installed `ndev` plugin.

The sync refuses to replace a kit file that was edited in the project. Move that change into the plugin first. Use `--discard-local-edits` only when the user agrees to lose the edit. Commit the synced files in the project's pull request for the change.

## Check a project

Run `node scripts/video-kit/check.mjs` (or `npm run check`) in the video's folder. It fails when:
- a kit file was edited, removed or added in the project;
- the copy is behind the plugin installed on this machine (it says when the plugin is not present, for example in CI, and then compares nothing);
- the script, voices, timelines and page scenes disagree.

`node "${CLAUDE_PLUGIN_ROOT}/skills/video-setup/scripts/sync.mjs" . --check` runs the kit part alone.

## A new video project

1. Sync the kit in.
2. Add `video.config.json` in the video's folder. Choose the type with the `video-types` skill.

   ```json
   {
     "type": "explainer",
     "name": "product-explainer",
     "script": "scripts/vo.json",
     "page": "film/index.html",
     "voices": [{ "id": "tabitha", "label": "Tabitha (female)" }],
     "pronounce": { "Kubectl": "cube cuttle" },
     "captions": { "written": { "example dot com": "example.com" } },
     "copy": ["film/index.html", "script.md"]
   }
   ```

   Optional keys: `"model"` (the speech model), `"timing"` (overrides of the type's pacing), `"captions"."maxWords"` (7 by default) and `"review"` (`"base"`, the approved branch, and `"font"`, a font file for review labels).
3. Copy `${CLAUDE_PLUGIN_ROOT}/skills/video-setup/scripts/templates/film/` to the page's folder. The template uses neutral tokens on `:root` and system fonts. Set them for the project before the first render.
4. Add `gsap`, `ffmpeg-static`, `ffprobe-static` and `playwright-core` to the project's dependencies, and `"engines": { "node": ">=22" }`.
5. Add npm scripts that call the engine:

   ```json
   {
     "voice": "node scripts/video-kit/voice.mjs",
     "timeline": "node scripts/video-kit/timeline.mjs",
     "stills": "node scripts/video-kit/render.mjs --stills",
     "render": "node scripts/video-kit/render.mjs --all",
     "review": "node scripts/video-kit/review.mjs",
     "check": "node scripts/video-kit/check.mjs",
     "copy": "node scripts/video-kit/copy-check.mjs",
     "precheck": "npm run check && npm test"
   }
   ```

   `video-finish` runs `npm run precheck` before every push. Add the project's own build or tests to it.
6. Give the copy check its Vale settings. It reads `--settings <URL or path>`, then `VALE_SETTINGS`, then `.vale.ini` in the video's folder. There is no default: ask the user which style rules the project uses, or add a `.vale.ini` for the project. It needs `vale` on the path (`brew install vale`).
7. Enable the plugin for everyone who opens the project in Claude Code, in `.claude/settings.json`:

   ```json
   {
     "extraKnownMarketplaces": { "ndev": { "source": { "source": "github", "repo": "neilellis/ndev" } } },
     "enabledPlugins": { "ndev@ndev": true }
   }
   ```

8. Point the project's instructions (`CLAUDE.md` and `AGENTS.md`) at the `video-*` skills, and keep only project facts there: the type, the voices, the sources of assets and claims, the close, and any scene-specific code.
9. Put the keys in the project's `.neil-dev.env`, never in a committed file: `OPENROUTER_API_KEY` (or `OPEN_ROUTER_API_KEY`) for speech, `OPENAI_API_KEY` for word timings and `UNSPLASH_ACCESS_KEY` for photography. Ask the user first, then run `node ${CLAUDE_PLUGIN_ROOT}/scripts/env/neil-dev-env.mjs init`. It creates the git-ignored file from the exports in `~/.zshrc` and lists the keys that are missing. Run a command that needs a key through `neil-dev-env.mjs run --need <KEY,KEY> -- <command>`.

## Branding

If `.neil-dev.json` at the project root (`git rev-parse --show-toplevel`) has `branding`, read `branding.guide` (or else `branding.site`) at step 3. Set the template's `:root` colour tokens and its fonts from it, add the font files to `assets/` with `@font-face`, and use `branding.name` in the page title. Otherwise skip this section.

## Change the kit

Edit `skills/video-setup/scripts/` in the plugin. Run `node --test tests/*.test.mjs` there; the podcast and template tests skip, with the reason, unless `ffmpeg-static`, `playwright-core` and Chrome are present (link a project's `node_modules` at `scripts/node_modules`, or set `VIDEO_KIT_NODE_MODULES`). Raise `version` in `kit.json`, then sync each project.

