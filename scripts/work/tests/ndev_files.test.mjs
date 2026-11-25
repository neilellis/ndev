// Tests for ndev-files.sh against real git repositories in a temporary folder.
// Run: node --test scripts/work/tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = process.env.NDEV_FILES_SCRIPT ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'ndev-files.sh')

const sh = (cwd, ...argv) => {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, `${argv.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const run = (cwd, ...args) => {
  const r = spawnSync('bash', [SCRIPT, ...args], { cwd, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout, stderr: r.stderr }
}

// A main checkout and two linked worktrees. `ignore` lists the names its .gitignore holds.
function project({ ignore = ['.neil-dev.env', '.neil-dev.worktree.json'] } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ndev-files-')))
  const main = join(base, 'main')
  mkdirSync(main)
  sh(main, 'git', 'init', '-q', '-b', 'main')
  writeFileSync(join(main, '.gitignore'), ignore.map(n => `${n}\n`).join('') || 'node_modules/\n')
  sh(main, 'git', 'add', '.gitignore')
  sh(main, 'git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init')
  const one = join(base, 'one')
  const two = join(base, 'two')
  sh(main, 'git', 'worktree', 'add', '-q', '-b', 'one', one)
  sh(main, 'git', 'worktree', 'add', '-q', '-b', 'two', two)
  return { base, main, one, two }
}

const listing = (p, ...extra) => {
  const r = run(p.main, 'list', '--json', ...extra)
  assert.equal(r.status, 0, r.out)
  return JSON.parse(r.stdout)
}
const fileOf = (w, name) => w.files.find(f => f.name === name)

test('list --json names every worktree, the main checkout first, with its branch', () => {
  const p = project()
  const out = listing(p)
  assert.deepEqual(out.worktrees.map(w => [w.path, w.branch, w.isMain]), [
    [p.main, 'main', true], [p.one, 'one', false], [p.two, 'two', false],
  ])
})

test('list --json reports each known ndev file as present or missing, and every other .neil-dev* file', () => {
  const p = project()
  writeFileSync(join(p.main, '.neil-dev.json'), '{}')
  writeFileSync(join(p.main, '.neil-dev.env'), 'SECRET_KEY=hunter2\n')
  writeFileSync(join(p.one, '.neil-dev.worktree.json'), '{}')
  writeFileSync(join(p.one, '.neil-dev.local'), 'x')
  const out = listing(p)
  const [main, one, two] = out.worktrees
  assert.deepEqual(['.neil-dev.json', '.neil-dev.env', '.neil-dev.worktree.json'].map(n => fileOf(main, n).present), [true, true, false])
  assert.equal(fileOf(one, '.neil-dev.worktree.json').present, true)
  assert.equal(fileOf(one, '.neil-dev.local').present, true)
  assert.equal(fileOf(one, '.neil-dev.local').isKnown, false)
  assert.equal(fileOf(two, '.neil-dev.json').present, false)
  assert.equal(fileOf(two, '.neil-dev.local'), undefined, 'a file nobody has is listed')
})

test('list --json says whether git ignores each name, and never prints a value of the env file', () => {
  const p = project()
  writeFileSync(join(p.main, '.neil-dev.env'), 'SECRET_KEY=hunter2\n')
  const r = run(p.main, 'list', '--json')
  assert.doesNotMatch(r.out, /hunter2|SECRET_KEY/)
  const env = fileOf(JSON.parse(r.stdout).worktrees[0], '.neil-dev.env')
  assert.equal(env.isIgnored, true)
  assert.equal(fileOf(JSON.parse(r.stdout).worktrees[0], '.neil-dev.json').isIgnored, false)
})

test('list --json works from a linked worktree, and fails with the repair outside a repository', () => {
  const p = project()
  const fromWorktree = run(p.one, 'list', '--json')
  assert.equal(fromWorktree.status, 0, fromWorktree.out)
  assert.equal(JSON.parse(fromWorktree.stdout).worktrees.length, 3)
  const outside = run(p.base, 'list', '--json')
  assert.equal(outside.status, 2, outside.out)
  assert.match(outside.out, /not in a git repository/)
})

test('create writes a valid .neil-dev.json that the plugin accepts, and refuses to overwrite one', () => {
  const p = project()
  const r = run(p.main, 'create', '--file', '.neil-dev.json', '--worktree', p.one)
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(JSON.parse(readFileSync(join(p.one, '.neil-dev.json'), 'utf8')), { mode: 'light', steering: 'interactive' })
  const again = run(p.main, 'create', '--file', '.neil-dev.json', '--worktree', p.one)
  assert.equal(again.status, 3, again.out)
  assert.match(again.out, /already exists/)
})

test('create makes an empty .neil-dev.env with mode 600 where git ignores it, and refuses where it does not', () => {
  const p = project()
  const r = run(p.main, 'create', '--file', '.neil-dev.env', '--worktree', p.one)
  assert.equal(r.status, 0, r.out)
  assert.equal(statSync(join(p.one, '.neil-dev.env')).mode & 0o777, 0o600)
  const q = project({ ignore: [] })
  const refused = run(q.main, 'create', '--file', '.neil-dev.env', '--worktree', q.one)
  assert.equal(refused.status, 3, refused.out)
  assert.match(refused.out, /not git-ignored/)
  assert.match(refused.out, /\.gitignore/)
  assert.equal(existsSync(join(q.one, '.neil-dev.env')), false)
})

test('copy takes the file from the main checkout, keeps the env file private, and refuses to overwrite', () => {
  const p = project()
  writeFileSync(join(p.main, '.neil-dev.json'), '{"mode":"heavy"}')
  writeFileSync(join(p.main, '.neil-dev.env'), 'KEY=v\n')
  chmodSync(join(p.main, '.neil-dev.env'), 0o600)
  assert.equal(run(p.main, 'copy', '--file', '.neil-dev.json', '--worktree', p.one).status, 0)
  assert.equal(readFileSync(join(p.one, '.neil-dev.json'), 'utf8'), '{"mode":"heavy"}')
  assert.equal(run(p.main, 'copy', '--file', '.neil-dev.env', '--worktree', p.one).status, 0)
  assert.equal(readFileSync(join(p.one, '.neil-dev.env'), 'utf8'), 'KEY=v\n')
  assert.equal(statSync(join(p.one, '.neil-dev.env')).mode & 0o777, 0o600)
  const again = run(p.main, 'copy', '--file', '.neil-dev.json', '--worktree', p.one)
  assert.equal(again.status, 3, again.out)
  assert.match(again.out, /already exists/)
  assert.equal(readFileSync(join(p.one, '.neil-dev.json'), 'utf8'), '{"mode":"heavy"}')
})

test('copy refuses a missing source, an env file where git does not ignore it, the main checkout and other names', () => {
  const p = project()
  const missing = run(p.main, 'copy', '--file', '.neil-dev.json', '--worktree', p.one)
  assert.equal(missing.status, 3, missing.out)
  assert.match(missing.out, /main checkout has no \.neil-dev\.json/)
  const q = project({ ignore: [] })
  writeFileSync(join(q.main, '.neil-dev.env'), 'KEY=v\n')
  const open = run(q.main, 'copy', '--file', '.neil-dev.env', '--worktree', q.one)
  assert.equal(open.status, 3, open.out)
  assert.match(open.out, /not git-ignored/)
  assert.equal(existsSync(join(q.one, '.neil-dev.env')), false)
  const self = run(p.main, 'copy', '--file', '.neil-dev.json', '--worktree', p.main)
  assert.equal(self.status, 3, self.out)
  assert.match(self.out, /main checkout/)
  for (const name of ['.neil-dev.worktree.json', '.neil-dev.local', '../x']) {
    const r = run(p.main, 'copy', '--file', name, '--worktree', p.one)
    assert.equal(r.status, 2, `${name}: ${r.out}`)
    assert.match(r.out, /--file must be/)
  }
})

test('copy and create refuse a folder that is not a worktree of this repository', () => {
  const p = project()
  const r = run(p.main, 'create', '--file', '.neil-dev.json', '--worktree', p.base)
  assert.equal(r.status, 2, r.out)
  assert.match(r.out, /not a worktree of/)
})

test('list --json keeps listing when a worktree lost its .git or its folder, and names the repair for that one', () => {
  const p = project()
  rmSync(join(p.one, '.git'))
  rmSync(p.two, { recursive: true })
  const out = listing(p)
  const [main, one, two] = out.worktrees
  assert.equal(main.problem, undefined)
  assert.ok(main.files.length > 0)
  for (const w of [one, two]) {
    assert.deepEqual(w.files, [])
    assert.match(w.problem, new RegExp(`${w.path.replace(/\//g, '\\/')}`))
    assert.match(w.problem, new RegExp(`Repair: git -C ${p.main.replace(/\//g, '\\/')} worktree prune`))
  }
  assert.match(one.problem, /check-ignore/)
  assert.match(two.problem, /does not exist/)
})
