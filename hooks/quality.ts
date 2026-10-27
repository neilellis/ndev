// Quality-control hooks: run the tested scripts in kb/hooks/ from tool calls,
// switched on per project by the "quality" key of <project root>/.neil-dev.json.
//
// No file, or a hook not listed: that hook does not run (opt in).
// A bad file (invalid JSON, an unknown key, a wrong type): one toast that names
// the file and the problem, and no quality hook runs until it is fixed.
// register.ts reads the file once at session start (getProject); restart the
// session to pick up an edit to it.
import type { EngineInterface, On } from 'claude-code'

import type { LoadedConfig } from './config'

const PLUGIN = 'neil-development'

export type QualityConfig = {
  editedFileGuards?: { venv?: string }
  precheckReminder?: { command?: string }
  subscriptionWarning?: { gateVar?: string }
  worktreeSubmodules?: { paths?: string[] }
}

// Each hook: its allowed settings (name -> kind) and the script's env variable for each.
const SCHEMA = {
  editedFileGuards: { venv: ['string', 'EDITED_FILE_GUARDS_VENV'] },
  precheckReminder: { command: ['string', 'PRECHECK_COMMAND'] },
  subscriptionWarning: { gateVar: ['string', 'SUBSCRIPTION_GATE_VAR'] },
  worktreeSubmodules: { paths: ['string[]', 'WORKTREE_SUBMODULES'] },
} as const

type HookName = keyof typeof SCHEMA

const SCRIPT: Record<HookName, string> = {
  editedFileGuards: 'edited-file-guards.sh',
  precheckReminder: 'precheck-reminder.sh',
  subscriptionWarning: 'warn-subscription-cli.sh',
  worktreeSubmodules: 'init-worktree-submodules.sh',
}

const TIMEOUT_MS: Record<HookName, number> = {
  editedFileGuards: 60_000,
  precheckReminder: 10_000,
  subscriptionWarning: 10_000,
  worktreeSubmodules: 120_000,
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// The first problem in the "quality" value, or undefined when it is valid. Never fills in a guess.
export const validateQuality = (quality: unknown): string | undefined => {
  if (quality === undefined) return undefined
  if (!isObject(quality)) return '"quality" must be an object'
  const hooks = Object.keys(SCHEMA)
  for (const [hook, settings] of Object.entries(quality)) {
    if (!(hook in SCHEMA)) return `unknown hook "quality.${hook}" (known: ${hooks.join(', ')})`
    if (!isObject(settings)) return `"quality.${hook}" must be an object ({} for the defaults)`
    const allowed = SCHEMA[hook as HookName] as Record<string, readonly [string, string]>
    for (const [name, value] of Object.entries(settings)) {
      const spec = allowed[name]
      if (spec === undefined) {
        return `unknown setting "quality.${hook}.${name}" (known: ${Object.keys(allowed).join(', ')})`
      }
      const ok =
        spec[0] === 'string'
          ? typeof value === 'string' && value !== ''
          : Array.isArray(value) && value.length > 0 && value.every(p => typeof p === 'string' && p !== '' && !/\s/.test(p))
      if (!ok) {
        return `"quality.${hook}.${name}" must be ${spec[0] === 'string' ? 'a non-empty string' : 'a non-empty array of paths without spaces'}`
      }
    }
  }
  return undefined
}

const envFor = (hook: HookName, settings: Record<string, unknown>, root: string) => {
  const env: Record<string, string> = { CLAUDE_PROJECT_DIR: root }
  const allowed = SCHEMA[hook] as Record<string, readonly [string, string]>
  for (const [name, [, variable]] of Object.entries(allowed)) {
    const value = settings[name]
    if (typeof value === 'string') env[variable] = value
    if (Array.isArray(value)) env[variable] = value.join(' ')
  }
  return env
}

type Ran =
  | { kind: 'ok'; stdout: string; stderr: string }
  | { kind: 'findings'; stderr: string }
  | { kind: 'failed'; message: string }

const head = (text: string, n = 600) => {
  const t = text.trim()
  return t.length > n ? `${t.slice(0, n)}…` : t || '(no stderr)'
}

type State = {
  getProject: () => LoadedConfig | undefined
  // The checked "quality" value of the project loaded last; a bad one is toasted once.
  checked?: { project: LoadedConfig; quality?: QualityConfig }
}

// The project's quality config, or undefined when no quality hook may run.
const load = ($: EngineInterface, state: State): { quality: QualityConfig; root: string } | undefined => {
  const project = state.getProject()
  // No project yet, or a file-level error (register.ts toasts that one): nothing runs.
  if (project === undefined || project.error !== undefined) return undefined
  if (state.checked?.project !== project) {
    const problem = validateQuality(project.config.quality)
    state.checked = { project, quality: problem ? undefined : ((project.config.quality ?? {}) as QualityConfig) }
    if (problem) {
      $.ui.toast(`${PLUGIN}: ${project.path}: ${problem}. No quality hooks run until it is fixed.`, { timeoutMs: 10_000 })
    }
  }
  const quality = state.checked.quality
  return quality === undefined ? undefined : { quality, root: project.root }
}

// Runs one kb/hooks script with a Claude-Code-hook payload on stdin and its settings as env.
const run = async ($: EngineInterface, hook: HookName, root: string, settings: Record<string, unknown>, payload: unknown): Promise<Ran> => {
  const script = `${$.plugin.root}/kb/hooks/${SCRIPT[hook]}`
  try {
    const ran = await $.process.run(['bash', script], {
      cwd: root,
      env: envFor(hook, settings, root),
      stdin: JSON.stringify(payload),
      timeoutMs: TIMEOUT_MS[hook],
    })
    if (ran.exitCode === 0) return { kind: 'ok', stdout: ran.stdout, stderr: ran.stderr }
    if (ran.exitCode === 2 && hook === 'editedFileGuards') return { kind: 'findings', stderr: ran.stderr }
    return { kind: 'failed', message: `${PLUGIN}: ${SCRIPT[hook]} could not run (exit ${ran.exitCode}): ${head(ran.stderr)}` }
  } catch (error) {
    return { kind: 'failed', message: `${PLUGIN}: ${SCRIPT[hook]} could not run (${head(String(error))}; timeout ${TIMEOUT_MS[hook]} ms)` }
  }
}

// Turns a script's run into notes for the model; a failure is also toasted.
const notes = ($: EngineInterface, ran: Ran, ok: (out: { stdout: string; stderr: string }) => string | undefined) => {
  if (ran.kind === 'failed') {
    $.ui.toast(ran.message, { timeoutMs: 10_000 })
    return [`${ran.message}\nThis quality hook did not check the call.`]
  }
  if (ran.kind === 'findings') return [ran.stderr.trim()]
  const text = ok(ran)
  return text ? [text] : []
}

// A background run (best effort): what it reports, or why it could not run, is toasted.
const runInBackground = async ($: EngineInterface, hook: HookName, root: string, settings: Record<string, unknown>, payload: unknown) => {
  const result = await run($, hook, root, settings, payload)
  const text = result.kind === 'failed' ? result.message : result.kind === 'ok' ? result.stderr.trim() : ''
  if (text) $.ui.toast(text, { timeoutMs: 15_000 })
}

// The text a PreToolUse script hands the model: its additionalContext, else its output.
const preToolText = ({ stdout, stderr }: { stdout: string; stderr: string }) => {
  const parts: string[] = []
  if (stdout.trim()) {
    try {
      const out = JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: unknown } }
      const text = out.hookSpecificOutput?.additionalContext
      parts.push(typeof text === 'string' ? text : stdout.trim())
    } catch {
      parts.push(stdout.trim())
    }
  }
  if (stderr.trim()) parts.push(stderr.trim())
  return parts.join('\n') || undefined
}

const stderrText = ({ stderr }: { stderr: string }) => stderr.trim() || undefined

const withContext = <R extends { deny?: unknown; context?: readonly string[] }>(ran: R, extra: string[]): R =>
  extra.length === 0 || ran.deny !== undefined ? ran : { ...ran, context: [...(ran.context ?? []), ...extra] }

export const quality = (on: On, getProject: () => LoadedConfig | undefined) => {
  const state: State = { getProject }

  // edited-file-guards: after Edit or Write; exit 2 sends the findings to the model.
  for (const tool of ['Edit', 'Write'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      const ran = await next(e)
      if (ran.deny !== undefined || ran.isError === true) return ran
      const loaded = load($, state)
      const settings = loaded?.quality.editedFileGuards
      if (loaded === undefined || settings === undefined) return ran
      const filePath = (e as { file_path?: unknown }).file_path
      const result = await run($, 'editedFileGuards', loaded.root, settings, {
        hook_event_name: 'PostToolUse',
        tool_name: tool,
        tool_input: { file_path: filePath },
        cwd: loaded.root,
      })
      return withContext(ran, notes($, result, stderrText))
    }).catch(($, e, next) => next(e))
  }

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String((e as { command?: unknown }).command ?? '')
    const loaded = load($, state)
    if (loaded === undefined) return next(e)
    const { quality: config, root } = loaded
    const cwd = await $.session.cwd()
    const extra: string[] = []

    // subscription warning: before the call (PreToolUse); never denies.
    const gate = config.subscriptionWarning
    if (gate !== undefined && (command.includes('claude') || command.includes(gate.gateVar ?? 'ALLOW_CLAUDE_CLI'))) {
      const result = await run($, 'subscriptionWarning', root, gate, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
        cwd,
      })
      extra.push(
        ...notes($, result, preToolText),
      )
    }

    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const post = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: ran.result ?? null,
      cwd,
    }

    // precheck reminder: after a command that may have run `git commit`; the script decides.
    const precheck = config.precheckReminder
    if (precheck !== undefined && ran.isError !== true && /\bgit\b/.test(command) && command.includes('commit')) {
      const result = await run($, 'precheckReminder', root, precheck, post)
      extra.push(...notes($, result, stderrText))
    }

    // worktree submodules: after `git worktree add`, in the background (best effort, as the
    // script's async wiring was); what it reports is toasted.
    const submodules = config.worktreeSubmodules
    if (submodules !== undefined && command.includes('git worktree add')) {
      void runInBackground($, 'worktreeSubmodules', root, submodules, post)
    }

    return withContext(ran, extra)
  }).catch(($, e, next) => next(e))
}
