import { expect, test } from './sdk-testing'
import type { On } from 'claude-code'

import type { RcProgress } from '../types'

const PANE = {
  plugin: 'ndev',
  component: 'Pane',
  requestId: 'responsive-check',
  props: {
    title: 'Responsive matrix',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const POINTER = '/home/n/.cache/ndev/responsive-check/latest.json'
const PROGRESS = '/site/.responsive-check/progress.json'
const REPORT = '/site/.responsive-check/report.json'
const NOW = 1_800_000_000_000

const viewports = [
  { name: 'iPhone SE', short: 'SE', width: 320, height: 568, engine: 'webkit' },
  { name: 'Desktop', short: 'Desktop', width: 1920, height: 1080, engine: 'chromium' },
]
const cell = (route: string, viewport: string, scheme: 'light' | 'dark', status: RcProgress['cells'][number]['status'], errors = 0) =>
  ({ route, viewport, scheme, status, errors, warnings: 0 })

const running = (startedAt = NOW): RcProgress => ({
  state: 'running', startedAt, updatedAt: startedAt + 5000, base: 'http://localhost:3000', out: '/site/.responsive-check',
  routes: ['/', '/about'], viewports, schemes: ['light', 'dark'],
  cells: [
    cell('/', 'iPhone SE', 'light', 'ok'), cell('/', 'iPhone SE', 'dark', 'error', 2),
    cell('/', 'Desktop', 'light', 'warn'), cell('/', 'Desktop', 'dark', 'running'),
    cell('/about', 'iPhone SE', 'light', 'pending'), cell('/about', 'iPhone SE', 'dark', 'pending'),
    cell('/about', 'Desktop', 'light', 'pending'), cell('/about', 'Desktop', 'dark', 'pending'),
  ],
})

const done = (): RcProgress => ({
  ...running(), state: 'done', report: REPORT,
  cells: running().cells.map(c => (c.status === 'pending' || c.status === 'running' ? { ...c, status: 'ok' } : c)),
})

const report = {
  cells: [
    { findings: [{ check: 'contrast', severity: 'error', selector: '.faint', detail: 'contrast 1.21:1, under 4.5:1' }] },
    { findings: [{ check: 'contrast', severity: 'error', selector: '.faint', detail: 'contrast 1.21:1, under 4.5:1' }, { check: 'target-size', severity: 'warning', selector: '#menu', detail: '30x30px touch target' }] },
  ],
}

// The files on disk: the pointer, the progress file and the report. Unset is missing.
function world(on: On, files: { progress?: RcProgress; report?: unknown; isPointerBroken?: boolean }, onCall: () => void = () => {}) {
  const opened: string[] = []
  const ran: string[][] = []
  on('env.get', () => ({ value: '/home/n' }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => new Promise(() => {}))
  on('fs.exists', (_, e) => ({ value: e.path === POINTER && files.progress !== undefined }))
  on('fs.read', (_, e) => {
    if (e.path === POINTER) return { value: files.isPointerBroken ? '{not json' : JSON.stringify({ progress: PROGRESS }) }
    if (e.path === PROGRESS && files.progress) return { value: JSON.stringify(files.progress) }
    if (e.path === REPORT && files.report) return { value: JSON.stringify(files.report) }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('command.register', () => ({ value: { command: 'responsive-matrix' } }))
  on('ui.open', (_, e) => { opened.push(e.id); return { value: { isPlaced: true } } })
  on('process.run', (_, e) => { ran.push([...e.argv]); return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } })
  on('tool.call', () => { onCall(); return { result: { stdout: 'ran' } } })
  return { opened, ran }
}

const open = { command: 'responsive-matrix', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

test('with no run yet the pane says how to start one', async ($, on) => {
  world(on, {})
  const r = await $.command.run(open)
  expect(r.text).toMatch(/No run yet/)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /No run yet/ }))?.text).toMatch(/responsive-check\.mjs/)
  await ui.unmount()
})

test('a running check shows progress, the matrix row by row, and the cell being checked', async ($, on) => {
  world(on, { progress: running() })
  await $.command.run(open)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /checking 3\/8/ }))?.text).toMatch(/^[◐◓◑◒] checking 3\/8$/)
  expect((await ui.find({ type: 'Text', text: /2 routes × 2 viewports/ }))?.text).toMatch(/☀ ☾/)
  expect((await ui.find({ type: 'Text', text: /pass/ }))?.text).toMatch(/● 1 pass\s+▲ 1 warn\s+✖ 1 fail\s+· 5 to go/)
  expect((await ui.find({ type: 'Text', text: /%$/ }))?.text).toMatch(/ {2}38%$/)
  // One row per viewport: its width, its engine, then light and dark for each route.
  expect((await ui.find({ type: 'Text', text: /^iPhone SE/ }))?.text).toMatch(/^iPhone SE\s+320 WebKit\s+●\s+✖2\s+·\s+·/)
  expect((await ui.find({ type: 'Text', text: /^Desktop/ }))?.text).toMatch(/^Desktop\s+1920 Chromium\s+▲\s+[◐◓◑◒]\s+·\s+·/)
  expect((await ui.find({ type: 'Text', text: /· Desktop · ☾ dark/ }))?.text).toMatch(/^[◐◓◑◒] \/ · Desktop · ☾ dark$/)
  await ui.unmount()
})

test('a finished run shows its verdict and its top findings grouped across cells', async ($, on) => {
  const { ran } = world(on, { progress: done(), report })
  await $.command.run(open)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /problems found/ }))?.text).toBe('✖ problems found')
  expect((await ui.find({ type: 'Text', text: /\.faint/ }))?.text).toMatch(/^✖ contrast\s+\.faint ×2 cells$/)
  expect((await ui.find({ type: 'Text', text: /#menu/ }))?.text).toMatch(/^▲ target-size\s+#menu ×1 cell$/)
  await ui.press({ key: 'open' })
  expect(ran).toContainEqual(['open', '/site/.responsive-check'])
  await ui.unmount()
})

test('an unreadable pointer shows the error and how to repair it', async ($, on) => {
  world(on, { progress: running(), isPointerBroken: true })
  await $.command.run(open)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Cannot read the newest run/ }))?.text).toMatch(/Run the check again/)
  await ui.unmount()
})

test('a Bash call that runs the checker opens the pane and skips the older run', async ($, on) => {
  const files: { progress?: RcProgress; report?: unknown } = { progress: done(), report }
  // The run on disk is older than the call, so the pane waits; the call ends with a fresh run.
  files.progress = { ...done(), startedAt: NOW - 60_000 }
  const { opened } = world(on, files, () => { files.progress = { ...done(), startedAt: NOW + 10 } })
  await $.tool.call({ tool: 'Bash', command: 'node skills/responsive-check/scripts/responsive-check.mjs --base http://localhost:3000 /' })
  expect(opened).toEqual(['responsive-check'])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /problems found/ }))?.text).toBe('✖ problems found')
  await ui.unmount()
})

test('a runner that exits before it writes progress says so', async ($, on) => {
  world(on, {})
  await $.tool.call({ tool: 'Bash', command: 'node responsive-check.mjs /' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /exited before/ }))?.text).toMatch(/exit 2 names the fix/)
  await ui.unmount()
})

test('another Bash call leaves the pane closed', async ($, on) => {
  const { opened } = world(on, { progress: done(), report })
  await $.tool.call({ tool: 'Bash', command: 'ls skills/responsive-check' })
  expect(opened).toEqual([])
})

test('a run older than the call is never shown as its result', async ($, on) => {
  world(on, { progress: { ...done(), startedAt: NOW - 60_000 }, report })
  await $.tool.call({ tool: 'Bash', command: 'node responsive-check.mjs --base http://localhost:3000 /' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /problems found/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /exited before/ }))?.text).toMatch(/exit 2 names the fix/)
  await ui.unmount()
})
