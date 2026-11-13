import type { EngineInterface } from 'claude-code'

import type { LoadedConfig } from './config'
import { confirm, contextOf, exec, type Fip, type Fw, hc, hcJson, type HostOptions, type Img, isOurs, isRemoteName, type Labels, labelsShown, NAME_RULE, said, shown, type Srv, SSH_PORT, steps, USER } from './remote-host'
import { type HostRecord, projectKey, readStore, storePath, writeStore } from './remote-store'

// /dev remote import <hetzner-id>: hands a server that was made by hand to /dev remote. It adds the labels
// managed-by=ndev and ndev-name=<name> to the server, to each firewall applied to it and to its floating IPv4, and
// records the remote on this machine with the server's host key. It creates, deletes, resizes and reassigns nothing.
// The remote's name is the server's Hetzner name, because create and remove find a server by that name.
// An imported server has no first-boot key, so the confirmation is the one moment its host key is trusted: the key is
// read with ssh-keyscan, checked against this machine's known_hosts, and shown as a fingerprint before the question.

type Kind = 'server' | 'firewall' | 'floating-ip'
type Thing = { kind: Kind; id: number; title: string; labels: Labels }

const fipTitle = (f: Fip) => `${f.name} (${f.id}, ${f.ip})`
const isV4 = (f: Fip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(f.ip)

// The ed25519 host key that the address presents, as "ssh-ed25519 <key>". Nothing is trusted by reading it.
async function presentedKey($: EngineInterface, address: string, repair: string): Promise<string> {
  const o = await exec($, ['ssh-keyscan', '-T', '15', '-p', SSH_PORT, '-t', 'ed25519', address], { timeoutMs: 30_000 })
  const line = o.stdout.split('\n').map(l => l.trim().split(/\s+/)).find(f => f[1] === 'ssh-ed25519' && f[2])
  if (o.exitCode !== 0 || !line) throw new Error(`ssh-keyscan read no ed25519 host key from ${address} port ${SSH_PORT} (exit ${o.exitCode}): ${said(o)}\nNothing changed.\nRepair: ${repair}`)
  return `ssh-ed25519 ${line[2]}`
}

async function fingerprint($: EngineInterface, key: string): Promise<string> {
  const o = await exec($, ['ssh-keygen', '-lf', '-'], { stdin: `${key}\n` })
  const print = /SHA256:\S+/.exec(o.stdout)?.[0]
  if (o.exitCode !== 0 || !print) throw new Error(`ssh-keygen -lf - printed no SHA256 fingerprint for a host key (exit ${o.exitCode}): ${said(o)}\nNothing changed.`)
  return print
}

// The ed25519 keys that this machine's known_hosts holds for the address, hashed lines too.
async function knownKeys($: EngineInterface, known: string, address: string): Promise<string[]> {
  if (!(await $.fs.exists(known))) return []
  const o = await exec($, ['ssh-keygen', '-F', address, '-f', known])
  // ssh-keygen -F exits 1 with no output when the file has no line for the host.
  if (o.exitCode !== 0 && (o.exitCode !== 1 || o.stdout.trim() || o.stderr.trim())) throw new Error(`ssh-keygen -F ${address} -f ${known} exited ${o.exitCode}: ${said(o)}\nNothing changed.\nRepair: fix ${known}, then run the command again.`)
  return o.stdout.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('@')).map(l => l.split(/\s+/)).filter(f => f[1] === 'ssh-ed25519' && f[2]).map(f => `ssh-ed25519 ${f[2]}`)
}

export async function importHost($: EngineInterface, project: LoadedConfig | undefined, given: string | undefined, o: HostOptions): Promise<string> {
  if (!given) throw new Error('it needs the Hetzner id of the server, as in /dev remote import <hetzner-id> --context <context>. Nothing changed.')
  if (!/^\d+$/.test(given)) throw new Error(`"${given}" is not a Hetzner server id: the id is the number that hcloud --context ${o.context ?? '<context>'} server list shows. Nothing changed.`)
  projectKey(project)
  const home = (await $.env.get('HOME')) ?? ''
  const path = await storePath($)
  const store = await readStore($, path)
  // The name is not known before the server is read, so no kept context can stand in: import always names it.
  const ctx = await contextOf($, `the server ${given}`, o.context, undefined, `/dev remote import ${given}`)
  const again = `/dev remote import ${given} --context ${ctx}`
  const hcloud = (rest: string) => `hcloud --context ${ctx} ${rest}`

  let server: Srv
  try {
    server = await hcJson<Srv>($, ctx, ['server', 'describe', given, '-o', 'json'])
  } catch (error) {
    throw new Error(`${given} is not the id of a server in the hcloud context ${ctx}: ${error instanceof Error ? error.message : String(error)}\nNothing changed.\nRepair: ${hcloud('server list')} shows the servers there and their ids.`)
  }
  const id = server.id
  const name = server.name
  const serverTitle = `the server ${name} (${id})`
  if (o.name !== undefined && o.name !== name) throw new Error(`the server ${id} has the Hetzner name ${name}, not ${o.name}. /dev remote create and remove find a server by its Hetzner name, so the remote takes that name. Nothing changed.\nRepair: run ${again} to import it as ${name}. Or rename it first with ${hcloud(`server update ${id} --name ${o.name}`)}`)
  if (!isRemoteName(name)) throw new Error(`the Hetzner name "${name}" of the server ${id} cannot name a remote: ${NAME_RULE}. Nothing changed.\nRepair: rename it with ${hcloud(`server update ${id} --name <name>`)}, then run ${again} again.`)
  if (server.status !== 'running') throw new Error(`${serverTitle} has the status "${server.status}", not "running", so its host key cannot be read. Nothing changed.\nRepair: start it with ${hcloud(`server poweron ${id}`)}, then run ${again} again.`)
  const both = `the labels managed-by=ndev and ndev-name=${name}`

  // The firewalls applied to the server. One that other servers share is not handed to one remote.
  const firewalls = await hcJson<Fw[]>($, ctx, ['firewall', 'list', '-o', 'json'])
  const appliedIds = new Set((server.public_net.firewalls ?? []).map(f => f.id))
  const applied = firewalls.filter(f => appliedIds.has(f.id))
  for (const fw of applied.filter(f => !isOurs(f.labels, name))) {
    // A label selector applies the firewall to a class of servers, now and later, so it is shared by its nature.
    const others = (fw.applied_to ?? []).filter(a => a.server?.id !== id)
    if (!others.length) continue
    const names = new Map((await hcJson<Srv[]>($, ctx, ['server', 'list', '-o', 'json'])).map(s => [s.id, s.name]))
    const one = (sid: number) => (names.has(sid) ? `${names.get(sid)} (${sid})` : `the server ${sid}`)
    const each = others.map(a => {
      if (a.server) return one(a.server.id)
      const matched = (a.applied_to_resources ?? []).flatMap(r => (r.server && r.server.id !== id ? [one(r.server.id)] : []))
      return `every server that matches the label selector "${a.label_selector?.selector ?? 'unknown'}"${matched.length ? ` (now also ${matched.join(', ')})` : ''}`
    })
    throw new Error(`the firewall ${fw.name} (${fw.id}) is applied to ${serverTitle} and also to ${each.join(', ')}. To label it would hand a shared firewall to the remote ${name}. Nothing changed.\nRepair: take it off the others with ${hcloud(`firewall remove-from-resource ${fw.id} --type server --server <id>`)}, or give ${name} a firewall of its own, then run ${again} again. If the remote must own the shared firewall, label it by hand first: ${hcloud(`firewall add-label ${fw.id} managed-by=ndev ndev-name=${name}`)}`)
  }
  const loose = firewalls.find(f => f.name === `${name}-ssh` && !appliedIds.has(f.id) && !isOurs(f.labels, name))
  if (loose) throw new Error(`the firewall ${loose.name} (${loose.id}) has the name of the remote's firewall, is not applied to ${serverTitle}, and does not carry ${both}, so /dev remote create and remove would refuse it. Nothing changed.\nRepair: apply it with ${hcloud(`firewall apply-to-resource ${loose.id} --type server --server ${id}`)}, or rename it with ${hcloud(`firewall update ${loose.id} --name <name>`)}, then run ${again} again.`)

  // The remote's address: the floating IPv4 assigned to the server. Import assigns nothing.
  const fips = await hcJson<Fip[]>($, ctx, ['floating-ip', 'list', '-o', 'json'])
  const assigned = fips.filter(f => f.server === id && isV4(f))
  let fip: Fip | undefined
  if (o.floatingIp !== undefined) {
    const found = fips.find(f => String(f.id) === o.floatingIp || f.name === o.floatingIp)
    if (!found) throw new Error(`there is no floating IP "${o.floatingIp}" in the hcloud context ${ctx}. The floating IPv4s assigned to ${serverTitle}: ${assigned.map(fipTitle).join(', ') || 'none'}. Nothing changed.\nRepair: name one of them with --floating-ip <name or id>.`)
    if (!isV4(found)) throw new Error(`the floating IP ${fipTitle(found)} is not an IPv4 address, and the address of a remote is a floating IPv4. Nothing changed.\nRepair: name a floating IPv4 with --floating-ip <name or id>. Those assigned to ${serverTitle}: ${assigned.map(fipTitle).join(', ') || 'none'}.`)
    if (found.server !== id) throw new Error(`the floating IP ${fipTitle(found)} is not assigned to ${serverTitle}, and import assigns nothing. Nothing changed.\nRepair: assign it with ${hcloud(`floating-ip assign ${found.id} ${id}`)}, then run the command again. The floating IPv4s assigned to it now: ${assigned.map(fipTitle).join(', ') || 'none'}.`)
    fip = found
  } else if (assigned.length > 1) {
    throw new Error(`${serverTitle} has ${assigned.length} floating IPv4s assigned: ${assigned.map(fipTitle).join(', ')}, and a remote has one address. Nothing changed.\nRepair: run ${again} --floating-ip <name or id> with the one that is the remote's address.`)
  } else fip = assigned[0]
  // What an earlier remote of this name left: create and remove take these as this remote's, so the question shows them.
  const keptFip = fip ? undefined : fips.find(f => f.name === name && isOurs(f.labels, name))
  const snapshots = await hcJson<Img[]>($, ctx, ['image', 'list', '--type', 'snapshot', '-l', `ndev-name=${name}`, '-o', 'json'])
  if (!fip) {
    const named = fips.find(f => f.name === name && !isOurs(f.labels, name))
    if (named) throw new Error(`the floating IP ${fipTitle(named)} has the remote's name, is not assigned to ${serverTitle}, and does not carry ${both}, so /dev remote create and remove would refuse it. Nothing changed.\nRepair: assign it with ${hcloud(`floating-ip assign ${named.id} ${id}`)}, or rename it with ${hcloud(`floating-ip update ${named.id} --name <name>`)}, then run ${again} again.`)
  }

  // A label of another owner is never written over.
  const things: Thing[] = [
    { kind: 'server', id, title: serverTitle, labels: server.labels ?? {} },
    ...applied.map(f => ({ kind: 'firewall' as const, id: f.id, title: `the firewall ${f.name} (${f.id})`, labels: f.labels ?? {} })),
    ...(fip ? [{ kind: 'floating-ip' as const, id: fip.id, title: `the floating IPv4 ${fipTitle(fip)}`, labels: fip.labels ?? {} }] : []),
  ]
  for (const t of things) {
    const off = (label: string) => `Nothing changed.\nRepair: if that is no longer so, take the label off with ${hcloud(`${t.kind} remove-label ${t.id} ${label}`)}, then run ${again} again.`
    const owner = t.labels['ndev-name']
    if (owner !== undefined && owner !== name) throw new Error(`${t.title} already carries ndev-name=${owner}, so it belongs to the remote ${owner}. ${off('ndev-name')}`)
    const manager = t.labels['managed-by']
    if (manager !== undefined && manager !== 'ndev') throw new Error(`${t.title} already carries managed-by=${manager}, so another tool manages it. ${off('managed-by')}`)
  }

  // A remote of that name that this machine already records must be this server.
  const kept = store.hosts[name]
  const elsewhere = (what: string) => new Error(`${path} already holds ${what}. Nothing changed.\nRepair: if that record is of a remote that is gone, delete hosts.${name} from ${path}, then run ${again} again. If it is of another server, give this one another name first: ${hcloud(`server update ${id} --name <name>`)}`)
  if (kept && kept.context !== ctx) throw elsewhere(`a remote ${name} in the hcloud context ${kept.context}, not ${ctx}`)
  if (kept?.floatingIp !== undefined && kept.floatingIp !== fip?.id) throw elsewhere(`a remote ${name} with the floating IP ${kept.floatingIp} (${kept.ip ?? 'address not recorded'}), and the server ${id} has ${fip ? `the floating IP ${fip.id} (${fip.ip})` : 'no floating IPv4 assigned'}`)

  // The host key, read from the remote's address. It is checked against what this machine already knows before
  // anyone is asked to trust it.
  const address = fip?.ip ?? server.public_net.ipv4?.ip
  if (!address) throw new Error(`${serverTitle} has no floating IPv4 and no IPv4 address of its own, so there is no address to read its host key from. Nothing changed.\nRepair: assign a floating IPv4 with ${hcloud(`floating-ip assign <floating ip> ${id}`)}, then run ${again} again.`)
  const key = await presentedKey($, address, `check that SSH answers there (ssh -p ${SSH_PORT} root@${address})${fip ? `, and that the floating address is on the server (as root: ip addr add ${address} dev eth0)` : ''}, then run ${again} again.`)
  const print = await fingerprint($, key)
  const known = `${home}/.ssh/known_hosts`
  const knowns = await knownKeys($, known, address)
  if (knowns.length && !knowns.includes(key)) {
    throw new Error(`${known} on this machine holds the ed25519 host key ${(await Promise.all(knowns.map(k => fingerprint($, k)))).join(', ')} for ${address}, and the server now presents ${print}. One of them is not the server you mean, so neither is trusted. Nothing changed.\nRepair: read the server's own fingerprint in its Hetzner console (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub). If it is ${print}, take the old key out with ssh-keygen -R ${address} -f ${known}, then run ${again} again.`)
  }
  if (kept?.hostKey && kept.hostKey !== key) throw elsewhere(`the host key ${await fingerprint($, kept.hostKey)} for the remote ${name}, and the server ${id} presents ${print} at ${address}`)

  const missing = (t: Thing) => [['managed-by', 'ndev'], ['ndev-name', name]].filter(([k]) => !(k! in t.labels)).map(([k, v]) => `${k}=${v}`)
  const toLabel = things.filter(t => missing(t).length)
  const record: HostRecord = { ...kept, context: ctx, hostKey: key, ...(fip ? { floatingIp: fip.id, ip: fip.ip } : {}) }
  const isRecorded = kept !== undefined && JSON.stringify(kept) === JSON.stringify(record)
  if (!toLabel.length && isRecorded) {
    return `Nothing changed: ${serverTitle} is already the remote ${name} in the hcloud context "${ctx}". ${things.map(t => t.title).join(', ')} ${things.length === 1 ? 'carries' : 'carry'} both labels, and ${path} holds the record with the host key ${print}, which ${address} presents now.`
  }

  const isVouched = knowns.includes(key) || kept?.hostKey === key
  if (o.isYes && !isVouched) throw new Error(`--yes cannot give trust to the host key ${print} of ${address}: nothing on this machine vouches for it, and a key is never trusted without a person who has seen its fingerprint. Nothing changed.\nRepair: run it where you can answer the question. Or check the key yourself first (ssh -p ${SSH_PORT} root@${address} asks you to compare the fingerprint, and puts the key in ${known}); then --yes confirms.`)

  const others = assigned.filter(f => f !== fip)
  const noAddress = `The server has no floating IPv4, so the key is read from its own address ${address}. ${keptFip
    ? `The floating IPv4 ${fipTitle(keptFip)} already carries the labels of ${name}: /dev remote create ${name} assigns it to this server and sets it on eth0, and /dev remote remove ${name} keeps it.`
    : `/dev remote remove ${name} keeps no address for it, and /dev remote create ${name} makes a new floating IPv4, which Hetzner charges for, after it asks.`}`
  const limit = `Limit: this server was not built by scripts/remote/root-setup.sh, so a restore is only as good as its own cloud-init setting. A server restored from a snapshot is a new instance to cloud-init, which by default deletes the SSH host keys and makes new ones; /dev remote create then refuses the new key. Before the first /dev remote remove ${name}, as root on the server: printf 'ssh_deletekeys: false\\n' > /etc/cloud/cloud.cfg.d/99-ndev-keep-host-keys.cfg`
  const ownFirewall = firewalls.some(f => f.name === `${name}-ssh`)
  const unused = applied.filter(f => f.name !== `${name}-ssh`)
  const firewallNote = unused.length
    ? [`/dev remote create and remove use only a firewall named ${name}-ssh: ${unused.map(f => `${f.name} (${f.id})`).join(', ')} ${unused.length === 1 ? 'is' : 'are'} labelled and otherwise left alone${ownFirewall ? '' : `, /dev remote create ${name} makes ${name}-ssh without applying it to this server, and a server restored later gets only ${name}-ssh`}.${!ownFirewall && unused.length === 1 ? ` To have them use it, rename it first: ${hcloud(`firewall update ${unused[0]!.id} --name ${name}-ssh`)}` : ''}`]
    : []
  await confirm($, o, [
    `Import ${serverTitle} in the Hetzner project of the hcloud context "${ctx}" as the remote ${name}?`,
    ...(toLabel.length ? [`It adds ${both} to:`, ...toLabel.map(t => `- ${t.title}, which has the labels ${labelsShown(t.labels)}${missing(t).length === 1 ? ` (it adds only ${missing(t)[0]})` : ''}`)] : ['It adds no label.']),
    ...things.filter(t => !toLabel.includes(t)).map(t => `It leaves ${t.title} as it is: it carries both labels.`),
    ...others.map(f => `It leaves the floating IPv4 ${fipTitle(f)} as it is: it is not the remote's address.`),
    `It records in ${path}, as hosts.${name}: the hcloud context ${ctx}, ${fip ? `the floating IPv4 ${fip.ip} (${fip.id})` : 'no address'} and the host key.`,
    ...(fip ? [] : [noAddress]),
    ...(snapshots.length ? [`The snapshot ${snapshots.map(s => s.id).join(', ')} already carries ndev-name=${name}: /dev remote create and remove take it as this remote's, and remove deletes it once its new snapshot is available.`] : []),
    ...firewallNote,
    limit,
    `The ed25519 host key that ${address} presents now: ${print}`,
    isVouched ? `${knowns.includes(key) ? `${known} on this machine` : path} already holds that key for ${knowns.includes(key) ? address : name}.` : `Nothing on this machine vouches for that key. Compare it with the server's own, in its Hetzner console: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`,
    `This is the one moment trust is given: after it, /dev remote create and remove trust this key and no other for ${name}.`,
    'It creates, deletes, resizes and reassigns nothing, and it keeps every label that is there.',
  ].join('\n'), `Import ${name}`, 'Nothing changed.')

  return steps($, async did => {
    for (const t of toLabel) {
      try {
        await hc($, ctx, [t.kind, 'add-label', String(t.id), ...missing(t)])
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\nThe record of ${name} was not written.\nRepair: run ${again} again: it adds only the labels that are missing.`)
      }
      did(`labelled ${t.title}`)
    }
    store.hosts[name] = record
    await writeStore($, path, store)
    return [
      `${serverTitle[0]!.toUpperCase()}${serverTitle.slice(1)} is now the remote ${name} in the hcloud context "${ctx}": ${toLabel.length ? `${toLabel.map(t => t.title).join(', ')} now ${toLabel.length === 1 ? 'carries' : 'carry'} ${both}` : 'no label was missing'}, and ${path} records its hcloud context, ${fip ? `its floating IPv4 ${fip.ip} ` : ''}and its host key ${print}.`,
      `/dev remote remove ${name} and /dev remote create ${name} now accept it. /dev remote create ${name} checks SSH with that key and links Orca; it signs in by key as root at the server's own address and as ${USER} at ${fip ? address : 'the floating address'}, so the server needs both.`,
      ...(fip ? [] : [noAddress]),
      ...firewallNote,
      limit,
    ].join('\n')
  })
}
