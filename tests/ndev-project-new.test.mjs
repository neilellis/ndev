import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ndev = fileURLToPath(new URL('../bin/ndev', import.meta.url))

function fixture(t, reply) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ndev-project-new-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal(spawnSync('git', ['init', '-q', root], { encoding: 'utf8' }).status, 0)
  writeFileSync(join(root, 'body.md'), 'The body.\n')
  const gh = join(root, 'gh.sh')
  writeFileSync(gh, `#!/bin/sh
printf '%s\\n' "$@" > "${root}/gh.args"
${reply}
`)
  chmodSync(gh, 0o755)
  return { root, gh, args: () => readFileSync(join(root, 'gh.args'), 'utf8').trim().split('\n'), called: () => existsSync(join(root, 'gh.args')) }
}

function project(f, args) {
  const result = spawnSync(ndev, ['project', '--json', ...args], { cwd: f.root, encoding: 'utf8', env: { ...process.env, NDEV_FLOW_GH: f.gh } })
  assert.ifError(result.error)
  return { ...result, json: result.stdout ? JSON.parse(result.stdout) : undefined }
}

test('project pr-new opens a draft PR through gh.sh pr-new and returns its number and URL', t => {
  const f = fixture(t, `echo '{"url":"https://github.com/o/r/pull/41"}'`)
  const result = project(f, ['pr-new', '--title', 'Fix the wait', '--body-file', 'body.md', '--base', 'main', '--head', 'topic'])
  assert.equal(result.status, 0, result.stdout || result.stderr)
  assert.deepEqual(f.args(), ['pr-new', '--title', 'Fix the wait', '--body-file', join(f.root, 'body.md'), '--base', 'main', '--head', 'topic'])
  assert.equal(result.json.result.number, 41)
  assert.equal(result.json.result.url, 'https://github.com/o/r/pull/41')
})

test('project pr-new --ready opens the PR ready for review', t => {
  const f = fixture(t, `echo '{"url":"https://github.com/o/r/pull/42"}'`)
  const result = project(f, ['pr-new', '--title', 'Fix', '--body-file', 'body.md', '--ready'])
  assert.equal(result.status, 0, result.stdout || result.stderr)
  assert.deepEqual(f.args(), ['pr-new', '--title', 'Fix', '--body-file', join(f.root, 'body.md'), '--ready'])
})

test('project issue-new files the issue with each label, assignee, milestone and type', t => {
  const f = fixture(t, `echo '{"number":43,"url":"https://github.com/o/r/issues/43"}'`)
  const result = project(f, ['issue-new', '--title', 'A bug', '--body-file', 'body.md', '--label', 'bug', '--label', 'ci', '--assignee', 'me', '--milestone', '3', '--type', 'Bug'])
  assert.equal(result.status, 0, result.stdout || result.stderr)
  assert.deepEqual(f.args(), ['issue-new', '--title', 'A bug', '--body-file', join(f.root, 'body.md'), '--label', 'bug', '--label', 'ci', '--assignee', 'me', '--milestone', '3', '--type', 'Bug'])
  assert.deepEqual([result.json.result.number, result.json.result.url], [43, 'https://github.com/o/r/issues/43'])
})

test('project issue-new refuses a missing body file before any GitHub call', t => {
  const f = fixture(t, 'exit 9')
  const result = project(f, ['issue-new', '--title', 'A bug', '--body-file', 'missing.md'])
  assert.equal(result.status, 2, result.stdout || result.stderr)
  assert.match(result.json.error.message, /missing\.md/)
  assert.equal(f.called(), false)
})

test('project pr-new reports the gh.sh failure with its exit code and output', t => {
  const f = fixture(t, `echo 'gh.sh: refusing to post: prose check failed' >&2; exit 3`)
  const result = project(f, ['pr-new', '--title', 'Fix', '--body-file', 'body.md'])
  assert.equal(result.status, 1, result.stdout || result.stderr)
  assert.match(result.json.error.message, /pr-new .*exited 3: gh\.sh: refusing to post: prose check failed/)
  assert.match(result.json.error.repair, /Nothing was posted\. Fix what the message names in .*body\.md, then run ndev project pr-new again\./)
})

test('project issue-new tells the agent to look on GitHub before a retry when gh.sh fails after a refusal check', t => {
  const f = fixture(t, `echo 'HTTP 502' >&2; exit 1`)
  const result = project(f, ['issue-new', '--title', 'Bug', '--body-file', 'body.md'])
  assert.equal(result.status, 1, result.stdout || result.stderr)
  assert.match(result.json.error.message, /issue-new .*exited 1: HTTP 502/)
  assert.match(result.json.error.repair, /Look on GitHub for the issue "Bug" before you retry/)
})
