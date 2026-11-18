import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ndev = fileURLToPath(new URL('../bin/ndev', import.meta.url))

function fixture(t, { red = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ndev-queue-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const env = { HOME: root, PATH: `${root}${delimiter}${process.env.PATH}`, ORCA_CLI_COMMAND: join(root, 'orca') }
  const git = spawnSync('git', ['init', '-q', root], { env, encoding: 'utf8' })
  assert.equal(git.status, 0, git.stderr)
  writeFileSync(join(root, '.neil-dev.json'), '{"github":{"repo":"fixture/demo","board":null}}')
  writeFileSync(join(root, 'gh'), `#!/bin/sh
printf '%s\n' "$*" >> "${root}/gh-log"
case "$1 $2" in
  'api user') printf '%s\n' '{"login":"tester"}' ;;
  'pr list') printf '%s\n' '[{"number":20,"title":"Newer","createdAt":"2026-08-01"},{"number":10,"title":"Older","createdAt":"2026-07-01"}]' ;;
  'pr view') case "$3" in
    10) printf '%s\n' '{"number":10,"title":"Older","headRefOid":"abc123","headRefName":"fix/ten","mergeStateStatus":"CLEAN","state":"OPEN","isDraft":false,"statusCheckRollup":[{"name":"test","conclusion":"${red ? 'FAILURE' : 'SUCCESS'}"}]}' ;;
    20) printf '%s\n' '{"number":20,"title":"Newer","headRefOid":"def456","headRefName":"fix/twenty","mergeStateStatus":"CLEAN","state":"OPEN","isDraft":false,"statusCheckRollup":[{"name":"test","conclusion":"SUCCESS"}]}' ;;
  esac ;;
  *) printf '%s\n' "unexpected gh $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 })
  writeFileSync(join(root, 'orca'), `#!/bin/sh
case "$1 $2" in
  'worktree list') printf '%s\n' '{"ok":true,"result":{"worktrees":[]}}' ;;
  'orchestration worker-start') printf '%s\n' '{"ok":true,"result":{"dispatchId":"ctx_active"}}' ;;
  'orchestration worker-show') printf '%s\n' '{"ok":true,"result":{"liveness":"live","state":"ready"}}' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 })
  const run = (...argv) => {
    const result = spawnSync(ndev, ['fix-prs', ...argv, '--json'], { cwd: root, env, encoding: 'utf8' })
    return { status: result.status, response: JSON.parse(result.stdout) }
  }
  return { root, run }
}

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
