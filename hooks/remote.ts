import type { EngineInterface } from 'claude-code'

import type { LoadedConfig } from './config'
import { createHost, type HostOptions, REMOTE_HOST_HELP, removeHost } from './remote-host'
import { each, orcaServers, projectKey, readStore, type Saved, type Server, storePath, writeStore } from './remote-store'

export { orcaServers, type Server }

// /dev remote: which of Orca's saved servers this project uses as its remote machine, and the one matcher of a server
// by id, id prefix or name. A saved server is an entry in this machine's Orca, so the setting is this machine's too: it
// lives in ~/.config/ndev/remote.json (remote-store.ts), keyed by the project's GitHub repository (the project folder
// when it has none), so every checkout and worktree of the project shares it and no commit can carry it.
// /dev remote create and remove make and delete a Hetzner Cloud server for it (remote-host.ts).

// The words after /dev remote that are subcommands, never server names. A server with one of these names is saved by its id.
export const REMOTE_WORDS = ['list', 'off', 'create', 'remove'] as const
export const REMOTE_ARGUMENT_HINT = 'remote [<server>|list|off|create <name>|remove <name>]'
export const REMOTE_HELP = [
  '  /dev remote [<server>]              show the Orca server this project uses as its remote machine, or save one by name or id',
  '  /dev remote list                    list Orca\'s saved servers and mark the one this project uses',
  '  /dev remote off                     clear the setting; /dev triage start --remote then needs the only saved server, or a name',
  ...REMOTE_HOST_HELP,
]

// The server saved for the project, or undefined when none is.
export async function savedRemote($: EngineInterface, project: LoadedConfig | undefined): Promise<Saved | undefined> {
  return (await readStore($, await storePath($))).projects[projectKey(project)]
}

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

// The options of /dev remote create and remove, taken out of the words wherever they stand.
const VALUES = { '--context': 'context', '--type': 'type', '--location': 'location', '--ssh-key': 'sshKey', '--floating-ip': 'floatingIp' } as const
function options(all: string[]): { words: string[]; given: string[]; host: HostOptions } {
  const words: string[] = []
  const given: string[] = []
  const host: HostOptions = { isForget: false, isYes: false }
  for (let i = 0; i < all.length; i++) {
    const word = all[i]!
    if (word === '--forget' || word === '--yes') {
      if (word === '--forget') host.isForget = true
      else host.isYes = true
      given.push(word)
    } else if (word in VALUES) {
      const value = all[++i]
      if (!value || value.startsWith('--')) throw new Error(`${word} needs a value, as in ${word} <value>. Nothing changed.`)
      host[VALUES[word as keyof typeof VALUES]] = value
      given.push(word)
    } else if (word.startsWith('--')) throw new Error(`"${word}" is not an option of /dev remote. The options of create are --context, --type, --location, --ssh-key, --floating-ip and --yes; those of remove are --context, --floating-ip, --forget and --yes. Nothing changed.`)
    else words.push(word)
  }
  return { words, given, host }
}

async function run($: EngineInterface, all: string[], project: LoadedConfig | undefined): Promise<string> {
  const { words, given, host } = options(all)
  const [first = '', ...rest] = words
  const word = first.toLowerCase()
  const key = projectKey(project)
  const path = await storePath($)
  if (word === 'create' || word === 'remove') {
    if (rest.length > 1) return `/dev remote ${word} takes one server name and got "${rest.join(' ')}". Nothing changed. Use /dev remote ${word} <name>.`
    const wrong = given.find(o => (word === 'create' ? o === '--forget' : ['--type', '--location', '--ssh-key'].includes(o)))
    if (wrong) return `${wrong} is not an option of /dev remote ${word}. Nothing changed.`
    return word === 'create' ? createHost($, project, rest[0], host) : removeHost($, project, rest[0], host)
  }
  if (given.length) return `${given[0]} is an option of /dev remote create and remove only. Nothing changed.`
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
