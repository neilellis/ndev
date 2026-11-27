**I am not merging this test fix — I need you to pick a path.**

It removes the old failures but fails more often in the way CI actually runs the suite. That
trades a known problem for a worse one, so #41 stays draft.

| how it was run | main | my rewrite |
|---|---|---|
| this test on its own | fails 25% (6/24) | 0% (0/12) |
| the whole file, as CI does | fails 17% (1/6) | 67% (4/6) |

I do not yet know why the whole-file case differs. That is the unfinished part.

**Pick one:**

1. **Split it** (my recommendation) — fix #42 first, then measure this test again.
2. **Land the safe half** — the 280ms correction and the `getAnimations()` finding.
3. **Keep going here** — find the cause of both in this PR.

Measurements are in `docs/wiki/dev/web/test-flakiness.md` on the branch.

The park report describes turning the village greens into community growing areas.
