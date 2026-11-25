// The Python sweep through its command line, in a real git repository. uv is a stub, because it is
// an external tool. The stub does what `uv run --with deadcode deadcode` does: one line per finding
// and exit 1 when it finds dead code, "Well done!" and exit 0 when it finds none.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SWEEP = join(dirname(fileURLToPath(import.meta.url)), '..', 'sweep.sh')

// Reports every function in pkg/dead*.py as unused, the way deadcode does.
const FAKE_UV = `#!/bin/sh
found=0
for f in pkg/dead*.py; do
  [ -f "$f" ] || continue
  name=$(sed -n 's/^def \\([a-z_0-9]*\\).*/\\1/p' "$f")
  echo "$f:1:0: DC02 Function \\\`$name\\\` is never used"
  found=1
done
if [ "$found" -eq 0 ]; then echo 'Well done!'; exit 0; fi
exit 1
`

const write = (file, text, mode) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  if (mode) chmodSync(file, mode)
}

const fixture = (t, { baseDead = true, headDead = false, uv = FAKE_UV } = {}) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sweep-py-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo, encoding: 'utf8' })
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  }
  write(join(root, 'bin', 'uv'), uv, 0o755)
  write(join(repo, 'pkg', 'live.py'), 'def live():\n    return 1\n\nlive()\n')
  if (baseDead) write(join(repo, 'pkg', 'dead_old.py'), 'def old_unused():\n    return 1\n')
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-qm', 'base')
  git('branch', 'base')
  write(join(repo, 'pkg', 'live.py'), 'def live():\n    return 2\n\nlive()\n')
  if (headDead) write(join(repo, 'pkg', 'dead_new.py'), 'def new_unused():\n    return 1\n')
  git('add', '-A')
  git('commit', '-qm', 'head')
  return { repo, bin: join(root, 'bin') }
}

const sweep = ({ repo, bin }) =>
  spawnSync('bash', [SWEEP, '--base', 'base', 'pkg'], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  })

test('dead code that the base already had is measured, and a branch that adds none exits 0', (t) => {
  const r = sweep(fixture(t))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /\*\*1\*\* distinct dead names at the base, \*\*1\*\* at this branch's head/)
  assert.match(r.stdout, /introduced no unused Python name/)
})

test('a branch that adds dead code to a repo that already had some exits 1 and lists only the new name', (t) => {
  const r = sweep(fixture(t, { headDead: true }))
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /introduced 1 unused Python name/)
  assert.match(r.stdout, /new_unused/)
  assert.doesNotMatch(r.stdout, /old_unused/)
})

test('a deadcode crash still exits 2, and shows the exit status and what the tool wrote', (t) => {
  const r = sweep(fixture(t, { uv: `#!/bin/sh\necho 'Traceback: deadcode broke' >&2\nexit 2\n` }))
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stderr, /exited 2/)
  assert.match(r.stderr, /Traceback: deadcode broke/)
})

test('exit 1 with no finding in the output exits 2, because it is not a findings report', (t) => {
  const r = sweep(fixture(t, { uv: `#!/bin/sh\necho 'error: no such package deadcode'\nexit 1\n` }))
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stderr, /exited 1/)
  assert.match(r.stderr, /no such package deadcode/)
})
