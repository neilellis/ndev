import { createHash, randomUUID } from 'node:crypto'
import { confirm } from '../export/flow/public.ts'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { remoteServer, triageRemote } from '../../hooks/remote-selection.ts'
import { createHost, removeHost } from '../../hooks/remote-host.ts'
import { resizeHost } from '../../hooks/remote-resize.ts'
import { importHost } from '../../hooks/remote-import.ts'
import { orcaServers, projectKey, readStore, storePath, writeStore } from '../../hooks/remote-store.ts'
import { makeRun, orca } from '../../hooks/remote-orca.ts'
import { argsFor, atomicJson, CliError, gitWorkspace, locked, readObject, releaseRoot, run, stateRoot } from './common.mjs'
import { readConfigText } from './config-file.mjs'
import { readProject } from './project.mjs'

function host(root) {
  const store = join(process.env.HOME, '.config/ndev/remote.json')
  let snapshot = {}
  const fs = {
    exists: existsSync, list: path => readdirSync(path, { withFileTypes: true }),
    read(path) {
      const data = readFileSync(path, 'utf8')
      if (path === store) snapshot = JSON.parse(data)
      return data
    },
    write(path, text) {
      if (path !== store) return writeFileSync(path, text, { mode: 0o600 })
      mkdirSync(dirname(path), { recursive: true })
      locked(path, () => {
        const current = readObject(path, { missing: {} })
        if (!isDeepStrictEqual(current, snapshot)) throw new CliError(5, `Remote record changed at ${path}.`, { repair: 'Run ndev remote status before retrying.' })
        const data = JSON.parse(text)
        snapshot = { ...current, ...data, hosts: data.hosts ?? {} }
        atomicJson(path, snapshot)
      })
    },
  }
  return {
    fs, env: { get: key => process.env[key] }, clock: { now: Date.now }, plugin: { root: releaseRoot },
    ui: { toast: text => console.error(text) },
    process: { run: ([exe, ...argv], options = {}) => {
      const result = run(exe, argv, { cwd: options.cwd ?? root, input: options.stdin, env: { ...process.env, ...options.env }, timeout: options.timeoutMs })
      return { ...result, exitCode: result.status }
    } },
  }
}

function context(cwd) {
  const { root } = gitWorkspace(cwd)
  return { root, engine: host(root), project: { root, config: readProject(root), path: readConfigText(root).path } }
}

export async function resolveRemote(wanted = '', { root = process.cwd(), repo, selector } = {}) {
  const { engine, project } = context(root)
  const server = await triageRemote(engine, project, wanted, '--remote', 'ndev remote set')
  if (!repo && !selector) return server
  if (selector && !/^(?:id|name|path):.+/.test(selector)) throw new CliError(2, `Invalid Orca repository selector ${selector}.`)
  const listed = await orca(makeRun(engine, 60000), ['repo', 'list', '--environment', server.id])
  const matches = listed.repos.filter(r => selector
    ? [`id:${r.id}`, `name:${r.displayName}`, `path:${r.path}`].includes(selector)
    : r.gitRemoteIdentity?.canonicalKey?.toLowerCase() === `github.com/${repo.toLowerCase()}` || r.projectId === `github:${repo.toLowerCase()}`)
  if (matches.length !== 1) throw new CliError(1, `Orca server ${server.id} returned ${matches.length} repositories matching ${selector ?? repo}.`, { repair: `Run orca repo list --environment ${server.id} --json and name an exact repository selector.` })
  return { id: server.id, name: server.name, repoId: matches[0].id, repoSelector: `id:${matches[0].id}` }
}

function removalJournal() {
  const dir = join(stateRoot(), 'remote-removals')
  const fileFor = (ctx, name, server) => join(dir, createHash('sha256').update(JSON.stringify([ctx, name, server])).digest('hex') + '.json')
  let active
  function update(fn) {
    return locked(active.file, () => {
      const row = readObject(active.file)
      if (row.owner !== process.pid || row.token !== active.token) throw new CliError(5, `Removal ownership changed at ${active.file}.`)
      fn(row)
      atomicJson(active.file, row)
    })
  }
  return {
    read(ctx, name, server) {
      return readObject(fileFor(ctx, name, server), { missing: {} })
    },
    claim(ctx, name, server, hostKey) {
      const file = fileFor(ctx, name, server)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      return locked(file, () => {
        const row = readObject(file, { missing: { ctx, name, server, token: randomUUID(), hostKey } })
        if (row.owner) {
          let alive = true
          try { process.kill(row.owner, 0) } catch (error) {
            if (error.code !== 'ESRCH') throw error
            alive = false
          }
          if (alive) throw new CliError(5, `Removal of ${name} (${server}) in ${ctx} is running in process ${row.owner}.`, { repair: 'Wait for that removal to finish before retrying.' })
        }
        row.owner = process.pid
        atomicJson(file, row)
        active = { file, token: row.token }
        return { token: row.token, requested: !!row.requested, file }
      })
    },
    request() { update(row => { row.requested = true }) },
    deleting(snapshot, prune) { update(row => { row.snapshot = snapshot; row.prune = prune }) },
    complete() { update(row => { row.complete = true }) },
    release() { if (active) update(row => { delete row.owner }) },
  }
}

const string = { type: 'string' }
const boolean = { type: 'boolean' }
const cloud = {
  create: { fn: createHost, options: ['context', 'type', 'location', 'ssh-key', 'floating-ip'] },
  remove: { fn: removeHost, options: ['context', 'floating-ip', 'forget', 'unverified-host'] },
  import: { fn: importHost, options: ['context', 'floating-ip', 'name'] },
  resize: { fn: resizeHost, options: ['context', 'server', 'ssh', 'agent'] },
}

export async function runRemote([verb, ...args]) {
  const repair = `ndev remote ${verb} --help`
  const { engine, project } = context(process.cwd())
  if (Object.hasOwn(cloud, verb)) {
    const spec = cloud[verb]
    const schema = Object.fromEntries([...spec.options, 'yes'].map(name => [name, ['yes', 'forget', 'unverified-host'].includes(name) ? boolean : string]))
    const { values, positionals: [target] } = argsFor(args, schema, repair, { positionals: 1 })
    if (!target && verb !== 'resize') throw new CliError(2, `Name the remote ${verb} target.`, { repair })
    const options = { ...values, sshKey: values['ssh-key'], floatingIp: values['floating-ip'], isForget: !!values.forget, isUnverifiedHost: !!values['unverified-host'], isYes: !!values.yes }
    const journal = verb === 'remove' ? removalJournal() : undefined
    options.removalJournal = journal
    let next
    options.requestConfirmation = text => {
      const digest = createHash('sha256').update(text).digest('hex').slice(0, 12)
      if (process.stdin.isTTY && !process.argv.includes('--json')) console.error(text)
      const answer = confirm('remote ' + verb, target ?? 'server', digest, project.root, process.argv.includes('--json'))
      if (answer) { next = { ...answer, question: text }; throw new Error(text) }
    }
    try {
      return { text: (await spec.fn(engine, project, target, options)).replaceAll('/dev remote', 'ndev remote') }
    } catch (error) {
      if (next) return next
      throw error
    } finally {
      journal?.release()
    }
  }
  const { positionals: [wanted] } = argsFor(args, {}, repair, { positionals: verb === 'set' ? 1 : 0 })
  const path = await storePath(engine)
  const store = await readStore(engine, path)
  const key = projectKey(project)
  const saved = store.projects[key]
  if (verb === 'off') {
    if (saved) { delete store.projects[key]; await writeStore(engine, path, store) }
    return { project: key, server: null }
  }
  if (verb === 'set') {
    if (!wanted) throw new CliError(2, 'Name an Orca server.', { repair })
    const server = await remoteServer(engine, wanted, 'ndev remote set', 'ndev remote set', project.root)
    store.projects[key] = { id: server.id, name: server.name, savedAt: new Date().toISOString() }
    await writeStore(engine, path, store)
    return { project: key, server, path }
  }
  const servers = await orcaServers(engine)
  const stale = saved && !servers.some(s => s.id === saved.id)
  if (verb === 'list') {
    const marked = servers.map(s => ({ ...s, saved: s.id === saved?.id }))
    const text = [
      servers.length ? "Orca's saved servers:" : 'Orca has no saved server. Pair one in Orca (Settings, Remote servers).',
      ...marked.map(s => `  ${s.saved ? '*' : ' '} ${s.name}  ${s.id}${s.saved ? `  (saved for ${key})` : ''}`),
      ...(stale ? [`Orca no longer has the server saved for ${key}, ${saved.name} (${saved.id}). Run ndev remote set <server> or ndev remote off.`] : []),
    ].join('\n')
    return { project: key, servers: marked, saved: saved ?? null, stale: !!stale, text }
  }
  if (stale) throw new CliError(1, `Saved server ${saved.name} (${saved.id}) is missing from Orca.`, { repair: 'Run ndev remote set <server> or ndev remote off.' })
  return { project: key, server: saved ?? null }
}
