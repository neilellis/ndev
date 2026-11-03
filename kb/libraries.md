# Libraries

[kb](README.md) › libraries

**Take a library from this list before you add another.** The `iNeedA` workflow tool reads this page, with the project's own dependencies, to answer an agent that needs a library.

## The rule

- A dependency that the project has already comes first.
- Then take a library from the table.
- If no row fits, choose a maintained library with a licence that the project allows. Say why in the pull request.
- Add a row here when a choice holds in two or more projects.

## The list

| Job | Library | Install | Home |
|---|---|---|---|
| UI components | shadcn/ui, with the sources in [ui-components.md](ui-components.md) | `npx shadcn@latest add <name>` | https://ui.shadcn.com |
| Animation | Motion | `npm install motion` | https://motion.dev |
| Web application | Next.js | `npx create-next-app@latest` | https://nextjs.org |
| Styles | Tailwind CSS | `npm install tailwindcss` | https://tailwindcss.com |
| Database, auth and storage | Supabase | `npm install @supabase/supabase-js` | https://supabase.com/docs |
| Model calls in an application | AI SDK | `npm install ai` | https://ai-sdk.dev |
| Validation of input | Zod | `npm install zod` | https://zod.dev |
| Browser tests | Playwright | `npm install -D @playwright/test` | https://playwright.dev |
| Unit tests in TypeScript | Vitest | `npm install -D vitest` | https://vitest.dev |
| Unit tests in Python | pytest | `uv add --dev pytest` | https://docs.pytest.org |
| Lint and format in Python | Ruff | `uv add --dev ruff` | https://docs.astral.sh/ruff |
| Type checks in Python | ty | `uv add --dev ty` | https://docs.astral.sh/ty |
