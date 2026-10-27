# Repository instructions

Follow these rules in Codex and Claude. Keep messages to the user short, plain and focused on the next step. The user does not use a terminal. Never ask them to install software, run commands, manage branches, read logs, or handle secret values.

## Project

This is the `{{repo}}` brand site: the {{name}} brand guide and design system. Production is {{siteUrl}}. It is a Next.js static export of MDX pages, with no server code, database or secrets. Pages are marked `noindex`, but anyone with the link can read them, so publish nothing that is not already public on {{domain}}.

- **Design system:** `public/ds/`, served at `/ds/`. Tokens are in `public/ds/tokens/`, component classes in `public/ds/components.css`, and assets in `public/ds/assets/`. Other projects link to `/ds/styles.css`, so treat token and class names as a public interface.
- **Pages:** MDX under `app/`. The sidebar is `lib/nav.ts`. Shared page components are in `app/components/` and registered in `mdx-components.tsx`. The guide's own chrome is `app/globals.css`.
- **Sources:** the brand comes from `{{sourceRepo}}`{{filmClause}}. Work in this repository only reads them; never write to them. If the guide and a source disagree, the source wins, so fix the guide. The source map is on the Governance page.
- **Claims:** every statement about {{name}} must be supported by the sources. Do not invent copy, statistics or client results. Label layout placeholder text as placeholder. Mark new guidance that is not taken from a source as a recommendation.
- **Credits:** credit every photographer. Keep the credits on the Photography and Footage pages and in `THIRD_PARTY_NOTICES.md` in step with `public/ds/assets/photos/`.

## Skills

Read the skill that matches the task before starting:

| Task | Skill |
| --- | --- |
| Bring the guide in line with its sources | `brand-sync` |
| Add or change a token or component class | `design-tokens` |
| Add or edit a guide page | `guide-pages` |
| Add, replace or credit an image | `brand-assets` |
| Any text, including agent files and skills | `copy` |
| Any change, pull requests, tests, replies and rule changes | light-work, github, testing, i-have-adhd and harness-sync from the neil-development plugin |

## Work and approval

- Use authorised GitHub write tools only. Never claim a branch, commit, pull request or deployment exists unless a tool confirms it.
- Make changes on one feature branch with one pull request. Never write to `main`. Continue an open pull request that covers the same work.
- Do not merge before the user says “Approve and publish” or gives equivalent clear approval. After merging, confirm the production deployment is Ready, uses the merge commit and passes browser smoke testing.
- Before asking for approval, confirm the required checks passed on the current commit, the Vercel preview is Ready for that commit, and the pages passed browser smoke testing. If a tool is unavailable, report that check as incomplete.
- Never ask for passwords, access tokens or secret values in chat.

## Checks

GitHub Actions runs Node 24, `npm ci`, the harness parity check and `scripts/precheck.sh` (lint, type checking, tests and the static build). The structure tests check that every sidebar link has a page, every `var(--…)` is a defined token, and every `/ds/` asset exists. With a terminal, run `scripts/precheck.sh` before pushing and push through `scripts/push-checked.sh`. Pending, skipped or missing checks are not passes.

## Failure handling

Fail fast. Record failures and their consequence. Do not hide errors, add silent fallback paths, weaken checks, or present partial work as complete. Keep the user informed in plain English.

## Harness files

Keep `AGENTS.md` and `CLAUDE.md` identical. Keep every skill name and body identical under `.agents/skills/` and `.claude/skills/`. The Skills table names in backticks only the skills in this repository. Skills contain instructions only. Shared scripts belong under `scripts/`. Run `node scripts/harness-sync/check.mjs` before and after changing rules or skills. It also checks that the Skills table above lists every skill and only real skills.
