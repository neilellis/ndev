# Documentation screenshots

Screenshots in a guide must show the current product. Give each capture a project-owned command and a list of source inputs. Run the freshness check in the docs build or CI, and refresh stale captures before reviewing a page.

## Project manifest

Put `docs-screenshots.json` at the project root. Paths and commands resolve from its directory. Each capture has a unique ID, explicit input files or directories, a command as an argument array, and one or more PNG outputs. A directory input includes all files below it, including added and removed files. Do not include generated outputs, receipts, the manifest, or symlinks in the inputs. List specific source directories instead of the whole repository.

```json
{
  "version": 1,
  "captures": [
    {
      "id": "settings",
      "inputs": ["apps/web/src/settings", "scripts/capture-settings.mjs", "fixtures/settings.json"],
      "command": ["node", "scripts/capture-settings.mjs"],
      "outputs": ["apps/docs/public/screenshots/settings.png", "docs/screenshots/settings.png"]
    }
  ]
}
```

List every published copy in `outputs`. The capture command writes those files. It owns browser setup, fixture data, authentication, viewport, readiness checks and failure evidence. Use real product states and deterministic fixtures. Keep credentials out of the manifest and receipt. Only run manifests from trusted projects: capture commands execute with your local permissions.

Include all files that affect the image: UI source, shared styles, fixture definitions, capture scripts and dependency lockfiles. Remote data, environment variables and unlisted dependencies cannot be checked through file hashes. Put fixture versions or other reproducible inputs in files. For a deliberate recapture with unchanged inputs, remove that manifest's receipt before running refresh.

## Refresh and check

Use the script from the installed ndev root:

```bash
node <ndev-root>/scripts/docs/screenshots.mjs refresh docs-screenshots.json
node <ndev-root>/scripts/docs/screenshots.mjs check docs-screenshots.json
```

Replace `<ndev-root>` with the installation path. In a skill, it is `${CLAUDE_PLUGIN_ROOT}`; outside Claude Code, use the folder two levels above the skill folder. Record the commands in the project's package scripts and contributor instructions. Add `check` to its docs build or CI. A source change makes a capture stale; `refresh` runs only stale captures. These commands do not install a file watcher.

Commit the manifest, screenshots and `docs-screenshots.json.receipt.json` together. The receipt records content hashes for inputs, capture settings and every output. Input changes, manifest changes, missing screenshots and changed screenshot bytes make `check` exit with status 1 and a repair command. Hashes prove file freshness; inspect the captured page to judge visual accuracy.

Before running a stale capture, `refresh` invalidates its receipt and removes its declared generated outputs. The command must produce each output again. It checks PNG headers and chunk boundaries, then records a receipt only if the command exited with status 0, every output passed, and the inputs stayed unchanged. This is a structural check, not a full PNG decoder. A failure preserves the command's output and identifies the capture and exit status. Successful captures keep their receipts if a later capture fails.

The manifest has a lock to prevent concurrent checks and refreshes. A lock error names its path. Remove an abandoned lock only after confirming no capture is running. Keep browser traces and other failure evidence outside the declared screenshot outputs.

## Creating and maintaining a guide

When a new page needs screenshots, add capture entries and implement the project's capture commands. Refresh them, inspect every image in the rendered guide, and run the check. When UI code changes, use the same refresh and check commands before building the affected docs. Keep fixture setup, browser selectors and authentication in the project; ndev supplies the freshness contract.
