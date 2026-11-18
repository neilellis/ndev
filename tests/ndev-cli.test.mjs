import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const executable = fileURLToPath(new URL('../bin/ndev', import.meta.url))

function run(args, cwd = tmpdir()) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8' })
  assert.ifError(result.error)
  return result
}

function worktree(t) {
  const root = mkdtempSync(join(tmpdir(), 'ndev-cli-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const init = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  return root
}

test('help and version work outside a Git repository', () => {
  const help = run(['--help'])
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /ndev <group> <command>/)
  assert.match(help.stdout, /\binstall\b/)
  const command = run(['flow', 'checkpoint', '--help'])
  assert.equal(command.status, 0, command.stderr)
  assert.match(command.stdout, /ndev flow checkpoint .*--file/)
  const version = run(['--version', '--json'])
  assert.equal(version.status, 0, version.stderr)
  assert.deepEqual(JSON.parse(version.stdout), { ok: true, result: { version: '2.0.0' } })
})

test('an unknown command returns one JSON error with the repair', () => {
  const result = run(['--json', 'flow', 'made-up'])
  assert.equal(result.status, 2)
  assert.equal(result.stderr, '')
  const { ok, error } = JSON.parse(result.stdout)
  assert.equal(ok, false)
  assert.match(error.message, /made-up/)
  assert.equal(error.repair, 'ndev flow --help')
})

test('project setup preserves existing settings and returns persisted values', t => {
  const root = worktree(t)
  const path = join(root, '.neil-dev.json')
  writeFileSync(path, '{"branding":{"name":"Example","site":"https://example.com"}}\n')
  const result = run(['project', 'setup', '--repo', 'owner/example', '--no-board', '--json'], root)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const { result: settings } = JSON.parse(result.stdout)
  assert.deepEqual(settings.github, { repo: 'owner/example', board: null })
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    branding: { name: 'Example', site: 'https://example.com' }, github: { repo: 'owner/example', board: null },
  })
})

test('setting auto in hack mode fails before saving the configuration', t => {
  const root = worktree(t)
  const path = join(root, '.neil-dev.json')
  const original = '{"mode":"hack","steering":"interactive"}\n'
  writeFileSync(path, original)
  const result = run(['project', 'steering', 'auto', '--json'], root)
  assert.equal(result.status, 1, result.stderr || result.stdout)
  assert.match(JSON.parse(result.stdout).error.message, /hack mode.*interactive/i)
  assert.equal(readFileSync(path, 'utf8'), original)
})

test('guidance returns project files and the bundled catalogue for a library choice', t => {
  const root = worktree(t)
  writeFileSync(join(root, 'package.json'), '{"dependencies":{"existing-example":"1.2.3"}}')
  const result = run(['project', 'guidance', 'library', 'Parse a request body', '--json'], root)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const guidance = JSON.parse(result.stdout).result
  assert.equal(guidance.kind, 'library')
  assert.equal(guidance.description, 'Parse a request body')
  assert.ok(guidance.sources.some(source => source.endsWith('kb/libraries.md')))
  assert.ok(guidance.sources.some(source => source.endsWith('package.json')))
})
