import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withSdkExecutionBudget } from './sdk-execution.mjs'

const recorder = () => {
  const calls = []
  const result = { registered: true }
  const register = (...args) => { calls.push(args); return result }
  return { calls, result, test: withSdkExecutionBudget(register) }
}

test('issue 143: SDK integration registration gets a finite execution allowance', () => {
  const sdk = recorder()
  const body = async () => 'completed'
  assert.equal(sdk.test('integration', body), sdk.result)
  assert.deepEqual(sdk.calls, [['integration', { timeoutMs: 30_000 }, body]])
})

test('issue 143: options without a deadline retain their metadata and get the integration allowance', () => {
  const sdk = recorder()
  const body = async () => {}
  const options = { tags: ['workflow'] }
  sdk.test('metadata', options, body)
  assert.deepEqual(sdk.calls, [['metadata', { tags: ['workflow'], timeoutMs: 30_000 }, body]])
  assert.deepEqual(options, { tags: ['workflow'] })
})

test('issue 143: explicit execution deadlines and the callback are preserved', () => {
  for (const timeoutMs of [1000, 30_000, 60_000, 180_000]) {
    const sdk = recorder()
    const body = () => {}
    sdk.test('explicit', { timeoutMs, tags: ['budget-guard'] }, body)
    assert.deepEqual(sdk.calls, [['explicit', { timeoutMs, tags: ['budget-guard'] }, body]])
  }
})

test('issue 143: registration failures propagate without retry', () => {
  const failure = new Error('SDK registration refused integration')
  let calls = 0
  const register = withSdkExecutionBudget(() => { calls++; throw failure })
  assert.throws(() => register('integration', () => {}), error => error === failure)
  assert.equal(calls, 1)
})

test('issue 143: callback failures are not wrapped or swallowed', async () => {
  const sdk = recorder()
  const failure = new Error('logical clock bound failed')
  const body = async () => { throw failure }
  sdk.test('clock assertion', body)
  assert.equal(sdk.calls[0][2], body)
  await assert.rejects(sdk.calls[0][2](), error => error === failure)
})

test('issue 143: malformed registrations fail before reaching the SDK', () => {
  for (const args of [['missing'], ['null', null, () => {}], ['bad body', {}, 'text'], ['two callbacks', () => {}, () => {}], ['extra argument', {}, () => {}, 'extra']]) {
    const sdk = recorder()
    assert.throws(() => sdk.test(...args), /SDK test .*expected a callback/)
    assert.equal(sdk.calls.length, 0)
  }
})

test('issue 143: pure synchronous registrations retain the SDK default', () => {
  const sdk = recorder()
  const body = () => 'pure rule'
  sdk.test('pure', body)
  sdk.test('pure metadata', { tags: ['rules'] }, body)
  assert.deepEqual(sdk.calls, [['pure', body], ['pure metadata', { tags: ['rules'] }, body]])
})
