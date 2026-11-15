import { expect, test } from 'claude-code/testing'

// /dev remote create makes a Hetzner Cloud server for Orca: from the snapshot that /dev remote remove kept for that
// name, else from the base image, prepared over SSH. /dev remote remove snapshots the server, then deletes it. The
// remote's address is a floating IPv4 that remove keeps and create assigns again. Only the command-line tools are
// faked, all behind the engine's one process runner: hcloud, ssh, ssh-keygen, orca and a few local commands.

type On = Parameters<Parameters<typeof test>[1]>[1]
type Engine = Parameters<Parameters<typeof test>[1]>[0]

const ROOT = '/proj'
const HOME = '/home/neil'
const STORE = `${HOME}/.config/ndev/remote.json`
const KNOWN = `${HOME}/.ssh/known_hosts`
const TMP = '/tmp/ndev-remote-1'
const FLOATING = '198.51.100.9'
const out = (stdout = '', exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })

type Labels = Record<string, string>
type Srv = { id: number; name: string; labels: Labels; status: string; public_net: { ipv4: { ip: string } | null }; server_type: unknown; location: { name: string } }
type Applied = { type: 'server'; server: { id: number } } | { type: 'label_selector'; label_selector: { selector: string }; applied_to_resources?: { type: 'server'; server: { id: number } }[] }
type Fw = { id: number; name: string; labels: Labels; rules?: unknown; applied_to?: Applied[] }
type Img = { id: number; type: string; description: string; created: string; status: string; image_size: number | null; disk_size: number; architecture: string; labels: Labels }
type Fip = { id: number; name: string; ip: string; labels: Labels; server: number | null; home_location: { name: string; network_zone: string } }

const price = (location: string, gross: string) => ({ location, price_monthly: { net: '0', gross } })
const TYPES = [
  { name: 'cx23', cores: 2, memory: 4, disk: 40, architecture: 'x86', prices: [price('fsn1', '5.3431')] },
  { name: 'cx33', cores: 4, memory: 8, disk: 80, architecture: 'x86', prices: [price('fsn1', '10.1880'), price('hel1', '10.1880')] },
  { name: 'cax21', cores: 4, memory: 8, disk: 80, architecture: 'arm', prices: [price('fsn1', '9.5081')] },
  { name: 'cpx32', cores: 4, memory: 8, disk: 160, architecture: 'x86', prices: [price('fsn1', '42.2331'), price('ash', '45.0000')] },
]
const PRICING = { pricing: { currency: 'EUR', image: { price_per_gb_month: { gross: '0.0172' } }, floating_ips: [{ type: 'ipv4', prices: [price('fsn1', '3.6000'), price('hel1', '3.6000')] }] } }
const ZONES: Record<string, string> = { fsn1: 'eu-central', hel1: 'eu-central', ash: 'us-east' }
const PUBLIC = 'ssh-ed25519 AAAAC3desktop neil@desk'
const LABELS = (name: string) => ({ 'managed-by': 'ndev', 'ndev-name': name })
const NEW_KEY = 'ssh-ed25519 AAAAnewhostkey'
// The host key that a server presents to ssh-keyscan, and the fingerprint the fake ssh-keygen prints for a key.
const PRESENTED = 'ssh-ed25519 AAAApresented'
const print = (key: string) => `SHA256:${key.split(' ')[1]}`

type Opts = {
  servers?: Srv[]
  firewalls?: Fw[]
  images?: Img[]
  fips?: Fip[]
  orcaServers?: { id: string; name: string }[]
  store?: unknown
  // The statuses that the new snapshot shows on each listing after it is made; the last one stays.
  snapshotStatus?: string[]
  // The host key lines that ssh-keyscan reads from every address; the default is PRESENTED.
  presents?: string[]
  // The host key that the server proves it holds when ssh connects. When it is set, the fake ssh, like ssh with
  // StrictHostKeyChecking=yes, refuses a connection whose known_hosts file holds no line "<address> <that key>".
  proves?: string
  fail?: (argv: string[], stdin: string) => ReturnType<typeof out> | undefined
  answer?: (question: string, options: string[]) => string | undefined
}

function world(on: On, opts: Opts = {}) {
  const files = new Map<string, string>([
    [`${ROOT}/.neil-dev.json`, JSON.stringify({ github: { repo: 'acme/widgets', board: null } })],
    [`${HOME}/.ssh/id_ed25519.pub`, `${PUBLIC}\n`],
    [KNOWN, '10.0.0.9 ssh-ed25519 AAAAother\n'],
  ])
  if (opts.store) files.set(STORE, JSON.stringify(opts.store))
  const servers = opts.servers ?? []
  const firewalls = opts.firewalls ?? []
  const images = opts.images ?? []
  const fips = opts.fips ?? []
  const orcaServers = opts.orcaServers ?? [{ id: 'aa11-x', name: 'vm-a' }]
  const runs: { argv: string[]; stdin?: string; known?: string }[] = []
  const asked: { question: string; options: string[] }[] = []
  const statuses = [...(opts.snapshotStatus ?? ['available'])]
  let nextId = 900
  const fresh = new Set<number>()

  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__ndev__${e.name}` } }))
  on('clock.now', () => ({ value: 1_800_000_000_000 }))
  on('clock.sleep', () => ({ value: undefined }))
  on('clock.every', () => new Promise(() => {}))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'remote-host-session' }))
  on('prompt.compose', () => ({ sections: [] }))
  on('env.get', () => ({ value: HOME }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) || [...files.keys()].some(p => p.startsWith(`${e.path}/`)) || e.path.startsWith(`${HOME}/dev-wiki`) }))
  on('fs.read', (_, e) => {
    if (e.path.endsWith('/scripts/remote/root-setup.sh')) return { value: '# root stage\n' }
    if (e.path.endsWith('/scripts/remote/floating-ip.sh')) return { value: '# floating stage\n' }
    if (!files.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: files.get(e.path)! }
  })
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.list', (_, e) => ({ value: [...files.keys()].filter(p => p.startsWith(`${e.path}/`) && !p.slice(e.path.length + 1).includes('/')).map(p => ({ name: p.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const q = e.questions[0]!
    const options = q.options.map((o: { label: string }) => o.label)
    asked.push({ question: q.question, options })
    const answer = opts.answer ? opts.answer(q.question, options) : options[0]
    if (answer === undefined) throw new Error('dismissed')
    return { result: { answers: { [q.question]: answer } }, text: answer }
  })

  const hcloud = (a: string[], stdin: string) => {
    const cmd = a.join(' ')
    if (cmd === 'hcloud context list -o noheader -o columns=name') return out('other\nproj\n')
    if (a[1] !== '--context') return out('', 1, `unexpected hcloud call with no --context: ${cmd}`)
    const rest = a.slice(3)
    const r = rest.join(' ')
    const last = a.at(-1)!
    if (r.startsWith('server-type describe ')) {
      const type = TYPES.find(t => t.name === rest[2])
      return type ? out(JSON.stringify(type)) : out('', 1, `hcloud: Server Type not found: ${rest[2]}`)
    }
    if (r.startsWith('location describe ')) return out(JSON.stringify({ name: rest[2], network_zone: ZONES[rest[2]!] }))
    if (r === 'api /pricing') return out(JSON.stringify(PRICING))
    if (r === 'ssh-key list -o json') return out(JSON.stringify([{ id: 7, name: 'desk', public_key: PUBLIC }, { id: 8, name: 'lost', public_key: 'ssh-rsa AAAAgone x' }]))
    if (r === 'server list -o json') return out(JSON.stringify(servers))
    if (r.startsWith('server describe ')) {
      const server = servers.find(s => String(s.id) === rest[2])
      if (!server) return out('', 1, `hcloud: Server not found: ${rest[2]}`)
      const applied = firewalls.filter(f => f.applied_to?.some(x => x.type === 'label_selector' || x.server.id === server.id)).map(f => ({ id: f.id, status: 'applied' }))
      return out(JSON.stringify({ ...server, public_net: { ...server.public_net, firewalls: applied } }))
    }
    if (/^(server|firewall|floating-ip) add-label /.test(r)) {
      const thing = (rest[0] === 'server' ? servers : rest[0] === 'firewall' ? firewalls : fips).find(x => String(x.id) === rest[2])
      if (!thing) return out('', 1, `hcloud: ${rest[0]} not found: ${rest[2]}`)
      for (const label of rest.slice(3)) {
        const [k, v] = label.split('=') as [string, string]
        if (k in thing.labels) return out('', 1, `hcloud: label ${k} on ${rest[0]} ${rest[2]} already exists`)
        thing.labels[k] = v
      }
      return out()
    }
    if (r === 'firewall list -o json') return out(JSON.stringify(firewalls))
    if (r === 'floating-ip list -o json') return out(JSON.stringify(fips))
    if (r.startsWith('image list --type snapshot -l ')) {
      const [k, v] = rest[5]!.split('=') as [string, string]
      for (const i of images) if (fresh.has(i.id)) i.status = statuses.length > 1 ? statuses.shift()! : statuses[0]!
      return out(JSON.stringify(images.filter(i => i.labels[k] === v)))
    }
    if (r.startsWith('firewall create')) {
      firewalls.push({ id: nextId++, name: a[a.indexOf('--name') + 1]!, labels: labelsOf(a), rules: JSON.parse(stdin) })
      return out()
    }
    if (r.startsWith('floating-ip create')) {
      const location = a[a.indexOf('--home-location') + 1]!
      fips.push({ id: nextId++, name: a[a.indexOf('--name') + 1]!, ip: FLOATING, labels: labelsOf(a), server: null, home_location: { name: location, network_zone: ZONES[location]! } })
      return out()
    }
    if (r.startsWith('floating-ip assign')) { fips.find(f => String(f.id) === rest[2])!.server = Number(rest[3]); return out() }
    if (r.startsWith('floating-ip unassign')) { fips.find(f => String(f.id) === last)!.server = null; return out() }
    if (r.startsWith('floating-ip delete')) { fips.splice(fips.findIndex(f => String(f.id) === last), 1); return out() }
    if (r.startsWith('server create ')) {
      const type = TYPES.find(t => t.name === a[a.indexOf('--type') + 1])
      servers.push({ id: nextId++, name: a[a.indexOf('--name') + 1]!, labels: labelsOf(a), status: 'running', public_net: { ipv4: { ip: '203.0.113.7' } }, server_type: type, location: { name: a[a.indexOf('--location') + 1]! } })
      return out()
    }
    if (r.startsWith('server shutdown')) { servers.find(s => String(s.id) === rest[2])!.status = 'off'; return out() }
    if (r.startsWith('server create-image')) {
      fresh.add(nextId)
      images.push({ id: nextId++, type: 'snapshot', description: a[a.indexOf('--description') + 1]!, created: '2027-01-15T10:00:00+00:00', status: 'pending', image_size: 6.5, disk_size: 80, architecture: 'x86', labels: labelsOf(a) })
      return out('Image 9 created from Server\n')
    }
    if (r.startsWith('server delete')) { servers.splice(servers.findIndex(s => String(s.id) === last), 1); return out() }
    if (r.startsWith('firewall delete')) { firewalls.splice(firewalls.findIndex(f => String(f.id) === last), 1); return out() }
    if (r.startsWith('image delete')) { images.splice(images.findIndex(i => String(i.id) === last), 1); return out() }
    return out('', 1, `unmocked hcloud: ${cmd}`)
  }

  on('process.run', (_, e) => {
    const a = [...e.argv]
    const stdin = e.init?.stdin === undefined ? '' : String(e.init.stdin)
    const knownAt = a.find(x => x.startsWith('UserKnownHostsFile='))?.slice('UserKnownHostsFile='.length) ?? KNOWN
    runs.push({ argv: a, ...(e.init?.stdin === undefined ? {} : { stdin }), ...(a[0] === 'ssh' ? { known: files.get(knownAt) ?? '' } : {}) })
    const failed = opts.fail?.(a, stdin)
    if (failed) return failed
    const cmd = a.join(' ')
    if (a[0] === 'git') return out(`${ROOT}\n`)
    if (a[0] === 'mkdir' || a[0] === 'sleep') return out()
    if (a[0] === 'mktemp') return out(`${TMP}\n`)
    if (a[0] === 'rm') { for (const p of [...files.keys()]) if (a.slice(2).some(t => p === t || p.startsWith(`${t}/`))) files.delete(p); return out() }
    if (a[0] === 'ssh-keygen' && a.includes('-R')) return out()
    if (a[0] === 'ssh-keyscan') return out((opts.presents ?? [PRESENTED]).map(k => `${a.at(-1)} ${k}\n`).join(''), 0, `# ${a.at(-1)}:22 SSH-2.0-OpenSSH_9.6\n`)
    if (a[0] === 'ssh-keygen' && a.includes('-lf')) return out(`256 ${print(stdin.trim())} no comment (ED25519)\n`)
    if (a[0] === 'ssh-keygen' && a.includes('-F')) {
      const host = a[a.indexOf('-F') + 1]!
      const lines = (files.get(a[a.indexOf('-f') + 1]!) ?? '').split('\n').filter(l => l.split(' ')[0] === host)
      return lines.length ? out(`# Host ${host} found: line 1\n${lines.join('\n')}\n`) : out('', 1)
    }
    if (a[0] === 'ssh-keygen') {
      const path = a[a.indexOf('-f') + 1]!
      files.set(path, '-----BEGIN OPENSSH PRIVATE KEY-----\nFIRSTBOOT\n-----END OPENSSH PRIVATE KEY-----\n')
      files.set(`${path}.pub`, 'ssh-ed25519 AAAAfirstboot box-1 first boot\n')
      return out()
    }
    if (a[0] === 'orca') {
      if (a[1] === 'environment' && a[2] === 'list') return out(JSON.stringify({ ok: true, result: { environments: orcaServers } }))
      return out('', 1, `unmocked orca: ${cmd}`)
    }
    // hcloud runs only with the token and the context variable removed: the fake refuses any other form.
    if (a.includes('hcloud')) {
      if (a.slice(0, 5).join(' ') !== 'env -u HCLOUD_TOKEN -u HCLOUD_CONTEXT') return out('', 1, `hcloud ran with HCLOUD_TOKEN in reach: ${cmd}`)
      return hcloud(a.slice(5), stdin)
    }
    if (a[0] === 'ssh') {
      const remote = a.at(-1)!
      const host = a.at(-2)!.split('@').at(-1)!
      if (opts.proves && !(files.get(knownAt) ?? '').split('\n').includes(`${host} ${opts.proves}`)) {
        return out('', 255, `@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\nHost key verification failed.\n`)
      }
      if (remote.includes('test -f /var/run/reboot-required')) return out('', 1)
      if (remote.endsWith('bash -s') && stdin.startsWith('# root stage')) return out(`${NEW_KEY}\n`)
      return out()
    }
    return out('', 1, `unmocked: ${cmd}`)
  })
  type Store = { projects: Record<string, { id: string; name: string }>; hosts?: Record<string, Record<string, unknown>> }
  const store = () => (files.has(STORE) ? JSON.parse(files.get(STORE)!) as Store : undefined)
  const hcloudRuns = () => runs.filter(r => r.argv.includes('hcloud')).map(r => r.argv.slice(r.argv.indexOf('hcloud')))
  return {
    files, runs, asked, servers, firewalls, images, fips, orcaServers, store, hcloudRuns,
    // The calls that make, change or delete a Hetzner resource, or switch a server off, without the context words.
    changes: () => hcloudRuns().map(a => a.slice(3).join(' ')).filter(r => /^(server|firewall|image|floating-ip) (create|create-image|delete|shutdown|poweroff|poweron|assign|unassign|add-label)\b/.test(r)),
    ssh: () => runs.filter(r => r.argv[0] === 'ssh'),
  }
}

const labelsOf = (a: string[]) => Object.fromEntries(a.flatMap((x, i) => (x === '--label' ? [a[i + 1]!.split('=') as [string, string]] : [])))
const ours = (id: number, name: string, extra: Partial<Srv> = {}): Srv => ({
  id, name, labels: LABELS(name), status: 'running', public_net: { ipv4: { ip: '203.0.113.7' } }, server_type: TYPES[1], location: { name: 'fsn1' }, ...extra,
})
const snapshot = (id: number, name: string, extra: Partial<Img> = {}): Img => ({
  id, type: 'snapshot', description: `ndev ${name}`, created: '2026-12-01T09:00:00+00:00', status: 'available', image_size: 5.2, disk_size: 80, architecture: 'x86', labels: { ...LABELS(name), 'ndev-type': 'cx33', 'ndev-location': 'fsn1' }, ...extra,
})
const ourFirewall = (id: number, name: string): Fw => ({ id, name: `${name}-ssh`, labels: LABELS(name), rules: [{ direction: 'in', protocol: 'tcp', port: '22' }] })
const ourFip = (id: number, name: string, server: number | null, extra: Partial<Fip> = {}): Fip => ({ id, name, ip: FLOATING, labels: LABELS(name), server, home_location: { name: 'fsn1', network_zone: 'eu-central' }, ...extra })
const hostRecord = (extra: Record<string, unknown> = {}) => ({ context: 'proj', sshKey: 'desk', floatingIp: 60, ip: FLOATING, hostKey: NEW_KEY, ...extra })
// A remote that is up: its server, floating IP and firewall, and this machine's record of it.
const up = (extra: Opts = {}): Opts => ({ servers: [ours(901, 'box-1')], fips: [ourFip(60, 'box-1', 901)], firewalls: [ourFirewall(5, 'box-1')], store: { projects: {}, hosts: { 'box-1': hostRecord() } }, ...extra })
// A remote that remove took down: its snapshot, floating IP and firewall are kept.
const down = (extra: Opts = {}): Opts => ({ images: [snapshot(40, 'box-1')], fips: [ourFip(60, 'box-1', null)], firewalls: [ourFirewall(5, 'box-1')], store: { projects: {}, hosts: { 'box-1': hostRecord() } }, ...extra })

const start = ($: Engine, isInteractive = true) => $.session.start({ cwd: `${ROOT}/src`, surface: 'terminal', isInteractive })
const dev = async ($: Engine, args: string) => (await $.command.run({ command: 'dev', args: `remote ${args}`.trim() })).text ?? ''

// --- the safety rules ------------------------------------------------------------------------------------------------

test('create shows the type, the monthly prices, the location and the Hetzner project before any spend, and makes nothing when the human cancels', async ($, on) => {
  const w = world(on, { answer: () => 'Cancel' })
  await start($)

  const text = await dev($, 'create box-1 --context proj')
  expect(w.asked).toHaveLength(1)
  const plan = w.asked[0]!.question
  expect(plan).toMatch(/hcloud context "proj"/)
  expect(plan).toMatch(/cx33 \(4 vCPU, 8 GB memory, 80 GB disk\) in fsn1, EUR 10\.19 a month/)
  expect(plan).toMatch(/base image ubuntu-24\.04, because box-1 has no snapshot/)
  expect(plan).toMatch(/floating IPv4 box-1 in fsn1, EUR 3\.60 a month/)
  expect(plan).toMatch(/firewall box-1-ssh/)
  expect(plan).toMatch(/Nothing is deleted/)
  expect(w.asked[0]!.options).toEqual(['Create box-1', 'Cancel'])
  expect(text).toMatch(/cancelled\. Nothing was created/)
  expect(w.changes()).toEqual([])
})

test('with no one to confirm, create and remove refuse and change nothing; only --yes confirms without a person', async ($, on) => {
  const w = world(on, up({ answer: () => undefined }))
  await start($)

  const removed = await dev($, 'remove box-1')
  expect(removed).toMatch(/no one confirmed it, so it is refused\. Nothing changed/)
  expect(removed).toMatch(/--yes/)
  expect(await dev($, 'create box-2 --context proj')).toMatch(/no one confirmed it, so it is refused\. Nothing was created/)
  expect(w.changes()).toEqual([])

  expect(await dev($, 'remove box-1 --yes')).toMatch(/The remote box-1 is removed/)
  expect(w.asked).toHaveLength(2)
  expect(w.servers).toEqual([])
})

test('a session with no person at it is not asked at all: create and remove refuse, and --yes still confirms', async ($, on) => {
  const w = world(on, up())
  await start($, false)

  expect(await dev($, 'remove box-1')).toMatch(/no one confirmed it, so it is refused\. Nothing changed/)
  expect(await dev($, 'create box-2 --context proj')).toMatch(/no one confirmed it, so it is refused\. Nothing was created/)
  expect(w.asked).toEqual([])
  expect(w.changes()).toEqual([])
  expect(await dev($, 'remove box-1 --yes')).toMatch(/The remote box-1 is removed/)
})

test('every hcloud call names its context and runs with HCLOUD_TOKEN and HCLOUD_CONTEXT removed; the active context is never used', async ($, on) => {
  const w = world(on, up())
  await start($)
  await dev($, 'remove box-1')
  await dev($, 'create box-1')

  const calls = w.runs.filter(r => r.argv.includes('hcloud'))
  expect(calls.length).toBeGreaterThan(15)
  for (const r of calls) {
    expect(r.argv.slice(0, 6)).toEqual(['env', '-u', 'HCLOUD_TOKEN', '-u', 'HCLOUD_CONTEXT', 'hcloud'])
    if (r.argv[6] !== 'context') expect(r.argv.slice(6, 8)).toEqual(['--context', 'proj'])
  }
  expect(w.servers).toHaveLength(1)
})

test('create and remove need a named hcloud context: no flag and none kept is refused with the contexts, and so is one hcloud does not have', async ($, on) => {
  const w = world(on, { servers: [ours(901, 'box-1')] })
  await start($)

  for (const word of ['create', 'remove']) {
    const none = await dev($, `${word} box-1`)
    expect(none).toMatch(/no hcloud context is named for box-1/)
    expect(none).toMatch(/active context and HCLOUD_CONTEXT are never used/)
    expect(none).toMatch(/The contexts here: other, proj/)
    expect(none).toMatch(new RegExp(`Repair: run /dev remote ${word} box-1 --context <context>`))
    expect(await dev($, `${word} box-1 --context nope`)).toMatch(/there is no hcloud context "nope".*other, proj/)
  }
  // Nothing was read from any project, and nothing changed.
  expect(w.hcloudRuns().every(a => a[1] === 'context')).toBe(true)
  expect(w.changes()).toEqual([])
})

// A server made by hand: with its project's own labels, with managed-by=ndev but no name label, and with another name.
for (const labels of [{ project: 'fcc-proto', role: 'orca-host' }, { 'managed-by': 'ndev' }, { 'managed-by': 'ndev', 'ndev-name': 'other' }] as Labels[]) {
  test(`remove and create refuse a server without both labels (it has ${JSON.stringify(labels)}), name the labels and /dev remote import, and change nothing`, async ($, on) => {
    const w = world(on, { servers: [ours(176003111, 'orca-dev-2', { labels })] })
    await start($)

    for (const word of ['remove', 'create']) {
      const text = await dev($, `${word} orca-dev-2 --context proj --yes`)
      expect(text).toMatch(/the server orca-dev-2 \(176003111\) in the hcloud context proj does not carry the labels managed-by=ndev and ndev-name=orca-dev-2/)
      expect(text).toMatch(/Nothing changed/)
      expect(text).toContain('Repair: use another name. Or, if it is yours to hand to /dev remote: /dev remote import 176003111 --context proj')
      expect(text).not.toContain('add-label')
    }
    expect(w.changes()).toEqual([])
    expect(w.servers).toHaveLength(1)
  })
}

const UNLABELLED: [string, Opts, RegExp][] = [
  ['snapshot', { images: [snapshot(40, 'box-1', { labels: { 'ndev-name': 'box-1' } })] }, /the image "ndev box-1" \(40\).*does not carry the labels/],
  ['floating IP', { fips: [ourFip(60, 'box-1', null, { labels: {} })] }, /the floating-ip box-1 \(60\).*does not carry the labels/],
  ['firewall', { firewalls: [{ ...ourFirewall(5, 'box-1'), labels: { role: 'orca-host' } }] }, /the firewall box-1-ssh \(5\).*does not carry the labels.*its labels: role=orca-host/],
]
for (const [what, opts, refusal] of UNLABELLED) {
  test(`remove --forget and create refuse a ${what} without the labels, and touch nothing`, async ($, on) => {
    const w = world(on, opts)
    await start($)
    for (const command of ['remove box-1 --forget --context proj --yes', 'create box-1 --context proj --yes']) {
      expect(await dev($, command)).toMatch(refusal)
    }
    expect(w.changes()).toEqual([])
  })
}

// --- create ----------------------------------------------------------------------------------------------------------

test('create from the base image makes the labelled firewall, floating IP and server, prepares the host, and says what set-up is still to do', async ($, on) => {
  const w = world(on)
  await start($)

  const text = await dev($, 'create box-1 --context proj')
  expect(w.changes()).toEqual([
    'firewall create --name box-1-ssh --label managed-by=ndev --label ndev-name=box-1 --rules-file -',
    'floating-ip create --type ipv4 --name box-1 --home-location fsn1 --label managed-by=ndev --label ndev-name=box-1',
    'server create --name box-1 --type cx33 --location fsn1 --ssh-key desk --firewall box-1-ssh --label managed-by=ndev --label ndev-name=box-1 --image ubuntu-24.04 --user-data-from-file -',
    'floating-ip assign 901 902',
  ])
  // The firewall lets in only SSH and ping.
  const rules = w.firewalls[0]!.rules as { protocol: string; port?: string | null }[]
  expect(rules.map(r => `${r.protocol}${r.port ? `:${r.port}` : ''}`)).toEqual(['tcp:22', 'icmp'])
  // The first-boot host key goes in by the user data on stdin; its private half never stays on this machine.
  const create = w.runs.find(r => r.argv.includes('server') && r.argv.includes('create'))!
  expect(create.stdin).toMatch(/FIRSTBOOT/)
  expect([...w.files.values()].some(v => v.includes('FIRSTBOOT'))).toBe(false)
  expect([...w.files.keys()].some(p => p.startsWith(TMP))).toBe(false)
  // The first connection already trusts the first-boot key, in a known hosts file of its own.
  const ssh = w.ssh()
  expect(ssh[0]!.argv.join(' ')).toContain(`StrictHostKeyChecking=yes -o ConnectTimeout=15 -o UserKnownHostsFile=${TMP}/known_hosts -o GlobalKnownHostsFile=/dev/null root@203.0.113.7`)
  expect(ssh[0]!.known).toBe('203.0.113.7 ssh-ed25519 AAAAfirstboot\n')
  // The floating address is set on the server by the script, after the root stage.
  const stages = ssh.filter(r => r.argv.at(-1)!.endsWith('bash -s')).map(r => `${r.argv.at(-1)} < ${r.stdin!.trim()}`)
  expect(stages).toEqual(['u=orca bash -s < # root stage', `floating=${FLOATING} bash -s < # floating stage`])
  // The last check is SSH as the workspace user on the floating address, against the desktop's own known hosts,
  // which ends with the server's new key for that address and keeps the other hosts.
  expect(ssh.at(-1)!.argv.slice(-2)).toEqual([`orca@${FLOATING}`, 'true'])
  expect(ssh.at(-1)!.argv.join(' ')).not.toContain('UserKnownHostsFile')
  expect(ssh.every(r => r.argv.includes('StrictHostKeyChecking=yes'))).toBe(true)
  expect(w.files.get(KNOWN)).toBe(`10.0.0.9 ssh-ed25519 AAAAother\n${FLOATING} ${NEW_KEY}\n`)
  // This machine keeps the context, the key, the floating IP and the host key; the address is the floating one.
  expect(w.store()?.hosts?.['box-1']).toEqual({ context: 'proj', sshKey: 'desk', floatingIp: 901, ip: FLOATING, hostKey: NEW_KEY })
  expect(text).toMatch(new RegExp(`The remote box-1 is up in the hcloud context "proj": server 902, floating IPv4 ${FLOATING.replace(/\./g, '\\.')}`))
  expect(text).toMatch(/host set-up is still to do/)
  expect(text).toMatch(/gh auth login.*clone.*claude auth login/)
  // Orca has no saved server for it and no CLI way to make one: the manual step, and the setting is left unset.
  expect(text).toMatch(/In the Orca app: New workspace, then Run on/)
  expect(text).toContain(`orca@${FLOATING}`)
  expect(w.store()?.projects['acme/widgets']).toBeUndefined()
  expect(w.runs.some(r => r.argv[0] === 'orca' && r.argv[2] !== 'list')).toBe(false)
})

test('create run again finds its own server, makes nothing twice, asks nothing, and saves the Orca server as the setting once Orca has it', async ($, on) => {
  const w = world(on, up())
  await start($)

  const again = await dev($, 'create box-1')
  expect(w.changes()).toEqual([])
  expect(w.asked).toEqual([])
  expect(again).toMatch(/The remote box-1 is up/)
  expect(again).toMatch(/In the Orca app/)

  w.orcaServers.push({ id: 'bb22-y', name: 'box-1 VM 1a2b' })
  expect(await dev($, 'create box-1')).toMatch(/box-1 VM 1a2b \(bb22-y\) is now the \/dev remote of acme\/widgets/)
  expect(w.changes()).toEqual([])
  expect(w.store()?.projects['acme/widgets']).toEqual(expect.objectContaining({ id: 'bb22-y', name: 'box-1 VM 1a2b' }))
})

test('create restores the newest snapshot as the recorded type, assigns the kept floating IP to the new server, and checks the address on it', async ($, on) => {
  const w = world(on, down({ images: [snapshot(40, 'box-1', { labels: { ...LABELS('box-1'), 'ndev-type': 'cpx32', 'ndev-location': 'fsn1' } }), snapshot(39, 'box-1', { created: '2026-11-01T09:00:00+00:00' })] }))
  await start($)

  const text = await dev($, 'create box-1')
  expect(w.asked[0]!.question).toMatch(/cpx32 .* in fsn1, EUR 42\.23 a month.*restored from the snapshot 40 \(80 GB disk, made 2026-12-01\)/)
  expect(w.asked[0]!.question).toMatch(new RegExp(`It keeps the floating IPv4 ${FLOATING.replace(/\./g, '\\.')}`))
  expect(w.changes()).toEqual([
    'server create --name box-1 --type cpx32 --location fsn1 --ssh-key desk --firewall box-1-ssh --label managed-by=ndev --label ndev-name=box-1 --image 40',
    'floating-ip assign 60 900',
  ])
  expect(w.fips).toEqual([expect.objectContaining({ id: 60, ip: FLOATING, server: 900 })])
  // No first build: no user data, no root stage. Only the check of the address, over the server's own address with
  // the host key of the first build, and then SSH on the floating address.
  expect(w.runs.find(r => r.argv.includes('create') && r.argv.includes('server'))!.stdin).toBeUndefined()
  const ssh = w.ssh()
  expect(ssh.some(r => r.stdin?.startsWith('# root stage'))).toBe(false)
  const check = ssh.find(r => r.stdin?.startsWith('# floating stage'))!
  expect(check.argv.slice(-2)).toEqual(['root@203.0.113.7', `floating=${FLOATING} bash -s`])
  expect(check.known).toBe(`203.0.113.7 ${NEW_KEY}\n`)
  expect(ssh.at(-1)!.argv.slice(-2)).toEqual([`orca@${FLOATING}`, 'true'])
  expect(w.files.get(KNOWN)).toContain(`${FLOATING} ${NEW_KEY}\n`)
  expect(text).toMatch(/The remote box-1 is up/)
  expect(text).not.toMatch(/still to do/)
})

test('--type names another server type for the restore, and a type the server does not have is refused once it exists', async ($, on) => {
  const w = world(on, down())
  await start($)

  await dev($, 'create box-1 --type cpx32 --yes')
  expect(w.changes()[0]).toMatch(/^server create --name box-1 --type cpx32 /)
  expect(await dev($, 'create box-1 --type cx23')).toMatch(/already exists with the type cpx32, not cx23.*Nothing changed/s)
})

test('create refuses a type whose disk is smaller than the snapshot\'s, and names both sizes and the repair', async ($, on) => {
  const w = world(on, down({ images: [snapshot(40, 'box-1', { disk_size: 160 })] }))
  await start($)

  // The recorded type, cx33, has an 80 GB disk.
  const text = await dev($, 'create box-1 --yes')
  expect(text).toMatch(/the snapshot 40 of box-1 is of a 160 GB disk, and the server type cx33 has a 80 GB disk/)
  expect(text).toMatch(/Nothing was created/)
  expect(text).toMatch(/Repair: run \/dev remote create box-1 --type <type> with a type of at least 160 GB/)
  expect(w.changes()).toEqual([])

  await dev($, 'create box-1 --type cpx32 --yes')
  expect(w.changes()[0]).toMatch(/--type cpx32 .*--image 40$/)
})

test('create refuses a location outside the floating IP\'s network zone, a type not sold there, and an SSH key this machine cannot use', async ($, on) => {
  const w = world(on, down())
  await start($)

  expect(await dev($, 'create box-1 --type cpx32 --location ash --yes')).toMatch(/network zone eu-central \(fsn1\), and ash is in us-east.*Nothing was created/s)
  expect(await dev($, 'create box-1 --location hel1 --type cpx32 --yes')).toMatch(/cpx32 is not sold in hel1; it is sold in fsn1, ash/)
  expect(await dev($, 'create box-1 --ssh-key lost --yes')).toMatch(/SSH key lost \(8\).*matches no public key in \/home\/neil\/\.ssh/)
  expect(await dev($, 'create box-1 --ssh-key nope --yes')).toMatch(/there is no SSH key "nope".*desk \(7\), lost \(8\)/)
  expect(w.changes()).toEqual([])
})

test('create adopts a floating IP made by hand only once it carries the labels, and names the label command; it never labels it itself', async ($, on) => {
  const handMade = ourFip(162501839, 'build-server', null, { ip: '88.99.125.86', labels: {} })
  const w = world(on, { fips: [handMade] })
  await start($)

  const refused = await dev($, 'create box-1 --context proj --floating-ip build-server --yes')
  expect(refused).toMatch(/the floating-ip build-server \(162501839\).*does not carry the labels managed-by=ndev and ndev-name=box-1/)
  expect(refused).toContain('hcloud --context proj floating-ip add-label 162501839 managed-by=ndev ndev-name=box-1')
  expect(await dev($, 'create box-1 --context proj --floating-ip nope --yes')).toMatch(/there is no floating IP "nope".*build-server \(162501839, 88\.99\.125\.86\)/)
  expect(w.changes()).toEqual([])

  // The owner runs the label command; then create takes it, by name or id, and makes no other.
  handMade.labels = LABELS('box-1')
  const text = await dev($, 'create box-1 --context proj --floating-ip 162501839 --yes')
  expect(w.changes().filter(c => c.startsWith('floating-ip'))).toEqual(['floating-ip assign 162501839 901'])
  expect(text).toMatch(/floating IPv4 88\.99\.125\.86, SSH as orca@88\.99\.125\.86/)
  expect(w.store()?.hosts?.['box-1']).toEqual(expect.objectContaining({ floatingIp: 162501839, ip: '88.99.125.86' }))

  // remove finds it again from this machine's record, with no option, and keeps it.
  await dev($, 'remove box-1 --yes')
  expect(w.changes()).toContain('floating-ip unassign 162501839')
  expect(w.fips).toEqual([expect.objectContaining({ id: 162501839, server: null })])
})

test('when the floating address cannot be set on the server, the failure names the address, the interface, the output and the ip addr add repair', async ($, on) => {
  const w = world(on, down({ fail: (a, stdin) => (a[0] === 'ssh' && stdin.startsWith('# floating stage') ? out('', 2, 'RTNETLINK answers: Operation not permitted') : undefined) }))
  await start($)

  const text = await dev($, 'create box-1 --yes')
  expect(text).toMatch(new RegExp(`the floating address ${FLOATING.replace(/\./g, '\\.')} was not set on the interface eth0 of root@203\\.0\\.113\\.7: floating-ip\\.sh exited 2: RTNETLINK answers: Operation not permitted`))
  expect(text).toContain(`ip addr add ${FLOATING} dev eth0`)
  expect(text).toMatch(/Done before this: made server box-1 \(cx33, fsn1\) from the snapshot 40; assigned the floating IPv4/)
})

const onFloating = (a: string[]) => a[0] === 'ssh' && a.includes(`orca@${FLOATING}`)

test('when SSH does not answer on the floating address, create fails with the address, the repair and the server it made', async ($, on) => {
  const silent = world(on, up({ fail: a => (onFloating(a) ? out('', 255, 'ssh: connect to host 198.51.100.9 port 22: Operation timed out') : undefined) }))
  await start($)
  const text = await dev($, 'create box-1')
  expect(text).toMatch(/did not answer on port 22 after 40 tries \(exit 255\): ssh: connect to host/)
  expect(text).toContain(`ip addr add ${FLOATING} dev eth0`)
  expect(text).toMatch(/The server box-1 \(901\) exists and is charged for/)
  expect(silent.changes()).toEqual([])
})

test('a host key that is not the recorded one is never trusted: create stops at the first try', async ($, on) => {
  const changed = world(on, up({ fail: a => (onFloating(a) ? out('', 255, 'Host key verification failed.') : undefined) }))
  await start($)
  const refused = await dev($, 'create box-1')
  expect(refused).toMatch(/refused the host key: Host key verification failed/)
  expect(refused).toMatch(/never trusted on first use/)
  expect(changed.ssh().filter(r => onFloating(r.argv))).toHaveLength(1)
  expect(changed.runs.some(r => r.argv.join(' ').includes('StrictHostKeyChecking=no') || r.argv.join(' ').includes('accept-new'))).toBe(false)
})

test('create does not wait on a server that is switched off: it names the status and the poweron command', async ($, on) => {
  const w = world(on, up({ servers: [ours(901, 'box-1', { status: 'off' })] }))
  await start($)

  const text = await dev($, 'create box-1')
  expect(text).toMatch(/the server box-1 \(901\) exists and has the status "off", not "running".*Nothing changed/)
  expect(text).toContain('hcloud --context proj server poweron 901')
  expect(w.ssh()).toEqual([])
  expect(w.changes()).toEqual([])
})

test('create refuses, before any spend, a snapshot that is not available, a firewall that lets no SSH in, and a type of another architecture', async ($, on) => {
  const w = world(on, down({ firewalls: [{ ...ourFirewall(5, 'box-1'), rules: [{ direction: 'in', protocol: 'icmp' }] }] }))
  await start($)

  const closed = await dev($, 'create box-1 --yes')
  expect(closed).toMatch(/the firewall box-1-ssh \(5\) has no inbound TCP 22 rule.*Nothing was created/)
  expect(closed).toContain('hcloud --context proj firewall add-rule 5 --direction in --protocol tcp --port 22')
  w.firewalls[0]!.rules = [{ direction: 'in', protocol: 'tcp', port: '22' }]
  expect(await dev($, 'create box-1 --type cax21 --yes')).toMatch(/the snapshot 40 of box-1 is x86, and the server type cax21 is arm\. Nothing was created/)
  w.images[0]!.status = 'creating'
  const unfinished = await dev($, 'create box-1 --yes')
  expect(unfinished).toMatch(/the newest snapshot of box-1, 40, has the status "creating", not "available", so it cannot be restored\. Nothing was created/)
  expect(unfinished).toContain('hcloud --context proj image describe 40')
  expect(w.changes()).toEqual([])
})

test('create refuses, before any spend, a snapshot or a server whose host key this machine does not hold', async ($, on) => {
  const w = world(on, down({ store: { projects: {}, hosts: { 'box-1': { context: 'proj' } } } }))
  await start($)

  const text = await dev($, 'create box-1 --yes')
  expect(text).toMatch(/box-1 has the snapshot 40, and \/home\/neil\/\.config\/ndev\/remote\.json on this machine holds no host key for box-1.*Nothing changed/)
  expect(text).toMatch(/copy hosts\.box-1 from that machine's ~\/\.config\/ndev\/remote\.json/)
  w.servers.push(ours(901, 'box-1'))
  const half = await dev($, 'create box-1 --yes')
  expect(half).toMatch(/the server box-1 \(901\) exists, and .* holds no host key for box-1/)
  expect(half).toContain('hcloud --context proj server delete 901')
  // A server that is known can be taken with its key by import, which asks.
  expect(half).toContain('/dev remote import 901 --context proj reads its host key')
  expect(text).not.toContain('/dev remote import')
  expect(w.changes()).toEqual([])
  expect(w.ssh()).toEqual([])
})

test('a first build that fails after the host key changed has already recorded the new key, and the next create finishes the floating address', async ($, on) => {
  let isBroken = true
  const w = world(on, { fail: (a, stdin) => (isBroken && a[0] === 'ssh' && stdin.startsWith('# floating stage') ? out('', 2, 'Cannot find device "eth0"') : undefined) })
  await start($)

  const text = await dev($, 'create box-1 --context proj --yes')
  expect(text).toMatch(/the floating address 198\.51\.100\.9 was not set on the interface eth0 of root@203\.0\.113\.7: floating-ip\.sh exited 2: Cannot find device "eth0"/)
  expect(w.store()?.hosts?.['box-1']).toEqual(expect.objectContaining({ hostKey: NEW_KEY, ip: FLOATING }))

  isBroken = false
  const before = w.changes().length
  expect(await dev($, 'create box-1')).toMatch(/The remote box-1 is up/)
  expect(w.changes().slice(before)).toEqual(['floating-ip assign 901 902'])
  const check = w.ssh().filter(r => r.stdin?.startsWith('# floating stage')).at(-1)!
  expect(check.known).toBe(`203.0.113.7 ${NEW_KEY}\n`)
})

test('a first build whose root stage prints no host key stops there, and records none', async ($, on) => {
  const w = world(on, { fail: (a, stdin) => (a[0] === 'ssh' && stdin.startsWith('# root stage') ? out('E: something else\n') : undefined) })
  await start($)

  expect(await dev($, 'create box-1 --context proj --yes')).toMatch(/the server did not print its new host key after root-setup\.sh; it printed: E: something else/)
  expect(w.store()?.hosts?.['box-1']?.hostKey).toBeUndefined()
  expect(w.files.get(KNOWN)).toBe('10.0.0.9 ssh-ed25519 AAAAother\n')
})

test('a floating IP that this machine kept for the name and that is gone is refused with the file to change, and no other is taken', async ($, on) => {
  const w = world(on, down({ fips: [ourFip(61, 'box-1', null)] }))
  await start($)

  for (const command of ['create box-1 --yes', 'remove box-1 --forget --yes']) {
    const text = await dev($, command)
    expect(text).toMatch(/the floating IP 60 that \/home\/neil\/\.config\/ndev\/remote\.json keeps for box-1 is no longer in the hcloud context proj.*box-1 \(61, 198\.51\.100\.9\)/)
    expect(text).toMatch(/delete "floatingIp" and "ip" from hosts\.box-1/)
  }
  expect(w.changes()).toEqual([])
})

// --- remove ----------------------------------------------------------------------------------------------------------

test('remove confirms what is deleted and kept, then shuts down, snapshots, waits for available, and only then deletes the server and the older snapshot', async ($, on) => {
  const w = world(on, up({ images: [snapshot(40, 'box-1')], snapshotStatus: ['creating', 'creating', 'available'] }))
  await start($)

  const text = await dev($, 'remove box-1')
  const plan = w.asked[0]!.question
  expect(plan).toMatch(/hcloud context "proj"/)
  expect(plan).toMatch(/shuts down the server box-1 \(901\): cx33 in fsn1, EUR 10\.19 a month/)
  expect(plan).toMatch(/DELETES the server 901 and the older snapshot 40/)
  expect(plan).toMatch(new RegExp(`keeps the floating IPv4 ${FLOATING.replace(/\./g, '\\.')}, which goes on costing EUR 3\\.60 a month.*and the firewall box-1-ssh`))
  expect(plan).toMatch(/If the snapshot fails, nothing is deleted/)
  expect(w.asked[0]!.options).toEqual(['Remove box-1', 'Cancel'])

  expect(w.changes()).toEqual([
    'server shutdown 901 --wait --wait-timeout 180s',
    'server create-image 901 --type snapshot --description ndev box-1 --label managed-by=ndev --label ndev-name=box-1 --label ndev-type=cx33 --label ndev-location=fsn1',
    'floating-ip unassign 60',
    'server delete 901',
    'image delete 40',
  ])
  // The wait: the snapshot was listed three times, and nothing was deleted before it read "available".
  const order = w.hcloudRuns().map(a => a.slice(3).join(' '))
  const lists = order.flatMap((r, i) => (r.startsWith('image list') && i > order.findIndex(x => x.startsWith('server create-image')) ? [i] : []))
  expect(lists).toHaveLength(3)
  expect(order.findIndex(r => /unassign|delete/.test(r))).toBeGreaterThan(lists[2]!)
  // One snapshot is kept, the floating IP is kept and unassigned, the firewall stays.
  expect(w.servers).toEqual([])
  expect(w.images.map(i => i.id)).toEqual([900])
  expect(w.fips).toEqual([expect.objectContaining({ id: 60, server: null })])
  expect(w.firewalls).toHaveLength(1)
  expect(text).toMatch(/server 901 is deleted, and the snapshot 900 \(80 GB disk, EUR 0\.11 a month with VAT\) holds it/)
  expect(text).toMatch(/\/dev remote create box-1 makes it again from the snapshot, as cx33/)
  // A server that create made had its host key checked by create; remove connects to nothing.
  expect(w.ssh()).toEqual([])
  expect(w.runs.filter(r => r.argv[0] === 'ssh-keyscan')).toEqual([])
})

test('remove deletes nothing when the snapshot fails: it reports the server id, the exit code, hcloud\'s own output and the repair', async ($, on) => {
  const w = world(on, up({ images: [snapshot(40, 'box-1')], fail: a => (a.includes('create-image') ? out('', 1, 'hcloud: server is locked (locked)') : undefined) }))
  await start($)

  const text = await dev($, 'remove box-1')
  expect(text).toMatch(/failed: the snapshot of the server box-1 \(901\) failed: hcloud --context proj server create-image 901 .* exited 1: hcloud: server is locked \(locked\)/)
  expect(text).toMatch(/Nothing was deleted: the server box-1 \(901\) is still there, shut down, with its floating IPv4 .* and the older snapshot 40/)
  expect(text).toMatch(/Repair: run \/dev remote remove box-1 again .* hcloud --context proj server poweron 901/)
  expect(w.changes().filter(c => /delete|unassign/.test(c))).toEqual([])
  expect(w.servers).toHaveLength(1)
  expect(w.images.map(i => i.id)).toEqual([40])
  expect(w.fips[0]!.server).toBe(901)
})

test('remove deletes nothing when the snapshot never becomes available, and the next remove does not delete on top of it', async ($, on) => {
  const stuck = world(on, up({ images: [snapshot(40, 'box-1')], snapshotStatus: ['creating'] }))
  await start($)
  const text = await dev($, 'remove box-1')
  expect(text).toMatch(/is not available after the wait: snapshot 900 has the status "creating"/)
  expect(text).toMatch(/Nothing was deleted/)
  expect(text).toContain('hcloud --context proj image describe 900')
  expect(stuck.changes().filter(c => /delete|unassign/.test(c))).toEqual([])
  expect(stuck.servers).toHaveLength(1)
  expect(stuck.images.map(i => i.id)).toEqual([40, 900])
  // The next remove does not delete on top of an unfinished snapshot either.
  expect(await dev($, 'remove box-1')).toMatch(/the snapshot 900 of box-1 has the status "creating", not "available"\. Nothing changed/)
})

test('remove takes no snapshot and deletes nothing when the shutdown command fails', async ($, on) => {
  const w = world(on, up({ fail: a => (a.includes('shutdown') ? out('', 1, 'hcloud: timed out waiting for the server to shut down') : undefined) }))
  await start($)

  const text = await dev($, 'remove box-1')
  expect(text).toMatch(/the server box-1 \(901\) did not shut down: hcloud --context proj server shutdown 901 --wait --wait-timeout 180s exited 1: hcloud: timed out waiting.*so no snapshot was taken\. Nothing was deleted/)
  expect(text).toContain('hcloud --context proj server poweroff 901')
  expect(w.changes()).toEqual(['server shutdown 901 --wait --wait-timeout 180s'])
})

test('remove takes no snapshot and deletes nothing when the server does not shut down', async ($, on) => {
  const awake = world(on, up({ fail: a => (a.includes('shutdown') ? out() : undefined) }))
  await start($)
  const still = await dev($, 'remove box-1')
  expect(still).toMatch(/has the status "running" after the shutdown, not "off", so no snapshot was taken\. Nothing was deleted/)
  expect(still).toContain('hcloud --context proj server poweroff 901')
  expect(awake.changes()).toEqual(['server shutdown 901 --wait --wait-timeout 180s'])
})

test('remove changes nothing when the human cancels', async ($, on) => {
  const w = world(on, up({ answer: () => 'Cancel' }))
  await start($)
  expect(await dev($, 'remove box-1')).toMatch(/cancelled\. Nothing changed/)
  expect(w.changes()).toEqual([])
  expect(w.servers).toHaveLength(1)
})

test('remove with no server says what is kept for the name, and changes nothing', async ($, on) => {
  const gone = world(on, down())
  await start($)
  const text = await dev($, 'remove box-1')
  expect(text).toMatch(/there is no server named box-1 in the hcloud context proj.*Kept for box-1: snapshot 40, floating IPv4 198\.51\.100\.9, firewall box-1-ssh/)
  expect(text).toMatch(/\/dev remote remove box-1 --forget deletes what is kept/)
  expect(gone.changes()).toEqual([])
})

test('remove --forget also deletes the snapshot, the floating IP and the firewall, after its own confirmation', async ($, on) => {
  const w = world(on, up())
  await start($)

  const text = await dev($, 'remove box-1 --forget')
  expect(w.asked.map(a => a.options[0])).toEqual(['Remove box-1', 'Forget box-1'])
  expect(w.asked[1]!.question).toMatch(new RegExp(`DELETES the snapshot 900, the floating IPv4 ${FLOATING.replace(/\./g, '\\.')} \\(60\\), the firewall box-1-ssh \\(5\\)`))
  expect(w.changes().slice(-3)).toEqual(['image delete 900', 'floating-ip delete 60', 'firewall delete 5'])
  expect(w.changes().indexOf('server delete 901')).toBeLessThan(w.changes().indexOf('image delete 900'))
  expect([w.servers, w.images, w.fips, w.firewalls]).toEqual([[], [], [], []])
  expect(w.store()?.hosts).toBeUndefined()
  expect(text).toMatch(/The remote box-1 is forgotten/)
  // Orca is not changed: the commands are named.
  expect(text).toContain('orca environment forget --environment "<its name>" --yes')
  expect(w.runs.some(r => r.argv[0] === 'orca')).toBe(false)
})

test('remove --forget keeps the snapshot and the floating IP when its own confirmation is refused', async ($, on) => {
  const w = world(on, up({ answer: (_, options) => (options[0] === 'Forget box-1' ? 'Cancel' : options[0]) }))
  await start($)
  const text = await dev($, 'remove box-1 --forget')
  expect(text).toMatch(/cancelled\. Nothing more was deleted: the snapshot 900, the floating IPv4 .*, the firewall box-1-ssh \(5\) are kept/)
  expect(text).toMatch(/Done before this: .*deleted server 901/)
  expect(w.images.map(i => i.id)).toEqual([900])
  expect(w.fips).toHaveLength(1)
})

test('remove --forget with no server asks once, and deletes what was kept', async ($, on) => {
  const kept = world(on, down())
  await start($)
  await dev($, 'remove box-1 --forget')
  expect(kept.asked.map(a => a.options[0])).toEqual(['Forget box-1'])
  expect(kept.changes()).toEqual(['image delete 40', 'floating-ip delete 60', 'firewall delete 5'])
})

// --- the command words ----------------------------------------------------------------------------------------------

test('create and remove need one valid name, and refuse an option that is not theirs', async ($, on) => {
  const w = world(on)
  await start($)

  expect(await dev($, 'create')).toMatch(/needs the name of the remote, as in \/dev remote create <name>/)
  expect(await dev($, 'remove Box_1 --context proj')).toMatch(/"Box_1" cannot name a remote/)
  expect(await dev($, 'create a b')).toMatch(/takes one server name/)
  expect(await dev($, 'create box-1 --forget')).toMatch(/--forget is not an option of \/dev remote create/)
  expect(await dev($, 'remove box-1 --type cx33')).toMatch(/--type is not an option of \/dev remote remove/)
  expect(await dev($, 'create box-1 --context')).toMatch(/--context needs a value/)
  expect(await dev($, 'create box-1 --nope')).toMatch(/"--nope" is not an option of \/dev remote/)
  expect(await dev($, 'list --yes')).toMatch(/--yes is an option of \/dev remote create, remove, import and resize only/)
  expect(w.hcloudRuns()).toEqual([])
})

test('create and remove refuse a floating IP that another server holds, and neither moves nor deletes it', async ($, on) => {
  const w = world(on, down({ fips: [ourFip(60, 'box-1', 777)] }))
  await start($)

  for (const command of ['create box-1 --yes', 'remove box-1 --forget --yes']) {
    const text = await dev($, command)
    expect(text).toMatch(/the floating IP 198\.51\.100\.9 \(60\) of box-1 is assigned to the server 777, which is not the server box-1/)
    expect(text).toContain('hcloud --context proj floating-ip describe 60')
  }
  expect(w.changes()).toEqual([])
  expect(w.fips[0]!.server).toBe(777)
})

// --- import ----------------------------------------------------------------------------------------------------------

// A server made by hand, as orca-dev-2 was: its own labels, a firewall applied to it alone, and a floating IPv4.
const HAND = 176003111
const OWN_LABELS = { project: 'fcc-proto', role: 'orca-host' }
const handServer = (extra: Partial<Srv> = {}) => ours(HAND, 'orca-dev-2', { labels: { ...OWN_LABELS }, ...extra })
const handFirewall = (extra: Partial<Fw> = {}): Fw => ({ id: 12048531, name: 'orca-dev-2-ssh', labels: { role: 'orca-host' }, rules: [{ direction: 'in', protocol: 'tcp', port: '22' }], applied_to: [{ type: 'server', server: { id: HAND } }], ...extra })
const handFip = (extra: Partial<Fip> = {}) => ourFip(162501839, 'build-server', HAND, { ip: '88.99.125.86', labels: {}, ...extra })
const byHand = (extra: Opts = {}): Opts => ({ servers: [handServer()], firewalls: [handFirewall()], fips: [handFip()], ...extra })
const IMPORT = `import ${HAND} --context proj`
const imported = { context: 'proj', floatingIp: 162501839, ip: '88.99.125.86', hostKey: PRESENTED, imported: true }
const adds = (w: ReturnType<typeof world>) => w.changes().filter(c => c.includes('add-label'))

test('import shows each resource it labels with its id, name and labels, the record and the host key fingerprint, then labels the server, its firewall and its floating IP and records the remote', async ($, on) => {
  const w = world(on, byHand())
  await start($)

  const text = await dev($, IMPORT)
  expect(w.asked).toHaveLength(1)
  const plan = w.asked[0]!.question
  expect(plan).toMatch(/Import the server orca-dev-2 \(176003111\) in the Hetzner project of the hcloud context "proj" as the remote orca-dev-2\?/)
  expect(plan).toMatch(/adds the labels managed-by=ndev and ndev-name=orca-dev-2 to:/)
  expect(plan).toContain('- the server orca-dev-2 (176003111), which has the labels project=fcc-proto, role=orca-host')
  expect(plan).toContain('- the firewall orca-dev-2-ssh (12048531), which has the labels role=orca-host')
  expect(plan).toContain('- the floating IPv4 build-server (162501839, 88.99.125.86), which has the labels none')
  expect(plan).toMatch(/records in \/home\/neil\/\.config\/ndev\/remote\.json, as hosts\.orca-dev-2: the hcloud context proj, the floating IPv4 88\.99\.125\.86 \(162501839\) and the host key/)
  // The key is read from the floating address, and the question says that this is where trust is given.
  expect(plan).toContain('The ed25519 host key that 88.99.125.86 presents now: SHA256:AAAApresented')
  expect(plan).toMatch(/Nothing on this machine vouches for that key/)
  expect(plan).toMatch(/This is the one moment trust is given/)
  expect(plan).toMatch(/creates, deletes, resizes and reassigns nothing/)
  // The limit of a server that root-setup.sh did not build is in the question, before trust is given.
  expect(plan).toMatch(/was not built by scripts\/remote\/root-setup\.sh/)
  expect(plan).not.toMatch(/use only a firewall named/)
  expect(w.asked[0]!.options).toEqual(['Import orca-dev-2', 'Cancel'])
  expect(w.runs.find(r => r.argv[0] === 'ssh-keyscan')!.argv).toEqual(['ssh-keyscan', '-T', '15', '-p', '22', '-t', 'ed25519', '88.99.125.86'])

  // Only labels are added, only the two, and the labels that were there stay.
  expect(w.changes()).toEqual([
    'server add-label 176003111 managed-by=ndev ndev-name=orca-dev-2',
    'firewall add-label 12048531 managed-by=ndev ndev-name=orca-dev-2',
    'floating-ip add-label 162501839 managed-by=ndev ndev-name=orca-dev-2',
  ])
  expect(w.servers[0]!.labels).toEqual({ ...OWN_LABELS, ...LABELS('orca-dev-2') })
  expect(w.firewalls[0]!.labels).toEqual({ role: 'orca-host', ...LABELS('orca-dev-2') })
  expect(w.store()?.hosts?.['orca-dev-2']).toEqual(imported)
  // Import connects to nothing: it only reads the key. known_hosts is create's to write.
  expect(w.ssh()).toEqual([])
  expect(w.files.get(KNOWN)).toBe('10.0.0.9 ssh-ed25519 AAAAother\n')
  for (const r of w.runs.filter(x => x.argv.includes('hcloud'))) expect(r.argv.slice(0, 8).join(' ')).toMatch(/^env -u HCLOUD_TOKEN -u HCLOUD_CONTEXT hcloud (context list|--context proj)/)
  expect(text).toMatch(/The server orca-dev-2 \(176003111\) is now the remote orca-dev-2 in the hcloud context "proj"/)
  expect(text).toMatch(/\/dev remote remove orca-dev-2 and \/dev remote create orca-dev-2 now accept it/)
  // The limit of a server that root-setup.sh did not build.
  expect(text).toMatch(/was not built by scripts\/remote\/root-setup\.sh/)
  expect(text).toContain('/etc/cloud/cloud.cfg.d/99-ndev-keep-host-keys.cfg')
})

test('after import, remove and create accept the server with no hand labelling and no context named', async ($, on) => {
  const opts = byHand()
  const w = world(on, opts)
  await start($)
  await dev($, IMPORT)

  // create checks the server with the imported host key and no other, and trusts it for the floating address.
  expect(await dev($, 'create orca-dev-2')).toMatch(/The remote orca-dev-2 is up in the hcloud context "proj": server 176003111, floating IPv4 88\.99\.125\.86/)
  expect(w.ssh().find(r => r.stdin?.startsWith('# floating stage'))!.known).toBe(`203.0.113.7 ${PRESENTED}\n`)
  expect(w.files.get(KNOWN)).toContain(`88.99.125.86 ${PRESENTED}\n`)
  expect(w.changes()).toEqual(adds(w))

  // From here the fake ssh, like ssh, refuses a known_hosts file that does not hold the key the server proves.
  opts.proves = PRESENTED
  expect(await dev($, 'remove orca-dev-2 --yes')).toMatch(/The remote orca-dev-2 is removed/)
  expect(w.servers).toEqual([])
  expect(w.fips).toEqual([expect.objectContaining({ id: 162501839, server: null })])
  // Before the shutdown, remove connected as root to the server's own address with the saved host key as the only
  // known key, and removed that temporary known_hosts file after.
  const order = w.runs.map(r => r.argv.join(' '))
  const check = order.findLastIndex(r => r.startsWith('ssh ') && r.endsWith(' root@203.0.113.7 true'))
  expect(check).toBeGreaterThan(-1)
  expect(check).toBeLessThan(order.findIndex(r => r.includes('server shutdown')))
  expect(w.runs[check]!.argv).toEqual(['ssh', '-p', '22', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '-o', `UserKnownHostsFile=${TMP}/known_hosts`, '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'KnownHostsCommand=none', '-o', 'VerifyHostKeyDNS=no', '-o', 'HostKeyAlias=203.0.113.7', '-o', 'HostKeyAlgorithms=ssh-ed25519', 'root@203.0.113.7', 'true'])
  expect(w.runs[check]!.known).toBe(`203.0.113.7 ${PRESENTED}\n`)
  expect(order.slice(check).some(r => r === `rm -rf ${TMP}`)).toBe(true)
  expect(w.files.has(`${TMP}/known_hosts`)).toBe(false)
  // Only import read a key with ssh-keyscan; remove does not, because a key it reads is no proof.
  expect(w.runs.filter(r => r.argv[0] === 'ssh-keyscan')).toHaveLength(1)
})

// An imported server's host key was seen once, at import. Before remove snapshots and deletes it, the server must
// prove over ssh that it holds that key, or the box under the name may not be the one imported. Showing the public
// key is not enough: ssh-keyscan would read it from any machine that copied it.
const SWAPPED = 'ssh-ed25519 AAAAswapped'
const SAVED_AT = '/home/neil/.config/ndev/remote.json'

test('remove of an imported server refuses, before the question and before any shutdown, snapshot or delete, a server that does not prove it holds the host key import saved', async ($, on) => {
  const opts = byHand()
  const w = world(on, opts)
  await start($)
  await dev($, IMPORT)
  const asked = w.asked.length
  // The machine at the address still shows the saved public key to ssh-keyscan, but cannot prove it holds the key.
  opts.proves = SWAPPED

  const text = await dev($, 'remove orca-dev-2')
  expect(text).toMatch(/the server orca-dev-2 \(176003111\) was imported, so remove first checks over SSH that the server at 203\.0\.113\.7 proves it holds the host key SHA256:AAAApresented, the one \/home\/neil\/\.config\/ndev\/remote\.json saved for orca-dev-2\. It did not: it may not be the server that was imported\./)
  expect(text).toMatch(/ssh root@203\.0\.113\.7 true exited 255: .*Host key verification failed/s)
  expect(text).toMatch(/No snapshot was taken and nothing was deleted\. Nothing changed/)
  expect(text).toMatch(/Repair: .*ssh-keygen -lf \/etc\/ssh\/ssh_host_ed25519_key\.pub/)
  expect(text).toContain('/dev remote import 176003111 --context proj')
  const check = w.ssh().at(-1)!
  expect(check.argv.slice(-2)).toEqual(['root@203.0.113.7', 'true'])
  expect(check.known).toBe(`203.0.113.7 ${PRESENTED}\n`)
  // Only import read a key with ssh-keyscan.
  expect(w.runs.filter(r => r.argv[0] === 'ssh-keyscan')).toHaveLength(1)
  expect(w.files.has(`${TMP}/known_hosts`)).toBe(false)
  expect(w.asked).toHaveLength(asked)
  expect(w.changes()).toEqual(adds(w))
  expect(w.servers).toHaveLength(1)
  expect(w.store()?.hosts?.['orca-dev-2']?.hostKey).toBe(PRESENTED)
})

test('remove of an imported server that SSH cannot reach refuses with ssh\'s exit code and output, the saved fingerprint and the repair, and changes nothing', async ($, on) => {
  const opts = byHand()
  const w = world(on, opts)
  await start($)
  await dev($, IMPORT)
  opts.fail = a => (a[0] === 'ssh' ? out('', 255, 'ssh: connect to host 203.0.113.7 port 22: Operation timed out') : undefined)

  const text = await dev($, 'remove orca-dev-2 --yes')
  expect(text).toMatch(/the server orca-dev-2 \(176003111\) was imported, so remove first checks over SSH that the server at 203\.0\.113\.7 proves it holds the host key SHA256:AAAApresented/)
  expect(text).toMatch(/The check did not finish\. ssh root@203\.0\.113\.7 true exited 255: ssh: connect to host 203\.0\.113\.7 port 22: Operation timed out\./)
  expect(text).toMatch(/No snapshot was taken and nothing was deleted\. Nothing changed/)
  expect(text).toMatch(/Repair: check that SSH answers there with ssh -p 22 root@203\.0\.113\.7 \(if ssh asks about a host key, its fingerprint must be SHA256:AAAApresented; never accept another\), then run \/dev remote remove orca-dev-2 again/)
  expect(w.files.has(`${TMP}/known_hosts`)).toBe(false)
  expect(w.changes()).toEqual(adds(w))
  expect(w.servers).toHaveLength(1)
})

test('a record that import wrote before it marked imports, with no SSH key of create, gets the same check', async ($, on) => {
  const name = 'orca-dev-2'
  const w = world(on, {
    servers: [handServer({ labels: { ...OWN_LABELS, ...LABELS(name) } })],
    firewalls: [handFirewall({ labels: { role: 'orca-host', ...LABELS(name) } })],
    fips: [handFip({ labels: LABELS(name) })],
    store: { projects: {}, hosts: { [name]: { context: 'proj', floatingIp: 162501839, ip: '88.99.125.86', hostKey: PRESENTED } } },
    proves: SWAPPED,
  })
  await start($)
  expect(await dev($, `remove ${name} --yes`)).toMatch(/was imported, so remove first checks over SSH that the server at 203\.0\.113\.7 proves it holds the host key SHA256:AAAApresented.*It did not/)
  expect(w.changes()).toEqual([])
})

test('remove of an imported server that refuses the root sign-in says so with the repair, and still changes nothing', async ($, on) => {
  const opts = byHand()
  const w = world(on, opts)
  await start($)
  await dev($, IMPORT)
  opts.fail = a => (a[0] === 'ssh' ? out('', 255, 'root@203.0.113.7: Permission denied (publickey).') : undefined)

  const text = await dev($, 'remove orca-dev-2 --yes')
  expect(text).toMatch(/the server orca-dev-2 \(176003111\) was imported, so remove first checks over SSH that the server at 203\.0\.113\.7 proves it holds the host key SHA256:AAAApresented.*The check did not finish: the server refused the sign-in as root\. ssh root@203\.0\.113\.7 true exited 255: root@203\.0\.113\.7: Permission denied \(publickey\)\./)
  expect(text).toMatch(/No snapshot was taken and nothing was deleted\. Nothing changed/)
  expect(text).toMatch(/Repair: the check needs a key sign-in as root: put your public SSH key in \/root\/.ssh\/authorized_keys on the server \(Hetzner console\), check it with ssh -p 22 root@203\.0\.113\.7 .*then run \/dev remote remove orca-dev-2 again/)
  expect(w.files.has(`${TMP}/known_hosts`)).toBe(false)
  expect(w.changes()).toEqual(adds(w))
  expect(w.servers).toHaveLength(1)
})

test('remove of an imported server refuses an address from Hetzner that is not an IPv4 address before it writes it to a known_hosts file', async ($, on) => {
  const w = world(on, {
    servers: [handServer({ labels: { ...OWN_LABELS, ...LABELS('orca-dev-2') }, public_net: { ipv4: { ip: '203.0.113.7 ssh-ed25519 AAAAother\n*' } } })],
    firewalls: [handFirewall({ labels: { role: 'orca-host', ...LABELS('orca-dev-2') } })],
    fips: [handFip({ labels: LABELS('orca-dev-2') })],
    store: { projects: {}, hosts: { 'orca-dev-2': imported } },
  })
  await start($)
  const text = await dev($, 'remove orca-dev-2 --yes')
  expect(text).toMatch(/the server orca-dev-2 \(176003111\) was imported, but its address reads "203\.0\.113\.7 ssh-ed25519 AAAAother\n\*", which is not an IPv4 address, so remove cannot check its host key there\. No snapshot was taken and nothing was deleted\. Nothing changed/)
  expect(text).toContain('Repair: look at the server with hcloud --context proj server describe 176003111, then run /dev remote remove orca-dev-2 again.')
  expect(w.ssh()).toEqual([])
  expect(w.files.has(`${TMP}/known_hosts`)).toBe(false)
  expect(w.changes()).toEqual([])
})

// With no host key saved on this machine, remove has nothing to check the server against. It refuses, and only the
// plain option --unverified-host removes the server without the check, with a warning.
const noRecord = (): Opts => ({ servers: [ours(901, 'box-1')], fips: [ourFip(60, 'box-1', 901)], firewalls: [ourFirewall(5, 'box-1')] })

for (const [what, store] of [['no record', undefined], ['a record with no host key', { projects: {}, hosts: { 'box-1': { context: 'proj' } } }], ['an import record with no host key', { projects: {}, hosts: { 'box-1': { context: 'proj', imported: true } } }]] as const) {
  test(`remove refuses a server that this machine holds no saved host key for (${what}), names the server and both repairs, and changes nothing`, async ($, on) => {
    const w = world(on, { ...noRecord(), ...(store ? { store } : {}) })
    await start($)
    const text = await dev($, 'remove box-1 --context proj --yes')
    expect(text).toMatch(/the server box-1 \(901\) in the hcloud context proj has no host key saved on this machine \(\/home\/neil\/\.config\/ndev\/remote\.json holds no hosts\.box-1\.hostKey\), so remove cannot check that it is the server you mean\. No snapshot was taken and nothing was deleted\. Nothing changed/)
    expect(text).toContain('Repair: run /dev remote remove box-1 on the machine that created or imported the server. Or, to remove it with no host key check: /dev remote remove box-1 --context proj --unverified-host')
    expect(w.ssh()).toEqual([])
    expect(w.changes()).toEqual([])
    expect(w.servers).toHaveLength(1)
  })
}

test('remove --unverified-host removes a server with no saved host key, and warns in one line that the host key was not checked', async ($, on) => {
  const w = world(on, noRecord())
  await start($)
  const text = await dev($, 'remove box-1 --context proj --unverified-host --yes')
  expect(text).toMatch(/The remote box-1 is removed/)
  expect(text.split('\n').filter(l => l.includes('NOT checked'))).toEqual(['Warning: the host key of the server box-1 (901) was NOT checked (--unverified-host): this machine holds no saved host key for it.'])
  expect(w.ssh()).toEqual([])
  expect(w.servers).toEqual([])
})

test('--unverified-host skips no check that a saved host key allows, warns of nothing then, and is an option of remove only', async ($, on) => {
  const w = world(on, { ...noIpv4({ server: HAND }), servers: [handServer({ labels: { ...OWN_LABELS, ...LABELS('orca-dev-2') } })], proves: SWAPPED })
  await start($)
  const text = await dev($, 'remove orca-dev-2 --unverified-host --yes')
  expect(text).toMatch(/proves it holds the host key SHA256:AAAApresented.*It did not/)
  expect(w.changes()).toEqual([])
  expect(await dev($, 'create box-1 --context proj --unverified-host')).toMatch(/--unverified-host is not an option of \/dev remote create/)
})

test('--unverified-host on a server that create made, with its saved host key, removes it as before and warns of nothing', async ($, on) => {
  world(on, up())
  await start($)
  const removed = await dev($, 'remove box-1 --unverified-host --yes')
  expect(removed).toMatch(/The remote box-1 is removed/)
  expect(removed).not.toMatch(/not checked/i)
})

// With no public IPv4 on the server, the only address left is the record's floating IP, and only while that floating
// IP is assigned to this server. An address that nothing ties to the server would check another machine.
const noIpv4 = (fip: Partial<Fip>): Opts => ({
  servers: [handServer({ labels: { ...OWN_LABELS, ...LABELS('orca-dev-2') }, public_net: { ipv4: null } })],
  firewalls: [handFirewall({ labels: { role: 'orca-host', ...LABELS('orca-dev-2') } })],
  fips: [handFip({ labels: LABELS('orca-dev-2'), ...fip })],
  store: { projects: {}, hosts: { 'orca-dev-2': imported } },
})

test('remove of an imported server with no public IPv4 checks at the record\'s floating IP only while it is assigned to that server', async ($, on) => {
  const w = world(on, noIpv4({ server: null }))
  await start($)
  const text = await dev($, 'remove orca-dev-2 --yes')
  expect(text).toMatch(/the server orca-dev-2 \(176003111\) was imported, so remove first checks over SSH that it still proves it holds the host key SHA256:AAAApresented.*But the server has no public IPv4 and no floating IP of orca-dev-2 that \/home\/neil\/\.config\/ndev\/remote\.json saved is assigned to it, so there is nowhere to check\. No snapshot was taken and nothing was deleted\. Nothing changed/s)
  expect(text).toMatch(/Repair: give the server a public IPv4 or a floating IP that SSH answers on, then run \/dev remote remove orca-dev-2 again/)
  expect(w.ssh()).toEqual([])
  expect(w.changes()).toEqual([])
  expect(w.servers).toHaveLength(1)
})

test('remove of an imported server with no public IPv4 checks the host key at its assigned floating IP', async ($, on) => {
  const w = world(on, { ...noIpv4({ server: HAND }), proves: PRESENTED })
  await start($)
  expect(await dev($, 'remove orca-dev-2 --yes')).toMatch(/The remote orca-dev-2 is removed/)
  const check = w.ssh().find(r => r.argv.at(-1) === 'true')!
  expect(check.argv.at(-2)).toBe('root@88.99.125.86')
  expect(check.known).toBe(`88.99.125.86 ${PRESENTED}\n`)
})

test('remove of an imported server whose saved host key is malformed names the server, the record and the import repair, and changes nothing', async ($, on) => {
  const broken = world(on, {
    ...noIpv4({ server: HAND }),
    servers: [handServer({ labels: { ...OWN_LABELS, ...LABELS('orca-dev-2') } })],
    fail: a => (a[0] === 'ssh-keygen' && a.includes('-lf') ? out('', 255, '(stdin) is not a public key file.') : undefined),
  })
  await start($)
  const text = await dev($, 'remove orca-dev-2 --yes')
  expect(text).toMatch(new RegExp(`the server orca-dev-2 \\(176003111\\) was imported, but the host key that ${SAVED_AT.replace(/\./g, '\\.')} saved as hosts\\.orca-dev-2\\.hostKey is not a well-formed ed25519 public key \\(ssh-keygen -lf - printed no SHA256 fingerprint for a host key \\(exit 255\\): \\(stdin\\) is not a public key file\\.\\)`))
  expect(text).toMatch(/No snapshot was taken and nothing was deleted\. Nothing changed/)
  expect(text).toContain(`Repair: delete hosts.orca-dev-2 from ${SAVED_AT}, run /dev remote import 176003111 --context proj and confirm the key there, then run /dev remote remove orca-dev-2 again.`)
  expect(broken.ssh()).toEqual([])
  expect(broken.changes()).toEqual([])
})

test('remove of an imported server refuses a saved host key that is not one key on one line before it writes it to a known_hosts file', async ($, on) => {
  const w = world(on, {
    ...noIpv4({ server: HAND }),
    servers: [handServer({ labels: { ...OWN_LABELS, ...LABELS('orca-dev-2') } })],
    store: { projects: {}, hosts: { 'orca-dev-2': { ...imported, hostKey: `${PRESENTED}\n10.0.0.1 ssh-ed25519 AAAAother` } } },
  })
  await start($)
  const text = await dev($, 'remove orca-dev-2 --yes')
  expect(text).toMatch(/saved as hosts\.orca-dev-2\.hostKey is not a well-formed ed25519 public key \(it reads "ssh-ed25519 AAAApresented\n10\.0\.0\.1/)
  expect(text).toContain('/dev remote import 176003111 --context proj')
  expect(w.ssh()).toEqual([])
  expect(w.changes()).toEqual([])
})

test('import changes nothing when the human cancels, and refuses with no one to confirm', async ($, on) => {
  const w = world(on, byHand({ answer: () => 'Cancel' }))
  await start($)
  expect(await dev($, IMPORT)).toMatch(/cancelled\. Nothing changed/)
  expect(w.changes()).toEqual([])
  expect(w.store()).toBeUndefined()
})

test('a session with no person at it is not asked: import refuses, labels nothing and records no host key', async ($, on) => {
  const w = world(on, byHand())
  await start($, false)
  const text = await dev($, IMPORT)
  expect(text).toMatch(/no one confirmed it, so it is refused\. Nothing changed/)
  expect(w.asked).toEqual([])
  expect(w.changes()).toEqual([])
  expect(w.store()).toBeUndefined()
})

test('--yes does not give trust to a host key that nothing on this machine vouches for; with the key in known_hosts it confirms', async ($, on) => {
  const w = world(on, byHand())
  await start($, false)

  const text = await dev($, `${IMPORT} --yes`)
  expect(text).toMatch(/--yes cannot give trust to the host key SHA256:AAAApresented of 88\.99\.125\.86: nothing on this machine vouches for it/)
  expect(text).toMatch(/Nothing changed/)
  expect(text).toMatch(/Repair: run it where you can answer the question/)
  expect(w.changes()).toEqual([])
  expect(w.store()).toBeUndefined()

  w.files.set(KNOWN, `10.0.0.9 ssh-ed25519 AAAAother\n88.99.125.86 ${PRESENTED}\n`)
  expect(await dev($, `${IMPORT} --yes`)).toMatch(/is now the remote orca-dev-2/)
  expect(w.asked).toEqual([])
  expect(w.store()?.hosts?.['orca-dev-2']).toEqual(imported)
})

test('import says in the question when known_hosts already holds the key for the address', async ($, on) => {
  const w = world(on, byHand())
  w.files.set(KNOWN, `88.99.125.86 ssh-rsa AAAArsa\n88.99.125.86 ${PRESENTED}\n`)
  await start($)
  await dev($, IMPORT)
  expect(w.asked[0]!.question).toMatch(/\/home\/neil\/\.ssh\/known_hosts on this machine already holds that key for 88\.99\.125\.86/)
  expect(w.runs.find(r => r.argv[0] === 'ssh-keygen' && r.argv.includes('-F'))!.argv).toEqual(['ssh-keygen', '-F', '88.99.125.86', '-f', KNOWN])
})

test('import refuses a server whose host key differs from the one known_hosts holds for the address, and shows both fingerprints', async ($, on) => {
  const w = world(on, byHand())
  w.files.set(KNOWN, '88.99.125.86 ssh-ed25519 AAAAearlier\n')
  await start($)

  const text = await dev($, `${IMPORT} --yes`)
  expect(text).toMatch(/\/home\/neil\/\.ssh\/known_hosts on this machine holds the ed25519 host key SHA256:AAAAearlier for 88\.99\.125\.86, and the server now presents SHA256:AAAApresented/)
  expect(text).toMatch(/Nothing changed/)
  expect(text).toContain('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub')
  expect(text).toContain(`ssh-keygen -R 88.99.125.86 -f ${KNOWN}`)
  expect(w.asked).toEqual([])
  expect(w.changes()).toEqual([])
  expect(w.store()).toBeUndefined()
})

test('import refuses when no ed25519 host key can be read, with the address, the exit code and the output', async ($, on) => {
  const w = world(on, byHand({ fail: a => (a[0] === 'ssh-keyscan' ? out('', 1, 'connect to 88.99.125.86 port 22: Connection refused') : undefined) }))
  await start($)
  const text = await dev($, `${IMPORT} --yes`)
  expect(text).toMatch(/ssh-keyscan read no ed25519 host key from 88\.99\.125\.86 port 22 \(exit 1\): connect to 88\.99\.125\.86 port 22: Connection refused/)
  expect(text).toMatch(/Nothing changed/)
  expect(w.changes()).toEqual([])
})

test('import needs a numeric id of a server in a named hcloud context', async ($, on) => {
  const w = world(on, byHand())
  await start($)

  expect(await dev($, 'import')).toMatch(/needs the Hetzner id of the server, as in \/dev remote import <hetzner-id> --context <context>/)
  expect(await dev($, 'import orca-dev-2 --context proj')).toMatch(/"orca-dev-2" is not a Hetzner server id.*hcloud --context proj server list/s)
  expect(await dev($, 'import 1 2 --context proj')).toMatch(/takes one Hetzner server id/)
  const none = await dev($, `import ${HAND}`)
  expect(none).toMatch(/no hcloud context is named for the server 176003111/)
  expect(none).toMatch(/Repair: run \/dev remote import 176003111 --context <context>/)
  expect(await dev($, `import ${HAND} --context nope`)).toMatch(/there is no hcloud context "nope"/)
  const missing = await dev($, 'import 999 --context proj --yes')
  expect(missing).toMatch(/999 is not the id of a server in the hcloud context proj: hcloud --context proj server describe 999 -o json exited 1: hcloud: Server not found: 999/)
  expect(missing).toContain('Repair: hcloud --context proj server list shows the servers there and their ids.')
  expect(await dev($, `${IMPORT} --type cx33`)).toMatch(/--type is not an option of \/dev remote import/)
  expect(await dev($, 'create box-1 --name box-2')).toMatch(/--name is not an option of \/dev remote create/)
  expect(w.asked).toEqual([])
  expect(w.changes()).toEqual([])
})

test('the remote takes the server\'s Hetzner name: another --name, or a server name that cannot name a remote, is refused with the rename command', async ($, on) => {
  const w = world(on, byHand({ servers: [handServer(), ours(55, 'Build_Server', { labels: {} })] }))
  await start($)

  const other = await dev($, `${IMPORT} --name box-9 --yes`)
  expect(other).toMatch(/the server 176003111 has the Hetzner name orca-dev-2, not box-9.*find a server by its Hetzner name/s)
  expect(other).toContain('hcloud --context proj server update 176003111 --name box-9')
  const bad = await dev($, 'import 55 --context proj --yes')
  expect(bad).toMatch(/the Hetzner name "Build_Server" of the server 55 cannot name a remote/)
  expect(bad).toContain('hcloud --context proj server update 55 --name <name>')
  expect(w.changes()).toEqual([])
  // The server's own name, given, is accepted.
  expect(await dev($, `${IMPORT} --name orca-dev-2`)).toMatch(/is now the remote orca-dev-2/)
})

for (const [what, opts, refusal, repair] of [
  ['server', { servers: [handServer({ labels: { 'managed-by': 'ndev', 'ndev-name': 'box-7' } })] }, /the server orca-dev-2 \(176003111\) already carries ndev-name=box-7, so it belongs to the remote box-7/, 'hcloud --context proj server remove-label 176003111 ndev-name'],
  ['firewall', { firewalls: [handFirewall({ labels: { 'ndev-name': 'box-7' } })] }, /the firewall orca-dev-2-ssh \(12048531\) already carries ndev-name=box-7/, 'hcloud --context proj firewall remove-label 12048531 ndev-name'],
  ['floating IP', { fips: [handFip({ labels: { 'managed-by': 'ndev', 'ndev-name': 'box-7' } })] }, /the floating IPv4 build-server \(162501839, 88\.99\.125\.86\) already carries ndev-name=box-7/, 'hcloud --context proj floating-ip remove-label 162501839 ndev-name'],
  ['firewall of another tool', { firewalls: [handFirewall({ labels: { 'managed-by': 'terraform' } })] }, /the firewall orca-dev-2-ssh \(12048531\) already carries managed-by=terraform, so another tool manages it/, 'hcloud --context proj firewall remove-label 12048531 managed-by'],
] as [string, Opts, RegExp, string][]) {
  test(`import refuses a ${what} that already carries the label of another owner, and labels nothing`, async ($, on) => {
    const w = world(on, byHand(opts))
    await start($)
    const text = await dev($, `${IMPORT} --yes`)
    expect(text).toMatch(refusal)
    expect(text).toMatch(/Nothing changed/)
    expect(text).toContain(repair)
    expect(w.changes()).toEqual([])
    expect(w.store()).toBeUndefined()
  })
}

test('import refuses a firewall that is also applied to another server or by a label selector, names the others, and labels nothing', async ($, on) => {
  const shared = handFirewall({ applied_to: [{ type: 'server', server: { id: HAND } }, { type: 'server', server: { id: 901 } }, { type: 'server', server: { id: 4242 } }] })
  const w = world(on, byHand({ servers: [handServer(), ours(901, 'box-1')], firewalls: [shared] }))
  await start($)

  const text = await dev($, `${IMPORT} --yes`)
  expect(text).toMatch(/the firewall orca-dev-2-ssh \(12048531\) is applied to the server orca-dev-2 \(176003111\) and also to box-1 \(901\), the server 4242/)
  expect(text).toMatch(/would hand a shared firewall to the remote orca-dev-2.*Nothing changed/s)
  expect(text).toContain('hcloud --context proj firewall remove-from-resource 12048531 --type server --server <id>')
  expect(text).toContain('hcloud --context proj firewall add-label 12048531 managed-by=ndev ndev-name=orca-dev-2')
  expect(w.changes()).toEqual([])

  shared.applied_to = [{ type: 'label_selector', label_selector: { selector: 'role=orca-host' }, applied_to_resources: [{ type: 'server', server: { id: HAND } }, { type: 'server', server: { id: 901 } }] }]
  expect(await dev($, `${IMPORT} --yes`)).toMatch(/and also to every server that matches the label selector "role=orca-host" \(now also box-1 \(901\)\)/)
  expect(w.changes()).toEqual([])
  expect(w.store()).toBeUndefined()

  // The owner hands the shared firewall over by hand; import then takes the rest and never labels the firewall.
  shared.labels = { ...shared.labels, ...LABELS('orca-dev-2') }
  expect(await dev($, IMPORT)).toMatch(/is now the remote orca-dev-2/)
  expect(adds(w).some(c => c.startsWith('firewall'))).toBe(false)
})

test('import refuses a firewall with the remote\'s firewall name that is not applied to the server, since remove and create would then refuse it', async ($, on) => {
  const w = world(on, byHand({ firewalls: [handFirewall({ applied_to: [] })] }))
  await start($)
  const text = await dev($, `${IMPORT} --yes`)
  expect(text).toMatch(/the firewall orca-dev-2-ssh \(12048531\) has the name of the remote's firewall, is not applied to the server orca-dev-2 \(176003111\), and does not carry the labels/)
  expect(text).toContain('hcloud --context proj firewall apply-to-resource 12048531 --type server --server 176003111')
  expect(w.changes()).toEqual([])
})

test('with more than one floating IPv4 on the server, import asks which with --floating-ip and labels only that one', async ($, on) => {
  const second = ourFip(77, 'spare', HAND, { ip: '198.51.100.77', labels: {} })
  const w = world(on, byHand({ fips: [handFip(), second, ourFip(78, 'elsewhere', null, { ip: '198.51.100.78', labels: {} })] }))
  await start($)

  const text = await dev($, `${IMPORT} --yes`)
  expect(text).toMatch(/the server orca-dev-2 \(176003111\) has 2 floating IPv4s assigned: build-server \(162501839, 88\.99\.125\.86\), spare \(77, 198\.51\.100\.77\).*one address/s)
  expect(text).toContain(`Repair: run /dev remote import ${HAND} --context proj --floating-ip <name or id>`)
  expect(await dev($, `${IMPORT} --floating-ip nope --yes`)).toMatch(/there is no floating IP "nope" in the hcloud context proj/)
  const loose = await dev($, `${IMPORT} --floating-ip elsewhere --yes`)
  expect(loose).toMatch(/the floating IP elsewhere \(78, 198\.51\.100\.78\) is not assigned to the server orca-dev-2 \(176003111\).*import assigns nothing/s)
  expect(loose).toContain('hcloud --context proj floating-ip assign 78 176003111')
  expect(w.changes()).toEqual([])

  expect(await dev($, `${IMPORT} --floating-ip spare`)).toMatch(/is now the remote orca-dev-2/)
  expect(w.asked[0]!.question).toMatch(/It leaves the floating IPv4 build-server \(162501839, 88\.99\.125\.86\) as it is/)
  expect(adds(w).filter(c => c.startsWith('floating-ip'))).toEqual(['floating-ip add-label 77 managed-by=ndev ndev-name=orca-dev-2'])
  expect(w.store()?.hosts?.['orca-dev-2']).toEqual(expect.objectContaining({ floatingIp: 77, ip: '198.51.100.77' }))
  expect(w.runs.filter(r => r.argv[0] === 'ssh-keyscan').at(-1)!.argv.at(-1)).toBe('198.51.100.77')
})

test('with no floating IP, import reads the key from the server\'s own address, records no address, and says what remove and create then do', async ($, on) => {
  const w = world(on, byHand({ fips: [] }))
  await start($)

  const text = await dev($, IMPORT)
  const plan = w.asked[0]!.question
  expect(plan).toContain('The ed25519 host key that 203.0.113.7 presents now: SHA256:AAAApresented')
  expect(plan).toMatch(/The server has no floating IPv4.*remove orca-dev-2 keeps no address.*create orca-dev-2 makes a new floating IPv4/s)
  expect(text).toMatch(/has no floating IPv4/)
  expect(w.store()?.hosts?.['orca-dev-2']).toEqual({ context: 'proj', hostKey: PRESENTED, imported: true })
  expect(w.changes()).toEqual(['server add-label 176003111 managed-by=ndev ndev-name=orca-dev-2', 'firewall add-label 12048531 managed-by=ndev ndev-name=orca-dev-2'])
})

test('with no floating IP assigned, import refuses a hand-made floating IP that has the remote\'s name, which create would otherwise refuse', async ($, on) => {
  const w = world(on, byHand({ fips: [ourFip(61, 'orca-dev-2', null, { labels: {} })] }))
  await start($)
  const text = await dev($, `${IMPORT} --yes`)
  expect(text).toMatch(/the floating IP orca-dev-2 \(61, 198\.51\.100\.9\) has the remote's name, is not assigned to the server orca-dev-2 \(176003111\), and does not carry the labels/)
  expect(text).toContain('hcloud --context proj floating-ip assign 61 176003111')
  expect(w.changes()).toEqual([])
})

for (const [what, record, refusal] of [
  ['another hcloud context', { context: 'other' }, /already holds a remote orca-dev-2 in the hcloud context other, not proj/],
  ['another floating IP', { context: 'proj', floatingIp: 60, ip: FLOATING }, /already holds a remote orca-dev-2 with the floating IP 60 \(198\.51\.100\.9\), and the server 176003111 has the floating IP 162501839 \(88\.99\.125\.86\)/],
  ['another host key', { context: 'proj', hostKey: NEW_KEY }, /already holds the host key SHA256:AAAAnewhostkey for the remote orca-dev-2, and the server 176003111 presents SHA256:AAAApresented at 88\.99\.125\.86/],
] as [string, Record<string, unknown>, RegExp][]) {
  test(`import refuses when this machine already records a remote of that name with ${what}`, async ($, on) => {
    const w = world(on, byHand({ store: { projects: {}, hosts: { 'orca-dev-2': record } } }))
    await start($)
    const text = await dev($, `${IMPORT} --yes`)
    expect(text).toMatch(refusal)
    expect(text).toMatch(/Nothing changed/)
    expect(text).toContain('delete hosts.orca-dev-2 from /home/neil/.config/ndev/remote.json')
    expect(w.changes()).toEqual([])
    expect(w.store()?.hosts?.['orca-dev-2']).toEqual(record)
  })
}

test('a second import of the same server changes nothing, asks nothing, and says so', async ($, on) => {
  const w = world(on, byHand())
  await start($)
  await dev($, IMPORT)
  const before = { changes: w.changes().length, store: w.files.get(STORE) }

  const again = await dev($, IMPORT)
  expect(again).toMatch(/Nothing changed: the server orca-dev-2 \(176003111\) is already the remote orca-dev-2 in the hcloud context "proj"/)
  expect(w.asked).toHaveLength(1)
  expect(w.changes()).toHaveLength(before.changes)
  expect(w.files.get(STORE)).toBe(before.store)
  // --yes too: this machine's record vouches for the key, and there is nothing to confirm.
  expect(await dev($, `${IMPORT} --yes`)).toMatch(/Nothing changed: the server orca-dev-2/)
})

test('import of a server that is partly labelled adds only the missing labels, and names what already carries them', async ($, on) => {
  const w = world(on, byHand({ servers: [handServer({ labels: { ...OWN_LABELS, ...LABELS('orca-dev-2') } })], fips: [handFip({ labels: { 'managed-by': 'ndev' } })] }))
  await start($)

  await dev($, IMPORT)
  const plan = w.asked[0]!.question
  expect(plan).toContain('It leaves the server orca-dev-2 (176003111) as it is: it carries both labels.')
  expect(plan).not.toContain('- the server orca-dev-2')
  expect(w.changes()).toEqual([
    'firewall add-label 12048531 managed-by=ndev ndev-name=orca-dev-2',
    'floating-ip add-label 162501839 ndev-name=orca-dev-2',
  ])
})

test('import refuses a server that is not running, since its host key cannot be read', async ($, on) => {
  const w = world(on, byHand({ servers: [handServer({ status: 'off' })] }))
  await start($)
  const text = await dev($, `${IMPORT} --yes`)
  expect(text).toMatch(/the server orca-dev-2 \(176003111\) has the status "off", not "running", so its host key cannot be read\. Nothing changed/)
  expect(text).toContain('hcloud --context proj server poweron 176003111')
  expect(w.runs.some(r => r.argv[0] === 'ssh-keyscan')).toBe(false)
})

test('when a label command fails, import says which labels were added before it, and the next import finishes', async ($, on) => {
  let isBroken = true
  const w = world(on, byHand({ fail: a => (isBroken && a.includes('firewall') && a.includes('add-label') ? out('', 1, 'hcloud: server error (service_error)') : undefined) }))
  await start($)

  const text = await dev($, IMPORT)
  expect(text).toMatch(/hcloud --context proj firewall add-label 12048531 managed-by=ndev ndev-name=orca-dev-2 exited 1: hcloud: server error/)
  expect(text).toMatch(/Done before this: labelled the server orca-dev-2 \(176003111\)/)
  expect(text).toContain(`Repair: run /dev remote import ${HAND} --context proj again`)
  expect(w.store()).toBeUndefined()

  isBroken = false
  expect(await dev($, IMPORT)).toMatch(/is now the remote orca-dev-2/)
  expect(w.store()?.hosts?.['orca-dev-2']).toEqual(imported)
})

test('a firewall or floating IP without the labels beside a server of the name: the refusal of remove names import, and keeps the label command', async ($, on) => {
  const w = world(on, { servers: [ours(901, 'box-1')], firewalls: [{ ...ourFirewall(5, 'box-1'), labels: {} }] })
  await start($)
  const text = await dev($, 'remove box-1 --context proj --yes')
  expect(text).toMatch(/the firewall box-1-ssh \(5\).*does not carry the labels/)
  expect(text).toContain('/dev remote import 901 --context proj')
  expect(text).toContain('hcloud --context proj firewall add-label 5 managed-by=ndev ndev-name=box-1')
  expect(w.changes()).toEqual([])
})

test('import shows what an earlier remote of the name left, and a firewall with another name that create and remove will not use', async ($, on) => {
  const w = world(on, byHand({ firewalls: [handFirewall({ name: 'web' })], fips: [ourFip(61, 'orca-dev-2', null)], images: [snapshot(40, 'orca-dev-2')] }))
  await start($)

  const text = await dev($, IMPORT)
  const plan = w.asked[0]!.question
  expect(plan).toMatch(/The floating IPv4 orca-dev-2 \(61, 198\.51\.100\.9\) already carries the labels of orca-dev-2: \/dev remote create orca-dev-2 assigns it to this server/)
  expect(plan).not.toMatch(/makes a new floating IPv4/)
  expect(plan).toMatch(/The snapshot 40 already carries ndev-name=orca-dev-2.*remove deletes it once its new snapshot is available/)
  for (const said of [plan, text]) {
    expect(said).toMatch(/use only a firewall named orca-dev-2-ssh: web \(12048531\) is labelled and otherwise left alone, \/dev remote create orca-dev-2 makes orca-dev-2-ssh without applying it/)
    expect(said).toContain('hcloud --context proj firewall update 12048531 --name orca-dev-2-ssh')
  }
  expect(w.changes()).toEqual(['server add-label 176003111 managed-by=ndev ndev-name=orca-dev-2', 'firewall add-label 12048531 managed-by=ndev ndev-name=orca-dev-2'])
})
