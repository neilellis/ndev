import { test } from 'node:test'
import assert from 'node:assert/strict'
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
'worktree list') if [ -n "$OWN_20" ]; then echo '{"ok":true,"result":{"worktrees":[{"id":"w20","projectId":"github:test/project","linkedItems":[{"type":"issue","number":20}]}]}}'; exit 0; fi; echo '{"ok":true,"result":{"worktrees":[]}}' ;;
'orchestration run-create') echo '{"ok":true,"result":{"run":{"id":"run-15"}}}' ;;
'orchestration task-create') echo '{"ok":true,"result":{"task":{"id":"task-15"}}}' ;;
'orchestration request-show') echo '{"ok":true,"result":{"state":"completed"}}' ;;
'orchestration worker-start') if [ -n "$START_UNKNOWN" ]; then echo '{"ok":false,"error":{"message":"lost response","data":{"requestId":"req-15"}}}'; exit 1; fi; if [ -n "$START_FAIL" ]; then echo '{"ok":true,"result":{"state":"failed","failedStage":"agent","lastError":"agent refused","dispatchId":"d-failed"}}'; exit 1; fi; echo '{"ok":true,"result":{"state":"ready","dispatchId":"d-15","worktree":"w-15"}}' ;;
'orchestration task-list') echo '{"ok":true,"result":{"tasks":[]}}' ;;
'orchestration worker-show') if [ -n "$WORKER_FAILED" ]; then echo '{"ok":true,"result":{"state":"failed","lastError":"lost worker"}}'; exit 0; fi; echo '{"ok":true,"result":{"state":"completed","pr":55}}' ;;
'orchestration inbox') echo '{"ok":true,"result":{"messages":[]}}' ;;
*) echo "unsupported orca $*" >&2; exit 23 ;;
esac`)
  fixture('gh', 'echo "ok"')
  function cli(args, extra) {
    const result = run(bin, ['triage', ...args, '--json'], extra)
    const data = JSON.parse(result.stdout)
    return { ...data, status: result.status }
  }
  function ok(args, extra) { const value = cli(args, extra); assert.equal(value.status, 0, JSON.stringify(value.error)); return value.result }
  return { root, env, input, cli, ok, log: () => readFileSync(log, 'utf8'), json: value => writeFileSync(input, JSON.stringify(value)) }
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
