import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { argsFor, checked, CliError, gitWorkspace, releaseRoot, run } from './common.mjs'
import { evidence } from './proof-evidence.mjs'
import { report } from './proof-report.mjs'
import { proofInstall } from './proof-install.mjs'
import { proofRun } from './proof-run.mjs'
import { snapshots } from './proof-snapshots.mjs'
import { CODE_FILE, DOCS_SITES, REQUIREMENTS, UI_FILE } from './proof-paths.mjs'
import { proofSettingsAt } from './proof-settings.mjs'

const COMPLEX_LABEL = 'proof:complex'
const LOCK_FILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|go\.sum|mix\.lock)$/
const DOC_FILE = /\.(md|mdx|markdown|rst|adoc)$/i
const WHITESPACE_SENSITIVE = /\.(py|ya?ml|mk|haml|pug|slim|coffee|nim)$|(^|\/)(Makefile|GNUmakefile)$/
const RISK_PATHS = [
  /migrat/i,
  /schema/i,
  /(^|[/_.-])(auth|authn|authz|oauth|session|sessions|permission|permissions|rbac|acl|security)([/_.-]|$)/i,
  /(^|[/_.-])(lock|locks|locking|mutex|semaphore|concurrency|concurrent)([/_.-]|$)/i,
  /(^|[/_.-])(workflow|workflows|state[-_]?machine)([/_.-]|$)/i,
]
const EXPORT_LINE = /^\s*(export\s|module\.exports\b|exports\.\w+\s*=|pub\s+(fn|struct|enum|trait|mod|type|const)\b)/
const REQUIREMENT_ID = /^id:\s*(REQ-\d+)\s*$/m

function git(root, args, { input, repair } = {}) {
  return checked('git', ['-C', root, ...args], { input, repair: repair ?? `Run git ${args.join(' ')} in ${root} to see the fault.` })
}

const exists = (root, ref, path) => run('git', ['-C', root, 'cat-file', '-e', `${ref}:${path}`]).status === 0

function commitOf(root, ref, what, repair) {
  const result = run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  if (result.status !== 0) throw new CliError(1, `${what} ${ref} is not a commit in ${root}.`, { repair })
  return result.stdout.trim()
}

function changes(root, base) {
  const output = git(root, ['diff', '--no-renames', '--numstat', '-z', `${base}...HEAD`])
  return output.split('\0').filter(Boolean).map(entry => {
    const [added, deleted, path] = entry.split('\t')
    return { path, lines: added === '-' ? 0 : Number(added) + Number(deleted) }
  })
}

function newExports(root, base, paths) {
  if (paths.length === 0) return 0
  const diff = git(root, ['--literal-pathspecs', 'diff', '--no-renames', '-U0', `${base}...HEAD`, '--', ...paths])
  const added = []
  const removed = new Set()
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+') && EXPORT_LINE.test(line.slice(1))) added.push(line.slice(1).trim())
    if (line.startsWith('-') && EXPORT_LINE.test(line.slice(1))) removed.add(line.slice(1).trim())
  }
  return added.filter(line => !removed.has(line)).length
}

function touchedRecords(root, base, paths) {
  if (!exists(root, 'HEAD', REQUIREMENTS) && !exists(root, base, REQUIREMENTS)) return []
  const ids = new Set()
  const present = paths.filter(path => exists(root, 'HEAD', path))
  for (const path of paths.filter(path => path.startsWith(`${REQUIREMENTS}/`))) {
    const text = exists(root, 'HEAD', path) ? readFileSync(join(root, path), 'utf8') : git(root, ['show', `${base}:${path}`])
    const id = text.match(REQUIREMENT_ID)?.[1]
    if (id) ids.add(id)
  }
  const targets = present.filter(path => !path.startsWith('docs/formal/'))
  if (targets.length > 0 && exists(root, 'HEAD', REQUIREMENTS)) {
    const output = checked(process.execPath, [join(releaseRoot, 'scripts/cli.mjs'), 'requirements', 'for', ...targets, '--root', root, '--json'], {
      cwd: root, timeout: 120_000, repair: `Run ndev requirements check in ${root} and fix the records it names.`,
    })
    for (const target of JSON.parse(output).result.targets) for (const record of target.records) ids.add(record.id)
  }
  return [...ids].sort()
}

function eventPull(file) {
  let event
  try {
    event = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new CliError(1, `The event file ${file} could not be read as JSON: ${error.message}`, { repair: 'Give --event the path of a GitHub pull_request event, or --pr <n>.' })
  }
  const pull = event.pull_request
  if (!pull) return null
  const head = pull.head?.repo?.full_name ?? '(deleted repository)'
  return {
    number: pull.number,
    labels: (pull.labels ?? []).map(label => label.name.toLowerCase()).sort(),
    draft: pull.draft === true,
    fork: head === pull.base?.repo?.full_name ? null : head,
  }
}

function ghPull(root, number) {
  const script = process.env.NDEV_FLOW_GH || join(releaseRoot, 'scripts/github/gh.sh')
  const output = checked('bash', [script, 'view-json', 'pr', String(number), '--fields', 'labels,isDraft,isCrossRepository,headRepositoryOwner,headRepository'], {
    cwd: root, repair: `Check gh auth status, and that pull request ${number} exists in this repository.`,
  })
  const pull = JSON.parse(output)
  return {
    number,
    labels: pull.labels.map(label => label.name.toLowerCase()).sort(),
    draft: pull.isDraft === true,
    fork: !pull.isCrossRepository ? null : pull.headRepositoryOwner && pull.headRepository ? `${pull.headRepositoryOwner.login}/${pull.headRepository.name}` : '(deleted repository)',
  }
}

function pullFacts(root, values) {
  if (values.pr && values.event) throw new CliError(2, 'Give --pr or --event, not both.', { repair: 'ndev proof plan --help' })
  if (values.pr) {
    if (!/^[1-9]\d*$/.test(values.pr)) throw new CliError(2, `--pr ${JSON.stringify(values.pr)} is not a pull request number.`, { repair: 'ndev proof plan --help' })
    return ghPull(root, Number(values.pr))
  }
  const file = values.event ?? process.env.GITHUB_EVENT_PATH
  return file ? eventPull(file) : null
}

const patchId = (root, diff) => diff.trim() === '' ? '' : git(root, ['patch-id', '--verbatim'], { input: `${diff}\n` }).split(' ')[0]

function sinceProven(root, base, proven) {
  const sha = commitOf(root, proven, 'The last proven commit', `Give --proven the full id of a commit in ${root}, or fetch it first.`)
  const short = sha.slice(0, 12)
  const changed = git(root, ['diff', '--name-only', '-z', sha, 'HEAD']).split('\0').filter(Boolean)
  if (changed.length === 0) return `no change since the last proven commit ${short}`
  const before = git(root, ['diff', '--no-renames', `${base}...${sha}`])
  const after = git(root, ['diff', '--no-renames', `${base}...HEAD`])
  if (patchId(root, before) === patchId(root, after)) return `only a rebase since the last proven commit ${short}`
  if (changed.some(path => WHITESPACE_SENSITIVE.test(path))) return undefined
  if (git(root, ['diff', '--ignore-space-at-eol', '--ignore-blank-lines', sha, 'HEAD']) === '') return `only formatting changes since the last proven commit ${short}`
  return undefined
}

function tierOf({ files, lines, docsOnly, newExports: exported, risk, records, deleted, labels }, tiers) {
  const complex = []
  const standard = []
  if (labels.includes(COMPLEX_LABEL)) complex.push(`the label ${COMPLEX_LABEL}`)
  for (const path of risk) complex.push(`risk path ${path}`)
  if (!docsOnly && lines >= tiers.large) complex.push(`${lines} changed lines, at least tiers.large (${tiers.large})`)
  if (!docsOnly && lines >= tiers.small && lines < tiers.large) standard.push(`${lines} changed lines, at least tiers.small (${tiers.small})`)
  if (!docsOnly && exported > 0) standard.push(`${exported} new exported interface${exported === 1 ? '' : 's'}`)
  for (const id of records) standard.push(`touches ${id}`)
  for (const path of deleted) standard.push(`deletes ${path}`)
  if (complex.length > 0) return { tier: 'complex', reasons: [...complex, ...standard] }
  if (standard.length > 0) return { tier: 'standard', reasons: standard }
  if (docsOnly) return { tier: 'trivial', reasons: ['docs-only change'] }
  return { tier: 'trivial', reasons: [`${lines} changed lines in ${files} file${files === 1 ? '' : 's'}, under tiers.small (${tiers.small}), with no new export, risk path or requirement record`] }
}

function checksFor({ settings, short, tier, stats, root }) {
  const off = `opted out in .ndev.json at ${short}`
  const site = DOCS_SITES.some(path => exists(root, 'HEAD', path))
  const hasServers = Object.keys(settings.devServers).length > 0
  const reasons = {
    requirements: !exists(root, 'HEAD', 'docs/formal') ? 'no docs/formal' : tier === 'trivial' ? 'trivial tier' : undefined,
    code: tier !== 'trivial' ? undefined : stats.docsOnly ? 'trivial tier: docs-only change' : 'trivial tier: no agent reads the diff',
    visual: stats.ui.length === 0 ? 'no UI files changed' : !hasServers ? `no devServers in .ndev.json at ${short}` : undefined,
    tests: stats.code.length === 0 ? 'no code files changed' : undefined,
    model: tier === 'complex' ? undefined : `only the complex tier needs a model; this change is ${tier}`,
    docs: !site ? 'no docs site' : stats.code.length === 0 ? 'no code files changed' : undefined,
    lessons: tier === 'trivial' ? 'trivial tier' : undefined,
  }
  return Object.fromEntries(Object.entries(reasons).map(([check, reason]) => {
    const why = settings.checks[check] === false ? off : reason
    return [check, why ? { action: 'skip', reason: why } : { action: 'run' }]
  }))
}

function skipFor({ settings, short, pr, root, base, proven }) {
  if (!settings.enabled) return `opted out in .ndev.json at ${short}`
  if (pr?.labels.includes(settings.label.toLowerCase())) return `the pull request has the label ${settings.label}`
  if (pr?.draft) return 'the pull request is a draft'
  if (pr?.fork && !process.env.ANTHROPIC_API_KEY) return `the pull request comes from the fork ${pr.fork}, and ANTHROPIC_API_KEY is not set`
  if (proven) return sinceProven(root, base, proven)
  return undefined
}

function summary({ base, short, head, tier, reasons, checks, skip }) {
  const lines = [`Proof plan for ${head.slice(0, 12)} against ${base} (${short}): ${tier}. ${reasons.join('; ')}.`]
  if (skip) lines.push(`Skip the run: ${skip.reason}.`)
  for (const [check, plan] of Object.entries(checks)) lines.push(`  ${check.padEnd(12)} ${plan.action === 'run' ? 'run' : `skip: ${plan.reason}`}`)
  return lines.join('\n')
}

export function plan(root, values) {
  const base = values.base
  const settings = proofSettingsAt(root, base)
  const baseSha = commitOf(root, base, 'The base ref', `git -C ${root} fetch origin ${base}`)
  const head = git(root, ['rev-parse', 'HEAD'])
  const short = baseSha.slice(0, 12)
  const pr = pullFacts(root, values)
  const changed = changes(root, base)
  const paths = changed.map(change => change.path)
  const counted = changed.filter(change => !LOCK_FILE.test(change.path))
  const code = paths.filter(path => CODE_FILE.test(path))
  const stats = {
    files: changed.length,
    lines: counted.reduce((sum, change) => sum + change.lines, 0),
    docsOnly: changed.length > 0 && paths.every(path => DOC_FILE.test(path) && !CODE_FILE.test(path)),
    newExports: newExports(root, base, code),
    risk: paths.filter(path => !LOCK_FILE.test(path) && !DOC_FILE.test(path) && RISK_PATHS.some(pattern => pattern.test(path))),
    records: touchedRecords(root, base, paths),
    ui: paths.filter(path => UI_FILE.test(path)),
    code,
  }
  const deleted = code.filter(path => !exists(root, 'HEAD', path))
  const { tier, reasons } = tierOf({ ...stats, deleted, labels: pr?.labels ?? [] }, settings.tiers)
  const checks = checksFor({ settings, short, tier, stats, root })
  const skipReason = skipFor({ settings, short, pr, root, base, proven: values.proven })
  const skip = skipReason ? { reason: skipReason } : null
  const result = { base, baseSha, head, tier, reasons, stats, pr, checks, skip, settings: settings.source }
  return { ...result, text: summary({ ...result, short }) }
}

export function runProof([verb, ...argv]) {
  const repair = `ndev proof ${verb} --help`
  if (verb === 'plan') {
    const { values } = argsFor(argv, { base: { type: 'string' }, pr: { type: 'string' }, event: { type: 'string' }, proven: { type: 'string' } }, repair)
    if (!values.base) throw new CliError(2, 'Give the base branch with --base <ref>.', { repair })
    return plan(gitWorkspace().root, values)
  }
  if (verb === 'evidence') {
    const { values } = argsFor(argv, { plan: { type: 'string' }, body: { type: 'string' } }, repair)
    if (!values.plan) throw new CliError(2, 'Give the plan file with --plan <file>, the output of ndev proof plan --json.', { repair })
    return evidence(gitWorkspace().root, values)
  }
  if (verb === 'snapshots') {
    const { values } = argsFor(argv, { pr: { type: 'string' }, routes: { type: 'string' }, out: { type: 'string' }, base: { type: 'string' }, local: { type: 'boolean' } }, repair)
    return snapshots(gitWorkspace().root, values)
  }
  if (verb === 'report') {
    const { values } = argsFor(argv, { plan: { type: 'string' }, verdict: { type: 'string' }, evidence: { type: 'string' }, grid: { type: 'string' }, pr: { type: 'string' }, local: { type: 'boolean' } }, repair)
    return report(gitWorkspace().root, values)
  }
  if (verb === 'run') {
    const { values } = argsFor(argv, { pr: { type: 'string' }, local: { type: 'boolean' }, base: { type: 'string' }, out: { type: 'string' }, body: { type: 'string' } }, repair)
    return proofRun(gitWorkspace().root, values)
  }
  if (verb === 'install') {
    const { values, positionals } = argsFor(argv, { 'dry-run': { type: 'boolean' }, yes: { type: 'boolean' }, force: { type: 'boolean' }, ref: { type: 'string' } }, repair, { positionals: 1 })
    return proofInstall(positionals[0], values)
  }
  throw new CliError(2, `Unknown proof command ${JSON.stringify(verb)}.`, { repair: 'ndev proof --help' })
}
