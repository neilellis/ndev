// kb/workflow.md must list what the human can do next in each state of each workflow.
// Run: node --test scripts/workflow/tests/workflow_human_steps_doc.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const source = file => readFileSync(join(ROOT, file), 'utf8')
const listOf = (file, pattern) => {
  const m = pattern.exec(source(file))
  assert.ok(m, `no state list in ${file}: the pattern no longer matches`)
  return [...m[1].matchAll(/'([a-z-]+)'/g)].map(x => x[1])
}

test('kb/workflow.md has a row for each issue state and each epic state', () => {
  const states = listOf('hooks/workflow/machine.ts', /export const STATES = \[([^\]]+)\]/)
  const epicStates = listOf('scripts/ndev/epic-model.ts', /export const EPIC_STATES: EpicState\[\] = \[([^\]]+)\]/)
  assert.ok(states.includes('developing') && epicStates.includes('slicing'))
  const section = source('kb/workflow.md').split('\n## What the human can do next\n')[1]?.split('\n## ')[0]
  assert.ok(section, 'kb/workflow.md has no section "## What the human can do next"')
  const missing = [...states.map(s => `| \`${s}\` |`), ...epicStates.map(s => `| epic \`${s}\` |`)].filter(row => !section.includes(row))
  assert.deepEqual(missing, [], `kb/workflow.md "What the human can do next" has no row for: ${missing.join(', ')}`)
})
