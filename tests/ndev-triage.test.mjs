import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const bin = fileURLToPath(new URL('../bin/ndev', import.meta.url))
function project(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ndev-triage-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const localBin = join(root, 'bin')
  mkdirSync(localBin)
  const log = join(root, 'commands')
  const env = { HOME: root, PATH: localBin + ':' + process.env.PATH, XDG_STATE_HOME: join(root, 'state'), GH_CONFIG_DIR: join(root, 'gh-config'), CODEX_HOME: join(root, '.codex'), ORCA_ENVIRONMENT: 'local', SSH_CONNECTION: 'integration test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', FAKE_LOG: log, NDEV_FLOW_GH: join(localBin, 'gh.sh'), GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' }
  function run(exe, args, extra = {}) {
    return spawnSync(exe, args, { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' })
  }
  function git(...args) { const r = run('git', args); assert.equal(r.status, 0, r.stderr) }
  git('init', '-q', '-b', 'main')
  git('commit', '--allow-empty', '-qm', 'Fix #15')
  git('init', '-q', '--bare', 'origin.git')
  git('remote', 'add', 'origin', join(root, 'origin.git'))
  git('push', '-qu', 'origin', 'main')
  writeFileSync(join(root, '.neil-dev.json'), JSON.stringify({ github: { repo: 'test/project', board: null } }))
  const input = join(root, 'input.json')
  const metrics = join(root, 'metrics.mjs')
  writeFileSync(metrics, `import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module'; os.loadavg = () => [Number(process.env.FAKE_LOAD || 0), 0, 0]; os.availableParallelism = () => 10; syncBuiltinESMExports();`)
  env.NODE_OPTIONS = '--import=' + metrics
  function fixture(name, script) {
    const path = join(localBin, name)
    writeFileSync(path, '#!/bin/sh\necho "' + name + ' $*" >> "$FAKE_LOG"\n' + script)
    chmodSync(path, 0o755)
  }
  fixture('gh.sh', `case "$1" in
  board) echo '{"number":15,"status":"Ready","title":"Mine","url":"https://github.com/test/project/issues/15","author":"me"}'
  echo '{"number":20,"status":"Ready","title":"Not mine","url":"https://github.com/test/project/issues/20","author":"other"}'
  echo '{"number":99,"status":"Ready","title":"Foreign","url":"https://github.com/other/repo/issues/99","author":"me"}'
  echo '{"number":7,"status":"Done","title":"Old","url":"https://github.com/test/project/issues/7","author":"me"}' ;;
  issue-search) [ -n "$2" ] || { echo "missing search query" >&2; exit 2; }; for n in 12 15 20; do echo "{\\"number\\":$n,\\"title\\":\\"Issue $n\\",\\"url\\":\\"https://github.com/test/project/issues/$n\\"}"; done ;;
  issue-read) echo '{"state":"open","title":"Issue","body":"Issue body"}' ;;
  default-branch) echo '{"default_branch":"main"}' ;;
  pr-search) echo '{"number":55,"title":"Fix #15","merged":true}' ;;
  pr-read) echo '{"number":55,"head":{"sha":"aaaaaaa","ref":"feature"},"state":"open","mergeable":true}' ;;
  api) if [ "$2" = "user" ]; then echo '{"login":"me"}'; exit 0; fi
  echo '{"data":{"repository":{"i12":{"number":12,"title":"12","body":"Evidence 12"},"i15":{"number":15,"title":"15","body":"Evidence 15"},"i20":{"number":20,"title":"20","body":"Evidence 20"}}}}' ;;
  label|issue-close) echo '{"ok":true}' ;;
  *) echo "unsupported gh $*" >&2; exit 21 ;;
esac`)
  fixture('orca', `case "$1 $2" in
'worktree list') if [ -n "$DUPLICATE_WORKTREE" ]; then
  if [ "$5" = "--environment" ] && [ "$6" = "remote-host" ]; then
    echo '{"ok":true,"result":{"worktrees":[{"id":"w-15","projectId":"github:test/project","linkedPR":56}]}}'
  else
    echo '{"ok":true,"result":{"worktrees":[{"id":"w-15","projectId":"github:test/project","linkedPR":99}]}}'
  fi
  exit 0
fi; if [ -n "$OWN_20" ]; then echo '{"ok":true,"result":{"worktrees":[{"id":"w20","projectId":"github:test/project","linkedItems":[{"type":"issue","number":20}]}]}}'; exit 0; fi; echo '{"ok":true,"result":{"worktrees":[]}}' ;;
'terminal create') echo '{"ok":true,"result":{"terminal":{"handle":"term-triage"}}}' ;;
'worktree activate') echo '{"ok":true,"result":{"activated":true}}' ;;
'orchestration run-create'|'orchestration task-create'|'orchestration worker-start')
  if [ -n "$REJECT_SENDER" ] || { [ -n "$REQUIRE_SENDER" ] && [ "$ORCA_TERMINAL_HANDLE" != "term-triage" ]; }; then
    echo '{"ok":false,"error":{"code":"no_active_sender_terminal","message":"No active sender"}}'
    exit 1
  fi
  echo "sender $2 $ORCA_TERMINAL_HANDLE" >> "$FAKE_LOG"
  case " $* " in
    *' --full '*) ;;
    *) echo '{"ok":true,"result":{"runId":"run-15","taskId":"task-15"}}'; exit 0 ;;
  esac
  case "$2" in
run-create) echo '{"ok":true,"result":{"run":{"id":"run-15"}}}' ;;
task-create) echo '{"ok":true,"result":{"task":{"id":"task-15"}}}' ;;
worker-start) if [ -n "$START_RECEIPT" ]; then printf '%s\n' "$START_RECEIPT"; exit 1; fi; if [ -n "$START_UNKNOWN" ]; then echo '{"ok":false,"error":{"message":"lost response","data":{"orchestrationRequestId":"req-15"}}}'; exit 1; fi; if [ -n "$START_FAIL" ]; then echo '{"ok":true,"result":{"state":"failed","failedStage":"agent","lastError":"agent refused","dispatchId":"d-failed","projection":{"liveness":{"verdict":"exited"}}}}'; exit 1; fi; echo '{"ok":true,"result":{"state":"ready","dispatchId":"d-15","effects":[{"kind":"worktree","id":"w-15"}]}}' ;;
  esac ;;
'orchestration request-show') echo '{"ok":true,"result":{"state":"completed"}}' ;;
'orchestration worker-list')
  if [ -n "$WORKER_PAGED" ]; then
    case " $* " in
      *' --cursor older '*) echo '{"ok":true,"result":{"workers":[{"taskId":"task-15","dispatchId":"d-old","terminalState":"active","projection":{"liveness":{"verdict":"alive"}}}],"page":{"hasMore":false}}}' ;;
      *) echo '{"ok":true,"result":{"workers":[{"taskId":"task-15","dispatchId":"d-failed","terminalState":"released","projection":{"liveness":{"verdict":"exited"}}}],"page":{"hasMore":true,"nextCursor":"older"}}}' ;;
    esac
    exit 0
  fi
  if [ -n "$WORKER_LIST" ]; then printf '%s\n' "$WORKER_LIST"; exit 0; fi
  echo '{"ok":true,"result":{"workers":[{"taskId":"task-15","dispatchId":"d-failed","terminalState":"released","projection":{"liveness":{"verdict":"exited"}}},{"taskId":"task-15","dispatchId":"d-15","terminalState":"released","projection":{"liveness":{"verdict":"exited"}}}],"page":{"hasMore":false}}}' ;;
'orchestration task-list') echo '{"ok":true,"result":{"tasks":[]}}' ;;
'orchestration worker-show') if [ -n "$WORKER_SHOW" ]; then printf '%s\n' "$WORKER_SHOW"; exit 0; fi; if [ -n "$NATIVE_RECEIPT" ]; then
  echo '{"ok":true,"result":{"dispatch":{"status":"failed"},"worker":{"worktreeId":"w-15","state":"stopped","lastError":"Worker process stopped"},"projection":{"liveness":{"verdict":"exited"}}}}'
  exit 0
fi; if [ -n "$WORKER_FAILED" ]; then echo '{"ok":true,"result":{"state":"failed","lastError":"lost worker","projection":{"liveness":{"verdict":"exited"}}}}'; exit 0; fi; echo '{"ok":true,"result":{"state":"completed","pr":55}}' ;;
'orchestration inbox') if [ -n "$NATIVE_RECEIPT" ]; then
  echo '{"ok":true,"result":{"messages":[{"id":"q1","run_id":"run-15","thread_id":"q1","from_handle":"worker","to_handle":"coordinator","type":"question","body":"Which fixture should I use?"},{"id":"q2","run_id":"run-15","thread_id":"q2","from_handle":"worker","to_handle":"coordinator","type":"question","body":"Can I proceed?"},{"id":"r2","run_id":"run-15","thread_id":"q2","from_handle":"coordinator","to_handle":"worker","type":"status","body":"Yes."},{"id":"q3","run_id":"another-run","thread_id":"q3","from_handle":"worker","to_handle":"coordinator","type":"question","body":"Unrelated question"}]}}'
  exit 0
fi; echo '{"ok":true,"result":{"messages":[]}}' ;;
*) echo "unsupported orca $*" >&2; exit 23 ;;
esac`)
  fixture('gh', 'echo "ok"')
  function cli(args, extra) {
    const result = run(bin, ['triage', ...args, '--json'], extra)
    const data = JSON.parse(result.stdout)
    return { ...data, status: result.status }
  }
  function ok(args, extra) { const value = cli(args, extra); assert.equal(value.status, 0, JSON.stringify(value.error)); return value.result }
  function paneWithEnv(extra, ...args) {
    const result = run(bin, ['pane', 'bridge', ...args, '--json'], extra)
    return { ...JSON.parse(result.stdout), status: result.status }
  }
  return { root, env, input, cli, ok, pane: (...args) => paneWithEnv({}, ...args), paneWithEnv, log: () => readFileSync(log, 'utf8'), json: value => writeFileSync(input, JSON.stringify(value)) }
}
const group = (issues, extra = {}) => ({ issues, title: 'Fix group ' + issues[0], complexity: 'complex', hint: 'Exercise the public CLI', ...extra })
test('triage dry-run validates a full partition, then starts one worker at a time in dependency order', t => {
  const p = project(t)
  const initial = p.ok(['start', '--dry-run', '--open', '--bugs-only', '--codex', '--sequential', '--reverse'])
  assert.equal(initial.phase, 'grouping')
  assert.deepEqual(initial.issues.map(i => i.number), [20, 15, 12])
  p.json({ groups: [group([12, 12])] })
  const duplicate = p.cli(['groups', '--file', p.input])
  assert.equal(duplicate.status, 2)
  assert.match(duplicate.error.message, /#12.*twice|duplicate.*12/i)
  p.json({ groups: [group([12]), group([15], { after: [12] })], screened: [{ issue: 20, kind: 'human', reason: 'Needs an account' }] })
  const plan = p.ok(['groups', '--file', p.input])
  assert.equal(plan.phase, 'planned')
  assert.doesNotMatch(p.log(), /run-create|worker-start|gh.sh label/)
  const started = p.ok(['launch'])
  assert.equal(started.runId, 'run-15')
  assert.equal(started.groups.find(g => g.lead === 12).dispatchId, 'd-15')
  assert.equal(started.groups.find(g => g.lead === 15).dispatchId, undefined)
  assert.match(p.log(), /--agent codex/)
  p.ok(['refresh'])
  assert.equal(p.log().match(/orca orchestration worker-start/g).length, 2)
  assert.match(p.log(), /--base-branch (origin\/)?feature/)
  p.ok(['reset'])
  assert.equal(p.ok(['status']).phase, 'idle')
  assert.doesNotMatch(p.log(), /orchestration reset|worker-stop/)
})
test('a partial launch records the Run and failed dispatch receipt without relaunching it', t => {
  const p = project(t)
  p.ok(['start', '--dry-run', '--open'])
  p.json({ groups: [group([12, 15, 20])] })
  p.ok(['groups', '--file', p.input])
  const first = p.cli(['launch'], { START_FAIL: '1' })
  assert.equal(first.status, 1)
  assert.match(first.error.message, /run-15/)
  assert.match(first.error.message, /agent refused/)
  const failed = p.pane('snapshot', 'triage').result.data.triage?.groups[0]
  assert.equal(failed?.status, 'failed')
  assert.match(failed.error, /agent refused/)
  const state = p.ok(['status'])
  assert.equal(state.groups[0].dispatchId, 'd-failed')
  assert.doesNotMatch(p.log(), /worker-stop/)
  const repaired = p.ok(['launch'])
  assert.equal(repaired.groups[0].status, 'running')
  assert.match(p.log(), /--retry-of d-failed/)
})
test('an uncertain Orca start recovers the request before replay on the same Run', t => {
  const p = project(t)
  p.ok(['start', '--dry-run', '--open'])
  p.json({ groups: [group([12, 15, 20])] })
  p.ok(['groups', '--file', p.input])
  const first = p.cli(['launch'], { START_UNKNOWN: '1' })
  assert.equal(first.status, 1)
  const replay = p.ok(['launch'])
  assert.equal(replay.groups[0].dispatchId, 'd-15')
  const log = p.log()
  assert.ok(log.indexOf('orchestration request-show --request req-15') < log.indexOf('--retry-request req-15'))
  assert.equal(log.match(/orchestration run-create/g).length, 1)
})
test('clean requires evidence and one verdict per issue, and binds each close to human confirmation and revision', async t => {
  const p = project(t)
  const clean = p.ok(['clean'])
  assert.equal(clean.phase, 'cleaning')
  assert.ok(JSON.stringify(clean.chunk).includes('Evidence 15'))
  const keep = issue => ({ issue, verdict: 'needs_work', confidence: 'high', evidence: 'Open' })
  p.json({ verdicts: [keep(12), { issue: 15, verdict: 'done', confidence: 'high', evidence: 'saw it' }] })
  const bad = p.cli(['clean-verdicts', '--file', p.input])
  assert.equal(bad.status, 2)
  assert.match(bad.error.message, /#15.*evidence/)
  assert.match(bad.error.message, /#20/)
  p.json({ verdicts: [keep(12), { issue: 15, verdict: 'done', confidence: 'high', evidence: 'PR #55 implements the fix' }, keep(20)] })
  const ready = p.ok(['clean-verdicts', '--file', p.input])
  assert.equal(ready.phase, 'confirming')
  const stale = p.cli(['confirm', '--issue', '15', '--revision', String(ready.revision - 1), 'close'])
  assert.equal(stale.status, 5)
  const next = p.ok(['confirm', '--issue', '15', '--revision', String(ready.revision), 'close']).nextAction
  assert.equal(next.action, 'triage.confirm')
  assert.equal(next.worktreeId, ready.worktreeId)
  assert.equal(next.revision, ready.revision)
  assert.deepEqual(next.target, { repo: 'test/project', issue: 15, decision: 'close', evidence: 'PR #55 implements the fix' })
  assert.equal(p.ok(['status']).revision, ready.revision)
  assert.doesNotMatch(p.log(), /issue-close|gh issue close/)
  const kept = p.ok(['confirm', '--issue', '15', '--revision', String(ready.revision), 'keep'])
  assert.equal(kept.phase, 'done')
  assert.doesNotMatch(p.log(), /issue-close|gh issue close/)
})

test('native close confirmation binds the selected issue and revision and sends one GitHub close', t => {
  const p = project(t)
  p.ok(['clean'])
  const proposals = [12, 15, 20].map(issue => ({ issue, verdict: 'done', confidence: 'high', evidence: 'Implemented by #55' }))
  p.json({ verdicts: proposals })
  const state = p.ok(['clean-verdicts', '--file', p.input])
  const module = new URL('../scripts/ndev/triage.mjs', import.meta.url)
  const script = `import {runTriage} from ${JSON.stringify(module)}; const result = await runTriage(['confirm','--issue','15','--revision',${JSON.stringify(String(state.revision))},'close'],{ confirm: async binding => binding.worktreeId === ${JSON.stringify(state.worktreeId)} && binding.revision === ${state.revision} && binding.target.issue === 15 && binding.target.repo === 'test/project' }); console.log(JSON.stringify(result))`
  const done = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: p.root, env: p.env, encoding: 'utf8' })
  assert.equal(done.status, 0, done.stderr)
  assert.equal(JSON.parse(done.stdout).verdicts.find(v => v.issue === 15).decision, 'closed')
  const calls = p.log().split('\n').filter(line => line.startsWith('gh issue close'))
  assert.equal(calls.length, 1)
  assert.ok(calls.every(line => line.startsWith('gh issue close 15 --repo test/project')))
})
test('the watcher does no external work for missing triage state or a saved dry plan', t => {
  const p = project(t)
  const mod = new URL('../scripts/ndev/triage.mjs', import.meta.url)
  const tick = () => spawnSync(process.execPath, ['--input-type=module', '-e', `import {tickTriage} from ${JSON.stringify(mod)}; console.log(await tickTriage(process.cwd()))`], { cwd: p.root, env: p.env, encoding: 'utf8' })
  const idle = tick()
  assert.equal(idle.stdout.trim(), 'null', idle.stderr)
  p.ok(['start', '--dry-run', '--open'])
  p.json({ groups: [group([12, 15, 20])] })
  p.ok(['groups', '--file', p.input])
  const before = p.log()
  assert.equal(tick().stdout.trim(), 'null')
  assert.equal(p.log(), before)
})
test('board filters scope Ready and In progress cards to the repository, author and issue floor', t => {
  const p = project(t)
  writeFileSync(join(p.root, '.neil-dev.json'), JSON.stringify({ github: { repo: 'test/project', board: { owner: 'test', number: 8 } } }))
  const state = p.ok(['start', '--mine', '--since', '8', '--dry-run'])
  assert.deepEqual(state.issues.map(i => i.number), [15])
  assert.match(p.log(), /board items/)
  assert.match(p.log(), /api user/)
  assert.doesNotMatch(p.log(), /issue-search/)
  p.json({ groups: [] })
  const failed = p.cli(['groups', '--file', p.input])
  assert.equal(failed.status, 2)
  assert.match(failed.error.message, /#15/)
})

test('restarting a failed predecessor recovers its descendants while preserving ownership blocks', t => {
  const p = project(t)
  p.ok(['start', '--dry-run', '--open'])
  p.json({ groups: [group([12]), group([15], { after: [12] }), group([20])] })
  p.ok(['groups', '--file', p.input])
  p.ok(['launch'], { OWN_20: '1' })
  const failed = p.ok(['refresh'], { WORKER_FAILED: '1', OWN_20: '1' })
  assert.deepEqual(failed.groups.map(g => g.status), ['failed', 'blocked', 'blocked'])
  p.ok(['launch'])
  const resumed = p.ok(['refresh'])
  assert.deepEqual(resumed.groups.map(g => g.status), ['done', 'running', 'blocked'])
  assert.equal(resumed.phase, 'running')
})

test('the triage pane publishes each issue and opens only a group workspace advertised at its revision', t => {
  const p = project(t)
  p.ok(['start', '--dry-run', '--open'])
  p.json({ groups: [group([12, 15])], skipped: [{ issue: 20, reason: 'Outside scope' }] })
  p.ok(['groups', '--file', p.input])
  const plan = p.pane('snapshot', 'triage').result
  assert.equal(plan.data.triage?.phase, 'planned')
  assert.deepEqual(plan.data.triage.groups[0].issues, [
    { number: 12, title: 'Issue 12', url: 'https://github.com/test/project/issues/12' },
    { number: 15, title: 'Issue 15', url: 'https://github.com/test/project/issues/15' },
  ])
  assert.equal(plan.data.triage.skipped[0].reason, 'Outside scope')
  assert.equal(plan.data.actions.some(action => action.id === 'triage.workspace'), false)
  p.ok(['launch'])
  const running = p.pane('snapshot', 'triage').result
  assert.equal(running.data.triage.groups[0].status, 'running')
  const activate = (lead, expectedRevision = running.revision) => p.pane('action', 'triage', JSON.stringify({
    worktreeId: running.worktreeId, expectedRevision, actionId: 'triage.workspace', input: { lead },
  }))
  assert.equal(activate(15).ok, false)
  assert.equal(activate(12, plan.revision).ok, false)
  assert.doesNotMatch(p.log(), /worktree activate/)
  assert.equal(activate(12).result.result.activated, true)
  assert.match(p.log(), /worktree activate --worktree id:w-15 --environment local/)
  p.ok(['refresh'])
  const completedPanel = p.pane('snapshot', 'triage').result.data
  const completed = completedPanel.triage.groups[0]
  assert.ok(completedPanel.actions.some(action => action.id === 'triage.refresh'))
  assert.equal(completed.status, 'done')
  assert.deepEqual(completed.pr, { number: 55, state: 'open', url: 'https://github.com/test/project/pull/55' })
})

test('opening the pane upgrades a saved plan from the older flat snapshot', t => {
  const p = project(t)
  p.ok(['start', '--dry-run', '--open'])
  p.json({ groups: [group([12, 15, 20])] })
  p.ok(['groups', '--file', p.input])
  const file = join(p.root, '.git', 'ndev-state', 'panels', 'triage.json')
  const legacy = JSON.parse(readFileSync(file, 'utf8'))
  delete legacy.data.triage
  writeFileSync(file, JSON.stringify(legacy))
  const first = p.pane('snapshot', 'triage').result
  assert.equal(first.data.triage?.phase, 'planned')
  assert.deepEqual(first.data.triage.groups[0].issues.map(issue => issue.number), [12, 15, 20])
  assert.equal(first.revision, legacy.revision + 1)
  assert.deepEqual(p.pane('snapshot', 'triage').result, first)
  assert.doesNotMatch(p.log(), /run-create|worker-start/)
})

test('workspace actions reject an old snapshot after the underlying run is saved without publishing', t => {
  const p = project(t)
  p.ok(['start', '--dry-run', '--open'])
  p.json({ groups: [group([12, 15, 20])] })
  p.ok(['groups', '--file', p.input])
  p.ok(['launch'])
  const running = p.pane('snapshot', 'triage').result
  const key = createHash('sha256').update(p.root).digest('hex')
  const file = join(p.env.XDG_STATE_HOME, 'ndev', 'triage', key + '.json')
  const state = JSON.parse(readFileSync(file, 'utf8'))
  state.phase = 'idle'
  state.groups = []
  state.revision++
  writeFileSync(file, JSON.stringify(state))
  const action = p.pane('action', 'triage', JSON.stringify({
    worktreeId: running.worktreeId, expectedRevision: running.revision, actionId: 'triage.workspace', input: { lead: 12 },
  }))
  assert.equal(action.ok, false)
  assert.doesNotMatch(p.log(), /worktree activate/)
  assert.equal(p.pane('snapshot', 'triage').result.data.triage.phase, 'idle')
})

test('workspace IDs and pull requests are matched on the worker host', t => {
  const p = project(t)
  p.ok(['start', '--dry-run', '--open'])
  p.json({ groups: [group([12, 15, 20])] })
  p.ok(['groups', '--file', p.input])
  p.ok(['launch'])
  const key = createHash('sha256').update(p.root).digest('hex')
  const file = join(p.env.XDG_STATE_HOME, 'ndev', 'triage', key + '.json')
  const state = JSON.parse(readFileSync(file, 'utf8'))
  state.remote = { id: 'remote-host' }
  state.groups[0].workerHost = 'remote-host'
  writeFileSync(file, JSON.stringify(state))
  p.ok(['refresh'], { DUPLICATE_WORKTREE: '1' })
  const completed = p.pane('snapshot', 'triage').result.data.triage.groups[0]
  assert.equal(completed.workspace.host, 'remote-host')
  assert.equal(completed.pr.number, 56)
})

test('triage displays failure and unanswered questions from native Orca receipts', t => {
  const p = project(t)
  p.ok(['start', '--dry-run', '--open'])
  p.json({ groups: [group([12, 15, 20])] })
  p.ok(['groups', '--file', p.input])
  p.ok(['launch'])
  const status = p.ok(['refresh'], { NATIVE_RECEIPT: '1' })
  assert.equal(status.phase, 'done')
  assert.equal(status.groups[0].status, 'failed')
  assert.equal(status.groups[0].error, 'Worker process stopped')
  assert.deepEqual(p.pane('snapshot', 'triage').result.data.sections.find(section => section.title === 'Questions')?.rows, [
    { label: 'worker', value: 'Which fixture should I use?' },
  ])
})

test('Launch from the Orca pane gets its own sender and reuses it for subsequent workers', t => {
  const p = project(t)
  p.ok(['start', '--dry-run', '--open', '--batch', '1'])
  p.json({ groups: [group([12]), group([15, 20])] })
  p.ok(['groups', '--file', p.input])
  const snapshot = p.pane('snapshot', 'triage').result
  const launch = p.paneWithEnv({ REQUIRE_SENDER: '1', ORCA_TERMINAL_HANDLE: '' }, 'action', 'triage', JSON.stringify({
    worktreeId: snapshot.worktreeId, expectedRevision: snapshot.revision, actionId: 'triage.launch', input: {},
  }))
  assert.equal(launch.ok, true, JSON.stringify(launch.error))
  assert.equal(launch.result.snapshot.data.triage.phase, 'running')
  p.ok(['refresh'], { REQUIRE_SENDER: '1', ORCA_TERMINAL_HANDLE: '' })
  assert.equal(p.log().match(/orca terminal create/g)?.length, 1)
  assert.equal(p.log().match(/sender worker-start term-triage/g)?.length, 2)
  assert.match(p.log(), /sender run-create term-triage/)
  assert.match(p.log(), /sender task-create term-triage/)
})

test('an explicit missing-sender rejection leaves the plan ready to retry', t => {
  const p = project(t)
  p.ok(['start', '--dry-run', '--open'])
  p.json({ groups: [group([12, 15, 20])] })
  p.ok(['groups', '--file', p.input])
  const rejected = p.cli(['launch'], { REJECT_SENDER: '1' })
  assert.equal(rejected.ok, false)
  assert.match(rejected.error.message, /No active sender/)
  assert.match(rejected.error.repair, /ndev triage launch/)
  const status = p.ok(['status'])
  assert.equal(status.phase, 'planned')
  assert.equal(status.runId, undefined)
  assert.deepEqual(status.groups[0].issues, [12, 15, 20])
  assert.equal(status.operations?.run, undefined)
  assert.equal(p.ok(['launch']).phase, 'running')
})

test('opening the pane restores a plan wedged by the old missing-sender error', t => {
  const p = project(t)
  p.ok(['start', '--dry-run', '--open'])
  p.json({ groups: [group([12, 15, 20])] })
  p.ok(['groups', '--file', p.input])
  const key = createHash('sha256').update(p.root).digest('hex')
  const file = join(p.env.XDG_STATE_HOME, 'ndev', 'triage', key + '.json')
  const state = JSON.parse(readFileSync(file, 'utf8'))
  state.phase = 'running'
  state.operations = { run: { receipt: { ok: false, error: { code: 'no_active_sender_terminal' } } } }
  state.revision++
  writeFileSync(file, JSON.stringify(state))
  const snapshot = p.pane('snapshot', 'triage').result
  assert.equal(snapshot.data.triage.phase, 'planned')
  assert.ok(snapshot.data.actions.some(action => action.id === 'triage.launch'))
  assert.equal(p.ok(['status']).operations.run, undefined)
  assert.doesNotMatch(p.log(), /run-create|worker-start/)
})

function planned(t, options = []) {
  const p = project(t)
  p.ok(['start', '--dry-run', '--open', ...options])
  p.json({ groups: [group([12]), group([15, 20])] })
  p.ok(['groups', '--file', p.input])
  return p
}

test('a failed Orca dispatch with a live or uncertain process keeps its slot and needs attention', t => {
  for (const verdict of ['alive', 'unverifiable', undefined]) {
    const p = planned(t, ['--batch', '1'])
    p.ok(['launch'])
    const state = p.ok(['refresh'], { WORKER_SHOW: JSON.stringify({ ok: true, result: { state: 'failed', lastError: 'startup deadline', projection: { liveness: { verdict } } } }) })
    assert.equal(state.groups[0].status, 'running')
    assert.equal(state.groups[0].stalled, true)
    assert.match(state.groups[0].error, /d-15.*startup deadline/)
    assert.equal(p.log().match(/orca orchestration worker-start/g).length, 1)
  }
})

test('retry refuses an older Task attempt that is still live, even when the latest exited', t => {
  const p = planned(t)
  p.cli(['launch'], { START_FAIL: '1' })
  const workers = [
    { taskId: 'task-15', dispatchId: 'd-failed', terminalState: 'released', projection: { liveness: { verdict: 'exited' } } },
    { taskId: 'task-15', dispatchId: 'd-old', terminalState: 'active', projection: { liveness: { verdict: 'alive' } } },
  ]
  const result = p.cli(['launch'], { WORKER_LIST: JSON.stringify({ ok: true, result: { workers, page: { hasMore: false } } }) })
  assert.equal(result.status, 1)
  assert.match(result.error.message, /d-old.*alive/)
  assert.match(result.error.repair, /worker-show --dispatch d-old/)
  assert.equal(p.log().match(/orca orchestration worker-start/g).length, 1)
  assert.doesNotMatch(p.log(), /worker-stop|worker-release|terminal close/)
})

test('retry refuses missing or unreleased worker evidence and preserves the failed dispatch', t => {
  for (const workers of [[], [{ taskId: 'task-15', dispatchId: 'd-failed', terminalState: 'release_unknown', projection: { liveness: { verdict: 'exited' } } }]]) {
    const p = planned(t)
    p.cli(['launch'], { START_FAIL: '1' })
    const result = p.cli(['launch'], { WORKER_LIST: JSON.stringify({ ok: true, result: { workers, page: { hasMore: false } } }) })
    assert.equal(result.status, 1)
    assert.equal(p.ok(['status']).groups[0].dispatchId, 'd-failed')
    assert.equal(p.log().match(/orca orchestration worker-start/g).length, 1)
  }
})

test('triage defaults to one worker and defers an overloaded local launch without losing the plan', t => {
  const p = planned(t)
  const held = p.ok(['launch'], { FAKE_LOAD: '150' })
  assert.equal(held.groups[0].status, 'queued')
  assert.match(held.admission.reason, /150.*10/)
  assert.doesNotMatch(p.log(), /orca orchestration worker-start/)
  const resumed = p.ok(['launch'], { FAKE_LOAD: '10' })
  assert.equal(resumed.groups[0].status, 'running')
  assert.equal(resumed.groups[1].status, 'queued')
  assert.equal(resumed.admission, undefined)
})

test('a failed start receipt with live worker evidence retains the occupied slot', t => {
  const p = planned(t)
  const result = p.cli(['launch'], { START_RECEIPT: JSON.stringify({ ok: true, result: { state: 'failed', dispatchId: 'd-live', lastError: 'readiness elapsed', projection: { liveness: { verdict: 'alive' } } } }) })
  assert.equal(result.status, 1)
  const state = p.ok(['status'])
  assert.equal(state.groups[0].status, 'running')
  assert.equal(state.groups[0].dispatchId, 'd-live')
  assert.equal(state.groups[0].stalled, true)
  p.ok(['launch'])
  assert.equal(p.log().match(/orca orchestration worker-start/g).length, 1)
})

test('retry checks older worker pages and refuses repeated cursors', t => {
  const p = planned(t)
  p.cli(['launch'], { START_FAIL: '1' })
  const paged = p.cli(['launch'], { WORKER_PAGED: '1' })
  assert.equal(paged.status, 1)
  assert.match(paged.error.message, /d-old.*alive/)
  assert.match(p.log(), /worker-list.*--cursor older/)
  const repeated = p.cli(['launch'], { WORKER_LIST: JSON.stringify({ ok: true, result: { workers: [], page: { hasMore: true, nextCursor: 'same' } } }) })
  assert.equal(repeated.status, 1)
  assert.match(repeated.error.message, /cursor/)
  assert.equal(p.log().match(/orca orchestration worker-start/g).length, 1)
})

test('paired execution serializes a requested batch instead of using coordinator load', t => {
  const p = planned(t, ['--batch', '5'])
  const key = createHash('sha256').update(p.root).digest('hex')
  const file = join(p.env.XDG_STATE_HOME, 'ndev', 'triage', key + '.json')
  const state = JSON.parse(readFileSync(file, 'utf8'))
  state.host = 'paired-host'
  writeFileSync(file, JSON.stringify(state))
  const launched = p.ok(['launch'], { FAKE_LOAD: '150' })
  assert.equal(launched.groups[0].status, 'running')
  assert.equal(launched.groups[1].status, 'queued')
  assert.equal(p.log().match(/orca orchestration worker-start/g).length, 1)
})

test('a retry queued by host load rechecks worker exit before dispatching later', t => {
  const p = planned(t)
  p.cli(['launch'], { START_FAIL: '1' })
  const queued = p.ok(['launch'], { FAKE_LOAD: '150' })
  assert.equal(queued.groups[0].status, 'queued')
  assert.equal(queued.groups[0].previousDispatch, 'd-failed')
  const workers = [{ taskId: 'task-15', dispatchId: 'd-failed', terminalState: 'active', projection: { liveness: { verdict: 'alive' } } }]
  const resumed = p.cli(['launch'], { WORKER_LIST: JSON.stringify({ ok: true, result: { workers, page: { hasMore: false } } }) })
  assert.equal(resumed.status, 1)
  assert.match(resumed.error.message, /d-failed.*alive/)
  assert.equal(p.log().match(/orca orchestration worker-start/g).length, 1)
})
