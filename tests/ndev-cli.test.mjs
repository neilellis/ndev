import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
  const repair = run(['flow', 'repair', '--help'])
  assert.equal(repair.status, 0, repair.stderr)
  assert.match(repair.stdout, /ndev flow repair --issue <n> --pr <n>/)
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

test('project setup asks the owner for a root North Star when the file is missing', t => {
  const root = realpathSync(worktree(t))
  const path = join(root, 'NORTH_STAR.md')
  const nested = join(root, 'src')
  mkdirSync(nested)
  writeFileSync(join(nested, 'NORTH_STAR.md'), '# Notes for this package\n')

  const before = run(['project', 'status', '--json'], nested)
  assert.equal(before.status, 0, before.stderr)
  const { result: status } = JSON.parse(before.stdout)
  assert.deepEqual(status.northStar, { path, exists: false })
  assert.doesNotMatch(status.text, /ask the project owner/i)
  const setup = run(['project', 'setup', '--no-repo'], nested)
  assert.equal(setup.status, 0, setup.stderr)
  assert.ok(setup.stdout.includes(path))
  assert.match(setup.stdout, /ask the project owner to create/i)
  assert.equal(existsSync(path), false)

  mkdirSync(path)
  const occupied = run(['project', 'setup'], nested)
  assert.equal(occupied.status, 0, occupied.stderr)
  assert.match(occupied.stdout, /ask the project owner to replace it with a regular file/i)
  rmSync(path, { recursive: true })

  const original = '# North Star\n\nKeep decisions traceable to evidence.\n'
  writeFileSync(path, original)
  const after = run(['project', 'setup', '--json'], nested)
  assert.equal(after.status, 0, after.stderr)
  const { result } = JSON.parse(after.stdout)
  assert.deepEqual(result.northStar, { path, exists: true })
  assert.doesNotMatch(result.text, /ask the project owner to create|Keep decisions traceable/)
  assert.equal(readFileSync(path, 'utf8'), original)
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

test('draft push reaches the workflow handler through the public CLI', t => {
  const help = run(['flow', 'push-draft', '--help'])
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /ndev flow push-draft .*--sha .*--review/)
  const command = run(['flow', 'push-draft', '--issue', '79', '--json'], worktree(t))
  assert.equal(command.status, 2, command.stdout)
  const { error } = JSON.parse(command.stdout)
  assert.match(error.message, /issue #79 has no workflow/)
})

test('requirements commands run through ndev requirements', t => {
  const root = worktree(t)
  const help = run(['requirements', '--help'])
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /ndev requirements check\n/)
  assert.match(help.stdout, /ndev requirements retire <path>\.\.\. --pdr <file> \[--keep <file>,<file>\]/)
  const empty = run(['requirements', 'list', '--root', root])
  assert.equal(empty.status, 0, empty.stderr)
  const usage = run(['requirements', 'quote', '--root', root])
  assert.equal(usage.status, 2)
  assert.match(usage.stderr, /^ndev: quote needs <path> <first line> <last line>/)
  const unknown = run(['requirements', 'nonsense'])
  assert.equal(unknown.status, 2)
  assert.match(unknown.stderr, /Unknown requirements command "nonsense"/)
})

test('requirements arguments after -- reach the command unchanged, and --json wraps the output', t => {
  const root = worktree(t)
  writeFileSync(join(root, 'guide.md'), 'One\nTwo\n')
  const ledger = run(['requirements', 'ledger', '--root', root, '--', 'guide.md', '1', '2', '--help'])
  assert.equal(ledger.status, 0, ledger.stderr)
  assert.match(readFileSync(join(root, 'docs/formal/requirements/extra/ledger.md'), 'utf8'), /- guide\.md#L1-L2 [0-9a-f]{12}: --help\n/)
  const json = run(['requirements', 'quote', 'guide.md', '1', '1', '--root', root, '--json'])
  assert.equal(json.status, 0, json.stderr)
  assert.deepEqual(JSON.parse(json.stdout), { ok: true, result: { text: '- guide.md#L1-L1\n\n> One\n' } })
})
