import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { checkText, isComponent } from '../../hooks/component-files.ts'
import { gitCode, gitFolder, OWN_WAIT, pushNames, pushesOnly, RAW_GIT } from '../../hooks/workflow/git-guard.ts'
import { envFor, SCRIPT, TIMEOUT_MS, validateQuality } from '../../hooks/quality-shared.ts'
import { binding } from '../export/flow/public.ts'
import { argsFor, atomicJson, checked, CliError, gitWorkspace, locked, readObject, releaseRoot, run, stateRoot, worktreeScript } from './common.mjs'
import { readProject } from './project.mjs'
import { readWorkflowRecords, recoverDeadWaits, saveWorkflowRecord } from './waits.mjs'

const events = new Set(['session-start', 'prompt-submit', 'prompt-context', 'pre-tool-use', 'post-tool-use', 'turn-start', 'turn-complete', 'session-end', 'compact'])
const harnesses = new Set(['claude', 'codex', 'opencode'])
const correction = /^\s*(?:no\b|nope\b|stop\b|wrong\b|don'?t\b|do not\b|not like that|that'?s not|instead\b|actually\b|i said\b|why did you\b)|\b(?:you should(?:n't)?|never do|always do|from now on)\b/i
const shellTools = new Set(['bash', 'shell', 'exec_command'])
const editTools = new Set(['edit', 'write', 'apply_patch', 'multiedit', 'patch'])

export function hookSessionFile(root, id) {
  const key = createHash('sha256').update(JSON.stringify([root, id])).digest('hex')
  return join(stateRoot(), 'sessions', `${key}.json`)
}

function changeSession(root, id, change) {
  if (!id) return
  const file = hookSessionFile(root, id)
  mkdirSync(join(stateRoot(), 'sessions'), { recursive: true, mode: 0o700 })
  locked(file, () => {
    const previous = readObject(file, { missing: {} })
    const patch = typeof change === 'function' ? change(previous) : change
    if (patch) atomicJson(file, { ...previous, id, root, ...patch })
  })
}

export function currentWorkflow(root, ids = []) {
  const records = readWorkflowRecords(root)
  const ordered = records.filter(wf => !wf.off && !wf.noChecks && !['done', 'setup'].includes(wf.state))
  const own = ordered.filter(wf => ids.includes(wf.owner?.session))
  return own.find(wf => wf.pr) ?? own[0] ?? ordered.find(wf => wf.pr) ?? ordered[0]
}

export function workflowRootFor(root, session) {
  return session ? binding(root, session)?.root ?? root : root
}

function releaseSession(root, ids) {
  for (const record of readWorkflowRecords(root)) {
    if (!record.owner?.session || !ids.includes(record.owner.session)) continue
    const { owner, wait, previous, ...rest } = record
    const phase = record.state === 'wait' && wait?.id ? { state: previous, lastWait: { id: wait.id, outcome: 'owner_exited', endedAt: Date.now() } } : { wait, previous }
    if (phase.state === undefined && record.state === 'wait' && wait?.id) {
      throw new CliError(1, `Issue #${record.issue} has no earlier phase for wait ${wait.id}.`, { repair: 'Inspect the issue record before releasing the session.' })
    }
    saveWorkflowRecord(root, { ...rest, ...phase, lastSession: owner.session, releasedAt: Date.now() })
  }
}

function findWorkspace(cwd) {
  try {
    return gitWorkspace(cwd)
  } catch (error) {
    if (/not a git repository/i.test(error.details?.output ?? '')) return null
    throw error
  }
}

function toolCall(payload) {
  const input = payload.tool_input ?? payload.input ?? {}
  const tool = String(payload.tool_name ?? payload.tool ?? '').toLowerCase()
  const command = typeof input.command === 'string' ? input.command : typeof input.cmd === 'string' ? input.cmd : ''
  return { tool, command, input, shell: shellTools.has(tool), edit: editTools.has(tool) }
}

function successful(payload) {
  const result = payload.tool_response ?? payload.output
  const exit = result?.exitCode ?? result?.exit_code
  return result?.isError !== true && result?.is_error !== true && (exit === undefined || exit === 0)
}

function componentNotes(root, cwd, id, call, workflow) {
  if (workflow && ['planning', 'developing', 'hardening'].includes(workflow.state)) return []
  const candidates = [call.input.file_path, call.input.filePath, call.input.path].filter(value => typeof value === 'string')
  if (call.tool === 'apply_patch' && typeof call.input.command === 'string') {
    candidates.push(...[...call.input.command.matchAll(/^\*\*\* (?:Add|Update|Move to) File: (.+)$/gm)].map(match => match[1]))
  }
  const files = [...new Set(candidates.map(file => resolve(realpathSync(cwd), file)))].filter(file => {
    const name = relative(root, file)
    return !name.startsWith('../') && !isAbsolute(name) && isComponent(file)
  })
  let fresh = files
  if (id && files.length) changeSession(root, id, state => {
    const seen = state.componentFiles ?? []
    fresh = files.filter(file => !seen.includes(file))
    return fresh.length ? { componentFiles: [...seen, ...fresh] } : null
  })
  return fresh.map(file => checkText(file, join(releaseRoot, 'kb/ui-components.md')))
}

function pushMarker(root, id, token, event, call, payload) {
  const code = gitCode(call.command)
  const pushes = [...code.matchAll(RAW_GIT)].some(match => match[2] === 'push') || /(?:^|\s|\/)push[\w-]*\.sh\b/.test(code)
  if (!pushes || /--dry-run\b/.test(code)) return undefined
  if (call.input.run_in_background === true) {
    return event === 'post-tool-use' && successful(payload) ? 'A push is still in progress. When it succeeds, load ndev-dev-wiki and capture lessons.' : undefined
  }
  if (!id || typeof token !== 'string') return undefined
  const output = () => checked('git', ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes'], { cwd: root }).split('\n').filter(Boolean)
  let before
  if (event === 'pre-tool-use') {
    const refs = output()
    changeSession(root, id, state => {
      const earlier = Object.entries(state.pushRefs ?? {}).slice(-15)
      return { pushRefs: { ...Object.fromEntries(earlier), [token]: refs } }
    })
    return undefined
  }
  changeSession(root, id, state => {
    if (!Object.hasOwn(state.pushRefs ?? {}, token)) return undefined
    const { [token]: recorded, ...rest } = state.pushRefs
    before = recorded
    return { pushRefs: rest }
  })
  if (!before || !successful(payload)) return undefined
  for (const line of output()) {
    if (before.includes(line)) continue
    const [ref, sha] = line.split(' ')
    const action = checked('git', ['reflog', 'show', '-n', '1', '--format=%gs', ref], { cwd: root })
    if (!action.startsWith('update by push')) continue
    const branch = ref.replace(/^refs\/remotes\//, '')
    const included = run('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: root })
    if (included.status > 1) throw new CliError(1, `git merge-base failed for ${sha} (exit ${included.status}): ${included.stderr}`, { repair: 'Check the worktree HEAD and remote tracking ref.' })
    if (included.status === 0 || code.includes(branch.split('/').slice(1).join('/'))) {
      return `A push landed on ${branch}. Load ndev-dev-wiki and follow its lesson capture steps.`
    }
  }
}

function rawGitReason(command, workspace, workflow, helperCwd) {
  if (!workflow) return undefined
  const label = `Issue #${workflow.issue} is in ${workflow.state}.`
  if (OWN_WAIT.test(gitCode(command)) && (workflow.state === 'ci' || workflow.doneWaitsFor)) {
    return `${label} ndev watch reads these checks. Use ndev flow status for its current result.`
  }
  const normalized = gitCode(command)
  const workflowDir = findWorkspace(workflow.root ?? workspace.root)
  for (const match of normalized.matchAll(RAW_GIT)) {
    const target = gitFolder(normalized, normalized.slice(0, match.index), match[1] ?? '', helperCwd, process.env.HOME)
    const tail = normalized.slice(match.index + match[0].length)
    const hotfix = workflow.hotfixes?.find(item => item.dir === target)
    if (hotfix && (match[2] !== 'push' || pushesOnly(tail, hotfix.branch))) continue
    const there = target ? findWorkspace(target) : null
    if (there && workflowDir && there.commonDir !== workflowDir.commonDir) continue
    const ownedRef = match[2] === 'push' && pushNames(tail.split(/[;&|)\n]/)[0], workflow)
    const followUp = workflow.followUps?.some(item => item.worktree && findWorkspace(item.worktree)?.gitDir === there?.gitDir)
    if (there && workflowDir && there.gitDir !== there.commonDir && there.gitDir !== workflowDir.gitDir && !ownedRef && !followUp) continue
    return `${label} Commit or push with ndev flow checkpoint so the checks run.`
  }
}

function native(event, harness, result = {}) {
  const { reason, context } = result
  if (reason) {
    if (harness === 'opencode') return { decision: 'deny', reason }
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
  }
  if (!context) return null
  if (harness === 'opencode') return { additionalContext: context }
  const nativeEvent = { 'session-start': 'SessionStart', 'prompt-submit': 'UserPromptSubmit', 'prompt-context': 'UserPromptSubmit', 'pre-tool-use': 'PreToolUse', 'post-tool-use': 'PostToolUse' }[event]
  return nativeEvent ? { hookSpecificOutput: { hookEventName: nativeEvent, additionalContext: context } } : { systemMessage: context }
}

function guidance({ root, linked }, config, workflow) {
  const settings = linked ? readObject(join(root, '.neil-dev.worktree.json'), { missing: {} }).settings ?? {} : {}
  const mode = workflow?.mode ?? settings.mode ?? config.mode ?? 'light'
  const steering = workflow?.steering ?? settings.steering ?? config.steering ?? 'interactive'
  const skill = mode === 'hack' ? 'ndev-work-hack' : `ndev-work-${mode}${steering === 'auto' ? '-auto' : ''}`
  const github = config.github
  return [
    `Mode ${mode}. Steering ${steering}. Load ${skill} for development work.`,
    github?.repo ? `GitHub repository ${github.repo}${github.board ? `, board ${github.board.owner}/${github.board.number}` : ''}.` : github?.repo === null ? undefined : 'Use ndev project setup to set the GitHub repository and board.',
    config.branding ? `Use the project brand at ${config.branding.guide ?? config.branding.site}.` : undefined,
    'Use ndev-dev-wiki for reusable lessons and ndev-remember for project facts.',
    'Report decisions needed, PRs and their check status, and any follow-up issues for review.',
    config.workflow !== false && (workflow ? `Issue #${workflow.issue} is in ${workflow.state}. Run ndev flow status for the next step. Use ndev flow checkpoint for commits and pushes.` : 'For GitHub issue work, run ndev flow start <issue> or ndev flow create.'),
  ].filter(Boolean).join('\n')
}

function qualityHook(name, root, settings, event, call, payload) {
  const script = join(releaseRoot, 'kb/hooks', SCRIPT[name])
  const input = { ...payload, cwd: root, hook_event_name: event, tool_name: call.shell ? 'Bash' : call.tool === 'write' ? 'Write' : 'Edit', tool_input: call.input }
  const ran = run('bash', [script], { cwd: root, input: JSON.stringify(input), timeout: TIMEOUT_MS[name], env: { ...process.env, ...envFor(name, settings, root) } })
  if (ran.status !== 0 && !(name === 'editedFileGuards' && ran.status === 2)) {
    return `${script} exited ${ran.status}: ${ran.stderr.trim() || ran.stdout.trim() || 'no output'}. Fix the cause and retry the tool call.`
  }
  if (name === 'subscriptionWarning' && ran.stdout.trim()) {
    const output = JSON.parse(ran.stdout)
    return output.hookSpecificOutput?.additionalContext ?? output.additionalContext
  }
  return ran.stderr.trim()
}

function qualityNotes(root, config, workflow, call, payload, event) {
  const quality = config.quality ?? {}
  const error = validateQuality(quality)
  if (error) throw new CliError(1, `${root}/.neil-dev.json: ${error}`, { repair: 'Fix the quality settings and retry the tool call.' })
  const notes = []
  const add = (name, nativeEvent) => {
    if (quality[name] !== undefined) notes.push(qualityHook(name, root, quality[name], nativeEvent, call, payload))
  }
  if (event === 'pre-tool-use') {
    const gate = quality.subscriptionWarning
    if (call.shell && gate && (call.command.includes('claude') || call.command.includes(gate.gateVar ?? 'ALLOW_CLAUDE_CLI'))) add('subscriptionWarning', 'PreToolUse')
  } else {
    if (!successful(payload)) return []
    if (call.edit && !workflow) add('editedFileGuards', 'PostToolUse')
    if (call.shell && !workflow && /\bgit\b.*\bcommit\b/.test(gitCode(call.command))) add('precheckReminder', 'PostToolUse')
    if (call.shell && /\bgit\s+worktree\s+add\b/.test(gitCode(call.command))) add('worktreeSubmodules', 'PostToolUse')
  }
  return notes.filter(Boolean)
}

function sessionStart(root, workspace, id, config, workflow) {
  if (workspace.linked) checked('bash', [worktreeScript, 'init', '--worktree', root], { cwd: root, repair: 'Check the worktree and run ndev hook session-start again.' })
  changeSession(root, id, { startedAt: Date.now(), activityAt: Date.now(), endedAt: null })
  const home = process.env.HOME
  if (home && !existsSync(join(home, 'dev-wiki/wiki.md'))) {
    const wiki = join(home, 'dev-wiki')
    if (!existsSync(wiki)) checked('bash', [join(releaseRoot, 'scripts/wiki/init.sh'), wiki], { cwd: root })
    else return `${wiki} exists without wiki.md. Move it aside or restore wiki.md, then start a new session.`
  }
  if (existsSync(join(root, 'scripts/init-project.sh')) && !existsSync(join(root, '.ndev-inited'))) {
    return 'This worktree needs its project build. Run ndev project init.'
  }
  return !workflow && config.workflow !== false ? 'Ask which issue to work on when the human starts development work.' : undefined
}

export async function runHook([event, ...argv], supplied) {
  const repair = 'ndev hook --help'
  if (!events.has(event)) throw new CliError(2, `Unknown hook event ${JSON.stringify(event)}.`, { repair })
  const { values } = argsFor(argv, { harness: { type: 'string' } }, repair)
  const harness = values.harness
  if (harness !== undefined && !harnesses.has(harness)) throw new CliError(2, `Unknown hook harness ${harness}.`, { repair })
  let payload = supplied
  if (!payload) {
    try {
      payload = JSON.parse(readFileSync(0, 'utf8'))
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('expected a JSON object')
    } catch (error) {
      throw new CliError(2, `Hook ${event} could not read its JSON payload: ${error.message}.`, { repair: 'Pass the native event as JSON on stdin.' })
    }
  }
  const cwd = payload.cwd ?? payload.directory ?? process.cwd()
  const id = process.env.ORCA_AGENT_SESSION_ID ?? payload.session_id ?? payload.sessionID
  const call = toolCall(payload)
  if (event === 'pre-tool-use' || event === 'post-tool-use') {
    const { walkPreTool, walkPostTool } = await import('./walk-doc.mjs')
    const walkCall = { ...call, session: id, terminal: process.env.ORCA_TERMINAL_HANDLE }
    if (event === 'pre-tool-use') {
      const reason = await walkPreTool(cwd, walkCall)
      if (reason) return { event, native: native(event, harness, { reason }), reason }
    } else {
      await walkPostTool(cwd, { ...walkCall, output: payload.tool_response ?? payload.output, succeeded: successful(payload) })
    }
  }
  const workspace = findWorkspace(cwd)
  if (!workspace) return { native: null, event, outsideWorktree: true }
  const { root } = workspace
  const config = readProject(root)
  const scoped = workflowRootFor(root, id)
  const { activeEpic } = await import('./epic.mjs')
  const epic = id ? activeEpic(root, id) : undefined
  const workflow = config.workflow === false || epic ? undefined : currentWorkflow(scoped, [id, payload.session_id])
  const prompt = payload.prompt ?? payload.text ?? ''
  const notes = []
  let reason
  if (event === 'pre-tool-use' && call.shell) {
    const helperCwd = payload.agent_id || payload.agentId ? cwd : undefined
    reason = rawGitReason(call.command, workspace, workflow, helperCwd)
  }
  if (event === 'session-start') {
    const note = sessionStart(root, workspace, id, config, workflow)
    if (note) notes.push(note)
    if (id && process.env.ORCA_TERMINAL_HANDLE) {
      const { ensureWatcher } = await import('./watch.mjs')
      ensureWatcher(root, id, process.env.ORCA_TERMINAL_HANDLE)
    }
  }
  if (event === 'prompt-submit' || event === 'turn-start') changeSession(root, id, { activityAt: Date.now(), running: true, turn: payload.turn_id })
  if (event === 'turn-complete') {
    recoverDeadWaits(scoped)
    const file = id ? readObject(hookSessionFile(root, id), { missing: {} }) : {}
    if (!payload.agent_id && (!file.turn || !payload.turn_id || file.turn === payload.turn_id)) {
      changeSession(root, id, { running: false, activityAt: Date.now(), turnEndedAt: Date.now() })
    }
  }
  if (event === 'compact') changeSession(root, id, { compactedAt: Date.now() })
  if (event === 'session-end') {
    if (harness === 'claude' && ['clear', 'resume'].includes(payload.reason)) return { event, native: null, keptSession: true }
    changeSession(root, id, { endedAt: Date.now(), running: false })
    if (id) {
      const { finishWalkOnSessionEnd } = await import('./walk-doc.mjs')
      await finishWalkOnSessionEnd(root, id)
    }
    recoverDeadWaits(scoped)
    releaseSession(scoped, [id, payload.session_id])
    if (workspace.linked) {
      const record = readObject(join(root, '.neil-dev.worktree.json'), { missing: {} })
      if (Object.values(record.resources ?? {}).some(value => Object.keys(value).length)) {
        checked('bash', [worktreeScript, 'stop-all', '--worktree', root, '--on-end', config.worktreeStacks?.onSessionEnd ?? 'stop-and-delete'], { cwd: root, timeout: 120_000 })
      }
    }
  }
  if (event === 'prompt-submit' && typeof prompt === 'string' && correction.test(prompt)) {
    notes.push('Apply the correction. Record reusable lessons with ndev-dev-wiki or project facts with ndev-remember.')
  }
  if (['session-start', 'prompt-submit', 'prompt-context'].includes(event)) {
    notes.push(guidance(workspace, epic ? { ...config, workflow: false } : config, workflow))
    if (epic) notes.push(`Epic #${epic.epic} is in ${epic.state}. Run ndev epic status ${epic.epic} for the coordinator's next action.`)
  }
  if (!reason && ['pre-tool-use', 'post-tool-use'].includes(event)) notes.push(...qualityNotes(root, config, workflow, call, payload, event))
  if (event === 'post-tool-use' && call.edit && successful(payload)) notes.push(...componentNotes(root, cwd, id, call, workflow))
  if (!reason && call.shell && !workflow && ['pre-tool-use', 'post-tool-use'].includes(event)) {
    const note = pushMarker(root, id, payload.tool_use_id ?? payload.call_id, event, call, payload)
    if (note) notes.push(note)
  }
  const context = notes.join('\n') || undefined
  return { event, native: native(event, harness, { reason, context }), reason, context }
}
