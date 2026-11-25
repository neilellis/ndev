import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const binary = process.env.NDEV_TEST_BINARY || fileURLToPath(new URL('../bin/ndev', import.meta.url))
const CORE_IDEA = '# Core idea\n\nAim: ship the work.\nMechanism: one store writes each record once.\n\nA1: an order → a receipt\nA2: a refund → a credit note\nA3: an empty cart → a refusal\n'
const PLAN = {
  framing: ['--aim', 'ship the work', '--source', 'no source: test fixture', '--file', 'core.md'],
  researching: ['--file', 'spec.md'], specifying: ['--file', 'spec.md'], deciding: [], 'spec-review': ['--file', 'spec.md', '--spec-pr', '50'], slicing: ['--approval', 'the human approved the breakdown table'],
}

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'ndev-epic-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const root = join(home, 'repo')
  mkdirSync(root)
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0)
  const env = { HOME: home, PATH: home + ':' + process.env.PATH, ORCA_AGENT_SESSION_ID: 'test-owner' }
  const responses = join(home, 'answers.json')
  const answers = {
    'repos/example/repo/issues/40': { number: 40, title: 'Test epic', state: 'open', id: 400 },
    'repos/example/repo': { default_branch: 'main' },
    'repos/example/repo/issues/40/sub_issues': [{ number: 41, title: 'Parent', state: 'open' }, { number: 42, title: 'Child', state: 'open' }],
    'repos/example/repo/issues/41/dependencies/blocked_by': [],
    'repos/example/repo/issues/42/dependencies/blocked_by': [{ number: 41 }],
    'repos/example/repo/pulls/50': { number: 50, state: 'open', merged: false, body: 'The spec of the epic.\n\nRefs #40' },
    'links:50': { closingIssuesReferences: [] },
    'repos/example/repo/pulls/61': { number: 61, state: 'open', merged: false, draft: false, head: { ref: 'parent', sha: 'abc' }, base: { ref: 'main' } },
    'repos/example/repo/pulls/62': { number: 62, state: 'open', merged: false, draft: false, head: { ref: 'child', sha: 'child-sha' }, base: { ref: 'parent' } },
    'repos/example/repo/pulls/63': { number: 63, state: 'open', merged: false, draft: false, head: { ref: 'sibling', sha: 'sibling-sha' }, base: { ref: 'parent' } },
  }
  const save = () => writeFileSync(responses, JSON.stringify(answers))
  save()
  writeFileSync(join(home, 'gh'), [
    '#!/usr/bin/env node', "const fs=require('node:fs')",
    "const path=process.argv[2] === 'pr' ? (process.argv.includes('closingIssuesReferences') ? 'links:' : 'checks:')+process.argv[4] : process.argv[2] === 'issue' ? 'closers:'+process.argv[4] : process.argv.slice(2).find(v => v.startsWith('repos/'))?.split('?')[0]",
    `const answer=JSON.parse(fs.readFileSync(${JSON.stringify(responses)}))[path] ?? (path?.startsWith('closers:') ? { closedByPullRequestsReferences: [] } : undefined)`,
    'if (!answer) {console.error("Unexpected gh call "+process.argv.slice(2).join(" ")); process.exit(9)}',
    'console.log(JSON.stringify(answer))',
  ].join('\n'), { mode: 0o755 })
  writeFileSync(join(root, '.neil-dev.json'), JSON.stringify({ github: { repo: 'example/repo' } }))
  writeFileSync(join(root, 'core.md'), CORE_IDEA)
  function call(...args) {
    const out = spawnSync(binary, ['epic', ...args, '--json'], { cwd: root, env, encoding: 'utf8' })
    assert.notEqual(out.stdout.trim(), '', `ndev epic ${args.join(' ')} exited ${out.status}: ${out.stderr || out.error?.message || 'no output'}`)
    return { status: out.status, ...JSON.parse(out.stdout) }
  }
  function ok(...args) {
    const r = call(...args)
    assert.equal(r.status, 0, JSON.stringify(r))
    return r.result
  }
  writeFileSync(join(home, 'orca'), [
    '#!/usr/bin/env node', "const fs=require('node:fs')",
    `const db=JSON.parse(fs.readFileSync(${JSON.stringify(responses)}))`,
    "const key=process.argv.slice(2,4).join(' ')",
    "const result=db['orca:'+key]",
    `fs.appendFileSync(${JSON.stringify(join(home, 'orca.log'))},JSON.stringify(process.argv.slice(2))+'\\n')`,
    `const marker=${JSON.stringify(join(home, 'during-send.once'))}`,
    "if(db['orca-during-send'] && !fs.existsSync(marker)) { fs.writeFileSync(marker,'started'); const cp=require('node:child_process'); const r=cp.spawnSync(db['orca-during-send'][0],db['orca-during-send'].slice(1),{encoding:'utf8',env:process.env}); fs.writeFileSync(marker+'.result',JSON.stringify({status:r.status,stdout:r.stdout,stderr:r.stderr})) }",
    "const target=process.argv[process.argv.indexOf('--to')+1]; const error=db['orca-error:'+key+':'+target] ?? db['orca-error:'+key]; if(error) { console.log(JSON.stringify({id:'local',ok:false,error,_meta:{runtimeId:null}})); process.exit(db['orca-exit:'+key] ?? 1) }",
    'console.log(JSON.stringify(result ? {ok:true,result} : {ok:false,error:{message:"Unexpected Orca command "+key}}))',
  ].join('\n'), { mode: 0o755 })
  return { root, home, env, answers, save, call, ok }
}

test('epic phases persist GitHub blocker links and a stacked implementer gets the open PR head', t => {
  const { root, home, answers, save, call, ok } = fixture(t)
  const started = ok('start', '40', '--run', 'run-1', '--repo-id', 'local')
  assert.equal(started.epic.state, 'framing')
  assert.match(started.nextGuidance ?? '', /ndev-epic-plan.*read all of NORTH_STAR\.md/)
  assert.equal(call('phase', '40', 'framing', '--evidence', 'interviewed').status, 2)
  ok('phase', '40', 'framing', '--evidence', 'interviewed', ...PLAN.framing)
  writeFileSync(join(root, 'spec.md'), 'the spec')
  for (const phase of ['researching', 'specifying', 'deciding', 'spec-review', 'slicing']) {
    ok('phase', '40', phase, '--evidence', 'accepted', ...PLAN[phase])
  }
  assert.deepEqual(ok('next', '40').frontier.ready.map(s => s.issue), [41])
  ok('issue', '40', '41', 'implementing', '--worker', 'worker-1', '--workspace', root)
  ok('issue', '40', '41', 'reviewing', '--pr', '61', '--worker', 'review-1')
  assert.deepEqual(ok('next', '40').frontier.stacked.map(s => s.sub.issue), [42])
  answers['repos/example/repo/pulls/61'].state = 'closed'
  save()
  assert.equal(call('brief', '40', '42', 'implementer').status, 1)
  answers['repos/example/repo/pulls/61'].state = 'open'
  save()
  const brief = ok('brief', '40', '42', 'implementer')
  assert.ok(brief.argv.includes('origin/parent'))
  assert.match(readFileSync(brief.path, 'utf8'), /Stacked on #41/)
  assert.equal(ok('status', '40').epic.issues['42'].stackedOn, 41)
  ok('issue','40','42','implementing','--worker','worker-2','--workspace',root)
  ok('issue','40','42','reviewing','--worker','review-2','--pr','62')
  assert.match(call('issue','40','42','verified','--verdict','approve').error.message,/unmerged #41/)
  Object.assign(answers['repos/example/repo/pulls/61'], { state: 'closed', merged: true, merge_commit_sha: 'abc' })
  answers['orca:orchestration send'] = { delivered: true, id: 'notice-1' }
  save()
  ok('issue','40','41','merged')
  ok('issue','40','41','merged')
  const deliveries = readFileSync(join(home,'orca.log'),'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(deliveries.length, 1)
  assert.ok(deliveries[0].includes('dispatch:worker-2'))
  assert.match(deliveries[0].join(' '),/Rebase #42.*retarget PR #62/)
  answers['repos/example/repo/pulls/62'] = { state: 'open', draft: false, merged: false, mergeable: true, head: { sha: 'def' }, base: { ref: 'parent' } }
  save()
  assert.match(call('issue','40','42','verified','--verdict','approve').error.message,/base parent/)
  answers['repos/example/repo/pulls/62'].base.ref = 'main'
  answers['repos/example/repo/pulls/62/files'] = []
  answers['checks:62'] = { headRefOid: 'stale', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] }
  save()
  assert.match(call('issue','40','42','verified','--verdict','approve').error.message,/head def/)
  answers['checks:62'].headRefOid = 'def'
  const checks = answers['checks:62'].statusCheckRollup
  checks.unshift({ name: 'ci', workflowName: 'release', status: 'COMPLETED', conclusion: 'FAILURE' })
  save()
  assert.match(call('issue','40','42','verified','--verdict','approve').error?.message ?? '', /ci.*FAILURE/)
  checks.shift()
  save()
  const verified = ok('issue','40','42','verified','--verdict','approve').epic.issues['42']
  assert.equal(verified.verification.sha, 'def')
  assert.equal(verified.stackedOn, undefined)
})

test('framing refuses without a source and records each source document or the reason there is none', t => {
  const f = fixture(t)
  f.ok('start', '40')
  const record = join(f.root, '.neil-dev.epic-40.json')
  const before = readFileSync(record, 'utf8')
  const refusals = [
    [[], 2, /--source/],
    [['--source', 'no source:'], 2, /no source: <reason>/],
    [['--source', 'no source: greenfield', '--source', 'https://example.test/brief'], 2, /no source.*alone/],
    [['--source', 'missing-prompt.md'], 1, /missing-prompt\.md/],
  ]
  for (const [extra, status, message] of refusals) {
    const result = f.call('phase', '40', 'framing', '--aim', 'ship', '--evidence', 'agreed', ...extra)
    assert.equal(result.status, status, JSON.stringify(result))
    assert.match(result.error.message, message)
    assert.equal(readFileSync(record, 'utf8'), before)
  }
  assert.deepEqual(f.ok('status', '40').nextAction, ['ndev', 'epic', 'phase', '40', 'framing', '--evidence', '<text>', '--aim', '<text>', '--source', '<path | link | no source: reason>', '--file', '<path>'])
  writeFileSync(join(f.root, 'prompt.md'), 'the customer prompt')
  const framed = f.ok('phase', '40', 'framing', '--aim', 'ship', '--evidence', 'agreed', '--file', 'core.md', '--source', 'prompt.md', '--source', 'https://example.test/brief').epic
  assert.deepEqual(framed.sources, [join(framed.root, 'prompt.md'), 'https://example.test/brief'])
  const other = fixture(t)
  other.ok('start', '40')
  assert.deepEqual(other.ok('phase', '40', 'framing', '--aim', 'ship', '--evidence', 'agreed', '--file', 'core.md', '--source', 'no source: an internal refactor with no outside brief').epic.sources, ['no source: an internal refactor with no outside brief'])
})

test('each departure from the spec goes to the decisions log: the implementer proposes a D-entry and the reviewer finds a missing one', t => {
  const f = fixture(t)
  const e = f.ok('start', '40', '--run', 'run-1', '--repo-id', 'local').epic
  e.state = 'coordinating'
  e.issues = { 41: { issue: 41, key: 'part', title: 'Part', blockedBy: [], rounds: 0, state: 'waiting' } }
  writeFileSync(join(f.root, '.neil-dev.epic-40.json'), JSON.stringify(e))
  const implementer = readFileSync(f.ok('brief', '40', '41', 'implementer').path, 'utf8')
  assert.match(implementer, /each departure from the spec with its proposed D-entry for the spec's decisions log: what, why, the alternative/)
  assert.match(implementer, /no departure is accepted without a D-entry/i)
  f.ok('issue', '40', '41', 'implementing', '--worker', 'worker-1', '--workspace', f.root)
  f.ok('issue', '40', '41', 'reviewing', '--pr', '61', '--worker', 'review-1')
  const reviewer = readFileSync(f.ok('brief', '40', '41', 'reviewer').path, 'utf8')
  assert.match(reviewer, /A departure from the spec with no numbered D-entry in the spec's decisions log is a finding/)
})

test('the parallel limit refuses an unblock back to work when every place is taken', t => {
  const f = fixture(t)
  const e = f.ok('start', '40', '--run', 'run-1', '--repo-id', 'local', '--parallel', '1').epic
  e.state = 'coordinating'
  e.issues = {
    41: { issue: 41, key: 'a', title: 'A', blockedBy: [], rounds: 0, state: 'implementing', implementer: 'w1' },
    42: { issue: 42, key: 'b', title: 'B', blockedBy: [], rounds: 0, state: 'blocked', previous: 'implementing', implementer: 'w2' },
  }
  writeFileSync(join(f.root, '.neil-dev.epic-40.json'), JSON.stringify(e))
  const r = f.call('issue', '40', '42', 'implementing')
  assert.equal(r.status, 1, JSON.stringify(r))
  assert.match(r.error.message, /all 1 parallel places are taken by #41/)
  assert.equal(f.ok('status', '40').epic.issues[42].state, 'blocked')
})

test('an unblock back to work goes through while a parallel place is free', t => {
  const f = fixture(t)
  const e = f.ok('start', '40', '--run', 'run-1', '--repo-id', 'local', '--parallel', '2').epic
  e.state = 'coordinating'
  e.issues = {
    41: { issue: 41, key: 'a', title: 'A', blockedBy: [], rounds: 0, state: 'implementing', implementer: 'w1' },
    42: { issue: 42, key: 'b', title: 'B', blockedBy: [], rounds: 0, state: 'blocked', previous: 'implementing', implementer: 'w2' },
  }
  writeFileSync(join(f.root, '.neil-dev.epic-40.json'), JSON.stringify(e))
  f.ok('issue', '40', '42', 'implementing')
  assert.equal(f.ok('status', '40').epic.issues[42].state, 'implementing')
})

test('framing needs the one-page core idea, with three to five acceptance examples', t => {
  const f = fixture(t)
  f.ok('start', '40')
  const record = join(f.root, '.neil-dev.epic-40.json')
  const before = readFileSync(record, 'utf8')
  const examples = count => Array.from({ length: count }, (_, i) => `A${i + 1}: input ${i + 1} → output ${i + 1}`).join('\n')
  writeFileSync(join(f.root, 'two.md'), `# Core idea\n${examples(2)}\n`)
  writeFileSync(join(f.root, 'six.md'), `# Core idea\n${examples(6)}\n`)
  writeFileSync(join(f.root, 'unfinished.md'), '# Core idea\nA1: TBD\nA2: TBD\nA3: TBD\n')
  const framing = ['phase', '40', 'framing', '--aim', 'ship', '--evidence', 'signed off by the human', '--source', 'no source: test fixture']
  const refusals = [
    [[], 2, /framing requires --file.*core idea/],
    [['--file', 'core.md', '--file', 'spec-notes.md'], 2, /one --file/],
    [['--file', 'absent.md'], 1, /absent\.md/],
    [['--file', 'two.md'], 1, /two\.md.*2 acceptance examples.*3 to 5/],
    [['--file', 'six.md'], 1, /six\.md.*6 acceptance examples.*3 to 5/],
    [['--file', 'unfinished.md'], 1, /unfinished\.md.*0 acceptance examples/],
  ]
  for (const [extra, status, message] of refusals) {
    const result = f.call(...framing, ...extra)
    assert.equal(result.status, status, JSON.stringify(result))
    assert.match(result.error.message, message)
    assert.equal(readFileSync(record, 'utf8'), before)
  }
  const framed = f.ok(...framing, '--file', 'core.md').epic
  assert.equal(framed.coreIdea, join(framed.root, 'core.md'))
  assert.deepEqual(framed.evidence.framing.files, [join(framed.root, 'core.md')])
})

test('slicing records the human approval of the breakdown and refuses above the cap of 30 without an override', t => {
  const f = fixture(t)
  f.ok('start', '40')
  const record = join(f.root, '.neil-dev.epic-40.json')
  for (const flag of ['--approval', '--cap-override']) assert.match(f.call('phase', '40', 'framing', '--evidence', 'x', ...PLAN.framing, flag, 'yes').error.message, new RegExp(`${flag} is only for slicing`))
  const slicing = JSON.parse(readFileSync(record, 'utf8'))
  slicing.state = 'slicing'
  writeFileSync(record, JSON.stringify(slicing))
  const children = count => {
    f.answers['repos/example/repo/issues/40/sub_issues'] = Array.from({ length: count }, (_, i) => ({ number: 101 + i, title: `Slice ${i + 1}`, state: 'open' }))
    for (let i = 0; i < count; i++) f.answers[`repos/example/repo/issues/${101 + i}/dependencies/blocked_by`] = []
    f.save()
  }
  const before = readFileSync(record, 'utf8')
  children(31)
  const refusals = [
    [[], 2, /slicing requires --approval/],
    [['--approval', 'approved'], 1, /31 sub-issues.*cap of 30.*Repair: .*child epics.*--cap-override/],
  ]
  for (const [extra, status, message] of refusals) {
    const result = f.call('phase', '40', 'slicing', '--evidence', 'filed', ...extra)
    assert.equal(result.status, status, JSON.stringify(result))
    assert.match(`${result.error.message} Repair: ${result.error.repair}`, message)
    assert.equal(readFileSync(record, 'utf8'), before)
  }
  const over = f.ok('phase', '40', 'slicing', '--evidence', 'filed', '--approval', 'Neil approved the 31 rows on 25 Nov', '--cap-override', 'the human keeps one epic for the migration').epic
  assert.equal(over.state, 'coordinating')
  assert.equal(over.evidence.slicing.approval, 'Neil approved the 31 rows on 25 Nov')
  assert.deepEqual(over.debts.map(d => [d.kind, d.note]), [['gate-override', 'Sliced 31 sub-issues, above the cap of 30: the human keeps one epic for the migration']])
  writeFileSync(record, before)
  children(30)
  const capped = f.ok('phase', '40', 'slicing', '--evidence', 'filed', '--approval', 'approved').epic
  assert.equal(Object.keys(capped.issues).length, 30)
  assert.equal(capped.debts, undefined)
})

test('spec-review reads the spec PR, and refuses a body that closes the epic or does not refer to it', t => {
  const f = fixture(t)
  f.ok('start', '40')
  const record = join(f.root, '.neil-dev.epic-40.json')
  assert.match(f.call('phase', '40', 'framing', '--evidence', 'x', ...PLAN.framing, '--spec-pr', '50').error.message, /--spec-pr is only for spec-review/)
  const review = JSON.parse(readFileSync(record, 'utf8'))
  review.state = 'spec-review'
  writeFileSync(record, JSON.stringify(review))
  writeFileSync(join(f.root, 'spec.md'), 'the spec')
  const bodies = { 51: 'The spec.\n\nCloses #40', 52: 'The spec.\n\nRefs #40\nfixes: example/repo#40', 53: 'The spec, with no link to the epic.', 54: 'The spec.\n\nRefs example/repo#40\nCloses #400' }
  for (const [n, body] of Object.entries(bodies)) {
    f.answers[`repos/example/repo/pulls/${n}`] = { number: Number(n), state: 'open', merged: false, body }
    f.answers[`links:${n}`] = { closingIssuesReferences: [] }
  }
  f.save()
  const before = readFileSync(record, 'utf8')
  const refusals = [
    [[], 2, /spec-review requires --spec-pr/],
    [['--spec-pr', '51'], 1, /Spec PR #51.*"Closes #40".*closes the epic.*Repair: .*Refs #40/],
    [['--spec-pr', '52'], 1, /Spec PR #52.*"fixes: example\/repo#40"/],
    [['--spec-pr', '53'], 1, /Spec PR #53.*does not say "Refs #40"/],
  ]
  for (const [extra, status, message] of refusals) {
    const result = f.call('phase', '40', 'spec-review', '--evidence', 'ruled', '--file', 'spec.md', ...extra)
    assert.equal(result.status, status, JSON.stringify(result))
    assert.match(`${result.error.message} Repair: ${result.error.repair}`, message)
    assert.equal(readFileSync(record, 'utf8'), before)
  }
  const reviewed = f.ok('phase', '40', 'spec-review', '--evidence', 'ruled', '--file', 'spec.md', '--spec-pr', '54').epic
  assert.equal(reviewed.state, 'slicing')
  assert.equal(reviewed.specPr, 54)
})

test('spec-review refuses a spec PR that GitHub links as closing the epic, though its body only says Refs', t => {
  const f = fixture(t)
  f.ok('start', '40')
  const record = join(f.root, '.neil-dev.epic-40.json')
  const review = JSON.parse(readFileSync(record, 'utf8'))
  review.state = 'spec-review'
  writeFileSync(record, JSON.stringify(review))
  writeFileSync(join(f.root, 'spec.md'), 'the spec')
  f.answers['repos/example/repo/pulls/55'] = { number: 55, state: 'open', merged: false, body: 'The spec.\n\nRefs #40' }
  f.answers['links:55'] = { closingIssuesReferences: [{ number: 40, url: 'https://github.com/Example/Repo/issues/40' }] }
  f.answers['links:50'] = { closingIssuesReferences: [{ number: 40, url: 'https://github.com/other/repo/issues/40' }, { number: 7, url: 'https://github.com/example/repo/issues/7' }] }
  f.save()
  const before = readFileSync(record, 'utf8')
  const result = f.call('phase', '40', 'spec-review', '--evidence', 'ruled', '--file', 'spec.md', '--spec-pr', '55')
  assert.equal(result.status, 1, JSON.stringify(result))
  assert.match(`${result.error.message} Repair: ${result.error.repair}`, /Spec PR #55: GitHub links it as closing the epic #40.*Repair: .*Development.*commit message.*gh pr view 55 --repo example\/repo --json closingIssuesReferences/)
  assert.equal(readFileSync(record, 'utf8'), before)
  assert.equal(f.ok('phase', '40', 'spec-review', '--evidence', 'ruled', '--file', 'spec.md', '--spec-pr', '50').epic.state, 'slicing')
})

test('slicing refuses while the epic issue is closed on GitHub', t => {
  const f = fixture(t)
  f.ok('start', '40')
  const record = join(f.root, '.neil-dev.epic-40.json')
  const slicing = JSON.parse(readFileSync(record, 'utf8'))
  slicing.state = 'slicing'
  slicing.specPr = 50
  writeFileSync(record, JSON.stringify(slicing))
  f.answers['repos/example/repo/issues/40'] = { ...f.answers['repos/example/repo/issues/40'], state: 'closed' }
  f.save()
  const before = readFileSync(record, 'utf8')
  const result = f.call('phase', '40', 'slicing', '--evidence', 'filed', '--approval', 'approved')
  assert.equal(result.status, 1, JSON.stringify(result))
  assert.match(`${result.error.message} Repair: ${result.error.repair}`, /Epic #40 is closed on GitHub.*Repair: gh issue reopen 40 --repo example\/repo.*spec PR #50/)
  assert.equal(readFileSync(record, 'utf8'), before)
  f.answers['repos/example/repo/issues/40'].state = 'open'
  f.save()
  assert.equal(f.ok('phase', '40', 'slicing', '--evidence', 'filed', '--approval', 'approved').epic.state, 'coordinating')
})

const IN_FLIGHT = { issue: 41, key: 'parent', title: 'Parent', blockedBy: [], rounds: 2, state: 'implementing', pr: 61, implementer: 'w1' }

function reslicing(t) {
  const f = fixture(t)
  const record = join(f.root, '.neil-dev.epic-40.json')
  const e = f.ok('start', '40').epic
  writeFileSync(record, JSON.stringify({ ...e, state: 'slicing', issues: { 41: IN_FLIGHT } }))
  return { f, record }
}

test('finishing a reslice keeps each sub-issue that has a record, and starts only the new ones as waiting', t => {
  const { f } = reslicing(t)
  f.answers['repos/example/repo/issues/40/sub_issues'][0].title = 'Parent v2'
  f.save()
  const e = f.ok('phase', '40', 'slicing', '--evidence', 'resliced', '--approval', 'approved').epic
  assert.deepEqual(e.issues['41'], { ...IN_FLIGHT, title: 'Parent v2' })
  assert.equal(e.issues['42'].state, 'waiting')
  assert.equal(e.state, 'coordinating')
})

test('a reslice after a sub-issue merged is refused, and names the import that keeps it', t => {
  const f = fixture(t)
  const record = join(f.root, '.neil-dev.epic-40.json')
  const e = f.ok('start', '40').epic
  writeFileSync(record, JSON.stringify({ ...e, state: 'slicing', issues: { 41: { ...IN_FLIGHT, state: 'merged' }, 42: { ...IN_FLIGHT, issue: 42, key: 'issue-42', title: 'Child', blockedBy: [41], pr: 62, implementer: 'w2' } } }))
  const before = readFileSync(record, 'utf8')
  const result = f.call('phase', '40', 'slicing', '--evidence', 'resliced', '--approval', 'approved')
  assert.equal(result.status, 1, JSON.stringify(result))
  assert.match(`${result.error.message} Repair: ${result.error.repair}`, /#41 is merged.*ndev epic import 40 --issues-file/)
  assert.equal(readFileSync(record, 'utf8'), before)
})

test('a reslice refuses to drop, rename or re-block a sub-issue that is in flight', t => {
  const { f, record } = reslicing(t)
  const before = readFileSync(record, 'utf8')
  const fail = (message, ...extra) => {
    const result = f.call('phase', '40', 'slicing', '--evidence', 'resliced', '--approval', 'approved', ...extra)
    assert.equal(result.status, 1, JSON.stringify(result))
    assert.match(`${result.error.message} Repair: ${result.error.repair}`, message)
    assert.equal(readFileSync(record, 'utf8'), before)
  }
  const sub = f.answers['repos/example/repo/issues/40/sub_issues']
  f.answers['repos/example/repo/issues/40/sub_issues'] = [sub[1]]
  f.answers['repos/example/repo/issues/42/dependencies/blocked_by'] = []
  f.save()
  fail(/drops #41, which is "implementing" with PR #61.*Keep #41/)
  f.answers['repos/example/repo/issues/40/sub_issues'] = sub
  f.answers['repos/example/repo/issues/42/dependencies/blocked_by'] = [{ number: 41 }]
  f.save()
  const file = join(f.root, 'issues.json')
  writeFileSync(file, JSON.stringify([{ issue: 41, key: 'other', blockedBy: [] }, { issue: 42, key: 'issue-42', blockedBy: [41] }]))
  fail(/#41 is "implementing".*key "parent".*"other"/, '--issues-file', file)
  sub.push({ number: 43, title: 'Sibling', state: 'open' })
  f.answers['repos/example/repo/issues/43/dependencies/blocked_by'] = []
  f.answers['repos/example/repo/issues/41/dependencies/blocked_by'] = [{ number: 43 }]
  f.save()
  fail(/#41 is "implementing".*blocked by \[\].*\[43\]/)
})

test('remote routing selects a repository on the requested server and keeps the reviewer on its original worktree', t => {
  const { root, answers, save, ok, call } = fixture(t)
  answers['orca:environment list'] = { environments: [{ id: 'host-1', name: 'Remote host' }] }
  answers['orca:repo list'] = { repos: [{ id: 'away', displayName: 'test', gitRemoteIdentity: { canonicalKey: 'github.com/example/repo' } }] }
  save()
  const result = ok('start','40','--run','run-1','--repo-id','local','--remote','Remote host','--remote-repo','name:test','--reviewer-model','test-model')
  assert.equal(result.epic.remoteRepo, 'id:away')
  const file = join(root,'.neil-dev.epic-40.json')
  const e = JSON.parse(readFileSync(file))
  e.state = 'coordinating'
  e.issues[41] = { issue: 41, key: 'part', title: 'Parent', state: 'waiting', blockedBy: [], rounds: 0 }
  writeFileSync(file,JSON.stringify(e))
  const impl = ok('brief','40','41','implementer')
  assert.ok(impl.argv.includes('host-1') && impl.argv.includes('id:away'))
  assert.match(readFileSync(impl.path, 'utf8'), /Read only the cited sections of `NORTH_STAR\.md`/)
  assert.equal(call('issue','40','41','implementing','--worker','w','--workspace','local::/repo').status,2)
  ok('issue','40','41','implementing','--worker','w','--workspace','away::/repo')
  ok('start','40','--local')
  const review = ok('brief','40','41','reviewer','--pr','61')
  assert.ok(review.argv.includes('id:away::/repo') && review.argv.includes('host-1'))
  assert.ok(review.argv.includes('test-model'))
  assert.match(readFileSync(review.path, 'utf8'), /Read only the cited sections of `NORTH_STAR\.md`/)
  assert.match(call('goto','done','--issue','40').error.message, /closing gate cannot be skipped/)
  assert.equal(ok('status','40').epic.state,'coordinating')
  e.state = 'closing'
  writeFileSync(file, JSON.stringify(e))
  const status = ok('status', '40')
  assert.match(status.nextGuidance ?? '', /ndev-epic-coordinate.*read all of NORTH_STAR\.md again from the default branch/)
  assert.deepEqual(status.nextAction.slice(0, 5), ['ndev', 'epic', 'phase', '40', 'closing'])
})

test('filing by title recovers an uncertain GitHub create and keeps a single epic issue', t => {
  const { root, home, ok, call } = fixture(t)
  const log = join(home, 'created.json')
  writeFileSync(join(home, 'gh'), [
    '#!/usr/bin/env node', "const fs=require('node:fs')",
    `const log=${JSON.stringify(log)}`,
    'const args=process.argv.slice(2)',
    "if(args[0] === 'issue' && args[1] === 'create') { fs.writeFileSync(log, JSON.stringify({ body: fs.readFileSync(0,'utf8'), calls: fs.existsSync(log) ? 2 : 1 })); console.error('lost receipt'); process.exit(1) }",
    "if(args[0] === 'issue' && args[1] === 'list') console.log(JSON.stringify([{number:44,body:JSON.parse(fs.readFileSync(log)).body}]))",
    "else if(args.includes('repos/example/repo/issues/44')) console.log(JSON.stringify({number:44,title:'A new epic',state:'open'}))",
    "else process.exit(2)",
  ].join('\n'), { mode: 0o755 })
  assert.equal(call('start', '--title','A new epic').status, 1)
  assert.equal(ok('start','--title','A new epic').epic.epic, 44)
  assert.equal(ok('start','--title','A new epic').epic.epic, 44)
  assert.equal(JSON.parse(readFileSync(log)).calls, 1)
  assert.equal(JSON.parse(readFileSync(join(root,'.neil-dev.epic-44.json'))).state, 'framing')
})

function importedFixture(t) {
  const f = fixture(t)
  const { answers, save, ok, root } = f
  const children = [1350, 1351, 1352, 1353, 1358, 1369, 1403, 1411, 1413, 1414, 1415]
  answers['repos/example/repo/issues/40/sub_issues'] = children.map(number => ({ number, title: `Child ${number}`, state: [1358, 1369, 1411].includes(number) ? 'closed' : 'open' }))
  const blockers = { 1350: [1369], 1351: [1369], 1352: [1369], 1353: [1369], 1358: [1369], 1403: [1358, 1401], 1415: [1414] }
  for (const n of [...children, 1401]) {
    answers[`repos/example/repo/issues/${n}/dependencies/blocked_by`] = (blockers[n] ?? []).map(number => ({ number }))
    answers[`repos/example/repo/issues/${n}/timeline`] = []
  }
  answers['repos/example/repo/issues/1401'] = { number: 1401, title: 'External writer', state: 'open' }
  const linked = (n, pr, merged) => {
    answers[`repos/example/repo/issues/${n}/timeline`].push({ event: 'cross-referenced', source: { issue: { pull_request: { url: `https://api.github.com/repos/example/repo/pulls/${pr}` } } } })
    answers[`repos/example/repo/pulls/${pr}`] = { number: pr, state: merged ? 'closed' : 'open', merged, merge_commit_sha: merged ? `sha-${pr}` : null, head: { ref: `branch-${pr}` } }
    answers[`links:${pr}`] = { closingIssuesReferences: [{ number: n, url: `https://github.com/example/repo/issues/${n}` }] }
  }
  linked(1358, 1431, true)
  linked(1369, 1371, true)
  linked(1411, 1412, true)
  linked(1350, 1419, false)
  linked(1401, 1402, false)
  answers['repos/example/repo/issues/1413/timeline'] = answers['repos/example/repo/issues/1411/timeline']
  save()
  const manifest = children.map(issue => ({ issue, key: `issue-${issue}`, kind: issue === 1413 ? 'human' : 'implementation', blockedBy: blockers[issue] ?? [] }))
  writeFileSync(join(root, 'import.json'), JSON.stringify(manifest))
  ok('start', '40', '--parallel', '3', '--local')
  const stateFile = join(root, '.neil-dev.epic-40.json')
  const e = JSON.parse(readFileSync(stateFile))
  e.state = 'slicing'
  writeFileSync(stateFile, JSON.stringify(e))
  return { ...f, stateFile, manifest, linked, import: () => f.call('import', '40', '--issues-file', 'import.json', '--evidence', 'reconciled existing epic') }
}

test('supported import verifies completed real children, preserves external and human gates, and reserves carried PR capacity', t => {
  const f = importedFixture(t)
  const imported = f.import()
  assert.equal(imported.status, 0, JSON.stringify(imported))
  const { epic, frontier } = imported.result
  assert.equal(epic.state, 'coordinating')
  for (const [n, pr] of [[1358, 1431], [1369, 1371], [1411, 1412]]) {
    assert.equal(epic.issues[n].state, 'merged')
    assert.equal(epic.issues[n].pr, pr)
    assert.equal(epic.issues[n].mergeSha, `sha-${pr}`)
  }
  assert.equal(epic.issues[1413].state, 'human-pending')
  assert.equal(epic.issues[1350].state, 'external')
  assert.equal(epic.issues[1350].pr, 1419)
  assert.equal(frontier.free, 2)
  assert.deepEqual(frontier.ready.map(s => s.issue), [1351, 1352])
  assert.ok(frontier.waitingOn.find(s => s.issue === 1403).open.includes(1401))
  assert.deepEqual(epic.issues[1403].blockedBy, [1358, 1401])
  assert.equal(epic.externalBlockers[1401].state, 'waiting')
  assert.equal(epic.externalBlockers[1401].pr, 1402)
  for (const n of [1413, 1350]) {
    assert.equal(f.call('brief', '40', String(n), 'implementer').status, 1)
    assert.equal(f.call('issue', '40', String(n), 'implementing', '--worker', 'duplicate').status, 1)
  }
  assert.equal(f.call('issue', '40', '1413', 'merged').status, 1)
  assert.equal(f.call('phase', '40', 'coordinating', '--evidence', 'not complete').status, 1)
  f.ok('issue', '40', '1351', 'implementing', '--worker', 'first')
  f.ok('issue', '40', '1352', 'implementing', '--worker', 'second')
  assert.equal(f.call('issue', '40', '1353', 'implementing', '--worker', 'overflow').status, 1)
  assert.equal(f.call('issue', '40', '1415', 'implementing', '--worker', 'out-of-order').status, 1)
  assert.equal(f.import().status, 0)
  assert.equal(f.ok('status', '40').epic.issues[1351].implementer, 'first')
  assert.equal(f.ok('next', '40').frontier.free, 0)
  assert.equal(f.ok('status', '40').epic.issues[1350].workspace, undefined)
})

test('import refuses closed unmerged or unrelated PR evidence and leaves the record unchanged', t => {
  const f = importedFixture(t)
  const before = readFileSync(f.stateFile, 'utf8')
  f.answers['repos/example/repo/pulls/1431'].merged = false
  f.save()
  const refused = f.import()
  assert.equal(refused.status, 1, JSON.stringify(refused))
  assert.match(refused.error.message, /#1358.*merged/)
  assert.equal(readFileSync(f.stateFile, 'utf8'), before)
  f.answers['repos/example/repo/pulls/1431'].merged = true
  f.answers['links:1431'].closingIssuesReferences = [{ number: 999, url: 'https://github.com/example/repo/issues/999' }]
  f.save()
  assert.equal(f.import().status, 1)
  assert.equal(readFileSync(f.stateFile, 'utf8'), before)
})

test('import refresh verifies external completion without dropping blockers and refuses partial lookup failure', t => {
  const f = importedFixture(t)
  assert.equal(f.import().status, 0)
  const before = readFileSync(f.stateFile, 'utf8')
  delete f.answers['repos/example/repo/issues/1401']
  f.save()
  const failed = f.import()
  assert.equal(failed.status, 1)
  assert.match(failed.error.message, /1401.*9|9.*1401/)
  assert.equal(readFileSync(f.stateFile, 'utf8'), before)
  f.answers['repos/example/repo/issues/1401'] = { number: 1401, title: 'External writer', state: 'closed' }
  Object.assign(f.answers['repos/example/repo/pulls/1402'], { state: 'closed', merged: true, merge_commit_sha: 'external-merge' })
  f.save()
  const refreshed = f.import()
  assert.equal(refreshed.status, 0, JSON.stringify(refreshed))
  assert.equal(refreshed.result.epic.externalBlockers[1401].state, 'merged')
  assert.ok(!refreshed.result.frontier.waitingOn.some(s => s.issue === 1403))
  assert.deepEqual(refreshed.result.epic.issues[1403].blockedBy, [1358, 1401])
})

test('import refuses ambiguous active PRs, changed dependencies and missing explicit human classification atomically', t => {
  const f = importedFixture(t)
  const before = readFileSync(f.stateFile, 'utf8')
  f.linked(1350, 1500, false)
  f.save()
  assert.equal(f.import().status, 1)
  assert.equal(readFileSync(f.stateFile, 'utf8'), before)
  f.answers['repos/example/repo/issues/1350/timeline'].pop()
  f.save()
  f.manifest.find(s => s.issue === 1403).blockedBy = [1358]
  writeFileSync(join(f.root, 'import.json'), JSON.stringify(f.manifest))
  assert.equal(f.import().status, 1)
  assert.equal(readFileSync(f.stateFile, 'utf8'), before)
  f.manifest.find(s => s.issue === 1403).blockedBy = [1358, 1401]
  delete f.manifest.find(s => s.issue === 1413).kind
  writeFileSync(join(f.root, 'import.json'), JSON.stringify(f.manifest))
  assert.equal(f.import().status, 1)
  assert.equal(readFileSync(f.stateFile, 'utf8'), before)
})

test('agent coordinator notification uses orchestration and reports saved revision on delivery failure', t => {
  const f = fixture(t)
  f.env.ORCA_AGENT_SESSION_ID = 'structworker_test'
  f.env.ORCA_TERMINAL_HANDLE = 'structworker_test'
  f.ok('start', '40')
  const failed = confirmedGoto(f, 'slicing')
  assert.equal(failed.status, 1, failed.stdout + failed.stderr)
  assert.match(failed.stdout, /saved at revision 2.*notification exited 0/)
  assert.equal(f.ok('status', '40').epic.state, 'slicing')
  const delivery = JSON.parse(readFileSync(join(f.home, 'orca.log'), 'utf8').trim())
  assert.deepEqual(delivery.slice(0, 2), ['orchestration', 'send'])
  assert.ok(delivery.includes('orca_session_id:structworker_test'))
})

function confirmedGoto(f, target) {
  return confirmed(f, 'goto', target)
}

function confirmed(f, verb, ...args) {
  const initial = f.ok(verb, ...args, '--issue', '40')
  const phrase = `confirm epic ${verb}${verb === 'goto' ? ' ' + args[0] : ''} 40 ${initial.nextAction.revision}`
  const script = `import os,pty,subprocess
m,s=pty.openpty()
os.write(m,${JSON.stringify(phrase + '\n')}.encode())
p=subprocess.Popen(${JSON.stringify([binary, 'epic', verb, ...args, '--issue', '40'])},stdin=s,stdout=s,stderr=s)
os.close(s)
while True:
 try:
  b=os.read(m,8192)
 except OSError: break
 if not b: break
 print(b.decode(),end='')
raise SystemExit(p.wait())
`
  return spawnSync('python3', ['-c', script], { cwd: f.root, env: f.env, encoding: 'utf8' })
}


test('legacy agent terminal addresses also use orchestration and successful delivery preserves the saved result', t => {
  const f = fixture(t)
  f.ok('start', '40')
  const stateFile = join(f.root, '.neil-dev.epic-40.json')
  const e = JSON.parse(readFileSync(stateFile))
  e.coordinator = { terminal: 'structworker_legacy' }
  writeFileSync(stateFile, JSON.stringify(e))
  f.answers['orca:orchestration send'] = { accepted: true, delivered: true, id: 'receipt' }
  f.save()
  const sent = confirmedGoto(f, 'slicing')
  assert.equal(sent.status, 0, sent.stdout + sent.stderr)
  assert.equal(f.ok('status', '40').epic.revision, 2)
  const delivery = JSON.parse(readFileSync(join(f.home, 'orca.log'), 'utf8').trim())
  assert.ok(delivery.includes('orca_session_id:structworker_legacy'))
})


test('import holds dependants of a carried PR and refuses closed human decisions without inventing approval', t => {
  const f = importedFixture(t)
  f.answers['repos/example/repo/issues/1353/dependencies/blocked_by'] = [{ number: 1350 }]
  f.manifest.find(s => s.issue === 1353).blockedBy = [1350]
  writeFileSync(join(f.root, 'import.json'), JSON.stringify(f.manifest))
  f.save()
  const imported = f.import()
  assert.equal(imported.status, 0, JSON.stringify(imported))
  assert.deepEqual(imported.result.frontier.waitingOn.find(s => s.issue === 1353).open, [1350])
  assert.ok(!imported.result.frontier.stacked.some(s => s.sub.issue === 1353))
  const before = readFileSync(f.stateFile, 'utf8')
  f.answers['repos/example/repo/issues/40/sub_issues'].find(s => s.number === 1413).state = 'closed'
  f.save()
  const refused = f.import()
  assert.equal(refused.status, 1, JSON.stringify(refused))
  assert.match(refused.error.message, /Human decision #1413.*cannot infer human approval/)
  assert.equal(readFileSync(f.stateFile, 'utf8'), before)
})


function managedStackFixture(t, sibling = false) {
  const f = fixture(t)
  if (sibling) {
    f.answers['repos/example/repo/issues/40/sub_issues'].push({ number: 43, title: 'Sibling', state: 'open' })
    f.answers['repos/example/repo/issues/43/dependencies/blocked_by'] = [{ number: 41 }]
    f.save()
  }
  f.ok('start', '40', '--run', 'run-1')
  f.ok('phase', '40', 'framing', '--evidence', 'agreed', ...PLAN.framing)
  writeFileSync(join(f.root, 'spec.md'), 'specification')
  for (const phase of ['researching', 'specifying', 'deciding', 'spec-review', 'slicing']) {
    f.ok('phase', '40', phase, '--evidence', 'accepted', ...PLAN[phase])
  }
  f.ok('issue', '40', '41', 'implementing', '--worker', 'parent-worker', '--workspace', f.root)
  f.ok('issue', '40', '41', 'reviewing', '--pr', '61', '--worker', 'parent-reviewer')
  f.ok('brief', '40', '42', 'implementer')
  f.ok('issue', '40', '42', 'implementing', '--worker', 'child-worker', '--workspace', f.root)
  f.ok('issue', '40', '42', 'reviewing', '--pr', '62', '--worker', 'child-reviewer')
  if (sibling) {
    f.ok('brief', '40', '43', 'implementer')
    f.ok('issue', '40', '43', 'implementing', '--worker', 'sibling-worker', '--workspace', f.root)
    f.ok('issue', '40', '43', 'reviewing', '--pr', '63', '--worker', 'sibling-reviewer')
    f.answers['repos/example/repo/pulls/63'] = { number: 63, state: 'open', merged: false, head: { ref: 'sibling', sha: 'sibling-sha' }, base: { ref: 'parent' } }
  }
  f.answers['repos/example/repo/issues/40/sub_issues'][0].state = 'closed'
  Object.assign(f.answers['repos/example/repo/pulls/61'], { state: 'closed', merged: true, merge_commit_sha: 'merged-parent' })
  f.answers['repos/example/repo/pulls/62'] = { number: 62, state: 'open', merged: false, head: { ref: 'child', sha: 'child-sha' }, base: { ref: 'parent' } }
  for (const [issue, pr] of [[41, 61], [42, 62], ...(sibling ? [[43, 63]] : [])]) {
    f.answers[`repos/example/repo/issues/${issue}/timeline`] = [{ event: 'cross-referenced', source: { issue: { pull_request: { url: `https://api.github.com/repos/example/repo/pulls/${pr}` } } } }]
    f.answers[`links:${pr}`] = { closingIssuesReferences: [{ number: issue, url: `https://github.com/example/repo/issues/${issue}` }] }
  }
  f.answers['orca:orchestration send'] = { accepted: true, delivered: true, id: 'handoff-receipt' }
  f.save()
  writeFileSync(join(f.root, 'refresh.json'), JSON.stringify([
    { issue: 41, key: 'parent', kind: 'implementation', blockedBy: [] },
    { issue: 42, key: 'child', kind: 'implementation', blockedBy: [41] },
    ...(sibling ? [{ issue: 43, key: 'sibling', kind: 'implementation', blockedBy: [41] }] : []),
  ]))
  return { ...f, refresh: () => f.call('import', '40', '--issues-file', 'refresh.json', '--evidence', 'refreshed merge'), deliveries: () => readFileSync(join(f.home, 'orca.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) }
}

test('import refresh sends the normal merge handoff to a managed stacked child exactly once', t => {
  const f = managedStackFixture(t)
  const imported = f.refresh()
  assert.equal(imported.status, 0, JSON.stringify(imported))
  const child = imported.result.epic.issues[42]
  assert.equal(child.handoff?.state, 'sent')
  assert.equal(child.handoff.blocker, 41)
  assert.match(child.handoff.message, /PR #61 is merged.*Rebase #42 onto origin\/main.*retarget PR #62 to main/)
  assert.equal(child.implementer, 'child-worker')
  assert.equal(child.reviewer, 'child-reviewer')
  assert.equal(child.workspace, f.root)
  assert.equal(child.stackedOn, 41)
  assert.equal(imported.result.epic.issues[41].mergeSha, 'merged-parent')
  assert.equal(f.deliveries().length, 1)
  assert.ok(f.deliveries()[0].includes('dispatch:child-worker'))
  assert.equal(f.refresh().status, 0)
  f.ok('issue', '40', '41', 'merged')
  assert.equal(f.deliveries().length, 1)
})

test('import handoff delivery failure saves a retryable merge and preserves the request on refresh', t => {
  const f = managedStackFixture(t)
  f.answers['orca-error:orchestration send'] = { message: 'lost handoff receipt', data: { orchestrationRequestId: 'request-rebase-42' } }
  f.answers['orca-exit:orchestration send'] = 17
  f.save()
  const failed = f.refresh()
  assert.equal(failed.status, 1, JSON.stringify(failed))
  assert.match(failed.error.message, /saved at revision.*dispatch:child-worker.*exited 17.*lost handoff receipt/)
  assert.match(failed.error.repair, /ndev epic issue 40 41 merged/)
  const saved = f.ok('status', '40').epic
  assert.equal(saved.issues[41].state, 'merged')
  assert.equal(saved.issues[42].handoff.state, 'sending')
  assert.equal(saved.issues[42].handoff.requestId, 'request-rebase-42')
  delete f.answers['orca-error:orchestration send']
  f.save()
  assert.equal(f.refresh().status, 0)
  assert.ok(f.deliveries()[1].includes('--retry-request'))
  assert.ok(f.deliveries()[1].includes('request-rebase-42'))
  f.ok('issue', '40', '41', 'merged')
  assert.equal(f.deliveries().length, 2)
})

test('import lookup failure neither saves the merge nor sends a stacked handoff', t => {
  const f = managedStackFixture(t)
  const file = join(f.root, '.neil-dev.epic-40.json')
  const before = readFileSync(file, 'utf8')
  delete f.answers['repos/example/repo/issues/42/timeline']
  f.save()
  const failed = f.refresh()
  assert.equal(failed.status, 1)
  assert.match(failed.error.message, /42.*9|9.*42/)
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.throws(() => f.deliveries(), /ENOENT/)
})


test('import does not resend an uncertain stacked handoff without a retry request', t => {
  const f = managedStackFixture(t)
  f.answers['orca-error:orchestration send'] = { message: 'no durable receipt' }
  f.save()
  assert.equal(f.refresh().status, 1)
  delete f.answers['orca-error:orchestration send']
  f.save()
  const refused = f.refresh()
  assert.equal(refused.status, 1)
  assert.match(refused.error.message, /saved at revision.*Delivery to child-worker is uncertain for #42/)
  assert.match(refused.error.repair, /Inspect the Orca Run mailbox/)
  assert.equal(f.deliveries().length, 1)
})

test('import repairs a previously saved managed merge that has no stacked handoff', t => {
  const f = managedStackFixture(t)
  const file = join(f.root, '.neil-dev.epic-40.json')
  const historical = JSON.parse(readFileSync(file, 'utf8'))
  Object.assign(historical.issues[41], { state: 'merged', mergeSha: 'merged-parent', mergedUnverified: true })
  writeFileSync(file, JSON.stringify(historical))
  const repaired = f.refresh()
  assert.equal(repaired.status, 0, JSON.stringify(repaired))
  assert.equal(repaired.result.epic.issues[42].handoff.state, 'sent')
  assert.equal(repaired.result.epic.issues[42].implementer, 'child-worker')
  assert.equal(f.deliveries().length, 1)
})


test('import retains the durable request when a retry loses its receipt', t => {
  const f = managedStackFixture(t)
  f.answers['orca-error:orchestration send'] = { message: 'lost receipt', data: { orchestrationRequestId: 'durable-request' } }
  f.save()
  assert.equal(f.refresh().status, 1)
  f.answers['orca-error:orchestration send'] = { message: 'retry transport failed' }
  f.save()
  const retried = f.refresh()
  assert.equal(retried.status, 1)
  assert.equal(f.ok('status', '40').epic.issues[42].handoff.requestId, 'durable-request')
  assert.match(retried.error.repair, /ndev epic issue 40 41 merged/)
  delete f.answers['orca-error:orchestration send']
  f.save()
  assert.equal(f.refresh().status, 0)
  assert.ok(f.deliveries()[2].includes('durable-request'))
})


test('overlapping import cannot discard an in-flight handoff receipt', t => {
  const f = managedStackFixture(t)
  f.answers['orca-error:orchestration send'] = { message: 'lost receipt', data: { orchestrationRequestId: 'overlap-request' } }
  f.answers['orca-exit:orchestration send'] = 17
  f.answers['orca-during-send'] = [binary, 'epic', 'import', '40', '--issues-file', 'refresh.json', '--evidence', 'overlapping refresh', '--json']
  f.save()
  const failed = f.refresh()
  assert.equal(failed.status, 1, JSON.stringify(failed))
  assert.match(failed.error.message, /exited 17.*lost receipt/)
  assert.equal(f.ok('status', '40').epic.issues[42].handoff.requestId, 'overlap-request')
  const overlap = JSON.parse(readFileSync(join(f.home, 'during-send.once.result'), 'utf8'))
  assert.equal(overlap.status, 5, overlap.stdout + overlap.stderr)
  assert.match(JSON.parse(overlap.stdout).error.message, /Another write holds.*40/)
  delete f.answers['orca-error:orchestration send']
  f.save()
  assert.equal(f.refresh().status, 0)
  assert.ok(f.deliveries()[1].includes('overlap-request'))
})

for (const requestId of [undefined, 'obsolete-request']) {
  test(`import ignores a merged child's obsolete handoff (${requestId ? 'retryable' : 'uncertain'})`, t => {
    const f = managedStackFixture(t)
    f.answers['orca-error:orchestration send'] = { message: 'lost receipt', ...(requestId ? { data: { orchestrationRequestId: requestId } } : {}) }
    f.save()
    assert.equal(f.refresh().status, 1)
    f.answers['repos/example/repo/issues/40/sub_issues'][1].state = 'closed'
    Object.assign(f.answers['repos/example/repo/pulls/62'], { state: 'closed', merged: true, merge_commit_sha: 'merged-child' })
    delete f.answers['orca-error:orchestration send']
    f.save()
    const refreshed = f.refresh()
    assert.equal(refreshed.status, 0, JSON.stringify(refreshed))
    assert.equal(refreshed.result.epic.issues[42].state, 'merged')
    assert.equal(refreshed.result.epic.issues[42].handoff.state, 'sending')
    f.ok('issue', '40', '41', 'merged')
    assert.equal(f.deliveries().length, 1)
  })
}


test('import saves the actual Orca orchestration request ID and retries that request', t => {
  const f = managedStackFixture(t)
  f.answers['orca-error:orchestration send'] = { code: 'runtime_unavailable', message: 'delivery outcome uncertain', data: { orchestrationRequestId: 'actual-orca-request' } }
  f.save()
  assert.equal(f.refresh().status, 1)
  assert.equal(f.ok('status', '40').epic.issues[42].handoff.requestId, 'actual-orca-request')
  delete f.answers['orca-error:orchestration send']
  f.save()
  assert.equal(f.refresh().status, 0)
  assert.ok(f.deliveries()[1].includes('actual-orca-request'))
})

test('import leaves a verified child detached from its old uncertain handoff', t => {
  const f = managedStackFixture(t)
  f.answers['orca-error:orchestration send'] = { message: 'no receipt' }
  f.save()
  assert.equal(f.refresh().status, 1)
  delete f.answers['orca-error:orchestration send']
  Object.assign(f.answers['repos/example/repo/pulls/62'], { draft: false, mergeable: true, base: { ref: 'main' } })
  f.answers['checks:62'] = { headRefOid: 'child-sha', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] }
  f.answers['repos/example/repo/pulls/62/files'] = []
  f.save()
  const verified = f.ok('issue', '40', '42', 'verified', '--verdict', 'approve').epic.issues[42]
  assert.equal(verified.stackedOn, undefined)
  const refreshed = f.refresh()
  assert.equal(refreshed.status, 0, JSON.stringify(refreshed))
  assert.equal(refreshed.result.epic.issues[42].state, 'verified')
  assert.equal(refreshed.result.epic.issues[42].handoff.state, 'sending')
  f.ok('issue', '40', '41', 'merged')
  assert.equal(f.deliveries().length, 1)
})


function hideOrca(f) {
  symlinkSync(process.execPath, join(f.home, 'node'))
  for (const command of ['git', 'dirname']) {
    const found = spawnSync('which', [command], { encoding: 'utf8' })
    assert.equal(found.status, 0, found.stderr)
    symlinkSync(found.stdout.trim(), join(f.home, command))
  }
  renameSync(join(f.home, 'orca'), join(f.home, 'orca-hidden'))
  f.env.PATH = f.home
}

test('a proven first launch failure stays pending and recovers when Orca is restored', t => {
  const f = managedStackFixture(t)
  hideOrca(f)
  const failed = f.refresh()
  assert.equal(failed.status, 1, JSON.stringify(failed))
  const h = f.ok('status', '40').epic.issues[42].handoff
  assert.equal(h.state, 'pending')
  assert.equal(h.error.code, 'ENOENT')
  assert.match(failed.error.message, /dispatch:child-worker.*127.*ENOENT/)
  assert.match(failed.error.repair, /orca --version.*ndev epic issue 40 41 merged/)
  renameSync(join(f.home, 'orca-hidden'), join(f.home, 'orca'))
  assert.equal(f.refresh().status, 0)
  assert.equal(f.deliveries().length, 1)
})

test('a failed launch while retrying a known request preserves the uncertain delivery state', t => {
  const f = managedStackFixture(t)
  f.answers['orca-error:orchestration send'] = { message: 'uncertain', data: { orchestrationRequestId: 'existing-request' } }
  f.save()
  assert.equal(f.refresh().status, 1)
  hideOrca(f)
  assert.equal(f.refresh().status, 1)
  const h = f.ok('status', '40').epic.issues[42].handoff
  assert.equal(h.state, 'sending')
  assert.equal(h.requestId, 'existing-request')
  renameSync(join(f.home, 'orca-hidden'), join(f.home, 'orca'))
  delete f.answers['orca-error:orchestration send']
  f.save()
  assert.equal(f.refresh().status, 0)
  assert.ok(f.deliveries()[1].includes('existing-request'))
})

test('an uncertain recipient does not prevent its independent sibling delivery or permit a blind retry', t => {
  const f = managedStackFixture(t, true)
  f.answers['orca-error:orchestration send:dispatch:child-worker'] = { message: 'ambiguous delivery' }
  f.save()
  const failed = f.refresh()
  assert.equal(failed.status, 1, JSON.stringify(failed))
  const saved = f.ok('status', '40').epic
  assert.equal(saved.issues[42].handoff.state, 'sending')
  assert.equal(saved.issues[43].handoff.state, 'sent')
  assert.equal(saved.issues[43].implementer, 'sibling-worker')
  assert.match(failed.error.message, /saved at revision.*#42.*dispatch:child-worker/)
  assert.equal(f.deliveries().length, 2)
  delete f.answers['orca-error:orchestration send:dispatch:child-worker']
  f.save()
  const retry = f.call('issue', '40', '41', 'merged')
  assert.equal(retry.status, 1)
  assert.match(retry.error.message, /uncertain for #42/)
  assert.match(retry.error.repair, /Inspect the Orca Run mailbox/)
  assert.equal(f.deliveries().length, 2)
})

test('handoff failure reports every recipient and retries an independent durable request', t => {
  const f = managedStackFixture(t, true)
  f.answers['orca-error:orchestration send:dispatch:child-worker'] = { message: 'ambiguous delivery' }
  f.answers['orca-error:orchestration send:dispatch:sibling-worker'] = { message: 'lost receipt', data: { orchestrationRequestId: 'sibling-request' } }
  f.save()
  const failed = f.refresh()
  assert.equal(failed.status, 1)
  assert.match(failed.error.message, /#42.*dispatch:child-worker.*#43.*dispatch:sibling-worker/)
  assert.equal(failed.error.details.failures.length, 2)
  assert.match(failed.error.repair, /Inspect the Orca Run mailbox/)
  assert.match(failed.error.repair, /ndev epic issue 40 41 merged/)
  delete f.answers['orca-error:orchestration send:dispatch:sibling-worker']
  f.save()
  const retry = f.refresh()
  assert.equal(retry.status, 1)
  assert.equal(retry.error.details.failures.length, 1)
  assert.equal(f.ok('status', '40').epic.issues[43].handoff.state, 'sent')
  assert.ok(f.deliveries()[2].includes('sibling-request'))
  assert.equal(f.deliveries().length, 3)
})

test('closing refuses prose without exact-sha suite and whole-epic review evidence', t => {
  const f = fixture(t)
  const e = f.ok('start', '40').epic
  e.state = 'closing'
  writeFileSync(join(f.root, '.neil-dev.epic-40.json'), JSON.stringify(e))
  const result = f.call('phase', '40', 'closing', '--evidence', 'everything passed')
  assert.equal(result.status, 1)
  assert.match(result.error.message, /closing.*structured|closing-file/i)
  assert.equal(f.ok('status', '40').epic.state, 'closing')
})

test('an unverified merge records skipped verification as structured debt', t => {
  const f = fixture(t)
  const e = f.ok('start', '40').epic
  e.state = 'coordinating'
  e.issues = { 41: { issue: 41, key: 'part', title: 'Part', blockedBy: [], rounds: 0, state: 'reviewing', pr: 61, reviewer: 'review-1' } }
  writeFileSync(join(f.root, '.neil-dev.epic-40.json'), JSON.stringify(e))
  Object.assign(f.answers['repos/example/repo/pulls/61'], { state: 'closed', merged: true, merge_commit_sha: 'b'.repeat(40) })
  f.save()
  const merged = f.ok('issue', '40', '41', 'merged').epic
  assert.equal(merged.debts?.length, 2)
  assert.equal(merged.debts[0].kind, 'merge-without-review')
  assert.equal(merged.debts[1].kind, 'skipped-check')
  assert.equal(merged.debts[1].sub, 41)
  assert.equal(merged.debts[1].check, 'verification')
  assert.equal(merged.debts[1].ruling, undefined)
})

function closingFixture(t) {
  const f = fixture(t)
  const git = (...args) => {
    const out = spawnSync('git', args, { cwd: f.root, env: f.env, encoding: 'utf8' })
    assert.equal(out.status, 0, out.stderr)
    return out.stdout.trim()
  }
  git('config', 'user.name', 'Epic Test')
  git('config', 'user.email', 'epic@example.test')
  git('checkout', '-qb', 'main')
  mkdirSync(join(f.root, 'tests'))
  writeFileSync(join(f.root, 'tests/all.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('the full fixture suite',()=>assert.equal(2+2,4))\n")
  writeFileSync(join(f.root, 'spec.md'), '# Spec\nR1: First requirement.\nR-2: Second requirement.\n\n## Decisions log\nD1: Keep one store.\n')
  git('add', '.')
  git('commit', '-qm', 'Original baseline')
  const base = git('rev-parse', 'HEAD')
  const command = [process.execPath, '--test']
  const suitesFile = join(f.home, 'suites.json')
  writeFileSync(suitesFile, JSON.stringify([command]))
  const e = f.ok('start', '40', '--base-sha', base, '--coordinator-model', 'author-model', '--posture', 'deadline', '--full-suites-file', suitesFile).epic
  writeFileSync(join(f.root, 'feature.txt'), 'implemented\n')
  git('add', 'feature.txt')
  git('commit', '-qm', 'Combined implementation')
  const sha = git('rev-parse', 'HEAD')
  f.answers['repos/example/repo/commits/main'] = { sha }
  f.save()
  e.state = 'closing'
  e.evidence.specifying = { text: 'Spec accepted', at: 1, files: [join(f.root, 'spec.md')] }
  e.issues = { 41: { issue: 41, key: 'part', title: 'Part', blockedBy: [], rounds: 0, state: 'merged', pr: 61, reviewer: 'reviewer-41', verdict: 'approve' } }
  const record = join(f.root, '.neil-dev.epic-40.json')
  writeFileSync(record, JSON.stringify(e))
  const suite = spawnSync(command[0], command.slice(1), { cwd: f.root, env: f.env, encoding: 'utf8' })
  assert.equal(suite.status, 0, suite.stdout + suite.stderr)
  const log = join(f.home, 'full-suite.log')
  writeFileSync(log, suite.stdout + suite.stderr)
  const receipt = { sha, branch: 'main', suites: [{ command, exitCode: suite.status, sha, log, skippedChecks: [] }], review: {
    baseSha: base, sha, model: 'review-model', reviewer: 'whole-epic-reviewer',
    requirements: [{ id: 'R1', status: 'done', evidence: 'tests/all.test.mjs' }, { id: 'R-2', status: 'done', evidence: 'feature.txt' }], findings: [],
  }, adrs: [] }
  const proof = join(f.home, 'closing.json')
  const close = value => { writeFileSync(proof, JSON.stringify(value)); return f.call('phase', '40', 'closing', '--evidence', 'Whole epic verified', '--closing-file', proof) }
  return { ...f, git, base, sha, record, receipt, proof, close }
}

test('closing records the exact default-branch suite and complete independent requirement review', t => {
  const f = closingFixture(t)
  const result = f.close(f.receipt)
  assert.equal(result.status, 0, JSON.stringify(result.error))
  assert.equal(result.result.epic.state, 'done')
  assert.equal(result.result.epic.closing.sha, f.sha)
  assert.equal(result.result.epic.closing.suites[0].exitCode, 0)
  assert.deepEqual(result.result.epic.closing.review.requirements.map(row => row.id), ['R1', 'R-2'])
})

test('closing evidence names the ADR of each ruled decision, and each ADR is committed at the closing SHA', t => {
  const f = closingFixture(t)
  const before = readFileSync(f.record, 'utf8')
  const refusals = [
    [receipt => { delete receipt.adrs }, /adrs/],
    [receipt => { receipt.adrs = [{ decision: 'three', path: 'docs/adr/0001-keep-one-store.md' }] }, /D-id/],
    [receipt => { receipt.adrs = [{ decision: 'D1', path: 'notes/keep-one-store.md' }] }, /docs\/adr\/NNNN-<slug>\.md/],
    [receipt => { receipt.adrs = [{ decision: 'D1', path: 'docs/adr/0001-keep-one-store.md' }, { decision: 'D1', path: 'docs/adr/0002-keep-it-again.md' }] }, /D1.*twice/],
    [receipt => { receipt.adrs = [{ decision: 'D7', path: 'docs/adr/0001-keep-one-store.md' }] }, /D7 is not in the decisions log/],
    [receipt => { receipt.adrs = [{ decision: 'D1', path: 'docs/adr/0002-not-written.md' }] }, /docs\/adr\/0002-not-written\.md.*D1.*not committed/],
  ]
  for (const [change, message] of refusals) {
    const receipt = structuredClone(f.receipt)
    change(receipt)
    const result = f.close(receipt)
    assert.equal(result.status, 1, JSON.stringify(result))
    assert.match(result.error.message, message)
    assert.equal(readFileSync(f.record, 'utf8'), before)
  }
  mkdirSync(join(f.root, 'docs/adr'), { recursive: true })
  writeFileSync(join(f.root, 'docs/adr/0001-keep-one-store.md'), '# Keep one store\n')
  f.git('add', 'docs')
  f.git('commit', '-qm', 'Record the store decision')
  const sha = f.git('rev-parse', 'HEAD')
  f.answers['repos/example/repo/commits/main'] = { sha }
  f.save()
  const receipt = structuredClone(f.receipt)
  Object.assign(receipt, { sha, adrs: [{ decision: 'D1', path: 'docs/adr/0001-keep-one-store.md' }] })
  receipt.suites[0].sha = sha
  receipt.review.sha = sha
  const closed = f.close(receipt)
  assert.equal(closed.status, 0, JSON.stringify(closed.error))
  assert.deepEqual(closed.result.epic.closing.adrs, [{ decision: 'D1', path: 'docs/adr/0001-keep-one-store.md' }])
})

test('closing refuses stale, partial, same-model or failed evidence without changing the epic', t => {
  const f = closingFixture(t)
  const before = readFileSync(f.record, 'utf8')
  const changes = [
    receipt => { receipt.sha = 'f'.repeat(40) },
    receipt => { receipt.suites[0].exitCode = 9 },
    receipt => { receipt.suites = [] },
    receipt => { receipt.review.baseSha = 'e'.repeat(40) },
    receipt => { receipt.review.model = 'AUTHOR-MODEL' },
    receipt => { receipt.review.reviewer = 'test-owner' },
    receipt => { receipt.review.requirements.pop() },
    receipt => { receipt.review.findings.push({ id: 'F1', evidence: 'reader and writer disagree' }) },
    receipt => { receipt.review.requirements[0].status = 'missing' },
    receipt => { receipt.suites[0].skippedChecks = ['integration'] },
  ]
  for (const change of changes) {
    const receipt = structuredClone(f.receipt)
    change(receipt)
    const result = f.close(receipt)
    assert.equal(result.status, 1, JSON.stringify(receipt))
    assert.equal(readFileSync(f.record, 'utf8'), before)
  }
})

test('closing requires the clean live default branch, not an equivalent feature checkout', t => {
  const f = closingFixture(t)
  f.git('checkout', '-qb', 'feature')
  assert.match(f.close(f.receipt).error.message, /default branch/)
  f.git('checkout', '-q', 'main')
  writeFileSync(join(f.root, 'feature.txt'), 'uncommitted change')
  assert.match(f.close(f.receipt).error.message, /clean default branch/)
  f.git('checkout', '--', 'feature.txt')
  f.answers['repos/example/repo/commits/main'] = { sha: 'd'.repeat(40) }
  f.save()
  assert.match(f.close(f.receipt).error.message, /Closing SHA/)
})

test('deadline debt remains visible and blocks closing until every item has a ruling', t => {
  const f = closingFixture(t)
  const debt = join(f.home, 'debt.json')
  writeFileSync(debt, JSON.stringify({ key: `closing:${f.sha}:suite:0:skip:0`, kind: 'skipped-check', check: 'integration', note: 'Deferred at the deadline' }))
  f.ok('debt', '40', '--file', debt)
  f.ok('debt', '40', '--file', debt)
  assert.equal(f.ok('status', '40').debt.length, 1)
  assert.match(f.close(f.receipt).error.message, /closing:.*ruling/)
  const ruling = join(f.home, 'ruling.json')
  writeFileSync(ruling, JSON.stringify({ verdict: 'accepted', reason: 'The owner accepts the remaining integration risk' }))
  f.ok('ruling', '40', `closing:${f.sha}:suite:0:skip:0`, '--file', ruling)
  f.receipt.suites[0].skippedChecks = ['integration']
  assert.equal(f.close(f.receipt).status, 0)
})

test('merging before reviewing requires an explicit override and records each omitted gate', t => {
  const f = fixture(t)
  const e = f.ok('start', '40', '--posture', 'deadline').epic
  e.state = 'coordinating'
  e.issues = { 41: { issue: 41, key: 'part', title: 'Part', blockedBy: [], rounds: 0, state: 'implementing' } }
  writeFileSync(join(f.root, '.neil-dev.epic-40.json'), JSON.stringify(e))
  Object.assign(f.answers['repos/example/repo/pulls/61'], { state: 'closed', merged: true, merge_commit_sha: 'b'.repeat(40) })
  f.save()
  assert.match(f.call('issue', '40', '41', 'merged', '--pr', '61').error.message, /#41 is implementing.*--override/)
  const merged = f.ok('issue', '40', '41', 'merged', '--pr', '61', '--override', 'Owner requested the emergency merge').epic
  assert.deepEqual(merged.debts.map(debt => debt.kind), ['merge-without-review', 'skipped-check', 'gate-override'])
  assert.equal(merged.posture, 'deadline')
})

test('closing preserves the original base, model and full-suite roster', t => {
  const f = closingFixture(t)
  assert.match(f.call('start', '40', '--base-sha', 'c'.repeat(40)).error.message, /cannot be replaced/)
  assert.match(f.call('start', '40', '--coordinator-model', 'replacement').error.message, /cannot be replaced/)
  const file = join(f.home, 'new-suites.json')
  writeFileSync(file, JSON.stringify([['true']]))
  assert.match(f.call('start', '40', '--full-suites-file', file).error.message, /cannot.*remove/)
  assert.equal(f.close(f.receipt).status, 0)
})

test('fixed and issue-filed debt require evidence and a real issue', t => {
  const f = closingFixture(t)
  const event = join(f.home, 'debt.json'), ruling = join(f.home, 'ruling.json')
  writeFileSync(event, JSON.stringify({ key: 'docs', kind: 'gate-override', note: 'Docs check omitted' }))
  f.ok('debt', '40', '--file', event)
  writeFileSync(ruling, JSON.stringify({ verdict: 'fixed', reason: 'Repaired' }))
  assert.match(f.call('ruling', '40', 'docs', '--file', ruling).error.message, /evidence/)
  writeFileSync(ruling, JSON.stringify({ verdict: 'issue-filed', reason: 'Track remaining work', issue: 90 }))
  f.answers['repos/example/repo/issues/90'] = { number: 90, state: 'open', pull_request: {} }
  f.save()
  assert.match(f.call('ruling', '40', 'docs', '--file', ruling).error.message, /follow-up issue #90/)
  f.answers['repos/example/repo/issues/90'] = { number: 90, state: 'open' }
  f.save()
  f.ok('ruling', '40', 'docs', '--file', ruling)
  assert.equal(f.close(f.receipt).status, 0)
})

test('a historical accepted check omission cannot waive a closing-suite skip', t => {
  const f = closingFixture(t)
  const e = JSON.parse(readFileSync(f.record, 'utf8'))
  e.debts = [{ key: 'old-integration', kind: 'skipped-check', sub: 41, check: 'integration', note: 'Old PR skipped integration', at: 1, ruling: { verdict: 'accepted', reason: 'Old risk accepted' } }]
  writeFileSync(f.record, JSON.stringify(e))
  f.receipt.suites[0].skippedChecks = ['integration']
  const result = f.close(f.receipt)
  assert.equal(result.status, 1, 'historical debt must not let this new closing skip pass')
  assert.match(result.error.message, /closing.*integration.*debt/i)
})

function stackedFixture(t, child) {
  const f = fixture(t)
  const e = f.ok('start', '40').epic
  e.state = 'coordinating'
  e.issues = {
    41: { issue: 41, key: 'parent', title: 'Parent', blockedBy: [], rounds: 0, state: 'merged', pr: 61, reviewer: 'r1', verdict: 'approve' },
    42: { issue: 42, key: 'child', title: 'Child', blockedBy: [41], rounds: 0, state: 'reviewing', pr: 62, reviewer: 'r2', verdict: 'approve', stackedOn: 41 },
  }
  writeFileSync(join(f.root, '.neil-dev.epic-40.json'), JSON.stringify(e))
  Object.assign(f.answers['repos/example/repo/pulls/61'], { state: 'closed', merged: true, merged_at: '2026-11-02T00:00:00Z' })
  f.answers['repos/example/repo/pulls/62'] = { number: 62, state: 'closed', merged: true, head: { ref: 'child', sha: 'c' }, base: { ref: 'parent' }, ...child }
  f.save()
  return f
}

test('a merged move refuses a stacked PR merged into the branch of an open blocker', t => {
  const f = stackedFixture(t, { merged_at: '2026-11-01T00:00:00Z' })
  Object.assign(f.answers['repos/example/repo/pulls/61'], { state: 'open', merged: false })
  f.save()
  const result = f.call('issue', '40', '42', 'merged')
  assert.equal(result.status, 1)
  assert.match(result.error.message, /PR #62.*parent.*PR #61 of #41.*not merged/)
  assert.equal(f.ok('status', '40').epic.issues['42'].state, 'reviewing')
})

test('a merged move records a stacked PR when its blocker merged after it', t => {
  const f = stackedFixture(t, { merged_at: '2026-11-01T00:00:00Z' })
  f.ok('issue', '40', '42', 'merged')
  assert.equal(f.ok('status', '40').epic.issues['42'].state, 'merged')
})

test('a stacked PR merged after its blocker merged is blocked with the repair, and a new PR into main ends the block', t => {
  const f = stackedFixture(t, { merged_at: '2026-11-03T00:00:00Z' })
  const result = f.call('issue', '40', '42', 'merged')
  assert.equal(result.status, 1)
  assert.match(result.error.message, /after PR #61.*not on main/)
  assert.match(JSON.stringify(result.error), /gh pr create --repo example\/repo --base main --head child/)
  const sub = f.ok('status', '40').epic.issues['42']
  assert.equal(sub.state, 'blocked')
  assert.equal(sub.previous, 'reviewing')
  assert.match(sub.note, /gh pr create --repo example\/repo --base main --head child/)
  f.answers['repos/example/repo/pulls/65'] = { number: 65, state: 'closed', merged: true, head: { ref: 'child', sha: 'd' }, base: { ref: 'main' } }
  f.save()
  f.ok('issue', '40', '42', 'merged', '--pr', '65', '--override', 'the change of PR #62 merged again through PR #65')
  assert.deepEqual([f.ok('status', '40').epic.issues['42'].state, f.ok('status', '40').epic.issues['42'].pr], ['merged', 65])
})

test('a stacked PR whose blocker PR closed unmerged is blocked, and a second lost PR from blocked keeps previous', t => {
  const f = stackedFixture(t, { merged_at: '2026-11-02T00:00:00Z' })
  Object.assign(f.answers['repos/example/repo/pulls/61'], { state: 'closed', merged: false })
  f.save()
  const result = f.call('issue', '40', '42', 'merged')
  assert.equal(result.status, 1)
  assert.match(result.error.message, /PR #62.*closed.*not on main/)
  assert.deepEqual([f.ok('status', '40').epic.issues['42'].state, f.ok('status', '40').epic.issues['42'].previous], ['blocked', 'reviewing'])
  f.answers['repos/example/repo/pulls/64'] = { number: 64, state: 'closed', merged: true, head: { ref: 'child-b', sha: 'e' }, base: { ref: 'parent' }, merged_at: '2026-11-04T00:00:00Z' }
  f.save()
  const again = f.call('issue', '40', '42', 'merged', '--pr', '64', '--override', 'merged again')
  assert.equal(again.status, 1)
  assert.match(JSON.stringify(again.error), /PR #64[\s\S]*--head child-b/)
  const sub = f.ok('status', '40').epic.issues['42']
  assert.deepEqual([sub.state, sub.previous, sub.pr], ['blocked', 'reviewing', 62])
})

test('a blocked sub-issue whose PR was not lost cannot take another PR with an override', t => {
  const f = stackedFixture(t, { base: { ref: 'main' }, merged: false, state: 'open' })
  f.ok('issue', '40', '42', 'blocked', '--note', 'waiting for a human')
  f.answers['repos/example/repo/pulls/66'] = { number: 66, state: 'closed', merged: true, head: { ref: 'other', sha: 'f' }, base: { ref: 'main' } }
  f.save()
  const result = f.call('issue', '40', '42', 'merged', '--pr', '66', '--override', 'swap')
  assert.equal(result.status, 1)
  assert.match(result.error.message, /PR #62.*PR #66/)
})

test('an unblock and a new block end the PR swap that a lost PR allows', t => {
  const f = stackedFixture(t, { merged_at: '2026-11-03T00:00:00Z' })
  assert.equal(f.call('issue', '40', '42', 'merged').status, 1)
  f.ok('issue', '40', '42', 'reviewing')
  f.ok('issue', '40', '42', 'blocked', '--note', 'waiting for a human')
  f.answers['repos/example/repo/pulls/66'] = { number: 66, state: 'closed', merged: true, head: { ref: 'other', sha: 'f' }, base: { ref: 'main' } }
  f.save()
  const result = f.call('issue', '40', '42', 'merged', '--pr', '66', '--override', 'swap')
  assert.equal(result.status, 1)
  assert.match(result.error.message, /PR #62.*PR #66/)
})

test('a merged move refuses a PR merged into a branch that is neither the default branch nor its blocker branch', t => {
  const f = stackedFixture(t, { base: { ref: 'release' }, merged_at: '2026-11-01T00:00:00Z' })
  const result = f.call('issue', '40', '42', 'merged')
  assert.equal(result.status, 1)
  assert.match(result.error.message, /"release".*"main"/)
  assert.equal(f.ok('status', '40').epic.issues['42'].state, 'reviewing')
})

test('a merged move cannot transfer review evidence to a different PR', t => {
  const f = fixture(t)
  const e = f.ok('start', '40').epic
  e.state = 'coordinating'
  e.issues = { 41: { issue: 41, key: 'part', title: 'Part', blockedBy: [], rounds: 0, state: 'reviewing', pr: 61, reviewer: 'reviewer', verdict: 'approve' } }
  writeFileSync(join(f.root, '.neil-dev.epic-40.json'), JSON.stringify(e))
  f.answers['repos/example/repo/pulls/62'] = { number: 62, state: 'closed', merged: true }
  f.save()
  const result = f.call('issue', '40', '41', 'merged', '--pr', '62')
  assert.equal(result.status, 1, 'PR61 review cannot authorize PR62')
  assert.match(result.error.message, /PR #61.*PR #62/)
})

test('status reports the active epic, its next action and sub-issues without a write', t => {
  const f = fixture(t)
  f.ok('start', '40')
  const file = join(f.root, '.neil-dev.epic-40.json')
  const e = JSON.parse(readFileSync(file))
  e.state = 'coordinating'
  e.issues = { 41: { issue: 41, key: 'part', title: 'Part', blockedBy: [], rounds: 0, state: 'waiting' } }
  writeFileSync(file, JSON.stringify(e))
  const before = readFileSync(file, 'utf8')
  const status = f.ok('status')
  assert.equal(status.epic.epic, 40)
  assert.deepEqual(status.nextAction, ['ndev', 'epic', 'next', '40'])
  assert.deepEqual(status.frontier.ready.map(s => s.issue), [41])
  assert.equal(readFileSync(file, 'utf8'), before)
  f.env.ORCA_AGENT_SESSION_ID = 'another-session'
  assert.equal(f.ok('status').epic, null)
})

test('start of a named epic resumes its record and gives the coordinator the next step', t => {
  const f = fixture(t)
  f.ok('start', '40')
  f.ok('phase', '40', 'framing', '--evidence', 'interviewed', ...PLAN.framing)
  const resumed = f.ok('start', '40')
  assert.equal(resumed.epic.state, 'researching')
  assert.equal(resumed.epic.evidence.framing.text, 'interviewed')
  assert.equal(resumed.epic.coordinator.session, 'test-owner')
  assert.deepEqual(resumed.nextAction, ['ndev', 'epic', 'phase', '40', 'researching', '--evidence', '<text>', '--file', '<path>'])
})

test('skip saves the human evidence, moves one phase and notifies the coordinator', t => {
  const f = fixture(t)
  f.ok('start', '40')
  f.answers['orca:orchestration send'] = { accepted: true, delivered: true, id: 'receipt' }
  f.save()
  const skipped = confirmed(f, 'skip', 'framing settled by the owner')
  assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr)
  const e = f.ok('status', '40').epic
  assert.equal(e.state, 'researching')
  assert.equal(e.evidence.framing.text, 'framing settled by the owner')
  assert.ok(e.debts.some(d => d.kind === 'gate-override' && d.note === 'framing settled by the owner'))
  const delivery = JSON.parse(readFileSync(join(f.home, 'orca.log'), 'utf8').trim())
  assert.deepEqual(delivery.slice(0, 2), ['orchestration', 'send'])
  assert.ok(delivery.includes('orca_session_id:test-owner'))
  assert.match(delivery.join(' '), /from framing to researching/)
})

test('goto rejects an unknown phase without a write or a notice', t => {
  const f = fixture(t)
  f.ok('start', '40')
  const file = join(f.root, '.neil-dev.epic-40.json')
  const before = readFileSync(file, 'utf8')
  const refused = f.call('goto', 'nowhere', '--issue', '40')
  assert.equal(refused.status, 2)
  assert.match(refused.error.message, /Invalid target phase for goto: nowhere/)
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.throws(() => readFileSync(join(f.home, 'orca.log')), { code: 'ENOENT' })
})

test('off keeps the record and restores the issue workflow of the coordinating session', t => {
  const f = fixture(t)
  f.ok('start', '40')
  const flow = () => spawnSync(binary, ['flow', 'checkpoint', '--issue', '7', '--json'], { cwd: f.root, env: f.env, encoding: 'utf8' }).stdout
  assert.match(flow(), /coordinates epic #40/)
  f.answers['orca:orchestration send'] = { accepted: true, delivered: true, id: 'receipt' }
  f.save()
  const off = confirmed(f, 'off')
  assert.equal(off.status, 0, off.stdout + off.stderr)
  const kept = JSON.parse(readFileSync(join(f.root, '.neil-dev.epic-40.json')))
  assert.equal(kept.off, true)
  assert.equal(kept.state, 'framing')
  assert.equal(kept.owner, undefined)
  assert.equal(f.ok('status').epic, null)
  assert.match(flow(), /issue #7 has no workflow/)
  assert.match(readFileSync(join(f.home, 'orca.log'), 'utf8'), /Human ended coordination of epic #40/)
})

test('goto and skip refuse a done epic, name the new-epic path, and write nothing', t => {
  const f = fixture(t)
  f.ok('start', '40')
  const file = join(f.root, '.neil-dev.epic-40.json')
  const e = JSON.parse(readFileSync(file, 'utf8'))
  e.state = 'done'
  writeFileSync(file, JSON.stringify(e))
  const before = readFileSync(file, 'utf8')
  for (const [verb, ...args] of [['goto', 'coordinating'], ['skip']]) {
    const refused = f.call(verb, ...args, '--issue', '40')
    assert.equal(refused.status, 1, JSON.stringify(refused))
    assert.match(refused.error.message, /Epic #40 is done/)
    assert.match(refused.error.repair, /ndev epic start --title/)
    assert.equal(readFileSync(file, 'utf8'), before)
  }
  assert.throws(() => readFileSync(join(f.home, 'orca.log')), { code: 'ENOENT' })
})

test('an implementer brief refuses a sub-issue that has started and an epic outside coordinating, and names the state', t => {
  const f = fixture(t)
  const e = f.ok('start', '40', '--run', 'run-1', '--repo-id', 'local').epic
  e.state = 'coordinating'
  e.issues = { 41: { issue: 41, key: 'part', title: 'Part', blockedBy: [], rounds: 0, state: 'waiting' }, 43: { issue: 43, key: 'other', title: 'Other', blockedBy: [], rounds: 0, state: 'waiting' } }
  const file = join(f.root, '.neil-dev.epic-40.json')
  writeFileSync(file, JSON.stringify(e))
  f.ok('issue', '40', '41', 'implementing', '--worker', 'worker-1', '--workspace', f.root)
  const started = f.call('brief', '40', '41', 'implementer')
  assert.equal(started.status, 1, JSON.stringify(started))
  assert.match(started.error.message, /#41 is implementing/)
  assert.match(started.error.repair, /dispatch:worker-1/)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  saved.state = 'closing'
  writeFileSync(file, JSON.stringify(saved))
  const closing = f.call('brief', '40', '43', 'implementer')
  assert.equal(closing.status, 1, JSON.stringify(closing))
  assert.match(closing.error.message, /Epic #40 is closing/)
})

test('reviewing reads the PR on GitHub and refuses unless it is open and ready', t => {
  const f = fixture(t)
  const e = f.ok('start', '40', '--run', 'run-1', '--repo-id', 'local').epic
  e.state = 'coordinating'
  e.issues = { 41: { issue: 41, key: 'part', title: 'Part', blockedBy: [], rounds: 0, state: 'waiting' } }
  writeFileSync(join(f.root, '.neil-dev.epic-40.json'), JSON.stringify(e))
  f.ok('issue', '40', '41', 'implementing', '--worker', 'worker-1', '--workspace', f.root)
  for (const [over, shown] of [[{ draft: true }, /draft true/], [{ state: 'closed', draft: false }, /state closed/], [{ state: 'closed', merged: true, draft: false }, /merged true/]]) {
    Object.assign(f.answers['repos/example/repo/pulls/61'], { state: 'open', merged: false }, over)
    f.save()
    const refused = f.call('issue', '40', '41', 'reviewing', '--pr', '61', '--worker', 'review-1')
    assert.equal(refused.status, 1, JSON.stringify(refused))
    assert.match(refused.error.message, /PR #61 of #41 must be open and ready/)
    assert.match(refused.error.message, shown)
    assert.equal(f.ok('status', '40').epic.issues[41].state, 'implementing')
  }
  Object.assign(f.answers['repos/example/repo/pulls/61'], { state: 'open', merged: false, draft: false })
  f.save()
  assert.equal(f.ok('issue', '40', '41', 'reviewing', '--pr', '61', '--worker', 'review-1').epic.issues[41].state, 'reviewing')
})

test('a merged blocker names a stacked sub-issue that has no implementer to receive its rebase, and a new brief clears it', t => {
  const f = fixture(t)
  f.ok('start', '40', '--run', 'run-1', '--repo-id', 'local')
  f.ok('phase', '40', 'framing', '--evidence', 'agreed', ...PLAN.framing)
  writeFileSync(join(f.root, 'spec.md'), 'specification')
  for (const phase of ['researching', 'specifying', 'deciding', 'spec-review', 'slicing']) f.ok('phase', '40', phase, '--evidence', 'accepted', ...PLAN[phase])
  f.ok('issue', '40', '41', 'implementing', '--worker', 'parent-worker', '--workspace', f.root)
  f.ok('issue', '40', '41', 'reviewing', '--pr', '61', '--worker', 'parent-reviewer')
  f.ok('brief', '40', '42', 'implementer')
  assert.equal(f.ok('status', '40').epic.issues[42].stackedOn, 41)
  Object.assign(f.answers['repos/example/repo/pulls/61'], { state: 'closed', merged: true, merge_commit_sha: 'merged-parent' })
  f.save()
  const merged = f.call('issue', '40', '41', 'merged')
  assert.equal(merged.status, 1, JSON.stringify(merged))
  assert.match(merged.error.message, /#42 .*no implementer/)
  assert.match(merged.error.repair, /ndev epic brief 40 42 implementer/)
  assert.equal(f.ok('status', '40').epic.issues[41].state, 'merged')
  assert.throws(() => readFileSync(join(f.home, 'orca.log')), { code: 'ENOENT' })
  const fresh = f.ok('brief', '40', '42', 'implementer')
  assert.ok(fresh.argv.includes('origin/main'))
  assert.equal(f.ok('status', '40').epic.issues[42].stackedOn, undefined)
  f.ok('issue', '40', '41', 'merged')
})

test('a merged blocker gives a blocked stacked sub-issue the unblock repair, and reports an external one to its owner once', t => {
  const f = fixture(t)
  f.ok('start', '40', '--run', 'run-1', '--repo-id', 'local')
  f.ok('phase', '40', 'framing', '--evidence', 'agreed', ...PLAN.framing)
  writeFileSync(join(f.root, 'spec.md'), 'specification')
  for (const phase of ['researching', 'specifying', 'deciding', 'spec-review', 'slicing']) f.ok('phase', '40', phase, '--evidence', 'accepted', ...PLAN[phase])
  f.ok('issue', '40', '41', 'implementing', '--worker', 'parent-worker', '--workspace', f.root)
  f.ok('issue', '40', '41', 'reviewing', '--pr', '61', '--worker', 'parent-reviewer')
  f.ok('brief', '40', '42', 'implementer')
  f.ok('issue', '40', '42', 'blocked', '--note', 'waits for a key')
  Object.assign(f.answers['repos/example/repo/pulls/61'], { state: 'closed', merged: true, merge_commit_sha: 'merged-parent' })
  f.save()
  const blocked = f.call('issue', '40', '41', 'merged')
  assert.equal(blocked.status, 1, JSON.stringify(blocked))
  assert.match(blocked.error.message, /#42 is blocked .*no implementer/)
  assert.match(blocked.error.repair, /ndev epic issue 40 42 waiting.*ndev epic brief 40 42 implementer/)
  const file = join(f.root, '.neil-dev.epic-40.json')
  const e = JSON.parse(readFileSync(file, 'utf8'))
  Object.assign(e.issues[42], { state: 'external', pr: 62 })
  delete e.issues[42].previous
  writeFileSync(file, JSON.stringify(e))
  const external = f.call('issue', '40', '41', 'merged')
  assert.equal(external.status, 1, JSON.stringify(external))
  assert.match(external.error.message, /#42 is external .*no implementer/)
  assert.match(external.error.repair, /existing owner of #42/)
  f.ok('issue', '40', '41', 'merged')
  assert.throws(() => readFileSync(join(f.home, 'orca.log')), { code: 'ENOENT' })
})

test('issue 256: a done epic refuses new debt, names the epic and changes nothing', t => {
  const f = fixture(t)
  const e = f.ok('start', '40').epic
  e.state = 'done'
  const record = join(f.root, '.neil-dev.epic-40.json')
  writeFileSync(record, JSON.stringify(e))
  const before = readFileSync(record, 'utf8')
  const debt = join(f.home, 'debt.json')
  writeFileSync(debt, JSON.stringify({ key: 'late', kind: 'gate-override', note: 'Recorded after done' }))
  const result = f.call('debt', '40', '--file', debt)
  assert.equal(result.status, 1, JSON.stringify(result))
  assert.match(result.error.message, /late.*#40 is done/)
  assert.match(result.error.repair, /new issue/)
  assert.equal(readFileSync(record, 'utf8'), before)
})

test('issue 256: closing still takes new debt', t => {
  const f = fixture(t)
  const e = f.ok('start', '40').epic
  e.state = 'closing'
  writeFileSync(join(f.root, '.neil-dev.epic-40.json'), JSON.stringify(e))
  const debt = join(f.home, 'debt.json')
  writeFileSync(debt, JSON.stringify({ key: 'closing-skip', kind: 'skipped-check', check: 'integration', note: 'Deferred' }))
  assert.deepEqual(f.ok('debt', '40', '--file', debt).debt.map(d => d.key), ['closing-skip'])
})

test('issue 248: open review debt is capped at 4, the refusal names the debts to rule on, and a ruling frees a place', t => {
  const f = fixture(t)
  const e = f.ok('start', '40').epic
  e.state = 'coordinating'
  const record = join(f.root, '.neil-dev.epic-40.json')
  writeFileSync(record, JSON.stringify(e))
  const debt = join(f.home, 'debt.json'), ruling = join(f.home, 'ruling.json')
  const owe = key => { writeFileSync(debt, JSON.stringify({ key, kind: 'gate-override', note: `Override ${key}` })); return f.call('debt', '40', '--file', debt) }
  for (const key of ['d1', 'd2', 'd3', 'd4']) assert.equal(owe(key).status, 0)
  const before = readFileSync(record, 'utf8')
  const refused = owe('d5')
  assert.equal(refused.status, 1, JSON.stringify(refused))
  assert.match(refused.error.message, /d5.*4 open debts.*cap is 4/)
  assert.match(refused.error.repair, /d1, d2, d3, d4.*ndev epic ruling 40/)
  assert.equal(readFileSync(record, 'utf8'), before)
  assert.equal(owe('d4').status, 0)
  writeFileSync(ruling, JSON.stringify({ verdict: 'accepted', reason: 'The owner accepts it' }))
  f.ok('ruling', '40', 'd1', '--file', ruling)
  assert.equal(owe('d5').status, 0)
})

test('issue 248: a merge that would pass the debt cap records nothing', t => {
  const f = fixture(t)
  const e = f.ok('start', '40').epic
  e.state = 'coordinating'
  e.issues = { 41: { issue: 41, key: 'part', title: 'Part', blockedBy: [], rounds: 0, state: 'implementing' } }
  e.debts = ['d1', 'd2'].map(key => ({ key, kind: 'gate-override', note: `Override ${key}`, at: 1 }))
  const record = join(f.root, '.neil-dev.epic-40.json')
  writeFileSync(record, JSON.stringify(e))
  Object.assign(f.answers['repos/example/repo/pulls/61'], { state: 'closed', merged: true, merge_commit_sha: 'b'.repeat(40) })
  f.save()
  const before = readFileSync(record, 'utf8')
  const refused = f.call('issue', '40', '41', 'merged', '--pr', '61', '--override', 'Owner merged it')
  assert.equal(refused.status, 1, JSON.stringify(refused))
  assert.match(refused.error.message, /merge:41:pr:61:review, merge:41:pr:61:verification, merge:41:override.*2 open debts.*cap is 4/)
  assert.equal(readFileSync(record, 'utf8'), before)
})

test('issue 248: skip at the debt cap is refused and the epic stays in its phase', t => {
  const f = fixture(t)
  const e = f.ok('start', '40').epic
  e.debts = ['d1', 'd2', 'd3', 'd4'].map(key => ({ key, kind: 'gate-override', note: `Override ${key}`, at: 1 }))
  writeFileSync(join(f.root, '.neil-dev.epic-40.json'), JSON.stringify(e))
  const skipped = confirmed(f, 'skip', 'framing settled by the owner')
  assert.equal(skipped.status, 1, skipped.stdout + skipped.stderr)
  assert.match(skipped.stdout + skipped.stderr, /cap is 4/)
  assert.equal(f.ok('status', '40').epic.state, 'framing')
})

test('issue 248: verify with skipped checks needs one place under the debt cap, as the model counts it', t => {
  const f = fixture(t)
  const e = f.ok('start', '40').epic
  e.state = 'coordinating'
  e.issues = { 41: { issue: 41, key: 'part', title: 'Part', blockedBy: [], rounds: 0, state: 'reviewing', pr: 61, reviewer: 'review-1' } }
  e.debts = ['d1', 'd2', 'd3'].map(key => ({ key, kind: 'gate-override', note: `Override ${key}`, at: 1 }))
  const record = join(f.root, '.neil-dev.epic-40.json')
  writeFileSync(record, JSON.stringify(e))
  f.answers['repos/example/repo/pulls/61'] = { number: 61, state: 'open', merged: false, draft: false, mergeable: true, head: { ref: 'parent', sha: 'def' }, base: { ref: 'main' } }
  f.answers['repos/example/repo/pulls/61/files'] = [[]]
  f.answers['checks:61'] = { headRefOid: 'def', statusCheckRollup: [...['a', 'b', 'c', 'd', 'e'].map(name => ({ name, status: 'COMPLETED', conclusion: 'SKIPPED' })), { name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] }
  f.save()
  const verified = f.ok('issue', '40', '41', 'verified', '--verdict', 'approve').epic
  assert.equal(verified.debts.filter(debt => debt.key.startsWith('verify:41:def:')).length, 5)
  e.debts.push({ key: 'd4', kind: 'gate-override', note: 'Override d4', at: 1 })
  writeFileSync(record, JSON.stringify(e))
  const refused = f.call('issue', '40', '41', 'verified', '--verdict', 'approve')
  assert.equal(refused.status, 1, JSON.stringify(refused))
  assert.match(refused.error.message, /4 open debts.*cap is 4/)
})

test('issue 257: a ruled debt refuses a different ruling and prints the one it has', t => {
  const f = fixture(t)
  f.ok('start', '40')
  const debt = join(f.home, 'debt.json'), ruling = join(f.home, 'ruling.json')
  writeFileSync(debt, JSON.stringify({ key: 'docs', kind: 'gate-override', note: 'Docs check omitted' }))
  f.ok('debt', '40', '--file', debt)
  writeFileSync(ruling, JSON.stringify({ verdict: 'accepted', reason: 'The owner accepts it' }))
  f.ok('ruling', '40', 'docs', '--file', ruling)
  f.ok('ruling', '40', 'docs', '--file', ruling)
  const record = join(f.root, '.neil-dev.epic-40.json')
  const before = readFileSync(record, 'utf8')
  writeFileSync(ruling, JSON.stringify({ verdict: 'fixed', reason: 'Repaired', evidence: 'commit abc' }))
  const refused = f.call('ruling', '40', 'docs', '--file', ruling)
  assert.equal(refused.status, 1, JSON.stringify(refused))
  assert.match(refused.error.message, /docs already has the ruling accepted: The owner accepts it/)
  assert.equal(readFileSync(record, 'utf8'), before)
})

test('issue 257: the same issue-filed ruling again changes nothing after its follow-up issue closed', t => {
  const f = fixture(t)
  f.ok('start', '40')
  const debt = join(f.home, 'debt.json'), ruling = join(f.home, 'ruling.json')
  writeFileSync(debt, JSON.stringify({ key: 'docs', kind: 'gate-override', note: 'Docs check omitted' }))
  f.ok('debt', '40', '--file', debt)
  writeFileSync(ruling, JSON.stringify({ verdict: 'issue-filed', reason: 'Track it', issue: 90 }))
  f.answers['repos/example/repo/issues/90'] = { number: 90, state: 'open' }
  f.save()
  f.ok('ruling', '40', 'docs', '--file', ruling)
  f.answers['repos/example/repo/issues/90'] = { number: 90, state: 'closed' }
  f.save()
  f.ok('ruling', '40', 'docs', '--file', ruling)
})

test('issue 250: a merge owes override debt exactly when the sub-issue is not in reviewing, fixing or verified', t => {
  const f = fixture(t)
  const e = f.ok('start', '40').epic
  e.state = 'coordinating'
  e.issues = {
    41: { issue: 41, key: 'part', title: 'Part', blockedBy: [], rounds: 0, state: 'blocked', previous: 'reviewing', pr: 61, reviewer: 'review-1', verdict: 'changes' },
    42: { issue: 42, key: 'child', title: 'Child', blockedBy: [], rounds: 0, state: 'reviewing', pr: 62, reviewer: 'review-2', verdict: 'changes' },
  }
  const record = join(f.root, '.neil-dev.epic-40.json')
  writeFileSync(record, JSON.stringify(e))
  Object.assign(f.answers['repos/example/repo/pulls/61'], { state: 'closed', merged: true, merge_commit_sha: 'b'.repeat(40) })
  Object.assign(f.answers['repos/example/repo/pulls/62'], { state: 'closed', merged: true, merge_commit_sha: 'c'.repeat(40), base: { ref: 'main' } })
  f.save()
  const before = readFileSync(record, 'utf8')
  const unforced = f.call('issue', '40', '41', 'merged')
  assert.equal(unforced.status, 1, JSON.stringify(unforced))
  assert.match(unforced.error.message, /#41 is blocked.*--override/)
  const superfluous = f.call('issue', '40', '42', 'merged', '--override', 'not needed')
  assert.equal(superfluous.status, 1, JSON.stringify(superfluous))
  assert.match(superfluous.error.message, /#42 is reviewing.*no override/)
  assert.equal(readFileSync(record, 'utf8'), before)
  const merged = f.ok('issue', '40', '41', 'merged', '--override', 'Owner merged the blocked PR').epic
  assert.deepEqual(merged.debts.map(debt => debt.key), ['merge:41:pr:61:verification', 'merge:41:override'])
})

test('issue 279: brief and start refuse a waiting sub-issue whose closing PR is open again on GitHub', t => {
  const f = fixture(t)
  const e = f.ok('start', '40').epic
  e.state = 'coordinating'
  e.issues = { 41: { issue: 41, key: 'part', title: 'Part', blockedBy: [], rounds: 0, state: 'waiting' } }
  const record = join(f.root, '.neil-dev.epic-40.json')
  writeFileSync(record, JSON.stringify(e))
  f.answers['closers:41'] = { closedByPullRequestsReferences: [{ number: 70, url: 'https://github.com/example/repo/pull/70', repository: { name: 'repo', owner: { login: 'example' } } }] }
  f.answers['repos/example/repo/pulls/70'] = { number: 70, state: 'open', merged: false, head: { ref: 'reopened', sha: 'r'.repeat(40) } }
  f.save()
  const before = readFileSync(record, 'utf8')
  for (const args of [['brief', '40', '41', 'implementer'], ['issue', '40', '41', 'implementing', '--worker', 'worker-1', '--workspace', f.root]]) {
    const refused = f.call(...args)
    assert.equal(refused.status, 1, JSON.stringify(refused))
    assert.match(refused.error.message, /#41 is waiting.*PR #70.*open/)
    assert.equal(refused.error.repair, 'Run ndev epic import 40 --issues-file <json> --evidence <text>. If it still records #41 as waiting, remove PR #70 from the Development section of #41.')
    assert.equal(readFileSync(record, 'utf8'), before)
  }
  f.answers['repos/example/repo/pulls/70'].state = 'closed'
  f.save()
  f.ok('brief', '40', '41', 'implementer')
  assert.equal(f.ok('issue', '40', '41', 'implementing', '--worker', 'worker-1', '--workspace', f.root).epic.issues[41].state, 'implementing')
})

test('issue 280: a verified sub-issue goes back to reviewing only after its PR head moved, and the refusal names both heads', t => {
  const f = fixture(t)
  const e = f.ok('start', '40').epic
  e.state = 'coordinating'
  const verified = 'a'.repeat(40)
  e.issues = { 41: { issue: 41, key: 'part', title: 'Part', blockedBy: [], rounds: 0, state: 'verified', pr: 61, implementer: 'worker-1', reviewer: 'review-1', verdict: 'approve', verification: { sha: verified, base: 'main', checks: [] } } }
  const record = join(f.root, '.neil-dev.epic-40.json')
  writeFileSync(record, JSON.stringify(e))
  f.answers['repos/example/repo/pulls/61'].head.sha = verified
  f.save()
  const before = readFileSync(record, 'utf8')
  const still = f.call('issue', '40', '41', 'reviewing')
  assert.equal(still.status, 1, JSON.stringify(still))
  assert.match(still.error.message, new RegExp(`PR #61 of #41 is at ${verified}, the head that verify checked \\(${verified}\\)`))
  assert.match(still.error.repair, /ndev epic issue 40 41 reviewing/)
  assert.equal(readFileSync(record, 'utf8'), before)
  const pushed = 'b'.repeat(40)
  f.answers['repos/example/repo/pulls/61'].head.sha = pushed
  f.save()
  const unmerged = f.call('issue', '40', '41', 'merged')
  assert.match(unmerged.error.repair, /ndev epic issue 40 41 reviewing/)
  f.answers['repos/example/repo/pulls/61'].state = 'closed'
  f.save()
  const shut = f.call('issue', '40', '41', 'reviewing')
  assert.match(shut.error.repair, /ndev epic issue 40 41 merged.*gh pr reopen 61.*ndev epic issue 40 41 blocked/)
  f.answers['repos/example/repo/pulls/61'].state = 'open'
  f.save()
  const moved = f.ok('issue', '40', '41', 'reviewing', '--worker', 'review-2').epic.issues[41]
  assert.equal(moved.state, 'reviewing')
  assert.equal(moved.reviewer, 'review-2')
  assert.equal(moved.verification.sha, verified)
})

function waitingClosers(t, ...closers) {
  const f = fixture(t)
  const e = f.ok('start', '40').epic
  e.state = 'coordinating'
  e.issues = { 41: { issue: 41, key: 'part', title: 'Part', blockedBy: [], rounds: 0, state: 'waiting' } }
  const record = join(f.root, '.neil-dev.epic-40.json')
  writeFileSync(record, JSON.stringify(e))
  function close(number, repo, created) {
    const [owner, name] = repo.split('/')
    closers.push({ number, url: `https://github.com/${repo}/pull/${number}`, repository: { name, owner: { login: owner } } })
    f.answers['closers:41'] = { closedByPullRequestsReferences: closers }
    f.answers[`repos/${repo}/pulls/${number}`] = { number, state: 'open', merged: false, created_at: created, head: { ref: 'work', sha: 'r'.repeat(40) } }
    f.save()
  }
  return { ...f, record, close, start: () => f.call('issue', '40', '41', 'implementing', '--worker', 'worker-1', '--workspace', f.root) }
}

test('issue 279: the start records the draft PR that the briefed worker opened, and refuses a reopened one', t => {
  const f = waitingClosers(t)
  f.ok('brief', '40', '41', 'implementer')
  f.close(70, 'example/repo', '2020-01-01T00:00:00Z')
  const refused = f.start()
  assert.equal(refused.status, 1, JSON.stringify(refused))
  assert.match(refused.error.message, /PR #70/)
  f.answers['repos/example/repo/pulls/70'].created_at = new Date(Date.now() + 60_000).toISOString()
  f.save()
  const again = f.call('brief', '40', '41', 'implementer')
  assert.equal(again.status, 1, JSON.stringify(again))
  const started = f.start()
  assert.equal(started.status, 0, JSON.stringify(started))
  assert.equal(started.result.epic.issues[41].state, 'implementing')
})

test('issue 279: an import forgets the brief, so a PR opened after it is refused at the start', t => {
  const f = waitingClosers(t)
  f.ok('brief', '40', '41', 'implementer')
  f.answers['repos/example/repo/issues/40/sub_issues'] = [{ number: 41, title: 'Part', state: 'open' }]
  f.answers['repos/example/repo/issues/41/timeline'] = []
  f.save()
  const manifest = join(f.home, 'import.json')
  writeFileSync(manifest, JSON.stringify([{ issue: 41, key: 'part', kind: 'implementation', blockedBy: [] }]))
  f.ok('import', '40', '--issues-file', manifest, '--evidence', 'reconciled')
  f.close(70, 'example/repo', new Date(Date.now() + 60_000).toISOString())
  const refused = f.start()
  assert.equal(refused.status, 1, JSON.stringify(refused))
  assert.match(refused.error.message, /PR #70/)
})

test('issue 279: a closing PR of another repository gets a repair that does not send the caller to import', t => {
  const f = waitingClosers(t)
  f.close(7, 'acme/other', '2020-01-01T00:00:00Z')
  const foreign = f.call('brief', '40', '41', 'implementer')
  assert.equal(foreign.status, 1, JSON.stringify(foreign))
  assert.match(foreign.error.message, /PR acme\/other#7/)
  assert.match(foreign.error.repair, /gh pr view 7 --repo acme\/other/)
  assert.match(foreign.error.repair, /closing reference to example\/repo#41/)
  assert.doesNotMatch(foreign.error.repair, /ndev epic import/)
})

test('issue 279: the own PR check ignores the case of the repository name, as GitHub does', t => {
  const f = waitingClosers(t)
  f.ok('brief', '40', '41', 'implementer')
  f.close(70, 'Example/Repo', new Date(Date.now() + 60_000).toISOString())
  const started = f.start()
  assert.equal(started.status, 0, JSON.stringify(started))
})
