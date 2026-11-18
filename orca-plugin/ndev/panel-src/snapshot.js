const panelId = document.body.dataset.panel
const find = id => document.getElementById(id)
const ask = (name, input, timeoutMs = 20_000) => orca.plugin.request(name, { panelId, ...input }, { timeoutMs })
const node = (tag, content, className) => {
  const element = document.createElement(tag)
  if (content !== undefined) element.textContent = content
  if (className) element.className = className
  return element
}
const errorText = error => `[${error.code ?? 'error'}] ${error.message}`

let snapshot
let loading = false
let acting = false
const newest = new Map()

function message(text = '', error = false) {
  const output = find('message')
  output.textContent = text
  output.className = error ? 'error' : ''
}

function rows(group) {
  const section = node('section')
  const list = node('dl')
  for (const { label, value } of group.rows ?? []) {
    list.append(node('dt', label), node('dd', typeof value === 'object' ? JSON.stringify(value) : value))
  }
  section.append(node('h2', group.title), list)
  return section
}

function matrix(cells) {
  const section = node('section')
  section.append(node('h2', 'Viewport results'))
  const table = node('table')
  const schemes = [...new Set(cells.map(cell => cell.scheme))]
  const keys = new Map()
  for (const cell of cells) {
    const key = JSON.stringify([cell.route, cell.viewport])
    if (!keys.has(key)) keys.set(key, {})
    keys.get(key)[cell.scheme] = cell
  }
  const header = table.createTHead().insertRow()
  for (const value of ['Route and viewport', ...schemes]) {
    const label = node('th', value)
    label.scope = 'col'
    header.append(label)
  }
  const body = table.createTBody()
  for (const [key, grouped] of keys) {
    const line = body.insertRow()
    const [route, viewport] = JSON.parse(key)
    const label = node('th', `${route} · ${viewport}`)
    label.scope = 'row'
    line.append(label)
    for (const scheme of schemes) {
      const cell = grouped[scheme]
      const value = line.insertCell()
      value.textContent = cell?.status ?? '—'
      if (cell?.errors || cell?.warnings) value.append(node('small', `${cell.errors ?? 0} errors · ${cell.warnings ?? 0} warnings`))
      if (cell?.screenshot) value.append(node('small', cell.screenshot, 'quiet'))
    }
  }
  section.append(table)
  return section
}

function inputLabel(label, field) {
  const wrap = node('label', label, 'text-field')
  wrap.append(field)
  return wrap
}

function questionFields(form, questions) {
  return questions.map((question, index) => {
    const group = node('fieldset')
    group.append(node('legend', question.header ?? question.id))
    group.append(node('p', question.question ?? question.prompt ?? question.text))
    if (question.context) group.append(node('p', question.context, 'quiet'))
    const options = (question.options ?? question.choices ?? []).map(option => {
      const label = typeof option === 'string' ? option : option.label
      const input = node('input')
      input.type = question.multiSelect ? 'checkbox' : 'radio'
      input.name = `question-${index}`
      input.value = label
      input.checked = option.recommended === true
      const item = node('label', undefined, 'option')
      item.append(input, ` ${label}`, option.recommended ? ' (recommended)' : '')
      if (option.description) item.append(node('span', ` · ${option.description}`, 'quiet'))
      group.append(item)
      return input
    })
    const other = node('textarea')
    other.value = question.suggested ?? ''
    const notes = node('textarea')
    group.append(inputLabel(options.length ? 'Other answer' : 'Answer', other), inputLabel('Notes', notes))
    form.append(group)
    return () => [question.id, {
      selected: options.filter(option => option.checked).map(option => option.value),
      ...(other.value.trim() ? { other: other.value } : {}),
      ...(notes.value.trim() ? { notes: notes.value } : {}),
    }]
  })
}

function actionField(form, field) {
  const input = node(field.type === 'textarea' ? 'textarea' : field.type === 'select' ? 'select' : 'input')
  if (field.type === 'number') {
    input.type = 'number'
    input.min = '1'
    input.step = '1'
  }
  for (const choice of field.options ?? []) {
    const item = node('option', choice.label ?? choice)
    item.value = choice.value ?? choice
    input.append(item)
  }
  input.required = field.required !== false
  if (field.value !== undefined) input.value = field.value
  form.append(inputLabel(field.label ?? field.name, input))
  return () => input.value ? [field.name, field.type === 'number' ? Number(input.value) : input.value] : undefined
}

function actions(data) {
  const wrapper = node('div', undefined, 'actions')
  for (const action of data.actions ?? []) {
    const form = node('form')
    const interview = action.id === 'interview.answer'
    const questions = interview ? questionFields(form, data.questions ?? []) : []
    const fields = (action.fields ?? []).map(field => actionField(form, field))
    const button = node('button', action.label ?? action.id)
    button.type = 'submit'
    if (panelId === 'triage') button.dataset.triageFocus = JSON.stringify([action.id, action.input])
    form.append(button)
    form.onsubmit = async event => {
      event.preventDefault()
      if (acting || !snapshot || !event.isTrusted) return
      const { worktreeId, revision } = snapshot
      const input = { ...action.input, ...Object.fromEntries(fields.map(read => read()).filter(Boolean)) }
      if (interview) input.answers = Object.fromEntries(questions.map(read => read()))
      acting = true
      button.disabled = true
      const openingWorkspace = action.id === 'triage.workspace'
      message(openingWorkspace ? 'Opening workspace…' : 'Applying action…')
      try {
        await ask('panel.action', { worktreeId, expectedRevision: revision, actionId: action.id, input }, 245_000)
        message()
        await load()
      } catch (error) {
        if (panelId === 'triage' && !openingWorkspace) await load()
        message(errorText(error), true)
      } finally {
        button.disabled = false
        acting = false
      }
    }
    wrapper.append(form)
  }
  return wrapper
}

function interviewHistory(rounds) {
  return rounds.map(round => {
    const questions = new Map((round.questions ?? []).map(question => [question.id, question]))
    return rows({
      title: round.title,
      rows: (round.answers ?? []).map(answer => ({
        label: questions.get(answer.id)?.header ?? answer.id,
        value: [...(answer.selected ?? []), answer.other, answer.notes].filter(Boolean).join('\n'),
      })),
    })
  })
}

function paint(next) {
  const { data } = next
  find('title').textContent = data.title ?? document.title
  find('reload').hidden = panelId === 'triage' && Boolean(data.triage && data.actions?.some(action => action.id === 'triage.refresh'))
  if (panelId === 'triage' && data.triage) {
    paintTriage(data, snapshot?.worktreeId === next.worktreeId)
    return
  }
  const children = []
  if (data.status) children.push(node('p', data.status, 'quiet'))
  for (const group of data.sections ?? []) {
    if (panelId === 'responsive-matrix' && group.title === 'Viewport results' && data.cells?.length) continue
    if (group.rows?.length) children.push(rows(group))
  }
  if (data.cells?.length) children.push(matrix(data.cells))
  if (data.round?.intro) children.push(node('p', data.round.intro))
  if (data.actions?.length) children.push(actions(data))
  if (panelId === 'interview' && data.rounds?.length) children.push(...interviewHistory(data.rounds))
  find('content').replaceChildren(...children)
}

async function load() {
  if (loading) return
  loading = true
  try {
    const next = await ask('panel.snapshot', {})
    if (next.schemaVersion !== 1 || next.panelId !== panelId) throw new Error('The returned snapshot version or panel ID is invalid.')
    const last = newest.get(next.worktreeId) ?? 0
    if (next.revision < last || (snapshot?.worktreeId === next.worktreeId && snapshot.revision === next.revision)) return
    paint(next)
    snapshot = next
    newest.set(next.worktreeId, next.revision)
  } catch (error) {
    if (['no_workspace', 'remote_workspace', 'no_worktree', 'workspace_changed'].includes(error.code)) {
      snapshot = undefined
      find('reload').hidden = false
      find('content').replaceChildren()
    }
    message(errorText(error), true)
  } finally {
    loading = false
  }
}

find('reload').onclick = () => { if (!acting) { message(); void load() } }
const timer = setInterval(() => { if (!document.hidden && !acting) void load() }, 2000)
window.addEventListener('pagehide', () => clearInterval(timer), { once: true })
void load()
