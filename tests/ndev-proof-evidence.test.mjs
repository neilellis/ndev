import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const executable = join(repoRoot, 'bin/ndev')

const record = (id, { model = [] } = {}) => `---
id: ${id}
title: "The report names each source"
status: Accepted
origin: explicit
level: normal
type: product
section: "Report"
date: 2026-01-02
source: "docs/guide.md#L3-L3"
author:
  - "Neil Ellis"
decided_by: "Neil Ellis"
verification: unassigned
${model.length ? `model:\n${model.map(entry => `  - ${entry}`).join('\n')}\n` : ''}issues: []
prs: []
---

## Statement

The report names each source.

## Explanation

The report gives a list of each document that it uses. A source is a document that the report reads.

## Source text

- docs/guide.md#L3-L3

> The report names each source.

## Trace

- File: src/report.js

## Notes



## Log

- 2026-01-02: Created.
`

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

function put(root, files) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), text)
  }
}

function commit(root, files, message = 'change') {
  put(root, files)
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', message)
  return git(root, 'rev-parse', 'HEAD')
}

const baseFiles = {
  'README.md': '# Project\n',
  'docs/guide.md': '# Guide\n\nThe report names each source.\n',
  'src/util.js': 'function add(a, b) {\n  return a + b\n}\n',
  'src/report.js': 'function report() {\n  return []\n}\n',
}

const withRecords = { 'docs/formal/requirements/0001-the-report-names-each-source.md': record('REQ-0001') }
const withSite = { 'docs-site/content/guide.md': '# Guide\n' }

function repository(t, files = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ndev-proof-evidence-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'repo')
  git(base, 'init', '-q', '-b', 'main', root)
  commit(root, { ...baseFiles, ...files }, 'base')
  git(root, 'checkout', '-qb', 'work')
  return { base, root }
}

function cleanEnv(env) {
  const clean = { ...process.env }
  delete clean.ANTHROPIC_API_KEY
  delete clean.GITHUB_EVENT_PATH
  delete clean.NDEV_FLOW_GH
  return { ...clean, ...env }
}

function ndev(root, args, env = {}) {
  const result = spawnSync(executable, [...args, '--json'], { cwd: root, encoding: 'utf8', timeout: 120_000, env: cleanEnv(env) })
  assert.ifError(result.error)
  return result
}

function planFile(base, root, args = [], edit = plan => plan) {
  const result = ndev(root, ['proof', 'plan', '--base', 'main', ...args])
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  const file = join(base, 'plan.json')
  writeFileSync(file, JSON.stringify(edit(JSON.parse(result.stdout).result)))
  return file
}

function bodyFile(base, text) {
  const file = join(base, 'body.md')
  writeFileSync(file, text)
  return file
}

function evidence(base, root, { plan, body, env } = {}) {
  const args = ['proof', 'evidence', '--plan', plan ?? planFile(base, root)]
  if (body !== undefined) args.push('--body', bodyFile(base, body))
  const result = ndev(root, args, env)
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  return JSON.parse(result.stdout).result
}

function complexEvent(base) {
  const file = join(base, 'event.json')
  writeFileSync(file, JSON.stringify({
    pull_request: { number: 7, draft: false, labels: [{ name: 'proof:complex' }], head: { repo: { full_name: 'o/r' } }, base: { repo: { full_name: 'o/r' } } },
  }))
  return ['--event', file]
}

const LESSONS = '## Lessons\n\n- A lesson.\n'

test('requirements: the cited records with their states, and the verify report', t => {
  const { base, root } = repository(t, withRecords)
  commit(root, { 'src/report.js': 'function report() {\n  return ["guide"]\n}\n' }, 'Name the sources (REQ-0001)')
  const result = evidence(base, root, { body: `Meets the record.\n\n${LESSONS}` })
  const found = result.evidence.requirements
  assert.equal(found.state, 'present')
  assert.deepEqual(found.cited, ['REQ-0001'])
  assert.deepEqual(found.records, [{ id: 'REQ-0001', title: 'The report names each source', status: 'Accepted', path: 'docs/formal/requirements/0001-the-report-names-each-source.md' }])
  assert.equal(found.verify.command, 'ndev requirements verify --base main')
  assert.deepEqual(found.verify.report.requirements.map(entry => entry.id), ['REQ-0001'])
})

test('requirements: an identifier from a linked issue with no record is reported as not found', t => {
  const { base, root } = repository(t, withRecords)
  commit(root, { 'src/report.js': 'function report() {\n  return ["guide"]\n}\n' })
  const script = join(base, 'gh.sh')
  writeFileSync(script, '[ "$*" = "issue-read 12" ] || { echo "unexpected: $*" >&2; exit 9; }\necho \'{"number":12,"title":"t","state":"open","body":"Needs REQ-0001 and REQ-0009.","url":"u"}\'\n')
  const result = evidence(base, root, { body: `Closes #12.\n\n${LESSONS}`, env: { NDEV_FLOW_GH: script } })
  assert.deepEqual(result.evidence.requirements.cited, ['REQ-0001', 'REQ-0009'])
  assert.deepEqual(result.evidence.requirements.records[1], { id: 'REQ-0009', found: false })
})

test('requirements: no cited identifier is missing', t => {
  const { base, root } = repository(t, withRecords)
  commit(root, { 'src/report.js': 'function report() {\n  return ["guide"]\n}\n' })
  const found = evidence(base, root, { body: `No record.\n\n${LESSONS}` }).evidence.requirements
  assert.equal(found.state, 'missing')
  assert.deepEqual(found.cited, [])
})

test('requirements: a verify that cannot run is not-run, with the command and its output', t => {
  const { base, root } = repository(t, withRecords)
  commit(root, { 'src/report.js': 'function report() {\n  return ["guide"]\n}\n' }, 'REQ-0001')
  const plan = planFile(base, root)
  writeFileSync(join(root, 'src/report.js'), 'function report() {\n  return ["dirty"]\n}\n')
  const found = evidence(base, root, { plan, body: LESSONS }).evidence.requirements
  assert.equal(found.state, 'not-run')
  assert.equal(found.command, 'ndev requirements verify --base main')
  assert.match(found.output, /the worktree has changes/)
})

test('requirements: a closing reference in a commit message reads that issue', t => {
  const { base, root } = repository(t, withRecords)
  commit(root, { 'src/report.js': 'function report() {\n  return ["guide"]\n}\n' }, 'Name the sources\n\nFixes #12.')
  const script = join(base, 'gh.sh')
  writeFileSync(script, '[ "$*" = "issue-read 12" ] || { echo "unexpected: $*" >&2; exit 9; }\necho \'{"number":12,"title":"t","state":"open","body":"Needs REQ-0001.","url":"u"}\'\n')
  assert.deepEqual(evidence(base, root, { body: LESSONS, env: { NDEV_FLOW_GH: script } }).evidence.requirements.cited, ['REQ-0001'])
})

test('requirements: an issue of a commit message that gh.sh cannot read is not-run, and the other checks still run', t => {
  const { base, root } = repository(t, withRecords)
  commit(root, { 'src/report.js': 'function report() {\n  return ["guide"]\n}\n' }, 'Name the sources\n\nCloses #12.')
  const script = join(base, 'gh.sh')
  writeFileSync(script, 'echo "HTTP 404: Could not resolve to an issue" >&2\nexit 1\n')
  const result = evidence(base, root, { body: LESSONS, env: { NDEV_FLOW_GH: script } })
  assert.equal(result.evidence.requirements.state, 'not-run')
  assert.equal(result.evidence.requirements.command, 'gh.sh issue-read 12')
  assert.match(result.evidence.requirements.output, /Could not resolve to an issue/)
  assert.equal(result.evidence.lessons.state, 'present')
})

test('requirements: with no pull request body to read, the collector is not-run', t => {
  const { base, root } = repository(t, withRecords)
  commit(root, { 'src/report.js': 'function report() {\n  return ["guide"]\n}\n' }, 'REQ-0001')
  const found = evidence(base, root).evidence.requirements
  assert.equal(found.state, 'not-run')
  assert.match(found.reason, /no pull request body/)
})

test('lessons: a body that gh.sh cannot read is not-run, with the command and its output', t => {
  const { base, root } = repository(t)
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n'.repeat(30) })
  const script = join(base, 'gh.sh')
  writeFileSync(script, 'case "$*" in "view-json pr 7 "*) echo \'{"labels":[],"isDraft":false,"isCrossRepository":false}\' ;; *) echo "gh: not logged in" >&2; exit 4 ;; esac\n')
  const env = { NDEV_FLOW_GH: script }
  const result = ndev(root, ['proof', 'plan', '--base', 'main', '--pr', '7'], env)
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  const plan = join(base, 'plan.json')
  writeFileSync(plan, result.stdout)
  const found = evidence(base, root, { plan, env }).evidence.lessons
  assert.deepEqual({ ...found, output: undefined }, { state: 'not-run', command: 'gh.sh pr-read 7', output: undefined })
  assert.match(found.output, /not logged in/)
})

test('request: the pull request body, and the number, title and body of each issue that it closes', t => {
  const { base, root } = repository(t)
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n'.repeat(30) })
  const script = join(base, 'gh.sh')
  writeFileSync(script, 'case "$*" in "issue-read 12") echo \'{"number":12,"title":"Add sub","state":"open","body":"Sub subtracts.","url":"u"}\' ;; "issue-read 13") echo \'{"number":13,"title":"Fix add","state":"open","body":"Add adds.","url":"u"}\' ;; *) echo "unexpected: $*" >&2; exit 9 ;; esac\n')
  const body = `Fixes #12 and resolves #13. Closes #12.\n\n${LESSONS}`
  const result = evidence(base, root, { body, env: { NDEV_FLOW_GH: script } })
  assert.equal(result.tier, 'standard')
  assert.deepEqual(result.request, { state: 'present', body, issues: [{ number: 12, title: 'Add sub', body: 'Sub subtracts.' }, { number: 13, title: 'Fix add', body: 'Add adds.' }] })
})

test('request: an issue that gh.sh cannot read fails fast, with the number, the gh output and the repair', t => {
  const { base, root } = repository(t)
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n'.repeat(30) })
  const script = join(base, 'gh.sh')
  writeFileSync(script, 'echo "HTTP 404: Could not resolve to an issue" >&2\nexit 1\n')
  const result = ndev(root, ['proof', 'evidence', '--plan', planFile(base, root), '--body', bodyFile(base, `Closes #12.\n\n${LESSONS}`)], { NDEV_FLOW_GH: script })
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`)
  const { error } = JSON.parse(result.stdout)
  assert.match(error.message, /issue #12/)
  assert.match(error.message, /Could not resolve to an issue/)
  assert.match(error.repair, /gh auth status/)
  assert.match(error.repair, /#12/)
  assert.match(error.repair, /The evidence stops at issue #12/)
})

test('request: an issue read whose output is not JSON fails, with the gh command and the start of the output', t => {
  const { base, root } = repository(t)
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n'.repeat(30) })
  const script = join(base, 'gh.sh')
  writeFileSync(script, 'echo "<html>rate limited</html>"\n')
  const result = ndev(root, ['proof', 'evidence', '--plan', planFile(base, root), '--body', bodyFile(base, `Closes #12.\n\n${LESSONS}`)], { NDEV_FLOW_GH: script })
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`)
  const { error } = JSON.parse(result.stdout)
  assert.match(error.message, /gh\.sh issue-read 12/)
  assert.match(error.message, /<html>rate limited<\/html>/)
  assert.doesNotMatch(error.message, /^Unexpected token/)
  assert.match(error.repair, /gh/)
})

test('tests: a test whose name only contains the source name is not near it', t => {
  const { base, root } = repository(t)
  commit(root, { 'src/a.js': 'function a() {}\n', 'tests/data.test.js': 'test()\n' })
  assert.deepEqual(evidence(base, root, { body: LESSONS }).evidence.tests, { state: 'missing', untested: ['src/a.js'], tests: ['tests/data.test.js'] })
})

test('tests: only test files changed needs no other test', t => {
  const { base, root } = repository(t)
  commit(root, { 'tests/util.test.js': 'test()\n' })
  assert.deepEqual(evidence(base, root, { body: LESSONS }).evidence.tests, { state: 'not-needed', untested: [], tests: ['tests/util.test.js'] })
})

test('tests: a changed source with a changed test nearby is present', t => {
  const { base, root } = repository(t)
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n', 'tests/util.test.js': 'test()\n' })
  const found = evidence(base, root, { body: LESSONS }).evidence.tests
  assert.deepEqual(found, { state: 'present', untested: [], tests: ['tests/util.test.js'] })
})

test('tests: a changed source with no test changed nearby is missing', t => {
  const { base, root } = repository(t)
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n', 'tests/other.test.js': 'test()\n' })
  const found = evidence(base, root, { body: LESSONS }).evidence.tests
  assert.deepEqual(found, { state: 'missing', untested: ['src/util.js'], tests: ['tests/other.test.js'] })
})

test('tests: a diff that cannot be read is not-run, with the command and its output', t => {
  const { base, root } = repository(t)
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n' })
  const plan = planFile(base, root, [], result => ({ ...result, base: 'gone' }))
  const found = evidence(base, root, { plan, body: LESSONS }).evidence.tests
  assert.equal(found.state, 'not-run')
  assert.match(found.command, /^git diff/)
  assert.match(found.output, /gone/)
})

test('model: a complex change with no model is missing', t => {
  const { base, root } = repository(t)
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n' })
  const found = evidence(base, root, { plan: planFile(base, root, complexEvent(base)), body: LESSONS }).evidence.model
  assert.deepEqual(found, { state: 'missing', models: [], added: [] })
})

test('model: a model of a touched record with no Quint installed is not-run', t => {
  const { base, root } = repository(t, {
    'docs/formal/requirements/0001-the-report-names-each-source.md': record('REQ-0001', { model: ['docs/formal/models/report.qnt#report'] }),
    'docs/formal/models/report.qnt': 'module report {}\n',
    'docs/formal/models/report.json': '{"model":"report.qnt"}\n',
  })
  commit(root, { 'src/report.js': 'function report() {\n  return ["guide"]\n}\n' })
  const found = evidence(base, root, { plan: planFile(base, root, complexEvent(base)), body: LESSONS }).evidence.model
  assert.equal(found.state, 'not-run')
  assert.deepEqual(found.models, ['docs/formal/models/report.qnt'])
  assert.equal(found.command, 'ndev requirements model-check')
  assert.match(found.output, /node_modules\/\.bin\/quint is missing/)
})

test('model: an added model is present, with the model-check result', t => {
  const { base, root } = repository(t)
  put(root, { 'node_modules/.bin/quint': '#!/bin/sh\nexit 0\n', '.gitignore': 'node_modules\n' })
  chmodSync(join(root, 'node_modules/.bin/quint'), 0o755)
  commit(root, { 'docs/formal/models/util.qnt': 'module util {}\n', 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n' })
  const found = evidence(base, root, { plan: planFile(base, root, complexEvent(base)), body: LESSONS }).evidence.model
  assert.equal(found.state, 'present')
  assert.deepEqual(found.added, ['docs/formal/models/util.qnt'])
  assert.equal(found.check.exit, 1)
  assert.match(found.check.output, /no manifest/)
})

test('model: a standard change keeps the skip of the plan', t => {
  const { base, root } = repository(t)
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n' })
  assert.deepEqual(evidence(base, root, { body: LESSONS }).evidence.model, { state: 'skipped', reason: 'only the complex tier needs a model; this change is trivial' })
})

test('docs: a code change with a docs-site change is present', t => {
  const { base, root } = repository(t, withSite)
  commit(root, { 'src/components/Button.tsx': 'export const Button = () => null\n', 'docs-site/content/guide.md': '# Guide\n\nThe button.\n' })
  assert.deepEqual(evidence(base, root, { body: LESSONS }).evidence.docs, { state: 'present', changed: ['docs-site/content/guide.md'], undocumented: [] })
})

test('docs: a user-facing change with no docs-site change is missing', t => {
  const { base, root } = repository(t, withSite)
  commit(root, { 'src/components/Button.tsx': 'export const Button = () => null\n', 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n' })
  assert.deepEqual(evidence(base, root, { body: LESSONS }).evidence.docs, { state: 'missing', changed: [], undocumented: ['src/components/Button.tsx'] })
})

test('docs: an internal change with no docs-site change needs no docs', t => {
  const { base, root } = repository(t, withSite)
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n' })
  assert.deepEqual(evidence(base, root, { body: LESSONS }).evidence.docs, { state: 'not-needed', changed: [], undocumented: [] })
})

test('docs: a diff that cannot be read is not-run', t => {
  const { base, root } = repository(t, withSite)
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n' })
  const plan = planFile(base, root, [], result => ({ ...result, base: 'gone' }))
  const found = evidence(base, root, { plan, body: LESSONS }).evidence.docs
  assert.equal(found.state, 'not-run')
  assert.match(found.output, /gone/)
})

test('lessons: present, empty and missing come from the PR body', t => {
  const { base, root } = repository(t)
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n'.repeat(30) })
  const plan = planFile(base, root)
  assert.deepEqual(evidence(base, root, { plan, body: `Intro.\n\n## Lessons\n\n- Read the base.\n\n## Other\n\nText.\n` }).evidence.lessons, { state: 'present', text: '- Read the base.' })
  assert.deepEqual(evidence(base, root, { plan, body: 'Intro.\n\n## Lessons\n\n## Other\n' }).evidence.lessons, { state: 'empty', text: '' })
  assert.deepEqual(evidence(base, root, { plan, body: 'Intro.\n' }).evidence.lessons, { state: 'missing' })
})

test('lessons: the body comes from gh.sh for the plan pull request', t => {
  const { base, root } = repository(t)
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n'.repeat(30) })
  const script = join(base, 'gh.sh')
  writeFileSync(script, 'case "$*" in "view-json pr 7 "*) echo \'{"labels":[],"isDraft":false,"isCrossRepository":false}\' ;; "pr-read 7") echo \'{"number":7,"body":"## Lessons\\n\\n- From GitHub.\\n"}\' ;; *) echo "unexpected: $*" >&2; exit 9 ;; esac\n')
  const env = { NDEV_FLOW_GH: script }
  const result = ndev(root, ['proof', 'plan', '--base', 'main', '--pr', '7'], env)
  assert.equal(result.status, 0, result.stderr)
  const plan = join(base, 'plan.json')
  writeFileSync(plan, result.stdout)
  assert.deepEqual(evidence(base, root, { plan, env }).evidence.lessons, { state: 'present', text: '- From GitHub.' })
})

test('lessons: with no PR body to read, the collector is not-run', t => {
  const { base, root } = repository(t)
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n'.repeat(30) })
  const found = evidence(base, root).evidence.lessons
  assert.equal(found.state, 'not-run')
  assert.match(found.reason, /no pull request body/)
})

test('a plan for another commit is refused, with the repair', t => {
  const { base, root } = repository(t)
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n' })
  const plan = planFile(base, root)
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return a + b + 0\n}\n' })
  const result = ndev(root, ['proof', 'evidence', '--plan', plan, '--body', bodyFile(base, LESSONS)])
  assert.equal(result.status, 1)
  const error = JSON.parse(result.stdout)
  assert.match(error.error.message, /is for [0-9a-f]{12}, and HEAD is [0-9a-f]{12}/)
  assert.match(error.error.repair, /ndev proof plan/)
})

test('a skipped run gives no evidence', t => {
  const { base, root } = repository(t, { '.ndev.json': JSON.stringify({ proof: { enabled: false } }) })
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n' })
  const result = evidence(base, root, { body: LESSONS })
  assert.deepEqual(result.skip, { reason: `opted out in .ndev.json at ${git(root, 'rev-parse', 'main').slice(0, 12)}` })
  assert.deepEqual(result.evidence, {})
})

test('the evidence file is the same on a second run', t => {
  const { base, root } = repository(t, withSite)
  commit(root, { 'src/components/Button.tsx': 'export const Button = () => null\n' })
  const plan = planFile(base, root)
  const first = evidence(base, root, { plan, body: LESSONS })
  assert.deepEqual(evidence(base, root, { plan, body: LESSONS }), first)
  assert.equal(readFileSync(plan, 'utf8').length > 0, true)
})
