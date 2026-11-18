import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { confirm } from '../export/flow/public.ts'
import { argsFor, atomicJson, checked, CliError, gitWorkspace, locked, readObject, run } from './common.mjs'
import { DEFAULT_PARALLEL, EPIC_STATES, ISSUE_STATES, KEY, OWNER_LIVE_MS, SHORT_NAME, frontier, implementerBrief, nextEpicState, reviewerBrief, sliceProblems, stackPlan } from './epic-model.ts'
import { readProject } from './project.mjs'
import { resolveRemote } from './remote.mjs'
import { readWorkflowRecords } from './waits.mjs'

const string = { type: 'string' }
const boolean = { type: 'boolean' }
const session = () => process.env.ORCA_AGENT_SESSION_ID || process.env.CODEX_THREAD_ID || process.env.CLAUDE_SESSION_ID || `ndev-terminal:${process.ppid}`
const pathFor = (root, n) => join(root, `.neil-dev.epic-${n}.json`)
const bad = message => { throw new CliError(2, message, { repair: 'ndev epic --help' }) }
const refuse = (message, repair = 'Run ndev epic status and inspect the record.') => { throw new CliError(1, message, { repair }) }
const number = (value, label) => {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) bad(`Invalid ${label} number ${JSON.stringify(value)}.`)
  return Number(value)
}

function load(root, n) {
  const file = pathFor(root, n)
  const e = readObject(file)
  if (e.epic !== n || !EPIC_STATES.includes(e.state) || !e.roles?.implementer?.agent || !e.roles?.reviewer?.agent || !Number.isInteger(e.parallel) || e.parallel < 1 || !e.evidence || !Array.isArray(e.history) || !e.issues || Array.isArray(e.issues)) refuse(`Invalid epic record ${file}.`, `Restore the last valid ${file}.`)
  for (const [key, item] of Object.entries(e.issues)) {
    if (!item || String(item.issue) !== key || !ISSUE_STATES.includes(item.state) || !Array.isArray(item.blockedBy) || item.blockedBy.some(id => !e.issues[id])) refuse(`Invalid sub-issue ${key} in ${file}.`)
  }
  return e
}

export function activeEpic(root, owner = session()) {
  const matches = readdirSync(root).flatMap(name => {
    const match = /^\.neil-dev\.epic-([1-9]\d*)\.json$/.exec(name)
    if (!match) return []
    const e = load(root, Number(match[1]))
    return !e.off && e.state !== 'done' && e.owner?.session === owner ? [e] : []
  })
  if (matches.length > 1) refuse(`Session ${owner} owns multiple epics: ${matches.map(e => e.epic).join(', ')}. Specify the epic number.`)
  return matches[0]
}

function ignore(workspace, file) {
  const { root, commonDir } = workspace
  const name = relative(root, file)
  if (checked('git', ['ls-files', '--', name], { cwd: root })) refuse(`Epic record ${file} is tracked.`, `Run git rm --cached -- ${name}.`)
  const probe = run('git', ['check-ignore', '-q', name], { cwd: root })
  if (probe.status === 0) return
  if (probe.status !== 1) refuse(`git check-ignore ${name} exited ${probe.status}: ${probe.stderr}`)
  const exclude = join(commonDir, 'info/exclude')
  mkdirSync(dirname(exclude), { recursive: true })
  locked(exclude, () => {
    const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
    if (!text.split('\n').includes('.neil-dev.epic-*.json')) writeFileSync(exclude, text + '\n.neil-dev.epic-*.json\n')
  })
  checked('git', ['check-ignore', '-q', name], { cwd: root, repair: `Add .neil-dev.epic-*.json to .gitignore in ${root}.` })
}

function nextAction(epic) {
  if (epic.off) return ['ndev','epic','start',String(epic.epic)]
  if (epic.state === 'done') return undefined
  if (epic.state === 'coordinating' && Object.values(epic.issues).some(issue => issue.state !== 'merged')) return ['ndev','epic','next',String(epic.epic)]
  const argv = ['ndev','epic','phase',String(epic.epic),epic.state,'--evidence','<text>']
  if (epic.state === 'framing') argv.push('--aim','<text>')
  if (['researching','specifying','spec-review'].includes(epic.state)) argv.push('--file','<path>')
  return argv
}

function epicResult(epic) {
  const result = { epic, nextAction: nextAction(epic) }
  if (epic.off) return result
  if (epic.state === 'framing') {
    return { ...result, nextGuidance: 'Load ndev-epic-plan and read all of NORTH_STAR.md before framing.' }
  }
  if (epic.state === 'closing') {
    return { ...result, nextGuidance: 'Load ndev-epic-coordinate and read all of NORTH_STAR.md again from the default branch before closing.' }
  }
  return result
}

function save(workspace, e, before, action, from, to) {
  const file = pathFor(workspace.root, e.epic)
  ignore(workspace, file)
  locked(file, () => {
    const current = existsSync(file) ? load(workspace.root, e.epic) : null
    if (!isDeepStrictEqual(before, current)) throw new CliError(5, `Epic #${e.epic} changed while processing ${action}.`, { repair: `Run ndev epic status ${e.epic} before retrying.` })
    const at = Date.now()
    e.revision = (e.revision ?? 0) + 1
    if (!e.off && e.state !== 'done') e.owner = { session: action.startsWith('human:') && e.owner ? e.owner.session : session(), at }
    e.history.push({ at, tool: action, from, to })
    atomicJson(file, e)
  })
  return epicResult(e)
}

function github(root, repo, endpoint, pages = false) {
  const args = ['api', ...(pages ? ['--paginate', '--slurp'] : []), `repos/${repo}${endpoint}`]
  const output = checked('gh', args, { cwd: root, repair: 'Check gh auth status and repository access.' })
  let data
  try { data = JSON.parse(output) } catch (error) { refuse(`gh ${args.join(' ')} returned invalid JSON: ${error.message}.`) }
  if (pages && !Array.isArray(data)) refuse(`GitHub did not return a list for ${endpoint}.`)
  return pages ? data.flat() : data
}

function githubRepo(root) {
  const configured = readProject(root).github?.repo
  if (configured) return configured
  const url = checked('git', ['remote', 'get-url', 'origin'], { cwd: root, repair: 'Run ndev project setup --repo <owner/name>.' })
  const repo = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1]
  if (!repo) refuse(`No GitHub repository is configured for ${root}.`, 'Run ndev project setup --repo <owner/name>.')
  return repo
}

function fileIssue(workspace, repo, title) {
  const key = createHash('sha256').update(JSON.stringify([repo, title])).digest('hex')
  const dir = join(workspace.gitDir, 'ndev-epic')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `create-${key}.json`)
  const pending = locked(file, () => {
    if (existsSync(file)) return { ...readObject(file), recover: true }
    const request = { id: randomUUID(), repo, title }
    atomicJson(file, request)
    return request
  })
  if (pending.issue) return number(pending.issue, 'saved epic')
  const marker = `ndev-epic-request-${pending.id}`
  let n
  if (pending.recover) {
    const out = checked('gh', ['issue','list','-R',repo,'--state','all','--search',`"${marker}" in:body`,'--json','number,body'], { cwd: workspace.root })
    const found = JSON.parse(out).filter(item => item.body?.includes(marker))
    if (found.length !== 1) refuse(`Creation of ${JSON.stringify(title)} has uncertain delivery. GitHub returned ${found.length} matching issues for request ${pending.id}.`, `Inspect GitHub for ${marker}. Resume the existing issue with ndev epic start <number>. If GitHub never created it, remove ${file} and retry.`)
    n = number(found[0].number, 'recovered epic')
  } else {
    const out = checked('gh', ['issue','create','-R',repo,'--title',title,'--body-file','-'], { cwd: workspace.root, input: `${title}\n\nThis epic tracks its GitHub sub-issues.\n\n<!-- ${marker} -->\n`, repair: `Retry ndev epic start --title with the same title to recover request ${pending.id}.` })
    const id = /\/issues\/(\d+)\s*$/.exec(out)?.[1]
    if (!id) refuse(`GitHub returned no epic issue number for request ${pending.id}: ${out}`)
    n = number(id, 'new epic')
  }
  locked(file, () => atomicJson(file, { id: pending.id, repo, title, issue: n }))
  return n
}

async function start(workspace, argv) {
  const options = Object.fromEntries(['title','short-name','parallel','implementer','implementer-model','reviewer','reviewer-model','run','repo-id','remote','remote-repo'].map(k => [k, string]))
  const normalized = argv.map((v, i) => v === '--remote' && (!argv[i + 1] || argv[i + 1].startsWith('--')) ? '--remote=' : v)
  const { values: v, positionals: [issue] } = argsFor(normalized, { ...options, local: boolean, 'take-over': boolean }, 'ndev epic start --help', { positionals: 1 })
  if (!!issue === !!v.title) bad('Give one epic number or --title.')
  if (v['short-name'] && !SHORT_NAME.test(v['short-name'])) bad('Use two to five lower-case words for --short-name.')
  if (v.local && (v.remote !== undefined || v['remote-repo'])) bad('--local conflicts with remote placement.')
  const root = workspace.root
  const repo = githubRepo(root)
  const live = activeEpic(root)
  if (live && live.epic !== Number(issue) && live.title !== v.title) refuse(`Session already owns epic #${live.epic}.`, `Run ndev epic off --issue ${live.epic} first.`)
  const ordinary = readWorkflowRecords(root).find(w => !w.off && w.state !== 'done' && w.owner?.session === session())
  if (ordinary) refuse(`Session owns issue #${ordinary.issue} in ${ordinary.state}.`, 'Finish the issue or suspend it with ndev flow off.')
  const parallel = v.parallel !== undefined ? number(v.parallel, 'parallel') : undefined
  let n = issue && number(issue, 'epic')
  let before = n && existsSync(pathFor(root, n)) ? load(root, n) : null
  if (!before?.off && before?.owner && before.owner.session !== session() && Date.now() - before.owner.at < OWNER_LIVE_MS && !v['take-over']) refuse(`Epic #${n} belongs to session ${before.owner.session}.`, `If the owner stopped, run ndev epic start ${n} --take-over.`)
  if (v['remote-repo'] && v.remote === undefined && !before?.remote) bad('--remote-repo requires --remote or an existing remote epic.')
  const remote = v.remote !== undefined || v['remote-repo'] ? await resolveRemote(v.remote ?? before.remote.id, { root, repo, selector: v['remote-repo'] }) : undefined
  if (!n) {
    n = fileIssue(workspace, repo, v.title)
    before = existsSync(pathFor(root, n)) ? load(root, n) : null
    if (before?.owner && before.owner.session !== session() && !before.off) refuse(`Epic #${n} belongs to ${before.owner.session}.`, `Run ndev epic start ${n} to resume it.`)
  }
  const gh = before ?? github(root, repo, `/issues/${n}`)
  if (!before && (gh.state !== 'open' || !gh.title)) refuse(`GitHub issue #${n} is ${gh.state}.`)
  const e = before ? structuredClone(before) : { epic: n, repo, root, title: gh.title, state: 'framing', evidence: {}, parallel: DEFAULT_PARALLEL, roles: { implementer: { agent: 'claude' }, reviewer: { agent: 'codex' } }, issues: {}, history: [] }
  delete e.off
  if (!before || before.owner?.session !== session()) delete e.coordinator
  if (process.env.ORCA_TERMINAL_HANDLE) e.coordinator = { terminal: process.env.ORCA_TERMINAL_HANDLE }
  if (process.env.ORCA_DISPATCH_ID) e.coordinator = { dispatch: process.env.ORCA_DISPATCH_ID }
  if (parallel) e.parallel = parallel
  if (v['short-name']) e.shortName = v['short-name']
  if (v['repo-id']) e.repoId = v['repo-id']
  if (v.run) e.run = v.run
  for (const role of ['implementer', 'reviewer']) {
    if (v[role]) e.roles[role].agent = v[role]
    if (v[role + '-model']) e.roles[role].model = v[role + '-model']
  }
  if (v.local) { delete e.remote; delete e.remoteRepo }
  if (remote) { e.remote = { id: remote.id, name: remote.name }; e.remoteRepo = remote.repoSelector }
  return save(workspace, e, before, 'epicStarted', before?.state, e.state)
}

function slices(root, epic, file) {
  const children = github(root, epic.repo, `/issues/${epic.epic}/sub_issues`, true)
  const actual = children.map(child => {
    const n = number(child.number, 'GitHub sub-issue')
    if (child.state !== 'open') refuse(`GitHub sub-issue #${n} is ${child.state}.`)
    const blockers = github(root, epic.repo, `/issues/${n}/dependencies/blocked_by`, true)
    return { issue: n, key: `issue-${n}`, title: child.title, blockedBy: blockers.map(item => number(item.number, 'GitHub blocker')).sort((a,b) => a-b) }
  })
  if (file) {
    let list
    try { list = JSON.parse(readFileSync(file === '-' ? 0 : resolve(root, file), 'utf8')) } catch (error) { bad(`Cannot read ${file}: ${error.message}`) }
    if (!Array.isArray(list) || list.length !== children.length) refuse(`The issue list in ${file} differs from GitHub's ${children.length} sub-issues of #${epic.epic}.`)
    for (const item of actual) {
      const entry = list.find(s => s.issue === item.issue)
      if (!entry || !KEY.test(entry.key ?? '') || !Array.isArray(entry.blockedBy ?? []) || !isDeepStrictEqual([...(entry.blockedBy ?? [])].sort((a,b) => a-b), item.blockedBy)) refuse(`Sub-issue #${item.issue} or its blockers in ${file} differ from GitHub.`, 'Correct the GitHub sub-issue and blocker links or update the file.')
      item.key = entry.key
    }
  }
  const problem = sliceProblems(actual)
  if (problem) refuse(problem, 'Correct the GitHub sub-issues and their blocker links.')
  return Object.fromEntries(actual.map(s => [s.issue, { ...s, state: 'waiting', rounds: 0 }]))
}

function phase(workspace, e, before, finished, v) {
  if (finished !== e.state || !nextEpicState(finished)) refuse(`Epic #${e.epic} is ${e.state}, so ${finished} cannot finish.`)
  if (!v.evidence?.trim()) bad(`Finishing ${finished} requires --evidence.`)
  if (finished === 'framing' && !v.aim?.trim()) bad('Finishing framing requires --aim.')
  const files = (v.file ?? []).map(f => resolve(workspace.root, f))
  if (['researching', 'specifying', 'spec-review'].includes(finished) && !files.length) bad(`Finishing ${finished} requires --file.`)
  for (const f of files) if (!statSync(f, { throwIfNoEntry: false })?.isFile()) refuse(`Missing phase evidence file ${f}.`)
  if (finished === 'slicing') e.issues = slices(workspace.root, e, v['issues-file'])
  if (finished === 'coordinating' && Object.values(e.issues).some(s => s.state !== 'merged')) refuse('Every sub-issue must be recorded as merged before closing.')
  if (v.aim) e.aim = v.aim
  e.evidence[finished] = { text: v.evidence, at: Date.now(), files }
  e.state = nextEpicState(finished)
  return save(workspace, e, before, 'epicPhase', finished, e.state)
}

function branchFor(e) {
  const branch = github(e.root, e.repo, '').default_branch
  if (!branch) refuse(`GitHub omitted the default branch for ${e.repo}.`)
  return branch
}

function brief(workspace, e, before, sub, role, pr) {
  if (!['implementer','reviewer'].includes(role)) bad('Name implementer or reviewer.')
  if (e.state !== 'coordinating') refuse(`Epic #${e.epic} is ${e.state}.`)
  const placement = sub.state === 'waiting' && role === 'implementer' ? e.remote : sub.remote
  let files = e.evidence.specifying?.files ?? []
  if (placement) {
    files = files.map(f => relative(workspace.root, resolve(workspace.root, f)))
    if (files.some(f => f === '..' || f.startsWith('../'))) refuse('A remote worker cannot read spec files outside the repository.')
  }
  const argv = ['orca','orchestration','worker-start']
  if (e.run) argv.push('--run', e.run)
  if (placement) argv.push('--on', placement.id)
  let body
  if (role === 'implementer') {
    const f = frontier(e)
    if (sub.state === 'waiting' && ![...f.ready, ...f.stacked.map(s => s.sub)].includes(sub)) refuse(`Sub-issue #${sub.issue} is outside the current frontier.`)
    const base = branchFor(e)
    const plan = stackPlan(e, sub)
    if (plan?.why) refuse(plan.why)
    let stack
    if (plan?.on) {
      const head = github(e.root, e.repo, `/pulls/${plan.on.pr}`)
      if (head.state !== 'open' || head.merged || !head.head?.ref) refuse(`Blocker PR #${plan.on.pr} is ${head.state}. Its branch cannot carry #${sub.issue}.`)
      stack = { on: plan.on, branch: head.head.ref, base }
      sub.stackedOn = plan.on.issue
    } else if (sub.state === 'waiting') delete sub.stackedOn
    if (placement) { sub.remote = placement; sub.remoteRepo = e.remoteRepo }
    else delete sub.remote
    const repoSelector = placement ? e.remoteRepo : e.repoId ? `id:${e.repoId}` : `path:${workspace.root}`
    if (!repoSelector) refuse(`Repository on ${placement.id} is missing.`, `Run ndev epic start ${e.epic} --remote ${placement.id} --remote-repo id:<id>.`)
    argv.push('--worktree','new-top-level','--repo',repoSelector,'--name',`${sub.issue}-${sub.key}`,'--base-branch',`origin/${stack?.branch ?? base}`)
    body = implementerBrief(e, sub, files, stack)
  } else {
    if (!sub.workspace || !(pr ?? sub.pr)) refuse(`Reviewer of #${sub.issue} needs an implementer workspace and a PR number.`)
    if (placement && !/^.+::\/.+/.test(sub.workspace)) refuse(`Invalid worktree ID ${sub.workspace} for ${placement.id}.`)
    argv.push('--worktree', placement ? `id:${sub.workspace}` : `path:${sub.workspace}`)
    body = reviewerBrief(e, sub, files, pr ?? sub.pr)
  }
  const config = e.roles[role]
  body = body.replaceAll('mcp__ndev__started', 'ndev flow start').replaceAll('mcp__ndev__unblocked', 'ndev flow unblock').replaceAll('mcp__ndev__checkpoint', 'ndev flow checkpoint').replaceAll('mcp__ndev__addMigration', 'ndev flow add-migration')
    .replace(/git merge origin\//g, 'git rebase origin/')
  body += `\nRole: ${role}. Agent: ${config.agent}.${config.model ? ` Model: ${config.model}.` : ''}\n`
  const digest = createHash('sha256').update(body).digest('hex').slice(0, 16)
  const folder = join(workspace.gitDir, 'ndev-epic')
  mkdirSync(folder, { recursive: true })
  const path = join(folder, `epic-${e.epic}-${sub.issue}-${role}-${digest}.md`)
  writeFileSync(path, body, { mode: 0o600 })
  argv.push('--agent', config.agent, '--spec', body, '--task-title', `#${sub.issue} ${sub.title} (${role})`)
  if (config.model) argv.push('--model', config.model)
  argv.push('--json')
  if (!isDeepStrictEqual(e, before)) save(workspace, e, before, 'epicBrief', sub.state, sub.state)
  return { path, argv, role, agent: config.agent, model: config.model, remote: placement, issue: sub.issue }
}

function verify(e, sub) {
  const under = e.issues[sub.stackedOn]
  if (under && under.state !== 'merged') refuse(`#${sub.issue} is stacked on unmerged #${under.issue}.`, `Record the merge of PR #${under.pr}, then rebase and retarget PR #${sub.pr}.`)
  const endpoint = `/pulls/${sub.pr}`
  const pr = github(e.root, e.repo, endpoint)
  const main = branchFor(e)
  if (pr.state !== 'open' || pr.merged || pr.draft || pr.mergeable !== true || pr.base?.ref !== main) refuse(`PR #${sub.pr} needs to be open, ready and mergeable on ${main}; GitHub reports state ${pr.state}, draft ${pr.draft}, mergeable ${pr.mergeable}, base ${pr.base?.ref}.`)
  const sha = pr.head?.sha
  if (!sha) refuse(`PR #${sub.pr} has no head SHA.`)
  const checks = JSON.parse(checked('gh', ['pr','view',String(sub.pr),'-R',e.repo,'--json','headRefOid,statusCheckRollup'], { cwd: e.root }))
  if (checks.headRefOid !== sha || !Array.isArray(checks.statusCheckRollup)) refuse(`Check evidence does not match PR #${sub.pr} head ${sha}.`)
  const rollup = checks.statusCheckRollup
  if (!rollup.length) {
    const commit = github(e.root, e.repo, `/commits/${sha}`)
    const at = Date.parse(commit.commit?.committer?.date)
    const workflows = checked('git', ['ls-tree','-d','HEAD','.github/workflows'], { cwd: e.root })
    if (!Number.isFinite(at) || Date.now() - at < (workflows ? 10 : 2) * 60000) refuse(`PR #${sub.pr} has no check evidence yet for ${sha}.`, 'Wait for checks on the current PR head.')
  }
  for (const check of rollup) {
    const state = check.conclusion || check.state
    if ((check.status && check.status !== 'COMPLETED') || !['SUCCESS','NEUTRAL','SKIPPED'].includes(state)) refuse(`PR #${sub.pr} check ${check.name ?? check.context} is ${state || check.status} at ${sha}.`)
  }
  const changes = github(e.root, e.repo, endpoint + '/files', true)
  const migrationSection = /<!-- ndev:migrations -->[\s\S]*?<!-- \/ndev:migrations -->/.exec(pr.body ?? '')?.[0] ?? ''
  const listed = new Set([...migrationSection.matchAll(/^- `([^`]+)`/gm)].map(match => match[1]))
  const missing = changes.filter(f => f.status === 'added' && /(^|\/)supabase\/migrations\/[^/]+$/.test(f.filename) && !listed.has(f.filename))
  if (missing.length) refuse(`PR #${sub.pr} omits migrations ${missing.map(f => f.filename).join(', ')}.`, 'Use ndev flow add-migration and update the PR body.')
  const fresh = github(e.root, e.repo, endpoint)
  if (fresh.head?.sha !== sha || fresh.base?.ref !== main || fresh.state !== 'open' || fresh.draft || fresh.mergeable !== true) refuse(`PR #${sub.pr} changed during verification of ${sha}.`)
  return { sha, base: main, checks: rollup.map(check => [check.workflowName, check.name ?? check.context].filter(Boolean).join('/')) }
}

function handoffs(workspace, e, sub) {
  for (const child of Object.values(e.issues).filter(item => item.handoff?.blocker === sub.issue && item.handoff.state !== 'sent')) {
    const h = child.handoff
    if (!child.implementer) continue
    if (h.state === 'sending' && !h.requestId) refuse(`Delivery to ${child.implementer} is uncertain for #${child.issue}.`, 'Inspect the Orca Run mailbox and its receipt before resending the rebase instructions.')
    const before = structuredClone(e)
    h.state = 'sending'
    save(workspace, e, before, 'handoff-start', sub.state, sub.state)
    const recorded = structuredClone(e)
    const args = ['orchestration','send','--to',`dispatch:${child.implementer}`,'--subject',`Rebase #${child.issue} after #${sub.issue} merged`,'--body',h.message,...(e.run ? ['--run',e.run] : []),...(h.requestId ? ['--retry-request',h.requestId] : []),'--full','--json']
    const out = run('orca', args, { cwd: workspace.root })
    let receipt
    try { receipt = JSON.parse(out.stdout) } catch {}
    if (out.status !== 0 || receipt?.ok !== true || receipt.result?.accepted === false || receipt.result?.delivered === false || !receipt.result) {
      h.requestId = receipt?.error?.data?.requestId
      h.error = receipt?.error ?? (out.stderr.trim() || out.stdout.trim())
      save(workspace,e,recorded,'handoff-uncertain',sub.state,sub.state)
      throw new CliError(1, `Orca send to dispatch:${child.implementer} exited ${out.status}: ${JSON.stringify(h.error)}`, { details: { receipt, requestId: h.requestId }, repair: h.requestId ? `Retry ndev epic issue ${e.epic} ${sub.issue} merged.` : 'Inspect the Run mailbox before attempting another delivery.' })
    }
    h.state = 'sent'
    h.receipt = receipt.result
    save(workspace,e,recorded,'handoff-sent',sub.state,sub.state)
  }
  return epicResult(e)
}

function move(workspace, e, before, sub, to, v) {
  if (e.state !== 'coordinating') refuse(`Epic #${e.epic} is ${e.state}.`)
  if (!ISSUE_STATES.includes(to)) bad(`Unknown sub-issue state ${to}.`)
  const from = sub.state
  if (v.workspace && (sub.remote ? !/^.+::\/.+/.test(v.workspace) || (sub.remoteRepo?.startsWith('id:') && !v.workspace.startsWith(sub.remoteRepo.slice(3) + '::/')) : !v.workspace.startsWith('/'))) bad(`Invalid workspace ${v.workspace} for ${sub.remote?.id ?? 'local'}.`)
  if (from === 'merged' && to === 'merged') return handoffs(workspace,e,sub)
  if (to === 'blocked' && !['blocked','merged'].includes(from)) {
    if (!v.note?.trim()) bad(`Blocking #${sub.issue} requires --note.`)
    sub.previous = from
  } else if (from === 'blocked' && sub.previous === to) delete sub.previous
  else if (from === to && v.workspace && from !== 'blocked') sub.workspace = v.workspace
  else if (from === 'waiting' && to === 'implementing') {
    const f = frontier(e)
    const stack = f.stacked.find(s => s.sub === sub)
    if (!f.ready.includes(sub) && !stack) refuse(`Issue #${sub.issue} is outside the current frontier.`)
    if (stack && sub.stackedOn !== stack.on.issue) refuse(`Issue #${sub.issue} needs a brief stacked on #${stack.on.issue}.`)
    if (e.remote && !sub.remote) refuse(`Generate the remote implementer brief for #${sub.issue} first.`)
    if (!v.worker) bad('Implementing requires --worker.')
    sub.implementer = v.worker
  } else if (from === 'implementing' && to === 'reviewing') {
    if (!v.worker || !v.pr) bad('Reviewing requires the PR number and reviewer dispatch ID.')
    sub.pr = number(v.pr, 'PR')
    sub.reviewer = v.worker
  } else if (from === 'reviewing' && to === 'fixing') {
    if (v.verdict !== 'changes' || !v.note?.trim()) bad('Fixing requires --verdict changes and --note.')
    sub.rounds = (sub.rounds ?? 0) + 1
    sub.verdict = 'changes'
  } else if (from === 'fixing' && to === 'reviewing') {
    if (v.worker) sub.reviewer = v.worker
  } else if (from === 'reviewing' && to === 'verified') {
    if (v.verdict !== 'approve' && !(v.verdict === 'changes' && v.note?.trim())) bad('Verification requires --verdict approve or resolved changes with --note.')
    sub.verification = verify(e, sub)
    sub.verdict = v.verdict
    delete sub.stackedOn
  } else if (['reviewing','fixing','verified'].includes(from) && to === 'merged') {
    const pr = github(e.root, e.repo, `/pulls/${sub.pr}`)
    if (pr.merged !== true) refuse(`GitHub has not merged PR #${sub.pr}.`)
    if (pr.merge_commit_sha) sub.mergeSha = pr.merge_commit_sha
    if (from !== 'verified' || (sub.verification && sub.verification.sha !== pr.head.sha)) sub.mergedUnverified = true
    const children = Object.values(e.issues).filter(item => item.stackedOn === sub.issue && item.state !== 'merged')
    const main = children.length && branchFor(e)
    for (const child of children) child.handoff = { state: 'pending', blocker: sub.issue, message: `PR #${sub.pr} is merged. Rebase #${child.issue} onto origin/${main}, checkpoint the rebased branch, and retarget ${child.pr ? `PR #${child.pr}` : 'your PR'} to ${main}. Report the new PR head.` }
  } else refuse(`Issue #${sub.issue} cannot move from ${from} to ${to}.`)
  if (v.workspace) sub.workspace = v.workspace
  if (v.note) sub.note = v.note
  sub.state = to
  const result = save(workspace, e, before, `epicIssue #${sub.issue}`, from, to)
  return to === 'merged' ? handoffs(workspace, e, sub) : result
}

function notifyCoordinator(workspace, e, changed, from) {
  const target = e.coordinator
  if (!target) return { ...changed, notification: 'coordinator can read the saved change with ndev epic status' }
  const message = e.off ? `Human ended coordination of epic #${e.epic}.` : `Human moved epic #${e.epic} from ${from} to ${e.state}. Run ndev epic status ${e.epic}.`
  const argv = target.dispatch ? ['orchestration','send','--to',`dispatch:${target.dispatch}`,'--subject','Epic phase changed','--body',message] : ['terminal','send','--terminal',target.terminal,'--text',message,'--enter','--wait-submit','5']
  const out = run('orca', [...argv,'--json'], { cwd: workspace.root })
  let receipt
  try { receipt = JSON.parse(out.stdout) } catch {}
  if (out.status !== 0 || receipt?.ok !== true || receipt.result?.accepted === false) {
    throw new CliError(1, `Epic #${e.epic} is saved at revision ${e.revision}. Coordinator notification exited ${out.status}: ${receipt?.error?.message || out.stderr.trim() || out.stdout.trim()}`, { details: { receipt, revision: e.revision }, repair: `Read ndev epic status ${e.epic} and inspect the Orca receipt before retrying delivery.` })
  }
  return { ...changed, notification: receipt.result }
}

export async function runEpic([verb, ...args], { json = process.argv.includes('--json') } = {}) {
  const workspace = gitWorkspace()
  if (verb === 'start') return start(workspace, args)
  const specs = {
    phase: [{ evidence: string, file: { ...string, multiple: true }, aim: string, 'issues-file': string }, 2],
    next: [{}, 1], brief: [{ pr: string }, 3], issue: [{ pr: string, worker: string, workspace: string, verdict: string, note: string }, 3],
    status: [{}, 1], skip: [{ issue: string }, 1], goto: [{ issue: string }, 2], off: [{ issue: string }, 0],
  }
  const [opts, count] = specs[verb] ?? bad(`Unknown epic command ${verb}.`)
  const { values: v, positionals: pos } = argsFor(args, opts, `ndev epic ${verb} --help`, { positionals: count })
  const override = ['skip','goto','off'].includes(verb)
  if (['phase','next','brief','issue'].includes(verb) && pos.length !== count) bad(`ndev epic ${verb} requires ${count} positional argument(s).`)
  const raw = override ? v.issue : pos[0]
  const n = raw !== undefined ? number(raw, 'epic') : activeEpic(workspace.root)?.epic
  if (!n) {
    if (verb === 'status') return { epic: null }
    bad('Name the epic number.')
  }
  const before = load(workspace.root, n)
  const e = structuredClone(before)
  if (verb === 'status') return { ...epicResult(e), ...(e.state === 'coordinating' ? { frontier: frontier(e) } : {}) }
  if (!override && (e.off || e.owner?.session !== session())) refuse(`This session does not coordinate #${n}.`, `Run ndev epic start ${n}.`)
  if (verb === 'next') return { epic: n, state: e.state, frontier: e.state === 'coordinating' ? frontier(e) : null }
  if (verb === 'phase') return phase(workspace,e,before,pos[1],v)
  if (override) {
    const from = e.state
    const to = verb === 'goto' ? pos[0] : nextEpicState(from)
    if (verb !== 'off' && !EPIC_STATES.includes(to)) bad(`Invalid target phase for ${verb}: ${to}.`)
    const revision = createHash('sha256').update(JSON.stringify(e)).digest('hex').slice(0, 12)
    const action = confirm(`epic ${verb}${verb === 'goto' ? ' ' + to : ''}`, String(n), revision, workspace.root, json)
    if (action) return action
    if (verb === 'off') { e.off = true; delete e.owner }
    else { e.state = to; e.evidence[from] = { at: Date.now(), text: pos[verb === 'goto' ? 1 : 0] ?? 'Human override' } }
    return notifyCoordinator(workspace, e, save(workspace,e,before,`human:${verb}`,from,e.state), from)
  }
  const sub = e.issues[number(pos[1], 'sub-issue')]
  if (!sub) refuse(`#${pos[1]} is outside epic #${n}.`)
  return verb === 'brief' ? brief(workspace,e,before,sub,pos[2],v.pr && number(v.pr,'PR')) : move(workspace,e,before,sub,pos[2],v)
}
