import type { EngineInterface } from 'claude-code'
import { workflowTools } from '../hooks/workflow/tools'
import { CONFIG, ROOT, engine, type On, type Opts } from './workflow-harness'

type Event = Record<string, unknown>
type Reply = { result: string; isError?: boolean }
type Budget = { ms: number; remainingMs: number }
type Limits = { budget: Budget; signal: AbortSignal }
type Mock = { event: string; filter: Event; body: (host: EngineInterface, event: Event) => unknown }
type Handler = (host: EngineInterface, event: Event, limits: Limits) => Promise<Reply>

export function workflowHost(options: Opts = {}) {
  const mocks: Mock[] = []
  const registerMock = (event: string, ...rest: unknown[]) => {
    const body = rest.at(-1)
    if (typeof body !== 'function') throw new TypeError(`Host mock ${event} has no handler`)
    mocks.push({ event, filter: rest.length > 1 ? rest[0] as Event : {}, body: body as Mock['body'] })
    return { catch: () => {} }
  }
  const world = engine(registerMock as On, options)
  const values = new Map<string, { value: unknown; version: number }>()
  let host: EngineInterface
  const effect = async (event: string, args: Event) => {
    const mock = mocks.findLast(m => m.event === event && Object.entries(m.filter).every(([key, value]) => args[key] === value))
    if (!mock) throw new Error(`Host mock ${event} is missing for ${JSON.stringify(args)}`)
    const answer = await mock.body(host, args)
    return answer && typeof answer === 'object' && 'value' in answer ? answer.value : answer
  }
  host = {
    plugin: { root: '/plugin', name: 'ndev' },
    state: {
      get: async (ref: unknown) => values.get(JSON.stringify(ref)) ?? { value: undefined, version: 0 },
      set: async (ref: unknown, value: unknown, init?: { ifVersion?: number }) => {
        const key = JSON.stringify(ref)
        const old = values.get(key) ?? { value: undefined, version: 0 }
        if (init?.ifVersion !== undefined && init.ifVersion !== old.version) return { isSet: false, version: old.version }
        const version = old.version + 1
        values.set(key, { value, version })
        return { isSet: true, version }
      },
    },
    process: { run: (argv: string[], init?: unknown) => effect('process.run', { argv, init }) },
    fs: {
      read: (path: string) => effect('fs.read', { path }),
      exists: (path: string) => effect('fs.exists', { path }),
      write: (path: string, text: string) => effect('fs.write', { path, text }),
      list: (path: string) => effect('fs.list', { path }),
    },
    clock: { now: () => effect('clock.now', {}) },
    session: { id: () => effect('session.id', {}), cwd: () => effect('session.cwd', {}) },
    env: { get: (name: string) => effect('env.get', { name }) },
    ui: {
      status: (text: string) => effect('ui.status', { text }),
      log: (text: string) => effect('ui.log', { text }),
      toast: (text: string) => effect('ui.toast', { text }),
    },
  } as unknown as EngineInterface
  const handlers = new Map<string, Handler>()
  const register = (event: string, filter: { tool: string }, body: Handler) => {
    if (event !== 'tool.call') throw new Error(`Unsupported workflow registration: ${event}`)
    handlers.set(filter.tool, body)
    return { catch: () => {} }
  }
  const config = world.files.get(CONFIG)
  if (config === undefined) throw new Error(`Host configuration is missing: ${CONFIG}`)
  workflowTools(register as Parameters<typeof workflowTools>[0], () => ({ root: ROOT, path: CONFIG, exists: true, config: JSON.parse(config) }))
  return {
    world,
    call: async (name: string, args: Event, budget: Budget) => {
      const tool = `mcp__ndev__${name}`
      const handler = handlers.get(tool)
      if (!handler) throw new Error(`Workflow host has no registered handler for ${tool}`)
      const reply = await handler(host, { tool, ...args }, { budget, signal: new AbortController().signal })
      return { text: String(reply.result), isError: !!reply.isError }
    },
  }
}
