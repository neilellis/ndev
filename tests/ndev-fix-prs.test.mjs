import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { renderPanel } from '../scripts/ndev/panes.mjs'

const ndev = fileURLToPath(new URL('../bin/ndev', import.meta.url))

function fixture(t, { red = false, existing = false, extraEnv = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ndev-queue-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const env = { HOME: root, PATH: `${root}${delimiter}${process.env.PATH}`, ORCA_CLI_COMMAND: join(root, 'orca'), ...extraEnv }
  const git = spawnSync('git', ['init', '-q', root], { env, encoding: 'utf8' })
  assert.equal(git.status, 0, git.stderr)
  writeFileSync(join(root, '.git/info/exclude'), '.neil-dev.worktree.json\n')
  const worker = join(root, 'repair')
  for (const args of [
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'fixture'],
    ['worktree', 'add', '-qb', 'fix/ten', worker],
  ]) {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  writeFileSync(join(worker, '.neil-dev.json'), '{"mode":"heavy","steering":"interactive"}')
  writeFileSync(join(worker, '.neil-dev.worktree.json'), JSON.stringify({ version: 2, settings: { mode: 'heavy', steering: 'interactive' }, resources: { docker: [], 'dev-servers': {} } }))
  writeFileSync(join(root, '.neil-dev.json'), '{"github":{"repo":"fixture/demo","board":null}}')
  function fakeGh(root, red) {
    const fs = require('node:fs')
    const file = name => `${root}/${name}`
    const read = (name, fallback) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8').trim() : fallback)
    const args = process.argv.slice(2)
    fs.appendFileSync(file('gh-log'), args.join(' ') + '\n')
    if (fs.existsSync(file('gh-fail'))) { console.error(read('gh-fail')); process.exit(1) }
    const send = value => console.log(JSON.stringify(value))
    const verb = args.slice(0, 2).join(' ')
    if (verb === 'api user') return send({ login: 'tester' })
    if (verb === 'pr list') return send([{ number: 20, title: 'Newer', createdAt: '2026-08-01' }, { number: 10, title: 'Older', createdAt: '2026-07-01' }])
    if (verb === 'repo view') return send({ squashMergeAllowed: true })
    if (verb === 'pr merge') return fs.writeFileSync(file(`merged-${args[2]}`), args.join(' '))
    if (verb === 'pr view') {
      const n = Number(args[2])
      const base = n === 10
        ? { number: 10, title: 'Older', headRefOid: read('head-10', 'abc123'), headRefName: 'fix/ten', mergeStateStatus: 'CLEAN', state: 'OPEN', isDraft: false, statusCheckRollup: [{ name: 'test', conclusion: read('check-10', red ? 'FAILURE' : 'SUCCESS') }] }
        : { number: 20, title: 'Newer', headRefOid: 'def456', headRefName: 'fix/twenty', mergeStateStatus: 'CLEAN', state: 'OPEN', isDraft: false, statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }] }
      return send({ ...base, ...JSON.parse(read(`pr-${n}.json`, '{}')), ...(fs.existsSync(file(`merged-${n}`)) ? { state: 'MERGED' } : {}) })
    }
    console.error('unexpected gh ' + args.join(' '))
    process.exit(1)
  }
  writeFileSync(join(root, 'gh'), `#!/usr/bin/env node\n(${fakeGh.toString()})(${JSON.stringify(root)}, ${red})\n`, { mode: 0o755 })
  writeFileSync(join(root, 'orca'), `#!/bin/sh
printf '%s\\n' "$*" >> "${root}/orca-log"
case "$1 $2" in
  'worktree list') printf '%s\n' '${JSON.stringify({ ok: true, result: { worktrees: existing ? [{ id: 'worker-id', path: worker, projectId: 'github:fixture/demo', branch: 'fix/ten' }] : [] } })}' ;;
  'worktree create') printf '%s\n' '${JSON.stringify({ ok: true, result: { worktree: { id: 'worker-id', path: worker } } })}' ;;
  'orchestration worker-start') if [ -f "${root}/start-fail" ]; then cat "${root}/start-fail"; exit 1; fi; cp "${worker}/.neil-dev.worktree.json" "${root}/launch-settings.json"; printf '%s\n' '{"ok":true,"result":{"dispatchId":"ctx_active"}}' ;;
  'orchestration worker-show') if [ -f "${root}/worker-show" ]; then cat "${root}/worker-show"; else printf '%s\n' '${JSON.stringify({ ok: true, result: { projection: { runId: 'run-1', liveness: { verdict: 'live' } }, worker: { agentTerminalHandle: 'structworker_ctx' }, terminalResource: { releaseState: 'retained' } } })}'; fi ;;
  'orchestration inbox') if [ -f "${root}/inbox" ]; then cat "${root}/inbox"; else printf '%s\n' '{"ok":true,"result":{"messages":[]}}'; fi ;;
  'terminal list') printf '%s\n' '{"ok":true,"result":{"terminals":[{"handle":"term_fixture","writable":true}]}}' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 })
  const run = (...argv) => {
    const result = spawnSync(ndev, ['fix-prs', ...argv, '--json'], { cwd: root, env, encoding: 'utf8' })
    return { status: result.status, response: JSON.parse(result.stdout) }
  }
  const workerShow = result => writeFileSync(join(root, 'worker-show'), JSON.stringify({ ok: true, result }))
  const pushHead = head => writeFileSync(join(root, 'head-10'), head)
  const dispatches = () => (readFileSync(join(root, 'orca-log'), 'utf8').match(/worker-start/g) ?? []).length
  const watch = (extra = {}) => {
    const result = spawnSync(ndev, ['watch', '--once', '--session', 'fixture', '--worktree', `path:${root}`, '--json'], { cwd: root, env: { ...env, ORCA_TERMINAL_HANDLE: 'term_fixture', ...extra }, encoding: 'utf8' })
    return { status: result.status, response: JSON.parse(result.stdout) }
  }
  const put = (name, value) => writeFileSync(join(root, name), typeof value === 'string' ? value : JSON.stringify(value))
  const ghCalls = pattern => readFileSync(join(root, 'gh-log'), 'utf8').split('\n').filter(line => pattern.test(line)).length
  const status = () => run('status').response.result
  const panel = () => {
    const result = spawnSync(ndev, ['pane', 'bridge', 'snapshot', 'fix-all-prs', '--json'], { cwd: root, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return JSON.parse(result.stdout).result
  }
  return { root, env, worker, run, workerShow, pushHead, dispatches, watch, put, ghCalls, status, panel }
}

const showing = (verdict, releaseState) => ({ projection: { runId: 'run-1', liveness: { verdict } }, worker: { agentTerminalHandle: 'structworker_ctx' }, terminalResource: { releaseState } })
const exited = showing('exited', 'released')

test('fix-prs starts existing and new worker sessions with light mode and auto steering', t => {
  for (const existing of [false, true]) {
    const { root, worker, run } = fixture(t, { red: true, existing })
    const started = run('start', '--no-merge')
    assert.equal(started.status, 0, JSON.stringify(started.response))
    const settings = JSON.parse(readFileSync(join(root, 'launch-settings.json'), 'utf8'))
    assert.deepEqual(settings.settings, { mode: 'light', steering: 'auto' })
    assert.deepEqual(settings.resources, { docker: [], 'dev-servers': {} })
    assert.deepEqual(JSON.parse(readFileSync(join(worker, '.neil-dev.json'), 'utf8')), { mode: 'heavy', steering: 'interactive' })
    const log = readFileSync(join(root, 'orca-log'), 'utf8')
    assert.match(log, /worker-start[\s\S]*--worktree id:worker-id[\s\S]*--agent codex/)
    assert.match(log, /ndev flow repair --issue <issue> --pr 10/)
    assert.match(log, /rerun it with --take-over/)
    assert.match(log, /never open a second pull request/)
    assert.doesNotMatch(log, /ndev flow start <issue>/)
    assert.equal(log.includes('worktree create'), !existing)
  }
})

test('fix-prs does not launch a worker when its settings cannot be configured', t => {
  const { root, worker, run } = fixture(t, { red: true, existing: true })
  writeFileSync(join(worker, '.neil-dev.worktree.json'), '{"settings":{"mode":"invalid"}}')
  const started = run('start', '--no-merge')
  assert.equal(started.status, 1)
  assert.match(started.response.error.message, /mode|settings/)
  assert.doesNotMatch(readFileSync(join(root, 'orca-log'), 'utf8'), /worker-start/)
  assert.equal(run('status').response.result.operation, null)
  writeFileSync(join(worker, '.neil-dev.worktree.json'), '{"version":2,"settings":{"mode":"heavy","steering":"interactive"},"resources":{"docker":[],"dev-servers":{}}}')
  const retry = run('retry', '10')
  assert.equal(retry.status, 0, JSON.stringify(retry.response))
  const resumed = run('resume')
  assert.equal(resumed.status, 0, JSON.stringify(resumed.response))
  assert.equal(resumed.response.result.worker, 'ctx_active')
})

test('fix-prs persists its queue and checks the oldest PR first without merging', t => {
  const { root, run } = fixture(t)
  const first = run('start', '--no-merge')
  assert.equal(first.status, 0, JSON.stringify(first.response))
  const state = run('status').response.result
  assert.deepEqual(state.queue.map(pr => pr.number), [10, 20])
  assert.equal(state.outcomes[10].kind, 'awaiting-human')
  assert.equal(state.outcomes[10].head, 'abc123')
  const log = readFileSync(join(root, 'gh-log'), 'utf8')
  assert.match(log, /pr view 10/)
  assert.doesNotMatch(log, /pr merge/)
  assert.equal(run('pause').response.result.phase, 'paused')
})

test('fix-prs refuses a report for a different PR', t => {
  const { run } = fixture(t)
  run('start', '--no-merge')
  const refusal = run('report', '99', 'blocked', '--reason', 'Waiting')
  assert.equal(refusal.status, 1)
  assert.match(refusal.response.error.message, /PR #99.*current/i)
})

test('retry and skip preserve the current dispatch while its worker is live', t => {
  const { run } = fixture(t, { red: true })
  const started = run('start', '--no-merge')
  assert.equal(started.status, 0, JSON.stringify(started.response))
  assert.equal(started.response.result.worker, 'ctx_active')
  for (const verb of ['retry', 'skip']) {
    const changed = run(verb, '10')
    assert.equal(changed.status, 1, JSON.stringify(changed.response))
    assert.match(changed.response.error.message, /ctx_active.*live/)
  }
  assert.equal(run('status').response.result.worker, 'ctx_active')
})

test('a pushed report keeps the live owner and dispatches no second worker on a failing new head', t => {
  const { run, pushHead, dispatches } = fixture(t, { red: true })
  assert.equal(run('start', '--no-merge').response.result.worker, 'ctx_active')
  pushHead('new456')
  const reported = run('report', '10', 'pushed')
  assert.equal(reported.status, 0, JSON.stringify(reported.response))
  assert.equal(reported.response.result.worker, 'ctx_active')
  assert.equal(dispatches(), 1)
  const resumed = run('resume')
  assert.equal(resumed.status, 0, JSON.stringify(resumed.response))
  assert.equal(resumed.response.result.worker, 'ctx_active')
  assert.equal(dispatches(), 1)
})

test('after the owner has exited and released, a failing pushed head gets a new worker', t => {
  const { run, pushHead, workerShow, dispatches } = fixture(t, { red: true })
  run('start', '--no-merge')
  pushHead('new456')
  run('report', '10', 'pushed')
  workerShow(exited)
  const resumed = run('resume')
  assert.equal(resumed.status, 0, JSON.stringify(resumed.response))
  assert.equal(dispatches(), 2)
})

for (const [name, receipt] of [
  ['a receipt with unverifiable liveness', { projection: { runId: 'run-1' }, worker: { agentTerminalHandle: 'structworker_ctx' } }],
  ['a lost verdict', showing('lost', 'released')],
  ['an exited process whose terminal is not released', showing('exited', 'stop_unknown')],
]) {
  test(`fix-prs treats ${name} as no proof that the worker ended`, t => {
    const { run, pushHead, workerShow, dispatches } = fixture(t, { red: true })
    run('start', '--no-merge')
    pushHead('new456')
    workerShow(receipt)
    const resumed = run('resume')
    assert.equal(resumed.status, 0, JSON.stringify(resumed.response))
    assert.equal(dispatches(), 1)
    const state = run('status').response.result
    assert.equal(state.worker, 'ctx_active')
    assert.deepEqual(state.outcomes, {})
    const retry = run('retry', '10')
    assert.equal(retry.status, 1, JSON.stringify(retry.response))
    assert.match(retry.response.error.message, /ctx_active/)
    assert.equal(run('status').response.result.worker, 'ctx_active')
  })
}

const message = (sequence, from, body, extra = {}) => ({ id: `msg-${sequence}`, sequence, from_handle: from, to_handle: 'run:run-1', type: 'status', subject: 'Update', body, created_at: '2026-11-25T10:00:00Z', ...extra })
const inbox = messages => ({ ok: true, result: { messages } })

test('a blocked PR keeps its live worker until Orca proves it exited and released, so retry starts no second worker', t => {
  const f = fixture(t, { red: true })
  f.run('start', '--no-merge')
  const reported = f.run('report', '10', 'blocked', '--reason', 'Needs a product decision')
  assert.equal(reported.status, 0, JSON.stringify(reported.response))
  let state = f.status()
  assert.equal(state.worker, 'ctx_active')
  assert.equal(state.current, 10)
  assert.equal(state.step, 'blocked')
  assert.equal(state.outcomes[10], undefined)
  assert.match(state.text, /#10 Older: blocked · Needs a product decision · owner ctx_active/)
  assert.match(readFileSync(join(f.root, 'orca-log'), 'utf8'), /After a blocked report, end your session/)
  assert.equal(f.watch().status, 0)
  assert.equal(f.status().current, 10)
  const retry = f.run('retry', '10')
  assert.equal(retry.status, 1, JSON.stringify(retry.response))
  assert.match(retry.response.error.message, /ctx_active.*live/)
  assert.equal(f.dispatches(), 1)
  f.workerShow(exited)
  assert.equal(f.watch().status, 0)
  state = f.status()
  assert.deepEqual(state.outcomes[10], { kind: 'blocked', detail: 'Needs a product decision', head: 'abc123' })
  assert.equal(state.worker, null)
  assert.equal(state.current, null)
  assert.equal(f.dispatches(), 1)
  assert.equal(f.run('retry', '10').status, 0)
  assert.equal(f.dispatches(), 2)
})

test('a blocked report on a PR without a worker settles it at once', t => {
  const f = fixture(t)
  f.put('check-10', 'PENDING')
  f.run('start', '--no-merge')
  assert.equal(f.run('report', '10', 'blocked', '--reason', 'Waiting on a vendor').status, 0)
  const state = f.status()
  assert.deepEqual(state.outcomes[10], { kind: 'blocked', detail: 'Waiting on a vendor', head: 'abc123' })
  assert.equal(state.current, null)
})

test('status shows the current PR, its step and the next actions without a GitHub read', t => {
  const f = fixture(t, { red: true })
  f.run('start', '--no-merge')
  const reads = f.ghCalls(/pr view/)
  const { text } = f.status()
  assert.match(text, /running · PR #10 · fixing/)
  assert.match(text, /#10 Older.*fixing/)
  assert.match(text, /#20 Newer.*queued/)
  assert.match(text, /Pause/)
  assert.match(text, /Skip #20/)
  assert.equal(f.ghCalls(/pr view/), reads)
})

test('pause keeps the queue and stops dispatch, and resume restores it from disk and continues', t => {
  const f = fixture(t, { extraEnv: { NDEV_PR_CHECK_MS: '1' } })
  f.put('check-10', 'PENDING')
  f.run('start', '--no-merge')
  assert.equal(f.status().step, 'checks')
  assert.equal(f.run('pause').response.result.phase, 'paused')
  f.put('check-10', 'FAILURE')
  const reads = f.ghCalls(/pr view 10/)
  assert.equal(f.watch().status, 0)
  assert.equal(f.ghCalls(/pr view 10/), reads)
  assert.equal(f.dispatches(), 0)
  const paused = f.status()
  assert.deepEqual(paused.queue.map(pr => pr.number), [10, 20])
  assert.equal(paused.phase, 'paused')
  const resumed = f.run('resume')
  assert.equal(resumed.status, 0, JSON.stringify(resumed.response))
  assert.equal(resumed.response.result.phase, 'running')
  assert.equal(resumed.response.result.worker, 'ctx_active')
  assert.equal(f.dispatches(), 1)
})

test('skip of the current PR settles it and picks the next one', t => {
  const f = fixture(t)
  f.put('check-10', 'PENDING')
  f.run('start', '--no-merge')
  assert.equal(f.status().current, 10)
  const skipped = f.run('skip', '10')
  assert.equal(skipped.status, 0, JSON.stringify(skipped.response))
  const state = f.status()
  assert.equal(state.outcomes[10].kind, 'skipped')
  assert.equal(state.outcomes[20].kind, 'awaiting-human')
  assert.equal(f.ghCalls(/pr view 20/), 1)
})

test('retry clears the outcome of the named PR and checks it again at its new head', t => {
  const f = fixture(t)
  f.run('start', '--no-merge')
  assert.equal(f.status().outcomes[10].head, 'abc123')
  f.pushHead('fff999')
  const retried = f.run('retry', '10')
  assert.equal(retried.status, 0, JSON.stringify(retried.response))
  assert.equal(f.status().outcomes[10].head, 'fff999')
  assert.equal(f.ghCalls(/pr view 10/), 2)
})

test('the queue log names the recipient of each repair brief and whether Orca delivered it', t => {
  const f = fixture(t, { red: true, existing: true })
  f.run('start', '--no-merge')
  assert.match(f.status().log.at(-1).entry, /PR #10: delivered the repair brief to dispatch ctx_active in worktree worker-id/)
  const g = fixture(t, { red: true, existing: true })
  g.put('start-fail', '{"ok":false,"error":{"message":"agent_launch_failed: no agent"}}')
  const failed = g.run('start', '--no-merge')
  assert.equal(failed.status, 1)
  const state = g.status()
  assert.match(state.log.at(-1).entry, /PR #10: Orca did not deliver the repair brief to worktree worker-id: .*agent_launch_failed: no agent/)
  assert.equal(state.phase, 'paused')
  assert.equal(state.worker, undefined)
  assert.equal(state.operation, null)
  rmSync(join(g.root, 'start-fail'))
  const retried = g.run('retry', '10')
  assert.equal(retried.status, 0, JSON.stringify(retried.response))
  assert.equal(g.status().worker, 'ctx_active')
})

test('the Orca inbox updates the owner activity and a blocked message settles the PR once its worker has ended', t => {
  const f = fixture(t, { red: true })
  f.run('start', '--no-merge')
  f.put('inbox', inbox([message(6, 'structworker_other', 'blocked: not ours', { payload: 'plain text' }), message(5, 'structworker_ctx', 'Rebasing onto main\nmore detail'), message(4, 'dispatch:ctx_active', 'Reading the failing check')]))
  assert.equal(f.watch().status, 0)
  assert.match(readFileSync(join(f.root, 'orca-log'), 'utf8'), /orchestration inbox --terminal run:run-1 /)
  let state = f.status()
  assert.equal(state.workerHeard, 'Rebasing onto main')
  assert.equal(state.workerHeardAt, Date.parse('2026-11-25T10:00:00Z'))
  assert.match(state.log.at(-1).entry, /PR #10: worker ctx_active said: Rebasing onto main/)
  assert.equal(state.worker, 'ctx_active')
  assert.equal(state.outcomes[10], undefined)
  const entries = state.log.length
  assert.equal(f.watch().status, 0)
  assert.equal(f.status().log.length, entries)
  f.put('inbox', inbox([message(9, 'structworker_ctx', 'Waiting for an answer'), message(7, 'structworker_x', 'Worker went idle', { type: 'escalation', payload: '{"dispatchId":"ctx_active","stopReason":"idle"}' }), message(8, 'dispatch:ctx_active', 'blocked: the fix needs a design decision')]))
  assert.equal(f.watch().status, 0)
  state = f.status()
  assert.equal(state.outcomes[10], undefined)
  assert.equal(state.worker, 'ctx_active')
  assert.equal(state.step, 'blocked')
  assert.ok(state.log.some(item => /worker ctx_active said: Worker went idle/.test(item.entry)))
  assert.equal(state.workerHeard, 'Waiting for an answer')
  f.workerShow(exited)
  assert.equal(f.watch().status, 0)
  state = f.status()
  assert.deepEqual(state.outcomes[10], { kind: 'blocked', detail: 'worker ctx_active is blocked: the fix needs a design decision', head: 'abc123' })
  assert.equal(state.worker, null)
  assert.equal(f.dispatches(), 1)
})

test('a blocked message sent before a pushed report does not override the report, and one sent after it does', t => {
  const f = fixture(t, { red: true })
  f.run('start', '--no-merge')
  f.put('inbox', inbox([message(5, 'structworker_ctx', 'blocked: cannot reproduce the failure', { created_at: '2020-01-01T00:00:00Z' })]))
  f.pushHead('new456')
  assert.equal(f.run('report', '10', 'pushed').status, 0)
  let state = f.status()
  assert.equal(state.step, 'awaiting-head')
  assert.equal(state.heardSequence, 5)
  assert.match(state.log.at(-1).entry, /worker ctx_active said: blocked: cannot reproduce the failure/)
  f.put('inbox', inbox([message(6, 'structworker_ctx', 'blocked: the new head breaks the build', { created_at: new Date(Date.now() + 60000).toISOString() })]))
  assert.equal(f.watch().status, 0)
  state = f.status()
  assert.equal(state.step, 'blocked')
  assert.equal(state.blockedReason, 'worker ctx_active is blocked: the new head breaks the build')
})

test('a main turn end advances the PR queue when no watcher runs in its worktree, and leaves the queue to a watcher of any session there', t => {
  const f = fixture(t, { extraEnv: { NDEV_PR_CHECK_MS: '1' } })
  f.put('check-10', 'PENDING')
  f.run('start', '--no-merge')
  assert.equal(f.status().step, 'checks')
  f.put('check-10', 'SUCCESS')
  const turnEnd = () => {
    const result = spawnSync(ndev, ['hook', 'turn-complete', '--harness', 'claude'], { cwd: f.root, env: f.env, encoding: 'utf8', input: JSON.stringify({ session_id: 'fixture', cwd: f.root, turn_id: 't1' }) })
    assert.equal(result.status, 0, result.stderr || result.stdout)
  }
  const sessions = join(f.root, '.local/state/ndev/sessions')
  const watcher = join(sessions, 'another-session.watch.json')
  mkdirSync(sessions, { recursive: true })
  writeFileSync(watcher, JSON.stringify({ pid: process.pid, root: realpathSync(f.root), session: 'another-session' }))
  turnEnd()
  assert.equal(f.status().outcomes[10], undefined)
  rmSync(watcher)
  turnEnd()
  assert.deepEqual(f.status().outcomes[10], { kind: 'awaiting-human', detail: 'checks are green, waiting for a human merge', head: 'abc123' })
})

test('the watch tick resumes the saved queue and advances through checks, the owner wait, backoff and retry', t => {
  const f = fixture(t, { extraEnv: { NDEV_PR_CHECK_MS: '1' } })
  f.put('check-10', 'PENDING')
  f.run('start', '--no-merge')
  assert.match(f.status().log.at(-1).entry, /waiting for test on abc123/)
  assert.equal(f.watch().status, 0)
  assert.equal(f.ghCalls(/pr view 10/), 2)
  f.put('check-10', 'FAILURE')
  assert.equal(f.watch().status, 0)
  assert.equal(f.status().step, 'fixing')
  assert.equal(f.watch().status, 0)
  assert.equal(f.dispatches(), 1)
  f.put('gh-fail', 'API rate limit exceeded for user ID 1')
  const limited = f.watch()
  assert.equal(limited.status, 1)
  assert.match(limited.response.error.message, /rate limit/)
  let state = f.status()
  assert.equal(state.failures, 1)
  assert.equal(state.phase, 'running')
  assert.ok(state.nextAt - Date.now() > 50_000 && state.nextAt - Date.now() <= 60_000, String(state.nextAt - Date.now()))
  const reads = f.ghCalls(/./)
  assert.equal(f.watch().status, 0)
  assert.equal(f.ghCalls(/./), reads)
  assert.equal(f.run('resume').status, 1)
  state = f.status()
  assert.equal(state.failures, 2)
  assert.ok(state.nextAt - Date.now() > 110_000, String(state.nextAt - Date.now()))
  rmSync(join(f.root, 'gh-fail'))
  assert.equal(f.run('resume').status, 0)
  state = f.status()
  assert.equal(state.failures, 0)
  assert.equal(state.error, null)
  assert.equal(state.worker, 'ctx_active')
})

for (const [name, setup, check] of [
  ['merges a green PR when the project level lets the agent merge', f => f.put('.neil-dev.json', { github: { repo: 'fixture/demo', board: null }, projectLevel: 'poc' }), f => {
    assert.equal(f.status().outcomes[10].kind, 'merged')
    assert.match(readFileSync(join(f.root, 'merged-10'), 'utf8'), /--squash --match-head-commit abc123/)
  }],
  ['keeps a green PR for a human when the project level does not let the agent merge', () => {}, f => {
    assert.equal(f.status().outcomes[10].kind, 'awaiting-human')
    assert.equal(f.ghCalls(/pr merge/), 0)
  }],
  ['sends a draft PR to a worker', f => f.put('pr-10.json', { isDraft: true }), f => {
    assert.match(readFileSync(join(f.root, 'orca-log'), 'utf8'), /PR status: draft\./)
    assert.equal(f.ghCalls(/pr merge/), 0)
  }],
  ['sends a conflicting PR to a worker', f => f.put('pr-10.json', { mergeStateStatus: 'DIRTY' }), f => {
    assert.match(readFileSync(join(f.root, 'orca-log'), 'utf8'), /PR status: DIRTY\./)
  }],
  ['sends a red PR to a worker with its failing checks', f => f.put('check-10', 'FAILURE'), f => {
    assert.match(readFileSync(join(f.root, 'orca-log'), 'utf8'), /Failing checks: test\./)
  }],
]) {
  test(`fix-prs ${name}`, t => {
    const f = fixture(t)
    setup(f)
    const started = f.run('start')
    assert.equal(started.status, 0, JSON.stringify(started.response))
    check(f)
  })
}

test('an inbox message with a time Orca cannot parse fails the tick and names the message', t => {
  const f = fixture(t, { red: true })
  f.run('start', '--no-merge')
  f.put('inbox', inbox([message(5, 'structworker_ctx', 'Working', { created_at: 'soon' })]))
  const failed = f.watch()
  assert.equal(failed.status, 1)
  assert.match(failed.response.error.message, /msg-5.*soon/)
  assert.equal(f.status().workerHeard, null)
})

test('a worker that keeps writing to the inbox is not paused as stalled when Orca cannot prove it live', t => {
  const f = fixture(t, { red: true })
  f.run('start', '--no-merge')
  f.workerShow(showing('lost', 'retained'))
  const fresh = new Date().toISOString()
  f.put('inbox', inbox([message(5, 'structworker_ctx', 'Still working', { created_at: fresh })]))
  const file = join(f.env.HOME, '.local/state/ndev/fix-prs', readdirSync(join(f.env.HOME, '.local/state/ndev/fix-prs')).find(name => name.endsWith('.json')))
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), workerAt: Date.now() - 31 * 60_000 }))
  assert.equal(f.watch().status, 0)
  const state = f.status()
  assert.equal(state.phase, 'running')
  assert.equal(state.worker, 'ctx_active')
})

for (const value of ['abc', '0']) {
  test(`fix-prs refuses NDEV_PR_CHECK_MS=${value} before it changes the queue`, t => {
    const f = fixture(t, { extraEnv: { NDEV_PR_CHECK_MS: value } })
    const started = f.run('start')
    assert.equal(started.status, 2, JSON.stringify(started.response))
    assert.match(started.response.error.message, new RegExp(`NDEV_PR_CHECK_MS.*"${value}"`))
    assert.equal(existsSync(join(f.env.HOME, '.local/state/ndev/fix-prs')), false)
  })
}

test('the fix-all-prs panel shows the counts, step, failing checks, owner and failure that fix-prs status shows', t => {
  const f = fixture(t, { red: true, existing: true })
  f.run('start', '--no-merge')
  let status = f.status()
  assert.equal(renderPanel(f.panel().data), status.text)
  assert.match(status.text, /running · PR #10 · fixing · 0 of 2 done/)
  assert.match(status.text, /#10 Older: fixing · failing: test · owner ctx_active/)
  assert.match(status.text, /#20 Newer: queued/)
  f.pushHead('fed789')
  assert.equal(f.run('report', '10', 'pushed', '--worktree', f.root).status, 0)
  status = f.status()
  assert.equal(renderPanel(f.panel().data), status.text)
  assert.doesNotMatch(status.text, /failing:/)
  f.workerShow(exited)
  assert.equal(f.run('report', '10', 'blocked', '--reason', 'needs a design decision', '--worktree', f.root).status, 0)
  status = f.status()
  assert.equal(renderPanel(f.panel().data), status.text)
  assert.match(status.text, /1 of 2 done · 1 blocked/)
  assert.match(status.text, /#10 Older: needs a design decision/)
  const g = fixture(t, { red: true, existing: true })
  g.put('start-fail', '{"ok":false,"error":{"message":"agent_launch_failed: no agent"}}')
  assert.equal(g.run('start', '--no-merge').status, 1)
  status = g.status()
  assert.equal(renderPanel(g.panel().data), status.text)
  assert.match(status.text, /paused · .*Orca did not deliver the repair brief.*agent_launch_failed: no agent/)
})
