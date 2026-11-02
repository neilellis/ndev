import type { EngineInterface } from 'claude-code'

import type { Mode, Steering } from '../types'

// All per-project settings of the plugin live in one checked-in file at the project root.
export const CONFIG_FILE = '.neil-dev.json'

export type NeilDevConfig = {
  mode?: Mode
  steering?: Steering
  quality?: Record<string, unknown>
  branding?: Branding
  github?: GitHub
  worktreeStacks?: WorktreeStacks
  services?: Services
}

// The project's web consoles, by name ("supabase", "vercel"), that /ndev:view shows as links.
export type Services = Record<string, { url: string }>

// What the session-end hook does with the docker stacks a worktree lists in .neil-dev.worktree.json
// (resources.docker). stop-and-delete (the default) stops each stack and deletes its data;
// stop-keep-data stops it and keeps its data volumes; keep-running leaves it running. The dev servers
// (resources.dev-servers) stop at every session end, whatever this says.
export const STACK_POLICIES = ['stop-and-delete', 'stop-keep-data', 'keep-running'] as const
export type StackPolicy = (typeof STACK_POLICIES)[number]
export type WorktreeStacks = { onSessionEnd?: StackPolicy }

// The project's GitHub repository and Projects v2 board, asked once by the set-up dialog so no
// skill or script looks them up again. null means "none", which the dialog does not ask again.
export type GitHub = { repo: string | null; board?: Board | null }
export type Board = { owner: string; number: number }

// The brand that docs, diagram and video skills apply. Absent: the skills use no branding at all.
// `path` is the brand site's source folder, relative to the project root, that /brand check reads.
export type Branding = { site: string; name?: string; guide?: string; path?: string }

export type LoadedConfig = {
  root: string
  path: string
  exists: boolean
  config: NeilDevConfig
  error?: string
}

const KEYS = ['mode', 'steering', 'quality', 'branding', 'github', 'worktreeStacks', 'services'] as const
export const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const MODES: readonly string[] = ['light', 'heavy']
const STEERINGS: readonly string[] = ['interactive', 'auto']

// The project root is the git top level of the session's folder; outside a repository, the folder itself.
export async function projectRoot($: EngineInterface, cwd: string) {
  const ran = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 10000 })
  return ran.exitCode === 0 && ran.stdout.trim() !== '' ? ran.stdout.trim() : cwd
}

const validate = (raw: unknown): string | undefined => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'the file must hold a JSON object'
  const value = raw as Record<string, unknown>
  const unknown = Object.keys(value).filter(k => !(KEYS as readonly string[]).includes(k))
  if (unknown.length > 0) return `unknown key ${unknown.map(k => `"${k}"`).join(', ')}; the keys are ${KEYS.join(', ')}`
  if (value.mode !== undefined && !MODES.includes(value.mode as string)) return `"mode" is ${JSON.stringify(value.mode)}; use "light" or "heavy"`
  if (value.steering !== undefined && !STEERINGS.includes(value.steering as string)) return `"steering" is ${JSON.stringify(value.steering)}; use "interactive" or "auto"`
  if (value.quality !== undefined && (typeof value.quality !== 'object' || value.quality === null || Array.isArray(value.quality))) return '"quality" must be an object'
  if (value.branding !== undefined) {
    const b = value.branding as Record<string, unknown>
    if (typeof b !== 'object' || b === null || Array.isArray(b)) return '"branding" must be an object such as { "site": "https://example.com" }'
    const extra = Object.keys(b).filter(k => !['site', 'name', 'guide', 'path'].includes(k))
    if (extra.length > 0) return `unknown "branding" key ${extra.map(k => `"${k}"`).join(', ')}; the keys are site, name, guide, path`
    if (typeof b.site !== 'string' || b.site.trim() === '') return '"branding.site" must be a non-empty string (the brand\'s website URL)'
    for (const k of ['name', 'guide', 'path'] as const) if (b[k] !== undefined && typeof b[k] !== 'string') return `"branding.${k}" must be a string`
    if (typeof b.path === 'string' && (b.path.trim() === '' || b.path.startsWith('/'))) return `"branding.path" must be a folder relative to the project root, such as "apps/brand" or "../acme-brand"; got "${b.path}"`
  }
  if (value.github !== undefined) {
    const g = value.github as Record<string, unknown>
    if (typeof g !== 'object' || g === null || Array.isArray(g)) return '"github" must be an object such as { "repo": "owner/name", "board": { "owner": "owner", "number": 1 } }'
    const extra = Object.keys(g).filter(k => !['repo', 'board'].includes(k))
    if (extra.length > 0) return `unknown "github" key ${extra.map(k => `"${k}"`).join(', ')}; the keys are repo, board`
    if (g.repo !== null && (typeof g.repo !== 'string' || !REPO.test(g.repo))) return `"github.repo" is ${JSON.stringify(g.repo)}; use "owner/name", or null for no GitHub repository`
    if (g.board !== undefined && g.board !== null) {
      const b = g.board as Record<string, unknown>
      if (typeof b !== 'object' || Array.isArray(b) || typeof b.owner !== 'string' || b.owner === '' || !Number.isInteger(b.number) || (b.number as number) < 1 || Object.keys(b).some(k => k !== 'owner' && k !== 'number'))
        return `"github.board" is ${JSON.stringify(g.board)}; use { "owner": "<org or user>", "number": <n> }, or null for no board`
    }
  }
  if (value.worktreeStacks !== undefined) {
    const w = value.worktreeStacks as Record<string, unknown>
    const choices = `${STACK_POLICIES.slice(0, -1).join(', ')} or ${STACK_POLICIES.at(-1)}`
    if (typeof w !== 'object' || w === null || Array.isArray(w)) return `"worktreeStacks" must be an object such as { "onSessionEnd": "stop-and-delete" }`
    const extra = Object.keys(w).filter(k => k !== 'onSessionEnd')
    if (extra.length > 0) return `unknown "worktreeStacks" key ${extra.map(k => `"${k}"`).join(', ')}; the key is onSessionEnd`
    if (w.onSessionEnd !== undefined && !(STACK_POLICIES as readonly unknown[]).includes(w.onSessionEnd)) return `"worktreeStacks.onSessionEnd" is ${JSON.stringify(w.onSessionEnd)}; use ${choices}`
  }
  if (value.services !== undefined) {
    const s = value.services as Record<string, unknown>
    const shape = '"services" must be an object such as { "supabase": { "url": "https://supabase.com/dashboard/project/<ref>" } }'
    if (typeof s !== 'object' || s === null || Array.isArray(s)) return shape
    for (const [name, entry] of Object.entries(s)) {
      const e = entry as Record<string, unknown>
      if (typeof e !== 'object' || e === null || Array.isArray(e) || Object.keys(e).some(k => k !== 'url')) return `"services.${name}" must be { "url": "https://..." }; the only key is url`
      if (typeof e.url !== 'string' || !/^https?:\/\/\S+$/.test(e.url)) return `"services.${name}.url" is ${JSON.stringify(e.url)}; use an http or https URL`
    }
  }
  return undefined
}

// The GitHub values the set-up dialog still has to ask for; empty when none.
export const missingGitHub = (config: NeilDevConfig): ('repo' | 'board')[] => {
  const g = config.github
  if (g === undefined) return ['repo', 'board']
  return g.repo !== null && g.board === undefined ? ['board'] : []
}

// Reads and checks .neil-dev.json. A missing file is an empty config; a bad file sets `error`
// and an empty config, so the caller shows the error and runs nothing that the file would enable.
export async function loadConfig($: EngineInterface, cwd: string): Promise<LoadedConfig> {
  return loadConfigAt($, await projectRoot($, cwd))
}

// The same, for a project root that is already known.
export async function loadConfigAt($: EngineInterface, root: string): Promise<LoadedConfig> {
  const path = `${root}/${CONFIG_FILE}`
  if (!(await $.fs.exists(path))) return { root, path, exists: false, config: {} }
  let raw: unknown
  try {
    raw = JSON.parse(await $.fs.read(path))
  } catch (error) {
    return { root, path, exists: true, config: {}, error: `not valid JSON: ${String(error).slice(0, 160)}` }
  }
  const error = validate(raw)
  return error ? { root, path, exists: true, config: {}, error } : { root, path, exists: true, config: raw as NeilDevConfig }
}

// Writes one key back to the file and keeps every other key as it was.
export async function saveSetting(
  $: EngineInterface,
  loaded: LoadedConfig,
  key: 'mode' | 'steering' | 'github',
  value: unknown,
) {
  const current = loaded.exists && !loaded.error ? (JSON.parse(await $.fs.read(loaded.path)) as Record<string, unknown>) : {}
  await $.fs.write(loaded.path, `${JSON.stringify({ ...current, [key]: value }, null, 2)}\n`)
}
