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

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...env, ...identity } })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

function developing(t, { joining } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ndev-finished-development-')))
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
  mkdirSync(join(work, 'old'))
  writeFileSync(join(work, 'old/widget.ts'), 'export const widget = 1\n')
  writeFileSync(join(work, '.neil-dev.json'), JSON.stringify({ mode: 'light', steering: 'auto', github: { repo: 'o/r' } }))
  writeFileSync(join(work, '.gitignore'), '.neil-dev.issue-*.json\n')
  git(work, 'add', '-A')
  git(work, 'commit', '-q', '-m', 'base')
  git(work, 'push', '-q', 'origin', 'main')
  git(work, 'switch', '-q', '-c', '12-fix-thing')
  const calls = join(root, 'gh-calls')
  const body = join(root, 'pr-body')
  writeFileSync(body, joining ?? 'Plan incoming.\n\nCloses #12\n')
  const gh = join(root, 'fake-gh.sh')
  writeFileSync(gh, `#!/bin/sh
echo "$*" >> '${calls}'
case "$1" in
  issue-read) echo '{"title":"Fix the thing","state":"open","body":""}' ;;
  pr-read) node -e 'console.log(JSON.stringify({ number: 77, state: "open", body: require("fs").readFileSync(process.argv[1], "utf8"), head: { ref: "12-fix-thing", sha: "x" }, base: { ref: "main" } }))' '${body}' ;;
  pr-edit) cp "$4" '${body}' ;;
  pr-list) echo '{"number":77}' ;;
  *) echo "fake gh.sh: unexpected $*" >&2; exit 9 ;;
esac
`)
  chmodSync(gh, 0o755)
  const record = join(work, '.neil-dev.issue-12.json')
  writeFileSync(record, JSON.stringify({ version: 1, issue: 12, rounds: [], workflow: { issue: 12, root: work, repo: 'o/r', base: 'main', branch: '12-fix-thing', ...(joining === undefined ? { prs: [77] } : { prs: [], prTitle: 'Fix the thing' }), mode: 'light', steering: 'auto', state: 'developing', evidence: {}, history: [], followUps: [], migrations: [], attempts: 0, nudges: { count: 0 }, rev: 1, baseCheck: { note: 'fixture' } } }))
  const flow = (...args) => spawnSync(ndev, ['flow', ...args, '--issue', '12'], { cwd: work, encoding: 'utf8', env: { ...env, ...identity, NDEV_FLOW_GH: gh } })
  return { root, work, flow, state: () => JSON.parse(readFileSync(record, 'utf8')).workflow, body: () => readFileSync(body, 'utf8'), calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '') }
}

test('finished-development accepts the old path of a rename that an earlier checkpoint committed', t => {
  const held = developing(t)
  mkdirSync(join(held.work, 'new'))
  git(held.work, 'mv', 'old/widget.ts', 'new/widget.ts')
  const saved = held.flow('checkpoint', '--message', 'Move the widget', '--file', 'old/widget.ts', '--file', 'new/widget.ts')
  assert.equal(saved.status, 0, saved.stderr || saved.stdout)
  writeFileSync(join(held.work, 'new/widget.ts'), 'export const widget = 2\n')
  const result = held.flow('finished-development', '--message', 'Change the widget', '--file', 'old/widget.ts', '--file', 'new/widget.ts')
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(held.state().state, 'reviewing')
  assert.equal(git(held.work, 'show', 'HEAD:new/widget.ts'), 'export const widget = 2')
  assert.equal(git(held.work, 'status', '--porcelain'), '')
})

test('finished-development still refuses a named path that the branch never had', t => {
  const held = developing(t)
  writeFileSync(join(held.work, 'old/widget.ts'), 'export const widget = 2\n')
  const result = held.flow('finished-development', '--message', 'Change the widget', '--file', 'old/widget.ts', '--file', 'old/wigdet.ts')
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /old\/wigdet\.ts is not in the worktree, the index or the history of 12-fix-thing. Nothing was committed. Repair: /)
  assert.equal(held.state().state, 'developing')
})

test('finished-development adds no closing keyword for an issue that the body names as "Part of" or "Refs"', t => {
  for (const words of ['Part of #12', 'Refs #12', 'Refs: o/r#12']) {
    const held = developing(t)
    writeFileSync(join(held.work, 'old/widget.ts'), 'export const widget = 2\n')
    const file = join(held.root, 'body.md')
    writeFileSync(file, `Groups A and C.\n\n${words}\n`)
    const result = held.flow('finished-development', '--message', 'Do groups A and C', '--file', 'old/widget.ts', '--body-file', file)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(held.body(), `Groups A and C.\n\n${words}\n`)
  }
})

test('finished-development still adds the closing keyword when the body does not name the issue', t => {
  const held = developing(t)
  writeFileSync(join(held.work, 'old/widget.ts'), 'export const widget = 2\n')
  const file = join(held.root, 'body.md')
  writeFileSync(file, 'Groups A and C. Part of #120.\n')
  const result = held.flow('finished-development', '--message', 'Do groups A and C', '--file', 'old/widget.ts', '--body-file', file)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(held.body(), 'Groups A and C. Part of #120.\n\nCloses #12\n')
})

test('finished-development joins the open PR of the branch and adds no closing keyword when its body says "Part of"', t => {
  const held = developing(t, { joining: 'Groups A and C.\n\nPart of #12\n' })
  writeFileSync(join(held.work, 'old/widget.ts'), 'export const widget = 2\n')
  const result = held.flow('finished-development', '--message', 'Do groups A and C', '--file', 'old/widget.ts')
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.deepEqual(held.state().prs, [77])
  assert.equal(held.body(), 'Groups A and C.\n\nPart of #12\n')
})

test('finished-development joins the open PR of the branch and adds the closing keyword when its body does not name the issue', t => {
  const held = developing(t, { joining: 'Groups A and C. Part of #120.\n' })
  writeFileSync(join(held.work, 'old/widget.ts'), 'export const widget = 2\n')
  const result = held.flow('finished-development', '--message', 'Do groups A and C', '--file', 'old/widget.ts')
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.deepEqual(held.state().prs, [77])
  assert.equal(held.body(), 'Groups A and C. Part of #120.\n\nCloses #12\n')
})
