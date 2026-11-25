import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const read = path => readFileSync(join(repo, path), 'utf8')

function section(text, heading) {
  const lines = text.split('\n')
  const start = lines.indexOf(`## ${heading}`)
  assert.ok(start >= 0, `There is no "## ${heading}" section.`)
  const end = lines.findIndex((line, i) => i > start && /^#{1,2} /.test(line))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n')
}

test('epic-plan traces each requirement up to its source and reviews the spec against the source', () => {
  const plan = read('skills/epic-plan/SKILL.md')
  assert.match(plan, /\| `framing` \|.*\| `aim`, `sources`/, 'skills/epic-plan/SKILL.md: the phase table does not say that framing needs sources.')
  assert.match(section(plan, 'Framing'), /no source: <reason>/, 'skills/epic-plan/SKILL.md "## Framing" does not ask for the sources or "no source: <reason>".')
  assert.match(section(plan, 'Researching'), /source passage/, 'skills/epic-plan/SKILL.md "## Researching" does not have each R cite a source passage.')
  const specifying = section(plan, 'Specifying')
  assert.match(specifying, /every R has a source passage/i, 'skills/epic-plan/SKILL.md: the self-check does not cover "every R has a source".')
  assert.match(specifying, /every source passage of substance has an R/i, 'skills/epic-plan/SKILL.md: the self-check does not cover "every source passage of substance has an R".')
  assert.match(section(plan, 'Spec review'), /departures of the spec from the source/, 'skills/epic-plan/SKILL.md: the spec-review brief has no group for departures of the spec from the source.')
  assert.match(section(read('kb/workflow.md'), 'The epic workflow'), /\| `framing` \|.*\| `aim`, `sources`/, 'kb/workflow.md: the epic table does not say that framing needs sources.')
})

test('epic-coordinate accepts a departure from the spec or a ruling against it only with a D-entry', () => {
  const rulings = section(read('skills/epic-coordinate/SKILL.md'), 'Rulings')
  assert.match(rulings, /numbered D-entry in the spec's decisions log/, 'skills/epic-coordinate/SKILL.md "## Rulings" does not require a numbered D-entry in the decisions log.')
  assert.match(rulings, /what, why, the alternative and who ruled/, 'skills/epic-coordinate/SKILL.md: the D-entry does not hold what, why, the alternative and who ruled.')
  assert.match(rulings, /sub-issue PR or (in )?a spec PR/, 'skills/epic-coordinate/SKILL.md: the D-entry is not committed in the sub-issue PR or a spec PR.')
  assert.match(rulings, /reverses a decision the human made.*human/, 'skills/epic-coordinate/SKILL.md: a ruling that reverses a human decision does not still go to the human.')
})

const THREE_TESTS = /hard to reverse.*surprising later.*real trade-off/is

test('ADRs and the glossary are written in epic deciding and heavy interviews, and checked at closing', () => {
  const adr = read('kb/adr.md')
  assert.match(section(adr, 'When to write an ADR'), THREE_TESTS, 'kb/adr.md "## When to write an ADR" does not give the three tests.')
  const deciding = section(read('skills/epic-plan/SKILL.md'), 'Deciding')
  assert.match(deciding, THREE_TESTS, 'skills/epic-plan/SKILL.md "## Deciding" does not apply the three ADR tests to each ruled D.')
  assert.match(deciding, /docs\/adr\/NNNN-<decision>\.md/, 'skills/epic-plan/SKILL.md "## Deciding" does not name the ADR file.')
  assert.match(deciding, /linked from the D-entry/, 'skills/epic-plan/SKILL.md "## Deciding" does not link the ADR from the D-entry.')
  assert.match(deciding, /glossary/, 'skills/epic-plan/SKILL.md "## Deciding" does not put the spec terms in the project glossary.')
  const closing = section(read('skills/epic-coordinate/SKILL.md'), 'Closing')
  assert.match(closing, /`adrs`/, 'skills/epic-coordinate/SKILL.md "## Closing" does not name the ADRs in the closing evidence.')
  assert.match(closing, /glossary matches the as-built system/, 'skills/epic-coordinate/SKILL.md "## Closing" does not check the glossary.')
  assert.match(closing, /as-built/, 'skills/epic-coordinate/SKILL.md "## Closing" does not update the spec to the as-built state.')
  const heavy = section(read('skills/interview/SKILL.md'), 'Heavy mode')
  assert.match(heavy, /offer an ADR/i, 'skills/interview/SKILL.md "## Heavy mode" does not offer an ADR.')
  assert.match(heavy, THREE_TESTS, 'skills/interview/SKILL.md "## Heavy mode" does not give the three ADR tests.')
  assert.match(heavy, /glossary/, 'skills/interview/SKILL.md "## Heavy mode" does not write accepted terms to the glossary.')
  assert.match(section(read('kb/workflow.md'), 'The epic workflow'), /"adrs": \[/, 'kb/workflow.md: the closing JSON has no "adrs" list.')
})

test('epic framing writes a one-page core idea with acceptance examples, and the first slice proves it end to end', () => {
  const plan = read('skills/epic-plan/SKILL.md')
  const table = /\| `framing` \|.*\| `aim`, `sources`, `files` \(the core idea\) \|/
  assert.match(plan, table, 'skills/epic-plan/SKILL.md: the phase table does not say that framing needs the core idea in files.')
  const framing = section(plan, 'Framing')
  assert.match(framing, /one-page core idea/, 'skills/epic-plan/SKILL.md "## Framing" does not write the one-page core idea.')
  assert.match(framing, /central mechanism/, 'skills/epic-plan/SKILL.md "## Framing": the core idea does not hold the central mechanism.')
  assert.match(framing, /3 to 5 worked acceptance examples/, 'skills/epic-plan/SKILL.md "## Framing": the core idea does not hold 3 to 5 acceptance examples.')
  assert.match(framing, /A1: <input> → <expected output>/, 'skills/epic-plan/SKILL.md "## Framing" does not give the form of an acceptance example.')
  assert.match(framing, /human signs (it|the page) off/, 'skills/epic-plan/SKILL.md "## Framing": the human does not sign the core idea off.')
  assert.match(framing, /`prototype` skill/, 'skills/epic-plan/SKILL.md "## Framing" does not offer the optional prototype.')
  assert.match(framing, /linked from the spec/, 'skills/epic-plan/SKILL.md "## Framing": the prototype is not linked from the spec.')
  assert.match(section(plan, 'Specifying'), /opens with the core idea/, 'skills/epic-plan/SKILL.md "## Specifying": the spec does not open with the core idea.')
  assert.match(section(plan, 'Spec review'), /against the core idea/, 'skills/epic-plan/SKILL.md "## Spec review" does not check the design against the core idea.')
  assert.match(section(plan, 'Slicing'), /first sub-issue is a thin end-to-end slice.*one acceptance example/s, 'skills/epic-plan/SKILL.md "## Slicing": the first sub-issue is not a thin end-to-end slice that proves one acceptance example.')
  const guide = section(read('kb/workflow.md'), 'The epic workflow')
  assert.match(guide, table, 'kb/workflow.md: the epic table does not say that framing needs the core idea in files.')
  assert.match(guide, /3 to 5 acceptance examples/, 'kb/workflow.md: the epicPhase row does not name the acceptance examples of the core idea.')
})

test('epic slicing cuts vertical slices, gets the breakdown approved before filing, and keeps under the cap with child epics', () => {
  const plan = read('skills/epic-plan/SKILL.md')
  const table = /\| `slicing` \|.*\| `issues`, `approval` \|/
  assert.match(plan, table, 'skills/epic-plan/SKILL.md: the phase table does not say that slicing needs the approval.')
  const slicing = section(plan, 'Slicing')
  assert.match(slicing, /tracer-bullet/, 'skills/epic-plan/SKILL.md "## Slicing" does not cut tracer-bullet vertical slices.')
  assert.match(slicing, /narrow complete path.*verif(y|ied) (it )?alone/s, 'skills/epic-plan/SKILL.md "## Slicing": a slice is not a narrow complete path that can be verified alone.')
  assert.match(slicing, /[Pp]refactoring first/, 'skills/epic-plan/SKILL.md "## Slicing" does not put prefactoring first.')
  assert.match(slicing, /expand.contract/, 'skills/epic-plan/SKILL.md "## Slicing" does not use expand-contract for a wide refactor.')
  assert.match(slicing, /title, blocked by, what it delivers/, 'skills/epic-plan/SKILL.md "## Slicing" does not show the breakdown with title, blocked by and what it delivers.')
  assert.match(slicing, /before any issue is filed/, 'skills/epic-plan/SKILL.md "## Slicing": the human does not approve the breakdown before any issue is filed.')
  assert.match(slicing, /cap of 30 sub-issues/, 'skills/epic-plan/SKILL.md "## Slicing" does not give the cap of 30 sub-issues.')
  assert.match(slicing, /child epics?, each with its own part of the spec/, 'skills/epic-plan/SKILL.md "## Slicing" does not split above the cap into child epics with their own spec parts.')
  assert.match(slicing, /`capOverride`/, 'skills/epic-plan/SKILL.md "## Slicing" does not name the recorded override.')
  const guide = section(read('kb/workflow.md'), 'The epic workflow')
  assert.match(guide, table, 'kb/workflow.md: the epic table does not say that slicing needs the approval.')
  assert.match(guide, /cap of 30 sub-issues/, 'kb/workflow.md does not give the cap of 30 sub-issues.')
  assert.match(guide, /--cap-override/, 'kb/workflow.md does not name the CLI override of the cap.')
})

test('the epic spec keeps "Not yet specified" and "Out of scope" apart, slicing files nothing from the fog, and closing lists what remains', () => {
  const plan = read('skills/epic-plan/SKILL.md')
  const specifying = section(plan, 'Specifying')
  assert.match(specifying, /\*\*Not yet specified\*\*.*in scope.*not sharp enough/, 'skills/epic-plan/SKILL.md "## Specifying": the spec has no "Not yet specified" section for what is in scope and not sharp enough.')
  assert.match(specifying, /\*\*Out of scope\*\*.*ruled out.*reason/, 'skills/epic-plan/SKILL.md "## Specifying": the spec has no "Out of scope" section with the reason for each item.')
  const slicing = section(plan, 'Slicing')
  assert.match(slicing, /no sub-issue for an item that is Not yet specified/, 'skills/epic-plan/SKILL.md "## Slicing" files sub-issues for Not-yet-specified items.')
  assert.match(slicing, /back through deciding and a spec amendment/, 'skills/epic-plan/SKILL.md "## Slicing": a cleared item does not go back through deciding and a spec amendment.')
  assert.match(section(read('skills/epic-coordinate/SKILL.md'), 'Closing'), /still Not yet specified/, 'skills/epic-coordinate/SKILL.md "## Closing" does not list what is still Not yet specified.')
  const guide = section(read('kb/workflow.md'), 'The epic workflow')
  assert.match(guide, /"Not yet specified".*"Out of scope"/s, 'kb/workflow.md does not name the "Not yet specified" and "Out of scope" sections of the spec.')
  assert.match(guide, /no sub-issue for a Not yet specified item/, 'kb/workflow.md: slicing files sub-issues for Not-yet-specified items.')
  assert.match(guide, /closing report lists what is still Not yet specified/, 'kb/workflow.md: the closing report does not list what is still Not yet specified.')
})

test('epic closing runs the retro, the spec PR refers to the epic and never closes it, and the guide says when work is an epic', () => {
  const closing = section(read('skills/epic-coordinate/SKILL.md'), 'Closing')
  assert.match(closing, /retro skill.*coordinator session/s, 'skills/epic-coordinate/SKILL.md "## Closing" does not run the retro skill on the coordinator session.')
  assert.match(closing, /`remember`.*`dev-wiki`/s, 'skills/epic-coordinate/SKILL.md "## Closing" does not record the lessons with remember or dev-wiki.')
  const review = section(read('skills/epic-plan/SKILL.md'), 'Spec review')
  assert.match(review, /`Refs #<epic>`/, 'skills/epic-plan/SKILL.md "## Spec review": the spec PR does not use "Refs #<epic>".')
  assert.match(review, /never a closing keyword/, 'skills/epic-plan/SKILL.md "## Spec review" does not forbid a closing keyword in the spec PR.')
  assert.match(review, /`specPr`/, 'skills/epic-plan/SKILL.md "## Spec review" does not name specPr.')
  const guide = read('kb/workflow.md')
  const routing = /more than one PR, more than one agent session, or decisions that need a spec others will implement from/
  assert.match(section(guide, 'The epic workflow'), routing, 'kb/workflow.md "## The epic workflow" has no test for epic or heavy.')
  assert.match(section(guide, 'The epic workflow'), /--spec-pr/, 'kb/workflow.md does not name the spec PR check.')
  assert.match(section(guide, 'The epic workflow'), /retro skill/, 'kb/workflow.md: closing does not run the retro skill.')
  assert.match(read('hooks/register.ts'), routing, 'hooks/register.ts: the /dev help has no test for epic or heavy.')
})
