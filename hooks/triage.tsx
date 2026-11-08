import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { LoadedConfig } from './config'
import { firstLine, gh, ghLines, makeRun, ofRepo, orca, orcaProject, orcaWorktrees, readPullRow, START_ORCA, type Run } from './fix-all-prs'
import { pullUrl } from './links'
import type { PrRow, TriageAgent, TriageComplexity, TriageGroup, TriageIssue, TriageView } from '../types'

// /dev triage (also /orca-triage): this session's model groups the open issues and then coordinates, and Orca does the
// work. Each group becomes one Task of one Orca Run; Orca makes the workspace, linked to the group's issues, and starts a
// supervised Claude worker in it that takes the group through the ndev workflow on one pull request. The session answers
// the workers and reports to the human. The mod keeps only the plan and reads the rest back from Orca.
// With --codex the workers are Codex: they have no mcp__ndev__ tools, so their Task gives the workflow's steps by hand.
const PANE = 'triage'
const TITLE = 'Triage'
const TOOL = 'mcp__ndev__triage_groups'
// Orca's inbox wait hears each worker at once, so the timer is only the safety net: GitHub limits calls, and Orca may spend them.
const TICK_MS = 15 * 60_000
// How often each group's open pull request is read, and its worker prodded when the pull request cannot merge.
const PR_CHECK_MS = 10 * 60_000
// The same fault on the same head is sent again only after this long: a fix and its checks take a while.
const PROD_AGAIN_MS = 30 * 60_000
// One blocking inbox check at a time; a check that times out is an empty wait.
const WAIT_MS = 300_000
const LIMIT = 200

type Size = { model: string; effort: string; when: string }
const WHEN: Record<TriageComplexity, string> = {
  'very-complex': 'very complex, or an epic with more than 2 sub-issues', complex: 'complex', average: 'average', simple: 'simple', 'very-simple': 'very simple',
}
const sized = (m: Record<TriageComplexity, [string, string]>) =>
  Object.fromEntries(Object.entries(m).map(([k, [model, effort]]) => [k, { model, effort, when: WHEN[k as TriageComplexity] }])) as Record<TriageComplexity, Size>
// Codex's sol, terra and luna stand where Claude's opus, sonnet and haiku do.
const SIZES: Record<TriageAgent, Record<TriageComplexity, Size>> = {
  claude: sized({
    'very-complex': ['claude-fable-5-1', 'high'], complex: ['claude-opus-5-5', 'high'], average: ['claude-sonnet-5-5', 'medium'],
    simple: ['claude-haiku-5-5', 'xhigh'], 'very-simple': ['claude-haiku-5-5', 'medium'],
  }),
  codex: sized({
    'very-complex': ['gpt-6.1-sol', 'xhigh'], complex: ['gpt-6.1-sol', 'high'], average: ['gpt-6.1-terra', 'medium'],
    simple: ['gpt-6-luna', 'xhigh'], 'very-simple': ['gpt-6-luna', 'medium'],
  }),
}
const isSize = (s: unknown): s is TriageComplexity => typeof s === 'string' && Object.hasOwn(WHEN, s)
const agentOf = (v: Pick<TriageView, 'agent'>): TriageAgent => v.agent ?? 'claude'
const AGENT_NAME: Record<TriageAgent, string> = { claude: 'Claude', codex: 'Codex' }
// batch: how many workers run at once, each batch after the last has ended; 0 for no limit.
type Options = { isDryRun: boolean; agent: TriageAgent; isOpen: boolean; batch: number }

const EMPTY: TriageView = { phase: 'idle', issues: [], groups: [], log: [] }
const view = atom({ plugin: 'ndev', key: 'triage' } as const, EMPTY, { shape: 'triage-1' })

// Module state, which a reload resets: the tick starts the inbox wait again, and starts run one after another.
let isWaiting = false
let isWatchingPrs = false
let starting: Promise<unknown> = Promise.resolve()
// The inbox messages handled, so a delivery Orca sends again after a failed ack is not handled twice.
const handled = new Set<string>()

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
// The host refuses each $ call once it has unloaded this mod, at the end of a session or a test.
const isUnloaded = (err: unknown) => message(err).includes('no hooks module of that name is loaded')
// Ends a chain that runs detached from its hook. Its own report of a failure calls $ too, so that report fails once
// the mod is unloaded, and nothing is left to show it to. Any other failure is raised again, and stays unhandled.
function detach(work: Promise<unknown>): void {
  void work.catch((err: unknown) => { if (!isUnloaded(err)) throw err })
}
function runner($: EngineInterface, timeoutMs: number, env?: Record<string, string>): Run {
  return makeRun($, timeoutMs, env)
}

async function note($: EngineInterface, text: string): Promise<void> {
  const at = await $.clock.now()
  await update($, view, v => ({ ...v, log: [...v.log, { at, text }].slice(-50) }))
}

// Sends a prompt to this session's model; a prompt the engine drops is shown, never lost.
function ask($: EngineInterface, what: string, text: string): void {
  detach($.prompt.submit({ text }).catch((err: unknown) => {
    $.ui.toast(`/orca-triage could not send ${what} to the model: ${message(err)}`)
    return update($, view, v => ({ ...v, error: `${what} was not sent to the model: ${message(err)}` }))
  }))
}

function setGroup($: EngineInterface, lead: number, change: Partial<TriageGroup>) {
  return update($, view, v => ({ ...v, groups: v.groups.map(g => (g.lead === lead ? { ...g, ...change } : g)) }))
}

// The issues to group: the board's Ready and In progress issue cards, else (and always with --open) the open issues
// with no pull request. An issue an Orca workspace already links is someone's work, so it is left out.
async function collect($: EngineInterface, project: LoadedConfig | undefined, o: Options): Promise<string> {
  const g = project?.config.github
  if (!g?.repo) throw new Error(`no GitHub repository is set for this project.\nRepair: run /dev setup, which saves it in .neil-dev.json.`)
  if (project?.config.workflow === false) throw new Error(`each triage worker needs the ndev workflow, and ${project.path} sets "workflow": false.\nRepair: remove that setting, or work the issues without /dev triage.`)
  const repo = g.repo
  if ((await read($, view)).phase === 'running') return `A triage of ${(await read($, view)).repo} is running. /orca-triage refresh reads it again.`
  await update($, view, () => ({ ...EMPTY, repo, isDryRun: o.isDryRun, agent: o.agent, isOpen: o.isOpen, batch: o.batch || undefined }))
  const run = runner($, 120_000)
  let issues: TriageIssue[]
  if (g.board && !o.isOpen) {
    const env = { GH_REPO: repo, GH_PROJECT_OWNER: g.board.owner, GH_PROJECT_NUMBER: String(g.board.number) }
    const out = await runner($, 120_000, env)(['bash', `${$.plugin.root}/scripts/github/gh.sh`, 'board', 'items'])
    if (out.exitCode !== 0) {
      throw new Error(`gh.sh board items for ${g.board.owner} #${g.board.number} exited ${out.exitCode}: ${(out.stderr.trim() || out.stdout.trim()).slice(0, 300)}\nRepair: check the board with /dev setup, and \`gh auth refresh -s project\` if gh lacks the project scope.`)
    }
    const cards = out.stdout.split('\n').filter(Boolean).map(l => JSON.parse(l) as TriageIssue & { status?: string })
    // A shared board holds other repositories' cards, and a draft card has no url.
    const own = `https://github.com/${repo}/issues/`.toLowerCase()
    issues = cards.filter(c => (c.status === 'Ready' || c.status === 'In progress') && typeof c.url === 'string' && c.url.toLowerCase().startsWith(own))
      .map(({ number, title, url }) => ({ number, title, url }))
  } else {
    issues = await ghLines<TriageIssue>(run, ['issue-search', '-linked:pr', '--limit', String(LIMIT + 1)])
    if (issues.length > LIMIT) {
      throw new Error(`${repo} has more than ${LIMIT} open issues with no pull request, more than one triage groups well.\nRepair: put the issues to work on in a GitHub project board's Ready column, save the board with /dev setup, and run /orca-triage start again${g.board ? ' without --open' : ''}.`)
    }
  }
  const linked = new Set(ofRepo(await orcaWorktrees(run, ', then run /orca-triage start again'), repo).filter(w => !w.isArchived)
    .flatMap(w => w.linkedItems ?? []).filter(i => i.type === 'issue').map(i => i.number))
  const left = issues.filter(i => !linked.has(i.number)).sort((a, b) => a.number - b.number)
  const skipped = issues.length - left.length
  if (!left.length) {
    await note($, `${issues.length} issues read; none is left without an Orca workspace`)
    return `No issue of ${repo} is left to triage: ${issues.length} read, ${skipped} already linked to an Orca workspace.`
  }
  await update($, view, (v): TriageView => ({ ...v, phase: 'grouping', issues: left }))
  await note($, `asked the model to group ${left.length} issues${skipped ? ` (${skipped} already in Orca workspaces)` : ''}`)
  ask($, 'the issues to group', brief(repo, left, o.agent, o.batch))
  return `Triage of ${repo}: ${left.length} issues sent to the model to group.`
}

function brief(repo: string, issues: TriageIssue[], agent: TriageAgent, batch: number): string {
  const sizes = Object.entries(SIZES[agent]).map(([k, s]) => `  - ${k}: ${s.when} (${s.model}, effort ${s.effort})`).join('\n')
  return [
    `Triage: group these ${issues.length} open issues of ${repo} for ${AGENT_NAME[agent]} Orca workers, one draft pull request per group.`,
    `Read each issue with \`gh issue view <n> --repo ${repo}\` (body, comments, sub-issues) and check the code for work already done.`,
    '',
    ...issues.map(i => `#${i.number} ${i.title} — ${i.url}`),
    '',
    'Rules:',
    '- Put issues about the same bug or area in one group. An epic goes in one group with its sub-issues. A risky change (schema, auth, migration) gets its own group.',
    '- Each issue is in exactly one group. The lead is the lowest issue number in the group.',
    `- complexity sets the worker's model:\n${sizes}`,
    '- hint: where the worker starts: the files, the cause, the approach.',
    '- implemented: true when the code already does what the issues ask, with evidence (file and line, or the commit).',
    '- after: the leads of groups that must finish first: when this group needs their change, or when both change the same files, so the two never edit the same lines at once. Groups with no after run in parallel.',
    ...(batch === 1 ? ['- This triage runs one worker at a time, in the order you list the groups: you decide that order. Put first what unblocks others, is most urgent, or is smallest and safest, so each pull request can merge before the next starts. A group still waits for the groups in its after.'] : []),
    ...(batch > 1 ? [`- This triage runs at most ${batch} workers at a time, in batches, in the order you list the groups: you decide that order. The next batch starts only when every worker of the last one has ended. Put first what unblocks others, is most urgent, or is smallest and safest, and put groups that touch the same files in different batches. A group still waits for the groups in its after.`] : []),
    '',
    `Then call \`${TOOL}\` once with { groups: [{ issues, title, complexity, hint, implemented, evidence, after }] }.`,
    'If it refuses, fix what it names and call it again.',
    '',
    `You are the coordinator of this triage: one Orca worker takes each group through the ndev workflow (kb/workflow.md), and you do none of that work. Never call mcp__ndev__started for these issues, and never edit, commit or open a pull request for them. Answer the workers, decide what to do when one fails, and report to the user. The mod sends you each of these moments.`,
  ].join('\n')
}

type Proposed = { issues?: unknown; title?: unknown; complexity?: unknown; hint?: unknown; implemented?: unknown; evidence?: unknown; after?: unknown }

// The reasons a groups report is refused; none when it can run.
function problems(issues: TriageIssue[], groups: Proposed[]): string[] {
  const out: string[] = []
  const known = new Set(issues.map(i => i.number))
  const nums = (x: unknown) => (Array.isArray(x) ? x.filter((n): n is number => Number.isInteger(n)) : [])
  const leads = new Map<number, number[]>()
  groups.forEach((g, i) => {
    const own = nums(g.issues)
    if (!own.length) { out.push(`group ${i + 1} has no issues`); return }
    const lead = Math.min(...own)
    leads.set(lead, nums(g.after))
    if (g.after !== undefined && (!Array.isArray(g.after) || nums(g.after).length !== g.after.length)) {
      out.push(`the group led by #${lead} has after ${JSON.stringify(g.after)}; give the leads as numbers, as in [12]`)
    }
    if (!isSize(g.complexity)) out.push(`"${String(g.complexity)}" is not a complexity; use one of ${Object.keys(WHEN).join(', ')}`)
    if (typeof g.title !== 'string' || !g.title.trim()) out.push(`the group led by #${lead} has no title`)
    if (g.implemented === true && (typeof g.evidence !== 'string' || !g.evidence.trim())) out.push(`the group led by #${lead} is implemented but gives no evidence`)
    for (const n of own) if (!known.has(n)) out.push(`#${n} is not one of the issues to group`)
  })
  for (const n of known) {
    const count = groups.filter(g => nums(g.issues).includes(n)).length
    if (count === 0) out.push(`#${n} is in no group`)
    if (count > 1) out.push(`#${n} is in ${count} groups`)
  }
  for (const [lead, after] of leads) for (const a of after) if (a === lead || !leads.has(a)) out.push(`the group led by #${lead} runs after #${a}, which leads no group`)
  if (!out.length) {
    // A depth-first walk of the order finds a cycle.
    const seen = new Set<number>()
    const walk = (lead: number, path: number[]): number[] | undefined => {
      if (path.includes(lead)) return [...path.slice(path.indexOf(lead)), lead]
      if (seen.has(lead)) return undefined
      seen.add(lead)
      for (const a of leads.get(lead) ?? []) { const c = walk(a, [...path, lead]); if (c) return c }
      return undefined
    }
    for (const lead of leads.keys()) { const c = walk(lead, []); if (c) { out.push(`the order has a cycle: ${c.map(n => `#${n}`).join(' → ')}`); break } }
  }
  return out
}

function toGroup(g: Proposed, agent: TriageAgent): TriageGroup {
  const issues = (g.issues as number[]).slice().sort((a, b) => a - b)
  const complexity = g.complexity as TriageComplexity
  const implemented = g.implemented === true
  const title = String(g.title).trim()
  return {
    lead: issues[0]!, issues, complexity, ...SIZES[agent][complexity], implemented,
    title: implemented && !title.startsWith('Confirm implemented:') ? `Confirm implemented: ${title}` : title,
    hint: typeof g.hint === 'string' ? g.hint : '', evidence: typeof g.evidence === 'string' ? g.evidence : undefined,
    after: Array.isArray(g.after) ? g.after.filter((n): n is number => Number.isInteger(n)) : [],
  }
}

// The worker's Task: Target, Change, Constraints, Ownership and Observable acceptance, as Orca's worker contract asks.
function spec(repo: string, g: TriageGroup, issues: TriageIssue[], agent: TriageAgent, root: string): string {
  if (agent === 'codex') return codexSpec(repo, g, issues, root)
  const url = (n: number) => issues.find(i => i.number === n)?.url ?? `https://github.com/${repo}/issues/${n}`
  const [lead, ...others] = g.issues
  return [
    `Target: ${repo} ${g.issues.map(n => `#${n} (${url(n)})`).join(', ')}. ${g.title}`,
    `Change: ${g.implemented ? `The code may already do this: ${g.evidence}. Confirm it with a test that proves the behaviour; change code only where it falls short. ` : ''}${g.hint}`,
    'Constraints:',
    `- Use the ndev workflow, with one pull request for this group. Call mcp__ndev__started with issue ${lead}, a shortName that you choose and the mode: heavy for a multi-step, cross-cutting or high-risk change, and light for the others. Then follow the answer of each tool.`,
    ...(others.length ? [`- Then call mcp__ndev__started for ${others.map(n => `#${n}`).join(', ')}, each with the same shortName: each joins the same worktree and PR, with its own closing line.`] : []),
    '- No human is at this terminal, because the coordinator session answers you. After each started, call mcp__ndev__setSteering with steering auto and the reason "An Orca worker of /dev triage: no human is at this terminal, and the coordinator session answers its questions."',
    '- Read each issue with `gh issue view` first. Work test first: a failing regression test through a public interface, then the smallest fix.',
    ...(g.after.length
      ? [
          `- This group follows ${g.after.map(a => `#${a}`).join(', ')}. Your workspace starts from the branch of the first of their open pull requests, or from the default branch when none is open.${g.after.length > 1 ? ' Merge the branches of the other open pull requests into it first.' : ''} Orca mail with the subject "Base branch" names <that branch> when it is not the default branch. Then, when the workflow has opened your draft pull request, run \`gh api -X PATCH repos/{owner}/{repo}/pulls/<number> -f base=<that branch>\`, so the pull request shows only this group's change. With no such mail, change no base.`,
          '- If a tool tells you to move or remove a file that came from a group this one follows, leave the file and ask the coordinator.',
        ]
      : []),
    '- Save work with mcp__ndev__checkpoint and not with git commit or git push. The workflow opens the pull request and links it to this workspace. Merge only when mcp__ndev__done does it.',
    `- The pull request body ends with these lines: Model: ${g.model} and Effort: ${g.effort}.`,
    '- When you need a product or scope decision, ask the coordinator and never guess. Run `orca orchestration ask --question "<question>" --wait --timeout-ms 540000 --json` in the foreground, with a command timeout of 600000 ms. After a timeout, run `orca orchestration ask --resume <message_id> --wait --timeout-ms 540000 --json`. Do not end your turn while a question is open, because the workflow counts that as no progress.',
    '- Call mcp__ndev__blocked only when a person must act on this machine, such as a sign-in.',
    `- If the workflow blocks this issue, for example on an open blocked-by issue, read the message. ${g.after.length ? `When it names only issues of the groups that this group follows (${g.after.map(a => `#${a}`).join(', ')}), their change is in your branch, so call mcp__ndev__unblocked and go on. ` : ''}Ask the coordinator about any other block, and call mcp__ndev__unblocked when it is clear. If nobody can clear it, send worker_done with --outcome failed and the block message.`,
    'Ownership: this workspace and its branch only.',
    `Observable acceptance: mcp__ndev__done accepted a pull request that closes ${g.issues.map(n => `#${n}`).join(', ')}.`,
    'Then send worker_done once, with --outcome succeeded and a body that starts with PR #<number>. If you cannot finish, send it with --outcome failed and the reason.',
  ].join('\n')
}

// A Codex worker's Task. The mcp__ndev__ tools are in Claude Code only, so it follows the workflow's stages by hand,
// with the project's check scripts, and stops at a ready pull request with green checks: a human merges it.
function codexSpec(repo: string, g: TriageGroup, issues: TriageIssue[], root: string): string {
  const url = (n: number) => issues.find(i => i.number === n)?.url ?? `https://github.com/${repo}/issues/${n}`
  const closes = g.issues.map(n => `Closes #${n}`).join(', ')
  return [
    `Target: ${repo} ${g.issues.map(n => `#${n} (${url(n)})`).join(', ')}. ${g.title}`,
    `Change: ${g.implemented ? `The code may already do this: ${g.evidence}. Confirm it with a test that proves the behaviour; change code only where it falls short. ` : ''}${g.hint}`,
    'Constraints:',
    `- Follow the ndev workflow by hand, with one pull request for this group. Its guide is ${root}/kb/workflow.md; read the states, Checks and Rules that the tools enforce. You have none of the ndev plugin\'s tools: they are in Claude Code only, so do each stage yourself as below.`,
    '- No human is at this terminal, because the coordinator session answers you.',
    '- Read each issue with `gh issue view` first. Work test first: a failing regression test through a public interface, watch it fail for the intended reason, then the smallest fix.',
    '- Before each commit, run the project\'s checks in scripts/ndev/workflow/ when they are there: fast-checks.sh <staged files>, then pre-commit-check.sh. Before each push, run pre-push-check.sh. Never skip or weaken a check that fails: fix the cause, or ask the coordinator when the failure is not from this change.',
    '- Commit with git on this workspace\'s branch and push it with `git push -u origin HEAD`. Never push to the default branch.',
    `- After the first push, open the pull request with \`gh pr create --draft --repo ${repo}\`. Its body gives the problem, the result, the test evidence and the limits, then one line each: ${closes}. It ends with these lines: Model: ${g.model} and Effort: ${g.effort}. Then link it to this workspace with \`orca worktree set --worktree "path:$(git rev-parse --show-toplevel)" --pr <number> --workspace-status in-review --json\`, so the coordinator sees it.`,
    ...(g.after.length
      ? [
          `- This group follows ${g.after.map(a => `#${a}`).join(', ')}. Your workspace starts from the branch of the first of their open pull requests, or from the default branch when none is open.${g.after.length > 1 ? ' Merge the branches of the other open pull requests into it first.' : ''} Orca mail with the subject "Base branch" names <that branch> when it is not the default branch. Then give your pull request that base, with \`gh pr create --base <that branch>\` or, once it is open, \`gh pr edit <number> --base <that branch>\`, so it shows only this group's change. With no such mail, keep the default base.`,
          '- If a check or a review tells you to move or remove a file that came from a group this one follows, leave the file and ask the coordinator.',
        ]
      : []),
    '- When the change is complete, review your own diff against the base for scope and accidental changes, run pre-ready-check.sh when it is there, push, and mark the pull request ready with `gh pr ready`. Then wait for its checks with `gh pr checks --watch` and fix each failure until they pass. Do not merge: a human merges.',
    '- When you need a product or scope decision, ask the coordinator and never guess. Run `orca orchestration ask --question "<question>" --wait --timeout-ms 540000 --json` in the foreground, with a command timeout of 600000 ms. After a timeout, run `orca orchestration ask --resume <message_id> --wait --timeout-ms 540000 --json`. Do not end your turn while a question is open.',
    `- If an open blocked-by issue blocks this work, ${g.after.length ? `and it is not one of ${g.after.map(a => `#${a}`).join(', ')}, whose change is in your branch, ` : ''}ask the coordinator. If a person must act on this machine, such as a sign-in, or nobody can clear a block, send worker_done with --outcome failed and the reason.`,
    'Ownership: this workspace and its branch only.',
    `Observable acceptance: a ready pull request on ${repo} whose checks pass and that closes ${g.issues.map(n => `#${n}`).join(', ')}.`,
    'Then send worker_done once, with --outcome succeeded and a body that starts with PR #<number>. If you cannot finish, send it with --outcome failed and the reason.',
  ].join('\n')
}

// One Orca Run, one Task per group in dependency order, then the workers for the ready Tasks.
// The plan is claimed (phase running) before Orca is called, so a second Launch or Start meanwhile is refused.
async function launch($: EngineInterface): Promise<void> {
  let v: TriageView | undefined
  await update($, view, (x): TriageView => {
    v = x
    return x.phase === 'planned' && x.repo ? { ...x, phase: 'running' } : x
  })
  if (v?.phase !== 'planned' || !v.repo) throw new Error(`there is no plan to launch (the triage is ${v?.phase}).\nRepair: run /orca-triage start.`)
  try {
    await create($, v)
  } catch (err) {
    const runId = (await read($, view)).runId
    await update($, view, (x): TriageView => ({ ...x, phase: 'done' }))
    ask($, 'the failed launch', `Triage: the launch stopped part way: ${message(err)}\nNo worker will write to you. Tell the user, with the repair: /orca-triage reset clears this triage, then /orca-triage start begins again.`)
    throw new Error(`the launch stopped part way: ${message(err)}\n${runId ? `Orca Run ${runId} keeps the Tasks it made. ` : ''}Repair: /orca-triage reset clears this triage, then /orca-triage start begins again.`)
  }
  await startReady($)
  waitLater($)
}

async function create($: EngineInterface, v: TriageView): Promise<void> {
  const repo = v.repo!
  const run = runner($, 120_000)
  const created = (await orca(run, ['orchestration', 'run-create', '--objective', `Triage ${repo}: ${v.groups.length} groups`])) as { run?: { id?: string } }
  const runId = created.run?.id
  if (!runId) throw new Error(`orca orchestration run-create answered no Run id: ${JSON.stringify(created).slice(0, 300)}`)
  handled.clear()
  await update($, view, (x): TriageView => ({ ...x, runId }))
  await note($, `Orca Run ${runId} created`)
  const taskOf = new Map<number, string>()
  const ordered: TriageGroup[] = []
  const place = (g: TriageGroup) => {
    if (ordered.includes(g)) return
    for (const a of g.after) place(v.groups.find(x => x.lead === a)!)
    ordered.push(g)
  }
  v.groups.forEach(place)
  for (const g of ordered) {
    const deps = g.after.map(a => taskOf.get(a)!)
    const made = (await orca(run, [
      'orchestration', 'task-create', '--run', runId, '--task-title', g.title, '--display-name', `issue-${g.lead}`,
      '--spec', spec(repo, g, v.issues, agentOf(v), $.plugin.root), ...(deps.length ? ['--deps', JSON.stringify(deps)] : []),
    ])) as { task?: { id?: string; status: string } }
    if (!made.task?.id) throw new Error(`orca orchestration task-create for #${g.lead} answered no Task id: ${JSON.stringify(made).slice(0, 300)}`)
    taskOf.set(g.lead, made.task.id)
    await setGroup($, g.lead, { taskId: made.task.id, task: made.task.status })
  }
}

// Starts a worker for each Task Orca reports ready. A group whose start failed is never started again:
// its error carries Orca's recovery.
function startReady($: EngineInterface): Promise<unknown> {
  starting = starting.then(() => startNow($)).catch((err: unknown) => note($, `starting workers failed: ${message(err)}`))
  return starting
}

const isInFlight = (g: TriageGroup) => !!g.dispatchId && !g.summary && !g.error
// The batch size: --batch <n>, or 1 for a triage saved by --sequential before --batch; 0 for no limit.
const batchOf = (v: TriageView) => v.batch ?? (v.isSequential ? 1 : 0)

async function startNow($: EngineInterface): Promise<void> {
  const v = await read($, view)
  if (v.phase !== 'running' || !v.runId || !v.repo) return
  // --batch: no start while a worker of the last batch has not reported worker_done.
  const batch = batchOf(v)
  if (batch && v.groups.some(isInFlight)) return
  const ready = (await orca(runner($, 60_000), ['orchestration', 'task-list', '--ready', '--run', v.runId])) as { tasks: { id: string }[] }
  // --batch: the coordinator's order of the groups decides which ready groups start next.
  const rank = (id: string) => { const i = v.groups.findIndex(x => x.taskId === id); return i < 0 ? Infinity : i }
  const tasks = batch ? ready.tasks.slice().sort((a, b) => rank(a.id) - rank(b.id)) : ready.tasks
  for (const t of tasks) {
    if (batch && (await read($, view)).groups.filter(isInFlight).length >= batch) break
    const g = (await read($, view)).groups.find(x => x.taskId === t.id)
    if (!g || g.dispatchId || g.error) continue
    try {
      const worktree = g.worktree ?? await makeWorkspace($, v.repo, g, v.issues)
      await startWorker($, v.runId, g, worktree, agentOf(v))
      const now = (await read($, view)).groups.find(x => x.lead === g.lead)
      if (now?.dispatchId && !now.error && now.base) await tellBase($, v.runId, now, now.base)
    } catch (err) {
      await setGroup($, g.lead, { error: message(err) })
      await note($, `#${g.lead}: ${firstLine(message(err))}`)
      askToDecide($, `the failed start of #${g.lead}`, `Triage: the worker for #${g.lead} (${g.title}) did not start:`, message(err), g, v.runId)
    }
  }
  await settle($)
}

// A group that waits for a failed or blocked group never starts. When every group is done, failed or blocked,
// the triage is done.
async function settle($: EngineInterface): Promise<void> {
  const before = await read($, view)
  let hasEnded = false
  await update($, view, (x): TriageView => {
    const groups = x.groups.slice()
    const isStuck = (g: TriageGroup) => !!g.error || g.task === 'failed' || g.blockedBy !== undefined
    for (let changed = true; changed;) {
      changed = false
      groups.forEach((g, i) => {
        if (g.dispatchId || isStuck(g)) return
        const by = g.after.find(a => { const d = groups.find(y => y.lead === a); return d && isStuck(d) })
        if (by !== undefined) { groups[i] = { ...g, blockedBy: by }; changed = true }
      })
    }
    const isOver = groups.every(g => g.task === 'completed' || isStuck(g))
    hasEnded = x.phase === 'running' && isOver
    return { ...x, groups, phase: x.phase === 'running' && isOver ? 'done' : x.phase }
  })
  const after = await read($, view)
  for (const g of after.groups) {
    if (g.blockedBy !== undefined && before.groups.find(y => y.lead === g.lead)?.blockedBy === undefined) await note($, `#${g.lead}: blocked, as #${g.blockedBy} failed`)
  }
  if (hasEnded) {
    await note($, 'every group is done, failed or blocked')
    ask($, 'the end of the triage', [
      `Triage of ${after.repo}: every group has ended. Report to the user, with a link to each pull request and issue, what each group reached and what needs them. Read each pull request with gh first, because this list can be behind.`,
      '',
      ...after.groups.map(g => `#${g.lead} ${g.title}: ${g.error ?? (g.blockedBy !== undefined ? `blocked, as #${g.blockedBy} failed` : g.task ?? 'no state')}${g.pr && after.repo ? `, ${pullUrl(after.repo, g.pr)}` : ', no pull request recorded'}`),
    ].join('\n'))
  }
}

// Orca makes the workspace from the default branch and links the group's issues to it before setup runs.
async function makeWorkspace($: EngineInterface, repo: string, g: TriageGroup, issues: TriageIssue[]): Promise<string> {
  const refs = g.issues.flatMap(n => ['--reference', issues.find(i => i.number === n)?.url ?? `https://github.com/${repo}/issues/${n}`])
  const base = await baseOf($, repo, g)
  const made = (await orca(runner($, 600_000), [
    'worktree', 'create', '--project', orcaProject(repo), '--name', `issue-${g.lead}`, '--no-parent', '--setup', 'run', '--comment', g.title, ...refs,
    ...(base ? ['--base-branch', `origin/${base}`] : []),
  ])) as { worktree?: { id?: string } }
  const id = made.worktree?.id
  if (!id) throw new Error(`orca worktree create for #${g.lead} answered no worktree id: ${JSON.stringify(made).slice(0, 300)}${START_ORCA}`)
  await setGroup($, g.lead, { worktree: id, base })
  await note($, `#${g.lead}: Orca made workspace issue-${g.lead}`)
  return id
}

// A group that follows others starts from the head branch of the first of their open pull requests, so it carries the
// change it waits for and its own pull request stacks on that one. Undefined when none is open: a merged pull request
// has its change on the default branch, and its branch may be gone.
async function baseOf($: EngineInterface, repo: string, g: TriageGroup): Promise<string | undefined> {
  if (!g.after.length) return undefined
  const groups = (await read($, view)).groups
  const worktrees = await orcaWorktrees(runner($, 60_000))
  for (const a of g.after) {
    const before = groups.find(x => x.lead === a)
    const pr = worktrees.find(w => w.id === before?.worktree)?.linkedPR ?? before?.pr
    if (!pr) { await note($, `#${g.lead}: #${a}, which it follows, has no known pull request`); continue }
    const pr_ = await gh(runner($, 60_000), ['pr-read', String(pr)]) as { state?: string; head?: { ref?: string } }
    if (pr_.state !== 'open') continue
    const headRefName = pr_.head?.ref
    if (!headRefName) throw new Error(`gh.sh pr-read ${pr} of ${repo} answered no head branch, so the branch #${g.lead} follows is unknown`)
    return headRefName
  }
  return undefined
}

// Codex stops at a "Hooks need review" screen when a hook is new or changed, and orchestration worker-start passes no CLI flags.
const HOOK_TRUST = 'Codex waits for the user to trust hooks that are new or changed. Repair: in Orca Settings → Agents, give Codex the default argument --dangerously-bypass-hook-trust (or choose "Trust all and continue" once in a Codex tab), then release this worker and start the Task again.'

type StartReceipt = {
  dispatchId?: string; state?: string; failedStage?: string; lastError?: string; recovery?: string
  launch?: { effective?: { model?: string; effort?: string } }; effects?: { kind?: string; role?: string; id?: string }[]
}

// worker-start prints its receipt with `ok: true` even when the start failed and it exits 1, so the receipt's
// state decides, not the exit code.
async function startWorker($: EngineInterface, runId: string, g: TriageGroup, worktree: string, agent: TriageAgent): Promise<void> {
  const args = ['orchestration', 'worker-start', '--task', g.taskId!, '--run', runId, '--worktree', `id:${worktree}`,
    '--agent', agent, '--model', g.model, '--effort', g.effort, '--timeout-ms', '120000', '--full', '--json']
  const out = await $.process.run(['orca', ...args], { timeoutMs: 180_000 })
  let reply: { ok?: boolean; result?: StartReceipt; error?: { code?: string; message?: string } } | undefined
  try {
    reply = JSON.parse(out.stdout) as typeof reply
  } catch {
    throw new Error(`orca orchestration worker-start for #${g.lead} exited ${out.exitCode} and printed no JSON: ${(out.stderr.trim() || out.stdout.trim()).slice(0, 300)}${START_ORCA}`)
  }
  if (!reply?.ok || !reply.result) {
    throw new Error(`orca orchestration worker-start for #${g.lead} refused: ${reply?.error?.code ?? ''}: ${reply?.error?.message ?? JSON.stringify(reply).slice(0, 300)}\nRepair: fix what Orca names, then /orca-triage reset and /orca-triage start again; \`orca orchestration task-list --run ${runId} --json\` shows the Task.`)
  }
  const r = reply.result
  const terminal = r.effects?.find(x => x.kind === 'terminal' && x.role === 'agent')?.id
  const effective = r.launch?.effective ? `${r.launch.effective.model ?? g.model} · ${r.launch.effective.effort ?? g.effort}` : undefined
  if (r.state !== 'ready') {
    const waits = r.lastError === 'agent_prompt_blocked' ? '\nA prompt waits in the worker\'s terminal: Jump to it and answer it.'
      : /hooks-review/.test(r.lastError ?? '') ? `\n${HOOK_TRUST}` : ''
    await setGroup($, g.lead, { dispatchId: r.dispatchId, terminal, error: `worker-start failed: ${r.lastError ?? r.state} at ${r.failedStage ?? 'an unknown stage'}${waits}\n${r.recovery ?? 'Orca gave no recovery.'}` })
    await note($, `#${g.lead}: the worker did not start: ${r.lastError ?? r.state}`)
    askToDecide($, `the failed start of #${g.lead}`, `Triage: the worker for #${g.lead} (${g.title}) did not start: ${r.lastError ?? r.state} at ${r.failedStage ?? 'an unknown stage'}.${waits}`, r.recovery ?? 'Orca gave no recovery.', g, runId)
    return
  }
  await setGroup($, g.lead, { dispatchId: r.dispatchId, terminal, effective })
  await note($, `#${g.lead}: worker ${r.dispatchId} started (${effective ?? `${g.model} · ${g.effort}`})`)
}

// The spec is written before the first of the groups ends, so only now is the branch known.
async function tellBase($: EngineInterface, runId: string, g: TriageGroup, base: string): Promise<void> {
  try {
    await orca(runner($, 60_000), ['orchestration', 'send', '--to', `dispatch:${g.dispatchId}`, '--run', runId, '--subject', 'Base branch',
      '--body', `Your workspace started from branch ${base}. When the workflow has opened your draft pull request, set its base to ${base}, as your Task says.`])
  } catch (err) {
    askToDecide($, `the base branch of #${g.lead}`, `Triage: the worker for #${g.lead} was not told its base branch, ${base}:`, message(err), g, runId)
  }
}

type Message = { id: string; from_handle: string; type: string; body: string; payload: string | null }

// The Run's inbox, one blocking check at a time, while the triage runs.
function waitLater($: EngineInterface): void {
  if (isWaiting) return
  isWaiting = true
  detach(waitLoop($).catch((err: unknown) => note($, `the Orca inbox wait stopped: ${message(err)}. The next tick starts it again.`))
    .finally(() => { isWaiting = false }))
}

async function waitLoop($: EngineInterface): Promise<void> {
  for (;;) {
    const v = await read($, view)
    if (v.phase !== 'running' || !v.runId) return
    const got = (await orca(runner($, WAIT_MS + 60_000), [
      'orchestration', 'check', '--run', v.runId, '--wait', '--types', 'worker_done,escalation,question', '--timeout-ms', String(WAIT_MS),
    ])) as { deliveryId?: string | null; messages?: Message[]; timedOut?: boolean }
    for (const m of got.messages ?? []) {
      if (handled.has(m.id)) continue
      handled.add(m.id)
      await handle($, m).catch((err: unknown) => note($, `Orca message ${m.id} (${m.type} from ${m.from_handle}) not handled: ${message(err)}`))
    }
    if (got.deliveryId) await orca(runner($, 60_000), ['orchestration', 'check', '--run', v.runId, '--ack', got.deliveryId])
    // A wait that ended with no message changed nothing, so the timer's refresh is enough.
    if (got.messages?.length) await refresh($)
  }
}

// A worker that cannot go on needs a decision, and the coordinator makes it or takes it to the human.
function askToDecide($: EngineInterface, what: string, head: string, body: string, g: TriageGroup | undefined, runId: string | undefined): void {
  ask($, what, [
    head, '', body, '',
    'Find the cause from the pull request and the workspace of the worker, and tell the user what it needs. Ask the user with AskUserQuestion when the decision is theirs. Do not do the work of the worker yourself.',
    ...(g?.dispatchId ? [`To answer a worker that is still open: \`orca orchestration send --to dispatch:${g.dispatchId} --run ${runId} --subject "<topic>" --body "<guidance>" --json\`.`] : []),
    ...(g?.taskId ? [`To end its group when it cannot go on: \`orca orchestration task-update --id ${g.taskId} --status failed --run ${runId} --json\`.`] : []),
  ].join('\n'))
}

async function handle($: EngineInterface, m: Message): Promise<void> {
  const payload = m.payload ? (JSON.parse(m.payload) as { taskId?: string; dispatchId?: string; outcome?: string; stopReason?: string; _orcaLifecycleRejection?: { code?: string; reason?: string } }) : {}
  if (payload._orcaLifecycleRejection) {
    await note($, `Orca rejected a ${m.type} from ${m.from_handle}: ${payload._orcaLifecycleRejection.code ?? ''} ${payload._orcaLifecycleRejection.reason ?? ''}`)
    return
  }
  let v = await read($, view)
  let g = v.groups.find(x => (payload.dispatchId && x.dispatchId === payload.dispatchId) || (payload.taskId && x.taskId === payload.taskId) || x.terminal === m.from_handle)
  // A Dispatch the triage does not hold, of a Task it knows: the coordinator may have restarted the Task by hand.
  if (g && payload.dispatchId && payload.taskId === g.taskId && g.dispatchId !== payload.dispatchId && v.runId) {
    await followRestarts($, v.runId)
    v = await read($, view)
    g = v.groups.find(x => x.lead === g!.lead)
    if (g?.dispatchId !== payload.dispatchId) {
      await note($, `#${g?.lead}: a ${m.type} from Dispatch ${payload.dispatchId}, which is not the Task's newest in Orca (${g?.dispatchId ?? 'none'}), was left out: ${firstLine(m.body)}`)
      return
    }
  }
  const who = g ? `#${g.lead} (${g.title})` : `an unknown worker (${m.from_handle})`
  if (m.type === 'question') {
    if (g) await setGroup($, g.lead, { question: { id: m.id, text: m.body } })
    await note($, `${who} asks: ${firstLine(m.body)}`)
    ask($, `the question from ${who}`, [
        `Triage: the Orca worker for ${who} asks:`, '', m.body, '',
        'Answer it from the issues, the code and what the user already decided. For a product or scope decision, ask the user first with AskUserQuestion.',
        'Then reply with:', `orca orchestration reply --id ${m.id} --run ${v.runId} --body "<answer>" --json`,
      ].join('\n'))
  } else if (m.type === 'worker_done') {
    const isDone = payload.outcome === 'succeeded'
    const reported = /\bPR #(\d+)/.exec(m.body)
    if (g) await setGroup($, g.lead, { summary: firstLine(m.body), question: undefined, ...(reported ? { pr: Number(reported[1]) } : {}), ...(isDone ? {} : { error: `the worker reported ${payload.outcome ?? 'no outcome'}: ${m.body}` }) })
    await note($, `${who}: worker done, ${payload.outcome ?? 'no outcome'}`)
    if (!isDone) askToDecide($, `the failure of ${who}`, `Triage: the Orca worker for ${who} ended with ${payload.outcome ?? 'no outcome'}:`, m.body, g, v.runId)
    // Keep the worker's terminal open for review.
    if (payload.dispatchId) {
      await orca(runner($, 60_000), ['orchestration', 'worker-retain', '--dispatch', payload.dispatchId])
        .catch((err: unknown) => note($, `${who}: worker-retain failed: ${message(err)}`))
    }
    await startReady($)
  } else if (m.type === 'escalation') {
    // Orca writes this when a turn ends with no worker_done, and the workflow ends the turn of a worker that waits for
    // its checks. The workflow wakes that worker, and its own reminders catch a worker that has stopped.
    if (payload.stopReason === 'finished') { await note($, `${who} ended a turn and its Dispatch stays open`); return }
    // Its Dispatch stays open, so this settles nothing: only worker_done or the Task's status ends a group.
    if (g) await setGroup($, g.lead, { summary: `Needs a decision: ${firstLine(m.body)}` })
    await note($, `${who} escalated: ${firstLine(m.body)}`)
    $.ui.toast(`/orca-triage: ${who} escalated: ${firstLine(m.body)}`)
    askToDecide($, `the escalation from ${who}`, `Triage: the Orca worker for ${who} escalated:`, m.body, g, v.runId)
  }
}

type Worker = { dispatchId: string; taskId?: string; workerState?: string; agentTerminalHandle?: string | null; projection?: { liveness?: { verdict?: string } } }

// A coordinator restarts a failed Task by hand (orca orchestration worker-start --retry-of <old ctx>), and Orca makes a
// new Dispatch of the same Task. worker-list lists a Run's workers newest first, so the first one of a Task is its
// current Dispatch. Each group whose Task has a newer Dispatch than the one it holds takes it: its terminal, no old
// failure or summary, a fresh PR-watch prod, and its followers no longer blocked by it. Returns the leads it moved.
function restarted(groups: TriageGroup[], workers: Worker[]): { groups: TriageGroup[]; moved: { lead: number; from?: string; to: string; isFailed: boolean }[] } {
  const moved: { lead: number; from?: string; to: string; isFailed: boolean }[] = []
  let out = groups.map((g): TriageGroup => {
    const w = g.taskId ? workers.find(x => x.taskId === g.taskId) : undefined
    if (!w || w.dispatchId === g.dispatchId) return g
    const isFailed = w.workerState === 'failed'
    moved.push({ lead: g.lead, from: g.dispatchId, to: w.dispatchId, isFailed })
    return {
      ...g, dispatchId: w.dispatchId, terminal: w.agentTerminalHandle ?? undefined, prod: undefined, question: undefined, summary: undefined, blockedBy: undefined,
      error: isFailed ? `the restarted worker ${w.dispatchId} failed too; \`orca orchestration worker-show --dispatch ${w.dispatchId} --json\` shows why` : undefined,
    }
  })
  // A follower blocked by a group that runs again waits again; settle blocks it once more if another of its groups is stuck.
  const freed = new Set(moved.filter(x => !x.isFailed).map(x => x.lead))
  for (let changed = true; changed;) {
    changed = false
    out = out.map(g => {
      if (g.blockedBy === undefined || !freed.has(g.blockedBy)) return g
      freed.add(g.lead)
      changed = true
      return { ...g, blockedBy: undefined }
    })
  }
  return { groups: out, moved }
}

async function adoptRestarts($: EngineInterface, workers: Worker[]): Promise<void> {
  let moved: ReturnType<typeof restarted>['moved'] = []
  await update($, view, (x): TriageView => {
    const r = restarted(x.groups, workers)
    moved = r.moved
    if (!moved.length) return x
    // A triage that ended because this group failed runs again.
    const isRunning = x.phase === 'done' && moved.some(m => !m.isFailed)
    return { ...x, groups: r.groups, phase: isRunning ? 'running' : x.phase }
  })
  for (const m of moved) {
    await note($, `#${m.lead}: Orca holds a newer worker for its Task, ${m.to}${m.from ? ` (was ${m.from})` : ''}, so the triage follows it${m.isFailed ? '; it failed too' : ''}`)
  }
}

// One worker-list read, for a message or a prod that may concern a worker restarted by hand.
async function followRestarts($: EngineInterface, runId: string): Promise<void> {
  const listed = (await orca(runner($, 60_000), ['orchestration', 'worker-list', '--run', runId])) as { workers: Worker[] }
  await adoptRestarts($, listed.workers)
}

// Reads Orca's own state back: each Task's status, each worker's liveness, each workspace's board status and pull request.
async function refresh($: EngineInterface): Promise<void> {
  const v = await read($, view)
  if (!v.runId || !v.repo) return
  const run = runner($, 60_000)
  const [tasks, workers, worktrees] = await Promise.all([
    orca(run, ['orchestration', 'task-list', '--run', v.runId]) as Promise<{ tasks: { id: string; status: string }[] }>,
    orca(run, ['orchestration', 'worker-list', '--run', v.runId]) as Promise<{ workers: Worker[] }>,
    orcaWorktrees(run),
  ])
  await adoptRestarts($, workers.workers)
  const now = await $.clock.now()
  for (const g of v.groups) {
    if (g.task !== 'failed' && tasks.tasks.find(t => t.id === g.taskId)?.status === 'failed') {
      askToDecide($, `the failed Task of #${g.lead}`, `Triage: the Task of #${g.lead} (${g.title}) is failed in Orca.`, g.error ?? g.summary ?? 'Orca gave no reason.', g, v.runId)
    }
  }
  await update($, view, x => {
    const groups = x.groups.map(g => {
      const wt = worktrees.find(w => w.id === g.worktree) as { workspaceStatus?: string; linkedPR?: number | null } | undefined
      return {
        ...g,
        task: tasks.tasks.find(t => t.id === g.taskId)?.status ?? g.task,
        liveness: workers.workers.find(w => w.dispatchId === g.dispatchId)?.projection?.liveness?.verdict ?? g.liveness,
        workspaceStatus: wt?.workspaceStatus ?? g.workspaceStatus,
        pr: wt?.linkedPR ?? g.pr,
      }
    })
    return { ...x, groups, checkedAt: now }
  })
  await settle($)
}

// What keeps an open pull request from merging that its worker can fix. Running checks are not a fault: they are read
// again at the next check. A review the base branch requires is the human's, so a BLOCKED state alone is not one.
function unready(r: PrRow): string[] {
  const out: string[] = []
  // A draft is still in development: the worker's own workflow brings it to ready.
  if (r.isDraft) return out
  if (r.mergeable === 'CONFLICTING' || r.mergeState === 'DIRTY') out.push('it conflicts with its base branch')
  else if (r.mergeState === 'BEHIND') out.push('it is behind its base branch')
  if (r.failing.length) out.push(`failing checks: ${r.failing.join(', ')}`)
  return out
}

// Every PR_CHECK_MS while the triage runs (its inbox wait hears the answers only then): reads the open pull request of
// each group, and prods the worker of one that is not mergeable and green. A send to a worker that has ended opens a
// follow-up turn for it in Orca, so a finished worker hears it too.
async function watchPrs($: EngineInterface): Promise<void> {
  if (isWatchingPrs) return
  isWatchingPrs = true
  try {
    const v = await read($, view)
    if (v.phase !== 'running' || !v.runId || !v.repo) return
    const run = runner($, 120_000)
    let hasFollowed = false
    for (const listed of v.groups) {
      if (!listed.pr || listed.prClosed === listed.pr) continue
      let g: TriageGroup & { pr: number } = { ...listed, pr: listed.pr }
      const r = await readPullRow(run, v.repo, g.pr).catch(async (err: unknown) => { await note($, `#${g.lead}: PR #${g.pr} not read: ${message(err)}`); return undefined })
      if (!r) continue
      if (r.state !== 'OPEN') { await setGroup($, g.lead, { prClosed: g.pr }); continue }
      const problems = unready(r)
      if (!problems.length) continue
      // A worker restarted by hand since the last refresh has a new Dispatch: one worker-list read per pass finds it.
      if (!hasFollowed) {
        hasFollowed = true
        await followRestarts($, v.runId)
        // The pull request is the one this pass read.
        const fresh = (await read($, view)).groups.find(x => x.lead === g.lead)
        if (fresh) g = { ...fresh, pr: g.pr }
      }
      const key = `${r.head} ${problems.join('; ')}`
      const now = await $.clock.now()
      if (g.prod?.key === key && now - g.prod.at < PROD_AGAIN_MS) continue
      await setGroup($, g.lead, { prod: { key, at: now } })
      const url = pullUrl(v.repo, g.pr)
      if (!g.dispatchId) {
        await note($, `#${g.lead}: PR #${g.pr} cannot merge (${problems.join('; ')}), and the group has no worker to prod`)
        askToDecide($, `the stuck PR of #${g.lead}`, `Triage: PR #${g.pr} (${url}) of #${g.lead} (${g.title}) cannot merge, and no Orca worker holds it:`, problems.join('\n'), g, v.runId)
        continue
      }
      const body = [
        `PR #${g.pr} (${url}) is not mergeable and green at ${r.head}: ${problems.join('; ')}.`,
        'Fix it now: merge the base branch and resolve the conflicts, fix the cause of each failing check (never weaken or skip a check), and push the fix through the workflow (mcp__ndev__checkpoint, or by hand when you have no ndev tools). Then wait for the checks.',
        'If you cannot fix it, send an escalation that says why and what you need.',
      ].join('\n')
      await orca(runner($, 60_000), ['orchestration', 'send', '--to', `dispatch:${g.dispatchId}`, '--run', v.runId, '--subject', `PR #${g.pr} is not mergeable and green`, '--body', body])
        .then(() => note($, `#${g.lead}: PR #${g.pr} cannot merge (${problems.join('; ')}); prodded its worker`))
        .catch((err: unknown) => note($, `#${g.lead}: PR #${g.pr} cannot merge, and the prod to its worker failed: ${message(err)}`))
    }
  } finally {
    isWatchingPrs = false
  }
}

async function prTick($: EngineInterface): Promise<void> {
  await watchPrs($).catch((err: unknown) => note($, `the pull request check stopped: ${message(err)}`))
}

async function tick($: EngineInterface): Promise<void> {
  const v = await read($, view)
  // A triage that ended still reads Orca back, because a Task restarted by hand makes it run again.
  if (v.phase !== 'running' && !(v.phase === 'done' && v.runId)) return
  await refresh($).catch((err: unknown) => update($, view, v => ({ ...v, error: `Orca not read: ${message(err)}` })))
  await startReady($)
  waitLater($)
}

function openPane($: EngineInterface): Promise<unknown> {
  return $.ui.open({ id: PANE, title: TITLE })
}

// Moves the pane's Orca window to the worker's terminal.
async function jump($: EngineInterface, g: TriageGroup): Promise<void> {
  if (!g.dispatchId) { $.ui.toast(`#${g.lead} has no worker yet.`); return }
  const shown = (await orca(runner($, 60_000), ['orchestration', 'worker-show', '--dispatch', g.dispatchId])) as
    { worker?: { agentTerminalHandle?: string | null }; terminal?: { handle?: string | null } }
  const handle = shown.worker?.agentTerminalHandle ?? shown.terminal?.handle ?? g.terminal
  if (!handle) { $.ui.toast(`#${g.lead}: the worker ${g.dispatchId} has no terminal (a chat worker); open its workspace for #${g.lead} in Orca.`); return }
  await orca(runner($, 60_000), ['terminal', 'switch', '--terminal', handle])
}

const fail = ($: EngineInterface, what: string) => (err: unknown) => {
  $.ui.toast(`/orca-triage ${what} failed: ${message(err)}`)
  return update($, view, v => ({ ...v, error: message(err) }))
}

export async function startTriage($: EngineInterface) {
  await $.command.register({
    name: 'orca-triage',
    description: 'Group the open issues with this session\'s model, then coordinate an Orca worker on each group, one pull request per group. Same as /dev triage',
    argumentHint: '[start [--dry-run] [--codex] [--open] [--batch <size>|--sequential]|launch|refresh|reset]',
  })
  await $.tool.register({
    name: 'triage_groups',
    description:
      'Report the /orca-triage groups: each open issue in exactly one group, with its complexity, a hint for the worker and, ' +
      'when needed, the leads of the groups it must follow. The mod then starts one Orca worker per group.',
    inputSchema: {
      type: 'object',
      properties: {
        groups: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              issues: { type: 'array', items: { type: 'number' } },
              title: { type: 'string' },
              complexity: { type: 'string', enum: Object.keys(SIZES) },
              hint: { type: 'string' },
              implemented: { type: 'boolean' },
              evidence: { type: 'string' },
              after: { type: 'array', items: { type: 'number' }, description: 'Leads (lowest issue numbers) of the groups that must finish first' },
            },
            required: ['issues', 'title', 'complexity', 'hint'],
          },
        },
      },
      required: ['groups'],
    },
    isDeferred: false,
  })
  $.clock.every(TICK_MS, () => { detach(tick($)) })
  $.clock.every(PR_CHECK_MS, () => { detach(prTick($)) })
}

// /orca-triage <args> and /dev triage <args>. Answers at once: the work runs detached, since gh and Orca can outlast the hook's budget.
const START_OPTIONS = ['--dry-run', '--codex', '--open', '--sequential', '--batch']
const BATCH_USAGE = '--batch <size> takes a whole number above 0: how many workers run at once, each batch after the last has ended. --sequential is --batch 1.'

// The value of --batch <size>, with --sequential as 1; 0 when neither is given. A bad size returns the refusal.
function batchOption(words: string[]): number | string {
  const at = words.indexOf('--batch')
  const isSequential = words.includes('--sequential')
  if (at < 0) return isSequential ? 1 : 0
  const raw = words[at + 1]
  if (!raw || !/^[1-9]\d*$/.test(raw)) return `/orca-triage start --batch ${raw ?? ''}`.trimEnd() + ` is not a size. ${BATCH_USAGE}`
  const size = Number(raw)
  if (isSequential && size !== 1) return `/orca-triage start --sequential --batch ${size} asks for two sizes. ${BATCH_USAGE}`
  return size
}

export async function triageCommand($: EngineInterface, args: string, project: () => LoadedConfig | undefined): Promise<{ text: string }> {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const at = words.indexOf('--batch')
  const [verb = 'status'] = words.filter((w, i) => !w.startsWith('--') && !(at >= 0 && i === at + 1))
  const unknown = words.find(w => w.startsWith('--') && (!START_OPTIONS.includes(w) || verb !== 'start'))
  if (unknown) return { text: `/orca-triage ${verb} does not know "${unknown}". The options are /orca-triage start ${START_OPTIONS.join(' ')}: --dry-run plans and starts nothing, --codex runs the fixes in Codex workers, --open takes every open issue and not only the board's, --batch <size> runs that many workers at once, batch after batch, and --sequential is --batch 1.` }
  detach(openPane($))
  if (verb === 'start') {
    const batch = batchOption(words)
    if (typeof batch === 'string') return { text: batch }
    detach(collect($, project(), { isDryRun: words.includes('--dry-run'), agent: words.includes('--codex') ? 'codex' : 'claude', isOpen: words.includes('--open'), batch })
      .then(text => $.ui.toast(text), fail($, 'start')))
    return { text: 'Triage started: reading the issues. The Triage pane shows progress.' }
  }
  if (verb === 'launch') { detach(launch($).catch(fail($, 'launch'))); return { text: 'Launching the planned groups in Orca.' } }
  if (verb === 'refresh') { detach(tick($).catch(fail($, 'refresh'))); return { text: 'Reading the triage back from Orca.' } }
  if (verb === 'reset') {
    const v = await read($, view)
    await update($, view, () => EMPTY)
    return { text: v.runId ? `Triage cleared. Orca Run ${v.runId} and its workspaces stay in Orca.` : 'Triage cleared.' }
  }
  if (verb !== 'status') return { text: `/orca-triage does not know "${verb}". Use start [--dry-run] [--codex] [--open] [--batch <size>|--sequential], launch, refresh or reset.` }
  const v = await read($, view)
  return { text: v.repo ? `Triage of ${v.repo}: ${v.phase}, ${v.groups.length} groups, ${AGENT_NAME[agentOf(v)]} workers.` : 'No triage yet. /orca-triage start reads the issues.' }
}

export const triage = (on: On, project: () => LoadedConfig | undefined) => {
  on('command.run', { command: 'orca-triage' }, ($, e) => triageCommand($, e.args, project)).catch(($, e, next) => ({
    text: `/orca-triage ${e.args} failed (${next.error.kind} after ${next.error.budget} ms): ${next.error.message ?? 'no message'}`,
  }))

  on('tool.call', { tool: TOOL }, async ($, e) => {
    // The engine passes the tool's arguments on the event itself, beside `tool`.
    const input = e as unknown as { groups?: Proposed[] }
    const v = await read($, view)
    if (v.phase !== 'grouping') return { result: `Refused: /orca-triage is not waiting for groups (it is ${v.phase}). /orca-triage start begins one.`, isError: true as const }
    const groups = Array.isArray(input.groups) ? input.groups : []
    const wrong = problems(v.issues, groups)
    if (wrong.length) return { result: `Refused, nothing recorded:\n- ${wrong.join('\n- ')}\nFix these and call ${TOOL} again.`, isError: true as const }
    const planned = groups.map(g => toGroup(g, agentOf(v)))
    await update($, view, (x): TriageView => ({ ...x, phase: 'planned', groups: planned }))
    await note($, `the model made ${planned.length} groups`)
    if (v.isDryRun) return { result: `Recorded ${planned.length} groups as a dry run: nothing started in Orca. /orca-triage launch starts them.` }
    detach(launch($).catch(fail($, 'launch')))
    return { result: `Recorded ${planned.length} groups. The mod creates the Orca Run and starts the workers; the Triage pane shows them. You are the coordinator now: start no work on these issues, and wait for what the mod sends you.` }
  })

  // The model's reply to a worker's question closes the question on the pane.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    const id = /orca orchestration reply\b.*?--id[ =](\S+)/.exec(String((e as { command?: unknown }).command ?? ''))?.[1]
    const g = id ? (await read($, view)).groups.find(x => x.question?.id === id) : undefined
    if (!g) return result
    const out = result.text ?? JSON.stringify(result.result ?? '')
    if (result.deny !== undefined || result.isError || /"ok"\s*:\s*false/.test(out)) {
      await note($, `#${g.lead}: the reply to ${id} failed, so the question stays open: ${firstLine(out)}`)
    } else {
      await setGroup($, g.lead, { question: undefined })
      await note($, `#${g.lead}: question answered`)
    }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const v = await read($, view)
    const columns = e.props.bodyColumns
    const width = Math.max(20, columns - 4 - 2 - 9 - 6 - 22)
    const fit = (s: string, w = width) => (s.length > w ? `${s.slice(0, w - 1)}…` : s)
    const pad = '             '
    const under = Math.max(20, columns - 4 - pad.length - 1)
    const done = v.groups.filter(g => g.task === 'completed').length
    const word = (g: TriageGroup): { word: string; color: string } =>
      g.error ? { word: 'failed', color: 'error' }
        : g.blockedBy !== undefined ? { word: 'blocked', color: 'warning' }
        : g.question ? { word: 'question', color: 'warning' }
          : g.task === 'completed' ? { word: 'done', color: 'success' }
            : g.task === 'failed' ? { word: 'failed', color: 'error' }
              : g.dispatchId ? { word: 'working', color: 'claude' }
                : g.taskId ? { word: 'waiting', color: 'subtle' } : { word: 'planned', color: 'subtle' }
    const workers = v.repo ? ` · ${AGENT_NAME[agentOf(v)]} workers${v.isOpen ? ' · every open issue' : ''}${batchOf(v) === 1 ? ' · one at a time' : batchOf(v) > 1 ? ` · batches of ${batchOf(v)}` : ''}` : ''
    const phase = v.phase === 'grouping' ? `the model is grouping ${v.issues.length} issues`
      : v.phase === 'planned' ? `${v.groups.length} groups planned, nothing started${v.isDryRun ? ' (dry run)' : ''}`
        : v.phase === 'running' ? `Orca Run ${v.runId ?? 'not made yet'}` : v.phase === 'done' ? (v.runId ? `done · Orca Run ${v.runId}` : 'stopped: no Orca Run was made') : 'not started'
    const url = (n: number) => v.issues.find(i => i.number === n)?.url ?? `https://github.com/${v.repo}/issues/${n}`
    const titled = (n: number) => v.issues.find(i => i.number === n)?.title ?? ''

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
          <Box justifyContent="space-between">
            <Text weight="bold" color="claude">{v.repo ?? 'No triage yet'}</Text>
            <Text color="subtle">
              {v.groups.length ? `${done} of ${v.groups.length} done` : ''}
              {v.checkedAt ? ` · ${new Date(v.checkedAt).toLocaleTimeString()}` : ''}
            </Text>
          </Box>
          <Text color="subtle">{fit(`${phase}${workers}`, columns - 4)}</Text>
        </Box>
        <Box gap={2}>
          {v.phase !== 'running' && v.phase !== 'grouping' &&
            <Button key="start" label="Start" hotkey="s" plain onPress={() => { detach(collect($, project(), { isDryRun: false, agent: agentOf(v), isOpen: !!v.isOpen, batch: batchOf(v) }).then(t => $.ui.toast(t), fail($, 'start'))) }} />}
          {v.phase === 'planned' && <Button key="launch" label="Launch" hotkey="l" plain onPress={() => { detach(launch($).catch(fail($, 'launch'))) }} />}
          {v.runId && <Button key="refresh" label="Refresh" hotkey="r" plain onPress={() => { detach(tick($).catch(fail($, 'refresh'))) }} />}
        </Box>
        {v.error && v.error.split('\n').map((line, i) => <Text key={`error-${i}`} color="error">{line}</Text>)}
        {v.phase === 'idle' && !v.error && <Text color="subtle">Start reads the open issues, has this session group them, and works each group in its own Orca workspace.</Text>}
        <Box flexDirection="column">
          {v.groups.map(g => {
            const m = word(g)
            const facts = [g.effective ?? `${g.model} · ${g.effort}`, g.workspaceStatus].filter(Boolean).join(' · ')
            const after = g.liveness ? ` · ${g.liveness}` : ''
            return (
              // Each group is a box that lists its issues, so the grouping reads at a glance.
              <Box key={`group-${g.lead}`} flexDirection="column" borderStyle="round" borderColor={m.color} paddingX={1}>
                <Box justifyContent="space-between">
                  <Text>
                    <Text color={m.color}>{m.word.padEnd(9)}</Text>
                    <Link href={url(g.lead)} label={`#${g.lead}`} />
                    <Text> {fit(g.title)}</Text>
                  </Text>
                  <Box gap={2}>
                    {g.dispatchId && <Button key={`jump-${g.lead}`} label="Jump" plain onPress={() => { detach(jump($, g).catch(fail($, 'jump'))) }} />}
                    {g.pr && <Button key={`pr-${g.lead}`} label="PR" plain dimColor
                      onPress={() => { void $.process.run(['gh', 'pr', 'view', String(g.pr), '--repo', v.repo!, '--web']) }} />}
                    <Button key={`issue-${g.lead}`} label="Issue" plain dimColor onPress={() => { void $.process.run(['open', url(g.lead)]) }} />
                  </Box>
                </Box>
                <Text color="subtle">{pad}{fit(facts, under)}{g.pr && v.repo ? ' · PR ' : g.pr ? ` · PR #${g.pr}` : ''}{g.pr && v.repo && <Link href={pullUrl(v.repo, g.pr)} label={`#${g.pr}`} />}{after}</Text>
                {g.issues.map(n => (
                  <Text key={`member-${g.lead}-${n}`}>{pad}<Link href={url(n)} label={`#${n}`} /> {fit(titled(n), under - String(n).length - 2)}</Text>
                ))}
                {g.question && <Text color="warning">{pad}{fit(`asks: ${g.question.text}`, under)}</Text>}
                {g.summary && <Text color="subtle">{pad}{fit(g.summary, under)}</Text>}
                {g.blockedBy !== undefined && <Text color="warning">{pad}waits for <Link href={url(g.blockedBy)} label={`#${g.blockedBy}`} />, which failed</Text>}
                {g.error && g.error.split('\n').map((line, i) => <Text key={`gerr-${g.lead}-${i}`} color="error">{pad}{line}</Text>)}
              </Box>
            )
          })}
        </Box>
        {v.log.length > 0 && (
          <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
            <Text weight="bold" color="claude">Activity</Text>
            {v.log.slice(-8).map((entry, i) => (
              <Text key={`log-${i}`}>
                <Text color="subtle">{new Date(entry.at).toLocaleTimeString()} </Text>{fit(entry.text, columns - 16)}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
