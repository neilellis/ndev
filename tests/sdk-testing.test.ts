import { expect, mock, test } from 'claude-code/testing'
import * as adapted from './sdk-testing'

test('issue 143: the integration registration adapter preserves SDK assertion and mock exports', () => {
  expect(adapted.expect).toBe(expect)
  expect(adapted.mock).toBe(mock)
})
