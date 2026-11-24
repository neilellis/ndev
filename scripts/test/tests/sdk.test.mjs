import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SDK = fileURLToPath(new URL('../sdk.mjs', import.meta.url))
const VERSION = '9.9.9'

const passLine = name => `(pass) ${name} [1.00ms]\n`
const failLine = name => `(fail) ${name} [1.00ms]\n  AssertionError: expected 1\n`
const report = (files, summary) => {
  const body = Object.entries(files).map(([file, lines]) => `${file}:\n${lines.join('')}\n`).join('')
  const all = Object.values(files).flat()
  const failed = all.filter(line => line.startsWith('(fail)')).length
  const passed = all.filter(line => line.startsWith('(pass)')).length
  return `${body}\n ${passed} pass\n ${failed} fail\n${summary ?? `Ran ${passed + failed} tests across ${Object.keys(files).length} ${Object.keys(files).length === 1 ? 'file' : 'files'}. [1.00ms]`}\n`
}

function project({ files = { 'tests/a.test.ts': [passLine('first'), passLine('second')] }, tracked = Object.keys(files), known, runtimeFile = { package: '@anthropic-ai/claude-code', version: VERSION }, output, status, version = `${VERSION} (Claude Code)`, runtime = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sdk-runner-'))
  const git = (...args) => assert.equal(spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }).status, 0)
  git('init', '-q')
  mkdirSync(join(root, 'scripts/test'), { recursive: true })
  mkdirSync(join(root, 'tests'), { recursive: true })
  if (runtimeFile) writeFileSync(join(root, 'scripts/test/sdk-runtime.json'), JSON.stringify(runtimeFile))
  if (known !== undefined) writeFileSync(join(root, 'scripts/test/sdk-known-failures.json'), JSON.stringify(known))
  for (const file of tracked) writeFileSync(join(root, file), '')
  git('add', '-A')
  writeFileSync(join(root, 'output.txt'), output ?? report(files))
  const fake = join(root, 'fake-claude')
  writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi\ncat '${join(root, 'output.txt')}'\nexit ${status ?? (Object.values(files).flat().some(line => line.startsWith('(fail)')) ? 1 : 0)}\n`)
  chmodSync(fake, 0o755)
  return { root, runtime: runtime ? fake : join(root, 'missing-claude') }
}

const run = ({ root, runtime }, extra = []) => {
  const result = spawnSync(process.execPath, [SDK, '--root', root, '--runtime', runtime, ...extra], { encoding: 'utf8' })
  return { status: result.status, text: `${result.stdout}${result.stderr}` }
}

test('a suite whose tests all pass passes, with its counts', () => {
  const result = run(project({ known: [] }))
  assert.equal(result.status, 0, result.text)
  assert.match(result.text, /2 passed, 0 failed, 0 skipped, 0 known failures/)
})

test('a failing SDK regression fails the job and is named', () => {
  const result = run(project({ files: { 'tests/a.test.ts': [passLine('first'), failLine('deliberately failing regression')] }, known: [] }))
  assert.equal(result.status, 1)
  assert.match(result.text, /tests\/a\.test\.ts: deliberately failing regression/)
  assert.match(result.text, /not in scripts\/test\/sdk-known-failures\.json/)
})

test('a missing runtime fails the job and names the install command', () => {
  const result = run(project({ known: [], runtime: false }))
  assert.equal(result.status, 1)
  assert.match(result.text, /missing-claude/)
  assert.match(result.text, new RegExp(`npm install --prefix <folder> @anthropic-ai/claude-code@${VERSION}`.replace(/[.]/g, '\\.')))
})

test('a runtime of another version than the pinned one fails the job', () => {
  const result = run(project({ known: [], version: '1.0.0 (Claude Code)' }))
  assert.equal(result.status, 1)
  assert.match(result.text, new RegExp(`pinned ${VERSION}`.replace(/[.]/g, '\\.')))
  assert.match(result.text, /1\.0\.0/)
})

test('a tracked SDK test file that the run did not report fails the job', () => {
  const files = { 'tests/a.test.ts': [passLine('first')] }
  const result = run(project({ files, tracked: ['tests/a.test.ts', 'tests/b.test.tsx'], known: [] }))
  assert.equal(result.status, 1)
  assert.match(result.text, /tests\/b\.test\.tsx/)
  assert.match(result.text, /did not report/)
})

test('a skipped test fails the job', () => {
  const output = report({ 'tests/a.test.ts': [passLine('first')] }).replace('\n\n', '\n(skip) later [0.10ms]\n\n')
  const result = run(project({ known: [], output, status: 0 }))
  assert.equal(result.status, 1)
  assert.match(result.text, /skipped/)
  assert.match(result.text, /later/)
})

test('a run that exits non-zero with no failing test fails the job and shows its output', () => {
  const result = run(project({ known: [], status: 1, output: 'bun: crashed in the middle\n' }))
  assert.equal(result.status, 1)
  assert.match(result.text, /exit(ed)? 1/)
  assert.match(result.text, /bun: crashed in the middle/)
})

test('counts that the run printed and the lines it reported must agree', () => {
  const output = report({ 'tests/a.test.ts': [passLine('first'), passLine('second')] }, 'Ran 5 tests across 1 files. [1.00ms]')
  const result = run(project({ known: [], output, status: 0 }))
  assert.equal(result.status, 1)
  assert.match(result.text, /5 tests/)
})

test('a missing known-failures list fails the job and names the file', () => {
  const result = run(project())
  assert.equal(result.status, 1)
  assert.match(result.text, /scripts\/test\/sdk-known-failures\.json/)
})

test('a malformed known-failures entry fails the job', () => {
  const result = run(project({ known: [{ test: 'tests/a.test.ts: first' }] }))
  assert.equal(result.status, 1)
  assert.match(result.text, /reason/)
})

const known = [{ test: 'tests/a.test.ts: broken', reason: 'tracked in #999' }]
const broken = { 'tests/a.test.ts': [passLine('first'), failLine('broken')] }

test('a listed known failure that still fails keeps the job green and is reported', () => {
  const result = run(project({ files: broken, known }))
  assert.equal(result.status, 0, result.text)
  assert.match(result.text, /1 known failures/)
  assert.match(result.text, /tests\/a\.test\.ts: broken/)
})

test('a new failure beside a listed known failure fails the job', () => {
  const files = { 'tests/a.test.ts': [failLine('broken'), failLine('fresh')] }
  const result = run(project({ files, known }))
  assert.equal(result.status, 1)
  assert.match(result.text, /tests\/a\.test\.ts: fresh/)
})

test('a listed known failure that now passes fails the job and says to remove it', () => {
  const result = run(project({ files: { 'tests/a.test.ts': [passLine('first'), passLine('broken')] }, known }))
  assert.equal(result.status, 1)
  assert.match(result.text, /tests\/a\.test\.ts: broken/)
  assert.match(result.text, /passes now/)
  assert.match(result.text, /Remove it from scripts\/test\/sdk-known-failures\.json/)
})

test('a listed known failure that the run did not report fails the job', () => {
  const result = run(project({ known }))
  assert.equal(result.status, 1)
  assert.match(result.text, /tests\/a\.test\.ts: broken/)
  assert.match(result.text, /did not report/)
})
