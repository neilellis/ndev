import type { EngineInterface } from 'claude-code'

import type { LoadedConfig } from './config'
import { makeRun, orca } from './fix-all-prs'

// /dev remote: which of Orca's saved servers this project uses as its remote machine, and the one matcher of a server
// by id, id prefix or name. A saved server is an entry in this machine's Orca, so the setting is this machine's too: it
// lives in ~/.config/ndev/remote.json, keyed by the project's GitHub repository (the project folder when it has none),
// so every checkout and worktree of the project shares it and no commit can carry it.
export type Server = { id: string; name: string }
type Saved = Server & { savedAt?: string }
type Store = { projects: Record<string, Saved> }

// The words after /dev remote that are subcommands, never server names. A server with one of these names is saved by its id.
export const REMOTE_WORDS = ['list', 'off', 'create', 'remove'] as const
export const REMOTE_ARGUMENT_HINT = `remote [<server>|${REMOTE_WORDS.join('|')}]`
export const REMOTE_HELP = [
  '  /dev remote [<server>]              show the Orca server this project uses as its remote machine, or save one by name or id',
  '  /dev remote list                    list Orca\'s saved servers and mark the one this project uses',
  '  /dev remote off                     clear the setting; /dev triage start --remote then needs the only saved server, or a name',
]

async function storePath($: EngineInterface): Promise<string> {
  const home = await $.env.get('HOME')
  if (!home) throw new Error('HOME is not set, so the /dev remote setting (~/.config/ndev/remote.json) cannot be found.\nRepair: start Claude Code with HOME set.')
  return `${home}/.config/ndev/remote.json`
}

// The key of the project's setting: its GitHub repository, else its folder.
function projectKey(project: LoadedConfig | undefined): string {
  if (project === undefined) throw new Error('the project folder is not known yet.\nRepair: run the command again once the session has started in the project.')
  if (project.error) throw new Error(`${project.path} has an error (${project.error}).\nRepair: fix the file, then run the command again.`)
  return project.config.github?.repo ?? project.root
}

async function readStore($: EngineInterface, path: string): Promise<Store> {
  if (!(await $.fs.exists(path))) return { projects: {} }
  let raw: unknown
  try {
    raw = JSON.parse(await $.fs.read(path))
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${String(error).slice(0, 160)}).\nRepair: fix or delete the file, then run /dev remote <server> again.`)
  }
  const projects = (raw as { projects?: unknown } | null)?.projects
  const bad = typeof projects !== 'object' || projects === null || Array.isArray(projects)
    || Object.entries(projects).some(([, s]) => typeof (s as Saved)?.id !== 'string' || typeof (s as Saved)?.name !== 'string')
  if (bad) throw new Error(`${path} does not hold { "projects": { "<owner/repo>": { "id": "<server id>", "name": "<server name>" } } }.\nRepair: fix or delete the file, then run /dev remote <server> again.`)
  return { projects: projects as Record<string, Saved> }
}

async function writeStore($: EngineInterface, path: string, store: Store): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf('/'))
  const made = await $.process.run(['mkdir', '-p', dir], { timeoutMs: 10_000 })
  if (made.exitCode !== 0) throw new Error(`mkdir -p ${dir} exited ${made.exitCode}: ${(made.stderr.trim() || made.stdout.trim()).slice(0, 200)}\nRepair: make the folder writable, then run the command again.`)
  await $.fs.write(path, `${JSON.stringify(store, null, 2)}\n`)
}

// The server saved for the project, or undefined when none is.
export async function savedRemote($: EngineInterface, project: LoadedConfig | undefined): Promise<Saved | undefined> {
  return (await readStore($, await storePath($))).projects[projectKey(project)]
}

// Orca's saved servers, as `orca environment list` answers them.
export async function orcaServers($: EngineInterface): Promise<Server[]> {
  const listed = (await orca(makeRun($, 60_000), ['environment', 'list'])) as { environments?: Server[] }
  return listed.environments ?? []
}

const each = (servers: Server[]) => servers.map(s => `${s.name} (${s.id})`).join(', ') || 'none'

// The saved Orca server named by its id, the start of its id, or its name; the only one saved when none is named. A
// name that matches none, or no name when several or none are saved, is refused with the list. `what` begins each
// message and `again` is the command its repair names, with <server> after it.
export async function remoteServer($: EngineInterface, wanted: string, what = '--remote', again = '/dev triage start --remote'): Promise<Server> {
  const servers = await orcaServers($)
  if (!servers.length) throw new Error(`${what}: Orca has no saved server.\nRepair: pair a server in Orca (Settings → Remote servers), then run ${again}${wanted ? ` ${wanted}` : ''} again.`)
  if (!wanted) {
    if (servers.length === 1) return servers[0]!
    throw new Error(`${what}: Orca has ${servers.length} saved servers: ${each(servers)}.\nRepair: name one, as in ${again} <server>.`)
  }
  const found = servers.filter(s => s.id === wanted || s.name === wanted)
  const byPrefix = found.length ? found : servers.filter(s => s.id.startsWith(wanted))
  if (byPrefix.length === 1) return byPrefix[0]!
  throw new Error(`${what}: ${byPrefix.length ? `"${wanted}" names more than one saved server` : `Orca has no saved server "${wanted}"`}. The saved servers: ${each(servers)}.\nRepair: run ${again} <server> with one of them, by name or id.`)
}

const stale = (key: string, s: Saved, servers: Server[]) =>
  `the remote server saved for ${key}, ${s.name} (${s.id}), is no longer in Orca: Orca no longer has a saved server with that id. Orca's saved servers: ${each(servers)}.`
const STALE_REPAIR = 'Repair: run /dev remote <server> to save another, or /dev remote off to clear it.'

// The server for /dev triage start --remote: the one named, else the one /dev remote saved, else the only one Orca
// has. A saved server that Orca no longer has is refused; it never falls back to another.
export async function triageRemote($: EngineInterface, project: LoadedConfig | undefined, wanted: string): Promise<Server> {
  if (wanted) return remoteServer($, wanted)
  const saved = await savedRemote($, project)
  if (!saved) return remoteServer($, '')
  const servers = await orcaServers($)
  const now = servers.find(s => s.id === saved.id)
  if (!now) throw new Error(`--remote: ${stale(projectKey(project), saved, servers)}\n${STALE_REPAIR} Or name one, as in /dev triage start --remote <server>.`)
  return now
}

// /dev remote <args>; register.ts dispatches it.
export async function remoteCommand($: EngineInterface, args: string, project: LoadedConfig | undefined): Promise<{ text: string }> {
  try {
    return { text: await run($, args.trim().split(/\s+/).filter(Boolean), project) }
  } catch (error) {
    return { text: `/dev remote ${args.trim()}`.trim() + ` failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

async function run($: EngineInterface, words: string[], project: LoadedConfig | undefined): Promise<string> {
  const [first = '', ...rest] = words
  const word = first.toLowerCase()
  const key = projectKey(project)
  const path = await storePath($)
  if (word === 'create' || word === 'remove') {
    return `/dev remote ${word} is not built yet: it is reserved for making and deleting a server, so "${word}" is never taken as a server name. To save a server that Orca already has, run /dev remote <server>.`
  }
  if (rest.length) return `/dev remote takes one server, by name or id, and got "${words.join(' ')}". Nothing changed. Use /dev remote <server>, /dev remote list or /dev remote off.`
  const store = await readStore($, path)
  const saved = store.projects[key]
  if (word === 'off') {
    if (!saved) return `No remote server was set for ${key}; nothing changed.`
    delete store.projects[key]
    await writeStore($, path, store)
    return `The remote server for ${key} is cleared (it was ${saved.name} (${saved.id})). Saved in ${path}.`
  }
  if (word === 'list') {
    const servers = await orcaServers($)
    const rows = servers.map(s => `  ${s.id === saved?.id ? '*' : ' '} ${s.name}  ${s.id}${s.id === saved?.id ? `  (saved for ${key})` : ''}`)
    const gone = saved && !servers.some(s => s.id === saved.id) ? [`Orca no longer has the server saved for ${key}, ${saved.name} (${saved.id}). ${STALE_REPAIR}`] : []
    return [servers.length ? `Orca's saved servers:` : 'Orca has no saved server. Pair one in Orca (Settings → Remote servers).', ...rows, ...gone].join('\n')
  }
  if (word === '') {
    let servers: Server[]
    try {
      servers = await orcaServers($)
    } catch (error) {
      const what = saved ? `The remote server for ${key} is ${saved.name} (${saved.id})` : `No remote server is set for ${key}`
      return `${what}. Orca was not read, so it is not known whether Orca still has it: ${error instanceof Error ? error.message : String(error)}`
    }
    if (!saved) return `No remote server is set for ${key}. Orca's saved servers: ${each(servers)}. Set one with /dev remote <server>; /dev triage start --remote then uses it.`
    if (!servers.some(s => s.id === saved.id)) return `Error: ${stale(key, saved, servers)}\n${STALE_REPAIR}`
    return `The remote server for ${key} is ${saved.name} (${saved.id}); Orca still has it. /dev triage start --remote uses it. /dev remote off clears it. Saved in ${path} (this machine only).`
  }
  const server = await remoteServer($, first, '/dev remote', '/dev remote')
  store.projects[key] = { id: server.id, name: server.name, savedAt: new Date(await $.clock.now()).toISOString() }
  await writeStore($, path, store)
  return `The remote server for ${key} is now ${server.name} (${server.id}). Saved in ${path} (this machine only, never committed). /dev triage start --remote uses it.`
}
