import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const runner = fileURLToPath(new URL('../scripts/test/run.mjs', import.meta.url))
const PASS = "import { test } from 'node:test'\ntest('passes', () => {})\n"
const FAIL = "import { test } from 'node:test'\ntest('fails', () => { throw new Error('red') })\n"

function project(t, files, exceptions) {
  const root = mkdtempSync(join(tmpdir(), 'ndev-test-runner-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: root }).status, 0, args.join(' '))
  git('init', '-q')
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  if (exceptions) {
    mkdirSync(join(root, 'scripts/test'), { recursive: true })
    writeFileSync(join(root, 'scripts/test/exceptions.json'), JSON.stringify(exceptions))
  }
  git('add', '-A')
  return root
}

const { NODE_TEST_CONTEXT, ...topLevel } = process.env
const run = (root, ...args) => spawnSync(process.execPath, [runner, '--root', root, ...args], { encoding: 'utf8', env: topLevel })

test('lists every tracked test file in any folder, and leaves out untracked files and the exceptions', t => {
  const root = project(t, { 'tests/a.test.mjs': PASS, 'scripts/x/tests/b.test.mjs': PASS, 'skills/y/scripts/tests/c.test.mjs': PASS, 'skills/z/d.test.mjs': PASS }, [{ path: 'skills/z/d.test.mjs', reason: 'needs a browser' }])
  writeFileSync(join(root, 'tests/untracked.test.mjs'), PASS)
  const out = run(root, '--list')
  assert.equal(out.status, 0, out.stderr)
  assert.equal(out.stdout, 'scripts/x/tests/b.test.mjs\nskills/y/scripts/tests/c.test.mjs\ntests/a.test.mjs\n')
})

test('runs the listed files and keeps the exit status of a failure', t => {
  const green = project(t, { 'tests/a.test.mjs': PASS, 'skills/y/b.test.mjs': PASS })
  const ok = run(green)
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  assert.match(ok.stdout, /ℹ tests 2\n/)
  const red = project(t, { 'tests/a.test.mjs': PASS, 'skills/y/b.test.mjs': FAIL })
  const bad = run(red)
  assert.equal(bad.status, 1)
  assert.match(bad.stdout, /ℹ fail 1\n/)
})

test('fails an exception with no reason, and one that names no tracked test file', t => {
  const noReason = run(project(t, { 'tests/a.test.mjs': PASS }, [{ path: 'tests/a.test.mjs', reason: ' ' }]), '--list')
  assert.equal(noReason.status, 1)
  assert.match(noReason.stderr, /scripts\/test\/exceptions\.json: the exception for tests\/a\.test\.mjs gives no reason/)
  const stale = run(project(t, { 'tests/a.test.mjs': PASS }, [{ path: 'tests/gone.test.mjs', reason: 'old' }]), '--list')
  assert.equal(stale.status, 1)
  assert.match(stale.stderr, /scripts\/test\/exceptions\.json: tests\/gone\.test\.mjs is not a tracked test file\. Remove the exception/)
})

test('the exceptions of this repository each give a reason and name a tracked file', () => {
  const out = spawnSync(process.execPath, [runner, '--list'], { encoding: 'utf8' })
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /^skills\/deadcode\/scripts\/tests\//m)
  assert.doesNotMatch(out.stdout, /responsive-check\.test\.mjs/)
})
