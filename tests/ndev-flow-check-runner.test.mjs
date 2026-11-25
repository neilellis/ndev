import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ndev = fileURLToPath(new URL('../bin/ndev', import.meta.url))
const identity = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const projectMajor = String(Number(process.versions.node.split('.')[0]) + 1)

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...identity } })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

function project(t, { check, installNode = true }) {
  const parent = mkdtempSync(join(tmpdir(), 'ndev-check-runner-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const root = realpathSync(parent)
  const origin = join(root, 'origin.git')
  const work = join(root, 'work')
  const state = join(root, 'state')
  const nvm = join(root, 'nvm')
  mkdirSync(state)
  if (installNode) {
    const bin = join(nvm, 'versions', 'node', `v${projectMajor}.0.0`, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'node'), `#!/bin/sh\necho v${projectMajor}.0.0\n`)
    chmodSync(join(bin, 'node'), 0o755)
  }
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  git(root, 'clone', '-q', origin, work)
  mkdirSync(join(work, 'scripts/ndev/workflow'), { recursive: true })
  writeFileSync(join(work, 'scripts/ndev/workflow/pre-ready-check.sh'), check)
  chmodSync(join(work, 'scripts/ndev/workflow/pre-ready-check.sh'), 0o755)
  writeFileSync(join(work, '.nvmrc'), `${projectMajor}\n`)
  writeFileSync(join(work, '.neil-dev.json'), JSON.stringify({ mode: 'light', steering: 'auto', github: { repo: 'o/r' } }))
  writeFileSync(join(work, '.gitignore'), '.neil-dev.issue-*.json\n')
  git(work, 'add', '-A')
  git(work, 'commit', '-q', '-m', 'base')
  git(work, 'push', '-q', 'origin', 'main')
  git(work, 'switch', '-q', '-c', 'feat')
  writeFileSync(join(work, 'a.txt'), 'one\n')
  git(work, 'add', 'a.txt')
  git(work, 'commit', '-q', '-m', 'feature work')
  git(work, 'push', '-q', '-u', 'origin', 'feat')
  const head = git(work, 'rev-parse', 'HEAD')
  const gh = join(root, 'fake-gh.sh')
  writeFileSync(gh, `#!/bin/sh
case "$1" in
  pr-read) echo '{"number":5,"state":"open","draft":true,"mergeable":true,"created_at":"2026-01-01T00:00:00Z","head":{"sha":"${head}","ref":"feat"}}' ;;
  pr-ready) echo ready >> ${JSON.stringify(join(state, 'ready'))} ;;
  comment) ;;
  *) echo "fake gh.sh: unexpected $*" >&2; exit 9 ;;
esac
`)
  chmodSync(gh, 0o755)
  writeFileSync(join(work, '.neil-dev.issue-12.json'), JSON.stringify({ version: 1, issue: 12, rounds: [], workflow: { issue: 12, root: work, repo: 'o/r', base: 'main', branch: 'feat', prs: [5], mode: 'light', steering: 'auto', state: 'reviewing', evidence: {}, history: [], followUps: [], migrations: [], attempts: 0, nudges: { count: 0 }, rev: 1, baseCheck: { note: 'fixture' }, hooks: { remember: { firedAt: 1 } } } }))
  const run = (env = {}) => spawnSync(ndev, ['flow', 'finished-review', '--issue', '12', '--review', 'no findings', '--deadcode', 'nothing', '--remembered', 'nothing: fixture'], { cwd: work, encoding: 'utf8', env: { ...process.env, ...identity, NDEV_FLOW_GH: gh, NVM_DIR: nvm, FNM_DIR: join(root, 'no-fnm'), HOMEBREW_PREFIX: join(root, 'no-brew'), NDEV_TEST_STATE: state, ...env } })
  const log = () => readFileSync(join(git(work, 'rev-parse', '--absolute-git-dir'), 'ndev-pre-ready-check.sh.log'), 'utf8')
  return { work, state, run, log, ready: () => existsSync(join(state, 'ready')) }
}

test('a CLI check runs on the Node that .nvmrc names, not the Node on PATH', t => {
  const held = project(t, { check: '#!/bin/sh\nnode --version > "$NDEV_TEST_STATE/node"\nexit 0\n' })
  const result = held.run()
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(readFileSync(join(held.state, 'node'), 'utf8').trim(), `v${projectMajor}.0.0`)
  assert.ok(held.ready())
})

test('a CLI check keeps its exit code and output in the log, and the failure names the check and the log', t => {
  const held = project(t, { check: '#!/bin/sh\necho out-line\necho err-line >&2\nexit 7\n' })
  const result = held.run()
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /pre-ready-check\.sh exited 7\. Nothing was pushed.*ndev-pre-ready-check\.sh\.log/s)
  assert.match(held.log(), /exit 7\n--- stdout\nout-line\n+--- stderr\n[\s\S]*err-line/)
  assert.equal(held.ready(), false)
})

test('a CLI check that needs a Node that is not installed does not run, and the failure names the repair', t => {
  const held = project(t, { check: '#!/bin/sh\ntouch "$NDEV_TEST_STATE/ran"\nexit 0\n', installNode: false })
  const result = held.run()
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, new RegExp(`asks for Node ${projectMajor}.*Repair: brew install node@${projectMajor}`, 's'))
  assert.equal(existsSync(join(held.state, 'ran')), false)
  assert.equal(held.ready(), false)
})

test('a CLI check still running at the cap is stopped, reported as exit 124 and kept in the log', t => {
  const held = project(t, { check: '#!/bin/sh\necho started\nsleep 60\n' })
  const result = held.run({ NDEV_FLOW_CHECK_MAX_MS: '1500' })
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /pre-ready-check\.sh exited 124.*Log: .*still running after 1500 ms.*stopped/s)
  assert.match(held.log(), /exit 124\n--- stdout\nstarted/)
  assert.equal(held.ready(), false)
})

test('a long CLI check reports its step and elapsed time on stderr while it runs', t => {
  const held = project(t, { check: '#!/bin/sh\nsleep 3\nexit 0\n' })
  const result = held.run({ NDEV_FLOW_PROGRESS_MS: '1000', NDEV_FLOW_CHECK_MAX_MS: '600000' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const lines = result.stderr.split('\n').filter(line => line.startsWith('ndev flow: '))
  assert.ok(lines.length >= 2, result.stderr)
  assert.match(lines[0], /^ndev flow: \S+\/pre-ready-check\.sh still runs after [12] s of at most 10 min\.$/)
  assert.match(lines.at(-1), /still runs after [23] s of at most 10 min\.$/)
  assert.ok(held.ready())
})

test('the worktree view panel shows a running CLI check from the progress it writes', t => {
  const held = project(t, { check: '#!/bin/sh\nsleep 2\n"$NDEV_NODE" "$NDEV_CLI" pane view > "$NDEV_TEST_STATE/pane" 2>&1\nexit 0\n' })
  const result = held.run({ NDEV_NODE: process.execPath, NDEV_CLI: fileURLToPath(new URL('../scripts/cli.mjs', import.meta.url)), NDEV_FLOW_CHECK_MAX_MS: '600000' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(readFileSync(join(held.state, 'pane'), 'utf8'), /Flow\nRunning step: scripts\/ndev\/workflow\/pre-ready-check\.sh · running [23] s of at most 10 min\n/)
})
