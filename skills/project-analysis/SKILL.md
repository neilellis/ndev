---
name: project-analysis
description: "Perform a scored, evidence-backed architecture and product health review of the repository and append the run to the project's ratings file."
disable-model-invocation: true
---

# Project health review

Take the ratings file from the arguments, else from the project's CLAUDE.md. A usual place is `docs/analysis/ratings.md`.

## Read

Read the current repository: `README.md`, `CLAUDE.md` / `AGENTS.md`, the main source packages, the tests, the migrations and the docs. Use the paths that exist now, not remembered ones.

## Score 25 dimensions, 0 to 10

philosophy and coherence, conceptual integrity, architecture, modularity, API design, error handling, configurability, language practices, concurrency, resources, semantic correctness, robustness, security, failure legibility, performance, scalability, testability, test architecture, observability, debuggability, operational readiness, evolvability, documentation, developer experience, dependency hygiene.

- Cite concrete code or docs evidence for every score.
- Say if the evidence is from reading or from an executed check.

## Try to falsify the top scores

Test the three highest scores with a targeted probe: a test, a query, a build, a benchmark or malformed input. Lower a score when a probe contradicts it. Do not claim a speed number without a measurement (`hyperfine`).

## Calibrate

Read the existing calibration ledger in the ratings file. Append a dated correction only when new evidence proves that an earlier score was wrong at the time. Never rewrite an earlier run.

## Write

Append to the ratings file. Make the folder and file if they do not exist.

1. A heading `## YYYY-MM-DD — Run N`, where N counts the existing `— Run ` headings.
2. The 25-row table: dimension, score, evidence, how it was checked.
3. An overall score summary.

Keep unrelated user changes. Run only checks that are in proportion to the review. Do not change product code as part of the analysis.
