import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { forgetEntry, readResources, stopAllResources, stopDevServer, stopDocker } from '../worker/resources.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A linked worktree that ignores the record, plus a bin folder for fake commands. */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'ndev-res-'))
  const main = path.join(root, 'main')
  execFileSync('git', ['init', '-q', '-b', 'main', main])
  git(main, 'config', 'user.email', 't@example.com')
  git(main, 'config', 'user.name', 't')
  writeFileSync(path.join(main, '.gitignore'), '.neil-dev.worktree.json\n')
  git(main, 'add', '-A')
  git(main, 'commit', '-q', '-m', 'init')
  const work = path.join(root, 'work')
  git(main, 'worktree', 'add', '-q', '-b', 'f', work)
  const bin = path.join(root, 'bin')
  mkdirSync(bin)
  return { root, main, work, bin }
}

const fake = (bin, name, script) => {
  writeFileSync(path.join(bin, name), `#!/bin/sh\n${script}\n`)
  chmodSync(path.join(bin, name), 0o755)
  return path.join(bin, name)
}

const record = (work, resources) => writeFileSync(path.join(work, '.neil-dev.worktree.json'), JSON.stringify({ version: 2, resources }, null, 2))
const readBack = (work) => JSON.parse(readFileSync(path.join(work, '.neil-dev.worktree.json'), 'utf8')).resources

const started = []
/** A real process; the entry records exactly what ps reports for it. */
function server(cwd, name = 'docs', port = 4321) {
  const child = spawn('sleep', ['300'], { cwd, stdio: 'ignore', detached: true })
  started.push(child)
  const ps = execFileSync('ps', ['-ww', '-o', 'etime=', '-o', 'command=', '-p', String(child.pid)], { encoding: 'utf8' }).trim()
  const [etime, ...command] = ps.split(/\s+/)
  const parts = etime.split(/[-:]/).map(Number).reverse()
  const seconds = parts[0] + parts[1] * 60 + (parts[2] ?? 0) * 3600 + (parts[3] ?? 0) * 86400
  return { name, entry: { pid: child.pid, port, command: command.join(' '), cwd, started: new Date(Math.floor(Date.now() / 1000 - seconds) * 1000).toISOString() }, child }
}
test.after(() => started.forEach((c) => { try { process.kill(c.pid, 'SIGKILL') } catch {} }))

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

test('readResources: no file means no resources', async () => {
  const { work, bin } = fixture()
  assert.deepEqual(await readResources(work, { docker: path.join(bin, 'none') }), { docker: [], devServers: [] })
})

test('readResources: version 1 and invalid JSON are reported with a repair, not hidden', async () => {
  const { work } = fixture()
  writeFileSync(path.join(work, '.neil-dev.worktree.json'), JSON.stringify({ version: 1, stacks: [] }))
  assert.match((await readResources(work)).problem, /version 1.*worktree-env\.sh migrate --worktree/s)
  writeFileSync(path.join(work, '.neil-dev.worktree.json'), '{ nope')
  assert.match((await readResources(work)).problem, /not valid JSON/)
})

test('readResources: dev servers are running, dead, or a reused pid', async () => {
  const { work } = fixture()
  const live = server(work, 'live')
  const gone = { pid: 999999, port: 3000, command: 'node x', cwd: work, started: '2026-01-01T00:00:00.000Z' }
  const reused = { ...live.entry, command: 'something else entirely' }
  record(work, { docker: [], 'dev-servers': { live: live.entry, gone, reused } })
  const status = Object.fromEntries((await readResources(work)).devServers.map((d) => [d.name, d.status]))
  assert.deepEqual(status, { live: 'running', gone: 'dead', reused: 'mismatch' })
})

test('readResources: docker stacks show running from docker ps, and unknown with the reason when docker fails', async () => {
  const { work, bin } = fixture()
  record(work, { docker: [{ kind: 'supabase', projectId: 'app', workdir: work, cliVersion: '2.0.0', addedAt: 'x' }, { kind: 'supabase', projectId: 'other', workdir: work, cliVersion: '2.0.0', addedAt: 'y' }], 'dev-servers': {} })
  const ok = fake(bin, 'docker', 'echo supabase_db_app\necho supabase_kong_app\necho unrelated')
  const stacks = (await readResources(work, { docker: ok })).docker
  assert.deepEqual(stacks.map((s) => [s.projectId, s.status]), [['app', 'running'], ['other', 'stopped']])
  const bad = fake(bin, 'docker2', 'echo "Cannot connect to the Docker daemon" >&2; exit 1')
  const unknown = (await readResources(work, { docker: bad })).docker
  assert.equal(unknown[0].status, 'unknown')
  assert.match(unknown[0].problem, /exit 1.*Cannot connect to the Docker daemon/s)
})

test('stopDevServer kills the recorded process and removes its entry', async () => {
  const { work } = fixture()
  const s = server(work)
  record(work, { docker: [], 'dev-servers': { docs: s.entry } })
  await stopDevServer(work, 'docs')
  await sleep(100)
  assert.equal(alive(s.entry.pid), false)
  assert.deepEqual(readBack(work)['dev-servers'], {})
})

test('stopDevServer refuses a pid that now runs another command, and kills nothing', async () => {
  const { work } = fixture()
  const s = server(work)
  record(work, { docker: [], 'dev-servers': { docs: { ...s.entry, command: 'node vite.js' } } })
  await assert.rejects(stopDevServer(work, 'docs'), (e) => e.code === 'pid_mismatch' && /node vite\.js/.test(e.message) && /Forget/.test(e.message))
  assert.equal(alive(s.entry.pid), true)
  assert.equal(Object.keys(readBack(work)['dev-servers']).length, 1)
})

test('forgetEntry removes a dev-server entry without killing anything', async () => {
  const { work } = fixture()
  const s = server(work)
  record(work, { docker: [], 'dev-servers': { docs: { ...s.entry, command: 'other' } } })
  await forgetEntry(work, { type: 'dev-server', name: 'docs' })
  assert.deepEqual(readBack(work)['dev-servers'], {})
  assert.equal(alive(s.entry.pid), true)
})

test('stopDocker runs supabase stop with the right flags per policy and removes the entry', async () => {
  const { work, bin } = fixture()
  const log = path.join(bin, 'calls.log')
  const npx = fake(bin, 'npx', `echo "$PWD $@" >> ${log}`)
  const stack = { kind: 'supabase', projectId: 'app', workdir: work, cliVersion: '2.1.0', addedAt: 'x' }
  record(work, { docker: [stack, { ...stack, projectId: 'keep', addedAt: 'y' }], 'dev-servers': {} })
  await stopDocker(work, 'app', 'stop-and-delete', { npx })
  assert.match(readFileSync(log, 'utf8'), /-y supabase@2\.1\.0 stop --project-id app --no-backup/)
  await stopDocker(work, 'keep', 'stop-keep-data', { npx })
  assert.doesNotMatch(readFileSync(log, 'utf8').split('\n')[1], /--no-backup/)
  assert.deepEqual(readBack(work).docker, [])
})

test('stopDocker failure keeps the entry and reports id, exit code, output and the repair command', async () => {
  const { work, bin } = fixture()
  const npx = fake(bin, 'npx', 'echo "port is busy" >&2; exit 3')
  record(work, { docker: [{ kind: 'supabase', projectId: 'app', workdir: work, cliVersion: '2.1.0', addedAt: 'x' }], 'dev-servers': {} })
  await assert.rejects(stopDocker(work, 'app', 'stop-and-delete', { npx }), (e) => e.code === 'stop_failed' && /app/.test(e.message) && /exit code 3/.test(e.message) && /port is busy/.test(e.message) && /npx -y supabase@2\.1\.0 stop --project-id app --no-backup/.test(e.message))
  assert.equal(readBack(work).docker.length, 1)
})

test('a lock held by a live process is reported with its path and repair, and nothing is changed', async () => {
  const { work } = fixture()
  const s = server(work)
  record(work, { docker: [], 'dev-servers': { docs: s.entry } })
  const gitDir = git(work, 'rev-parse', '--path-format=absolute', '--git-dir').trim()
  writeFileSync(path.join(gitDir, 'ndev-worktree.lock'), String(process.pid))
  await assert.rejects(forgetEntry(work, { type: 'dev-server', name: 'docs' }, { lockWaitMs: 150 }), (e) => e.code === 'locked' && e.message.includes('ndev-worktree.lock') && /rm /.test(e.message))
  assert.equal(Object.keys(readBack(work)['dev-servers']).length, 1)
})

test('stopAllResources stops dev servers, applies the policy to docker, and reports every outcome', async () => {
  const { work, bin } = fixture()
  const a = server(work, 'a', 3001)
  const b = server(work, 'b', 3002)
  const npx = fake(bin, 'npx', 'exit 0')
  const stack = { kind: 'supabase', projectId: 'app', workdir: work, cliVersion: '2.1.0', addedAt: 'x' }
  record(work, { docker: [stack], 'dev-servers': { a: a.entry, b: { ...b.entry, command: 'changed' } } })
  const result = await stopAllResources(work, 'stop-keep-data', { npx })
  await sleep(100)
  const by = Object.fromEntries(result.map((r) => [r.id, r.ok]))
  assert.deepEqual(by, { 'dev-server:a': true, 'dev-server:b': false, 'docker:app': true })
  assert.equal(alive(a.entry.pid), false)
  assert.equal(alive(b.entry.pid), true, 'a mismatched pid is never killed')
  assert.match(result.find((r) => r.id === 'dev-server:b').error, /pid_mismatch|runs/)
})

test('stopAllResources with keep-running leaves docker alone', async () => {
  const { work, bin } = fixture()
  const npx = fake(bin, 'npx', 'echo called >> ' + path.join(bin, 'c.log'))
  record(work, { docker: [{ kind: 'supabase', projectId: 'app', workdir: work, cliVersion: '2.1.0', addedAt: 'x' }], 'dev-servers': {} })
  const result = await stopAllResources(work, 'keep-running', { npx })
  assert.equal(existsSync(path.join(bin, 'c.log')), false)
  assert.equal(result.find((r) => r.id === 'docker:app').skipped, true)
})
