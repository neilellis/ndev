// Proves that EVERY In progress / In review card is peer-checked, not only the
// cards this pass intends to dispatch an agent at.
//
// Before this, peerCandidateNumbers took only the four dispatch actions
// (revise / resume / close-out / smoke) plus the startable Ready cards. A card
// sitting In progress that the scan classified `untracked` (no claude/issue-<n>
// PR) or `awaiting-review` was never measured at all. Those are precisely the
// cards a live session holds: a peer working outside the pipeline moves its card
// to In progress and opens no PR the scan recognises, so the pass reported it as
// "not pipeline-owned, left alone" with no idea a session was live in it.
//
// The function under test is EXTRACTED FROM work_ready_workflow.js, not imported
// from a copy. The workflow runtime evaluates that file as one script, so the
// function has to live inline there; testing a duplicate would let the two drift
// and leave this suite green while the shipped code is wrong.
import { readFileSync } from 'node:fs'

const SRC = new URL('./work_ready_workflow.js', import.meta.url)
const src = readFileSync(SRC, 'utf8')
const m = src.match(/\/\/ --- BEGIN peerCandidateNumbers[\s\S]*?\n([\s\S]*?)\/\/ --- END peerCandidateNumbers ---/)
if (!m) {
  console.log('CANNOT MEASURE: the peerCandidateNumbers block was not found in work_ready_workflow.js.')
  console.log('That is not a pass — the shipped code is untested.')
  process.exit(2)
}
const peerCandidateNumbers = new Function(m[1] + '\nreturn peerCandidateNumbers')()

let pass = 0, fail = 0
const ok  = (msg) => { pass++; console.log('  ok   — ' + msg) }
const bad = (msg) => { fail++; console.log('  FAIL — ' + msg) }

// 1. The defect: a card In progress with no pipeline PR went unmeasured.
{
  const r = peerCandidateNumbers([{ number: 1407, action: 'untracked' }], [])
  r.includes(1407)
    ? ok('an untracked In progress card is peer-checked')
    : bad('an untracked In progress card was not measured: ' + JSON.stringify(r))
}

// 2. A green PR nobody is dispatched at is still held by whoever pushed it.
{
  const r = peerCandidateNumbers([{ number: 1586, action: 'awaiting-review' }], [])
  r.includes(1586)
    ? ok('an awaiting-review card is peer-checked')
    : bad('an awaiting-review card was not measured: ' + JSON.stringify(r))
}

// 3. The cases that already worked must keep working.
{
  const r = peerCandidateNumbers(
    [{ number: 1, action: 'resume' }, { number: 2, action: 'close-out' }],
    [{ number: 3 }],
  )
  ;[1, 2, 3].every((n) => r.includes(n))
    ? ok('dispatch actions and startable Ready cards are still measured')
    : bad('a previously measured number was dropped: ' + JSON.stringify(r))
}

// 4. One number, one check. A card in both lists must not be measured twice —
//    peer_activity.sh spawns processes, and a duplicate is a wasted one.
{
  const r = peerCandidateNumbers([{ number: 9, action: 'resume' }], [{ number: 9 }])
  r.filter((n) => n === 9).length === 1
    ? ok('a number present in both lists is measured once')
    : bad('duplicate candidate: ' + JSON.stringify(r))
}

// 5. Nothing to check is an empty list, never a crash.
{
  const r = peerCandidateNumbers([], [])
  Array.isArray(r) && r.length === 0
    ? ok('an idle pass produces no candidates')
    : bad('expected an empty array, got ' + JSON.stringify(r))
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
