// Proves the one-agent-per-issue rule, in both directions.
//
// Live sessions were hit because prActions (revise/resume/smoke)
// and startable (Ready cards) are separate lists with no shared key. An issue present
// in both got TWO agents in one pass, each recreating the other's worktree. Releasing
// one agent did nothing, because the pass had already dispatched another.
//
// dedupeDispatch keeps the FIRST claim on an issue and rejects every later one.
// prActions run first, so an open PR outranks a fresh start — the conservative way
// round, since the PR is evidence that work already exists.
// The function under test is EXTRACTED FROM work_ready_workflow.js, not imported from
// a copy. The workflow runtime evaluates that file as one script, so the function has
// to live inline there; testing a duplicate would let the two drift and leave this
// suite green while the shipped code is wrong.
import { readFileSync } from 'node:fs'

const SRC = new URL('./work_ready_workflow.js', import.meta.url)
const src = readFileSync(SRC, 'utf8')
const m = src.match(/\/\/ --- BEGIN dedupeDispatch[\s\S]*?\n([\s\S]*?)\/\/ --- END dedupeDispatch ---/)
if (!m) {
  console.log('CANNOT MEASURE: the dedupeDispatch block was not found in work_ready_workflow.js.')
  console.log('That is not a pass — the shipped code is untested.')
  process.exit(2)
}
const dedupeDispatch = new Function(m[1] + '\nreturn dedupeDispatch')()

let pass = 0, fail = 0
const ok  = (m) => { pass++; console.log('  ok   — ' + m) }
const bad = (m) => { fail++; console.log('  FAIL — ' + m) }
const eq  = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// 1. The real failure: #1496 in both lists.
{
  const pr = [{ number: 1496, action: 'resume' }]
  const start = [{ number: 1496 }, { number: 1000 }]
  const r = dedupeDispatch(pr, start)
  eq(r.startable.map(i => i.number), [1000])
    ? ok('an issue already claimed by prActions is dropped from startable')
    : bad('startable still contains the claimed issue: ' + JSON.stringify(r.startable))
  r.rejected.length === 1 && r.rejected[0].number === 1496
    ? ok('the drop is reported, not silent')
    : bad('the drop was silent — that is how this stayed invisible')
}

// 2. Duplicates inside one list.
{
  const r = dedupeDispatch([{ number: 7, action: 'resume' }, { number: 7, action: 'revise' }], [])
  r.prActions.length === 1
    ? ok('a repeated issue inside prActions is collapsed to one')
    : bad('prActions dispatched ' + r.prActions.length + ' agents at one issue')
}
{
  const r = dedupeDispatch([], [{ number: 8 }, { number: 8 }])
  r.startable.length === 1
    ? ok('a repeated issue inside startable is collapsed to one')
    : bad('startable dispatched ' + r.startable.length + ' agents at one issue')
}

// 3. Must NOT over-collapse: distinct issues all survive.
{
  const r = dedupeDispatch([{ number: 1, action: 'resume' }], [{ number: 2 }, { number: 3 }])
  r.prActions.length === 1 && eq(r.startable.map(i => i.number), [2, 3])
    ? ok('distinct issues are all kept (the guard does not over-collapse)')
    : bad('the guard dropped work it should have kept')
}

// 4. Explicit exclusions, for issues a human has claimed.
{
  const r = dedupeDispatch([{ number: 1438, action: 'resume' }], [{ number: 1459 }], [1438, 1459])
  r.prActions.length === 0 && r.startable.length === 0
    ? ok('excluded issues are dispatched at by nobody')
    : bad('an excluded issue was still dispatched')
  r.rejected.filter(x => x.reason === 'excluded').length === 2
    ? ok('each exclusion is reported')
    : bad('exclusions were not reported')
}

// 5. A batch claims every issue it closes, not just its lead.
{
  const r = dedupeDispatch([], [{ number: 10, batch: [10, 11, 12] }, { number: 11 }])
  eq(r.startable.map(i => i.number), [10])
    ? ok('a member of a batch is not also dispatched on its own')
    : bad('issue 11 got its own agent as well as its batch: ' + JSON.stringify(r.startable))
}

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail === 0 ? 0 : 1)
