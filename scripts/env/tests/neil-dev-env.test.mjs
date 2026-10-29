// Tests for neil-dev-env.mjs against real git repositories in a temporary folder.
// Run: node --test scripts/env/tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'neil-dev-env.mjs')
const ZSHRC = [
  '# shell set-up',
  'export OPENROUTER_API_KEY=sk-or-abc123',
  "OPENAI_API_KEY='sk-oa-xyz789'",
  'export UNSPLASH_ACCESS_KEY="$(security find-generic-password -w -s unsplash)"',
  'export OTHER_TOKEN=not-asked-for',
  '',
].join('\n')
const SECRETS = ['sk-or-abc123', 'sk-oa-xyz789', 'not-asked-for']

const sh = (cwd, ...argv) => {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, `${argv.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

// A main checkout that ignores .neil-dev.env (unless ignored: false), one worktree, and a ~/.zshrc.
function project({ ignored = true, zshrc = ZSHRC } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'neil-dev-env-')))
  const main = join(base, 'main')
  const home = join(base, 'home')
  sh(base, 'mkdir', '-p', main, home)
  sh(main, 'git', 'init', '-q', '-b', 'main')
  writeFileSync(join(main, '.gitignore'), ignored ? '.neil-dev.env\n' : 'node_modules/\n')
  sh(main, 'git', 'add', '.gitignore')
  sh(main, 'git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init')
  const worktree = join(base, 'wt')
  sh(main, 'git', 'worktree', 'add', '-q', '-b', 'task', worktree)
  if (zshrc !== null) writeFileSync(join(home, '.zshrc'), zshrc)
  return { base, main, worktree, home }
}

const run = (p, cwd, ...args) => {
  const r = spawnSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8', env: { ...process.env, HOME: p.home, OPENROUTER_API_KEY: '', OPEN_ROUTER_API_KEY: '', OPENAI_API_KEY: '' } })
  const out = `${r.stdout}${r.stderr}`
  for (const s of SECRETS) assert.ok(!out.includes(s), `the output shows a secret value: ${out}`)
  return { status: r.status, out, stdout: r.stdout }
}

const values = file => Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter(l => /^[A-Z]/.test(l)).map(l => l.split(/=(.*)/s).slice(0, 2)))

test('init in a worktree writes the main checkout file from ~/.zshrc and copies it here', () => {
  const p = project()
  const r = run(p, p.worktree, 'init')
  assert.equal(r.status, 0, r.out)
  const file = join(p.main, '.neil-dev.env')
  assert.deepEqual(values(file), { OPENROUTER_API_KEY: 'sk-or-abc123', OPENAI_API_KEY: 'sk-oa-xyz789' })
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(readFileSync(join(p.worktree, '.neil-dev.env'), 'utf8'), readFileSync(file, 'utf8'))
  assert.equal(statSync(join(p.worktree, '.neil-dev.env')).mode & 0o777, 0o600)
  assert.match(r.out, /OPENROUTER_API_KEY/)
  assert.match(r.out, /UNSPLASH_ACCESS_KEY.*not a plain value/)
  assert.match(r.out, /VERCEL_AUTOMATION_BYPASS_SECRET/)
  assert.ok(!readFileSync(file, 'utf8').includes('OTHER_TOKEN'), 'init copied a key that no ndev skill reads')
})

test('init takes an extra key when asked with --key', () => {
  const p = project()
  assert.equal(run(p, p.main, 'init', '--key', 'OTHER_TOKEN').status, 0)
  assert.equal(values(join(p.main, '.neil-dev.env')).OTHER_TOKEN, 'not-asked-for')
})

test('init keeps a value already in the file', () => {
  const p = project()
  writeFileSync(join(p.main, '.neil-dev.env'), 'OPENAI_API_KEY=kept-value\n', { mode: 0o600 })
  assert.equal(run(p, p.main, 'init').status, 0)
  const v = values(join(p.main, '.neil-dev.env'))
  assert.equal(v.OPENAI_API_KEY, 'kept-value')
  assert.equal(v.OPENROUTER_API_KEY, 'sk-or-abc123')
})

test('init refuses when git does not ignore the file, and names the repair', () => {
  const p = project({ ignored: false })
  const r = run(p, p.worktree, 'init')
  assert.equal(r.status, 1)
  assert.match(r.out, /not git-ignored/)
  assert.match(r.out, /info\/exclude/)
  assert.ok(!existsSync(join(p.main, '.neil-dev.env')))
})

test('init without a ~/.zshrc still creates the file and lists every key as missing', () => {
  const p = project({ zshrc: null })
  const r = run(p, p.main, 'init')
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /missing: OPENROUTER_API_KEY/)
  assert.deepEqual(values(join(p.main, '.neil-dev.env')), {})
})

test('check in a new worktree copies the main checkout file and passes', () => {
  const p = project()
  writeFileSync(join(p.main, '.neil-dev.env'), 'OPENAI_API_KEY=sk-oa-xyz789\n', { mode: 0o600 })
  const r = run(p, p.worktree, 'check', 'OPENAI_API_KEY')
  assert.equal(r.status, 0, r.out)
  assert.equal(readFileSync(join(p.worktree, '.neil-dev.env'), 'utf8'), 'OPENAI_API_KEY=sk-oa-xyz789\n')
  assert.equal(statSync(join(p.worktree, '.neil-dev.env')).mode & 0o777, 0o600)
})

test('check names a missing key, the file and the repair', () => {
  const p = project()
  writeFileSync(join(p.main, '.neil-dev.env'), 'OPENAI_API_KEY=sk-oa-xyz789\n', { mode: 0o600 })
  const r = run(p, p.main, 'check', 'OPENAI_API_KEY', 'UNSPLASH_ACCESS_KEY')
  assert.equal(r.status, 1)
  assert.match(r.out, /UNSPLASH_ACCESS_KEY/)
  assert.ok(!/missing.*OPENAI_API_KEY/.test(r.out))
  assert.match(r.out, new RegExp(join(p.main, '.neil-dev.env').replace(/[.]/g, '\\.')))
  assert.match(r.out, /init/)
})

test('check accepts the alias of a key', () => {
  const p = project()
  writeFileSync(join(p.main, '.neil-dev.env'), 'OPEN_ROUTER_API_KEY=sk-or-abc123\n', { mode: 0o600 })
  assert.equal(run(p, p.main, 'check', 'OPENROUTER_API_KEY').status, 0)
})

test('check with no file anywhere fails and names init', () => {
  const p = project()
  const r = run(p, p.worktree, 'check', 'OPENAI_API_KEY')
  assert.equal(r.status, 1)
  assert.match(r.out, /no \.neil-dev\.env/)
  assert.match(r.out, /neil-dev-env\.mjs init/)
})

test('run gives the command the file values, alias included, and returns its exit status', () => {
  const p = project()
  writeFileSync(join(p.main, '.neil-dev.env'), '# keys\nOPEN_ROUTER_API_KEY=sk-or-abc123\nOPENAI_API_KEY="sk-oa-xyz789"\n', { mode: 0o600 })
  const probe = "process.exit(process.env.OPENROUTER_API_KEY === 'sk-or-abc123' && process.env.OPENAI_API_KEY === 'sk-oa-xyz789' ? 7 : 3)"
  const r = run(p, p.main, 'run', '--need', 'OPENROUTER_API_KEY,OPENAI_API_KEY', '--', 'node', '-e', probe)
  assert.equal(r.status, 7, r.out)
})

test('run refuses before starting the command when a needed key is missing', () => {
  const p = project()
  writeFileSync(join(p.main, '.neil-dev.env'), 'OPENAI_API_KEY=sk-oa-xyz789\n', { mode: 0o600 })
  const marker = join(p.base, 'ran')
  const r = run(p, p.main, 'run', '--need', 'UNSPLASH_ACCESS_KEY', '--', 'touch', marker)
  assert.equal(r.status, 1)
  assert.match(r.out, /UNSPLASH_ACCESS_KEY/)
  assert.ok(!existsSync(marker))
})

test('a malformed line is refused with its line number', () => {
  const p = project()
  writeFileSync(join(p.main, '.neil-dev.env'), 'OPENAI_API_KEY=sk-oa-xyz789\nthis is wrong\n', { mode: 0o600 })
  const r = run(p, p.main, 'check', 'OPENAI_API_KEY')
  assert.equal(r.status, 1)
  assert.match(r.out, /line 2/)
})

test('status --json lists key names only', () => {
  const p = project()
  writeFileSync(join(p.main, '.neil-dev.env'), 'OPENAI_API_KEY=sk-oa-xyz789\n', { mode: 0o600 })
  const r = run(p, p.worktree, 'status', '--json')
  assert.equal(r.status, 0, r.out)
  const s = JSON.parse(r.stdout)
  assert.equal(s.file, join(p.worktree, '.neil-dev.env'))
  assert.equal(s.copiedFrom, join(p.main, '.neil-dev.env'))
  assert.equal(s.ignored, true)
  assert.deepEqual(s.keys, ['OPENAI_API_KEY'])
  assert.ok(s.missing.includes('OPENROUTER_API_KEY'))
})

test('status --json with no file anywhere says so', () => {
  const p = project()
  const s = JSON.parse(run(p, p.worktree, 'status', '--json').stdout)
  assert.equal(s.file, null)
  assert.equal(s.main, p.main)
})

test('init in a worktree keeps a key added to the worktree copy, in the main checkout file too', () => {
  const p = project()
  assert.equal(run(p, p.main, 'init').status, 0)
  assert.equal(run(p, p.worktree, 'status').status, 0)
  writeFileSync(join(p.worktree, '.neil-dev.env'), `${readFileSync(join(p.worktree, '.neil-dev.env'), 'utf8')}PROJECT_KEY=keepme\n`)
  const r = run(p, p.worktree, 'init')
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /PROJECT_KEY/)
  assert.equal(values(join(p.main, '.neil-dev.env')).PROJECT_KEY, 'keepme')
  assert.equal(values(join(p.worktree, '.neil-dev.env')).PROJECT_KEY, 'keepme')
})

test('init in a worktree refuses when a key differs between the worktree copy and the main checkout file', () => {
  const p = project()
  writeFileSync(join(p.main, '.neil-dev.env'), 'OPENAI_API_KEY=sk-oa-xyz789\n', { mode: 0o600 })
  writeFileSync(join(p.worktree, '.neil-dev.env'), 'OPENAI_API_KEY=other-value\n', { mode: 0o600 })
  const r = run(p, p.worktree, 'init')
  assert.equal(r.status, 1, r.out)
  assert.match(r.out, /OPENAI_API_KEY/)
  assert.ok(!r.out.includes('other-value'))
  assert.equal(values(join(p.worktree, '.neil-dev.env')).OPENAI_API_KEY, 'other-value')
})

test('a file that other users can read is refused, and the repair is chmod 600', () => {
  const p = project()
  writeFileSync(join(p.main, '.neil-dev.env'), 'OPENAI_API_KEY=sk-oa-xyz789\n', { mode: 0o644 })
  const r = run(p, p.main, 'status', '--json')
  assert.equal(r.status, 1, r.out)
  assert.match(r.out, /chmod 600/)
})

test('init reads only plain values: a shell operator, a quote in the value or a one-command prefix is not a value', () => {
  const p = project({
    zshrc: [
      'export OPENROUTER_API_KEY=sk-or-abc123;',
      'export OPENAI_API_KEY=sk-oa-xyz789',
      'OPENAI_API_KEY=dummy npm test',
      `export UNSPLASH_ACCESS_KEY="un'quote"`,
      '',
    ].join('\n'),
  })
  const r = run(p, p.main, 'init')
  assert.equal(r.status, 0, r.out)
  const v = values(join(p.main, '.neil-dev.env'))
  assert.equal(v.OPENROUTER_API_KEY, undefined)
  assert.equal(v.OPENAI_API_KEY, 'sk-oa-xyz789')
  assert.equal(v.UNSPLASH_ACCESS_KEY, undefined)
  assert.match(r.out, /OPENROUTER_API_KEY.*not a plain value/)
  assert.match(r.out, /UNSPLASH_ACCESS_KEY.*not a plain value/)
})

test('import merges another KEY=VALUE file into the main checkout file and the worktree copy, without printing a value', () => {
  const p = project()
  assert.equal(run(p, p.main, 'init').status, 0)
  const old = join(p.base, 'walk.env')
  writeFileSync(old, '# walk values\nDOWNLOAD_USER=not-asked-for\nOPENAI_API_KEY=sk-oa-xyz789\n', { mode: 0o644 })
  const r = run(p, p.worktree, 'import', old)
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /added: DOWNLOAD_USER/)
  assert.match(r.out, /already set to the same value: OPENAI_API_KEY/)
  for (const file of [join(p.main, '.neil-dev.env'), join(p.worktree, '.neil-dev.env')]) {
    assert.equal(values(file).DOWNLOAD_USER, 'not-asked-for')
    assert.equal(values(file).OPENAI_API_KEY, 'sk-oa-xyz789')
    assert.equal(statSync(file).mode & 0o777, 0o600)
  }
  assert.ok(existsSync(old), 'import removed the file it read')
})

test('import refuses a key whose value differs, names the key, and writes nothing', () => {
  const p = project()
  assert.equal(run(p, p.main, 'init').status, 0)
  const before = readFileSync(join(p.main, '.neil-dev.env'), 'utf8')
  const old = join(p.base, 'walk.env')
  writeFileSync(old, 'DOWNLOAD_USER=not-asked-for\nOPENAI_API_KEY=other-value\n')
  const r = run(p, p.main, 'import', old)
  assert.equal(r.status, 1, r.out)
  assert.match(r.out, /OPENAI_API_KEY/)
  assert.ok(!r.out.includes('other-value'))
  assert.equal(readFileSync(join(p.main, '.neil-dev.env'), 'utf8'), before)
})

test('import of a file that does not exist names it and exits 1', () => {
  const p = project()
  const r = run(p, p.main, 'import', join(p.base, 'absent.env'))
  assert.equal(r.status, 1, r.out)
  assert.match(r.out, /absent\.env/)
})
