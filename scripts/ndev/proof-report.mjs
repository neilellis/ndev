import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PROOF_CHECKS } from '../../hooks/workflow/proof-config.ts'
import { CliError, releaseRoot, run } from './common.mjs'
import { repository } from './proof-snapshots.mjs'

export const STATES = ['pass', 'fail', 'skipped', 'not-run']
export const MARKER = '<!-- ndev-proof -->'
export const VERDICT_GUIDE = join(releaseRoot, 'skills/proof/references/verdict.md')
const LETTERS = { requirements: 'A', code: 'B', visual: 'C', tests: 'D', model: 'E', docs: 'F', lessons: 'G' }
const NAMES = { requirements: 'Requirements', code: 'Code', visual: 'Visual', tests: 'Tests', model: 'Model', docs: 'Docs', lessons: 'Lessons' }
const SHOWN = { pass: '✅ pass', fail: '❌ fail', skipped: '⏭️ skipped', 'not-run': '⚠️ not-run' }
const CHECK_KEYS = ['state', 'reason', 'evidence']
const EVIDENCE_KEYS = ['text', 'file', 'line']
const COMMENT_LIMIT = 60_000
const ghScript = () => process.env.NDEV_FLOW_GH || join(releaseRoot, 'scripts/github/gh.sh')
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)

export function readJson(file, what, repair) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new CliError(2, `The ${what} ${file} cannot be read: ${error.message}`, { repair })
  }
  return isObject(parsed) && 'ok' in parsed && 'result' in parsed ? parsed.result : parsed
}

function checkProblems(check, entry, planned, found) {
  const at = `"checks.${check}`
  if (!isObject(entry)) return [`${at}" must be an object such as { "state": "pass", "evidence": [{ "text": "..." }] }`]
  const problems = Object.keys(entry).filter(key => !CHECK_KEYS.includes(key)).map(key => `${at}" has the unknown key "${key}"; the keys are ${CHECK_KEYS.join(', ')}`)
  if (!STATES.includes(entry.state)) return [...problems, `${at}.state" is ${JSON.stringify(entry.state)}; use one of ${STATES.join(', ')}`]
  if (planned?.action !== 'run' && entry.state !== 'skipped') problems.push(`${at}.state" is "${entry.state}", and the plan skips it (${planned?.reason ?? 'not in the plan'}); use "skipped" or leave it out`)
  if (planned?.action === 'run' && entry.state === 'skipped') problems.push(`${at}.state" is "skipped", and the plan runs it; use pass, fail or not-run`)
  if (entry.state !== 'pass' && (typeof entry.reason !== 'string' || entry.reason.trim() === '')) problems.push(`${at}.reason" is missing; a ${entry.state} needs the reason in one sentence`)
  if (entry.reason !== undefined && typeof entry.reason !== 'string') problems.push(`${at}.reason" must be a string`)
  const evidence = entry.evidence ?? []
  if (!Array.isArray(evidence)) problems.push(`${at}.evidence" must be a list of { "text", "file", "line" }`)
  else {
    if ((entry.state === 'fail' || entry.state === 'pass') && evidence.length === 0) problems.push(`${at}.evidence" is empty, and a ${entry.state} needs at least one item`)
    evidence.forEach((item, index) => {
      const where = `${at}.evidence[${index}]`
      if (!isObject(item)) return problems.push(`${where}" must be an object such as { "text": "...", "file": "src/a.js", "line": 3 }`)
      for (const key of Object.keys(item).filter(key => !EVIDENCE_KEYS.includes(key))) problems.push(`${where}" has the unknown key "${key}"; the keys are ${EVIDENCE_KEYS.join(', ')}`)
      if (typeof item.text !== 'string' || item.text.trim() === '') problems.push(`${where}.text" is missing; say what was found`)
      if (item.file !== undefined && (typeof item.file !== 'string' || item.file === '')) problems.push(`${where}.file" must be a path relative to the repository root`)
      if (item.line !== undefined) {
        if (!Number.isInteger(item.line) || item.line < 1) problems.push(`${where}.line" is ${JSON.stringify(item.line)}; use a line number from 1`)
        else if (item.file === undefined) problems.push(`${where}.line" needs a file`)
      }
    })
  }
  if (entry.state === 'pass' && found?.state === 'not-run') problems.push(`${at}.state" is "pass", and its evidence did not run: ${found.output ?? found.reason ?? 'no output'}; use "not-run"`)
  return problems
}

export function verdictProblems(verdict, plan, evidence) {
  if (!isObject(verdict)) return ['the verdict must be a JSON object { "head", "checks" }']
  const problems = Object.keys(verdict).filter(key => !['head', 'summary', 'checks'].includes(key)).map(key => `"${key}" is not a verdict key; the keys are head, summary, checks`)
  if (verdict.head !== plan.head) problems.push(`"head" is ${verdict.head}, and the plan is for ${plan.head}`)
  if (verdict.summary !== undefined && typeof verdict.summary !== 'string') problems.push('"summary" must be a string')
  if (!isObject(verdict.checks)) return [...problems, '"checks" must be an object of checks, such as { "code": { "state": "pass" } }']
  for (const check of Object.keys(verdict.checks).filter(check => !PROOF_CHECKS.includes(check))) problems.push(`"checks.${check}" is not a check; the checks are ${PROOF_CHECKS.join(', ')}`)
  for (const check of PROOF_CHECKS) {
    const planned = plan.checks[check]
    const entry = verdict.checks[check]
    if (entry === undefined) {
      if (planned?.action === 'run') problems.push(`"checks.${check}" is missing, and the plan runs it`)
      continue
    }
    problems.push(...checkProblems(check, entry, planned, evidence?.evidence?.[check]))
  }
  return problems
}

const CELL_LIMIT = 1000
const safe = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('@', '&#64;').replaceAll('[', '&#91;').replaceAll(']', '&#93;').replaceAll('!', '&#33;')
const cell = text => {
  const flat = safe(text).replace(/\r?\n/g, ' ').trim()
  return (flat.length > CELL_LIMIT ? `${flat.slice(0, CELL_LIMIT)}…` : flat).replaceAll('|', '\\|')
}
const cite = item => `${item.text}${item.file ? ` (${item.file}${item.line ? `:${item.line}` : ''})` : ''}`

function rowsOf(plan, verdict) {
  return PROOF_CHECKS.map(check => {
    const planned = plan.checks[check]
    if (plan.skip) return { check, state: 'skipped', reason: plan.skip.reason, evidence: [] }
    if (planned?.action !== 'run') return { check, state: 'skipped', reason: planned?.reason ?? 'not in the plan', evidence: [] }
    const entry = verdict.checks[check]
    return { check, state: entry.state, reason: entry.reason, evidence: entry.evidence ?? [] }
  })
}

function bodyOf(plan, verdict, rows, grid) {
  const detail = row => cell([row.reason, row.evidence.map(cite).join('; ')].filter(Boolean).join(': ') || '-')
  const lines = [MARKER, `## Proof of ${plan.head.slice(0, 12)}`, '']
  if (plan.skip) lines.push(`Proof skipped: ${plan.skip.reason}.`, '')
  else if (verdict?.summary) lines.push(safe(verdict.summary.trim()).slice(0, CELL_LIMIT * 2), '')
  lines.push('| | Check | State | Detail |', '|---|---|---|---|')
  for (const row of rows) lines.push(`| ${LETTERS[row.check]} | ${NAMES[row.check]} | ${SHOWN[row.state]} | ${detail(row)} |`)
  lines.push('', `Tier: **${plan.tier}**: ${plan.reasons.join('; ')}. Base ${plan.base}, settings from ${plan.settings}.`)
  const body = lines.join('\n')
  if (!grid) return body
  const withGrid = [body, '', '<details><summary>Snapshots</summary>', '', grid.trim(), '', '</details>'].join('\n')
  return withGrid.length <= COMMENT_LIMIT ? withGrid : `${body}\n\nThe snapshot grid is longer than ${COMMENT_LIMIT} characters, so it is not in this comment. Read it in the Proof files of the run.`
}

function gh(args, repair) {
  const result = run('bash', [ghScript(), ...args], { timeout: 120_000 })
  if (result.status !== 0) {
    const output = `${result.stdout}${result.stderr}`.trim()
    throw new CliError(1, `gh.sh ${args[0]} ${args.slice(1).filter(arg => !arg.includes('\n')).join(' ')} exited ${result.status}: ${output || 'no output'}`.slice(0, 2000), { repair, details: { exitCode: result.status, output } })
  }
  return result.stdout.trim()
}

function commenter() {
  if (process.env.NDEV_PROOF_COMMENTER) return process.env.NDEV_PROOF_COMMENTER
  if (process.env.GITHUB_ACTIONS === 'true') return 'github-actions[bot]'
  return JSON.parse(gh(['me'], 'gh auth status')).login
}

function postComment(slug, pr, body) {
  const repair = `Check gh auth status, and that the token can write to pull request ${pr} in ${slug} (pull-requests: write).`
  const listed = gh(['api', '--paginate', `repos/${slug}/issues/${pr}/comments`, '--jq', '.[] | {id, body, login: .user.login} | @json'], repair)
  const login = commenter()
  const mine = listed.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(comment => comment.login === login && comment.body.startsWith(MARKER))
  if (mine) return { action: 'edited', url: gh(['comment-edit', String(mine.id), '--body', body], repair) }
  return { action: 'created', url: gh(['comment', String(pr), '--body', body], repair) }
}

function postCheckRun(slug, plan, conclusion, body) {
  const folder = mkdtempSync(join(tmpdir(), 'ndev-proof-check-'))
  try {
    const input = join(folder, 'check-run.json')
    const failed = conclusion === 'failure'
    writeFileSync(input, JSON.stringify({
      name: 'ndev proof', head_sha: plan.head, status: 'completed', conclusion,
      output: { title: conclusion === 'skipped' ? 'Proof skipped' : failed ? 'Proof failed' : 'Proof passed', summary: body.slice(0, 65_000) },
    }))
    const output = gh(['api', '-X', 'POST', `repos/${slug}/check-runs`, '--input', input], `Give the workflow's GITHUB_TOKEN the permission checks: write (permissions: checks: write), or run gh auth refresh -s repo.`)
    return { conclusion, url: JSON.parse(output).html_url }
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

export function report(root, values) {
  const repair = 'ndev proof report --help'
  if (Boolean(values.pr) === Boolean(values.local)) throw new CliError(2, 'Give --pr <n> or --local, not both and not neither.', { repair })
  if (values.pr && !/^[1-9]\d*$/.test(values.pr)) throw new CliError(2, `--pr ${JSON.stringify(values.pr)} is not a pull request number.`, { repair })
  if (!values.plan) throw new CliError(2, 'Give the plan file with --plan <file>, the output of ndev proof plan --json.', { repair })
  const plan = readJson(values.plan, 'plan', 'ndev proof plan --base <ref> --json > plan.json')
  if (!plan.head || !plan.checks || !plan.tier) throw new CliError(2, `The plan ${values.plan} is not the output of ndev proof plan.`, { repair: 'ndev proof plan --base <ref> --json > plan.json' })
  let verdict = null
  if (!plan.skip) {
    if (!values.verdict) throw new CliError(2, 'Give the verdict with --verdict <file>; only a skipped plan needs none.', { repair: `Write the verdict as ${VERDICT_GUIDE} says.` })
    verdict = readJson(values.verdict, 'verdict', `Write the verdict as ${VERDICT_GUIDE} says.`)
    if (!values.evidence) throw new CliError(2, 'Give the evidence with --evidence <file>, the output of ndev proof evidence --json, so a check whose evidence did not run cannot pass.', { repair: 'ndev proof evidence --plan plan.json --json > evidence.json' })
    const evidence = readJson(values.evidence, 'evidence', 'ndev proof evidence --plan plan.json --json > evidence.json')
    const problems = verdictProblems(verdict, plan, evidence)
    if (problems.length > 0) throw new CliError(2, `The verdict ${values.verdict} has ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n${problems.map(problem => `- ${problem}`).join('\n')}`, { repair: `Fix the verdict as ${VERDICT_GUIDE} says, then run ndev proof report again.`, details: { problems } })
  }
  const grid = values.grid ? readFileSync(values.grid, 'utf8') : ''
  const rows = rowsOf(plan, verdict)
  const body = bodyOf(plan, verdict, rows, grid)
  const blocking = plan.skip ? [] : rows.filter(row => row.state === 'fail' || row.state === 'not-run')
  const conclusion = plan.skip ? 'skipped' : blocking.length > 0 ? 'failure' : 'success'
  let comment = null
  let checkRun = null
  if (values.pr) {
    const slug = repository()
    comment = postComment(slug, Number(values.pr), body)
    checkRun = postCheckRun(slug, plan, conclusion, body)
  }
  const states = rows.map(row => `${row.check} ${row.state}`).join(', ')
  const posted = comment ? ` Comment ${comment.action}: ${comment.url}. Check run: ${checkRun.url}.` : ' Nothing was posted (--local).'
  const result = { head: plan.head, conclusion, checks: Object.fromEntries(rows.map(({ check, ...row }) => [check, row])), comment, checkRun, body }
  if (conclusion === 'failure') {
    const names = blocking.map(row => `${row.check} (${row.state}: ${row.reason ?? 'no reason'})`).join(', ')
    throw new CliError(1, `Proof failed for ${plan.head.slice(0, 12)}: ${names}.${posted}${values.local ? `\n\n${body}` : ''}`, {
      repair: 'Fix each failed check, or say in the pull request why it does not apply, then push again.', details: result,
    })
  }
  return { ...result, text: `Proof ${conclusion} for ${plan.head.slice(0, 12)}: ${states}.${posted}${values.local ? `\n\n${body}` : ''}` }
}
