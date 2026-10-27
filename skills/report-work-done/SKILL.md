---
name: report-work-done
description: "Summarize what actually shipped by reading merged pull requests in a requested time window, optionally filtered by author."
---

# Report shipped work

1. Define the window and the author filter exactly.
2. Fetch merged PRs with this skill's `scripts/fetch-prs.sh`:
   ```bash
   fetch-prs.sh --since <YYYY-MM-DD> | --period 7d  [--author LOGIN|me|all] [--chunks N] [--repo OWNER/REPO] [--out DIR]
   fetch-prs.sh --period 7d --count-only     # the denominator, for "N of M"
   ```
   It writes `prs.json` and `chunk1.md` to `chunkN.md` (to the scratchpad or `--out`) for helper summaries. It fails when it reaches the 500-PR limit; use a shorter window.
3. Read each PR's body, diff, closing issues and merge date. Do not infer shipped work from commits, open PRs, issue titles or chat.

Write the report:

- Group related PRs into a few sections led by outcomes. Each section gives the user or business result, then only the PRs that support it.
- Mention operational, documentation or infrastructure work where it changed delivery.
- List open or incomplete work separately.
- End with a full evidence table: PR number, title, author, merged date, linked issues.
- With an author filter, state it exactly. Separate authored work from reviewed, co-authored or only related PRs.
- Cite a PR number or link for every factual claim. Keep uncertainty. Write for the requested audience. No padding, no impact claims without evidence.
