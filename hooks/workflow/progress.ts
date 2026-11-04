// A tool call can hold for many minutes: a check script runs for up to 10, and finishedReview runs two
// of them and a push. The host draws no text for a call that runs, so the plugin's status line under the
// prompt says which tool runs, which step it is on and for how long. A call that ends in one tick shows nothing.
import type { EngineInterface } from 'claude-code'
import { span } from './live'

const TICK_MS = 15_000

type Step = { name: string; at: number; limitMs?: number }
type Call = { tool: string; at: number; step?: Step }

// One process serves one session, so what the line says when no tool runs lives here too.
let idle: string | undefined
const calls: Call[] = []

function put($: EngineInterface, progress?: string): void {
  $.ui.status(progress ? (idle ? `${idle} · ${progress}` : progress) : idle)
}

async function show($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const call = calls.at(-1)
  if (!call) return
  const step = call.step ? ` · ${call.step.name} ${span(now - call.step.at)}${call.step.limitMs ? ` of at most ${span(call.step.limitMs)}` : ''}` : ''
  put($, `ndev ${call.tool} ${span(now - call.at)}${step}`)
}

// The line for when no tool runs. A running tool's next tick carries the new text.
export function showIdleStatus($: EngineInterface, text: string): void {
  idle = text
  if (!calls.length) put($)
}

export async function withToolProgress<T>($: EngineInterface, tool: string, work: () => Promise<T>): Promise<T> {
  const call: Call = { tool, at: await $.clock.now() }
  calls.push(call)
  // A failed tick costs one update of the line. It must not fail the tool, so it goes to the debug log.
  const timer = $.clock.every(TICK_MS, () => { void show($).catch((error: unknown) => $.ui.log(`ndev: the progress line of ${tool} did not update: ${String(error)}`, { to: 'debug' })) })
  try {
    return await work()
  } finally {
    timer.cancel()
    calls.splice(calls.indexOf(call), 1)
    if (calls.length) await show($)
    else put($)
  }
}

// The step of the tool call that runs now. With no tool call, for example in a hook, the work just runs.
export async function withStep<T>($: EngineInterface, name: string, limitMs: number | undefined, work: () => Promise<T>): Promise<T> {
  const call = calls.at(-1)
  if (!call) return work()
  const earlier = call.step
  call.step = { name, at: await $.clock.now(), ...(limitMs ? { limitMs } : {}) }
  try {
    return await work()
  } finally {
    call.step = earlier
  }
}
