import { expect, test } from 'claude-code/testing'
import { CHANGE_MAP_LIMIT, buildChangeMap, changeMapBlock, withChangeBlock } from '../hooks/workflow/change-map'
import { requiredSmokeTypes } from '../hooks/workflow/change-types'
import { afterTool, needsSmoke, nextStep } from '../hooks/workflow/machine'

const SHA = 'abc1234def'
const LINE = /^<!-- ndev:change-map (.*) -->$/m
const facts = { mode: 'light', steering: 'auto' } as const

test('the map gives each issue its types and each file the type of its path', () => {
  expect(buildChangeMap(SHA, [{ issue: 7, changeTypes: ['web', 'backend'] }], ['app/page.tsx', 'README.md', 'server/a.py'])).toEqual({
    version: 1,
    sha: SHA,
    issues: { '7': { changeTypes: ['web', 'backend', 'docs'] } },
    files: { 'app/page.tsx': ['web'], 'README.md': ['docs'], 'server/a.py': ['backend'] },
  })
})

test('the block is one line of JSON, and a path cannot close the comment', () => {
  const block = changeMapBlock(buildChangeMap(SHA, [{ issue: 7, changeTypes: [] }], ['a-->b.ts']))!
  expect(block).not.toContain('\n')
  expect(block.indexOf('-->')).toBe(block.length - 3)
  expect(Object.keys(JSON.parse(LINE.exec(block)![1]!).files)).toEqual(['a-->b.ts'])
})

test('a change with no files has no block, because an empty map must run everything', () => {
  expect(changeMapBlock(buildChangeMap(SHA, [{ issue: 7, changeTypes: ['web'] }], []))).toBeUndefined()
})

test('a map over the limit has no block, and a reader then runs everything', () => {
  const paths = Array.from({ length: 2000 }, (_, i) => `src/a/long/path/to/some/module/number/${i}.ts`)
  expect(JSON.stringify(paths).length).toBeGreaterThan(CHANGE_MAP_LIMIT)
  expect(changeMapBlock(buildChangeMap(SHA, [{ issue: 7, changeTypes: [] }], paths))).toBeUndefined()
})

test('a new block replaces the old one and keeps the rest of the body', () => {
  const first = withChangeBlock('Closes #7\n\n## Plan\nStep', changeMapBlock(buildChangeMap('one', [{ issue: 7, changeTypes: [] }], ['a.ts'])))
  const second = withChangeBlock(first, changeMapBlock(buildChangeMap('two', [{ issue: 7, changeTypes: [] }], ['b.ts'])))
  expect(second.startsWith('Closes #7\n\n## Plan\nStep\n\n<!-- ndev:change-map ')).toBe(true)
  expect(second.match(/ndev:change-map/g)!.length).toBe(1)
  expect(second).toContain('"sha":"two"')
  expect(withChangeBlock(second, undefined)).toBe('Closes #7\n\n## Plan\nStep')
})

test('web or docs in the types, or a web or docs path, requires the smoke stage', () => {
  expect(requiredSmokeTypes(['docs', 'backend', 'web'])).toEqual(['web', 'docs'])
  expect(requiredSmokeTypes(['backend', 'tests'])).toEqual([])
  expect(needsSmoke('light', ['scripts/a.sh'], [], ['docs'])).toBe(true)
  expect(needsSmoke('light', ['README.md'], [])).toBe(true)
  expect(needsSmoke('light', ['scripts/a.sh'], [], ['backend'])).toBe(false)
})

test('a commit of documents in finishing goes to smoke when the smoke test is due, and stays when it is not', () => {
  expect(afterTool({ state: 'finishing' }, 'checkpoint', { ...facts, docsOnly: true, smoke: true })).toEqual({ state: 'smoke' })
  expect(afterTool({ state: 'finishing' }, 'checkpoint', { ...facts, docsOnly: true })).toEqual({ state: 'finishing' })
})

test('the smoke step of a required test offers no skip to the agent, and tells how to test a document', () => {
  const docs = nextStep('smoke', { ...facts, changeTypes: ['docs'] })
  expect(docs).toContain('/flow skip')
  expect(docs).not.toContain('or with skipped')
  expect(docs).toContain('each changed document')
  expect(nextStep('smoke', { ...facts, changeTypes: ['backend'] })).toContain('or with skipped')
})
