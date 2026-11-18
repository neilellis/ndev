// Workflow tests: The wait tools: waitFor, waitForURL, waitForSubAgent and their timing. The shared harness is in tests/workflow-harness.ts.
import { expect, test } from 'claude-code/testing'
import { held, engine, settle, start, tool, turnEnds, AGENT, startFollowUp, unblock, round } from './workflow-harness'

test('waitFor checks until the command exits 0, holds the state "wait" meanwhile, and goes back', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  const seen: (string | undefined)[] = []
  let exits = [1, 1, 0]
  w.s.probe = () => {
    seen.push(w.state()?.state)
    return { exitCode: exits.shift() ?? 0 }
  }
  const r = await tool($, 'waitFor', { shell_command: 'test -f /tmp/x', period: 5 })
  expect(r.isError).toBe(false)
  expect(seen).toEqual(['wait', 'wait', 'wait'])
  expect(w.s.probes[0]).toContain('test -f /tmp/x')
  expect(w.s.now).toBe(10_000)
  expect(w.state()?.state).toBe('developing')
  expect(r.text).toContain('State: developing')
})

test('waitFor goes on past a pause that the host aborts after it ran over', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  w.s.sleepAborts = 1
  let exits = [1, 0]
  w.s.probe = () => ({ exitCode: exits.shift() ?? 0 })
  const r = await tool($, 'waitFor', { shell_command: 'test -f /tmp/x', period: 2 })
  expect(r.isError).toBe(false)
  expect(w.s.sleepAborts).toBe(0)
  expect(w.state()?.state).toBe('developing')
})

test('waitFor gives up after its attempts, names the last result and goes back', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  w.s.probe = () => ({ exitCode: 7, stderr: 'no such file' })
  const r = await tool($, 'waitFor', { shell_command: 'false', period: 5, attempts: 3 })
  expect(r.isError).toBe(true)
  expect(w.s.probes.length).toBe(3)
  expect(r.text).toContain('3 attempts')
  expect(r.text).toContain('exit code 7')
  expect(r.text).toContain('no such file')
  expect(w.state()?.state).toBe('developing')
})

test('a wait can hold for 1200 s in all: a longer timeout or secs is refused, and nothing changes', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  for (const [name, args] of [
    ['waitFor', { shell_command: 'true', timeout: 1201 }],
    ['waitForSeconds', { secs: 1201 }],
    ['waitForSeconds', { secs: 5, timeout: 3600 }],
  ] as const) {
    const r = await tool($, name, args)
    expect(r.isError).toBe(true)
    expect(r.text).toContain('1200 s')
    expect(w.state()?.state).toBe('developing')
  }
  expect((await tool($, 'waitForSeconds', { secs: 1200 })).isError).toBe(false)
})

test('with no timeout a wait gives up within 1200 s, and its last check runs just before the end', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  w.s.probe = () => ({ exitCode: 1 })
  const startedAt = w.s.now
  const r = await tool($, 'waitFor', { shell_command: 'false', period: 100 })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('timeout of 1200 s')
  expect(w.s.now - startedAt).toBeLessThanOrEqual(1_200_000)
  expect(w.s.probes.length).toBe(13)
  expect(w.state()?.state).toBe('developing')
})

test('a check may run only for what is left of the timeout', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  w.s.probe = () => ({ exitCode: 1 })
  await tool($, 'waitFor', { shell_command: 'false', period: 100, timeout: 130 })
  expect(w.s.probeLimits).toEqual([60_000, 20_000, 10_000])
})

test('a wait sees a condition that comes true in its last period, and does not hold to the end with no check', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  const startedAt = w.s.now
  w.s.probe = () => ({ exitCode: w.s.now - startedAt > 100_000 ? 0 : 1 })
  const r = await tool($, 'waitFor', { shell_command: 'x', period: 100, timeout: 130 })
  expect(r.isError).toBe(false)
  expect(w.s.probes.length).toBe(3)
})

test('waitForSeconds with secs above its timeout is refused, because it could not end well', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  const r = await tool($, 'waitForSeconds', { secs: 600, timeout: 300 })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('Nothing changed')
  expect(w.state()?.state).toBe('developing')
})

test('a wait behind a long call starts nothing past its timeout, and says so', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  w.s.sleepYields = true
  let release = () => {}
  w.s.checkHold = new Promise<void>(resolve => { release = resolve })
  const held = tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  await settle()
  const startedAt = w.s.now
  // The hold ends in time for a wait that ignores its timeout to fail here, and not to hang the file.
  const watch = setInterval(() => { if (w.s.now - startedAt > 60_000) release() }, 1)
  const r = await tool($, 'waitFor', { shell_command: 'true', timeout: 30 })
  clearInterval(watch)
  release()
  await held
  expect(r.isError).toBe(true)
  expect(r.text).toContain('Nothing changed')
  expect(w.s.now - startedAt).toBeLessThanOrEqual(30_000)
  expect(w.s.probes.length).toBe(0)
})

test('a wait ends within its timeout while another call holds the queue', async ($, on) => {
  const w = engine(on)
  await startFollowUp($, w)
  w.s.sleepAdvances = true
  w.s.sleepYields = true
  w.s.dirty = [' M a.ts']
  let release = () => {}
  w.s.checkHold = new Promise<void>(resolve => { release = resolve })
  const startedAt = w.s.now
  // A helper's checkpoint holds the queue through its checks, while the main agent waits.
  let held: ReturnType<typeof tool> | undefined
  w.s.probe = () => {
    held ??= tool($, 'checkpoint', { issue: 31, message: 'm', files: ['a.ts'], ...AGENT })
    return { exitCode: 1 }
  }
  const watch = setInterval(() => { if (w.s.now - startedAt > 60_000) release() }, 1)
  const r = await tool($, 'waitFor', { shell_command: 'false', period: 10, timeout: 30 })
  clearInterval(watch)
  const endedAt = w.s.now
  release()
  await held
  expect(r.isError).toBe(true)
  expect(r.text).toContain('timeout of 30 s')
  expect(endedAt - startedAt).toBeLessThanOrEqual(30_000)
  expect(w.state()?.state).toBe('developing')
})

test('one check of many issues stops reading when its time is up', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  w.s.issueReadMs = 8_000
  const startedAt = w.s.now
  const r = await tool($, 'waitForIssue', { waitOn: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], state: 'closed', timeout: 30 })
  expect(r.isError).toBe(true)
  expect(w.s.now - startedAt).toBeLessThanOrEqual(30_000)
})

test('a check stopped by what is left of the timeout says so, and is not reported as a command that did not run', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  w.s.probe = () => {
    w.s.now += 60_000
    throw new Error('the command was still running')
  }
  const r = await tool($, 'waitFor', { shell_command: 'slow', timeout: 30 })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('stopped after')
  expect(r.text).not.toContain('did not run')
})

test('a long period does not raise the notice after the first check', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  const seen: number[] = []
  w.s.probe = () => {
    seen.push(w.alerts.length)
    return { exitCode: 1 }
  }
  await tool($, 'waitFor', { shell_command: 'false', period: 900 })
  expect(seen).toEqual([0, 0, 1])
})

test('a wait gives up at its timeout, with attempts left', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  w.s.probe = () => ({ exitCode: 1 })
  const r = await tool($, 'waitFor', { shell_command: 'false', period: 10, attempts: 100, timeout: 25 })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('25 s')
  expect(w.s.probes.length).toBeLessThan(5)
  expect(w.state()?.state).toBe('developing')
})

test('waitForSeconds sleeps for its time and comes back', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  const r = await tool($, 'waitForSeconds', { secs: 7 })
  expect(r.isError).toBe(false)
  expect(w.s.now).toBe(7000)
  // A hook's budget of ten seconds runs on through $.clock.sleep, and not through a process.
  expect(w.s.clockSleeps).toBe(0)
  expect(w.state()?.state).toBe('developing')
})

test('waitForURL ends at a 2xx answer, and passes the URL with no shell', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  let codes = ['503', '200']
  w.s.probe = () => ({ exitCode: 0, stdout: codes.shift() ?? '200' })
  const r = await tool($, 'waitForURL', { url: 'https://example.com/a?b=1;rm' })
  expect(r.isError).toBe(false)
  expect(w.s.probes.length).toBe(2)
  expect(w.s.probes[0]?.startsWith('curl ')).toBe(true)
  expect(w.state()?.state).toBe('developing')
})

test('waitForProcessEnd ends when ps no longer lists the pid, or lists a zombie', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  let answers = [{ exitCode: 0, stdout: 'S' }, { exitCode: 1 }]
  w.s.probe = () => answers.shift() ?? { exitCode: 1 }
  expect((await tool($, 'waitForProcessEnd', { pid: 4242 })).isError).toBe(false)
  expect(w.s.probes.length).toBe(2)
  expect(w.s.probes[0]).toContain('4242')
  w.s.probes.length = 0
  answers = [{ exitCode: 0, stdout: 'Z+' }]
  expect((await tool($, 'waitForProcessEnd', { pid: 4242 })).isError).toBe(false)
  expect(w.s.probes.length).toBe(1)
})

// fcc-proto, load 120-190 on 10 cores: each 2 s slice of a pause cost the hook about 100-230 ms of its own ten
// seconds, so a wait with a timeout of 1200 s stopped after 1-4 checks. A large record makes each read of it slow,
// and that time is the hook's own, as in the test above. How slow depends on the computer and its load, so the
// test sizes the record for about 60 ms a read. The wait spaces its pauses so that its own time lasts.
test('waitForProcessEnd on a busy host holds until the process ends', { timeoutMs: 180_000 }, async ($, on) => {
  const sample = JSON.stringify(Array.from({ length: 10_000 }, (_, i) => ({ n: i, at: 0 })))
  const from = Date.now()
  for (let i = 0; i < 20; i++) JSON.parse(sample)
  const length = Math.min(2_000_000, Math.round((10_000 * 60) / Math.max((Date.now() - from) / 20, 0.05)))
  const w = engine(on, { wf: { ballast: Array.from({ length }, (_, i) => ({ n: i, at: 0 })) } })
  await start($, w)
  w.s.sleepAdvances = true
  const endsAt = w.s.now + 1_000_000
  w.s.probe = () => (w.s.now >= endsAt ? { exitCode: 1 } : { exitCode: 0, stdout: 'S' })
  const r = await tool($, 'waitForProcessEnd', { pid: 95794, period: 60, timeout: 1200 })
  expect(r.text).not.toContain("the host's time budget for one hook is nearly spent")
  expect(r.isError).toBe(false)
  expect(r.text).toContain('The wait for process 95794 ended')
  expect(w.s.now).toBeGreaterThanOrEqual(endsAt)
  expect(w.state()?.state).toBe('developing')
})

test('waitForSubAgent waits while the agent is listed as busy', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  w.s.agents = [{ id: 'a1', status: 'running' }]
  let release!: () => void
  w.s.sleepHold = new Promise<void>(resolve => { release = resolve })
  const call = tool($, 'waitForSubAgent', { claude_agent_id: 'a1' })
  await settle()
  expect(w.state()?.state).toBe('wait')
  w.s.agents = [{ id: 'a1', status: 'completed' }]
  release()
  const r = await call
  expect(r.isError).toBe(false)
  expect(r.text).toContain('a1')
  expect(w.state()?.state).toBe('developing')
})

test('waitForSubAgent holds through a pause of part of a second', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  // A first slice that runs 181 ms late leaves 0.819 s of the period: (0.819 + 10) * 1000 is not a whole number.
  w.s.sleepDrift = [181]
  Object.defineProperty(w.s, 'agents', { get: () => [{ id: 'a1', status: w.s.now >= 5000 ? 'completed' : 'running' }] })
  const r = await tool($, 'waitForSubAgent', { claude_agent_id: 'a1' })
  expect(r.text).toContain('ended after 2 checks')
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('developing')
})

test('/unblock ends a wait that is running: the tool returns the message and the state goes back', async ($, on) => {
  const w = engine(on)
  await start($, w)
  // The agent holds the turn while it waits, so the command must run at once, mid-turn.
  expect(w.s.immediate).toContain('unblock')
  w.s.probe = () => ({ exitCode: 1 })
  let release!: () => void
  w.s.sleepHold = new Promise<void>(resolve => { release = resolve })
  const call = tool($, 'waitFor', { shell_command: 'false', period: 30 })
  await settle()
  expect(w.state()?.state).toBe('wait')
  const text = await unblock($, 'it is deployed, go on')
  expect(text).toContain('back in the state "developing"')
  expect(w.state()?.state).toBe('developing')
  release()
  const r = await call
  expect(r.isError).toBe(false)
  expect(r.text).toContain('it is deployed, go on')
  expect(w.state()?.state).toBe('developing')
})

test('in the state "wait" the other phase tools refuse, and the reminders stay quiet', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.probe = () => ({ exitCode: 1 })
  let release!: () => void
  w.s.sleepHold = new Promise<void>(resolve => { release = resolve })
  const call = tool($, 'waitFor', { shell_command: 'false', period: 30 })
  await settle()
  const refused = await tool($, 'blocked', { message: 'help' })
  expect(refused.isError).toBe(true)
  expect(refused.text).toContain('"wait"')
  await turnEnds($)
  expect(w.prompts).toEqual([])
  await unblock($, 'stop')
  release()
  await call
})

test('a wait whose time equals its timeout still ends well: the last check runs at the deadline', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  const r = await tool($, 'waitForSeconds', { secs: 5, timeout: 5 })
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('developing')
})

for (const exitCode of [0, 1]) {
  test(`/unblock during a check keeps its answer, also when the check then exits ${exitCode} on its last attempt`, async ($, on) => {
    const w = engine(on)
    await start($, w)
    w.s.probe = () => unblock($, 'use the staging server').then(() => ({ exitCode }))
    const r = await tool($, 'waitFor', { shell_command: 'check', attempts: 1 })
    expect(r.text).toContain('use the staging server')
    expect(r.isError).toBe(false)
    expect(w.state()?.state).toBe('developing')
    expect((w.state() as { waitAnswer?: unknown }).waitAnswer).toBeUndefined()
  })
}
