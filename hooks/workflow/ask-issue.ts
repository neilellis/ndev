// A person starts a session with no issue: ask for the issue, a new issue, or no workflow.
// A session that has a task already gets no dialog, so that an unattended worker cannot stop here.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { LoadedConfig } from '../config'
import { git, run } from './effects'
import { loadWorkflow, setDeclined } from './tools'
import { promptSince } from './watchdog'

// A worker's first prompt reaches the session in this time, so it is not met by a dialog.
const PROMPT_WAIT_MS = 3_000
// A session older than this is resumed or reloaded, and it has its context already.
const NEW_SESSION_MS = 60_000
const EXISTING = 'Use an existing issue'
const NEW_ISSUE = 'Create a new issue'
const NONE = 'Work without the workflow'
const asked = atom({ plugin: 'ndev', key: 'workflowIssueAsked' } as const, false, { shape: 'workflow-issue-asked-1' })

// Orca links a workspace to its issue when it makes the workspace for one. Its failure is shown, and the question still comes.
async function orcaIssue($: EngineInterface, root: string): Promise<boolean> {
  if (!(await $.env.get('ORCA_WORKSPACE_ID'))) return false
  const r = await run($, ['orca', 'worktree', 'show', '--worktree', `path:${root}`, '--json'], { cwd: root, timeoutMs: 20_000 })
  if (r.exitCode !== 0) {
    $.ui.toast(`workflow: orca worktree show for ${root} exited ${r.exitCode}: ${(r.stderr || r.stdout).trim().slice(0, 200)}. Orca was not read for the issue of this workspace.`)
    return false
  }
  return !!(JSON.parse(r.stdout) as { result?: { worktree?: { linkedIssue?: unknown } } }).result?.worktree?.linkedIssue
}

async function hasIssue($: EngineInterface, root: string): Promise<boolean> {
  const wf = await loadWorkflow($, root)
  if (wf?.off || (wf && wf.state !== 'done')) return true
  const branch = await git(root, $, 'rev-parse', '--abbrev-ref', 'HEAD')
  if (branch.exitCode !== 0) return true // Not a git repository, so there is no work for an issue here.
  return /(?:^|[/-])issue-\d+/.test(branch.stdout) || orcaIssue($, root)
}

async function fill($: EngineInterface, text: string): Promise<void> {
  const { isFilled } = await $.prompt.fill({ text })
  if (!isFilled) $.ui.toast(`ndev: the prompt box did not take the text. Type: ${text}`)
}

async function act($: EngineInterface, answer: string): Promise<void> {
  const typed = /^#?(\d+)$/.exec(answer)?.[1] ?? /\/issues\/(\d+)\b/.exec(answer)?.[1]
  if (answer === NONE) {
    await setDeclined($, true)
    $.ui.toast('ndev: no workflow in this session. /ndev-workflow on turns it back on.')
  } else if (answer === EXISTING) {
    await fill($, 'Work on issue #')
  } else if (answer === NEW_ISSUE) {
    await fill($, '/ndev:issue ')
  } else if (typed) {
    await $.prompt.submit({ text: `Work on issue #${typed}. Call mcp__ndev__started with its number and a shortName that you choose from the issue.` })
  } else if (answer) {
    await $.prompt.submit({ text: `File a new issue with the ndev:issue skill for this work, then call mcp__ndev__started with its number and a shortName that you choose from it: ${answer}` })
  }
}

export async function askForIssue($: EngineInterface, getProject: () => LoadedConfig | undefined, isInteractive: boolean, began: number): Promise<void> {
  if (!isInteractive || (await read($, asked))) return
  await $.clock.sleep(PROMPT_WAIT_MS)
  const project = getProject()
  if (!project?.exists || project.error || project.config.workflow === false) return
  if (began - (await $.session.usage()).startedAt > NEW_SESSION_MS) return
  if (await hasIssue($, project.root)) return
  // The system text tells the agent to ask, when the task of this session names no issue.
  if ((await promptSince($, began)) || (await $.prompt.read()).text.trim()) return
  await update($, asked, () => true)
  let answer: string
  try {
    answer = (await $.ui.ask('This session has no issue. Which issue is this work for? You can also type an issue number, or what the new issue is about.', { header: 'Issue', options: [EXISTING, NEW_ISSUE, NONE] })).trim()
  } catch {
    return // The dialog was closed: the system text tells the agent to ask when work starts.
  }
  await act($, answer)
}
