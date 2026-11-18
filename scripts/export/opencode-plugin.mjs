import { spawnSync } from 'node:child_process'

const binary = '__NDEV_BINARY__'
const lifecycle = {
  'session.created': 'session-start',
  'session.execution.started': 'turn-start',
  'session.execution.succeeded': 'turn-complete',
  'session.execution.failed': 'turn-complete',
  'session.execution.interrupted': 'turn-complete',
  'session.compaction.ended': 'compact',
  'session.deleted': 'session-end',
}

function invoke(event, data, cwd) {
  const result = spawnSync(binary, ['hook', event, '--harness', 'opencode'], {
    cwd, encoding: 'utf8', input: JSON.stringify({ ...data, session_id: data.sessionID, cwd }),
  })
  if (result.error || result.status !== 0) {
    throw new Error(`ndev hook ${event} failed (exit ${result.status ?? result.signal}): ${result.error?.message ?? result.stderr ?? result.stdout}`)
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : {}
}

export default {
  id: 'ndev',
  async setup(ctx) {
    const started = new Set()
    const pending = new Map()
    const capture = (name, data, cwd) => {
      const result = invoke(name, data, cwd)
      if (result.additionalContext) {
        const queue = pending.get(data.sessionID) ?? []
        queue.push({ type: 'text', text: result.additionalContext })
        pending.set(data.sessionID, queue)
      }
      return result
    }
    const start = (event, cwd) => {
      if (started.has(event.sessionID)) return
      capture('session-start', { sessionID: event.sessionID }, cwd)
      started.add(event.sessionID)
    }
    await ctx.session.hook('prompt', event => {
      capture('prompt-submit', { sessionID: event.sessionID, prompt: event.prompt.text }, event.location?.directory ?? ctx.location.directory)
    })
    await ctx.session.hook('context', event => {
      const cwd = event.location?.directory ?? ctx.location.directory
      start(event, cwd)
      capture('prompt-context', { sessionID: event.sessionID }, cwd)
      event.system.push(...(pending.get(event.sessionID) ?? []))
      pending.delete(event.sessionID)
    })
    await ctx.tool.hook('execute.before', event => {
      const data = { sessionID: event.sessionID, tool_name: event.tool, tool_input: event.input }
      const result = capture('pre-tool-use', data, event.location?.directory ?? ctx.location.directory)
      if (result.decision === 'deny') throw new Error(result.reason)
    })
    await ctx.tool.hook('execute.after', event => {
      const data = { sessionID: event.sessionID, tool_name: event.tool, tool_input: event.input, tool_response: event.result ?? event.error }
      capture('post-tool-use', data, event.location?.directory ?? ctx.location.directory)
    })
    const controller = new AbortController()
    const events = ctx.event.subscribe({ types: Object.keys(lifecycle), signal: controller.signal })
    const task = (async () => {
      for await (const event of events) {
        if (event.location?.directory && event.location.directory !== ctx.location.directory) continue
        const cwd = event.location?.directory ?? ctx.location.directory
        if (event.type === 'session.created') start(event.data, cwd)
        else capture(lifecycle[event.type], event.data, cwd)
        if (event.type === 'session.deleted') {
          started.delete(event.data.sessionID)
          pending.delete(event.data.sessionID)
        }
      }
    })()
    task.catch(error => {
      if (!controller.signal.aborted) console.error(`ndev opencode lifecycle: ${error.message}`)
    })
    return () => controller.abort()
  },
}
