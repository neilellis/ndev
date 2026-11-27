import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { validate } from '../../hooks/config.ts'
import { argsFor, checked, CliError, isAlive, readObject, worktreeScript } from './common.mjs'
import { readConfigObject } from './config-file.mjs'

const DEFAULT_TIMEOUT = 60
const LOG_TAIL = 20

export function devServers(root) {
  const { path, config } = readConfigObject(root)
  const error = validate(config)
  if (error) throw new CliError(1, `${path}: ${error}`, { repair: `Fix ${path} and retry.` })
  return { path, servers: config.devServers ?? {} }
}

const isUrl = ready => /^https?:\/\//.test(ready)

function logFile(root, name) {
  const result = spawnSync('git', ['-C', root, 'rev-parse', '--git-path', `ndev-dev-servers/${name}.log`], { encoding: 'utf8' })
  if (result.status !== 0) throw new CliError(1, `git rev-parse --git-path in ${root} exited ${result.status}: ${result.stderr.trim()}`, { repair: 'Run the command inside a git worktree.' })
  return resolve(root, result.stdout.trim())
}

export function tail(file) {
  if (!existsSync(file)) return '(no log)'
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
  return lines.slice(-LOG_TAIL).join('\n') || '(empty log)'
}

async function answers(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'manual' })
    return response.status < 500
  } catch {
    return false
  }
}

function stop(pid) {
  try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch {} }
}

export async function stopAndWait(pid, seconds = 10) {
  stop(pid)
  const deadline = Date.now() + seconds * 1000
  while (isAlive(pid)) {
    if (Date.now() >= deadline) {
      try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch {} }
      await sleep(250)
      if (isAlive(pid)) throw new CliError(1, `Process ${pid} is still alive after SIGTERM and SIGKILL.`, { repair: `kill -9 ${pid}` })
      return
    }
    await sleep(100)
  }
}

export async function start(root, name, { record = true } = {}) {
  const { path, servers } = devServers(root)
  const server = servers[name]
  if (!server) throw new CliError(2, `No dev server ${JSON.stringify(name)} in ${path}. Configured: ${Object.keys(servers).join(', ') || 'none'}.`, { repair: `Add "devServers.${name}" to ${path}, or run ndev project dev-servers to list the servers.` })
  const cwd = join(root, server.cwd ?? '.')
  if (!existsSync(cwd)) throw new CliError(1, `Dev server ${name}: the folder ${cwd} does not exist.`, { repair: `Fix "devServers.${name}.cwd" in ${path}.` })
  const recorded = readObject(join(root, '.neil-dev.worktree.json'), { missing: {} }).resources?.['dev-servers']?.[name]
  if (recorded && isAlive(recorded.pid)) throw new CliError(1, `Dev server ${name} already runs in ${root} as pid ${recorded.pid} (port ${recorded.port}), so it was not started again.`, { repair: `${worktreeScript} stop --name ${name}, then run ndev project dev-servers start ${name} again.` })
  const ready = isUrl(server.ready) ? () => answers(server.ready) : async () => existsSync(resolve(cwd, server.ready))
  if (await ready()) {
    throw isUrl(server.ready)
      ? new CliError(1, `Dev server ${name}: ${server.ready} already answers before the server starts, so a ready check would pass for the wrong process. Something else holds port ${server.port}.`, { repair: `Stop the process on port ${server.port} (lsof -i :${server.port}), then run ndev project dev-servers start ${name} again.` })
      : new CliError(1, `Dev server ${name}: the ready path ${resolve(cwd, server.ready)} already exists before the server starts, so a ready check would pass at once.`, { repair: `Delete ${resolve(cwd, server.ready)}, then run ndev project dev-servers start ${name} again.` })
  }
  const log = logFile(root, name)
  mkdirSync(dirname(log), { recursive: true })
  const fd = openSync(log, 'w')
  const child = spawn('sh', ['-c', server.command], { cwd, env: { ...process.env, ...server.env }, detached: true, stdio: ['ignore', fd, fd] })
  closeSync(fd)
  let exit
  child.on('exit', (code, signal) => { exit = signal ? `was stopped by ${signal}` : `exited ${code}` })
  const spawned = await new Promise(done => { child.once('spawn', () => done(undefined)); child.once('error', done) })
  if (spawned) throw new CliError(1, `Dev server ${name} (${server.command}) did not start: ${spawned.message}`, { repair: `Check "devServers.${name}.command" in ${path}.` })
  child.unref()
  const seconds = server.timeout ?? DEFAULT_TIMEOUT
  const deadline = Date.now() + seconds * 1000
  const failure = (what, repair) => new CliError(1, `Dev server ${name} (${server.command}, in ${cwd}) ${what}. The end of its log ${log}:\n${tail(log)}`, { repair, details: { name, command: server.command, ready: server.ready, log } })
  for (;;) {
    if (exit) throw failure(`${exit} before it was ready at ${server.ready}`, `Run ${server.command} in ${cwd} to see the fault, fix it, then run ndev project dev-servers start ${name} again.`)
    if (await ready()) {
      await sleep(50)
      if (!exit) break
      continue
    }
    if (Date.now() >= deadline) {
      stop(child.pid)
      throw failure(`was not ready after ${seconds} s: ${server.ready} ${isUrl(server.ready) ? 'did not answer' : 'does not exist'}. It was stopped`, `Check that "devServers.${name}.ready" names what the server serves, or raise "devServers.${name}.timeout" in ${path}.`)
    }
    await sleep(250)
  }
  if (record) try {
    checked(worktreeScript, ['add-dev-server', '--name', name, '--pid', String(child.pid), '--port', String(server.port), '--cwd', cwd], { cwd: root, repair: `The server was stopped. Fix the fault above, then run ndev project dev-servers start ${name} again.` })
  } catch (error) {
    stop(child.pid)
    throw error
  }
  const url = isUrl(server.ready) ? server.ready : `http://localhost:${server.port}/`
  return { name, pid: child.pid, port: server.port, url, cwd, log, routes: server.routes ?? [], text: `Dev server ${name} is ready at ${url} (pid ${child.pid}). Log: ${log}` }
}

export async function runDevServers(root, argv, repair) {
  if (argv[0] === 'start') {
    const { positionals } = argsFor(argv.slice(1), {}, repair, { positionals: 1 })
    if (!positionals[0]) throw new CliError(2, 'Name the dev server to start.', { repair })
    return start(root, positionals[0])
  }
  argsFor(argv, {}, repair)
  const { path, servers } = devServers(root)
  const listed = Object.entries(servers).map(([name, server]) => ({ name, ...server }))
  return {
    path,
    servers: listed,
    text: listed.length === 0 ? `No dev servers in ${path}. Add them under "devServers".` : listed.map(s => `${s.name}: ${s.command} (port ${s.port}, ready ${s.ready})`).join('\n'),
  }
}
