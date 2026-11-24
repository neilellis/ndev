import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextStep } from '../hooks/workflow/machine.ts'

test('the plan step asks for a verification line for each record and a Quint model first for a heavy or stateful change', () => {
  const step = nextStep('planning', { mode: 'heavy', steering: 'auto' })
  assert.match(step, /"REQ-NNNN: <the test, check or model that verifies it>"/)
  assert.match(step, /state, concurrency, money, permissions or a protocol, in Quint first/)
  assert.match(step, /ndev requirements model <REQ-NNNN> <path\.qnt#name>/)
})

test('a record is verified only by its own "REQ-NNNN:" line that names a test, check or model', async () => {
  const { verificationProblems } = await import('../hooks/workflow/records.ts')
  const plan = rest => `Requirements: REQ-0004\nModel: docs/m.qnt#inv (REQ-0004)\nTest entry point: REQ-0004 test\n${rest}`
  for (const weak of ['REQ-0004: no test yet', 'REQ-0004: none, tests later', 'REQ-0004: TBD check', 'The REQ-0004 test is pending', ''])
    assert.equal(verificationProblems(plan(weak), ['REQ-0004']).length, 1, weak)
  for (const good of ['REQ-0004: the test tests/a.test.ts', '- REQ-0004: the model docs/m.qnt#inv', '* **REQ-0004:** check scripts/x.sh'])
    assert.deepEqual(verificationProblems(plan(good), ['REQ-0004']), [], good)
})
