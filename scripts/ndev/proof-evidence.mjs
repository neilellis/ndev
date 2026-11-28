import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { parseRecord } from '../requirements/requirements.mjs'
import { CliError, releaseRoot, run } from './common.mjs'
import { CODE_FILE, DOCS_SITES, REQUIREMENTS, UI_FILE } from './proof-paths.mjs'

const CITED = /\bREQ-\d{4,}\b/g
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/
const USER_FACING = /(^|\/)(app|pages|routes|components|cli|commands|bin|api)\//
const LESSONS = /^##[ \t]+Lessons[ \t]*$/m
const NEXT_SECTION = /^##[ \t]/m
const ndevCli = join(releaseRoot, 'scripts/cli.mjs')
const ghScript = () => process.env.NDEV_FLOW_GH || join(releaseRoot, 'scripts/github/gh.sh')

function readPlan(file) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new CliError(2, `The plan ${file} cannot be read: ${error.message}`, { repair: 'ndev proof plan --base <ref> --json > plan.json' })
  }
  const plan = parsed.result ?? parsed
  if (!plan.head || !plan.base || !plan.checks || !plan.stats) throw new CliError(2, `The plan ${file} is not the output of ndev proof plan.`, { repair: 'ndev proof plan --base <ref> --json > plan.json' })
  return plan
}

function diffOf(root, base) {
  const args = ['diff', '--no-renames', '--name-status', '-z', `${base}...HEAD`]
  const result = run('git', ['-C', root, ...args])
  if (result.status !== 0) return { failed: { state: 'not-run', command: `git ${args.join(' ')}`, output: `${result.stdout}${result.stderr}`.trim() } }
  const fields = result.stdout.split('\0').filter(Boolean)
  const entries = []
  for (let index = 0; index < fields.length; index += 2) entries.push({ status: fields[index][0], path: fields[index + 1] })
  return { entries }
}

function recordsAt(root) {
  const folder = join(root, REQUIREMENTS)
  const listed = run('git', ['-C', root, 'ls-files', '-z', '--', REQUIREMENTS])
  if (listed.status !== 0) throw new CliError(1, `git ls-files ${REQUIREMENTS} failed in ${root}: ${`${listed.stdout}${listed.stderr}`.trim()}`, { repair: `git -C ${root} status` })
  if (!existsSync(folder)) return new Map()
  const records = new Map()
  for (const rel of listed.stdout.split('\0').filter(path => path.endsWith('.md') && dirname(path) === REQUIREMENTS)) {
    const record = parseRecord(rel, readFileSync(join(root, rel), 'utf8'))
    const id = record.data?.id
    if (id) records.set(id, { id, title: record.title, status: record.status, path: rel, model: record.data.model ?? [] })
  }
  return records
}

function ghRead(args) {
  const result = run('bash', [ghScript(), ...args])
  const output = `${result.stdout}${result.stderr}`.trim()
  if (result.status !== 0) return { failed: { state: 'not-run', command: `gh.sh ${args.join(' ')}`, output } }
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch (error) {
    throw new CliError(1, `gh.sh ${args.join(' ')} exited 0 with output that is not JSON (${error.message}): ${output.slice(0, 500) || 'no output'}`, {
      repair: `Run bash ${ghScript()} ${args.join(' ')} and check that it prints JSON; check gh auth status and gh --version.`,
      details: { command: `gh.sh ${args.join(' ')}`, output },
    })
  }
  return { body: parsed.body ?? '', title: parsed.title ?? '' }
}

const closedBy = text => [...new Set([...text.matchAll(CLOSING)].map(match => match[1]))]

function request({ body, failed }) {
  if (failed) return failed
  if (body === undefined) return { state: 'not-run', reason: NO_BODY }
  const issues = closedBy(body).map(number => {
    const issue = ghRead(['issue-read', number])
    if (issue.failed) {
      throw new CliError(1, `The pull request body closes issue #${number}, and ${issue.failed.command} failed: ${issue.failed.output || 'no output'}`, {
        repair: `Check gh auth status, and that issue #${number} exists in this repository; or take "#${number}" out of the closing words of the body. The evidence stops at issue #${number}, so no later issue was read.`,
      })
    }
    return { number: Number(number), title: issue.title, body: issue.body }
  })
  return { state: 'present', body, issues }
}

function bodyOf(plan, values) {
  if (values.body) return { body: readFileSync(values.body, 'utf8') }
  if (plan.pr?.number) return ghRead(['pr-read', String(plan.pr.number)])
  const event = process.env.GITHUB_EVENT_PATH
  if (!event) return {}
  try {
    return { body: JSON.parse(readFileSync(event, 'utf8')).pull_request?.body ?? '' }
  } catch (error) {
    throw new CliError(1, `The GitHub event file ${event} (GITHUB_EVENT_PATH) cannot be read: ${error.message}`, { repair: 'Give the body with --body <file>, or unset GITHUB_EVENT_PATH.' })
  }
}

function ndev(root, args) {
  const result = run(process.execPath, [ndevCli, ...args, '--root', root, '--json'], { cwd: root, timeout: 600_000 })
  return { exit: result.status, output: `${result.stdout}${result.stderr}`.trim() }
}

const NO_BODY = 'no pull request body: give --body <file>, a plan made with --pr <n>, or GITHUB_EVENT_PATH'

function requirements(root, plan, { body, failed }, asked, records) {
  if (failed) return failed
  if (body === undefined) return { state: 'not-run', reason: NO_BODY }
  const log = git(root, ['log', '--format=%B', `${plan.base}..HEAD`]).output
  const texts = [body, log, ...asked.issues.map(issue => issue.body)]
  const read = new Set(asked.issues.map(issue => String(issue.number)))
  for (const number of closedBy(log).filter(number => !read.has(number))) {
    const issue = ghRead(['issue-read', number])
    if (issue.failed) return issue.failed
    texts.push(issue.body)
  }
  const cited = [...new Set(texts.flatMap(text => text.match(CITED) ?? []))].sort()
  const found = cited.map(id => {
    const record = records.get(id)
    return record ? { id, title: record.title, status: record.status, path: record.path } : { id, found: false }
  })
  const command = `ndev requirements verify --base ${plan.base}`
  const folder = mkdtempSync(join(tmpdir(), 'ndev-proof-verify-'))
  try {
    const report = join(folder, 'report.json')
    const result = ndev(root, ['requirements', 'verify', '--base', plan.base, '--report', report])
    if (!existsSync(report)) return { state: 'not-run', cited, records: found, command, output: result.output }
    const verify = { command, exit: result.exit, report: JSON.parse(readFileSync(report, 'utf8')) }
    return { state: cited.length === 0 ? 'missing' : 'present', cited, records: found, verify }
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

function git(root, args) {
  const result = run('git', ['-C', root, ...args])
  if (result.status !== 0) throw new CliError(1, `git ${args.join(' ')} failed in ${root}: ${result.stderr.trim()}`, { repair: `Fetch the base, then run ndev proof plan again.` })
  return { output: result.stdout }
}

function tests({ entries }) {
  const changed = entries.filter(entry => CODE_FILE.test(entry.path))
  const testFiles = changed.filter(entry => TEST_FILE.test(entry.path) && entry.status !== 'D').map(entry => entry.path)
  const source = changed.filter(entry => !TEST_FILE.test(entry.path) && !entry.path.endsWith('.qnt') && entry.status !== 'D').map(entry => entry.path)
  const stem = path => basename(path).replace(/\.[^.]+$/, '')
  const named = (test, path) => new RegExp(`^(test_)?${stem(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([._-]|$)`).test(basename(test))
  const untested = source.filter(path => !testFiles.some(test => dirname(test) === dirname(path) || named(test, path)))
  if (source.length === 0) return { state: 'not-needed', untested, tests: testFiles }
  return { state: untested.length === 0 ? 'present' : 'missing', untested, tests: testFiles }
}

function model(root, plan, { entries }, records) {
  const models = [...new Set(plan.stats.records.flatMap(id => records.get(id)?.model ?? []).map(entry => String(entry).split('#')[0]))].sort()
  const added = entries.filter(entry => entry.status === 'A' && entry.path.endsWith('.qnt')).map(entry => entry.path)
  if (models.length === 0 && added.length === 0) return { state: 'missing', models, added }
  const command = 'ndev requirements model-check'
  const quint = join(root, 'node_modules/.bin/quint')
  const result = ndev(root, ['requirements', 'model-check'])
  if (!existsSync(quint) && result.exit !== 0) return { state: 'not-run', models, added, command, output: result.output }
  return { state: 'present', models, added, check: { exit: result.exit, output: result.output } }
}

function docs({ entries }) {
  const paths = entries.map(entry => entry.path)
  const changed = paths.filter(path => DOCS_SITES.some(site => path === site || path.startsWith(`${site}/`)))
  const userFacing = entries.filter(entry => entry.status !== 'D' && !changed.includes(entry.path) && (UI_FILE.test(entry.path) || (CODE_FILE.test(entry.path) && USER_FACING.test(entry.path)))).map(entry => entry.path)
  if (changed.length > 0) return { state: 'present', changed, undocumented: [] }
  if (userFacing.length > 0) return { state: 'missing', changed, undocumented: userFacing }
  return { state: 'not-needed', changed, undocumented: [] }
}

function lessons({ body, failed }) {
  if (failed) return failed
  if (body === undefined) return { state: 'not-run', reason: NO_BODY }
  const heading = body.match(LESSONS)
  if (!heading) return { state: 'missing' }
  const rest = body.slice(heading.index + heading[0].length)
  const next = rest.match(NEXT_SECTION)
  const text = (next ? rest.slice(0, next.index) : rest).trim()
  return { state: text === '' ? 'empty' : 'present', text }
}

export function evidence(root, values) {
  const plan = readPlan(values.plan)
  const head = git(root, ['rev-parse', 'HEAD']).output.trim()
  if (head !== plan.head) throw new CliError(1, `The plan ${values.plan} is for ${plan.head.slice(0, 12)}, and HEAD is ${head.slice(0, 12)}.`, { repair: `ndev proof plan --base ${plan.base} --json > ${values.plan}` })
  const result = { base: plan.base, head, tier: plan.tier, skip: plan.skip }
  if (plan.skip) return { ...result, evidence: {}, text: `Proof evidence for ${head.slice(0, 12)}: none, the run is skipped: ${plan.skip.reason}.` }
  const wanted = check => plan.checks[check]?.action === 'run'
  const needsBody = ['requirements', 'lessons', 'code', 'visual'].some(wanted)
  const body = needsBody ? bodyOf(plan, values) : {}
  const asked = needsBody ? request(body) : undefined
  const diff = ['tests', 'model', 'docs'].some(wanted) ? diffOf(root, plan.base) : undefined
  const records = wanted('requirements') || wanted('model') ? recordsAt(root) : new Map()
  const collectors = {
    requirements: () => requirements(root, plan, body, asked, records),
    tests: () => diff.failed ?? tests(diff),
    model: () => diff.failed ?? model(root, plan, diff, records),
    docs: () => diff.failed ?? docs(diff),
    lessons: () => lessons(body),
  }
  const found = {}
  for (const [check, collect] of Object.entries(collectors)) {
    const planned = plan.checks[check]
    found[check] = planned?.action === 'run' ? collect() : { state: 'skipped', reason: planned?.reason ?? 'not in the plan' }
  }
  const text = [`Proof evidence for ${head.slice(0, 12)} against ${plan.base}:`, ...Object.entries(found).map(([check, entry]) => `  ${check.padEnd(12)} ${entry.state}${entry.reason ? `: ${entry.reason}` : ''}`)].join('\n')
  return { ...result, ...(asked ? { request: asked } : {}), evidence: found, text }
}
