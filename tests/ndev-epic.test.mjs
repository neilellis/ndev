import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const binary = fileURLToPath(new URL('../bin/ndev', import.meta.url))

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
    "const path=process.argv[2] === 'pr' ? 'checks:'+process.argv[4] : process.argv.slice(2).find(v => v.startsWith('repos/'))?.split('?')[0]",
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
  assert.equal(ok('start', '40', '--run', 'run-1', '--repo-id', 'local').epic.state, 'framing')
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
  assert.equal(call('issue','40','41','implementing','--worker','w','--workspace','local::/repo').status,2)
  ok('issue','40','41','implementing','--worker','w','--workspace','away::/repo')
  ok('start','40','--local')
  const review = ok('brief','40','41','reviewer','--pr','61')
  assert.ok(review.argv.includes('id:away::/repo') && review.argv.includes('host-1'))
  assert.ok(review.argv.includes('test-model'))
  assert.equal(ok('goto','done','--issue','40').nextAction.confirmation,'terminal')
  assert.equal(ok('status','40').epic.state,'coordinating')
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
