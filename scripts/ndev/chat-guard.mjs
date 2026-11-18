import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CliError, stateRoot } from './common.mjs'

const flag = () => join(stateRoot(), 'chat-guard')
const maximumTranscriptBytes = 1024 * 1024
const minutes = 60_000
const threshold = 200_000
const providers = new Set(['claude', 'codex'])
const contextCommands = /^\s*\/(?:compact|clear)(?:\s|$)/i

function transcriptTail(path) {
  let file
  try {
    file = openSync(path, 'r')
  } catch (error) {
    if (error.code === 'ENOENT') return { lines: [] }
    throw error
  }
  try {
    const info = fstatSync(file)
    if (!info.isFile()) throw new Error('expected a regular transcript file')
    const start = Math.max(0, info.size - maximumTranscriptBytes)
    const bytes = Buffer.alloc(info.size - start)
    const read = readSync(file, bytes, 0, bytes.length, start)
    const lines = bytes.toString('utf8', 0, read).split('\n')
    return { lines: (start ? lines.slice(1) : lines).reverse(), truncatedAt: start ? info.mtimeMs : undefined }
  } finally {
    closeSync(file)
  }
}

function transcriptActivity(harness, lines) {
  for (const line of lines) {
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    const timestamp = Date.parse(entry?.timestamp)
    if (!Number.isFinite(timestamp)) continue
    if (harness === 'codex') {
      const event = entry.type === 'event_msg' ? entry.payload : undefined
      if (entry.type === 'compacted' || event?.type === 'context_compacted') return { timestamp }
      const usage = event?.type === 'token_count' ? event.info?.last_token_usage : undefined
      if (Number.isFinite(usage?.total_tokens)) return { timestamp, tokens: usage.total_tokens }
    } else {
      if (entry.type === 'system' && entry.subtype === 'compact_boundary') return { timestamp }
      const usage = entry.type === 'assistant' && !entry.isSidechain ? entry.message?.usage : undefined
      if (usage && Number.isFinite(usage.input_tokens)) {
        const tokens = usage.input_tokens + (usage.cache_read_input_tokens ?? 0)
          + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0)
        if (tokens > 0) return { timestamp, tokens }
      }
    }
  }
}

export function blockedNativePrompt(harness, payload) {
  if (!providers.has(harness) || process.env.ORCA_STRUCTURED_SESSION !== '1' || !existsSync(flag())) return
  if (typeof payload.prompt !== 'string' || contextCommands.test(payload.prompt)) return
  if (typeof payload.transcript_path !== 'string' || !payload.transcript_path) return
  let activity
  try {
    const { lines, truncatedAt } = transcriptTail(payload.transcript_path)
    activity = transcriptActivity(harness, lines) ?? (truncatedAt ? { timestamp: truncatedAt } : undefined)
  } catch (error) {
    throw new CliError(1, `Chat guard could not read ${payload.transcript_path}: ${error.message}`, {
      repair: 'Check the transcript or run ndev chat-guard off.',
    })
  }
  if (!activity) return
  const elapsed = Date.now() - activity.timestamp
  const idle = Math.floor(elapsed / minutes)
  const explanation = elapsed > 50 * minutes
    ? `This chat has been idle for ${idle} minutes.`
    : elapsed >= 5 * minutes && activity.tokens > threshold
      ? `This chat has about ${activity.tokens.toLocaleString('en-GB')} tokens and has been idle for ${idle} minutes.`
      : undefined
  if (!explanation) return
  return {
    decision: 'block',
    reason: `${explanation} Run /compact in Orca, then resend once it finishes. To continue without the guard, run ndev chat-guard off in a terminal.`,
    ...(harness === 'claude' ? {
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true },
    } : {}),
  }
}

export function runChatGuard([command, ...args]) {
  if (args.length) throw new CliError(2, 'Use ndev chat-guard on, off, or status.')
  const path = flag()
  if (command === 'on' && !existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, '', { mode: 0o600, flag: 'wx' })
  }
  if (command === 'off') rmSync(path, { force: true })
  const enabled = existsSync(path)
  return { enabled, text: `Native Orca chat guard is ${enabled ? 'on' : 'off'}.` }
}
