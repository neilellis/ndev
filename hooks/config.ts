import type { EngineInterface } from 'claude-code'

import type { Mode, Steering } from '../types'
import { chooseConfig, CONFIG_FILE, LEGACY_CONFIG_FILE } from './workflow/config-file.ts'
import { devServersError, proofError, type DevServers, type Proof } from './workflow/proof-config.ts'
import { SECRET_NAME } from './workflow/secrets.ts'

export { CONFIG_FILE, LEGACY_CONFIG_FILE }

export type NeilDevConfig = {
  mode?: Mode
  steering?: Steering
  quality?: Record<string, unknown>
  branding?: Branding
  github?: GitHub
  worktreeStacks?: WorktreeStacks
  services?: Services
  projectLevel?: ProjectLevel
  workflow?: boolean
  checkEnv?: string[]
  chatGuard?: boolean
  remote?: Remote
  devServers?: DevServers
  proof?: Proof
}

// remote.hcloudContext: the hcloud context (the Hetzner project) of the box that /dev remote resize changes. It is
// named here or with --context; the active context is never used.
export type Remote = { hcloudContext?: string }

// checkEnv: the names of the .neil-dev.env keys that the check scripts get, such as the URL of a local test
// database. Absent: they get none. The file also holds credentials for hosted services, and a test that finds
// such a key, as fcc-proto's do with FALKORDB_URL, runs against the hosted service and not a local one.

// How much risk the workflow tools take. straw_man: the agent may commit to main and merge PRs.
// poc: the agent may merge PRs. small_project and formal_project: a human merges, and
// formal_project also refuses a skipped review. Absent: a human merges, as in small_project.
export const PROJECT_LEVELS = ['straw_man', 'poc', 'small_project', 'formal_project'] as const
export type ProjectLevel = (typeof PROJECT_LEVELS)[number]

// The project's web consoles, by name ("supabase", "vercel"), that /view shows as links.
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
  legacy?: string
}

const KEYS = ['mode', 'steering', 'quality', 'branding', 'github', 'worktreeStacks', 'services', 'projectLevel', 'workflow', 'checkEnv', 'chatGuard', 'remote', 'devServers', 'proof'] as const
export const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const MODES: readonly string[] = ['light', 'heavy', 'hack']
const STEERINGS: readonly string[] = ['interactive', 'auto']

// The project root is the git top level of the session's folder; outside a repository, the folder itself.
export async function projectRoot($: EngineInterface, cwd: string) {
  const ran = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 10000 })
  return ran.exitCode === 0 && ran.stdout.trim() !== '' ? ran.stdout.trim() : cwd
}

export const validate = (raw: unknown): string | undefined => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'the file must hold a JSON object'
  const value = raw as Record<string, unknown>
  const unknown = Object.keys(value).filter(k => !(KEYS as readonly string[]).includes(k))
  if (unknown.length > 0) return `unknown key ${unknown.map(k => `"${k}"`).join(', ')}; the keys are ${KEYS.join(', ')}`
  if (value.mode !== undefined && !MODES.includes(value.mode as string)) return `"mode" is ${JSON.stringify(value.mode)}; use "light", "heavy" or "hack"`
  if (value.steering !== undefined && !STEERINGS.includes(value.steering as string)) return `"steering" is ${JSON.stringify(value.steering)}; use "interactive" or "auto"`
  // A human steers each step of a hack, so hack mode is interactive only.
  if (value.mode === 'hack' && value.steering === 'auto') return '"mode" is "hack" and "steering" is "auto", but hack mode is interactive only; set "steering" to "interactive" or "mode" to "light"'

  if (value.projectLevel !== undefined && !(PROJECT_LEVELS as readonly unknown[]).includes(value.projectLevel)) return `"projectLevel" is ${JSON.stringify(value.projectLevel)}; use ${PROJECT_LEVELS.map(l => `"${l}"`).join(', ')}`
  if (value.workflow !== undefined && typeof value.workflow !== 'boolean') return `"workflow" is ${JSON.stringify(value.workflow)}; use true or false`
  if (value.chatGuard !== undefined && typeof value.chatGuard !== 'boolean') return `"chatGuard" is ${JSON.stringify(value.chatGuard)}; use true or false`
  if (value.checkEnv !== undefined && (!Array.isArray(value.checkEnv) || value.checkEnv.some(k => typeof k !== 'string' || !SECRET_NAME.test(k)))) return `"checkEnv" is ${JSON.stringify(value.checkEnv)}; use a list of key names, such as ["TEST_DATABASE_URL"]`
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
  if (value.remote !== undefined) {
    const r = value.remote as Record<string, unknown>
    if (typeof r !== 'object' || r === null || Array.isArray(r)) return '"remote" must be an object such as { "hcloudContext": "<hcloud context>" }'
    const extra = Object.keys(r).filter(k => k !== 'hcloudContext')
    if (extra.length > 0) return `unknown "remote" key ${extra.map(k => `"${k}"`).join(', ')}; the key is hcloudContext`
    if (r.hcloudContext !== undefined && (typeof r.hcloudContext !== 'string' || r.hcloudContext.trim() === '')) return `"remote.hcloudContext" must be a non-empty string (the name of an hcloud context, as hcloud context list shows it); got ${JSON.stringify(r.hcloudContext)}`
  }
  if (value.devServers !== undefined) {
    const error = devServersError(value.devServers)
    if (error) return error
  }
  if (value.proof !== undefined) {
    const error = proofError(value.proof)
    if (error) return error
  }
  return undefined
}

// The GitHub values the set-up dialog still has to ask for; empty when none.
export const missingGitHub = (config: NeilDevConfig): ('repo' | 'board')[] => {
  const g = config.github
  if (g === undefined) return ['repo', 'board']
  return g.repo !== null && g.board === undefined ? ['board'] : []
}

// Reads and checks the project config: .ndev.json, else the legacy name. A missing file is an empty
// config; a bad file, or two files that differ, sets `error` and an empty config, so the caller shows the
// error and runs nothing that the file would enable.
export async function loadConfig($: EngineInterface, cwd: string): Promise<LoadedConfig> {
  return loadConfigAt($, await projectRoot($, cwd))
}

async function textAt($: EngineInterface, path: string) {
  return (await $.fs.exists(path)) ? await $.fs.read(path) : undefined
}

export async function loadConfigAt($: EngineInterface, root: string): Promise<LoadedConfig> {
  const choice = chooseConfig(root, await textAt($, `${root}/${CONFIG_FILE}`), await textAt($, `${root}/${LEGACY_CONFIG_FILE}`))
  if (choice.conflict) return { root, path: `${root}/${CONFIG_FILE}`, exists: true, config: {}, error: `${choice.conflict.message}. Repair: ${choice.conflict.repair}` }
  const { path, text, legacy } = choice
  const base = { root, path, exists: text !== undefined, ...(legacy ? { legacy } : {}) }
  if (text === undefined) return { ...base, config: {} }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ...base, config: {}, error: `not valid JSON: ${String(error).slice(0, 160)}` }
  }
  const error = validate(raw)
  return error ? { ...base, config: {}, error } : { ...base, config: raw as NeilDevConfig }
}

const said = (r: { stdout: string; stderr: string }) => (r.stderr.trim() || r.stdout.trim() || 'no output').replace(/\s+/g, ' ').slice(0, 300)

async function moveLegacy($: EngineInterface, root: string) {
  const isTracked = await $.process.run(['git', 'ls-files', '--error-unmatch', '--', LEGACY_CONFIG_FILE], { cwd: root, timeoutMs: 10000 })
  const argv = isTracked.exitCode === 0 ? ['git', 'mv', '-f', '--', LEGACY_CONFIG_FILE, CONFIG_FILE] : ['rm', '--', LEGACY_CONFIG_FILE]
  const moved = await $.process.run(argv, { cwd: root, timeoutMs: 10000 })
  if (moved.exitCode !== 0) throw new Error(`${argv.join(' ')} in ${root} exited ${moved.exitCode}: ${said(moved)}. Repair: move ${root}/${LEGACY_CONFIG_FILE} to ${root}/${CONFIG_FILE} by hand, or run ndev project migrate-config.`)
}

// Writes one key to .ndev.json and keeps every other key as it was. A config under the legacy name moves to .ndev.json.
export async function saveSetting(
  $: EngineInterface,
  loaded: LoadedConfig,
  key: 'mode' | 'steering' | 'github' | 'workflow',
  value: unknown,
) {
  const current = loaded.exists && !loaded.error ? (JSON.parse(await $.fs.read(loaded.path)) as Record<string, unknown>) : {}
  if (loaded.legacy && !loaded.error) await moveLegacy($, loaded.root)
  await $.fs.write(`${loaded.root}/${CONFIG_FILE}`, `${JSON.stringify({ ...current, [key]: value }, null, 2)}\n`)
}
