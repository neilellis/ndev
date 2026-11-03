import { expect, test } from 'claude-code/testing'
import { checkLog, outputCut } from '../hooks/workflow/check-log'

const CAP = 4194304
const PATH = 'scripts/ndev/workflow/pre-commit-check.sh'
const bytes = (text: string) => new TextEncoder().encode(text).length

test('a log under the limit is written whole', () => {
  expect(checkLog({ stdout: 'ok', stderr: 'warn' }, PATH)).toBe('ok\n--- stderr\nwarn\n')
})

test('both streams at the cap in ASCII fit one write, and the log keeps the end of what it was given', () => {
  const log = checkLog({ stdout: `${'x'.repeat(CAP - 5)}\nlast`, stderr: `${'y'.repeat(CAP - 5)}\nlast`, isStdoutTruncated: true, isStderrTruncated: true }, PATH)
  expect(bytes(log)).toBeLessThanOrEqual(CAP)
  expect(log).toContain('\nlast\n--- stderr\n')
  expect(log).toContain('[cut: the first')
  expect(log).toContain(`--- cut\n${PATH} printed more than 4 MiB`)
})

test('both streams at the cap in 3-byte text fit one write', () => {
  const huge = '€'.repeat(Math.floor(CAP / 3))
  expect(bytes(checkLog({ stdout: huge, stderr: huge, isStdoutTruncated: true, isStderrTruncated: true }, PATH))).toBeLessThanOrEqual(CAP)
})

test('output the engine did not cut has no cut note', () => {
  expect(outputCut({ stdout: 'a', stderr: 'b', isStdoutTruncated: false, isStderrTruncated: false }, PATH)).toBeUndefined()
  expect(outputCut({ stdout: 'a', stderr: 'b' }, PATH)).toBeUndefined()
})

test('the cut note names the stream and the repair', () => {
  const note = outputCut({ stdout: '', stderr: 'b', isStderrTruncated: true }, PATH) as string
  expect(note).toContain('on stderr')
  expect(note).toContain(`bash ${PATH}`)
})
