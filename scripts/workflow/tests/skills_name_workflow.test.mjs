// Each skill must name the workflow tools, and each tool that a skill or agent names must exist.
// Run: node --test scripts/workflow/tests/skills_name_workflow.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const skills = readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => ({ name: d.name, path: join(ROOT, 'skills', d.name, 'SKILL.md') }))
const agents = readdirSync(join(ROOT, 'agents'))
  .filter(f => f.endsWith('.md') && f !== 'README.md')
  .map(f => ({ name: f, path: join(ROOT, 'agents', f) }))
const read = item => readFileSync(item.path, 'utf8')

// mcp__ndev__report is the fix-all-prs tool, and triage_groups the triage tool. They are not workflow tools.
const OTHER_TOOLS = ['report', 'triage_groups']
const toolNames = () => {
  const source = readFileSync(join(ROOT, 'hooks', 'workflow', 'tools.ts'), 'utf8')
  return new Set([...source.matchAll(/\{ name: '([A-Za-z]+)', description:/g)].map(m => m[1]).concat(OTHER_TOOLS))
}

// The skills that carry development work must name the tool for each stage.
const STAGE_TOOLS = ['started', 'checkpoint', 'finishedDevelopment', 'finishedReview', 'finishedChecks', 'finishedSmoke', 'done', 'blocked', 'followUp', 'status', 'iNeedA', 'reportWorkflowBug']
const FULL_METHOD = ['work-light', 'work-heavy']

test('the tool list was read from the source', () => {
  assert.ok(toolNames().has('started'), 'no tool named started: the pattern no longer matches hooks/workflow/tools.ts')
})

test('each skill names a workflow tool', () => {
  const missing = skills.filter(s => !read(s).includes('mcp__ndev__')).map(s => s.name)
  assert.deepEqual(missing, [], `these skills do not name a workflow tool: add a "The workflow" section to ${missing.join(', ')}`)
})

test('each agent names a workflow tool', () => {
  const missing = agents.filter(a => !read(a).includes('mcp__ndev__')).map(a => a.name)
  assert.deepEqual(missing, [], `these agents do not name a workflow tool: ${missing.join(', ')}`)
})

for (const name of FULL_METHOD) {
  test(`${name} names the tool of each stage`, () => {
    const text = read({ path: join(ROOT, 'skills', name, 'SKILL.md') })
    const missing = STAGE_TOOLS.filter(tool => !text.includes(`mcp__ndev__${tool}`))
    assert.deepEqual(missing, [], `skills/${name}/SKILL.md does not name: ${missing.join(', ')}`)
  })
}

test('each tool that a skill or agent names exists', () => {
  const known = toolNames()
  const wrong = []
  for (const item of [...skills, ...agents]) {
    for (const m of read(item).matchAll(/mcp__ndev__([A-Za-z_]+)/g)) {
      if (!known.has(m[1])) wrong.push(`${item.name}: mcp__ndev__${m[1]}`)
    }
  }
  assert.deepEqual(wrong, [], `no such workflow tool: ${wrong.join(', ')}`)
})
