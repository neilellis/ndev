import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const hook = resolve('scripts/ndev/workflow/pre-push-check.sh')
const gitEnvironment = { ...process.env }
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete gitEnvironment[name]

function fixture(t) {
  const repo = mkdtempSync(join(tmpdir(), 'ndev-version-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repo, env: gitEnvironment, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  const put = (path, value) => {
    mkdirSync(join(repo, path, '..'), { recursive: true })
    writeFileSync(join(repo, path), value)
  }
  const version = value => put('.claude-plugin/plugin.json', JSON.stringify({ name: 'sample', version: value }))
  const commit = () => { git('add', '.'); git('commit', '-qm', 'fixture') }
  git('init', '-q')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.com')
  version('1.2.3')
  put('hooks/index.ts', 'original')
  commit()
  const bin = mkdtempSync(join(tmpdir(), 'ndev-version-bin-'))
  t.after(() => rmSync(bin, { recursive: true, force: true }))
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const check = () => spawnSync('bash', [hook], { cwd: repo, env: { ...gitEnvironment, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' })
  return { repo, git, put, version, commit, check }
}

test('pre-push rejects plugin changes without a version bump and names the repair', t => {
  const f = fixture(t)
  f.put('hooks/index.ts', 'changed')
  f.commit()
  const result = f.check()
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /hooks\/index.ts/)
  assert.match(result.stderr, /1\.2\.3/)
  assert.match(result.stderr, /raise the patch version.*1\.2\.4/i)
})

test('pre-push accepts plugin changes committed with a higher version', t => {
  const f = fixture(t)
  f.put('skills/example/SKILL.md', 'changed')
  f.version('1.2.4')
  f.commit()
  assert.equal(f.check().status, 0)
})

test('pre-push rejects another plugin change after a valid bump', t => {
  const f = fixture(t)
  f.version('1.2.4')
  f.commit()
  f.put('scripts/example.sh', 'changed')
  f.commit()
  assert.equal(f.check().status, 1)
})

test('manifest metadata edits do not count as a version bump', t => {
  const f = fixture(t)
  f.put('.claude-plugin/plugin.json', JSON.stringify({ name: 'renamed', version: '1.2.3' }))
  f.commit()
  assert.equal(f.check().status, 1)
})

test('development-only changes and repeated checks need no plugin bump', t => {
  const f = fixture(t)
  f.put('tests/example.test.mjs', 'test')
  f.put('docs/example.md', 'docs')
  f.commit()
  assert.equal(f.check().status, 0)
  assert.equal(f.check().status, 0)
})

test('pre-push rejects a lower or malformed plugin version', t => {
  const f = fixture(t)
  for (const value of ['1.2.2', 'invalid']) {
    f.version(value)
    f.commit()
    const result = f.check()
    assert.equal(result.status, 1)
    assert.match(result.stderr, /version/i)
  }
})

test('pre-push rejects deleted plugin assets without a bump', t => {
  const f = fixture(t)
  f.git('rm', 'hooks/index.ts')
  f.commit()
  const result = f.check()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /hooks\/index.ts/)
})

test('pre-push refuses shallow history with its repair command', t => {
  const f = fixture(t)
  f.put('tests/example.test.mjs', 'test')
  f.commit()
  const head = f.git('rev-parse', 'HEAD')
  f.put('.git/shallow', `${head}\n`)
  const result = f.check()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /git fetch --unshallow/)
})

test('pre-push reports the failed manifest identifier and Git output', t => {
  const f = fixture(t)
  f.git('rm', '.claude-plugin/plugin.json')
  f.commit()
  const result = f.check()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /HEAD:\.claude-plugin\/plugin.json/)
  assert.match(result.stderr, /exited 128.*fatal:/s)
})
