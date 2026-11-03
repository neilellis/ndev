---
name: site-check
description: "Check a local, preview or live copy of a website for broken links, missing pages, server errors and JavaScript errors, with a linkinator link check and a Crawlee browser spider. Use when the user asks to check a site's links, find broken pages, spider a site, or check a site before or after publishing."
---

# Site check

There are two checks. Both work on a local server, a Vercel preview or the live site. Run them in the project root: the scripts load their packages from the project's `node_modules`.

## The workflow

A check that is part of the smoke stage goes to `mcp__ndev__finishedSmoke(report)`, and the report names the HEAD commit. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

- **Link check.** `node "${CLAUDE_PLUGIN_ROOT}/skills/site-check/scripts/links.mjs" <url>` uses linkinator to visit every page on the site: every page in the sitemap and every page reachable by links. It checks every link and image on those pages, including links to other sites. Sites that turn checkers away (401, 403, 429, 999) are listed as warnings.
- **Browser spider.** `node "${CLAUDE_PLUGIN_ROOT}/skills/site-check/scripts/spider.mjs" <url>` uses Crawlee to open up to 20 pages in Chrome. It picks pages from the sitemap and the links it finds, in a random order seeded from the branch name. Each branch samples different pages, and the same branch repeats its sample. It fails on a page that returns 4xx or 5xx, uncaught JavaScript errors, console errors, failed requests, and links to same-site pages that return 4xx or 5xx. Use `--branch <name>` to repeat the sample of another branch, and `--limit <n>` to change the page count.

Exit codes for both: `0` no problems, `1` problems found, `2` the check cannot run. The message for `2` names the cause and the repair.

## Packages

The plugin has no `node_modules`. The target project installs the packages at the exact versions the scripts expect. If a package is missing, the check stops with exit code `2` and prints the install command:

```bash
npm install --save-dev --save-exact linkinator@8.1.0                        # link check
npm install --save-dev --save-exact @crawlee/puppeteer@3.18.2 puppeteer-core@25.12.0   # spider
```

The spider also needs Chrome or Chromium. Set `CHROME_PATH` if it is not in a usual place.

## Live address in the sitemap

A sitemap often lists live addresses, also on a local build. Pass `--live <live site url>` (or set `SITE_CHECK_LIVE_URL`). Then both checks move those addresses, with or without `www`, onto the site under test. Without it, the checks test the live pages that the sitemap names, not the local build.

## Check a production build

`bash "${CLAUDE_PLUGIN_ROOT}/skills/site-check/scripts/against-build.sh" links|spider [--serve '<command>'] [check arguments]` serves the existing build, waits for it to answer, and runs one check against it.

- In a Next.js project, it runs `next start` on the build in `.next/`. If there is no build, it stops and tells you to run `npm run build`.
- In other projects, give the command that serves the build on `$PORT`, in single quotes. For example: `--serve 'npx --yes serve@14.2.4 -l $PORT dist'`. `SITE_CHECK_SERVE` sets the same command. Without a command, the script stops and shows an example.
- `SITE_CHECK_PORT` sets the port (default `3123`).

## Wire the checks into a project

The project owns its wiring. A usual set-up:

1. Add the packages to `devDependencies`, as above.
2. In the project's precheck script, run the link check against the fresh production build: `bash "<plugin>/skills/site-check/scripts/against-build.sh" links --live <live site url>`. A broken link then fails the precheck.
3. In CI, run the spider against the production build after the precheck. Pass `--branch "$GITHUB_HEAD_REF"` if the job runs on a detached commit.
4. Write the live address, the serve command and the commands above in the project's `CLAUDE.md` or wiki, so the next person runs the same checks.

## Other targets

- **Live site:** pass the live address. Run both checks after publishing.
- **Vercel preview:** previews are often protected. The checks send the bypass header only when `VERCEL_AUTOMATION_BYPASS_SECRET` is set, and send it only to the site under test. Keep the secret in the project's `.neil-dev.env` and run the checks through `node ${CLAUDE_PLUGIN_ROOT}/scripts/env/neil-dev-env.mjs run --need VERCEL_AUTOMATION_BYPASS_SECRET -- <check command>`. Without it, open the preview with the Vercel CLI (`vercel curl`), or run the checks against a local build of the pull request's commit. Never ask the user for the secret.

## Page text

When you review page text, use `copy`. If `.neil-dev.json` at the project root (`git rev-parse --show-toplevel`) has `branding`, read the writing rules in `branding.guide` (or else `branding.site`) too. Make sure that desktop and mobile give the same meaning.

## Failures

Fix the cause of each problem: a wrong address, a missing page, a failing script or a moved external page. Do not skip links or relax the checks to get a pass. If a fix needs a new or replaced UI component, read `${CLAUDE_PLUGIN_ROOT}/kb/ui-components.md` and choose it from there. If an external site is down or blocks checkers, tell the user and name the link. Report every problem to the user in plain English, with the page where you found it.

## Test the helpers

`node --test tests/*.test.mjs` in `skills/site-check/scripts/` runs the helper tests offline. `node scripts/links.mjs --help`, `node scripts/spider.mjs --help` and `bash scripts/against-build.sh --help` print the usage.

`${CLAUDE_PLUGIN_ROOT}` is this plugin's root. Outside Claude Code (for example Codex through `for-codex`), use the folder two levels above this skill's folder, so the scripts are at `<skill folder>/scripts/...`.
