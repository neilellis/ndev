import type { EngineInterface } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { startWatchdog, watcherNote } from '../hooks/workflow/watchdog'

// The words of the host (2.1.318) when a timer fires in a process with no session.
const NO_SESSION = 'HooksError: ndev: $.agent.list is not available in this mode: no session is bound in this process (the REPL has not mounted and no headless session is built); catch it and carry on'

// The kit turns a throw in a hook into "no implementation for agent.list", which loses the host's words.
// So this fake engine holds only what the timer's failure path needs, and the failure comes from the project read.
const watchdogThatFails = async (message: string) => {
  const held = new Map<string, { value: unknown; version: number }>()
  const toasts: string[] = []
  let fire: () => Promise<void> = async () => {}
  const $ = {
    clock: { now: async () => 1000, every: (_ms: number, tick: () => Promise<void>) => { fire = tick } },
    state: {
      get: async (ref: { key: string }) => held.get(ref.key) ?? { value: undefined, version: 0 },
      set: async (ref: { key: string }, value: unknown) => {
        const version = (held.get(ref.key)?.version ?? 0) + 1
        held.set(ref.key, { value, version })
        return { isSet: true, version }
      },
    },
    ui: { toast: (text: string) => { toasts.push(text) } },
  } as unknown as EngineInterface
  let reads = 0
  // Only the tick's read fails: the failure message reads the project again for its report.
  await startWatchdog($, () => {
    if (reads++ === 0) throw new Error(message)
    return undefined
  })
  await fire()
  return { $, toasts }
}

test('an idle check with no session bound stays quiet, reports no bug, and the note says why', async () => {
  const { $, toasts } = await watchdogThatFails(NO_SESSION)
  expect(toasts).toEqual([])
  expect((await watcherNote($)).why).toBe('quiet: no session is bound in this process yet')
})

test('any other failure of an idle check still shows, with its words and the bug report', async () => {
  const { toasts } = await watchdogThatFails('ndev: $.agent.list broke')
  expect(toasts.join()).toContain('the idle check failed')
  expect(toasts.join()).toContain('$.agent.list broke')
  expect(toasts.join()).toContain('as a workflow bug')
})
