// The workflow's states and moves, with no side effects. kb/workflow.md draws this as a flow chart.
// tools.ts does the work of each tool, then asks this module where the workflow goes next.
import type { ProjectLevel } from '../config'
import type { Mode, Steering } from '../../types'
import { REVIEW_DATABASE_STEP, REVIEW_DOCS_ONLY_STEP, SMOKE_DOCS_STEP, isDocsOnly, isDocsPath, isWebPath, requiredSmokeTypes, reviewWebStep, smokeWebStep } from './change-types'
import type { ChangeType } from './change-types'

export const ATTEMPT_LIMIT = 3

export const STATES = ['setup', 'interviewing', 'planning', 'developing', 'developed', 'reviewing', 'ci', 'smoke', 'finishing', 'done', 'revising', 'blocked', 'wait'] as const
export type State = (typeof STATES)[number]

// The phase tools, plus the three kinds of follow-up, which differ in what they do to the state.
export type Tool =
  | 'interview' | 'setAuto' | 'finishedPlan' | 'checkpoint' | 'finishedDevelopment' | 'finishedReview' | 'finishedChecks' | 'finishedSmoke' | 'finishedRevision'
  | 'blocked' | 'unblocked' | 'wait' | 'waitEnded' | 'done' | 'followUpThisAgent' | 'followUpOther' | 'followUpIssue'

export type Facts = {
  merged?: boolean
  // Only for a commit in done: the tool read the PR, and it is open.
  prOpen?: boolean
  remembered?: boolean
  mode: Mode
  steering: Steering
  level?: ProjectLevel
  smoke?: boolean
  feedback?: boolean
  docsOnly?: boolean
  changeTypes?: readonly ChangeType[]
  webFiles?: readonly string[]
  // False from the moment of the workflow's start until the base check has run. Undefined says nothing.
  baseChecked?: boolean
  // Only for done before the review: the issue is closed, the branch holds no change and no PR is open.
  noChange?: boolean
}
export type Position = { state: State; previous?: State }
export type Move = Position | { refused: string }

export const mayMerge = (level?: ProjectLevel) => level === 'straw_man' || level === 'poc'
export const mayCommitToBase = (level?: ProjectLevel) => level === 'straw_man'
export const maySkipReview = (level?: ProjectLevel) => level !== 'formal_project'
export const needsPlanSignOff = (steering: Steering, level?: ProjectLevel) => steering === 'interactive' && !mayMerge(level)

const VALID_NOW: Record<State, string> = {
  setup: 'started', interviewing: 'interview', planning: 'finishedPlan', developing: 'finishedDevelopment, after finishedInterview. For an issue that was closed with no change on this branch, done ends the workflow', developed: 'started, with an issue on this PR that is still in development', reviewing: 'finishedReview', ci: 'finishedChecks',
  smoke: 'finishedSmoke', finishing: 'done', revising: 'finishedRevision', blocked: 'unblocked', wait: 'none while a wait tool runs, and the human can end it with /unblock <message>. If no wait tool runs now, call started', done: 'checkpoint while the PR is open, or else followUp with issue_only',
}

const wrong = (position: Position, tool: string): Move => ({
  refused: `Refused: ${tool} is not valid in the state "${position.state}". Nothing changed. The tool for this state is ${VALID_NOW[position.state]}.`,
})

const PAST_DEVELOPMENT: State[] = ['reviewing', 'ci', 'smoke', 'finishing']
// done can end an issue that was closed with no change before its review, such as one that another change fixed.
export const BEFORE_REVIEW: State[] = ['interviewing', 'planning', 'developing']

// Stage hooks: work that a change of state sets off. moved() in tools.ts fires them, so each way into
// a state fires them: a tool, the heartbeat or a human. The tool that leaves the stage takes the result.
export type StageHook = 'review' | 'remember'
const STAGE_HOOKS: { name: StageHook; on: State }[] = [
  { name: 'review', on: 'reviewing' },
  { name: 'remember', on: 'reviewing' },
]

// The main line of the flow, in order, for a drawing of it. revising is a side loop back to ci.
export const FLOW: State[] = ['setup', 'interviewing', 'planning', 'developing', 'reviewing', 'ci', 'smoke', 'finishing', 'done']
const OPTIONAL_STEPS: State[] = ['interviewing', 'planning', 'smoke']
export type FlowMark = 'passed' | 'current' | 'blocked' | 'waiting' | 'later' | 'skipped'
export type FlowPicture = { steps: { state: State; mark: FlowMark }[]; revising?: FlowMark }

// Where a workflow stands on the flow. `visited` holds each state its history names: an optional step
// behind the current one that it does not hold was skipped (light mode has no plan, most changes no smoke).
export function flowPicture(position: Position, visited: readonly State[]): FlowPicture {
  const isHeld = position.state === 'blocked' || position.state === 'wait'
  const at = isHeld && position.previous ? position.previous : position.state
  const here: FlowMark = position.state === 'blocked' ? 'blocked' : position.state === 'wait' || position.state === 'developed' ? 'waiting' : 'current'
  // Revising goes back to ci, so it stands just before ci on the main line.
  // An issue that finished development stands at developing, and waits for the others on its PR.
  const index = at === 'revising' ? FLOW.indexOf('ci') - 0.5 : FLOW.indexOf(at === 'developed' ? 'developing' : at)
  const steps = FLOW.map((state, i) => {
    if (i === index) return { state, mark: at === 'done' ? 'passed' as const : here }
    if (i > index) return { state, mark: 'later' as const }
    return { state, mark: OPTIONAL_STEPS.includes(state) && !visited.includes(state) ? 'skipped' as const : 'passed' as const }
  })
  const revising: FlowMark | undefined = at === 'revising' ? here : visited.includes('revising') ? 'passed' : undefined
  return revising ? { steps, revising } : { steps }
}

// A return from blocked or wait is the same stage going on, so its hook has already fired.
export const hooksFiredBy = (from: State, to: State): StageHook[] =>
  from === to || from === 'blocked' || from === 'wait' ? [] : STAGE_HOOKS.filter(h => h.on === to).map(h => h.name)

// After the interview, or in its place: the plan when heavy, the code when light.
const afterInterview = (mode: Mode): State => (mode === 'heavy' ? 'planning' : 'developing')

export function afterTool(position: Position, tool: Tool, facts: Facts): Move {
  const { state } = position
  if (tool === 'followUpIssue') return position
  if (tool === 'unblocked') return state === 'blocked' && position.previous ? { state: position.previous } : wrong(position, tool)
  if (tool === 'waitEnded') return state === 'wait' && position.previous ? { state: position.previous } : wrong(position, tool)
  // Started can land in blocked with the interview still to come, and auto then gives it up.
  if (tool === 'setAuto' && state === 'blocked') return { state, previous: position.previous === 'interviewing' ? afterInterview(facts.mode) : position.previous }
  if (state === 'blocked' || state === 'wait') return wrong(position, tool)
  if (tool === 'blocked') return state === 'done' ? wrong(position, tool) : { state: 'blocked', previous: state }
  if (tool === 'wait') return state === 'done' ? wrong(position, tool) : { state: 'wait', previous: state }
  // An agent with no human to answer gives up the interview too. Each other state stays.
  if (tool === 'setAuto') return state === 'done' ? wrong(position, tool) : { state: state === 'interviewing' ? afterInterview(facts.mode) : state }
  if (tool === 'followUpOther') return state === 'done' ? wrong(position, tool) : { state }
  if (tool === 'followUpThisAgent') {
    if (state === 'done' || state === 'setup') return wrong(position, tool)
    return { state: PAST_DEVELOPMENT.includes(state) ? 'developing' : state }
  }
  if (tool === 'checkpoint') {
    // More work on an issue that had finished: it is in development again.
    if (state === 'developed') return { state: 'developing' }
    if (state === 'developing' || state === 'reviewing' || state === 'revising' || state === 'ci') return { state }
    // Documents leave the tested code as it was, but a change that now holds them has a smoke test due.
    if (state === 'finishing' && facts.docsOnly && facts.smoke) return { state: 'smoke' }
    if (state === 'smoke' || state === 'finishing') return { state: facts.docsOnly ? state : 'ci' }
    // The base can move under a PR that waits for a human. A new commit needs the checks again.
    if (state === 'done' && facts.prOpen) return { state: 'ci' }
    return wrong(position, tool)
  }
  if (tool === 'interview' && state === 'interviewing') return { state: afterInterview(facts.mode) }
  if (tool === 'finishedPlan' && state === 'planning') {
    return needsPlanSignOff(facts.steering, facts.level) ? { state: 'blocked', previous: 'developing' } : { state: 'developing' }
  }
  if (tool === 'finishedDevelopment' && state === 'developing') return { state: 'reviewing' }
  if (tool === 'finishedReview' && state === 'reviewing') return { state: 'ci' }
  if (tool === 'finishedChecks' && state === 'ci') return { state: facts.smoke ? 'smoke' : 'finishing' }
  if (tool === 'finishedSmoke' && state === 'smoke') return { state: 'finishing' }
  if (tool === 'finishedRevision' && state === 'revising') return { state: 'ci' }
  if (tool === 'done' && facts.noChange && BEFORE_REVIEW.includes(state)) return { state: 'done' }
  if (tool === 'done' && state === 'finishing') return { state: facts.feedback ? 'revising' : 'done' }
  return wrong(position, tool)
}

// /flow skip: the human moves on from a phase. `done` has no skip, because it holds the
// final checks, and a block ends with unblock.
const SKIP_TO: Partial<Record<State, State>> = {
  planning: 'developing', developing: 'reviewing', reviewing: 'ci', ci: 'finishing', smoke: 'finishing', revising: 'ci',
}
export function afterSkip(position: Position, mode: Mode, steering: Steering): Move {
  if (position.state === 'setup') return { state: steering === 'interactive' ? 'interviewing' : afterInterview(mode) }
  if (position.state === 'interviewing') return { state: afterInterview(mode) }
  const to = SKIP_TO[position.state]
  if (to) return { state: to }
  const how = position.state === 'developed' ? 'This issue waits for the other issues on its PR.' : position.state === 'blocked' ? 'Use /unblock <message> or /flow unblock.' : position.state === 'wait' ? 'Use /unblock <message>.' : position.state === 'finishing' ? 'The agent calls done, or use /flow goto done.' : 'The workflow is finished.'
  return { refused: `There is no phase to skip in the state "${position.state}". ${how}` }
}

export function afterStarted(
  position: Position | undefined,
  facts: { mode: Mode; steering: Steering; scriptsMissing?: boolean; blockerOpen?: boolean; feedback?: boolean },
): Position {
  const first: State = facts.steering === 'interactive' ? 'interviewing' : afterInterview(facts.mode)
  if (!position || position.state === 'setup') {
    if (facts.scriptsMissing) return { state: 'setup' }
    return facts.blockerOpen ? { state: 'blocked', previous: first } : { state: first }
  }
  if (position.state === 'done' && facts.feedback) return { state: 'revising' }
  // A wait lives in the tool call that made it, so a new session finds no one waiting.
  if (position.state === 'wait') return { state: position.previous ?? first }
  return position
}

const PREVIEW_CHECK = /preview|vercel|netlify/i

export function needsSmoke(mode: Mode, paths: readonly string[], checkNames: readonly string[], types: readonly ChangeType[] = []): boolean {
  if (requiredSmokeTypes(types).length || paths.some(path => isWebPath(path) || isDocsPath(path))) return true
  return mode === 'heavy' && checkNames.some(n => PREVIEW_CHECK.test(n))
}

// What the Orca workspace shows. Status ids are Orca's default board columns: `in-review` means that
// the work waits for a human, so it starts at `done`, and a block keeps the status it had.
const ORCA_DOING: Record<Exclude<State, 'blocked' | 'wait' | 'done'>, string> = {
  setup: 'setup: creating the check scripts',
  interviewing: 'interviewing: settling the decisions with the human',
  planning: 'planning: writing the plan',
  developing: 'developing: writing the code and its tests',
  developed: 'developed: waiting for the other issues on this PR',
  reviewing: 'reviewing: reviewing the change',
  ci: 'ci: the workflow watches the checks',
  smoke: 'smoke: testing the running change',
  finishing: 'finishing: the last checks before done',
  revising: 'revising: answering the feedback',
}
export type OrcaView = { name?: string; status: string; comment: string; attention: boolean; issue: number; pr?: number }
export function orcaView(w: { issue: number; shortName?: string; direct?: boolean; prs: number[]; state: State; previous?: State; merged?: boolean; doneMessage?: string; blocked?: { message: string }; waiting?: { what: string; alert?: unknown }; asking?: unknown; off?: unknown }): OrcaView {
  const finished = w.state === 'done' || (w.state === 'blocked' && w.previous === 'done')
  return {
    // The issue's number names the workspace until a PR is added, then the PR's number does.
    // The main checkout of a project that commits to its base branch is not this issue's workspace.
    name: w.shortName && !w.direct ? `${w.prs[0] ?? w.issue}-${w.shortName}` : undefined,
    status: w.merged ? 'completed' : finished ? 'in-review' : 'in-progress',
    comment: (w.off ? 'The workflow is off'
      : w.state === 'blocked' ? `Blocked: ${w.blocked?.message ?? ''}`
        : w.state === 'wait' ? `${w.waiting?.alert ? 'Past half its retries, waiting' : 'Waiting'} for ${w.waiting?.what ?? 'a wait tool'}`
        : w.state === 'interviewing' && w.asking ? "Interview: waiting for the human's answers"
        : w.merged ? `Merged${w.doneMessage ? `: ${w.doneMessage}` : ''}`
          : w.state === 'done' ? `Done, waiting for a human${w.doneMessage ? `: ${w.doneMessage}` : ''}`
            : ORCA_DOING[w.state]).slice(0, 200),
    attention: !w.off && (w.state === 'blocked' || (w.state === 'wait' && !!w.waiting?.alert) || (w.state === 'interviewing' && !!w.asking) || (w.state === 'done' && !w.merged)),
    issue: w.issue,
    pr: w.prs[0],
  }
}

// The board column that a state belongs in. Undefined keeps the column, because the card does not move
// for a wait or for an issue that waits for the others on its PR. "In review" means that no more automated
// development is due, so it starts at done and not when the PR goes ready.
export type BoardColumn = 'progress' | 'awaiting' | 'review' | 'done'
export function boardColumn(w: { state: State; merged?: boolean; direct?: boolean }): BoardColumn | undefined {
  if (w.state === 'wait' || w.state === 'developed') return undefined
  if (w.state === 'blocked') return 'awaiting'
  if (w.state === 'done') return w.merged || w.direct ? 'done' : 'review'
  return 'progress'
}

export const baseCheckScript = (mode: Mode) => (mode === 'heavy' ? 'pre-push-check.sh' : 'pre-commit-check.sh')

// What the accumulated change types add to the next step of the review and the smoke test.
function reviewStep(full: string, facts: Pick<Facts, 'changeTypes' | 'webFiles'>): string {
  const types = facts.changeTypes ?? []
  if (isDocsOnly(types)) return REVIEW_DOCS_ONLY_STEP
  return [full, types.includes('web') ? reviewWebStep(facts.webFiles ?? []) : '', types.includes('database') ? REVIEW_DATABASE_STEP : ''].filter(Boolean).join(' ')
}

function stepText(state: State, facts: Pick<Facts, 'mode' | 'steering' | 'level' | 'merged' | 'remembered' | 'changeTypes' | 'webFiles' | 'baseChecked'>): string {
  switch (state) {
    case 'setup':
      return 'Create each missing check script that the reply names, with the commands from the project\'s CLAUDE.md, and make it executable. Then call started again.'
    case 'interviewing':
      if (facts.steering === 'auto') return 'Steering is auto, so no human answers an interview. Call interview with no arguments to go on.'
      return `Load the ndev:interview skill and follow it. Read each .neil-dev.issue-*.json file in this worktree first, and do not ask again what they answer. Ask with interview(interviewJson). ${facts.mode === 'heavy' ? 'Go through the whole design tree, round by round, and let the last round confirm the shared understanding.' : 'Ask at most 5 pertinent questions and 5 follow-ups, or none if none is pertinent.'} Then call interview with no arguments: only that call goes on.`
    case 'planning':
      return 'Read the interview answers in the .neil-dev.issue-*.json files of this worktree. Write the plan (work-heavy F2) in a markdown file with a "Test entry point:" line. Then call finishedPlan with the file name.'
    case 'developing':
      return `${facts.baseChecked === false ? `Before any code, call finishedInterview. It runs ${baseCheckScript(facts.mode)} on the base, so a base that is already broken shows while nothing depends on it. Then: ` : ''}Develop test first. For a quick answer on your changes, run scripts/ndev/workflow/fast-checks.sh with the changed files; each commit also runs it. Commit and push through checkpoint when a step is coherent. When the work is complete, call finishedDevelopment with the PR numbers, the commit message and each changed file.`
    case 'developed':
      return 'This issue has finished development, and another issue on its PR has not. The last issue to finish calls finishedDevelopment, which starts the review of the PR. If this agent takes that issue, call started with its number. Else end your turn. For more work on this issue, commit with checkpoint.'
    case 'reviewing':
      return reviewStep(`Review: your last commit is not pushed yet, because the code is reviewed first. ${facts.mode === 'heavy' ? 'The plugin started the two-axis review: two ndev:diff-reviewer agents on the diff against the base branch, one for standards and one for the specification. Keep the two reports apart. Do not start another,' : 'The plugin started one independent review: the ndev:diff-reviewer agent on the diff against the base branch. Do not start another,'} and do not wait with a helper, because its answer comes to you. The plugin ran the dead-code sweep on this change, and this answer holds its result: triage each finding, and give the triage as deadcode. Meanwhile, do the remember hook: load the ndev:remember skill and record what this work taught in the project wiki, update each document that this change made wrong (the ndev:docs-sync skill helps when the project has a docs map), and run the dev-wiki ingest with the ndev:dev-wiki skill. When the answer comes, fix what they found with checkpoint, which holds those commits too. Then call finishedReview with each result, with remembered as what you recorded or "nothing: <reason>": it runs pre-ready-check.sh, pushes and marks the PR ready.`, facts)
    case 'ci':
      return 'Do not run a wait helper: the workflow watches the checks and merge conflicts of this PR, and prompts you when they end or when one fails. If nothing else is open, end your turn. When it prompts you, fix a failed check or a conflict with checkpoint, or call finishedChecks: it reads them for HEAD itself.'
    case 'smoke':
      return ['Smoke test the affected behaviour on the real preview URL.', facts.changeTypes?.includes('web') ? smokeWebStep(facts.webFiles ?? []) : '', facts.changeTypes?.includes('docs') ? SMOKE_DOCS_STEP : '', requiredSmokeTypes(facts.changeTypes ?? []).length ? `Then call finishedSmoke, with the URL that you tested in the report and the HEAD sha. The change types ${requiredSmokeTypes(facts.changeTypes ?? []).join(', ')} require this test: only a human can skip it, with /flow skip <reason>.` : 'Then call finishedSmoke, with the preview URL in the report and the HEAD sha, or with skipped and the reason.'].filter(Boolean).join(' ')
    case 'finishing':
      return facts.remembered ? `Do each chore that you would leave for the human, or file it with followUp. Then call done with a summary of the work. It checks everything, and ${mayMerge(facts.level) ? 'then it merges the PR, because this project level lets the agent merge' : 'a human merges'}.` : `Remember hook: the review stage was skipped, so do this now: load the ndev:remember skill and record what this work taught in the project wiki. Update each document that this change made wrong (the ndev:docs-sync skill helps when the project has a docs map), and commit it with checkpoint: a commit of documents only stays in this state, or goes to smoke when the change now holds documents and no smoke test has run. Then run the dev-wiki ingest: load the ndev:dev-wiki skill and follow "Ingest after a push". Do each chore that you would leave for the human, or file it with followUp. Then call done with a summary of the work, and with remembered: what you recorded, or "nothing: <reason>". It checks everything, and ${mayMerge(facts.level) ? 'then it merges the PR, because this project level lets the agent merge' : 'a human merges'}.`
    case 'revising':
      return 'Answer each piece of feedback that the reply names. Commit with checkpoint and reply on the PR. Then call finishedRevision.'
    case 'blocked':
      return 'Wait for the human. When the human answers and that resolves the block, call unblocked with what changed.'
    case 'wait':
      return 'A wait tool holds this agent. When it answers, go on from the state it names.'
    case 'done':
      if (facts.merged) return 'The work is finished and merged. Nothing is left to do.'
      return mayMerge(facts.level) ? 'The work is finished and not merged. This project level lets you merge: load the ndev:merge skill and follow it.' : 'The work is finished and waits for a human to merge. The base can move after done, so call status to read whether the PR can still merge. Nothing else is left to do.'
  }
}

export function nextStep(state: State, facts: Facts): string {
  const step = stepText(state, facts)
  if (state === 'done' || state === 'blocked' || state === 'wait') return step
  // A question at the end of a turn stops the work until the human answers it, and that human may be away.
  const question = 'Do not ask permission for a step that the plan already allows. If only the human can answer a question, call blocked.'
  return facts.steering === 'interactive' ? `${step} Report this checkpoint to the human in a short line. ${question}` : `${step} Continue without waiting. ${question}`
}
