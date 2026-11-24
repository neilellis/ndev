import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ndev = fileURLToPath(new URL('../bin/ndev', import.meta.url))

function fixture(t, { red = false, existing = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ndev-queue-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const env = { HOME: root, PATH: `${root}${delimiter}${process.env.PATH}`, ORCA_CLI_COMMAND: join(root, 'orca') }
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
  writeFileSync(join(root, 'gh'), `#!/bin/sh
printf '%s\n' "$*" >> "${root}/gh-log"
case "$1 $2" in
  'api user') printf '%s\n' '{"login":"tester"}' ;;
  'pr list') printf '%s\n' '[{"number":20,"title":"Newer","createdAt":"2026-08-01"},{"number":10,"title":"Older","createdAt":"2026-07-01"}]' ;;
  'pr view') case "$3" in
    10) head=$(cat "${root}/head-10" 2>/dev/null || echo abc123); printf '%s\n' '{"number":10,"title":"Older","headRefOid":"'"$head"'","headRefName":"fix/ten","mergeStateStatus":"CLEAN","state":"OPEN","isDraft":false,"statusCheckRollup":[{"name":"test","conclusion":"${red ? 'FAILURE' : 'SUCCESS'}"}]}' ;;
    20) printf '%s\n' '{"number":20,"title":"Newer","headRefOid":"def456","headRefName":"fix/twenty","mergeStateStatus":"CLEAN","state":"OPEN","isDraft":false,"statusCheckRollup":[{"name":"test","conclusion":"SUCCESS"}]}' ;;
  esac ;;
  *) printf '%s\n' "unexpected gh $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 })
  writeFileSync(join(root, 'orca'), `#!/bin/sh
printf '%s\\n' "$*" >> "${root}/orca-log"
case "$1 $2" in
  'worktree list') printf '%s\n' '${JSON.stringify({ ok: true, result: { worktrees: existing ? [{ id: 'worker-id', path: worker, projectId: 'github:fixture/demo', branch: 'fix/ten' }] : [] } })}' ;;
  'worktree create') printf '%s\n' '${JSON.stringify({ ok: true, result: { worktree: { id: 'worker-id', path: worker } } })}' ;;
  'orchestration worker-start') cp "${worker}/.neil-dev.worktree.json" "${root}/launch-settings.json"; printf '%s\n' '{"ok":true,"result":{"dispatchId":"ctx_active"}}' ;;
  'orchestration worker-show') if [ -f "${root}/worker-show" ]; then cat "${root}/worker-show"; else printf '%s\n' '{"ok":true,"result":{"projection":{"liveness":{"verdict":"live"}},"state":"ready"}}'; fi ;;
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
  return { root, worker, run, workerShow, pushHead, dispatches }
}

const exited = { projection: { liveness: { verdict: 'exited' } }, terminalState: 'released', state: 'finished' }

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
  ['a failed task state with unverifiable liveness', { state: 'failed' }],
  ['a completed task state with a lost verdict', { state: 'completed', projection: { liveness: { verdict: 'lost' } } }],
  ['an exited process whose terminal is not released', { state: 'finished', projection: { liveness: { verdict: 'exited' } }, terminalState: 'stop_unknown' }],
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
