// The TypeScript sweep through its command line, in a real git repository. knip and pnpm are stubs,
// because both are external tools. The pnpm stub does what pnpm 11 does in the base worktree: its
// dependency check sees a state file that names other paths, tries to reinstall, cannot prompt for
// the purge without a TTY, writes the abort to stdout and exits 1.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SWEEP = join(dirname(fileURLToPath(import.meta.url)), '..', 'sweep-ts.sh')
const ABORT = '[ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY] Aborted removal of modules directory due to no TTY'

const FAKE_KNIP = `#!/bin/sh
printf '{"issues":['
sep=''
for f in src/orphan*.ts; do
  printf '%s{"file":"%s","files":[{"name":"%s"}]}' "$sep" "$f" "$f"
  sep=','
done
printf ']}\\n'
exit 1
`
const FAKE_PNPM = `#!/bin/sh
if [ -L node_modules ]; then
  echo '${ABORT}'
  exit 1
fi
shift
cmd="$1"
shift
exec "node_modules/.bin/$cmd" "$@"
`

const write = (file, text, mode) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  if (mode) chmodSync(file, mode)
}

const fixture = (t, { knip = FAKE_KNIP } = {}) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sweep-ts-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo, encoding: 'utf8' })
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  }
  write(join(root, 'bin', 'pnpm'), FAKE_PNPM, 0o755)
  write(join(repo, 'knip.json'), '{}\n')
  write(join(repo, '.gitignore'), 'node_modules\n')
  write(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  write(join(repo, 'src', 'orphan.ts'), 'export const dead = 1\n')
  mkdirSync(join(repo, 'node_modules'))
  if (knip) write(join(repo, 'node_modules', '.bin', 'knip'), knip, 0o755)
  mkdirSync(repo, { recursive: true })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-qm', 'base')
  git('branch', 'base')
  write(join(repo, 'src', 'orphan2.ts'), 'export const added = 2\n')
  git('add', '-A')
  git('commit', '-qm', 'head')
  return { repo, bin: join(root, 'bin') }
}

const sweep = ({ repo, bin }) =>
  spawnSync('bash', [SWEEP, 'base'], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  })

test('the base scan measures the base when pnpm would abort in the symlinked worktree', (t) => {
  const f = fixture(t)
  const r = sweep(f)
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /\*\*1\*\* findings at the base, \*\*2\*\* at this branch's head/)
  assert.match(r.stdout, /introduced 1 unused/)
  assert.match(r.stdout, /src\/orphan2\.ts/)
  assert.ok(lstatSync(join(f.repo, 'node_modules')).isDirectory())
  assert.ok(existsSync(join(f.repo, 'node_modules', '.bin', 'knip')))
})

test('a checkout with no knip binary exits 2, and names the path and the repair', (t) => {
  const r = sweep(fixture(t, { knip: null }))
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stderr, /node_modules\/\.bin\/knip/)
  assert.match(r.stderr, /pnpm add -D -w knip/)
})

test('a report that is not JSON exits 2, and shows what the tool wrote to stdout', (t) => {
  const r = sweep(fixture(t, { knip: `#!/bin/sh\necho 'knip wrote this instead of a report'\nexit 1\n` }))
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stderr, /could not parse knip JSON/)
  assert.match(r.stderr, /knip wrote this instead of a report/)
})
