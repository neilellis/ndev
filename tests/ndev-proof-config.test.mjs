import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { validate } from '../hooks/config.ts'
import { proofSettingsAt } from '../scripts/ndev/proof-settings.mjs'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const executable = join(repoRoot, 'bin/ndev')
const fixtureServer = join(repoRoot, 'tests/fixtures/dev-server.mjs')

function run(args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', timeout: 60_000 })
  assert.ifError(result.error)
  return result
}

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

function repository(t, config) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ndev-proof-config-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const main = join(base, 'main')
  git(base, 'init', '-q', '-b', 'main', main)
  writeFileSync(join(main, '.gitignore'), '.neil-dev.worktree.json\n')
  writeFileSync(join(main, '.ndev.json'), `${JSON.stringify(config, null, 2)}\n`)
  git(main, 'add', '-A')
  git(main, 'commit', '-qm', 'config')
  return { base, main }
}

function worktree(t, config) {
  const { base, main } = repository(t, config)
  const tree = join(base, 'tree')
  git(main, 'worktree', 'add', '-q', '-b', 'work', tree)
  return tree
}

const web = { command: `node ${fixtureServer}`, port: 0, ready: '/', routes: ['/'] }

const serverConfig = (port, extra = {}) => ({ devServers: { web: { ...web, port, ready: `http://127.0.0.1:${port}/`, env: { FIXTURE_PORT: String(port) }, ...extra } } })

function freePort() {
  const result = spawnSync(process.execPath, ['-e', "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"], { encoding: 'utf8' })
  return Number(result.stdout.trim())
}

function stop(pid) {
  try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch {} }
}

test('the schema accepts dev servers and proof settings', () => {
  assert.equal(validate({
    devServers: { web: { command: 'npm run dev', cwd: 'apps/web', port: 3000, ready: 'http://localhost:3000/', env: { A: 'b' }, routes: ['/', '/settings'], timeout: 90 } },
    proof: { enabled: true, checks: { visual: false }, viewports: [{ name: 'phone', width: 390, height: 844 }], schemes: ['light', 'dark'], label: 'skip-proof', tiers: { small: 50, large: 400 } },
  }), undefined)
})

for (const [config, path, fix] of [
  [{ devServers: { web: { command: 'x', port: 70000, ready: '/' } } }, 'devServers.web.port', 'a port number from 1 to 65535'],
  [{ devServers: { web: { port: 3000, ready: '/' } } }, 'devServers.web.command', 'the shell command that starts the server'],
  [{ devServers: { web: { command: 'x', port: 3000 } } }, 'devServers.web.ready', 'a URL or a path'],
  [{ devServers: { web: { command: 'x', port: 3000, ready: '/', routes: '/' } } }, 'devServers.web.routes', 'a list of paths'],
  [{ devServers: { web: { command: 'x', port: 3000, ready: '/', colour: 1 } } }, 'devServers.web', 'the keys are command, cwd, port, ready, env, routes, timeout'],
  [{ devServers: { 'bad name': { command: 'x', port: 3000, ready: '/' } } }, 'devServers', 'letters, digits'],
  [{ proof: { enabled: 'no' } }, 'proof.enabled', 'true or false'],
  [{ proof: { checks: { speed: true } } }, 'proof.checks', 'the checks are requirements, code, visual, tests, model, docs, lessons'],
  [{ proof: { schemes: ['sepia'] } }, 'proof.schemes', '"light" and "dark"'],
  [{ proof: { viewports: [{ name: 'phone', width: 0, height: 800 }] } }, 'proof.viewports', 'width and height'],
  [{ proof: { label: '' } }, 'proof.label', 'a GitHub label name'],
  [{ proof: { tiers: { small: 500, large: 100 } } }, 'proof.tiers', 'small below large'],
]) {
  test(`the schema refuses a bad ${path}, naming the path and the fix`, () => {
    const error = validate(config)
    assert.ok(error, `no error for ${JSON.stringify(config)}`)
    assert.match(error, new RegExp(`"${path.replaceAll('.', '\\.')}`))
    assert.ok(error.includes(fix), `${error} does not name the fix "${fix}"`)
  })
}

test('proof settings come from the base ref, so a pull request cannot turn its own checks off', t => {
  const { main } = repository(t, { proof: { checks: { visual: false } } })
  git(main, 'switch', '-q', '-c', 'feature')
  writeFileSync(join(main, '.ndev.json'), `${JSON.stringify({ proof: { enabled: false, checks: { tests: false } } })}\n`)
  git(main, 'commit', '-qam', 'turn proof off')
  const settings = proofSettingsAt(main, 'main')
  assert.equal(settings.enabled, true)
  assert.deepEqual(settings.checks, { requirements: true, code: true, visual: false, tests: true, model: true, docs: true, lessons: true })
  assert.equal(settings.label, 'no-proof')
  assert.equal(settings.source, 'main:.ndev.json')
})

test('proof settings fall back to the legacy file at the base ref, and default to on', t => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ndev-proof-legacy-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  git(base, 'init', '-q', '-b', 'main')
  writeFileSync(join(base, '.neil-dev.json'), '{"proof":{"label":"skip-proof"}}\n')
  git(base, 'add', '-A')
  git(base, 'commit', '-qm', 'legacy')
  const settings = proofSettingsAt(base, 'main')
  assert.equal(settings.enabled, true)
  assert.equal(settings.label, 'skip-proof')
  assert.equal(settings.source, 'main:.neil-dev.json')
})

test('proof settings at a base ref with a bad proof section fail with the path', t => {
  const { main } = repository(t, { proof: { enabled: 'off' } })
  assert.throws(() => proofSettingsAt(main, 'main'), error => error.message.includes('main:.ndev.json') && error.message.includes('"proof.enabled"'))
})

test('dev-servers lists the configured servers', t => {
  const tree = worktree(t, serverConfig(4321))
  const result = run(['project', 'dev-servers', '--json'], tree)
  assert.equal(result.status, 0, result.stderr)
  const listed = JSON.parse(result.stdout).result
  assert.deepEqual(listed.servers.map(s => [s.name, s.port, s.ready]), [['web', 4321, 'http://127.0.0.1:4321/']])
})

test('dev-servers start boots the server, waits until it is ready, and records it', t => {
  const port = freePort()
  const tree = worktree(t, serverConfig(port))
  const result = run(['project', 'dev-servers', 'start', 'web', '--json'], tree)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const started = JSON.parse(result.stdout).result
  t.after(() => stop(started.pid))
  assert.equal(started.name, 'web')
  assert.equal(started.url, `http://127.0.0.1:${port}/`)
  const record = JSON.parse(readFileSync(join(tree, '.neil-dev.worktree.json'), 'utf8'))
  assert.equal(record.resources['dev-servers'].web.pid, started.pid)
  assert.equal(record.resources['dev-servers'].web.port, port)
  const page = spawnSync('curl', ['-sf', `http://127.0.0.1:${port}/`], { encoding: 'utf8' })
  assert.equal(page.stdout, 'fixture ready')
})

test('a dev server that exits before it is ready fails with its name, command, exit code and log', t => {
  const tree = worktree(t, { devServers: { web: { command: 'echo booting; echo port taken >&2; exit 3', port: 4999, ready: 'http://127.0.0.1:4999/' } } })
  const result = run(['project', 'dev-servers', 'start', 'web'], tree)
  assert.notEqual(result.status, 0)
  const output = result.stderr + result.stdout
  for (const part of ['web', 'echo booting; echo port taken >&2; exit 3', 'exited 3', 'port taken']) assert.ok(output.includes(part), `${output} does not include ${part}`)
})

test('a dev server that never becomes ready is stopped and fails with its log', t => {
  const tree = worktree(t, { devServers: { web: { command: 'echo waiting forever; sleep 30', port: 4998, ready: 'ready.flag', timeout: 1 } } })
  const started = Date.now()
  const result = run(['project', 'dev-servers', 'start', 'web'], tree)
  assert.notEqual(result.status, 0)
  assert.ok(Date.now() - started < 15_000)
  const output = result.stderr + result.stdout
  for (const part of ['web', 'not ready after 1 s', 'waiting forever', 'ready.flag']) assert.ok(output.includes(part), `${output} does not include ${part}`)
})

test('dev-servers start names the configured servers when the name is unknown', t => {
  const tree = worktree(t, serverConfig(4321))
  const result = run(['project', 'dev-servers', 'start', 'docs'], tree)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr + result.stdout, /docs.*web/s)
})

test('dev-servers start refuses while something already answers at the ready URL, naming the port', t => {
  const port = freePort()
  const holder = spawn(process.execPath, [fixtureServer], { env: { ...process.env, FIXTURE_PORT: String(port) }, stdio: 'ignore' })
  t.after(() => holder.kill('SIGKILL'))
  const tree = worktree(t, serverConfig(port))
  for (let i = 0; i < 40 && spawnSync('curl', ['-sf', `http://127.0.0.1:${port}/`]).status !== 0; i++) spawnSync('sleep', ['0.1'])
  const result = run(['project', 'dev-servers', 'start', 'web'], tree)
  assert.notEqual(result.status, 0)
  const output = result.stderr + result.stdout
  for (const part of ['web', `http://127.0.0.1:${port}/`, `port ${port}`, 'already answers']) assert.ok(output.includes(part), `${output} does not include ${part}`)
  const record = join(tree, '.neil-dev.worktree.json')
  assert.equal(existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')).resources?.['dev-servers']?.web : undefined, undefined)
})

test('dev-servers start refuses a second start of a running server and names the stop command', t => {
  const port = freePort()
  const tree = worktree(t, serverConfig(port))
  const first = run(['project', 'dev-servers', 'start', 'web', '--json'], tree)
  assert.equal(first.status, 0, first.stderr + first.stdout)
  const started = JSON.parse(first.stdout).result
  t.after(() => stop(started.pid))
  const second = run(['project', 'dev-servers', 'start', 'web'], tree)
  assert.notEqual(second.status, 0)
  const output = second.stderr + second.stdout
  for (const part of ['web', `pid ${started.pid}`, 'worktree-env.sh stop --name web']) assert.ok(output.includes(part), `${output} does not include ${part}`)
  assert.equal(JSON.parse(readFileSync(join(tree, '.neil-dev.worktree.json'), 'utf8')).resources['dev-servers'].web.pid, started.pid)
})

test('dev-servers start refuses a ready path that exists before the server starts', t => {
  const tree = worktree(t, { devServers: { web: { command: 'sleep 30', port: 4997, ready: 'ready.flag', timeout: 2 } } })
  writeFileSync(join(tree, 'ready.flag'), '')
  const result = run(['project', 'dev-servers', 'start', 'web'], tree)
  assert.notEqual(result.status, 0)
  const output = result.stderr + result.stdout
  for (const part of ['web', 'ready.flag', 'already exists']) assert.ok(output.includes(part), `${output} does not include ${part}`)
})
