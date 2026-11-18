export type QualityConfig = {
  editedFileGuards?: { venv?: string }
  precheckReminder?: { command?: string }
  subscriptionWarning?: { gateVar?: string }
  worktreeSubmodules?: { paths?: string[] }
}

const SCHEMA = {
  editedFileGuards: { venv: ['string', 'EDITED_FILE_GUARDS_VENV'] },
  precheckReminder: { command: ['string', 'PRECHECK_COMMAND'] },
  subscriptionWarning: { gateVar: ['string', 'SUBSCRIPTION_GATE_VAR'] },
  worktreeSubmodules: { paths: ['string[]', 'WORKTREE_SUBMODULES'] },
} as const

export type HookName = keyof typeof SCHEMA

export const SCRIPT: Record<HookName, string> = {
  editedFileGuards: 'edited-file-guards.sh',
  precheckReminder: 'precheck-reminder.sh',
  subscriptionWarning: 'warn-subscription-cli.sh',
  worktreeSubmodules: 'init-worktree-submodules.sh',
}

export const TIMEOUT_MS: Record<HookName, number> = {
  editedFileGuards: 60_000,
  precheckReminder: 10_000,
  subscriptionWarning: 10_000,
  worktreeSubmodules: 120_000,
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

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

export const envFor = (hook: HookName, settings: Record<string, unknown>, root: string) => {
  const env: Record<string, string> = { CLAUDE_PROJECT_DIR: root }
  const allowed = SCHEMA[hook] as Record<string, readonly [string, string]>
  for (const [name, [, variable]] of Object.entries(allowed)) {
    const value = settings[name]
    if (typeof value === 'string') env[variable] = value
    if (Array.isArray(value)) env[variable] = value.join(' ')
  }
  return env
}
