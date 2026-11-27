import { expect, test } from './sdk-testing'

// /dev remote saves which of Orca's saved servers this project uses as its remote machine. The setting lives on this
// machine (the server is an entry in this machine's Orca), keyed by the project's GitHub repository.

type On = Parameters<Parameters<typeof test>[1]>[1]
type Engine = Parameters<Parameters<typeof test>[1]>[0]

const ROOT = '/proj'
const PRIMARY = '/primary'
const ORCA_YAML = `scripts:\n  setup: ./setup.sh\nenvironmentRecipes:\n  - id: dev-build\n    name: dev-build (Hetzner, SSH)\n    create: ./scripts/orca-vm/dev-build-create.sh\n  - id: dev-host-2\n    name: "dev-host-2 (Hetzner, SSH)"\n    create: ./scripts/orca-vm/dev-host-2-create.sh\n  - id: bare\n    create: ./x.sh\nother:\n  - id: not-a-recipe\n`
const STORE = '/home/user/.config/ndev/remote.json'
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

// A fake engine: the project is acme/widgets at /proj, and Orca's saved servers are `servers` (the test may change
// them). Only the Orca CLI is faked beyond the engine's own file and process calls.
function engine(on: On, servers: { id: string; name: string }[] = [{ id: 'aa11-x', name: 'vm-a' }, { id: 'bb22-y', name: 'vm-b' }]) {
  const files = new Map<string, string>([[`${ROOT}/.ndev.json`, JSON.stringify({ github: { repo: 'acme/widgets', board: null } })]])
  const runs: string[][] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__ndev__${e.name}` } }))
  on('clock.now', () => ({ value: 1_800_000_000_000 }))
  on('clock.every', () => new Promise(() => {}))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'remote-session' }))
  on('prompt.compose', () => ({ sections: [] }))
  on('env.get', () => ({ value: '/home/user' }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) || e.path.startsWith('/home/user/dev-wiki') }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    const a = [...e.argv]
    runs.push(a)
    // A worktree: the primary checkout is /primary, and it holds the project's orca.yaml.
    if (a[0] === 'git' && a.includes('worktree')) return ok(`worktree ${PRIMARY}\nHEAD 1111\nbranch refs/heads/main\n\nworktree ${ROOT}\nHEAD 2222\nbranch refs/heads/work\n`)
    if (a[0] === 'git') return ok(`${ROOT}\n`)
    if (a.slice(0, 3).join(' ') === 'orca environment list') return ok(JSON.stringify({ id: 'x', ok: true, result: { environments: servers } }))
    return ok()
  })
  const saved = () => (files.has(STORE) ? (JSON.parse(files.get(STORE)!) as { projects: Record<string, { id: string; name: string }> }).projects : undefined)
  return { files, runs, servers, saved }
}

const start = ($: Engine) => $.session.start({ cwd: `${ROOT}/src`, surface: 'terminal', isInteractive: true })
const remote = async ($: Engine, args: string) => (await $.command.run({ command: 'dev', args: `remote ${args}`.trim() })).text ?? ''

test('/dev remote <server> saves the Orca server by its name, and /dev remote shows it and that Orca still has it', async ($, on) => {
  const w = engine(on)
  await start($)

  const set = await remote($, 'vm-b')
  expect(set).toMatch(/vm-b \(bb22-y\)/)
  expect(set).toContain(STORE)
  expect(w.saved()).toEqual({ 'acme/widgets': expect.objectContaining({ id: 'bb22-y', name: 'vm-b' }) })

  const shown = await remote($, '')
  expect(shown).toMatch(/acme\/widgets/)
  expect(shown).toMatch(/vm-b \(bb22-y\)/)
  expect(shown).toMatch(/Orca still has it/)
  expect(shown).toMatch(/\/dev remote off/)
})

test('/dev remote takes the start of an id too, and keeps the other projects\' settings', async ($, on) => {
  const w = engine(on)
  w.files.set(STORE, JSON.stringify({ projects: { 'acme/other': { id: 'aa11-x', name: 'vm-a' } } }))
  await start($)

  expect(await remote($, 'aa11')).toMatch(/vm-a \(aa11-x\)/)
  expect(w.saved()).toEqual({ 'acme/other': { id: 'aa11-x', name: 'vm-a' }, 'acme/widgets': expect.objectContaining({ id: 'aa11-x', name: 'vm-a' }) })
})

test('/dev remote refuses a server Orca does not have, lists the saved servers and the repair, and saves nothing', async ($, on) => {
  const w = engine(on)
  await start($)

  const text = await remote($, 'vm-c')
  expect(text).toMatch(/no saved server "vm-c"/)
  expect(text).toMatch(/vm-a \(aa11-x\)/)
  expect(text).toMatch(/vm-b \(bb22-y\)/)
  expect(text).toMatch(/Repair: run \/dev remote <server>/)
  expect(w.saved()).toBeUndefined()
})

test('/dev remote with none set says so, lists Orca\'s servers and how to set one', async ($, on) => {
  engine(on)
  await start($)

  const text = await remote($, '')
  expect(text).toMatch(/No remote server is set for acme\/widgets/)
  expect(text).toMatch(/vm-a \(aa11-x\)/)
  expect(text).toMatch(/\/dev remote <server>/)
})

test('/dev remote off clears the setting, and says when none was set', async ($, on) => {
  const w = engine(on)
  await start($)
  await remote($, 'vm-a')

  expect(await remote($, 'off')).toMatch(/cleared.*vm-a \(aa11-x\)/)
  expect(w.saved()).toEqual({})
  expect(await remote($, '')).toMatch(/No remote server is set/)
  expect(await remote($, 'off')).toMatch(/No remote server was set for acme\/widgets/)
})

test('/dev remote list shows every saved Orca server and marks the one this project uses', async ($, on) => {
  engine(on)
  await start($)
  await remote($, 'vm-b')

  const text = await remote($, 'list')
  const lines = text.split('\n')
  expect(lines.find(l => l.includes('vm-a'))).toMatch(/aa11-x/)
  expect(lines.find(l => l.includes('vm-a'))).not.toMatch(/saved for/)
  expect(lines.find(l => l.includes('vm-b'))).toMatch(/bb22-y.*saved for acme\/widgets/)
})

test('a saved server that Orca no longer has is shown as an error with both repairs, in /dev remote and /dev remote list', async ($, on) => {
  const w = engine(on)
  await start($)
  await remote($, 'vm-b')
  w.servers.splice(1, 1)

  const shown = await remote($, '')
  expect(shown).toMatch(/vm-b \(bb22-y\)/)
  expect(shown).toMatch(/Orca no longer has/)
  expect(shown).toMatch(/\/dev remote <server>/)
  expect(shown).toMatch(/\/dev remote off/)
  const listed = await remote($, 'list')
  expect(listed).toMatch(/Orca no longer has.*vm-b \(bb22-y\)/)
  expect(listed).toMatch(/\/dev remote off/)
})

test('create, remove, import, off and list are subcommands, never server names', async ($, on) => {
  const w = engine(on, [{ id: 'cc33-z', name: 'create' }, { id: 'dd44-w', name: 'list' }, { id: 'ee55-v', name: 'import' }])
  await start($)

  expect(await remote($, 'import')).toMatch(/needs the Hetzner id of the server, as in \/dev remote import <hetzner-id> --context <context>/)
  const help = (await $.command.run({ command: 'dev', args: 'help' })).text ?? ''
  expect(help).toMatch(/\/dev remote import <hetzner-id> --context <hcloud context>/)

  // create and remove make and delete a Hetzner server (tests/dev-remote-host.test.ts); neither is taken as a server's name.
  for (const word of ['create', 'remove']) {
    expect(await remote($, word)).toMatch(new RegExp(`needs the name of the remote, as in /dev remote ${word} <name>`))
  }
  expect(w.saved()).toBeUndefined()
  // A server with a reserved name is saved by its id.
  expect(await remote($, 'cc33')).toMatch(/create \(cc33-z\)/)
  expect(await remote($, 'vm-a vm-b')).toMatch(/takes one server/)
})

// Orca names a saved server "<recipe id> VM <id>", and saves it only when a workspace is made on the recipe in the app.

test('/dev remote <name> takes the short name of a saved server named "<name> VM <id>", as create does', async ($, on) => {
  const w = engine(on, [{ id: '7dbce0aa-1', name: 'dev-build VM 7dbce0aa' }, { id: 'bb22-y', name: 'dev-build-2 VM 11aa' }])
  await start($)

  expect(await remote($, 'dev-build')).toMatch(/The remote server for acme\/widgets is now dev-build VM 7dbce0aa \(7dbce0aa-1\)/)
  expect(w.saved()).toEqual({ 'acme/widgets': expect.objectContaining({ id: '7dbce0aa-1', name: 'dev-build VM 7dbce0aa' }) })
  // A name that only begins the same is another server.
  expect(await remote($, 'dev-build-2')).toMatch(/dev-build-2 VM 11aa \(bb22-y\)/)
})

test('/dev remote <name> refuses a short name that more than one saved server has, lists them, and saves nothing', async ($, on) => {
  const w = engine(on, [{ id: 'aa11-x', name: 'dev-build VM 7dbce0aa' }, { id: 'bb22-y', name: 'dev-build VM 99ff' }, { id: 'cc33-z', name: 'dev-build' }, { id: 'dd44-w', name: 'vm-a' }])
  await start($)

  const text = await remote($, 'dev-build')
  expect(text).toMatch(/"dev-build" names 3 saved servers: dev-build VM 7dbce0aa \(aa11-x\), dev-build VM 99ff \(bb22-y\), dev-build \(cc33-z\)\./)
  expect(text).not.toMatch(/vm-a/)
  expect(text).toMatch(/Repair: run \/dev remote <server> with the id of one of them/)
  expect(w.saved()).toBeUndefined()
  expect(await remote($, 'bb22')).toMatch(/dev-build VM 99ff \(bb22-y\)/)
})

test('with no saved server for a name that orca.yaml has a recipe for, the refusal says so and names the one repair with the recipe\'s display name', async ($, on) => {
  const w = engine(on, [{ id: '7dbce0aa-1', name: 'dev-build VM 7dbce0aa' }])
  w.files.set(`${PRIMARY}/orca.yaml`, ORCA_YAML)
  await start($)

  const text = await remote($, 'dev-host-2')
  expect(text).toMatch(/Orca has no saved server for "dev-host-2" yet/)
  expect(text).toMatch(/\/primary\/orca\.yaml has the environmentRecipes entry dev-host-2/)
  expect(text).toMatch(/saves its server \("dev-host-2 VM <id>"\) only when a workspace is made on the recipe in the Orca app/)
  expect(text).toMatch(/The saved servers: dev-build VM 7dbce0aa \(7dbce0aa-1\)/)
  expect(text).toContain('Repair: in the Orca app: New workspace, then Run on, then "dev-host-2 (Hetzner, SSH)". Then run /dev remote dev-host-2 again.')
  expect(text).not.toMatch(/orca skills get/)
  expect(w.saved()).toBeUndefined()
  // The list at column 0, a comment inside it, the name before the id, and a deeper name that is not the recipe's.
  w.files.set(`${PRIMARY}/orca.yaml`, 'environmentRecipes:\n# the hosts\n- name: Second box # ours\n  ssh:\n    name: inner\n  id: box-2\n- id: bare\n  create: ./x.sh\n')
  expect(await remote($, 'box-2')).toContain('then Run on, then "Second box". Then run /dev remote box-2 again.')
  // A recipe with no display name is shown by its id.
  expect(await remote($, 'bare')).toContain('then Run on, then "bare". Then run /dev remote bare again.')
  // Once the workspace is made, Orca has the server and the same command takes it.
  w.servers.push({ id: 'ee55-v', name: 'dev-host-2 VM 5e6f' })
  expect(await remote($, 'dev-host-2')).toMatch(/is now dev-host-2 VM 5e6f \(ee55-v\)/)
})

test('with no saved server and no recipe of that name, the refusal keeps the list and adds how to make a recipe', async ($, on) => {
  const w = engine(on)
  w.files.set(`${PRIMARY}/orca.yaml`, ORCA_YAML)
  await start($)

  // An id under another key of orca.yaml is not a recipe.
  for (const name of ['vm-c', 'not-a-recipe']) {
    const text = await remote($, name)
    expect(text).toMatch(new RegExp(`Orca has no saved server "${name}"\\. The saved servers: vm-a \\(aa11-x\\), vm-b \\(bb22-y\\)`))
    expect(text).toMatch(/Repair: run \/dev remote <server> with one of them, by name or id/)
    expect(text).toMatch(new RegExp(`\\/primary\\/orca\\.yaml has no environmentRecipes entry with the id ${name}`))
    expect(text).toContain('orca skills get orca-per-workspace-env --reference ssh-host')
    expect(text).toMatch(/New workspace, then Run on, then that recipe/)
  }
  expect(w.saved()).toBeUndefined()
})
