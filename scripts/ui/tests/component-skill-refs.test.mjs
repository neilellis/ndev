// The skills that lead to UI work must make the agent read the component catalogue. A path written as
// "the plugin's kb/ui-components.md" does not resolve in the agent's project, so it stays out of context.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SKILLS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills')
const READ = /\bread `\$\{CLAUDE_PLUGIN_ROOT\}\/kb\/ui-components\.md`/i
const MUST_READ = ['brand', 'motion', 'react-grab', 'responsive-check', 'site-check', 'ux-principles', 'work-heavy', 'work-light']

const refProblems = (text) =>
  text
    .split('\n')
    .filter((line) => line.includes('ui-components') && !READ.test(line))
    .map((line) => line.trim())

test('each skill that leads to UI work tells the agent to read the catalogue by its resolved path', () => {
  const missing = MUST_READ.filter((name) => !READ.test(readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8')))
  assert.deepEqual(missing, [], 'add: read `${CLAUDE_PLUGIN_ROOT}/kb/ui-components.md`')
})

test('no skill names the catalogue in a form that does not load it', () => {
  const bad = readdirSync(SKILLS)
    .map((name) => join(SKILLS, name, 'SKILL.md'))
    .filter((file) => existsSync(file))
    .flatMap((file) => refProblems(readFileSync(file, 'utf8')).map((line) => `${file}: ${line}`))
  assert.deepEqual(bad, [], 'write it as: read `${CLAUDE_PLUGIN_ROOT}/kb/ui-components.md`')
})

test('the check tells the two forms apart', () => {
  assert.deepEqual(refProblems('Read `${CLAUDE_PLUGIN_ROOT}/kb/ui-components.md` first.'), [])
  assert.equal(refProblems("Choose it from the plugin's `kb/ui-components.md`.").length, 1)
})
