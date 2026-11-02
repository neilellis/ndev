import { expect, test } from 'claude-code/testing'

type Body = Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>
type On = Parameters<Body>[1]

const ROOT = '/proj'
const WT = '/proj/.claude/worktrees/fix-1'
const PLUGIN = '/plugin'
const FILES = `bash ${PLUGIN}/scripts/work/ndev-files.sh`
const ENV = `bash ${PLUGIN}/scripts/work/worktree-env.sh`

const PANE = {
  plugin: 'ndev',
  component: 'Pane',
  requestId: 'view',
  props: { title: 'ndev view', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const open = { command: 'view', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const

const file = (name: string, present: boolean, isIgnored = false) => ({ name, isKnown: true, present, isIgnored })
const listing = {
  worktrees: [
    { path: ROOT, branch: 'main', isMain: true, files: [file('.neil-dev.json', true), file('.neil-dev.env', true, true), file('.neil-dev.worktree.json', false, true)] },
    { path: WT, branch: 'fix-1', isMain: false, files: [file('.neil-dev.json', false), file('.neil-dev.env', false, true), file('.neil-dev.worktree.json', true, true), { name: '.neil-dev.local', isKnown: false, present: true, isIgnored: false }] },
  ],
}
const record = {
  version: 2,
  resources: {
    docker: [{ kind: 'supabase', projectId: 'fcc-1', workdir: WT, cliVersion: '2.122.0', live: true }],
    'dev-servers': {
      docs: { pid: 4821, port: 3000, command: 'node next dev', cwd: `${WT}/apps/docs`, started: '2026-10-30T10:00:00.000Z', live: true },
      ui: { pid: 4822, port: 3001, command: 'pnpm dev', cwd: `${WT}/apps/ui`, started: '2026-10-30T10:00:00.000Z', live: false },
    },
  },
}
const ok = (stdout = '', exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })

// A fake engine. `answers` maps a command line to its result; each run is recorded in `ran`.
function world(on: On, answers: Record<string, ReturnType<typeof ok>> = {}, current = WT) {
  let now = 1_000_000
  const ran: string[] = []
  const copied: string[] = []
  const opened: string[] = []
  const table: Record<string, ReturnType<typeof ok>> = {
    [`${FILES} list --json --repo ${ROOT}`]: ok(JSON.stringify(listing)),
    [`${ENV} list --json --live --worktree ${WT}`]: ok(JSON.stringify(record)),
    ...answers,
  }
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', () => ({ value: { tool: 'mcp__ndev__report' } }))
  on('clock.now', () => ({ value: now }))
  on('clock.every', () => new Promise(() => {}))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('prompt.compose', () => ({ sections: [] }))
  on('prompt.submit', (_, e) => e)
  on('env.get', () => ({ value: '/home/neil' }))
  on('fs.exists', (_, e) => ({ value: e.path.startsWith('/home/neil/dev-wiki') || e.path === `${ROOT}/.ndev-inited` }))
  on('fs.read', () => ({ value: '' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', (_, e) => { opened.push(e.id); return { value: { isPlaced: true } } })
  on('ui.copy', (_, e) => { copied.push(e.text); return { value: { isCopied: true } } })
  on('process.run', (_, e) => {
    // The plugin's own folder differs per run: name the scripts as PLUGIN/scripts/... .
    const argv = e.argv.map((a, i) => (i === 1 && a.includes('/scripts/work/') ? `${PLUGIN}${a.slice(a.indexOf('/scripts/work/'))}` : a))
    const line = argv.join(' ')
    if (argv[0] === 'git' && argv[1] === 'rev-parse') return ok(`${current}\n`)
    ran.push(line)
    return table[line] ?? ok('', 0, '')
  })
  return { ran, copied, opened, tick: (ms: number) => { now += ms } }
}

const start = async ($: Parameters<Body>[0]) => {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: false })
  await $.command.run(open)
  return $.ui.mount({ ...PANE, surface: 'terminal' })
}

test('/view opens the pane for the current worktree only: its branch and path, not the others', async ($, on) => {
  const w = world(on)
  const ui = await start($)
  expect(w.opened).toContain('view')
  expect((await ui.find({ type: 'Text', text: /fix-1/ }))?.text).toMatch(/^fix-1\s+\/proj\/\.claude\/worktrees\/fix-1$/)
  expect(await ui.find({ type: 'Text', text: /main checkout/ })).toBeUndefined()
  expect(w.ran.some(l => !l.includes(' init ') && /--worktree \/proj( |$)/.test(l))).toBe(false)
  await ui.unmount()
})

test('the worktree shows its ndev files as present or missing, and any other .neil-dev* file', async ($, on) => {
  world(on)
  const ui = await start($)
  expect((await ui.find({ type: 'Text', text: /^✔ \.neil-dev\.worktree\.json$/ }))?.text).toBe('✔ .neil-dev.worktree.json')
  expect((await ui.find({ type: 'Text', text: /^✖ \.neil-dev\.json \(missing\)$/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /\.neil-dev\.local/ }))?.text).toMatch(/\.neil-dev\.local/)
  await ui.unmount()
})

test('resources show their live status: running, stopped, and a docker stack by its containers', async ($, on) => {
  world(on)
  const ui = await start($)
  expect((await ui.find({ type: 'Text', text: /docs/ }))?.text).toMatch(/● docs\s+:3000\s+running/)
  expect((await ui.find({ type: 'Text', text: /ui\s+:3001/ }))?.text).toMatch(/○ ui\s+:3001\s+stopped/)
  expect((await ui.find({ type: 'Text', text: /fcc-1/ }))?.text).toMatch(/● supabase fcc-1\s+running/)
  await ui.unmount()
})

test('a docker stack whose state is unknown says so with docker\'s message', async ($, on) => {
  const unknown = { ...record, resources: { ...record.resources, docker: [{ ...record.resources.docker[0], live: null, liveError: 'Cannot connect to the Docker daemon' }] } }
  world(on, { [`${ENV} list --json --live --worktree ${WT}`]: ok(JSON.stringify(unknown)) })
  const ui = await start($)
  expect((await ui.find({ type: 'Text', text: /fcc-1/ }))?.text).toMatch(/\? supabase fcc-1\s+unknown: Cannot connect to the Docker daemon/)
  await ui.unmount()
})

test('a worktree record that cannot be read shows the error and the repair, and its files still list', async ($, on) => {
  world(on, { [`${ENV} list --json --live --worktree ${WT}`]: ok('', 2, 'worktree-env: version 1 file. Repair: worktree-env.sh migrate --worktree /w') })
  const ui = await start($)
  expect((await ui.find({ type: 'Text', text: /could not be read/ }))?.text).toMatch(/exit code 2.*version 1 file.*migrate/)
  expect((await ui.find({ type: 'Text', text: /^✔ \.neil-dev\.worktree\.json$/ }))?.text).toBeDefined()
  await ui.unmount()
})

test('a failed list of the worktrees shows the error, with the command that failed', async ($, on) => {
  world(on, { [`${FILES} list --json --repo ${ROOT}`]: ok('', 2, 'ndev-files: /proj is not in a git repository') })
  const ui = await start($)
  expect((await ui.find({ type: 'Text', text: /not in a git repository/ }))?.text).toMatch(/exit code 2/)
  await ui.unmount()
})

test('a linked worktree copies a missing file from the main checkout when the main one has it', async ($, on) => {
  const w = world(on)
  const ui = await start($)
  await ui.press({ key: `copy:${WT}:.neil-dev.json` })
  expect(w.ran).toContain(`${FILES} copy --file .neil-dev.json --worktree ${WT} --repo ${ROOT}`)
  await ui.press({ key: `copy:${WT}:.neil-dev.env` })
  expect(w.ran).toContain(`${FILES} copy --file .neil-dev.env --worktree ${WT} --repo ${ROOT}`)
  await ui.unmount()
})

test('the main checkout offers create where a file is missing, never copy', async ($, on) => {
  const missing = { worktrees: [{ ...listing.worktrees[0], files: [file('.neil-dev.json', false), file('.neil-dev.env', false, true)] }] }
  const w = world(on, { [`${FILES} list --json --repo ${ROOT}`]: ok(JSON.stringify(missing)) }, ROOT)
  const ui = await start($)
  expect(await ui.find({ type: 'Button', key: `copy:${ROOT}:.neil-dev.json` })).toBeUndefined()
  await ui.press({ key: `create:${ROOT}:.neil-dev.json` })
  expect(w.ran).toContain(`${FILES} create --file .neil-dev.json --worktree ${ROOT} --repo ${ROOT}`)
  await ui.unmount()
})

test('a failed create shows the failure with its exit code and the script\'s own message', async ($, on) => {
  world(on, { [`${FILES} create --file .neil-dev.env --worktree ${WT} --repo ${ROOT}`]: ok('', 3, 'ndev-files: .neil-dev.env is not git-ignored in /w. Repair: add the line') })
  const ui = await start($)
  await ui.press({ key: `create:${WT}:.neil-dev.env` })
  expect((await ui.find({ type: 'Text', text: /not git-ignored/ }))?.text).toMatch(/exit code 3.*Repair: add the line/)
  await ui.unmount()
})

test('stopping a dev server takes two presses: the first only arms the button', async ($, on) => {
  const w = world(on)
  const ui = await start($)
  const key = `stop:${WT}:docs`
  await ui.press({ key })
  expect(w.ran.some(l => l.includes(' stop '))).toBe(false)
  expect((await ui.find({ type: 'Button', key }))?.text).toMatch(/Press again/)
  await ui.press({ key })
  expect(w.ran).toContain(`${ENV} stop --name docs --worktree ${WT}`)
  await ui.unmount()
})

test('an armed stop lapses after 5 seconds: the next press arms again and runs nothing', async ($, on) => {
  const w = world(on)
  const ui = await start($)
  const key = `stop:${WT}:docs`
  await ui.press({ key })
  w.tick(6000)
  await ui.press({ key })
  expect(w.ran.some(l => l.includes(' stop '))).toBe(false)
  await ui.unmount()
})

test('pressing another stop disarms the first', async ($, on) => {
  const w = world(on)
  const ui = await start($)
  await ui.press({ key: `stop:${WT}:docs` })
  await ui.press({ key: `stop-keep:${WT}:supabase:fcc-1` })
  await ui.press({ key: `stop:${WT}:docs` })
  expect(w.ran.some(l => l.includes(' stop '))).toBe(false)
  await ui.unmount()
})

test('a docker stack offers stop keeping data and stop deleting data, each with two presses', async ($, on) => {
  const w = world(on)
  const ui = await start($)
  for (const [which, policy] of [['keep', 'stop-keep-data'], ['delete', 'stop-and-delete']] as const) {
    const key = `stop-${which}:${WT}:supabase:fcc-1`
    await ui.press({ key })
    await ui.press({ key })
    expect(w.ran).toContain(`${ENV} stop --kind supabase --project-id fcc-1 --on-end ${policy} --worktree ${WT}`)
  }
  await ui.unmount()
})

test('stop all in a worktree offers keep data and delete data, each with two presses', async ($, on) => {
  const w = world(on)
  const ui = await start($)
  for (const [which, policy] of [['keep', 'stop-keep-data'], ['delete', 'stop-and-delete']] as const) {
    const key = `stop-all-${which}:${WT}`
    await ui.press({ key })
    expect(w.ran.some(l => l.includes('stop-all'))).toBe(which === 'delete')
    await ui.press({ key })
    expect(w.ran).toContain(`${ENV} stop-all --on-end ${policy} --worktree ${WT}`)
  }
  await ui.unmount()
})

test('a failed stop shows the exit code and the script\'s message, naming the repair', async ($, on) => {
  world(on, { [`${ENV} stop --name docs --worktree ${WT}`]: ok('', 1, 'dev server docs did not stop. Repair: run worktree-env.sh stop-all') })
  const ui = await start($)
  await ui.press({ key: `stop:${WT}:docs` })
  await ui.press({ key: `stop:${WT}:docs` })
  expect((await ui.find({ type: 'Text', text: /did not stop/ }))?.text).toMatch(/exit code 1.*Repair: run worktree-env\.sh stop-all/)
  await ui.unmount()
})

test('a dev server opens at its localhost port, and its port and command can be copied', async ($, on) => {
  const w = world(on)
  const ui = await start($)
  await ui.press({ key: `open:${WT}:docs` })
  expect(w.ran).toContain('open http://localhost:3000')
  await ui.press({ key: `copy-port:${WT}:docs` })
  await ui.press({ key: `copy-command:${WT}:docs` })
  expect(w.copied).toEqual(['3000', 'node next dev'])
  await ui.unmount()
})

test('a stopped dev server cannot be opened or stopped, but its port and command can be copied', async ($, on) => {
  world(on)
  const ui = await start($)
  expect(await ui.find({ type: 'Button', key: `open:${WT}:ui` })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: `stop:${WT}:ui` })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: `copy-port:${WT}:ui` })).toBeDefined()
  await ui.unmount()
})

test('a worktree with a problem shows it with the repair and no files', async ($, on) => {
  const stale = { worktrees: [listing.worktrees[0], { ...listing.worktrees[1], files: [], problem: 'ndev-files: the worktree folder /gone does not exist. Repair: git -C /proj worktree prune' }] }
  world(on, { [`${FILES} list --json --repo ${ROOT}`]: ok(JSON.stringify(stale)) })
  const ui = await start($)
  expect((await ui.find({ type: 'Text', text: /does not exist/ }))?.text).toMatch(/Repair: git -C \/proj worktree prune/)
  expect(await ui.find({ type: 'Text', text: /^✔ / })).toBeUndefined()
  await ui.unmount()
})

test('/view creates a missing worktree record first, before it lists the files', async ($, on) => {
  const w = world(on)
  const ui = await start($)
  const init = w.ran.indexOf(`${ENV} init --worktree ${ROOT}`)
  expect(init).toBeGreaterThanOrEqual(0)
  expect(init).toBeLessThan(w.ran.indexOf(`${FILES} list --json --repo ${ROOT}`))
  await ui.unmount()
})

test('/view that cannot create the record shows the script\'s own message and its repair, and still lists', async ($, on) => {
  world(on, { [`${ENV} init --worktree ${ROOT}`]: ok('', 3, 'worktree-env: /proj is not git-ignored. Repair: add the line `.neil-dev.worktree.json` to .gitignore') })
  const ui = await start($)
  const text = (await ui.find({ type: 'Text', text: /Repair: add the line/ }))?.text ?? ''
  expect(text).toContain('exit code 3')
  expect(text).toContain('.gitignore')
  expect((await ui.find({ type: 'Text', text: /fix-1/ }))?.text).toMatch(/fix-1/)
  await ui.unmount()
})
