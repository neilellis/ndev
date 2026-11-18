import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ndev-wait-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' })
  assert.equal(git.status, 0, git.stderr)
  const record = join(root, '.neil-dev.issue-12.json')
  writeFileSync(record, JSON.stringify({ version: 1, issue: 12, rounds: [], workflow: { issue: 12, root, state: 'developing', rev: 1, history: [] } }))
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
