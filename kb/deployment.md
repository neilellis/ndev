# Deployment

[kb](README.md) › deployment

**A merge deploys the code, but it does not run the migration. The production build fails closed.** These lessons come from Vercel. Most apply to any host with a git integration.

## Vercel basics

- Set the project's **Root Directory** to the app folder in a monorepo.
- The main branch deploys to production. Every other branch deploys a preview.
- Several projects connected to one repository each build on every push unless an ignored-build step stops them. See [ci.md](ci.md#cost).
- An environment variable that the build reads is fixed at build time. Change it, then redeploy.

## Migrations and merges

- A merge deploys at once. The migration runs separately. The code must therefore be correct while the new row, column or table is absent.
- When a row is absent, the code records the absence (an ERROR log line) and resolves to a default that the caller states. A feature-flag row is the common case.
- A new table has no safe default. Land the migration first, run it, then merge the code that reads it.

## A build that fails closed

The production build command runs the type check and the tests before the build, chained with `&&`:

```bash
if [ "$VERCEL_ENV" = "production" ]; then
  tsc --noEmit && NODE_ENV=test vitest run
fi && next build
```

- **It fails closed.** A gate that prints the failure and deploys anyway is worse than no gate, because it makes false confidence.
- **Prove it by execution, not by spelling.** A test runs the real build command with stub tools on `PATH` and checks which steps ran and the exit code. A test that only checks the command string for a `;` is a proxy.
- **`NODE_ENV=test` applies to the test step only.** The host sets `NODE_ENV=production` for the whole build, and some test libraries break under it. The build step must keep `production`, or it ships a development bundle.
- **The suite must be hermetic.** A test that reads an ambient variable which the host sets (for example a site URL) fails only inside the host's build. Stub the variable.
- **The build container and CI can run different operating systems.** A script that the tests spawn must work on both.
- **Tree-wide guards are slow under load.** Set a test timeout that holds on a busy build container.
- **The deploy gate is a subset of CI's frontend job.** A subset cannot disagree with its superset. Leave out style-only lint: a lint nit must not block a deploy.
- **Previews can skip the gate** when a preview gate already refuses previews for red CI. Production keeps it, because a red PR can still be merged.

## If a known-bad test blocks a deploy

Fix the test. Do not weaken the gate.

## Before you tag a release

- **Read CI on the branch that you release from.** Some jobs run only on a push to the main branch (for example a slow fuzz job). A PR can be green while the same commit fails on the main branch.
- A green local gate and a green PR do not replace this check. Read the newest push run on the branch (`gh run list --branch main --limit 5`).
- If that run is still in progress, wait for it with one blocking wait ([core belief 3](core-beliefs.md#3-wait-without-polling)). A tag on a red commit cannot be honestly rewritten.
- Close each plan row that the release marks done on evidence ([verification-policy.md](verification-policy.md#rule-2-a-plan-row-closes-only-on-evidence)).
- Derive each list that a release step uses (the packages to bump, the files to change) from the tree. A typed list stops covering a package that joins later.
- Check each count by reading the matched items, not by text matching ([guards.md](guards.md#the-guard-pathology-catalogue)).

## After a deploy

- "Ready" means the build finished. It does not mean the feature works. Check the deployed URL.
- A red status from a deploy bot can be about permissions, not the build. Read the message before you call it a failed deploy.
