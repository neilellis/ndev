# ndev documentation site

Static Next.js documentation site for `ndev` 2.0, deployed to GitHub Pages by `.github/workflows/pages.yml`.

## Local commands

```sh
pnpm install
pnpm dev
```

Build and verify the static export:

```sh
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
pnpm run verify:links
```

Test with the GitHub Pages base path (`/ndev`):

```sh
NEXT_PUBLIC_BASE_PATH=/ndev pnpm run build
NEXT_PUBLIC_BASE_PATH=/ndev pnpm run verify:links
```

Print the Mermaid state diagrams generated from `models/workflow/*.qnt`:

```sh
pnpm run quint:mermaid
```
