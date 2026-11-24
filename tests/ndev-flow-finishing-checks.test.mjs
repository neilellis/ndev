import { test } from 'node:test'
import assert from 'node:assert/strict'
import { afterTool, nextStep } from '../hooks/workflow/machine.ts'

const facts = { mode: 'light', steering: 'auto' }

test('finishedChecks in finishing records the checks of a new HEAD and stays in finishing', () => {
  assert.deepEqual(afterTool({ state: 'finishing' }, 'finishedChecks', { ...facts, smoke: false }), { state: 'finishing' })
})

test('finishedChecks in finishing goes to smoke when the new HEAD needs a smoke test', () => {
  assert.deepEqual(afterTool({ state: 'finishing' }, 'finishedChecks', { ...facts, smoke: true }), { state: 'smoke' })
})

test('finishedChecks stays refused where no checks are due', () => {
  for (const state of ['developing', 'reviewing', 'smoke', 'done']) {
    assert.match(afterTool({ state }, 'finishedChecks', facts).refused, new RegExp(`not valid in the state "${state}"`), state)
  }
})

test('the refusal of a tool in finishing names done and finishedChecks, and the step explains when to call it', () => {
  assert.match(afterTool({ state: 'finishing' }, 'finishedReview', facts).refused, /done, or finishedChecks/)
  assert.match(nextStep('finishing', { ...facts, remembered: true }), /finishedChecks/)
})
