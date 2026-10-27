# Local development

[kb](README.md) › local-dev

**The local stack refuses to start when it is half-configured, and you run every command from the tree that you test.** A project records its own commands in its `CLAUDE.md`; this page gives the general pattern.

## Start-up

- With nothing configured, the database layer refuses to run and exits 2. The message names the variable to set and the command that starts a local database.
- It never falls back silently to a default host or a file database. A silent fallback runs the tests against the wrong engine ([testing.md](testing.md#its-environment-differs-from-production)).
- Copy the example environment file (`.env.example`) to the local file. The example lists every variable, with no real values.

## Fast throwaway databases

A Postgres in a container on `tmpfs` with `fsync=off` is fast. Use it only for a throwaway container in tests. Never point it at data that you keep.

## Worktrees

- A build or a test that needs a database can fail in a new worktree because the worktree has no environment file or no container. Compare with a run on the base branch as the control before you call it a regression.
- Run commands from the worktree that you test. A command from the main checkout tests the main checkout.
- Give each worktree its own container names and ports, or let the kernel pick the port. See [ci.md](ci.md#self-hosted-runners).

## Switches

- A variable that points the tests at a test database is a switch. When it is absent, the database tests skip. A skipped test proves nothing ([core belief 8](core-beliefs.md#8-never-overclaim)). Report the skip.
