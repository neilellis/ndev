import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const script = fileURLToPath(new URL('../check.mjs', import.meta.url))
const repo = fileURLToPath(new URL('../../../', import.meta.url))

function run(...args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
}

function tree(skills) {
  const root = mkdtempSync(join(tmpdir(), 'skills-check-'))
  for (const [name, text] of Object.entries(skills)) {
    mkdirSync(join(root, 'skills', name), { recursive: true })
    if (text !== null) writeFileSync(join(root, 'skills', name, 'SKILL.md'), text)
  }
  return root
}

const skill = (head, body = '# Body\n') => `---\n${head}\n---\n\n${body}`

function failing(head, pattern, name = 'demo') {
  const r = run('--root', tree({ [name]: skill(head) }))
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}:\n${r.stdout}${r.stderr}`)
  assert.match(r.stderr, pattern)
  assert.match(r.stderr, new RegExp(`skills/${name}/SKILL\\.md`))
  return r
}

describe('skill check', () => {
  test('every skill in this repository passes', () => {
    const r = run('--root', repo)
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
    assert.match(r.stdout, /\d+ skills? valid/)
  })

  test('accepts the harness fields disable-model-invocation and argument-hint', () => {
    const r = run('--root', tree({
      hidden: skill('name: hidden\ndescription: "Run only when the user asks."\ndisable-model-invocation: true'),
      shown: skill('name: shown\ndescription: Always available.\ndisable-model-invocation: false'),
      hinted: skill('name: hinted\ndescription: "File an issue."\nargument-hint: "[--orca] <description of the issue>"'),
    }))
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
    assert.match(r.stdout, /3 skills valid/)
  })

  test('accepts a description with angle brackets, quoted or plain', () => {
    const r = run('--root', tree({
      quoted: skill('name: quoted\ndescription: "Run a board pass; flags --dry-run, --issue <n>, --parallel."'),
      plain: skill('name: plain\ndescription: Pick <n> issues when a > b.'),
    }))
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
  })

  test('accepts license and a metadata map', () => {
    const r = run('--root', tree({ vendored: skill('name: vendored\ndescription: "Draw it."\nlicense: MIT\nmetadata:\n  version: "2.6"\n  author: someone') }))
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
  })

  test('fails an unknown field, naming it and the known fields', () => {
    failing('name: demo\ndescription: "Do it."\ndisable-model-invokation: true', /"disable-model-invokation" is not a known skill field.*disable-model-invocation/)
  })

  test('fails a missing name or description', () => {
    failing('description: "Do it."', /no "name"/)
    failing('name: demo', /no "description"/)
    failing('name: demo\ndescription: ""', /"description" is empty/)
  })

  test('fails a name that is not the folder name or not kebab-case', () => {
    failing('name: other\ndescription: "Do it."', /"name" is "other", but the folder is "demo"/)
    failing('name: Demo_Skill\ndescription: "Do it."', /"name" "Demo_Skill" is not kebab-case/, 'Demo_Skill')
  })

  test('fails a flag that is not a boolean', () => {
    failing('name: demo\ndescription: "Do it."\ndisable-model-invocation: "true"', /"disable-model-invocation" must be true or false without quotes/)
    failing('name: demo\ndescription: "Do it."\ndisable-model-invocation: yes', /"disable-model-invocation" must be true or false without quotes/)
  })

  test('fails a description over 1024 characters', () => {
    failing(`name: demo\ndescription: "${'a'.repeat(1025)}"`, /"description" has 1025 characters; the limit is 1024/)
  })

  test('fails a repeated field and a value YAML would read differently', () => {
    failing('name: demo\ndescription: "Do it."\ndescription: "Again."', /"description" is in the front matter more than once/)
    failing('name: demo\ndescription: Do it: now.', /"description" holds ": "/)
    failing('name: demo\ndescription: > folded', /"description" starts with ">"/)
    failing('name: demo\ndescription: "Do it.', /line 3 is not valid/)
  })

  test('fails nested values outside metadata, and a non-text metadata entry', () => {
    failing('name: demo\ndescription: "Do it."\nlicense:\n  kind: MIT', /"license" must be text/)
    failing('name: demo\ndescription: "Do it."\nmetadata:\n  tags:\n    - a', /line 5 is not valid/)
  })

  test('fails a skill without front matter, or with front matter that does not close', () => {
    let r = run('--root', tree({ demo: '# No front matter\n' }))
    assert.equal(r.status, 1)
    assert.match(r.stderr, /skills\/demo\/SKILL\.md: no front matter/)
    r = run('--root', tree({ demo: '---\nname: demo\ndescription: "Do it."\n\n# Body\n' }))
    assert.equal(r.status, 1)
    assert.match(r.stderr, /skills\/demo\/SKILL\.md: the front matter has no closing "---" line/)
  })

  test('fails a skill folder without SKILL.md, and a nested SKILL.md', () => {
    let r = run('--root', tree({ empty: null }))
    assert.equal(r.status, 1)
    assert.match(r.stderr, /skills\/empty: no SKILL\.md/)
    const root = tree({ demo: skill('name: demo\ndescription: "Do it."') })
    mkdirSync(join(root, 'skills/demo/references'), { recursive: true })
    writeFileSync(join(root, 'skills/demo/references/SKILL.md'), skill('name: inner\ndescription: "Inner."'))
    r = run('--root', root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /skills\/demo\/references\/SKILL\.md: a second SKILL\.md inside the skill/)
  })

  test('reports every problem, not only the first', () => {
    const r = run('--root', tree({ one: skill('name: one'), two: skill('description: "Two."') }))
    assert.equal(r.status, 1)
    assert.match(r.stderr, /skills\/one\/SKILL\.md: no "description"/)
    assert.match(r.stderr, /skills\/two\/SKILL\.md: no "name"/)
    assert.match(r.stderr, /2 problems in 2 skills/)
  })

  test('fails a value YAML reads as null or rejects, without a second "no description" line', () => {
    let r = failing('name: demo\ndescription: ~', /"description" must be text, not empty/)
    assert.doesNotMatch(r.stderr, /no "description"/)
    failing('name: demo\ndescription: null', /"description" must be text, not empty/)
    r = failing('name: demo\ndescription: Use when:', /"description" ends with ":"/)
    assert.doesNotMatch(r.stderr, /no "description"/)
    r = failing('name: demo\ndescription: "Do it."\ndisable-model-invocation: True', /"disable-model-invocation" must be true or false without quotes/)
    assert.doesNotMatch(r.stderr, /no "description"/)
  })

  test('reads whole-line comments, and fails a trailing comment after quotes and a repeated metadata key', () => {
    const r = run('--root', tree({ demo: skill('# owner: docs\nname: demo\ndescription: "Do it."') }))
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
    failing('name: demo\ndescription: "Do it." # note', /line 3 is not valid.*move a comment to its own line/)
    failing('name: demo\ndescription: "Do it."\nmetadata:\n  a: b\n  a: c', /"a" is in a map of the front matter more than once/)
  })

  test('an empty skills folder or a --root without a folder is a usage failure, not a pass', () => {
    const root = tree({})
    mkdirSync(join(root, 'skills'))
    let r = run('--root', root)
    assert.equal(r.status, 2)
    assert.match(r.stderr, /no skill folder in .*skills, so nothing was checked/)
    r = run('--root')
    assert.equal(r.status, 2)
    assert.match(r.stderr, /--root needs a folder/)
  })

  test('a root without a skills folder is a usage failure, not a pass', () => {
    const r = run('--root', mkdtempSync(join(tmpdir(), 'skills-check-')))
    assert.equal(r.status, 2)
    assert.match(r.stderr, /no skills folder/)
  })
})
