import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const binary = process.env.NDEV_TEST_BINARY || fileURLToPath(new URL('../bin/ndev', import.meta.url))

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
    'repos/example/repo/pulls/61': { number: 61, state: 'open', merged: false, head: { ref: 'parent', sha: 'abc' }, base: { ref: 'main' } },
  }
  const save = () => writeFileSync(responses, JSON.stringify(answers))
  save()
  writeFileSync(join(home, 'gh'), [
    '#!/usr/bin/env node', "const fs=require('node:fs')",
    "const path=process.argv[2] === 'pr' ? (process.argv.includes('closingIssuesReferences') ? 'links:' : 'checks:')+process.argv[4] : process.argv.slice(2).find(v => v.startsWith('repos/'))?.split('?')[0]",
    `const answer=JSON.parse(fs.readFileSync(${JSON.stringify(responses)}))[path]`,
    'if (!answer) {console.error("Unexpected gh call "+process.argv.slice(2).join(" ")); process.exit(9)}',
    'console.log(JSON.stringify(answer))',
  ].join('\n'), { mode: 0o755 })
  writeFileSync(join(root, '.neil-dev.json'), JSON.stringify({ github: { repo: 'example/repo' } }))
  function call(...args) {
    const out = spawnSync(binary, ['epic', ...args, '--json'], { cwd: root, env, encoding: 'utf8' })
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
  ok('phase', '40', 'framing', '--aim', 'ship the work', '--evidence', 'interviewed')
  writeFileSync(join(root, 'spec.md'), 'the spec')
  for (const phase of ['researching', 'specifying', 'deciding', 'spec-review', 'slicing']) {
    ok('phase', '40', phase, '--evidence', 'accepted', ...(['researching', 'specifying', 'spec-review'].includes(phase) ? ['--file', 'spec.md'] : []))
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
  assert.equal(ok('goto','done','--issue','40').nextAction.confirmation,'terminal')
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
  const initial = f.ok('goto', target, '--issue', '40')
  const phrase = `confirm epic goto ${target} 40 ${initial.nextAction.revision}`
  const script = `import os,pty,subprocess
m,s=pty.openpty()
os.write(m,${JSON.stringify(phrase + '\n')}.encode())
p=subprocess.Popen(${JSON.stringify([binary, 'epic', 'goto', target, '--issue', '40'])},stdin=s,stdout=s,stderr=s)
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
