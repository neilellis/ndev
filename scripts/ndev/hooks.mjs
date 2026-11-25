import { blockedNativePrompt } from './chat-guard.mjs'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { checkText, isComponent } from '../../hooks/component-files.ts'
import { gitCode, gitFolder, OWN_WAIT, pushNames, pushesOnly, RAW_GIT } from '../../hooks/workflow/git-guard.ts'
import { harnessSession, recordInnerSession } from '../../hooks/workflow/session.ts'
import { envFor, SCRIPT, TIMEOUT_MS, validateQuality } from '../../hooks/quality-shared.ts'
import { ensureProjectFiles } from '../../orca-plugin/ndev/worker/files.mjs'
import { binding } from '../export/flow/public.ts'
import { argsFor, atomicJson, checked, CliError, gitWorkspace, isAlive, locked, readObject, releaseRoot, run, stateRoot, worktreeScript } from './common.mjs'
import { readProject } from './project.mjs'
import { commitFiles, fixedEditReason, hasRecords, rawCreateReason, recordCheck, recordCommitReason, recordProblemNote, requirementsList, savesCommit } from './requirement-hooks.mjs'
import { effectiveWorkflowRecords, readWorkflowRecords, recoverDeadWaits, saveWorkflowRecord } from './waits.mjs'

const events = new Set(['session-start', 'prompt-submit', 'prompt-context', 'pre-tool-use', 'post-tool-use', 'turn-start', 'turn-complete', 'session-end', 'compact'])
const harnesses = new Set(['claude', 'codex', 'opencode', 'antigravity'])
const correction = /^\s*(?:no\b|nope\b|stop\b|wrong\b|don'?t\b|do not\b|not like that|that'?s not|instead\b|actually\b|i said\b|why did you\b)|\b(?:you should(?:n't)?|never do|always do|from now on)\b/i
const shellTools = new Set(['bash', 'shell', 'exec_command'])
const editTools = new Set(['edit', 'write', 'apply_patch', 'multiedit', 'patch'])

export function hookSessionFile(root, id) {
  const key = createHash('sha256').update(JSON.stringify([root, id])).digest('hex')
  return join(stateRoot(), 'sessions', `${key}.json`)
}

export function watcherState(root, id) {
  return hookSessionFile(root, id).replace(/\.json$/, '.watch.json')
}

export function watcherStatus(root, id) {
  const { pid, startError, lastNotice } = id ? readObject(watcherState(root, id), { missing: {} }) : {}
  const running = Boolean(pid) && isAlive(pid)
  return { running, ...(running ? { pid } : {}), ...(startError ? { startError } : {}), ...(lastNotice ? { lastNotice } : {}) }
}

function watcherRunning(root, id) {
  return watcherStatus(root, id).running
}

function rootWatched(root) {
  const dir = join(stateRoot(), 'sessions')
  if (!existsSync(dir)) return false
  return readdirSync(dir).filter(name => name.endsWith('.watch.json')).some(name => {
    const { root: watched, pid } = readObject(join(dir, name), { missing: {} })
    return watched === root && Boolean(pid) && isAlive(pid)
  })
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
  const ordered = effectiveWorkflowRecords(root).filter(wf => !wf.off && !wf.noChecks && !['done', 'setup'].includes(wf.state))
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

function transcriptLines(file, agent) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
  } catch (error) {
    throw new CliError(1, `The transcript ${file} of subagent ${agent} cannot be read: ${error.message}.`, { repair: 'Check that the harness still has the subagent transcript, then give the review answer to ndev flow finished-review.' })
  }
}

const messageText = entry => {
  const content = entry?.message?.content
  return typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part?.type === 'text').map(part => part.text).join('\n') : ''
}

function keepReviewAnswer(root, agent, payload) {
  const file = payload.agent_transcript_path
  const unanswered = run => Boolean(run.brief) && run.answer === undefined
  const pending = effectiveWorkflowRecords(root).filter(record => (record.exportReview?.runs ?? []).some(unanswered))
  if (!file || !pending.length) return
  const lines = transcriptLines(file, agent)
  const prompt = messageText(lines.find(entry => entry.type === 'user'))
  const briefed = run => unanswered(run) && prompt.includes(run.brief)
  const matches = pending.filter(record => record.exportReview.runs.some(briefed))
  if (!matches.length) return
  if (matches.length > 1) {
    throw new CliError(1, `Subagent ${agent} reviewed from a brief that issues ${matches.map(record => `#${record.issue}`).join(' and ')} both hold, so its answer has no single issue.`, { repair: 'Give the answer to ndev flow finished-review --issue <n> for the issue that the review is for.' })
  }
  const [record] = matches
  const answer = String(payload.last_assistant_message ?? messageText(lines.findLast(entry => entry.type === 'assistant' && messageText(entry).trim()))).trim()
  const briefs = record.exportReview.runs.filter(briefed).map(run => run.brief).join(', ')
  if (!answer) throw new CliError(1, `Subagent ${agent} ended its review of #${record.issue} (${briefs}) without an answer.`, { repair: `Give ${briefs} to a new reviewer subagent.` })
  const runs = record.exportReview.runs.map(run => (briefed(run) ? { ...run, agentId: agent, answer, answeredAt: Date.now() } : run))
  saveWorkflowRecord(root, { ...record, exportReview: { ...record.exportReview, runs } })
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

function changedRecordCheck(root, id, { commit = false } = {}) {
  const saved = id ? readObject(hookSessionFile(root, id), { missing: {} }).recordChecks : undefined
  const check = recordCheck(root, commit && !saved?.ok ? undefined : saved)
  if (check?.fresh) changeSession(root, id, { recordChecks: { key: check.key, ok: check.ok, output: check.output, commands: check.commands } })
  return check
}

function editedFile(root, cwd, call) {
  const path = call.input.file_path ?? call.input.filePath ?? call.input.path
  if (typeof path !== 'string') return undefined
  const absolute = resolve(realpathSync(cwd), path)
  if (!existsSync(dirname(absolute))) return undefined
  const file = relative(realpathSync(root), join(realpathSync(dirname(absolute)), basename(absolute)))
  if (file.startsWith('../') || isAbsolute(file)) return undefined
  return file
}

function firstEditRequirements(root, id, file) {
  if (id && (readObject(hookSessionFile(root, id), { missing: {} }).requirementFiles ?? []).includes(file)) return undefined
  const list = requirementsList(root, [file])
  changeSession(root, id, state => {
    const seen = state.requirementFiles ?? []
    return seen.includes(file) ? null : { requirementFiles: [...seen, file] }
  })
  return list
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

function workflowGitRefusal(root, workflow) {
  const path = join(root, `.neil-dev.issue-${workflow.issue}.json`)
  const prefix = `Issue #${workflow.issue} is in ${workflow.state}. Record: ${path}.`
  const checkpoint = ' Commit or push with ndev flow checkpoint so the checks run.'
  const pr = workflow.pr ?? workflow.prs?.[0]
  if (!pr) return prefix + checkpoint
  if (!workflow.repo) return `${prefix} PR #${pr} state unverified: the record has no repository.${checkpoint}`
  const script = process.env.NDEV_FLOW_GH || join(releaseRoot, 'scripts/github/gh.sh')
  const command = `gh.sh pr-read ${pr} in ${workflow.repo}`
  const result = run('bash', [script, 'pr-read', String(pr)], { cwd: root, env: { ...process.env, GH_REPO: workflow.repo }, timeout: 3_000 })
  if (result.status !== 0) return `${prefix} PR #${pr} state unverified: ${command} exited ${result.status}: ${result.stderr.trim() || result.stdout.trim() || 'no output'}.${checkpoint}`
  let receipt
  try { receipt = JSON.parse(result.stdout) }
  catch (error) { return `${prefix} PR #${pr} state unverified: ${command} returned invalid JSON (${error.message}): ${result.stdout.slice(0, 250)}.${checkpoint}` }
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) return `${prefix} PR #${pr} state unverified: ${command} returned a non-object PR response: ${JSON.stringify(receipt)}.${checkpoint}`
  if (receipt.number !== pr || !['open', 'closed'].includes(receipt.state) || receipt.merged !== undefined && typeof receipt.merged !== 'boolean') return `${prefix} PR #${pr} state unverified: ${command} returned PR #${receipt.number} in state ${JSON.stringify(receipt.state)}, merged=${JSON.stringify(receipt.merged)}.${checkpoint}`
  const state = receipt.merged === true ? 'merged' : receipt.state
  const repair = state === 'merged' || state === 'closed' ? ` Repair: run ndev flow off --pr ${pr} to retain the old record without its guard before starting another issue.` : checkpoint
  return `${prefix} PR #${pr} state ${state}.${repair}`
}

function rawGitReason(command, workspace, workflow, helperCwd, watched) {
  if (!workflow) return undefined
  const label = `Issue #${workflow.issue} is in ${workflow.state}.`
  const owned = [workflow.pr, ...(workflow.prs ?? [])]
  const waits = [...gitCode(command).matchAll(new RegExp(OWN_WAIT.source, 'g'))]
  const ownWait = waits.some(([wait]) => {
    const pr = /^gh\s+pr\s+checks\s+#?(\d+)/.exec(wait)?.[1]
    return !pr || owned.includes(Number(pr))
  })
  if (ownWait && (workflow.state === 'ci' || workflow.doneWaitsFor) && watched) {
    return `${label} ndev watch reads these checks, so this helper would only repeat them. Run ndev wait checks ${workflow.pr ?? workflow.prs?.[0] ?? '<pr>'} for one blocking wait, or ndev flow status for the current result.`
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
    return workflowGitRefusal(workflow.root ?? workspace.root, workflow)
  }
}

function fromAntigravity(payload) {
  const { name, id, args = {} } = payload.toolCall ?? {}
  const tool = { run_command: 'bash', write_file: 'write', write_to_file: 'write', edit_file: 'edit', replace_file_content: 'edit', multi_replace_file_content: 'multiedit' }[name] ?? name
  const edits = args.ReplacementChunks?.map(chunk => ({ old_string: chunk.TargetContent, new_string: chunk.ReplacementContent, replace_all: chunk.AllowMultiple === true }))
  const input = {
    ...args, command: args.CommandLine, file_path: args.Path ?? args.TargetFile, content: args.Content ?? args.CodeContent,
    old_string: args.Target ?? args.TargetContent, new_string: args.Replacement ?? args.ReplacementContent, ...(edits ? { edits } : {}),
  }
  return {
    ...payload, session_id: payload.conversationId, cwd: args.Cwd ?? payload.cwd ?? payload.workspacePaths?.[0], prompt: payload.lastUserInput,
    ...(name ? { tool_name: tool, tool_input: input, tool_use_id: id, tool_response: { isError: Boolean(payload.error), error: payload.error } } : {}),
  }
}

function antigravityAnswer(event, { reason, context, systemMessage }) {
  if (reason) return { decision: 'deny', reason }
  if (event === 'pre-tool-use') return { decision: 'allow' }
  if (event === 'turn-complete') return { decision: '' }
  const steps = [systemMessage, context].filter(Boolean).map(text => ({ systemMessage: { systemMessage: text } }))
  return steps.length ? { injectSteps: steps } : {}
}

function native(event, harness, result = {}) {
  const { reason, context, systemMessage } = result
  if (harness === 'antigravity') return antigravityAnswer(event, result)
  if (reason) {
    if (harness === 'opencode') return { decision: 'deny', reason }
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
  }
  if (!context) return null
  if (harness === 'opencode') return { additionalContext: context }
  const nativeEvent = { 'session-start': 'SessionStart', 'prompt-submit': 'UserPromptSubmit', 'prompt-context': 'UserPromptSubmit', 'pre-tool-use': 'PreToolUse', 'post-tool-use': 'PostToolUse' }[event]
  return nativeEvent
    ? { ...(systemMessage ? { systemMessage } : {}), hookSpecificOutput: { hookEventName: nativeEvent, additionalContext: context } }
    : { systemMessage: context }
}

function workSkill({ root, linked }, config, workflow) {
  const settings = linked ? readObject(join(root, '.neil-dev.worktree.json'), { missing: {} }).settings ?? {} : {}
  const mode = workflow?.mode ?? settings.mode ?? config.mode ?? 'light'
  const steering = workflow?.steering ?? settings.steering ?? config.steering ?? 'interactive'
  return { mode, steering, skill: mode === 'hack' ? 'ndev-work-hack' : `ndev-work-${mode}${steering === 'auto' ? '-auto' : ''}` }
}

function delayedNotice(root, id, prompt, workflow) {
  if (!id || typeof prompt !== 'string' || !prompt.trim()) return undefined
  const { notices = [] } = readObject(watcherState(root, id), { missing: {} })
  const notice = notices.findLast(item => item.message.trim() === prompt.trim())
  if (!notice) return undefined
  if (workflow?.issue === notice.issue && workflow.state === notice.state) return undefined
  const now = workflow?.issue === notice.issue ? `Issue #${workflow.issue} is now in ${workflow.state}` : `Issue #${notice.issue} is no longer the active workflow`
  const request = notice.requestId ? `Orca request ${notice.requestId}` : 'an Orca send that returned no request id'
  return `This prompt is the delayed ndev watch notice of ${request} for issue #${notice.issue} in ${notice.state}. ${now}, so ignore the notice and run ndev flow status.`
}

function compactionNote(root, id, skill) {
  let note
  changeSession(root, id, state => {
    if (!state.compactedAt || state.compactedAt <= (state.skillReloadedAt ?? 0)) return null
    note = `The context was compacted, so the loaded skills are gone. Load ${skill} again before more development work.`
    return { skillReloadedAt: Date.now() }
  })
  return note
}

function resourceNotes(root, config) {
  const file = join(root, '.neil-dev.worktree.json')
  const saved = readObject(file, { missing: {} }).resources ?? {}
  if (!Object.values(saved).some(value => value && Object.keys(value).length)) return []
  const output = checked('bash', [worktreeScript, 'list', '--json', '--worktree', root], { cwd: root, repair: `Fix ${file}, then run bash ${worktreeScript} list --worktree ${root}.` })
  const { docker, 'dev-servers': servers } = JSON.parse(output).resources
  const tail = text => (text ?? '').trim().split('\n').slice(-8).join('\n    ') || '(none)'
  const stacks = docker.filter(stack => !stack.lastStop)
  const failed = docker.filter(stack => stack.lastStop)
  const named = Object.entries(servers)
  const failedServers = named.filter(([, server]) => server.lastStop)
  const listedServers = named.filter(([, server]) => !server.lastStop)
  const notes = []
  if (failed.length) notes.push([
    'Worktree stacks: a stop at an earlier session end failed, so these stacks may still run and hold Docker resources. Run each repair, then the remove-stack command. Tell the person if a repair fails.',
    ...failed.map(({ kind, projectId, workdir, lastStop: stop }) => [
      `- ${kind} stack ${projectId} (workdir ${workdir ?? 'unknown'}) did not stop at ${stop.at ?? 'an earlier session end'}.`,
      `  command: ${stop.command ?? 'unknown'}; exit code ${stop.exitCode ?? 'unknown'}`,
      `  output: ${tail(stop.output)}`,
      `  repair: ${stop.repair ?? stop.command ?? 'unknown'}`,
      `  then: bash ${worktreeScript} remove-stack --kind ${kind} --project-id ${projectId} --worktree ${root}`,
    ].join('\n')),
  ].join('\n'))
  if (failedServers.length) notes.push([
    'Worktree dev servers: a stop at an earlier session end failed, so these servers may still run and hold their ports. Run each repair, then the remove-dev-server command. Tell the person if a repair fails.',
    ...failedServers.map(([name, server]) => [
      `- dev server ${name} (pid ${server.pid}, port ${server.port}, ${server.command} in ${server.cwd}) did not stop at ${server.lastStop.at ?? 'an earlier session end'}.`,
      `  output: ${tail(server.lastStop.output)}`,
      `  repair: ${server.lastStop.repair ?? `lsof -nP -iTCP:${server.port} -sTCP:LISTEN, then stop that process`}`,
      `  then: bash ${worktreeScript} remove-dev-server --name ${name} --worktree ${root}`,
    ].join('\n')),
  ].join('\n'))
  if (stacks.length && config.worktreeStacks?.onSessionEnd !== 'keep-running') {
    notes.push(`Worktree stacks: ${file} still lists ${stacks.map(stack => `${stack.kind} ${stack.projectId}`).join(', ')}, which may run from an earlier session. If this task uses a stack, leave it listed: it is stopped when this session ends. If not, stop them now with bash ${worktreeScript} stop-all --worktree ${root}.`)
  }
  if (listedServers.length) {
    notes.push(`Worktree dev servers: ${file} still lists ${listedServers.map(([name, server]) => `dev server ${name} (pid ${server.pid}, port ${server.port})`).join(', ')}, which may run from an earlier session. If this task uses a server, leave it listed: it is stopped when this session ends. If not, stop the dev servers now with bash ${worktreeScript} stop-all --worktree ${root} --on-end keep-running.`)
  }
  return notes
}

function guidance(workspace, config, workflow) {
  const { mode, steering, skill } = workSkill(workspace, config, workflow)
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

function linkedIssueGuidance(root, repo) {
  if (!repo || !process.env.ORCA_AGENT_SESSION_ID) return {}
  const command = process.env.ORCA_CLI_COMMAND || 'orca'
  const args = ['reference', 'list', '--worktree', `path:${root}`, '--json']
  const result = run(command, args, { cwd: root, timeout: 3_000 })
  const repair = `Run ${command} reference list --worktree path:${root} --json to check the link.`
  if (result.status !== 0) {
    return { systemMessage: `Orca issue lookup for ${root} exited ${result.status}: ${result.stderr.trim() || result.stdout.trim() || 'no output'}. ${repair}` }
  }
  let references
  try {
    const data = JSON.parse(result.stdout)
    if (!data.ok || !Array.isArray(data.result?.references)) throw new Error('expected a reference list')
    references = data.result.references
  } catch (error) {
    return { systemMessage: `Orca issue lookup for ${root}: ${error.message}. ${repair}` }
  }
  const prefix = `https://github.com/${repo.toLowerCase()}/issues/`
  const issues = references.flatMap(reference => {
    const url = typeof reference?.url === 'string' ? reference.url.toLowerCase() : ''
    const number = url.startsWith(prefix) ? url.slice(prefix.length) : ''
    return reference?.provider === 'github' && reference.type === 'issue' && /^[1-9]\d*$/.test(number)
      ? [{ number, selected: reference.selected === true }]
      : []
  })
  const selected = issues.filter(issue => issue.selected)
  const numbers = [...new Set((selected.length ? selected : issues).map(issue => issue.number))]
  return numbers.length === 1
    ? { context: `Before development work, run ndev flow start ${numbers[0]}. Follow the next step it returns.` }
    : {}
}

function workflowStartup(root, config, workflow, source) {
  if (source && source !== 'startup') return {}
  if (config.workflow === false) {
    return { systemMessage: `Workflow is disabled in ${root}/.neil-dev.json. To enable it, run ndev flow on --project.` }
  }
  if (workflow) {
    return { context: `Before development work, run ndev flow start ${workflow.issue}. Follow the next step it returns.` }
  }
  const linked = linkedIssueGuidance(root, config.github?.repo)
  return { ...linked, context: linked.context ?? 'Ask which issue to work on when the human starts development work.' }
}

function sessionStart(root, id, harness) {
  changeSession(root, id, { startedAt: Date.now(), activityAt: Date.now(), endedAt: null, ...(harness ? { harness } : {}) })
  const home = process.env.HOME
  if (home && !existsSync(join(home, 'dev-wiki/wiki.md'))) {
    const wiki = join(home, 'dev-wiki')
    if (!existsSync(wiki)) checked('bash', [join(releaseRoot, 'scripts/wiki/init.sh'), wiki], { cwd: root })
    else return `${wiki} exists without wiki.md. Move it aside or restore wiki.md, then start a new session.`
  }
}

function buildNote(root) {
  if (existsSync(join(root, 'scripts/init-project.sh')) && !existsSync(join(root, '.ndev-inited'))) {
    return 'This worktree needs its project build. Run ndev project init.'
  }
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
  if (harness === 'antigravity') payload = fromAntigravity(payload)
  const followingCall = harness === 'antigravity' && event === 'prompt-submit' && payload.invocationNum > 0
  if (event === 'prompt-submit' && !followingCall) {
    const native = blockedNativePrompt(harness, payload)
    if (native) return { event, native }
  }
  const cwd = payload.cwd ?? payload.directory ?? process.cwd()
  const id = harnessSession(process.env, payload)
  recordInnerSession(process.env, payload)
  const call = toolCall(payload)
  if (event === 'pre-tool-use' || event === 'post-tool-use') {
    const { walkPreTool, walkPostTool } = await import('./walk-doc.mjs')
    const walkCall = { ...call, session: id, terminal: process.env.ORCA_TERMINAL_HANDLE, pane: process.env.ORCA_PANE_KEY }
    if (event === 'pre-tool-use') {
      const reason = await walkPreTool(cwd, walkCall)
      if (reason) return { event, native: native(event, harness, { reason }), reason }
    } else {
      await walkPostTool(cwd, { ...walkCall, output: payload.tool_response ?? payload.output, succeeded: successful(payload) })
    }
  }
  const workspace = findWorkspace(cwd)
  if (!workspace) return { native: native(event, harness), event, outsideWorktree: true }
  const { root } = workspace
  if (followingCall) {
    const context = takeHeldNotes(root, id)
    return { event, native: native(event, harness, { context }), context }
  }
  if (event === 'session-start' && workspace.linked) {
    checked('bash', [worktreeScript, 'init', '--worktree', root, '--session-start'], { cwd: root })
    try {
      await ensureProjectFiles(root)
    } catch (error) {
      throw new CliError(1, error.message, { repair: 'Check the named file and start a new session.' })
    }
  }
  const config = readProject(root)
  const scoped = workflowRootFor(root, id)
  const { activeEpic } = await import('./epic.mjs')
  const epic = id ? activeEpic(root, id) : undefined
  const workflow = config.workflow === false || epic ? undefined : currentWorkflow(scoped, [id, payload.session_id])
  const prompt = payload.prompt ?? payload.text ?? ''
  const notes = []
  let reason
  let systemMessage
  if (event === 'pre-tool-use' && call.shell) {
    const helperCwd = payload.agent_id || payload.agentId ? cwd : undefined
    reason = rawGitReason(call.command, workspace, workflow, helperCwd, watcherRunning(root, id))
    reason ??= rawCreateReason(root, call.command)
    if (!reason && savesCommit(call.command)) {
      const check = changedRecordCheck(root, id, { commit: true })
      if (check && !check.ok) reason = recordCommitReason(check)
      if (!reason && hasRecords(root)) {
        const list = requirementsList(root, commitFiles(root, cwd, call.command), 'the files of this commit')
        if (list) notes.push(list)
      }
    }
  }
  if (event === 'pre-tool-use' && call.edit && hasRecords(root)) {
    const file = editedFile(root, cwd, call)
    if (file) reason ??= fixedEditReason(root, file, call.tool, call.input)
    const note = file && !reason ? firstEditRequirements(root, id, file) : undefined
    if (note) notes.push(note)
  }
  if (event === 'post-tool-use' && (call.shell || call.edit) && successful(payload) && hasRecords(root)) {
    const check = changedRecordCheck(root, id)
    if (check?.fresh && !check.ok) notes.push(recordProblemNote(check))
  }
  if (event === 'session-start') {
    const note = sessionStart(root, id, harness)
    if (note) notes.push(note)
    if (!epic) {
      const startup = workflowStartup(root, config, workflow, payload.source)
      if (startup.context) notes.push(startup.context)
      systemMessage = startup.systemMessage
    }
    if (id && process.env.ORCA_TERMINAL_HANDLE) {
      const { ensureWatcher } = await import('./watch.mjs')
      ensureWatcher(root, id, process.env.ORCA_TERMINAL_HANDLE)
    }
  }
  if (event === 'prompt-submit' || event === 'turn-start') {
    changeSession(root, id, { activityAt: Date.now(), running: true, turn: payload.turn_id })
    const delayed = delayedNotice(root, id, prompt, workflow)
    if (delayed) notes.push(delayed)
  }
  if (event === 'turn-complete') {
    recoverDeadWaits(scoped)
    const file = id ? readObject(hookSessionFile(root, id), { missing: {} }) : {}
    if (!payload.agent_id && (!file.turn || !payload.turn_id || file.turn === payload.turn_id)) {
      changeSession(root, id, { running: false, activityAt: Date.now(), turnEndedAt: Date.now() })
    }
    const agent = payload.agent_id ?? payload.agentId
    if (agent) keepReviewAnswer(scoped, agent, payload)
    else if (!rootWatched(root)) {
      const { tickQueues } = await import('./watch.mjs')
      await tickQueues(root, id, process.env.ORCA_TERMINAL_HANDLE)
    }
  }
  if (event === 'compact' && !payload.agent_id && !payload.agentId) changeSession(root, id, { compactedAt: Date.now() })
  if (event === 'session-end') {
    if (harness === 'claude' && ['clear', 'resume'].includes(payload.reason)) return { event, native: null, keptSession: true }
    changeSession(root, id, { endedAt: Date.now(), running: false })
    let walkFailure
    if (id) {
      const { finishWalkOnSessionEnd } = await import('./walk-doc.mjs')
      try {
        const walk = await finishWalkOnSessionEnd(root, { session: id, terminal: process.env.ORCA_TERMINAL_HANDLE })
        if (walk?.text) notes.push(walk.text)
      } catch (error) {
        walkFailure = error
      }
    }
    recoverDeadWaits(scoped)
    releaseSession(scoped, [id, payload.session_id])
    if (workspace.linked) {
      const record = readObject(join(root, '.neil-dev.worktree.json'), { missing: {} })
      if (Object.values(record.resources ?? {}).some(value => Object.keys(value).length)) {
        checked('bash', [worktreeScript, 'stop-all', '--worktree', root, '--on-end', config.worktreeStacks?.onSessionEnd ?? 'stop-and-delete'], { cwd: root, timeout: 120_000 })
      }
    }
    if (walkFailure) throw walkFailure
  }
  if (event === 'prompt-submit' && typeof prompt === 'string' && correction.test(prompt)) {
    notes.push('Apply the correction. Record reusable lessons with ndev-dev-wiki or project facts with ndev-remember.')
  }
  if (['session-start', 'prompt-submit', 'prompt-context'].includes(event)) {
    const build = buildNote(root)
    if (build) notes.push(build)
    const reload = compactionNote(root, id, workSkill(workspace, config, workflow).skill)
    if (reload) notes.push(reload)
    notes.push(...resourceNotes(root, config))
    notes.push(guidance(workspace, epic ? { ...config, workflow: false } : config, workflow))
    if (epic) notes.push(`Epic #${epic.epic} is in ${epic.state}. Run ndev epic status ${epic.epic} for the coordinator's next action.`)
  }
  if (!reason && ['pre-tool-use', 'post-tool-use'].includes(event)) notes.push(...qualityNotes(root, config, workflow, call, payload, event))
  if (event === 'post-tool-use' && call.edit && successful(payload)) notes.push(...componentNotes(root, cwd, id, call, workflow))
  if (!reason && call.shell && !workflow && ['pre-tool-use', 'post-tool-use'].includes(event)) {
    const note = pushMarker(root, id, payload.tool_use_id ?? payload.call_id, event, call, payload)
    if (note) notes.push(note)
  }
  if (harness === 'antigravity' && ['pre-tool-use', 'post-tool-use'].includes(event)) {
    holdNotes(root, id, notes)
    return { event, native: native(event, harness, { reason }), reason }
  }
  if (harness === 'antigravity' && ['session-start', 'prompt-submit'].includes(event)) notes.unshift(...[takeHeldNotes(root, id)].filter(Boolean))
  const context = notes.join('\n') || undefined
  return { event, native: native(event, harness, { reason, context, systemMessage }), reason, context }
}

function holdNotes(root, id, notes) {
  if (!notes.length) return
  if (!id) throw new CliError(1, `An Antigravity tool hook in ${root} has notes but no conversationId to hold them for the next model call: ${notes.join(' ')}`, { repair: 'Check that Antigravity sends conversationId in its hook payload.' })
  changeSession(root, id, state => ({ heldNotes: [...(state.heldNotes ?? []), ...notes] }))
}

function takeHeldNotes(root, id) {
  let held = []
  changeSession(root, id, state => {
    held = state.heldNotes ?? []
    return held.length ? { heldNotes: [] } : null
  })
  return held.join('\n') || undefined
}
