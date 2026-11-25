import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { availableParallelism, loadavg, platform } from 'node:os'
import { argsFor, atomicJson, checked, CliError, gitWorkspace, locked, readObject, releaseRoot, run, stateRoot } from './common.mjs'
import { confirmPanelAction, publishPanel, renderPanel } from './panes.mjs'
import { readProject } from './project.mjs'

const idle = () => ({ schemaVersion: 1, revision: 0, phase: 'idle', issues: [], groups: [], log: [] })
function location(root, env) {
  const key = createHash('sha256').update(root).digest('hex')
  return join(stateRoot(env), 'triage', key + '.json')
}
function read(root, env) {
  const file = location(root, env)
  const state = readObject(file, { missing: idle() })
  if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || !Array.isArray(state.issues) || !Array.isArray(state.groups)) throw new CliError(1, `Invalid triage state in ${file}.`)
  return state
}
function save(root, state, env) {
  const file = location(root, env)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  locked(file, () => {
    const seen = read(root, env).revision
    if (state.revision !== seen) throw new CliError(5, `Triage revision ${state.revision} is stale. Current revision is ${seen}.`, { repair: 'ndev triage status' })
    state.revision++
    atomicJson(file, state)
  })
}

const bool = { type: 'boolean' }
const str = { type: 'string' }
const sizes = {
  claude: { 'very-simple': ['claude-haiku-5-5', 'medium'], simple: ['claude-haiku-5-5', 'xhigh'], average: ['claude-sonnet-5-5', 'medium'], complex: ['claude-opus-5-5', 'high'], 'very-complex': ['claude-fable-5-1', 'high'] },
  codex: { 'very-simple': ['gpt-6-luna', 'medium'], simple: ['gpt-6-luna', 'xhigh'], average: ['gpt-6.1-terra', 'medium'], complex: ['gpt-6.1-sol', 'high'], 'very-complex': ['gpt-6.1-sol', 'xhigh'] },
}
const pollMs = 10 * 60_000
const nonempty = v => typeof v === 'string' && Boolean(v.trim())
const object = v => v && typeof v === 'object' && !Array.isArray(v)
const positive = v => Number.isSafeInteger(v) && v > 0
const input = message => new CliError(2, message, { repair: 'ndev triage --help' })
const failure = (message, details) => new CliError(1, message, { details, repair: 'ndev triage status' })
function integer(value, label) {
  if (!/^[1-9]\d*$/.test(value) || !positive(Number(value))) throw input(`Invalid ${label}: ${value}`)
  return Number(value)
}
function payload(name) {
  if (!nonempty(name)) throw input('Provide a JSON file with --file <path> or --file -.')
  try { return JSON.parse(readFileSync(name === '-' ? 0 : name, 'utf8')) }
  catch (error) { throw input(`Cannot read JSON from ${name}: ${error.message}`) }
}
function parsed(source, text) {
  try { return JSON.parse(text) } catch (error) { throw failure(`${source} returned invalid JSON: ${error.message}`, { output: text.slice(0, 250) }) }
}
function gh(root, repo, argv, env = {}) {
  return checked('bash', [process.env.NDEV_FLOW_GH || join(releaseRoot, 'scripts/github/gh.sh'), ...argv], {
    cwd: root, env: { ...process.env, GH_REPO: repo, ...env }, timeout: 120_000, repair: 'Check gh auth status and the repository settings.',
  })
}
const lines = output => output.split('\n').filter(Boolean).map(line => parsed('GitHub', line))
const localHost = () => process.env.ORCA_ENVIRONMENT || (process.env.ORCA_PAIRING_CODE ? '' : 'local')
function orca(root, host, argv, sender) {
  const env = { ...process.env }
  if (sender) {
    env.ORCA_TERMINAL_HANDLE = sender
    delete env.ORCA_AGENT_SESSION_ID
    delete env.ORCA_PANE_KEY
  }
  const result = run(env.ORCA_CLI_COMMAND || 'orca', [...argv, ...(host ? ['--environment', host] : []), '--json'], { cwd: root, env, timeout: 180_000 })
  let envelope
  try { envelope = JSON.parse(result.stdout) } catch {}
  if (result.status || envelope?.ok !== true || !envelope.result) {
    const reason = [envelope?.error?.message, envelope?.result?.lastError, envelope?.result?.failedStage, envelope?.result?.recovery, result.stderr.trim(), !envelope && result.stdout.trim()].filter(Boolean).join(' · ')
    throw failure(`orca ${argv.slice(0, 2).join(' ')} exited ${result.status}: ${reason || 'no result'}`, { receipt: envelope, exitCode: result.status })
  }
  return envelope.result
}
function note(state, message) {
  state.log = [...state.log, { at: Date.now(), message }].slice(-60)
}
function expectPhase(state, allowed) {
  if (!allowed.includes(state.phase)) throw failure(`Triage is ${state.phase}. This command needs ${allowed.join(' or ')}.`)
}
function workspaces(root, state) {
  const hosts = [...new Set([state.host, ...(state.remote ? [state.remote.id] : [])])]
  return hosts.flatMap(host => {
    const listing = orca(root, host, ['worktree', 'list', '--limit', '1000'])
    if (listing.truncated || !Array.isArray(listing.worktrees)) throw failure(`Orca returned an incomplete worktree list for ${host || 'paired host'}.`, listing)
    return listing.worktrees.filter(w => !w.isArchived && w.projectId?.toLowerCase() === 'github:' + state.repo.toLowerCase()).map(w => ({ ...w, host }))
  })
}
function activeIssues(root, spaces) {
  const keys = new Set(spaces.flatMap(w => (w.linkedItems || []).filter(link => link.type === 'issue').map(link => link.number)))
  const paths = checked('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: root }).split('\0').filter(line => line.startsWith('worktree ')).map(line => line.slice(9))
  for (const path of paths) {
    for (const name of readdirSync(path).filter(name => /^\.neil-dev\.(issue|epic)-[1-9]\d*\.json$/.test(name))) {
      const data = readObject(join(path, name))
      if (name.includes('.issue-')) {
        if (data.workflow && !data.workflow.off && data.workflow.state !== 'done') keys.add(data.issue)
      } else {
        const epic = object(data.epic) ? data.epic : data
        if (epic.state && epic.state !== 'done') {
          keys.add(epic.epic ?? epic.issue)
          for (const child of Object.values(epic.issues || {})) keys.add(child.issue || child.number)
        }
      }
    }
  }
  return keys
}
function issuesFor(root, state, board, clean) {
  const filters = state.options
  let issues
  if (board && !filters.open && !clean) {
    const cards = lines(gh(root, state.repo, ['board', 'items'], { GH_PROJECT_OWNER: board.owner, GH_PROJECT_NUMBER: String(board.number) }))
    const login = filters.mine ? parsed('gh api user', gh(root, state.repo, ['api', 'user'])).login : undefined
    if (filters.mine && !login) throw failure('GitHub returned no login for --mine.')
    const prefix = `https://github.com/${state.repo}/issues/`.toLowerCase()
    issues = cards.filter(c => ['Ready', 'In progress'].includes(c.status) && c.url?.toLowerCase().startsWith(prefix) && (!login || (c.author?.login || c.author || '').toLowerCase() === login.toLowerCase()))
  } else {
    const qualifiers = clean ? [filters.reverse ? 'sort:created-desc' : 'sort:created-asc'] : ['-linked:pr']
    if (filters.mine) qualifiers.push('author:@me')
    if (filters.since) {
      const issue = parsed('gh api', gh(root, state.repo, ['api', `repos/${state.repo}/issues/${filters.since}`]))
      if (!issue.created_at) throw failure(`GitHub returned no opening date for #${filters.since}.`)
      qualifiers.push('created:>=' + issue.created_at)
    }
    issues = lines(gh(root, state.repo, ['issue-search', qualifiers.join(' '), '--limit', String(filters.since ? 202 : 201)]))
  }
  if (issues.some(issue => !positive(issue.number) || !nonempty(issue.title))) throw failure(`GitHub returned an invalid issue for ${state.repo}.`)
  issues = issues.filter(issue => issue.number > (filters.since || 0))
  if (!clean && issues.length > 200) throw failure(`More than 200 issues match ${state.repo}. Narrow the selection with --since or the project board.`)
  const ordered = issues.sort((a, b) => (filters.reverse ? -1 : 1) * (a.number - b.number))
  if (ordered.length > 200) note(state, 'Clean covers the first 200 matching issues. Run it again with --since to cover the rest.')
  return ordered.slice(0, 200)
}

function groupsFor(state, report) {
  if (!object(report) || !Array.isArray(report.groups)) throw input('Supply {groups:[{issues,title,complexity,hint,after?}],screened?,skipped?}.')
  const known = new Set(state.issues.map(i => i.number))
  const seen = new Set()
  function include(n) {
    if (!positive(n) || !known.has(n)) throw input(`Unknown issue #${n}.`)
    if (seen.has(n)) throw input(`Issue #${n} appears twice in the partition.`)
    seen.add(n)
  }
  const groups = report.groups.map(g => {
    if (!object(g) || !Array.isArray(g.issues) || !g.issues.length || !nonempty(g.title) || !Object.hasOwn(sizes[state.agent], g.complexity)) throw input('Each group needs issues, title and a supported complexity.')
    if (g.implemented && !nonempty(g.evidence)) throw input(`Group #${g.issues[0]} claims implementation without evidence.`)
    if (g.after !== undefined && (!Array.isArray(g.after) || !g.after.every(positive))) throw input(`Group #${g.issues[0]} needs numeric group leads in after.`)
    for (const n of g.issues) include(n)
    const [model, effort] = sizes[state.agent][g.complexity]
    return { lead: Math.min(...g.issues), issues: [...g.issues].sort((a, b) => a - b), title: g.title.trim(), complexity: g.complexity, hint: g.hint || '', implemented: g.implemented === true, evidence: g.evidence, after: [...new Set(g.after || [])], status: 'queued', model, effort }
  })
  const screened = report.screened || []
  const skipped = report.skipped || []
  if (!Array.isArray(screened) || !Array.isArray(skipped)) throw input('screened and skipped must be lists.')
  if (screened.length && !state.options['bugs-only']) throw input('screened requires --bugs-only.')
  for (const item of screened) {
    if (!object(item) || !['enhancement', 'proposal', 'human', 'other'].includes(item.kind) || !nonempty(item.reason)) throw input('Each screened issue needs a kind and reason.')
    include(item.issue)
  }
  for (const item of skipped) {
    if (!object(item) || !nonempty(item.reason)) throw input('Each skipped issue needs a reason.')
    include(item.issue)
  }
  if (report.closed?.length) throw input('Use ndev triage clean and confirm to close an issue. Grouping requires a partition of the open issues.')
  const missing = [...known].filter(n => !seen.has(n))
  if (missing.length) throw input(`No group or decision covers ${missing.map(n => '#' + n).join(', ')}.`)
  const ordered = []
  const completed = new Set()
  function visit(g, path = []) {
    if (completed.has(g.lead)) return
    if (path.includes(g.lead)) throw input(`Dependency cycle at #${g.lead}: ${[...path, g.lead].join(' → ')}.`)
    for (const predecessor of g.after) {
      const prior = groups.find(candidate => candidate.lead === predecessor)
      if (!prior) throw input(`Group #${g.lead} follows unknown lead #${predecessor}.`)
      visit(prior, [...path, g.lead])
    }
    completed.add(g.lead)
    ordered.push(g)
  }
  for (const group of groups.sort((a, b) => (state.options.reverse ? -1 : 1) * (a.lead - b.lead))) visit(group)
  return { groups: ordered, screened, skipped }
}

const issueFields = `fragment Facts on Issue {
  number title url body
  labels(first:20) { nodes { name } }
  comments(last:5) { nodes { author { login } body createdAt } }
  subIssues(first:50) { nodes { number title state } }
  parent { number state }
  closedByPullRequestsReferences(first:10,includeClosedPrs:true) { nodes { number title state mergedAt changedFiles headRefName } }
  timelineItems(first:50,itemTypes:[CROSS_REFERENCED_EVENT]) { nodes { ... on CrossReferencedEvent { willCloseTarget source { __typename ... on PullRequest { number title state mergedAt } ... on Issue { number title state } } } } }
}`
function cleanFacts(root, state, spaces) {
  if (!state.issues.length) return []
  const [owner, name] = state.repo.split('/')
  const base = parsed('gh default-branch', gh(root, state.repo, ['default-branch'])).default_branch
  if (!nonempty(base)) throw failure(`Missing default branch for ${state.repo}.`)
  const pulls = lines(gh(root, state.repo, ['pr-search', 'sort:updated-desc', '--limit', '300']))
  checked('git', ['fetch', 'origin', base], { cwd: root, timeout: 120_000 })
  const commits = checked('git', ['log', 'FETCH_HEAD', '-n', '3000', '--format=%h%x1f%s%x1f%b%x1e'], { cwd: root }).split('\x1e').map(c => c.trim()).filter(Boolean)
  const facts = []
  for (let index = 0; index < state.issues.length; index += 20) {
    const batch = state.issues.slice(index, index + 20)
    const selectors = batch.map(i => `i${i.number}: issue(number:${i.number}) { ...Facts }`).join(' ')
    const query = `query($owner:String!,$name:String!) { repository(owner:$owner,name:$name) { ${selectors} } } ${issueFields}`
    const response = parsed('gh graphql', gh(root, state.repo, ['api', 'graphql', '-f', 'owner=' + owner, '-f', 'name=' + name, '-f', 'query=' + query]))
    for (const item of batch) {
      const factsForIssue = response?.data?.repository?.['i' + item.number]
      if (!factsForIssue || response.errors?.length) throw failure(`GraphQL returned no evidence for #${item.number}.`, response.errors)
      const reference = new RegExp('#' + item.number + '(?![0-9])')
      facts.push({ ...factsForIssue, workspaces: spaces.filter(space => space.linkedItems?.some(link => link.type === 'issue' && link.number === item.number)).map(space => ({ id: space.id, host: space.host, pr: space.linkedPR })), namingPrs: pulls.filter(p => reference.test(p.title + '\n' + (p.body || ''))).map(({ number, title, state, merged }) => ({ number, title, state, merged })), commits: commits.filter(commit => reference.test(commit)).map(commit => commit.split('\x1f').slice(0, 2).join(' ')) })
    }
  }
  return facts
}
function verdictsFor(state, report) {
  if (!Array.isArray(report?.verdicts)) throw input('Supply {verdicts:[{issue,verdict,confidence,evidence,by?}]}.')
  const expected = new Set(state.facts.slice(state.offset, state.offset + 10).map(i => i.number))
  const seen = new Set()
  const problems = []
  for (const item of report.verdicts) {
    if (!object(item) || !expected.has(item.issue)) { problems.push(`Unknown issue #${item?.issue} in this chunk.`); continue }
    if (seen.has(item.issue)) problems.push(`#${item.issue} has two verdicts.`)
    seen.add(item.issue)
    if (!['done', 'outdated', 'superseded', 'duplicate', 'needs_work'].includes(item.verdict)) problems.push(`Invalid verdict for #${item.issue}.`)
    if (!['low', 'medium', 'high'].includes(item.confidence)) problems.push(`Invalid confidence for #${item.issue}.`)
    if (item.verdict !== 'needs_work' && (!nonempty(item.evidence) || !/#\d+|\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b|[\w./-]+\.\w+:\d+/.test(item.evidence))) problems.push(`#${item.issue} needs evidence naming a commit, PR, issue or file:line.`)
    if (['superseded', 'duplicate'].includes(item.verdict) && (!positive(item.by) || item.issue === item.by)) problems.push(`#${item.issue} needs a distinct positive by number.`)
  }
  for (const n of expected) if (!seen.has(n)) problems.push(`#${n} has no verdict.`)
  if (problems.length) throw input(problems.join('\n'))
  return report.verdicts.map(({ issue, verdict, confidence, evidence, by }) => ({ issue, verdict, confidence, evidence, by, ...(verdict !== 'needs_work' && confidence !== 'low' ? { decision: 'pending' } : { decision: 'keep' }) }))
}
const cleanChunk = state => state.phase === 'cleaning' ? state.facts.slice(state.offset, state.offset + 10) : undefined

function triageData(state) {
  const chunk = cleanChunk(state)
  const pending = (state.verdicts || []).filter(v => v.decision === 'pending')
  const sections = []
  const section = (title, rows) => { if (rows.length) sections.push({ title, rows }) }
  if (state.phase === 'grouping') section('Issues to group', state.issues.map(i => ({ label: '#' + i.number, value: i.title })))
  if (state.admission?.reason) section('Admission', [{ label: 'Waiting for host capacity', value: state.admission.reason }])
  section('Groups', state.groups.map(g => ({ label: g.issues.map(n => '#' + n).join(', '), value: [g.title, g.status, g.pr && 'PR #' + g.pr, g.error, g.stalled && 'Worker needs attention'].filter(Boolean).join(' · ') })))
  section('Clean evidence', (chunk || []).map(i => ({ label: '#' + i.number, value: JSON.stringify(i) })))
  section('Clean decisions', (state.verdicts || []).map(v => ({ label: '#' + v.issue, value: [v.verdict, v.confidence, v.evidence, v.decision].filter(Boolean).join(' · ') })))
  section('Questions', (state.questions || []).map(q => ({ label: q.from || q.id, value: q.body })))
  const activity = state.log.at(-1)
  if (activity) section('Last activity', [{ label: new Date(activity.at).toISOString(), value: activity.message }])
  const actions = []
  if (state.phase === 'planned') actions.push({ id: 'triage.launch', label: 'Launch plan', input: {} })
  if (state.runId && ['running', 'done'].includes(state.phase)) actions.push({ id: 'triage.refresh', label: 'Refresh run', input: {} })
  for (const v of pending) for (const decision of ['keep', 'close']) actions.push({ id: 'triage.confirm', label: `${decision === 'close' ? 'Close' : 'Keep'} #${v.issue}`, input: { issue: v.issue, revision: state.revision, decision } })
  const progress = state.groups.length && `${state.groups.filter(group => group.status === 'done').length} of ${state.groups.length} groups done`
  const status = [state.repo, state.phase, state.runId && 'Run ' + state.runId, progress].filter(Boolean).join(' · ')
  const issues = new Map(state.issues.map(issue => [issue.number, issue]))
  const issueLink = number => ({
    number,
    title: issues.get(number)?.title,
    url: `https://github.com/${state.repo}/issues/${number}`,
  })
  const groups = state.groups.map(group => {
    const workspace = nonempty(group.worktree)
      ? { id: group.worktree, host: group.workerHost || state.remote?.id || state.host }
      : undefined
    if (workspace) actions.push({ id: 'triage.workspace', label: 'Open workspace', input: { lead: group.lead } })
    return {
      lead: group.lead,
      title: group.title,
      status: group.status,
      issues: group.issues.map(issueLink),
      after: group.after,
      stalled: group.stalled,
      error: group.error,
      workspace,
      pr: group.pr ? { number: group.pr, url: `https://github.com/${state.repo}/pull/${group.pr}`, state: group.prState } : undefined,
    }
  })
  const triage = {
    revision: state.revision,
    phase: state.phase,
    repo: state.repo,
    batch: state.batch,
    activity,
    groups,
    ungrouped: state.phase === 'grouping' ? state.issues.map(issue => issueLink(issue.number)) : [],
    skipped: [...(state.skipped || []), ...(state.screened || [])].map(item => ({ ...issueLink(item.issue), reason: item.reason })),
    excluded: (state.excluded || []).map(issueLink),
  }
  return { title: 'Triage', status, sections, actions, triage }
}

export function readTriagePanel(root, env) {
  const state = read(root, env)
  restoreRejectedRun(root, state, env)
  return triageData(state)
}

async function view(root, state) {
  const chunk = cleanChunk(state)
  const data = triageData(state)
  const panel = await publishPanel('triage', data, { cwd: root })
  const nextAction = state.phase === 'grouping' ? 'Submit a full partition with ndev triage groups --file <json>.' : state.phase === 'cleaning' ? 'Submit a verdict for each issue in this chunk with ndev triage clean-verdicts --file <json>.' : undefined
  const { facts, ...result } = state
  return { ...result, root, chunk, nextAction, worktreeId: panel.worktreeId, text: [renderPanel(data), nextAction].filter(Boolean).join('\n') }
}

function workerSpec(state, group) {
  const issues = group.issues.map(n => `#${n} (https://github.com/${state.repo}/issues/${n})`).join(', ')
  return [
    `Implement ${issues} on one draft PR in ${state.repo}. ${group.title}.`,
    group.hint, state.options.hint, group.evidence && `Verify the existing implementation against ${group.evidence}.`,
    `Start each issue with ndev flow start in this worktree. Set steering to auto with the coordinator as the contact. Develop test first and checkpoint each change. A human merges unless the project permits an agent merge.`,
    group.after.length && `This work follows ${group.after.map(n => '#' + n).join(', ')}. Review the predecessor PRs and retarget after they merge.`,
    `Record Model: ${group.model} and Effort: ${group.effort} in the PR. Report the PR and check status to the coordinator. Ask through orca orchestration ask when a human decision is needed.`,
  ].filter(Boolean).join('\n')
}
function recordedRequest(operation) {
  const receipt = operation?.receipt
  return operation?.requestId || receipt?.error?.data?.orchestrationRequestId || receipt?.error?.data?.requestId ||
    receipt?.requestId || receipt?.result?.requestId
}

function mutation(root, state, key, argv, readReceipt, workerHost) {
  state.operations ||= {}
  const prior = state.operations[key]
  if (prior?.complete) return prior.result
  const retryId = recordedRequest(prior)
  if (prior && !retryId) throw failure(`Run ${state.runId || '(pending)'}: the outcome of ${key} is uncertain. Inspect the earlier Orca receipt before retrying.`, prior)
  if (retryId) {
    const receipt = orca(root, state.host, ['orchestration', 'request-show', '--request', retryId, ...(workerHost ? ['--on', workerHost] : []), '--full'], state.coordinatorTerminal)
    if ((receipt.status ?? receipt.state) === 'absent') throw failure(`Orca lost receipt ${retryId} for ${key}. Inspect the Run before retrying.`, receipt)
    argv.push('--retry-request', retryId)
  }
  state.operations[key] = { ...prior, startedAt: Date.now() }
  save(root, state)
  try {
    const receipt = orca(root, state.host, argv, state.coordinatorTerminal)
    const result = readReceipt(receipt)
    state.operations[key] = { complete: true, result }
    save(root, state)
    return result
  } catch (error) {
    const receipt = error.details?.receipt
    const requestId = recordedRequest({ receipt })
    state.operations[key] = { ...state.operations[key], requestId, error: error.message, receipt }
    save(root, state)
    throw error
  }
}
function launchedWorktree(receipt) {
  return receipt?.effects?.find(effect => effect.kind === 'worktree')?.id ??
    receipt?.worktree?.id ?? receipt?.worktreeId ?? receipt?.worktree
}

function restoreRejectedRun(root, state, env) {
  const run = state.operations?.run
  if (state.runId || !['planned', 'running'].includes(state.phase) || run?.complete || recordedRequest(run) ||
    run?.receipt?.error?.code !== 'no_active_sender_terminal') return false
  delete state.operations.run
  delete state.coordinatorTerminal
  state.phase = 'planned'
  note(state, 'Orca rejected launch before creating a run. The saved plan is ready to launch again.')
  save(root, state, env)
  return true
}

function verifyRetry(root, state, group, previousDispatch = group.dispatchId) {
  const workers = []
  const cursors = new Set()
  let cursor
  do {
    const listing = orca(root, state.host, ['orchestration', 'worker-list', '--run', state.runId, '--include-remote', '--limit', '100', ...(cursor ? ['--cursor', cursor] : []), '--full'])
    if (!Array.isArray(listing.workers) || listing.truncated || listing.errors?.length || listing.remoteErrors?.length) throw failure(`Cannot verify all attempts of Task ${group.taskId} before retrying Dispatch ${previousDispatch}.`, listing)
    if (listing.scope?.run && listing.scope.run !== state.runId) throw failure(`Orca returned workers for Run ${listing.scope.run}, expected ${state.runId}.`)
    workers.push(...listing.workers.filter(worker => worker.taskId === group.taskId))
    if (!object(listing.page) || typeof listing.page.hasMore !== 'boolean') throw failure(`Orca returned incomplete worker pagination for Run ${state.runId}.`, listing)
    cursor = listing.page.nextCursor
    if (listing.page.hasMore) {
      if (!nonempty(cursor) || cursors.has(cursor)) throw failure(`Orca repeated or returned an invalid worker cursor for Run ${state.runId}.`)
      cursors.add(cursor)
    } else {
      if (cursor != null) throw failure(`Orca returned a worker cursor with hasMore=false for Run ${state.runId}.`)
      cursor = undefined
    }
  } while (cursor)
  const missing = !workers.some(worker => worker.dispatchId === previousDispatch)
  const unsafe = workers.find(worker => worker.projection?.liveness?.verdict !== 'exited' || worker.terminalState !== 'released')
  if (missing || unsafe) {
    const dispatch = unsafe?.dispatchId || previousDispatch
    throw new CliError(1, `Task ${group.taskId}: cannot retry Dispatch ${dispatch}; liveness ${unsafe?.projection?.liveness?.verdict || 'unverifiable'}, terminal ${unsafe?.terminalState || 'unobserved'}. The previous worker is not proven exited and released.`, {
      repair: `Run orca orchestration worker-show --dispatch ${dispatch} --json and follow its recovery. A failed state, stop_unknown or release_unknown does not prove exit. Preserve the worker; do not start a successor or close its terminal.`,
    })
  }
}

function admission(state) {
  if (state.remote || state.host !== 'local' || platform() === 'win32') return { capacity: 1 }
  const load = loadavg()[0]
  const cores = availableParallelism()
  if (!Number.isFinite(load) || load < 0 || !positive(cores)) throw failure(`Cannot read local host load: load=${load}, cores=${cores}.`)
  return { capacity: state.batch, ...(load > cores && { reason: `Host load ${load} exceeds ${cores} CPU cores. No new worker starts. Run ndev triage launch after the host load falls.` }) }
}

function launch(root, state, retry = false, panelLaunch = false) {
  restoreRejectedRun(root, state)
  const failed = state.groups.filter(group => group.status === 'failed')
  expectPhase(state, retry && failed.length ? ['planned', 'running', 'done'] : ['planned', 'running'])
  if (retry && failed.length) {
    for (const group of failed) if (group.dispatchId && !recordedRequest(state.operations?.['worker-' + group.lead])) verifyRetry(root, state, group)
    state.phase = 'running'
    for (const group of failed) {
      const key = 'worker-' + group.lead
      const operation = state.operations?.[key]
      if (!recordedRequest(operation) && group.dispatchId) {
        group.previousDispatch = group.dispatchId
        delete group.dispatchId
        delete state.operations[key]
      }
      group.status = 'queued'
      delete group.error
      delete group.stalled
    }
    save(root, state)
  }
  if (panelLaunch && !state.runId && !state.coordinatorTerminal && !state.operations?.run) {
    const { terminal } = orca(root, state.host, ['terminal', 'create', '--worktree', 'path:' + root, '--title', 'Triage coordinator'])
    if (!nonempty(terminal?.handle)) throw failure('Orca created no usable terminal handle for the Triage coordinator.', { terminal })
    state.coordinatorTerminal = terminal.handle
    save(root, state)
  }
  if (!state.runId) {
    try {
      state.runId = mutation(root, state, 'run', ['orchestration', 'run-create', '--objective', `Triage ${state.repo}: ${state.groups.length} groups`, '--full'], r => {
        if (!nonempty(r.run?.id)) throw failure('Orca returned no Run ID.', r)
        return r.run.id
      })
    } catch (error) {
      if (!restoreRejectedRun(root, state)) throw error
      throw new CliError(1, error.message, {
        details: error.details,
        repair: 'Retry Launch plan in Orca, or run ndev triage launch from a live Orca terminal in this workspace.',
      })
    }
    state.phase = 'running'
    note(state, `Created Orca Run ${state.runId} for the saved plan.`)
    save(root, state)
  }
  if (state.options['bugs-only']) {
    const labels = [...state.groups.flatMap(g => g.issues.map(n => [n, 'bug'])), ...(state.screened || []).filter(s => ['enhancement', 'proposal'].includes(s.kind)).map(s => [s.issue, s.kind === 'proposal' ? 'proposed' : 'enhancement'])]
    for (const [n, label] of labels) {
      state.labels ||= []
      const key = n + '/' + label
      if (state.labels.includes(key)) continue
      gh(root, state.repo, ['label', String(n), label])
      state.labels.push(key)
      save(root, state)
    }
  }
  for (const g of state.groups) {
    if (g.taskId) continue
    const deps = g.after.map(n => state.groups.find(x => x.lead === n).taskId)
    const cmd = ['orchestration', 'task-create', '--run', state.runId, '--task-title', g.title, '--display-name', 'issue-' + g.lead, '--spec', workerSpec(state, g), ...(deps.length ? ['--deps', JSON.stringify(deps)] : []), '--full']
    g.taskId = mutation(root, state, 'task-' + g.lead, cmd, r => {
      if (!nonempty(r.task?.id)) throw failure(`Orca returned no task ID for #${g.lead}.`, r)
      return r.task.id
    })
    save(root, state)
  }
  const spaces = workspaces(root, state)
  const active = activeIssues(root, spaces)
  for (const g of state.groups) {
    const dependencies = g.after.map(lead => state.groups.find(group => group.lead === lead))
    const impeded = dependencies.some(group => ['failed', 'blocked'].includes(group.status))
    if (g.status === 'blocked' && (g.blockReason === 'dependency' || g.error === 'A predecessor failed.') && !impeded) {
      g.status = 'queued'
      delete g.blockReason
      delete g.error
    }
    if (g.status !== 'queued') continue
    const admitted = admission(state)
    if (admitted.reason) {
      state.admission = admitted
      note(state, admitted.reason)
      save(root, state)
      break
    }
    delete state.admission
    if (state.groups.filter(group => group.status === 'running').length >= admitted.capacity) continue
    if (impeded) {
      Object.assign(g, { status: 'blocked', blockReason: 'dependency', error: 'A predecessor failed.' })
      save(root, state)
      continue
    }
    if (dependencies.some(group => group.status !== 'done')) continue
    if (!g.previousDispatch && !state.operations?.['worker-' + g.lead] && g.issues.some(n => active.has(n))) {
      g.status = 'blocked'
      g.blockReason = 'ownership'
      g.error = 'An existing workspace or workflow already owns this issue.'
      save(root, state)
      continue
    }
    if (g.previousDispatch && !state.operations?.['worker-' + g.lead]) verifyRetry(root, state, g, g.previousDispatch)
    const reference = dependencies.find(group => group.prHead && group.prState === 'open')
    const cmd = ['orchestration', 'worker-start', '--task', g.taskId, '--run', state.runId, ...(state.remote ? ['--on', state.remote.id] : []), '--worktree', 'new-top-level', '--repo', state.remote?.repoSelector || 'path:' + state.main, '--name', `issue-${g.lead}`, '--agent', state.agent, '--model', g.model, '--effort', g.effort, ...(reference ? ['--base-branch', reference.prHead] : []), ...(g.previousDispatch ? ['--retry-of', g.previousDispatch] : []), '--full']
    try {
      const worker = mutation(root, state, 'worker-' + g.lead, cmd, r => {
        if (r.state !== 'ready' || !nonempty(r.dispatchId)) throw failure(`Orca worker for #${g.lead} failed: ${r.lastError || r.state} at ${r.failedStage || 'unknown stage'}.`, { receipt: { result: r } })
        return r
      }, state.remote?.id)
      Object.assign(g, { status: 'running', dispatchId: worker.dispatchId, worktree: launchedWorktree(worker), lastActivity: Date.now(), startedAt: Date.now(), workerHost: state.remote?.id || state.host })
      note(state, `Worker ${g.dispatchId} started for #${g.lead}.`)
      save(root, state)
    } catch (error) {
      const receipt = error.details?.receipt?.result
      g.status = 'failed'
      g.error = error.message
      if (receipt?.dispatchId) {
        g.dispatchId = receipt.dispatchId
        const verdict = receipt.projection?.liveness?.verdict
        if (verdict !== 'exited') {
          g.status = 'running'
          g.stalled = true
          g.lifecycleConflict = true
          g.error += ` Dispatch ${g.dispatchId} has liveness ${verdict || 'unverifiable'}; inspect orca orchestration worker-show --dispatch ${g.dispatchId} --json before recovery.`
        }
      }
      const worktree = launchedWorktree(receipt)
      if (nonempty(worktree)) {
        g.worktree = worktree
        g.workerHost = state.remote?.id || state.host
      }
      note(state, `Group #${g.lead}: ${error.message}`)
      save(root, state)
      throw failure(`Run ${state.runId} stopped launching at #${g.lead}: ${error.message}`, { runId: state.runId, group: g, receipt })
    }
  }
  if (state.groups.every(g => ['done', 'failed', 'blocked'].includes(g.status))) state.phase = 'done'
  state.nextCheckAt = Date.now() + pollMs
  save(root, state)
}

function refresh(root, state) {
  expectPhase(state, ['running', 'done'])
  if (!state.runId) throw failure('No Orca Run is recorded for this triage.')
  const spaces = workspaces(root, state)
  const taskList = orca(root, state.host, ['orchestration', 'task-list', '--run', state.runId])
  if (!Array.isArray(taskList.tasks)) throw failure(`Run ${state.runId} has no task list in its receipt.`, taskList)
  const inbox = orca(root, state.host, ['orchestration', 'inbox', '--limit', '100', '--full'])
  if (!Array.isArray(inbox.messages)) throw failure(`Orca inbox returned no message list for Run ${state.runId}.`, inbox)
  const messages = inbox.messages.filter(message => (message.run_id ?? message.runId) === state.runId)
  state.questions = messages.filter(question => {
    if ((question.type ?? question.kind) !== 'question' || question.answeredAt || question.reply || question.repliedAt) return false
    return !messages.some(reply => reply.type === 'status' && reply.thread_id && reply.thread_id === question.thread_id &&
      reply.from_handle === question.to_handle && reply.to_handle === question.from_handle)
  }).map(message => ({ id: message.id, from: message.from_handle ?? message.from, body: message.body ?? message.question }))
  for (const g of state.groups) {
    if (!g.dispatchId || !['running', 'done'].includes(g.status)) continue
    const receipt = orca(root, state.host, ['orchestration', 'worker-show', '--dispatch', g.dispatchId, '--full'])
    const task = taskList.tasks.find(t => t.id === g.taskId)
    const host = g.workerHost || state.remote?.id || state.host
    const worktree = receipt.worker?.worktreeId ?? receipt.projection?.workspace?.id ?? g.worktree
    const matches = spaces.filter(w => w.host === host && (worktree
      ? w.id === worktree
      : w.linkedItems?.some(link => link.type === 'issue' && g.issues.includes(link.number))))
    const space = matches.length === 1 ? matches[0] : undefined
    if (space || worktree) {
      g.worktree = space?.id ?? worktree
      g.workerHost = host
    }
    const prNumber = space?.linkedPR || receipt.pr || g.pr
    const before = g.status
    const activity = Date.parse(receipt.worker?.updatedAt ?? receipt.updatedAt ?? '') || Number(receipt.lastActivityAt) || g.lastActivity
    if (activity) g.lastActivity = activity
    if (g.lifecycleConflict) {
      delete g.lifecycleConflict
      delete g.error
      delete g.stalled
    }
    const workerStates = [receipt.dispatch?.status, receipt.worker?.state, receipt.state]
    if (['complete', 'completed', 'done', 'succeeded'].includes(task?.status) || workerStates.some(status => ['completed', 'done', 'succeeded', 'finished'].includes(status))) g.status = 'done'
    else if (['failed', 'cancelled', 'blocked'].includes(task?.status) || workerStates.some(status => ['failed', 'cancelled', 'lost', 'abandoned', 'stopped'].includes(status))) {
      const verdict = receipt.projection?.liveness?.verdict
      const detail = receipt.worker?.lastError || receipt.lastError || [...workerStates, task?.status].filter(Boolean).join(', ')
      if (verdict === 'exited') {
        g.status = 'failed'
        g.error = detail
        delete g.lifecycleConflict
      } else {
        g.status = 'running'
        g.stalled = true
        g.lifecycleConflict = true
        g.error = `Dispatch ${g.dispatchId}: ${detail}; liveness ${verdict || 'unverifiable'}. Inspect orca orchestration worker-show --dispatch ${g.dispatchId} --json before any recovery.`
      }
    }
    if (before !== g.status) { g.lastActivity = Date.now(); note(state, `#${g.lead} is ${g.status}.`) }
    if (g.status === 'running' && !g.stalled && (receipt.projection?.liveness?.verdict === 'exited' || Date.now() - g.lastActivity >= 30 * 60_000)) {
      g.stalled = true
      note(state, `Worker ${g.dispatchId} on #${g.lead} needs attention. Inspect its task and last output.`)
    }
    if (prNumber) {
      const pr = parsed('gh pr-read', gh(root, state.repo, ['pr-read', String(prNumber)]))
      g.pr = prNumber
      g.prHead = pr.head?.ref
      g.prSha = pr.head?.sha
      g.prState = pr.merged ? 'merged' : pr.state
      g.prMergeable = pr.mergeable
    }
  }
  save(root, state)
  if (state.phase === 'running') launch(root, state)
}
async function begin(root, old, argv, clean) {
  expectPhase(old, ['idle', 'done'])
  const flags = { since: str, reverse: bool, mine: bool, hint: str, ...(!clean && { 'dry-run': bool, codex: bool, open: bool, batch: str, sequential: bool, 'bugs-only': bool, remote: str }) }
  const args = argv.flatMap((value, index) => value === '--remote' && (!argv[index + 1] || argv[index + 1].startsWith('--')) ? ['--remote='] : [value])
  const { values: options } = argsFor(args, flags, `ndev triage ${clean ? 'clean' : 'start'} --help`)
  const config = readProject(root)
  const repo = config.github?.repo
  if (!repo) throw failure('Triage requires a GitHub repository. Run ndev project setup --repo <owner/name>.')
  if (!clean && config.workflow === false) throw failure(`Triage workers need the workflow, which is off in ${root}.`)
  if (options.batch && options.sequential) throw input('--batch conflicts with --sequential.')
  if (options.since) options.since = integer(options.since, '--since')
  const remote = options.remote === undefined ? undefined : await (await import('./remote.mjs')).resolveRemote(options.remote, { root, repo })
  const state = { ...idle(), root, revision: old.revision, repo, host: localHost(), remote, options, agent: options.codex ? 'codex' : 'claude', batch: options.sequential ? 1 : options.batch ? integer(options.batch, '--batch') : 1 }
  state.main = checked('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: root }).split('\0')[0].slice(9)
  const spaces = workspaces(root, state)
  const all = issuesFor(root, state, config.github.board, clean)
  if (clean) {
    state.issues = all
    state.facts = cleanFacts(root, state, spaces)
    state.offset = 0
    state.verdicts = []
    state.phase = all.length ? 'cleaning' : 'done'
  } else {
    const owned = activeIssues(root, spaces)
    state.issues = all.filter(i => !owned.has(i.number))
    state.excluded = all.filter(i => owned.has(i.number)).map(i => i.number)
    state.phase = state.issues.length ? 'grouping' : 'done'
  }
  note(state, `Read ${all.length} issues in ${repo}; ${state.issues.length} need ${clean ? 'verdicts' : 'grouping'}.`)
  save(root, state)
  return view(root, state)
}
async function confirm(root, state, argv, options) {
  const { values, positionals: [decision] } = argsFor(argv, { issue: str, revision: str }, 'ndev triage confirm --help', { positionals: 1 })
  if (!['close', 'keep'].includes(decision)) throw input('Choose close or keep.')
  const issue = integer(values.issue, '--issue')
  const revision = integer(values.revision, '--revision')
  if (state.revision !== revision) throw new CliError(5, `Issue #${issue}: expected revision ${revision}, current revision ${state.revision}.`, { repair: 'ndev triage status' })
  expectPhase(state, ['confirming'])
  const item = state.verdicts.find(v => v.issue === issue)
  if (!item || !['pending', 'closing'].includes(item.decision)) throw failure(`#${issue} has no outstanding clean decision.`)
  if (item.decision === 'closing') {
    const remote = parsed('gh issue-read', gh(root, state.repo, ['issue-read', String(issue)]))
    if (remote.state === 'closed') item.decision = 'closed'
    else if (decision === 'keep') throw failure(`Closing #${issue} was attempted. Confirm its GitHub outcome before changing the decision.`)
  }
  if (item.decision !== 'closed' && decision === 'close') {
    const panel = await view(root, state)
    const binding = { worktreeId: panel.worktreeId, action: 'triage.confirm', target: { repo: state.repo, issue, decision, evidence: item.evidence }, revision }
    if (options.json) return { nextAction: { ...binding, confirmation: 'desktop' }, text: `Confirm closing #${issue} in the triage panel or rerun ndev triage confirm --issue ${issue} --revision ${revision} close from the desktop.` }
    const approved = await confirmPanelAction(binding, { cwd: root, confirm: options.confirm })
    if (!approved) throw new CliError(1, `Human declined closing #${issue}.`, { errorCode: 'confirmation_declined' })
    item.decision = 'closing'
    save(root, state)
    checked('gh', ['issue', 'close', String(issue), '--repo', state.repo, '--reason', item.verdict === 'done' ? 'completed' : 'not planned', '--comment', `${item.verdict}: ${item.evidence}`], { cwd: root, repair: 'Check the issue state and use ndev triage status before retrying.' })
    item.decision = 'closed'
  } else if (decision === 'keep') item.decision = 'keep'
  if (!state.verdicts.some(v => ['pending', 'closing'].includes(v.decision))) state.phase = 'done'
  note(state, `#${issue}: ${item.decision}.`)
  save(root, state)
  return view(root, state)
}
async function updateAndView(root, state, update) {
  try {
    update()
  } catch (error) {
    await view(root, read(root))
    throw error
  }
  return view(root, state)
}

export async function runTriage([command = 'status', ...argv], options = {}) {
  const root = gitWorkspace(options.cwd || process.cwd()).root
  const state = read(root)
  if (command === 'start' || command === 'clean') return begin(root, state, argv, command === 'clean')
  if (command === 'confirm') return confirm(root, state, argv, options)
  if (command === 'groups' || command === 'clean-verdicts') {
    const { values } = argsFor(argv, { file: str }, 'ndev triage ' + command + ' --help')
    const report = payload(values.file)
    if (command === 'groups') {
      expectPhase(state, ['grouping'])
      Object.assign(state, groupsFor(state, report))
      state.phase = state.groups.length ? 'planned' : 'done'
      note(state, `Recorded ${state.groups.length} groups.`)
      save(root, state)
      if (state.groups.length && !state.options['dry-run']) return updateAndView(root, state, () => launch(root, state))
    } else {
      expectPhase(state, ['cleaning'])
      state.verdicts.push(...verdictsFor(state, report))
      state.offset += Math.min(10, state.facts.length - state.offset)
      if (state.offset >= state.facts.length) state.phase = state.verdicts.some(v => v.decision === 'pending') ? 'confirming' : 'done'
      note(state, `Recorded verdicts for ${state.offset} of ${state.facts.length} issues.`)
      save(root, state)
    }
    return view(root, state)
  }
  argsFor(argv, {}, 'ndev triage ' + command + ' --help')
  switch (command) {
    case 'status': restoreRejectedRun(root, state); break
    case 'launch': return updateAndView(root, state, () => launch(root, state, true, options.panelLaunch))
    case 'refresh': return updateAndView(root, state, () => refresh(root, state))
    case 'reset': {
      const next = { ...idle(), revision: state.revision }
      note(next, `Reset local triage.${state.runId ? ' Orca retains Run ' + state.runId + '.' : ''}`)
      save(root, next)
      return view(root, next)
    }
    default: throw input(`Unknown triage command ${command}.`)
  }
  return view(root, state)
}
export async function tickTriage(root) {
  const state = read(root)
  if (state.phase !== 'running' || !state.runId || Date.now() < (state.nextCheckAt || 0)) return null
  state.nextCheckAt = Date.now() + pollMs
  save(root, state)
  return updateAndView(root, state, () => refresh(root, state))
}
