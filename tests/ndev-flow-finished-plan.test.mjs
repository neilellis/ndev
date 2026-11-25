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

function heavyPlanning(t, { ahead, steering = 'interactive', plan: planText = '# Plan\n\nTest entry point: ndev flow finished-plan\n' }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ndev-finished-plan-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const origin = join(root, 'origin.git')
  const work = join(root, 'work')
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  git(root, 'clone', '-q', origin, work)
  mkdirSync(join(work, 'scripts/ndev/workflow'), { recursive: true })
  for (const check of ['fast-checks.sh', 'pre-commit-check.sh', 'pre-push-check.sh', 'pre-ready-check.sh']) {
    writeFileSync(join(work, 'scripts/ndev/workflow', check), '#!/bin/sh\nexit 0\n')
    chmodSync(join(work, 'scripts/ndev/workflow', check), 0o755)
  }
  writeFileSync(join(work, '.neil-dev.json'), JSON.stringify({ mode: 'heavy', steering, github: { repo: 'o/r' } }))
  writeFileSync(join(work, '.gitignore'), '.neil-dev.issue-*.json\n')
  git(work, 'add', '-A')
  git(work, 'commit', '-q', '-m', 'base')
  git(work, 'push', '-q', 'origin', 'main')
  git(work, 'switch', '-q', '-c', '12-fix-thing')
  if (ahead) {
    writeFileSync(join(work, 'a.txt'), 'work\n')
    git(work, 'add', 'a.txt')
    git(work, 'commit', '-q', '-m', 'work')
  }
  const calls = join(root, 'gh-calls')
  const body = join(root, 'pr-body')
  const gh = join(root, 'fake-gh.sh')
  writeFileSync(gh, `#!/bin/sh
echo "$*" >> '${calls}'
case "$1" in
  issue-read) echo '{"title":"Fix the thing","state":"open","body":""}' ;;
  pr-list) ;;
  pr-new) shift; while [ "$1" != --body-file ]; do shift; done; cp "$2" '${body}'; echo 'https://github.com/o/r/pull/77' ;;
  pr-edit) cp "$4" '${body}' ;;
  *) echo "fake gh.sh: unexpected $*" >&2; exit 9 ;;
esac
`)
  chmodSync(gh, 0o755)
  const record = join(work, '.neil-dev.issue-12.json')
  writeFileSync(record, JSON.stringify({ version: 1, issue: 12, rounds: [], workflow: { issue: 12, root: work, repo: 'o/r', base: 'main', branch: '12-fix-thing', prs: [], mode: 'heavy', steering, state: 'planning', evidence: {}, history: [], followUps: [], migrations: [], attempts: 0, nudges: { count: 0 }, rev: 1 } }))
  const plan = join(root, 'plan.md')
  writeFileSync(plan, planText)
  const finishedPlan = () => spawnSync(ndev, ['flow', 'finished-plan', '--issue', '12', '--markdown-file', plan], { cwd: work, encoding: 'utf8', env: { ...process.env, ...identity, NDEV_FLOW_GH: gh } })
  return { work, origin, finishedPlan, state: () => JSON.parse(readFileSync(record, 'utf8')).workflow, body: () => (existsSync(body) ? readFileSync(body, 'utf8') : ''), calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '') }
}

test('finished-plan opens the draft PR with the plan for a heavy issue whose record has no PR', t => {
  const held = heavyPlanning(t, { ahead: true })
  const result = held.finishedPlan()
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.deepEqual(held.state().prs, [77])
  assert.equal(held.state().state, 'blocked')
  assert.equal(git(held.work, 'rev-parse', 'origin/12-fix-thing'), git(held.work, 'rev-parse', 'HEAD'))
  assert.match(held.calls(), /^pr-new --title Fix the thing/m)
  assert.match(held.body(), /Test entry point: ndev flow finished-plan/)
  assert.match(held.body(), /Closes #12/)
})

test('finished-plan holds the plan for the first push when a heavy issue has no PR and no commit yet', t => {
  const held = heavyPlanning(t, { ahead: false })
  const result = held.finishedPlan()
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.deepEqual(held.state().prs, [])
  assert.equal(held.state().prTitle, 'Fix the thing')
  assert.match(held.state().prBody, /Test entry point: ndev flow finished-plan\n\nCloses #12/)
  assert.equal(held.state().state, 'blocked')
  assert.doesNotMatch(held.calls(), /^pr-new/m)
})

test('finished-plan with auto steering puts the plan in the PR and enters development', t => {
  const held = heavyPlanning(t, { ahead: true, steering: 'auto' })
  const result = held.finishedPlan()
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(held.state().state, 'developing')
  assert.equal(held.state().blocked, undefined)
  assert.match(held.body(), /Test entry point: ndev flow finished-plan/)
})

test('finished-plan adds no closing keyword for an issue that the plan names as "Part of"', t => {
  const held = heavyPlanning(t, { ahead: true, plan: '# Plan\n\nGroups A and C. Part of #12\n\nTest entry point: ndev flow finished-plan\n' })
  const result = held.finishedPlan()
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(held.body(), /Part of #12/)
  assert.doesNotMatch(held.body(), /Closes #12/)
})
