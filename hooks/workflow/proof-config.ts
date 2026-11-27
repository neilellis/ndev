export type DevServer = {
  command: string
  cwd?: string
  port: number
  ready: string
  env?: Record<string, string>
  routes?: string[]
  timeout?: number
}
export type DevServers = Record<string, DevServer>

export const PROOF_CHECKS = ['requirements', 'code', 'visual', 'tests', 'model', 'docs', 'lessons'] as const
export type ProofCheck = (typeof PROOF_CHECKS)[number]
export const PROOF_SCHEMES = ['light', 'dark'] as const
export type Viewport = { name: string; width: number; height: number }
export type ProofTiers = { small?: number; large?: number }

export type Proof = {
  enabled?: boolean
  checks?: Partial<Record<ProofCheck, boolean>>
  viewports?: Viewport[]
  schemes?: (typeof PROOF_SCHEMES)[number][]
  label?: string
  tiers?: ProofTiers
}

export type ProofSettings = {
  enabled: boolean
  checks: Record<ProofCheck, boolean>
  viewports: Viewport[]
  schemes: (typeof PROOF_SCHEMES)[number][]
  label: string
  tiers: Required<ProofTiers>
}

export const DEV_SERVER_NAME = /^[A-Za-z0-9._-]+$/
const SERVER_KEYS = ['command', 'cwd', 'port', 'ready', 'env', 'routes', 'timeout']
const PROOF_KEYS = ['enabled', 'checks', 'viewports', 'schemes', 'label', 'tiers']
const LABEL = /^[^,\s][^,]{0,49}$/

export const DEFAULT_PROOF: ProofSettings = {
  enabled: true,
  checks: Object.fromEntries(PROOF_CHECKS.map(check => [check, true])) as Record<ProofCheck, boolean>,
  viewports: [
    { name: 'phone', width: 390, height: 844 },
    { name: 'tablet', width: 820, height: 1180 },
    { name: 'desktop', width: 1440, height: 900 },
  ],
  schemes: ['light', 'dark'],
  label: 'no-proof',
  tiers: { small: 50, large: 400 },
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const list = (values: readonly string[]) => values.join(', ')

function serverError(name: string, raw: unknown): string | undefined {
  const at = `"devServers.${name}`
  if (!isObject(raw)) return `${at}" must be an object such as { "command": "npm run dev", "port": 3000, "ready": "http://localhost:3000/" }`
  const extra = Object.keys(raw).filter(key => !SERVER_KEYS.includes(key))
  if (extra.length > 0) return `${at}" has the unknown key ${extra.map(key => `"${key}"`).join(', ')}; the keys are ${list(SERVER_KEYS)}`
  if (typeof raw.command !== 'string' || raw.command.trim() === '') return `${at}.command" is ${JSON.stringify(raw.command)}; use the shell command that starts the server, such as "npm run dev"`
  if (raw.cwd !== undefined && (typeof raw.cwd !== 'string' || raw.cwd.trim() === '' || raw.cwd.startsWith('/'))) return `${at}.cwd" is ${JSON.stringify(raw.cwd)}; use a folder relative to the project root, such as "apps/web"`
  if (!Number.isInteger(raw.port) || (raw.port as number) < 1 || (raw.port as number) > 65535) return `${at}.port" is ${JSON.stringify(raw.port)}; use a port number from 1 to 65535`
  if (typeof raw.ready !== 'string' || raw.ready.trim() === '') return `${at}.ready" is ${JSON.stringify(raw.ready)}; use a URL or a path: the server is ready when the URL answers or the path exists`
  if (raw.env !== undefined && (!isObject(raw.env) || Object.values(raw.env).some(value => typeof value !== 'string'))) return `${at}.env" must be an object of strings, such as { "PORT": "3000" }`
  if (raw.routes !== undefined && (!Array.isArray(raw.routes) || raw.routes.some(route => typeof route !== 'string' || !route.startsWith('/')))) return `${at}.routes" is ${JSON.stringify(raw.routes)}; use a list of paths that start with "/", such as ["/", "/settings"]`
  if (raw.timeout !== undefined && (!Number.isInteger(raw.timeout) || (raw.timeout as number) < 1)) return `${at}.timeout" is ${JSON.stringify(raw.timeout)}; use the seconds to wait for ready, a whole number from 1`
  return undefined
}

export function devServersError(raw: unknown): string | undefined {
  if (!isObject(raw)) return '"devServers" must be an object of named servers, such as { "web": { "command": "npm run dev", "port": 3000, "ready": "http://localhost:3000/" } }'
  for (const [name, server] of Object.entries(raw)) {
    if (!DEV_SERVER_NAME.test(name)) return `"devServers" has the server name ${JSON.stringify(name)}; use letters, digits, ".", "_" or "-", such as "web" or "docs"`
    const error = serverError(name, server)
    if (error) return error
  }
  return undefined
}

export function proofError(raw: unknown): string | undefined {
  if (!isObject(raw)) return '"proof" must be an object such as { "enabled": true }'
  const extra = Object.keys(raw).filter(key => !PROOF_KEYS.includes(key))
  if (extra.length > 0) return `"proof" has the unknown key ${extra.map(key => `"${key}"`).join(', ')}; the keys are ${list(PROOF_KEYS)}`
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return `"proof.enabled" is ${JSON.stringify(raw.enabled)}; use true or false`
  if (raw.checks !== undefined) {
    if (!isObject(raw.checks)) return `"proof.checks" must be an object such as { "visual": false }; the checks are ${list(PROOF_CHECKS)}`
    const unknown = Object.keys(raw.checks).filter(key => !(PROOF_CHECKS as readonly string[]).includes(key))
    if (unknown.length > 0) return `"proof.checks" has the unknown check ${unknown.map(key => `"${key}"`).join(', ')}; the checks are ${list(PROOF_CHECKS)}`
    const bad = Object.entries(raw.checks).find(([, value]) => typeof value !== 'boolean')
    if (bad) return `"proof.checks.${bad[0]}" is ${JSON.stringify(bad[1])}; use true or false`
  }
  if (raw.viewports !== undefined && (!Array.isArray(raw.viewports) || raw.viewports.length === 0 || raw.viewports.some(v => !isObject(v) || typeof v.name !== 'string' || v.name === '' || !Number.isInteger(v.width) || !Number.isInteger(v.height) || (v.width as number) < 1 || (v.height as number) < 1 || Object.keys(v).some(key => !['name', 'width', 'height'].includes(key)))))
    return `"proof.viewports" is ${JSON.stringify(raw.viewports)}; use a list of { "name", "width", "height" }, with width and height in pixels from 1`
  if (raw.schemes !== undefined && (!Array.isArray(raw.schemes) || raw.schemes.length === 0 || raw.schemes.some(scheme => !(PROOF_SCHEMES as readonly unknown[]).includes(scheme))))
    return `"proof.schemes" is ${JSON.stringify(raw.schemes)}; use a list of "light" and "dark"`
  if (raw.label !== undefined && (typeof raw.label !== 'string' || !LABEL.test(raw.label))) return `"proof.label" is ${JSON.stringify(raw.label)}; use a GitHub label name of 1 to 50 characters with no comma, such as "no-proof"`
  if (raw.tiers !== undefined) {
    const tiers = raw.tiers
    const shape = `"proof.tiers" is ${JSON.stringify(tiers)}; use { "small": <lines>, "large": <lines> } with small below large`
    if (!isObject(tiers) || Object.keys(tiers).some(key => key !== 'small' && key !== 'large')) return shape
    if (Object.values(tiers).some(value => !Number.isInteger(value) || (value as number) < 1)) return shape
    const small = (tiers.small as number | undefined) ?? DEFAULT_PROOF.tiers.small
    const large = (tiers.large as number | undefined) ?? DEFAULT_PROOF.tiers.large
    if (small >= large) return shape
  }
  return undefined
}

export function proofSettings(raw: Proof | undefined): ProofSettings {
  const proof = raw ?? {}
  return {
    enabled: proof.enabled ?? DEFAULT_PROOF.enabled,
    checks: { ...DEFAULT_PROOF.checks, ...proof.checks },
    viewports: proof.viewports ?? DEFAULT_PROOF.viewports,
    schemes: proof.schemes ?? DEFAULT_PROOF.schemes,
    label: proof.label ?? DEFAULT_PROOF.label,
    tiers: { ...DEFAULT_PROOF.tiers, ...proof.tiers },
  }
}
