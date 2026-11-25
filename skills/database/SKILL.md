---
name: database
description: "Review schema changes, foreign keys, deletion behaviour and database integrity in the repository."
---

# Database integrity

The migrations are the schema authority. Read the project's CLAUDE.md and its wiki for the migration tool and any schema notes before you change the schema.

## The workflow

Add a migration with `mcp__ndev__addMigration(name)`, which makes the file and lists it for `/ndev:merge`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

## Rules

- **A reference needs a foreign key.** A column that refers to another table needs a constraint. Read the live database catalogue, including schemas that only migrations create. ORM metadata and test `create_all()` calls omit those.
- **Find missing references both ways.** Compare the real foreign keys with columns whose names suggest a reference but have no constraint. Exclude a table's own primary key and keys constrained to a different target. A similar name or an overlapping ID range does not prove a relation.
- **Product removal is logical deletion.** Filter deleted rows in the shared read layer, and check every read path. Where a deleted row must release a unique value, use a partial unique index (`WHERE deleted_at IS NULL`).
- **Physical deletion is an operational repair.** Choose `ON DELETE` from the writer of the child table:
  - `CASCADE` for dependants that the system can rebuild,
  - `RESTRICT` for durable records,
  - `SET NULL` only when an empty reference still has a meaning and the column is nullable.
- **Rebuilt projections and frozen snapshots differ.** Read the writer of each table before you copy deletion rules from one to the other.

## Migration safety

`/ndev:merge` runs the migrations after the merge. The old code can still run while they apply. So each migration must work with the code before it and the code after it.

- **Expand, then contract.** First add the new schema. Then move the writers and the readers to it. Remove the old schema only after that.
- **A drop or a rename goes in its own deployment.** Deploy it only when no code reads the old schema. A rename is a new column, a copy of the data, and a later drop.
- **Prove the rollback before merge.** Run the down migration on a local database. If the tool has no down migration, as with Supabase, write the reverse SQL in the PR body. Then run it on a local database.
- **A long lock or a table rewrite needs a stated plan.** On a big table, some changes lock it or rewrite it. Examples are an index without `CONCURRENTLY`, a column type change, and a constraint that is not `NOT VALID`. Write the plan in the PR body: the table size, the lock, the expected time and when it runs.

## Audit

For an audit, read the real constraints, suspect references, orphan counts, nullability, deletion filters and uniqueness. Report the table, column, measured count, evidence and proposed repair.

1. Repair orphans before you add a constraint.
2. Test that an invalid write or delete is refused.
3. Test that a valid operation still works.

Use the `supabase-postgres-best-practices` skill, if it is available, for Postgres detail.
