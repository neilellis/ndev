---
name: perf-review
description: "Review a specified file or directory for performance risks in algorithms, I/O, allocations, database access and connection use."
disable-model-invocation: true
---

# Performance review

Take the target file or directory from the arguments. If there is none, ask for it.

Read the target code and its callers. Report only findings that have evidence. Give each finding:

- the location (`file:line`)
- the category: algorithmic complexity, I/O, redundant computation, database query pattern, or session and connection management
- the problem and its likely impact
- a practical fix, or the measurement that would confirm it

Trace these:

- hot paths, and loop and collection complexity
- repeated serialisation or parsing
- blocking or repeated I/O
- N+1 queries, unbounded result sets and transaction scope
- sessions or connections that leak or that the code makes again without need

Keep a plausible concern apart from a measured regression. Use `hyperfine` for process timing and a profiler for in-process attribution. Do not invent a speed number.
