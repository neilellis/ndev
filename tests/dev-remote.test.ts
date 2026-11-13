import { expect, test } from 'claude-code/testing'

// /dev remote saves which of Orca's saved servers this project uses as its remote machine. The setting lives on this
// machine (the server is an entry in this machine's Orca), keyed by the project's GitHub repository.

type On = Parameters<Parameters<typeof test>[1]>[1]
type Engine = Parameters<Parameters<typeof test>[1]>[0]

const ROOT = '/proj'
const STORE = '/home/neil/.config/ndev/remote.json'
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

// A fake engine: the project is acme/widgets at /proj, and Orca's saved servers are `servers` (the test may change
// them). Only the Orca CLI is faked beyond the engine's own file and process calls.
function engine(on: On, servers: { id: string; name: string }[] = [{ id: 'aa11-x', name: 'vm-a' }, { id: 'bb22-y', name: 'vm-b' }]) {
  const files = new Map<string, string>([[`${ROOT}/.neil-dev.json`, JSON.stringify({ github: { repo: 'acme/widgets', board: null } })]])
  const runs: string[][] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__ndev__${e.name}` } }))
  on('clock.now', () => ({ value: 1_800_000_000_000 }))
  on('clock.every', () => new Promise(() => {}))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'remote-session' }))
  on('prompt.compose', () => ({ sections: [] }))
  on('env.get', () => ({ value: '/home/neil' }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) || e.path.startsWith('/home/neil/dev-wiki') }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    const a = [...e.argv]
    runs.push(a)
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

test('create, remove, off and list are subcommands, never server names', async ($, on) => {
  const w = engine(on, [{ id: 'cc33-z', name: 'create' }, { id: 'dd44-w', name: 'list' }])
  await start($)

  for (const word of ['create', 'remove', 'create orca-dev-2', 'remove orca-dev-2']) {
    expect(await remote($, word)).toMatch(/not built yet/)
  }
  expect(w.saved()).toBeUndefined()
  // A server with a reserved name is saved by its id.
  expect(await remote($, 'cc33')).toMatch(/create \(cc33-z\)/)
  expect(await remote($, 'vm-a vm-b')).toMatch(/takes one server/)
})
