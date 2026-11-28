import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const executable = join(repoRoot, 'bin/ndev')

const RECORD = `---
id: REQ-0001
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
issues: []
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
    if (text === null) {
      rmSync(join(root, name))
      continue
    }
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), typeof text === 'string' ? text : `${JSON.stringify(text, null, 2)}\n`)
  }
}

function commit(root, files, message = 'change') {
  put(root, files)
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', message)
  return git(root, 'rev-parse', 'HEAD')
}

const lines = (count, word = 'line') => Array.from({ length: count }, (_, i) => `const ${word}${i} = ${i}`).join('\n') + '\n'

const baseFiles = {
  'README.md': '# Project\n',
  'src/util.js': 'function add(a, b) {\n  return a + b\n}\n',
  'src/report.js': 'function report() {\n  return []\n}\n',
}

function repository(t, files = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ndev-proof-plan-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'repo')
  git(base, 'init', '-q', '-b', 'main', root)
  const baseSha = commit(root, { ...baseFiles, ...files }, 'base')
  git(root, 'checkout', '-qb', 'work')
  return { base, root, baseSha }
}

function plan(root, args = [], env = {}) {
  const clean = { ...process.env }
  delete clean.ANTHROPIC_API_KEY
  delete clean.GITHUB_EVENT_PATH
  const result = spawnSync(executable, ['proof', 'plan', '--base', 'main', ...args, '--json'], { cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...clean, ...env } })
  assert.ifError(result.error)
  return result
}

function planned(root, args, env) {
  const result = plan(root, args, env)
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout).result
}

function event(base, pull) {
  const file = join(base, 'event.json')
  writeFileSync(file, JSON.stringify({
    pull_request: {
      number: 7,
      draft: pull.draft ?? false,
      labels: (pull.labels ?? []).map(name => ({ name })),
      head: { repo: { full_name: pull.head ?? 'o/r' } },
      base: { repo: { full_name: 'o/r' } },
    },
  }))
  return ['--event', file]
}

const ran = { action: 'run' }
const skipped = reason => ({ action: 'skip', reason })

test('a docs-only change is trivial and skips the code, tests, model and lessons checks', t => {
  const { root, baseSha } = repository(t)
  commit(root, { 'README.md': '# Project\n\nMore words.\n' })
  const result = planned(root)
  assert.equal(result.tier, 'trivial')
  assert.equal(result.baseSha, baseSha)
  assert.equal(result.skip, null)
  assert.deepEqual(result.checks, {
    requirements: skipped('no docs/formal'),
    code: skipped('trivial tier: docs-only change'),
    visual: skipped('no UI files changed'),
    tests: skipped('no code files changed'),
    model: skipped('only the complex tier needs a model; this change is trivial'),
    docs: skipped('no docs site'),
    lessons: skipped('trivial tier'),
  })
  assert.deepEqual(result.stats, { files: 1, lines: 2, docsOnly: true, newExports: 0, risk: [], records: [], ui: [], code: [] })
})

test('a small code change with no export, risk path or record is trivial: no agent reads its code, and its tests are checked', t => {
  const { root } = repository(t)
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n' })
  const result = planned(root)
  assert.equal(result.tier, 'trivial')
  assert.deepEqual(result.checks.code, skipped('trivial tier: no agent reads the diff'))
  assert.deepEqual(result.checks.tests, ran)
  assert.deepEqual(result.checks.lessons, skipped('trivial tier'))
  assert.deepEqual(result.stats.code, ['src/util.js'])
})

test('a new exported interface makes a small change standard', t => {
  const { root } = repository(t)
  commit(root, { 'src/util.js': 'export function add(a, b) {\n  return a + b\n}\n' })
  const result = planned(root)
  assert.equal(result.tier, 'standard')
  assert.equal(result.stats.newExports, 1)
  assert.ok(result.reasons.includes('1 new exported interface'), result.reasons.join('; '))
  assert.deepEqual(result.checks.lessons, ran)
  assert.deepEqual(result.checks.model, skipped('only the complex tier needs a model; this change is standard'))
})

test('a change of at least tiers.small lines is standard, and of at least tiers.large lines is complex', t => {
  const { root } = repository(t, { '.ndev.json': { proof: { tiers: { small: 10, large: 30 } } } })
  commit(root, { 'src/more.js': lines(12) })
  assert.equal(planned(root).tier, 'standard')
  commit(root, { 'src/more.js': lines(30) })
  const result = planned(root)
  assert.equal(result.tier, 'complex')
  assert.ok(result.reasons.includes('30 changed lines, at least tiers.large (30)'), result.reasons.join('; '))
  assert.deepEqual(result.checks.model, ran)
})

test('lock files count as changed files but not as changed lines', t => {
  const { root } = repository(t)
  commit(root, { 'package-lock.json': lines(900), 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n' })
  const result = planned(root)
  assert.equal(result.tier, 'trivial')
  assert.equal(result.stats.files, 2)
  assert.equal(result.stats.lines, 2)
})

for (const path of ['db/migrations/0002_add.sql', 'src/auth/session.js', 'src/schema.ts', 'src/queue-lock.js', 'scripts/workflow/state.ts']) {
  test(`a change to the risk path ${path} is complex`, t => {
    const { root } = repository(t)
    commit(root, { [path]: 'const x = 1\n' })
    const result = planned(root)
    assert.equal(result.tier, 'complex')
    assert.deepEqual(result.stats.risk, [path])
    assert.ok(result.reasons.includes(`risk path ${path}`), result.reasons.join('; '))
  })
}

test('the proof:complex label raises the tier', t => {
  const { base, root } = repository(t)
  commit(root, { 'README.md': '# Project\n\nMore.\n' })
  const result = planned(root, event(base, { labels: ['proof:complex'] }))
  assert.equal(result.tier, 'complex')
  assert.ok(result.reasons.includes('the label proof:complex'), result.reasons.join('; '))
  assert.deepEqual(result.checks.model, ran)
})

test('a touched requirement record makes a small change standard and runs the requirements check', t => {
  const { root } = repository(t, { 'docs/guide.md': '# Guide\n\nThe report names each source.\n', 'docs/formal/requirements/0001-the-report-names-each-source.md': RECORD })
  commit(root, { 'src/report.js': 'function report() {\n  return ["a"]\n}\n' })
  const result = planned(root)
  assert.equal(result.tier, 'standard')
  assert.deepEqual(result.stats.records, ['REQ-0001'])
  assert.ok(result.reasons.includes('touches REQ-0001'), result.reasons.join('; '))
  assert.deepEqual(result.checks.requirements, ran)
})

test('a deleted file does not stop the requirement lookup', t => {
  const { root } = repository(t, { 'docs/guide.md': '# Guide\n\nThe report names each source.\n', 'docs/formal/requirements/0001-the-report-names-each-source.md': RECORD })
  commit(root, { 'src/util.js': null, 'src/report.js': 'function report() {\n  return ["a"]\n}\n' })
  assert.deepEqual(planned(root).stats.records, ['REQ-0001'])
})

test('a UI change runs the visual check only when the base names dev servers', t => {
  const server = { web: { command: 'npm run dev', port: 3000, ready: 'http://localhost:3000/' } }
  const withServers = repository(t, { '.ndev.json': { devServers: server } })
  commit(withServers.root, { 'src/Button.tsx': 'export const Button = () => null\n' })
  const result = planned(withServers.root)
  assert.deepEqual(result.checks.visual, ran)
  assert.deepEqual(result.stats.ui, ['src/Button.tsx'])

  const without = repository(t)
  commit(without.root, { '.ndev.json': { devServers: server }, 'src/Button.tsx': 'export const Button = () => null\n' })
  assert.deepEqual(planned(without.root).checks.visual, skipped(`no devServers in .ndev.json at ${without.baseSha.slice(0, 12)}`))
})

test('a code change with a docs site runs the docs check', t => {
  const { root } = repository(t, { 'docs-site/content/index.md': '# Docs\n' })
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n' })
  assert.deepEqual(planned(root).checks.docs, ran)
})

test('a check turned off at the base is skipped, and the PR cannot turn checks off for itself', t => {
  const { root, baseSha } = repository(t, { '.ndev.json': { proof: { checks: { tests: false } } } })
  commit(root, { '.ndev.json': { proof: { enabled: false, checks: { tests: true } } }, 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n' })
  const result = planned(root)
  assert.equal(result.skip, null)
  assert.deepEqual(result.checks.tests, skipped(`opted out in .ndev.json at ${baseSha.slice(0, 12)}`))
  assert.deepEqual(result.checks.code, skipped('trivial tier: no agent reads the diff'))
})

test('Proof turned off at the base skips the run', t => {
  const { root, baseSha } = repository(t, { '.ndev.json': { proof: { enabled: false } } })
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n' })
  assert.deepEqual(planned(root).skip, { reason: `opted out in .ndev.json at ${baseSha.slice(0, 12)}` })
})

test('the opt-out label from the base config skips the run', t => {
  const { base, root } = repository(t, { '.ndev.json': { proof: { label: 'skip-proof' } } })
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n' })
  assert.deepEqual(planned(root, event(base, { labels: ['skip-proof'] })).skip, { reason: 'the pull request has the label skip-proof' })
  assert.equal(planned(root, event(base, { labels: ['no-proof'] })).skip, null)
})

test('a draft pull request skips the run', t => {
  const { base, root } = repository(t)
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n' })
  assert.deepEqual(planned(root, event(base, { draft: true })).skip, { reason: 'the pull request is a draft' })
})

test('a pull request from a fork skips the run only when ANTHROPIC_API_KEY is not set', t => {
  const { base, root } = repository(t)
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n' })
  const fork = event(base, { head: 'someone/r' })
  assert.deepEqual(planned(root, fork).skip, { reason: 'the pull request comes from the fork someone/r, and ANTHROPIC_API_KEY is not set' })
  assert.equal(planned(root, fork, { ANTHROPIC_API_KEY: 'x' }).skip, null)
})

test('the event file comes from GITHUB_EVENT_PATH when no --event or --pr is given', t => {
  const { base, root } = repository(t)
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n' })
  const [, file] = event(base, { draft: true })
  assert.deepEqual(planned(root, [], { GITHUB_EVENT_PATH: file }).skip, { reason: 'the pull request is a draft' })
})

test('--pr reads the labels, draft state and fork through gh.sh', t => {
  const { base, root } = repository(t)
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n' })
  const script = join(base, 'gh.sh')
  writeFileSync(script, `[ "$*" = "view-json pr 7 --fields labels,isDraft,isCrossRepository,headRepositoryOwner,headRepository" ] || { echo "unexpected: $*" >&2; exit 9; }\necho '{"labels":[{"name":"proof:complex"}],"isDraft":false,"isCrossRepository":false,"headRepositoryOwner":{"login":"o"},"headRepository":{"name":"r"}}'\n`)
  const result = planned(root, ['--pr', '7'], { NDEV_FLOW_GH: script })
  assert.equal(result.tier, 'complex')
  assert.deepEqual(result.pr, { number: 7, labels: ['proof:complex'], draft: false, fork: null })
})

test('only a rebase since the last proven commit skips the run', t => {
  const { root } = repository(t)
  const proven = commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n' })
  git(root, 'checkout', '-q', 'main')
  commit(root, { 'README.md': '# Project\n\nBase moved.\n' })
  git(root, 'checkout', '-q', 'work')
  git(root, 'rebase', '-q', 'main')
  assert.deepEqual(planned(root, ['--proven', proven]).skip, { reason: `only a rebase since the last proven commit ${proven.slice(0, 12)}` })
})

test('only formatting changes since the last proven commit skip the run', t => {
  const { root } = repository(t)
  const proven = commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n' })
  commit(root, { 'src/util.js': 'function add(a, b) {\n\n  return b + a  \n}\n' })
  assert.deepEqual(planned(root, ['--proven', proven]).skip, { reason: `only formatting changes since the last proven commit ${proven.slice(0, 12)}` })
})

for (const [name, before, after] of [
  ['a space inside a string', 'const s = "a b"\n', 'const s = "a  b"\n'],
  ['a space between tokens', '[ a = b ] && go\n', '[a=b] && go\n'],
  ['a change of indentation', 'function f() {\n  return 1\n}\n', 'function f() {\n    return 1\n}\n'],
]) {
  test(`${name} since the last proven commit runs`, t => {
    const { root } = repository(t)
    const proven = commit(root, { 'src/c.js': before })
    commit(root, { 'src/c.js': after })
    assert.equal(planned(root, ['--proven', proven]).skip, null)
  })
}

test('a manifest .txt file is not documentation', t => {
  const { root } = repository(t)
  commit(root, { 'requirements.txt': 'requests==2.0\n' })
  const result = planned(root)
  assert.equal(result.stats.docsOnly, false)
  assert.deepEqual(result.checks.code, skipped('trivial tier: no agent reads the diff'))
})

test('a path with glob characters counts its new exports', t => {
  const { root } = repository(t)
  commit(root, { 'src/[id].tsx': 'export const Page = () => null\n' })
  assert.equal(planned(root).stats.newExports, 1)
})

test('a deleted requirement record counts as touched', t => {
  const { root } = repository(t, { 'docs/guide.md': '# Guide\n\nThe report names each source.\n', 'docs/formal/requirements/0001-the-report-names-each-source.md': RECORD, 'docs/formal/README.md': '# Formal\n' })
  commit(root, { 'docs/formal/requirements/0001-the-report-names-each-source.md': null })
  const result = planned(root)
  assert.deepEqual(result.stats.records, ['REQ-0001'])
  assert.equal(result.tier, 'standard')
})

test('a deleted code file makes the change standard', t => {
  const { root } = repository(t)
  commit(root, { 'src/util.js': null })
  const result = planned(root)
  assert.equal(result.tier, 'standard')
  assert.ok(result.reasons.includes('deletes src/util.js'), result.reasons.join('; '))
})

test('labels match without regard to case', t => {
  const { base, root } = repository(t)
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n' })
  assert.deepEqual(planned(root, event(base, { labels: ['No-Proof'] })).skip, { reason: 'the pull request has the label no-proof' })
  assert.equal(planned(root, event(base, { labels: ['Proof:Complex'] })).tier, 'complex')
})

test('an indentation change in a whitespace-sensitive file since the last proven commit runs', t => {
  const { root } = repository(t)
  const proven = commit(root, { 'tool.py': 'if ready:\n    go()\nstop()\n' })
  commit(root, { 'tool.py': 'if ready:\n    go()\n    stop()\n' })
  assert.equal(planned(root, ['--proven', proven]).skip, null)
})

test('a real change since the last proven commit runs', t => {
  const { root } = repository(t)
  const proven = commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n' })
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return a + b + 0\n}\n' })
  assert.equal(planned(root, ['--proven', proven]).skip, null)
})

test('the same diff and config give the same plan', t => {
  const { root } = repository(t)
  commit(root, { 'src/util.js': 'export function add(a, b) {\n  return a + b\n}\n' })
  const first = plan(root)
  assert.equal(first.status, 0, first.stderr)
  assert.equal(plan(root).stdout, first.stdout)
})

test('a base that is not a commit fails with the fetch command', t => {
  const { root } = repository(t)
  const bad = spawnSync(executable, ['proof', 'plan', '--base', 'nowhere', '--json'], { cwd: root, encoding: 'utf8' })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr + bad.stdout, /The base ref nowhere is not a commit/)
  assert.match(bad.stderr + bad.stdout, /git -C .* fetch origin nowhere/)
})

test('a proven commit that is not a commit fails with its name', t => {
  const { root } = repository(t)
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n' })
  const result = plan(root, ['--proven', 'deadbeef'])
  assert.equal(result.status, 1)
  assert.match(result.stderr + result.stdout, /The last proven commit deadbeef is not a commit/)
})
