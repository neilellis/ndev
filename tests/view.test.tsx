import { expect, test } from './sdk-testing'
import { linked } from '../hooks/view-layout'
import { shownFull, shownValue } from '../hooks/workflow/live'

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
    { path: ROOT, branch: 'main', isMain: true, files: [file('.ndev.json', true), file('.neil-dev.env', true, true), file('.neil-dev.worktree.json', false, true)] },
    { path: WT, branch: 'fix-1', isMain: false, files: [file('.ndev.json', false), file('.neil-dev.env', false, true), file('.neil-dev.worktree.json', true, true), { name: '.neil-dev.local', isKnown: false, present: true, isIgnored: false }] },
  ],
}
const record = {
  version: 2,
  resources: {
    docker: [{ kind: 'supabase', projectId: 'app-1', workdir: WT, cliVersion: '2.122.0', live: true }],
    'dev-servers': {
      docs: { pid: 4821, port: 3000, command: 'node next dev', cwd: `${WT}/apps/docs`, started: '2026-10-30T10:00:00.000Z', live: true },
      ui: { pid: 4822, port: 3001, command: 'pnpm dev', cwd: `${WT}/apps/ui`, started: '2026-10-30T10:00:00.000Z', live: false },
    },
  },
}
const ok = (stdout = '', exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })

// A fake engine. `answers` maps a command line to its result; each run is recorded in `ran`.
function world(on: On, answers: Record<string, ReturnType<typeof ok>> = {}, current = WT, files: Record<string, string> = {}) {
  let now = 1_000_000
  const ran: string[] = []
  const copied: string[] = []
  const opened: string[] = []
  const table: Record<string, ReturnType<typeof ok>> = {
    // As ndev-files.sh does, the listing names each issue file that exists.
    [`${FILES} list --json --repo ${ROOT}`]: ok(JSON.stringify({ worktrees: listing.worktrees.map(t => ({ ...t, files: [...t.files, ...Object.keys(files).filter(k => k.startsWith(`${t.path}/.neil-dev.issue-`)).map(k => ({ name: k.slice(t.path.length + 1), isKnown: false, present: true, isIgnored: true }))] })) })),
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
  on('env.get', () => ({ value: '/home/user' }))
  on('fs.exists', (_, e) => ({ value: e.path.startsWith('/home/user/dev-wiki') || e.path === `${ROOT}/.ndev-inited` || e.path in files || Object.keys(files).some(k => k.startsWith(`${e.path}/`)) }))
  on('fs.list', (_, e) => ({ value: Object.keys(files).filter(k => k.startsWith(`${e.path}/`) && !k.slice(e.path.length + 1).includes('/')).map(k => ({ name: k.slice(e.path.length + 1), kind: 'file', size: 0, isLink: false })) }) as never)
  on('fs.read', (_, e) => ({ value: files[e.path] ?? '' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', (_, e) => { opened.push(e.id); backgrounds.push(e.backgroundColor); return { value: { isPlaced: true } } })
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

test('a worktree that runs a workflow shows its state and its issue', async ($, on) => {
  world(on, {}, WT, { [`${WT}/.neil-dev.worktree.json`]: JSON.stringify({ workflow: { state: 'reviewing', issue: 7, prs: [12] } }) })
  const ui = await start($)
  expect((await ui.find({ type: 'Text', text: /^reviewing, issue #7, PR #12/ }))).toBeTruthy()
})

test('a worktree with several issues shows the state of each', async ($, on) => {
  world(on, {}, WT, { [`${WT}/.neil-dev.worktree.json`]: JSON.stringify({ workflows: { 7: { state: 'reviewing', issue: 7, prs: [12] }, 12: { state: 'planning', issue: 12, prs: [12] } } }) })
  const ui = await start($)
  expect(await ui.find({ type: 'Text', text: /^reviewing, issue #7, PR #12/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^planning, issue #12, PR #12/ })).toBeTruthy()
  await ui.unmount()
})

test('a blocked workflow shows the state it keeps and the message', async ($, on) => {
  world(on, {}, WT, { [`${WT}/.neil-dev.worktree.json`]: JSON.stringify({ workflow: { state: 'blocked', previous: 'ci', issue: 7, prs: [], blocked: { message: 'Which API key?' } } }) })
  const ui = await start($)
  expect((await ui.find({ type: 'Text', text: /^blocked \(was ci\), issue #7: Which API key\?/ }))).toBeTruthy()
})

test('the worktree shows its ndev files as present or missing, and any other .neil-dev* file', async ($, on) => {
  world(on)
  const ui = await start($)
  expect((await ui.find({ type: 'Text', text: /^✔ \.neil-dev\.worktree\.json$/ }))?.text).toBe('✔ .neil-dev.worktree.json')
  expect((await ui.find({ type: 'Text', text: /^✖ \.ndev\.json \(missing\)$/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /\.neil-dev\.local/ }))?.text).toMatch(/\.neil-dev\.local/)
  await ui.unmount()
})

test('resources show their live status: running, stopped, and a docker stack by its containers', async ($, on) => {
  world(on)
  const ui = await start($)
  expect((await ui.find({ type: 'Text', text: /docs/ }))?.text).toMatch(/● docs\s+:3000\s+running/)
  expect((await ui.find({ type: 'Text', text: /ui\s+:3001/ }))?.text).toMatch(/○ ui\s+:3001\s+stopped/)
  expect((await ui.find({ type: 'Text', text: /app-1/ }))?.text).toMatch(/● supabase app-1\s+running/)
  await ui.unmount()
})

test('a docker stack whose state is unknown says so with docker\'s message', async ($, on) => {
  const unknown = { ...record, resources: { ...record.resources, docker: [{ ...record.resources.docker[0], live: null, liveError: 'Cannot connect to the Docker daemon' }] } }
  world(on, { [`${ENV} list --json --live --worktree ${WT}`]: ok(JSON.stringify(unknown)) })
  const ui = await start($)
  expect((await ui.find({ type: 'Text', text: /app-1/ }))?.text).toMatch(/\? supabase app-1\s+unknown: Cannot connect to the Docker daemon/)
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
  await ui.press({ key: `copy:${WT}:.ndev.json` })
  expect(w.ran).toContain(`${FILES} copy --file .ndev.json --worktree ${WT} --repo ${ROOT}`)
  await ui.press({ key: `copy:${WT}:.neil-dev.env` })
  expect(w.ran).toContain(`${FILES} copy --file .neil-dev.env --worktree ${WT} --repo ${ROOT}`)
  await ui.unmount()
})

test('the main checkout offers create where a file is missing, never copy', async ($, on) => {
  const missing = { worktrees: [{ ...listing.worktrees[0], files: [file('.ndev.json', false), file('.neil-dev.env', false, true)] }] }
  const w = world(on, { [`${FILES} list --json --repo ${ROOT}`]: ok(JSON.stringify(missing)) }, ROOT)
  const ui = await start($)
  expect(await ui.find({ type: 'Button', key: `copy:${ROOT}:.ndev.json` })).toBeUndefined()
  await ui.press({ key: `create:${ROOT}:.ndev.json` })
  expect(w.ran).toContain(`${FILES} create --file .ndev.json --worktree ${ROOT} --repo ${ROOT}`)
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
  await ui.press({ key: `stop-keep:${WT}:supabase:app-1` })
  await ui.press({ key: `stop:${WT}:docs` })
  expect(w.ran.some(l => l.includes(' stop '))).toBe(false)
  await ui.unmount()
})

test('a docker stack offers stop keeping data and stop deleting data, each with two presses', async ($, on) => {
  const w = world(on)
  const ui = await start($)
  for (const [which, policy] of [['keep', 'stop-keep-data'], ['delete', 'stop-and-delete']] as const) {
    const key = `stop-${which}:${WT}:supabase:app-1`
    await ui.press({ key })
    await ui.press({ key })
    expect(w.ran).toContain(`${ENV} stop --kind supabase --project-id app-1 --on-end ${policy} --worktree ${WT}`)
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

const SERVICES = { services: { supabase: { url: 'https://supabase.com/dashboard/project/abc' }, vercel: { url: 'https://vercel.com/acme/web' } } }

test('the services of .ndev.json show as links, each with its name', async ($, on) => {
  world(on, {}, WT, { [`${WT}/.ndev.json`]: JSON.stringify(SERVICES) })
  const ui = await start($)
  expect((await ui.find({ type: 'Link', text: 'supabase' }))?.props).toMatchObject({ href: 'https://supabase.com/dashboard/project/abc', label: 'supabase' })
  expect((await ui.find({ type: 'Link', text: 'vercel' }))?.props).toMatchObject({ href: 'https://vercel.com/acme/web', label: 'vercel' })
  await ui.unmount()
})

test('a worktree without .ndev.json shows the services of the main checkout', async ($, on) => {
  world(on, {}, WT, { [`${ROOT}/.ndev.json`]: JSON.stringify(SERVICES) })
  const ui = await start($)
  expect((await ui.find({ type: 'Link', text: 'vercel' }))?.props.href).toBe('https://vercel.com/acme/web')
  await ui.unmount()
})

test('a .ndev.json that cannot be read shows its error and the file, and the pane still lists', async ($, on) => {
  world(on, {}, WT, { [`${WT}/.ndev.json`]: JSON.stringify({ services: { vercel: { url: 'ftp://x' } } }) })
  const ui = await start($)
  expect((await ui.find({ type: 'Text', text: /\.ndev\.json.*services\.vercel\.url/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^✔ \.neil-dev\.worktree\.json$/ }))?.text).toBeDefined()
  await ui.unmount()
})

const backgrounds: unknown[] = []

const flowText = async (ui: Awaited<ReturnType<typeof start>>) =>
  (await ui.findAll({ type: 'Text', text: /^[✔●▲○–] (setup|planning|developing|reviewing|ci|smoke|finishing|done|revising)$/ })).map(t => t.text)

test('the flow chart marks the steps passed, the current step and the steps to come', async ($, on) => {
  const history = [{ at: 1, tool: 'started', to: 'developing' }, { at: 2, tool: 'finishedDevelopment', from: 'developing', to: 'reviewing' }]
  world(on, {}, WT, { [`${WT}/.neil-dev.worktree.json`]: JSON.stringify({ workflow: { state: 'reviewing', issue: 7, prs: [12], history } }) })
  const ui = await start($)
  // Light mode went straight to development, so the plan shows as skipped, not as passed.
  expect(await flowText(ui)).toEqual(['✔ setup', '– planning', '✔ developing', '● reviewing', '○ ci', '○ smoke', '○ finishing', '○ done'])
})

test('a blocked workflow marks the step it stopped at', async ($, on) => {
  world(on, {}, WT, { [`${WT}/.neil-dev.worktree.json`]: JSON.stringify({ workflow: { state: 'blocked', previous: 'ci', issue: 7, prs: [], blocked: { message: 'x' }, history: [{ at: 1, tool: 'started', to: 'planning' }] } }) })
  const ui = await start($)
  expect(await flowText(ui)).toEqual(['✔ setup', '✔ planning', '✔ developing', '✔ reviewing', '▲ ci', '○ smoke', '○ finishing', '○ done'])
})

test('revising shows as a side loop that goes back to ci, and done shows every step passed', async ($, on) => {
  const history = [{ at: 1, tool: 'started', to: 'planning' }, { at: 2, tool: 'x', from: 'ci', to: 'smoke' }]
  world(on, {}, WT, {
    [`${WT}/.neil-dev.worktree.json`]: JSON.stringify({ workflow: { state: 'revising', issue: 7, prs: [12], history } }),
  })
  const ui = await start($)
  expect(await flowText(ui)).toEqual(['✔ setup', '✔ planning', '✔ developing', '✔ reviewing', '○ ci', '○ smoke', '○ finishing', '○ done', '● revising'])
  expect(await ui.find({ type: 'Text', text: /back to ci/ })).toBeTruthy()
})

test('done marks every step passed', async ($, on) => {
  const history = [{ at: 1, tool: 'started', to: 'planning' }, { at: 2, tool: 'x', from: 'ci', to: 'smoke' }]
  world(on, {}, WT, { [`${WT}/.neil-dev.worktree.json`]: JSON.stringify({ workflow: { state: 'done', issue: 7, prs: [12], history } }) })
  const ui = await start($)
  expect(await flowText(ui)).toEqual(['✔ setup', '✔ planning', '✔ developing', '✔ reviewing', '✔ ci', '✔ smoke', '✔ finishing', '✔ done'])
})

test('the pane paints no background of its own', async ($, on) => {
  backgrounds.length = 0
  world(on, {}, WT, {})
  await start($)
  expect(backgrounds).toEqual(['transparent'])
})

test('a present ndev file is a link that opens the file, by its absolute path', async ($, on) => {
  world(on)
  const ui = await start($)
  expect((await ui.find({ type: 'Link', text: '.neil-dev.worktree.json' }))?.props.href).toBe(`file://${WT}/.neil-dev.worktree.json`)
  expect((await ui.find({ type: 'Link', text: '.neil-dev.local' }))?.props.href).toBe(`file://${WT}/.neil-dev.local`)
  await ui.unmount()
})

test('the worktree path is a link that opens the folder', async ($, on) => {
  world(on)
  const ui = await start($)
  expect((await ui.find({ type: 'Link', text: WT }))?.props.href).toBe(`file://${WT}`)
  await ui.unmount()
})

test('the issue and the pull request of a workflow are links to GitHub', async ($, on) => {
  world(on, {}, WT, { [`${WT}/.neil-dev.worktree.json`]: JSON.stringify({ workflow: { state: 'reviewing', issue: 7, repo: 'acme/widgets', prs: [12] } }) })
  const ui = await start($)
  expect((await ui.find({ type: 'Link', text: '#7' }))?.props.href).toBe('https://github.com/acme/widgets/issues/7')
  expect((await ui.find({ type: 'Link', text: '#12' }))?.props.href).toBe('https://github.com/acme/widgets/pull/12')
  await ui.unmount()
})

const RECORD_AT = `${WT}/.neil-dev.worktree.json`
const LIVE = (name: string) => `${WT}/ndev-live-${name}.json`
const waiting = { id: 'waitForPR-1', tool: 'waitForPR', what: 'PR #12 to be mergeable', at: 900_000, period: 300, most: 12, timeoutS: 3600, args: { pr: '12', state: 'mergeable' } }

test('a wait draws its arguments, the check count and what came back for the PR', async ($, on) => {
  const seen = { state: 'open', draft: 'no', mergeable: 'no (blocked)', head: 'a1b2c3d4' }
  world(on, {}, WT, {
    [RECORD_AT]: JSON.stringify({ workflows: { 7: { state: 'wait', previous: 'ci', issue: 7, prs: [12], waiting } } }),
    [LIVE('issue-7')]: JSON.stringify({ at: 1000, wait: { id: 'waitForPR-1', tries: 4, checkedAt: 950_000, nextAt: 1_200_000, seen } }),
  })
  const ui = await start($)
  expect(await ui.find({ type: 'Text', text: /waitForPR {2}PR #12 to be mergeable/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /check 4 of 12 · every 300 s · next in/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /mergeable +no \(blocked\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /head +a1b2c3d4/ })).toBeTruthy()
  await ui.unmount()
})

test('a live file of another wait is not read as this wait', async ($, on) => {
  world(on, {}, WT, {
    [RECORD_AT]: JSON.stringify({ workflows: { 7: { state: 'wait', previous: 'ci', issue: 7, prs: [12], waiting } } }),
    [LIVE('issue-7')]: JSON.stringify({ at: 1000, wait: { id: 'old', tries: 9, checkedAt: 1000, seen: { state: 'closed' } } }),
  })
  const ui = await start($)
  expect(await ui.find({ type: 'Text', text: /no check yet/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /state +closed/ })).toBeUndefined()
  await ui.unmount()
})

test('a wait that stopped reporting says so', async ($, on) => {
  const w = world(on, {}, WT, {
    [RECORD_AT]: JSON.stringify({ workflows: { 7: { state: 'wait', previous: 'ci', issue: 7, prs: [12], waiting } } }),
    [LIVE('issue-7')]: JSON.stringify({ at: 1000, wait: { id: 'waitForPR-1', tries: 1, checkedAt: 1000 } }),
  })
  w.tick(30 * 60_000)
  const ui = await start($)
  expect(await ui.find({ type: 'Text', text: /No report for .*the session may have ended/ })).toBeTruthy()
  await ui.unmount()
})

test('a live file that cannot be parsed shows why, and the pane still draws the record', async ($, on) => {
  world(on, {}, WT, { [RECORD_AT]: JSON.stringify({ workflows: { 7: { state: 'developing', issue: 7, prs: [12] } } }), [LIVE('issue-7')]: '{"at":' })
  const ui = await start($)
  expect(await ui.find({ type: 'Text', text: /^developing, issue #7/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /ndev-live-issue-7\.json could not be read/ })).toBeTruthy()
  await ui.unmount()
})

test('a PR record stands for the issues that it took over, and draws their calls', async ($, on) => {
  const developed = { state: 'developed', prs: [12] }
  world(on, {}, WT, {
    [RECORD_AT]: JSON.stringify({ workflows: { 7: { ...developed, issue: 7 }, 9: { ...developed, issue: 9 } }, prs: { 12: { state: 'reviewing', issue: 7, pr: 12, issues: [7, 9], prs: [12], hooks: { review: { firedAt: 1000, agentId: 'a' } } } } }),
    [LIVE('pr-12')]: JSON.stringify({ at: 1000, calls: [{ tool: 'finishedReview', args: { review: 'no findings', pr: '12' }, at: 1000, outcome: 'running' }] }),
    [LIVE('issue-9')]: JSON.stringify({ at: 900, calls: [{ tool: 'done', args: { issue: '9' }, at: 900, endedAt: 900, outcome: 'refused', note: 'Refused: not valid' }] }),
  })
  const ui = await start($)
  expect(await ui.find({ type: 'Text', text: /^reviewing, PR #12 \(issues #7, #9\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^developed, issue/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /finishedReview/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /review +no findings/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /✖ done .*Refused: not valid/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Review {2}review running/ })).toBeTruthy()
  await ui.unmount()
})

test('an issue that finished development, with no PR record yet, still draws', async ($, on) => {
  world(on, {}, WT, { [RECORD_AT]: JSON.stringify({ workflows: { 7: { state: 'developed', issue: 7, prs: [12] } } }) })
  const ui = await start($)
  expect(await ui.find({ type: 'Text', text: /^developed, issue #7/ })).toBeTruthy()
  await ui.unmount()
})

test('a record that cannot be read names the file, and the resources still draw', async ($, on) => {
  world(on, { [`${ENV} list --json --live --worktree ${WT}`]: ok(JSON.stringify({ resources: { 'dev-servers': { docs: { pid: 1, port: 3000, command: 'c', cwd: '/w', live: true } } } })) }, WT, { [RECORD_AT]: '{' })
  const ui = await start($)
  expect(await ui.find({ type: 'Text', text: /\.neil-dev\.worktree\.json/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /docs +:3000/ })).toBeTruthy()
  await ui.unmount()
})

test('a record with no workflow says so in one line', async ($, on) => {
  world(on, {}, WT, { [RECORD_AT]: JSON.stringify({ version: 2, resources: {} }) })
  const ui = await start($)
  expect(await ui.find({ type: 'Text', text: /^No workflow in this worktree/ })).toBeTruthy()
  await ui.unmount()
})

test('shownValue masks secrets and cuts long text, and leaves plain values alone', () => {
  expect(shownValue('api_key', 'abc')).toBe('•••')
  expect(shownValue('shell_command', 'TOKEN=abc curl -H "Authorization: Bearer xyz" https://u:p@x.io/a?k=v')).toBe('TOKEN=••• curl -H "Authorization: •••" https://•••@x.io/a?•••')
  expect(shownValue('note', 'gh token ghp_abc123 and sk-abc and xoxb-1-2 --password hunter2')).toBe('gh token ••• and ••• and ••• --password •••')
  expect(shownValue('message', `first\nsecond`)).toBe('first')
  expect(shownValue('message', 'x'.repeat(200))).toBe(`${'x'.repeat(120)}…(200 chars)`)
  expect(shownValue('pr', 12)).toBe('12')
  expect(shownValue('waitOn', [7, 9])).toBe('7, 9')
  expect(shownValue('url', 'https://x.io/a')).toBe('https://x.io/a')
})

test('an issue with its own mode and steering shows them', async ($, on) => {
  world(on, {}, WT, { [RECORD_AT]: JSON.stringify({ workflows: { 7: { state: 'developing', issue: 7, prs: [], mode: 'heavy', steering: 'auto' } } }) })
  const ui = await start($)
  expect(await ui.find({ type: 'Text', text: /^For this issue: heavy, auto/ })).toBeTruthy()
  await ui.unmount()
})

test('shownValue masks each form of a secret that a command can hold', () => {
  for (const [value, shown] of [
    ['psql postgres://app:hunter2@db/x', 'psql postgres://•••@db/x'],
    ['curl -u bob:hunter2 https://x.io', 'curl -u ••• https://x.io'],
    ['curl --user=bob:hunter2 https://x.io', 'curl --user=••• https://x.io'],
    ['login password=hunter2 now', 'login password=••• now'],
    ['run api_key=abc123', 'run api_key=•••'],
    ['curl -H "X-Api-Key: abc123" https://x.io', 'curl -H "X-Api-Key: •••" https://x.io'],
    ['curl -H "Authorization: Basic abc123 " https://x.io', 'curl -H "Authorization: •••" https://x.io'],
    ['mysql -u root -phunter2 db', 'mysql -u root -p••• db'],
  ] as const) expect(shownValue('shell_command', value)).toBe(shown)
  expect(shownValue('body', { password: 'hunter2', nested: { token: 'abc' }, list: [{ secret: 'x' }], fine: 1 })).not.toMatch(/hunter2|abc|"x"/)
  expect(shownValue('body', { fine: 1 })).toContain('"fine":1')
  expect(shownValue('list', [{ password: 'hunter2' }])).not.toContain('hunter2')
})

// ---- the issue files, and everything they hold ----
const ISSUE_AT = (n: number) => `${WT}/.neil-dev.issue-${n}.json`
const REPO = 'acme/widgets'
const fullIssue = {
  rev: 6, issue: 7, root: WT, repo: REPO, base: 'main', branch: 'issue-7', prs: [12], shortName: 'fix-the-thing', state: 'developing', mode: 'heavy', steering: 'auto',
  owner: { session: 'sess-abc', at: 990_000 }, lastSession: 'sess-old', releasedAt: 980_000,
  orca: { name: '7-fix-the-thing', status: 'in-progress', comment: 'Working on it', attention: false, issue: 7 },
  evidence: { review: { sha: 'abcdef1234567', text: 'no findings' } },
  attempts: 2, nudges: { count: 3, fingerprint: 'fp-1' },
  followUps: [{ hash: 'h1', mode: 'subagent', issue: 31, title: 'Tidy the parser', worktree: '/proj/.claude/worktrees/w31' }],
  migrations: [{ name: 'add_col', path: 'supabase/migrations/1_add_col.sql' }],
  hooks: { review: { firedAt: 950_000, result: 'See https://example.com/report for #44', agentId: 'agent-9' } },
  reviewCopy: { agentId: 'agent-c', answer: 'copy is fine' },
  changeTypes: ['web', 'tests'], webFiles: ['app/page.tsx'],
  history: [{ at: 900_000, tool: 'started', to: 'planning' }, { at: 940_000, tool: 'finishedPlan', from: 'planning', to: 'developing' }],
  doneWaitsFor: 'feedface', futureThing: { color: 'teal', api_key: 'hunter2' },
}
const issueFiles = (issue: Record<string, unknown>, prs?: Record<string, unknown>) => ({ [ISSUE_AT(issue.issue as number)]: JSON.stringify({ version: 1, issue: issue.issue, workflow: issue, ...(prs ? { prs } : {}) }) })
const hrefOf = async (ui: Awaited<ReturnType<typeof start>>, text: string | RegExp) => (await ui.find({ type: 'Link', text }))?.props.href

test('a worktree with issue files and no worktree file still shows its workflows and its resources', async ($, on) => {
  const onlyIssue = { worktrees: [listing.worktrees[0], { ...listing.worktrees[1], files: [file('.ndev.json', true), file('.neil-dev.worktree.json', false, true), { name: '.neil-dev.issue-7.json', isKnown: false, present: true, isIgnored: true }] }] }
  world(on, { [`${FILES} list --json --repo ${ROOT}`]: ok(JSON.stringify(onlyIssue)) }, WT, issueFiles(fullIssue))
  const ui = await start($)
  expect(await ui.find({ type: 'Text', text: /^developing, issue #7/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /docs +:3000/ })).toBeTruthy()
  await ui.unmount()
})

test('every field of an issue record shows, and each resource in it is one click away', async ($, on) => {
  world(on, {}, WT, issueFiles(fullIssue))
  const ui = await start($)
  expect(await hrefOf(ui, '.neil-dev.issue-7.json')).toBe(`file://${ISSUE_AT(7)}`)
  expect(await hrefOf(ui, REPO)).toBe(`https://github.com/${REPO}`)
  expect(await hrefOf(ui, /^issue-7$/)).toBe(`https://github.com/${REPO}/tree/issue-7`)
  expect(await hrefOf(ui, /^main$/)).toBe(`https://github.com/${REPO}/tree/main`)
  expect(await hrefOf(ui, 'checks #12')).toBe(`https://github.com/${REPO}/pull/12/checks`)
  expect(await hrefOf(ui, 'abcdef12')).toBe(`https://github.com/${REPO}/commit/abcdef1234567`)
  expect(await hrefOf(ui, 'feedface')).toBe(`https://github.com/${REPO}/commit/feedface`)
  expect(await hrefOf(ui, '#31')).toBe(`https://github.com/${REPO}/issues/31`)
  expect(await hrefOf(ui, '/proj/.claude/worktrees/w31')).toBe('file:///proj/.claude/worktrees/w31')
  expect(await hrefOf(ui, 'supabase/migrations/1_add_col.sql')).toBe(`file://${WT}/supabase/migrations/1_add_col.sql`)
  expect(await hrefOf(ui, 'app/page.tsx')).toBe(`file://${WT}/app/page.tsx`)
  for (const shown of [/fix-the-thing/, /rev +6/, /sess-abc/, /sess-old/, /attempts +2/, /nudges +3.*fp-1/, /Working on it/, /no findings/, /agent-9/, /copy is fine/, /web, tests/, /Tidy the parser/, /add_col/, /finishedPlan +planning → developing/, /futureThing/, /teal/]) {
    expect(await ui.find({ type: 'Text', text: shown })).toBeTruthy()
  }
  await ui.unmount()
})

test('a field that the pane does not know still shows, and a secret in a record does not', async ($, on) => {
  world(on, {}, WT, issueFiles(fullIssue))
  const ui = await start($)
  expect(await ui.find({ type: 'Text', text: /hunter2/ })).toBeUndefined()
  await ui.unmount()
})

test('a URL and an issue number in the text of a record are links', async ($, on) => {
  world(on, {}, WT, issueFiles(fullIssue))
  const ui = await start($)
  expect(await hrefOf(ui, 'https://example.com/report')).toBe('https://example.com/report')
  expect(await hrefOf(ui, '#44')).toBe(`https://github.com/${REPO}/issues/44`)
  await ui.unmount()
})

test('the history shows newest first, and a bar shows how far the flow has come', async ($, on) => {
  world(on, {}, WT, issueFiles(fullIssue))
  const ui = await start($)
  const rows = (await ui.findAll({ type: 'Text', text: /ago +(started|finishedPlan) / })).map(t => t.text)
  expect(rows.findIndex(t => t.includes('finishedPlan'))).toBeLessThan(rows.findIndex(t => t.includes('started')))
  const progress = await ui.find({ type: 'Text', text: /^█+░+/ })
  expect(progress?.text).toMatch(/^█+░+ 2\/10 .*developing for 1m 0s/)
  await ui.unmount()
})

test('the worktree file shows its version, its settings, and the lead issue of each PR', async ($, on) => {
  const withLeads = { ...record, settings: { mode: 'heavy', steering: 'auto' }, leads: { 12: 7 } }
  world(on, { [`${ENV} list --json --live --worktree ${WT}`]: ok(JSON.stringify(withLeads)) }, WT, issueFiles({ ...fullIssue, state: 'developed' }, { 12: { rev: 2, issue: 7, pr: 12, issues: [7], root: WT, repo: REPO, prs: [12], state: 'reviewing', base: 'main', branch: 'issue-7', evidence: {}, followUps: [], migrations: [], history: [] } }))
  const ui = await start($)
  expect(await ui.find({ type: 'Text', text: /version +2/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /mode +heavy/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /steering +auto/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /PR #12 +lead issue #7 +\.neil-dev\.issue-7\.json/ })).toBeTruthy()
  // The issue that the PR took over keeps its own section, and the PR says which file holds it.
  expect(await ui.find({ type: 'Text', text: /^── issue #7 .*\.neil-dev\.issue-7\.json/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^── PR #12 .*lead #7 .*\.neil-dev\.issue-7\.json/ })).toBeTruthy()
  await ui.unmount()
})

test('state still in the old keys of the worktree file names that file, and says a save moves it', async ($, on) => {
  world(on, {}, WT, { [RECORD_AT]: JSON.stringify({ workflows: { 7: { state: 'developing', issue: 7, prs: [] } } }) })
  const ui = await start($)
  expect(await ui.find({ type: 'Text', text: /^── issue #7 .*\.neil-dev\.worktree\.json.*the next save moves it/ })).toBeTruthy()
  await ui.unmount()
})

test('a dev server links its port and its folder and shows its pid, and a stack links its folder', async ($, on) => {
  world(on)
  const ui = await start($)
  expect(await hrefOf(ui, ':3000')).toBe('http://localhost:3000')
  expect(await hrefOf(ui, `${WT}/apps/docs`)).toBe(`file://${WT}/apps/docs`)
  expect(await ui.find({ type: 'Text', text: /pid 4821/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /cliVersion +2\.122\.0/ })).toBeTruthy()
  await ui.unmount()
})

test('a blocked workflow is the first thing the pane says', async ($, on) => {
  world(on, {}, WT, issueFiles({ ...fullIssue, state: 'blocked', previous: 'ci', blocked: { message: 'Which API key?', at: 990_000, group: 'g' } }))
  const ui = await start($)
  const all = (await ui.findAll({ type: 'Text', text: /./ })).map(t => t.text)
  expect(all.findIndex(t => /^▲ #7 needs you: Which API key\?/.test(t))).toBeLessThan(all.findIndex(t => t.startsWith('fix-1')))
  await ui.unmount()
})

test('the header counts the workflows and the servers, active rows first', async ($, on) => {
  world(on, {}, WT, { ...issueFiles({ ...fullIssue, state: 'done' }), ...issueFiles({ ...fullIssue, issue: 9, state: 'developing' }) })
  const ui = await start($)
  expect(await ui.find({ type: 'Text', text: /^ndev view .*2 workflows .*1 server up, 1 down/ })).toBeTruthy()
  const flows = (await ui.findAll({ type: 'Text', text: /^(done|developing), issue/ })).map(t => t.text)
  expect(flows[0]).toMatch(/^developing, issue #9/)
  await ui.unmount()
})

test('with no live file, the pane draws what the last save kept on the record', async ($, on) => {
  world(on, {}, WT, issueFiles({ ...fullIssue, live: { at: 1000, calls: [{ tool: 'checkpoint', args: { message: 'saved' }, at: 999_000, outcome: 'running' }] } }))
  const ui = await start($)
  expect(await ui.find({ type: 'Text', text: /message +saved/ })).toBeTruthy()
  await ui.unmount()
})

// ---- the interview, in the same file ----
const ANSWERED = {
  rounds: [{
    title: 'The login page', at: 900_000,
    questions: [
      { id: 'store', header: 'Session store', question: 'Where do sessions live?', options: [{ label: 'Redis' }] },
      { id: 'name', header: 'Cookie name', question: 'What name?', suggested: 'sid' },
    ],
    answers: [
      { id: 'store', selected: ['Redis'], notes: 'see https://example.com/redis', source: 'human' },
      { id: 'name', selected: [], other: 'API_TOKEN=zzz', source: 'recommended' },
    ],
  }],
  commentIds: { issue: 555, pr: 666 }, posted: true, closed: { at: 950_000, asked: true }, startedByFollowUp: { of: 3, at: 800_000 },
  draft: { later: { selected: ['Yes'], other: '', notes: '', touched: true } },
}
test('the interview in an issue file shows each question and answer, with links, and no secret', async ($, on) => {
  const file = JSON.parse(issueFiles(fullIssue)[ISSUE_AT(7)]!)
  world(on, {}, WT, { [ISSUE_AT(7)]: JSON.stringify({ ...file, ...ANSWERED }) })
  const ui = await start($)
  expect(await ui.find({ type: 'Text', text: /interview of #7/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /The login page/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Where do sessions live\?/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Redis/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /recommended/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /1 draft answer/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /zzz/ })).toBeUndefined()
  expect(await hrefOf(ui, 'https://example.com/redis')).toBe('https://example.com/redis')
  expect(await hrefOf(ui, 'comment on #7')).toBe(`https://github.com/${REPO}/issues/7#issuecomment-555`)
  expect(await hrefOf(ui, 'comment on PR #12')).toBe(`https://github.com/${REPO}/pull/12#issuecomment-666`)
  await ui.unmount()
})

test('an issue file with only answers shows them, with no workflow', async ($, on) => {
  world(on, {}, WT, { [ISSUE_AT(3)]: JSON.stringify({ version: 1, issue: 3, ...ANSWERED }) })
  const ui = await start($)
  expect(await ui.find({ type: 'Text', text: /interview of #3/ })).toBeTruthy()
  expect(await hrefOf(ui, '.neil-dev.issue-3.json')).toBe(`file://${ISSUE_AT(3)}`)
  await ui.unmount()
})

test('answers that the pane cannot draw cost their own rows, and the record still shows', async ($, on) => {
  const file = JSON.parse(issueFiles(fullIssue)[ISSUE_AT(7)]!)
  world(on, {}, WT, { [ISSUE_AT(7)]: JSON.stringify({ ...file, rounds: 'nonsense' }) })
  const ui = await start($)
  expect(await ui.find({ type: 'Text', text: /\.neil-dev\.issue-7\.json could not be drawn/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /fix-the-thing/ })).toBeTruthy()
  await ui.unmount()
})

test('an issue file with a key that nothing owns is refused as the script refuses it', async ($, on) => {
  world(on, {}, WT, { [ISSUE_AT(7)]: JSON.stringify({ version: 1, issue: 7, mystery: 1 }) })
  const ui = await start($)
  expect(await ui.find({ type: 'Text', text: /\.neil-dev\.issue-7\.json.*mystery.*Repair/ })).toBeTruthy()
  await ui.unmount()
})

test('an answers row with a text that is not a text costs only its own rows', async ($, on) => {
  const file = JSON.parse(issueFiles(fullIssue)[ISSUE_AT(7)]!)
  const rounds = [{ questions: [{ id: 'q', header: 5, question: 'Why?' }], answers: [], at: 1 }]
  world(on, {}, WT, { [ISSUE_AT(7)]: JSON.stringify({ ...file, rounds }) })
  const ui = await start($)
  expect(await ui.find({ type: 'Text', text: /interview of #7/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /fix-the-thing/ })).toBeTruthy()
  await ui.unmount()
})

test('a bad issue file costs only its own rows: it says why, and the other issues still show', async ($, on) => {
  world(on, {}, WT, { ...issueFiles(fullIssue), [ISSUE_AT(9)]: JSON.stringify({ version: 1, issue: 9, mystery: 1 }) })
  const ui = await start($)
  expect(await ui.find({ type: 'Text', text: /\.neil-dev\.issue-9\.json.*mystery.*Repair/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /fix-the-thing/ })).toBeTruthy()
  await ui.unmount()
})

test('the pane shows a multi-select, an untouched draft, and an answer whose question has gone', async ($, on) => {
  const round = { title: 'R', at: 1, questions: [{ id: 'many', header: 'Pick', question: 'Which?', multiSelect: true, options: [{ label: 'A' }] }], answers: [{ id: 'gone', selected: ['Orphan answer'], source: 'human' }] }
  world(on, {}, WT, { [ISSUE_AT(3)]: JSON.stringify({ version: 1, issue: 3, rounds: [round], draft: { later: { selected: ['Yes'], other: '', notes: '', touched: false } } }) })
  const ui = await start($)
  expect(await ui.find({ type: 'Text', text: /multi-select/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /not touched/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /gone/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Orphan answer/ })).toBeTruthy()
  await ui.unmount()
})

test('a handed-over file links its PR comment from the number it holds', async ($, on) => {
  world(on, {}, WT, { ...issueFiles(fullIssue), [ISSUE_AT(3)]: JSON.stringify({ version: 1, issue: 3, rounds: [], commentIds: { pr: 666, prNumber: 40 } }) })
  const ui = await start($)
  expect(await hrefOf(ui, 'comment on PR #40')).toBe(`https://github.com/${REPO}/pull/40#issuecomment-666`)
  await ui.unmount()
})

// ---- what the review found ----
const SECRET_TEXT = 'curl -H "Authorization: Bearer abc" API_TOKEN=zzz ghp_x1'
test('a secret in any field of a record stays off the screen', async ($, on) => {
  world(on, {}, WT, issueFiles({
    ...fullIssue, state: 'blocked', previous: 'ci',
    blocked: { message: SECRET_TEXT, at: 990_000 }, typesUnread: SECRET_TEXT, liveUnread: SECRET_TEXT, doneMessage: SECRET_TEXT,
    nudges: { count: 1, fingerprint: SECRET_TEXT }, orca: { name: SECRET_TEXT, status: SECRET_TEXT, comment: SECRET_TEXT, attention: false, issue: 7 },
  }))
  const ui = await start($)
  for (const secret of [/Bearer abc/, /zzz/, /ghp_x1/]) expect(await ui.find({ type: 'Text', text: secret })).toBeUndefined()
  await ui.unmount()
})

test('a failed stop shows all that it recorded, with no secret', async ($, on) => {
  const failed = { at: '2026-01-01T00:00:00.000Z', command: `kill ${SECRET_TEXT}`, exitCode: 3, output: `boom ${SECRET_TEXT}`, repair: 'kill -9 4821' }
  const withStop = { ...record, resources: { ...record.resources, 'dev-servers': { docs: { ...record.resources['dev-servers'].docs, lastStop: failed } } } }
  world(on, { [`${ENV} list --json --live --worktree ${WT}`]: ok(JSON.stringify(withStop)) })
  const ui = await start($)
  expect(await ui.find({ type: 'Text', text: /The last stop failed: boom/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /exit 3/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /repair +kill -9 4821/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /2026-01-01/ })).toBeTruthy()
  for (const secret of [/Bearer abc/, /zzz/, /ghp_x1/]) expect(await ui.find({ type: 'Text', text: secret })).toBeUndefined()
  await ui.unmount()
})

for (const [what, bad] of [
  ['a history row with no tool', { history: [{ at: 1 }] }],
  ['evidence with no sha', { evidence: { checks: { text: 'x' } } }],
  ['a migration that is a string', { migrations: ['001.sql'] }],
  ['a web file that is a number', { webFiles: [1] }],
  ['issues that is a number', { issues: 5 }],
  ['prs that is a string', { prs: 'abc' }],
  ['a path that cannot be encoded', { webFiles: ['a\ud800b.ts'] }],
] as [string, Record<string, unknown>][]) {
  test(`${what}: the pane still draws, with its stop buttons, and names the file`, async ($, on) => {
    world(on, {}, WT, { ...issueFiles({ ...fullIssue, ...bad }), ...issueFiles({ ...fullIssue, issue: 9 }) })
    const ui = await start($)
    expect(await ui.find({ type: 'Button', key: `stop:${WT}:docs` })).toBeTruthy()
    expect(await ui.find({ type: 'Link', text: '.neil-dev.issue-9.json' })).toBeTruthy()
    await ui.unmount()
  })
}

test('a record the pane cannot draw says so in red, names the file, and shows the raw record', async ($, on) => {
  world(on, {}, WT, issueFiles({ ...fullIssue, history: [{ at: 1 }] }))
  const ui = await start($)
  expect(await ui.find({ type: 'Text', text: /\.neil-dev\.issue-7\.json could not be drawn: .*Repair/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /"shortName":"fix-the-thing"/ })).toBeTruthy()
  await ui.unmount()
})

for (const [what, content, said] of [
  ['an unknown version', JSON.stringify({ version: 2, issue: 7, workflow: { issue: 7, state: 'ci', prs: [] } }), /version/],
  ['the state of another issue', JSON.stringify({ version: 1, issue: 7, workflow: { issue: 9, state: 'ci', prs: [] } }), /workflow.*issue/],
  ['the wrong issue number', JSON.stringify({ version: 1, issue: 9, workflow: { issue: 9, state: 'ci', prs: [] } }), /issue/],
  ['a PR under the wrong key', JSON.stringify({ version: 1, issue: 7, prs: { 12: { pr: 13, issue: 7 } } }), /prs\.12/],
] as [string, string, RegExp][]) {
  test(`an issue file with ${what} is refused where the script would refuse it, and names the file`, async ($, on) => {
    world(on, {}, WT, { [ISSUE_AT(7)]: content })
    const ui = await start($)
    expect(await ui.find({ type: 'Text', text: /\.neil-dev\.issue-7\.json.*Repair/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: said })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: `stop:${WT}:docs` })).toBeTruthy()
    await ui.unmount()
  })
}

test('a URL with a fragment keeps its link; one with a masked query links to its page, with no query in the address', async ($, on) => {
  world(on, {}, WT, issueFiles({ ...fullIssue, doneMessage: 'See https://github.com/o/r/pull/12#issuecomment-99 and https://x.io/a?token=abc&k=v' }))
  const ui = await start($)
  expect(await hrefOf(ui, 'https://github.com/o/r/pull/12#issuecomment-99')).toBe('https://github.com/o/r/pull/12#issuecomment-99')
  expect(await hrefOf(ui, /^https:\/\/x\.io\/a/)).toBe('https://x.io/a')
  await ui.unmount()
})

test('a path in a sibling worktree does not link to this worktree', () => {
  const links = (text: string) => linked(text, { root: '/tmp/wt' }).filter(seg => seg.href).map(seg => seg.href)
  expect(links('see /tmp/wt-other/x and /tmp/wt.old/y')).toEqual([])
  expect(links('see /tmp/wt/x, then /tmp/wt.')).toEqual(['file:///tmp/wt/x', 'file:///tmp/wt'])
})

test('shownFull masks a secret and keeps the whole text', () => {
  expect(shownFull('note', `curl -u bob:hunter2 ${'x'.repeat(200)}`)).toBe(`curl -u ••• ${'x'.repeat(200)}`)
  expect(shownFull('api_key', 'abc')).toBe('•••')
  expect(shownFull('note', 'one\ntwo')).toBe('one two')
})

test('shownValue leaves plain commands alone', () => {
  for (const value of ['git push -u origin main', 'mkdir -p/tmp/a', 'sort -u a.txt', 'pytest -pno:cacheprovider', 'see the monkey: it is fine']) expect(shownValue('shell_command', value)).toBe(value)
})
