import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { publishPanel, runPane } from '../scripts/ndev/panes.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const writeJson = (file, data) => writeFile(file, JSON.stringify(data))
const model = title => ({ title, sections: [{ title: 'Current', rows: [{ label: 'Step', value: title }] }] })

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'ndev-panes-'))
  t.after(() => rm(temp, { force: true, recursive: true }))
  const home = join(temp, 'home')
  const cwd = join(temp, 'checkout')
  await mkdir(home)
  await mkdir(cwd)
  git(cwd, 'init', '-q', '-b', 'main')
  git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'Start')
  return { cwd, home, env: { ...process.env, HOME: home } }
}

test('pane snapshots are versioned, stable on refresh and scoped to the Git worktree', async t => {
  const options = await fixture(t)
  const other = join(options.home, 'linked')
  git(options.cwd, 'worktree', 'add', '-q', '-b', 'linked', other)
  const first = await publishPanel('interview', model('Interview'), options)
  assert.deepEqual(first, { schemaVersion: 1, worktreeId: first.worktreeId, panelId: 'interview', revision: 1, data: model('Interview') })
  assert.deepEqual(await runPane(['bridge', 'snapshot', 'interview'], options), first)
  assert.deepEqual(await publishPanel('interview', model('Interview'), options), first)
  const following = await Promise.all(['Grouping', 'Reviewing'].map(title => publishPanel('interview', model(title), options)))
  assert.deepEqual(following.map(snapshot => snapshot.revision).sort(), [2, 3])
  const linked = await publishPanel('interview', model('Linked'), { ...options, cwd: other })
  assert.notEqual(linked.worktreeId, first.worktreeId)
  assert.equal(linked.revision, 1)
})

test('view reads recognized settings and shows the same workflow and resource rows as its snapshot', async t => {
  const options = await fixture(t)
  await writeJson(join(options.cwd, '.neil-dev.json'), { mode: 'heavy', steering: 'interactive', token: 'must stay private' })
  await writeJson(join(options.cwd, '.neil-dev.issue-26.json'), { issue: 26, state: 'review', pr: 30, reviewSpec: { answer: '' } })
  await writeJson(join(options.cwd, '.neil-dev.worktree.json'), { version: 2, resources: { 'dev-servers': {}, docker: [] } })
  const view = await runPane(['view'], options)
  assert.match(view.text, /Mode.*heavy/)
  assert.match(view.text, /#26.*review.*#30/)
  assert.doesNotMatch(JSON.stringify(view), /must stay private/)
  assert.deepEqual(await runPane(['bridge', 'snapshot', 'view'], options), view.snapshot)
})

test('view shows the running flow step with its elapsed time and limit, and the last watcher result', async t => {
  const options = await fixture(t)
  const gitDir = git(options.cwd, 'rev-parse', '--absolute-git-dir')
  assert.match((await runPane(['view'], options)).text, /Flow\nRunning step: none/)
  const running = join(gitDir, 'ndev-pre-push-check.sh.run')
  const finished = join(gitDir, 'ndev-pre-ready-check.sh.run')
  await mkdir(running)
  await mkdir(finished)
  await writeJson(join(running, 'progress.json'), { label: 'scripts/ndev/workflow/pre-push-check.sh', pid: process.pid, startedAt: Date.now() - 150_000, limitMs: 3_600_000 })
  await writeJson(join(finished, 'progress.json'), { label: 'scripts/ndev/workflow/pre-ready-check.sh', pid: process.pid, startedAt: Date.now(), limitMs: 3_600_000 })
  await writeFile(join(finished, 'exit'), '0\n')
  const sessions = join(options.home, '.local/state/ndev/sessions')
  await mkdir(sessions, { recursive: true })
  const root = git(options.cwd, 'rev-parse', '--show-toplevel')
  await writeJson(join(sessions, 'a.json'), { id: 'claude-7', root })
  await writeJson(join(sessions, 'a.watch.json'), { pid: 2 ** 22 + 12345, lastNotice: { message: 'Issue #26 is in developing. Run ndev flow status.', issue: 26, state: 'developing', requestId: 'req-1', at: Date.parse('2026-11-25T10:00:00Z') } })
  await writeJson(join(sessions, 'b.json'), { id: 'other', root: options.home })
  await writeJson(join(sessions, 'b.watch.json'), { lastNotice: { message: 'Not this worktree.', at: 1 } })
  const view = await runPane(['view'], options)
  assert.match(view.text, /Flow\nRunning step: scripts\/ndev\/workflow\/pre-push-check\.sh · running 3 min of at most 60 min\n/)
  assert.doesNotMatch(view.text, /pre-ready-check/)
  assert.match(view.text, /Watcher claude-7: not running · last notice at 2026-11-25T10:00:00\.000Z \(Orca request req-1\): Issue #26 is in developing\. Run ndev flow status\./)
  assert.doesNotMatch(view.text, /Not this worktree/)
  await writeJson(join(running, 'progress.json'), { label: 'broken' })
  await assert.rejects(runPane(['view'], options), /Invalid check progress .*ndev-pre-push-check\.sh\.run\/progress\.json/)
  await rm(running, { recursive: true })
  await writeJson(join(sessions, 'a.watch.json'), { lastNotice: { message: 'No time.' } })
  await assert.rejects(runPane(['view'], options), /Invalid watcher notice .*a\.watch\.json/)
})

test('explicit open checks the selected workspace, uses text headless and reports an Orca error', async t => {
  const options = await fixture(t)
  const calls = []
  let mode = 'other'
  options.orca = async (args) => {
    calls.push(args)
    if (args[0] === 'status') return { app: { desktopWindowStatus: mode === 'headless' ? 'unavailable' : 'available' }, target: { kind: 'local' } }
    if (args[0] === 'worktree') return { worktree: { path: mode === 'other' ? options.home : options.cwd, displayName: 'A workspace', hostId: 'local' } }
    if (mode === 'failed') throw Error('plugin_not_enabled: ndev is disabled')
    return {}
  }
  assert.match((await runPane(['view', '--open'], options)).text, /Select.*checkout/)
  mode = 'headless'
  assert.equal((await runPane(['view', '--open'], options)).opened, false)
  assert.equal(calls.filter(([first]) => first === 'plugin').length, 0)
  mode = 'ok'
  assert.equal((await runPane(['view', '--open'], options)).opened, true)
  assert.deepEqual(calls.at(-1), ['plugin', 'open', 'neilellis.ndev', '--panel', 'view'])
  mode = 'failed'
  await assert.rejects(runPane(['view', '--open'], options), /plugin_not_enabled.*disabled/)
})

test('panel file actions reject stale and foreign revisions and use the CLI file handler', async t => {
  const options = await fixture(t)
  const files = await runPane(['bridge', 'snapshot', 'files'], options)
  const request = { worktreeId: files.worktreeId, expectedRevision: files.revision, actionId: 'file.create', input: { name: '.neil-dev.json' } }
  const action = patch => runPane(['bridge', 'action', 'files', JSON.stringify({ ...request, ...patch })], options)
  await assert.rejects(action({ worktreeId: 'other' }), /worktree/)
  await assert.rejects(action({ actionId: 'shell.exec' }), /Unknown.*shell.exec/)
  await assert.rejects(action({ input: { name: '../elsewhere' } }), /name|file/)
  await assert.rejects(action({ input: { name: '.neil-dev.json', dir: options.home } }), /input|dir/)
  const result = await action({})
  assert.equal(result.snapshot.revision, files.revision + 1)
  assert.equal(JSON.parse(await readFile(join(options.cwd, '.neil-dev.json'), 'utf8')).mode, 'light')
  await assert.rejects(action({}), /revision.*Refresh/i)
})

test('delete confirmation binds the target and revision and a command-line flag cannot supply it', async t => {
  const options = await fixture(t)
  await writeJson(join(options.cwd, '.neil-dev.worktree.json'), { version: 2, resources: { 'dev-servers': {}, docker: [{ kind: 'supabase', projectId: 'bound-target', cliVersion: '2.0.0', workdir: options.cwd }] } })
  options.confirm = async binding => {
    assert.equal(binding.action, 'resources.stopStack')
    assert.deepEqual(binding.target, { projectId: 'bound-target', policy: 'stop-and-delete' })
    assert.equal(binding.revision, 1)
    assert.equal(typeof binding.worktreeId, 'string')
    return false
  }
  await assert.rejects(runPane(['resources', 'stop-stack', 'bound-target', 'stop-and-delete', '--yes'], options), /usage/i)
  await assert.rejects(runPane(['resources', 'stop-stack', 'bound-target', 'stop-and-delete'], options), /confirmation.*declined/i)
  assert.match(await readFile(join(options.cwd, '.neil-dev.worktree.json'), 'utf8'), /bound-target/)
})

test('responsive evidence stays within the worktree, and refresh sees new cells', async t => {
  const options = await fixture(t)
  const pointerDir = join(options.home, '.cache/ndev/responsive-check')
  const run = join(options.cwd, 'run')
  await mkdir(pointerDir, { recursive: true })
  await mkdir(run)
  const progress = join(run, 'progress.json')
  const screen = join(run, 'tablet.png')
  await writeFile(screen, 'png')
  await writeJson(join(pointerDir, 'latest.json'), { cwd: options.cwd, progress })
  await writeJson(progress, { state: 'running', base: 'http://localhost:3000', cells: [] })
  const first = await runPane(['responsive-matrix'], options)
  await writeJson(progress, { state: 'done', base: 'http://localhost:3000', cells: [{ route: '/cart', viewport: 'tablet', scheme: 'dark', status: 'ok', screenshot: screen }] })
  const next = await runPane(['bridge', 'snapshot', 'responsive-matrix'], options)
  assert.equal(next.revision, first.snapshot.revision + 1)
  assert.match(JSON.stringify(next.data), /\/cart.*tablet.*dark.*ok.*tablet\.png/)
  await symlink(options.home, join(run, 'escape'))
  await writeJson(join(options.home, 'progress.json'), { state: 'done', cells: [] })
  await writeJson(join(pointerDir, 'latest.json'), { cwd: options.cwd, progress: join(run, 'escape', 'progress.json') })
  await assert.rejects(runPane(['responsive-matrix'], options), /outside/)
})

test('a completed responsive run includes the evidence recorded in its report', async t => {
  const options = await fixture(t)
  const pointerDir = join(options.home, '.cache/ndev/responsive-check')
  await mkdir(pointerDir, { recursive: true })
  const progress = join(options.cwd, 'progress.json')
  const report = join(options.cwd, 'report.json')
  const image = join(options.cwd, 'phone.png')
  await writeFile(image, 'png')
  await writeJson(join(pointerDir, 'latest.json'), { cwd: options.cwd, progress })
  const cell = { route: '/', viewport: 'phone', scheme: 'light', status: 'warn' }
  await writeJson(progress, { state: 'done', base: 'http://localhost:3000', cells: [cell], report })
  await writeJson(report, { cells: [{ ...cell, screenshot: image, findings: [{ check: 'overflow', selector: '.cart', severity: 'warning', detail: 'Width is 500px' }] }] })
  const view = await runPane(['responsive-matrix'], options)
  assert.match(view.text, /phone\.png/)
  assert.match(view.text, /overflow.*Width is 500px/)
})

test('resource forget preserves other record owners and view accepts interview-only records', async t => {
  const options = await fixture(t)
  const file = join(options.cwd, '.neil-dev.worktree.json')
  const settings = { mode: 'heavy', steering: 'interactive' }
  const leads = { '11': 12 }
  await writeJson(file, { version: 2, settings, leads, resources: { docker: [], 'dev-servers': { web: { pid: 99999999, port: 3000, command: 'ndev-web', started: '2025-01-01' } } } })
  await writeJson(join(options.cwd, '.neil-dev.issue-12.json'), { version: 1, issue: 12, rounds: [] })
  await runPane(['resources', 'forget', 'dev-server', 'web'], options)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 2, settings, leads, resources: { docker: [], 'dev-servers': {} } })
  assert.match((await runPane(['view'], options)).text, /#12.*interview/i)
})

test('Orca worker fences worktree identity before dispatch and refuses remote filesystem access', async t => {
  const options = await fixture(t)
  const { default: activate } = await import('../orca-plugin/ndev/worker/main.mjs')
  const handlers = new Map()
  let active = 'local'
  const workspaces = [
    { id: 'local', hostId: 'local', kind: 'worktree', path: options.cwd },
    { id: 'remote', hostId: 'ssh:other', kind: 'worktree', path: options.cwd },
  ]
  let writes = 0
  await activate({
    host: { call: async method => method === 'workspace.readContext' ? { workspaceId: active } : { workspaces } },
    panels: { handle: (name, handler) => handlers.set(name, handler) },
  }, {
    bridge: (directory, args) => {
      assert.equal(git(directory, 'rev-parse', '--show-toplevel'), git(options.cwd, 'rev-parse', '--show-toplevel'))
      if (args[0] === 'action') writes += 1
      return runPane(['bridge', ...args], options)
    },
  })
  const snapshot = await handlers.get('panel.snapshot')({ panelId: 'files' })
  const request = { panelId: 'files', worktreeId: snapshot.worktreeId, expectedRevision: snapshot.revision, actionId: 'file.create', input: { name: '.neil-dev.json' } }
  await assert.rejects(handlers.get('panel.action')({ ...request, worktreeId: 'foreign' }), /different worktree/)
  await assert.rejects(handlers.get('panel.action')({ ...request, expectedRevision: 0 }), /refresh/i)
  active = 'remote'
  await assert.rejects(handlers.get('panel.action')(request), /cannot access/)
  active = 'local'
  await handlers.get('panel.action')(request)
  assert.equal(writes, 1)
})

test('the interview action passes the exact answer map through stdin and fences the advertised round', async t => {
  const options = await fixture(t)
  const actions = [{ id: 'interview.answer', label: 'Submit answers', input: { issue: 51, roundId: 'test-round' } }]
  const panel = await publishPanel('interview', { ...model('Interview'), actions }, options)
  const answers = { target: { selected: ['Desktop'], notes: 'Existing support' } }
  const request = { worktreeId: panel.worktreeId, expectedRevision: panel.revision, actionId: 'interview.answer', input: { issue: 51, roundId: 'test-round', answers } }
  const calls = []
  options.ndev = (args, effects) => { calls.push({ args, ...effects }); return { issue: 51 } }
  const invoke = payload => runPane(['bridge', 'action', 'interview', JSON.stringify(payload)], options)
  await assert.rejects(invoke({ ...request, input: { ...request.input, roundId: 'previous' } }), /not available/)
  const reply = await invoke(request)
  assert.equal(reply.snapshot.revision, panel.revision + 1)
  assert.deepEqual(calls.map(({ args, input }) => ({ args, input: JSON.parse(input) })), [{
    args: ['flow', 'interview', '--issue', '51', '--answers-file', '-'],
    input: answers,
  }])
})

test('screenshot pins its tab for each viewport and scheme, closes on success and leaves login open', async t => {
  const options = await fixture(t)
  const temporaryImage = join(options.home, 'shot.png')
  const calls = []
  let login = false
  let scheme
  let width
  options.orca = async (args) => {
    calls.push(args)
    if (args[0] === 'tab' && args[1] === 'create') return { browserPageId: 'evidence-tab' }
    assert.deepEqual(args.slice(-2), ['--page', 'evidence-tab'])
    if (args[0] === 'exec') scheme = args[2].split(' ').at(-1)
    if (args[0] === 'viewport') width = args[2]
    if (args[0] === 'eval') {
      if (args[2] === 'location.href') return { result: login ? 'https://login.example.test/login' : 'https://example.test/cart' }
      if (args[2] === 'window.innerWidth') return { result: width }
      return { result: scheme === 'dark' }
    }
    if (args[0] === 'screenshot') {
      await writeFile(temporaryImage, scheme)
      return { path: temporaryImage }
    }
    return {}
  }
  const url = 'https://example.test/cart'
  const result = await runPane(['screenshot', url, '--viewport', '390x844', '--viewport', '800x900'], options)
  assert.equal(result.files.length, 4)
  assert.deepEqual(calls.at(-1), ['tab', 'close', '--page', 'evidence-tab'])
  for (const { file, scheme: expected } of result.files) assert.equal(await readFile(file, 'utf8'), expected)
  calls.length = 0
  login = true
  await assert.rejects(runPane(['screenshot', url], options), error => error.errorCode === 'browser_sign_in_required' && /evidence-tab/.test(error.repair))
  assert.equal(calls.some(([type, action]) => type === 'tab' && action === 'close'), false)
})

test('a full-page screenshot is one full-screenshot image after a scroll pass, and needs an Orca that does not wrap it', async t => {
  const options = await fixture(t)
  const temporaryImage = join(options.home, 'full.png')
  await writeFile(temporaryImage, 'whole page')
  const calls = []
  const scrolls = []
  let appVersion = '1.4.274'
  let reachable = true
  let loading = 0
  let total = 2000
  let stuckAt = Infinity
  let width
  options.orca = async (args) => {
    calls.push(args)
    if (args[0] === 'status') return { runtime: { reachable, appVersion: reachable ? appVersion : undefined } }
    if (args[0] === 'tab' && args[1] === 'create') return { browserPageId: 'full-tab' }
    if (args[0] === 'viewport') width = args[2]
    if (args[0] === 'eval') {
      if (args[2] === 'location.href') return { result: 'https://example.test/long' }
      if (args[2] === 'window.innerWidth') return { result: width }
      if (args[2].includes('querySelectorAll')) return { result: 'null' }
      if (args[2].includes('document.images')) return { result: JSON.stringify(loading) }
      if (args[2].includes('scrollTo')) {
        const y = Math.min(Number(/top:\s*(\d+)/.exec(args[2])[1]), total - 640, stuckAt)
        scrolls.push(y)
        return { result: JSON.stringify([y, 640, total]) }
      }
      return { result: false }
    }
    if (args[0] === 'screenshot' || args[0] === 'full-screenshot') return { path: temporaryImage }
    return {}
  }
  const args = ['screenshot', 'https://example.test/long', '--viewport', '320x640', '--scheme', 'light', '--full-page']
  const result = await runPane(args, options)
  assert.deepEqual(scrolls, [0, 512, 1024, 1360, 0])
  assert.deepEqual(calls.filter(call => call[0].endsWith('screenshot')).map(call => call[0]), ['full-screenshot'])
  assert.equal(result.files.length, 1)
  assert.match(result.files[0].file, /320x640-light\.png$/)
  assert.deepEqual(result.warnings, [])

  calls.length = 0
  loading = 3
  const paused = await runPane([...args, '--wait-seconds', '2'], options)
  assert.deepEqual(paused.warnings, ['320x640 light: 3 image(s) were still loading after 10 s, so the image may show them blank.'])
  const steps = calls.flatMap(call => (call[0] === 'wait' && call.includes('2000') ? ['pause'] : call[0] === 'full-screenshot' ? ['capture'] : call[2]?.includes?.('scrollTo') ? ['scroll'] : call[2]?.includes?.('document.images') ? ['images'] : []))
  assert.deepEqual(steps, ['pause', 'scroll', 'scroll', 'scroll', 'scroll', 'scroll', 'pause', 'images', 'capture'])
  loading = 0

  total = 1_000_000
  scrolls.length = 0
  assert.match((await runPane(args, options)).warnings.join('\n'), /limit of 40 steps.*of 1000000 pixels.*may not have loaded/)
  assert.equal(scrolls.length, 41)
  total = 2000
  stuckAt = 0
  assert.match((await runPane(args, options)).warnings.join('\n'), /stopped scrolling at 640 of 2000 pixels.*may not have loaded/)
  stuckAt = Infinity

  for (const [version, said] of [['1.4.266', /1\.4\.274.*1\.4\.266/], ['unknown', /1\.4\.274.*"unknown"/]]) {
    calls.length = 0
    appVersion = version
    await assert.rejects(runPane(args, options), error => said.test(error.message) && /update Orca/i.test(error.repair))
    assert.equal(calls.some(call => call[0] === 'tab'), false)
  }
  calls.length = 0
  reachable = false
  await assert.rejects(runPane(args, options), error => /not reachable/.test(error.message) && /orca open/.test(error.repair))
  assert.equal(calls.some(call => call[0] === 'tab'), false)
})

test('confirmation expires if the resource target changes while the dialog is open', async t => {
  const options = await fixture(t)
  const file = join(options.cwd, '.neil-dev.worktree.json')
  const recorded = { kind: 'supabase', projectId: 'bound-target', cliVersion: '2.0.0', workdir: options.cwd }
  const replace = addedAt => writeJson(file, { version: 2, resources: { 'dev-servers': {}, docker: [{ ...recorded, addedAt }] } })
  await replace('first')
  options.confirm = async () => { await replace('second'); return true }
  await assert.rejects(runPane(['resources', 'stop-stack', 'bound-target', 'stop-and-delete'], options), error => error.errorCode === 'stale_revision')
  assert.match(await readFile(file, 'utf8'), /second/)
})

class FakeElement {
  constructor(tag) { Object.assign(this, { tag, children: [], text: '', value: '', className: '', hidden: false, dataset: {}, style: {} }) }
  set textContent(value) { this.text = String(value); this.children = [] }
  get textContent() { return [this.text, ...this.children.map(child => typeof child === 'string' ? child : child.textContent)].filter(Boolean).join('\n') }
  get lastChild() { return this.children.at(-1) }
  append(...nodes) { this.children.push(...nodes) }
  replaceChildren(...nodes) { this.text = ''; this.children = nodes }
  setAttribute() {}
  addChild(tag) { const child = new FakeElement(tag); this.append(child); return child }
  createTHead() { return this.addChild('thead') }
  createTBody() { return this.addChild('tbody') }
  insertRow() { return this.addChild('tr') }
  insertCell() { return this.addChild('td') }
}

async function openPanel(panelId, options) {
  const html = await readFile(new URL(`../orca-plugin/ndev/panel/${panelId}.html`, import.meta.url), 'utf8')
  const script = html.match(/<script type="module">\n([\s\S]*)<\/script>/)[1]
  const elements = new Map()
  const document = {
    hidden: false,
    body: { dataset: { panel: panelId } },
    getElementById: id => elements.get(id) ?? elements.set(id, new FakeElement(id)).get(id),
    createElement: tag => new FakeElement(tag),
  }
  const pending = []
  let tick
  const requests = []
  const orca = { plugin: { request: (name, { panelId: id, ...input }) => {
    requests.push(name)
    const reply = name === 'panel.action' ? runPane(['bridge', 'action', id, JSON.stringify(input)], options) : runPane(['bridge', 'snapshot', id], options)
    pending.push(reply)
    return reply
  } } }
  const settle = async () => {
    while (pending.length) await pending.shift().catch(() => {})
    await new Promise(resolve => setImmediate(resolve))
  }
  runInNewContext(script, { document, orca, window: { addEventListener() {} }, setInterval: callback => { tick = callback; return 1 }, clearInterval() {}, setTimeout, clearTimeout, console })
  await settle()
  return {
    document,
    requests,
    content: () => document.getElementById('content').textContent,
    message: () => document.getElementById('message').textContent,
    tick: async () => { tick(); await settle() },
    settle,
  }
}

test('an open view panel shows file and resource changes on its timer and pauses while hidden', async t => {
  const options = await fixture(t)
  const panel = await openPanel('view', options)
  assert.equal(panel.message(), '')
  assert.match(panel.content(), /\.neil-dev\.json\nMissing/)
  assert.doesNotMatch(panel.content(), /ndev-web/)
  await writeJson(join(options.cwd, '.neil-dev.json'), { mode: 'heavy' })
  await writeJson(join(options.cwd, '.neil-dev.worktree.json'), { version: 2, resources: { docker: [], 'dev-servers': { 'ndev-web': { pid: 99999999, port: 3000, command: 'ndev-web', started: '2025-01-01' } } } })
  panel.document.hidden = true
  const before = panel.requests.length
  await panel.tick()
  assert.equal(panel.requests.length, before)
  panel.document.hidden = false
  await panel.tick()
  assert.match(panel.content(), /Mode\nheavy/)
  assert.match(panel.content(), /ndev-web\nport 3000/)
})

test('an open responsive matrix panel shows new cells on its timer as the evidence appears', async t => {
  const options = await fixture(t)
  const pointerDir = join(options.home, '.cache/ndev/responsive-check')
  await mkdir(pointerDir, { recursive: true })
  const progress = join(options.cwd, 'progress.json')
  await writeJson(join(pointerDir, 'latest.json'), { cwd: options.cwd, progress })
  await writeJson(progress, { state: 'running', base: 'http://localhost:3000', cells: [] })
  const panel = await openPanel('responsive-matrix', options)
  assert.match(panel.content(), /running/)
  assert.doesNotMatch(panel.content(), /\/cart/)
  const screen = join(options.cwd, 'phone.png')
  await writeFile(screen, 'png')
  await writeJson(progress, { state: 'running', base: 'http://localhost:3000', cells: [{ route: '/cart', viewport: 'phone', scheme: 'dark', status: 'ok', screenshot: screen }] })
  await panel.tick()
  assert.match(panel.content(), /\/cart · phone[\s\S]*ok[\s\S]*phone\.png/)
  await writeJson(progress, { state: 'done', base: 'http://localhost:3000', cells: [{ route: '/cart', viewport: 'phone', scheme: 'dark', status: 'ok', screenshot: screen }, { route: '/cart', viewport: 'phone', scheme: 'light', status: 'warn', warnings: 1 }] })
  await panel.tick()
  assert.match(panel.content(), /done/)
  assert.match(panel.content(), /warn[\s\S]*0 errors · 1 warnings/)
})

test('the interview panel renders questions, recommendations and notes and submits the answers text mode takes', async t => {
  const options = await fixture(t)
  const round = {
    title: 'Scope',
    questions: [
      { id: 'target', header: 'Target', question: 'Which surface ships first?', options: [{ label: 'Desktop', recommended: true, description: 'Existing support' }, { label: 'Mobile' }] },
      { id: 'name', header: 'Name', question: 'What is the command called?', suggested: 'ndev pane' },
    ],
    rounds: [{ title: 'Earlier', questions: [{ id: 'goal', header: 'Goal' }], answers: [{ id: 'goal', selected: [], other: 'Ship the CLI', notes: 'From the issue' }] }],
    actions: [{ id: 'interview.answer', label: 'Submit answers', input: { issue: 51, roundId: 'round-1' } }],
  }
  await publishPanel('interview', round, options)
  const calls = []
  options.ndev = (args, effects) => { calls.push({ args, input: JSON.parse(effects.input) }); return { issue: 51 } }
  const panel = await openPanel('interview', options)
  const text = panel.content()
  assert.match(text, /Target\nWhich surface ships first\?/)
  assert.match(text, /Desktop\n \(recommended\)\n · Existing support/)
  assert.match(text, /Other answer[\s\S]*Notes/)
  assert.match(text, /Earlier\nGoal\nShip the CLI\nFrom the issue/)
  const find = (node, test) => test(node) ? node : node.children?.filter(child => typeof child !== 'string').map(child => find(child, test)).find(Boolean)
  const content = panel.document.getElementById('content')
  const notes = find(content, node => node.tag === 'label' && node.text === 'Notes')
  notes.children[0].value = 'Tablet later'
  const form = find(content, node => node.tag === 'form')
  await form.onsubmit({ isTrusted: true, preventDefault() {} })
  await panel.settle()
  assert.equal(panel.message(), '')
  assert.deepEqual(calls, [{
    args: ['flow', 'interview', '--issue', '51', '--answers-file', '-'],
    input: { target: { selected: ['Desktop'], notes: 'Tablet later' }, name: { selected: [], other: 'ndev pane' } },
  }])
})
