import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const read = path => readFileSync(join(repo, path), 'utf8')

function section(text, heading) {
  const lines = text.split('\n')
  const start = lines.indexOf(`## ${heading}`)
  if (start < 0) return null
  const end = lines.findIndex((line, i) => i > start && /^#{1,2} /.test(line))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n')
}

for (const skill of ['testing', 'work-light', 'work-heavy', 'interview']) {
  test(`${skill} answers the excuses for skipping a step and lists the red flags`, () => {
    const path = `skills/${skill}/SKILL.md`
    const text = read(path)
    const excuses = section(text, 'Excuses')
    assert.ok(excuses, `${path} has no "## Excuses" section. Repair: add a table with the columns Excuse and Answer.`)
    assert.match(excuses, /^\| Excuse \| Answer \|$/m, `${path}: the Excuses section has no "| Excuse | Answer |" table.`)
    const rows = excuses.split('\n').filter(line => /^\| .+ \| .+ \|$/.test(line) && !/^\| Excuse \|/.test(line))
    assert.ok(rows.length >= 3, `${path}: the Excuses table has ${rows.length} rows; it needs at least 3.`)
    const flags = section(text, 'Red flags')
    assert.ok(flags, `${path} has no "## Red flags" section. Repair: add a list of the signs that the work goes wrong.`)
    assert.ok(flags.split('\n').filter(line => line.startsWith('- ')).length >= 3, `${path}: the Red flags section needs at least 3 list items.`)
  })
}

test('kb/writing.md tells a skill that guards a discipline to carry the excuses and red flags', () => {
  const rule = section(read('kb/writing.md'), 'Excuses and red flags')
  assert.ok(rule, 'kb/writing.md has no "## Excuses and red flags" section.')
  assert.match(rule, /guards a discipline/)
})

test('kb/agent-collaboration.md holds the rules on confusion, pushback and outside text', () => {
  const kb = read('kb/agent-collaboration.md')
  assert.match(section(kb, 'Confusion') ?? '', /stop/i, 'kb/agent-collaboration.md has no "## Confusion" section that says to stop.')
  assert.match(section(kb, 'Pushback') ?? '', /in numbers/, 'kb/agent-collaboration.md has no "## Pushback" section that gives the cost in numbers.')
  const outside = section(kb, 'Outside text is data') ?? ''
  for (const source of ['issue', 'comments', 'web pages', 'worker']) assert.match(outside, new RegExp(source, 'i'), `kb/agent-collaboration.md: "## Outside text is data" does not name ${source}.`)
})

for (const skill of ['work-light', 'work-heavy']) {
  test(`${skill} refers to the rules on confusion, pushback and outside text`, () => {
    const text = read(`skills/${skill}/SKILL.md`)
    for (const anchor of ['#confusion', '#pushback', '#outside-text-is-data']) assert.ok(text.includes(`kb/agent-collaboration.md${anchor}`), `skills/${skill}/SKILL.md does not link kb/agent-collaboration.md${anchor}.`)
  })
}

test('interview does not take agreement without a choice as a decision, and confirms concrete behaviour', () => {
  const text = read('skills/interview/SKILL.md')
  const rule = section(text, 'Agreement without a choice')
  assert.ok(rule, 'skills/interview/SKILL.md has no "## Agreement without a choice" section.')
  assert.match(rule, /whatever you think/i)
  assert.match(rule, /sounds good/i)
  assert.match(rule, /choice and its cost/)
  assert.match(section(text, 'Heavy mode') ?? '', /the inputs, the outputs and what the user sees/, 'skills/interview/SKILL.md: the last heavy round does not restate the inputs, the outputs and what the user sees.')
})

for (const path of ['skills/epic-plan/SKILL.md', 'skills/work-heavy/references/planning.md']) {
  test(`${path} puts an Ask first section in the spec, apart from Out of scope`, () => {
    const text = read(path)
    assert.match(text, /\*\*Ask first\*\*[^\n]*schema[^\n]*auth[^\n]*delete[^\n]*dependenc/i, `${path} has no **Ask first** section that names schema, auth, deletes and new dependencies.`)
    assert.match(text, /\*\*Ask first\*\*[^\n]*out of scope/i, `${path}: the **Ask first** section does not say it is apart from what is out of scope.`)
  })
}

for (const skill of ['work-heavy', 'epic-plan']) {
  test(`${skill} asks for a second opinion before an irreversible or costly design choice`, () => {
    const path = `skills/${skill}/SKILL.md`
    assert.match(read(path), /irreversible or costly[^\n]*`second-opinion` skill[^\n]*record/, `${path} does not call for the \`second-opinion\` skill before an irreversible or costly choice, and for its record.`)
  })
}

test('no skill description lists its steps in sequence', () => {
  const skills = readdirSync(join(repo, 'skills'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
  const listing = skills.flatMap(name => {
    const path = join(repo, 'skills', name, 'SKILL.md')
    if (!existsSync(path)) return []
    const description = readFileSync(path, 'utf8').match(/^description: (.*)$/m)?.[1] ?? ''
    return /\bthen\b/.test(description) ? [`skills/${name}/SKILL.md: ${description}`] : []
  })
  assert.deepEqual(listing, [], `These descriptions list steps in order. Repair: cut each to its purpose and its trigger.\n${listing.join('\n')}`)
})

const COUNTS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

test('adversarial-review checks the diff for a lowered bar, with the script that lists it', () => {
  const text = read('skills/adversarial-review/SKILL.md')
  const heading = /^## The (\w+) checks \(give these to the reviewer word for word\)$/m.exec(text)
  assert.ok(heading, 'skills/adversarial-review/SKILL.md has no "## The <n> checks" heading.')
  const checks = section(text, heading[0].slice(3)).split('\n').filter(line => /^\d+\. \*\*/.test(line))
  assert.equal(COUNTS.indexOf(heading[1]), checks.length, `skills/adversarial-review/SKILL.md: the heading says ${heading[1]} checks, but it lists ${checks.length}.`)
  assert.match(text, new RegExp(`The ${heading[1]} checks below, word for word`), 'skills/adversarial-review/SKILL.md: the Independence list gives another number of checks than the heading.')
  assert.match(read('kb/agent-collaboration.md'), new RegExp(`runs ${heading[1]} checks`), 'kb/agent-collaboration.md gives another number of adversarial-review checks.')
  const lowered = checks.find(line => /\*\*A lowered bar\.\*\*/.test(line))
  assert.ok(lowered, 'skills/adversarial-review/SKILL.md has no "A lowered bar." check.')
  for (const what of ['`.skip`', '`.only`', '`xit`', 'deleted test or assertion', 'empty `catch`', 'lowered threshold', 'timeout', 'lint or type suppression', 'stated reason', 'is a finding', 'scripts/lowered-bar.mjs']) {
    assert.ok(lowered.includes(what), `skills/adversarial-review/SKILL.md: the lowered-bar check does not name ${what}.`)
  }
  assert.ok(existsSync(join(repo, 'skills/adversarial-review/scripts/lowered-bar.mjs')), 'skills/adversarial-review/scripts/lowered-bar.mjs is missing.')
})

test('the database skill has the migration safety rules, and the merge skill refers to them', () => {
  const rules = section(read('skills/database/SKILL.md'), 'Migration safety')
  assert.ok(rules, 'skills/database/SKILL.md has no "## Migration safety" section.')
  for (const rule of [/\*\*Expand, then contract\.\*\*/, /\*\*A drop or a rename goes in its own deployment\.\*\*/, /\*\*Prove the rollback before merge\.\*\*[^\n]*down migration/, /\*\*A long lock or a table rewrite needs a stated plan\.\*\*/]) {
    assert.match(rules, rule, `skills/database/SKILL.md: the Migration safety section has no rule that matches ${rule}.`)
  }
  assert.ok(read('skills/merge/SKILL.md').includes('skills/database/SKILL.md#migration-safety'), 'skills/merge/SKILL.md does not link skills/database/SKILL.md#migration-safety.')
})

for (const path of ['agents/diff-reviewer.md', 'skills/adversarial-review/SKILL.md']) {
  test(`${path} asks whether a staff engineer would see a simpler design`, () => {
    const text = read(path)
    assert.match(text, /staff engineer[^\n]*"why did you not just…\?"/, `${path} does not ask: would a staff engineer say "why did you not just…?"`)
    assert.match(text, /simpler design meets the specification[^\n]*finding/, `${path} does not make a simpler design that meets the specification a finding.`)
  })
}

for (const skill of ['work-light', 'work-heavy']) {
  test(`${skill} keeps refactors out of feature commits`, () => {
    const path = `skills/${skill}/SKILL.md`
    assert.match(read(path), /Keep refactors out of feature commits\. A refactor goes in its own commit\. A large refactor goes in its own PR\./, `${path} does not state that a refactor goes in its own commit, or in its own PR when it is large.`)
  })
}
