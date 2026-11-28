# The Proof verdict

The verdict is one JSON object. `ndev proof report` refuses a verdict with a problem, lists every problem, and exits 2.

```json
{
  "head": "<the full commit id of the plan>",
  "summary": "One or two sentences for the top of the comment.",
  "checks": {
    "code": {
      "state": "fail",
      "reason": "The new limit is never checked.",
      "evidence": [{ "text": "parseLimit returns the value with no range check", "file": "src/limits.js", "line": 42 }]
    },
    "tests": { "state": "pass", "evidence": [{ "text": "limits.test.js covers the zero limit", "file": "tests/limits.test.js", "line": 12 }] }
  }
}
```

## Rules

- `head` is the `head` of the plan.
- The keys are `head`, `summary` and `checks`. The checks are `requirements`, `code`, `visual`, `tests`, `model`, `docs` and `lessons`.
- Each check that the plan runs is present, with the state `pass`, `fail` or `not-run`. A check that the plan skips is absent, or has the state `skipped`.
- `state` is `pass`, `fail`, `skipped` or `not-run`.
- `reason` is required for each state except `pass`.
- `evidence` is a list of `{ "text", "file", "line" }`. `text` is required. `line` is a whole number from 1, and needs `file`. A `pass` and a `fail` each need at least one item.
- A check whose evidence has the state `not-run` cannot pass.

## The exit status of the report

| Exit | Meaning |
|---|---|
| 0 | Each check that the plan runs passes. The `ndev proof` check succeeds. |
| 1 | A check fails or did not run. The `ndev proof` check fails. |
| 2 | The verdict or a file is malformed. Nothing is posted. |
