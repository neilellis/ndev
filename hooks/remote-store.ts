import type { EngineInterface } from 'claude-code'

import type { LoadedConfig } from './config'
import { makeRun, orca } from './remote-orca.ts'

// The /dev remote record of this machine, ~/.config/ndev/remote.json. A saved Orca server is an entry in this
// machine's Orca, and the host key of a server ndev made is what this machine trusts, so both live here, never in a
// commit. `projects`: the Orca server each project uses as its remote machine, keyed by its GitHub repository (the
// project folder when it has none). `hosts`: each Hetzner server /dev remote create made, by name: the hcloud context
// (the Hetzner project that pays), the SSH key it was made with, its floating IP (the id, and the address, which is
// the remote's address), and the host key the first
// build recorded, or the one a person confirmed at /dev remote import. The snapshot carries that host key, so a
// restore trusts only it. `imported`: /dev remote import wrote the record, so /dev remote remove first checks over SSH
// that the server still presents that host key.
export type Server = { id: string; name: string }
export type Saved = Server & { savedAt?: string }
export type HostRecord = { context: string; sshKey?: string; floatingIp?: number; ip?: string; hostKey?: string; imported?: boolean }
export type Store = { projects: Record<string, Saved>; hosts: Record<string, HostRecord> }

export async function storePath($: EngineInterface): Promise<string> {
  const home = await $.env.get('HOME')
  if (!home) throw new Error('HOME is not set, so the /dev remote setting (~/.config/ndev/remote.json) cannot be found.\nRepair: start Claude Code with HOME set.')
  return `${home}/.config/ndev/remote.json`
}

// The key of the project's setting: its GitHub repository, else its folder.
export function projectKey(project: LoadedConfig | undefined): string {
  if (project === undefined) throw new Error('the project folder is not known yet.\nRepair: run the command again once the session has started in the project.')
  if (project.error) throw new Error(`${project.path} has an error (${project.error}).\nRepair: fix the file, then run the command again.`)
  return project.config.github?.repo ?? project.root
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export async function readStore($: EngineInterface, path: string): Promise<Store> {
  if (!(await $.fs.exists(path))) return { projects: {}, hosts: {} }
  let raw: unknown
  try {
    raw = JSON.parse(await $.fs.read(path))
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${String(error).slice(0, 160)}).\nRepair: fix or delete the file, then run /dev remote <server> again.`)
  }
  const projects = (raw as { projects?: unknown } | null)?.projects
  const hosts = (raw as { hosts?: unknown } | null)?.hosts ?? {}
  const bad = !isObject(projects) || Object.values(projects).some(s => !isObject(s) || typeof s.id !== 'string' || typeof s.name !== 'string')
  if (bad) throw new Error(`${path} does not hold { "projects": { "<owner/repo>": { "id": "<server id>", "name": "<server name>" } } }.\nRepair: fix or delete the file, then run /dev remote <server> again.`)
  const badHost = !isObject(hosts) ? 'it is not an object' : Object.entries(hosts).map(([name, h]) => (!isObject(h) || typeof h.context !== 'string' ? name : '')).find(Boolean)
  if (badHost) throw new Error(`${path}: "hosts" ${badHost === 'it is not an object' ? badHost : `entry "${badHost}" has no hcloud "context"`}.\nRepair: fix the file (each host is { "context": "<hcloud context>", ... }), then run the command again.`)
  return { projects: projects as Record<string, Saved>, hosts: hosts as Record<string, HostRecord> }
}

export async function writeStore($: EngineInterface, path: string, store: Store): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf('/'))
  const made = await $.process.run(['mkdir', '-p', dir], { timeoutMs: 10_000 })
  if (made.exitCode !== 0) throw new Error(`mkdir -p ${dir} exited ${made.exitCode}: ${(made.stderr.trim() || made.stdout.trim()).slice(0, 200)}\nRepair: make the folder writable, then run the command again.`)
  const hosts = Object.keys(store.hosts).length ? { hosts: store.hosts } : {}
  await $.fs.write(path, `${JSON.stringify({ projects: store.projects, ...hosts }, null, 2)}\n`)
}

// Orca's saved servers, as `orca environment list` answers them.
export async function orcaServers($: EngineInterface): Promise<Server[]> {
  const listed = (await orca(makeRun($, 60_000), ['environment', 'list'])) as { environments?: Server[] }
  return listed.environments ?? []
}

// Orca names the saved server of a recipe "<recipe id> VM <id>", so a server is found by the short name too.
export const namedFor = (servers: Server[], name: string) => servers.filter(s => s.name === name || s.name.startsWith(`${name} VM `))

export const each = (servers: Server[]) => servers.map(s => `${s.name} (${s.id})`).join(', ') || 'none'
