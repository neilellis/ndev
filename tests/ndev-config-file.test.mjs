import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const executable = join(repoRoot, 'bin/ndev')

function run(args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8' })
  assert.ifError(result.error)
  return result
}

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

function project(t, files = {}, { commit = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ndev-config-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  git(root, 'init', '-q')
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text)
  if (commit) {
    git(root, 'add', '-A')
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'config')
  }
  return root
}

const json = result => JSON.parse(result.stdout)

test('a project with only .neil-dev.json is read', t => {
  const root = project(t, { '.neil-dev.json': '{"mode":"heavy"}\n' })
  const result = run(['project', 'status', '--json'], root)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(json(result).result.mode, 'heavy')
})

test('a project with only .ndev.json is read', t => {
  const root = project(t, { '.ndev.json': '{"mode":"heavy"}\n' })
  const result = run(['project', 'status', '--json'], root)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(json(result).result.mode, 'heavy')
})

test('both files with the same settings are read', t => {
  const root = project(t, { '.ndev.json': '{"mode":"heavy","steering":"auto"}\n', '.neil-dev.json': '{ "steering": "auto", "mode": "heavy" }' })
  const result = run(['project', 'status', '--json'], root)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(json(result).result.mode, 'heavy')
})

test('both files with different settings fail, naming both and the migration', t => {
  const root = project(t, { '.ndev.json': '{"mode":"heavy"}\n', '.neil-dev.json': '{"mode":"light"}\n' })
  const result = run(['project', 'status', '--json'], root)
  assert.equal(result.status, 1, result.stderr || result.stdout)
  const { error } = json(result)
  assert.ok(error.message.includes(join(root, '.ndev.json')), error.message)
  assert.ok(error.message.includes(join(root, '.neil-dev.json')), error.message)
  assert.match(error.repair, /ndev project migrate-config/)
})

test('a write moves an untracked .neil-dev.json to .ndev.json', t => {
  const root = project(t, { '.neil-dev.json': '{"branding":{"name":"Example","site":"https://example.com"}}\n' })
  const result = run(['project', 'mode', 'heavy', '--json'], root)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(existsSync(join(root, '.neil-dev.json')), false)
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.ndev.json'), 'utf8')), {
    branding: { name: 'Example', site: 'https://example.com' }, mode: 'heavy',
  })
})

test('a write moves a tracked .neil-dev.json with git, so git sees a rename', t => {
  const root = project(t, { '.neil-dev.json': '{"mode":"light","steering":"interactive","github":{"repo":"acme/app","board":null}}\n' }, { commit: true })
  const result = run(['project', 'mode', 'heavy', '--json'], root)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(existsSync(join(root, '.neil-dev.json')), false)
  assert.match(git(root, 'status', '--porcelain'), /^RM? \.neil-dev\.json -> \.ndev\.json/m)
  assert.equal(JSON.parse(readFileSync(join(root, '.ndev.json'), 'utf8')).mode, 'heavy')
})

test('a write with both files the same leaves only .ndev.json', t => {
  const root = project(t, { '.ndev.json': '{"mode":"light"}\n', '.neil-dev.json': '{"mode":"light"}\n' }, { commit: true })
  const result = run(['project', 'mode', 'heavy', '--json'], root)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(existsSync(join(root, '.neil-dev.json')), false)
  assert.match(git(root, 'status', '--porcelain'), /^D  \.neil-dev\.json$/m)
})

test('project setup writes .ndev.json in a project with no config', t => {
  const root = project(t)
  const result = run(['project', 'setup', '--repo', 'owner/example', '--no-board', '--json'], root)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(existsSync(join(root, '.neil-dev.json')), false)
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.ndev.json'), 'utf8')).github, { repo: 'owner/example', board: null })
})

test('migrate-config moves the file once and then reports nothing to do', t => {
  const original = '{"mode":"heavy"}\n'
  const root = project(t, { '.neil-dev.json': original }, { commit: true })
  const first = run(['project', 'migrate-config', '--json'], root)
  assert.equal(first.status, 0, first.stderr || first.stdout)
  assert.deepEqual(json(first).result, { from: join(root, '.neil-dev.json'), to: join(root, '.ndev.json'), moved: true, text: `Moved ${join(root, '.neil-dev.json')} to ${join(root, '.ndev.json')}. Commit the rename.` })
  assert.equal(readFileSync(join(root, '.ndev.json'), 'utf8'), original)
  const second = run(['project', 'migrate-config', '--json'], root)
  assert.equal(second.status, 0, second.stderr || second.stdout)
  assert.equal(json(second).result.moved, false)
})

test('migrate-config refuses two files that differ and changes neither', t => {
  const root = project(t, { '.ndev.json': '{"mode":"heavy"}\n', '.neil-dev.json': '{"mode":"light"}\n' })
  const result = run(['project', 'migrate-config', '--json'], root)
  assert.equal(result.status, 1, result.stderr || result.stdout)
  assert.equal(readFileSync(join(root, '.ndev.json'), 'utf8'), '{"mode":"heavy"}\n')
  assert.equal(readFileSync(join(root, '.neil-dev.json'), 'utf8'), '{"mode":"light"}\n')
})

function sourceProjectConfig(root) {
  const script = join(repoRoot, 'scripts/github/project-config.sh')
  return spawnSync('bash', ['-c', `cd "$1" && . "$2" && printf '%s|%s|%s' "$GH_REPO" "$GH_PROJECT_OWNER" "$GH_PROJECT_NUMBER"`, '_', root, script], {
    encoding: 'utf8', env: { ...process.env, GH_REPO: '', GH_PROJECT_OWNER: '', GH_PROJECT_NUMBER: '' },
  })
}

test('the shell helpers read the github key of .ndev.json, then of .neil-dev.json', t => {
  const board = '{"github":{"repo":"acme/new","board":{"owner":"acme","number":3}}}'
  const current = sourceProjectConfig(project(t, { '.ndev.json': board }))
  assert.equal(current.status, 0, current.stderr)
  assert.equal(current.stdout, 'acme/new|acme|3')
  const legacy = sourceProjectConfig(project(t, { '.neil-dev.json': '{"github":{"repo":"acme/old"}}' }))
  assert.equal(legacy.status, 0, legacy.stderr)
  assert.equal(legacy.stdout, 'acme/old||')
})

test('the shell helpers stop on two config files that differ', t => {
  const root = project(t, { '.ndev.json': '{"github":{"repo":"acme/new"}}', '.neil-dev.json': '{"github":{"repo":"acme/old"}}' })
  const result = sourceProjectConfig(root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /\.ndev\.json/)
  assert.match(result.stderr, /\.neil-dev\.json/)
  assert.match(result.stderr, /ndev project migrate-config/)
})

const RESOLVERS = new Set(['hooks/workflow/config-file.ts', 'scripts/ndev/config-file.mjs', 'scripts/github/project-config.sh', 'orca-plugin/ndev/worker/files.mjs', 'scripts/work/ndev_files.mjs'])

test('only the config resolvers name .neil-dev.json in code', () => {
  const listed = spawnSync('git', ['-C', repoRoot, 'grep', '-l', '-F', '.neil-dev.json', '--', 'hooks', 'scripts', 'orca-plugin', 'skills/*/scripts', 'bin'], { encoding: 'utf8' })
  assert.ok(listed.status === 0 || listed.status === 1, listed.stderr)
  const code = listed.stdout.split('\n').filter(Boolean)
    .filter(path => !/(^|\/)(tests?|__tests__)\//.test(path) && !/\.test\.[cm]?[jt]sx?$/.test(path) && !path.endsWith('.md'))
    .filter(path => !path.startsWith('orca-plugin/ndev/panel/'))
    .filter(path => !RESOLVERS.has(path))
  assert.deepEqual(code, [], `these files name .neil-dev.json outside the config resolvers; read the config through hooks/config.ts or scripts/ndev/config-file.mjs: ${code.join(', ')}`)
})
