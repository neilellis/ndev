import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

function mergePending(t, { sameChange }) {
  const parent = mkdtempSync(join(tmpdir(), 'ndev-checkpoint-merge-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const root = realpathSync(parent)
  const origin = join(root, 'origin.git')
  const work = join(root, 'work')
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  git(root, 'clone', '-q', origin, work)
  mkdirSync(join(work, 'scripts/ndev/workflow'), { recursive: true })
  writeFileSync(join(work, 'scripts/ndev/workflow/fast-checks.sh'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(work, 'scripts/ndev/workflow/fast-checks.sh'), 0o755)
  writeFileSync(join(work, '.neil-dev.json'), JSON.stringify({ mode: 'hack', steering: 'interactive', github: { repo: 'o/r' } }))
  writeFileSync(join(work, '.gitignore'), '.neil-dev.issue-*.json\n')
  git(work, 'add', '-A')
  git(work, 'commit', '-q', '-m', 'base')
  git(work, 'push', '-q', 'origin', 'main')
  git(work, 'switch', '-q', '-c', 'feat')
  writeFileSync(join(work, 'a.txt'), 'same\n')
  git(work, 'add', 'a.txt')
  git(work, 'commit', '-q', '-m', 'feature work')
  git(work, 'switch', '-q', 'main')
  writeFileSync(join(work, 'a.txt'), sameChange ? 'same\n' : 'other\n')
  git(work, 'add', 'a.txt')
  git(work, 'commit', '-q', '-m', 'main work')
  git(work, 'push', '-q', 'origin', 'main')
  git(work, 'switch', '-q', 'feat')
  const gh = join(root, 'fake-gh.sh')
  writeFileSync(gh, '#!/bin/sh\necho "fake gh.sh: unexpected $*" >&2\nexit 9\n')
  chmodSync(gh, 0o755)
  const record = join(work, '.neil-dev.issue-12.json')
  writeFileSync(record, JSON.stringify({ version: 1, issue: 12, rounds: [], workflow: { issue: 12, root: work, repo: 'o/r', base: 'main', branch: 'feat', prs: [], mode: 'hack', steering: 'interactive', state: 'developing', evidence: {}, history: [], followUps: [], migrations: [], attempts: 0, nudges: { count: 0 }, rev: 1, baseCheck: { note: 'fixture' } } }))
  return { work, gh }
}

const checkpoint = ({ work, gh }) => spawnSync(ndev, ['flow', 'checkpoint', '--issue', '12', '--message', 'Record the ancestry of main', '--file', 'a.txt'], { cwd: work, encoding: 'utf8', env: { ...process.env, ...identity, NDEV_FLOW_GH: gh } })
const pending = work => existsSync(join(work, '.git/MERGE_HEAD'))

test('checkpoint commits a pending merge whose tree already holds the incoming changes', t => {
  const held = mergePending(t, { sameChange: true })
  git(held.work, 'merge', '--no-commit', '--no-ff', 'origin/main')
  assert.equal(pending(held.work), true)
  assert.equal(git(held.work, 'diff', '--cached', '--name-only'), '')
  const before = git(held.work, 'rev-parse', 'HEAD')
  const result = checkpoint(held)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(pending(held.work), false)
  assert.equal(git(held.work, 'rev-parse', 'HEAD^1'), before)
  assert.equal(git(held.work, 'rev-parse', 'HEAD^2'), git(held.work, 'rev-parse', 'origin/main'))
})

test('checkpoint still refuses to commit when there is no change and no pending merge', t => {
  const held = mergePending(t, { sameChange: true })
  const result = checkpoint(held)
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /hold no change to commit/)
  assert.equal(readFileSync(join(held.work, 'a.txt'), 'utf8'), 'same\n')
})
