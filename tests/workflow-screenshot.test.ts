// Workflow tests: screenshot, the check log cap, waitForPR and the status line. The shared harness is in tests/workflow-harness.ts.
import { expect, test } from './sdk-testing'
import { held, engine, settle, start, tool, poll, orcaVerbs, SHOTS } from './workflow-harness'

test('screenshot follows the viewports, schemes, fullPage and waitSeconds that it gets', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const r = await tool($, 'screenshot', { url: 'https://x.test/', viewports: ['320x640'], schemes: ['dark'], fullPage: true, waitSeconds: 2 })
  expect(r.isError).toBe(false)
  expect(w.copies).toEqual([`${SHOTS}/x-test-home-320x640-dark.png`])
  expect(orcaVerbs(w)).toContain('full-screenshot')
  expect(w.orcaCalls.some(c => c[0] === 'wait' && c.includes('2000'))).toBe(true)
})

test('a full page is one full-screenshot image, taken after a scroll pass reaches the end and returns to the top', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.pageHeight = 2000
  const r = await tool($, 'screenshot', { url: 'https://x.test/', viewports: ['320x640'], schemes: ['light'], fullPage: true })
  expect(r.isError).toBe(false)
  expect(w.s.scrolls).toEqual([0, 512, 1024, 1360, 0])
  expect(orcaVerbs(w).filter(v => v === 'screenshot' || v === 'full-screenshot')).toEqual(['full-screenshot'])
  expect(w.s.shotsAt).toEqual([0])
  expect(w.copies).toEqual([`${SHOTS}/x-test-home-320x640-light.png`])
  expect(r.text).toContain('Saved 1 image')
  expect(r.text).not.toContain('WARNING')
})

test('a full page with no end stops the scroll pass at its limit and says what may not have loaded', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.pageHeight = 1_000_000
  const r = await tool($, 'screenshot', { url: 'https://x.test/', viewports: ['320x640'], schemes: ['light'], fullPage: true })
  expect(r.isError).toBe(false)
  expect(w.s.scrolls).toHaveLength(41)
  expect(w.copies).toHaveLength(1)
  expect(r.text).toContain('may not have loaded')
  expect(r.text).toContain('1000000')
})

test('a full page that will not scroll to its end says so', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.pageHeight = 2000
  w.s.stuckAt = 0
  const r = await tool($, 'screenshot', { url: 'https://x.test/', viewports: ['320x640'], schemes: ['light'], fullPage: true })
  expect(r.isError).toBe(false)
  expect(w.s.shotsAt).toEqual([0])
  expect(r.text).toContain('would not scroll on')
})

test('a full page waits again after the scroll pass and before the capture', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.pageHeight = 2000
  await tool($, 'screenshot', { url: 'https://x.test/', viewports: ['320x640'], schemes: ['light'], fullPage: true, waitSeconds: 2 })
  const steps = w.orcaCalls.flatMap(c => (c[0] === 'wait' && c.includes('2000') ? ['pause'] : c[0] === 'full-screenshot' ? ['capture'] : c.join(' ').includes('scrollTo') ? ['scroll'] : c.join(' ').includes('document.images') ? ['images'] : []))
  expect(steps).toEqual(['pause', 'scroll', 'scroll', 'scroll', 'scroll', 'scroll', 'pause', 'images', 'capture'])
})

test('a full page warns when images are still loading at the capture', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.loadingImages = 3
  const r = await tool($, 'screenshot', { url: 'https://x.test/', viewports: ['320x640'], schemes: ['light'], fullPage: true })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('WARNING')
  expect(r.text).toContain('3 image(s) were still loading')
  expect(w.copies).toHaveLength(1)
})

test('a full page is refused when orca status gives no version number', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.orcaVersion = 'unknown'
  const r = await tool($, 'screenshot', { url: 'https://x.test/', viewports: ['320x640'], schemes: ['light'], fullPage: true })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('"unknown"')
  expect(orcaVerbs(w)).toEqual(['status'])
})

test('a full page is refused on an Orca that can wrap the image, before a tab opens, and a viewport image is not', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.orcaVersion = '1.4.266'
  const refused = await tool($, 'screenshot', { url: 'https://x.test/', viewports: ['320x640'], schemes: ['light'], fullPage: true })
  expect(refused.isError).toBe(true)
  expect(refused.text).toContain('1.4.274')
  expect(refused.text).toContain('1.4.266')
  expect(orcaVerbs(w)).toEqual(['status'])
  expect((await tool($, 'screenshot', { url: 'https://x.test/', viewports: ['320x640'], schemes: ['light'] })).isError).toBe(false)
})

test('a page that looks the same in light and dark gets a warning that names the images and the repair', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sameImages = true
  const r = await tool($, 'screenshot', { url: 'https://x.test/cart', viewports: ['320x640', '800x600'], schemes: ['light', 'dark'] })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('WARNING')
  expect(r.text).toContain('did not change between light and dark')
  expect(r.text).toContain(`${SHOTS}/x-test-cart-320x640-dark.png`)
  expect(r.text).toContain(`${SHOTS}/x-test-cart-800x600-dark.png`)
  expect(r.text).toContain('orca storage local set')
})

test('a page that changes between light and dark gets no warning, and one scheme is not compared', async ($, on) => {
  const w = engine(on)
  await start($, w)
  expect((await tool($, 'screenshot', { url: 'https://x.test/cart', viewports: ['320x640'] })).text).not.toContain('WARNING')
  w.s.sameImages = true
  expect((await tool($, 'screenshot', { url: 'https://x.test/cart', viewports: ['320x640'], schemes: ['dark'] })).text).not.toContain('WARNING')
})

test('a comparison that cannot run is a refusal that names the files and the cause', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.cmpFails = 'cmp: No such file or directory'
  const r = await tool($, 'screenshot', { url: 'https://x.test/cart', viewports: ['320x640'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('exited 2')
  expect(r.text).toContain('No such file')
  expect(r.text).toContain(`${SHOTS}/x-test-cart-320x640-dark.png`)
  expect(orcaVerbs(w).at(-1)).toBe('tab close')
})

test('screenshot works with no workflow, and for a helper', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  const r = await tool($, 'screenshot', { url: 'https://x.test/a', viewports: ['320x640'], schemes: ['light'], agentId: 'helper-1' })
  expect(r.isError).toBe(false)
  expect(w.copies).toHaveLength(1)
})

test('screenshot refuses bad arguments before it opens a tab', async ($, on) => {
  const w = engine(on)
  await start($, w)
  for (const args of [{}, { url: 'file:///etc/passwd' }, { url: 'x.test' }, { url: 'https://x.test', viewports: ['wide'] }, { url: 'https://x.test', viewports: [] }, { url: 'https://x.test', schemes: ['blue'] }, { url: 'https://x.test', schemes: [] }, { url: 'https://x.test', waitSeconds: -1 }]) {
    const r = await tool($, 'screenshot', args)
    expect([JSON.stringify(args), r.isError]).toEqual([JSON.stringify(args), true])
  }
  expect(w.orcaCalls).toEqual([])
})

test('screenshot with no orca command refuses and names the repair and the other route', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.orcaGone = true
  const r = await tool($, 'screenshot', { url: 'https://x.test' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('orca did not run')
  expect(r.text).toContain('orca open')
  expect(r.text).toContain('ndev:responsive-check')
  expect(w.copies).toEqual([])
})

test('screenshot with Orca not running refuses and opens no tab', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.orcaReachable = false
  const r = await tool($, 'screenshot', { url: 'https://x.test' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('orca open')
  expect(orcaVerbs(w)).toEqual(['status'])
})

test('a browser command that fails names the command, the code and the repair', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.orcaFails = 'The desktop is offline'
  const r = await tool($, 'screenshot', { url: 'https://x.test' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('orca tab create')
  expect(r.text).toContain('browser_host_unavailable')
  expect(r.text).toContain('orca open')
})

test('a page that lands on a login leaves its tab for the human and saves nothing', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.pageUrl = 'https://x.test/login?next=/cart'
  const r = await tool($, 'screenshot', { url: 'https://x.test/cart' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('https://x.test/login?next=/cart')
  expect(r.text).toContain('sign in')
  expect(r.text).toContain('page-1')
  expect(w.copies).toEqual([])
  expect(orcaVerbs(w)).not.toContain('tab close')
})

test('a login page that was asked for is taken', async ($, on) => {
  const w = engine(on)
  await start($, w)
  expect((await tool($, 'screenshot', { url: 'https://x.test/login', viewports: ['320x640'], schemes: ['light'] })).isError).toBe(false)
  expect(w.copies).toHaveLength(1)
})

test('a viewport that was not applied is refused, and the tab still closes', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.pageWidth = 1000
  const r = await tool($, 'screenshot', { url: 'https://x.test' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('1000')
  expect(r.text).toContain('390')
  expect(w.copies).toEqual([])
  expect(orcaVerbs(w).at(-1)).toBe('tab close')
})

test('a copy that fails is refused, the tab closes, and the failure names the file', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.cpFails = 'No space left on device'
  const r = await tool($, 'screenshot', { url: 'https://x.test' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('No space left on device')
  expect(orcaVerbs(w).at(-1)).toBe('tab close')
})

// ---- a refused command name must not stop the watcher ----
test('when the command name is refused, the watcher still starts and the toast names the refusal', async ($, on) => {
  const w = engine(on, { refuseCommand: /^flow$/, wf: { state: 'ci' }, pr: { mergeable: false, mergeable_state: 'dirty' } })
  await start($, w)
  expect(w.toasts.join('\n')).toContain('did not start')
  await poll(w)
  expect(w.prompts.join('\n')).toContain('merge conflict')
})

test('the command name is not /workflow, which the Vercel plugin owns', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' } })
  await start($, w)
  expect(w.commandNames).toContain('flow')
  expect(w.commandNames).not.toContain('workflow')
})

test('a check that passes with stdout at the 4 MiB cap still commits, and its log says it was cut', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.hugeCheck = 'pre-commit-check'
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'Add', files: ['a.ts'] })
  expect(r.text).not.toContain('byte limit')
  expect(r.isError).toBe(false)
  expect(w.commits.length).toBe(1)
  const log = [...w.files].find(([path]) => path.endsWith('ndev-pre-commit-check.sh.log'))?.[1]
  expect(log).toContain('printed more than 4 MiB on stdout')
  expect(log).toContain('--- stderr')
})

test('a check that fails with stdout at the 4 MiB cap names its exit code and the cut, not the log write', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.hugeCheck = 'pre-commit-check'
  w.s.hugeExit = 3
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'Add', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('pre-commit-check.sh exited 3')
  expect(r.text).toContain('4 MiB')
  expect(w.commits.length).toBe(0)
})

// ---- a resumed session finds its workflow again ----
// A session in the main checkout works in a worktree. Its link to that worktree does not survive a restart, and session end clears the owner.
for (const [what, wf] of [['still owns', { owner: { session: 's1', at: 0 } }], ['ended and released', { owner: undefined, lastSession: 's1' }]] as const) {
  test(`a resumed session in the main checkout that ${what} the workflow is watched again`, async ($, on) => {
    const w = engine(on, { wf: { state: 'ci', ...wf }, pr: { mergeable: false, mergeable_state: 'dirty' } })
    await $.session.start({ cwd: '/main', surface: 'terminal', isInteractive: false })
    await settle()
    await poll(w)
    expect(w.prompts.join('\n')).toContain('merge conflict')
    expect(w.state()?.owner?.session).toBe('s1')
  })
}

test('a session that never had the workflow does not take it on start', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci', owner: undefined, lastSession: 'another' } })
  await $.session.start({ cwd: '/main', surface: 'terminal', isInteractive: false })
  await settle()
  expect(w.state()?.owner).toBeUndefined()
})

// ---- waitForPR, waitForIssue and the alert past half the retries ----
test('waitForPR holds until the PR is merged, with one GitHub read for each check', async ($, on) => {
  const w = engine(on, { pr: { state: 'open', merged: false } })
  await start($, w)
  w.s.sleepAdvances = true
  const reads = () => w.gh.filter(c => c.includes(' pr-read 44')).length
  const before = reads()
  w.s.prReadsFor = { 44: [{ state: 'open', merged: false }, { state: 'closed', merged: true }] }
  const r = await tool($, 'waitForPR', { pr: 44, state: 'merged', period: 60 })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('PR #44')
  expect(reads() - before).toBe(2)
  expect(w.s.now).toBe(60_000)
  expect(w.state()?.state).toBe('developing')
})

test('waitForPR refuses a state it cannot read, and a period that spends the GitHub calls', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const bad = await tool($, 'waitForPR', { pr: 44, state: 'green' })
  expect(bad.isError).toBe(true)
  expect(bad.text).toContain('merged')
  const fast = await tool($, 'waitForPR', { pr: 44, state: 'merged', period: 5 })
  expect(fast.isError).toBe(true)
  expect(fast.text).toContain('60')
  expect(w.state()?.state).toBe('developing')
})

test('waitForPR outlasts a failed read and ends at once on a PR that does not exist', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  w.s.prReadsFor = { 44: ['HTTP 502', { state: 'closed', merged: true }], 45: ['Could not resolve to a PullRequest: not found'] }
  expect((await tool($, 'waitForPR', { pr: 44, state: 'merged', period: 60 })).isError).toBe(false)
  const r = await tool($, 'waitForPR', { pr: 45, state: 'merged', period: 60 })
  expect(r.text).toContain('not found')
  expect(w.state()?.state).toBe('developing')
})

test('waitForIssue holds until the issue is closed', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  w.s.issueReadsFor = { 9: [{ state: 'open' }, { state: 'closed' }] }
  const r = await tool($, 'waitForIssue', { waitOn: [9], state: 'closed', period: 60 })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('issue #9')
  expect((await tool($, 'waitForIssue', { waitOn: [9], state: 'merged' })).isError).toBe(true)
})

// ---- the line under the prompt during a long tool call ----
test('a long tool call shows its name, its step and the time under the prompt, and the line goes back when it ends', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const shownBefore = w.statuses.at(-1)
  let release = () => {}
  w.s.checkHold = new Promise<void>(resolve => { release = resolve })
  const held = tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  await settle()
  expect(w.statuses.filter(x => x?.includes('checkpoint'))).toEqual([])
  w.s.now += 125_000
  w.timers.splice(0).forEach(fire => fire())
  await settle()
  const line = w.statuses.at(-1)!
  expect(line).toContain(String(shownBefore))
  expect(line).toContain('checkpoint 2m 5s')
  expect(line).toMatch(/fast-checks\.sh 2m 5s of at most 1h 0m/)
  release()
  expect((await held).isError).toBe(false)
  expect(w.statuses.at(-1)).toBe(shownBefore)
})

test('a short tool call does not write the status line', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const before = w.statuses.length
  await tool($, 'status')
  expect(w.statuses.length).toBe(before)
})

test('a call that waits behind a long call does not take its line', async ($, on) => {
  const w = engine(on)
  await start($, w)
  let release = () => {}
  w.s.checkHold = new Promise<void>(resolve => { release = resolve })
  const held = tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  await settle()
  const queued = tool($, 'status')
  await settle()
  w.s.now += 125_000
  w.timers.splice(0).forEach(fire => fire())
  await settle()
  const line = w.statuses.at(-1)!
  expect(line).toContain('checkpoint 2m 5s')
  expect(line).toContain('fast-checks.sh')
  expect(w.statuses.filter(x => x?.includes('ndev status'))).toEqual([])
  release()
  await held
  await queued
})

test('a tool call that fails puts the line back too, and a wait tool has its own display and adds no line', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const shownBefore = w.statuses.at(-1)
  let release = () => {}
  w.s.checkHold = new Promise<void>(resolve => { release = resolve })
  w.s.failCheck = 'fast-checks'
  const held = tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  await settle()
  w.timers.splice(0).forEach(fire => fire())
  await settle()
  expect(w.statuses.at(-1)).toContain('checkpoint')
  release()
  expect((await held).isError).toBe(true)
  expect(w.statuses.at(-1)).toBe(shownBefore)
  w.s.sleepAdvances = true
  const before = w.statuses.length
  await tool($, 'waitForSeconds', { secs: 1 })
  expect(w.statuses.length).toBe(before)
})


test('fullPage warns when an inner scrolling pane has content outside the captured view', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.pageHeight = 640
  w.s.innerScroller = { element: 'main#content', height: 500, total: 2000 }
  const result = await tool($, 'screenshot', { url: 'https://x.test/app', viewports: ['320x640'], schemes: ['light'], fullPage: true })
  expect(result.isError).toBe(false)
  expect(w.copies).toHaveLength(1)
  expect(result.text).toContain('WARNING')
  expect(result.text).toContain('main#content')
  expect(result.text).toContain('2000')
  expect(result.text).toMatch(/only.*visible (?:portion|view)/i)
  expect(result.text).toContain('not the whole page')
  expect(orcaVerbs(w).at(-1)).toBe('tab close')
})

test('a viewport screenshot of an inner pane does not claim or warn about a full page', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.innerScroller = { element: 'main#content', height: 500, total: 2000 }
  const result = await tool($, 'screenshot', { url: 'https://x.test/app', viewports: ['320x640'], schemes: ['light'], fullPage: false })
  expect(result.isError).toBe(false)
  expect(w.copies).toHaveLength(1)
  expect(result.text).not.toContain('WARNING')
})
