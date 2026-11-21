import assert from 'node:assert/strict'
import { test } from 'node:test'
import { until } from './until.ts'

test('readiness waits for the outcome rather than accepting an unfinished state', async () => {
  let probes = 0
  await until('the third response', async () => ++probes === 3, () => ({ probes }))
  assert.equal(probes, 3)
})

test('readiness propagates a failed probe instead of hiding it in a timeout', async () => {
  const cause = new Error('PR #12: HTTP 403')
  await assert.rejects(until('PR checks', async () => { throw cause }, () => 'unreadable'), error => error === cause)
})

test('readiness times out a probe that never returns', async () => {
  let watchdog
  const waiting = until('the held response', () => new Promise(() => {}), () => ({ response: 'pending' }), 0)
  const guard = new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('Readiness left its probe unbounded')), 100) })
  try {
    await assert.rejects(Promise.race([waiting, guard]), /Timed out waiting for the held response: {"response":"pending"}/)
  } finally {
    clearTimeout(watchdog)
  }
})
