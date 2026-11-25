import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ndev = fileURLToPath(new URL('../bin/ndev', import.meta.url))
const HEAD = 'a'.repeat(40)
const run = (name, status, conclusion, startedAt, extra = {}) => ({
  __typename: 'CheckRun', name, workflowName: 'CI', status, conclusion, startedAt, detailsUrl: `https://github.com/o/r/actions/runs/${startedAt.slice(11, 19).replaceAll(':', '')}`, ...extra,
})

function fixture(t, rollups, record = { state: 'ci' }) {
  const root = mkdtempSync(join(tmpdir(), 'ndev-wait-checks-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal(spawnSync('git', ['init', '-q', root], { encoding: 'utf8' }).status, 0)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  rollups.forEach((rollup, index) => writeFileSync(join(root, `rollup-${index + 1}.json`), JSON.stringify({ headRefOid: HEAD, statusCheckRollup: rollup })))
  writeFileSync(join(bin, 'gh'), `#!/bin/sh
echo "$*" >> "${root}/gh.log"
n=$(cat "${root}/count" 2>/dev/null || echo 0)
n=$((n+1))
echo $n > "${root}/count"
file="${root}/rollup-$n.json"
[ -f "$file" ] || file="${root}/rollup-${rollups.length}.json"
cat "$file"
`)
  chmodSync(join(bin, 'gh'), 0o755)
  const file = join(root, '.neil-dev.issue-12.json')
  writeFileSync(file, JSON.stringify({ version: 1, issue: 12, rounds: [], workflow: { issue: 12, root, pr: 7, prs: [7], state: 'developing', rev: 1, history: [], ...record } }))
  return { root, bin, workflow: () => JSON.parse(readFileSync(file, 'utf8')).workflow, calls: () => readFileSync(join(root, 'gh.log'), 'utf8').trim().split('\n') }
}

function wait(f, args) {
  const result = spawnSync(ndev, ['wait', '--json', ...args], { cwd: f.root, encoding: 'utf8', env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` } })
  assert.ifError(result.error)
  return { ...result, json: result.stdout ? JSON.parse(result.stdout) : undefined }
}

const cancelled = run('checks', 'COMPLETED', 'CANCELLED', '2026-11-24T10:00:00Z')

test('wait checks ignores a cancelled run that a newer run of the same check replaced', t => {
  const f = fixture(t, [[cancelled, run('checks', 'COMPLETED', 'SUCCESS', '2026-11-24T10:05:00Z'), run('lint', 'COMPLETED', 'SUCCESS', '2026-11-24T10:01:00Z')]])
  const result = wait(f, ['checks', '7'])
  assert.equal(result.status, 0, result.stdout || result.stderr)
  const { checks } = result.json.result.last
  assert.deepEqual(checks.map(check => [check.name, check.conclusion]), [['CI/checks', 'SUCCESS'], ['CI/lint', 'SUCCESS']])
  assert.match(checks[0].url, /^https:\/\/github\.com\/o\/r\/actions\/runs\//)
  assert.match(f.calls()[0], /^pr view 7 .*statusCheckRollup/)
})

test('wait checks holds while the replacement run is queued and returns when it succeeds', t => {
  const queued = run('checks', 'QUEUED', '', '2026-11-24T10:05:00Z')
  const f = fixture(t, [[cancelled, queued], [cancelled, run('checks', 'COMPLETED', 'SUCCESS', '2026-11-24T10:05:00Z')]])
  const result = wait(f, ['checks', '7', '--period', '1'])
  assert.equal(result.status, 0, result.stdout || result.stderr)
  assert.equal(result.json.result.attempts, 2)
  assert.deepEqual(result.json.result.last.checks.map(check => check.conclusion), ['SUCCESS'])
})

test('wait checks fails on the newest run that really failed, naming the check and its log URL', t => {
  const failed = run('checks', 'COMPLETED', 'FAILURE', '2026-11-24T10:05:00Z')
  const f = fixture(t, [[run('checks', 'COMPLETED', 'SUCCESS', '2026-11-24T10:00:00Z'), failed, run('lint', 'COMPLETED', 'SUCCESS', '2026-11-24T10:01:00Z')]])
  const result = wait(f, ['checks', '7'])
  assert.equal(result.status, 1, result.stdout || result.stderr)
  const { error } = result.json
  assert.match(error.message, /PR #7/)
  assert.match(error.message, /CI\/checks \(FAILURE\) https:\/\/github\.com\/o\/r\/actions\/runs\/100500/)
  assert.doesNotMatch(error.message, /lint/)
  assert.match(error.repair, /ndev flow checkpoint/)
  assert.match(error.repair, /ndev wait checks 7/)
})

test('wait checks fails on a cancelled run that no newer run replaced', t => {
  const f = fixture(t, [[cancelled]])
  const result = wait(f, ['checks', '7'])
  assert.equal(result.status, 1, result.stdout || result.stderr)
  assert.match(result.json.error.message, /CI\/checks \(CANCELLED\)/)
})

test('wait checks changes no workflow state, and runs for a record whose workflow is off', t => {
  const f = fixture(t, [[run('checks', 'COMPLETED', 'SUCCESS', '2026-11-24T10:05:00Z')]], { off: { at: 1, reason: 'merged' } })
  const result = wait(f, ['checks', '7'])
  assert.equal(result.status, 0, result.stdout || result.stderr)
  assert.equal(f.workflow().state, 'developing')
  assert.equal(f.workflow().wait, undefined)
  assert.equal(f.workflow().rev, 1)
})

test('wait checks accepts a timeout longer than the 1200 seconds that other waits allow', t => {
  const f = fixture(t, [[run('checks', 'COMPLETED', 'SUCCESS', '2026-11-24T10:05:00Z')]])
  assert.equal(wait(f, ['checks', '7', '--timeout', '7200']).status, 0)
  const capped = wait(f, ['seconds', '--timeout', '7200', '0.01'])
  assert.equal(capped.status, 2, capped.stdout || capped.stderr)
})
