// Tests for notify.sh, merge.sh and fast-checks-template.sh. Fake alerter, orca and gh programs stand in for the real ones:
// no test raises a real alert or calls GitHub. Run: node --test scripts/workflow/tests/workflow_scripts.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const NOTIFY = join(HERE, '..', 'notify.sh')
const MERGE = join(HERE, '..', 'merge.sh')

const folder = () => realpathSync(mkdtempSync(join(tmpdir(), 'wf-scripts-')))
const program = (dir, name, body) => {
  const path = join(dir, name)
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}
const lines = path => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : [])
// Waits with a real clock only because the watcher is detached: it has no other signal.
const until = (check, what) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    spawnSync('sleep', ['0.05'])
  }
  assert.fail(`timed out waiting for ${what}`)
}

// ---- notify.sh ----
const notifyEnv = (dir, answer) => ({
  ...process.env,
  NDEV_ALERTER: program(dir, 'alerter', `echo "$*" >> "${dir}/alerter.log"\n[ "$1" = --remove ] && exit 0\n${answer}`),
  NDEV_ORCA: program(dir, 'orca', `echo "$*" >> "${dir}/orca.log"`),
})
const raise = (dir, env, ...extra) =>
  spawnSync('bash', [NOTIFY, 'raise', '--group', 'g1', '--title', 'T', '--message', 'M', '--log', join(dir, 'n.log'), ...extra], { encoding: 'utf8', env })

test('raise prints the watcher pid, and a click switches to the Orca terminal', () => {
  const dir = folder()
  const r = raise(dir, notifyEnv(dir, 'echo @CONTENTCLICKED'), '--terminal', 't-1')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout.trim(), /^\d+$/)
  until(() => lines(join(dir, 'orca.log')).length > 0, 'the Orca switch')
  assert.deepEqual(lines(join(dir, 'orca.log')), ['terminal switch --terminal t-1'])
  assert.match(lines(join(dir, 'alerter.log'))[0], /--group g1/)
})

test('a dismissed alert does not switch the terminal, and the log says what came back', () => {
  const dir = folder()
  raise(dir, notifyEnv(dir, 'echo @CLOSED'), '--terminal', 't-1')
  until(() => /alerter exited 0: @CLOSED/.test(existsSync(join(dir, 'n.log')) ? readFileSync(join(dir, 'n.log'), 'utf8') : ''), 'the log line')
  assert.deepEqual(lines(join(dir, 'orca.log')), [])
})

test('withdraw stops the watcher and removes the alert', () => {
  const dir = folder()
  const env = notifyEnv(dir, 'exec sleep 60')
  const pid = raise(dir, env).stdout.trim()
  until(() => lines(join(dir, 'alerter.log')).length > 0, 'the alert')
  const r = spawnSync('bash', [NOTIFY, 'withdraw', '--group', 'g1', '--pid', pid], { encoding: 'utf8', env })
  assert.equal(r.status, 0, r.stderr)
  assert.match(lines(join(dir, 'alerter.log')).at(-1), /--remove g1/)
  until(() => spawnSync('kill', ['-0', pid]).status !== 0, 'the watcher to end')
})

test('a missing alerter exits 3 and names the install command', () => {
  const dir = folder()
  const r = raise(dir, { ...process.env, NDEV_ALERTER: join(dir, 'no-such-alerter') })
  assert.equal(r.status, 3)
  assert.match(r.stderr, /brew install vjeantet\/tap\/alerter/)
})

test('bad usage exits 2', () => {
  assert.equal(spawnSync('bash', [NOTIFY, 'raise'], { encoding: 'utf8' }).status, 2)
  assert.equal(spawnSync('bash', [NOTIFY, 'nonsense', '--group', 'g'], { encoding: 'utf8' }).status, 2)
})

// ---- merge.sh ----
const BODY = 'Plan\n<!-- ndev:migrations -->\n- `supabase/migrations/1_a.sql`: first\n- `supabase/migrations/2_b.sql`: second\n<!-- /ndev:migrations -->\nEnd'
const OPEN_PR = { state: 'open', draft: false, merged: false, base: { ref: 'main' }, body: BODY }
// The fake gh answers a read in the words of gh pr view, runs mergeBody for the merge, and logs each call.
const ghPr = pr => ({ number: 12, title: 'T', url: 'u', author: { login: 'neil' }, createdAt: 'c', headRefOid: 'h', headRefName: 'b', baseRefName: pr.base?.ref ?? 'main', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', isDraft: !!pr.draft, body: pr.body ?? null, state: pr.merged ? 'MERGED' : String(pr.state).toUpperCase(), mergeCommit: pr.merge_commit_sha ? { oid: pr.merge_commit_sha } : null })
const merge = (pr, mergeBody = 'true', ...args) => {
  const dir = folder()
  writeFileSync(join(dir, 'pr.json'), JSON.stringify(ghPr(pr)))
  writeFileSync(join(dir, 'merged.json'), JSON.stringify(ghPr({ ...pr, merged: true, merge_commit_sha: 'abc' })))
  program(dir, 'gh', `echo "$*" >> "${dir}/gh.log"
if [[ "$*" == "pr merge"* || "$*" == *"-X PUT"* ]]; then ${mergeBody}; exit $?; fi
if grep -q "pr merge" "${dir}/gh.log"; then cat "${dir}/merged.json"; else cat "${dir}/pr.json"; fi`)
  const r = spawnSync('bash', [MERGE, '12', '--repo', 'o/r', ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } })
  return { ...r, calls: lines(join(dir, 'gh.log')) }
}

test('merge reads, merges through gh, reads the sha and lists the migrations in order', () => {
  const r = merge(OPEN_PR)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), {
    pr: 12, merged: true, alreadyMerged: false, sha: 'abc', base: 'main',
    migrations: ['supabase/migrations/1_a.sql', 'supabase/migrations/2_b.sql'],
  })
  assert.equal(r.calls.length, 3)
  assert.ok(r.calls[0].startsWith('pr view 12 --repo o/r'), r.calls[0])
  assert.equal(r.calls[1], 'pr merge 12 --repo o/r --merge')
  assert.ok(r.calls[2].startsWith('pr view 12 --repo o/r'), r.calls[2])
})

test('a PR already merged is not merged again, and still names its migrations', () => {
  const r = merge({ ...OPEN_PR, merged: true, state: 'closed', merge_commit_sha: 'def' })
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.alreadyMerged, true)
  assert.equal(out.sha, 'def')
  assert.equal(out.migrations.length, 2)
  assert.equal(r.calls.length, 1)
})

test('a PR with no migrations section gives an empty list', () => {
  assert.deepEqual(JSON.parse(merge({ ...OPEN_PR, body: 'Plan' }).stdout).migrations, [])
  assert.deepEqual(JSON.parse(merge({ ...OPEN_PR, body: null }).stdout).migrations, [])
})

test('a draft and a closed PR are refused with no merge call', () => {
  const draft = merge({ ...OPEN_PR, draft: true })
  assert.equal(draft.status, 1)
  assert.match(draft.stderr, /draft/)
  const closed = merge({ ...OPEN_PR, state: 'closed' })
  assert.equal(closed.status, 1)
  assert.match(closed.stderr, /closed and not merged/)
  assert.equal(draft.calls.length + closed.calls.length, 2)
})

test('a merge GitHub refuses exits 1 and prints its reason', () => {
  const r = merge(OPEN_PR, 'echo "Pull Request is not mergeable"; exit 1')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /refused the merge of PR #12 of o\/r/)
  assert.match(r.stderr, /Pull Request is not mergeable/)
})

test('bad usage exits 2 and calls nothing', () => {
  for (const args of [['abc', '--repo', 'o/r'], ['12', '--repo', 'o/r', '--method', 'fast'], ['12', '--nope']]) {
    assert.equal(spawnSync('bash', [MERGE, ...args], { encoding: 'utf8' }).status, 2)
  }
})

// ---- fast-checks-template.sh ----
const FAST = join(HERE, '..', 'fast-checks-template.sh')

function fastRepo(tools = {}, files = ['a.py', 'b.ts']) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fast-checks-')))
  const bin = join(dir, '.venv', 'bin')
  mkdirSync(bin, { recursive: true })
  for (const [name, code] of Object.entries(tools)) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "$0 $*" >> "${dir}/calls"\necho "${name} says line 3"\nexit ${code}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  for (const f of files) writeFileSync(join(dir, f), '')
  return dir
}
const fast = (dir, ...args) => spawnSync('bash', [FAST, ...args], { cwd: dir, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
const fastCalls = dir => (existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8') : '')

test('fast checks give each tool only its own kind of file, and pass when they are clean', () => {
  const dir = fastRepo({ ruff: 0, ty: 0, oxlint: 0 })
  const r = fast(dir, 'a.py', 'b.ts')
  assert.equal(r.status, 0, r.stderr)
  const calls = fastCalls(dir)
  assert.match(calls, /ruff check a\.py\n/)
  assert.match(calls, /ty check a\.py\n/)
  assert.match(calls, /oxlint b\.ts\n/)
})

test('a fault exits 1 and prints the tool and its output', () => {
  const dir = fastRepo({ ruff: 1, ty: 0, oxlint: 0 })
  const r = fast(dir, 'a.py')
  assert.equal(r.status, 1)
  assert.match(r.stdout, /ruff: found faults\nruff says line 3/)
})

test('a tool that is not installed is named, so that it does not look like a pass', () => {
  const dir = fastRepo({ ty: 0 })
  const r = fast(dir, 'a.py')
  assert.equal(r.status, 0)
  assert.match(r.stderr, /ruff is not installed, so it did not check 1 file/)
})

test('fast checks call no tool with no files, and skip a deleted file', () => {
  const dir = fastRepo({ ruff: 1, ty: 1, oxlint: 1 })
  assert.equal(fast(dir).status, 0)
  assert.equal(fast(dir, 'gone.py').status, 0)
  assert.equal(fastCalls(dir), '')
})

test('ast-grep runs only in a project with its config', () => {
  const dir = fastRepo({ 'ast-grep': 0 }, ['c.go'])
  assert.equal(fast(dir, 'c.go').status, 0)
  assert.equal(fastCalls(dir), '')
  writeFileSync(join(dir, 'sgconfig.yml'), '')
  assert.equal(fast(dir, 'c.go').status, 0)
  assert.match(fastCalls(dir), /ast-grep scan c\.go\n/)
})

// The guide is what /flow guide shows, so it must not fall behind the code.
test('the guide names each tool, each state and each stage hook', () => {
  const plugin = new URL('../../../', import.meta.url).pathname
  const guide = readFileSync(`${plugin}kb/workflow.md`, 'utf8')
  const tools = [...readFileSync(`${plugin}hooks/workflow/tools.ts`, 'utf8').matchAll(/^  \{ name: '(\w+)', description:/gm)].map(m => m[1])
  assert.ok(tools.length >= 15, `found only ${tools.length} tools in the Spec list`)
  const machine = readFileSync(`${plugin}hooks/workflow/machine.ts`, 'utf8')
  const hooks = [...machine.matchAll(/\{ name: '(\w+)', on: '(\w+)' \}/g)]
  assert.equal(hooks.length, 2)
  for (const tool of tools) assert.match(guide, new RegExp(`\\| \`${tool}[(\`]`), `the guide has no row for the tool ${tool}`)
  for (const [, hook, state] of hooks) assert.match(guide, new RegExp(`\\| \`${hook}\` \\| \`${state}\``), `the guide has no row for the hook ${hook}`)
  assert.match(guide, /```mermaid\nflowchart TD/)
})
