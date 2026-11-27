const $ = (id) => document.getElementById(id)
const ask = (name, input) => orca.plugin.request(name, input, { timeoutMs: 245000 })
let loading = false
let acting = false
let shown
const newest = new Map()

function actOn(ws, actionId, input) {
  const { worktreeId, revision } = ws.snapshot
  return ask('panel.action', { panelId: 'files', worktreeId, expectedRevision: revision, actionId, input })
}

function setStatus(message, isError = false) {
  const el = $('status')
  el.textContent = message
  el.className = isError ? 'error' : ''
}

async function run(label, fn) {
  setStatus(label)
  try {
    const result = await fn()
    setStatus('')
    return result
  } catch (error) {
    // code and message come from the worker; show both so the repair command is visible.
    setStatus(`${error.code ? `[${error.code}] ` : ''}${error.message}`, true)
    return undefined
  }
}

const WHAT = {
  '.ndev.json': 'Project settings: mode, steering, GitHub repo and board. Checked in.',
  '.neil-dev.env': 'Private keys for ndev skills. Git-ignored, mode 600. Only key names are shown.',
  '.neil-dev.worktree.json': 'Local stacks this worktree started. Written by ndev, one per worktree.'
}
const COPYABLE = new Set(['.ndev.json', '.neil-dev.env'])

function button(label, onclick) {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = label
  b.onclick = onclick
  return b
}

function cell(text, className) {
  const td = document.createElement('td')
  if (className) td.className = className
  if (text !== undefined) td.textContent = text
  return td
}

function fileRow(ws, file) {
  const tr = document.createElement('tr')
  if (!file.exists) tr.className = 'missing'
  const name = cell()
  const code = document.createElement('code')
  code.textContent = file.name
  const what = document.createElement('div')
  what.className = 'keys'
  what.textContent = WHAT[file.name]
  name.append(code, what)

  const state = cell()
  if (!file.exists) state.textContent = 'missing'
  else {
    state.append(`${file.size} bytes · mode ${file.mode}`)
    const detail = file.summary ?? (file.keys ? `${file.keys.length} keys: ${file.keys.join(', ') || 'none'}` : '')
    if (detail) {
      const d = document.createElement('div')
      d.className = 'keys'
      d.textContent = detail
      state.append(d)
    }
    if (file.problem) {
      const p = document.createElement('div')
      p.className = 'problem'
      p.textContent = file.problem
      state.append(p)
    }
  }

  const actions = cell(undefined, 'actions')
  if (ws.snapshot && !file.exists && file.name !== '.neil-dev.worktree.json') {
    actions.append(button('Create', () => act('Creating…', 'file.create', ws, file)))
    if (COPYABLE.has(file.name) && !ws.isMain) actions.append(' ', button('Copy from main', () => act('Copying…', 'file.copyFromMain', ws, file)))
  }
  tr.append(name, state, actions)
  return tr
}

async function act(label, method, ws, file) {
  await action(label, method, ws, { name: file.name })
}

function workspace(ws) {
  const section = document.createElement('section')
  section.className = `ws${ws.focused ? ' focused' : ''}`
  const h = document.createElement('h2')
  h.textContent = ws.name
  for (const text of [ws.focused && 'current', ws.isMain && 'main checkout']) {
    if (!text) continue
    const badge = document.createElement('span')
    badge.className = 'badge'
    badge.textContent = text
    h.append(badge)
  }
  const path = document.createElement('p')
  path.className = 'path'
  path.textContent = ws.dir
  section.append(h, path)
  if (ws.problem) {
    const p = document.createElement('p')
    p.className = 'problem'
    p.textContent = ws.problem
    section.append(p)
    return section
  }
  const table = document.createElement('table')
  const body = document.createElement('tbody')
  body.append(...ws.files.map((f) => fileRow(ws, f)))
  table.append(body)
  section.append(table)
  if (ws.others?.length) {
    const o = document.createElement('p')
    o.className = 'keys'
    o.textContent = `Other .neil-dev files: ${ws.others.map((f) => `${f.name}${f.isDirectory ? '/' : ''} (${f.size} bytes)`).join(', ')}`
    section.append(o)
  }
  if (ws.resources) section.append(resources(ws))
  return section
}

// ---- resources: docker stacks and dev servers recorded in .neil-dev.worktree.json -------------

const armed = new Map() // button -> reset timer; a second click within 4 s confirms
function confirmed(b, label, armedLabel, onconfirm) {
  b.textContent = label
  b.onclick = () => {
    if (!armed.has(b)) {
      b.textContent = armedLabel
      b.classList.add('armed')
      armed.set(b, setTimeout(() => { armed.delete(b); b.classList.remove('armed'); b.textContent = label }, 4000))
      return
    }
    clearTimeout(armed.get(b))
    armed.delete(b)
    onconfirm()
  }
  return b
}

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text)
    setStatus(`Copied ${what}`)
  } catch (error) {
    setStatus(`Could not copy ${what}: ${error.message}. Select it here instead: ${text}`, true)
  }
}

async function openUrl(url) {
  try {
    await orca.shell.openExternal(url)
  } catch (error) {
    setStatus(`[${error.code ?? 'error'}] Could not open ${url}: ${error.message}`, true)
  }
}

const resRow = (dot, title, detail) => {
  const row = document.createElement('div')
  row.className = 'res'
  const what = document.createElement('div')
  what.className = 'what'
  const d = document.createElement('span')
  d.className = `dot ${dot}`
  const t = document.createElement('strong')
  t.textContent = title
  what.append(d, t)
  if (detail) {
    const x = document.createElement('div')
    x.className = 'keys'
    x.textContent = detail
    what.append(x)
  }
  row.append(what)
  return row
}

async function action(label, method, ws, input) {
  if (acting) return
  acting = true
  try {
    const done = await run(label, () => actOn(ws, method, input))
    if (done) await load()
  } finally {
    acting = false
  }
}

const reload = (label, method, ws, input) => () => action(label, method, ws, input)

function resources(ws) {
  const box = document.createElement('div')
  const r = ws.resources
  const h = document.createElement('h3')
  h.textContent = 'Resources'
  box.append(h)
  if (r.problem) {
    const p = document.createElement('p')
    p.className = 'problem'
    p.textContent = r.problem
    box.append(p)
    return box
  }
  if (!r.docker.length && !r.devServers.length) {
    const p = document.createElement('p')
    p.className = 'keys'
    p.textContent = 'Nothing recorded: no docker stacks or dev servers started by this worktree.'
    box.append(p)
    return box
  }
  for (const s of r.devServers) {
    const url = `http://localhost:${s.port}`
    const row = resRow(s.status, `Dev server ${s.name} · port ${s.port}`, `${s.status === 'dead' ? 'not running · ' : s.status === 'mismatch' ? `pid ${s.pid} now runs "${s.now}", not stopped · ` : ''}${s.command}`)
    row.append(button('Open', () => openUrl(url)), button('Copy port', () => copy(String(s.port), 'port')), button('Copy command', () => copy(s.command, 'command')))
    if (ws.snapshot && s.status === 'running') row.append(confirmed(button('Stop'), 'Stop', 'Click again to stop', reload('Stopping…', 'resources.stopServer', ws, { name: s.name })))
    else if (ws.snapshot) row.append(confirmed(button('Forget'), 'Forget', 'Click again to forget', reload('Forgetting…', 'resources.forget', ws, { type: 'dev-server', id: s.name })))
    box.append(row)
  }
  for (const s of r.docker) {
    const row = resRow(s.status, `Docker ${s.kind} · ${s.projectId}`, s.problem ?? `${s.status} · ${s.workdir}`)
    row.append(button('Copy id', () => copy(s.projectId, 'project id')))
    if (ws.snapshot) {
      row.append(confirmed(button('Stop, keep data'), 'Stop, keep data', 'Click again to stop', reload('Stopping stack…', 'resources.stopStack', ws, { projectId: s.projectId, policy: 'stop-keep-data' })))
      row.append(button('Stop and delete data', reload('Confirm the data deletion in the desktop prompt…', 'resources.stopStack', ws, { projectId: s.projectId, policy: 'stop-and-delete' })))
    }
    box.append(row)
  }
  if (!ws.snapshot) return box
  const all = document.createElement('div')
  all.className = 'res'
  const policy = document.createElement('select')
  policy.setAttribute('aria-label', 'Docker policy for stop all')
  policy.append(new Option('docker: stop, keep data', 'stop-keep-data'), new Option('docker: stop and delete data', 'stop-and-delete'), new Option('docker: leave running', 'keep-running'))
  const stopAll = confirmed(button('Stop all'), 'Stop all', 'Click again to stop all', async () => {
    await action('Stopping resources…', 'resources.stopAll', ws, { policy: policy.value })
  })
  all.append(policy, stopAll)
  box.append(all)
  return box
}

async function load() {
  if (loading) return
  loading = true
  try {
    const list = await ask('workspaces.list', {})
    for (const ws of list) {
      if (!ws.snapshot) continue
      const { worktreeId, revision } = ws.snapshot
      if ((newest.get(worktreeId) ?? 0) > revision) return
      newest.set(worktreeId, revision)
    }
    const next = JSON.stringify(list)
    if (next !== shown) {
      $('workspaces').replaceChildren(...list.map(workspace))
      shown = next
    }
  } catch (error) {
    setStatus(`[${error.code ?? 'error'}] ${error.message}`, true)
  } finally {
    loading = false
  }
}

$('reload').onclick = () => { setStatus(''); void load() }
const timer = setInterval(() => { if (!document.hidden && !acting) void load() }, 3000)
window.addEventListener('pagehide', () => clearInterval(timer), { once: true })
void load()
