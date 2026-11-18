import type { EngineInterface } from 'claude-code'

import type { LoadedConfig } from './config'
import { type HostRecord, namedFor, orcaServers, projectKey, readStore, type Server, type Store, storePath, writeStore } from './remote-store.ts'

// /dev remote create <name> and /dev remote remove <name>: a Hetzner Cloud server that is an SSH host for Orca
// workspaces. remove shuts the server down, snapshots it, and deletes it only once the snapshot is available; create
// restores the newest snapshot of the name, or builds from the base image when there is none. The remote's address
// is a floating IPv4 that remove keeps and create assigns again, so the server type can change and the address and
// host key stay. Everything it makes carries the labels managed-by=ndev and ndev-name=<name>, and it touches nothing
// without them; /dev remote import (remote-import.ts) gives them to a server made by hand. Every hcloud call names its context and runs with no HCLOUD_TOKEN or HCLOUD_CONTEXT.

type RemovalJournal = {
  read(ctx: string, name: string, server: number): { token?: string; hostKey?: string; requested?: boolean; prune?: number[]; snapshot?: number; complete?: boolean }
  claim(ctx: string, name: string, server: number, hostKey?: string): { token: string; requested: boolean; file: string }
  request(): void
  deleting(snapshot: number, prune: number[]): void
  complete(): void
}
export type HostOptions = { removalJournal?: RemovalJournal; requestConfirmation?: (question: string) => void; hasHuman?: () => Promise<boolean>; context?: string; type?: string; location?: string; sshKey?: string; floatingIp?: string; name?: string; server?: string; ssh?: string; agent?: string; isForget: boolean; isUnverifiedHost?: boolean; isYes: boolean }

export const REMOTE_HOST_HELP = [
  '  /dev remote create <name> [options] make a Hetzner Cloud server for Orca: from the snapshot remove kept, else from the base image',
  '        options: --context <hcloud context>  --type <server type>  --location <location>  --ssh-key <key>  --floating-ip <name or id>  --yes',
  '        the address is a floating IPv4; on the server it is set by hand with: ip addr add <floating ip> dev eth0',
  '  /dev remote remove <name> [options] shut the server down, snapshot it, and delete it only once the snapshot is available; an imported server must first prove over SSH (a root sign-in) that it holds its saved host key',
  '        options: --context <hcloud context>  --floating-ip <name or id>  --forget (also delete the snapshot, the floating IP and the firewall)  --unverified-host (remove a server that this machine holds no saved host key for, with no host key check)  --yes',
  '  /dev remote import <hetzner-id> --context <hcloud context> [options] hand a server made by hand to /dev remote: label it, its firewalls and its floating IPv4, and record its host key',
  '        options: --floating-ip <name or id> (when the server has several)  --name <the server\'s Hetzner name>  --yes (only for a host key already in known_hosts)',
  '  /dev remote resize [<type>] [options] change the Hetzner server type of the box under the Orca server: with no type, list the types and recommend one',
  '        it pauses the workers on the box (a WIP commit and ~/handoff/<issue>.md), shuts it down, changes the type with the disk kept, starts it and starts the workers again',
  '        the hcloud context: remote.hcloudContext in .neil-dev.json, or --context <hcloud context>',
  '        options: --context <hcloud context>  --server <Orca server>  --ssh <user@host>  --agent <agent> (for a worker whose agent Orca does not record)  --yes',
]

const DEFAULT_TYPE = 'cx33'
const DEFAULT_LOCATION = 'fsn1'
const BASE_IMAGE = 'ubuntu-24.04'
export const USER = 'orca'
export const SSH_PORT = '22'
const PACKAGES_TIMEOUT_MS = 600_000

export type Labels = Record<string, string>
export type Price = { location: string; price_monthly: { gross: string } }
export type Srv = { id: number; name: string; status: string; labels: Labels; server_type: { name: string; disk: number; prices?: Price[] }; location?: { name: string }; public_net: { ipv4?: { ip: string } | null; firewalls?: { id: number }[] } }
export type Img = { id: number; description: string; created: string; status: string; disk_size: number; image_size: number | null; labels: Labels; architecture?: string }
export type Fip = { id: number; name: string; ip: string; labels: Labels; server: number | null; home_location: { name: string; network_zone?: string } }
export type Applied = { type: string; server?: { id: number }; label_selector?: { selector: string }; applied_to_resources?: { server?: { id: number } }[] }
export type Fw = { id: number; name: string; labels: Labels; rules?: { direction: string; protocol: string; port?: string | null }[]; applied_to?: Applied[] }
export type ServerType = { name: string; disk: number; cores: number; memory: number; architecture?: string; prices: Price[] }
export type Out = { exitCode: number; stdout: string; stderr: string }

// ---- The one runner: hcloud, ssh and the small local commands all go through $.process.run ----

// A command that did not start or outran its time reads as a failed command, with the reason in place of its output.
export async function exec($: EngineInterface, argv: string[], init: { timeoutMs?: number; stdin?: string } = {}): Promise<Out> {
  try {
    return await $.process.run(argv, { timeoutMs: 60_000, ...init })
  } catch (error) {
    return { exitCode: -1, stdout: '', stderr: `it did not run to its end: ${error instanceof Error ? error.message : String(error)}` }
  }
}
export const said = (o: Out) => (o.stderr.trim() || o.stdout.trim() || 'no output').slice(0, 800)

// The ed25519 host key that the address presents, as "ssh-ed25519 <key>", or no key with ssh-keyscan's answer.
// ssh-keyscan stops before the server proves it holds the private key, so any machine at the address can show any
// public key: a key read here proves nothing until a person confirms it. A check against a saved key goes over ssh.
export async function scanKey($: EngineInterface, address: string): Promise<{ key?: string; out: Out }> {
  const out = await exec($, ['ssh-keyscan', '-T', '15', '-p', SSH_PORT, '-t', 'ed25519', address], { timeoutMs: 30_000 })
  const line = out.stdout.split('\n').map(l => l.trim().split(/\s+/)).find(f => f[1] === 'ssh-ed25519' && f[2])
  return { key: out.exitCode === 0 && line ? `ssh-ed25519 ${line[2]}` : undefined, out }
}

export async function fingerprint($: EngineInterface, key: string): Promise<string> {
  const o = await exec($, ['ssh-keygen', '-lf', '-'], { stdin: `${key}\n` })
  const print = /SHA256:\S+/.exec(o.stdout)?.[0]
  if (o.exitCode !== 0 || !print) throw new Error(`ssh-keygen -lf - printed no SHA256 fingerprint for a host key (exit ${o.exitCode}): ${said(o)}\nNothing changed.`)
  return print
}

// hcloud takes an exported token before the context's own, so both variables are removed for every call.
const HCLOUD = ['env', '-u', 'HCLOUD_TOKEN', '-u', 'HCLOUD_CONTEXT', 'hcloud']
export const shown = (ctx: string, args: string[]) => `hcloud --context ${ctx} ${args.join(' ')}`

export async function hc($: EngineInterface, ctx: string, args: string[], init: { timeoutMs?: number; stdin?: string } = {}): Promise<string> {
  const o = await exec($, [...HCLOUD, '--context', ctx, ...args], init)
  if (o.exitCode !== 0) throw new Error(`${shown(ctx, args)} exited ${o.exitCode}: ${said(o)}`)
  return o.stdout
}

export async function hcJson<T>($: EngineInterface, ctx: string, args: string[]): Promise<T> {
  const text = await hc($, ctx, args)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`${shown(ctx, args)} printed no JSON: ${text.trim().slice(0, 200) || 'no output'}`)
  }
}

export async function pause($: EngineInterface, secs: number): Promise<void> {
  await exec($, ['sleep', String(secs)], { timeoutMs: (secs + 10) * 1000 })
}

// The hcloud context is the Hetzner project that pays. It is named on the command or kept from an earlier create of
// this name; the active context and HCLOUD_CONTEXT are never used.
// `whose` is what the context is for (a remote's name, or the server that import reads) and `kept` the one an earlier
// command kept for it.
export async function contextOf($: EngineInterface, whose: string, wanted: string | undefined, kept: string | undefined, again: string): Promise<string> {
  const listed = await exec($, [...HCLOUD, 'context', 'list', '-o', 'noheader', '-o', 'columns=name'])
  if (listed.exitCode !== 0) throw new Error(`hcloud context list exited ${listed.exitCode}: ${said(listed)}\nRepair: install hcloud (brew install hcloud) and make a context for the Hetzner project (hcloud context create <name>, which asks for the project's API token).`)
  const contexts = listed.stdout.split('\n').map(l => l.trim()).filter(Boolean)
  const here = `The contexts here: ${contexts.join(', ') || 'none'}.`
  const ctx = wanted ?? kept
  if (!ctx) throw new Error(`no hcloud context is named for ${whose}. The context is the Hetzner project that pays, so it must be named: the active context and HCLOUD_CONTEXT are never used. ${here} Nothing changed.\nRepair: run ${again} --context <context>.`)
  if (!contexts.includes(ctx)) throw new Error(`there is no hcloud context "${ctx}". ${here} Nothing changed.\nRepair: name one of them, or make it with hcloud context create ${ctx} (it asks for the project's API token).`)
  return ctx
}

export const isRemoteName = (name: string) => /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/.test(name)
export const NAME_RULE = 'a name is 2 to 40 lower-case letters, digits and hyphens, and starts with a letter'
function nameOf(name: string | undefined, word: string): string {
  if (!name) throw new Error(`it needs the name of the remote, as in /dev remote ${word} <name>. Nothing changed.`)
  if (!isRemoteName(name)) throw new Error(`"${name}" cannot name a remote: ${NAME_RULE}. Nothing changed.`)
  return name
}

// ---- What Hetzner holds for a name, and whose it is ----

const labelArgs = (name: string, more: Labels = {}) => Object.entries({ 'managed-by': 'ndev', 'ndev-name': name, ...more }).flatMap(([k, v]) => ['--label', `${k}=${v}`])
export const isOurs = (labels: Labels | undefined, name: string) => labels?.['managed-by'] === 'ndev' && labels['ndev-name'] === name

export const labelsShown = (labels: Labels | undefined) => Object.entries(labels ?? {}).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'

// /dev remote touches only what it made or what /dev remote import handed to it. `kind` is the hcloud resource word,
// so the repair is a command. `serverId` is the server of the name, when there is one: import of it labels the
// firewalls applied to it and its floating IPv4. A snapshot, and a firewall or floating IP with no server, have only
// the label command.
function ours<T extends { id: number; labels: Labels }>(kind: 'server' | 'image' | 'floating-ip' | 'firewall', thing: T | undefined, title: string, name: string, ctx: string, serverId?: number): T | undefined {
  if (!thing || isOurs(thing.labels, name)) return thing
  const byHand = `hcloud --context ${ctx} ${kind} add-label ${thing.id} managed-by=ndev ndev-name=${name}`
  const repair =
    kind === 'server' ? `/dev remote import ${thing.id} --context ${ctx}`
    : serverId !== undefined && kind !== 'image' ? `/dev remote import ${serverId} --context ${ctx} labels it when it is ${kind === 'firewall' ? 'applied' : 'assigned'} to the server ${name}; when it is not, ${byHand}`
    : byHand
  throw new Error(`the ${kind} ${title} (${thing.id}) in the hcloud context ${ctx} does not carry the labels managed-by=ndev and ndev-name=${name} (its labels: ${labelsShown(thing.labels)}), so /dev remote did not make it and does not touch it. Nothing changed.\nRepair: use another name. Or, if it is yours to hand to /dev remote: ${repair}`)
}

// The floating IP of a remote: the one named with --floating-ip (by name or id), else the one an earlier command
// kept for the name, else the one with the remote's name. One that was made by hand is adopted only once it carries
// the labels; the refusal names the command, and only /dev remote import labels it.
async function look($: EngineInterface, ctx: string, name: string, flag: string | undefined, kept: number | undefined, path: string) {
  const wantedIp = flag ?? (kept === undefined ? undefined : String(kept))
  const server = ours('server', (await hcJson<Srv[]>($, ctx, ['server', 'list', '-o', 'json'])).find(s => s.name === name), name, name, ctx)
  // A snapshot has no name: the name label finds it, and the managed-by label must be beside it.
  const snapshots = (await hcJson<Img[]>($, ctx, ['image', 'list', '--type', 'snapshot', '-l', `ndev-name=${name}`, '-o', 'json']))
    .map(s => ours('image', s, `"${s.description}"`, name, ctx)!)
    .sort((a, b) => b.created.localeCompare(a.created))
  const fips = await hcJson<Fip[]>($, ctx, ['floating-ip', 'list', '-o', 'json'])
  const found = wantedIp === undefined ? fips.find(f => f.name === name) : fips.find(f => String(f.id) === wantedIp || f.name === wantedIp)
  if (wantedIp !== undefined && !found) {
    const there = `The floating IPs there: ${fips.map(f => `${f.name} (${f.id}, ${f.ip})`).join(', ') || 'none'}. Nothing changed.`
    if (flag === undefined) throw new Error(`the floating IP ${wantedIp} that ${path} keeps for ${name} is no longer in the hcloud context ${ctx}. ${there}\nRepair: name another with --floating-ip <name or id>. To have a new one made, delete "floatingIp" and "ip" from hosts.${name} in ${path}, then run the command again.`)
    throw new Error(`there is no floating IP "${wantedIp}" in the hcloud context ${ctx}. ${there}\nRepair: name one of them with --floating-ip <name or id>.`)
  }
  const fip = ours('floating-ip', found, found?.name ?? name, name, ctx, server?.id)
  const firewall = ours('firewall', (await hcJson<Fw[]>($, ctx, ['firewall', 'list', '-o', 'json'])).find(f => f.name === `${name}-ssh`), `${name}-ssh`, name, ctx, server?.id)
  return { server, snapshots, fip, firewall }
}

async function pricing($: EngineInterface, ctx: string) {
  const p = (await hcJson<{ pricing: { currency: string; floating_ips?: { type: string; prices: Price[] }[]; image?: { price_per_gb_month: { gross: string } } } }>($, ctx, ['api', '/pricing'])).pricing
  const money = (gross: string | undefined) => (gross === undefined ? 'a price Hetzner does not list' : `${p.currency} ${Number(gross).toFixed(2)} a month with VAT`)
  return {
    money,
    floating: (location: string) => money(p.floating_ips?.find(f => f.type === 'ipv4')?.prices.find(x => x.location === location)?.price_monthly.gross),
    snapshot: (gb: number | null) => (gb === null || !p.image ? 'a price by its size' : money(String(gb * Number(p.image.price_per_gb_month.gross)))),
  }
}

// Asks before any spend or deletion. With no one to ask, it refuses: only --yes confirms without a person.
export async function confirm($: EngineInterface, o: HostOptions, question: string, yes: string, nothing: string): Promise<void> {
  if (o.isYes) return
  if (o.requestConfirmation) return o.requestConfirmation(question)
  const refused = `no one confirmed it, so it is refused. ${nothing}\nRepair: run it where you can answer the question, or add --yes to confirm on the command line.`
  // A session with no person at it is not asked: an answer there would not be a person's.
  if (!(await o.hasHuman?.())) throw new Error(refused)
  let answer: string
  try {
    answer = (await $.ui.ask(question, { header: 'Remote', options: [yes, 'Cancel'] })).trim()
  } catch {
    throw new Error(refused)
  }
  if (answer !== yes) throw new Error(`cancelled. ${nothing}`)
}

// Runs the steps of a command and, when one fails, adds what the earlier steps already did.
export async function steps($: EngineInterface, fn: (did: (what: string) => void) => Promise<string>): Promise<string> {
  const done: string[] = []
  try {
    return await fn(what => {
      done.push(what)
      $.ui.toast(`/dev remote: ${what}`)
    })
  } catch (error) {
    if (!done.length && error instanceof Error) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(done.length ? `${message}\nDone before this: ${done.join('; ')}.` : message)
  }
}

// ---- SSH ----

// `only` names the address whose line in the known file is the one host key ssh may accept: it shuts the other ways
// the user's ssh config can vouch for a key (a KnownHostsCommand, DNS) or look one up under another name.
const sshArgs = (known?: string, only?: string) => ['-p', SSH_PORT, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', ...(known ? ['-o', `UserKnownHostsFile=${known}`, '-o', 'GlobalKnownHostsFile=/dev/null'] : []), ...(only ? ['-o', 'KnownHostsCommand=none', '-o', 'VerifyHostKeyDNS=no', '-o', `HostKeyAlias=${only}`, '-o', 'HostKeyAlgorithms=ssh-ed25519'] : [])]
type SshInit = { known?: string; only?: string; stdin?: string; timeoutMs?: number }
function ssh($: EngineInterface, target: string, command: string, init: SshInit = {}): Promise<Out> {
  return exec($, ['ssh', ...sshArgs(init.known, init.only), target, command], { timeoutMs: init.timeoutMs ?? 60_000, ...(init.stdin === undefined ? {} : { stdin: init.stdin }) })
}

async function sshOk($: EngineInterface, target: string, command: string, init: SshInit = {}): Promise<string> {
  const o = await ssh($, target, command, init)
  if (o.exitCode !== 0) throw new Error(`ssh ${target} ${command.slice(0, 80)} exited ${o.exitCode}: ${said(o)}`)
  return o.stdout
}

// Waits for sshd. The host key is checked from the first try, and a key that does not match stops the wait at once.
async function waitForSsh($: EngineInterface, target: string, known: string | undefined, knownPath: string): Promise<void> {
  let last: Out = { exitCode: -1, stdout: '', stderr: 'not tried' }
  for (let tries = 0; tries < 40; tries++) {
    last = await ssh($, target, 'true', { ...(known ? { known } : {}), timeoutMs: 30_000 })
    if (last.exitCode === 0) return
    if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No .* host key is known/i.test(last.stderr)) {
      throw new Error(`ssh ${target} refused the host key: ${said(last)}\nThe key the server presents is not the one in ${knownPath}. It is never trusted on first use.\nRepair: check the server's key in its Hetzner console, put it in ${knownPath}, then run the command again.`)
    }
    await pause($, 5)
  }
  throw new Error(`ssh ${target} did not answer on port ${SSH_PORT} after 40 tries (exit ${last.exitCode}): ${said(last)}`)
}

// Puts the address and its host key in the desktop's known_hosts, in place of any older key of that address.
async function trust($: EngineInterface, home: string, ip: string, hostKey: string): Promise<string> {
  const known = `${home}/.ssh/known_hosts`
  const made = await exec($, ['mkdir', '-p', `${home}/.ssh`])
  if (made.exitCode !== 0) throw new Error(`mkdir -p ${home}/.ssh exited ${made.exitCode}: ${said(made)}`)
  const has = await $.fs.exists(known)
  if (has) await exec($, ['ssh-keygen', '-R', ip, '-f', known]) // a hashed line of an earlier server at this address
  const lines = (has ? await $.fs.read(known) : '').split('\n').filter(l => l.trim() && l.split(/\s+/)[0] !== ip)
  await $.fs.write(known, `${[...lines, `${ip} ${hostKey}`].join('\n')}\n`)
  return known
}

// Puts the floating address on eth0 of the server, now (ip addr add) and for every restart (Hetzner's netplan file).
// floating-ip.sh checks first, so on a server that already holds it this is only the check.
const FLOATING_BY_HAND = (ip: string) => `Repair: as root on the server, run ip addr add ${ip} dev eth0 (that sets it until the next restart), then run the command again, which writes the persistent form (/etc/netplan/60-floating-ip.yaml).`
async function setFloating($: EngineInterface, root: string, known: string, ip: string): Promise<void> {
  const script = await $.fs.read(`${$.plugin.root}/scripts/remote/floating-ip.sh`)
  const o = await ssh($, root, `floating=${ip} bash -s`, { known, stdin: script })
  if (o.exitCode !== 0) throw new Error(`the floating address ${ip} was not set on the interface eth0 of ${root}: floating-ip.sh exited ${o.exitCode}: ${said(o)}\n${FLOATING_BY_HAND(ip)}`)
}

// ---- /dev remote create ----

const FIREWALL_RULES = JSON.stringify([
  { direction: 'in', protocol: 'tcp', port: SSH_PORT, source_ips: ['0.0.0.0/0', '::/0'], description: 'SSH' },
  { direction: 'in', protocol: 'icmp', source_ips: ['0.0.0.0/0', '::/0'], description: 'ICMP' },
])
const letsSshIn = (fw: Fw) => (fw.rules ?? []).some(r => {
  if (r.direction !== 'in' || r.protocol !== 'tcp') return false
  const [from, to = from] = String(r.port ?? '').split('-').map(Number)
  return from !== undefined && to !== undefined && from <= Number(SSH_PORT) && Number(SSH_PORT) <= to
})

// The SSH key of the Hetzner project that the server takes: the one named, else the one of the last create, else the
// only one that matches a public key in ~/.ssh on this desktop. A key that matches none is refused, or nobody could
// sign in.
async function sshKeyOf($: EngineInterface, ctx: string, home: string, wanted: string | undefined, again: string): Promise<string> {
  const keys = await hcJson<{ id: number; name: string; public_key: string }[]>($, ctx, ['ssh-key', 'list', '-o', 'json'])
  const list = `The SSH keys in the hcloud context ${ctx}: ${keys.map(k => `${k.name} (${k.id})`).join(', ') || 'none'}.`
  const add = `add yours with hcloud --context ${ctx} ssh-key create --name <name> --public-key-from-file ~/.ssh/<key>.pub`
  const body = (text: string) => text.trim().split(/\s+/).slice(0, 2).join(' ')
  const local = new Set<string>()
  if (await $.fs.exists(`${home}/.ssh`)) {
    for (const f of await $.fs.list(`${home}/.ssh`)) if (f.name.endsWith('.pub')) local.add(body(await $.fs.read(`${home}/.ssh/${f.name}`)))
  }
  if (wanted) {
    const key = keys.find(k => k.name === wanted || String(k.id) === wanted)
    if (!key) throw new Error(`there is no SSH key "${wanted}" in the hcloud context ${ctx}. ${list} Nothing was created.\nRepair: run ${again} --ssh-key <key>, or ${add}`)
    if (!local.has(body(key.public_key))) throw new Error(`the SSH key ${key.name} (${key.id}) of the hcloud context ${ctx} matches no public key in ${home}/.ssh on this machine, so you could not sign in to the server. ${list} Nothing was created.\nRepair: run ${again} --ssh-key <key> with one that does, or ${add}`)
    return key.name
  }
  const mine = keys.filter(k => local.has(body(k.public_key)))
  if (mine.length === 1) return mine[0]!.name
  throw new Error(`${mine.length ? `${mine.length} SSH keys of the hcloud context ${ctx} match a public key in ${home}/.ssh on this machine (${mine.map(k => k.name).join(', ')}), so one must be named` : `no SSH key of the hcloud context ${ctx} matches a public key in ${home}/.ssh on this machine, so you could not sign in to the server`}. ${list} Nothing was created.\nRepair: run ${again} --ssh-key <key>, or ${add}`)
}

// The first build: the server boots with a host key made here, so the first connection already checks a key this
// machine knows. That key is in the user data, which every user of the server can read, so root-setup.sh makes a new
// one and this machine records it over the checked connection. Returns the server's new host key.
async function firstBuild($: EngineInterface, ctx: string, name: string, create: string[], floating: string, did: (what: string) => void, keep: (hostKey: string) => Promise<void>): Promise<string> {
  const tmp = (await exec($, ['mktemp', '-d'])).stdout.trim()
  if (!tmp) throw new Error('mktemp -d made no folder for the first-boot host key. Nothing was created.')
  try {
    const made = await exec($, ['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', `${name} first boot`, '-f', `${tmp}/host_key`])
    if (made.exitCode !== 0) throw new Error(`ssh-keygen for the first-boot host key exited ${made.exitCode}: ${said(made)} Nothing was created.`)
    const first = (await $.fs.read(`${tmp}/host_key.pub`)).trim().split(/\s+/).slice(0, 2).join(' ')
    const secret = (await $.fs.read(`${tmp}/host_key`)).trimEnd().split('\n').map(l => `    ${l}`).join('\n')
    await exec($, ['rm', '-f', `${tmp}/host_key`, `${tmp}/host_key.pub`])
    const userData = `#cloud-config\nssh_deletekeys: true\nssh_genkeytypes: [ed25519]\nssh_keys:\n  ed25519_private: |\n${secret}\n  ed25519_public: ${first}\n`
    await hc($, ctx, [...create, '--image', BASE_IMAGE, '--user-data-from-file', '-'], { stdin: userData, timeoutMs: 300_000 })
    const server = (await hcJson<Srv[]>($, ctx, ['server', 'list', '-o', 'json'])).find(s => s.name === name)
    const ip = server?.public_net.ipv4?.ip
    if (!server || !ip) throw new Error(`hcloud made the server ${name} but server list shows ${server ? 'no IPv4 address for it' : 'no server of that name'}.\nRepair: look at it with hcloud --context ${ctx} server describe ${name}`)
    did(`made server ${name} (${server.id}) from ${BASE_IMAGE} at ${ip}`)

    const known = `${tmp}/known_hosts`
    const root = `root@${ip}`
    await $.fs.write(known, `${ip} ${first}\n`)
    await waitForSsh($, root, known, known)
    // Exit 2 is "done, with recoverable errors" (cloud-init 23.4 and later): the server is usable, so only 1 stops it.
    await sshOk($, root, 'cloud-init status --wait >/dev/null 2>&1; rc=$?; [ "$rc" -eq 0 ] || [ "$rc" -eq 2 ] || { cloud-init status --long >&2; exit 1; }', { known, timeoutMs: PACKAGES_TIMEOUT_MS })
    const script = await $.fs.read(`${$.plugin.root}/scripts/remote/root-setup.sh`)
    const hostKey = (await sshOk($, root, `u=${USER} bash -s`, { known, stdin: script, timeoutMs: PACKAGES_TIMEOUT_MS })).trim()
    if (!/^ssh-ed25519 \S+$/.test(hostKey)) throw new Error(`the server did not print its new host key after root-setup.sh; it printed: ${hostKey.slice(0, 200) || 'nothing'}`)
    // Recorded at once: if a later step fails, this machine can still check the server.
    await keep(hostKey)
    // At every point the known hosts file holds the key the server presents: both, then reload, then only the new.
    await $.fs.write(known, `${ip} ${first}\n${ip} ${hostKey}\n`)
    await sshOk($, root, 'systemctl reload ssh', { known })
    await $.fs.write(known, `${ip} ${hostKey}\n`)
    await sshOk($, root, 'true', { known })
    did(`installed the system packages and the user ${USER} on it, with password sign-in off and a new host key`)
    await setFloating($, root, known, floating)
    did(`set the floating address ${floating} on eth0, now and for every restart`)
    // The packages can bring a new kernel or libc: restart now, while nothing runs on it.
    if ((await ssh($, root, 'test -f /var/run/reboot-required', { known })).exitCode === 0) {
      await ssh($, root, 'systemctl reboot', { known })
      await pause($, 20)
      await waitForSsh($, root, known, known)
      did('restarted it, because the upgrades asked for it')
    }
    return hostKey
  } finally {
    await exec($, ['rm', '-rf', tmp])
  }
}

// Orca saves an SSH host as a server only from its app. A saved server made from a recipe with the remote's name is
// "<name> VM <id>", so that one is saved as this project's /dev remote; with none or several, the setting is left.
async function orcaSide($: EngineInterface, project: LoadedConfig | undefined, store: Store, path: string, name: string, ip: string): Promise<string> {
  const key = projectKey(project)
  const manual = [
    `Orca has no saved server for ${name} yet, and its CLI cannot make one from an SSH host (orca environment add takes only a pairing code of a running Orca server). The /dev remote setting of ${key} is not changed. To finish:`,
    `  1. In orca.yaml, on the default branch of the project's primary checkout, add an environmentRecipes entry with the id ${name} whose create script prints the SSH connection ${USER}@${ip}, port ${SSH_PORT} (guide: orca skills get orca-per-workspace-env --reference ssh-host).`,
    `  2. In the Orca app: New workspace, then Run on, then that recipe. Orca then saves the server ("${name} VM <id>").`,
    `  3. Run /dev remote create ${name} again, or /dev remote <server> with the name that orca environment list shows.`,
  ].join('\n')
  let servers: Server[]
  try {
    servers = await orcaServers($)
  } catch (error) {
    return `Orca was not read, so the /dev remote setting of ${key} is not changed: ${error instanceof Error ? error.message : String(error)}\n${manual}`
  }
  const found = namedFor(servers, name)
  if (found.length > 1) return `Orca has ${found.length} saved servers named for ${name}: ${found.map(s => `${s.name} (${s.id})`).join(', ')}. The /dev remote setting of ${key} is not changed.\nRepair: run /dev remote <server> with the one that is this machine.`
  const server = found[0]
  if (!server) return manual
  store.projects[key] = { id: server.id, name: server.name, savedAt: new Date(await $.clock.now()).toISOString() }
  await writeStore($, path, store)
  return `Orca's saved server ${server.name} (${server.id}) is now the /dev remote of ${key}; /dev triage start --remote uses it. Orca does not show a saved server's address, so the plugin matched it by its name only.`
}

export async function createHost($: EngineInterface, project: LoadedConfig | undefined, given: string | undefined, o: HostOptions): Promise<string> {
  const name = nameOf(given, 'create')
  const again = `/dev remote create ${name}`
  projectKey(project)
  const home = (await $.env.get('HOME')) ?? ''
  const path = await storePath($)
  const store = await readStore($, path)
  const ctx = await contextOf($, name, o.context, store.hosts[name]?.context, again)
  const { server, snapshots, fip, firewall } = await look($, ctx, name, o.floatingIp, store.hosts[name]?.floatingIp, path)
  const record: HostRecord = { ...store.hosts[name], context: ctx }

  const snapshot = snapshots[0]
  if (!server && snapshot && snapshot.status !== 'available') throw new Error(`the newest snapshot of ${name}, ${snapshot.id}, has the status "${snapshot.status}", not "available", so it cannot be restored. Nothing was created.\nRepair: look at it with hcloud --context ${ctx} image describe ${snapshot.id}; when it is available, run ${again} again.`)
  if (fip && fip.server !== null && fip.server !== server?.id) throw new Error(`the floating IP ${fip.ip} (${fip.id}) of ${name} is assigned to the server ${fip.server}, which is not the server ${name}. Nothing was created.\nRepair: look at it with hcloud --context ${ctx} floating-ip describe ${fip.id}`)
  if (firewall && !letsSshIn(firewall)) throw new Error(`the firewall ${firewall.name} (${firewall.id}) has no inbound TCP ${SSH_PORT} rule, so the server could not be reached. Nothing was created.\nRepair: hcloud --context ${ctx} firewall add-rule ${firewall.id} --direction in --protocol tcp --port ${SSH_PORT} --source-ips 0.0.0.0/0 --source-ips ::/0 --description SSH`)

  // A server or a snapshot of the name with no host key on this machine: nothing here could check the server, and a
  // key is never trusted on first use. It is refused before any spend.
  if ((server || snapshot) && !record.hostKey) {
    const what = server ? `the server ${name} (${server.id}) exists` : `${name} has the snapshot ${snapshot!.id}`
    throw new Error(`${what}, and ${path} on this machine holds no host key for ${name}, so this machine cannot check the server's identity. That is so when the first build did not finish, or when another machine made it. Nothing changed.\nRepair: if another machine made it, copy hosts.${name} from that machine's ~/.config/ndev/remote.json into ${path}.${server ? ` If the server is one you know, /dev remote import ${server.id} --context ${ctx} reads its host key, shows you the fingerprint and records it on yes. If its first build did not finish, delete it with hcloud --context ${ctx} server delete ${server.id}, then run ${again} again.` : ''}`)
  }

  const type = o.type ?? snapshot?.labels['ndev-type'] ?? DEFAULT_TYPE
  const location = o.location ?? fip?.home_location.name ?? snapshot?.labels['ndev-location'] ?? DEFAULT_LOCATION
  const cost = await pricing($, ctx)
  let sshKey = record.sshKey
  const plan: string[] = []
  if (server) {
    if (server.status !== 'running') throw new Error(`the server ${name} (${server.id}) exists and has the status "${server.status}", not "running", so SSH cannot answer. Nothing changed.\nRepair: start it with hcloud --context ${ctx} server poweron ${server.id}, then run ${again} again. Or run /dev remote remove ${name} to snapshot and delete it.`)
    if (o.type && o.type !== server.server_type.name) throw new Error(`the server ${name} (${server.id}) already exists with the type ${server.server_type.name}, not ${o.type}. Nothing changed.\nRepair: to change its type, run /dev remote remove ${name}, then ${again} --type ${o.type}.`)
  } else {
    const info = await hcJson<ServerType>($, ctx, ['server-type', 'describe', type, '-o', 'json'])
    const price = info.prices.find(p => p.location === location)
    if (!price) throw new Error(`the server type ${type} is not sold in ${location}; it is sold in ${info.prices.map(p => p.location).join(', ') || 'no location'}. Nothing was created.\nRepair: run ${again} --location <location>, or --type <type>.`)
    if (snapshot && info.disk < snapshot.disk_size) throw new Error(`the snapshot ${snapshot.id} of ${name} is of a ${snapshot.disk_size} GB disk, and the server type ${type} has a ${info.disk} GB disk. A snapshot restores only onto a disk at least as large as its source. Nothing was created.\nRepair: run ${again} --type <type> with a type of at least ${snapshot.disk_size} GB (hcloud --context ${ctx} server-type list shows each disk).`)
    if (snapshot?.architecture && info.architecture && snapshot.architecture !== info.architecture) throw new Error(`the snapshot ${snapshot.id} of ${name} is ${snapshot.architecture}, and the server type ${type} is ${info.architecture}. Nothing was created.\nRepair: run ${again} --type <type> with a type of the architecture ${snapshot.architecture}.`)
    if (fip && location !== fip.home_location.name) {
      const zone = (await hcJson<{ network_zone: string }>($, ctx, ['location', 'describe', location, '-o', 'json'])).network_zone
      if (zone !== fip.home_location.network_zone) throw new Error(`the floating IP ${fip.ip} of ${name} is in the network zone ${fip.home_location.network_zone ?? 'unknown'} (${fip.home_location.name}), and ${location} is in ${zone}. A floating IP goes only to a server in its own network zone. Nothing was created.\nRepair: run ${again} --location ${fip.home_location.name}.`)
    }
    sshKey = await sshKeyOf($, ctx, home, o.sshKey ?? record.sshKey, again)
    plan.push(`a server ${name}: ${type} (${info.cores} vCPU, ${info.memory} GB memory, ${info.disk} GB disk) in ${location}, ${cost.money(price.price_monthly.gross)}, ${snapshot ? `restored from the snapshot ${snapshot.id} (${snapshot.disk_size} GB disk, made ${snapshot.created.slice(0, 10)})` : `built from the base image ${BASE_IMAGE}, because ${name} has no snapshot`}, with the SSH key ${sshKey}`)
  }
  if (!fip) plan.push(`a floating IPv4 ${name} in ${location}, ${cost.floating(location)}, charged for as long as it exists, with or without a server`)
  if (!firewall) plan.push(`a firewall ${name}-ssh that lets in only TCP ${SSH_PORT} and ICMP, at no charge`)
  if (plan.length) {
    await confirm($, o, `Create the remote ${name} in the Hetzner project of the hcloud context "${ctx}"? It makes:\n${plan.map(p => `- ${p}`).join('\n')}\n${fip ? `It keeps the floating IPv4 ${fip.ip}. ` : ''}Nothing is deleted.`, `Create ${name}`, 'Nothing was created.')
  }

  return steps($, async did => {
    if (!firewall) {
      await hc($, ctx, ['firewall', 'create', '--name', `${name}-ssh`, ...labelArgs(name), '--rules-file', '-'], { stdin: FIREWALL_RULES })
      did(`made firewall ${name}-ssh`)
    }
    let address = fip
    if (!address) {
      await hc($, ctx, ['floating-ip', 'create', '--type', 'ipv4', '--name', name, '--home-location', location, ...labelArgs(name)])
      address = (await hcJson<Fip[]>($, ctx, ['floating-ip', 'list', '-o', 'json'])).find(f => f.name === name)
      if (!address) throw new Error(`hcloud made the floating IP ${name} but floating-ip list does not show it.\nRepair: look with hcloud --context ${ctx} floating-ip list, then run ${again} again.`)
      did(`made floating IPv4 ${address.ip} (${address.id})`)
    }
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address.ip)) throw new Error(`the floating IP ${name} (${address.id}) has the address "${address.ip}", which is not an IPv4 address.`)
    record.ip = address.ip
    record.floatingIp = address.id
    if (sshKey) record.sshKey = sshKey
    store.hosts[name] = record
    await writeStore($, path, store)

    let made = server
    let isBuilt = false
    const todo: string[] = []
    if (!made) {
      const create = ['server', 'create', '--name', name, '--type', type, '--location', location, '--ssh-key', sshKey!, '--firewall', `${name}-ssh`, ...labelArgs(name)]
      if (snapshot) {
        await hc($, ctx, [...create, '--image', String(snapshot.id)], { timeoutMs: 600_000 })
        did(`made server ${name} (${type}, ${location}) from the snapshot ${snapshot.id}`)
      } else {
        isBuilt = true
        await firstBuild($, ctx, name, create, address.ip, did, async hostKey => {
          record.hostKey = hostKey
          await writeStore($, path, store)
        })
        todo.push(
          `This server is new, so its host set-up is still to do, as ${USER}@${address.ip}: the project's toolchain (Node, its package manager, the Claude CLI and the ndev plugin), gh auth login, the clone of the repository, claude auth login, and the project's credentials file if a workspace needs it.`,
          `Do it before the first /dev remote remove ${name}: the snapshot then carries it, and a later create needs none of it.`,
        )
      }
      made = (await hcJson<Srv[]>($, ctx, ['server', 'list', '-o', 'json'])).find(s => s.name === name)
      if (!made) throw new Error(`hcloud made the server ${name} but server list does not show it.\nRepair: look with hcloud --context ${ctx} server list, then run ${again} again.`)
    }
    if (address.server !== made.id) {
      await hc($, ctx, ['floating-ip', 'assign', String(address.id), String(made.id)])
      did(`assigned the floating IPv4 ${address.ip} to server ${made.id}`)
    }
    // The snapshot carries the netplan file, so a restored server needs only the check, and the repair if the address
    // is missing; so does a server that an earlier create left before this step. It goes over the server's own
    // address, with the host key of the first build and no other.
    const own = made.public_net.ipv4?.ip
    if (!isBuilt && own) {
      const tmp = (await exec($, ['mktemp', '-d'])).stdout.trim()
      if (!tmp) throw new Error(`mktemp -d made no folder for the host key check of ${own}.`)
      try {
        await $.fs.write(`${tmp}/known_hosts`, `${own} ${record.hostKey}\n`)
        await waitForSsh($, `root@${own}`, `${tmp}/known_hosts`, `${tmp}/known_hosts (the host key of the first build of ${name})`)
        await setFloating($, `root@${own}`, `${tmp}/known_hosts`, address.ip)
        did(`checked that eth0 of the server holds ${address.ip}`)
      } finally {
        await exec($, ['rm', '-rf', tmp])
      }
    }
    // The floating address must answer SSH with the host key this machine recorded at the first build. It is in the
    // snapshot, so a restored server presents it too. A key is never trusted on first use.
    const known = await trust($, home, address.ip, record.hostKey!)
    try {
      await waitForSsh($, `${USER}@${address.ip}`, undefined, known)
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nSSH did not answer on the floating address ${address.ip}, which belongs on the interface eth0 of the server. ${FLOATING_BY_HAND(address.ip)}\nThe server ${name} (${made.id}) exists and is charged for. When SSH answers as ${USER}@${address.ip}, run ${again} again: it makes nothing twice. To stop the charge: /dev remote remove ${name}.`)
    }
    did(`SSH answers as ${USER}@${address.ip} with the recorded host key`)
    const orcaNote = await orcaSide($, project, store, path, name, address.ip)
    return [`The remote ${name} is up in the hcloud context "${ctx}": server ${made.id}, floating IPv4 ${address.ip}, SSH as ${USER}@${address.ip}.`, ...todo, orcaNote].join('\n')
  })
}

// ---- /dev remote remove ----

// A server that ndev made has its host key from the first boot. An imported one has only the key a person confirmed
// at /dev remote import, and nothing else ties the Hetzner server of that name to the machine the person saw. So
// before remove snapshots and deletes an imported server, it connects as root over ssh with that key as the only
// known host key. ssh checks that the server signs the key exchange with the private half of that key, so a machine
// that only shows the public key fails. ssh-keyscan would not do: it stops before that proof.
// A record that import wrote before the `imported` marker is known by its host key with no SSH key of create.
// With no host key saved on this machine there is nothing to check the server against: remove refuses, and only
// --unverified-host goes on, with the warning that this returns. The option skips no check that a saved key allows.
async function checkHostKey($: EngineInterface, name: string, ctx: string, server: Srv, fip: Fip | undefined, rec: HostRecord | undefined, path: string, again: string, isUnverifiedHost: boolean): Promise<string | undefined> {
  const nothing = 'No snapshot was taken and nothing was deleted. Nothing changed.'
  // A record of the name for another hcloud context is the record of another server: its key says nothing here.
  const isOther = rec !== undefined && rec.context !== ctx
  if (!rec?.hostKey || isOther) {
    if (isUnverifiedHost) return `Warning: the host key of the server ${name} (${server.id}) was NOT checked (--unverified-host): this machine holds no saved host key for it.`
    throw new Error(`the server ${name} (${server.id}) in the hcloud context ${ctx} has no host key saved on this machine (${path} holds ${isOther ? `hosts.${name} for the hcloud context ${rec.context}, not ${ctx}` : `no hosts.${name}.hostKey`}), so remove cannot check that it is the server you mean. ${nothing}\nRepair: run ${again} on the machine that created or imported the server. Or, to remove it with no host key check: ${again} --context ${ctx} --unverified-host`)
  }
  // A server that create made had its host key checked by create, and its record holds the SSH key of create.
  if (!(rec.imported || !rec.sshKey)) return undefined
  const reimport = `delete hosts.${name} from ${path}, run /dev remote import ${server.id} --context ${ctx} and confirm the key there, then run ${again} again`
  // The saved key goes into a known_hosts file, so it must be one key on one line.
  const malformed = (detail: string) => new Error(`the server ${name} (${server.id}) was imported, but the host key that ${path} saved as hosts.${name}.hostKey is not a well-formed ed25519 public key (${detail}), so remove cannot check that the server is the one that was imported. ${nothing}\nRepair: ${reimport}.`)
  if (!/^ssh-ed25519 [A-Za-z0-9+/]+=*$/.test(rec.hostKey)) throw malformed(`it reads "${rec.hostKey.slice(0, 120)}"`)
  let saved: string
  try {
    saved = await fingerprint($, rec.hostKey)
  } catch (error) {
    throw malformed(error instanceof Error ? error.message.split('\n')[0]! : String(error))
  }
  // The server's own public IPv4, else the floating IP of the record, but only while it is assigned to this server.
  const isFloatingOurs = fip !== undefined && fip.id === rec.floatingIp && fip.server === server.id && fip.ip === rec.ip
  const address = server.public_net.ipv4?.ip ?? (isFloatingOurs ? rec.ip : undefined)
  const start = server.status === 'running' ? '' : `the server is ${server.status}: start it with hcloud --context ${ctx} server poweron ${server.id}; `
  if (!address) throw new Error(`the server ${name} (${server.id}) was imported, so remove first checks over SSH that it still proves it holds the host key ${saved}, the one ${path} saved for ${name}. But the server has no public IPv4 and no floating IP of ${name} that ${path} saved is assigned to it, so there is nowhere to check. ${nothing}\nRepair: give the server a public IPv4 or a floating IP that SSH answers on, then run ${again} again.`)
  // The address goes into the known_hosts file and ssh's arguments, so it must be an IPv4 address and nothing else.
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) throw new Error(`the server ${name} (${server.id}) was imported, but its address reads "${address.slice(0, 120)}", which is not an IPv4 address, so remove cannot check its host key there. ${nothing}\nRepair: look at the server with hcloud --context ${ctx} server describe ${server.id}, then run ${again} again.`)
  const made = await exec($, ['mktemp', '-d'])
  const tmp = made.exitCode === 0 ? made.stdout.trim() : ''
  if (!tmp) throw new Error(`mktemp -d made no folder for the host key check of the server ${name} (${server.id}) at ${address} (exit ${made.exitCode}): ${said(made)}. ${nothing}\nRepair: check that the temporary folder ($TMPDIR) is writable, then run ${again} again.`)
  const target = `root@${address}`
  try {
    await $.fs.write(`${tmp}/known_hosts`, `${address} ${rec.hostKey}\n`)
    await sshOk($, target, 'true', { known: `${tmp}/known_hosts`, only: address })
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).trim().replace(/\.$/, '')
    const isKeyRefused = /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No .* host key is known/i.test(detail)
    // ssh checks the host key before the sign-in, but a refused sign-in is still no finished check: remove refuses.
    const isSignInRefused = !isKeyRefused && /Permission denied/i.test(detail)
    const byHand = `ssh -p ${SSH_PORT} ${target} (if ssh asks about a host key, its fingerprint must be ${saved}; never accept another)`
    const repair = isKeyRefused
      ? `read the server's own fingerprint in its Hetzner console (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub). If it is not ${saved}, the server's key changed or another machine answers at ${address}: find out which before you remove anything. If the server is the one you imported and its key changed, ${reimport}.`
      : isSignInRefused
        ? `the check needs a key sign-in as root: put your public SSH key in /root/.ssh/authorized_keys on the server (Hetzner console), check it with ${byHand}, then run ${again} again.`
        : `${start}check that SSH answers there with ${byHand}, then run ${again} again. If ssh says the host key does not match, read the server's own fingerprint in its Hetzner console (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub) before you remove anything.`
    throw new Error(`the server ${name} (${server.id}) was imported, so remove first checks over SSH that the server at ${address} proves it holds the host key ${saved}, the one ${path} saved for ${name}. ${isKeyRefused ? 'It did not: it may not be the server that was imported.' : isSignInRefused ? 'The check did not finish: the server refused the sign-in as root.' : 'The check did not finish.'} ${detail}. ${nothing}\nRepair: ${repair}`)
  } finally {
    await exec($, ['rm', '-rf', tmp])
  }
}

export async function removeHost($: EngineInterface, project: LoadedConfig | undefined, given: string | undefined, o: HostOptions): Promise<string> {
  const name = nameOf(given, 'remove')
  const again = `/dev remote remove ${name}`
  projectKey(project)
  const path = await storePath($)
  const store = await readStore($, path)
  const ctx = await contextOf($, name, o.context, store.hosts[name]?.context, again)
  const { server, snapshots, fip, firewall } = await look($, ctx, name, o.floatingIp, store.hosts[name]?.floatingIp, path)
  const kept = [snapshots.length ? `snapshot ${snapshots.map(s => s.id).join(', ')}` : '', fip ? `floating IPv4 ${fip.ip}` : '', firewall ? `firewall ${firewall.name}` : ''].filter(Boolean).join(', ') || 'nothing'
  const recovered = !server && o.removalJournal ? snapshots.flatMap(image => {
    const source = Number(image.labels['ndev-source'])
    if (!Number.isSafeInteger(source) || source < 1) return []
    const row = o.removalJournal!.read(ctx, name, source)
    return row.snapshot === image.id && row.token === image.labels['ndev-operation'] ? [{ source, image, row }] : []
  }) : []
  if (recovered.length > 1) throw new Error(`Multiple removal snapshots of ${name} match local operations in ${ctx}: ${recovered.map(r => r.image.id).join(', ')}. Inspect the images before retrying.`)
  if (!server && !o.isForget && !recovered.length) throw new Error(`there is no server named ${name} in the hcloud context ${ctx}, so there is nothing to remove. Kept for ${name}: ${kept}. Nothing changed.\nRepair: /dev remote create ${name} makes it again; ${again} --forget deletes what is kept.`)
  if (fip && fip.server !== null && fip.server !== server?.id) throw new Error(`the floating IP ${fip.ip} (${fip.id}) of ${name} is assigned to the server ${fip.server}, which is not the server ${name}, so it is in use. Nothing changed.\nRepair: look at it with hcloud --context ${ctx} floating-ip describe ${fip.id}; unassign it with hcloud --context ${ctx} floating-ip unassign ${fip.id} if that server must lose the address.`)
  const unfinished = snapshots.find(s => s.status !== 'available')
  if (unfinished) throw new Error(`the snapshot ${unfinished.id} of ${name} has the status "${unfinished.status}", not "available". Nothing changed.\nRepair: look at it with hcloud --context ${ctx} image describe ${unfinished.id}. When it is available, run ${again} again; delete a failed one with hcloud --context ${ctx} image delete ${unfinished.id}.`)
  const prior = server && o.removalJournal?.read(ctx, name, server.id)
  if (prior?.requested && server?.status !== 'off') throw new Error(`Snapshot request ${prior.token} is pending but server ${server?.id} is ${server?.status}. Inspect its snapshot and disk before removing ${name}.`)
  const savedHostKey = store.hosts[name]?.context === ctx ? store.hosts[name]?.hostKey : undefined
  const verifiedBeforeShutdown = server?.status === 'off' && savedHostKey && prior?.hostKey === savedHostKey
  const unchecked = server && !verifiedBeforeShutdown ? await checkHostKey($, name, ctx, server, fip, store.hosts[name], path, again, o.isUnverifiedHost === true) : undefined
  const cost = await pricing($, ctx)

  return steps($, async did => {
    const said: string[] = []
    let keptSnapshots = snapshots
    if (recovered.length && !o.isForget) {
      const { source, image, row } = recovered[0]!
      if (!row.complete) {
        o.removalJournal!.claim(ctx, name, source, row.hostKey)
        for (const old of snapshots.filter(s => s.id !== image.id && row.prune?.includes(s.id))) {
          await hc($, ctx, ['image', 'delete', String(old.id)])
          did(`deleted the older snapshot ${old.id}`)
        }
        store.hosts[name] = { ...store.hosts[name], context: ctx, ...(fip ? { ip: fip.ip, floatingIp: fip.id } : {}) }
        await writeStore($, path, store)
        o.removalJournal!.complete()
      }
      return `Recovered the removal of server ${name} (${source}) in ${ctx}. Its available snapshot is ${image.id}.`
    }
    if (server) {
      const type = server.server_type.name
      const location = server.location?.name ?? 'unknown'
      const monthly = cost.money(server.server_type.prices?.find(p => p.location === location)?.price_monthly.gross)
      await confirm($, o, [
        `Remove the remote ${name} from the Hetzner project of the hcloud context "${ctx}"?`,
        ...(unchecked ? [unchecked] : []),
        `- It shuts down the server ${name} (${server.id}): ${type} in ${location}, ${monthly}.`,
        `- It takes a snapshot of it and waits until the snapshot is available. Hetzner charges for a snapshot by its size.`,
        `- Only then it DELETES the server ${server.id}${snapshots.length ? ` and the older snapshot ${snapshots.map(s => s.id).join(', ')}` : ''}.`,
        `- It keeps ${fip ? `the floating IPv4 ${fip.ip}, which goes on costing ${cost.floating(fip.home_location.name)}` : 'no floating IP (there is none)'}${firewall ? `, and the firewall ${firewall.name}` : ''}.`,
        `If the snapshot fails, nothing is deleted.`,
      ].join('\n'), `Remove ${name}`, 'Nothing changed.')

      const claim = o.removalJournal?.claim(ctx, name, server.id, unchecked ? undefined : savedHostKey)
      if (server.status !== 'off') {
        const off = `so no snapshot was taken. Nothing was deleted.\nRepair: switch it off with hcloud --context ${ctx} server poweroff ${server.id}, then run ${again} again.`
        try {
          await hc($, ctx, ['server', 'shutdown', String(server.id), '--wait', '--wait-timeout', '180s'], { timeoutMs: 240_000 })
        } catch (error) {
          throw new Error(`the server ${name} (${server.id}) did not shut down: ${error instanceof Error ? error.message : String(error)}, ${off}`)
        }
        const now = await hcJson<Srv>($, ctx, ['server', 'describe', String(server.id), '-o', 'json'])
        if (now.status !== 'off') throw new Error(`the server ${name} (${server.id}) has the status "${now.status}" after the shutdown, not "off", ${off}`)
        did(`shut down server ${server.id}`)
      }

      // The snapshot, and the proof that it is available. Until that proof, nothing is deleted.
      const before = new Set(snapshots.map(s => s.id))
      const intact = `Nothing was deleted: the server ${name} (${server.id}) is still there, shut down${fip ? `, with its floating IPv4 ${fip.ip}` : ''}${snapshots.length ? ` and the older snapshot ${snapshots.map(s => s.id).join(', ')}` : ''}.`
      const repair = claim
        ? `Repair: inspect hcloud --context ${ctx} image list -l ndev-operation=${claim.token}, then run ${again} again to recover that snapshot. If the provider confirms the request was never accepted, archive the journal ${claim.file} before retrying.`
        : `Repair: run ${again} again to take the snapshot again, or start the server with hcloud --context ${ctx} server poweron ${server.id}.`
      let fresh: Img | undefined
      try {
        if (!claim?.requested) {
          o.removalJournal?.request()
          await hc($, ctx, ['server', 'create-image', String(server.id), '--type', 'snapshot', '--description', `ndev ${name}`, ...labelArgs(name, { 'ndev-type': type, 'ndev-location': location, ...(claim ? { 'ndev-operation': claim.token, 'ndev-source': String(server.id) } : {}) })], { timeoutMs: 600_000 })
        }
        for (let tries = 0; tries < 90; tries++) {
          const images = await hcJson<Img[]>($, ctx, ['image', 'list', '--type', 'snapshot', '-l', `ndev-name=${name}`, '-o', 'json'])
          const matching = claim ? images.filter(s => isOurs(s.labels, name) && s.labels['ndev-operation'] === claim.token) : images.filter(s => !before.has(s.id))
          if (claim && matching.length > 1) throw new Error(`Multiple snapshots carry operation ${claim.token}: ${matching.map(s => s.id).join(', ')}.`)
          fresh = matching[0]
          if (claim?.requested && !fresh) break
          if (fresh?.status === 'available') break
          await pause($, 10)
        }
      } catch (error) {
        throw new Error(`the snapshot of the server ${name} (${server.id}) failed: ${error instanceof Error ? error.message : String(error)}\n${intact}\n${repair}`)
      }
      if (fresh?.status !== 'available') {
        throw new Error(`the snapshot of the server ${name} (${server.id}) is not available after the wait: ${fresh ? `snapshot ${fresh.id} has the status "${fresh.status}"` : 'hcloud lists no new snapshot'}.\n${intact}\n${repair}${fresh ? ` Look at the snapshot with hcloud --context ${ctx} image describe ${fresh.id}.` : ''}`)
      }
      const keptId = fresh.id
      const prune = snapshots.filter(s => s.id !== keptId)
      o.removalJournal?.deleting(keptId, prune.map(s => s.id))
      did(`took snapshot ${fresh.id} of server ${server.id}, and it is available`)

      if (fip && fip.server === server.id) {
        await hc($, ctx, ['floating-ip', 'unassign', String(fip.id)])
        did(`unassigned the floating IPv4 ${fip.ip}, and kept it`)
      }
      await hc($, ctx, ['server', 'delete', String(server.id)])
      did(`deleted server ${server.id}`)
      for (const old of prune) {
        await hc($, ctx, ['image', 'delete', String(old.id)])
        did(`deleted the older snapshot ${old.id}`)
      }
      keptSnapshots = [fresh]
      store.hosts[name] = { ...store.hosts[name], context: ctx, ...(fip ? { ip: fip.ip, floatingIp: fip.id } : {}) }
      await writeStore($, path, store)
      o.removalJournal?.complete()
      said.push(
        ...(unchecked ? [unchecked] : []),
        `The remote ${name} is removed from the hcloud context "${ctx}": the server ${server.id} is deleted, and the snapshot ${fresh.id} (${fresh.disk_size} GB disk, ${cost.snapshot(fresh.image_size)}) holds it.${fip ? ` The floating IPv4 ${fip.ip} is kept and still charged for.` : ''}`,
        `/dev remote create ${name} makes it again from the snapshot, as ${type} unless you name another type. Orca's saved server for it stays, and cannot connect until then.`,
      )
    }
    if (o.isForget) {
      const gone = [...keptSnapshots.map(s => `the snapshot ${s.id}`), ...(fip ? [`the floating IPv4 ${fip.ip} (${fip.id})`] : []), ...(firewall ? [`the firewall ${firewall.name} (${firewall.id})`] : [])]
      if (!gone.length) said.push(`Nothing is kept for ${name} in the hcloud context "${ctx}", so --forget deleted nothing.`)
      else {
        await confirm($, o, `Forget the remote ${name} in the Hetzner project of the hcloud context "${ctx}"? It DELETES ${gone.join(', ')}. After it, /dev remote create ${name} can only build a new server from the base image, at a new address.`, `Forget ${name}`, `Nothing more was deleted: ${gone.join(', ')} ${gone.length === 1 ? 'is' : 'are'} kept.`)
        for (const s of keptSnapshots) {
          await hc($, ctx, ['image', 'delete', String(s.id)])
          did(`deleted snapshot ${s.id}`)
        }
        if (fip) {
          await hc($, ctx, ['floating-ip', 'delete', String(fip.id)])
          did(`deleted the floating IPv4 ${fip.ip}`)
        }
        if (firewall) {
          await hc($, ctx, ['firewall', 'delete', String(firewall.id)])
          did(`deleted firewall ${firewall.name}`)
        }
        said.push(`The remote ${name} is forgotten: ${gone.join(', ')} ${gone.length === 1 ? 'is' : 'are'} deleted, and nothing of it is charged for.`)
      }
      delete store.hosts[name]
      await writeStore($, path, store)
      said.push(`Orca was not changed. If Orca has a saved server for ${name}, unlink it with orca environment forget --environment "<its name>" --yes (orca environment list shows the name), and clear this project's setting with /dev remote off if it names that server.`)
    }
    return said.join('\n')
  })
}
