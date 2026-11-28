import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ndev = fileURLToPath(new URL('../bin/ndev', import.meta.url))
const identity = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ORCA_')))
const CHECKS = ['fast-checks.sh', 'pre-commit-check.sh', 'pre-push-check.sh', 'pre-ready-check.sh']
const SELF_ROOTED = name => `#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "\${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$root"
marker="$(cat marker.txt)"
echo "${name} $(pwd) $marker \${NDEV_WORKTREE_ROOT:-unset}" >> "$NDEV_TEST_STATE/ran"
`

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...identity } })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

function nested(t, { base = SELF_ROOTED } = {}) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'ndev-worktree-checks-')))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const origin = join(parent, 'origin.git')
  const main = join(parent, 'main')
  const state = join(parent, 'state')
  mkdirSync(state)
  git(parent, 'init', '-q', '--bare', '-b', 'main', origin)
  git(parent, 'clone', '-q', origin, main)
  mkdirSync(join(main, 'scripts/ndev/workflow'), { recursive: true })
  for (const name of CHECKS) {
    writeFileSync(join(main, 'scripts/ndev/workflow', name), base(name))
    chmodSync(join(main, 'scripts/ndev/workflow', name), 0o755)
  }
  writeFileSync(join(main, 'marker.txt'), 'base\n')
  writeFileSync(join(main, '.neil-dev.json'), JSON.stringify({ mode: 'light', steering: 'auto', github: { repo: 'o/r' } }))
  writeFileSync(join(main, '.gitignore'), '.neil-dev.issue-*.json\nwt/\n')
  git(main, 'add', '-A')
  git(main, 'commit', '-q', '-m', 'base')
  git(main, 'push', '-q', 'origin', 'main')
  const wt = join(main, 'wt')
  git(main, 'worktree', 'add', '-q', '-b', 'feat', wt, 'origin/main')
  writeFileSync(join(main, 'marker.txt'), 'main-checkout\n')
  for (const name of CHECKS) writeFileSync(join(main, 'scripts/ndev/workflow', name), `#!/bin/sh\necho "main-copy ${name}" >> "$NDEV_TEST_STATE/ran"\n`)
  writeFileSync(join(wt, 'marker.txt'), 'worktree\n')
  git(wt, 'add', 'marker.txt')
  git(wt, 'commit', '-q', '-m', 'mark the worktree')
  git(wt, 'push', '-q', '-u', 'origin', 'feat')
  const gh = join(parent, 'fake-gh.sh')
  writeFileSync(gh, `#!/bin/sh
case "$1" in
  issue-read) echo '{"title":"Fix the thing","state":"open","body":""}' ;;
  pr-read) echo '{"number":5,"state":"open","body":"Closes #12","head":{"sha":"x","ref":"feat"},"base":{"ref":"main"}}' ;;
  *) echo "fake gh.sh: unexpected $*" >&2; exit 9 ;;
esac
`)
  chmodSync(gh, 0o755)
  writeFileSync(join(wt, '.neil-dev.issue-12.json'), JSON.stringify({ version: 1, issue: 12, rounds: [], workflow: { issue: 12, root: wt, repo: 'o/r', base: 'main', branch: 'feat', prs: [5], mode: 'light', steering: 'auto', state: 'developing', evidence: {}, history: [], followUps: [], migrations: [], attempts: 0, nudges: { count: 0 }, rev: 1, baseCheck: { exitCode: 0 } } }))
  const flow = (args, cwd = wt) => spawnSync(ndev, ['flow', ...args, '--issue', '12'], { cwd, encoding: 'utf8', env: { ...env, ...identity, NDEV_FLOW_GH: gh, NDEV_TEST_STATE: state } })
  const checkpoint = (file, cwd = main) => spawnSync(ndev, ['flow', 'checkpoint', '--worktree', wt, '--issue', '12', '--message', `Add ${file}`, '--file', file], { cwd, encoding: 'utf8', env: { ...env, ...identity, NDEV_FLOW_GH: gh, NDEV_TEST_STATE: state } })
  const ran = () => existsSync(join(state, 'ran')) ? readFileSync(join(state, 'ran'), 'utf8').trim().split('\n') : []
  return { main, wt, origin, checkpoint, flow, ran }
}

test('checkpoint in a worktree nested in the main checkout runs the worktree copy of each check in the worktree', t => {
  const p = nested(t)
  writeFileSync(join(p.wt, 'a.txt'), 'a\n')
  const result = p.checkpoint('a.txt')
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.deepEqual(p.ran(), ['fast-checks.sh', 'pre-commit-check.sh', 'pre-push-check.sh'].map(name => `${name} ${p.wt} worktree ${p.wt}`))
  assert.equal(git(p.origin, 'rev-parse', 'feat'), git(p.wt, 'rev-parse', 'HEAD'))
})

test('a check that the branch changed runs the base version in the worktree, never in the main checkout, and the failure names the repair', t => {
  const p = nested(t)
  writeFileSync(join(p.wt, 'scripts/ndev/workflow/fast-checks.sh'), '#!/bin/sh\necho weakened >> "$NDEV_TEST_STATE/ran"\n')
  const result = p.checkpoint('scripts/ndev/workflow/fast-checks.sh')
  assert.equal(result.status, 1, result.stdout)
  assert.doesNotMatch(p.ran().join('\n'), /weakened|main-checkout|main-copy/)
  assert.match(result.stderr, /fast-checks\.sh exited 1/)
  assert.match(result.stderr, /differs from the version on main.*NDEV_WORKTREE_ROOT/s)
})

test('finished-development reports that a passing check ran the base version outside the worktree', t => {
  const p = nested(t, { base: name => `#!/bin/sh\ncd "$NDEV_WORKTREE_ROOT"\necho "${name} $(pwd) $(cat marker.txt)" >> "$NDEV_TEST_STATE/ran"\n` })
  writeFileSync(join(p.wt, 'scripts/ndev/workflow/fast-checks.sh'), '#!/bin/sh\necho weakened >> "$NDEV_TEST_STATE/ran"\n')
  const result = p.flow(['finished-development', '--file', 'scripts/ndev/workflow/fast-checks.sh', '--message', 'Change the fast check'])
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.deepEqual(p.ran().slice(0, 2), [`fast-checks.sh ${p.wt} worktree`, `pre-commit-check.sh ${p.wt} worktree`])
  assert.match(`${result.stdout}\n${result.stderr}`, /differs from the version on main.*NDEV_WORKTREE_ROOT/s)
})
