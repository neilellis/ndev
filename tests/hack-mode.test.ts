import { expect, test } from 'claude-code/testing'

import { FLOW, afterSkip, afterStarted, afterTool, flowPicture, needsSmoke, nextStep, orcaView } from '../hooks/workflow/machine'
import type { Facts } from '../hooks/workflow/machine'
import { strictest } from '../hooks/workflow/tools'

// Hack mode: free trial and error first, then a strict stage before anything is pushed. Interactive only.
const hack = (extra: Partial<Facts> = {}): Facts => ({ mode: 'hack', steering: 'interactive', ...extra })

test('hack starts in developing, with no interview and no plan', () => {
  expect(afterStarted(undefined, { mode: 'hack', steering: 'interactive' })).toEqual({ state: 'developing' })
  expect(afterSkip({ state: 'setup' }, 'hack', 'interactive')).toEqual({ state: 'developing' })
})

test('the hack ends with finishedHacking, and hardening ends with finishedDevelopment', () => {
  expect(afterTool({ state: 'developing' }, 'finishedHacking', hack())).toEqual({ state: 'hardening' })
  expect(afterTool({ state: 'hardening' }, 'finishedDevelopment', hack())).toEqual({ state: 'reviewing' })
  expect(afterTool({ state: 'hardening' }, 'checkpoint', hack())).toEqual({ state: 'hardening' })
})

test('a hack cannot go to the review without hardening, and the refusal names finishedHacking', () => {
  const move = afterTool({ state: 'developing' }, 'finishedDevelopment', hack())
  expect(move).toHaveProperty('refused')
  expect((move as { refused: string }).refused).toContain('finishedHacking')
})

test('finishedHacking belongs to hack mode only', () => {
  expect(afterTool({ state: 'developing' }, 'finishedHacking', { mode: 'light', steering: 'interactive' })).toHaveProperty('refused')
  expect(afterTool({ state: 'reviewing' }, 'finishedHacking', hack())).toHaveProperty('refused')
})

test('a skip goes from the hack to hardening, and from hardening to the review', () => {
  expect(afterSkip({ state: 'developing' }, 'hack', 'interactive')).toEqual({ state: 'hardening' })
  expect(afterSkip({ state: 'hardening' }, 'hack', 'interactive')).toEqual({ state: 'reviewing' })
})

test('more work after the review on a hack goes back to hardening, not to the hack', () => {
  expect(afterTool({ state: 'ci' }, 'followUpThisAgent', hack())).toEqual({ state: 'hardening' })
  expect(afterTool({ state: 'developed' }, 'checkpoint', hack())).toEqual({ state: 'hardening' })
  expect(afterTool({ state: 'ci' }, 'followUpThisAgent', { mode: 'light', steering: 'interactive' })).toEqual({ state: 'developing' })
})

test('each hack change has a smoke test due', () => {
  expect(needsSmoke('hack', ['lib/a.ts'], [])).toBe(true)
  expect(needsSmoke('light', ['lib/a.ts'], [])).toBe(false)
})

test('the steps of hack name its tools, its checks and the adversarial review', () => {
  const developing = nextStep('developing', hack({ baseChecked: false }))
  expect(developing).toContain('finishedHacking')
  expect(developing).not.toContain('finishedInterview')
  expect(developing).not.toContain('test first')
  const hardening = nextStep('hardening', hack())
  expect(hardening).toContain('fail on the base')
  expect(hardening).toContain('finishedDevelopment')
  expect(hardening).toContain('hardening')
  const reviewing = nextStep('reviewing', hack())
  expect(reviewing).toContain('two-axis')
  expect(reviewing).toContain('ndev:adversarial-review')
})

test('hardening stands between developing and the review on the flow', () => {
  expect(FLOW.indexOf('hardening')).toBe(FLOW.indexOf('developing') + 1)
  expect(flowPicture({ state: 'hardening' }, ['developing', 'hardening']).steps.find(s => s.state === 'developing')?.mark).toBe('passed')
  // Light and heavy have no hardening, so it shows as skipped once they pass it.
  expect(flowPicture({ state: 'ci' }, ['developing', 'reviewing']).steps.find(s => s.state === 'hardening')?.mark).toBe('skipped')
  expect(orcaView({ issue: 7, prs: [12], state: 'hardening' }).comment).toContain('hardening')
})

test('a PR follows its strictest issue: light, then hack, then heavy', () => {
  expect(strictest([{ mode: 'light' }, { mode: 'hack' }]).mode).toBe('hack')
  expect(strictest([{ mode: 'hack' }, { mode: 'light' }]).mode).toBe('hack')
  expect(strictest([{ mode: 'hack' }, { mode: 'heavy' }]).mode).toBe('heavy')
  expect(strictest([{ mode: 'light' }, { mode: 'heavy' }, { mode: 'hack' }]).mode).toBe('heavy')
})
