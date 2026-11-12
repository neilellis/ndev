// /flow <command>: the human's controls over the workflow. These outrank the state machine:
// a skip or a goto is the human's decision, so it holds at any project level, and the PR records it.
import { read } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { saveSetting } from '../config'
import type { LoadedConfig } from '../config'
import { comment, git, head, markReady, readPr, withdrawAlert } from './effects'
import { afterSkip } from './machine'
import type { State } from './machine'
import { boundRoot, endAsking, factsFor, inTurn, isStaleWrite, isWaitRunning, labelOf, loadWorkflow, readHeld, waitHolder, whenTurnsFree, moved, saveWorkflow, hasDeclined, setDeclined, startReview, stepOf } from './tools'
import type { Workflow } from './tools'
import { EPIC_HELP, epicCommand } from './epic'
import { watcherNote } from './watchdog'

const HELP = [
  '/flow status: the state and the next step.',
  '/flow guide: show the guide to the workflow, with its flow chart.',
  '/flow skip [reason]: leave the current phase and go to the next one.',
  '/flow goto <state> [reason]: go to any state.',
  '/flow unblock [message]: end a block and withdraw its notification.',
  '/unblock <message>: give the agent your answer and end a block or a wait. It runs at once, also during a turn.',
  '/flow mode [light|heavy] [issue]: show or set the mode of one issue. It wins over the worktree and the project.',
  '/flow steering [interactive|auto] [issue]: the same for the steering.',
  '/flow off [reason]: stop the tools and the reminders for the issue or PR that this agent is on. The record stays.',
  '/flow on: turn them back on.',
  '/flow off project, /flow on project: the same for the whole project, in .neil-dev.json.',
  ...EPIC_HELP,
].join('\n')

const GOTO: State[] = ['setup', 'interviewing', 'planning', 'developing', 'reviewing', 'ci', 'smoke', 'finishing', 'revising', 'done']

type Project = LoadedConfig | undefined

async function clearBlock($: EngineInterface, wf: Workflow, notes: string[]) {
  if (!wf.blocked) return
  const problem = await withdrawAlert($, wf.root, wf.blocked)
  if (problem) notes.push(problem)
  wf.blocked = undefined
}

// Another session or process can save the record between this command's read and its write. The save then exits 5
// and changes nothing, so the command reads the record again and makes its change again. After the last try the
// error names the record, both revisions, the tries and the repair.
const FLOW_TRIES = 3
async function saveFresh($: EngineInterface, wf: Workflow, verb: string, change: (w: Workflow) => Promise<void>): Promise<Workflow> {
  let current = wf
  for (let tries = 1; ; tries += 1) {
    await change(current)
    try {
      await saveWorkflow($, current)
      return current
    } catch (error) {
      if (!isStaleWrite(error)) throw error
      if (tries >= FLOW_TRIES) throw new Error(`${(error as Error).message} /flow ${verb} read the record again ${tries} times, and each time another writer saved it first. Repair: run /flow status to see the record, then /flow ${verb} again.`)
    }
    const again = await loadWorkflow($, current.root, current.issue)
    if (!again) throw new Error(`/flow ${verb}: the record of ${labelOf(current)} in ${current.root} is gone after another writer saved it. Nothing was changed. Repair: run /flow status.`)
    current = again
  }
}

// The agent learns the new state by a prompt: a command's text goes to the human.
async function tellAgent($: EngineInterface, wf: Workflow, project: Project, what: string) {
  const facts = await factsFor($, wf.root, project, wf)
  const text = `${what} ${labelOf(wf)} is now in the state "${wf.state}". ${stepOf(wf, facts)}`
  // A command hook holds the turn, and the host refuses a prompt from inside it: submit just after.
  void $.clock.after(100, async () => {
    try {
      await $.prompt.submit({ text })
    } catch (error) {
      $.ui.toast(`workflow: the agent was not told of the change: ${error instanceof Error ? error.message : String(error)}. Tell it: ${text}`.slice(0, 400))
    }
  })
}

async function record($: EngineInterface, wf: Workflow, what: string, notes: string[]) {
  if (!wf.prs[0] || wf.direct) return
  try {
    await comment($, wf.root, wf.repo, wf.prs[0], `<!-- work-heavy-auto:workflow -->\n**work-heavy-auto:** The human ran /flow: ${what}`)
  } catch (error) {
    notes.push(`The PR does not record this: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const said = (notes: string[]) => (notes.length ? `\n${notes.join('\n')}` : '')

async function guide($: EngineInterface): Promise<string> {
  const path = `${$.plugin.root}/kb/workflow.md`
  if (!(await $.fs.exists(path))) return `The guide is missing: ${path} does not exist. Run: claude plugin update ndev`
  return $.fs.read(path)
}

async function run($: EngineInterface, args: string, getProject: () => Project, setProject: (p: LoadedConfig) => void): Promise<string> {
  const [verb = 'status', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const tail = rest.join(' ')
  if (verb === 'help') return HELP
  if (verb === 'guide') return guide($)
  if (verb === 'epic') return epicCommand($, rest, getProject())
  const project = getProject()
  if ((verb === 'off' || verb === 'on') && rest[0] === 'project') {
    if (!project) return 'Not saved: the project folder is not known yet.'
    if (project.error) return `Not saved: ${project.path} has an error (${project.error}). Fix the file, then run the command again.`
    const value = verb === 'on'
    await saveSetting($, project, 'workflow', value)
    setProject({ ...project, exists: true, config: { ...project.config, workflow: value } })
    return `The workflow is ${verb} for this project. Saved to ${project.path}; commit it to share the setting.`
  }
  if (verb === 'on' && (await hasDeclined($))) {
    await setDeclined($, false)
    return 'The workflow is on for this session. The agent starts it with mcp__ndev__started.'
  }
  const root = (await boundRoot($)) ?? project?.root
  const wf = root ? await loadWorkflow($, root) : undefined
  if (verb === 'status') {
    const off = project?.config.workflow === false ? `The workflow is off for this project (${project.path}). ` : ''
    if (!wf) return `${off}No workflow in ${root ?? 'this session'}. The agent starts one with mcp__ndev__started.\n\n${HELP}`
    const facts = await factsFor($, wf.root, project, wf)
    const last = wf.history.slice(-5).map(h => `${h.tool}: ${h.from ?? 'none'} to ${h.to}`).join('; ')
    const holder = wf.state === 'wait' ? await waitHolder($, wf) : undefined
    const watch = await watcherNote($)
    const watched = `\n\nWatcher: ${watch.why}${watch.at ? ` (${Math.round(((await $.clock.now()) - watch.at) / 1000)} s ago)` : ''}.`
    return `${off}${wf.off ? `Off for this issue: ${wf.off.reason}. ` : ''}${labelOf(wf)} in ${wf.root} is in the state "${wf.state}"${wf.previous ? ` (before the block: ${wf.previous})` : ''}.${wf.blocked ? ` Blocked: ${wf.blocked.message}` : ''}${holder ? `\n${holder.detail}` : ''}\nNext: ${holder?.next ?? stepOf(wf, facts)}\nLast moves: ${last || 'none'}${watched}`
  }
  if (verb === 'mode' || verb === 'steering') {
    const allowed = verb === 'mode' ? ['light', 'heavy'] : ['interactive', 'auto']
    const value = rest[0]
    if (value && !allowed.includes(value)) return `/flow ${verb}: ${JSON.stringify(value)} is not a ${verb}. Use ${allowed.join(' or ')}.`
    const named = rest[1] === undefined ? undefined : Number(rest[1])
    if (named !== undefined && (!Number.isInteger(named) || named <= 0)) return `/flow ${verb}: ${JSON.stringify(rest[1])} is not an issue number.`
    const target = named === undefined ? wf : root ? await loadWorkflow($, root, named) : undefined
    if (!target) return `No workflow${named ? ` for issue #${named}` : ''} in ${root ?? 'this session'}, so there is nothing to set. The agent starts one with mcp__ndev__started.`
    const now = (await factsFor($, target.root, project, target))[verb]
    if (!value) return `${labelOf(target)} is ${now}${target[verb] ? ', set for this issue' : ', from the worktree or the project'}. /flow ${verb} ${allowed.join('|')} [issue] changes it.`
    Object.assign(target, { [verb]: value })
    await saveWorkflow($, target)
    return `${labelOf(target)} is now ${value}. Other issues keep their settings. The steps that are complete stay complete, and the steps that remain follow this setting.`
  }
  if (!['skip', 'goto', 'unblock', 'off', 'on'].includes(verb)) return `/flow does not know "${verb}".\n\n${HELP}`
  if (!wf && verb === 'off') {
    await setDeclined($, true)
    return 'The workflow is off for this session: started refuses and no reminder comes. /flow on turns it back on.'
  }
  if (!wf) return `No workflow in ${root ?? 'this session'}, so there is nothing to change. /flow off project turns the workflow off for the whole project.`
  const now = await $.clock.now()
  const notes: string[] = []

  if (verb === 'off') {
    const reason = tail || 'no reason given'
    const saved = await saveFresh($, wf, 'off', async w => {
      await clearBlock($, w, notes)
      w.off = { at: now, reason }
    })
    await record($, saved, `off (${reason}).`, notes)
    return `The workflow of ${labelOf(saved)} is off: its tools refuse and no reminder comes. The state stays "${saved.state}".${said(notes)}`
  }
  if (verb === 'on') {
    if (!wf.off) return `The workflow of ${labelOf(wf)} is already on, in the state "${wf.state}".`
    wf.off = undefined
    wf.nudges = { count: 0 }
    await saveWorkflow($, wf)
    await tellAgent($, wf, project, 'The human turned the workflow back on.')
    return `The workflow of ${labelOf(wf)} is on, in the state "${wf.state}".`
  }
  if (verb === 'unblock' && wf.state === 'wait' && wf.previous) {
    const previous = wf.previous
    const id = wf.waiting?.id
    // A running wait tool reads the answer from the record and gives it to the agent as its result.
    const running = !!id && isWaitRunning(id)
    if (running) wf.waitAnswer = { id, message: tail }
    // A live wait withdraws its own notice. The notice of a wait that died with its session is for this command to withdraw.
    if (!running && wf.waiting?.alert) {
      const problem = await withdrawAlert($, wf.root, wf.waiting.alert)
      if (problem) notes.push(problem)
    }
    moved(wf, 'human:unblock', { state: previous }, now)
    wf.nudges = { count: 0 }
    await saveWorkflow($, wf)
    if (!running) await tellAgent($, wf, project, `The human ended the wait${tail ? `: ${tail}` : ''}.`)
    return `${labelOf(wf)} is back in the state "${previous}".`
  }
  if (verb === 'unblock') {
    if (wf.state !== 'blocked' || !wf.previous) return `${labelOf(wf)} is not blocked: it is in the state "${wf.state}".`
    await clearBlock($, wf, notes)
    const previous = wf.previous
    moved(wf, 'human:unblock', { state: previous }, now)
    wf.nudges = { count: 0 }
    await saveWorkflow($, wf)
    await tellAgent($, wf, project, `The human ended the block${tail ? `: ${tail}` : ''}.`)
    return `${labelOf(wf)} is back in the state "${previous}".${said(notes)}`
  }

  const facts = await factsFor($, wf.root, project, wf)
  let to: State
  if (verb === 'skip') {
    const move = afterSkip({ state: wf.state, previous: wf.previous }, facts.mode, facts.steering)
    if ('refused' in move) return move.refused
    to = move.state
  } else {
    const wanted = rest[0] as State | undefined
    if (!wanted || !GOTO.includes(wanted)) return `/flow goto needs one of: ${GOTO.join(', ')}.`
    to = wanted
  }
  // Past development a PR has one record. One issue alone cannot go there while the PR has others.
  if (!wf.pr && wf.prs[0] && !['setup', 'interviewing', 'planning', 'developing'].includes(to)) {
    const others = (await readHeld($, wf.root)).issues.filter(o => o.issue !== wf.issue && o.prs[0] === wf.prs[0] && o.state !== 'done')
    if (others.length) {
      const all = [wf, ...others].map(o => o.issue).sort((a, b) => a - b).join(', ')
      return `/flow ${verb}: PR #${wf.prs[0]} also carries ${others.map(o => `#${o.issue} ("${o.state}")`).join(', ')}, so issue #${wf.issue} cannot go past development alone. Nothing changed. Repair: have the agent call finishedDevelopment with the issues ${all}. Then /flow ${verb} works on the PR.`
    }
  }
  const reason = (verb === 'skip' ? tail : rest.slice(1).join(' ')) || 'no reason given'
  const from = wf.state
  if (to === 'done') {
    if (!wf.direct && !wf.prs.length) return `/flow goto done: ${labelOf(wf)} has no PR, so nothing is ready for a human. Nothing changed. Have the agent call started: it opens the draft PR.`
    const pushed = await git(wf.root, $, 'rev-parse', `origin/${wf.branch}`)
    if (pushed.stdout.trim() !== (await head(wf.root, $))) return `/flow goto done: HEAD is not pushed to origin/${wf.branch}. Nothing changed. Use goto finishing, and have the agent call checkpoint with no files.`
  }
  await clearBlock($, wf, notes)
  // Only finishedReview marks the PR ready and pushes, so a human move past it does that part here.
  const pastReview = from === 'reviewing' && to !== 'developing' && to !== 'planning' && to !== 'reviewing'
  let holds = ''
  if (pastReview) {
    if (wf.prs[0]) {
      try {
        const pr = await readPr($, wf.root, wf.repo, wf.prs[0])
        if (pr.draft) await markReady($, wf.root, wf.repo, pr.number)
      } catch (error) {
        notes.push(`PR #${wf.prs[0]} was not marked ready: ${error instanceof Error ? error.message : String(error)}. Repair: gh pr ready ${wf.prs[0]}.`)
      }
    }
    if ((await git(wf.root, $, 'rev-parse', `origin/${wf.branch}`)).stdout.trim() !== (await head(wf.root, $))) holds = ' A commit is held and not pushed: call checkpoint with no files.'
  }
  // A skip of the phase's check leaves evidence for `done`, marked as the human's decision.
  const sha = await head(wf.root, $)
  if (from === 'setup' && verb === 'skip') wf.noChecks = true
  if ((from === 'ci' && verb === 'skip') || (verb === 'goto' && ['finishing', 'smoke', 'done'].includes(to) && wf.evidence.checks?.sha !== sha)) {
    wf.evidence.checks = { sha, text: `skipped by the human: ${reason}`, byHuman: true }
  }
  if (from === 'smoke' && verb === 'skip') wf.evidence.smoke = { sha, text: `skipped by the human: ${reason}` }
  wf.attempts = 0
  wf.nudges = { count: 0 }
  if (from === 'interviewing') notes.push(...(await endAsking($, wf)))
  moved(wf, `human:${verb}`, { state: to }, now)
  await saveWorkflow($, wf)
  if (to === 'reviewing') {
    notes.push(await startReview($, wf, facts))
    await saveWorkflow($, wf)
  }
  const what = verb === 'skip' ? `skip "${from}", at ${sha.slice(0, 8)}: ${reason}` : `goto "${to}" from "${from}", at ${sha.slice(0, 8)}: ${reason}`
  await record($, wf, what, notes)
  if (to !== 'done') await tellAgent($, wf, project, from === 'setup' && !wf.direct && !wf.prs.length ? `The human moved the workflow past setup (${reason}), and it has no PR yet: call started with issue ${wf.issue} now, which opens the draft PR.` : `The human moved the workflow from "${from}" (${reason}). Do not go back to that phase.${holds}`)
  return `${labelOf(wf)} moved from "${from}" to "${to}".${said(notes)}`
}

async function answerCommand($: EngineInterface, args: string, getProject: () => Project, setProject: (p: LoadedConfig) => void) {
  try {
    return { text: await inTurn(() => run($, args, getProject, setProject)) }
  } catch (error) {
    return { text: `/flow ${args} failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

// The message is compulsory: it is the answer that the agent waits for.
async function answerUnblock($: EngineInterface, args: string, getProject: () => Project, setProject: (p: LoadedConfig) => void) {
  try {
    if (args.trim()) {
      await whenTurnsFree($)
      return { text: await inTurn(() => run($, `unblock ${args}`, getProject, setProject)) }
    }
    const project = getProject()
    const root = (await boundRoot($)) ?? project?.root
    const wf = root ? await loadWorkflow($, root) : undefined
    const held = wf?.blocked ? ` The block says: ${wf.blocked.message}` : wf?.waiting ? ` It waits for ${wf.waiting.what}.` : ''
    return { text: `Nothing changed. Usage: /unblock <message>, where the message is your answer to the agent.${held}` }
  } catch (error) {
    return { text: `/unblock ${args} failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function startWorkflowCommand($: EngineInterface): Promise<void> {
  await $.command.register({ name: 'unblock', description: 'ndev: give the agent your answer and end its block or wait', argumentHint: '<message>', immediate: true })
  await $.command.register({ name: 'flow', description: 'ndev: control the workflow of this worktree: status, guide, mode, steering, skip, goto, unblock, off, on, epic', argumentHint: '[status|guide|skip [reason]|goto <state>|unblock|off [project]|on [project]|epic [issue|title|status|skip|goto|off]]' })
}

export const workflowCommand = (on: Parameters<Register>[0], getProject: () => Project, setProject: (p: LoadedConfig) => void) => {
  on('command.run', { command: 'flow' }, ($, e) => answerCommand($, e.args, getProject, setProject))
  on('command.run', { command: 'unblock' }, ($, e) => answerUnblock($, e.args, getProject, setProject))
}
