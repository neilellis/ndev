import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ndev = fileURLToPath(new URL('../bin/ndev', import.meta.url))

function sync(args, cwd = tmpdir()) {
  const result = spawnSync(ndev, [...args.slice(0, 1), '--json', ...args.slice(1)], { cwd, encoding: 'utf8' })
  assert.ifError(result.error)
  return result
}

function fixture(t, workflow = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ndev-wait-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' })
  assert.equal(git.status, 0, git.stderr)
  const record = join(root, '.neil-dev.issue-12.json')
  writeFileSync(record, JSON.stringify({ version: 1, issue: 12, rounds: [], workflow: { issue: 12, root, state: 'developing', rev: 1, history: [], ...workflow } }))
  return { root, state: () => JSON.parse(readFileSync(record, 'utf8')).workflow }
}

test('wait command retries and reports the child exit and output on exhaustion', () => {
  const result = sync(['wait', 'command', '--period', '0.01', '--attempts', '2', '--', process.execPath, '-e', 'console.error("failing fixture"); process.exit(7)'])
  assert.equal(result.status, 3, result.stdout || result.stderr)
  const { error } = JSON.parse(result.stdout)
  assert.equal(error.details.attempts, 2)
  assert.equal(error.details.last.exitCode, 7)
  assert.match(error.details.last.stderr, /failing fixture/)
})

test('wait seconds restores the caller state after success', t => {
  const { root, state } = fixture(t)
  const result = sync(['wait', 'seconds', '--issue', '12', '0.03'], root)
  assert.equal(result.status, 0, result.stdout || result.stderr)
  assert.equal(JSON.parse(result.stdout).result.outcome, 'satisfied')
  assert.equal(state().state, 'developing')
  assert.equal(state().wait, undefined)
})

test('a failed bound wait keeps its final child result with the restored state', t => {
  const { root, state } = fixture(t)
  const result = sync(['wait', 'command', '--issue', '12', '--attempts', '1', '--', process.execPath, '-e', 'console.error("failed bound check"); process.exit(41)'], root)
  assert.equal(result.status, 3, result.stdout || result.stderr)
  assert.equal(state().state, 'developing')
  assert.equal(state().lastWait.last.exitCode, 41)
  assert.match(state().lastWait.last.stderr, /failed bound check/)
})

test('a second CLI call unblocks the active wait and restores its state', async t => {
  const { root, state } = fixture(t)
  const child = spawn(ndev, ['wait', '--json', 'seconds', '--issue', '12', '8'], { cwd: root })
  t.after(() => child.kill())
  let stdout = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  const exit = once(child, 'close')
  const end = Date.now() + 4000
  while (state().state !== 'wait' && Date.now() < end && child.exitCode === null) await pause(25)
  assert.equal(state().state, 'wait', stdout)
  const unblocked = sync(['flow', 'unblock', '--issue', '12', 'Continue with the answer'], root)
  assert.equal(unblocked.status, 0, unblocked.stdout || unblocked.stderr)
  assert.equal(state().state, 'developing')
  assert.equal((await exit)[0], 4, stdout)
  assert.equal(JSON.parse(stdout).error.details.answer, 'Continue with the answer')
})

test('wait accepts a PR that no workflow record holds, and moves no workflow state', t => {
  const { root, state } = fixture(t)
  const result = sync(['wait', 'seconds', '--pr', '99', '0.03'], root)
  assert.equal(result.status, 0, result.stdout || result.stderr)
  assert.equal(JSON.parse(result.stdout).result.outcome, 'satisfied')
  assert.equal(state().state, 'developing')
  assert.equal(state().wait, undefined)
})

test('wait for an issue that no workflow record holds names the command that starts it, not --issue again', t => {
  const { root } = fixture(t)
  const result = sync(['wait', 'seconds', '--issue', '99', '0.03'], root)
  assert.equal(result.status, 2, result.stdout || result.stderr)
  const { error } = JSON.parse(result.stdout)
  assert.match(error.message, /No workflow record for issue #99/)
  assert.match(error.repair, /ndev flow start 99/)
  assert.match(error.repair, /--pr/)
})

const exits = code => [process.execPath, '-e', `process.exit(${code})`]

for (const [label, workflow] of [['is off', { state: 'ci', pr: 7, prs: [7], off: { at: 1, reason: 'merged' } }], ['is done', { state: 'done', pr: 7, prs: [7] }]]) {
  test(`wait command runs beside a workflow record that ${label}, and leaves that record as it was`, t => {
    const { root, state } = fixture(t, workflow)
    const before = state()
    const result = sync(['wait', 'command', '--attempts', '1', '--', ...exits(0)], root)
    assert.equal(result.status, 0, result.stdout || result.stderr)
    assert.equal(JSON.parse(result.stdout).result.outcome, 'satisfied')
    assert.deepEqual(state(), before)
  })
}

test('wait command still refuses beside a workflow record that is blocked', t => {
  const { root } = fixture(t, { state: 'blocked', previous: 'ci' })
  const result = sync(['wait', 'command', '--attempts', '1', '--', ...exits(0)], root)
  assert.equal(result.status, 1, result.stdout || result.stderr)
  assert.match(JSON.parse(result.stdout).error.message, /Issue #12 cannot wait in state blocked/)
})

test('wait command accepts a timeout long enough for CI, up to 21600 seconds', () => {
  const long = sync(['wait', 'command', '--timeout', '7200', '--attempts', '1', '--', ...exits(0)])
  assert.equal(long.status, 0, long.stdout || long.stderr)
  const over = sync(['wait', 'command', '--timeout', '21601', '--attempts', '1', '--', ...exits(0)])
  assert.equal(over.status, 2, over.stdout || over.stderr)
  assert.match(JSON.parse(over.stdout).error.message, /Invalid timeout "21601".*to 21600/)
})

function fakeBin(t, root, name, body) {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, name), `#!/bin/sh\necho "$*" >> "${root}/${name}.log"\n${body}`)
  chmodSync(join(bin, name), 0o755)
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` }
}

function waitWith(env, root, args) {
  const result = spawnSync(ndev, ['wait', '--json', ...args], { cwd: root, encoding: 'utf8', env })
  assert.ifError(result.error)
  return { ...result, json: result.stdout ? JSON.parse(result.stdout) : undefined }
}

async function waitAsync(args, cwd, env = process.env) {
  const running = spawn(ndev, ['wait', '--json', ...args], { cwd, env })
  let stdout = ''
  let stderr = ''
  running.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  running.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const [status] = await once(running, 'close')
  return { status, stdout, stderr, json: stdout ? JSON.parse(stdout) : undefined }
}

const githubFake = root => `n=$(cat "${root}/count-$1-$3" 2>/dev/null || echo 0)
n=$((n+1))
echo $n > "${root}/count-$1-$3"
file="${root}/$1-$3-$n.json"
[ -f "$file" ] || file="${root}/$1-$3.json"
cat "$file"
`

const prFixtures = {
  open: { state: 'OPEN', isDraft: false, mergeable: 'CONFLICTING' },
  draft: { state: 'OPEN', isDraft: true, mergeable: 'MERGEABLE' },
  ready: { state: 'OPEN', isDraft: false, mergeable: 'UNKNOWN' },
  mergeable: { state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE' },
  closed: { state: 'CLOSED', isDraft: false, mergeable: 'UNKNOWN' },
  merged: { state: 'MERGED', isDraft: false, mergeable: 'UNKNOWN' },
}

function prCaller(t) {
  const { root } = fixture(t, { prs: [7], state: 'developed' })
  const record = join(root, '.neil-dev.issue-12.json')
  const held = JSON.parse(readFileSync(record, 'utf8'))
  writeFileSync(record, JSON.stringify({ ...held, prs: { 7: { issue: 12, root, pr: 7, prs: [7], state: 'ci', rev: 1, history: [] } } }))
  return { root, pr: () => JSON.parse(readFileSync(record, 'utf8')).prs[7] }
}

test('wait pr observes each supported PR state and refuses one the PR is not in', t => {
  const { root } = fixture(t)
  const env = fakeBin(t, root, 'gh', githubFake(root))
  for (const [wanted, pr] of Object.entries(prFixtures)) {
    writeFileSync(join(root, 'pr-8.json'), JSON.stringify(pr))
    const met = waitWith(env, root, ['pr', '--issue', '12', '8', wanted, '--attempts', '1'])
    assert.equal(met.status, 0, `${wanted}: ${met.stdout || met.stderr}`)
    assert.ok(met.json.result.last.states.includes(wanted), JSON.stringify(met.json.result.last))
  }
  writeFileSync(join(root, 'pr-8.json'), JSON.stringify(prFixtures.draft))
  for (const wanted of ['ready', 'mergeable', 'merged', 'closed']) {
    const unmet = waitWith(env, root, ['pr', '--issue', '12', '8', wanted, '--attempts', '1'])
    assert.equal(unmet.status, 3, `${wanted}: ${unmet.stdout || unmet.stderr}`)
    assert.deepEqual(unmet.json.error.details.last.states, ['open', 'draft'])
  }
  assert.match(readFileSync(join(root, 'gh.log'), 'utf8'), /^pr view 8 --json state,isDraft,mergeable$/m)
})

test('wait pr keeps a GitHub-safe period and a target distinct from the caller PR', t => {
  const { root, pr } = prCaller(t)
  const env = fakeBin(t, root, 'gh', githubFake(root))
  const fast = waitWith(env, root, ['pr', '--pr', '7', '8', 'merged', '--period', '59'])
  assert.equal(fast.status, 2, fast.stdout || fast.stderr)
  assert.match(fast.json.error.message, /Invalid period "59".*from 60/)
  const own = waitWith(env, root, ['pr', '--pr', '7', '7', 'merged'])
  assert.equal(own.status, 2, own.stdout || own.stderr)
  assert.match(own.json.error.message, /Wait PR cannot target its own PR #7/)
  assert.equal(existsSync(join(root, 'gh.log')), false)
  writeFileSync(join(root, 'pr-8.json'), JSON.stringify(prFixtures.merged))
  const other = waitWith(env, root, ['pr', '--pr', '7', '8', 'merged', '--attempts', '1'])
  assert.equal(other.status, 0, other.stdout || other.stderr)
  assert.equal(pr().state, 'ci')
  assert.equal(pr().lastWait.outcome, 'satisfied')
})

test('wait issue holds until every named issue reaches the requested state', t => {
  const { root, state } = fixture(t)
  const env = fakeBin(t, root, 'gh', githubFake(root))
  writeFileSync(join(root, 'issue-5.json'), JSON.stringify({ state: 'CLOSED' }))
  writeFileSync(join(root, 'issue-6.json'), JSON.stringify({ state: 'OPEN' }))
  const partial = waitWith(env, root, ['issue', '--issue', '12', 'closed', '5', '6', '--attempts', '1'])
  assert.equal(partial.status, 3, partial.stdout || partial.stderr)
  assert.deepEqual(partial.json.error.details.last.issues, [{ issue: 5, state: 'closed' }, { issue: 6, state: 'open' }])
  writeFileSync(join(root, 'issue-6.json'), JSON.stringify({ state: 'CLOSED' }))
  const all = waitWith(env, root, ['issue', '--issue', '12', 'closed', '5', '6', '--attempts', '1'])
  assert.equal(all.status, 0, all.stdout || all.stderr)
  assert.deepEqual(all.json.result.last.issues, [{ issue: 5, state: 'closed' }, { issue: 6, state: 'closed' }])
  assert.equal(state().state, 'developing')
  assert.equal(state().lastWait.outcome, 'satisfied')
})

test('wait url waits through a non-2xx response and returns on a 2xx response', async t => {
  const statuses = [503, 404, 200]
  let served = 0
  const server = createServer((request, response) => {
    response.writeHead(statuses[Math.min(served++, statuses.length - 1)])
    response.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const result = await waitAsync(['url', `http://127.0.0.1:${server.address().port}/health`, '--period', '0.02'], tmpdir())
  assert.equal(result.status, 0, result.stdout || result.stderr)
  assert.equal(result.json.result.attempts, 3)
  assert.equal(result.json.result.last.status, 200)
})

test('wait process observes the PID exit and points to its log or result file for the result', async t => {
  const target = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(9), 2000)'])
  t.after(() => target.kill())
  const result = await waitAsync(['process', String(target.pid), '--period', '0.02'], tmpdir())
  assert.equal(result.status, 0, result.stdout || result.stderr)
  assert.ok(result.json.result.attempts > 1, result.stdout)
  assert.equal(result.json.result.last.pid, target.pid)
  assert.match(result.json.result.text, /log or result file/)
})

const orcaFake = root => `if [ "$1" = terminal ]; then exit "$(cat "${root}/terminal-exit")"; fi
n=$(cat "${root}/count-orca" 2>/dev/null || echo 0)
n=$((n+1))
echo $n > "${root}/count-orca"
file="${root}/dispatch-$n.json"
[ -f "$file" ] || file="${root}/dispatch.json"
cat "$file"
`

test('wait agent waits for an Orca dispatch to finish and for a named terminal to exit', t => {
  const { root } = fixture(t)
  const env = fakeBin(t, root, 'orca', orcaFake(root))
  writeFileSync(join(root, 'dispatch-1.json'), JSON.stringify({ ok: true, result: { state: 'running' } }))
  writeFileSync(join(root, 'dispatch.json'), JSON.stringify({ ok: true, result: { state: 'completed' } }))
  const dispatch = waitWith(env, root, ['agent', 'ctx_worker1', '--period', '0.02'])
  assert.equal(dispatch.status, 0, dispatch.stdout || dispatch.stderr)
  assert.equal(dispatch.json.result.attempts, 2)
  assert.equal(dispatch.json.result.last.status, 'completed')
  writeFileSync(join(root, 'terminal-exit'), '0')
  const terminal = waitWith(env, root, ['agent', 'term_reviewer', '--attempts', '1'])
  assert.equal(terminal.status, 0, terminal.stdout || terminal.stderr)
  const calls = readFileSync(join(root, 'orca.log'), 'utf8')
  assert.match(calls, /^orchestration worker-show --dispatch ctx_worker1 --json$/m)
  assert.match(calls, /^terminal wait --terminal term_reviewer --for exit /m)
})

test('wait agent reports a lost Orca dispatch at once', t => {
  const { root, state } = fixture(t)
  const env = fakeBin(t, root, 'orca', orcaFake(root))
  writeFileSync(join(root, 'dispatch.json'), JSON.stringify({ ok: true, result: { state: 'lost', id: 'ctx_worker2' } }))
  const lost = waitWith(env, root, ['agent', '--issue', '12', 'dispatch:ctx_worker2', '--period', '0.02'])
  assert.equal(lost.status, 1, lost.stdout || lost.stderr)
  assert.match(lost.json.error.message, /Orca dispatch dispatch:ctx_worker2 is lost/)
  assert.equal(lost.json.error.details.attempts, 1)
  assert.equal(state().state, 'developing')
})

function deadPid() {
  const gone = spawnSync(process.execPath, ['-e', ''])
  assert.equal(gone.status, 0)
  return gone.pid
}

const deadWait = () => ({ state: 'wait', previous: 'reviewing', wait: { id: 'dead-wait', pid: deadPid(), kind: 'seconds', startedAt: 1, until: 2 } })

test('flow unblock restores the saved phase of a wait whose owner died', t => {
  const { root, state } = fixture(t, deadWait())
  const result = sync(['flow', 'unblock', '--issue', '12'], root)
  assert.equal(result.status, 0, result.stdout || result.stderr)
  assert.equal(state().state, 'reviewing')
  assert.equal(state().wait, undefined)
  assert.equal(state().lastWait.id, 'dead-wait')
})

test('a new wait restores the saved phase of a wait whose owner died, then waits', t => {
  const { root, state } = fixture(t, deadWait())
  const result = sync(['wait', 'seconds', '--issue', '12', '0.03'], root)
  assert.equal(result.status, 0, result.stdout || result.stderr)
  assert.equal(state().state, 'reviewing')
  assert.equal(state().wait, undefined)
  assert.notEqual(state().lastWait.id, 'dead-wait')
  assert.equal(state().lastWait.outcome, 'satisfied')
})

test('a wait leaves the dead wait of another issue alone, even one that cannot be restored', t => {
  const { root, state } = fixture(t)
  const other = join(root, '.neil-dev.issue-13.json')
  const broken = JSON.stringify({ version: 1, issue: 13, rounds: [], workflow: { issue: 13, root, rev: 1, history: [], ...deadWait(), previous: undefined } })
  writeFileSync(other, broken)
  const result = sync(['wait', 'seconds', '--issue', '12', '0.03'], root)
  assert.equal(result.status, 0, result.stdout || result.stderr)
  assert.equal(state().lastWait.outcome, 'satisfied')
  assert.equal(readFileSync(other, 'utf8'), broken)
})

test('a new wait still refuses while the earlier wait owner is alive', t => {
  const { root, state } = fixture(t, { ...deadWait(), wait: { id: 'live-wait', pid: process.pid, kind: 'seconds', startedAt: 1, until: 2 } })
  const result = sync(['wait', 'seconds', '--issue', '12', '0.03'], root)
  assert.equal(result.status, 1, result.stdout || result.stderr)
  assert.match(JSON.parse(result.stdout).error.message, /Issue #12 cannot wait in state wait/)
  assert.equal(state().wait.id, 'live-wait')
})

test('an old wait that ends after another wait started leaves the new wait in place', async t => {
  const { root, state } = fixture(t)
  const holdUntil = async (predicate, label) => {
    const end = Date.now() + 4000
    while (!predicate() && Date.now() < end) await pause(10)
    assert.ok(predicate(), `${label}: ${JSON.stringify(state())}`)
  }
  const first = spawn(ndev, ['wait', '--json', 'seconds', '--issue', '12', '8'], { cwd: root })
  t.after(() => first.kill())
  const firstExit = once(first, 'close')
  await holdUntil(() => state().state === 'wait', 'first wait')
  const firstId = state().wait.id
  const record = join(root, '.neil-dev.issue-12.json')
  const held = JSON.parse(readFileSync(record, 'utf8'))
  writeFileSync(`${record}.next`, JSON.stringify({ ...held, workflow: { ...held.workflow, rev: held.workflow.rev + 1, wait: { ...held.workflow.wait, id: 'second-wait', pid: process.pid } } }))
  renameSync(`${record}.next`, record)
  assert.equal((await firstExit)[0], 4)
  assert.equal(state().state, 'wait')
  assert.equal(state().wait.id, 'second-wait')
  assert.notEqual(state().lastWait?.id, firstId)
})

test('wait state reads another worktree without GitHub, waits for a missing record and accepts a later phase', t => {
  const { root, state } = fixture(t)
  const env = fakeBin(t, root, 'gh', 'exit 1\n')
  const git = (...args) => assert.equal(spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }).status, 0, args.join(' '))
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base')
  const other = `${root}-other`
  t.after(() => rmSync(other, { recursive: true, force: true }))
  git('worktree', 'add', '-q', other)
  const missing = waitWith(env, root, ['state', '--issue', '12', '30', 'developing', '--attempts', '2', '--period', '0.02'])
  assert.equal(missing.status, 3, missing.stdout || missing.stderr)
  assert.equal(missing.json.error.details.attempts, 2)
  assert.equal(missing.json.error.details.last.state, 'no record')
  writeFileSync(join(other, '.neil-dev.issue-30.json'), JSON.stringify({ version: 1, issue: 30, workflow: { issue: 30, root: other, state: 'reviewing', rev: 1, history: [{ at: 1, to: 'reviewing' }] } }))
  const later = waitWith(env, root, ['state', '--issue', '12', '30', 'developing', '--attempts', '1'])
  assert.equal(later.status, 0, later.stdout || later.stderr)
  assert.deepEqual(later.json.result.last, { satisfied: true, issue: 30, state: 'reviewing' })
  assert.equal(existsSync(join(root, 'gh.log')), false)
  assert.equal(state().state, 'developing')
})
