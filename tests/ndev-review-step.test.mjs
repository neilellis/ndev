import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextStep } from '../hooks/workflow/machine.ts'

const web = { steering: 'auto', changeTypes: ['web'], webFiles: ['app/page.tsx'] }

test('the review step asks for screenshots of a web change in heavy mode and not in light mode', () => {
  assert.match(nextStep('reviewing', { ...web, mode: 'heavy' }), /Screenshots:/)
  assert.doesNotMatch(nextStep('reviewing', { ...web, mode: 'light' }), /Screenshots:|mcp__ndev__screenshot/)
})
