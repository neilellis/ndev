import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { confirmInTerminal } from './terminal-confirm.mjs'

const ndev = fileURLToPath(new URL('../bin/ndev', import.meta.url))

function fixture(t, { remoteChanges = false, rollup = [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }], workflow = {} } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ndev-watch-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const env = { HOME: root, PATH: `${root}${delimiter}${process.env.PATH}`, ORCA_TERMINAL_HANDLE: 'term_fixture', ORCA_CLI_COMMAND: join(root, 'orca'), NDEV_WORKFLOW_CHECK_MS: '1', NDEV_OSASCRIPT: 'true', NDEV_WATCH_COMPACT_HOOK_MS: '200' }
  mkdirSync(join(root, 'home'))
  const git = (...argv) => {
    const result = spawnSync('git', argv, { cwd: root, encoding: 'utf8', env })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '-q')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '--allow-empty', '-m', 'fixture')
  const sha = git('rev-parse', 'HEAD')
  writeFileSync(join(root, '.neil-dev.issue-17.json'), JSON.stringify({
    version: 1, issue: 17, workflow: { issue: 17, root, repo: 'example/example', state: 'ci', branch: 'topic', base: 'main', prs: [39], owner: { session: 'fixture' }, ...workflow },
  }))
  writeFileSync(join(root, 'gh'), `#!/bin/sh
case "$1 $2" in
  'pr view')
    case "$*" in
      *statusCheckRollup*) printf '%s\n' '{"state":"OPEN","headRefOid":"${sha}","mergeable":"MERGEABLE","statusCheckRollup":${JSON.stringify(rollup)}}' ;;
      *) printf '%s\n' '{"headRefOid":"${remoteChanges ? sha.split('').reverse().join('') : sha}"}' ;;
    esac ;;
  *) printf '%s\n' "unexpected gh $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 })
  writeFileSync(join(root, 'orca'), `#!/bin/sh
case "$1 $2" in
  'terminal list') printf '%s\n' '{"ok":true,"result":{"terminals":[{"handle":"term_fixture","writable":true}]}}' ;;
  'terminal send'|'orchestration send')
    printf '%s\n' "$*" >> "${root}/delivered"
    case "$*" in *'--text /compact'*) [ -n "$FAKE_COMPACT_HOOK" ] && printf '%s' '{"session_id":"fixture","cwd":"${root}"}' | ORCA_TERMINAL_HANDLE= '${ndev}' hook compact --harness claude > /dev/null ;; esac
    printf '%s\n' '{"ok":true,"result":{"send":{"accepted":true,"prompt":{"requestId":"fixture-send"}},"mutation":{"requestId":"fixture-send","replayed":false}}}' ;;
  'terminal wait')
    printf '%s\n' "$*" >> "${root}/delivered"
    if [ -n "$FAKE_WAIT_FAILS" ]; then printf '%s\n' '{"ok":false,"error":{"code":"timeout","message":"term_fixture did not become idle in 300000 ms"}}'; exit 1; fi
    printf '%s\n' '{"ok":true,"result":{"wait":{"handle":"term_fixture","condition":"tui-idle","satisfied":true}}}' ;;
  *) printf '%s\n' "unexpected orca $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 })
  return { root, env, sha }
}

test('watch reports green checks once for the current head through Orca', t => {
  const { root, env, sha } = fixture(t)
  const once = () => {
    const result = spawnSync(ndev, ['watch', '--session', 'fixture', '--once', '--json'], { cwd: root, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    return JSON.parse(result.stdout).result
  }
  const first = once()
  assert.equal(first.notices.length, 1)
  assert.match(first.notices[0].message, new RegExp(sha.slice(0, 8)))
  assert.match(readFileSync(join(root, 'delivered'), 'utf8'), /ndev flow finished-checks/)
  assert.equal(once().notices.length, 0)
  assert.equal(readFileSync(join(root, 'delivered'), 'utf8').match(/terminal send/g).length, 1)
})

test('watch drops a check result when the GitHub head changes before delivery', t => {
  const { root, env } = fixture(t, { remoteChanges: true })
  const result = spawnSync(ndev, ['watch', '--session', 'fixture', '--once', '--json'], { cwd: root, env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.deepEqual(JSON.parse(result.stdout).result.notices, [])
})

test('watch counts only the newest run of each check, so a replaced cancelled run is no failure', t => {
  const cancelled = { name: 'checks', workflowName: 'CI', status: 'COMPLETED', conclusion: 'CANCELLED', startedAt: '2026-11-24T10:00:00Z' }
  const replaced = fixture(t, { rollup: [cancelled, { ...cancelled, conclusion: 'SUCCESS', startedAt: '2026-11-24T10:05:00Z' }] })
  const once = ({ root, env }) => {
    const result = spawnSync(ndev, ['watch', '--session', 'fixture', '--once', '--json'], { cwd: root, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    return JSON.parse(result.stdout).result.notices
  }
  const [green] = once(replaced)
  assert.doesNotMatch(green.message, /failed/)
  assert.match(green.message, /ndev flow finished-checks/)
  const stranded = fixture(t, { rollup: [cancelled] })
  assert.match(once(stranded)[0].message, /checks failed on .*: checks\./)
})

test('flow off --project quiets the watcher, and flow on --project resumes it after terminal confirmation', t => {
  const { root, env } = fixture(t)
  const notices = () => {
    const result = spawnSync(ndev, ['watch', '--session', 'fixture', '--once', '--json'], { cwd: root, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    return JSON.parse(result.stdout).result.notices
  }
  const flow = (...args) => spawnSync(ndev, ['flow', ...args, '--json'], { cwd: root, env, encoding: 'utf8' })
  const setting = () => JSON.parse(readFileSync(join(root, '.ndev.json'), 'utf8')).workflow
  const off = flow('off', '--project')
  assert.equal(off.status, 0, off.stdout + off.stderr)
  assert.equal(setting(), false)
  assert.deepEqual(notices(), [])
  const asked = flow('on', '--project')
  assert.equal(asked.status, 0, asked.stdout + asked.stderr)
  assert.equal(setting(), false)
  const on = confirmInTerminal(JSON.parse(asked.stdout).result.nextAction, [ndev, 'flow', 'on', '--project'], { cwd: root, env })
  assert.equal(on.status, 0, on.stdout)
  assert.equal(setting(), true)
  assert.match(notices()[0].message, /ndev flow finished-checks/)
})

function session(t, options, harness = 'claude') {
  const made = fixture(t, options)
  const { root, env } = made
  const hook = (event, payload = {}, extra = {}) => {
    const result = spawnSync(ndev, ['hook', event, '--harness', harness], {
      cwd: root, encoding: 'utf8', env: { ...env, ORCA_TERMINAL_HANDLE: '', ...extra }, input: JSON.stringify({ session_id: 'fixture', cwd: root, ...payload }),
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    return result.stdout.trim() ? JSON.parse(result.stdout) : null
  }
  const watch = (extra = {}) => {
    const result = spawnSync(ndev, ['watch', '--session', 'fixture', '--once', '--json'], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    return JSON.parse(result.stdout).result
  }
  const log = () => {
    try { return readFileSync(join(root, 'delivered'), 'utf8') } catch { return '' }
  }
  const sent = () => log().match(/terminal send (?!.*--text \/compact)/g)?.length ?? 0
  const record = () => JSON.parse(readFileSync(join(root, '.neil-dev.issue-17.json'), 'utf8')).workflow
  return { ...made, hook, watch, sent, record, log }
}

const developing = { state: 'developing', prs: [], history: [{ tool: 'start', from: 'setup', to: 'developing', at: 1 }] }

test('a turn that ends early gets the next step once per turn end, and the fourth turn end with no progress blocks', t => {
  const s = session(t, { workflow: developing })
  for (const [turn, count] of [['t1', 1], ['t2', 2], ['t3', 3]]) {
    s.hook('turn-start', { turn_id: turn })
    s.hook('turn-complete', { turn_id: turn })
    const notices = s.watch().notices
    assert.equal(notices.length, 1, turn)
    assert.equal(notices[0].reason, 'turn')
    assert.equal(notices[0].message, 'Issue #17 is in developing. Run ndev flow status for the next action and keep working or record the blocker.')
    assert.equal(s.sent(), count)
    assert.deepEqual(s.watch().notices, [], `${turn} again`)
  }
  s.hook('turn-start', { turn_id: 't4' })
  s.hook('turn-complete', { turn_id: 't4' })
  const [stalled] = s.watch().notices
  assert.equal(stalled.reason, 'stalled')
  assert.match(stalled.message, /Issue #17 did not progress after 3 notices\. Run ndev flow status, then ndev flow unblock/)
  assert.equal(s.record().state, 'blocked')
  assert.equal(s.sent(), 3)
  assert.deepEqual(s.watch().notices, [])
})

function runningCheck(root, issue, { ended = false, startedAt = Date.now(), flowPid = process.pid } = {}) {
  const dir = join(root, '.git', 'ndev-pre-commit-check.sh.run')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'progress.json'), JSON.stringify({ label: 'scripts/ndev/workflow/pre-commit-check.sh', pid: process.pid, flowPid, startedAt, limitMs: 3_600_000, issue }))
  if (ended) writeFileSync(join(dir, 'exit'), '0\n')
}

test('turn ends while a transition of the issue runs its check send no notice and do not count toward a block', t => {
  const s = session(t, { workflow: developing })
  runningCheck(s.root, 17)
  for (const turn of ['t1', 't2', 't3', 't4', 't5']) {
    s.hook('turn-start', { turn_id: turn })
    s.hook('turn-complete', { turn_id: turn })
    assert.deepEqual(s.watch().notices, [], turn)
  }
  assert.equal(s.record().state, 'developing')
  assert.equal(s.sent(), 0)
})

test('a finished check, a check past its limit, a check whose flow command died, or a check of another issue does not hold back the notices', t => {
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim()
  const runs = { ended: [17, { ended: true }], expired: [17, { startedAt: Date.now() - 3_600_001 }], orphaned: [17, { flowPid: Number(dead) }], other: [18, {}] }
  for (const [name, [issue, options]] of Object.entries(runs)) {
    const s = session(t, { workflow: developing })
    runningCheck(s.root, issue, options)
    s.hook('turn-start', { turn_id: 't1' })
    s.hook('turn-complete', { turn_id: 't1' })
    assert.equal(s.watch().notices.length, 1, name)
  }
})

test('a new turn suppresses the nudge, and a late end of an older turn does not release it', t => {
  const s = session(t, { workflow: developing })
  s.hook('turn-start', { turn_id: 't1' })
  s.hook('turn-complete', { turn_id: 't1' })
  s.hook('turn-start', { turn_id: 't2' })
  assert.deepEqual(s.watch().notices, [])
  s.hook('turn-complete', { turn_id: 't1' })
  assert.deepEqual(s.watch().notices, [])
  s.hook('turn-complete', { turn_id: 't2', agent_id: 'helper' })
  assert.deepEqual(s.watch().notices, [])
  assert.equal(s.sent(), 0)
  s.hook('turn-complete', { turn_id: 't2' })
  assert.equal(s.watch().notices.length, 1)
  assert.equal(s.sent(), 1)
})

test('a delayed watcher notice is told apart from a human prompt by its receipt', t => {
  const s = session(t, { workflow: developing })
  s.hook('turn-start', { turn_id: 't1' })
  s.hook('turn-complete', { turn_id: 't1' })
  const [notice] = s.watch().notices
  assert.equal(notice.receipt.requestId, 'fixture-send')
  const context = prompt => s.hook('prompt-submit', { prompt })?.hookSpecificOutput?.additionalContext ?? ''
  assert.doesNotMatch(context(notice.message), /delayed ndev watch notice/)
  const file = join(s.root, '.neil-dev.issue-17.json')
  const held = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...held, workflow: { ...held.workflow, state: 'reviewing' } }))
  assert.match(context(notice.message), /This prompt is the delayed ndev watch notice of Orca request fixture-send for issue #17 in developing\. Issue #17 is now in reviewing, so ignore the notice and run ndev flow status\./)
  assert.doesNotMatch(context('Issue #17 is in developing. Please look at the parser.'), /delayed ndev watch notice/)
})

test('an older watcher notice that arrives after a newer one is still told apart', t => {
  const s = session(t, { workflow: developing })
  const file = join(s.root, '.neil-dev.issue-17.json')
  const move = state => {
    const held = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ ...held, workflow: { ...held.workflow, state } }))
  }
  s.hook('turn-start', { turn_id: 't1' })
  s.hook('turn-complete', { turn_id: 't1' })
  const [older] = s.watch().notices
  move('revising')
  s.hook('turn-start', { turn_id: 't2' })
  s.hook('turn-complete', { turn_id: 't2' })
  const [newer] = s.watch().notices
  assert.notEqual(newer.message, older.message)
  const context = s.hook('prompt-submit', { prompt: older.message })?.hookSpecificOutput?.additionalContext ?? ''
  assert.match(context, /This prompt is the delayed ndev watch notice of Orca request fixture-send for issue #17 in developing\. Issue #17 is now in revising/)
})

test('turn complete restores a stopped wait and records the idle time that the watcher reads', t => {
  const s = session(t, { workflow: { ...developing, state: 'wait', previous: 'developing', wait: { id: 'wait-1', pid: 2 ** 22 + 12345, kind: 'pr' } } })
  assert.deepEqual(s.watch({ ORCA_TERMINAL_HANDLE: 'term_fixture' }).notices, [])
  assert.equal(s.sent(), 0)
  s.hook('turn-start', { turn_id: 't1' })
  s.hook('turn-complete', { turn_id: 't1' })
  const restored = s.record()
  assert.equal(restored.state, 'developing')
  assert.deepEqual({ id: restored.lastWait.id, outcome: restored.lastWait.outcome }, { id: 'wait-1', outcome: 'owner_exited' })
  assert.equal(restored.wait, undefined)
  const [notice] = s.watch().notices
  assert.match(notice.message, /Issue #17 is in developing/)
})

test('an idle session gets one notice, then blocks, and a blocked or waiting issue gets none', t => {
  const s = session(t, { workflow: developing })
  const idle = { NDEV_WORKFLOW_IDLE_MS: '1' }
  s.hook('session-start', { source: 'startup' })
  assert.deepEqual(s.watch().notices, [])
  const [nudge] = s.watch(idle).notices
  assert.equal(nudge.reason, 'idle')
  assert.match(nudge.message, /Issue #17 is in developing\. Run ndev flow status/)
  const [stalled] = s.watch(idle).notices
  assert.equal(stalled.reason, 'stalled')
  assert.equal(s.record().state, 'blocked')
  assert.deepEqual(s.watch(idle).notices, [])
  const waiting = session(t, { workflow: { ...developing, state: 'wait', previous: 'developing', wait: { id: 'wait-2', pid: process.pid, kind: 'pr' } } })
  waiting.hook('turn-start', { turn_id: 't1' })
  waiting.hook('turn-complete', { turn_id: 't1' })
  assert.deepEqual(waiting.watch(idle).notices, [])
  assert.equal(waiting.sent(), 0)
})

test('an idle Claude session is compacted through its terminal before the idle notice, which still goes out', t => {
  const s = session(t, { workflow: developing })
  s.hook('session-start', { source: 'startup' })
  const [notice] = s.watch({ NDEV_WORKFLOW_IDLE_MS: '1', FAKE_COMPACT_HOOK: '1' }).notices
  assert.equal(notice.reason, 'idle')
  assert.equal(notice.message, 'Issue #17 is in developing. Run ndev flow status for the next action and keep working or record the blocker.')
  const steps = s.log().trim().split('\n')
  assert.equal(steps.length, 3)
  assert.match(steps[0], /^terminal send --terminal term_fixture --text \/compact --enter --wait-submit 5/)
  assert.match(steps[1], /^terminal wait --terminal term_fixture --for tui-idle --timeout-ms \d+/)
  assert.match(steps[2], /--text Issue #17 is in developing/)
  const watched = JSON.parse(spawnSync(ndev, ['flow', 'status', '--issue', '17', '--json'], { cwd: s.root, env: { ...s.env, ORCA_AGENT_SESSION_ID: 'fixture' }, encoding: 'utf8' }).stdout).result.watcher
  assert.deepEqual(watched.lastNotice.compaction, { compacted: true, requestId: 'fixture-send' })
})

test('an idle notice says when the compaction failed or was skipped, with the Orca receipt or error, and is still delivered', t => {
  const idle = { NDEV_WORKFLOW_IDLE_MS: '1' }
  const failed = session(t, { workflow: developing })
  failed.hook('session-start', { source: 'startup' })
  const [timeout] = failed.watch({ ...idle, FAKE_WAIT_FAILS: '1' }).notices
  assert.match(timeout.message, /^Issue #17 is in developing\. .* Compaction failed \(Orca request fixture-send\): Orca terminal wait exited 1: term_fixture did not become idle in 300000 ms\.$/)
  assert.equal(failed.sent(), 1)
  const unconfirmed = session(t, { workflow: developing })
  unconfirmed.hook('session-start', { source: 'startup' })
  const [silent] = unconfirmed.watch(idle).notices
  assert.match(silent.message, /Compaction failed \(Orca request fixture-send\): \/compact went into term_fixture and the agent went idle, but no compact hook of session fixture recorded a compaction within 200 ms\.$/)
  for (const [harness, reason] of [['opencode', /Compaction skipped: Orca cannot see when an OpenCode turn ends/], ['codex', /Compaction skipped: Codex .*\(#227\)\.$/]]) {
    const skipped = session(t, { workflow: developing }, harness)
    skipped.hook('session-start', { source: 'startup' })
    const [notice] = skipped.watch(idle).notices
    assert.match(notice.message, reason)
    assert.doesNotMatch(skipped.log(), /--text \/compact|terminal wait/)
    assert.equal(skipped.sent(), 1)
  }
})

function doneSession(t, fields = {}) {
  const s = session(t, { workflow: { ...developing, state: 'done', prs: [39], feedbackAt: 0, ...fields } })
  const write = (name, value) => writeFileSync(join(s.root, name), value)
  const pr = (fields = {}) => write('pr.json', JSON.stringify({ number: 39, state: 'open', merged: false, draft: false, mergeable: true, created_at: '2026-11-20T10:00:00Z', body: 'Closes #17', head: { sha: s.sha, ref: 'topic' }, ...fields }))
  const feedback = lines => write('feedback.jsonl', lines.map(line => JSON.stringify(line)).join('\n'))
  const checks = runs => write('checks.json', JSON.stringify({ check_runs: runs, statuses: [] }))
  pr()
  feedback([])
  checks([{ name: 'test', status: 'completed', conclusion: 'success' }])
  write('gh.sh', `#!/bin/sh
printf '%s\\n' "$*" >> "${s.root}/gh.log"
case "$1" in
  pr-read) cat "${s.root}/pr.json" ;;
  feedback) cat "${s.root}/feedback.jsonl" ;;
  commit-checks) cat "${s.root}/checks.json" ;;
  *) printf '%s\\n' "unexpected gh.sh $*" >&2; exit 1 ;;
esac
`)
  const reads = () => {
    try { return readFileSync(join(s.root, 'gh.log'), 'utf8').match(/^pr-read /gm)?.length ?? 0 } catch { return 0 }
  }
  const idle = { NDEV_WORKFLOW_IDLE_MS: '1', NDEV_FLOW_GH: join(s.root, 'gh.sh') }
  s.hook('session-start', { source: 'startup' })
  return { ...s, pr, feedback, checks, reads, idle }
}

test('an idle done workflow reads its PR once, stays quiet when clean, and returns to revising on new feedback', t => {
  const s = doneSession(t)
  assert.deepEqual(s.watch({ NDEV_FLOW_GH: s.idle.NDEV_FLOW_GH }).notices, [])
  assert.equal(s.reads(), 0)
  assert.deepEqual(s.watch(s.idle).notices, [])
  assert.equal(s.reads(), 1)
  assert.equal(s.record().state, 'done')
  assert.equal(s.sent(), 0)
  s.feedback([{ id: 501, body: 'Rename the flag to --strict.', user: { login: 'reviewer' }, created_at: '2026-11-24T10:00:00Z' }])
  const [notice] = s.watch(s.idle).notices
  assert.equal(s.reads(), 2)
  assert.equal(notice.reason, 'revisit')
  assert.match(notice.message, /Issue #17, PR #39 has new feedback with no answer:\n#501 from reviewer: Rename the flag to --strict\.\nIssue #17 is in revising\. Run ndev flow status/)
  assert.equal(s.record().state, 'revising')
  assert.equal(s.sent(), 1)
})

test('a done workflow is read once per idle period', t => {
  const s = doneSession(t)
  const file = join(s.root, '.local/state/ndev/sessions', `${createHash('sha256').update(JSON.stringify([s.root, 'fixture'])).digest('hex')}.json`)
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), activityAt: Date.now() - 60_000 }))
  const idle = { ...s.idle, NDEV_WORKFLOW_IDLE_MS: '30000' }
  assert.deepEqual(s.watch(idle).notices, [])
  assert.equal(s.reads(), 1)
  assert.deepEqual(s.watch(idle).notices, [])
  assert.equal(s.reads(), 1)
})

test('a done workflow released by its ended session returns to revising for the next session', t => {
  const s = doneSession(t, { owner: undefined, lastSession: 'earlier' })
  s.feedback([{ id: 502, body: 'Add a test for the empty case.', user: { login: 'reviewer' }, created_at: '2026-11-24T10:00:00Z' }])
  const [notice] = s.watch(s.idle).notices
  assert.equal(notice.reason, 'revisit')
  assert.equal(s.record().state, 'revising')
  assert.equal(s.record().owner.session, 'fixture')
})

test('a done PR with a red check gets one notice in done, and a conflict returns it to revising', t => {
  const s = doneSession(t)
  s.checks([{ name: 'test', status: 'completed', conclusion: 'failure' }])
  const [red] = s.watch(s.idle).notices
  assert.match(red.message, /^Issue #17, PR #39 needs work after done:\nRed checks on [0-9a-f]{8}: test \(failure\)\. Fix the cause and run ndev flow checkpoint\.\nIssue #17 is in done\./)
  assert.equal(s.record().state, 'done')
  assert.deepEqual(s.watch(s.idle).notices, [])
  assert.equal(s.sent(), 1)
  s.pr({ mergeable: false })
  const [conflict] = s.watch(s.idle).notices
  assert.match(conflict.message, /PR #39 has conflicts with main\./)
  assert.equal(s.record().state, 'revising')
})

test('a merged or closed PR of a done workflow stops the watch of it', t => {
  for (const ended of [{ state: 'closed', merged: true }, { state: 'closed', merged: false }]) {
    const s = doneSession(t)
    s.pr(ended)
    assert.deepEqual(s.watch(s.idle).notices, [])
    assert.equal(s.reads(), 1)
    assert.equal(s.record().state, 'done')
    assert.equal(s.record().prsClosed, true)
    assert.equal(s.record().merged, ended.merged || undefined)
    assert.deepEqual(s.watch(s.idle).notices, [])
    assert.equal(s.reads(), 1)
    assert.equal(s.sent(), 0)
  }
})

test('flow status shows the last watcher result with its time and receipt', t => {
  const s = session(t, { workflow: developing })
  const status = () => {
    const result = spawnSync(ndev, ['flow', 'status', '--issue', '17', '--json'], { cwd: s.root, env: { ...s.env, ORCA_AGENT_SESSION_ID: 'fixture' }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    return JSON.parse(result.stdout).result
  }
  assert.match(status().text, /Watcher: not running for session fixture\. It has sent no notice\./)
  s.hook('turn-start', { turn_id: 't1' })
  s.hook('turn-complete', { turn_id: 't1' })
  const [notice] = s.watch().notices
  const shown = status()
  assert.equal(shown.watcher.lastNotice.message, notice.message)
  assert.match(shown.text, /Watcher: not running for session fixture\. Last notice at \d{4}-\d\d-\d\dT[\d:.]+Z \(Orca request fixture-send\): Issue #17 is in developing\. Run ndev flow status/)
})

test('outside Orca, flow status reports the watcher that the session-start hook started for the same Claude session', t => {
  const s = session(t, { workflow: developing })
  writeFileSync(join(s.root, 'orca'), `#!/bin/sh
case "$1 $2" in
  'terminal create') while [ "$1" != --command ]; do shift; done; sh -c "$2" > "${s.root}/watcher.log" 2>&1 & printf '%s\\n' '{"ok":true,"result":{"terminal":{"handle":"term_watch"}}}' ;;
  'terminal list') printf '%s\\n' '{"ok":true,"result":{"terminals":[{"handle":"term_fixture","writable":true}]}}' ;;
  *) printf '%s\\n' "unexpected orca $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 })
  t.after(() => spawnSync('pkill', ['-KILL', '-f', `path:${s.root}`]))
  const harness = { CLAUDE_CODE_SESSION_ID: 'claude-7', NDEV_WORKFLOW_CHECK_MS: '60000' }
  s.hook('session-start', { session_id: 'claude-7', source: 'startup' }, { ...harness, ORCA_TERMINAL_HANDLE: 'term_fixture' })
  const status = () => {
    const result = spawnSync(ndev, ['flow', 'status', '--issue', '17', '--json'], { cwd: s.root, env: { ...s.env, ...harness }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    return JSON.parse(result.stdout).result
  }
  assert.match(status().text, /Binding: session claude-7 /)
  const deadline = Date.now() + 20_000
  let shown = status()
  while (!shown.watcher.running && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    shown = status()
  }
  assert.equal(shown.watcher.running, true, readFileSync(join(s.root, 'watcher.log'), 'utf8'))
  assert.match(shown.text, /Watcher: running as PID \d+ for session claude-7\./)
})

for (const [name, harness, nested, inner] of [
  ['Claude Code inside a Codex terminal', 'claude', { CODEX_THREAD_ID: 'codex-outer', CLAUDE_CODE_SESSION_ID: 'claude-inner' }, 'claude-inner'],
  ['Codex inside Claude Code', 'codex', { CLAUDE_CODE_SESSION_ID: 'claude-outer', CODEX_THREAD_ID: 'codex-inner' }, 'codex-inner'],
]) {
  test(`outside Orca, flow status names the session its hooks named for ${name}, and refuses to guess before a hook ran`, t => {
    const s = session(t, { workflow: developing }, harness)
    const status = () => {
      const result = spawnSync(ndev, ['flow', 'status', '--issue', '17', '--json'], { cwd: s.root, env: { ...s.env, ...nested }, encoding: 'utf8' })
      return { status: result.status, response: JSON.parse(result.stdout) }
    }
    const unrecorded = status()
    assert.equal(unrecorded.status, 1, JSON.stringify(unrecorded.response))
    assert.match(unrecorded.response.error.message, /CODEX_THREAD_ID=codex-\w+.*CLAUDE_CODE_SESSION_ID=claude-\w+/)
    assert.match(unrecorded.response.error.repair, /hook/)
    s.hook('session-start', { session_id: inner, source: 'startup' }, nested)
    const shown = status()
    assert.equal(shown.status, 0, JSON.stringify(shown.response))
    assert.match(shown.response.result.text, new RegExp(`Binding: session ${inner} `))
  })
}

test('a subagent that reviewed from a written brief has its answer stored on the issue that wrote the brief after the owner moved on', t => {
  const s = session(t, { workflow: developing })
  const brief = join(s.root, '.git', 'ndev-review-17-review.md')
  writeFileSync(brief, '# Review of issue #17: Fixture')
  const held = JSON.parse(readFileSync(join(s.root, '.neil-dev.issue-17.json'), 'utf8'))
  const runs = [{ axis: 'review', brief, out: brief.replace(/\.md$/, '.out.md'), log: brief.replace(/\.md$/, '.log') }]
  writeFileSync(join(s.root, '.neil-dev.issue-17.json'), JSON.stringify({ ...held, workflow: { ...held.workflow, state: 'reviewing', exportReview: { sha: s.sha, at: 1, runs } } }))
  writeFileSync(join(s.root, '.neil-dev.issue-18.json'), JSON.stringify({ version: 1, issue: 18, workflow: { ...held.workflow, issue: 18, state: 'developing', owner: { session: 'fixture', at: Date.now() } } }))
  const transcript = (name, prompt) => {
    const file = join(s.root, `${name}.jsonl`)
    writeFileSync(file, [{ type: 'user', message: { role: 'user', content: prompt } }, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ignored' }] } }].map(line => JSON.stringify(line)).join('\n'))
    return file
  }
  s.hook('turn-complete', { agent_id: 'helper', agent_transcript_path: transcript('helper', 'List the test files.'), last_assistant_message: 'tests/a.test.mjs' })
  assert.equal(s.record().exportReview.runs[0].answer, undefined)
  s.hook('turn-complete', { agent_id: 'rev-1', agent_type: 'ndev-diff-reviewer', agent_transcript_path: transcript('reviewer', `Review the change as the brief ${brief} says.`), last_assistant_message: 'No findings in the parser change' })
  const stored = s.record().exportReview.runs[0]
  assert.equal(stored.answer, 'No findings in the parser change')
  assert.equal(stored.agentId, 'rev-1')
  assert.equal(JSON.parse(readFileSync(join(s.root, '.neil-dev.issue-18.json'), 'utf8')).workflow.exportReview, undefined)
  const status = spawnSync(ndev, ['flow', 'status', '--issue', '17', '--json'], { cwd: s.root, env: s.env, encoding: 'utf8' })
  assert.equal(status.status, 0, status.stderr || status.stdout)
  assert.match(JSON.parse(status.stdout).result.next, /review by subagent rev-1 has answered, and the record keeps it:\nNo findings in the parser change/)
})
