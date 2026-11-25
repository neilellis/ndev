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

function reviewing(t, { lag = 0, extra = {} } = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'ndev-finished-review-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const root = realpathSync(parent)
  const origin = join(root, 'origin.git')
  const work = join(root, 'work')
  const state = join(root, 'state')
  mkdirSync(state)
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  git(root, 'clone', '-q', origin, work)
  mkdirSync(join(work, 'scripts/ndev/workflow'), { recursive: true })
  writeFileSync(join(work, 'scripts/ndev/workflow/pre-ready-check.sh'), '#!/bin/sh\necho run >> "$NDEV_TEST_RUNS"\nexit 0\n')
  chmodSync(join(work, 'scripts/ndev/workflow/pre-ready-check.sh'), 0o755)
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
  const reviewed = git(work, 'rev-parse', 'HEAD')
  writeFileSync(join(work, 'a.txt'), 'two\n')
  git(work, 'add', 'a.txt')
  git(work, 'commit', '-q', '-m', 'review fix')
  const fix = git(work, 'rev-parse', 'HEAD')
  writeFileSync(join(state, 'stale'), reviewed)
  writeFileSync(join(state, 'lag'), String(lag))
  writeFileSync(join(state, 'ref'), 'feat')
  const gh = join(root, 'fake-gh.sh')
  writeFileSync(gh, `#!/bin/sh
state=${JSON.stringify(state)}
case "$1" in
  pr-read)
    head=$(git --git-dir=${JSON.stringify(origin)} rev-parse refs/heads/feat)
    lag=$(cat "$state/lag")
    if [ "$lag" -gt 0 ] && [ "$head" != "$(cat "$state/stale")" ]; then
      echo $((lag - 1)) > "$state/lag"
      head=$(cat "$state/stale")
    fi
    echo "pr-read" >> "$state/reads"
    echo '{"number":5,"state":"open","draft":true,"mergeable":true,"created_at":"2026-01-01T00:00:00Z","head":{"sha":"'$head'","ref":"'$(cat "$state/ref")'"}}' ;;
  pr-ready) echo ready >> "$state/ready" ;;
  comment) echo "$*" >> "$state/comments" ;;
  *) echo "fake gh.sh: unexpected $*" >&2; exit 9 ;;
esac
`)
  chmodSync(gh, 0o755)
  const record = join(work, '.neil-dev.issue-12.json')
  writeFileSync(record, JSON.stringify({ version: 1, issue: 12, rounds: [], workflow: { issue: 12, root: work, repo: 'o/r', base: 'main', branch: 'feat', prs: [5], mode: 'light', steering: 'auto', state: 'reviewing', evidence: {}, history: [], followUps: [], migrations: [], attempts: 0, nudges: { count: 0 }, rev: 1, baseCheck: { note: 'fixture' }, hooks: { remember: { firedAt: 1 } }, ...extra } }))
  const runs = join(state, 'runs')
  const env = {}
  const run = (...flags) => spawnSync(ndev, ['flow', 'finished-review', '--issue', '12', '--review', 'no findings', '--deadcode', 'nothing', '--remembered', 'nothing: fixture', ...flags], { cwd: work, encoding: 'utf8', env: { ...process.env, ...identity, NDEV_FLOW_GH: gh, NDEV_TEST_RUNS: runs, NDEV_FLOW_PR_HEAD_WAIT_MS: '2000', NDEV_FLOW_PR_HEAD_POLL_MS: '20', ...env } })
  const count = file => (existsSync(join(state, file)) ? readFileSync(join(state, file), 'utf8').split('\n').filter(Boolean).length : 0)
  return { env, state, work, origin, reviewed, fix, run, preReadyRuns: () => count('runs'), ready: () => count('ready'), record: () => JSON.parse(readFileSync(record, 'utf8')).workflow, remote: () => git(origin, 'rev-parse', 'refs/heads/feat') }
}

test('finished-review pushes held review-fix commits on top of the reviewed PR head and marks the PR ready', t => {
  const held = reviewing(t)
  const result = held.run()
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(held.remote(), held.fix)
  assert.equal(held.ready(), 1)
  assert.equal(held.record().state, 'ci')
  assert.equal(held.record().evidence.review.sha, held.fix)
  assert.match(held.record().evidence.review.text, /^review: no findings\n/)
  assert.equal(held.preReadyRuns(), 1)
})

test('finished-review waits for the PR head to show the pushed commit and runs the pre-ready check once', t => {
  const held = reviewing(t, { lag: 3 })
  const result = held.run()
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(held.preReadyRuns(), 1)
  assert.equal(held.ready(), 1)
  assert.equal(held.record().state, 'ci')
})

test('finished-review that cannot see the pushed commit in time fails with the PR head, and a retry does not rerun the pre-ready check', t => {
  const held = reviewing(t, { lag: 1000 })
  const first = held.run()
  assert.equal(first.status, 1, first.stdout)
  assert.match(first.stderr, new RegExp(`PR #5 still points to feat@${held.reviewed} 2000 ms after the push; expected feat@${held.fix}.*finished-review again`))
  assert.equal(held.ready(), 0)
  assert.equal(held.record().state, 'reviewing')
  writeFileSync(join(held.work, '../state/lag'), '0')
  const second = held.run()
  assert.equal(second.status, 0, second.stderr || second.stdout)
  assert.equal(held.preReadyRuns(), 1)
  assert.equal(held.ready(), 1)
  assert.equal(held.record().state, 'ci')
})

test('finished-review rejects a PR whose remote head is neither the reviewed head nor the new one', t => {
  const held = reviewing(t)
  git(held.work, 'switch', '-q', '--detach', 'main')
  writeFileSync(join(held.work, 'b.txt'), 'x\n')
  git(held.work, 'add', 'b.txt')
  git(held.work, 'commit', '-q', '-m', 'someone else')
  git(held.work, 'push', '-q', 'origin', 'HEAD:refs/heads/feat', '--force')
  git(held.work, 'switch', '-q', 'feat')
  const result = held.run()
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /Repair/)
  assert.equal(held.ready(), 0)
  assert.equal(held.preReadyRuns(), 0)
})

test('finished-review reruns the pre-ready check when HEAD changed after the receipt', t => {
  const held = reviewing(t, { lag: 1000 })
  assert.equal(held.run().status, 1)
  assert.equal(held.preReadyRuns(), 1)
  writeFileSync(join(held.state, 'lag'), '0')
  writeFileSync(join(held.work, 'a.txt'), 'three\n')
  git(held.work, 'add', 'a.txt')
  git(held.work, 'commit', '-q', '-m', 'another fix')
  const result = held.run()
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(held.preReadyRuns(), 2)
  assert.equal(held.remote(), git(held.work, 'rev-parse', 'HEAD'))
})

test('finished-review rejects a PR on another branch at once instead of waiting', t => {
  const held = reviewing(t)
  writeFileSync(join(held.state, 'ref'), 'other')
  held.env.NDEV_FLOW_PR_HEAD_WAIT_MS = '60000'
  const started = Date.now()
  const result = held.run()
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /points to other@/)
  assert.ok(Date.now() - started < 30000)
  assert.equal(held.ready(), 0)
})
