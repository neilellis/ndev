import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { harnessSession } from '../../hooks/workflow/session.ts'
import { confirm } from '../export/flow/public.ts'
import { releaseRoot, argsFor, atomicJson, checked, CliError, gitWorkspace, locked, readObject, run } from './common.mjs'
import { DEFAULT_PARALLEL, EPIC_STATES, IN_FLIGHT, ISSUE_STATES, KEY, OWNER_LIVE_MS, SHORT_NAME, SLICE_CAP, SOURCE_FORM, capNote, coreIdeaProblem, frontier, specPrLinkProblem, specPrLinkRepair, specPrProblem, implementerBrief, nextEpicState, reviewerBrief, mergedSubIssue, resliced, sliceProblems, sourcePaths, sourceProblem, stackPlan } from './epic-model.ts'
import { readProject } from './project.mjs'
import { resolveRemote } from './remote.mjs'
import { readWorkflowRecords } from './waits.mjs'
import { DebtRefused, closingFollowups, closingProblems, closingSha, configureClosing, debtProblem, decisionIds, mergeDebts, recordDebt, recordDebts, requirementIds, rulingConflict, rulingProblem } from './epic-closing.ts'

const string = { type: 'string' }
const boolean = { type: 'boolean' }
const session = () => harnessSession(process.env) || `ndev-terminal:${process.ppid}`
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
  try { configureClosing({}, { baseSha: e.baseSha, coordinatorModel: e.coordinatorModel, fullSuites: e.fullSuites, posture: e.posture }) } catch (error) { refuse(`Invalid closing configuration in ${file}: ${error.message}.`) }
  if (e.debts !== undefined && (!Array.isArray(e.debts) || e.debts.some(debt => debtProblem(debt)))) refuse(`Invalid debt in ${file}.`, `Restore the last valid ${file}.`)
  if (e.posture !== undefined && !['standard', 'deadline'].includes(e.posture)) refuse(`Invalid posture in ${file}.`)
  if (e.baseSha !== undefined && !closingSha(e.baseSha)) refuse(`Invalid base SHA in ${file}.`)
  if (e.externalBlockers !== undefined && (!e.externalBlockers || typeof e.externalBlockers !== 'object' || Array.isArray(e.externalBlockers))) refuse(`Invalid external blockers in ${file}.`)
  for (const [key, item] of Object.entries(e.externalBlockers ?? {})) {
    if (!item || String(item.issue) !== key || e.issues[key] || !['waiting', 'merged'].includes(item.state) || !Array.isArray(item.blockedBy) || item.blockedBy.length || item.state === 'merged' && (!item.pr || !item.mergeSha)) refuse(`Invalid external blocker #${key} in ${file}.`)
  }
  for (const [key, item] of Object.entries(e.issues)) {
    if (!item || String(item.issue) !== key || !ISSUE_STATES.includes(item.state) || !Array.isArray(item.blockedBy) || item.blockedBy.some(id => !e.issues[id] && !e.externalBlockers?.[id])) refuse(`Invalid sub-issue ${key} in ${file}.`)
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
  if (epic.state === 'framing') argv.push('--aim','<text>','--source',SOURCE_FORM)
  if (['framing','researching','specifying','spec-review'].includes(epic.state)) argv.push('--file','<path>')
  if (epic.state === 'spec-review') argv.push('--spec-pr','<n>')
  if (epic.state === 'slicing') argv.push('--approval','<text>')
  return argv
}

function epicResult(epic) {
  const result = { epic, nextAction: nextAction(epic), debt: (epic.debts ?? []).map(item => ({ key: item.key, kind: item.kind, sub: item.sub, check: item.check, note: item.note, ruling: item.ruling ?? null })) }
  if (epic.off) return result
  if (epic.state === 'framing') {
    return { ...result, nextGuidance: 'Load ndev-epic-plan and read all of NORTH_STAR.md before framing.' }
  }
  if (epic.state === 'closing') {
    return { ...result, nextGuidance: 'Load ndev-epic-coordinate and read all of NORTH_STAR.md again from the default branch before closing.' }
  }
  return result
}

function mutate(workspace, n, work) {
  return locked(join(workspace.gitDir, `ndev-epic-${n}-mutation`), () => work({ ...workspace, mutation: n }))
}

function save(workspace, e, before, action, from, to) {
  if (workspace.mutation !== e.epic) return mutate(workspace, e.epic, scoped => save(scoped, e, before, action, from, to))
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
  const options = Object.fromEntries(['title','short-name','parallel','implementer','implementer-model','reviewer','reviewer-model','run','repo-id','remote','remote-repo','base-sha','coordinator-model','posture','full-suites-file'].map(k => [k, string]))
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
  try { configureClosing(e, { baseSha: v['base-sha'], coordinatorModel: v['coordinator-model'], posture: v.posture, fullSuites: v['full-suites-file'] ? JSON.parse(readFileSync(resolve(root, v['full-suites-file']), 'utf8')) : undefined }) } catch (error) { bad(error.message) }
  e.posture ??= 'standard'
  delete e.off
  if (!before || before.owner?.session !== session()) delete e.coordinator
  if (process.env.ORCA_AGENT_SESSION_ID) e.coordinator = { session: process.env.ORCA_AGENT_SESSION_ID }
  else if (process.env.ORCA_TERMINAL_HANDLE) e.coordinator = { terminal: process.env.ORCA_TERMINAL_HANDLE }
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
  const merged = mergedSubIssue(epic.issues ?? {})
  if (merged) refuse(`Epic #${epic.epic}: #${merged.issue} is merged, so the epic cannot be sliced again: a new breakdown must keep each merged sub-issue, and slicing needs each sub-issue open.`, `File new work as new sub-issues of #${epic.epic} on GitHub, then run ndev epic import ${epic.epic} --issues-file <json> --evidence <text>: it keeps each merged sub-issue, records the new ones and moves the epic to coordinating.`)
  const children = github(root, epic.repo, `/issues/${epic.epic}/sub_issues`, true)
  const actual = children.map(child => {
    const n = number(child.number, 'GitHub sub-issue')
    if (child.state !== 'open') refuse(`GitHub sub-issue #${n} is ${child.state}.`, `Run ndev epic import ${epic.epic} --issues-file <json> --evidence <text> to verify and import existing work.`)
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
  const kept = resliced(epic.issues ?? {}, actual, !file)
  if ('problem' in kept) refuse(`Epic #${epic.epic}: ${kept.problem}.`, `${kept.repair}, then repeat ndev epic phase ${epic.epic} slicing.`)
  return kept
}

function linkedPulls(root, repo, n) {
  const timeline = github(root, repo, `/issues/${n}/timeline`, true)
  const prefix = `https://api.github.com/repos/${repo}/pulls/`
  const candidates = [...new Set(timeline.flatMap(event => {
    const url = event.source?.issue?.pull_request?.url
    return event.event === 'cross-referenced' && typeof url === 'string' && url.startsWith(prefix) ? [number(url.slice(prefix.length), 'referenced PR')] : []
  }))]
  return candidates.flatMap(pr => {
    const out = checked('gh', ['pr', 'view', String(pr), '-R', repo, '--json', 'closingIssuesReferences'], { cwd: root, repair: `Run gh pr view ${pr} --repo ${repo} --json closingIssuesReferences, then retry ndev epic import.` })
    let links
    try { links = JSON.parse(out).closingIssuesReferences } catch (error) { refuse(`PR #${pr} closure evidence is invalid JSON: ${error.message}.`) }
    if (!Array.isArray(links) || links.length >= 100) refuse(`PR #${pr} has missing or potentially truncated closing issue evidence.`, `Inspect gh pr view ${pr} --repo ${repo} --json closingIssuesReferences before retrying import.`)
    if (!links.some(link => link.number === n && link.url === `https://github.com/${repo}/issues/${n}`)) return []
    const pull = github(root, repo, `/pulls/${pr}`)
    if (pull.number !== pr || !['open', 'closed'].includes(pull.state) || typeof pull.merged !== 'boolean' || pull.merged && (pull.state !== 'closed' || !pull.merge_commit_sha)) refuse(`PR #${pr} has uncertain merge evidence for issue #${n}: ${JSON.stringify(pull)}.`, `Inspect gh pr view ${pr} --repo ${repo} before retrying import.`)
    return [pull]
  })
}

// Model: models/workflow/epic_workflow.qnt#finishSlicing
function importedIssue(root, repo, child, kind) {
  const n = number(child.number, 'GitHub issue')
  if (!['open', 'closed'].includes(child.state)) refuse(`GitHub issue #${n} has unknown state ${JSON.stringify(child.state)}.`)
  if (kind === 'human') {
    if (child.state !== 'open') refuse(`Human decision #${n} is ${child.state}; import cannot infer human approval from closure.`, `Inspect gh issue view ${n} --repo ${repo}; keep the decision pending until its human owner records evidence.`)
    return { state: 'human-pending', note: 'Pending decision by the human owner; implementation dispatch and automatic merge are forbidden.' }
  }
  const prs = linkedPulls(root, repo, n)
  const merged = prs.filter(pr => pr.merged === true && pr.state === 'closed' && pr.merge_commit_sha)
  const open = prs.filter(pr => pr.state === 'open' && pr.merged === false)
  if (child.state === 'closed') {
    if (merged.length !== 1 || open.length) refuse(`Closed issue #${n} needs one verified merged closing PR and no open closing PR; found merged [${merged.map(p => p.number)}], open [${open.map(p => p.number)}].`, `Inspect gh issue view ${n} --repo ${repo} and its closing PRs, then retry ndev epic import.`)
    return { state: 'merged', pr: number(merged[0].number, 'merged PR'), mergeSha: merged[0].merge_commit_sha, mergedUnverified: true }
  }
  if (merged.length || open.length > 1) refuse(`Issue #${n} has uncertain closing PR evidence: ${prs.map(pr => `#${pr.number} (${pr.state}, merged ${pr.merged})`).join(', ')}.`, `Inspect gh issue view ${n} --repo ${repo} and resolve its closing PR links before import.`)
  return open.length ? { state: 'external', pr: number(open[0].number, 'existing PR'), note: 'Existing PR remains with its current owner. Resume that workflow; do not dispatch a duplicate.' } : { state: 'waiting' }
}

// Model: models/workflow/epic_workflow.qnt#reimport
function importEpic(workspace, e, before, v) {
  if (!['slicing', 'coordinating'].includes(e.state)) refuse(`Epic #${e.epic} is ${e.state}; import requires slicing or coordinating.`, `Run ndev epic status ${e.epic}.`)
  if (!v['issues-file'] || !v.evidence?.trim()) bad('Import requires --issues-file and --evidence.')
  const file = v['issues-file']
  let list
  try { list = JSON.parse(readFileSync(file === '-' ? 0 : resolve(workspace.root, file), 'utf8')) } catch (error) { bad(`Cannot read ${file}: ${error.message}`) }
  const children = github(workspace.root, e.repo, `/issues/${e.epic}/sub_issues`, true)
  if (!Array.isArray(list) || list.some(s => !s || typeof s !== 'object' || Array.isArray(s)) || list.length !== children.length || new Set(list.map(s => s?.issue)).size !== list.length) refuse(`Import manifest ${file} must name each of the ${children.length} GitHub children of #${e.epic} exactly once.`)
  const issues = {}
  for (const child of children) {
    const n = number(child.number, 'GitHub sub-issue')
    const entry = list.find(s => s.issue === n)
    if (!entry || !KEY.test(entry.key ?? '') || !['implementation', 'human'].includes(entry.kind) || !Array.isArray(entry.blockedBy) || entry.blockedBy.some(b => !Number.isSafeInteger(b) || b < 1) || new Set(entry.blockedBy).size !== entry.blockedBy.length) refuse(`Import manifest ${file} needs #${n}, a valid key, explicit kind (implementation or human), and unique blockedBy issue numbers.`)
    const blockedBy = github(workspace.root, e.repo, `/issues/${n}/dependencies/blocked_by`, true).map(b => number(b.number, 'GitHub blocker')).sort((a, b) => a - b)
    if (!isDeepStrictEqual([...entry.blockedBy].sort((a, b) => a - b), blockedBy)) refuse(`Sub-issue #${n} blockers in ${file} differ from GitHub [${blockedBy.join(', ')}].`, 'Correct the GitHub blocker links or update the manifest; never drop a dependency.')
    const imported = importedIssue(workspace.root, e.repo, child, entry.kind)
    const old = e.issues[n]
    const managed = old && !['waiting', 'external', 'merged', 'human-pending'].includes(old.state)
    if (old && (old.kind && old.kind !== entry.kind || old.state === 'merged' && imported.state !== 'merged' || managed && (entry.kind === 'human' || !isDeepStrictEqual(old.blockedBy, blockedBy) || old.pr !== undefined && imported.pr !== old.pr))) refuse(`Import of #${n} conflicts with its saved ${old.state} workflow.`, `Run ndev epic status ${e.epic} and reconcile #${n} with its existing owner.`)
    issues[n] = { ...(old ?? { rounds: 0 }), issue: n, key: entry.key, title: child.title, kind: entry.kind, blockedBy, ...(managed && imported.state !== 'merged' ? {} : imported) }
    // Model: models/workflow/epic_workflow.qnt#reimportStillWaiting
    if (!managed) delete issues[n].briefedAt
  }
  const externalBlockers = {}
  const externalIds = [...new Set(Object.values(issues).flatMap(s => s.blockedBy).filter(n => !issues[n]))]
  for (const n of externalIds) {
    const child = github(workspace.root, e.repo, `/issues/${n}`)
    if (child.number !== n || child.pull_request) refuse(`External blocker #${n} did not resolve to that GitHub issue.`)
    const imported = importedIssue(workspace.root, e.repo, child, 'implementation')
    externalBlockers[n] = { issue: n, key: `issue-${n}`, title: child.title, rounds: 0, blockedBy: [], ...imported, state: imported.state === 'merged' ? 'merged' : 'waiting' }
  }
  if (Object.keys(e.issues).some(n => !issues[n])) refuse(`Import would remove saved children from epic #${e.epic}.`, `Run ndev epic status ${e.epic} and reconcile removed children with their owners.`)
  const problem = sliceProblems(Object.values(issues), externalIds)
  if (problem) refuse(problem, 'Correct the GitHub sub-issues and their blocker links.')
  e.issues = issues
  e.externalBlockers = externalBlockers
  e.evidence.import = { text: v.evidence, at: Date.now(), files: file === '-' ? [] : [resolve(workspace.root, file)] }
  e.state = 'coordinating'
  const merged = Object.values(e.issues).filter(sub => sub.state === 'merged')
  for (const sub of merged) { mergeDebts(e, sub, Boolean(sub.reviewer && sub.verdict), !sub.mergedUnverified, Date.now(), undefined, Infinity); prepareMergeHandoffs(e, sub) }
  save(workspace, e, before, 'epicImport', before.state, e.state)
  handoffs(workspace, e, merged)
  return { ...epicResult(e), frontier: frontier(e) }
}

function closingReceipt(workspace, e, file) {
  if (!file) refuse('Closing needs structured evidence in --closing-file <json>.', `Run ndev epic phase ${e.epic} closing --evidence <text> --closing-file <json>.`)
  const path = resolve(workspace.root, file)
  const receipt = readObject(path)
  const main = branchFor(e)
  const remote = github(e.root, e.repo, `/commits/${encodeURIComponent(main)}`)
  const head = checked('git', ['rev-parse', 'HEAD'], { cwd: workspace.root })
  const branch = checked('git', ['branch', '--show-current'], { cwd: workspace.root })
  if (closingSha(e.baseSha)) checked('git', ['merge-base', '--is-ancestor', e.baseSha, head], { cwd: workspace.root, repair: 'Fetch the original epic base commit and verify it precedes the closing SHA.' })
  const dirty = Boolean(checked('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: workspace.root }))
  const ids = []
  const decisions = []
  const specs = e.evidence.specifying?.files ?? []
  if (!specs.length) refuse('Closing needs committed spec files with numbered requirements.')
  for (const spec of specs) {
    const name = relative(realpathSync(workspace.root), realpathSync(spec))
    if (name === '..' || name.startsWith('../') || isAbsolute(name)) refuse(`Spec ${spec} is outside ${workspace.root}. Commit the spec on ${main}.`)
    const source = checked('git', ['show', `${head}:${name}`], { cwd: workspace.root, repair: `Commit ${name} on ${main} before closing.` })
    ids.push(...requirementIds(source))
    decisions.push(...decisionIds(source))
  }
  const problems = closingProblems(e, receipt, { branch, defaultBranch: main, head, remoteHead: remote?.sha, dirty, requirements: [...new Set(ids)], decisions: [...new Set(decisions)] })
  if (problems.length) refuse(`Epic #${e.epic} cannot close:\n- ${problems.join('\n- ')}`, `Run ndev epic status ${e.epic}; record the missing evidence and rule on every debt with ndev epic ruling.`)
  for (const followup of closingFollowups(e, receipt)) {
    const found = github(e.root, e.repo, `/issues/${followup.issue}`)
    if (found?.number !== followup.issue || found.pull_request) refuse(`${followup.id} needs a real follow-up issue #${followup.issue} in ${e.repo}.`)
  }
  for (const suite of receipt.suites) if (!statSync(resolve(workspace.root, suite.log), { throwIfNoEntry: false })?.isFile()) refuse(`Closing suite log ${suite.log} is missing.`)
  for (const adr of receipt.adrs) {
    const found = run('git', ['cat-file', '-e', `${head}:${adr.path}`], { cwd: workspace.root })
    if (found.status !== 0) refuse(`ADR ${adr.path} for ${adr.decision} is not committed at the closing SHA ${head}: git cat-file exited ${found.status}: ${found.stderr.trim() || 'no output'}.`, `Write ${adr.path} in the kb/adr.md form, merge it to ${main}, and record new closing evidence.`)
  }
  return receipt
}

// Model: models/workflow/epic_workflow.qnt#recordDebt
function addDebt(workspace, e, before, v) {
  if (!v.file) bad('Debt requires --file <json>.')
  const debt = readObject(resolve(workspace.root, v.file))
  if (debt.sub !== undefined && !e.issues[debt.sub]) bad(`Debt sub-issue #${debt.sub} is outside epic #${e.epic}.`)
  try { recordDebt(e, debt, Date.now()) } catch (error) { if (error instanceof DebtRefused) throw error; bad(error.message) }
  if (isDeepStrictEqual(e, before)) return epicResult(e)
  return save(workspace, e, before, 'epicDebt', e.state, e.state)
}

// Model: models/workflow/epic_workflow.qnt#ruleDebt
function ruleDebt(workspace, e, before, key, v) {
  const debt = e.debts?.find(item => item.key === key)
  if (!debt) bad(`Unknown debt ${key} in epic #${e.epic}.`)
  if (!v.file) bad('A debt ruling requires --file <json>.')
  const ruling = readObject(resolve(workspace.root, v.file))
  const problem = rulingProblem(ruling)
  if (problem) bad(`Debt ${key} ${problem}.`)
  const conflict = rulingConflict(debt, ruling)
  if (conflict) refuse(`${conflict}.`, `Keep the ruling, or record what changed as a new debt with its own key and rule on that.`)
  if (debt.ruling) return epicResult(e)
  if (ruling.verdict === 'issue-filed') {
    const found = github(e.root, e.repo, `/issues/${ruling.issue}`)
    if (found?.number !== ruling.issue || found.state !== 'open' || found.pull_request) refuse(`Debt ${key} needs an open follow-up issue #${ruling.issue} in ${e.repo}.`)
  }
  debt.ruling = ruling
  if (isDeepStrictEqual(e, before)) return epicResult(e)
  return save(workspace, e, before, 'epicDebtRuling', e.state, e.state)
}

function specPull(root, e, value) {
  if (value === undefined) bad(`Finishing spec-review requires --spec-pr: the PR of the spec, whose body says "Refs #${e.epic}" and no closing keyword for it.`)
  const n = number(value, 'spec PR')
  const pr = github(root, e.repo, `/pulls/${n}`)
  if (pr?.number !== n) refuse(`Spec PR #${n} is not a pull request in ${e.repo}.`, `Give the number of the spec PR with --spec-pr.`)
  const problem = specPrProblem(pr.body ?? '', e.repo, e.epic)
  if (problem) refuse(`Spec PR #${n}: ${problem}.`, `Run gh pr edit ${n} --repo ${e.repo} --body-file <file> with "Refs #${e.epic}" and no closing keyword for #${e.epic}: the sub-issue PRs close their own issues, and the epic closes after closing. Then repeat ndev epic phase ${e.epic} spec-review.`)
  const out = checked('gh', ['pr', 'view', String(n), '-R', e.repo, '--json', 'closingIssuesReferences'], { cwd: root, repair: `Run gh pr view ${n} --repo ${e.repo} --json closingIssuesReferences, then repeat ndev epic phase ${e.epic} spec-review.` })
  let links
  try { links = JSON.parse(out).closingIssuesReferences } catch (error) { refuse(`Spec PR #${n}: gh pr view printed invalid JSON for closingIssuesReferences: ${error.message}.`) }
  const linked = specPrLinkProblem(links, e.repo, e.epic)
  if (linked) refuse(`Spec PR #${n}: ${linked}.`, `${specPrLinkRepair(n, e.repo, e.epic)}. Then repeat ndev epic phase ${e.epic} spec-review.`)
  return n
}

// Model: models/workflow/epic_workflow.qnt#finishPhase
function phase(workspace, e, before, finished, v) {
  if (finished !== e.state || !nextEpicState(finished)) refuse(`Epic #${e.epic} is ${e.state}, so ${finished} cannot finish.`)
  if (!v.evidence?.trim()) bad(`Finishing ${finished} requires --evidence.`)
  if (v['closing-file'] && finished !== 'closing') bad('--closing-file is only for closing.')
  if (v['spec-pr'] !== undefined && finished !== 'spec-review') bad('--spec-pr is only for spec-review.')
  for (const flag of ['approval', 'cap-override']) if (v[flag] !== undefined && finished !== 'slicing') bad(`--${flag} is only for slicing.`)
  if (finished === 'closing') e.closing = closingReceipt(workspace, e, v['closing-file'])
  if (finished === 'framing' && !v.aim?.trim()) bad('Finishing framing requires --aim.')
  const sources = (v.source ?? []).map(s => s.trim()).filter(Boolean)
  if (finished !== 'framing' && sources.length) bad('--source is only for framing.')
  if (finished === 'framing') {
    const problem = sourceProblem(sources)
    if (problem) bad(`Finishing framing requires --source: ${problem}.`)
    for (const path of sourcePaths(sources)) if (!statSync(resolve(workspace.root, path), { throwIfNoEntry: false })) refuse(`Framing source ${path} does not exist at ${resolve(workspace.root, path)}.`, `Give the right path or link with --source ${SOURCE_FORM}.`)
  }
  const files = [...(v.file ?? []), ...(finished === 'closing' && v['closing-file'] ? [v['closing-file']] : [])].map(f => resolve(workspace.root, f))
  if (['researching', 'specifying', 'spec-review'].includes(finished) && !files.length) bad(`Finishing ${finished} requires --file.`)
  if (finished === 'framing' && !files.length) bad('Finishing framing requires --file: the one-page core idea, with the aim, the central mechanism and 3 to 5 acceptance examples that the human signed off.')
  if (finished === 'framing' && files.length > 1) bad(`Finishing framing takes one --file, the one-page core idea, and it got ${files.length}: ${files.join(', ')}.`)
  for (const f of files) if (!statSync(f, { throwIfNoEntry: false })?.isFile()) refuse(`Missing phase evidence file ${f}.`)
  if (finished === 'spec-review') e.specPr = specPull(workspace.root, e, v['spec-pr'])
  if (finished === 'framing') {
    const problem = coreIdeaProblem(readFileSync(files[0], 'utf8'))
    if (problem) refuse(`Core idea ${files[0]}: ${problem}.`, `Write the acceptance examples that the human signs off into ${files[0]}, then repeat ndev epic phase ${e.epic} framing.`)
    e.coreIdea = files[0]
  }
  if (finished === 'slicing' && !v.approval?.trim()) bad('Finishing slicing requires --approval: the human\'s approval of the breakdown (title, blocked by, what it delivers), given before any issue was filed.')
  if (finished === 'slicing') {
    const state = github(workspace.root, e.repo, `/issues/${e.epic}`)?.state
    if (state !== 'open') refuse(`Epic #${e.epic} is ${state ?? 'unknown'} on GitHub, so its sub-issues cannot be coordinated.`, `gh issue reopen ${e.epic} --repo ${e.repo}${e.specPr ? `, and check that spec PR #${e.specPr} no longer closes it: ${specPrLinkRepair(e.specPr, e.repo, e.epic)}` : ''}. Then repeat ndev epic phase ${e.epic} slicing.`)
    e.issues = slices(workspace.root, e, v['issues-file'])
    const count = Object.keys(e.issues).length
    const reason = v['cap-override']?.trim()
    if (count > SLICE_CAP && !reason) refuse(`Epic #${e.epic} has ${count} sub-issues, above the cap of ${SLICE_CAP}.`, `Split the epic into child epics, each with its own part of the spec, or record the human's override with --cap-override <reason>.`)
    if (count > SLICE_CAP) recordDebt(e, { key: `slicing:cap:${e.history.length}`, kind: 'gate-override', note: capNote(count, reason) }, Date.now())
  }
  if (finished === 'coordinating' && Object.values(e.issues).some(s => s.state !== 'merged')) refuse('Every sub-issue must be recorded as merged before closing.')
  if (v.aim) e.aim = v.aim
  if (finished === 'framing') e.sources = sources.map(s => sourcePaths([s]).length ? resolve(workspace.root, s) : s)
  e.evidence[finished] = { text: v.evidence, at: Date.now(), files, ...(finished === 'slicing' ? { approval: v.approval.trim() } : {}) }
  e.state = nextEpicState(finished)
  return save(workspace, e, before, 'epicPhase', finished, e.state)
}

function branchFor(e) {
  const branch = github(e.root, e.repo, '')?.default_branch
  if (typeof branch !== 'string' || !branch.trim()) refuse(`GitHub omitted the default branch for ${e.repo}.`)
  return branch
}

const isRepo = (a, b) => a.toLowerCase() === b.toLowerCase()

// Model: models/workflow/epic_workflow.qnt#otherOwnerOpensPr
function refuseClosingPr(e, sub, since) {
  const shown = `gh issue view ${sub.issue} --repo ${e.repo} --json closedByPullRequestsReferences`
  const script = process.env.NDEV_FLOW_GH || join(releaseRoot, 'scripts/github/gh.sh')
  const out = checked('bash', [script, 'view-json', 'issue', String(sub.issue), '--fields', 'closedByPullRequestsReferences'], { cwd: e.root, env: { ...process.env, GH_REPO: e.repo }, repair: `Run ${shown}, then retry.` })
  let refs
  try { refs = JSON.parse(out).closedByPullRequestsReferences } catch (error) { refuse(`Closing PR evidence of #${sub.issue} is invalid JSON: ${error.message}.`, `Run ${shown}, then retry.`) }
  if (!Array.isArray(refs) || refs.length >= 100) refuse(`Closing PR evidence of #${sub.issue} is missing or may be truncated: ${JSON.stringify(refs)}.`, `Run ${shown}, then retry.`)
  const pulls = refs.flatMap(ref => {
    const repo = `${ref?.repository?.owner?.login}/${ref?.repository?.name}`
    if (!ref?.repository?.owner?.login || !ref.repository.name) refuse(`Closing PR ${JSON.stringify(ref)} of #${sub.issue} names no repository.`, `Run ${shown}, then retry.`)
    const pull = github(e.root, repo, `/pulls/${number(ref.number, 'closing PR')}`)
    return [{ repo, number: ref.number, created: Date.parse(pull.created_at), open: pull.state === 'open', merged: pull.merged === true }]
  })
  const merged = pulls.filter(pr => pr.merged && isRepo(pr.repo, e.repo))
  if (merged.length) refuse(`Sub-issue #${sub.issue} is waiting, but GitHub says its closing ${merged.map(pr => `PR #${pr.number}`).join(', ')} has merged, so its work is already done.`, merged.length === 1 ? `Run ndev epic issue ${e.epic} ${sub.issue} merged --pr ${merged[0].number} --override <reason>, which records the merge and its review debt.` : `Read each with ${merged.map(pr => `gh pr view ${pr.number} --repo ${e.repo}`).join(', ')}, then record the one that closes #${sub.issue} with ndev epic issue ${e.epic} ${sub.issue} merged --pr <n> --override <reason>.`)
  const open = pulls.filter(pr => pr.open)
  const own = pr => isRepo(pr.repo, e.repo) && pr.created > sub.briefedAt
  const others = since ? open.filter(pr => !own(pr)) : open
  if (others.length) refuse(`Sub-issue #${sub.issue} is waiting, but GitHub says its closing ${others.map(pr => isRepo(pr.repo, e.repo) ? `PR #${pr.number}` : `PR ${pr.repo}#${pr.number}`).join(', ')} is open, so another owner works on it.`, closingPrRepair(e, sub, others, own))
}

function closingPrRepair(e, sub, open, own) {
  const foreign = open.filter(pr => !isRepo(pr.repo, e.repo))
  if (foreign.length) return `${foreign.map(pr => `Read it with gh pr view ${pr.number} --repo ${pr.repo}.`).join(' ')} Close it, or remove its closing reference to ${e.repo}#${sub.issue}, then retry.`
  const imports = `run ndev epic import ${e.epic} --issues-file <json> --evidence <text>. If it still records #${sub.issue} as waiting, remove ${open.map(pr => `PR #${pr.number}`).join(', ')} from the Development section of #${sub.issue}.`
  if (open.every(own)) return `If the worker that you started from the last brief opened it, run ndev epic issue ${e.epic} ${sub.issue} implementing --worker <dispatch id> --workspace <path>. If not, ${imports}`
  return `R${imports.slice(1)}`
}

// Model: models/workflow/epic_workflow.qnt#brief
function brief(workspace, e, before, sub, role, pr) {
  if (!['implementer','reviewer'].includes(role)) bad('Name implementer or reviewer.')
  if (e.state !== 'coordinating') refuse(`Epic #${e.epic} is ${e.state}.`)
  if (['external', 'human-pending', 'merged'].includes(sub.state)) refuse(`Sub-issue #${sub.issue} is ${sub.state}; it cannot receive a new ${role} worker.`, `Run ndev epic status ${e.epic} and contact its existing owner.`)
  if (role === 'implementer' && sub.state !== 'waiting') refuse(`Sub-issue #${sub.issue} is ${sub.state}; an implementer brief is only for a waiting sub-issue.`, sub.implementer ? `Its implementer is dispatch:${sub.implementer}: message it with orca orchestration send.` : `Run ndev epic status ${e.epic} for its owner.`)
  const placement = role === 'implementer' ? e.remote : sub.remote
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
    if (![...f.ready, ...f.stacked.map(s => s.sub)].includes(sub)) refuse(`Sub-issue #${sub.issue} is outside the current frontier.`)
    refuseClosingPr(e, sub)
    const base = branchFor(e)
    const plan = stackPlan(e, sub)
    if (plan?.why) refuse(plan.why)
    let stack
    if (plan?.on) {
      const head = github(e.root, e.repo, `/pulls/${plan.on.pr}`)
      // Model: models/workflow/epic_workflow.qnt#humanMergesPr
      // Model: models/workflow/epic_workflow.qnt#humanClosesPr
      if (head.state !== 'open' || head.merged || !head.head?.ref) refuse(`Blocker PR #${plan.on.pr} is ${head.state}. Its branch cannot carry #${sub.issue}.`)
      stack = { on: plan.on, branch: head.head.ref, base }
      sub.stackedOn = plan.on.issue
    } else delete sub.stackedOn
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
  if (role === 'implementer') sub.briefedAt = Date.now()
  if (!isDeepStrictEqual(e, before)) save(workspace, e, before, 'epicBrief', sub.state, sub.state)
  return { path, argv, role, agent: config.agent, model: config.model, remote: placement, issue: sub.issue }
}

// Model: models/workflow/epic_workflow.qnt#verify
function verify(e, sub) {
  const under = e.issues[sub.stackedOn]
  if (under && under.state !== 'merged') refuse(`#${sub.issue} is stacked on unmerged #${under.issue}.`, `Record the merge of PR #${under.pr}, then rebase and retarget PR #${sub.pr}.`)
  const endpoint = `/pulls/${sub.pr}`
  const pr = github(e.root, e.repo, endpoint)
  const main = branchFor(e)
  // Model: models/workflow/epic_workflow.qnt#humanClosesPr
  // Model: models/workflow/epic_workflow.qnt#workerMarksReady
  // Model: models/workflow/epic_workflow.qnt#baseMoves
  // Model: models/workflow/epic_workflow.qnt#retarget
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
  // Model: models/workflow/epic_workflow.qnt#ciEnds
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
  // Model: models/workflow/epic_workflow.qnt#workerPushes
  if (fresh.head?.sha !== sha || fresh.base?.ref !== main || fresh.state !== 'open' || fresh.draft || fresh.mergeable !== true) refuse(`PR #${sub.pr} changed during verification of ${sha}.`)
  const omitted = rollup.filter(check => check.conclusion === 'SKIPPED').map(check => check.name ?? check.context)
  if (!rollup.length) omitted.push('ci:no-checks')
  recordDebts(e, omitted.map((check, index) => ({ key: `verify:${sub.issue}:${sha}:${index}`, kind: 'skipped-check', sub: sub.issue, check, note: `PR #${sub.pr} skipped ${check} at ${sha}` })), Date.now(), { places: 1 })
  return { sha, base: main, checks: rollup.map(check => [check.workflowName, check.name ?? check.context].filter(Boolean).join('/')) }
}

// Model: models/workflow/epic_workflow.qnt#retarget
function prepareMergeHandoffs(e, sub) {
  const children = Object.values(e.issues).filter(item => item.stackedOn === sub.issue && item.state !== 'merged' && item.handoff?.blocker !== sub.issue)
  const main = children.length && branchFor(e)
  for (const child of children) child.handoff = { state: 'pending', blocker: sub.issue, message: `PR #${sub.pr} is merged. Rebase #${child.issue} onto origin/${main}, checkpoint the rebased branch, and retarget ${child.pr ? `PR #${child.pr}` : 'your PR'} to ${main}. Report the new PR head.` }
}

function handoffs(workspace, e, parents) {
  const failures = []
  const inspect = 'Inspect the Orca Run mailbox and its receipt before resending the rebase instructions.'
  for (const sub of Array.isArray(parents) ? parents : [parents]) {
    for (const child of Object.values(e.issues).filter(item => item.state !== 'merged' && item.stackedOn === sub.issue && item.handoff?.blocker === sub.issue && !['sent', 'owner'].includes(item.handoff.state))) {
      const h = child.handoff
      if (!child.implementer) {
        const brief = `ndev epic brief ${e.epic} ${child.issue} implementer`
        const owned = ['external', 'human-pending'].includes(child.state)
        const repair = owned ? `Tell the existing owner of #${child.issue} to rebase onto the default branch and retarget its PR; this epic does not message it.` : child.state === 'blocked' ? `Run ndev epic issue ${e.epic} ${child.issue} ${child.previous}, then ${brief}: it starts from the default branch.` : `Generate a new brief with ${brief}: it starts from the default branch.`
        if (owned) {
          const before = structuredClone(e)
          h.state = 'owner'
          save(workspace, e, before, 'handoff-owner', sub.state, sub.state)
        }
        failures.push({ issue: child.issue, recipient: 'no implementer', message: `#${child.issue} is ${child.state} and stacked on merged #${sub.issue}, and it has no implementer to receive the rebase.`, repair })
        continue
      }
      const recipient = `dispatch:${child.implementer}`
      if (h.state === 'sending' && !h.requestId) {
        failures.push({ issue: child.issue, recipient, message: `Delivery to ${child.implementer} is uncertain for #${child.issue}.`, repair: inspect })
        continue
      }
      const firstAttempt = h.state === 'pending' && !h.requestId
      const before = structuredClone(e)
      h.state = 'sending'
      save(workspace, e, before, 'handoff-start', sub.state, sub.state)
      const recorded = structuredClone(e)
      const args = ['orchestration','send','--to',recipient,'--subject',`Rebase #${child.issue} after #${sub.issue} merged`,'--body',h.message,...(e.run ? ['--run',e.run] : []),...(h.requestId ? ['--retry-request',h.requestId] : []),'--full','--json']
      const out = run('orca', args, { cwd: workspace.root })
      let receipt
      try { receipt = JSON.parse(out.stdout) } catch {}
      if (out.status !== 0 || receipt?.ok !== true || receipt.result?.accepted === false || receipt.result?.delivered === false || !receipt.result) {
        const launchFailed = out.pid === 0 && ['ENOENT', 'EACCES', 'ENOTDIR', 'ENOEXEC', 'E2BIG'].includes(out.error?.code)
        const requestId = receipt?.error?.data?.orchestrationRequestId ?? receipt?.error?.data?.requestId ?? h.requestId
        if (requestId !== undefined) h.requestId = requestId
        h.error = receipt?.error ?? (out.error ? { ...out.error, ...(out.pid !== undefined ? { pid: out.pid } : {}) } : out.stderr.trim() || out.stdout.trim())
        if (firstAttempt && launchFailed && !h.requestId) h.state = 'pending'
        save(workspace,e,recorded,h.state === 'pending' ? 'handoff-not-launched' : 'handoff-uncertain',sub.state,sub.state)
        const retry = `Retry ndev epic issue ${e.epic} ${sub.issue} merged.`
        const repair = launchFailed ? `Restore orca on PATH, run orca --version, then ${retry}` : h.requestId ? retry : inspect
        failures.push({ issue: child.issue, recipient, message: `Orca send to ${recipient} exited ${out.status}: ${JSON.stringify(h.error)}`, exitCode: out.status, error: h.error, receipt, requestId: h.requestId, repair })
        continue
      }
      h.state = 'sent'
      h.receipt = receipt.result
      save(workspace,e,recorded,'handoff-sent',sub.state,sub.state)
    }
  }
  if (failures.length) throw new CliError(1, `Epic #${e.epic} is saved at revision ${e.revision}. Handoff delivery failed: ${failures.map(f => `#${f.issue} (${f.recipient}): ${f.message}`).join('; ')}`, { details: { revision: e.revision, failures }, repair: [...new Set(failures.map(f => f.repair))].join(' ') })
  return epicResult(e)
}

function move(workspace, e, before, sub, to, v) {
  if (e.state !== 'coordinating') refuse(`Epic #${e.epic} is ${e.state}.`)
  if (!ISSUE_STATES.includes(to)) bad(`Unknown sub-issue state ${to}.`)
  const from = sub.state
  if (v.workspace && (sub.remote ? !/^.+::\/.+/.test(v.workspace) || (sub.remoteRepo?.startsWith('id:') && !v.workspace.startsWith(sub.remoteRepo.slice(3) + '::/')) : !v.workspace.startsWith('/'))) bad(`Invalid workspace ${v.workspace} for ${sub.remote?.id ?? 'local'}.`)
  if (['external', 'human-pending'].includes(from)) refuse(`Issue #${sub.issue} is ${from}; its existing owner must resume it.`, `Refresh evidence with ndev epic import ${e.epic} --issues-file <json> --evidence <text>.`)
  if (from === 'merged' && to === 'merged') return handoffs(workspace,e,sub)
  // Model: models/workflow/epic_workflow.qnt#block
  if (to === 'blocked' && !['blocked','merged'].includes(from)) {
    if (!v.note?.trim()) bad(`Blocking #${sub.issue} requires --note.`)
    sub.previous = from
    delete sub.lost
  // Model: models/workflow/epic_workflow.qnt#unblock
  } else if (from === 'blocked' && sub.previous === to) {
    const inFlight = Object.values(e.issues).filter(i => IN_FLIGHT.includes(i.state))
    if (IN_FLIGHT.includes(to) && inFlight.length >= e.parallel) refuse(`Issue #${sub.issue} goes back to ${to}, and all ${e.parallel} parallel places are taken by ${inFlight.map(i => `#${i.issue}`).join(', ')}.`, `Wait for one to merge, or raise parallel with ndev epic start ${e.epic} --parallel <n>.`)
    delete sub.previous
    delete sub.lost
  }
  else if (from === to && v.workspace && from !== 'blocked') sub.workspace = v.workspace
  // Model: models/workflow/epic_workflow.qnt#start
  else if (from === 'waiting' && to === 'implementing') {
    const f = frontier(e)
    const stack = f.stacked.find(s => s.sub === sub)
    if (!f.ready.includes(sub) && !stack) refuse(`Issue #${sub.issue} is outside the current frontier.`)
    if (stack && sub.stackedOn !== stack.on.issue) refuse(`Issue #${sub.issue} needs a brief stacked on #${stack.on.issue}.`)
    if (e.remote && !sub.remote) refuse(`Generate the remote implementer brief for #${sub.issue} first.`)
    if (!v.worker) bad('Implementing requires --worker.')
    refuseClosingPr(e, sub, sub.briefedAt)
    sub.implementer = v.worker
  // Model: models/workflow/epic_workflow.qnt#toReviewing
  } else if (from === 'implementing' && to === 'reviewing') {
    if (!v.worker || !v.pr) bad('Reviewing requires the PR number and reviewer dispatch ID.')
    sub.pr = number(v.pr, 'PR')
    const pr = github(e.root, e.repo, `/pulls/${sub.pr}`)
    if (pr.state !== 'open' || pr.merged !== false || pr.draft !== false) refuse(`PR #${sub.pr} of #${sub.issue} must be open and ready for review; GitHub reports state ${pr.state}, merged ${pr.merged}, draft ${pr.draft}.`, `Have the implementer open the PR or mark it ready with gh pr ready ${sub.pr} --repo ${e.repo}, then repeat ndev epic issue ${e.epic} ${sub.issue} reviewing.`)
    sub.reviewer = v.worker
  // Model: models/workflow/epic_workflow.qnt#toFixing
  } else if (from === 'reviewing' && to === 'fixing') {
    if (v.verdict !== 'changes' || !v.note?.trim()) bad('Fixing requires --verdict changes and --note.')
    sub.rounds = (sub.rounds ?? 0) + 1
    sub.verdict = 'changes'
  // Model: models/workflow/epic_workflow.qnt#fixedToReviewing
  } else if (from === 'fixing' && to === 'reviewing') {
    if (v.worker) sub.reviewer = v.worker
  // Model: models/workflow/epic_workflow.qnt#reverify
  } else if (from === 'verified' && to === 'reviewing') {
    const checkedSha = sub.verification?.sha
    if (!checkedSha) refuse(`Sub-issue #${sub.issue} is verified but its record has no verified head.`, `Restore the last valid ${pathFor(workspace.root, e.epic)}.`)
    const pr = github(e.root, e.repo, `/pulls/${sub.pr}`)
    if (pr.state !== 'open' || pr.merged !== false || !pr.head?.sha) refuse(`PR #${sub.pr} of #${sub.issue} must be open to review again; GitHub reports state ${pr.state}, merged ${pr.merged}, head ${pr.head?.sha}.`, `If it merged, run ndev epic issue ${e.epic} ${sub.issue} merged. If it closed, reopen it with gh pr reopen ${sub.pr} --repo ${e.repo}, or run ndev epic issue ${e.epic} ${sub.issue} blocked --note <text>.`)
    if (pr.head.sha === checkedSha) refuse(`PR #${sub.pr} of #${sub.issue} is at ${pr.head.sha}, the head that verify checked (${checkedSha}), so it has nothing new to review.`, `Merge PR #${sub.pr} and run ndev epic issue ${e.epic} ${sub.issue} merged, or push the change first and then run ndev epic issue ${e.epic} ${sub.issue} reviewing.`)
    if (v.worker) sub.reviewer = v.worker
  // Model: models/workflow/epic_workflow.qnt#verify
  } else if (from === 'reviewing' && to === 'verified') {
    if (v.verdict !== 'approve' && !(v.verdict === 'changes' && v.note?.trim())) bad('Verification requires --verdict approve or resolved changes with --note.')
    sub.verification = verify(e, sub)
    sub.verdict = v.verdict
    delete sub.stackedOn
  // Model: models/workflow/epic_workflow.qnt#recordMerged
  } else if (to === 'merged' && ['waiting','implementing','blocked','reviewing','fixing','verified'].includes(from)) {
    const reviewed = Boolean(sub.reviewer && sub.verdict)
    const override = !['reviewing','fixing','verified'].includes(from)
    if (override && !v.override?.trim()) refuse(`Sub-issue #${sub.issue} is ${from}, not reviewing, fixing or verified, so its merge needs --override <reason>, recorded as override debt.`, 'Repeat the merged move with --pr and --override <reason> to record review debt.')
    if (!override && v.override?.trim()) refuse(`Sub-issue #${sub.issue} is ${from}: a merge from reviewing, fixing or verified owes no override debt.`, 'Repeat the merged move without --override.')
    if (v.pr && sub.pr && number(v.pr, 'PR') !== sub.pr && !(from === 'blocked' && sub.lost && v.override?.trim())) refuse(`Review of PR #${sub.pr} cannot transfer to PR #${v.pr}.`, 'Keep the recorded PR, or reconcile the sub-issue before merging.')
    if (v.pr) sub.pr = number(v.pr, 'PR')
    if (!sub.pr) bad('Merged requires the PR number.')
    const pr = github(e.root, e.repo, `/pulls/${sub.pr}`)
    // Model: models/workflow/epic_workflow.qnt#humanMergesPr
    if (pr.merged !== true) refuse(`GitHub has not merged PR #${sub.pr}.`, from === 'verified' && sub.verification?.sha !== pr.head?.sha ? `PR #${sub.pr} is at ${pr.head?.sha}, not the head ${sub.verification?.sha} that verify checked. Run ndev epic issue ${e.epic} ${sub.issue} reviewing to review and verify it, or merge it and owe verification debt.` : undefined)
    const main = branchFor(e)
    if (pr.base?.ref !== main) landedThroughBlocker(workspace, e, before, sub, pr, main, from)
    delete sub.lost
    if (pr.merge_commit_sha) sub.mergeSha = pr.merge_commit_sha
    const verified = from === 'verified' && sub.verification?.sha === pr.head?.sha
    if (!verified) sub.mergedUnverified = true
    mergeDebts(e, sub, reviewed, verified, Date.now(), v.override?.trim())
    prepareMergeHandoffs(e, sub)
  } else refuse(`Issue #${sub.issue} cannot move from ${from} to ${to}.`)
  if (v.workspace) sub.workspace = v.workspace
  if (v.note) sub.note = v.note
  sub.state = to
  const result = save(workspace, e, before, `epicIssue #${sub.issue}`, from, to)
  return to === 'merged' ? handoffs(workspace, e, sub) : result
}

// Model: models/workflow/epic_workflow.qnt#recordMerged
function landedThroughBlocker(workspace, e, before, sub, pr, main, from) {
  const into = pr.base?.ref ?? '(no base)'
  const again = `ndev epic issue ${e.epic} ${sub.issue} merged --pr <the new PR> --override <reason>`
  const reopen = `Run gh pr create --repo ${e.repo} --base ${main} --head ${pr.head?.ref}, merge that PR, then run ${again}.`
  const on = sub.stackedOn === undefined ? undefined : e.issues[String(sub.stackedOn)]
  const under = on?.pr ? github(e.root, e.repo, `/pulls/${on.pr}`) : undefined
  if (!on || !under || under.head?.ref !== into) refuse(`GitHub says PR #${sub.pr} of #${sub.issue} merged into "${into}", which is not the default branch "${main}"${on?.pr ? ` and not the branch of PR #${on.pr} of #${on.issue}` : ''}, so ${main} does not have it.`, reopen)
  const closed = under.merged !== true && under.state === 'closed'
  if (under.merged !== true && !closed) refuse(`PR #${sub.pr} of #${sub.issue} merged into ${into}, the branch of PR #${on.pr} of #${on.issue}, which is not merged, so ${main} does not have it yet.`, `Merge PR #${on.pr}, run ndev epic issue ${e.epic} ${on.issue} merged, then record #${sub.issue} again.`)
  if (!closed) {
    const landed = Date.parse(under.merged_at ?? '')
    const rode = Date.parse(pr.merged_at ?? '')
    if (Number.isNaN(landed) || Number.isNaN(rode)) refuse(`GitHub gave no merge time for PR #${Number.isNaN(rode) ? sub.pr : on.pr}, so it is not known whether PR #${sub.pr} merged into ${into} before PR #${on.pr} took that branch to ${main}.`, `Read both with gh pr view <n> --repo ${e.repo} --json mergedAt, then record #${sub.issue} again.`)
    if (landed > rode) return
  }
  const why = closed ? `PR #${on.pr} of #${on.issue} closed without merging` : `PR #${on.pr} of #${on.issue} had merged into ${main}`
  const lostText = `PR #${sub.pr} merged into ${into} after ${why}, so its change is not on ${main}.`
  if (from === 'blocked') refuse(lostText, reopen)
  // Model: models/workflow/epic_workflow.qnt#recordLost
  sub.note = `${lostText} ${reopen}`
  sub.previous = from
  sub.state = 'blocked'
  sub.lost = true
  save(workspace, e, before, `epicIssue #${sub.issue}`, from, 'blocked')
  refuse(`Not recorded as merged: ${lostText} #${sub.issue} is now blocked (it was ${from}).`, reopen)
}

function notifyCoordinator(workspace, e, changed, from) {
  const target = e.coordinator
  if (!target) return { ...changed, notification: 'coordinator can read the saved change with ndev epic status' }
  const message = e.off ? `Human ended coordination of epic #${e.epic}.` : `Human moved epic #${e.epic} from ${from} to ${e.state}. Run ndev epic status ${e.epic}.`
  const agentSession = target.session ?? (/^(?:orca_session_id:|structworker_|codex_|claude_)/.test(target.terminal ?? '') ? target.terminal : undefined)
  const argv = agentSession ? ['orchestration','send','--to',agentSession.startsWith('orca_session_id:') ? agentSession : `orca_session_id:${agentSession}`,'--subject','Epic phase changed','--body',message] : target.dispatch ? ['orchestration','send','--to',`dispatch:${target.dispatch}`,'--subject','Epic phase changed','--body',message] : ['terminal','send','--terminal',target.terminal,'--text',message,'--enter','--wait-submit','5']
  const out = run('orca', [...argv,'--json'], { cwd: workspace.root })
  let receipt
  try { receipt = JSON.parse(out.stdout) } catch {}
  if (out.status !== 0 || receipt?.ok !== true || !receipt.result || receipt.result.accepted === false || receipt.result.delivered === false) {
    throw new CliError(1, `Epic #${e.epic} is saved at revision ${e.revision}. Coordinator notification exited ${out.status}: ${receipt?.error?.message || out.stderr.trim() || out.stdout.trim()}`, { details: { receipt, revision: e.revision }, repair: `Read ndev epic status ${e.epic} and inspect the Orca receipt before retrying delivery.` })
  }
  return { ...changed, notification: receipt.result }
}

export async function runEpic([verb, ...args], { json = process.argv.includes('--json') } = {}) {
  const workspace = gitWorkspace()
  if (verb === 'start') return start(workspace, args)
  const specs = {
    import: [{ evidence: string, 'issues-file': string }, 1],
    debt: [{ file: string }, 1], ruling: [{ file: string }, 2],
    phase: [{ evidence: string, file: { ...string, multiple: true }, aim: string, source: { ...string, multiple: true }, approval: string, 'cap-override': string, 'spec-pr': string, 'issues-file': string, 'closing-file': string }, 2],
    next: [{}, 1], brief: [{ pr: string }, 3], issue: [{ pr: string, worker: string, workspace: string, verdict: string, note: string, override: string }, 3],
    status: [{}, 1], skip: [{ issue: string }, 1], goto: [{ issue: string }, 2], off: [{ issue: string }, 0],
  }
  const [opts, count] = specs[verb] ?? bad(`Unknown epic command ${verb}.`)
  const { values: v, positionals: pos } = argsFor(args, opts, `ndev epic ${verb} --help`, { positionals: count })
  const override = ['skip','goto','off'].includes(verb)
  if (['phase','import','next','brief','issue','debt','ruling'].includes(verb) && pos.length !== count) bad(`ndev epic ${verb} requires ${count} positional argument(s).`)
  const raw = override ? v.issue : pos[0]
  const n = raw !== undefined ? number(raw, 'epic') : activeEpic(workspace.root)?.epic
  if (!n) {
    if (verb === 'status') return { epic: null }
    bad('Name the epic number.')
  }
  const execute = workspace => {
    const before = load(workspace.root, n)
    const e = structuredClone(before)
    if (verb === 'status') return { ...epicResult(e), ...(e.state === 'coordinating' ? { frontier: frontier(e) } : {}) }
    if (!override && (e.off || e.owner?.session !== session())) refuse(`This session does not coordinate #${n}.`, `Run ndev epic start ${n}.`)
    if (verb === 'next') return { epic: n, state: e.state, frontier: e.state === 'coordinating' ? frontier(e) : null }
    if (verb === 'import') return importEpic(workspace,e,before,v)
    if (verb === 'debt') return addDebt(workspace,e,before,v)
    if (verb === 'ruling') return ruleDebt(workspace,e,before,pos[1],v)
    if (verb === 'phase') return phase(workspace,e,before,pos[1],v)
    // Model: models/workflow/epic_workflow.qnt#humanMove
    if (override) {
      const from = e.state
      if (verb !== 'off' && from === 'done') refuse(`Epic #${e.epic} is done; ${verb} cannot reopen it.`, `File what remains as new issues, or start a new epic with ndev epic start --title <title>.`)
      // Model: models/workflow/epic_workflow.qnt#humanSkip
      // Model: models/workflow/epic_workflow.qnt#humanGoto
      const to = verb === 'goto' ? pos[0] : nextEpicState(from)
      if (verb !== 'off' && !EPIC_STATES.includes(to)) bad(`Invalid target phase for ${verb}: ${to}.`)
      if (verb !== 'off' && to === 'done') refuse('The closing gate cannot be skipped or bypassed.', `Use ndev epic phase ${e.epic} closing with structured evidence and ruled debt.`)
      const revision = createHash('sha256').update(JSON.stringify(e)).digest('hex').slice(0, 12)
      const action = confirm(`epic ${verb}${verb === 'goto' ? ' ' + to : ''}`, String(n), revision, workspace.root, json)
      if (action) return action
      if (verb === 'off') { e.off = true; delete e.owner }
      else { recordDebt(e, { key: `phase:${from}:${to}:${e.revision}`, kind: 'gate-override', note: pos[verb === 'goto' ? 1 : 0] ?? 'Human override' }, Date.now()); e.state = to; e.evidence[from] = { at: Date.now(), text: pos[verb === 'goto' ? 1 : 0] ?? 'Human override' } }
      return notifyCoordinator(workspace, e, save(workspace,e,before,`human:${verb}`,from,e.state), from)
    }
    const sub = e.issues[number(pos[1], 'sub-issue')]
    if (!sub) refuse(`#${pos[1]} is outside epic #${n}.`)
    return verb === 'brief' ? brief(workspace,e,before,sub,pos[2],v.pr && number(v.pr,'PR')) : move(workspace,e,before,sub,pos[2],v)
  }
  return ['status', 'next'].includes(verb) ? execute(workspace) : mutate(workspace, n, execute)
}
