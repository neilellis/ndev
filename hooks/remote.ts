import type { EngineInterface } from 'claude-code'

import type { LoadedConfig } from './config'
import { createHost, type HostOptions, REMOTE_HOST_HELP, removeHost } from './remote-host'
import { importHost } from './remote-import'
import { each, namedFor, orcaServers, projectKey, readStore, type Saved, type Server, storePath, writeStore } from './remote-store'

export { orcaServers, type Server }

// /dev remote: which of Orca's saved servers this project uses as its remote machine, and the one matcher of a server
// by id, id prefix or name. A saved server is an entry in this machine's Orca, so the setting is this machine's too: it
// lives in ~/.config/ndev/remote.json (remote-store.ts), keyed by the project's GitHub repository (the project folder
// when it has none), so every checkout and worktree of the project shares it and no commit can carry it.
// /dev remote create and remove make and delete a Hetzner Cloud server for it (remote-host.ts), and /dev remote import
// hands them a server that was made by hand (remote-import.ts).

// The words after /dev remote that are subcommands, never server names. A server with one of these names is saved by its id.
export const REMOTE_WORDS = ['list', 'off', 'create', 'remove', 'import'] as const
export const REMOTE_ARGUMENT_HINT = 'remote [<server>|list|off|create <name>|remove <name>|import <hetzner-id>]'
export const REMOTE_HELP = [
  '  /dev remote [<server>]              show the Orca server this project uses as its remote machine, or save one by name, recipe id or id',
  '  /dev remote list                    list Orca\'s saved servers and mark the one this project uses',
  '  /dev remote off                     clear the setting; /dev triage start --remote then needs the only saved server, or a name',
  ...REMOTE_HOST_HELP,
]

// The server saved for the project, or undefined when none is.
export async function savedRemote($: EngineInterface, project: LoadedConfig | undefined): Promise<Saved | undefined> {
  return (await readStore($, await storePath($))).projects[projectKey(project)]
}

// The recipe guide that /dev remote create prints too.
const RECIPE_GUIDE = 'orca skills get orca-per-workspace-env --reference ssh-host'

// The environmentRecipes entry with this id in the orca.yaml of the project's primary checkout, which is where Orca
// reads recipes. Only the id and the display name are read, line by line: the plugin has no YAML parser.
async function recipeOf($: EngineInterface, root: string, id: string): Promise<{ file: string; display?: string; unread?: string }> {
  let primary = root
  try {
    const listed = await $.process.run(['git', '-C', root, 'worktree', 'list', '--porcelain'], { timeoutMs: 15_000 })
    primary = listed.exitCode === 0 ? (/^worktree (.+)$/m.exec(listed.stdout)?.[1] ?? root) : root
  } catch {
    // The project folder itself is then the one read.
  }
  const file = `${primary}/orca.yaml`
  let text: string
  try {
    if (!(await $.fs.exists(file))) return { file }
    text = await $.fs.read(file)
  } catch (error) {
    return { file, unread: error instanceof Error ? error.message : String(error) }
  }
  const found = recipes(text).find(r => r.id === id)
  return found ? { file, display: found.name ?? id } : { file }
}

// The id and name of each entry under the top-level key environmentRecipes. A top-level key starts at column 0 with
// neither "-" nor "#"; an entry starts with "- " at the indent of the first one; only the fields at the entry's own
// indent are its id and name, in either order.
function recipes(text: string): { id?: string; name?: string }[] {
  const plain = (v: string) => v.trim().replace(/\s+#.*$/, '').replace(/^(["'])(.*)\1$/, '$2')
  const all: { id?: string; name?: string }[] = []
  let isIn = false
  let dash = -1
  for (const line of text.split('\n')) {
    if (/^[^\s#-]/.test(line)) {
      isIn = /^environmentRecipes:\s*(#.*)?$/.test(line)
      dash = -1
      continue
    }
    if (!isIn || !line.trim() || line.trim().startsWith('#')) continue
    const entry = /^(\s*)-\s+/.exec(line)
    if (entry && (dash === -1 || entry[1]!.length === dash)) {
      dash = entry[1]!.length
      all.push({})
    }
    const now = all.at(-1)
    if (!now) continue
    const isOwn = entry ? entry[1]!.length === dash : line.search(/\S/) === dash + 2
    const field = isOwn ? /^(id|name):\s*(.+)$/.exec(line.slice(entry ? entry[0].length : dash + 2)) : null
    if (field) now[field[1] as 'id' | 'name'] = plain(field[2]!)
  }
  return all
}

// The saved Orca server named by its id, its name, the recipe id that begins its name ("<name> VM <id>"), or the
// start of its id; the only one saved when none is named. A name that matches none or several, or no name when
// several or none are saved, is refused with the list. `what` begins each message and `again` is the command its
// repair names, with <server> after it. `root` is the project folder: with it, a name that matches none is looked up
// among the recipes of orca.yaml, and the refusal then names the step in the Orca app that saves the server.
export async function remoteServer($: EngineInterface, wanted: string, what = '--remote', again = '/dev triage start --remote', root?: string): Promise<Server> {
  const servers = await orcaServers($)
  if (!servers.length) throw new Error(`${what}: Orca has no saved server.\nRepair: pair a server in Orca (Settings → Remote servers), then run ${again}${wanted ? ` ${wanted}` : ''} again.`)
  if (!wanted) {
    if (servers.length === 1) return servers[0]!
    throw new Error(`${what}: Orca has ${servers.length} saved servers: ${each(servers)}.\nRepair: name one, as in ${again} <server>.`)
  }
  const byId = servers.find(s => s.id === wanted)
  if (byId) return byId
  const named = namedFor(servers, wanted)
  if (named.length === 1) return named[0]!
  if (named.length > 1) throw new Error(`${what}: "${wanted}" names ${named.length} saved servers: ${each(named)}.\nRepair: run ${again} <server> with the id of one of them.`)
  const byPrefix = servers.filter(s => s.id.startsWith(wanted))
  if (byPrefix.length === 1) return byPrefix[0]!
  if (byPrefix.length > 1) throw new Error(`${what}: "${wanted}" names more than one saved server. The saved servers: ${each(servers)}.\nRepair: run ${again} <server> with one of them, by name or id.`)
  const none = `${what}: Orca has no saved server "${wanted}". The saved servers: ${each(servers)}.\nRepair: run ${again} <server> with one of them, by name or id.`
  if (root === undefined) throw new Error(none)
  const recipe = await recipeOf($, root, wanted)
  if (recipe.display !== undefined) throw new Error(`${what}: Orca has no saved server for "${wanted}" yet. ${recipe.file} has the environmentRecipes entry ${wanted}, and Orca saves its server ("${wanted} VM <id>") only when a workspace is made on the recipe in the Orca app; its CLI cannot save one. The saved servers: ${each(servers)}.\nRepair: in the Orca app: New workspace, then Run on, then "${recipe.display}". Then run ${again} ${wanted} again.`)
  throw new Error(`${none}\n${recipe.unread ? `${recipe.file} was not read (${recipe.unread}), so it is not known whether it has a recipe for ${wanted}` : `${recipe.file} has no environmentRecipes entry with the id ${wanted}`}. To make a server of that name: add the entry there, on the default branch (guide: ${RECIPE_GUIDE}); then in the Orca app: New workspace, then Run on, then that recipe; then run ${again} ${wanted} again.`)
}

const stale = (key: string, s: Saved, servers: Server[]) =>
  `the remote server saved for ${key}, ${s.name} (${s.id}), is no longer in Orca: Orca no longer has a saved server with that id. Orca's saved servers: ${each(servers)}.`
const STALE_REPAIR = 'Repair: run /dev remote <server> to save another, or /dev remote off to clear it.'

// The server for /dev triage start --remote: the one named, else the one /dev remote saved, else the only one Orca
// has. A saved server that Orca no longer has is refused; it never falls back to another.
// The epic takes the same server for its workers (epicStarted with remote); `what` and `again` then name that call.
export async function triageRemote($: EngineInterface, project: LoadedConfig | undefined, wanted: string, what = '--remote', again = '/dev triage start --remote'): Promise<Server> {
  if (wanted) return remoteServer($, wanted, what, again, project?.root)
  const saved = await savedRemote($, project)
  if (!saved) return remoteServer($, '', what, again)
  const servers = await orcaServers($)
  const now = servers.find(s => s.id === saved.id)
  if (!now) throw new Error(`${what}: ${stale(projectKey(project), saved, servers)}\n${STALE_REPAIR} Or name one, as in ${again} <server>.`)
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

// The options of /dev remote create, remove and import, taken out of the words wherever they stand.
const VALUES = { '--context': 'context', '--type': 'type', '--location': 'location', '--ssh-key': 'sshKey', '--floating-ip': 'floatingIp', '--name': 'name' } as const
// The options that each of the three words does not take.
const NOT_OF = {
  create: ['--forget', '--name'],
  remove: ['--type', '--location', '--ssh-key', '--name'],
  import: ['--type', '--location', '--ssh-key', '--forget'],
} as const
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
    } else if (word.startsWith('--')) throw new Error(`"${word}" is not an option of /dev remote. The options of create are --context, --type, --location, --ssh-key, --floating-ip and --yes; those of remove are --context, --floating-ip, --forget and --yes; those of import are --context, --floating-ip, --name and --yes. Nothing changed.`)
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
  if (word === 'create' || word === 'remove' || word === 'import') {
    if (rest.length > 1) return `/dev remote ${word} takes one ${word === 'import' ? 'Hetzner server id' : 'server name'} and got "${rest.join(' ')}". Nothing changed. Use /dev remote ${word} ${word === 'import' ? '<hetzner-id>' : '<name>'}.`
    const wrong = given.find(o => (NOT_OF[word] as readonly string[]).includes(o))
    if (wrong) return `${wrong} is not an option of /dev remote ${word}. Nothing changed.`
    return word === 'create' ? createHost($, project, rest[0], host) : word === 'remove' ? removeHost($, project, rest[0], host) : importHost($, project, rest[0], host)
  }
  if (given.length) return `${given[0]} is an option of /dev remote create, remove and import only. Nothing changed.`
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
  const server = await remoteServer($, first, '/dev remote', '/dev remote', project?.root)
  store.projects[key] = { id: server.id, name: server.name, savedAt: new Date(await $.clock.now()).toISOString() }
  await writeStore($, path, store)
  return `The remote server for ${key} is now ${server.name} (${server.id}). Saved in ${path} (this machine only, never committed). /dev triage start --remote uses it.`
}
