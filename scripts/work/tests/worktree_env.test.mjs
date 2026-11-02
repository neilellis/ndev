// Tests for worktree-env.sh against real git repositories in a temporary folder.
// A fake `npx` first on PATH stands in for the Supabase CLI: no test stops a real stack.
// Run: node --test scripts/work/tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// WORKTREE_ENV_SCRIPT runs the tests against another copy, to watch a new test fail on the old code.
const SCRIPT = process.env.WORKTREE_ENV_SCRIPT ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'worktree-env.sh')
const FILE = '.neil-dev.worktree.json'

const sh = (cwd, ...argv) => {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, `${argv.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

// The fake npx records "<cwd>|<args>" in calls.log. It fails (exit 1, a Docker error) for each
// project id listed in fail.txt, and succeeds for every other id. With slow.txt it takes 1 s; an
// executable during.sh runs while it "stops".
const FAKE_NPX = `#!/usr/bin/env bash
dir="$(cd "$(dirname "$0")" && pwd -P)"
echo "$(pwd -P)|$*" >> "$dir/calls.log"
if [ -f "$dir/slow.txt" ]; then sleep 1; fi
if [ -x "$dir/during.sh" ]; then "$dir/during.sh"; fi
for id in $(cat "$dir/fail.txt" 2>/dev/null); do
  case " $* " in *" --project-id $id "*)
    echo "Stopping containers..."
    echo "Error response from daemon: cannot stop container supabase_db_$id" >&2
    exit 1 ;;
  esac
done
echo "Stopped supabase local development setup."
`

// A main checkout that ignores the file (unless ignored: false), one linked worktree, and a bin
// folder that holds the fake npx.
function project({ ignored = true } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-env-')))
  const main = join(base, 'main')
  const bin = join(base, 'bin')
  mkdirSync(main)
  mkdirSync(bin)
  writeFileSync(join(bin, 'npx'), FAKE_NPX)
  chmodSync(join(bin, 'npx'), 0o755)
  sh(main, 'git', 'init', '-q', '-b', 'main')
  writeFileSync(join(main, '.gitignore'), ignored ? `${FILE}\n` : 'node_modules/\n')
  sh(main, 'git', 'add', '.gitignore')
  sh(main, 'git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init')
  const worktree = join(base, 'wt')
  sh(main, 'git', 'worktree', 'add', '-q', '-b', 'task', worktree)
  mkdirSync(join(worktree, 'app', 'supabase'), { recursive: true })
  return { base, main, worktree, bin, app: join(worktree, 'app') }
}

const runWith = (env, p, cwd, ...args) => {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${p.bin}:${process.env.PATH}`, ...env },
  })
  return { status: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout, stderr: r.stderr }
}

const run = (p, cwd, ...args) => runWith({}, p, cwd, ...args)

// Waits (at most 10 s) until a process has exited.
async function exited(pid) {
  for (let i = 0; i < 200; i++) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.fail(`pid ${pid} still runs after 10 s`)
}

const record = p => JSON.parse(readFileSync(join(p.worktree, FILE), 'utf8'))
const docker = p => record(p).resources.docker
const servers = p => record(p).resources['dev-servers']
const writeRecord = (p, value) => writeFileSync(join(p.worktree, FILE), JSON.stringify(value))
const calls = p => (existsSync(join(p.bin, 'calls.log')) ? readFileSync(join(p.bin, 'calls.log'), 'utf8').trim().split('\n') : [])
const add = (p, id, ...extra) =>
  run(p, p.app, 'add-stack', '--kind', 'supabase', '--project-id', id, '--workdir', p.app, '--cli-version', '2.122.0', ...extra)

test('add-stack records the stack in the worktree root file, also when run from a subfolder', () => {
  const p = project()
  const r = add(p, 'fcc-211')
  assert.equal(r.status, 0, r.out)
  const stacks = docker(p)
  assert.equal(stacks.length, 1)
  assert.deepEqual(
    { kind: stacks[0].kind, projectId: stacks[0].projectId, workdir: stacks[0].workdir, cliVersion: stacks[0].cliVersion },
    { kind: 'supabase', projectId: 'fcc-211', workdir: p.app, cliVersion: '2.122.0' },
  )
  assert.match(stacks[0].addedAt, /^\d{4}-\d\d-\d\dT/)
  assert.ok(!existsSync(join(p.main, FILE)), 'the main checkout got the file')
})

test('add-stack twice for one id keeps one entry with the latest values', () => {
  const p = project()
  assert.equal(add(p, 'fcc-211').status, 0)
  assert.equal(run(p, p.app, 'add-stack', '--kind', 'supabase', '--project-id', 'fcc-211', '--workdir', p.app, '--cli-version', '2.130.1').status, 0)
  const stacks = docker(p)
  assert.equal(stacks.length, 1)
  assert.equal(stacks[0].cliVersion, '2.130.1')
})

test('add-stack refuses when git does not ignore the file, and names the repair', () => {
  const p = project({ ignored: false })
  const r = add(p, 'fcc-211')
  assert.equal(r.status, 3, r.out)
  assert.match(r.out, /not git-ignored/)
  assert.match(r.out, /\.neil-dev\.worktree\.json/)
  assert.match(r.out, /\.gitignore/)
  assert.ok(!existsSync(join(p.worktree, FILE)))
})

test('add-stack refuses in the main checkout', () => {
  const p = project()
  const r = run(p, p.main, 'add-stack', '--kind', 'supabase', '--project-id', 'fcc-main', '--workdir', p.main, '--cli-version', '2.122.0')
  assert.equal(r.status, 3, r.out)
  assert.match(r.out, /main checkout/)
  assert.ok(!existsSync(join(p.main, FILE)))
})

test('add-stack without --cli-version names the missing option', () => {
  const p = project()
  const r = run(p, p.app, 'add-stack', '--kind', 'supabase', '--project-id', 'fcc-211', '--workdir', p.app)
  assert.equal(r.status, 2, r.out)
  assert.match(r.out, /--cli-version/)
})

test('add-stack refuses a workdir that is not a folder', () => {
  const p = project()
  const r = run(p, p.app, 'add-stack', '--kind', 'supabase', '--project-id', 'fcc-211', '--workdir', join(p.worktree, 'gone'), '--cli-version', '2.122.0')
  assert.equal(r.status, 2, r.out)
  assert.match(r.out, /--workdir/)
  assert.ok(!existsSync(join(p.worktree, FILE)))
})

test('add-stack refuses a kind it cannot stop', () => {
  const p = project()
  const r = run(p, p.app, 'add-stack', '--kind', 'redis', '--project-id', 'x', '--workdir', p.app, '--cli-version', '1.0.0')
  assert.equal(r.status, 2, r.out)
  assert.match(r.out, /supabase/)
})

test('remove-stack removes the entry and stops nothing; an unlisted id exits 4', () => {
  const p = project()
  add(p, 'fcc-211')
  add(p, 'fcc-212')
  const r = run(p, p.app, 'remove-stack', '--kind', 'supabase', '--project-id', 'fcc-211')
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(docker(p).map(s => s.projectId), ['fcc-212'])
  assert.deepEqual(calls(p), [])
  const again = run(p, p.app, 'remove-stack', '--kind', 'supabase', '--project-id', 'fcc-211')
  assert.equal(again.status, 4, again.out)
  assert.match(again.out, /fcc-211/)
})

test('list --json prints the record', () => {
  const p = project()
  add(p, 'fcc-211')
  const r = run(p, p.app, 'list', '--json')
  assert.equal(r.status, 0, r.out)
  assert.equal(JSON.parse(r.stdout).resources.docker[0].projectId, 'fcc-211')
})

test('stop-all by default stops each stack and deletes its data, in its workdir, then removes the entries', () => {
  const p = project()
  add(p, 'fcc-211')
  add(p, 'fcc-212')
  const r = run(p, p.base, 'stop-all', '--worktree', p.worktree)
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(calls(p), [
    `${p.app}|-y supabase@2.122.0 stop --project-id fcc-211 --no-backup`,
    `${p.app}|-y supabase@2.122.0 stop --project-id fcc-212 --no-backup`,
  ])
  assert.deepEqual(docker(p), [])
})

test('stop-all --on-end stop-keep-data stops without deleting the data', () => {
  const p = project()
  add(p, 'fcc-211')
  const r = run(p, p.base, 'stop-all', '--worktree', p.worktree, '--on-end', 'stop-keep-data')
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(calls(p), [`${p.app}|-y supabase@2.122.0 stop --project-id fcc-211`])
  assert.deepEqual(docker(p), [])
})

test('stop-all --on-end keep-running stops nothing and keeps the entries', () => {
  const p = project()
  add(p, 'fcc-211')
  const r = run(p, p.base, 'stop-all', '--worktree', p.worktree, '--on-end', 'keep-running')
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(calls(p), [])
  assert.equal(docker(p).length, 1)
  assert.match(r.out, /keep-running/)
})

test('stop-all refuses an unknown --on-end value', () => {
  const p = project()
  add(p, 'fcc-211')
  const r = run(p, p.base, 'stop-all', '--worktree', p.worktree, '--on-end', 'nuke')
  assert.equal(r.status, 2, r.out)
  assert.match(r.out, /stop-and-delete/)
  assert.deepEqual(calls(p), [])
})

test('a stop that fails: the id, command, exit code, output and repair are printed, and only that entry stays', () => {
  const p = project()
  add(p, 'fcc-211')
  add(p, 'fcc-212')
  writeFileSync(join(p.bin, 'fail.txt'), 'fcc-211\n')
  const r = run(p, p.base, 'stop-all', '--worktree', p.worktree)
  assert.equal(r.status, 1, r.out)
  assert.match(r.stderr, /fcc-211/)
  assert.match(r.stderr, /npx -y supabase@2\.122\.0 stop --project-id fcc-211 --no-backup/)
  assert.match(r.stderr, /exit code 1/)
  assert.match(r.stderr, /cannot stop container supabase_db_fcc-211/)
  assert.match(r.stderr, /[Rr]epair/)
  assert.match(r.stderr, /remove-stack --kind supabase --project-id fcc-211/)
  const stacks = docker(p)
  assert.deepEqual(stacks.map(s => s.projectId), ['fcc-211'])
  assert.equal(stacks[0].lastStop.exitCode, 1)
  assert.match(stacks[0].lastStop.command, /--no-backup/)
  assert.match(stacks[0].lastStop.output, /cannot stop container/)
  assert.equal(calls(p).length, 2, 'the second stack was not stopped after the first failed')
})

test('stop-all with no file stops nothing and exits 0', () => {
  const p = project()
  const r = run(p, p.base, 'stop-all', '--worktree', p.worktree)
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(calls(p), [])
})

test('stop-all names a file that is not valid JSON and stops nothing', () => {
  const p = project()
  writeFileSync(join(p.worktree, FILE), '{ not json')
  const r = run(p, p.base, 'stop-all', '--worktree', p.worktree)
  assert.equal(r.status, 2, r.out)
  assert.match(r.out, /not valid JSON/)
  assert.match(r.out, new RegExp(FILE.replace(/[.]/g, '\\.')))
})

test('stop-all whose workdir is gone runs the stop from the worktree root', () => {
  const p = project()
  add(p, 'fcc-211')
  rmSync(p.app, { recursive: true })
  const r = run(p, p.base, 'stop-all', '--worktree', p.worktree)
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(calls(p), [`${p.worktree}|-y supabase@2.122.0 stop --project-id fcc-211 --no-backup`])
})

test('stop-all --background returns at once and the detached run stops the stacks and logs the result', async () => {
  const p = project()
  add(p, 'fcc-211')
  const log = join(p.base, 'stop.log')
  const r = run(p, p.base, 'stop-all', '--worktree', p.worktree, '--background', '--log', log)
  assert.equal(r.status, 0, r.out)
  const pid = Number(/pid (\d+)/.exec(r.out)?.[1])
  assert.ok(pid > 0, `no pid in: ${r.out}`)
  assert.match(r.out, new RegExp(log.replace(/[.]/g, '\\.')))
  // Wait (bounded) for the detached child to exit.
  for (let i = 0; i < 200; i++) {
    try {
      process.kill(pid, 0)
    } catch {
      break
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.deepEqual(calls(p), [`${p.app}|-y supabase@2.122.0 stop --project-id fcc-211 --no-backup`])
  assert.deepEqual(docker(p), [])
  assert.match(readFileSync(log, 'utf8'), /fcc-211/)
})

test('stop-all keeps a newer entry for the same stack that was added while the stop ran', () => {
  const p = project()
  add(p, 'fcc-211')
  // While the old stack stops, a new session starts the stack again and records it.
  writeFileSync(join(p.bin, 'during.sh'), `#!/usr/bin/env bash\nrm -f "$0"\nbash ${SCRIPT} add-stack --kind supabase --project-id fcc-211 --workdir ${p.app} --cli-version 2.130.1\n`)
  chmodSync(join(p.bin, 'during.sh'), 0o755)
  const r = run(p, p.base, 'stop-all', '--worktree', p.worktree)
  assert.equal(r.status, 0, r.out)
  const stacks = docker(p)
  assert.deepEqual(stacks.map(s => `${s.projectId}@${s.cliVersion}`), ['fcc-211@2.130.1'], 'the stop removed the entry added after it read the file')
})

test('a record change waits for the lock; a lock that a live process holds too long exits 2 and names the repair', () => {
  const p = project()
  add(p, 'fcc-211')
  const lock = join(p.main, '.git', 'worktrees', 'wt', 'ndev-worktree.lock')
  writeFileSync(lock, String(process.pid))
  const r = runWith({ NDEV_WORKTREE_LOCK_WAIT_MS: '300' }, p, p.app, 'remove-stack', '--kind', 'supabase', '--project-id', 'fcc-211')
  assert.equal(r.status, 2, r.out)
  assert.match(r.out, new RegExp(`held by pid ${process.pid}`))
  assert.match(r.out, new RegExp(`rm ${lock.replace(/[.]/g, '\\.')}`))
  assert.equal(docker(p).length, 1, 'the record changed without the lock')
  assert.ok(existsSync(lock), 'the lock of a live holder was removed')
})

test('a lock whose holder is gone is taken over', () => {
  const p = project()
  add(p, 'fcc-211')
  const gone = spawnSync('true')
  const lock = join(p.main, '.git', 'worktrees', 'wt', 'ndev-worktree.lock')
  writeFileSync(lock, String(gone.pid))
  const r = runWith({ NDEV_WORKTREE_LOCK_WAIT_MS: '300' }, p, p.app, 'remove-stack', '--kind', 'supabase', '--project-id', 'fcc-211')
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(docker(p), [])
  assert.ok(!existsSync(lock))
})

test('add-stack refuses a project id that another worktree lists, and names that worktree and the repair', () => {
  const p = project()
  add(p, 'fcc-211')
  const other = join(p.base, 'wt2')
  sh(p.main, 'git', 'worktree', 'add', '-q', '-b', 'task2', other)
  const r = run(p, other, 'add-stack', '--kind', 'supabase', '--project-id', 'fcc-211', '--workdir', other, '--cli-version', '2.122.0')
  assert.equal(r.status, 3, r.out)
  assert.match(r.out, new RegExp(p.worktree.replace(/[.]/g, '\\.')))
  assert.match(r.out, /project_id/)
  assert.match(r.out, /remove-stack --kind supabase --project-id fcc-211/)
  assert.ok(!existsSync(join(other, FILE)))
  assert.equal(run(p, other, 'add-stack', '--kind', 'supabase', '--project-id', 'fcc-211b', '--workdir', other, '--cli-version', '2.122.0').status, 0)
})

test('stop-all --worktree with a subfolder stops the stacks of its worktree', () => {
  const p = project()
  add(p, 'fcc-211')
  const r = run(p, p.base, 'stop-all', '--worktree', p.app)
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(calls(p), [`${p.app}|-y supabase@2.122.0 stop --project-id fcc-211 --no-backup`])
  assert.deepEqual(docker(p), [])
})

test('stop-all --background logs by default in the common git dir, which outlives the worktree', async () => {
  const p = project()
  add(p, 'fcc-211')
  const r = run(p, p.base, 'stop-all', '--worktree', p.worktree, '--background')
  assert.equal(r.status, 0, r.out)
  const log = join(p.main, '.git', 'ndev-worktree-stop', 'wt.log')
  assert.match(r.out, new RegExp(`log ${log.replace(/[.]/g, '\\.')}`))
  await exited(Number(/pid (\d+)/.exec(r.out)?.[1]))
  assert.match(readFileSync(log, 'utf8'), /stopped supabase stack fcc-211/)
})

test('the background stop survives a kill of the caller\'s process group', async () => {
  const p = project()
  add(p, 'fcc-211')
  writeFileSync(join(p.bin, 'slow.txt'), '')
  const log = join(p.base, 'stop.log')
  // The caller runs in its own process group, as a hook command does; the group is killed at once.
  const r = spawnSync('bash', [SCRIPT, 'stop-all', '--worktree', p.worktree, '--background', '--log', log], {
    cwd: p.base, encoding: 'utf8', detached: true, env: { ...process.env, PATH: `${p.bin}:${process.env.PATH}` },
  })
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
  try {
    process.kill(-r.pid, 'SIGKILL')
  } catch (error) {
    assert.equal(error.code, 'ESRCH')
  }
  const pid = Number(/pid (\d+)/.exec(r.stdout)?.[1])
  assert.ok(pid > 0, r.stdout)
  await exited(pid)
  assert.deepEqual(docker(p), [])
  assert.match(readFileSync(log, 'utf8'), /stopped supabase stack fcc-211/)
})

test('the file keeps every resource under "resources": docker stacks and dev servers', () => {
  const p = project()
  assert.equal(add(p, 'fcc-211').status, 0)
  const r = record(p)
  assert.deepEqual(Object.keys(r).sort(), ['resources', 'version'])
  assert.equal(r.version, 2)
  assert.deepEqual(Object.keys(r.resources).sort(), ['dev-servers', 'docker'])
  assert.deepEqual(r.resources['dev-servers'], {})
  assert.deepEqual(r.resources.docker.map(s => s.projectId), ['fcc-211'])
})

// The version 1 layout: the stacks at the top level.
const V1 = wt => ({ version: 1, stacks: [{ kind: 'supabase', projectId: 'fcc-old', workdir: wt, cliVersion: '2.122.0', addedAt: '2026-10-30T10:00:00.000Z' }] })

test('a version 1 file is refused, stops nothing, and the message names the migrate command', () => {
  const p = project()
  writeRecord(p, V1(p.worktree))
  for (const args of [['stop-all', '--worktree', p.worktree], ['list', '--worktree', p.worktree], ['remove-stack', '--kind', 'supabase', '--project-id', 'fcc-old', '--worktree', p.worktree]]) {
    const r = run(p, p.base, ...args)
    assert.equal(r.status, 2, `${args[0]}: ${r.out}`)
    assert.match(r.out, /version 1/)
    assert.match(r.out, new RegExp(`migrate --worktree ${p.worktree.replace(/[.]/g, '\\.')}`))
  }
  assert.deepEqual(calls(p), [])
  assert.deepEqual(record(p), V1(p.worktree), 'a refused command changed the file')
})

test('migrate moves the version 1 stacks under resources.docker, and a second run changes nothing', () => {
  const p = project()
  writeRecord(p, V1(p.worktree))
  const r = run(p, p.base, 'migrate', '--worktree', p.worktree)
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(record(p), { version: 2, resources: { docker: V1(p.worktree).stacks, 'dev-servers': {} } })
  const again = run(p, p.base, 'migrate', '--worktree', p.worktree)
  assert.equal(again.status, 0, again.out)
  assert.match(again.out, /already/)
  assert.deepEqual(record(p), { version: 2, resources: { docker: V1(p.worktree).stacks, 'dev-servers': {} } })
})

test('migrate refuses a version 1 file with a key it does not know, and changes nothing', () => {
  const p = project()
  writeRecord(p, { ...V1(p.worktree), extra: true })
  const r = run(p, p.base, 'migrate', '--worktree', p.worktree)
  assert.equal(r.status, 2, r.out)
  assert.match(r.out, /"extra"/)
  assert.equal(record(p).extra, true)
})

test('an unknown shape is refused with exit 2 and names the bad part', () => {
  const p = project()
  const shapes = [
    [{ version: 3, resources: {} }, /"version"/],
    [{ version: 2, resources: {}, stacks: [] }, /"stacks"/],
    [{ version: 2 }, /"resources"/],
    [{ version: 2, resources: { docker: [], vms: {} } }, /"vms"/],
    [{ version: 2, resources: { docker: {} } }, /resources\.docker/],
    [{ version: 2, resources: { 'dev-servers': [] } }, /resources\.dev-servers/],
    [{ version: 2, resources: { docker: [{ kind: 'supabase' }] } }, /projectId/],
    [{ version: 2, resources: { 'dev-servers': { docs: { pid: 'x', port: 3000, command: 'c', cwd: '/', started: '2026-10-30T10:00:00.000Z' } } } }, /dev-servers\.docs.*pid/],
  ]
  for (const [shape, problem] of shapes) {
    writeRecord(p, shape)
    const r = run(p, p.base, 'stop-all', '--worktree', p.worktree)
    assert.equal(r.status, 2, `${JSON.stringify(shape)}: ${r.out}`)
    assert.match(r.out, problem, JSON.stringify(shape))
    assert.match(r.out, new RegExp(FILE.replace(/[.]/g, '\\.')))
  }
  assert.deepEqual(calls(p), [])
})
