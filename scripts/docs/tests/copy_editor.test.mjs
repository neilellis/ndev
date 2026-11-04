import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const agent = readFileSync(new URL('../../../agents/copy-editor.md', import.meta.url), 'utf8')

test('the copy-editor agent runs readability.sh, and a Vale that did not run is not a pass', () => {
  assert.match(agent, /scripts\/docs\/readability\.sh/)
  assert.match(agent, /VALE: not run/)
})
