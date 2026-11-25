import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'lowered-bar.mjs')

function repo(t, base) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lowered-bar-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  }
  const write = files => {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) unlinkSync(join(root, path))
      else {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        writeFileSync(join(root, path), text)
      }
    }
  }
  git('init', '-q', '-b', 'main')
  write(base)
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  git('switch', '-q', '-c', 'change')
  return {
    root,
    change(files) {
      write(files)
      git('add', '-A')
      git('commit', '-q', '-m', 'change')
    },
    scan: (...args) => spawnSync(process.execPath, [SCRIPT, ...(args.length ? args : ['main'])], { cwd: root, encoding: 'utf8' }),
  }
}

const BASE_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'

test('adds', () => {
  assert.equal(1 + 1, 2)
})

test('subtracts', () => {
  assert.equal(2 - 1, 1)
})
`

test('a test diff with an added .skip and an empty catch is reported', t => {
  const r = repo(t, { 'src/math.test.mjs': BASE_TEST, 'src/load.js': 'export function load(read) {\n  return read()\n}\n' })
  r.change({
    'src/math.test.mjs': BASE_TEST.replace("test('subtracts'", "test.skip('subtracts'"),
    'src/load.js': 'export function load(read) {\n  try {\n    return read()\n  } catch (error) {}\n}\n',
  })
  const out = r.scan()
  assert.equal(out.status, 1, out.stdout + out.stderr)
  assert.match(out.stdout, /^src\/math\.test\.mjs:8: skipped or focused test: test\.skip\('subtracts'/m)
  assert.match(out.stdout, /^src\/load\.js:4: empty catch: \} catch \(error\) \{\}/m)
  assert.match(out.stdout, /stated reason/)
})

test('a clean diff is not reported', t => {
  const r = repo(t, { 'src/math.test.mjs': BASE_TEST })
  r.change({ 'src/math.test.mjs': `${BASE_TEST}\ntest('multiplies', () => {\n  assert.equal(2 * 3, 6)\n})\n`, 'src/ok.js': 'try {\n  run()\n} catch (error) {\n  throw new Error(`run failed: ${error.message}`)\n}\n' })
  const out = r.scan()
  assert.equal(out.status, 0, out.stdout + out.stderr)
  assert.doesNotMatch(out.stdout, /:\d+: /)
  assert.match(out.stdout, /found nothing/)
})

test('deleted tests and assertions are reported at their old line, and a deleted test file is reported', t => {
  const r = repo(t, { 'src/math.test.mjs': BASE_TEST, 'tests/old_test.py': 'def test_old():\n    assert True\n' })
  r.change({ 'src/math.test.mjs': BASE_TEST.replace("  assert.equal(2 - 1, 1)\n", ''), 'tests/old_test.py': null })
  const out = r.scan()
  assert.equal(out.status, 1, out.stdout + out.stderr)
  assert.match(out.stdout, /^src\/math\.test\.mjs:9: deleted assertion: assert\.equal\(2 - 1, 1\)/m)
  assert.match(out.stdout, /^tests\/old_test\.py: deleted test file/m)
})

test('a lowered threshold, a raised timeout and new suppressions are reported', t => {
  const r = repo(t, { 'vitest.config.ts': 'export default {\n  coverage: { threshold: 80 },\n  testTimeout: 5000,\n}\n', 'src/a.ts': 'export const a = 1\n', 'src/b.py': 'b = 1\n' })
  r.change({
    'vitest.config.ts': 'export default {\n  coverage: { threshold: 60 },\n  testTimeout: 30000,\n}\n',
    'src/a.ts': '// @ts-ignore\nexport const a: number = "1"\n// eslint-disable-next-line no-console\nconsole.log(a)\n',
    'src/b.py': 'import os  # noqa: F401\nb = 1  # type: ignore\n',
  })
  const out = r.scan()
  assert.equal(out.status, 1, out.stdout + out.stderr)
  assert.match(out.stdout, /^vitest\.config\.ts:2: lowered threshold: threshold 80 -> 60/m)
  assert.match(out.stdout, /^vitest\.config\.ts:3: raised timeout: testTimeout 5000 -> 30000/m)
  assert.match(out.stdout, /^src\/a\.ts:1: lint or type suppression: \/\/ @ts-ignore/m)
  assert.match(out.stdout, /^src\/a\.ts:3: lint or type suppression: \/\/ eslint-disable-next-line/m)
  assert.match(out.stdout, /^src\/b\.py:1: lint or type suppression:/m)
  assert.match(out.stdout, /^src\/b\.py:2: lint or type suppression:/m)
})

test('a raised threshold is not reported', t => {
  const r = repo(t, { 'jest.config.js': 'module.exports = { coverageThreshold: { global: { lines: 60 } } }\n' })
  r.change({ 'jest.config.js': 'module.exports = { coverageThreshold: { global: { lines: 80 } } }\n' })
  const out = r.scan()
  assert.equal(out.status, 0, out.stdout + out.stderr)
})

test('an empty catch over several lines and a bare except with pass are reported', t => {
  const r = repo(t, { 'src/a.js': 'run()\n', 'src/b.py': 'run()\n' })
  r.change({ 'src/a.js': 'try {\n  run()\n} catch {\n}\nload().catch(() => {})\n', 'src/b.py': 'try:\n    run()\nexcept Exception:\n    pass\n' })
  const out = r.scan()
  assert.equal(out.status, 1, out.stdout + out.stderr)
  assert.match(out.stdout, /^src\/a\.js:3: empty catch:/m)
  assert.match(out.stdout, /^src\/a\.js:5: empty catch: load\(\)\.catch\(\(\) => \{\}\)/m)
  assert.match(out.stdout, /^src\/b\.py:3: empty catch: except Exception:/m)
})

test('xit, .only and pytest skips are reported', t => {
  const r = repo(t, { 'a.spec.js': 'it("a", () => {})\n', 'test_b.py': 'def test_b():\n    assert True\n' })
  r.change({ 'a.spec.js': 'xit("a", () => {})\ndescribe.only("b", () => {})\n', 'test_b.py': 'import pytest\n\n@pytest.mark.skip\ndef test_b():\n    assert True\n' })
  const out = r.scan()
  assert.equal(out.status, 1, out.stdout + out.stderr)
  assert.match(out.stdout, /^a\.spec\.js:1: skipped or focused test: xit\(/m)
  assert.match(out.stdout, /^a\.spec\.js:2: skipped or focused test: describe\.only\(/m)
  assert.match(out.stdout, /^test_b\.py:3: skipped or focused test: @pytest\.mark\.skip/m)
})

test('prose files are not scanned', t => {
  const r = repo(t, { 'README.md': 'Read me.\n' })
  r.change({ 'README.md': 'Never add `.skip` or an empty `catch {}` or `// @ts-ignore`.\n' })
  const out = r.scan()
  assert.equal(out.status, 0, out.stdout + out.stderr)
})

test('a base that git cannot resolve fails with the ref and the git output', t => {
  const r = repo(t, { 'a.js': '1\n' })
  const out = r.scan('origin/nope')
  assert.equal(out.status, 2)
  assert.match(out.stderr, /origin\/nope/)
  assert.match(out.stderr, /git diff/)
})

test('no base is a usage error', t => {
  const r = repo(t, { 'a.js': '1\n' })
  const out = spawnSync(process.execPath, [SCRIPT], { cwd: r.root, encoding: 'utf8' })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /usage: lowered-bar\.mjs <base-ref>/)
})

test('a binary file, a pure rename and a mode change are not errors', t => {
  const r = repo(t, { 'a.py': 'a = 1\n', 'b.sh': 'echo b\n' })
  writeFileSync(join(r.root, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
  spawnSync('git', ['mv', 'a.py', 'c.py'], { cwd: r.root })
  spawnSync('chmod', ['+x', 'b.sh'], { cwd: r.root })
  r.change({})
  const out = r.scan()
  assert.equal(out.status, 0, out.stdout + out.stderr)
  assert.match(out.stdout, /found nothing/)
})

test('a renamed test is not reported as a deleted test', t => {
  const r = repo(t, { 'src/math.test.mjs': BASE_TEST })
  r.change({ 'src/math.test.mjs': BASE_TEST.replace("test('adds'", "test('adds two numbers'") })
  const out = r.scan()
  assert.equal(out.status, 0, out.stdout + out.stderr)
})

test('a deleted test is reported', t => {
  const r = repo(t, { 'src/math.test.mjs': BASE_TEST })
  r.change({ 'src/math.test.mjs': BASE_TEST.replace("\ntest('subtracts', () => {\n  assert.equal(2 - 1, 1)\n})\n", '') })
  const out = r.scan()
  assert.equal(out.status, 1, out.stdout + out.stderr)
  assert.match(out.stdout, /^src\/math\.test\.mjs:8: deleted test: test\('subtracts'/m)
  assert.match(out.stdout, /^src\/math\.test\.mjs:9: deleted assertion:/m)
})
