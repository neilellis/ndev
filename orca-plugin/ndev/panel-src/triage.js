const triageStates = {
  running: { label: 'Running', icon: '▶' },
  queued: { label: 'Queued', icon: '○' },
  done: { label: 'Done', icon: '✓' },
  blocked: { label: 'Blocked', icon: 'Ⅱ' },
  failed: { label: 'Failed', icon: '×' },
}
const triagePhases = {
  idle: 'Idle',
  grouping: 'Grouping issues',
  planned: 'Plan ready',
  running: 'Run in progress',
  done: 'Triage complete',
  cleaning: 'Reviewing issues',
  confirming: 'Awaiting decisions',
}

function triageBadge(status) {
  const { label, icon } = triageStates[status] ?? { label: status, icon: '○' }
  const badge = node('span', undefined, 'triage-badge')
  badge.dataset.state = status
  const mark = node('span', icon, 'triage-mark')
  mark.setAttribute('aria-hidden', 'true')
  badge.append(mark, label)
  return badge
}

function triageLink(label, url) {
  const link = node('a', label, 'triage-link')
  link.href = url
  link.dataset.triageFocus = url
  link.onclick = async event => {
    event.preventDefault()
    if (!event.isTrusted) return
    message()
    try {
      await orca.shell.openExternal(url)
    } catch (error) {
      message(errorText(error), true)
    }
  }
  return link
}

function triageIssues(issues) {
  const list = node('ul', undefined, 'triage-issues')
  for (const issue of issues) {
    const item = node('li')
    const link = triageLink(`#${issue.number}`, issue.url)
    if (issue.title) link.setAttribute('aria-label', `#${issue.number} ${issue.title}`)
    item.append(link)
    if (issue.title) item.append(node('span', issue.title))
    if (issue.reason) item.append(node('small', issue.reason, 'quiet'))
    list.append(item)
  }
  return list
}

function triageSummary(triage) {
  const summary = node('section', undefined, 'triage-summary')
  const heading = node('div', undefined, 'triage-summary-heading')
  heading.append(node('h2', triagePhases[triage.phase] ?? triage.phase))
  if (triage.repo) heading.append(node('span', triage.repo, 'quiet'))
  summary.append(heading)
  if (!triage.groups.length) return summary
  const issueCount = triage.groups.reduce((total, group) => total + group.issues.length, 0)
  const countLabel = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`
  const totals = [countLabel(triage.groups.length, 'group'), countLabel(issueCount, 'issue')]
  if (triage.batch) totals.push(triage.batch === 1 ? 'One group at a time' : `Up to ${triage.batch} groups at a time`)
  summary.append(node('p', totals.join(' · '), 'quiet'))
  const bar = node('div', undefined, 'triage-progress')
  bar.setAttribute('aria-hidden', 'true')
  const legend = node('ul', undefined, 'triage-legend')
  for (const [status, { label }] of Object.entries(triageStates)) {
    const count = triage.groups.filter(group => group.status === status).length
    if (count) {
      const segment = node('span')
      segment.dataset.state = status
      segment.style.flexGrow = String(count)
      bar.append(segment)
      const item = node('li')
      const badge = triageBadge(status)
      badge.lastChild.textContent = `${count} ${label.toLowerCase()}`
      item.append(badge)
      legend.append(item)
    }
  }
  summary.append(bar, legend)
  return summary
}

function triageGroup(group, data) {
  const card = node('li', undefined, 'triage-group')
  card.dataset.state = group.status
  const heading = node('div', undefined, 'triage-group-heading')
  heading.append(node('h3', group.title), triageBadge(group.status))
  card.append(heading, triageIssues(group.issues))
  if (group.after?.length) {
    const dependency = node('p', 'After ', 'triage-dependencies quiet')
    group.after.forEach((lead, index) => {
      if (index) dependency.append(', ')
      const link = node('a', `group #${lead}`)
      link.href = `#triage-group-${lead}`
      link.dataset.triageFocus = `dependency-${group.lead}-${lead}`
      dependency.append(link)
    })
    card.append(dependency)
  }
  if (group.stalled && group.status === 'running') card.append(node('p', 'Worker needs attention', 'triage-attention'))
  if (group.error) card.append(node('p', group.error, 'triage-attention'))
  const workspace = data.actions?.find(action => action.id === 'triage.workspace' && action.input.lead === group.lead)
  if (workspace || group.pr) {
    const links = node('div', undefined, 'triage-group-actions')
    if (workspace) links.append(actions({ actions: [workspace] }))
    if (group.pr) {
      const label = [`PR #${group.pr.number}`, group.pr.state].filter(Boolean).join(' · ')
      links.append(triageLink(label, group.pr.url))
    }
    card.append(links)
  }
  card.id = `triage-group-${group.lead}`
  return card
}

function triageDisclosure(title, issues) {
  const previous = find(`triage-${title}`)
  const details = node('details', undefined, 'triage-disclosure')
  details.id = `triage-${title}`
  details.open = previous?.open ?? false
  const summary = node('summary', `${title} issues (${issues.length})`)
  summary.dataset.triageFocus = details.id
  details.append(summary, triageIssues(issues))
  return details
}

function triageView(data) {
  const triage = data.triage
  const children = [triageSummary(triage)]
  const controls = data.actions?.filter(action => action.id !== 'triage.workspace') ?? []
  if (controls.length) children.push(actions({ actions: controls }))
  if (triage.groups.length) {
    const section = node('section', undefined, 'triage-groups')
    const list = node('ol')
    list.append(...triage.groups.map(group => triageGroup(group, data)))
    section.append(node('h2', 'Groups'), list)
    children.push(section)
  }
  if (triage.ungrouped.length) {
    const section = node('section', undefined, 'triage-ungrouped')
    section.append(node('h2', `Issues to group (${triage.ungrouped.length})`), triageIssues(triage.ungrouped))
    children.push(section)
  }
  if (triage.skipped.length) children.push(triageDisclosure('Skipped', triage.skipped))
  if (triage.excluded.length) children.push(triageDisclosure('Already assigned', triage.excluded))
  for (const group of data.sections ?? []) {
    if (!['Groups', 'Issues to group', 'Last activity'].includes(group.title)) children.push(rows(group))
  }
  if (triage.activity) {
    const time = new Date(triage.activity.at)
    const activity = node('p', undefined, 'triage-activity quiet')
    const stamp = node('time', time.toLocaleString())
    stamp.dateTime = time.toISOString()
    activity.append(stamp, ' · ', triage.activity.message)
    children.push(activity)
  }
  if (triage.phase === 'idle') children.push(node('p', 'No plan is saved for this worktree.', 'quiet'))
  return children
}

function paintTriage(data, sameWorktree) {
  const content = find('content')
  const focused = sameWorktree && content.contains(document.activeElement) && document.activeElement.dataset.triageFocus
  const children = triageView(data)
  content.replaceChildren(...children)
  if (focused) {
    const target = [...content.querySelectorAll('[data-triage-focus]')].find(item => item.dataset.triageFocus === focused)
    target?.focus({ preventScroll: true })
  }
  let announcement = find('triage-status')
  if (!announcement) {
    announcement = node('p', undefined, 'triage-screen-reader')
    announcement.id = 'triage-status'
    announcement.setAttribute('role', 'status')
    content.before(announcement)
  }
  const counts = [...content.querySelectorAll('.triage-legend .triage-badge')].map(badge => badge.lastChild.textContent)
  const status = [triagePhases[data.triage.phase], ...counts].join(', ')
  if (announcement.textContent !== status) announcement.textContent = status
}
