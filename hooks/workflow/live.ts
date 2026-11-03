// What the workflow is doing right now, for the /view pane: the last result of a wait, the last read
// of the checks and the last few tool calls. It sits in the git dir of the worktree, because a wait
// with a 5 s period would otherwise write the record 720 times an hour. Only the pane reads it, so a
// failed write costs a toast and never stops the work.
import type { EngineInterface } from 'claude-code'

import type { WorkflowLive, WorkflowView } from '../../types'

const MASK = '•••'
const MAX_TEXT = 120
const MAX_FILE = 4096
const MAX_CALLS = 5
const MAX_ARGS = 6
// A wait or a watch that has not reported for this long past its period has likely lost its session.
const STALE_GRACE_MS = 90_000
const RUNNING_LIMIT_MS = 15 * 60_000

const SECRET_KEY = /secret|token|key|pass|auth|credential/i
const SECRET_FLAG = /(--?[\w-]*(?:secret|token|key|pass|auth|credential)[\w-]*)(=|\s+)\S+/gi
const SECRET_TEXT: [RegExp, string][] = [
  [SECRET_FLAG, `$1$2${MASK}`],
  [/\b([A-Z][A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, `$1=${MASK}`],
  [/\b((?:proxy-)?authorization\s*[:=]\s*)[^"'\n]+/gi, `$1${MASK}`],
  [/\b([\w.-]*(?:secret|token|apikey|api[-_]key|[-_]key|passw|pwd|passphrase|credential)[\w.-]*["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"',;&]+)/gi, `$1${MASK}`],
  [/((?:^|\s)(?:-u|--user)(?:=|\s*))[^\s:]+:\S*/g, `$1${MASK}`],
  [/\b((?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n;|&]*?\s-p)\S+/g, `$1${MASK}`],
  [/\bBearer\s+\S+/gi, `Bearer ${MASK}`],
  [/\b(?:gh[a-z]_|github_pat_)[A-Za-z0-9_]+/g, MASK],
  [/\bsk-[A-Za-z0-9_-]+/g, MASK],
  [/\bxox[a-z]-[A-Za-z0-9-]+/g, MASK],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${MASK}@`],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s?#]+)[?#]\S*/gi, `$1?${MASK}`],
]

// A secret under a key inside an object, at any depth, as in a body that a tool was given.
function maskedDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskedDeep)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, SECRET_KEY.test(key) ? MASK : maskedDeep(inner)]))
}

const textOf = (value: unknown) => (typeof value === 'object' && value !== null ? JSON.stringify(maskedDeep(value)) : String(value))

// A value as the pane and the record may hold it: no secret, one line, short.
export function shownValue(key: string, value: unknown): string {
  if (SECRET_KEY.test(key)) return MASK
  const raw = Array.isArray(value) ? value.map(textOf).join(', ') : textOf(value)
  const line = SECRET_TEXT.reduce((text, [find, put]) => text.replace(find, put), raw).trim().split('\n')[0] ?? ''
  return line.length > MAX_TEXT ? `${line.slice(0, MAX_TEXT)}…(${raw.length} chars)` : line
}

export function shownArgs(args: Record<string, unknown>): Record<string, string> {
  const entries = Object.entries(args).filter(([key, value]) => key !== 'agentId' && value !== undefined && value !== null && value !== '')
  return Object.fromEntries(entries.slice(0, MAX_ARGS).map(([key, value]) => [key, shownValue(key, value)]))
}

export const liveName = (wf: { pr?: number; issue: number }) => (wf.pr ? `pr-${wf.pr}` : `issue-${wf.issue}`)
export const livePath = (gitDir: string, name: string) => `${gitDir}/ndev-live-${name}.json`

const gitDirs = new Map<string, string>()

// Each worktree has its own git dir, so the live files of two worktrees never meet.
export async function liveGitDir($: EngineInterface, root: string): Promise<string> {
  const known = gitDirs.get(root)
  if (known) return known
  const r = await $.process.run(['git', 'rev-parse', '--absolute-git-dir'], { cwd: root, timeoutMs: 10000 })
  if (r.exitCode !== 0) throw new Error(`git rev-parse --absolute-git-dir exited ${r.exitCode} in ${root}: ${r.stderr.trim() || r.stdout.trim()}`)
  const dir = r.stdout.trim()
  gitDirs.set(root, dir)
  return dir
}
const queues = new Map<string, Promise<void>>()
const toasted = new Set<string>()

function fitted(live: WorkflowLive): string {
  const kept = { ...live, calls: [...(live.calls ?? [])].slice(-MAX_CALLS) }
  let out = JSON.stringify(kept)
  while (out.length > MAX_FILE && kept.calls.length > 1) {
    kept.calls.shift()
    out = JSON.stringify(kept)
  }
  return out
}

async function writeNow($: EngineInterface, root: string, name: string, change: (live: WorkflowLive) => WorkflowLive): Promise<void> {
  try {
    const path = livePath(await liveGitDir($, root), name)
    let was: WorkflowLive = { at: 0 }
    if (await $.fs.exists(path)) {
      // A file that a crash cut short only loses the earlier lines of a display.
      try {
        was = JSON.parse(await $.fs.read(path)) as WorkflowLive
      } catch {
        was = { at: 0 }
      }
    }
    await $.fs.write(path, fitted({ ...change(was), at: await $.clock.now() }))
  } catch (error) {
    const key = `${root}:${name}`
    if (toasted.has(key)) return
    toasted.add(key)
    $.ui.toast(`workflow: the /view pane will not show the live state of ${name} in ${root}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// Writes for one file go one at a time, or a tool call and a wait in the same worktree lose a line.
export async function writeLive($: EngineInterface, root: string, name: string, change: (live: WorkflowLive) => WorkflowLive): Promise<void> {
  const key = `${root}:${name}`
  const next = (queues.get(key) ?? Promise.resolve()).then(() => writeNow($, root, name, change))
  queues.set(key, next)
  await next
}

export async function liveCallStart($: EngineInterface, root: string, name: string, tool: string, args: Record<string, unknown>): Promise<number> {
  const at = await $.clock.now()
  await writeLive($, root, name, live => ({ ...live, calls: [...(live.calls ?? []), { tool, args: shownArgs(args), at, outcome: 'running' as const }] }))
  return at
}

export async function liveCallEnd($: EngineInterface, root: string, name: string, tool: string, at: number, outcome: 'ok' | 'refused' | 'failed', result: string): Promise<void> {
  const endedAt = await $.clock.now()
  await writeLive($, root, name, live => ({
    ...live,
    calls: (live.calls ?? []).map(c => (c.tool === tool && c.at === at ? { ...c, outcome, endedAt, note: shownValue('note', result) } : c)),
  }))
}

export async function readLive($: EngineInterface, path: string): Promise<{ live?: WorkflowLive; error?: string }> {
  try {
    if (!(await $.fs.exists(path))) return {}
    return { live: JSON.parse(await $.fs.read(path)) as WorkflowLive }
  } catch (error) {
    return { error: `${path} could not be read: ${error instanceof Error ? error.message : String(error)}. The next write replaces it.` }
  }
}

// Whether a wait or a watch stopped reporting.
export const liveStale = (at: number | undefined, periodS: number, now: number) => at !== undefined && now - at > periodS * 1000 + STALE_GRACE_MS

export function span(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000))
  if (secs < 60) return `${secs} s`
  const mins = Math.floor(secs / 60)
  if (mins < 10) return `${mins}m ${secs % 60}s`
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`
}

export type LiveLine = { text: string; color?: 'warning' | 'error' | 'subtle' | 'success' }
export type LiveBox = { sign: string; title: string; color: 'warning' | 'claude' | 'subtle'; lines: LiveLine[]; earlier: LiveLine[] }

const pairs = (values: Record<string, string> | undefined): LiveLine[] => {
  const entries = Object.entries(values ?? {})
  const width = Math.max(0, ...entries.map(([key]) => key.length)) + 2
  return entries.map(([key, value]) => ({ text: `  ${key.padEnd(width)}${value}` }))
}

const watchLine = (watch: NonNullable<WorkflowLive['watch']>, now: number) => {
  const parts = [`${watch.green} green`, `${watch.pending.length} pending${watch.pending.length ? `: ${watch.pending.join(', ')}` : ''}`, `${watch.red.length} red${watch.red.length ? `: ${watch.red.join(', ')}` : ''}`]
  return `Checks${watch.sha ? ` on ${watch.sha}` : ''}, read ${span(now - watch.at)} ago: ${parts.join(', ')}`
}

// The box of the pane: what this workflow does now, what it waits for and what came back last.
export function liveBox(w: WorkflowView, now: number): LiveBox | undefined {
  const calls = w.live?.calls ?? []
  const running = calls.filter(c => c.outcome === 'running' && c.tool !== w.waiting?.tool)
  const earlier: LiveLine[] = calls.filter(c => c.outcome !== 'running').slice(-4).reverse().map(c => ({
    text: `${c.outcome === 'ok' ? '✔' : '✖'} ${c.tool}  ${span(now - (c.endedAt ?? c.at))} ago${c.note ? `  ${c.note}` : ''}`,
    color: c.outcome === 'ok' ? 'subtle' : 'error',
  }))
  const review: LiveLine[] = (w.review ?? []).map(r => ({ text: `Review  ${r.name} ${r.answered ? 'answered' : 'running'}${r.firedAt ? ` ${span(now - r.firedAt)}` : ''}` }))
  const watch = w.live?.watch
  if (w.state === 'blocked') {
    const lines: LiveLine[] = [
      { text: w.blocked ?? 'The workflow is blocked.' },
      ...(w.blockedAt ? [{ text: `blocked ${span(now - w.blockedAt)} ago`, color: 'subtle' as const }] : []),
      { text: 'Repair: /unblock <message>' },
      ...(watch ? [{ text: watchLine(watch, now), color: 'subtle' as const }] : []),
    ]
    return { sign: '▲', title: 'Needs you', color: 'warning', lines, earlier }
  }
  if (w.state === 'wait' && w.waiting) {
    const waiting = w.waiting
    const wait = w.live?.wait?.id === waiting.id ? w.live.wait : undefined
    const period = waiting.period ?? 0
    const count = wait ? `check ${wait.tries}${waiting.most ? ` of ${waiting.most}` : ''}` : 'no check yet'
    const next = wait?.nextAt !== undefined && wait.nextAt > now ? ` · next in ${span(wait.nextAt - now)}` : ''
    const givesUp = waiting.timeoutS ? ` · gives up in ${span(waiting.at + waiting.timeoutS * 1000 - now)}` : ''
    const lines: LiveLine[] = [
      { text: `${waiting.tool}  ${waiting.what}` },
      ...pairs(waiting.args),
      { text: `${count}${period ? ` · every ${period} s` : ''}${next}` },
      { text: `started ${span(now - waiting.at)} ago${givesUp}`, color: 'subtle' },
    ]
    if (wait?.checkedAt !== undefined) {
      lines.push({ text: `Last result, ${span(now - wait.checkedAt)} ago` })
      lines.push(...(wait.seen ? pairs(wait.seen) : [{ text: `  ${wait.detail ?? ''}` }]))
    }
    if (liveStale(wait?.checkedAt ?? waiting.at, period, now)) lines.push({ text: `No report for ${span(now - (wait?.checkedAt ?? waiting.at))}: the session may have ended. A new session resumes with started.`, color: 'warning' })
    return { sign: '◷', title: 'Waiting', color: 'claude', lines, earlier }
  }
  if (running.length) {
    const lines = running.flatMap(c => {
      const longGone = now - c.at > RUNNING_LIMIT_MS
      return [{ text: `${c.tool}  ${span(now - c.at)}${longGone ? ' (no end recorded: the session may have ended)' : ''}`, color: longGone ? ('warning' as const) : undefined }, ...pairs(c.args)]
    })
    return { sign: '●', title: 'Running', color: 'claude', lines: [...lines, ...review], earlier }
  }
  if (w.state === 'ci' && watch) {
    const lines: LiveLine[] = [
      { text: watchLine(watch, now) },
      ...(watch.nextAt !== undefined && watch.nextAt > now ? [{ text: `next read in ${span(watch.nextAt - now)}`, color: 'subtle' as const }] : []),
      ...pairs(watch.seen),
      ...watch.problems.map(text => ({ text, color: 'error' as const })),
    ]
    return { sign: '◷', title: 'Watching', color: 'claude', lines, earlier }
  }
  if (review.length) return { sign: '●', title: 'In review', color: 'claude', lines: review, earlier }
  return earlier.length ? { sign: '○', title: 'Last calls', color: 'subtle', lines: [], earlier } : undefined
}
