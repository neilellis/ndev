import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ndev = fileURLToPath(new URL('../bin/ndev', import.meta.url))
const standalone = fileURLToPath(new URL('../scripts/export/flow/cli.ts', import.meta.url))

function fixture(t, workflow) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ndev-flow-start-')))
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

test('goto, mode and steering name a value that is already set, and change nothing', t => {
  const held = fixture(t, { state: 'developing', mode: 'light', steering: 'interactive' })
  const before = held.state()
  for (const [args, said] of [[['goto', 'developing'], /already in the state "developing"/], [['mode', 'light'], /already light/], [['steering', 'interactive'], /already interactive/]]) {
    const result = spawnSync(ndev, ['flow', ...args, '--issue', '12'], { cwd: held.root, encoding: 'utf8', env: { ...process.env, NDEV_FLOW_GH: held.gh } })
    assert.ifError(result.error)
    assert.equal(result.status, 1, `${args.join(' ')}: ${result.stdout}${result.stderr}`)
    assert.match(result.stderr, said)
    assert.match(result.stderr, /Nothing changed/)
  }
  for (const [args, said] of [[['goto', '--state', 'developing'], /already in the state "developing"/], [['mode', '--mode', 'light'], /already light/], [['steering', '--steering', 'interactive'], /already interactive/]]) {
    const result = spawnSync(process.execPath, [standalone, ...args, '--issue', '12'], { cwd: held.root, encoding: 'utf8', env: { ...process.env, NDEV_FLOW_GH: held.gh } })
    assert.ifError(result.error)
    assert.equal(result.status, 1, `ndev-flow ${args.join(' ')}: ${result.stdout}${result.stderr}`)
    assert.match(result.stderr, said)
  }
  assert.deepEqual(held.state(), before)
})

test('skip out of the interview drops the open chat round and says so', t => {
  const held = fixture(t, { state: 'interviewing', mode: 'light', steering: 'interactive' })
  const record = join(held.root, '.neil-dev.issue-12.json')
  writeFileSync(record, JSON.stringify({ ...JSON.parse(readFileSync(record, 'utf8')), chatRound: { title: 'The login page', questions: [{ id: 'name', header: 'Name', question: 'What name?' }] } }))
  const commit = spawnSync('git', ['-C', held.root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base'], { encoding: 'utf8' })
  assert.equal(commit.status, 0, commit.stderr)
  const skipArgs = [ndev, 'flow', 'skip', 'the human decides', '--issue', '12']
  const shellQuote = s => `'${String(s).replace(/'/g, "'\\''")}'`
  const typed = process.platform === 'linux'
    ? `(printf "%s\\n" "$PHRASE"; sleep 2) | script -q -e -c ${shellQuote(skipArgs.map(shellQuote).join(' '))} /dev/null`
    : '(printf "%s\\n" "$PHRASE"; sleep 2) | script -q /dev/null "$@"'
  const result = spawnSync('sh', process.platform === 'linux' ? ['-c', typed] : ['-c', typed, 'sh', ...skipArgs], { cwd: held.root, encoding: 'utf8', env: { ...process.env, NDEV_FLOW_GH: held.gh, PHRASE: 'confirm skip #12 1' } })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout)
  assert.equal(held.state().state, 'developing')
  assert.equal(JSON.parse(readFileSync(record, 'utf8')).chatRound, undefined)
  assert.match(result.stdout, /"The login page"/)
})

for (const [name, history, want] of [
  ['checkpoint on a heavy issue with a signed-off plan goes back to developing', [{ at: 1, tool: 'finishedPlan', from: 'planning', to: 'blocked' }], 'developing'],
  ['checkpoint on a heavy issue that never planned goes back to planning', [], 'planning'],
]) {
  test(name, t => {
    const held = fixture(t, { state: 'developed', mode: 'heavy', steering: 'interactive', history })
    const run = (...args) => {
      const r = spawnSync(args[0], args.slice(1), { cwd: held.root, encoding: 'utf8' })
      assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`)
    }
    const origin = realpathSync(mkdtempSync(join(tmpdir(), 'ndev-flow-origin-')))
    t.after(() => rmSync(origin, { recursive: true, force: true }))
    run('git', 'init', '-q', '--bare', origin)
    run('git', 'remote', 'add', 'origin', origin)
    run('git', 'switch', '-q', '-c', 'b')
    run('git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base')
    run('mkdir', '-p', 'scripts/ndev/workflow')
    for (const check of ['fast-checks', 'pre-commit-check', 'pre-push-check']) {
      writeFileSync(join(held.root, 'scripts/ndev/workflow', `${check}.sh`), '#!/bin/sh\nexit 0\n')
      chmodSync(join(held.root, 'scripts/ndev/workflow', `${check}.sh`), 0o755)
    }
    writeFileSync(join(held.root, 'a.txt'), 'more work\n')
    const result = spawnSync(ndev, ['flow', 'checkpoint', '--issue', '12', '--message', 'More work', '--file', 'a.txt'], { cwd: held.root, encoding: 'utf8', env: { ...process.env, NDEV_FLOW_GH: held.gh } })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(held.state().state, want)
  })
}
