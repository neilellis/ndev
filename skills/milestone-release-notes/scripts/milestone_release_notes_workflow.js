export const meta = {
  name: 'milestone-release-notes',
  description: 'Summarize every issue in a GitHub milestone with Haiku, then have Sonnet write stakeholder-facing release notes',
  phases: [
    { title: 'Summarize', detail: 'read each issue in full (body and every comment) and write one plain-English paragraph', model: 'haiku' },
    { title: 'Synthesize', detail: 'classify + group every paragraph (Features/Improvements/Fixes) and write the release notes file', model: 'sonnet' },
  ],
}

// ---------------------------------------------------------------------------
// Inputs. The SKILL.md body resolves the milestone and lists its issues with
// plain `gh` calls *before* it starts this workflow. A workflow script has no
// filesystem or shell of its own; every gh and Write call below happens INSIDE
// an agent.
//
//   args.milestone   exact milestone title                       (required)
//   args.repo        OWNER/NAME on GitHub                        (required)
//   args.repoDir     absolute path of the local checkout         (required)
//   args.issues      [{number, title, url}, …], already resolved (required, may be empty)
//   args.outFile     notes path, absolute or relative to repoDir (default docs/release-notes/<slug>.md)
//   args.dumpScript  optional command that dumps one issue to markdown; it is run as
//                    `<dumpScript> <number>` and must print the markdown file path.
//                    Without it, agents read the issue with `gh issue view --comments`.
// ---------------------------------------------------------------------------
const A = (typeof args === 'string' ? JSON.parse(args) : args) || {}
function required(name) {
  if (!A[name]) throw new Error(`milestone-release-notes: args.${name} is required (see the header of this script)`)
  return A[name]
}
const MILESTONE = required('milestone')
const REPO_SLUG = required('repo')
const REPO = required('repoDir')
if (!Array.isArray(A.issues)) throw new Error('milestone-release-notes: args.issues must be an array of {number, title, url}')
const ISSUES = A.issues
const DUMP = A.dumpScript || null

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'release'
}
const OUT_FILE = A.outFile || ('docs/release-notes/' + slug(MILESTONE) + '.md')
const OUT_PATH = OUT_FILE.startsWith('/') ? OUT_FILE : (REPO + '/' + OUT_FILE)

if (ISSUES.length === 0) {
  return { milestone: MILESTONE, issueCount: 0, summarized: 0, file: null, note: 'no issues passed in — nothing to summarize' }
}

// ---------------------------------------------------------------------------
// Summarize — one Haiku agent per issue, in parallel. Cheap model, so we read
// every issue in full rather than skimming titles.
// ---------------------------------------------------------------------------
const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    number: { type: 'integer' },
    title: { type: 'string' },
    url: { type: 'string' },
    paragraph: {
      type: 'string',
      description: 'One plain-English paragraph (a few sentences) covering what the issue was about, what changed, and any nuance from the comments — written for a non-technical stakeholder, not a developer. No classification here — just a faithful, jargon-free account.',
    },
  },
  required: ['number', 'title', 'url', 'paragraph'],
}

function summarizePrompt(issue) {
  const how = DUMP
    ? `run \`${DUMP} ${issue.number}\` in ${REPO}, then Read the markdown file it prints (title, metadata, body, ` +
      `every comment). Only look at downloaded images if the text alone does not tell you what shipped.`
    : `run \`gh issue view ${issue.number} --repo ${REPO_SLUG} --comments\` and read all of it (title, body, ` +
      `every comment).`
  return `Read GitHub issue #${issue.number} ("${issue.title}") of ${REPO_SLUG} in full: ${how} ` +
    `If you cannot read the issue, stop and return an error instead of a paragraph.\n\n` +
    `You are writing for a NON-TECHNICAL STAKEHOLDER (investors, partners, non-engineer team members), not a ` +
    `developer reading a changelog. Write ONE PARAGRAPH (a few sentences) in plain business language — no file ` +
    `names, function names, library names, PR/commit jargon, or internal component names — covering what this ` +
    `issue was about, what actually changed as a result, and any real-world effect or nuance worth keeping from ` +
    `the comments. Describe the effect (what a user or the business can now do, or what problem no longer ` +
    `happens), not the implementation. Don't classify or judge importance — just give a faithful, complete, ` +
    `jargon-free account; a later step reads every paragraph together and decides how to group them.\n\n` +
    `Return {number: ${issue.number}, title: ${JSON.stringify(issue.title)}, url: ${JSON.stringify(issue.url)}, ` +
    `paragraph}.`
}

phase('Summarize')
const results = await parallel(ISSUES.map(issue => () =>
  agent(summarizePrompt(issue), { label: `summarize #${issue.number}`, phase: 'Summarize', schema: SUMMARY_SCHEMA, model: 'haiku', effort: 'low' })
))
const summaries = results.filter(Boolean)
log(`${summaries.length}/${ISSUES.length} issues summarized`)
// Release notes that silently drop an issue claim less shipped than did ship, and
// nobody can see the gap. Stop instead, and name the issues to retry.
const failed = ISSUES.filter((issue, i) => !results[i]).map(issue => '#' + issue.number)
if (failed.length) {
  throw new Error(`milestone-release-notes: ${failed.length} issue(s) failed to summarize: ${failed.join(', ')}. ` +
    'No notes were written. Fix: check `gh auth status` and that each issue is readable, then run the workflow again.')
}

// ---------------------------------------------------------------------------
// Synthesize — one Sonnet agent groups everything into the release notes file.
// ---------------------------------------------------------------------------
const WRITE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    file: { type: 'string', description: 'absolute path written' },
    headline: { type: 'string', description: 'one sentence summarizing this release, for a changelog index' },
  },
  required: ['file', 'headline'],
}

function synthesizePrompt() {
  return `Write stakeholder-facing release notes for the "${MILESTONE}" milestone of ${REPO_SLUG} ` +
    `to ${OUT_PATH} (create parent directories if needed). The reader is a NON-TECHNICAL stakeholder — ` +
    `plain business English throughout, no jargon, no technical terms, no issue-tracker language beyond the ` +
    `bracketed reference links.\n\n` +
    `Here is one plain-English paragraph per issue, as JSON — each paragraph is a faithful, unclassified account ` +
    `of that issue only (written without seeing any of the others):\n\n${JSON.stringify(summaries, null, 2)}\n\n` +
    `Read every paragraph, then decide for yourself — from what actually happened, NOT from the issue's GitHub ` +
    `labels (often missing or wrong) — how to classify and group each one:\n` +
    `  - "New Features": something new became possible\n` +
    `  - "Improvements": something that already worked got better, faster, or clearer\n` +
    `  - "Fixes": something broken or wrong was corrected\n` +
    `  - "Other": internal/dev-tooling/infra/refactor work a non-technical stakeholder would never notice or ` +
    `care about\n` +
    `Judge consistently across the whole set — you're seeing every paragraph together, so use that to catch ` +
    `duplicates or near-duplicates (merge them into one bullet citing both issue numbers) and to keep similar ` +
    `items in the same bucket.\n\n` +
    `Structure the file like ordinary release notes:\n` +
    `# ${MILESTONE}\n` +
    `<1-2 sentence plain-English overview of what this release is about>\n\n` +
    `Then "## New Features", "## Improvements", "## Fixes" in that order (omit a heading entirely if it has no ` +
    `items — never print an empty section), one bullet per issue (or merged group), each ending with its ` +
    `reference(s) as "([#<number>](<url>))". Rewrite each into a single clean sentence — don't just copy-paste ` +
    `the paragraph — but don't invent facts beyond what it says.\n\n` +
    `Finally, collect everything you classified "Other" into a short closing "## Other" section, one terse line ` +
    `each, same reference style — for completeness, don't try to spin internal work as user value.\n\n` +
    `Write the file with your Write tool, then return {file: "${OUT_PATH}", headline: <one sentence summarizing ` +
    `this release for a changelog index>}.`
}

phase('Synthesize')
const written = await agent(synthesizePrompt(), { label: 'write-release-notes', phase: 'Synthesize', schema: WRITE_SCHEMA, model: 'sonnet', effort: 'high' })
if (!written || !written.file) {
  throw new Error(`milestone-release-notes: the synthesis agent returned no file. Nothing is confirmed written at ${OUT_PATH}. Fix: run the workflow again.`)
}

return {
  milestone: MILESTONE,
  issueCount: ISSUES.length,
  summarized: summaries.length,
  file: written.file,
  headline: written.headline,
}
