import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ndev = fileURLToPath(new URL('../bin/ndev', import.meta.url))

function fixture(t, workflow) {
  const root = mkdtempSync(join(tmpdir(), 'ndev-flow-start-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' })
  assert.equal(git.status, 0, git.stderr)
  writeFileSync(join(root, '.neil-dev.json'), JSON.stringify({ mode: 'light', steering: 'interactive', github: { repo: 'o/r' } }))
  const gh = join(root, 'fake-gh.sh')
  writeFileSync(gh, `#!/bin/sh
case "$1" in
  issue-read) echo '{"title":"Fix the thing","state":"open","body":""}' ;;
  default-branch) echo '{"default_branch":"main"}' ;;
  pr-read) echo '{"number":5,"state":"open","merged":false,"mergeable":true}' ;;
  *) echo "fake gh.sh: unexpected $*" >&2; exit 9 ;;
esac
`)
  chmodSync(gh, 0o755)
  const record = join(root, '.neil-dev.issue-12.json')
  writeFileSync(record, JSON.stringify({ version: 1, issue: 12, rounds: [], workflow: { issue: 12, root, repo: 'o/r', base: 'main', branch: 'b', prs: [5], evidence: {}, history: [], followUps: [], migrations: [], attempts: 0, nudges: { count: 0 }, rev: 1, ...workflow } }))
  return { root, gh, state: () => JSON.parse(readFileSync(record, 'utf8')).workflow }
}

const start = ({ root, gh }, ...args) => {
  const result = spawnSync(ndev, ['flow', 'start', '12', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, NDEV_FLOW_GH: gh } })
  assert.ifError(result.error)
  return result
}

test('start resumes a record that stores no mode and no steering, with the ones of the project', t => {
  const held = fixture(t, { state: 'interviewing' })
  const { state } = held
  const result = start(held)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.doesNotMatch(result.stderr, /afterInterview/)
  assert.equal(state().mode, 'light')
  assert.equal(state().steering, 'interactive')
})
