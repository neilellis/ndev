import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { copyFromMain, createFile, ensureProjectFiles, inspectWorkspace, mainCheckout, NdevError } from '../worker/files.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })

/** A real repository with a linked worktree. */
function fixture({ ignoreEnv = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ndev-plugin-'))
  const main = path.join(root, 'main')
  execFileSync('git', ['init', '-q', '-b', 'main', main])
  git(main, 'config', 'user.email', 't@example.com')
  git(main, 'config', 'user.name', 't')
  writeFileSync(path.join(main, 'README.md'), 'x')
  if (ignoreEnv) writeFileSync(path.join(main, '.gitignore'), '.neil-dev.env\n.neil-dev.worktree.json\n')
  git(main, 'add', '-A')
  git(main, 'commit', '-q', '-m', 'init')
  const work = path.join(root, 'work')
  git(main, 'worktree', 'add', '-q', '-b', 'feature', work)
  return { main, work }
}

test('mainCheckout finds the main checkout from a linked worktree and from itself', async () => {
  const { main, work } = fixture()
  assert.equal(await mainCheckout(work), await mainCheckout(main))
  assert.equal(path.basename(await mainCheckout(work)), 'main')
})

test('inspectWorkspace reports present and missing files, and env key names only', async () => {
  const { main } = fixture()
  writeFileSync(path.join(main, '.ndev.json'), JSON.stringify({ mode: 'heavy', steering: 'auto' }))
  writeFileSync(path.join(main, '.neil-dev.env'), '# c\nOPENAI_API_KEY=sk-secret-value\nFOO=bar\n', { mode: 0o600 })
  const result = await inspectWorkspace(main)
  const byName = Object.fromEntries(result.files.map((f) => [f.name, f]))
  assert.equal(byName['.ndev.json'].exists, true)
  assert.equal(byName['.ndev.json'].summary, 'mode heavy · steering auto')
  assert.deepEqual(byName['.neil-dev.env'].keys, ['OPENAI_API_KEY', 'FOO'])
  assert.equal(byName['.neil-dev.env'].ignored, true)
  assert.equal(byName['.neil-dev.worktree.json'].exists, false)
  assert.ok(!JSON.stringify(result).includes('sk-secret-value'), 'a value must never be returned')
})

test('inspectWorkspace reports a bad .ndev.json instead of hiding it', async () => {
  const { main } = fixture()
  writeFileSync(path.join(main, '.ndev.json'), '{ nope')
  const f = (await inspectWorkspace(main)).files.find((x) => x.name === '.ndev.json')
  assert.match(f.problem, /not valid JSON/)
})

test('inspectWorkspace flags an env file that other users can read', async () => {
  const { main } = fixture()
  writeFileSync(path.join(main, '.neil-dev.env'), 'A=1\n', { mode: 0o644 })
  const f = (await inspectWorkspace(main)).files.find((x) => x.name === '.neil-dev.env')
  assert.match(f.problem, /chmod 600 .*\.neil-dev\.env/)
})

test('createFile makes .ndev.json and refuses to overwrite it', async () => {
  const { work } = fixture()
  await createFile(work, '.ndev.json')
  assert.deepEqual(JSON.parse(readFileSync(path.join(work, '.ndev.json'), 'utf8')), { mode: 'light', steering: 'interactive' })
  await assert.rejects(createFile(work, '.ndev.json'), (e) => e instanceof NdevError && e.code === 'exists')
})

test('createFile makes a mode 600 env file only where git ignores it, and names the repair otherwise', async () => {
  const ok = fixture()
  await createFile(ok.work, '.neil-dev.env')
  assert.equal(statSync(path.join(ok.work, '.neil-dev.env')).mode & 0o777, 0o600)
  const bad = fixture({ ignoreEnv: false })
  await assert.rejects(createFile(bad.work, '.neil-dev.env'), (e) => e.code === 'not_ignored' && /echo \.neil-dev\.env >> .*\.gitignore/.test(e.message))
  assert.equal(existsSync(path.join(bad.work, '.neil-dev.env')), false)
})

test('createFile refuses .neil-dev.worktree.json, which the plugin owns', async () => {
  const { work } = fixture()
  await assert.rejects(createFile(work, '.neil-dev.worktree.json'), (e) => e.code === 'not_allowed')
})

test('copyFromMain copies the file, keeps mode 600 on env, and never overwrites', async () => {
  const { main, work } = fixture()
  writeFileSync(path.join(main, '.ndev.json'), '{"mode":"heavy"}')
  writeFileSync(path.join(main, '.neil-dev.env'), 'K=v\n', { mode: 0o600 })
  await copyFromMain(work, '.ndev.json')
  await copyFromMain(work, '.neil-dev.env')
  assert.equal(readFileSync(path.join(work, '.ndev.json'), 'utf8'), '{"mode":"heavy"}')
  assert.equal(statSync(path.join(work, '.neil-dev.env')).mode & 0o777, 0o600)
  await assert.rejects(copyFromMain(work, '.ndev.json'), (e) => e.code === 'exists')
})

test('copyFromMain fails clearly when main lacks the file, or when copying onto main', async () => {
  const { main, work } = fixture()
  const missing = path.join(await mainCheckout(main), '.ndev.json')
  await assert.rejects(copyFromMain(work, '.ndev.json'), (e) => e.code === 'no_source' && e.message.includes(missing))
  writeFileSync(path.join(main, '.ndev.json'), '{}')
  await assert.rejects(copyFromMain(main, '.ndev.json'), (e) => e.code === 'is_main')
})

test('copyFromMain refuses the env file where git does not ignore it', async () => {
  const { main, work } = fixture({ ignoreEnv: false })
  writeFileSync(path.join(main, '.neil-dev.env'), 'K=v\n', { mode: 0o600 })
  await assert.rejects(copyFromMain(work, '.neil-dev.env'), (e) => e.code === 'not_ignored')
})

test('copyFromMain refuses .neil-dev.worktree.json, which belongs to one worktree', async () => {
  const { work } = fixture()
  await assert.rejects(copyFromMain(work, '.neil-dev.worktree.json'), (e) => e.code === 'not_allowed')
})

test('createFile refuses .ndev.json beside a .neil-dev.json and names the migration', async () => {
  const { work } = fixture()
  writeFileSync(path.join(work, '.neil-dev.json'), '{"mode":"heavy"}')
  await assert.rejects(createFile(work, '.ndev.json'), (e) => e.code === 'exists' && e.message.includes(path.join(work, '.neil-dev.json')) && /ndev project migrate-config/.test(e.message))
  assert.equal(existsSync(path.join(work, '.ndev.json')), false)
})

test('copyFromMain takes the main checkout .neil-dev.json when it has no .ndev.json', async () => {
  const { main, work } = fixture()
  writeFileSync(path.join(main, '.neil-dev.json'), '{"mode":"heavy"}')
  await copyFromMain(work, '.ndev.json')
  assert.equal(readFileSync(path.join(work, '.ndev.json'), 'utf8'), '{"mode":"heavy"}')
  assert.equal(existsSync(path.join(work, '.neil-dev.json')), false)
})

test('ensureProjectFiles keeps a worktree .neil-dev.json and copies a main .neil-dev.json to .ndev.json', async () => {
  const kept = fixture()
  writeFileSync(path.join(kept.work, '.neil-dev.json'), '{"mode":"heavy"}')
  await ensureProjectFiles(kept.work)
  assert.equal(existsSync(path.join(kept.work, '.ndev.json')), false)
  const copied = fixture()
  writeFileSync(path.join(copied.main, '.neil-dev.json'), '{"mode":"heavy"}')
  await ensureProjectFiles(copied.work)
  assert.equal(readFileSync(path.join(copied.work, '.ndev.json'), 'utf8'), '{"mode":"heavy"}')
})
