import { createHash } from 'node:crypto'
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { atomicJson, CliError, locked, readObject, run, stateRoot } from './common.mjs'

const flag = () => join(stateRoot(), 'chat-guard')
const maximumTranscriptBytes = 1024 * 1024
const minutes = 60_000
const threshold = 200_000
const providers = new Set(['claude', 'codex'])
const preLaunchErrors = new Set([
  'incompatible_runtime', 'worktree_host_unresolved', 'selector_not_found', 'LINEAGE_PARENT_AMBIGUOUS',
])
const chatReplies = new Set(['hand-off', 'new-session', 'continue'])
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

function readTranscript(path) {
  try {
    return transcriptTail(path)
  } catch (error) {
    throw new CliError(1, `Chat guard could not read ${path}: ${error.message}`, {
      repair: 'Check the transcript or run ndev chat-guard off.',
    })
  }
}

function handoffPrompt(harness, transcript, draft) {
  const recent = []
  for (const line of readTranscript(transcript).lines) {
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    const message = harness === 'codex'
      ? entry?.type === 'response_item' && entry.payload?.type === 'message'
        && entry.payload.role === 'assistant' && entry.payload
      : entry?.type === 'assistant' && !entry.isSidechain && entry.message
    if (!Array.isArray(message?.content)) continue
    const text = message.content
      .filter(part => (part?.type === 'text' || part?.type === 'output_text') && typeof part.text === 'string')
      .map(part => part.text)
      .join('\n')
      .trim()
    if (text) recent.push(text.slice(-2000))
    if (recent.length === 3) break
  }
  if (!recent.length) return draft
  return `Recent assistant messages from the previous chat (for reference):\n\n${recent.reverse().join('\n\n')}\n\nUser request:\n\n${draft}`
}

function recoverLaunch(attempt) {
  return attempt.operationId
    ? `Reply ${attempt.reply} again to recover the earlier Orca launch.`
    : 'Check Orca for the new chat. If it did not open, run /compact here, then resend the original message.'
}

function launchSavedPrompt(harness, payload, reply, file, pending) {
  const attempt = pending.attempt
  if (attempt && (!attempt.operationId || attempt.reply !== reply)) return recoverLaunch(attempt)
  const cwd = pending.cwd
  const prompt = attempt?.prompt ?? (reply === 'hand-off'
    ? handoffPrompt(harness, payload.transcript_path, pending.draft)
    : pending.draft)
  atomicJson(file, { ...pending, attempt: { reply, prompt, operationId: attempt?.operationId } })
  const { status, stdout, stderr } = run(process.env.ORCA_CLI_COMMAND || 'orca', [
    'agent', 'launch', '--agent', harness, '--surface', 'chat', '--worktree', `path:${cwd}`,
    '--focus', '--json', `--prompt=${prompt}`,
    ...(attempt?.operationId ? ['--retry-launch', attempt.operationId] : []),
  ], { cwd, timeout: 25_000 })
  let response
  try { response = JSON.parse(stdout) } catch {}
  const delivery = response?.result?.prompt?.outcome
  if (status === 0 && response?.ok === true && delivery === 'journaled') {
    rmSync(file)
    return reply === 'hand-off' && prompt === pending.draft
      ? 'Sent your saved message to a new Orca chat. This transcript had no recent assistant text to carry over.'
      : 'Sent your saved message to a new Orca chat.'
  }
  if (status === 0 && response?.ok === true && delivery === 'handed-to-terminal') {
    rmSync(file)
    return 'Orca opened a terminal and sent your saved message there.'
  }
  const errorCode = response?.error?.code
  if (!attempt && (preLaunchErrors.has(errorCode) || (status === 127 && /\bENOENT\b/.test(stderr)))) {
    atomicJson(file, pending)
    const repair = errorCode === 'incompatible_runtime'
      ? 'Update Orca before retrying.'
      : 'Check that the Orca CLI can find this workspace with orca worktree show --worktree current, then retry.'
    return `Orca could not start a chat (exit ${status}, ${errorCode ?? 'CLI not found'}). ${repair}`
  }
  const operationId = response?.error?.data?.operationId ?? response?.result?.operationId ?? attempt?.operationId
  if (typeof operationId === 'string' && operationId) {
    atomicJson(file, { ...pending, attempt: { reply, prompt, operationId } })
    return `Orca could not confirm delivery (exit ${status}). Reply ${reply} again to recover the same launch.`
  }
  return `Orca could not confirm delivery (exit ${status}). ${recoverLaunch({})}`
}

function withPendingDraft(harness, file, update) {
  try {
    const result = locked(file, update)
    return typeof result === 'string' ? block(harness, result) : result
  } catch (error) {
    if (error instanceof CliError && error.code === 5) {
      return block(harness, 'An Orca chat guard action is already in progress. Wait for it to finish before replying.')
    }
    throw error
  }
}

function block(harness, reason) {
  return {
    decision: 'block',
    reason,
    ...(harness === 'claude' ? {
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true },
    } : {}),
  }
}

export function blockedNativePrompt(harness, payload) {
  if (!providers.has(harness) || process.env.ORCA_STRUCTURED_SESSION !== '1' || !existsSync(flag())) return
  if (typeof payload.prompt !== 'string' || contextCommands.test(payload.prompt)) return
  if (typeof payload.transcript_path !== 'string' || !payload.transcript_path) return
  const key = createHash('sha256').update(JSON.stringify([
    harness, payload.session_id ?? process.env.ORCA_AGENT_SESSION_ID, payload.transcript_path,
  ])).digest('hex')
  const file = join(stateRoot(), 'chat-guard-pending', `${key}.json`)
  const reply = payload.prompt.trim().toLowerCase()
  const isReply = chatReplies.has(reply)
  if (isReply && existsSync(file)) {
    return withPendingDraft(harness, file, () => {
      const pending = readObject(file, { missing: {} })
      if (reply === 'continue' && pending.draft) {
        if (pending.attempt) return recoverLaunch(pending.attempt)
        rmSync(file)
        return { hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `The user chose to continue in this chat. Carry out their saved request:\n\n${pending.draft}`,
        } }
      }
      return pending.draft
        ? launchSavedPrompt(harness, payload, reply, file, pending)
        : 'There is no saved message for this chat. Send the original message again first.'
    })
  }
  const { lines, truncatedAt } = readTranscript(payload.transcript_path)
  const activity = transcriptActivity(harness, lines) ?? (truncatedAt ? { timestamp: truncatedAt } : undefined)
  if (!activity) return
  const elapsed = Date.now() - activity.timestamp
  const idle = Math.floor(elapsed / minutes)
  const explanation = elapsed > 50 * minutes
    ? `This chat has been idle for ${idle} minutes.`
    : elapsed >= 20 * minutes && activity.tokens > threshold
      ? `This chat has about ${activity.tokens.toLocaleString('en-GB')} tokens and has been idle for ${idle} minutes.`
      : undefined
  if (!explanation) {
    if (existsSync(file)) locked(file, () => rmSync(file, { force: true }))
    return
  }
  if (isReply) return block(harness, 'There is no saved message for this chat. Send the original message again first.')
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  return withPendingDraft(harness, file, () => {
    const { attempt } = readObject(file, { missing: {} })
    if (attempt) return recoverLaunch(attempt)
    atomicJson(file, { draft: payload.prompt, cwd: payload.cwd ?? process.cwd() })
    return `${explanation} Reply continue to send your saved message here anyway, hand-off to carry recent context into a new chat, or new-session to send just your saved message. You can also run /compact, then resend when it finishes.`
  })
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
