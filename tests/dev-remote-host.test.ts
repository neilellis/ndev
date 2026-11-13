import { expect, test } from 'claude-code/testing'

// /dev remote create makes a Hetzner Cloud server for Orca: from the snapshot that /dev remote remove kept for that
// name, else from the base image, prepared over SSH. /dev remote remove snapshots the server, then deletes it.
// /dev remote list also shows the servers and snapshots it made. Only the command-line tools are faked: hcloud, ssh,
// ssh-keygen, orca, and the desktop's gh and git.

type On = Parameters<Parameters<typeof test>[1]>[1]
type Engine = Parameters<Parameters<typeof test>[1]>[0]

const ROOT = '/proj'
const HOME = '/home/neil'
const STORE = `${HOME}/.config/ndev/remote.json`
const KNOWN = `${HOME}/.ssh/known_hosts`
const out = (stdout = '', exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })

type Srv = { id: number; name: string; labels: Record<string, string>; status: string; public_net: { ipv4: { ip: string } }; server_type: unknown; location: { name: string } }
type Fw = { id: number; name: string; labels: Record<string, string>; applied_to: unknown[]; rules?: unknown }
type Img = { id: number; type: string; description: string; created: string; status: string; image_size: number | null; disk_size: number; labels: Record<string, string> }

const price = (location: string, net: string, gross: string) => ({ location, price_monthly: { net, gross }, included_traffic: 21990232555520 })
const where = (available: Record<string, boolean>) => Object.entries(available).map(([name, a]) => ({ name, available: a }))
// The Hetzner catalogue at run time: cx33 is the cheapest 4-vCPU type but sold out, cax21 is ARM, cx23 has 2 vCPU,
// cpx22 is the cheapest on sale (80 GB disk), cpx32 the next (160 GB disk).
const TYPES = [
  { name: 'cx23', cores: 2, disk: 40, architecture: 'x86', deprecated: false, prices: [price('fsn1', '4.4900', '5.3431')], locations: where({ fsn1: true }) },
  { name: 'cx33', cores: 4, disk: 80, architecture: 'x86', deprecated: false, prices: [price('fsn1', '8.4900', '10.1031'), price('hel1', '8.4900', '10.1031')], locations: where({ fsn1: false, hel1: false }) },
  { name: 'cax21', cores: 4, disk: 80, architecture: 'arm', deprecated: false, prices: [price('fsn1', '10.4900', '12.4831')], locations: where({ fsn1: true }) },
  { name: 'cpx22', cores: 4, disk: 80, architecture: 'x86', deprecated: false, prices: [price('fsn1', '19.9900', '23.7881'), price('nbg1', '19.9900', '23.7881')], locations: where({ fsn1: true, nbg1: true }) },
  { name: 'cpx32', cores: 4, disk: 160, architecture: 'x86', deprecated: false, prices: [price('fsn1', '35.4900', '42.2331'), price('nbg1', '35.4900', '42.2331'), price('hel1', '29.9900', '35.6881')], locations: where({ fsn1: true, nbg1: true, hel1: true }) },
]
const IMAGES = ['ubuntu-22.04', 'ubuntu-24.04', 'ubuntu-25.10', 'ubuntu-26.04', 'debian-13'].flatMap(name => ['x86', 'arm'].map(architecture => ({ name, architecture, deprecated: null })))
const PRICING = { pricing: { currency: 'EUR', image: { price_per_gb_month: { net: '0.0143', gross: '0.0170' } }, primary_ips: [{ type: 'ipv4', prices: ['fsn1', 'nbg1', 'hel1'].map(location => ({ location, price_monthly: { net: '0.5000', gross: '0.5950' } })) }] } }
const PUBLIC = 'ssh-ed25519 AAAAC3desktop neil@desk'
const LABELS = (name: string) => ({ 'managed-by': 'ndev', 'ndev-name': name })

type Opts = {
  contract?: Record<string, unknown> | null
  servers?: Srv[]
  firewalls?: Fw[]
  images?: Img[]
  orcaServers?: { id: string; name: string }[]
  worktrees?: { path: string; displayName: string }[]
  claudeSignedIn?: boolean
  ghSignedIn?: boolean
  fail?: (argv: string[]) => ReturnType<typeof out> | undefined
  answer?: (question: string, options: string[]) => string | undefined
  hcloud?: boolean
}

function world(on: On, opts: Opts = {}) {
  const contract = opts.contract === undefined ? { hcloudContext: 'proj', settings: 'ops/{name}.json' } : opts.contract
  const files = new Map<string, string>([
    [`${ROOT}/.neil-dev.json`, JSON.stringify({ github: { repo: 'acme/widgets', board: null }, ...(contract ? { remoteHost: contract } : {}) })],
    [`${ROOT}/ops/box-1.json`, JSON.stringify({ host: 'ignored', nodeMajor: 22, pnpmVersion: '10.28.0', repoRef: 'trunk', install: 'pnpm install --frozen-lockfile' })],
    [`${HOME}/.ssh/id_ed25519.pub`, `${PUBLIC}\n`],
    [KNOWN, '10.0.0.9 ssh-ed25519 AAAAother\n'],
  ])
  const servers = opts.servers ?? []
  const firewalls = opts.firewalls ?? []
  const images = opts.images ?? []
  const orcaServers = opts.orcaServers ?? [{ id: 'aa11-x', name: 'vm-a' }]
  const runs: { argv: string[]; stdin?: string; known?: string }[] = []
  const asked: { question: string; options: string[] }[] = []
  let claude = opts.claudeSignedIn ?? false
  let nextId = 900

  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__ndev__${e.name}` } }))
  on('clock.now', () => ({ value: 1_800_000_000_000 }))
  on('clock.sleep', () => ({ value: undefined }))
  on('clock.every', () => new Promise(() => {}))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'remote-host-session' }))
  on('prompt.compose', () => ({ sections: [] }))
  on('env.get', () => ({ value: HOME }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) || e.path.startsWith(`${HOME}/dev-wiki`) }))
  on('fs.read', (_, e) => {
    if (e.path.endsWith('/scripts/remote/root-setup.sh')) return { value: '# root stage\n' }
    if (e.path.endsWith('/scripts/remote/user-setup.sh')) return { value: '# user stage\n' }
    if (e.path.endsWith('/scripts/remote/clone.sh')) return { value: '# clone stage\n' }
    if (!files.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: files.get(e.path)! }
  })
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.list', (_, e) => ({ value: [...files.keys()].filter(p => p.startsWith(`${e.path}/`) && !p.slice(e.path.length + 1).includes('/')).map(p => ({ name: p.slice(e.path.length + 1), kind: 'file' })) }))
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
  on('process.run', (_, e) => {
    const a = [...e.argv]
    runs.push({ argv: a, ...(e.stdin === undefined ? {} : { stdin: String(e.stdin) }), ...(a[0] === 'ssh' ? { known: files.get(KNOWN) ?? '' } : {}) })
    const failed = opts.fail?.(a)
    if (failed) return failed
    const cmd = a.join(' ')
    if (a[0] === 'git' && a[1] === 'rev-parse') return out(`${ROOT}\n`)
    if (a[0] === 'git' && a[1] === 'config') return out(a[2] === 'user.name' ? 'Neil\n' : 'neil@example.com\n')
    if (a[0] === 'mkdir' || a[0] === 'chmod') return out()
    if (a[0] === 'rm') { for (const p of [...files.keys()]) if (a.slice(2).some(t => p === t || p.startsWith(`${t}/`))) files.delete(p); return out() }
    if (a[0] === 'ssh-keygen') {
      const path = a[a.indexOf('-f') + 1]!
      files.set(path, '-----BEGIN OPENSSH PRIVATE KEY-----\nFIRSTBOOT\n-----END OPENSSH PRIVATE KEY-----\n')
      files.set(`${path}.pub`, 'ssh-ed25519 AAAAfirstboot box-1 first boot\n')
      return out()
    }
    if (a[0] === 'gh' && a[1] === 'auth' && a[2] === 'token') return out('gho_desktop_token\n')
    if (a[0] === 'orca') {
      if (a[1] === 'environment' && a[2] === 'list') return out(JSON.stringify({ ok: true, result: { environments: orcaServers } }))
      if (a[1] === 'worktree' && a[2] === 'list') return out(JSON.stringify({ ok: true, result: { worktrees: opts.worktrees ?? [] } }))
      if (a[1] === 'orchestration') return out(JSON.stringify({ ok: true, result: { workers: [] } }))
      if (a[1] === 'environment' && (a[2] === 'forget' || a[2] === 'stop')) {
        const at = orcaServers.findIndex(s => a.includes(s.id))
        if (at >= 0) orcaServers.splice(at, 1)
        return out(JSON.stringify({ ok: true, result: {} }))
      }
      return out('', 1, `unmocked orca: ${cmd}`)
    }
    if (a[0] === 'hcloud') {
      if (opts.hcloud === false) throw new Error('spawn hcloud ENOENT')
      if (cmd === 'hcloud context list -o json') return out(JSON.stringify([{ name: 'other', active: true }, { name: 'proj', active: false }]))
      if (a[1] !== '--context') return out('', 1, `unexpected hcloud call with no --context: ${cmd}`)
      const rest = a.slice(3)
      const r = rest.join(' ')
      if (r === 'server-type list -o json') return out(JSON.stringify(TYPES))
      if (r === 'image list --type system -o json') return out(JSON.stringify(IMAGES))
      if (r === 'api /pricing') return out(JSON.stringify(PRICING))
      if (r === 'ssh-key list -o json') return out(JSON.stringify([{ id: 7, name: 'desk', public_key: PUBLIC }, { id: 8, name: 'lost', public_key: 'ssh-rsa AAAAgone x' }]))
      if (r === 'server list -o json') return out(JSON.stringify(servers))
      if (r === 'server list -l managed-by=ndev -o json') return out(JSON.stringify(servers.filter(s => s.labels['managed-by'] === 'ndev')))
      if (r === 'firewall list -o json') return out(JSON.stringify(firewalls))
      if (r.startsWith('image list --type snapshot -l ')) {
        const want = Object.fromEntries(rest[5]!.split(',').map(kv => kv.split('=') as [string, string]))
        return out(JSON.stringify(images.filter(i => Object.entries(want).every(([k, v]) => i.labels[k] === v))))
      }
      if (r.startsWith('firewall create')) {
        const name = a[a.indexOf('--name') + 1]!
        firewalls.push({ id: nextId++, name, labels: labelsOf(a), applied_to: [], rules: JSON.parse(String(e.stdin)) })
        return out()
      }
      if (r.startsWith('server create ')) {
        const name = a[a.indexOf('--name') + 1]!
        const location = a[a.indexOf('--location') + 1]!
        const type = TYPES.find(t => t.name === a[a.indexOf('--type') + 1])
        servers.push({ id: nextId++, name, labels: labelsOf(a), status: 'running', public_net: { ipv4: { ip: '203.0.113.7' } }, server_type: type, location: { name: location } })
        firewalls.find(f => f.name === a[a.indexOf('--firewall') + 1])?.applied_to.push({ type: 'server' })
        return out()
      }
      if (r.startsWith('server shutdown')) { servers.find(s => String(s.id) === a.at(-1))!.status = 'off'; return out() }
      if (r.startsWith('server poweron')) { servers.find(s => String(s.id) === a.at(-1))!.status = 'running'; return out() }
      if (r.startsWith('server create-image')) {
        const name = labelsOf(a)['ndev-name']!
        images.push({ id: nextId++, type: 'snapshot', description: a[a.indexOf('--description') + 1]!, created: '2027-01-15T10:00:00+00:00', status: 'available', image_size: 6.5, disk_size: 160, labels: labelsOf(a) })
        void name
        return out()
      }
      if (r.startsWith('server delete')) { servers.splice(servers.findIndex(s => String(s.id) === a.at(-1)), 1); return out() }
      if (r.startsWith('firewall delete')) { firewalls.splice(firewalls.findIndex(f => String(f.id) === a.at(-1)), 1); return out() }
      if (r.startsWith('image delete')) { images.splice(images.findIndex(i => String(i.id) === a.at(-1)), 1); return out() }
      return out('', 1, `unmocked hcloud: ${cmd}`)
    }
    if (a[0] === 'ssh') {
      const remote = a.at(-1)!
      if (remote.includes('claude auth status')) return claude ? out('signed in\n') : out('', 1, 'Not logged in')
      if (remote.includes('gh api user')) return (opts.ghSignedIn ?? true) ? out('neil\n') : out('', 1, 'HTTP 401: Bad credentials')
      if (remote.includes('gh auth status')) return out('', 1, 'not logged in')
      if (remote.includes('test -f /var/run/reboot-required')) return out('', 1)
      if (remote.includes('ssh_host_') && remote.includes('.pub')) return out('ssh-ed25519 AAAAnewhostkey root@box-1\n')
      if (remote.startsWith('df ')) return out('6012345678\n')
      if (remote.endsWith('bash -s') && String(e.stdin).startsWith('# root stage')) return out('ssh-ed25519 AAAAnewhostkey\n')
      return out()
    }
    return out('', 1, `unmocked: ${cmd}`)
  })
  type Store = { projects: Record<string, { id: string; name: string }>; hosts?: Record<string, Record<string, unknown>> }
  const store = () => (files.has(STORE) ? JSON.parse(files.get(STORE)!) as Store : undefined)
  return {
    files, runs, asked, servers, firewalls, images, orcaServers, store,
    signIn: () => { claude = true },
    argvs: () => runs.map(r => r.argv),
    // The calls that make, change or delete a paid resource, or switch a server off or on.
    changes: () => runs.filter(r => r.argv[0] === 'hcloud' && /^(server|firewall|image) (create|create-image|delete|shutdown|poweron)\b/.test(r.argv.slice(3).join(' '))).map(r => r.argv.join(' ')),
  }
}

const labelsOf = (a: string[]) => Object.fromEntries(a.flatMap((x, i) => (x === '--label' ? [a[i + 1]!.split('=') as [string, string]] : [])))
const ours = (id: number, name: string, extra: Partial<Srv> = {}): Srv => ({
  id, name, labels: LABELS(name), status: 'running', public_net: { ipv4: { ip: '203.0.113.7' } }, server_type: TYPES[4], location: { name: 'hel1' }, ...extra,
})
const snapshot = (id: number, name: string, extra: Partial<Img> = {}): Img => ({
  id, type: 'snapshot', description: `ndev ${name}`, created: '2026-12-01T09:00:00+00:00', status: 'available', image_size: 5.2, disk_size: 80, labels: LABELS(name), ...extra,
})
const ourFirewall = (id: number, name: string): Fw => ({ id, name: `${name}-ssh`, labels: LABELS(name), applied_to: [{ type: 'server' }] })
const hostRecord = (extra: Record<string, unknown> = {}) => ({ context: 'proj', serverId: 901, ip: '203.0.113.7', firewall: 'box-1-ssh', project: 'acme/widgets', username: 'orca', ...extra })

const start = ($: Engine) => $.session.start({ cwd: `${ROOT}/src`, surface: 'terminal', isInteractive: true })
const dev = async ($: Engine, args: string) => (await $.command.run({ command: 'dev', args: `remote ${args}`.trim() })).text ?? ''

// --- create from the base image -------------------------------------------------------------------------------------

test('create with no kept snapshot shows the cheapest 4-vCPU type on sale, its monthly price and what it leaves out, and makes nothing when the human cancels', async ($, on) => {
  const w = world(on, { answer: () => 'Cancel' })
  await start($)

  const text = await dev($, 'create box-1')
  expect(w.asked).toHaveLength(1)
  const plan = w.asked[0]!.question
  expect(plan).toMatch(/no kept snapshot/i)
  expect(plan).toMatch(/cpx22/)
  expect(plan).toMatch(/fsn1/)
  expect(plan).toMatch(/19\.99/)
  expect(plan).toMatch(/23\.79/)
  expect(plan).toMatch(/IPv4.*0\.50/)
  expect(plan).toMatch(/ubuntu-26\.04/)
  expect(plan).toMatch(/hcloud context "proj"/)
  expect(w.asked[0]!.options).toEqual(['Create box-1', 'Cancel'])
  expect(text).toMatch(/Nothing was created/)
  expect(w.changes()).toEqual([])
  // Every Hetzner call names the context; the active one ("other") is never used.
  for (const a of w.argvs().filter(x => x[0] === 'hcloud' && x[1] !== 'context')) expect(a.slice(1, 3)).toEqual(['--context', 'proj'])
})

test('create makes nothing when the dialog is closed, as in a run with no one to ask', async ($, on) => {
  const w = world(on, { answer: () => undefined })
  await start($)

  expect(await dev($, 'create box-1')).toMatch(/Nothing was created/)
  expect(w.changes()).toEqual([])
})

test('create from the base image makes the labelled firewall and server, prepares the host, and stops at the Claude sign-in with the ssh command', async ($, on) => {
  const w = world(on)
  await start($)

  const text = await dev($, 'create box-1')
  expect(w.changes()).toEqual([
    'hcloud --context proj firewall create --name box-1-ssh --label managed-by=ndev --label ndev-name=box-1 --rules-file -',
    'hcloud --context proj server create --name box-1 --type cpx22 --image ubuntu-26.04 --location fsn1 --ssh-key desk --firewall box-1-ssh --user-data-from-file - --label managed-by=ndev --label ndev-name=box-1',
  ])
  // The firewall lets in only SSH and ping.
  const rules = w.firewalls[0]!.rules as { protocol: string; port?: string | null }[]
  expect(rules.map(r => `${r.protocol}${r.port ? `:${r.port}` : ''}`)).toEqual(['tcp:22', 'icmp'])
  // The first-boot host key goes in by the user data on stdin; its private half never stays on this machine.
  const create = w.runs.find(r => r.argv.includes('server') && r.argv.includes('create'))!
  expect(create.stdin).toMatch(/FIRSTBOOT/)
  expect([...w.files.values()].some(v => v.includes('FIRSTBOOT'))).toBe(false)
  // The first connection already trusts the first-boot key; known_hosts ends with the host's new key, and keeps the other hosts.
  expect(w.runs.find(r => r.argv[0] === 'ssh')!.known).toContain('203.0.113.7 ssh-ed25519 AAAAfirstboot')
  expect(w.files.get(KNOWN)).toBe('10.0.0.9 ssh-ed25519 AAAAother\n203.0.113.7 ssh-ed25519 AAAAnewhostkey\n')
  // The project's settings reach the host: Node 22, pnpm 10.28.0, the ref and the install command.
  const ssh = w.runs.filter(r => r.argv[0] === 'ssh')
  expect(ssh.find(r => r.argv.at(-1)!.includes('node_major=22'))?.argv.at(-1)).toMatch(/pnpm_version=10\.28\.0/)
  expect(ssh.find(r => r.argv.at(-1)!.includes('repo_ref=trunk'))?.argv.at(-1)).toMatch(/repo_url=https:\/\/github\.com\/acme\/widgets\.git/)
  // The desktop's gh token goes over stdin, never on a command line.
  expect(ssh.find(r => r.stdin?.includes('gho_desktop_token'))?.argv.at(-1)).toMatch(/gh auth login .*--with-token/)
  expect(w.argvs().some(a => a.join(' ').includes('gho_desktop_token'))).toBe(false)
  // No credentials file and no Claude credentials are copied.
  expect(w.argvs().some(a => ['scp', 'rsync'].includes(a[0]!) || a.join(' ').includes('.credentials'))).toBe(false)
  // It stops cleanly at the sign-in, naming the exact command and what to run next.
  expect(text).toContain(`ssh -t orca@203.0.113.7 'bash -lc "claude auth login"'`)
  expect(text).toMatch(/\/dev remote create box-1 again/)
  expect(text).toMatch(/hcloud context "proj"/)
  expect(w.store()?.hosts?.['box-1']).toEqual(expect.objectContaining({ context: 'proj', serverId: 901, ip: '203.0.113.7', project: 'acme/widgets' }))
})

test('create run again finds its own server, makes no second one, asks nothing, and saves the Orca server as the setting once Orca has it', async ($, on) => {
  const w = world(on)
  await start($)
  await dev($, 'create box-1')
  w.signIn()
  const asked = w.asked.length
  const changes = w.changes().length

  const ready = await dev($, 'create box-1')
  expect(w.changes()).toHaveLength(changes)
  expect(w.asked).toHaveLength(asked)
  expect(ready).toMatch(/host ready/)
  // Orca has no saved server for it yet: the one app step, and /dev remote picks it up.
  expect(ready).toMatch(/In the Orca app/)
  expect(ready).toMatch(/orca@203\.0\.113\.7/)
  expect(w.store()?.projects['acme/widgets']).toBeUndefined()

  w.orcaServers.push({ id: 'bb22-y', name: 'box-1 VM 1a2b' })
  expect(await dev($, 'create box-1')).toMatch(/box-1 VM 1a2b \(bb22-y\)/)
  expect(w.changes()).toHaveLength(changes)
  expect(w.store()?.projects['acme/widgets']).toEqual(expect.objectContaining({ id: 'bb22-y', name: 'box-1 VM 1a2b' }))
})

test('create never takes over a server or firewall of that name that it did not label', async ($, on) => {
  const w = world(on, { servers: [{ ...ours(176003111, 'orca-dev-2'), labels: { project: 'fcc-proto', role: 'orca-host' } }], firewalls: [{ id: 5, name: 'box-1-ssh', labels: {}, applied_to: [] }] })
  await start($)

  const text = await dev($, 'create orca-dev-2')
  expect(text).toMatch(/orca-dev-2 \(176003111\)/)
  expect(text).toMatch(/project=fcc-proto/)
  expect(text).toMatch(/managed-by=ndev/)
  expect(await dev($, 'create box-1')).toMatch(/firewall box-1-ssh \(5\)/)
  expect(w.changes()).toEqual([])
  expect(w.argvs().some(a => a[0] === 'ssh')).toBe(false)
  expect(w.asked).toEqual([])
})

test('create needs a named hcloud context and never falls back to the active one', async ($, on) => {
  const w = world(on, { contract: null })
  await start($)

  const text = await dev($, 'create box-1')
  expect(text).toMatch(/hcloud context/)
  expect(text).toMatch(/other, proj/)
  expect(text).toMatch(/--context <context>/)
  expect(text).toMatch(/remoteHost/)
  expect(await dev($, 'create box-1 --context nope')).toMatch(/no hcloud context "nope"/)
  expect(w.changes()).toEqual([])
})

test('create refuses a bad name, and a type the project names that is not on sale', async ($, on) => {
  const w = world(on, { contract: { hcloudContext: 'proj', serverType: 'cx33' } })
  await start($)

  expect(await dev($, 'create Box_1')).toMatch(/"Box_1" is not a server name/)
  const text = await dev($, 'create box-1')
  expect(text).toMatch(/cx33/)
  expect(text).toMatch(/not on sale/)
  expect(text).toMatch(/cpx22/)
  expect(w.changes()).toEqual([])
})

test('a create that fails in one location tries the next, and a failed step after it names the step, exit code, output and both repairs', async ($, on) => {
  const w = world(on, {
    contract: { hcloudContext: 'proj', locations: ['fsn1', 'nbg1'] },
    fail: a => {
      if (a.includes('create') && a.includes('fsn1')) return out('', 1, 'hcloud: resource_unavailable')
      if (a[0] === 'ssh' && a.at(-1)!.endsWith('bash -s') && a.includes('root@203.0.113.7')) return out('apt said no', 100, 'E: Unable to locate package')
      return undefined
    },
  })
  await start($)

  const text = await dev($, 'create box-1')
  expect(w.changes().filter(c => c.includes('server create'))).toEqual([expect.stringMatching(/fsn1/), expect.stringMatching(/nbg1/)])
  expect(text).toMatch(/system packages/)
  expect(text).toMatch(/exited 100/)
  expect(text).toMatch(/Unable to locate package/)
  expect(text).toMatch(/box-1 \(901, 203\.0\.113\.7\)/)
  expect(text).toMatch(/\/dev remote create box-1/)
  expect(text).toMatch(/\/dev remote remove box-1/)
})

test('a server create that fails but leaves a server stops, and makes no second one', async ($, on) => {
  const w = world(on, {
    contract: { hcloudContext: 'proj', locations: ['fsn1', 'nbg1'] },
    fail: a => {
      if (a.includes('create') && a.includes('--type')) {
        w.servers.push(ours(950, 'box-1', { status: 'off' }))
        return out('', 1, 'hcloud: timeout')
      }
      return undefined
    },
  })
  await start($)

  const text = await dev($, 'create box-1')
  expect(w.changes().filter(c => c.includes('server create'))).toHaveLength(1)
  expect(text).toMatch(/box-1 \(950/)
  expect(text).toMatch(/\/dev remote remove box-1/)
})

// --- create from a kept snapshot ------------------------------------------------------------------------------------

test('create restores the newest kept snapshot at a new address, trusts only the host keys kept at remove, and re-checks the sign-ins', async ($, on) => {
  const w = world(on, {
    images: [snapshot(70, 'box-1', { created: '2026-11-01T09:00:00+00:00' }), snapshot(71, 'box-1', { created: '2026-12-01T09:00:00+00:00', disk_size: 160 }), snapshot(72, 'box-1', { status: 'creating', created: '2026-12-02T09:00:00+00:00' })],
    ghSignedIn: false,
    claudeSignedIn: true,
  })
  w.files.set(STORE, JSON.stringify({ projects: {}, hosts: { 'box-1': hostRecord({ serverId: undefined, ip: '198.51.100.4', hostKeys: ['ssh-ed25519 AAAAkeptkey'], snapshotId: 71 }) } }))
  w.files.set(KNOWN, '10.0.0.9 ssh-ed25519 AAAAother\n198.51.100.4 ssh-ed25519 AAAAkeptkey\n')
  await start($)

  const text = await dev($, 'create box-1')
  const plan = w.asked[0]!.question
  expect(plan).toMatch(/snapshot 71/)
  expect(plan).toMatch(/2026-12-01/)
  // The cheapest type on sale whose disk holds the snapshot's 160 GB: cpx32 in hel1, not the cheaper cpx22 with 80 GB.
  expect(plan).toMatch(/cpx32/)
  expect(plan).toMatch(/hel1/)
  expect(plan).toMatch(/29\.99/)
  expect(plan).not.toMatch(/cpx22/)
  const create = w.runs.find(r => r.argv.includes('server') && r.argv.includes('create'))!
  expect(create.argv.join(' ')).toMatch(/--image 71 /)
  // cloud-init keeps the snapshot's host keys; no first-boot key is made.
  expect(create.stdin).toMatch(/ssh_deletekeys: false/)
  expect(w.argvs().some(a => a[0] === 'ssh-keygen' && a.includes('-t'))).toBe(false)
  // The kept key is written for the new address before the first connection, and every connection checks it; the old address is dropped.
  const ssh = w.runs.filter(r => r.argv[0] === 'ssh')
  expect(ssh.length).toBeGreaterThan(0)
  for (const r of ssh) {
    expect(r.known).toContain('203.0.113.7 ssh-ed25519 AAAAkeptkey')
    expect(r.argv.join(' ')).toMatch(/StrictHostKeyChecking=yes/)
  }
  expect(w.files.get(KNOWN)).toBe('10.0.0.9 ssh-ed25519 AAAAother\n203.0.113.7 ssh-ed25519 AAAAkeptkey\n')
  // The snapshot holds the toolchain and clone: no setup stage runs again.
  expect(w.runs.some(r => r.stdin?.startsWith('# root stage') || r.stdin?.startsWith('# user stage'))).toBe(false)
  // gh no longer proves its sign-in: reported with the repair, and create still finishes.
  expect(text).toMatch(/gh.*HTTP 401/s)
  expect(text).toMatch(/gh auth login/)
  expect(text).toMatch(/host ready/)
  expect(w.store()?.hosts?.['box-1']).toEqual(expect.objectContaining({ serverId: 901, ip: '203.0.113.7' }))
})

test('create refuses a snapshot whose disk is larger than the disk of the type the project names', async ($, on) => {
  const w = world(on, { contract: { hcloudContext: 'proj', serverType: 'cpx22' }, images: [snapshot(71, 'box-1', { disk_size: 160 })] })
  w.files.set(STORE, JSON.stringify({ projects: {}, hosts: { 'box-1': hostRecord({ serverId: undefined, hostKeys: ['ssh-ed25519 AAAAkeptkey'] }) } }))
  await start($)

  const text = await dev($, 'create box-1')
  expect(text).toMatch(/cpx22/)
  expect(text).toMatch(/80 GB/)
  expect(text).toMatch(/160 GB/)
  expect(w.changes()).toEqual([])
  expect(w.asked).toEqual([])
})

test('create refuses a kept snapshot whose host keys this machine did not keep: it never trusts a key on first use', async ($, on) => {
  const w = world(on, { images: [snapshot(73, 'box-3')] })
  await start($)

  const text = await dev($, 'create box-3')
  expect(text).toMatch(/host key/)
  expect(text).toMatch(/\/dev remote remove box-3 --forget/)
  expect(w.changes()).toEqual([])
  expect(w.argvs().some(a => a[0] === 'ssh')).toBe(false)
})

// --- remove ---------------------------------------------------------------------------------------------------------

test('remove refuses a server it did not label, or one labelled with another name, and deletes nothing', async ($, on) => {
  const w = world(on, { servers: [{ ...ours(176003111, 'orca-dev-2'), labels: { project: 'fcc-proto' } }, { ...ours(4, 'box-2'), labels: { 'managed-by': 'ndev', 'ndev-name': 'box-9' } }] })
  await start($)

  const a = await dev($, 'remove orca-dev-2 --context proj')
  expect(a).toMatch(/orca-dev-2 \(176003111\)/)
  expect(a).toMatch(/project=fcc-proto/)
  expect(await dev($, 'remove box-2 --context proj')).toMatch(/ndev-name=box-9/)
  expect(await dev($, 'remove')).toMatch(/names the server/)
  expect(w.changes()).toEqual([])
  expect(w.asked).toEqual([])
})

test('remove lists the workspaces, confirms what is kept and deleted, shuts the server down, snapshots it, and only then deletes it and the older snapshot', async ($, on) => {
  const w = world(on, {
    servers: [ours(901, 'box-1')],
    firewalls: [ourFirewall(902, 'box-1')],
    images: [snapshot(60, 'box-1'), { ...snapshot(61, 'box-1'), labels: { 'ndev-name': 'box-1' } }],
    orcaServers: [{ id: 'bb22-y', name: 'box-1 VM 1a2b' }, { id: 'aa11-x', name: 'vm-a' }],
    worktrees: [{ path: '/home/orca/w/fix-1', displayName: 'fix-1' }],
  })
  w.files.set(STORE, JSON.stringify({ projects: { 'acme/widgets': { id: 'bb22-y', name: 'box-1 VM 1a2b' } }, hosts: { 'box-1': hostRecord({ orcaId: 'bb22-y' }) } }))
  w.files.set(KNOWN, '10.0.0.9 ssh-ed25519 AAAAother\n203.0.113.7 ssh-ed25519 AAAAnewhostkey\n')
  await start($)

  const text = await dev($, 'remove box-1')
  const confirm = w.asked.at(-1)!.question
  expect(confirm).toMatch(/box-1/)
  expect(confirm).toMatch(/901/)
  expect(confirm).toMatch(/203\.0\.113\.7/)
  expect(confirm).toMatch(/fix-1/)
  expect(confirm).toMatch(/files are kept in the snapshot/)
  expect(confirm).toMatch(/processes stop/)
  // What is kept: the snapshot, its rough size and monthly price, and what it holds.
  expect(confirm).toMatch(/6\.0 GB/)
  expect(confirm).toMatch(/0\.09/)
  expect(confirm).toMatch(/Claude sign-in/)
  expect(confirm).toMatch(/gh token/)
  expect(confirm).toMatch(/unpushed work/)
  expect(confirm).toMatch(/--forget/)
  // The older labelled snapshot is named before anything runs; the unlabelled one is not.
  expect(confirm).toMatch(/snapshot 60/)
  expect(confirm).not.toMatch(/61/)
  expect(w.asked.at(-1)!.options[0]).toBe('Snapshot and delete box-1')

  expect(w.changes()).toEqual([
    'hcloud --context proj server shutdown --wait --wait-timeout 180s 901',
    expect.stringMatching(/^hcloud --context proj server create-image --type snapshot --description .* --label managed-by=ndev --label ndev-name=box-1 901$/),
    'hcloud --context proj server delete 901',
    'hcloud --context proj firewall delete 902',
    'hcloud --context proj image delete 60',
  ])
  expect(w.images.map(i => i.id)).toEqual([61, 900])
  expect(w.argvs().some(a => a.join(' ') === 'orca environment forget --environment bb22-y --yes --json')).toBe(true)
  expect(w.files.get(KNOWN)).toBe('10.0.0.9 ssh-ed25519 AAAAother\n')
  expect(w.store()?.projects).toEqual({})
  expect(w.store()?.hosts?.['box-1']).toEqual(expect.objectContaining({ snapshotId: 900, hostKeys: ['ssh-ed25519 AAAAnewhostkey'] }))
  expect(w.store()?.hosts?.['box-1']?.serverId).toBeUndefined()
  expect(text).toMatch(/snapshot 900/)
  expect(text).toMatch(/\/dev remote create box-1/)
})

test('remove deletes nothing when the snapshot fails: it starts the server again and reports the image error with the repair', async ($, on) => {
  const w = world(on, {
    servers: [ours(901, 'box-1')],
    firewalls: [ourFirewall(902, 'box-1')],
    images: [snapshot(60, 'box-1')],
    orcaServers: [{ id: 'bb22-y', name: 'box-1 VM 1a2b' }],
    fail: a => (a.includes('create-image') ? out('', 1, 'hcloud: action create_image failed: image_creation_failed') : undefined),
  })
  w.files.set(STORE, JSON.stringify({ projects: { 'acme/widgets': { id: 'bb22-y', name: 'box-1 VM 1a2b' } }, hosts: { 'box-1': hostRecord({ orcaId: 'bb22-y' }) } }))
  await start($)

  const text = await dev($, 'remove box-1')
  expect(w.changes()).toEqual([
    'hcloud --context proj server shutdown --wait --wait-timeout 180s 901',
    expect.stringMatching(/server create-image/),
    'hcloud --context proj server poweron 901',
  ])
  expect(w.servers.map(s => [s.id, s.status])).toEqual([[901, 'running']])
  expect(w.images.map(i => i.id)).toEqual([60])
  expect(w.orcaServers).toHaveLength(1)
  expect(w.store()?.projects['acme/widgets']).toEqual(expect.objectContaining({ id: 'bb22-y' }))
  expect(text).toMatch(/image_creation_failed/)
  expect(text).toMatch(/exited 1/)
  expect(text).toMatch(/Nothing was deleted/)
  expect(text).toMatch(/\/dev remote remove box-1/)
})

test('remove deletes nothing when the image is not available after the wait', async ($, on) => {
  const w = world(on, {
    servers: [ours(901, 'box-1')],
    firewalls: [ourFirewall(902, 'box-1')],
    fail: a => {
      if (!a.includes('create-image')) return undefined
      w.images.push({ ...snapshot(905, 'box-1'), status: 'creating' })
      return out()
    },
  })
  await start($)

  const text = await dev($, 'remove box-1 --context proj')
  expect(w.changes().filter(c => c.includes('delete'))).toEqual([])
  expect(w.changes().at(-1)).toBe('hcloud --context proj server poweron 901')
  expect(text).toMatch(/905/)
  expect(text).toMatch(/creating/)
  expect(text).toMatch(/Nothing was deleted/)
})

test('remove deletes nothing when the human cancels', async ($, on) => {
  const w = world(on, {
    servers: [ours(901, 'box-1')],
    firewalls: [ourFirewall(902, 'box-1')],
    answer: (_, options) => options.at(-1),
  })
  await start($)

  expect(await dev($, 'remove box-1 --context proj')).toMatch(/Nothing was deleted/)
  expect(w.changes()).toEqual([])
})

test('remove --forget deletes the kept snapshots of that name after its own confirmation, never an unlabelled image', async ($, on) => {
  const w = world(on, { images: [snapshot(60, 'box-1'), { ...snapshot(61, 'box-1'), labels: { 'ndev-name': 'box-1' } }, snapshot(62, 'box-2')] })
  w.files.set(STORE, JSON.stringify({ projects: {}, hosts: { 'box-1': hostRecord({ serverId: undefined, snapshotId: 60, hostKeys: ['ssh-ed25519 AAAAk'] }) } }))
  await start($)

  const text = await dev($, 'remove box-1 --forget')
  const confirm = w.asked.at(-1)!
  expect(confirm.question).toMatch(/snapshot 60/)
  expect(confirm.question).toMatch(/for good/)
  expect(confirm.question).not.toMatch(/61|62/)
  expect(confirm.options[0]).toBe('Delete the snapshot of box-1')
  expect(w.changes()).toEqual(['hcloud --context proj image delete 60'])
  expect(w.store()?.hosts?.['box-1']).toBeUndefined()
  expect(text).toMatch(/60/)
})

test('remove --forget refuses while the server of that name exists, and names the remove that snapshots it first', async ($, on) => {
  const w = world(on, { servers: [ours(901, 'box-1')], images: [snapshot(60, 'box-1')] })
  await start($)

  expect(await dev($, 'remove box-1 --forget --context proj')).toMatch(/\/dev remote remove box-1\b(?! --forget)/)
  expect(w.changes()).toEqual([])
  expect(w.asked).toEqual([])
})

// --- list -----------------------------------------------------------------------------------------------------------

test('list marks the servers ndev made in Hetzner, with type, location, IP and monthly price, and the kept snapshots with no server', async ($, on) => {
  world(on, { servers: [ours(901, 'box-1'), { ...ours(175578364, 'fcc-graph-server'), labels: {} }], images: [snapshot(70, 'box-7'), { ...snapshot(71, 'stray'), labels: {} }] })
  await start($)

  const text = await dev($, 'list')
  expect(text).toMatch(/vm-a\s+aa11-x/)
  const line = text.split('\n').find(l => l.includes('box-1'))
  expect(line).toMatch(/cpx32/)
  expect(line).toMatch(/hel1/)
  expect(line).toMatch(/203\.0\.113\.7/)
  expect(line).toMatch(/29\.99/)
  expect(line).toMatch(/proj/)
  const kept = text.split('\n').find(l => l.includes('box-7'))
  expect(kept).toMatch(/2026-12-01/)
  expect(kept).toMatch(/5\.2 GB/)
  expect(kept).toMatch(/\/dev remote create box-7/)
  expect(text).not.toMatch(/fcc-graph-server/)
  expect(text).not.toMatch(/stray/)
})

test('list still shows the Orca servers when hcloud is missing, and says in one line why the Hetzner part is empty', async ($, on) => {
  world(on, { hcloud: false })
  await start($)

  const text = await dev($, 'list')
  expect(text).toMatch(/vm-a\s+aa11-x/)
  const why = text.split('\n').filter(l => /hcloud/.test(l))
  expect(why).toHaveLength(1)
  expect(why[0]).toMatch(/not (found|installed)/)
})
