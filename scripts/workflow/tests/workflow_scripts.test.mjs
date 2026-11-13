// Tests for notify.sh, merge.sh and fast-checks-template.sh. Fake osascript, orca and gh programs stand in for the real ones:
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
// A fake osascript records its arguments, one per line, then a blank line.
const notifyEnv = (dir, body = '') => ({
  ...process.env,
  NDEV_OSASCRIPT: program(dir, 'osascript', `printf '%s\\n' "$@" >> "${dir}/osascript.log"; echo >> "${dir}/osascript.log"\n${body}`),
})
const raise = (dir, env, ...extra) =>
  spawnSync('bash', [NOTIFY, 'raise', '--group', 'g1', '--title', 'T "quoted"', '--message', 'M \\ $HOME', ...extra], { encoding: 'utf8', env })

test('raise shows one notification, passes the text as arguments and leaves no process behind', () => {
  const dir = folder()
  const r = raise(dir, notifyEnv(dir))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '')
  const said = readFileSync(join(dir, 'osascript.log'), 'utf8')
  assert.match(said, /^T "quoted"$/m)
  assert.match(said, /^M \\ \$HOME$/m)
})

test('a failed osascript exits 3 and gives its exit code and output', () => {
  const dir = folder()
  const r = raise(dir, notifyEnv(dir, 'echo "not allowed" >&2; exit 1'))
  assert.equal(r.status, 3)
  assert.match(r.stderr, /osascript exited 1: not allowed/)
})

test('withdraw stops a watcher that an older version started', () => {
  const dir = folder()
  const old = spawnSync('bash', ['-c', 'nohup sleep 60 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).stdout.trim()
  const r = spawnSync('bash', [NOTIFY, 'withdraw', '--group', 'g1', '--pid', old], { encoding: 'utf8', env: notifyEnv(dir) })
  assert.equal(r.status, 0, r.stderr)
  until(() => spawnSync('kill', ['-0', old]).status !== 0, 'the old watcher to end')
  assert.equal(existsSync(join(dir, 'osascript.log')), false)
})

test('withdraw with no pid does nothing and succeeds', () => {
  const dir = folder()
  assert.equal(spawnSync('bash', [NOTIFY, 'withdraw', '--group', 'g1'], { encoding: 'utf8', env: notifyEnv(dir) }).status, 0)
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
// The files of the PR, in the shape of GET /pulls/{n}/files. 1_a and 2_b are the listed migrations.
const LISTED_FILES = [
  { filename: 'supabase/migrations/1_a.sql', status: 'added' },
  { filename: 'supabase/migrations/2_b.sql', status: 'added' },
  { filename: 'src/a.ts', status: 'modified' },
]
const merge = (pr, mergeBody = 'true', ...args) => {
  const dir = folder()
  writeFileSync(join(dir, 'files.json'), JSON.stringify(pr.files ?? LISTED_FILES))
  writeFileSync(join(dir, 'pr.json'), JSON.stringify(ghPr(pr)))
  writeFileSync(join(dir, 'merged.json'), JSON.stringify(ghPr({ ...pr, merged: true, merge_commit_sha: 'abc' })))
  writeFileSync(join(dir, 'rest.json'), JSON.stringify({ number: 12, state: 'open', head: { sha: 'h1', ref: 'b' }, base: { ref: 'main' }, stack: pr.stack ?? null }))
  program(dir, 'gh', `echo "$*" >> "${dir}/gh.log"
if [[ "$*" == "api repos/o/r/pulls/12" ]]; then cat "${dir}/rest.json"; exit 0; fi
if [[ "$*" == "api --paginate repos/o/r/pulls/12/files?per_page=100" ]]; then ${pr.filesBody ?? `cat "${dir}/files.json"`}; exit $?; fi
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
    migrations: ['supabase/migrations/1_a.sql', 'supabase/migrations/2_b.sql'], unlisted: [],
  })
  assert.doesNotMatch(r.stderr, /not listed/)
  assert.equal(r.calls.length, 4)
  assert.ok(r.calls[0].startsWith('pr view 12 --repo o/r'), r.calls[0])
  assert.equal(r.calls[1], 'api --paginate repos/o/r/pulls/12/files?per_page=100')
  assert.equal(r.calls[2], 'pr merge 12 --repo o/r --merge')
  assert.ok(r.calls[3].startsWith('pr view 12 --repo o/r'), r.calls[3])
})

test('a migration file the PR adds but does not list is named in unlisted and in a warning with the repair', () => {
  const files = [
    ...LISTED_FILES,
    { filename: 'supabase/migrations/20261113135004_gate_reply_wording.sql', status: 'added' },
    { filename: 'apps/db/supabase/migrations/3_c.sql', status: 'added' },
    { filename: 'supabase/migrations/0_old.sql', status: 'modified' },
    { filename: 'supabase/migrations/README.md', status: 'added' },
  ]
  const added = ['supabase/migrations/20261113135004_gate_reply_wording.sql', 'apps/db/supabase/migrations/3_c.sql']
  const cases = [
    [{ ...OPEN_PR, files }, added],
    [{ ...OPEN_PR, files, merged: true, state: 'closed', merge_commit_sha: 'def' }, added],
    [{ ...OPEN_PR, files, body: 'Plan' }, ['supabase/migrations/1_a.sql', 'supabase/migrations/2_b.sql', ...added]],
  ]
  for (const [pr, unlisted] of cases) {
    const r = merge(pr)
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout).unlisted, unlisted)
    for (const f of unlisted) assert.match(r.stderr, new RegExp(`- ${f.replaceAll('.', '\\.')}\\n`))
    assert.match(r.stderr, new RegExp(`PR #12 of o/r adds ${unlisted.length} migration file\\(s\\) that its body does not list`))
    assert.match(r.stderr, /addMigration/)
    assert.match(r.stderr, /supabase db push/)
  }
})

test('a failed read of the PR files exits 2 before the merge and gives the exit code', () => {
  const r = merge({ ...OPEN_PR, filesBody: 'echo "HTTP 502: Bad gateway" >&2; exit 1' })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /could not read the files of PR #12 of o\/r \(exit 1\)/)
  assert.match(r.stderr, /Bad gateway/)
  assert.ok(!r.calls.some(c => c.startsWith('pr merge')), r.calls.join('\n'))
})

test('a PR already merged is not merged again, and still names its migrations', () => {
  const r = merge({ ...OPEN_PR, merged: true, state: 'closed', merge_commit_sha: 'def' })
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.alreadyMerged, true)
  assert.equal(out.sha, 'def')
  assert.equal(out.migrations.length, 2)
  assert.equal(r.calls.length, 2)
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
  assert.ok(![...draft.calls, ...closed.calls].some(c => c.startsWith('pr merge')))
})

test('a merge GitHub refuses exits 1 and prints its reason', () => {
  const r = merge(OPEN_PR, 'echo "Pull Request is not mergeable"; exit 1')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /refused the merge of PR #12 of o\/r/)
  assert.match(r.stderr, /Pull Request is not mergeable/)
})

// GitHub refuses gh pr merge and PUT .../merge for a stacked PR; only merge-async merges it.
const STACKED = `case "$*" in
  "pr merge"*) echo "GraphQL: This pull request is part of a stack and must be merged using the asynchronous merge REST API" >&2; exit 1 ;;
  *merge-async*) echo '{"id":"u-1","status":"merged"}' ;;
  *) echo "Merging stacked PRs via this endpoint is not supported. (HTTP 403)" >&2; exit 1 ;;
esac`

test('a stacked PR above the bottom of its stack is refused unless --stack is given, and then merged through merge-async', () => {
  const stacked = { ...OPEN_PR, stack: { position: 2, size: 2 } }
  const refused = merge(stacked, STACKED)
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /2 of 2 in a stack/)
  assert.match(refused.stderr, /--stack/)
  assert.doesNotMatch(refused.stderr, /rate_limit/)
  const r = merge(stacked, STACKED, '--stack')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).sha, 'abc')
  assert.ok(r.calls.some(c => c.includes('pulls/12/merge-async') && c.includes('sha=h1')), r.calls.join('\n'))
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

const RUN_CHECK = join(HERE, '..', 'run-check.sh')
const runCheck = (args, env = {}) => spawnSync('bash', [RUN_CHECK, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })

test('run-check.sh runs a check detached, waits in parts and gives its exit code and streams', () => {
  const dir = folder()
  const check = program(dir, 'check.sh', 'echo "out $1 $NDEV_X"; echo err >&2; sleep 2; exit 5')
  const started = runCheck(['start', join(dir, 'run'), check, 'a1'], { NDEV_X: 'env' })
  assert.equal(started.status, 0, started.stderr)
  const pid = started.stdout.trim()
  assert.match(pid, /^\d+$/)
  assert.equal(runCheck(['wait', join(dir, 'run'), pid, '0']).status, 124)
  const ended = runCheck(['wait', join(dir, 'run'), pid, '20'])
  assert.equal(ended.status, 0, ended.stderr)
  assert.equal(ended.stdout.trim(), '5')
  assert.equal(runCheck(['out', join(dir, 'run')]).stdout, 'out a1 env\n')
  assert.equal(runCheck(['err', join(dir, 'run')]).stdout, 'err\n')
})

test('run-check.sh stop ends the check and the processes it started', () => {
  const dir = folder()
  const marker = `run-check-${process.pid}-${Date.now()}`
  const check = program(dir, 'check.sh', `bash -c 'sleep 60; echo ${marker}' & sleep 60`)
  const pid = runCheck(['start', join(dir, 'run'), check]).stdout.trim()
  assert.equal(runCheck(['stop', pid]).status, 0)
  const gone = runCheck(['wait', join(dir, 'run'), pid, '5'])
  assert.equal(gone.status, 3)
  assert.match(gone.stderr, /wrote no exit code/)
  assert.notEqual(spawnSync('pgrep', ['-f', marker]).status, 0)
})
