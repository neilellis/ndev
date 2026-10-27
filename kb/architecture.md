# Architecture

[kb](README.md) › architecture

**A higher layer must not reach past the layer below it.** Each layer reads only the published surface of the layer under it. The project records its own layers in its wiki; this page gives the general principles.

## Layering

- Name the layers, and the one surface that each layer publishes.
- A layer reads the surface of the layer directly below. It never reads that layer's internal tables, files or modules.
- A frontend reads published tables (or a published API) only, plus its own application tables.
- A guard enforces the layering: a structural rule or an import-boundary rule refuses an import or a query that crosses a layer. See [guards.md](guards.md).

## Data and transactions

- Commit at the smallest unit of work that is correct on its own. A failure then loses one unit, not a whole batch.
- Never hold a database session or a transaction open across a network call. The call can take minutes, and the session holds locks and a connection for that time.
- Use parameterised queries. Never build SQL from strings.
- A batch write respects the database's bind-parameter limit (65,535 in Postgres). Chunk it.
- A schema change goes in a migration. The code must be correct while the migration has not yet run. See [deployment.md](deployment.md#migrations-and-merges).

## Configuration

- A required value that is missing stops the start-up, with a message that names the value and where to set it. See [local-dev.md](local-dev.md).
- A secret never goes in the browser bundle.
