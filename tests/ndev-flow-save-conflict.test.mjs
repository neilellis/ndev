import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ndev = fileURLToPath(new URL('../bin/ndev', import.meta.url))
const identity = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...identity } })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

const bumpRecord = `node -e '
const fs = require("fs")
const file = process.argv[1]
const held = JSON.parse(fs.readFileSync(file, "utf8"))
held.workflow.rev += 4
held.workflow.nudges = { count: 3 }
fs.writeFileSync(file, JSON.stringify(held))
' "$PWD/.neil-dev.issue-12.json"`

function project(t, { check }) {
  const parent = mkdtempSync(join(tmpdir(), 'ndev-save-conflict-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const root = realpathSync(parent)
  const origin = join(root, 'origin.git')
  const work = join(root, 'work')
  const state = join(root, 'state')
  mkdirSync(state)
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  git(root, 'clone', '-q', origin, work)
  mkdirSync(join(work, 'scripts/ndev/workflow'), { recursive: true })
  writeFileSync(join(work, 'scripts/ndev/workflow/pre-commit-check.sh'), check)
  chmodSync(join(work, 'scripts/ndev/workflow/pre-commit-check.sh'), 0o755)
  writeFileSync(join(work, '.neil-dev.json'), JSON.stringify({ mode: 'light', steering: 'auto', github: { repo: 'o/r' } }))
  writeFileSync(join(work, '.gitignore'), '.neil-dev.issue-*.json\n')
  git(work, 'add', '-A')
  git(work, 'commit', '-q', '-m', 'base')
  git(work, 'push', '-q', 'origin', 'main')
  git(work, 'switch', '-q', '-c', 'feat')
  const record = join(work, '.neil-dev.issue-12.json')
  writeFileSync(record, JSON.stringify({ version: 1, issue: 12, rounds: [], workflow: { issue: 12, root: work, repo: 'o/r', base: 'main', branch: 'feat', prs: [], mode: 'light', steering: 'auto', state: 'interviewing', evidence: {}, history: [], followUps: [], migrations: [], attempts: 0, nudges: { count: 0 }, rev: 2 } }))
  const run = (...args) => spawnSync(ndev, ['flow', ...args, '--issue', '12'], { cwd: work, encoding: 'utf8', env: { ...process.env, ...identity, NDEV_TEST_STATE: state } })
  const read = () => JSON.parse(readFileSync(record, 'utf8')).workflow
  return { work, state, run, read }
}

test('a transition whose save meets a newer revision exits non-zero and names the issue and both revisions', t => {
  const held = project(t, { check: `#!/bin/sh\n${bumpRecord}\nexit 0\n` })
  const result = held.run('interview', '--finish')
  assert.notEqual(result.status, 0, `exit ${result.status}\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, /#12/)
  assert.match(result.stderr, /revision 6/)
  assert.match(result.stderr, /expected 2/)
})

test('a running check records which issue started it, so the watcher can leave that issue alone', t => {
  const held = project(t, { check: '#!/bin/sh\nsleep 1\ncp "$(git rev-parse --absolute-git-dir)/ndev-pre-commit-check.sh.run/progress.json" "$NDEV_TEST_STATE/progress.json"\nexit 0\n' })
  const result = held.run('interview', '--finish')
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(JSON.parse(readFileSync(join(held.state, 'progress.json'), 'utf8')).issue, 12)
})

test('a retry after a save conflict reuses the passed check and does not run it again', t => {
  const held = project(t, { check: `#!/bin/sh\necho run >> "$NDEV_TEST_STATE/runs"\n${bumpRecord}\nexit 0\n` })
  const runs = () => readFileSync(join(held.state, 'runs'), 'utf8').split('\n').filter(Boolean).length
  const first = held.run('interview', '--finish')
  assert.equal(first.status, 5, first.stderr || first.stdout)
  assert.equal(runs(), 1)
  const retry = held.run('interview', '--finish')
  assert.equal(retry.status, 0, retry.stderr || retry.stdout)
  assert.equal(runs(), 1)
  assert.equal(held.read().state, 'developing')
  assert.equal(held.read().baseCheck.exitCode, 0)
  assert.match(retry.stdout, /did not run again/)
})

test('a passed check runs again once the commit changes', t => {
  const held = project(t, { check: `#!/bin/sh\necho run >> "$NDEV_TEST_STATE/runs"\n${bumpRecord}\nexit 0\n` })
  const runs = () => readFileSync(join(held.state, 'runs'), 'utf8').split('\n').filter(Boolean).length
  assert.equal(held.run('interview', '--finish').status, 5)
  writeFileSync(join(held.work, 'b.txt'), 'two\n')
  git(held.work, 'add', 'b.txt')
  git(held.work, 'commit', '-q', '-m', 'more')
  held.run('interview', '--finish')
  assert.equal(runs(), 2)
})

test('a passed check whose transition saved runs again on the next transition', t => {
  const held = project(t, { check: '#!/bin/sh\necho run >> "$NDEV_TEST_STATE/runs"\nexit 0\n' })
  const runs = () => readFileSync(join(held.state, 'runs'), 'utf8').split('\n').filter(Boolean).length
  assert.equal(held.run('interview', '--finish').status, 0)
  const again = held.run('finished-interview')
  assert.equal(again.status, 0, again.stderr || again.stdout)
  assert.equal(runs(), 2)
})

test('an unreadable saved check result fails and names the file and its repair', t => {
  const held = project(t, { check: `#!/bin/sh\n${bumpRecord}\nexit 0\n` })
  assert.equal(held.run('interview', '--finish').status, 5)
  const file = join(git(held.work, 'rev-parse', '--absolute-git-dir'), 'ndev-pre-commit-check.sh.passed.json')
  writeFileSync(file, '{"key":')
  const retry = held.run('interview', '--finish')
  assert.equal(retry.status, 1, retry.stdout)
  assert.ok(retry.stderr.includes(file), retry.stderr)
  assert.match(retry.stderr, /Repair: delete/)
})
