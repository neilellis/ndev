import { expect, test } from 'claude-code/testing'

import { strictest } from '../hooks/workflow/tools'
import type { Workflow } from '../hooks/workflow/tools'
import type { WorkflowLive } from '../types'

type Body = Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>
type On = Parameters<Body>[1]
type Dollar = Parameters<Body>[0]

const ROOT = '/proj'
const RECORD = `${ROOT}/.neil-dev.worktree.json`
const CONFIG = `${ROOT}/.neil-dev.json`
const REPO = 'acme/w'
const SHA = 'aaaaaaaa11111111'
const STREAM_CAP = 4194304 // What $.process.run keeps of each stream, and the most $.fs.write takes.
const ok = (stdout = '', exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })

const flow = (over: Record<string, unknown> = {}) => ({
  rev: 1, issue: 7, root: ROOT, repo: REPO, base: 'main', branch: 'issue-7', prs: [12], state: 'developing',
  evidence: {}, attempts: 0, nudges: { count: 0 }, followUps: [], migrations: [], history: [], owner: { session: 's1', at: 0 }, ...over,
})
// A record past development sits under prs, as the merge point leaves it, and its issue waits as developed.
const PR_STAGES = ['reviewing', 'ci', 'smoke', 'finishing', 'revising', 'done']
const onPr = (r: Record<string, unknown>) => !r.direct && !r.pr && (r.prs as number[] | undefined)?.[0] !== undefined && (PR_STAGES.includes(r.state as string) || (['blocked', 'wait'].includes(r.state as string) && PR_STAGES.includes(r.previous as string)))
const held = (...records: Record<string, unknown>[]) => {
  const prs: Record<string, Record<string, unknown>> = {}
  const issues: Record<string, Record<string, unknown>> = {}
  for (const r of records) {
    if (r.pr) { prs[r.pr as number] = r; continue }
    if (!onPr(r)) { issues[r.issue as number] = r; continue }
    const n = (r.prs as number[])[0]!
    const was = prs[n]
    prs[n] = was ? { ...was, issues: [...(was.issues as number[]), r.issue] } : { ...r, pr: n, issues: [r.issue] }
    issues[r.issue as number] = { ...r, state: 'developed', previous: undefined, rev: 1 }
  }
  return JSON.stringify({ version: 2, resources: {}, workflows: issues, prs })
}
const pull = (over: Record<string, unknown> = {}) => ({
  number: 12, state: 'open', merged: false, draft: false, mergeable: true, mergeable_state: 'clean',
  body: 'Closes #7', created_at: '2026-11-01T00:00:00Z', head: { sha: SHA, ref: 'issue-7' }, ...over,
})
const CHECKS = (...runs: { name: string; status?: string; conclusion: string | null }[]) => ({ check_runs: runs.map(r => ({ status: 'completed', ...r })) })

type Opts = {
  refuseCommand?: RegExp; wf?: Record<string, unknown> | null; config?: Record<string, unknown>; pr?: Record<string, unknown>; checks?: unknown; scripts?: boolean; skillFiles?: boolean; files?: Record<string, string>; guide?: boolean; main?: boolean; names?: string[] }

// A fake engine: a linked worktree at /proj, a simulated git and a simulated GitHub. Only the
// process and file boundaries are fake: the plugin's tools, machine and watchdog all really run.
let registeredTools: unknown[] = []
let onIssue = 7
const engine = (on: On, opts: Opts = {}) => {
  const files = new Map<string, string>(Object.entries({
    [`${ROOT}/.ndev-inited`]: '',
    [CONFIG]: JSON.stringify({ github: { repo: REPO, board: null }, mode: 'light', steering: 'auto', ...opts.config }),
    ...(opts.wf === null ? {} : { [RECORD]: held(flow(opts.wf ?? {})) }),
    ...opts.files,
  }))
  const s = {
    now: 0, sha: SHA, upstream: SHA, dirty: [] as string[], staged: false, failCheck: '', hugeCheck: '', hugeExit: 0, scripts: opts.scripts ?? true, agents: [] as { id: string; status: string }[],
    prReadsFor: undefined as Record<number, unknown[]> | undefined, issueReadsFor: undefined as Record<number, unknown[]> | undefined,
    main: opts.main ?? false, names: opts.names ?? ['a.ts'], copyDiffFails: '', draft: '', ghFails: '', orcaOn: false, orcaFails: '', issueAnswer: undefined as string | undefined, modelFails: false, spawnDeny: '', sleepHold: undefined as Promise<void> | undefined, resumed: false, orcaLinked: null as number | null, branch: undefined as string | undefined, pr: pull(opts.pr), checks: (opts.checks ?? CHECKS({ name: 'ci', conclusion: 'success' })) as unknown,
    clockSleeps: 0, staleSaves: 0, saves: 0, failWrite: undefined as ((path: string) => boolean) | undefined, sleepAdvances: false, sleepDrift: [] as number[], immediate: [] as string[], probe: undefined as ((argv: string[]) => Promise<{ exitCode: number; stdout?: string; stderr?: string }> | { exitCode: number; stdout?: string; stderr?: string }) | undefined, probes: [] as string[],
    diffFails: '', orcaGone: false, orcaReachable: true, pageUrl: undefined as string | undefined, pageWidth: undefined as number | undefined, viewportWidth: 0, dark: false, cpFails: '',
    ops: new Set<string>(), pushFails: '', noOpenPr: false, diffText: '', commitAt: -3_600_000, commitIso: '2026-11-01T00:00:00Z', commitUnknown: false, workflowsDir: false, blobSize: '', promptFails: false, comments: [] as unknown[], commitDirs: [] as (string | undefined)[],
  }
  const gh: string[] = []
  const ready: string[] = []
  const prompts: string[] = []
  const toasts: string[] = []
  const spawns: { subagentType?: string; prompt: string; cwd?: string }[] = []
  const modelCalls: { model: string; prompt: string; system?: string }[] = []
  const compacts: unknown[] = []
  const pushes: string[] = []
  const commits: string[] = []
  const alerts: string[] = []
  const merges: string[] = []
  const orcaCalls: string[][] = []
  const issueAsks: { question: string; options: string[] }[] = []
  const fills: string[] = []
  const steps: string[] = []
  const submodules: { command: string; paths?: string }[] = []
  const timers: (() => void)[] = []
  const copies: string[] = []

  const commandNames: string[] = []
  on('command.register', (_, e) => {
    commandNames.push(e.name)
    if ((e as { immediate?: boolean }).immediate) s.immediate.push(e.name)
    // Another plugin can own a name: the host then refuses it, as it did with the Vercel plugin's /workflow.
    if (opts.refuseCommand?.test(e.name)) throw new Error(`"/${e.name}" refused: another plugin owns it`)
    return { value: { command: e.name } }
  })
  registeredTools = []
  onIssue = (opts.wf?.issue as number | undefined) ?? 7
  on('tool.register', (_, e) => {
    registeredTools.push(e)
    return { value: { tool: `mcp__ndev__${e.name}` } }
  })
  on('clock.now', () => ({ value: s.now }))
  on('clock.every', () => new Promise(resolve => { timers.push(() => resolve({ value: undefined })) }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: 's1' }))
  on('session.compact', (_, e) => { compacts.push(e); return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never })
  // A timer runs after the command's hook has returned, as in the host, which refuses a prompt before that.
  on('clock.after', () => new Promise(resolve => { pendingAfters.push(() => resolve({ value: undefined })) }))
  on('turn.complete', () => ({ text: 'text' }) as never)
  for (const name of ['Edit', 'Bash'] as const) on('tool.call', { tool: name }, () => ({ result: 'ok' }) as never)
  on('prompt.compose', () => ({ sections: [] }))
  on('prompt.read', () => ({ value: { text: s.draft, cursor: 0 } }))
  on('prompt.submit', (_, e) => { if (s.promptFails) throw new Error('refused by the host'); prompts.push(e.text); return { text: e.text } })
  on('agent.list', () => ({ value: s.agents }) as never)
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/neil' : e.name === 'ORCA_WORKSPACE_ID' && s.orcaOn ? 'workspace-1' : undefined }) as never)
  const guide = (path: string) => {
    if (path.endsWith('/kb/workflow.md')) return opts.guide !== false ? '# The guide' : undefined
    const skill = /\/skills\/(work-light|work-heavy)\/SKILL\.md$/.exec(path)
    if (skill && opts.skillFiles !== false) return `---\nname: ${skill[1]}\ndescription: "the listing"\n---\n\n# The ${skill[1]} method\n\nRun \`\${CLAUDE_PLUGIN_ROOT}/scripts/x.sh\`.\n`
    for (const name of ['kb/ui-components.md', 'kb/libraries.md', 'skills/motion/SKILL.md', 'skills/motion/references/delight.md']) if (path.endsWith(`/${name}`)) return `SOURCE ${name}`
    return undefined
  }
  on('fs.exists', (_, e) => ({ value: e.path.startsWith('/home/neil/dev-wiki') || files.has(e.path) || guide(e.path) !== undefined }))
  on('fs.read', (_, e) => ({ value: guide(e.path) ?? files.get(e.path) ?? '' }))
  on('fs.write', (_, e) => {
    if (s.failWrite?.(e.path)) throw new Error(`disk full: ${e.path}`)
    const size = new TextEncoder().encode(e.text).length
    if (size > STREAM_CAP) throw new Error(`ndev: $.fs.write: ${e.path} refused: ${size} bytes is over the ${STREAM_CAP}-byte limit`)
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.notify', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }) as never)
  on('session.cwd', () => ({ value: ROOT }) as never)
  let refReads = 0
  on('process.run', (_, e) => {
    const a = e.argv.map(String)
    const line = a.join(' ')
    // The host refuses a timeout that is not a whole number of ms, as $.process.run does in a session.
    const limit = e.init?.timeoutMs
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 600_000)) throw new Error('ndev: process.run: init.timeoutMs is a whole number of ms, 1 to 600000 (host check)')
    if (a[0] === 'sleep') return (async () => { await s.sleepHold; if (s.sleepAdvances) s.now += Number(a[1]) * 1000 + (s.sleepDrift.shift() ?? 0); return ok() })() as never
    if (s.probe && (a[0] === 'curl' || a[0] === 'ps' || (a[0] === 'bash' && a[1] === '-c'))) {
      s.probes.push(line)
      return (async () => {
        const r = await s.probe!(a)
        return ok(r.stdout ?? '', r.exitCode, r.stderr ?? '')
      })() as never
    }
    if (a[0] === 'git') {
      // Another repository on this computer, and a path that is not a repository.
      if (a[1] === '-C' && a[2]?.startsWith('/home/neil/dev-wiki')) return ok('/home/neil/dev-wiki/.git\n')
      if (a[1] === '-C' && a[2] === '/nowhere') return ok('', 128, 'fatal: cannot change to /nowhere')
      if (line.includes('--path-format=absolute')) return ok(s.main ? '/main/.git\n/main/.git\n' : `${ROOT}/.git/worktrees/x\n/main/.git\n`)
      // Each read of the remote refs differs, so a Bash call that names a push lands.
      if (a[1] === 'for-each-ref') return ok(`refs/remotes/origin/issue-7 ${++refReads}\n`)
      if (a[1] === 'reflog') return ok('update by push\n')
      if (a[1] === 'fetch') return ok()
      if (line.includes('--abbrev-ref')) return ok(`${s.branch ?? 'issue-7'}\n`)
      if (a[1] === 'rev-parse' && a[2] === 'HEAD') return ok(`${s.sha}\n`)
      if (a[1] === 'rev-parse' && a[2]?.startsWith('origin/')) return ok(`${s.upstream}\n`)
      if (a[1] === 'rev-parse') return ok(`${ROOT}\n`)
      if (a[1] === 'status') return ok(s.dirty.join('\n'))
      if (a[1] === 'remote') return ok(`git@github.com:${REPO}.git\n`)
      if (a[1] === 'symbolic-ref') return ok('origin/main\n')
      if (a[1] === 'log' && line.includes('--grep=')) return ok([...s.ops].some(op => line.includes(`Ndev-Op: ${op}$`)) ? `${s.sha}\n` : '')
      if (a[1] === 'log' && line.includes('%ct')) return ok(`${s.commitAt / 1000}\n`)
      if (a[1] === 'log' && line.includes('%cI')) return s.commitUnknown ? ok('', 128, `fatal: bad object ${a.at(-1)}`) : ok(`${s.commitIso}\n`)
      if (a[1] === 'log') return ok('')
      if (a[1] === 'ls-tree') return ok(s.workflowsDir ? 'tree .github/workflows\n' : '')
      if (a[1] === 'ls-files') return ok('')
      if (a[1] === 'reset') { s.staged = false; steps.push('reset'); return ok() }
      if (a[1] === 'stash') return ok('')
      if (a[1] === 'check-ignore') return ok('x\n')
      if (a[1] === 'cat-file') return s.blobSize ? ok(`${s.blobSize}\n`) : ok('', 1)
      if (a[1] === 'worktree') return ok(`worktree ${ROOT}\n`)
      if (a[1] === 'add') { s.staged = true; return ok() }
      if (s.copyDiffFails && line.includes('--name-only --diff-filter=d origin/')) return ok('', 128, s.copyDiffFails)
      if (a[1] === 'diff' && line.includes('--name-only')) return s.diffFails && line.includes('...') ? ok('', 128, s.diffFails) : ok(`${s.names.join('\n')}\n`)
      if (a[1] === 'diff' && a[2] === 'HEAD') return ok(s.diffText)
      if (a[1] === 'diff') return ok('', s.staged ? 1 : 0)
      if (a[1] === 'commit') { s.commitDirs.push(e.init?.cwd); const op = /Ndev-Op: (\S+)/.exec(line)?.[1]; if (op) s.ops.add(op); steps.push('commit'); commits.push(line); s.staged = false; s.sha = `bbbb${commits.length}`; return ok() }
      if (a[1] === 'push' && s.pushFails) return ok('', 1, s.pushFails)
      if (a[1] === 'push') { pushes.push(line); s.upstream = s.sha; return ok() }
      return ok('', 1, `git not faked: ${line}`)
    }
    if (a[0] === 'test') return ok('', s.scripts ? 0 : 1)
    // Every GitHub call goes through gh.sh. A raw gh call here is a bug in the plugin.
    if (a[0] === 'gh') {
      if (!isFixAllPrsRead(line)) gh.push(line)
      return ok('', 1, `raw gh call, use scripts/github/gh.sh: ${line}`)
    }
    if (a[0] === 'bash' && a[1]?.endsWith('worktree-env.sh')) {
      if (a[2] === 'set-workflow') {
        s.saves += 1
        if (s.staleSaves > 0) {
          s.staleSaves -= 1
          return ok('', 5, 'another writer got in first')
        }
        // As the real script: a writer that expected another revision changes nothing, and exits 5.
        const record = `${a[a.indexOf('--worktree') + 1]}/.neil-dev.worktree.json`
        const onFile = JSON.parse(files.get(record) ?? '{}') as { workflow?: { issue: number; rev?: number }; workflows?: Record<string, { rev?: number }>; prs?: Record<string, { rev?: number }> }
        const all: Record<string, { rev?: number }> = { ...(onFile.workflow ? { [onFile.workflow.issue]: onFile.workflow } : {}), ...onFile.workflows }
        const prRecords = { ...onFile.prs }
        const written = JSON.parse(String(e.init?.stdin)) as { issue: number; pr?: number }
        const was = (written.pr ? prRecords[written.pr]?.rev : all[written.issue]?.rev) ?? 0
        const rev = Number(a[a.indexOf('--expect-rev') + 1]) + 1
        if (was !== rev - 1) return ok('', 5, `the workflow of ${written.pr ? `PR #${written.pr}` : `#${written.issue}`} is at revision ${was}, and this writer expected ${rev - 1}`)
        if (written.pr) prRecords[written.pr] = { ...written, rev }
        else all[written.issue] = { ...written, rev }
        files.set(record, JSON.stringify({ version: 2, resources: {}, workflows: all, prs: prRecords }))
        return ok(`${rev}\n`)
      }
      return ok()
    }
    if (a[0] === 'bash' && a[1]?.endsWith('notify.sh')) {
      alerts.push(a[2] as string)
      return ok(a[2] === 'raise' ? '4242\n' : '')
    }
    if (a[0] === 'bash' && a[1]?.endsWith('gh.sh')) {
      if (!isFixAllPrsRead(line)) gh.push(line)
      if (s.ghFails) return ok('', 1, s.ghFails)
      if (a[2] === 'blocked-by') return ok('')
      const scripted = (a[2] === 'pr-read' ? s.prReadsFor : a[2] === 'issue-read' ? s.issueReadsFor : undefined)?.[Number(a[3])]?.shift()
      if (typeof scripted === 'string') return ok('', 1, scripted)
      if (scripted) return ok(JSON.stringify(scripted))
      if (a[2] === 'pr-read') return ok(JSON.stringify(s.pr))
      if (a[2] === 'issue-read') return ok(JSON.stringify({ state: 'open', title: 'T' }))
      if (a[2] === 'issue-new') return ok('{"number":31}\n')
      if (a[2] === 'pr-list') return ok(s.noOpenPr ? '' : '{"number":12}\n')
      if (a[2] === 'pr-edit') return ok('')
      if (a[2] === 'subissues') return s.linkFails ? ok('', 1, s.linkFails) : ok('')
      if (a[2] === 'commit-checks') return ok(JSON.stringify({ statuses: [], ...(s.checks as object) }))
      if (a[2] === 'feedback') return ok((s.comments as unknown[]).map(c => JSON.stringify(c)).join('\n'))
      if (a[2] === 'pr-ready') { ready.push(line); s.pr = { ...s.pr, draft: false }; return ok() }
      if (a[2] === 'comment' || a[2] === 'pr-review' || a[2] === 'label') return ok()
      return ok('', 1, `gh.sh not faked: ${line}`)
    }
    if (a[0] === 'bash' && a[1]?.endsWith('merge.sh')) {
      merges.push(a[2] as string)
      return ok(JSON.stringify({ pr: 12, merged: true }))
    }
    if (a[0] === 'bash' && a[1]?.endsWith('init-worktree-submodules.sh')) {
      submodules.push({ command: JSON.parse(String(e.init?.stdin)).tool_input.command, paths: e.init?.env?.WORKTREE_SUBMODULES })
    }
    if (a[0] === 'bash' && a[1]?.endsWith('worktree_claim.sh')) return ok('/claimed/issue-7\n')
    if (a[0] === 'bash' && a[1]?.includes('.sh')) {
      steps.push(`${a[1].split('/').pop()}${a.length > 2 ? ` ${a.slice(2).join(' ')}` : ''}`)
      if (s.hugeCheck && a[1].includes(s.hugeCheck)) return { value: { exitCode: s.hugeExit, stdout: `${'x'.repeat(STREAM_CAP - 5)}\nlast`, stderr: '', isStdoutTruncated: true, isStderrTruncated: false } }
      if (s.failCheck && a[1].includes(s.failCheck)) return ok('lint: broken line', 3)
      return ok('passed')
    }
    if (a[0] === 'mkdir') return ok()
    if (a[0] === 'cp') { if (s.cpFails) return ok('', 1, s.cpFails); copies.push(a.at(-1) as string); return ok() }
    if (a[0] === 'orca') {
      if (s.orcaGone) throw new Error('spawn orca ENOENT')
      orcaCalls.push(a.slice(1) as string[])
      // The answers of the browser commands, as Orca 1.4.247 gives them.
      const answer = (result: unknown) => ok(JSON.stringify({ ok: true, result }))
      if (a[1] === 'status') return answer({ runtime: { reachable: s.orcaReachable } })
      if (a[1] === 'tab' && a[2] === 'create') { if (s.orcaFails) return ok(JSON.stringify({ ok: false, error: { code: 'browser_host_unavailable', message: s.orcaFails } }), 1); s.pageUrl ??= a[a.indexOf('--url') + 1]; return answer({ browserPageId: 'page-1' }) }
      if (a[1] === 'viewport') { s.viewportWidth = Number(a[a.indexOf('--width') + 1]); return answer({}) }
      if (a[1] === 'exec') { s.dark = a.join(' ').includes('set media dark'); return answer({ set: true }) }
      if (a[1] === 'eval') {
        const expression = a[a.indexOf('--expression') + 1] as string
        return answer({ result: expression.includes('innerWidth') ? String(s.pageWidth ?? s.viewportWidth) : expression.includes('location') ? s.pageUrl : String(s.dark) })
      }
      if (a[1] === 'screenshot' || a[1] === 'full-screenshot') return answer({ format: 'png', path: `/tmp/orca-shots/${orcaCalls.length}.png` })
      if (a[2] === 'worker-start') return s.workerReceipt ? ok(JSON.stringify(s.workerReceipt), 1) : answer({ state: 'ready', dispatchId: 'ctx_1', runId: 'run_1', taskId: 'task_1' })
      if (a[1] === 'wait' || (a[1] === 'tab' && a[2] === 'close')) return answer({})
      if (a[2] === 'launch' && s.orcaFails) return ok('', 1, s.orcaFails)
      if (a[2] === 'show' && !s.orcaFails) return ok(JSON.stringify({ ok: true, result: { worktree: { linkedIssue: s.orcaLinked } } }))
      return s.orcaFails ? ok('', 1, s.orcaFails) : ok('{}')
    }
    if (a[0] === 'find') return ok(`${a[1]}/colour.css\n`)
    if (a[0] === 'curl') return ok('<html>Brand guide: Inter</html>')
    if (a[0] === 'node') return ok(JSON.stringify({ file: null, copiedFrom: null, root: ROOT, main: ROOT, ignored: true, keys: [], missing: [] }))
    return ok('', 1, `not faked: ${line}`)
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const q = e.questions[0]!
    if (q.header !== 'Issue') throw new Error('dismissed')
    issueAsks.push({ question: q.question, options: q.options.map(o => o.label) })
    if (s.issueAnswer === undefined) throw new Error('dismissed')
    return { result: { answers: { [q.question]: s.issueAnswer } }, text: s.issueAnswer } as never
  })
  on('prompt.fill', (_, e) => { fills.push(e.text); return { isFilled: true } as never })
  on('agent.spawn', (_, e) => {
    // The engine hands this hook the Agent call's own spelling, and only core can set the agentId of a result.
    const r = e as unknown as { subagent_type?: string; prompt: string; cwd?: string }
    spawns.push({ ...r, subagentType: r.subagent_type })
    return (s.spawnDeny ? { deny: s.spawnDeny } : { model: 'opus' }) as never
  })
  on('model.complete', (_, e) => {
    const r = e as unknown as { model: string; prompt: string; system?: string }
    modelCalls.push(r)
    return { value: s.modelFails ? { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: {} } : { isAnswered: true, text: 'Use Kokonut UI hold-button.', usage: {} } } as never
  })
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }) as never)
  on('store.set', (_, e) => { store.set(e.key, e.value); return { value: undefined } as never })
  on('clock.sleep', async () => { s.clockSleeps += 1; await s.sleepHold; return { value: undefined } as never })
  on('session.usage', () => ({ value: { startedAt: s.resumed ? s.now - 3_600_000 : s.now } }) as never)

  type Held = ReturnType<typeof flow> & { blocked?: { message: string; group?: string }; hooks?: Record<string, { firedAt: number; result?: string } | undefined> } & Record<string, unknown>
  const onRecord = () => JSON.parse(files.get(RECORD) ?? '{}') as { workflows?: Record<string, Held>; prs?: Record<string, Held> }
  const prRecord = (n: number) => onRecord().prs?.[n]
  const issueRecord = (n: number) => onRecord().workflows?.[n]
  // The record that acts for this issue now: its PR record, once the PR is past its developers.
  const state = (issue = 7) => {
    const own = issueRecord(issue)
    const carrier = own?.state === 'developed' ? prRecord(own.prs[0]!) : undefined
    return carrier && carrier.state !== 'developing' ? carrier : own
  }
  liveFiles = files
  return { commandNames, s, spawns, modelCalls, issueAsks, fills, orcaCalls, copies, gh, ready, prompts, toasts, compacts, pushes, commits, alerts, merges, steps, submodules, files, state, prRecord, issueRecord, timers }
}
type W = ReturnType<typeof engine>

// The fix-all-prs feature has its own timer, which idle() also fires, and this one read. hooks/workflow never makes it.
const isFixAllPrsRead = (line: string) => /^bash \S*\/scripts\/github\/gh\.sh repo-read$/.test(line)
const pendingAfters: (() => void)[] = []
const settle = () => new Promise(resolve => setTimeout(resolve, 30))
const start = async ($: Dollar, w?: W) => {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: false })
  await settle()
  if (w) w.gh.length = 0 // fix-all-prs reads the repository at the start of a session; that is not the workflow.
}
// Each state tool names its issue. A test names it only when the issue is the point of the test.
const STATE_TOOLS = ['finishedPlan', 'checkpoint', 'finishedDevelopment', 'finishedReview', 'finishedChecks', 'finishedSmoke', 'finishedRevision', 'blocked', 'unblocked', 'done', 'followUp', 'addMigration', 'waitForSubAgent', 'waitForURL', 'waitForProcessEnd', 'waitForSeconds', 'waitFor', 'waitForPR', 'waitForIssue']
let liveFiles: Map<string, string> | undefined
// A test names its target only when the target is the point of the test: the issue, or its PR once it has moved on.
function callFor(name: string): Record<string, unknown> {
  if (name === 'finishedDevelopment') return { issues: [onIssue] }
  if (name === 'waitForPR') return { issue: onIssue }
  const onFile = JSON.parse(liveFiles?.get(RECORD) ?? '{}') as { workflows?: Record<string, { state: string; prs: number[] }>; prs?: Record<string, { state: string }> }
  const own = onFile.workflows?.[onIssue]
  const n = own?.state === 'developed' ? own.prs[0] : undefined
  return n !== undefined && onFile.prs?.[n] && onFile.prs[n]!.state !== 'developing' ? { pr: n } : { issue: onIssue }
}
const tool = async ($: Dollar, name: string, args: Record<string, unknown> = {}) => {
  const named = STATE_TOOLS.includes(name) && !('issue' in args) && (name === 'waitForPR' || !('pr' in args)) ? { ...callFor(name), ...args } : args
  const r = await $.tool.call({ tool: `mcp__ndev__${name}`, ...named } as never) as { result: string; isError?: boolean }
  if (name === 'started' && !r.isError) onIssue = Number(args.issue)
  return { text: String(r.result), isError: !!r.isError }
}
const command = async ($: Dollar, args: string) => {
  const out = String(((await $.command.run({ command: 'flow', args } as never)) as { text: string }).text)
  pendingAfters.splice(0).forEach(fire => fire()) // A command tells the agent just after its hook returns.
  await settle()
  return out
}
const turnEnds = async ($: Dollar, reason = 'answer') => {
  await $.turn.complete({ reason, answer: 'text', durationMs: 1, isAborted: reason === 'aborted', turnId: 't1' } as never)
  await settle()
}
// One idle period passes, and the watchdog's timer fires.
const idle = async (w: W) => {
  w.s.now += 21 * 60_000
  w.timers.splice(0).forEach(fire => fire())
  await settle()
}

// ---- started ----
test('started opens the workflow and answers with the next step', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('developing')
  expect(w.state()?.prs).toEqual([12])
  expect(r.text).toContain('State: developing')
})

test('started loads the skill of the mode into its answer, with the plugin path filled in', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(r.text).toContain('# The work-light method')
  expect(r.text).toMatch(/Run `\/\S*\/scripts\/x\.sh`\./)
  expect(r.text).toMatch(/relative paths start at \/\S*\/skills\/work-light\./)
  expect(r.text).not.toContain('the listing')
  expect(r.text).not.toContain('CLAUDE_PLUGIN_ROOT')
  expect(r.text).not.toContain('work-heavy method')
})

test('started loads the heavy skill for a heavy issue, and the board skills never', async ($, on) => {
  const w = engine(on, { wf: null, config: { steering: 'auto' } })
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub', mode: 'heavy' })
  expect(r.text).toContain('# The work-heavy method')
  expect(r.text).not.toContain('work-heavy-auto')
  expect(r.text).not.toContain('work-light method')
})

test('started loads a skill once in a session, and again after a compaction', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  const again = await tool($, 'started', { issue: 7 })
  expect(again.isError).toBe(false)
  expect(again.text).not.toContain('# The work-light method')
  await $.session.compact({ instructions: 'keep it', messages: [{ role: 'user', text: 'the talk', toolUses: [] }] } as never)
  const after = await tool($, 'started', { issue: 7 })
  expect(after.text).toContain('# The work-light method')
})

test('started names the repair when it cannot read the skill, and the workflow still starts', async ($, on) => {
  const w = engine(on, { wf: null, skillFiles: false })
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('developing')
  expect(r.text).toMatch(/\/skills\/work-light\/SKILL\.md has no text/)
  expect(r.text).toContain('Skill tool')
  expect(r.text).toContain('ndev:work-light')
})

test('started goes to setup when a check script is missing, and names them', async ($, on) => {
  const w = engine(on, { wf: null, scripts: false })
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(w.state()?.state).toBe('setup')
  expect(r.text).toContain('pre-commit-check.sh')
})

test('started refuses in a project that turned the workflow off', async ($, on) => {
  const w = engine(on, { wf: null, config: { workflow: false } })
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('/flow on project')
  expect(w.state()).toBeUndefined()
})

test('a tool called with no workflow refuses and names started', async ($, on) => {
  engine(on, { wf: null })
  await start($)
  const r = await tool($, 'checkpoint', { message: 'x', files: ['a'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('Call started')
})

test('a helper cannot move the workflow', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const r = await tool($, 'blocked', { message: 'stop', agentId: 'helper-1' })
  expect(r.isError).toBe(true)
  expect(w.state()?.state).toBe('developing')
})

// ---- commit and push ----
test('finishedDevelopment commits the named files and moves on', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.dirty = []
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'Add the thing', files: ['a.ts'] })
  expect(r.isError).toBe(false)
  expect(w.commits.length).toBe(1)
  expect(w.pushes.length).toBe(0)
  expect(w.state()?.state).toBe('reviewing')
})

test('a failed check script stops the commit and names script, exit code and output', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.failCheck = 'pre-commit-check'
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'Add', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('pre-commit-check.sh exited 3')
  expect(r.text).toContain('lint: broken line')
  expect(w.commits.length).toBe(0)
  expect(w.pushes.length).toBe(0)
  expect(w.state()?.state).toBe('developing')
})

test('a tool refuses while a helper still runs, because its edits could enter the commit', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.agents = [{ id: 'a1', status: 'running' }]
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'Add', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(w.commits.length).toBe(0)
})

// ---- ready ----
test('finishedReview marks a draft PR ready with its one GraphQL mutation', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' }, pr: { draft: true } })
  await start($, w)
  const r = await tool($, 'finishedReview', { remembered: 'nothing: small', review: 'clean', deadcode: 'clean' })
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('ci')
  expect(w.ready.length).toBe(1)
  expect(w.ready[0]).toContain('pr-ready 12')
})

test('finishedReview makes no GraphQL call for a PR that is already ready', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' } })
  await start($, w)
  await tool($, 'finishedReview', { remembered: 'nothing: small', review: 'clean', deadcode: 'clean' })
  expect(w.ready.length).toBe(0)
})

// ---- done ----
const finishing = (over: Record<string, unknown> = {}) => ({ state: 'finishing', evidence: { checks: { sha: SHA, text: 'green' } }, ...over })

test('done refuses with a dirty tree and lists every problem', async ($, on) => {
  const w = engine(on, { wf: finishing(), checks: CHECKS({ name: 'ci', conclusion: 'failure' }) })
  await start($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'done', { message: 'finished', remembered: 'none: nothing durable' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('a.ts')
  expect(r.text).toContain('Red checks on HEAD: ci (failure)')
  expect(w.state()?.state).toBe('finishing')
})

test('done passes when the tree, the checks and the evidence are clean', async ($, on) => {
  const w = engine(on, { wf: finishing() })
  await start($, w)
  const r = await tool($, 'done', { message: 'finished', remembered: 'none: nothing durable' })
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('done')
})

test('done refuses stale evidence', async ($, on) => {
  const w = engine(on, { wf: finishing({ evidence: { checks: { sha: 'old', text: 'green' } } }) })
  await start($, w)
  const r = await tool($, 'done', { message: 'finished', remembered: 'none: nothing durable' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('finishedChecks has no record for HEAD')
  expect(w.state()?.state).toBe('finishing')
})

test('done at small_project leaves the merge to the human', async ($, on) => {
  const w = engine(on, { wf: finishing(), config: { projectLevel: 'small_project' } })
  await start($, w)
  await tool($, 'done', { message: 'finished', remembered: 'none: nothing durable' })
  expect(w.state()?.state).toBe('done')
  expect(w.merges).toEqual([])
})

test('done at poc merges the PR', async ($, on) => {
  const w = engine(on, { wf: finishing(), config: { projectLevel: 'poc' } })
  await start($, w)
  const r = await tool($, 'done', { message: 'finished', remembered: 'none: nothing durable' })
  expect(r.isError).toBe(false)
  expect(w.merges).toEqual(['12'])
  expect(r.text).toContain('PR #12 is merged')
})

// ---- blocked ----
test('blocked raises the alert, and unblocked withdraws it and restores the state', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const b = await tool($, 'blocked', { message: 'Which database?' })
  expect(b.isError).toBe(false)
  expect(w.state()?.state).toBe('blocked')
  expect(w.alerts).toEqual(['raise'])
  const u = await tool($, 'unblocked', { message: 'Postgres' })
  expect(u.isError).toBe(false)
  expect(w.state()?.state).toBe('developing')
  expect(w.alerts).toEqual(['raise', 'withdraw'])
})

// ---- like /goal: the turn end ----
test('a turn that ends before done gets the next step, with no GitHub call', async ($, on) => {
  const w = engine(on)
  await start($, w)
  await turnEnds($)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0]).toContain('in the state "developing"')
  expect(w.gh).toEqual([])
})

test('a turn end says nothing when blocked, done, typed over, aborted or a helper runs', async ($, on) => {
  const w = engine(on)
  await start($, w)
  await turnEnds($, 'aborted')
  w.s.draft = 'I am typing'
  await turnEnds($)
  w.s.draft = ''
  w.s.agents = [{ id: 'a1', status: 'running' }]
  await turnEnds($)
  w.s.agents = []
  await tool($, 'blocked', { message: 'help' })
  await turnEnds($)
  expect(w.prompts).toEqual([])
})

test('three turn ends with no progress reach the human as a block', async ($, on) => {
  const w = engine(on)
  await start($, w)
  for (let i = 0; i < 4; i++) await turnEnds($)
  expect(w.prompts.length).toBe(3)
  expect(w.state()?.state).toBe('blocked')
  expect(w.alerts).toEqual(['raise'])
})

test('progress resets the count of reminders', async ($, on) => {
  const w = engine(on)
  await start($, w)
  for (let i = 0; i < 3; i++) await turnEnds($)
  w.s.sha = 'cccc'
  await turnEnds($)
  expect(w.state()?.state).toBe('developing')
  expect(w.prompts.length).toBe(4)
})

// ---- the idle heartbeat ----
test('idle with a clean PR: one REST read, a compaction and the next step', async ($, on) => {
  const w = engine(on)
  await start($, w)
  await idle(w)
  expect(w.gh.length).toBe(1)
  expect(w.gh[0]).toContain('pr-read 12')
  expect(w.ready).toEqual([])
  expect(w.compacts.length).toBe(1)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0]).not.toContain('Fix these first')
})

test('idle with a merge conflict tells the agent', async ($, on) => {
  const w = engine(on, { pr: { mergeable: false, mergeable_state: 'dirty' } })
  await start($, w)
  await idle(w)
  expect(w.prompts[0]).toContain('PR #12 has merge conflicts')
  expect(w.prompts[0]).toContain('ndev:resolving-merge-conflicts')
})

test('idle with a failed check names it', async ($, on) => {
  const w = engine(on, { pr: { mergeable_state: 'unstable' }, checks: CHECKS({ name: 'unit tests', conclusion: 'failure' }) })
  await start($, w)
  await idle(w)
  expect(w.prompts[0]).toContain('failed checks')
  expect(w.prompts[0]).toContain('unit tests (failure)')
})

test('a clean PR needs no read of its checks; only another state costs that', async ($, on) => {
  const w = engine(on)
  await start($, w)
  await idle(w)
  expect(w.gh.some(c => c.includes('commit-checks'))).toBe(false)
})

test('a pending check is not a failure', async ($, on) => {
  const w = engine(on, { pr: { mergeable_state: 'unstable' }, checks: CHECKS({ name: 'ci', status: 'in_progress', conclusion: null }) })
  await start($, w)
  await idle(w)
  expect(w.prompts[0]).not.toContain('Fix these first')
})

test('a read of GitHub that fails is said, not read as a clean PR, and the reminder still goes', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.ghFails = 'HTTP 403: API rate limit exceeded'
  await idle(w)
  expect(w.toasts.join()).toContain('PR #12 was not read')
  expect(w.toasts.join()).toContain('rate limit')
  expect(w.prompts.length).toBe(1)
})

test('idle under a draft in the prompt box makes no GitHub call', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.draft = 'typing'
  await idle(w)
  expect(w.gh).toEqual([])
  expect(w.prompts).toEqual([])
})

test('a PR that waits for the human stays silent while clean', async ($, on) => {
  const w = engine(on, { wf: { state: 'done' } })
  await start($, w)
  await idle(w)
  expect(w.gh.length).toBe(1)
  expect(w.prompts).toEqual([])
  expect(w.compacts).toEqual([])
  expect(w.state()?.state).toBe('done')
})

test('a conflict under a finished PR reopens the work', async ($, on) => {
  const w = engine(on, { wf: { state: 'done' }, pr: { mergeable: false, mergeable_state: 'dirty' } })
  await start($, w)
  await idle(w)
  expect(w.state()?.state).toBe('revising')
  expect(w.prompts[0]).toContain('merge conflicts')
})

test('a merged PR ends the watch: no more GitHub calls', async ($, on) => {
  const w = engine(on, { wf: { state: 'done' }, pr: { state: 'closed', merged: true } })
  await start($, w)
  await idle(w)
  expect(w.gh.length).toBe(1)
  await idle(w)
  await idle(w)
  expect(w.gh.length).toBe(1)
  expect(w.prompts).toEqual([])
})

test('a PR closed with no merge during the work reaches the human', async ($, on) => {
  const w = engine(on, { pr: { state: 'closed', merged: false } })
  await start($, w)
  await idle(w)
  expect(w.state()?.state).toBe('blocked')
  expect(w.state()?.blocked?.message).toContain('closed with no merge')
})

test('the same conflict after a second idle period reaches the human', async ($, on) => {
  const w = engine(on, { pr: { mergeable: false, mergeable_state: 'dirty' } })
  await start($, w)
  await idle(w)
  await idle(w)
  expect(w.state()?.state).toBe('blocked')
  expect(w.state()?.blocked?.message).toContain('merge conflicts')
})

// ---- the workflow watches the checks, so the agent starts no wait of its own ----
// One check period passes, and the watchdog's timer fires.
const poll = async (w: W, ms = 4 * 60_000) => {
  w.s.now += ms
  w.timers.splice(0).forEach(fire => fire())
  await settle()
}
const RUNNING = CHECKS({ name: 'unit tests', status: 'in_progress', conclusion: null })

test('in ci the agent is told not to wait, and the turn end gets no reminder', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, checks: RUNNING })
  await start($, w)
  const r = await tool($, 'status')
  expect(r.text).toContain('Do not run a wait helper')
  expect(r.text).not.toContain('Run wait-for-pr-change.sh')
  await turnEnds($)
  expect(w.prompts).toEqual([])
})

test('pending checks make no prompt, and one check period costs two GitHub calls', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, pr: { mergeable_state: 'unstable' }, checks: RUNNING })
  await start($, w)
  await poll(w)
  expect(w.gh.length).toBe(2)
  expect(w.prompts).toEqual([])
  expect(w.compacts).toEqual([])
})

test('a timer fire inside the check period makes no GitHub call', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, checks: RUNNING })
  await start($, w)
  await poll(w)
  const calls = w.gh.length
  await poll(w, 60_000)
  expect(w.gh.length).toBe(calls)
})

test('a failed check reaches the agent as soon as it is read, with no compaction', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, pr: { mergeable_state: 'unstable' }, checks: CHECKS({ name: 'unit tests', conclusion: 'failure' }) })
  await start($, w)
  await poll(w)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0]).toContain('unit tests (failure)')
  expect(w.prompts[0]).toContain('checkpoint')
  expect(w.compacts).toEqual([])
})

test('a merge conflict reaches the agent while the checks still run', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, pr: { mergeable: false, mergeable_state: 'dirty' }, checks: RUNNING })
  await start($, w)
  await poll(w)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0]).toContain('PR #12 has merge conflicts')
})

test('green checks tell the agent to call finishedChecks', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, checks: RUNNING })
  await start($, w)
  await poll(w)
  expect(w.prompts).toEqual([])
  w.s.checks = CHECKS({ name: 'unit tests', conclusion: 'success' })
  await poll(w)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0]).toContain('call finishedChecks')
})

test('the same red checks with no progress reach the human, and do not prompt for ever', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, pr: { mergeable_state: 'unstable' }, checks: CHECKS({ name: 'unit tests', conclusion: 'failure' }) })
  await start($, w)
  for (let i = 0; i < 4; i++) await poll(w)
  expect(w.prompts.length).toBe(3)
  expect(w.state()?.state).toBe('blocked')
  expect(w.state()?.blocked?.message).toContain('unit tests (failure)')
})

test('a failed read of GitHub is named, and is not taken for green', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' } })
  await start($, w)
  w.s.ghFails = 'commit-checks'
  await poll(w)
  expect(w.prompts).toEqual([])
  expect(w.toasts.join('\n')).toContain('checks')
})

test('checks stuck for an hour reach the agent, and then the human', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, checks: RUNNING })
  await start($, w)
  await poll(w, 61 * 60_000)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0]).toContain('unit tests')
  expect(w.prompts[0]).toContain('60 minutes')
  await poll(w, 61 * 60_000)
  expect(w.state()?.state).toBe('blocked')
})

test('a person typing holds the read and the prompt', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, checks: CHECKS({ name: 'unit tests', conclusion: 'failure' }) })
  await start($, w)
  w.s.draft = 'half a thought'
  await poll(w)
  expect(w.gh).toEqual([])
  expect(w.prompts).toEqual([])
})

for (const command of ['/x/scripts/github/wait-for-pr-change.sh 12 --skip-success --json', 'bash scripts/github/wait-for-run.sh 99', 'gh pr checks 12 --watch', 'gh run watch 99']) {
  test(`in ci the agent's own wait is refused: ${command}`, async ($, on) => {
    const w = engine(on, { wf: { state: 'ci' } })
    await start($, w)
    const r = await hookCall($, 'Bash', { command })
    expect(JSON.stringify(r)).toContain('The workflow watches the checks')
  })
}

test('a one-off read of the checks is not a wait, and stays allowed', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' } })
  await start($, w)
  const r = await hookCall($, 'Bash', { command: 'gh pr checks 12' })
  expect(JSON.stringify(r)).not.toContain('The workflow watches the checks')
})

for (const [name, wf] of [['developing', { state: 'developing' }], ['a workflow turned off', { state: 'ci', off: { at: 1, reason: 'r' } }]] as const) {
  test(`with ${name}, a wait helper is allowed`, async ($, on) => {
    const w = engine(on, { wf })
    await start($, w)
    const r = await hookCall($, 'Bash', { command: 'wait-for-pr-change.sh 12' })
    expect(JSON.stringify(r)).not.toContain('The workflow watches the checks')
  })
}

test('checks pending at done: the workflow watches them too, and says when to call done again', async ($, on) => {
  const w = engine(on, { wf: { state: 'finishing', evidence: { checks: { sha: SHA, text: 'green' } } }, checks: RUNNING })
  await start($, w)
  const r = await tool($, 'done', { message: 'm', remembered: 'nothing: small' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('Do not run a wait helper')
  await turnEnds($)
  expect(w.prompts).toEqual([])
  expect(JSON.stringify(await hookCall($, 'Bash', { command: 'wait-for-pr-change.sh 12' }))).toContain('The workflow watches the checks')
  w.s.checks = CHECKS({ name: 'unit tests', conclusion: 'success' })
  await poll(w)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0]).toContain('call done')
})

// ---- Orca: the workspace shows the workflow ----
const arg = (call: string[] | undefined, flag: string) => (call && call.includes(flag) ? call[call.indexOf(flag) + 1] : undefined)
const inOrca = (w: W) => {
  w.s.orcaOn = true
  w.s.orcaFails = ''
}

test('a new workflow needs a short name, and the refusal comes before any claim and names the issue title', async ($, on) => {
  const w = engine(on, { wf: null, main: true })
  await start($, w)
  const r = await tool($, 'started', { issue: 7 })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('shortName')
  expect(r.text).toContain('"T"')
  expect(w.state()).toBeUndefined()
  expect(w.steps.join()).not.toContain('worktree_claim')
})

test('started refuses a short name that is not lower-case words, or that repeats the issue number', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  for (const bad of ['Add Sub', 'add_sub', '-add', '7-add-sub', 'a'.repeat(41)]) {
    const r = await tool($, 'started', { issue: 7, shortName: bad })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('shortName')
  }
  expect(w.state()).toBeUndefined()
})

test('the short name stays in the record, and a resume does not need it again', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect((w.state() as { shortName?: string })?.shortName).toBe('add-sub')
  const again = await tool($, 'started', { issue: 7 })
  expect(again.isError).toBe(false)
  expect((w.state() as { shortName?: string })?.shortName).toBe('add-sub')
})

test('a record from before short names resumes, and the answer asks for one', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  const r = await tool($, 'started', { issue: 7 })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('shortName')
})

test('started names the Orca workspace <issue>-<short name> and sets its status, by the folder of the worktree', async ($, on) => {
  const w = engine(on, { wf: null })
  inOrca(w)
  await start($, w)
  await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  const all = w.orcaCalls.flat().join(' ')
  expect(all).toContain('--display-name 7-add-sub')
  expect(all).toContain('--workspace-status in-progress')
  expect(all).toContain('--issue 7')
  expect(all).toContain('--pr 12')
  for (const c of w.orcaCalls) expect(arg(c, '--worktree')).toBe(`path:${ROOT}`)
  expect(w.orcaCalls.map(c => arg(c, '--comment')).join()).toContain('developing')
})

test('outside Orca, the workflow makes no Orca call', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(w.orcaCalls).toEqual([])
})

test('a change of state sends only what changed, and a save with no change sends nothing', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing', evidence: {} }, pr: { draft: true } })
  inOrca(w)
  await start($, w)
  await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  w.orcaCalls.length = 0
  await tool($, 'started', { issue: 7 })
  expect(w.orcaCalls).toEqual([])
  await tool($, 'finishedReview', { remembered: 'nothing: small', review: 'passed', deadcode: 'skipped: none' })
  expect(w.state()?.state).toBe('ci')
  expect(w.orcaCalls.length).toBe(1)
  const c = w.orcaCalls[0]!
  expect(arg(c, '--comment')).toContain('ci')
  expect(c).not.toContain('--display-name')
  expect(c).not.toContain('--workspace-status')
})

test('blocked flags the workspace and keeps its status, and unblocked clears the flag', async ($, on) => {
  const w = engine(on, { wf: null })
  inOrca(w)
  await start($, w)
  await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  w.orcaCalls.length = 0
  await tool($, 'blocked', { message: 'needs a key' })
  expect(arg(w.orcaCalls[0], '--comment')).toBe('Blocked: needs a key')
  expect(w.orcaCalls[0]).toContain('--unread')
  expect(w.orcaCalls[0]).not.toContain('--workspace-status')
  w.orcaCalls.length = 0
  await tool($, 'unblocked', { message: 'key added' })
  expect(w.orcaCalls[0]).toContain('--read')
  expect(arg(w.orcaCalls[0], '--comment')).toContain('developing')
})

test('done moves the workspace to in-review and flags it, with the message of the agent', async ($, on) => {
  const w = engine(on, { wf: { state: 'finishing', evidence: { checks: { sha: SHA, text: 'green' } }, shortName: 'add-sub' } })
  inOrca(w)
  await start($, w)
  const r = await tool($, 'done', { message: 'finished the sub function', remembered: 'nothing: no lesson' })
  expect(r.isError).toBe(false)
  const c = w.orcaCalls.at(-1)!
  expect(arg(c, '--workspace-status')).toBe('in-review')
  expect(c).toContain('--unread')
  expect(arg(c, '--comment')).toContain('finished the sub function')
})

test('the heartbeat that sees the PR merged after done moves the workspace to completed', async ($, on) => {
  const w = engine(on, { wf: { state: 'done', evidence: {}, shortName: 'add-sub' }, pr: { state: 'closed', merged: true } })
  inOrca(w)
  await start($, w)
  await idle(w)
  expect(w.state()?.prsClosed).toBe(true)
  expect(arg(w.orcaCalls.at(-1), '--workspace-status')).toBe('completed')
})

test('a failed Orca call does not stop the tool, shows a toast with its output, and is sent again at the next save', async ($, on) => {
  const w = engine(on, { wf: null })
  inOrca(w)
  w.s.orcaFails = 'orca is not running'
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(r.isError).toBe(false)
  expect(w.toasts.join()).toContain('orca is not running')
  expect(w.toasts.join()).toContain('#7')
  w.s.orcaFails = ''
  w.orcaCalls.length = 0
  await tool($, 'started', { issue: 7 })
  expect(w.orcaCalls.flat().join(' ')).toContain('--display-name 7-add-sub')
})

test('a project that commits to its base branch keeps the name of its main checkout', async ($, on) => {
  const w = engine(on, { wf: { direct: true, state: 'developing', shortName: 'add-sub' } })
  inOrca(w)
  await start($, w)
  await tool($, 'blocked', { message: 'needs a key' })
  expect(w.orcaCalls.flat()).not.toContain('--display-name')
})

// ---- followUp with the mode worktree ----
const workerStarts = (w: W) => w.orcaCalls.filter(c => c[0] === 'orchestration' && c[1] === 'worker-start')
const onDeveloping = async ($: Dollar, on: On) => {
  const w = engine(on, { wf: { state: 'developing', shortName: 'add-sub' } })
  inOrca(w)
  await start($, w)
  return w
}

test('a worktree follow-up files one issue and starts one worker in a new workspace named <issue>-<short name>', async ($, on) => {
  const w = await onDeveloping($, on)
  const r = await tool($, 'followUp', { mode: 'worktree', message: 'Tidy: the old Config loader\nbody' })
  expect(w.gh.filter(c => c.includes('issue-new')).length).toBe(1)
  const started = workerStarts(w)
  expect(started.length).toBe(1)
  expect(arg(started[0], '--worktree')).toBe('new-top-level')
  expect(arg(started[0], '--name')).toBe('31-tidy-the-old-config-loader')
  expect(started[0]).toContain('--keep-open')
  expect(arg(started[0], '--spec')).toContain('shortName "tidy-the-old-config-loader"')
  expect(arg(started[0], '--spec')).toContain('body')
  expect(w.gh.some(c => c.includes('subissues link 7 31'))).toBe(true)
  expect(r.text).toContain('run_1')
})

test('the old mode name orca_workspace is refused, and the refusal names worktree', async ($, on) => {
  const w = await onDeveloping($, on)
  const r = await tool($, 'followUp', { mode: 'orca_workspace', message: 'Tidy\nbody' })
  expect(r.text).toContain('worktree')
  expect(r.text).toContain('Refused')
  expect(w.gh.filter(c => c.includes('issue-new'))).toEqual([])
  expect(workerStarts(w)).toEqual([])
})

test('a worktree follow-up with issues files nothing and starts one worker that carries them all on one PR', async ($, on) => {
  const w = await onDeveloping($, on)
  const r = await tool($, 'followUp', { mode: 'worktree', issues: [200, 166], message: 'Retire the runner\nThe brief' })
  expect(r.text).not.toContain('Refused')
  expect(w.gh.filter(c => c.includes('issue-new'))).toEqual([])
  const started = workerStarts(w)
  expect(started.length).toBe(1)
  expect(arg(started[0], '--name')).toBe('166-retire-the-runner')
  const spec = arg(started[0], '--spec')!
  expect(spec).toContain('The brief')
  expect(spec).toContain('issue 166')
  expect(spec).toContain('#200')
  expect(spec).toContain('same worktree and PR')
  expect(w.gh.some(c => c.includes('subissues link 7 166'))).toBe(true)
  expect(w.gh.some(c => c.includes('subissues link 7 200'))).toBe(true)
  expect(r.text).toContain('/issues/166')
  expect(r.text).toContain('/issues/200')
})

test('issues with a closed or unreadable issue are refused by number, and nothing starts', async ($, on) => {
  const w = await onDeveloping($, on)
  w.s.issueReadsFor = { 200: [{ state: 'closed', title: 'Old' }], 201: ['Could not resolve to an issue'] }
  const r = await tool($, 'followUp', { mode: 'worktree', issues: [166, 200, 201], message: 'Stage\nbrief' })
  expect(r.text).toContain('Refused')
  expect(r.text).toContain('#200 is closed')
  expect(r.text).toContain('#201')
  expect(r.text).toContain('Could not resolve')
  expect(workerStarts(w)).toEqual([])
  expect(w.gh.some(c => c.includes('subissues link'))).toBe(false)
})

test('bad issues are refused before any read: another mode, an empty list, a non-number and the calling issue', async ($, on) => {
  const w = await onDeveloping($, on)
  const reads = () => w.gh.filter(c => c.includes('issue-read 166')).length
  const before = reads()
  const refused = async (args: Record<string, unknown>, says: string) => {
    const r = await tool($, 'followUp', { message: 'Stage\nbrief', ...args })
    expect(r.text).toContain('Refused')
    expect(r.text).toContain(says)
  }
  await refused({ mode: 'issue_only', issues: [166] }, 'worktree')
  await refused({ mode: 'worktree', issues: [] }, 'issues')
  await refused({ mode: 'worktree', issues: ['abc'] }, 'abc')
  await refused({ mode: 'worktree', issues: [166, 7] }, '#7')
  expect(reads()).toBe(before)
  expect(workerStarts(w)).toEqual([])
})

test('the same worktree call again starts no second worker, and an issue with a worker is not started by another call', async ($, on) => {
  const w = await onDeveloping($, on)
  await tool($, 'followUp', { mode: 'worktree', issues: [166], message: 'Stage\nbrief' })
  const again = await tool($, 'followUp', { mode: 'worktree', issues: [166], message: 'Stage\nbrief' })
  expect(again.text).not.toContain('Refused')
  expect(again.text).toContain('ctx_1')
  expect(workerStarts(w).length).toBe(1)
  const other = await tool($, 'followUp', { mode: 'worktree', issues: [166, 200], message: 'Another\nbrief' })
  expect(other.text).toContain('Refused')
  expect(other.text).toContain('#166')
  expect(workerStarts(w).length).toBe(1)
})

test('a sub-issue link that fails is said with its repair, and the worker still counts as started', async ($, on) => {
  const w = await onDeveloping($, on)
  w.s.linkFails = 'Issue may not contain duplicate sub-issues'
  const r = await tool($, 'followUp', { mode: 'worktree', issues: [166], message: 'Stage\\nbrief' })
  expect(r.text).toContain('#166 is not a sub-issue of #7')
  expect(r.text).toContain('duplicate sub-issues')
  expect(r.text).toContain('subissues link 7 166')
  expect(r.text).toContain('ctx_1')
})

test('a worker that does not start is refused with what Orca said, by its receipt and not its exit code, and a retry starts it', async ($, on) => {
  const w = await onDeveloping($, on)
  w.s.workerReceipt = { ok: true, result: { state: 'failed', lastError: 'agent_prompt_blocked', failedStage: 'launch', recovery: 'Answer the prompt' } }
  const r = await tool($, 'followUp', { mode: 'worktree', issues: [166], message: 'Stage\nbrief' })
  expect(r.text).toContain('agent_prompt_blocked')
  expect(r.text).toContain('Answer the prompt')
  expect(r.text).toContain('#166')
  expect(w.gh.some(c => c.includes('subissues link'))).toBe(false)
  w.s.workerReceipt = undefined
  const retry = await tool($, 'followUp', { mode: 'worktree', issues: [166], message: 'Stage\nbrief' })
  expect(retry.text).not.toContain('Refused')
  expect(workerStarts(w).length).toBe(2)
})

// ---- a follow-up agent works in its own worktree ----
const CLAIMED = '/claimed/issue-7'
const AGENT = { agentId: 'agent-31', worktree: CLAIMED }
const startFollowUp = async ($: Dollar, w: W) => {
  await start($, w)
  const r = await tool($, 'followUp', { mode: 'subagent', message: 'Tidy the loader\nbody' })
  expect(r.text).toContain(CLAIMED)
}

test('a followUp subagent commits and pushes in its own worktree through checkpoint, with the checks', async ($, on) => {
  const w = engine(on)
  await startFollowUp($, w)
  expect(w.spawns[0]!.cwd).toBe(CLAIMED)
  expect(w.spawns[0]!.prompt).toContain('mcp__ndev__checkpoint')
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'checkpoint', { issue: 31, message: 'm', files: ['a.ts'], ...AGENT })
  expect(r.text).not.toContain('Refused')
  expect(r.isError).toBe(false)
  expect(w.s.commitDirs).toEqual([CLAIMED])
  expect(w.pushes).toHaveLength(1)
  expect(w.steps.join()).toContain('fast-checks.sh')
  expect(w.steps.join()).toContain('pre-commit-check.sh')
  expect(w.steps.join()).toContain('pre-push-check.sh')
})

test('a raw commit by a followUp subagent is refused and names its issue, its worktree and the tool', async ($, on) => {
  const w = engine(on)
  await startFollowUp($, w)
  const r = await $.tool.call({ tool: 'Bash', command: `git -C ${CLAIMED} commit -m x`, agentId: 'agent-31' } as never) as { deny?: string }
  expect(r.deny).toContain('#31')
  expect(r.deny).toContain(CLAIMED)
  expect(r.deny).toContain('mcp__ndev__checkpoint')
})

test('a followUp subagent adds its change types to its own record', async ($, on) => {
  const w = engine(on, { names: ['server/a.py'] })
  await startFollowUp($, w)
  w.s.dirty = [' M a.ts']
  expect((await tool($, 'checkpoint', { issue: 31, message: 'm', files: ['a.ts'], changeTypes: ['tests'], worktree: CLAIMED })).isError).toBe(false)
  expect(JSON.parse(w.files.get(`${CLAIMED}/.neil-dev.worktree.json`)!).workflows[31].changeTypes).toEqual(['tests', 'backend'])
  expect(w.state()?.changeTypes).toBeUndefined()
  expect((await tool($, 'checkpoint', { issue: 31, message: 'm', files: ['a.ts'], changeTypes: ['frontend'], worktree: CLAIMED })).text).toContain('web, backend')
})

test('a followUp subagent in a worktree with no check scripts is refused, is told the repair, and commits nothing', async ($, on) => {
  const w = engine(on)
  await startFollowUp($, w)
  w.s.scripts = false
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'checkpoint', { issue: 31, message: 'm', files: ['a.ts'], ...AGENT })
  expect(r.isError).toBe(true)
  expect(r.text).toContain(`${CLAIMED}`)
  expect(r.text).toContain('scripts/ndev/workflow/fast-checks.sh')
  expect(r.text).toContain('fast-checks-template.sh')
  expect(w.s.commitDirs).toEqual([])
})

test('the record of the main workflow stays on its issue, and its Orca workspace does not take the follow-up', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing', shortName: 'add-sub' } })
  inOrca(w)
  await startFollowUp($, w)
  w.s.dirty = [' M a.ts']
  await tool($, 'checkpoint', { message: 'm', files: ['a.ts'], ...AGENT })
  expect(w.state()!.issue).toBe(7)
  expect(w.state()!.state).toBe('developing')
  expect(JSON.parse(w.files.get(`${CLAIMED}/.neil-dev.worktree.json`)!).workflows[31].issue).toBe(31)
  expect(JSON.stringify(w.orcaCalls)).not.toContain('"31"')
})

test('a followUp retry after a refused spawn reuses the worktree and says so', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.spawnDeny = 'no agents now'
  const first = await tool($, 'followUp', { mode: 'subagent', message: 'Tidy\nbody' })
  expect(first.isError).toBe(true)
  expect(first.text).toContain('no agents now')
  w.s.spawnDeny = ''
  const again = await tool($, 'followUp', { mode: 'subagent', message: 'Tidy\nbody' })
  expect(again.isError).toBe(false)
  expect(w.spawns.at(-1)!.cwd).toBe(CLAIMED)
})

test('checkpoint refuses a worktree that followUp did not start, and names those it did', async ($, on) => {
  const w = engine(on)
  await startFollowUp($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'checkpoint', { message: 'm', files: ['a.ts'], agentId: 'agent-31', worktree: '/elsewhere' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('/elsewhere')
  expect(r.text).toContain(CLAIMED)
  expect(w.s.commitDirs).toEqual([])
})

test('a helper that followUp did not start still cannot call checkpoint', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const r = await tool($, 'checkpoint', { message: 'm', files: ['a.ts'], agentId: 'helper-1' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('only the main agent')
})

// ---- requestSecret and addMigration ----
test('requestSecret gives the first file in order and the line, never the value', async ($, on) => {
  engine(on, { files: { [`${ROOT}/.env`]: '# c\nAPI_KEY=hunter2\n', '/home/neil/.zshrc': 'export API_KEY=other\n' } })
  await start($)
  const r = await tool($, 'requestSecret', { name: 'API_KEY' })
  expect(r.isError).toBe(false)
  expect(r.text).toContain(`${ROOT}/.env`)
  expect(r.text).toContain('2')
  expect(r.text).not.toContain('hunter2')
})

test('requestSecret says where it looked when it finds nothing', async ($, on) => {
  engine(on)
  await start($)
  const r = await tool($, 'requestSecret', { name: 'NOPE' })
  expect(r.text).toContain('.neil-dev.env')
  expect(r.text).toContain('.bashrc')
})

// ---- what the workflow took over from the hooks ----
const QUALITY = { quality: { editedFileGuards: {}, precheckReminder: {}, worktreeSubmodules: { paths: ['.claude/agents'] } } }
const hookCall = async ($: Dollar, name: 'Edit' | 'Bash', args: Record<string, unknown>) =>
  (await $.tool.call({ tool: name, ...args } as never)) as { context?: string[] }

test('a commit runs fast-checks.sh on the files, then pre-commit-check.sh, then commits', async ($, on) => {
  const w = engine(on, { names: ['a.py', 'b.ts'] })
  await start($, w)
  w.s.dirty = [' M a.py', ' M b.ts']
  await tool($, 'checkpoint', { message: 'm', files: ['a.py', 'b.ts'] })
  const order = w.steps.filter(x => x.startsWith('ndev-') || x.includes('-check') || x.includes('fast-checks') || x === 'commit')
  expect(order.slice(0, 3)).toEqual(['fast-checks.sh a.py b.ts', 'pre-commit-check.sh', 'commit'])
})

test('a failed fast check stops the commit and the slower checks, and names the script', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.dirty = [' M a.ts']
  w.s.failCheck = 'fast-checks.sh'
  const r = await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('scripts/ndev/workflow/fast-checks.sh exited 3')
  expect(w.commits).toEqual([])
  expect(w.steps.some(x => x.includes('pre-commit-check'))).toBe(false)
})

test('started asks for fast-checks.sh, and says it holds the fast tools only', async ($, on) => {
  const w = engine(on, { wf: null, scripts: false })
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(r.text).toContain('scripts/ndev/workflow/fast-checks.sh')
  expect(r.text).toContain('ruff')
})

test('started initialises the submodules of the worktree it claims', async ($, on) => {
  const w = engine(on, { wf: null, main: true, config: QUALITY })
  await start($, w)
  expect((await tool($, 'started', { issue: 7, shortName: 'add-sub' })).isError).toBe(false)
  expect(w.steps).toContain('init-worktree-submodules.sh')
  expect(w.submodules).toEqual([{ command: 'git worktree add /claimed/issue-7', paths: '.claude/agents' }])
})

test('started claims no submodules with no setting for them', async ($, on) => {
  const w = engine(on, { wf: null, main: true })
  await start($, w)
  expect((await tool($, 'started', { issue: 7, shortName: 'add-sub' })).isError).toBe(false)
  expect(w.steps).not.toContain('init-worktree-submodules.sh')
})

test('finishedDevelopment hands the changed UI files to the review, and only those', async ($, on) => {
  const w = engine(on, { names: ['src/Card.tsx', 'src/Card.test.tsx', 'lib/a.ts'] })
  await start($, w)
  const r = await tool($, 'finishedDevelopment', { prs: [12] })
  expect(r.text).toContain('Component map')
  expect(r.text).toContain('src/Card.tsx')
  expect(r.text).not.toContain('Card.test.tsx')
})

test('finishedDevelopment says nothing of components with no UI file', async ($, on) => {
  const w = engine(on, { names: ['lib/a.ts'] })
  await start($, w)
  const r = await tool($, 'finishedDevelopment', { prs: [12] })
  expect(r.text).not.toContain('Component map')
})

test('the finishing step asks for the dev-wiki ingest', async ($, on) => {
  const w = engine(on, { wf: { state: 'finishing' } })
  await start($, w)
  expect((await tool($, 'status')).text).toContain('ndev:dev-wiki')
})

test('while a workflow runs, the edit, commit, push and component hooks stand aside', async ($, on) => {
  const w = engine(on, { config: QUALITY })
  await start($, w)
  const edit = await hookCall($, 'Edit', { file_path: `${ROOT}/src/Card.tsx`, old_string: 'a', new_string: 'b' })
  const commit = await hookCall($, 'Bash', { command: 'git commit -m x' })
  const push = await hookCall($, 'Bash', { command: 'git push' })
  expect(w.steps.filter(x => x.includes('edited-file-guards') || x.includes('precheck-reminder'))).toEqual([])
  expect([...(edit.context ?? []), ...(commit.context ?? []), ...(push.context ?? [])]).toEqual([])
})

for (const [name, opts] of [
  ['no workflow', { wf: null }],
  ['a workflow in setup', { wf: { state: 'setup' } }],
  ['a skipped setup', { wf: { noChecks: true } }],
  ['a workflow turned off', { wf: { off: { at: 1, reason: 'r' } } }],
  ['a finished workflow', { wf: { state: 'done' } }],
] as const) {
  test(`with ${name}, the hooks still run`, async ($, on) => {
    const w = engine(on, { ...opts, config: QUALITY } as never)
    await start($, w)
    const edit = await hookCall($, 'Edit', { file_path: `${ROOT}/src/Card.tsx`, old_string: 'a', new_string: 'b' })
    const commit = await hookCall($, 'Bash', { command: 'git commit -m x' })
    const push = await hookCall($, 'Bash', { command: 'git push' })
    expect(w.steps.some(x => x.includes('edited-file-guards'))).toBe(true)
    expect(w.steps.some(x => x.includes('precheck-reminder'))).toBe(true)
    expect(edit.context?.join('\n')).toContain('Component map')
    expect(push.context?.join('\n')).toContain('ndev:dev-wiki')
    expect(commit).toBeDefined()
  })
}

// ---- stage hooks: fired by a change of state in the machine ----
test('entering reviewing fires the review hook, and the last commit waits for the review', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'] })
  expect(r.isError).toBe(false)
  expect(w.commits.length).toBe(1)
  expect(w.pushes.length).toBe(0)
  expect(r.text).toContain('Review')
  expect(r.text).toContain('not pushed')
  expect(w.state()?.hooks?.review?.result).toBeUndefined()
  expect(w.state()?.hooks?.review?.firedAt).toBeDefined()
})

test('a fix during the review is committed and held, and the hook does not fire twice', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing', hooks: { review: { firedAt: 111 } } } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'checkpoint', { message: 'fix', files: ['a.ts'] })
  expect(r.isError).toBe(false)
  expect(w.commits.length).toBe(1)
  expect(w.pushes.length).toBe(0)
  expect(w.state()?.hooks?.review?.firedAt).toBe(111)
})

test('finishedReview answers the review hook, then pushes, then marks the PR ready', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing', hooks: { review: { firedAt: 111 } } }, pr: { draft: true } })
  await start($, w)
  w.s.sha = 'cccc'
  const r = await tool($, 'finishedReview', { remembered: 'nothing: small', review: 'clean', deadcode: 'clean' })
  expect(r.isError).toBe(false)
  expect(w.pushes.length).toBe(1)
  expect(w.ready.length).toBe(1)
  expect(w.state()?.hooks?.review?.result).toBe('clean')
  expect(w.state()?.state).toBe('ci')
})

test('with no review result nothing is pushed', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' } })
  await start($, w)
  w.s.sha = 'cccc'
  const r = await tool($, 'finishedReview', { remembered: 'nothing: small', review: '', deadcode: 'clean' })
  expect(r.isError).toBe(true)
  expect(w.pushes.length).toBe(0)
})

test('a failed pre-ready check stops the push', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' } })
  await start($, w)
  w.s.sha = 'cccc'
  w.s.failCheck = 'pre-ready-check.sh'
  const r = await tool($, 'finishedReview', { remembered: 'nothing: small', review: 'clean', deadcode: 'clean' })
  expect(r.isError).toBe(true)
  expect(w.pushes.length).toBe(0)
})

test('a held commit can be pushed with an empty checkpoint after a human skips the review', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' } })
  await start($, w)
  w.s.sha = 'cccc'
  const r = await tool($, 'checkpoint', { message: 'push the held commit', files: [] })
  expect(r.isError).toBe(false)
  expect(w.pushes.length).toBe(1)
})

test('an empty checkpoint with nothing to push is still refused', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' } })
  await start($, w)
  const r = await tool($, 'checkpoint', { message: 'm', files: [] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('files')
})

test('done refuses with no remember result and changes nothing', async ($, on) => {
  const w = engine(on, { wf: finishing() })
  await start($, w)
  const r = await tool($, 'done', { message: 'finished' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('remembered')
  expect(w.state()?.state).toBe('finishing')
})

test('done records the remember result', async ($, on) => {
  const w = engine(on, { wf: finishing() })
  await start($, w)
  const r = await tool($, 'done', { message: 'finished', remembered: 'wiki page updated' })
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('done')
  expect(w.state()?.hooks?.remember?.result).toBe('wiki page updated')
})

test('a formal_project does not skip the remember hook', async ($, on) => {
  const w = engine(on, { wf: finishing(), config: { projectLevel: 'formal_project' } })
  await start($, w)
  const r = await tool($, 'done', { message: 'finished', remembered: 'skipped: no time' })
  expect(r.isError).toBe(true)
  expect(w.state()?.state).toBe('finishing')
})

test('a return from blocked does not fire a hook again', async ($, on) => {
  const w = engine(on, { wf: { state: 'blocked', previous: 'reviewing', blocked: { message: 'm', at: 1, group: 'g' }, hooks: { review: { firedAt: 111 } } } })
  await start($, w)
  await tool($, 'unblocked', { message: 'answered' })
  expect(w.state()?.state).toBe('reviewing')
  expect(w.state()?.hooks?.review?.firedAt).toBe(111)
})

test('a human move into a stage fires its hook too', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  await command($, 'skip')
  expect(w.state()?.state).toBe('reviewing')
  expect(w.state()?.hooks?.review?.firedAt).toBeDefined()
})

test('after a human skips the review, finishedChecks names the held commit and how to push it', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' } })
  await start($, w)
  w.s.sha = 'cccc'
  await command($, 'skip no time')
  expect(w.state()?.state).toBe('ci')
  const r = await tool($, 'finishedChecks')
  expect(r.isError).toBe(true)
  expect(r.text).toContain('checkpoint')
  expect(r.text).toContain('no files')
})

// ---- from the human's own messages: what they had to type, and now need not ----
test('each next step says that a question for the human goes through blocked', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  const r = await tool($, 'status')
  expect(r.text).toContain('call blocked')
  expect(r.text).toContain('already allows')
})

test('the turn-end reminder says to wait in the foreground', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  await turnEnds($)
  expect(w.prompts.at(-1)).toContain('background wait')
})

test('finishing asks that no chore is left for the human', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' } })
  await start($, w)
  const r = await tool($, 'finishedChecks')
  expect(r.text).toContain('followUp')
})

test('the smoke step asks for the preview URL in the report', async ($, on) => {
  const w = engine(on, { wf: { state: 'smoke' } })
  await start($, w)
  expect((await tool($, 'status')).text).toContain('preview URL in the report')
})

test('finishedDevelopment names a migration file that addMigration does not list', async ($, on) => {
  const w = engine(on, { names: ['supabase/migrations/20260101_add.sql', 'a.ts'] })
  await start($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'] })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('supabase/migrations/20260101_add.sql')
  expect(r.text).toContain('addMigration')
})

test('done refuses a migration file that nothing will run, and names it', async ($, on) => {
  const w = engine(on, { wf: finishing(), names: ['supabase/migrations/20260101_add.sql'] })
  await start($, w)
  const r = await tool($, 'done', { message: 'finished', remembered: 'nothing: small' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('Nothing will run')
  expect(r.text).toContain('supabase/migrations/20260101_add.sql')
  expect(w.state()?.state).toBe('finishing')
})

test('done passes a migration file that addMigration lists', async ($, on) => {
  const path = 'supabase/migrations/20260101_add.sql'
  const w = engine(on, { wf: { ...finishing(), migrations: [{ name: 'add', path }] }, names: [path] })
  await start($, w)
  const r = await tool($, 'done', { message: 'finished', remembered: 'nothing: small' })
  expect(r.text).not.toContain('Nothing will run')
})

// ---- from the independent review ----
test('a retry after a failed pre-push commits the fix and pushes it', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.failCheck = 'pre-push'
  w.s.dirty = [' M a.ts']
  expect((await tool($, 'checkpoint', { message: 'one', files: ['a.ts'] })).isError).toBe(true)
  expect(w.pushes.length).toBe(0)
  w.s.failCheck = ''
  const r = await tool($, 'checkpoint', { message: 'fix', files: ['a.ts'] })
  expect(r.isError).toBe(false)
  expect(w.commits.length).toBe(2)
  expect(w.pushes.length).toBe(1)
})

test('a retry with an unnamed fix in the tree pushes nothing and names the file', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.failCheck = 'pre-push'
  w.s.dirty = [' M a.ts']
  await tool($, 'checkpoint', { message: 'one', files: ['a.ts'] })
  w.s.failCheck = ''
  const r = await tool($, 'checkpoint', { message: 'again', files: ['b.ts'].slice(1) })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('a.ts')
  expect(w.pushes.length).toBe(0)
})

test('a retry after a failed push with a clean tree pushes the same commit', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.pushFails = 'rejected'
  await tool($, 'checkpoint', { message: 'one', files: ['a.ts'] })
  w.s.pushFails = ''
  w.s.staged = false
  w.s.dirty = []
  const r = await tool($, 'checkpoint', { message: 'one', files: [] })
  expect(r.isError).toBe(false)
  expect(w.commits.length).toBe(1)
  expect(w.pushes.length).toBe(1)
})

test('a refused commit leaves nothing staged', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.failCheck = 'pre-commit'
  expect((await tool($, 'checkpoint', { message: 'one', files: ['a.ts'] })).isError).toBe(true)
  expect(w.s.staged).toBe(false)
  expect(w.steps).toContain('reset')
})

// ---- one record per issue ----
const bodyFile = (w: W) => [...w.files.keys()].find(k => k.endsWith('ndev-pr-body.md'))!
const seven = (over: Record<string, unknown> = {}) => flow(over)
const twelve = (over: Record<string, unknown> = {}) => flow({ issue: 12, shortName: 'other', ...over })

test('started keeps a finished issue in the record, beside the new one', async ($, on) => {
  const w = engine(on, { wf: { issue: 9, state: 'done', rev: 5, prs: [] } })
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(r.isError).toBe(false)
  expect(w.state()?.issue).toBe(7)
  expect(w.state(9)?.state).toBe('done')
})

test('started on a second issue makes it active in this agent, and the first keeps its state until the agent goes back', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  await tool($, 'started', { issue: 7 })
  const r = await tool($, 'started', { issue: 12, shortName: 'other-work' })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('Issue #12')
  expect(r.text).toContain(`Other issues in this worktree: #7 ("developing"`)
  expect(w.state()?.state).toBe('developing')
  expect((await tool($, 'status')).text).toContain('Issue #12')
  expect(w.state(12)?.branch).toBe('issue-7')
  const back = await tool($, 'started', { issue: 7 })
  expect(back.text).toContain('State: developing. Issue #7')
  expect((await tool($, 'status')).text).toContain('Issue #7')
})

test('an agent that leaves an issue gives it up, so another agent can take it at once', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  await tool($, 'started', { issue: 7 })
  await tool($, 'started', { issue: 12, shortName: 'other-work' })
  expect(w.state()?.owner).toBeUndefined()
  expect(w.state()?.lastSession).toBe('s1')
  expect(w.state(12)?.owner?.session).toBe('s1')
})

test('an issue that another live agent owns in this worktree stays refused', async ($, on) => {
  const w = engine(on, { wf: { owner: { session: 'other', at: 0 } } })
  await start($, w)
  expect((await tool($, 'started', { issue: 7 })).text).toContain('owns issue #7')
  expect(w.state()?.owner?.session).toBe('other')
})

test('a session that restarts finds the issue it owned among several', async ($, on) => {
  const w = engine(on, { wf: null, files: { [RECORD]: held(seven({ owner: { session: 'other', at: 0 } }), twelve({ state: 'ci' })) } })
  await start($, w)
  expect((await tool($, 'status')).text).toContain('PR #12')
})

test('a record with several issues and none of this agent\'s shows no workflow, and started picks one', async ($, on) => {
  const w = engine(on, { wf: null, files: { [RECORD]: held(seven({ owner: undefined }), twelve({ owner: undefined })) } })
  await start($, w)
  expect((await tool($, 'status')).text).toContain('No workflow in this session')
  expect((await tool($, 'started', { issue: 12 })).text).toContain('Issue #12')
})

test('a file with the old workflow key is read, and goes on from its revision', async ($, on) => {
  const w = engine(on, { wf: null, files: { [RECORD]: JSON.stringify({ version: 2, resources: {}, workflow: flow({ rev: 3 }) }) } })
  await start($, w)
  expect((await tool($, 'started', { issue: 7 })).isError).toBe(false)
  expect(w.state()?.rev).toBeGreaterThan(3)
  expect(JSON.parse(w.files.get(RECORD)!).workflow).toBeUndefined()
})

test('a second issue on an open PR adds its Closes line and keeps the first', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  await tool($, 'started', { issue: 7 })
  await tool($, 'started', { issue: 12, shortName: 'other-work' })
  expect(w.state(12)?.prs).toEqual([12])
  const body = w.files.get(bodyFile(w))!
  expect(body).toContain('Closes #7')
  expect(body).toContain('Closes #12')
})

test('finishedPlan keeps the plan and the Closes line of each other issue on the PR', async ($, on) => {
  const plan = 'The plan.\n\nTest entry point: x\n'
  const others = '<!-- ndev:plan:7 -->\nPlan of seven.\nCloses #7\n<!-- /ndev:plan:7 -->\n\nCloses #31\n'
  const w = engine(on, { wf: null, pr: { body: others }, files: { [RECORD]: held(seven({ state: 'developing', owner: undefined, lastSession: 'other' }), twelve({ state: 'planning' })), [`${ROOT}/plan.md`]: plan }, config: { mode: 'heavy' } })
  await start($, w)
  await tool($, 'started', { issue: 12 })
  const r = await tool($, 'finishedPlan', { markdown_file: 'plan.md' })
  expect(r.isError).toBe(false)
  const body = w.files.get(bodyFile(w))!
  expect(body).toContain('Plan of seven.')
  expect(body).toContain('The plan.')
  expect(body).toContain('Closes #7')
  expect(body).toContain('Closes #12')
  expect(body).toContain('Closes #31')
})

test('a second finishedPlan of one issue replaces its own plan', async ($, on) => {
  const old = '<!-- ndev:plan:7 -->\nOld plan.\nCloses #7\n<!-- /ndev:plan:7 -->\n'
  const w = engine(on, { wf: { state: 'planning' }, pr: { body: old }, files: { [`${ROOT}/plan.md`]: 'New plan.\n\nTest entry point: x\n' }, config: { mode: 'heavy' } })
  await start($, w)
  await tool($, 'started', { issue: 7 })
  expect((await tool($, 'finishedPlan', { markdown_file: 'plan.md' })).isError).toBe(false)
  const body = w.files.get(bodyFile(w))!
  expect(body).toContain('New plan.')
  expect(body).not.toContain('Old plan.')
  expect(body.match(/Closes #7/g)?.length).toBe(1)
})

test('done does not merge a PR while another issue on it is in development', async ($, on) => {
  const remembered = { remember: { firedAt: 1, result: 'wiki' } }
  const record = { version: 2, resources: {}, workflows: { 7: seven({ state: 'developed' }), 12: twelve({ state: 'developing', owner: undefined }) }, prs: { 12: flow({ pr: 12, issues: [7], ...finishing({ hooks: remembered }) }) } }
  const w = engine(on, { wf: null, config: { projectLevel: 'poc' }, files: { [RECORD]: JSON.stringify(record) } })
  await start($, w)
  const r = await tool($, 'done', { pr: 12, message: 'm' })
  expect(r.isError).toBe(false)
  expect(w.merges).toEqual([])
  expect(r.text).toContain('#12')
})

test('done merges a PR once for all its issues, and marks each of them merged', async ($, on) => {
  const remembered = { remember: { firedAt: 1, result: 'wiki' } }
  const w = engine(on, { wf: null, config: { projectLevel: 'poc' }, files: { [RECORD]: held(seven(finishing({ hooks: remembered })), twelve(finishing({ hooks: remembered, owner: undefined }))) } })
  await start($, w)
  const r = await tool($, 'done', { pr: 12, message: 'm' })
  expect(r.isError).toBe(false)
  expect(w.merges).toEqual(['12'])
  expect(w.prRecord(12)!.merged).toBe(true)
  expect(w.issueRecord(7)!.merged).toBe(true)
  expect(w.issueRecord(12)!.merged).toBe(true)
})

test('done leaves the merge to the skill when another issue on the PR has a migration', async ($, on) => {
  const remembered = { remember: { firedAt: 1, result: 'wiki' } }
  const record = { version: 2, resources: {}, workflows: { 7: seven({ state: 'developed', migrations: [{ name: 'add', path: 'supabase/migrations/1_add.sql' }], owner: undefined }), 12: twelve({ state: 'developed' }) }, prs: { 12: flow({ pr: 12, issues: [7, 12], ...finishing({ hooks: remembered }) }) } }
  const w = engine(on, { wf: null, config: { projectLevel: 'poc' }, files: { [RECORD]: JSON.stringify(record) } })
  await start($, w)
  const r = await tool($, 'done', { pr: 12, message: 'm' })
  expect(r.text).toContain('ndev:merge')
  expect(w.merges).toEqual([])
})

test('Orca shows the active issue each time the agent changes issue', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing', shortName: 'add-sub', orca: { name: '7-add-sub', issue: 7, status: 'in-progress', comment: 'x', attention: false } } })
  inOrca(w)
  await start($, w)
  await tool($, 'started', { issue: 12, shortName: 'other-work' })
  expect(JSON.stringify(w.orcaCalls.at(-1))).toContain('12')
  await tool($, 'started', { issue: 7 })
  expect(JSON.stringify(w.orcaCalls.at(-1))).toContain('"7"')
})

test('two blocked issues in one worktree have separate notifications', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  await tool($, 'started', { issue: 7 })
  await tool($, 'blocked', { message: 'first' })
  await tool($, 'started', { issue: 12, shortName: 'other-work' })
  await tool($, 'blocked', { message: 'second' })
  expect(w.state()?.blocked?.group).not.toBe(w.state(12)?.blocked?.group)
})

test('with setup skipped and no PR, the tools refuse and name started, which opens it', async ($, on) => {
  const w = engine(on, { wf: { state: 'setup', prs: [] } })
  await start($, w)
  await command($, 'skip no scripts yet')
  expect(w.prompts.at(-1)).toContain('call started')
  for (const [name, args] of [['finishedDevelopment', { prs: [], files: [] }], ['checkpoint', { message: 'm', files: ['a.ts'] }]] as const) {
    const r = await tool($, name, args)
    expect(r.isError).toBe(true)
    expect(r.text).toContain('Call started')
  }
  expect(w.commits.length).toBe(0)
  expect(await command($, 'goto done')).toContain('has no PR')
  expect((await tool($, 'started', { issue: 7, shortName: 'add-sub' })).isError).toBe(false)
  expect(w.state()?.prs).toEqual([12])
})

test('done refuses a workflow with no PR, which a human skip can leave', async ($, on) => {
  const w = engine(on, { wf: { ...finishing(), prs: [] } })
  await start($, w)
  const r = await tool($, 'done', { message: 'm', remembered: 'nothing: x' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('Call started')
  expect(w.state()?.state).toBe('finishing')
})

test('a record that holds a workflow is a good record for the stacks and the session start', async ($, on) => {
  const w = engine(on)
  await start($, w)
  expect(w.toasts.join(' ')).not.toContain('unknown top-level key')
})

test('a failed PR step in started keeps the record, so a retry resumes and does not claim again', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  w.s.noOpenPr = true
  w.s.pushFails = 'network down'
  expect((await tool($, 'started', { issue: 7, shortName: 'add-sub' })).isError).toBe(true)
  expect(w.state()?.issue).toBe(7)
  w.s.noOpenPr = false
  w.s.pushFails = ''
  expect((await tool($, 'started', { issue: 7, shortName: 'add-sub' })).isError).toBe(false)
  expect(w.state()?.prs).toEqual([12])
})

test('a docs commit after green keeps the evidence, also on a retry after a failed push', async ($, on) => {
  const smoked = finishing()
  const w = engine(on, { wf: { ...smoked, evidence: { ...smoked.evidence, smoke: { sha: SHA, text: 'smoked' } } }, names: ['README.md'] })
  await start($, w)
  w.s.pushFails = 'rejected'
  expect((await tool($, 'checkpoint', { message: 'docs', files: ['README.md'] })).isError).toBe(true)
  w.s.pushFails = ''
  w.s.staged = false
  const r = await tool($, 'checkpoint', { message: 'docs', files: [] })
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('finishing')
  expect(w.state()?.evidence.checks?.sha).toBe(w.s.sha)
})

test('what the commit holds decides the evidence, not the names in the call', async ($, on) => {
  const w = engine(on, { wf: finishing(), names: ['README.md', 'a.ts'] })
  await start($, w)
  const r = await tool($, 'checkpoint', { message: 'docs', files: ['README.md'] })
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('ci')
  expect(w.state()?.evidence.checks?.sha).toBe(SHA)
})

test('a skip out of reviewing marks the PR ready and says the commit is held', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' }, pr: { draft: true } })
  await start($, w)
  w.s.sha = 'cccc1'
  await command($, 'skip reviewed by hand')
  expect(w.ready.length).toBe(1)
  expect(w.prompts.at(-1)).toContain('checkpoint with no files')
})

test('goto done refuses a held commit, and changes nothing', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' } })
  await start($, w)
  w.s.sha = 'cccc1'
  expect(await command($, 'goto done')).toContain('not pushed')
  expect(w.state()?.state).toBe('reviewing')
})

test('a failed gates.sh says that the commit is held, not pushed', async ($, on) => {
  const w = engine(on, { config: { mode: 'heavy' }, wf: { state: 'developing' } })
  await start($, w)
  w.s.failCheck = 'gates'
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('held')
  expect(r.text).not.toContain('is pushed')
})

test('done at a merging level with migrations says it is not merged', async ($, on) => {
  const path = 'supabase/migrations/20260101_add.sql'
  const w = engine(on, { config: { projectLevel: 'poc' }, wf: { ...finishing(), migrations: [{ name: 'add', path }] }, names: [path] })
  await start($, w)
  w.s.blobSize = '10'
  const r = await tool($, 'done', { message: 'finished', remembered: 'nothing: small' })
  expect(r.isError).toBe(false)
  expect(w.merges.length).toBe(0)
  expect(r.text).toContain('ndev:merge')
  expect(r.text).not.toContain('finished and merged')
})

test('done at a merging level that merged says merged', async ($, on) => {
  const w = engine(on, { config: { projectLevel: 'poc' }, wf: finishing() })
  await start($, w)
  const r = await tool($, 'done', { message: 'finished', remembered: 'nothing: small' })
  expect(w.merges.length).toBe(1)
  expect(r.text).toContain('finished and merged')
})

test('an idle read that finds the PR closed blocks, and sends no prompt', async ($, on) => {
  const w = engine(on, { pr: { state: 'closed', merged: false } })
  await start($, w)
  await idle(w)
  expect(w.state()?.state).toBe('blocked')
  expect(w.prompts.length).toBe(0)
  expect(w.compacts.length).toBe(0)
})

test('edits to a file that is already changed count as progress at a turn end', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.dirty = [' M a.ts']
  for (let i = 0; i < 6; i++) {
    w.s.diffText = `edit ${i}`
    await turnEnds($)
  }
  expect(w.state()?.state).toBe('developing')
})

test('a prompt that the host refuses is shown, not lost', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.promptFails = true
  await turnEnds($)
  expect(w.toasts.join(' ')).toContain('was not sent to the model')
})

const noChecks = { check_runs: [] }
test('no check on a new commit is pending; later, with no workflows, it is no checks', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, checks: noChecks })
  await start($, w)
  w.s.commitAt = 0
  const early = await tool($, 'finishedChecks')
  expect(early.isError).toBe(true)
  expect(early.text).toContain('no check has started')
  w.s.now = 3 * 60_000
  expect((await tool($, 'finishedChecks')).isError).toBe(false)
})

test('with workflows that a commit does not trigger, the wait ends after the longer limit', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, checks: noChecks })
  await start($, w)
  w.s.commitAt = 0
  w.s.workflowsDir = true
  w.s.now = 3 * 60_000
  expect((await tool($, 'finishedChecks')).isError).toBe(true)
  w.s.now = 11 * 60_000
  expect((await tool($, 'finishedChecks')).isError).toBe(false)
})

const remark = { id: 55, body: 'please change this', user: { login: 'human', type: 'User' }, created_at: '2026-11-02T00:00:00Z' }
test('a comment before the last commit is still feedback at done, until finishedRevision', async ($, on) => {
  const w = engine(on, { wf: finishing() })
  await start($, w)
  w.s.comments = [remark]
  w.s.commitIso = '2026-11-03T00:00:00Z'
  w.s.now = Date.parse('2026-11-03T00:00:00Z')
  const r = await tool($, 'done', { message: 'finished', remembered: 'nothing: small' })
  expect(r.text).toContain('please change this')
  expect(w.state()?.state).toBe('revising')
  expect((await tool($, 'finishedRevision')).isError).toBe(false)
  const again = await tool($, 'status')
  expect(again.isError).toBe(false)
  expect(w.state()?.feedbackAt).toBe(w.s.now)
})

test('a PR head that this worktree lacks: finishedRevision names git pull', async ($, on) => {
  const w = engine(on, { wf: { state: 'revising' } })
  await start($, w)
  w.s.commitUnknown = true
  const r = await tool($, 'finishedRevision')
  expect(r.isError).toBe(true)
  expect(r.text).toContain('git pull')
})

test('a raw git commit or push is refused while a workflow runs, and names the tool', async ($, on) => {
  const w = engine(on)
  await start($, w)
  for (const command of ['git commit -m x', 'git -C /proj push origin HEAD', 'cd /proj && git push']) {
    const r = await $.tool.call({ tool: 'Bash', command } as never) as { deny?: string }
    expect(r.deny).toContain('checkpoint')
  }
  const fine = await $.tool.call({ tool: 'Bash', command: 'git log --grep commit' } as never) as { deny?: string }
  expect(fine.deny).toBeUndefined()
})

for (const command of [
  'git -C ~/dev-wiki add -A && git -C ~/dev-wiki commit -qm "learn: x"',
  'git -C ~/dev-wiki commit -m "learn: never git push by hand"',
  'git -C "$HOME/dev-wiki" commit -m x',
  'git -C /home/neil/dev-wiki push',
]) {
  test(`a commit or push in another repository passes while a workflow runs: ${command}`, async ($, on) => {
    const w = engine(on, { wf: { state: 'reviewing' } })
    await start($, w)
    const r = await $.tool.call({ tool: 'Bash', command } as never) as { deny?: string }
    expect(r.deny).toBeUndefined()
  })
}

for (const command of [
  'git -C ~/dev-wiki commit -m x && git push',
  'git -C ~/dev-wiki add -A && git commit -m x',
  'git -C /proj/sub commit -m x',
  'git -C "/proj/a dir" commit -m x',
  'git -C ../other commit -m x',
  'git -C /nowhere commit -m x',
  'git -C ~/dev-wiki -C /proj commit -m x',
]) {
  test(`a commit or push that may reach the workflow's repository is refused: ${command}`, async ($, on) => {
    const w = engine(on, { wf: { state: 'reviewing' } })
    await start($, w)
    const r = await $.tool.call({ tool: 'Bash', command } as never) as { deny?: string }
    expect(r.deny).toContain('checkpoint')
  })
}

for (const [name, wf] of [['done', { state: 'done' }], ['off', { off: { reason: 'x', at: 0 } }], ['with checks skipped', { noChecks: true }]] as const) {
  test(`a raw git commit passes when the workflow is ${name}`, async ($, on) => {
    const w = engine(on, { wf })
    await start($, w)
    const r = await $.tool.call({ tool: 'Bash', command: 'git commit -m x' } as never) as { deny?: string }
    expect(r.deny).toBeUndefined()
  })
}

test('a UI edit after development still gets the component check', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' } })
  await start($, w)
  const r = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/Late.tsx` } as never) as { context?: string[] }
  expect((r.context ?? []).join(' ')).toContain('ui-components.md')
})

// ---- /flow ----
test('/flow status shows the state and the next step', async ($, on) => {
  engine(on)
  await start($)
  const out = await command($, 'status')
  expect(out).toContain('in the state "developing"')
  expect(out).toContain('Next:')
})

test('a record from before addMigration has no list, and status still answers', async ($, on) => {
  engine(on, { wf: { migrations: undefined } })
  await start($)
  const out = await command($, 'status')
  expect(out).not.toContain('failed')
  expect(out).toContain('in the state "developing"')
})

test('/flow guide shows the guide, with or without a workflow, and changes nothing', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  expect(await command($, 'guide')).toContain('# The guide')
  expect(w.state()).toBeUndefined()
  expect(w.gh).toEqual([])
})

test('/flow guide names the file and the repair when the guide is missing', async ($, on) => {
  engine(on, { guide: false })
  await start($)
  const out = await command($, 'guide')
  expect(out).toContain('/kb/workflow.md')
  expect(out).toContain('claude plugin update')
})

test('/flow with an unknown word lists the commands', async ($, on) => {
  engine(on)
  await start($)
  expect(await command($, 'bogus')).toContain('/flow skip')
})

test('/flow skip moves on, tells the agent and records it on the PR', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const out = await command($, 'skip the review is not needed')
  expect(out).toContain('from "developing" to "reviewing"')
  expect(w.state()?.state).toBe('reviewing')
  expect(w.prompts[0]).toContain('in the state "reviewing"')
  expect(w.gh.some(c => c.includes('comment 12') && c.includes('the review is not needed'))).toBe(true)
})

test('/flow skip of ci lets done pass on red checks, for that commit only', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, checks: CHECKS({ name: 'flaky', conclusion: 'failure' }) })
  await start($, w)
  await command($, 'skip flaky suite')
  expect(w.state()?.state).toBe('finishing')
  expect((await tool($, 'done', { message: 'finished', remembered: 'none: nothing durable' })).isError).toBe(false)
})

test('/flow skip of ci gives no pass to a later commit', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, checks: CHECKS({ name: 'flaky', conclusion: 'failure' }) })
  await start($, w)
  await command($, 'skip flaky suite')
  w.s.sha = 'later'
  w.s.upstream = 'later'
  w.s.pr = { ...w.s.pr, head: { sha: 'later', ref: 'issue-7' } }
  const r = await tool($, 'done', { message: 'finished', remembered: 'none: nothing durable' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('Red checks')
})

test('/flow skip refuses when blocked and names unblock', async ($, on) => {
  const w = engine(on)
  await start($, w)
  await tool($, 'blocked', { message: 'help' })
  expect(await command($, 'skip')).toContain('/flow unblock')
  expect(w.state()?.state).toBe('blocked')
})

test('/flow unblock withdraws the alert and restores the state', async ($, on) => {
  const w = engine(on)
  await start($, w)
  await tool($, 'blocked', { message: 'help' })
  await command($, 'unblock use Postgres')
  expect(w.state()?.state).toBe('developing')
  expect(w.alerts).toEqual(['raise', 'withdraw'])
  expect(w.prompts[0]).toContain('use Postgres')
})

const unblock = async ($: Dollar, args: string) => {
  const out = String(((await $.command.run({ command: 'unblock', args } as never)) as { text: string }).text)
  pendingAfters.splice(0).forEach(fire => fire())
  await settle()
  return out
}

test('/unblock gives the answer to the agent, withdraws the alert and restores the state', async ($, on) => {
  const w = engine(on)
  await start($, w)
  await tool($, 'blocked', { message: 'which database?' })
  const text = await unblock($, 'use Postgres')
  expect(text).toContain('back in the state "developing"')
  expect(w.state()?.state).toBe('developing')
  expect(w.alerts).toEqual(['raise', 'withdraw'])
  expect(w.prompts[0]).toContain('use Postgres')
})

test('/unblock with no message changes nothing and says the message is needed', async ($, on) => {
  const w = engine(on)
  await start($, w)
  await tool($, 'blocked', { message: 'which database?' })
  for (const args of ['', '   ']) {
    const text = await unblock($, args)
    expect(text).toContain('/unblock <message>')
    expect(text).toContain('which database?')
  }
  expect(w.state()?.state).toBe('blocked')
  expect(w.alerts).toEqual(['raise'])
  expect(w.prompts).toEqual([])
})

test('/unblock when nothing is blocked says so and changes nothing', async ($, on) => {
  const w = engine(on)
  await start($, w)
  expect(await unblock($, 'use Postgres')).toContain('is not blocked')
  expect(w.state()?.state).toBe('developing')
  expect(w.prompts).toEqual([])
})

// ---- the wait tools ----
test('waitFor checks until the command exits 0, holds the state "wait" meanwhile, and goes back', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  const seen: (string | undefined)[] = []
  let exits = [1, 1, 0]
  w.s.probe = () => {
    seen.push(w.state()?.state)
    return { exitCode: exits.shift() ?? 0 }
  }
  const r = await tool($, 'waitFor', { shell_command: 'test -f /tmp/x', period: 5 })
  expect(r.isError).toBe(false)
  expect(seen).toEqual(['wait', 'wait', 'wait'])
  expect(w.s.probes[0]).toContain('test -f /tmp/x')
  expect(w.s.now).toBe(10_000)
  expect(w.state()?.state).toBe('developing')
  expect(r.text).toContain('State: developing')
})

test('waitFor gives up after its attempts, names the last result and goes back', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  w.s.probe = () => ({ exitCode: 7, stderr: 'no such file' })
  const r = await tool($, 'waitFor', { shell_command: 'false', period: 5, attempts: 3 })
  expect(r.isError).toBe(true)
  expect(w.s.probes.length).toBe(3)
  expect(r.text).toContain('3 attempts')
  expect(r.text).toContain('exit code 7')
  expect(r.text).toContain('no such file')
  expect(w.state()?.state).toBe('developing')
})

test('a wait gives up at its timeout, with attempts left', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  w.s.probe = () => ({ exitCode: 1 })
  const r = await tool($, 'waitFor', { shell_command: 'false', period: 10, attempts: 100, timeout: 25 })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('25 s')
  expect(w.s.probes.length).toBeLessThan(5)
  expect(w.state()?.state).toBe('developing')
})

test('waitForSeconds sleeps for its time and comes back', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  const r = await tool($, 'waitForSeconds', { secs: 7 })
  expect(r.isError).toBe(false)
  expect(w.s.now).toBe(7000)
  // A hook's budget of ten seconds runs on through $.clock.sleep, and not through a process.
  expect(w.s.clockSleeps).toBe(0)
  expect(w.state()?.state).toBe('developing')
})

test('waitForURL ends at a 2xx answer, and passes the URL with no shell', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  let codes = ['503', '200']
  w.s.probe = () => ({ exitCode: 0, stdout: codes.shift() ?? '200' })
  const r = await tool($, 'waitForURL', { url: 'https://example.com/a?b=1;rm' })
  expect(r.isError).toBe(false)
  expect(w.s.probes.length).toBe(2)
  expect(w.s.probes[0]?.startsWith('curl ')).toBe(true)
  expect(w.state()?.state).toBe('developing')
})

test('waitForProcessEnd ends when ps no longer lists the pid, or lists a zombie', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  let answers = [{ exitCode: 0, stdout: 'S' }, { exitCode: 1 }]
  w.s.probe = () => answers.shift() ?? { exitCode: 1 }
  expect((await tool($, 'waitForProcessEnd', { pid: 4242 })).isError).toBe(false)
  expect(w.s.probes.length).toBe(2)
  expect(w.s.probes[0]).toContain('4242')
  w.s.probes.length = 0
  answers = [{ exitCode: 0, stdout: 'Z+' }]
  expect((await tool($, 'waitForProcessEnd', { pid: 4242 })).isError).toBe(false)
  expect(w.s.probes.length).toBe(1)
})

test('waitForSubAgent waits while the agent is listed as busy', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  w.s.agents = [{ id: 'a1', status: 'running' }]
  let release!: () => void
  w.s.sleepHold = new Promise<void>(resolve => { release = resolve })
  const call = tool($, 'waitForSubAgent', { claude_agent_id: 'a1' })
  await settle()
  expect(w.state()?.state).toBe('wait')
  w.s.agents = [{ id: 'a1', status: 'completed' }]
  release()
  const r = await call
  expect(r.isError).toBe(false)
  expect(r.text).toContain('a1')
  expect(w.state()?.state).toBe('developing')
})

test('waitForSubAgent holds through a pause of part of a second', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  // A first slice that runs 181 ms late leaves 0.819 s of the period: (0.819 + 10) * 1000 is not a whole number.
  w.s.sleepDrift = [181]
  Object.defineProperty(w.s, 'agents', { get: () => [{ id: 'a1', status: w.s.now >= 5000 ? 'completed' : 'running' }] })
  const r = await tool($, 'waitForSubAgent', { claude_agent_id: 'a1' })
  expect(r.text).toContain('ended after 2 checks')
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('developing')
})

test('/unblock ends a wait that is running: the tool returns the message and the state goes back', async ($, on) => {
  const w = engine(on)
  await start($, w)
  // The agent holds the turn while it waits, so the command must run at once, mid-turn.
  expect(w.s.immediate).toContain('unblock')
  w.s.probe = () => ({ exitCode: 1 })
  let release!: () => void
  w.s.sleepHold = new Promise<void>(resolve => { release = resolve })
  const call = tool($, 'waitFor', { shell_command: 'false', period: 30 })
  await settle()
  expect(w.state()?.state).toBe('wait')
  const text = await unblock($, 'it is deployed, go on')
  expect(text).toContain('back in the state "developing"')
  expect(w.state()?.state).toBe('developing')
  release()
  const r = await call
  expect(r.isError).toBe(false)
  expect(r.text).toContain('it is deployed, go on')
  expect(w.state()?.state).toBe('developing')
})

test('in the state "wait" the other phase tools refuse, and the reminders stay quiet', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.probe = () => ({ exitCode: 1 })
  let release!: () => void
  w.s.sleepHold = new Promise<void>(resolve => { release = resolve })
  const call = tool($, 'waitFor', { shell_command: 'false', period: 30 })
  await settle()
  const refused = await tool($, 'blocked', { message: 'help' })
  expect(refused.isError).toBe(true)
  expect(refused.text).toContain('"wait"')
  await turnEnds($)
  expect(w.prompts).toEqual([])
  await unblock($, 'stop')
  release()
  await call
})

test('a wait whose time equals its timeout still ends well: the last check runs at the deadline', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  const r = await tool($, 'waitForSeconds', { secs: 5, timeout: 5 })
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('developing')
})

for (const exitCode of [0, 1]) {
  test(`/unblock during a check keeps its answer, also when the check then exits ${exitCode} on its last attempt`, async ($, on) => {
    const w = engine(on)
    await start($, w)
    w.s.probe = () => unblock($, 'use the staging server').then(() => ({ exitCode }))
    const r = await tool($, 'waitFor', { shell_command: 'check', attempts: 1 })
    expect(r.text).toContain('use the staging server')
    expect(r.isError).toBe(false)
    expect(w.state()?.state).toBe('developing')
    expect((w.state() as { waitAnswer?: unknown }).waitAnswer).toBeUndefined()
  })
}

test('a wait ends well when another writer gets in first', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.probe = () => {
    w.s.staleSaves = 1
    return { exitCode: 0 }
  }
  const r = await tool($, 'waitFor', { shell_command: 'check' })
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('developing')
})

test('a wait that cannot go back says so and names the repair', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.probe = () => {
    w.s.staleSaves = 99
    return { exitCode: 0 }
  }
  const r = await tool($, 'waitFor', { shell_command: 'check' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('exited 5')
  expect(r.text).toContain('/unblock')
})

test('a wait tool refuses bad numbers and a helper, and changes nothing', async ($, on) => {
  const w = engine(on)
  await start($, w)
  for (const [name, args] of [
    ['waitFor', {}],
    ['waitFor', { shell_command: 'true', period: 0 }],
    ['waitFor', { shell_command: 'true', attempts: -1 }],
    ['waitFor', { shell_command: 'true', timeout: 'soon' }],
    ['waitForURL', { url: 'file:///etc/passwd' }],
    ['waitForProcessEnd', { pid: 1.5 }],
    ['waitForSeconds', { secs: 0 }],
    ['waitForSubAgent', {}],
  ] as const) {
    const r = await tool($, name, args)
    expect(r.isError).toBe(true)
    expect(w.state()?.state).toBe('developing')
  }
  const helper = await tool($, 'waitForSeconds', { secs: 1, agentId: 'h1' })
  expect(helper.isError).toBe(true)
  expect(helper.text).toContain('only the main agent')
})

test('started on a record left in "wait" by a dead session goes back to the earlier state', async ($, on) => {
  const w = engine(on, { wf: { state: 'wait', previous: 'ci', waiting: { id: 'old', tool: 'waitFor', what: 'old', at: 0 }, owner: { session: 'dead', at: -3_600_000 } } })
  await start($, w)
  await tool($, 'started', { issue: 7, takeOver: true })
  expect(w.state()?.state).toBe('ci')
  expect(w.state()?.waiting).toBeUndefined()
})

test('/flow goto goes to any state and refuses an unknown one', async ($, on) => {
  const w = engine(on)
  await start($, w)
  expect(await command($, 'goto nowhere')).toContain('needs one of')
  expect(w.state()?.state).toBe('developing')
  await command($, 'goto finishing shipped by hand')
  expect(w.state()?.state).toBe('finishing')
})

test('/flow off stops the tools and the reminders; on starts them again', async ($, on) => {
  const w = engine(on)
  await start($, w)
  await command($, 'off doing this by hand')
  const r = await tool($, 'checkpoint', { message: 'x', files: ['a'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('/flow on')
  await turnEnds($)
  await idle(w)
  expect(w.prompts).toEqual([])
  w.gh.length = 0
  await idle(w)
  expect(w.gh).toEqual([])
  await command($, 'on')
  expect(w.state()?.off).toBeUndefined()
  expect(w.prompts.length).toBe(1)
})

test('/flow off project writes .neil-dev.json and stops the reminders', async ($, on) => {
  const w = engine(on)
  await start($, w)
  await command($, 'off project')
  expect((JSON.parse(w.files.get(CONFIG) ?? '{}') as { workflow?: boolean }).workflow).toBe(false)
  await turnEnds($)
  expect(w.prompts).toEqual([])
  await command($, 'on project')
  expect((JSON.parse(w.files.get(CONFIG) ?? '{}') as { workflow?: boolean }).workflow).toBe(true)
})

// ---- the limit on GitHub calls ----
test('the whole flow reaches GitHub only through gh.sh', async ($, on) => {
  const w = engine(on, { wf: null, pr: { draft: true } })
  await start($, w)
  await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  await tool($, 'finishedDevelopment', { prs: [12], message: 'Add', files: ['a.ts'] })
  await tool($, 'finishedReview', { remembered: 'nothing: small', review: 'clean', deadcode: 'clean' })
  expect(w.gh.length).toBeGreaterThan(0)
  expect(w.gh.filter(c => !c.includes('/scripts/github/gh.sh '))).toEqual([])
  expect(w.ready.length).toBe(1)
})

// ---- A session with no issue asks the human ----

const workflowSection = async ($: Dollar) => {
  const { sections } = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never)
  return sections.find((x: { id: string }) => x.id === 'ndev:workflow')?.text as string | undefined
}

const noIssue = (on: On) => {
  const w = engine(on, { wf: null })
  w.s.branch = 'main'
  return w
}

const talk = async ($: Dollar) => {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 15; i++) await settle() // The question comes after the dialogs before it, in a void chain.
}

test('an interactive session with no issue asks for the issue, a new issue or no workflow', async ($, on) => {
  const w = noIssue(on)
  await talk($)
  expect(w.issueAsks).toHaveLength(1)
  expect(w.issueAsks[0]!.options).toEqual(['Use an existing issue', 'Create a new issue', 'Work without the workflow'])
})

test('use an existing issue puts the start of the request in the prompt box', async ($, on) => {
  const w = noIssue(on)
  w.s.issueAnswer = 'Use an existing issue'
  await talk($)
  expect(w.fills).toEqual(['Work on issue #'])
  expect(w.prompts).toEqual([])
})

test('create a new issue puts the issue skill in the prompt box', async ($, on) => {
  const w = noIssue(on)
  w.s.issueAnswer = 'Create a new issue'
  await talk($)
  expect(w.fills).toEqual(['/ndev:issue '])
})

test('a typed issue number starts the work, and typed words file a new issue', async ($, on) => {
  const w = noIssue(on)
  w.s.issueAnswer = '#42'
  await talk($)
  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0]).toContain('#42')
  expect(w.prompts[0]).toContain('mcp__ndev__started')
})

test('typed words become the text of a new issue', async ($, on) => {
  const w = noIssue(on)
  w.s.issueAnswer = 'the login page loses the redirect'
  await talk($)
  expect(w.prompts[0]).toContain('the login page loses the redirect')
  expect(w.prompts[0]).toContain('ndev:issue')
})

test('work without the workflow: started refuses, no reminder comes, and /flow on undoes it', async ($, on) => {
  const w = noIssue(on)
  w.s.issueAnswer = 'Work without the workflow'
  await talk($)
  expect(await workflowSection($)).toBeUndefined()
  const refused = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(refused.text).toContain('/flow on')
  expect(w.files.has(RECORD)).toBe(false)

  await $.command.run({ command: 'flow', args: 'on' } as never)
  expect(await workflowSection($)).toContain('mcp__ndev__started')
  expect(await workflowSection($)).toContain('names no issue')
})

test('the question comes once in a session, also after a reload', async ($, on) => {
  const w = noIssue(on)
  await talk($)
  await talk($)
  expect(w.issueAsks).toHaveLength(1)
})

for (const [name, setUp] of [
  ['a project with the workflow off', { config: { workflow: false } }],
] as const) {
  test(`no question in ${name}`, async ($, on) => {
    const w = engine(on, { wf: null, ...setUp })
    w.s.branch = 'main'
    await talk($)
    expect(w.issueAsks).toEqual([])
  })
}

test('no question when no person is at the prompt', async ($, on) => {
  const w = noIssue(on)
  await start($)
  expect(w.issueAsks).toEqual([])
})

test('no question when the record names an issue', async ($, on) => {
  const w = engine(on)
  await talk($)
  expect(w.issueAsks).toEqual([])
})

test('a question when the record is done: the next work has no issue', async ($, on) => {
  const w = engine(on, { wf: { state: 'done' } })
  w.s.branch = 'main'
  await talk($)
  expect(w.issueAsks).toHaveLength(1)
})

test('no question in a resumed session', async ($, on) => {
  const w = noIssue(on)
  w.s.resumed = true
  await talk($)
  expect(w.issueAsks).toEqual([])
})

test('no question when the branch names an issue', async ($, on) => {
  const w = noIssue(on)
  w.s.branch = 'claude/issue-9'
  await talk($)
  expect(w.issueAsks).toEqual([])
})

test('no question when Orca links the workspace to an issue', async ($, on) => {
  const w = noIssue(on)
  w.s.orcaOn = true
  w.s.orcaLinked = 12
  await talk($)
  expect(w.issueAsks).toEqual([])
  expect(w.orcaCalls.some(c => c[1] === 'show' && c.includes(`path:${ROOT}`))).toBe(true)
})

test('a question when Orca links the workspace to no issue', async ($, on) => {
  const w = noIssue(on)
  w.s.orcaOn = true
  await talk($)
  expect(w.issueAsks).toHaveLength(1)
})

test('no question when a first prompt reached the session, as with an Orca worker or claude "prompt"', async ($, on) => {
  const w = noIssue(on)
  let wake = () => {}
  w.s.sleepHold = new Promise<void>(resolve => { wake = resolve })
  await talk($)
  await $.turn.start({ prompt: 'a task' } as never).catch(() => undefined)
  wake()
  await settle()
  expect(w.issueAsks).toEqual([])
})

test('no question while the person is typing in the prompt box', async ($, on) => {
  const w = noIssue(on)
  w.s.draft = 'half a thou'
  await talk($)
  expect(w.issueAsks).toEqual([])
  expect(w.fills).toEqual([])
})

test('a failed Orca read still asks, and shows the failure', async ($, on) => {
  const w = noIssue(on)
  w.s.orcaOn = true
  w.s.orcaFails = 'no server'
  await talk($)
  expect(w.issueAsks).toHaveLength(1)
  expect(w.toasts.join()).toContain('no server')
})

// ---- A bug in the workflow goes to an agent in the plugin's own checkout ----

const launches = (w: { orcaCalls: string[][] }) => w.orcaCalls.filter(c => c[0] === 'agent' && c[1] === 'launch')
const promptOf = (c: string[]) => c[c.indexOf('--prompt') + 1]!

test('reportWorkflowBug starts an Orca agent on main in the plugin checkout, with the report as data', async ($, on) => {
  const w = engine(on)
  w.s.branch = 'main'
  const r = await tool($, 'reportWorkflowBug', { title: 'done refuses a clean tree', details: 'status said nothing, done said dirty' })
  expect(r.isError).toBe(false)
  const [call] = launches(w)
  expect(call).toBeDefined()
  expect(call!.join(' ')).toContain('--agent claude')
  expect(call![call!.indexOf('--worktree') + 1]).toStartWith('path:')
  const prompt = promptOf(call!)
  expect(prompt).toContain('done refuses a clean tree')
  expect(prompt).toContain('status said nothing, done said dirty')
  expect(prompt).toContain('on main')
  expect(prompt).toContain('failing test')
  expect(prompt).toContain('by name')
  expect(r.text).toContain('agent')
})

test('reportWorkflowBug works with no workflow, and from a helper', async ($, on) => {
  const w = engine(on, { wf: null })
  w.s.branch = 'main'
  const r = await tool($, 'reportWorkflowBug', { title: 'status crashed', details: 'x', agentId: 'helper-1' })
  expect(r.isError).toBe(false)
  expect(launches(w)).toHaveLength(1)
})

test('the same bug again starts no second agent', async ($, on) => {
  const w = engine(on)
  w.s.branch = 'main'
  await tool($, 'reportWorkflowBug', { title: 'done refuses a clean tree', details: 'a' })
  const again = await tool($, 'reportWorkflowBug', { title: 'Done refuses  a clean tree', details: 'b' })
  expect(launches(w)).toHaveLength(1)
  expect(again.text).toContain('already')
})

test('a loop of new bugs stops at the daily limit and says so', async ($, on) => {
  const w = engine(on)
  w.s.branch = 'main'
  for (let i = 0; i < 5; i++) await tool($, 'reportWorkflowBug', { title: `bug ${i}`, details: 'a' })
  const over = await tool($, 'reportWorkflowBug', { title: 'bug six', details: 'a' })
  expect(launches(w)).toHaveLength(5)
  expect(over.isError).toBe(true)
  expect(over.text).toContain('bug six')
  expect(over.text).toContain('limit')
})

test('a plugin checkout that is not on main starts no agent, and the refusal names the branch and the report', async ($, on) => {
  const w = engine(on)
  w.s.branch = 'feature-x'
  const r = await tool($, 'reportWorkflowBug', { title: 'status crashed', details: 'the detail' })
  expect(launches(w)).toHaveLength(0)
  expect(r.isError).toBe(true)
  expect(r.text).toContain('feature-x')
  expect(r.text).toContain('the detail')
})

test('a failed Orca launch names the command output, the repair, and keeps the report; a retry can start it', async ($, on) => {
  const w = engine(on)
  w.s.branch = 'main'
  w.s.orcaFails = 'orca is not running'
  const r = await tool($, 'reportWorkflowBug', { title: 'status crashed', details: 'the detail' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('orca is not running')
  expect(r.text).toContain('orca repo add')
  expect(r.text).toContain('the detail')
  w.s.orcaFails = ''
  expect((await tool($, 'reportWorkflowBug', { title: 'status crashed', details: 'the detail' })).isError).toBe(false)
  expect(launches(w).length).toBeGreaterThan(0)
})

test('an unexpected fault in a tool is reported by the plugin, and a refusal is not', async ($, on) => {
  const w = engine(on, { files: { [RECORD]: '{ not json' } })
  await start($, w)
  w.s.branch = 'main'
  const r = await tool($, 'status')
  expect(r.isError).toBe(true)
  expect(launches(w)).toHaveLength(1)
  expect(promptOf(launches(w)[0]!)).toContain('not valid JSON')
  expect(r.text).toContain('reported')
})

test('a refusal starts no agent', async ($, on) => {
  const w = engine(on)
  await tool($, 'finishedSmoke', {})
  expect(launches(w)).toHaveLength(0)
})

// ---- iNeedA: guidance from the fixed lists ----

test('iNeedA react-component asks haiku with the component list and answers with its suggestions', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const r = await tool($, 'iNeedA', { kind: 'react-component', description: 'a hold to confirm button' })
  expect(r.isError).toBe(false)
  expect(w.modelCalls).toHaveLength(1)
  expect(w.modelCalls[0]!.model).toBe('haiku')
  const sent = JSON.stringify(w.modelCalls[0])
  expect(sent).toContain('SOURCE kb/ui-components.md')
  expect(sent).toContain('a hold to confirm button')
  expect(r.text).toContain('Use Kokonut UI hold-button.')
  expect(r.text).toContain('kb/ui-components.md')
})

test('iNeedA library reads the library list and the dependencies the project has', async ($, on) => {
  const w = engine(on, { files: { [`${ROOT}/package.json`]: JSON.stringify({ dependencies: { zod: '4.0.0' } }) } })
  await start($, w)
  await tool($, 'iNeedA', { kind: 'library', description: 'validate a form' })
  const sent = JSON.stringify(w.modelCalls[0])
  expect(sent).toContain('SOURCE kb/libraries.md')
  expect(sent).toContain('zod')
})

test('iNeedA animation reads the motion guidance', async ($, on) => {
  const w = engine(on)
  await start($, w)
  await tool($, 'iNeedA', { kind: 'animation', description: 'a micro-interaction when a card is saved' })
  const sent = JSON.stringify(w.modelCalls[0])
  expect(sent).toContain('SOURCE skills/motion/SKILL.md')
  expect(sent).toContain('SOURCE skills/motion/references/delight.md')
})

test('iNeedA brand-style reads the tokens of the local brand site', async ($, on) => {
  const w = engine(on, { config: { branding: { site: 'https://b.example', path: 'apps/brand' } }, files: { [`${ROOT}/apps/brand/public/ds/colour.css`]: '--ink: #111' } })
  await start($, w)
  const r = await tool($, 'iNeedA', { kind: 'brand-style', description: 'the colour of an error message' })
  expect(JSON.stringify(w.modelCalls[0])).toContain('--ink: #111')
  expect(r.isError).toBe(false)
})

test('iNeedA brand-style with only a site reads the site', async ($, on) => {
  const w = engine(on, { config: { branding: { site: 'https://b.example' } } })
  await start($, w)
  await tool($, 'iNeedA', { kind: 'brand-style', description: 'the heading font' })
  expect(JSON.stringify(w.modelCalls[0])).toContain('Brand guide: Inter')
})

test('iNeedA brand-style with no brand calls no model and names /brand create', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const r = await tool($, 'iNeedA', { kind: 'brand-style', description: 'the heading font' })
  expect(w.modelCalls).toHaveLength(0)
  expect(r.text).toContain('/brand create')
})

test('iNeedA refuses an unknown kind and names the kinds', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const r = await tool($, 'iNeedA', { kind: 'pony', description: 'x' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('react-component')
  expect(w.modelCalls).toHaveLength(0)
})

test('a failed model call names the reason and the file to read, and reports no workflow bug', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.modelFails = true
  const r = await tool($, 'iNeedA', { kind: 'react-component', description: 'a date picker' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('529')
  expect(r.text).toContain('kb/ui-components.md')
  expect(launches(w)).toHaveLength(0)
})

test('iNeedA works from a helper and with no workflow', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  const r = await tool($, 'iNeedA', { kind: 'library', description: 'x', agentId: 'helper-1' })
  expect(r.isError).toBe(false)
  expect(w.modelCalls).toHaveLength(1)
})

// ---- finishedDevelopment starts the code review itself ----

const toReview = async ($: Dollar, w: ReturnType<typeof engine>) => {
  await start($, w)
  w.s.dirty = [' M a.ts']
  return tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'] })
}

test('finishedDevelopment starts the reviewer before it answers, on the worktree and the base branch', async ($, on) => {
  const w = engine(on)
  const r = await toReview($, w)
  expect(w.spawns).toHaveLength(1)
  expect(w.spawns[0]!.subagentType).toBe('ndev:diff-reviewer')
  expect(w.spawns[0]!.cwd).toBe(ROOT)
  expect(w.spawns[0]!.prompt).toContain('origin/main')
  expect(w.spawns[0]!.prompt).toContain('#7')
  expect(r.text).toContain('Do not start another')
  expect(w.state()?.hooks?.review?.firedAt).toBeDefined()
})

test('in heavy mode the reviewer is told to check the work-heavy requirements too', async ($, on) => {
  const w = engine(on, { config: { mode: 'heavy' } })
  await toReview($, w)
  expect(w.spawns[0]!.prompt).toContain('work-heavy')
})

test('in heavy mode two reviewers start, one for each axis, and in light mode one', async ($, on) => {
  const w = engine(on, { config: { mode: 'heavy' } })
  await toReview($, w)
  expect(w.spawns.map(s => s.subagentType)).toEqual(['ndev:diff-reviewer', 'ndev:diff-reviewer'])
  expect(w.spawns[0]!.prompt).toContain('axis: standards')
  expect(w.spawns[1]!.prompt).toContain('axis: specification')
  expect(w.spawns[1]!.prompt).not.toContain('axis: standards')
})

test('a reviewer that is refused leaves a clear instruction, and the commit stays', async ($, on) => {
  const w = engine(on)
  w.s.spawnDeny = 'a limit of the host'
  const r = await toReview($, w)
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('reviewing')
  expect(r.text).toContain('a limit of the host')
  expect(r.text).toContain('ndev:diff-reviewer')
})

test('the answer of the reviewer is recorded and reaches the agent', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing', prs: [12], hooks: { review: { firedAt: 1, agentId: 'reviewer-1' } } } })
  await start($, w)
  await $.turn.complete({ agentId: 'reviewer-1', answer: 'Critical: a.ts:3 loses the error' } as never)
  await settle()
  expect(w.state()?.hooks?.review?.answer).toContain('a.ts:3')
  expect(w.prompts.join('\n')).toContain('a.ts:3')
  expect(w.prompts.join('\n')).toContain('finishedReview')
})

test('the second reviewer has its own answer, and it reaches the agent too', async ($, on) => {
  const w = engine(on, { config: { mode: 'heavy' }, wf: { state: 'reviewing', prs: [12], hooks: { review: { firedAt: 1, agentId: 'r-1', answer: 'standards are fine' } }, reviewSpec: { agentId: 'r-2' } } as never })
  await start($, w)
  await $.turn.complete({ agentId: 'r-2', answer: 'Critical: the issue asks for b.ts:9' } as never)
  await settle()
  expect((w.state() as unknown as { reviewSpec: { answer?: string } }).reviewSpec.answer).toContain('b.ts:9')
  expect(w.state()?.hooks?.review?.answer).toBe('standards are fine')
  expect(w.prompts.join('\n')).toContain('b.ts:9')
})

test('a resume in heavy mode gives both answers, and does not start the reviewers again', async ($, on) => {
  const w = engine(on, { config: { mode: 'heavy' }, wf: { state: 'reviewing', prs: [12], hooks: { review: { firedAt: 1, agentId: 'r-1', answer: 'standards are fine' } }, reviewSpec: { agentId: 'r-2', answer: 'the spec is met' } } as never })
  await start($, w)
  const said = (await tool($, 'started', { issue: 7 })).text
  expect(said).toContain('standards are fine')
  expect(said).toContain('the spec is met')
  expect(w.spawns).toHaveLength(0)
})

test('the turn of another agent is not taken for the review', async ($, on) => {
  const w = engine(on)
  await toReview($, w)
  await $.turn.complete({ agentId: 'other', answer: 'nothing to see' } as never)
  await settle()
  expect(w.state()?.hooks?.review?.answer).toBeUndefined()
})

test('a /flow goto reviewing starts the reviewer too', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci', prs: [12] } })
  await start($, w)
  await command($, 'goto reviewing go back')
  expect(w.spawns).toHaveLength(1)
})

test('a resume in reviewing starts the review again when its answer was lost in a restart', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing', prs: [12], hooks: { review: { firedAt: 1, agentId: 'gone' } } } })
  await start($, w)
  const r = await tool($, 'started', { issue: 7 })
  expect(w.spawns).toHaveLength(1)
  expect(r.text).toContain('started the code review')
})

test('a resume does not start a review that has answered', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing', prs: [12], hooks: { review: { firedAt: 1, agentId: 'gone', answer: 'clean' } } } })
  await start($, w)
  const r = await tool($, 'started', { issue: 7 })
  expect(w.spawns).toHaveLength(0)
  expect(r.text).toContain('clean')
})

// ---- The remember hook comes before the push ----

test('finishedDevelopment fires the remember hook with the review, and names the docs and the wiki', async ($, on) => {
  const w = engine(on)
  const r = await toReview($, w)
  expect(w.state()?.hooks?.remember?.firedAt).toBeDefined()
  expect(r.text).toContain('ndev:remember')
  expect(r.text).toContain('ndev:docs-sync')
  expect(r.text).toContain('ndev:dev-wiki')
})

test('finishedReview with no remember result pushes nothing; with one it pushes and records it', async ($, on) => {
  const w = engine(on)
  await toReview($, w)
  w.s.dirty = []
  const refused = await tool($, 'finishedReview', { review: 'clean', deadcode: 'clean' })
  expect(refused.isError).toBe(true)
  expect(refused.text).toContain('remembered')
  expect(w.pushes).toHaveLength(0)
  const r = await tool($, 'finishedReview', { review: 'clean', deadcode: 'clean', remembered: 'wiki page updated' })
  expect(r.isError).toBe(false)
  expect(w.pushes.length).toBeGreaterThan(0)
  expect(w.state()?.hooks?.remember?.result).toBe('wiki page updated')
})

test('a formal_project cannot skip the remember hook at the push', async ($, on) => {
  const w = engine(on, { config: { projectLevel: 'formal_project' } })
  await toReview($, w)
  w.s.dirty = []
  const r = await tool($, 'finishedReview', { review: 'clean', deadcode: 'clean', remembered: 'skipped: no time' })
  expect(r.isError).toBe(true)
  expect(w.pushes).toHaveLength(0)
})

test('done takes the earlier remember result, and asks for it only after a skipped review', async ($, on) => {
  const w = engine(on, { wf: { state: 'finishing', prs: [12], hooks: { remember: { firedAt: 1, result: 'wiki page updated' } } } })
  await start($, w)
  expect((await tool($, 'status')).text).toContain('call done')
  await tool($, 'done', { message: 'finished' })
  expect(w.state()?.hooks?.remember?.result).toBe('wiki page updated')
})

// ---- Change types ----

test('checkpoint records the declared types and those of the changed paths, and they accumulate', async ($, on) => {
  const w = engine(on, { names: ['lib/a.ts'] })
  await start($, w)
  w.s.dirty = [' M lib/a.ts']
  expect((await tool($, 'checkpoint', { message: 'm', files: ['lib/a.ts'], changeTypes: ['web'] })).isError).toBe(false)
  expect(w.state()?.changeTypes).toEqual(['web', 'backend'])
  w.s.names = ['README.md']
  w.s.dirty = [' M README.md']
  await tool($, 'checkpoint', { message: 'n', files: ['README.md'] })
  expect(w.state()?.changeTypes).toEqual(['web', 'backend', 'docs'])
})

test('with no types given, the paths decide, and the read costs no GitHub call', async ($, on) => {
  const w = engine(on, { names: ['src/Card.tsx', 'src/Card.test.tsx'] })
  await start($, w)
  w.s.dirty = [' M src/Card.tsx']
  const before = w.gh.length
  await tool($, 'checkpoint', { message: 'm', files: ['src/Card.tsx'] })
  expect(w.state()?.changeTypes).toEqual(['web', 'tests'])
  expect(w.state()?.webFiles).toEqual(['src/Card.tsx'])
  // Only the note for the human about the check scripts, which each commit in this fake sends, and the change map of the push.
  expect(w.gh.slice(before).filter(call => !call.includes('gh.sh comment') && !call.includes('gh.sh pr-read 12') && !call.includes('gh.sh pr-edit 12'))).toEqual([])
})

test('a type that is not in the list is refused, and nothing is committed', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.dirty = [' M a.ts']
  for (const changeTypes of [['frontend'], 'web']) {
    const r = await tool($, 'checkpoint', { message: 'm', files: ['a.ts'], changeTypes })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('web, backend, database, docs, tests, config')
  }
  const d = await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'], changeTypes: ['frontend'] })
  expect(d.isError).toBe(true)
  expect(w.commits).toHaveLength(0)
  expect(w.state()?.state).toBe('developing')
})

test('finishedDevelopment takes types too, and the reviewer and the next step follow them', async ($, on) => {
  const w = engine(on, { names: ['app/cart/page.tsx', 'server/api.py'] })
  await start($, w)
  w.s.dirty = [' M app/cart/page.tsx']
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['app/cart/page.tsx'], changeTypes: ['database'] })
  expect(w.state()?.changeTypes).toEqual(['database', 'web', 'backend'])
  expect(w.spawns[0]!.prompt).toContain('Web:')
  expect(w.spawns[0]!.prompt).toContain('Backend:')
  expect(w.spawns[0]!.prompt).toContain('Database:')
  expect(r.text).toContain('screenshot tool')
  expect(r.text).toContain('/cart')
  expect(r.text).toContain('local database')
})

test('a documents-only change gets the short review, and a code change that declares docs does not', async ($, on) => {
  const w = engine(on, { names: ['README.md'] })
  await start($, w)
  w.s.dirty = [' M README.md']
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['README.md'], changeTypes: ['docs'] })
  expect(w.spawns[0]!.prompt).toContain('documents only')
  expect(r.text).toContain('deadcode as "none: documents only"')
  expect(r.text).not.toContain('dead-code sweep')
})

test('a declaration can add a type and cannot take the code out of the review', async ($, on) => {
  const w = engine(on, { names: ['lib/a.ts'] })
  await start($, w)
  w.s.dirty = [' M lib/a.ts']
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['lib/a.ts'], changeTypes: ['docs'] })
  expect(w.spawns[0]!.prompt).not.toContain('documents only')
  expect(r.text).toContain('dead-code sweep')
})

test('a diff that cannot be read gives the full review and says so, until a read succeeds', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci', prs: [12], changeTypes: ['docs'] }, names: ['README.md'] })
  await start($, w)
  w.s.diffFails = 'fatal: bad revision'
  await command($, 'goto reviewing go back')
  expect(w.spawns[0]!.prompt).not.toContain('documents only')
  expect(w.state()?.typesUnread).toContain('fatal: bad revision')
  expect((await tool($, 'status')).text).toContain('dead-code sweep')
  w.s.dirty = [' M README.md']
  const r = await tool($, 'checkpoint', { message: 'm', files: ['README.md'] })
  expect(r.text).toContain('fatal: bad revision')
  expect(r.text).toContain('git fetch origin')
  w.s.diffFails = ''
  w.s.dirty = [' M README.md']
  const good = await tool($, 'checkpoint', { message: 'n', files: ['README.md'] })
  expect(w.state()?.typesUnread).toBeUndefined()
  expect(good.text).toContain('deadcode as "none: documents only"')
})

test('a /flow goto reviewing gives the reviewer the types of the diff', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci', prs: [12] }, names: ['supabase/migrations/1_a.sql'] })
  await start($, w)
  await command($, 'goto reviewing go back')
  expect(w.spawns[0]!.prompt).toContain('Database:')
  expect(w.state()?.changeTypes).toEqual(['database'])
})

test('a declared web change goes to the smoke stage although the paths show none', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci', prs: [12], changeTypes: ['web', 'backend'] }, names: ['server/render.py'] })
  await start($, w)
  const r = await tool($, 'finishedChecks')
  expect(w.state()?.state).toBe('smoke')
  expect(r.text).toContain('screenshot tool')
})

test('status names the change types', async ($, on) => {
  const w = engine(on, { wf: { changeTypes: ['web', 'docs'] } })
  await start($, w)
  expect((await tool($, 'status')).text).toContain('Change types: web, docs')
})

// ---- screenshot ----

const orcaVerbs = (w: W) => w.orcaCalls.map(c => (c[0] === 'tab' ? `tab ${c[1]}` : c[0]))
const SHOTS = `${ROOT}/.git/worktrees/x/ndev-screenshots/${SHA.slice(0, 8)}`

test('screenshot reads a login page from the host and path of the address, not from its query', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing', prs: [12] } })
  await start($, w)
  w.s.pageUrl = 'https://app.test/login'
  const went = await tool($, 'screenshot', { url: 'https://app.test/go?to=https://app.test/login', viewports: ['390x844'], schemes: ['light'] })
  expect(went.isError).toBe(true)
  expect(went.text).toContain('went to the login page')
  w.s.pageUrl = 'https://app.test/help?from=/login'
  const help = await tool($, 'screenshot', { url: 'https://app.test/help?from=/login', viewports: ['390x844'], schemes: ['light'] })
  expect(help.text).toContain('Saved 1 image of')
  expect(help.isError).toBe(false)
})

test('screenshot takes each viewport in each scheme, saves under the git folder and closes its tab', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const before = w.gh.length
  const r = await tool($, 'screenshot', { url: 'http://localhost:3000/cart' })
  expect(r.text).toContain('Saved 6 images')
  expect(r.isError).toBe(false)
  expect(w.copies).toHaveLength(6)
  for (const view of ['390x844', '820x1180', '1440x900']) {
    for (const scheme of ['light', 'dark']) {
      const file = `${SHOTS}/localhost-3000-cart-${view}-${scheme}.png`
      expect(w.copies).toContain(file)
      expect(r.text).toContain(file)
    }
  }
  expect(w.orcaCalls.at(-1)!.slice(0, 2)).toEqual(['tab', 'close'])
  expect(w.orcaCalls.at(-1)).toContain('page-1')
  expect(orcaVerbs(w).filter(v => v === 'tab create')).toHaveLength(1)
  expect(w.gh.slice(before)).toEqual([])
  expect(r.text).toContain('Read')
  // It changes no state and needs no save.
  expect(w.state()?.state).toBe('developing')
  expect(w.state()?.rev).toBe(1)
})

test('screenshot follows the viewports, schemes, fullPage and waitSeconds that it gets', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const r = await tool($, 'screenshot', { url: 'https://x.test/', viewports: ['320x640'], schemes: ['dark'], fullPage: true, waitSeconds: 2 })
  expect(r.isError).toBe(false)
  expect(w.copies).toEqual([`${SHOTS}/x-test-home-320x640-dark.png`])
  expect(orcaVerbs(w)).toContain('full-screenshot')
  expect(orcaVerbs(w)).not.toContain('screenshot')
  expect(w.orcaCalls.some(c => c[0] === 'wait' && c.includes('2000'))).toBe(true)
})

test('screenshot works with no workflow, and for a helper', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  const r = await tool($, 'screenshot', { url: 'https://x.test/a', viewports: ['320x640'], schemes: ['light'], agentId: 'helper-1' })
  expect(r.isError).toBe(false)
  expect(w.copies).toHaveLength(1)
})

test('screenshot refuses bad arguments before it opens a tab', async ($, on) => {
  const w = engine(on)
  await start($, w)
  for (const args of [{}, { url: 'file:///etc/passwd' }, { url: 'x.test' }, { url: 'https://x.test', viewports: ['wide'] }, { url: 'https://x.test', viewports: [] }, { url: 'https://x.test', schemes: ['blue'] }, { url: 'https://x.test', schemes: [] }, { url: 'https://x.test', waitSeconds: -1 }]) {
    const r = await tool($, 'screenshot', args)
    expect([JSON.stringify(args), r.isError]).toEqual([JSON.stringify(args), true])
  }
  expect(w.orcaCalls).toEqual([])
})

test('screenshot with no orca command refuses and names the repair and the other route', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.orcaGone = true
  const r = await tool($, 'screenshot', { url: 'https://x.test' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('orca did not run')
  expect(r.text).toContain('orca open')
  expect(r.text).toContain('ndev:responsive-check')
  expect(w.copies).toEqual([])
})

test('screenshot with Orca not running refuses and opens no tab', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.orcaReachable = false
  const r = await tool($, 'screenshot', { url: 'https://x.test' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('orca open')
  expect(orcaVerbs(w)).toEqual(['status'])
})

test('a browser command that fails names the command, the code and the repair', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.orcaFails = 'The desktop is offline'
  const r = await tool($, 'screenshot', { url: 'https://x.test' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('orca tab create')
  expect(r.text).toContain('browser_host_unavailable')
  expect(r.text).toContain('orca open')
})

test('a page that lands on a login leaves its tab for the human and saves nothing', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.pageUrl = 'https://x.test/login?next=/cart'
  const r = await tool($, 'screenshot', { url: 'https://x.test/cart' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('https://x.test/login?next=/cart')
  expect(r.text).toContain('sign in')
  expect(r.text).toContain('page-1')
  expect(w.copies).toEqual([])
  expect(orcaVerbs(w)).not.toContain('tab close')
})

test('a login page that was asked for is taken', async ($, on) => {
  const w = engine(on)
  await start($, w)
  expect((await tool($, 'screenshot', { url: 'https://x.test/login', viewports: ['320x640'], schemes: ['light'] })).isError).toBe(false)
  expect(w.copies).toHaveLength(1)
})

test('a viewport that was not applied is refused, and the tab still closes', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.pageWidth = 1000
  const r = await tool($, 'screenshot', { url: 'https://x.test' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('1000')
  expect(r.text).toContain('390')
  expect(w.copies).toEqual([])
  expect(orcaVerbs(w).at(-1)).toBe('tab close')
})

test('a copy that fails is refused, the tab closes, and the failure names the file', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.cpFails = 'No space left on device'
  const r = await tool($, 'screenshot', { url: 'https://x.test' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('No space left on device')
  expect(orcaVerbs(w).at(-1)).toBe('tab close')
})

// ---- a refused command name must not stop the watcher ----
test('when the command name is refused, the watcher still starts and the toast names the refusal', async ($, on) => {
  const w = engine(on, { refuseCommand: /^flow$/, wf: { state: 'ci' }, pr: { mergeable: false, mergeable_state: 'dirty' } })
  await start($, w)
  expect(w.toasts.join('\n')).toContain('did not start')
  await poll(w)
  expect(w.prompts.join('\n')).toContain('merge conflict')
})

test('the command name is not /workflow, which the Vercel plugin owns', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' } })
  await start($, w)
  expect(w.commandNames).toContain('flow')
  expect(w.commandNames).not.toContain('workflow')
})

test('a check that passes with stdout at the 4 MiB cap still commits, and its log says it was cut', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.hugeCheck = 'pre-commit-check'
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'Add', files: ['a.ts'] })
  expect(r.text).not.toContain('byte limit')
  expect(r.isError).toBe(false)
  expect(w.commits.length).toBe(1)
  const log = [...w.files].find(([path]) => path.endsWith('ndev-pre-commit-check.sh.log'))?.[1]
  expect(log).toContain('printed more than 4 MiB on stdout')
  expect(log).toContain('--- stderr')
})

test('a check that fails with stdout at the 4 MiB cap names its exit code and the cut, not the log write', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.hugeCheck = 'pre-commit-check'
  w.s.hugeExit = 3
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'Add', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('pre-commit-check.sh exited 3')
  expect(r.text).toContain('4 MiB')
  expect(w.commits.length).toBe(0)
})

// ---- a resumed session finds its workflow again ----
// A session in the main checkout works in a worktree. Its link to that worktree does not survive a restart, and session end clears the owner.
for (const [what, wf] of [['still owns', { owner: { session: 's1', at: 0 } }], ['ended and released', { owner: undefined, lastSession: 's1' }]] as const) {
  test(`a resumed session in the main checkout that ${what} the workflow is watched again`, async ($, on) => {
    const w = engine(on, { wf: { state: 'ci', ...wf }, pr: { mergeable: false, mergeable_state: 'dirty' } })
    await $.session.start({ cwd: '/main', surface: 'terminal', isInteractive: false })
    await settle()
    await poll(w)
    expect(w.prompts.join('\n')).toContain('merge conflict')
    expect(w.state()?.owner?.session).toBe('s1')
  })
}

test('a session that never had the workflow does not take it on start', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci', owner: undefined, lastSession: 'another' } })
  await $.session.start({ cwd: '/main', surface: 'terminal', isInteractive: false })
  await settle()
  expect(w.state()?.owner).toBeUndefined()
})

// ---- waitForPR, waitForIssue and the alert past half the retries ----
test('waitForPR holds until the PR is merged, with one GitHub read for each check', async ($, on) => {
  const w = engine(on, { pr: { state: 'open', merged: false } })
  await start($, w)
  w.s.sleepAdvances = true
  const reads = () => w.gh.filter(c => c.includes(' pr-read 44')).length
  const before = reads()
  w.s.prReadsFor = { 44: [{ state: 'open', merged: false }, { state: 'closed', merged: true }] }
  const r = await tool($, 'waitForPR', { pr: 44, state: 'merged', period: 60 })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('PR #44')
  expect(reads() - before).toBe(2)
  expect(w.s.now).toBe(60_000)
  expect(w.state()?.state).toBe('developing')
})

test('waitForPR refuses a state it cannot read, and a period that spends the GitHub calls', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const bad = await tool($, 'waitForPR', { pr: 44, state: 'green' })
  expect(bad.isError).toBe(true)
  expect(bad.text).toContain('merged')
  const fast = await tool($, 'waitForPR', { pr: 44, state: 'merged', period: 5 })
  expect(fast.isError).toBe(true)
  expect(fast.text).toContain('60')
  expect(w.state()?.state).toBe('developing')
})

test('waitForPR outlasts a failed read and ends at once on a PR that does not exist', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  w.s.prReadsFor = { 44: ['HTTP 502', { state: 'closed', merged: true }], 45: ['Could not resolve to a PullRequest: not found'] }
  expect((await tool($, 'waitForPR', { pr: 44, state: 'merged', period: 60 })).isError).toBe(false)
  const r = await tool($, 'waitForPR', { pr: 45, state: 'merged', period: 60 })
  expect(r.text).toContain('not found')
  expect(w.state()?.state).toBe('developing')
})

test('waitForIssue holds until the issue is closed', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  w.s.issueReadsFor = { 9: [{ state: 'open' }, { state: 'closed' }] }
  const r = await tool($, 'waitForIssue', { waitOn: [9], state: 'closed', period: 60 })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('issue #9')
  expect((await tool($, 'waitForIssue', { waitOn: [9], state: 'merged' })).isError).toBe(true)
})

test('a wait past half its attempts tells the human once, and withdraws the notice when it ends', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  const seen: string[][] = []
  let left = 5
  w.s.probe = () => {
    seen.push([...w.alerts])
    return { exitCode: --left === 0 ? 0 : 1 }
  }
  const r = await tool($, 'waitFor', { shell_command: 'false', period: 5, attempts: 6 })
  expect(r.isError).toBe(false)
  // Checks 1 to 3 are half of 6. The notice comes after check 4.
  expect(seen.map(a => a.length)).toEqual([0, 0, 0, 0, 1])
  expect(w.alerts).toEqual(['raise', 'withdraw'])
  expect(w.state()?.waiting).toBeUndefined()
})

test('a wait with no attempts counts half of its timeout', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  w.s.probe = () => ({ exitCode: 1 })
  const r = await tool($, 'waitFor', { shell_command: 'false', period: 10, timeout: 100 })
  expect(r.isError).toBe(true)
  expect(w.alerts).toEqual(['raise', 'withdraw'])
})

test('a short wait and waitForSeconds do not raise the notice', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  await tool($, 'waitForSeconds', { secs: 7 })
  let exits = [1, 0]
  w.s.probe = () => ({ exitCode: exits.shift() ?? 0 })
  await tool($, 'waitFor', { shell_command: 'x', period: 5, attempts: 10 })
  expect(w.alerts).toEqual([])
})

// ---- each call names its issue; create; comment ----
test('a state tool with no issue is refused, and nothing changes', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' } })
  await start($, w)
  const before = w.state()?.rev
  const r = await tool($, 'finishedChecks', { issue: undefined })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('finishedChecks needs issue')
  expect(w.state()?.rev).toBe(before)
})

test('the schema of each state tool asks for what that stage names: the issue, the issues, or either the issue or the PR', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  const specs = registeredTools as { name: string; inputSchema: { required: string[]; properties: Record<string, unknown> } }[]
  const spec = (name: string) => specs.find(s => s.name === name)!.inputSchema
  expect(spec('finishedPlan').required).toContain('issue')
  expect(spec('finishedDevelopment').required).toContain('issues')
  expect(spec('waitForPR').required).toEqual(expect.arrayContaining(['issue', 'pr', 'state']))
  for (const name of STATE_TOOLS.filter(n => !['finishedPlan', 'finishedDevelopment', 'waitForPR'].includes(n))) {
    expect(Object.keys(spec(name).properties)).toEqual(expect.arrayContaining(['issue', 'pr']))
    expect(spec(name).required).not.toContain('issue')
    expect(spec(name).required).not.toContain('pr')
  }
  expect(spec('waitForIssue').required).toContain('waitOn')
  expect((spec('waitForIssue').properties.waitOn as { type: string }).type).toBe('array')
})

test('a call that names an issue this agent is not on is refused and names the repair', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  await tool($, 'started', { issue: 7 })
  await tool($, 'started', { issue: 12, shortName: 'other-work' })
  const before = w.state(7)?.rev
  const r = await tool($, 'blocked', { issue: 7, message: 'stuck' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('on issue #12')
  expect(r.text).toContain('started')
  expect(w.state(7)?.state).toBe('developing')
  expect(w.state(7)?.rev).toBe(before)
})

test('a call that names an issue with no record says so', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' } })
  await start($, w)
  const r = await tool($, 'finishedChecks', { issue: 99 })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('#99')
})

test('status reads the named issue, and does not change the active one', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  await tool($, 'started', { issue: 7 })
  await tool($, 'started', { issue: 12, shortName: 'other-work' })
  expect((await tool($, 'status', { issue: 7 })).text).toContain('State: developing. Issue #7')
  expect((await tool($, 'status')).text).toContain('Issue #12')
})

test('create files the issue, starts its workflow and answers with the number', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  const r = await tool($, 'create', { shortName: 'new-thing', description: 'The title\n\nThe body.' })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('Issue #31')
  expect(w.state(31)?.shortName).toBe('new-thing')
  const made = w.gh.find(line => line.includes('issue-new'))!
  expect(made).toContain('The title')
  expect([...w.files.values()].some(text => text.includes('The body.'))).toBe(true)
})

test('create refuses a bad shortName or no description before it files anything', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  expect((await tool($, 'create', { shortName: 'Bad Name', description: 'T' })).isError).toBe(true)
  expect((await tool($, 'create', { shortName: 'new-thing', description: '' })).isError).toBe(true)
  expect(w.gh.filter(line => line.includes('issue-new'))).toEqual([])
})

test('create refuses in a project with the workflow off, before it files anything', async ($, on) => {
  const w = engine(on, { wf: null, config: { workflow: false } })
  await start($, w)
  const r = await tool($, 'create', { shortName: 'new-thing', description: 'T' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('off for this project')
  expect(w.gh.filter(line => line.includes('issue-new'))).toEqual([])
})

test('create that files the issue and then cannot start names the issue and the repair', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  w.s.issueReadsFor = { 31: ['read failed'] }
  const r = await tool($, 'create', { shortName: 'new-thing', description: 'T' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('#31')
  expect(r.text).toContain('started')
  expect(r.text).toContain('new-thing')
  expect(r.text).toContain('read failed')
})

test('comment posts to the issue or the PR it names, marked as the tool\'s own', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  const toIssue = await tool($, 'comment', { issue: 9, message: 'On the issue.' })
  expect(toIssue.isError).toBe(false)
  expect(toIssue.text).toContain(`https://github.com/${REPO}/issues/9`)
  const onPr = await tool($, 'comment', { pr: 12, message: 'On the PR.' })
  expect(onPr.isError).toBe(false)
  expect(onPr.text).toContain(`https://github.com/${REPO}/pull/12`)
  const said = w.gh.filter(line => line.includes(' comment '))
  expect(said.length).toBe(2)
  expect(said[0]).toContain('comment 9')
  expect(said[0]).toContain('On the issue.')
  expect(said[0]).toContain('ndev')
  expect(said[1]).toContain('comment 12')
})

test('comment refuses without one target, or without a message', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  for (const args of [{ message: 'x' }, { issue: 9, pr: 12, message: 'x' }, { issue: 9 }, { pr: 0, message: 'x' }]) {
    expect((await tool($, 'comment', args)).isError).toBe(true)
  }
  expect(w.gh.filter(line => line.includes(' comment '))).toEqual([])
})

// The merge point: from finishedDevelopment on, the PR and not one issue goes through review and CI.
const mine = (over = {}) => ({ owner: { session: 's1', at: 0 }, ...over })

test('finishedDevelopment with all the issues of a PR starts one review, of the PR, and names each issue', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  w.files.set(RECORD, held(seven(), twelve()))
    await start($, w)
    const r = await tool($, 'finishedDevelopment', { issues: [7, 12], prs: [12], files: [] })
    expect(r.isError).toBe(false)
    expect(w.issueRecord(7)!.state).toBe('developed')
    expect(w.issueRecord(12)!.state).toBe('developed')
    const pr = w.prRecord(12)! as Record<string, unknown>
    expect(pr.state).toBe('reviewing')
    expect(pr.issues).toEqual([7, 12])
    expect(r.text).toContain('pr 12')
    expect(w.spawns).toHaveLength(1)
    expect(String((w.spawns[0] as { prompt: string }).prompt)).toContain('#7')
    expect(String((w.spawns[0] as { prompt: string }).prompt)).toContain('#12')
})

test('an issue that finishes before another on its PR waits, and the last one to finish starts the review', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  w.files.set(RECORD, held(seven(), twelve()))
    await start($, w)
    const first = await tool($, 'finishedDevelopment', { issues: [7], prs: [12], files: [] })
    expect(first.isError).toBe(false)
    expect(first.text).toContain('#12')
    expect(w.issueRecord(7)!.state).toBe('developed')
    expect(w.prRecord(12)).toBeUndefined()
    expect(w.spawns).toHaveLength(0)
    expect((await tool($, 'started', { issue: 12 })).isError).toBe(false)
    const last = await tool($, 'finishedDevelopment', { issues: [12], prs: [12], files: [] })
    expect(last.isError).toBe(false)
    expect(w.prRecord(12)!.state).toBe('reviewing')
    expect(w.prRecord(12)!.issues).toEqual([7, 12])
    expect(w.spawns).toHaveLength(1)
})

test('finishedDevelopment refuses an issue that this worktree does not hold, and an empty list', async ($, on) => {
  engine(on, { wf: { state: 'developing' } })
    await start($)
    expect((await tool($, 'finishedDevelopment', { issues: [7, 99], prs: [12], files: [] })).text).toContain('#99')
    expect((await tool($, 'finishedDevelopment', { issues: [], prs: [12], files: [] })).isError).toBe(true)
})

test('from the merge point on, a stage tool that names only the issue is told to give the PR', async ($, on) => {
  engine(on, { wf: { state: 'ci' }, pr: pull() })
    await start($)
    const r = await tool($, 'finishedChecks', { issue: 7 })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('pr 12')
    expect((await tool($, 'finishedChecks', { pr: 12 })).text).not.toContain('give pr')
})

test('a PR with no workflow yet is refused by number', async ($, on) => {
  engine(on, { wf: { state: 'developing' } })
    await start($)
    const r = await tool($, 'finishedChecks', { pr: 44 })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('PR #44')
})

for (const stage of ['ci', 'smoke', 'finishing', 'done']) {
  test(`a new issue joins a PR in ${stage}, which goes back to its developers with no evidence`, async ($, on) => {
    const w = engine(on, { wf: finishing({ state: stage, hooks: { review: { firedAt: 1, agentId: 'a', answer: 'old' } } }), pr: pull() })
      await start($, w)
      w.s.issueReadsFor = { 31: [{ state: 'open', title: 'More' }] }
      const r = await tool($, 'started', { issue: 31, shortName: 'more-work' })
      expect(r.isError).toBe(false)
      expect(r.text).toContain('PR #12')
      const pr = w.prRecord(12)! as Record<string, unknown> & { hooks?: { review?: unknown } }
      expect(pr.state).toBe('developing')
      expect(pr.evidence).toEqual({})
      expect(pr.hooks?.review).toBeUndefined()
      expect(pr.issues).toEqual([7, 31])
      expect(w.issueRecord(31)!.prs).toEqual([12])
      expect(w.issueRecord(31)!.state).toBe('developing')
      expect(w.files.get(bodyFile(w))).toContain('Closes #31')
  })
}

test('a PR that has merged takes no new issue, and the refusal names its state', async ($, on) => {
  const w = engine(on, { wf: { state: 'done', merged: true }, pr: pull({ state: 'closed', merged: true }) })
    await start($, w)
    const r = await tool($, 'started', { issue: 31, shortName: 'more-work' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('merged')
    expect(w.issueRecord(31)).toBeUndefined()
})

test('a PR that was closed with no merge takes no new issue, and the refusal names its state', async ($, on) => {
  const w = engine(on, { wf: { state: 'done' }, pr: pull({ state: 'closed' }) })
    await start($, w)
    const r = await tool($, 'started', { issue: 31, shortName: 'more-work' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('closed')
})

test('an issue that opens the PR shares it with the issue it joined, which had none', async ($, on) => {
  const w = engine(on, { wf: { state: 'planning', prs: [] }, pr: pull() })
    await start($, w)
    w.s.issueReadsFor = { 31: [{ state: 'open', title: 'More' }] }
    expect((await tool($, 'started', { issue: 31, shortName: 'more-work' })).isError).toBe(false)
    const shared = w.issueRecord(31)!.prs
    expect(shared).toHaveLength(1)
    expect(w.issueRecord(7)!.prs).toEqual(shared)
})

test('a new session does not join the issue of another live agent', async ($, on) => {
  const w = engine(on, { wf: { owner: { session: 'other', at: 0 } } })
    await start($, w)
    const r = await tool($, 'started', { issue: 31, shortName: 'more-work' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('other')
    expect(w.issueRecord(31)).toBeUndefined()
})

test('a resumed session binds to the unfinished issue it released last', async ($, on) => {
  const w = engine(on, { wf: null })
  const released = (issue: number, at: number, state = 'developing') => flow({ issue, state, owner: undefined, lastSession: 's1', releasedAt: at })
  w.files.set(RECORD, held(released(7, 100, 'done'), released(9, 50), released(11, 80)))
    await start($, w)
    expect((await tool($, 'status')).text).toContain('Issue #11')
})

test('a checkpoint on an issue holds its commit while another issue on the PR holds one too', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  w.files.set(RECORD, held(seven(mine({ state: 'developed' })), twelve(mine())))
    await start($, w)
    await tool($, 'started', { issue: 12 })
    const before = w.pushes.length
    w.s.dirty = [' M x.ts']
    w.s.staged = true
    const r = await tool($, 'checkpoint', { issue: 12, message: 'm', files: ['x.ts'] })
    expect(r.isError).toBe(false)
    expect(w.pushes.length).toBe(before)
    expect(r.text).toContain('#7')
})

test('addMigration lists the migrations of each issue on the PR, and not only of the caller', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  w.files.set(RECORD, held(seven(mine()), twelve({ migrations: [{ name: 'other_one', path: 'supabase/migrations/1_other_one.sql' }] })))
  w.files.set(`${ROOT}/supabase/config.toml`, '')
    await start($, w)
    expect((await tool($, 'addMigration', { name: 'mine_one' })).isError).toBe(false)
    const body = w.files.get(bodyFile(w))!
    expect(body).toContain('1_other_one.sql')
    expect(body).toContain('mine_one')
})

test('the answer of a code review reaches the PR record, while the agent is on another issue', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  w.files.set(RECORD, JSON.stringify({ version: 2, resources: {}, workflows: { 7: seven({ state: 'developed' }), 31: flow({ issue: 31, state: 'developing', ...mine() }) }, prs: { 12: flow({ pr: 12, issues: [7, 31], state: 'reviewing', hooks: { review: { firedAt: 1, agentId: 'rev-1' } } }) } }))
    await start($, w)
    await tool($, 'started', { issue: 31 })
    await $.turn.complete({ agentId: 'rev-1', answer: 'No findings.' } as never)
    expect((w.prRecord(12)!.hooks!.review as { answer?: string }).answer).toContain('No findings')
})

test('finishedPlan keeps the text outside the plans, and each closing reference in any form', async ($, on) => {
  const w = engine(on, { wf: { state: 'planning' }, pr: pull({ body: 'Plan incoming.\n\nA note from the human.\n\nCloses: #31\nCloses owner/repo#32\nFixes https://github.com/o/r/issues/33\n' }) })
  w.files.set('/tmp/plan.md', 'The plan.\nTest entry point: the tool.\n')
    await start($, w)
    expect((await tool($, 'finishedPlan', { markdown_file: '/tmp/plan.md' })).isError).toBe(false)
    const body = w.files.get(bodyFile(w))!
    expect(body).toContain('A note from the human.')
    expect(body).toContain('Closes: #31')
    expect(body).toContain('Closes owner/repo#32')
    expect(body).toContain('issues/33')
    expect(body).not.toContain('Plan incoming.')
})

test('followUp this_agent from the PR stage sends the PR back, and the agent goes on the new issue', async ($, on) => {
  const w = engine(on, { wf: finishing(), pr: pull() })
    await start($, w)
    const r = await tool($, 'followUp', { mode: 'this_agent', message: 'Sub work' })
    expect(r.text).toContain('This PR now closes')
    expect(r.isError).toBe(false)
    const n = Number(/issues\/(\d+)/.exec(r.text)![1])
    expect(w.prRecord(12)!.state).toBe('developing')
    expect(w.prRecord(12)!.issues).toContain(n)
    expect(w.issueRecord(n)!.state).toBe('developing')
    expect(w.issueRecord(n)!.prs).toEqual([12])
    expect(((await tool($, 'status')).text)).toContain(`Issue #${n}`)
})

test('waitForIssue takes several issues and ends when all of them reach the state', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
    await start($, w)
    w.s.sleepAdvances = true
    w.s.issueReadsFor = { 9: [{ state: 'closed' }, { state: 'closed' }], 10: [{ state: 'open' }, { state: 'closed' }] }
    const r = await tool($, 'waitForIssue', { waitOn: [9, 10], state: 'closed', period: 60 })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('#9')
    expect(r.text).toContain('#10')
    expect(w.s.issueReadsFor[10]).toHaveLength(0)
    expect((await tool($, 'waitForIssue', { waitOn: [], state: 'closed' })).isError).toBe(true)
    expect((await tool($, 'waitForIssue', { waitOn: 9, state: 'closed' })).isError).toBe(true)
})

test('no tool schema lists a name twice under required, which would drop the tool from the model', async ($, on) => {
  const w = engine(on, { wf: null })
    await start($, w)
    const seen = registeredTools as { name: string; inputSchema: { required?: string[] } }[]
    expect(seen.length).toBeGreaterThan(20)
    for (const s of seen) expect(new Set(s.inputSchema.required ?? []).size).toBe((s.inputSchema.required ?? []).length)
    for (const s of seen) for (const r of s.inputSchema.required ?? []) expect(Object.keys((s.inputSchema as unknown as { properties: object }).properties)).toContain(r)
})

for (const types of [['docs'], ['web', 'backend']]) {
  test(`finishedSmoke refuses skipped when the change types hold ${types[0]}, and names the types and the repair`, async ($, on) => {
    const w = engine(on, { wf: { state: 'smoke', changeTypes: types } })
    await start($, w)
    const r = await tool($, 'finishedSmoke', { skipped: 'no preview' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain(types[0]!)
    expect(r.text).toContain('/flow skip')
    expect(w.state()?.state).toBe('smoke')
  })
}

test('finishedSmoke still takes skipped when the types hold no web and no docs', async ($, on) => {
  const w = engine(on, { wf: { state: 'smoke', changeTypes: ['backend'] } })
  await start($, w)
  expect((await tool($, 'finishedSmoke', { skipped: 'nothing to see' })).isError).toBe(false)
  expect(w.state()?.state).toBe('finishing')
})

test('a human /flow skip leaves a required smoke stage, and a later commit of documents does not go back', async ($, on) => {
  const w = engine(on, { wf: { state: 'smoke', changeTypes: ['docs'], evidence: { checks: { sha: SHA, text: 'green' } } }, names: ['README.md'] })
  await start($, w)
  await command($, 'skip no preview here')
  expect(w.state()?.state).toBe('finishing')
  expect(w.state()?.evidence.smoke.text).toContain('skipped by the human')
  w.s.dirty = [' M README.md']
  w.s.staged = true
  await tool($, 'checkpoint', { message: 'docs', files: ['README.md'] })
  expect(w.state()?.state).toBe('finishing')
})

test('documents only now go to the smoke stage after the checks', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci', changeTypes: ['docs'] }, names: ['README.md'] })
  await start($, w)
  const r = await tool($, 'finishedChecks')
  expect(w.state()?.state).toBe('smoke')
  expect(r.text).toContain('each changed document')
})

test('a commit of documents in finishing sends a change with no smoke test to the smoke stage', async ($, on) => {
  const w = engine(on, { wf: { state: 'finishing', changeTypes: ['backend'], evidence: { checks: { sha: SHA, text: 'green' } } }, names: ['README.md'] })
  await start($, w)
  w.s.dirty = [' M README.md']
  w.s.staged = true
  await tool($, 'checkpoint', { message: 'docs', files: ['README.md'] })
  expect(w.state()?.state).toBe('smoke')
})

test('a push writes the change map to the PR body before git push, for the sha it pushes', async ($, on) => {
  const w = engine(on, { wf: { changeTypes: ['backend'] }, names: ['app/page.tsx', 'README.md'] })
  await start($, w)
  w.s.dirty = [' M a.ts']
  w.s.staged = true
  w.s.pushFails = 'rejected'
  expect((await tool($, 'checkpoint', { message: 'm', files: ['a.ts'], changeTypes: ['database'] })).isError).toBe(true)
  expect(w.pushes.length).toBe(0)
  expect(w.gh.some(line => line.includes('pr-edit 12'))).toBe(true)
  const body = w.files.get(`${ROOT}/.git/worktrees/x/ndev-pr-body.md`)!
  expect(body.startsWith('Closes #7\n\n<!-- ndev:change-map ')).toBe(true)
  const map = JSON.parse(/^<!-- ndev:change-map (.*) -->$/m.exec(body)![1]!)
  expect(map.sha).toBe(w.s.sha)
  expect(map.issues['7'].changeTypes).toEqual(['web', 'backend', 'database', 'docs'])
  expect(map.files).toEqual({ 'app/page.tsx': ['web'], 'README.md': ['docs'] })
})

test('an issue that this PR carries for a followUp is in the map', async ($, on) => {
  const w = engine(on, { wf: { followUps: [{ issue: 9, mode: 'this_agent' }, { issue: 10, mode: 'issue_only' }] } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  w.s.staged = true
  await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  const map = JSON.parse(/^<!-- ndev:change-map (.*) -->$/m.exec(w.files.get(`${ROOT}/.git/worktrees/x/ndev-pr-body.md`)!)![1]!)
  expect(Object.keys(map.issues)).toEqual(['7', '9'])
})

test('a failed write of the map does not stop the push, and the note says that CI runs everything', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.dirty = [' M a.ts']
  w.s.staged = true
  w.s.prReadsFor = { 12: ['HTTP 403: rate limit'] }
  const r = await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  expect(r.isError).toBe(false)
  expect(w.pushes.length).toBe(1)
  expect(r.text).toContain('CI runs everything')
})

test('a diff that cannot be read writes no map, and the note names the repair', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.dirty = [' M a.ts']
  w.s.staged = true
  w.s.diffFails = 'bad revision'
  const r = await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  expect(w.pushes.length).toBe(1)
  expect(w.gh.some(line => line.includes('pr-edit'))).toBe(false)
  expect(r.text).toContain('CI runs everything')
  expect(r.text).toContain('git fetch origin main')
})

test('finishedReview writes the map before its push', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' }, names: ['a.ts'] })
  await start($, w)
  w.s.sha = 'cccc1'
  await tool($, 'finishedReview', { review: 'clean', deadcode: 'clean', remembered: 'nothing: small' })
  expect(w.pushes.length).toBe(1)
  expect(w.files.get(`${ROOT}/.git/worktrees/x/ndev-pr-body.md`)).toContain('"sha":"cccc1"')
})

test('a direct commit to the base branch has no PR, so no map', async ($, on) => {
  const w = engine(on, { wf: { direct: true, prs: [] } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  w.s.staged = true
  await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  expect(w.gh.some(line => line.includes('pr-edit'))).toBe(false)
})

// ---- what the /view pane reads: the live file beside the record ----
const liveFile = (w: ReturnType<typeof engine>, name: string) => {
  const entry = [...w.files.entries()].find(([path]) => path.endsWith(`/ndev-live-${name}.json`))
  return entry ? (JSON.parse(entry[1]) as WorkflowLive) : undefined
}

test('a poll writes what came back to the live file, with no write to the record', async ($, on) => {
  const w = engine(on, { pr: { state: 'open', merged: false } })
  await start($, w)
  w.s.sleepAdvances = true
  w.s.prReadsFor = { 44: [
    { state: 'open', merged: false, draft: false, mergeable: false, mergeable_state: 'blocked', head: { sha: 'a1b2c3d4e5f6' } },
    { state: 'open', merged: false, draft: true, mergeable: false, mergeable_state: 'draft', head: { sha: 'a1b2c3d4e5f6' } },
    { state: 'closed', merged: true, head: { sha: 'a1b2c3d4e5f6' } },
  ] }
  const before = w.s.saves
  const r = await tool($, 'waitForPR', { pr: 44, state: 'merged', period: 60 })
  expect(r.isError).toBe(false)
  // One to enter the wait and one to leave it, however many checks ran.
  expect(w.s.saves - before).toBe(2)
  const live = liveFile(w, 'issue-7')
  expect(live?.wait?.tries).toBe(3)
  expect(live?.wait?.seen).toEqual({ state: 'merged', draft: 'no', mergeable: 'unknown', head: 'a1b2c3d4' })
  expect(live?.calls?.at(-1)).toMatchObject({ tool: 'waitForPR', outcome: 'ok', args: expect.objectContaining({ pr: '44', state: 'merged' }) })
})

test('the wait in the record holds the period and the arguments, with no secret', async ($, on) => {
  const w = engine(on)
  await start($, w)
  let seen: Workflow['waiting']
  w.s.probe = async () => {
    seen = w.state()?.waiting
    return { exitCode: 0 }
  }
  const r = await tool($, 'waitFor', { shell_command: 'API_TOKEN=hunter2 curl https://x.io/a?k=v', period: 30, timeout: 90 })
  expect(r.isError).toBe(false)
  expect(seen).toMatchObject({ tool: 'waitFor', period: 30, most: 3, timeoutS: 90 })
  expect(JSON.stringify(seen)).not.toContain('hunter2')
  expect(JSON.stringify(seen)).not.toContain('k=v')
})

test('a failed write of the live file costs one toast, and the wait goes on', async ($, on) => {
  const w = engine(on, { pr: { state: 'open', merged: false } })
  await start($, w)
  w.s.sleepAdvances = true
  w.s.prReadsFor = { 44: [{ state: 'open', merged: false }, { state: 'closed', merged: true }] }
  w.s.failWrite = (path: string) => path.includes('ndev-live-')
  const r = await tool($, 'waitForPR', { pr: 44, state: 'merged', period: 60 })
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('developing')
  expect(w.toasts.filter(t => t.includes('will not show the live state of issue-7'))).toHaveLength(1)
})

test('a refused call shows in the live file with its reason and its arguments', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const r = await tool($, 'finishedSmoke', { report: 'looked fine' })
  expect(r.isError).toBe(true)
  const call = liveFile(w, 'issue-7')?.calls?.at(-1)
  expect(call).toMatchObject({ tool: 'finishedSmoke', outcome: 'refused', args: expect.objectContaining({ report: 'looked fine' }) })
  expect(call?.note).toContain('not valid')
})

test('a project with the workflow off writes no live file', async ($, on) => {
  const w = engine(on, { wf: null, config: { workflow: false } })
  await start($, w)
  await tool($, 'comment', { issue: 7, message: 'hello' })
  expect(liveFile(w, 'issue-7')).toBeUndefined()
})

// ---- the mode and the steering of one issue ----
test('started takes the mode that the agent chooses, and the record of that issue keeps it', async ($, on) => {
  const w = engine(on, { wf: null, config: { mode: 'light' } })
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'fix-login', mode: 'heavy' })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('Mode: heavy')
  expect(w.state()?.state).toBe('planning')
  expect(w.state()?.mode).toBe('heavy')
})

test('with no choice, an issue follows the worktree and the record stores nothing', async ($, on) => {
  const w = engine(on, { wf: null, config: { mode: 'light' } })
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'fix-login' })
  expect(r.text).toContain('Mode: light')
  expect(w.state()?.state).toBe('developing')
  expect(w.state()?.mode).toBeUndefined()
})

test('the agent chooses the mode only at the start, and the refusal names the command for the human', async ($, on) => {
  const w = engine(on, { wf: null, config: { mode: 'light' } })
  await start($, w)
  await tool($, 'started', { issue: 7, shortName: 'fix-login' })
  const r = await tool($, 'started', { issue: 7, mode: 'heavy' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('/flow mode heavy 7')
  expect(w.state()?.mode).toBeUndefined()
})

test('started refuses a mode that does not exist, and offers the agent no steering', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'fix-login', mode: 'medium' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('"medium"')
  const spec = (registeredTools as { name: string; inputSchema: { properties: Record<string, unknown> } }[]).find(t => t.name.endsWith('started'))!
  expect(Object.keys(spec.inputSchema.properties)).toContain('mode')
  expect(Object.keys(spec.inputSchema.properties)).not.toContain('steering')
})

test('create passes the chosen mode to the workflow of the new issue', async ($, on) => {
  const w = engine(on, { wf: null, config: { mode: 'light' } })
  await start($, w)
  const r = await tool($, 'create', { shortName: 'new-thing', description: 'New thing\nbody', mode: 'heavy' })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('Mode: heavy')
})

test('/flow steering sets one issue, and that issue then follows it over the worktree', async ($, on) => {
  const w = engine(on, { wf: null, config: { mode: 'light', steering: 'auto' } })
  await start($, w)
  await tool($, 'started', { issue: 7, shortName: 'fix-login' })
  const said = await command($, 'steering interactive')
  expect(said).toContain('issue #7')
  expect(w.state()?.steering).toBe('interactive')
  expect((await tool($, 'status', {})).text).toContain('Report this checkpoint')
})

test('/flow mode names the issue, refuses a bad value, and shows the setting with no value', async ($, on) => {
  const w = engine(on, { wf: null, config: { mode: 'light' } })
  await start($, w)
  await tool($, 'started', { issue: 7, shortName: 'fix-login' })
  expect(await command($, 'mode medium')).toContain('"medium"')
  expect(await command($, 'mode heavy 7')).toContain('issue #7')
  expect(w.state()?.mode).toBe('heavy')
  expect(await command($, 'mode')).toContain('heavy')
  expect(await command($, 'mode light 99')).toContain('#99')
})

test('a PR follows the strictest of its issues: heavy over light, interactive over auto', () => {
  expect(strictest([{ mode: 'light', steering: 'auto' }, { mode: 'heavy', steering: 'interactive' }])).toEqual({ mode: 'heavy', steering: 'interactive' })
  expect(strictest([{ mode: 'light' }, { steering: 'auto' }])).toEqual({ mode: 'light', steering: 'auto' })
  expect(strictest([{}, {}])).toEqual({})
})

test('the PR record takes the settings of its issues, and /flow mode then sets the PR', async ($, on) => {
  const w = engine(on, { wf: flow({ mode: 'heavy', steering: 'auto' }) })
  await start($, w)
  w.s.dirty = []
  await tool($, 'finishedDevelopment', { prs: [12], message: 'Add the thing', files: ['a.ts'] })
  expect(w.prRecord(12)?.mode).toBe('heavy')
  expect(w.prRecord(12)?.steering).toBe('auto')
  expect(await command($, 'mode light')).toContain('PR #12')
  expect(w.prRecord(12)?.mode).toBe('light')
})

test('a PR of two issues is heavy and interactive when one issue is heavy and the other is interactive', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  w.files.set(RECORD, held(seven({ mode: 'light', steering: 'auto' }), twelve({ mode: 'heavy', steering: 'interactive' })))
  await start($, w)
  const r = await tool($, 'finishedDevelopment', { issues: [7, 12], prs: [12], files: [] })
  expect(r.isError).toBe(false)
  expect(w.prRecord(12)?.mode).toBe('heavy')
  expect(w.prRecord(12)?.steering).toBe('interactive')
  expect(w.issueRecord(7)?.mode).toBe('light')
})

// ---- found by the independent review ----
test('finishedDevelopment follows the strictest issue, also when the active issue is the light one', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  w.files.set(RECORD, held(seven({ mode: 'light' }), twelve({ mode: 'heavy' })))
  await start($, w)
  await tool($, 'started', { issue: 7 })
  const r = await tool($, 'finishedDevelopment', { issues: [7, 12], prs: [12], files: [] })
  expect(r.isError).toBe(false)
  expect(w.spawns).toHaveLength(2)
})

test('gates.sh runs for the heavy issue of a PR, not only when the lead is heavy', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  w.files.set(RECORD, held(seven({ mode: 'light' }), twelve({ mode: 'heavy' })))
  await start($, w)
  await tool($, 'started', { issue: 7 })
  w.s.failCheck = 'gates'
  const r = await tool($, 'finishedDevelopment', { issues: [7, 12], prs: [12], files: [] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('for #12')
})

test('the strictest of a PR counts an issue that inherits its settings', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' }, config: { mode: 'heavy', steering: 'interactive' } })
  w.files.set(RECORD, held(seven({ mode: 'light', steering: 'auto' }), twelve()))
  await start($, w)
  const r = await tool($, 'finishedDevelopment', { issues: [7, 12], prs: [12], files: [] })
  expect(r.isError).toBe(false)
  expect(w.prRecord(12)?.mode).toBe('heavy')
  expect(w.prRecord(12)?.steering).toBe('interactive')
})

test('a PR whose issues have no settings of their own stores none, so it follows the worktree', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  w.files.set(RECORD, held(seven(), twelve()))
  await start($, w)
  await tool($, 'finishedDevelopment', { issues: [7, 12], prs: [12], files: [] })
  expect(w.prRecord(12)?.mode).toBeUndefined()
  expect(w.prRecord(12)?.steering).toBeUndefined()
})

test('the end of a wait follows the steering of the issue', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing', steering: 'auto' }, config: { steering: 'interactive' } })
  await start($, w)
  w.s.sleepAdvances = true
  const r = await tool($, 'waitForSeconds', { secs: 7 })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('Continue without waiting')
  expect(r.text).not.toContain('Report this checkpoint')
})

test('started refuses to join the merged PR of a done record of another session', async ($, on) => {
  const w = engine(on, { wf: { state: 'done', owner: { session: 'other', at: 0 } }, pr: { state: 'closed', merged: true } })
  await start($, w)
  const r = await tool($, 'started', { issue: 9, shortName: 'new-thing' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('cannot join')
  expect(r.text).toContain('Repair')
  expect(w.gh.some(line => line.includes('pr-new'))).toBe(false)
})

test('followUp this_agent refuses when the PR has merged, and files no issue', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' }, pr: { state: 'closed', merged: true } })
  await start($, w)
  const r = await tool($, 'followUp', { mode: 'this_agent', message: 'A new thing' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('PR #12')
  expect(r.text).toContain('issue_only')
  expect(w.gh.some(line => line.includes('issue-new'))).toBe(false)
})

for (const args of ['skip because', 'goto reviewing because']) {
  test(`/flow ${args} refuses on one issue of a shared PR`, async ($, on) => {
    const w = engine(on, { wf: { state: 'developing' } })
    w.files.set(RECORD, held(seven(), twelve()))
    await start($, w)
    await tool($, 'started', { issue: 7 })
    const said = await command($, args)
    expect(said).toContain('#12')
    expect(said).toContain('finishedDevelopment')
    expect(w.issueRecord(7)?.state).toBe('developing')
  })
}

test('/flow skip still moves one issue alone on its PR', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  await command($, 'skip because')
  expect(w.state()?.state).toBe('reviewing')
})

test('/flow goto back to planning stays allowed on a shared PR', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  w.files.set(RECORD, held(seven(), twelve()))
  await start($, w)
  await tool($, 'started', { issue: 7 })
  await command($, 'goto planning because')
  expect(w.issueRecord(7)?.state).toBe('planning')
})

test('a raw git push is refused in a worktree of several records when this session owns none', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  const other = { owner: { session: 'other', at: 0 } }
  w.files.set(RECORD, held(seven(other), twelve(other)))
  await start($, w)
  const r = await hookCall($, 'Bash', { command: 'git push origin HEAD' })
  expect(JSON.stringify(r)).toContain('checkpoint')
})

test('a raw git push passes when each record of the worktree is done', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  const other = { state: 'done', owner: { session: 'other', at: 0 } }
  w.files.set(RECORD, held(seven(other), twelve(other)))
  await start($, w)
  const r = await hookCall($, 'Bash', { command: 'git push origin HEAD' })
  expect(JSON.stringify(r)).not.toContain('checkpoint')
})

test('a raw git push is refused when one record is done and another is open, and this session owns neither', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  const other = { owner: { session: 'other', at: 0 } }
  w.files.set(RECORD, held(seven({ ...other, state: 'done' }), twelve(other)))
  await start($, w)
  const r = await hookCall($, 'Bash', { command: 'git push origin HEAD' })
  expect(JSON.stringify(r)).toContain('issue #12')
})

test('the map names each issue on the PR before the PR record exists, with the types of all of them', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  w.files.set(RECORD, held(seven({ changeTypes: ['database'] }), twelve()))
  await start($, w)
  await tool($, 'started', { issue: 12 })
  w.s.dirty = [' M a.ts']
  w.s.staged = true
  await tool($, 'checkpoint', { issue: 12, message: 'm', files: ['a.ts'] })
  const map = JSON.parse(/^<!-- ndev:change-map (.*) -->$/m.exec(w.files.get(`${ROOT}/.git/worktrees/x/ndev-pr-body.md`)!)![1]!)
  expect(Object.keys(map.issues)).toEqual(['7', '12'])
  expect(map.issues['12'].changeTypes).toContain('database')
})

// ---- the copy editor beside the code review ----

const PROSE = ['apps/docs/content/using/overview.mdx', 'README.md']
const NOT_PROSE = ['a.ts', 'CLAUDE.md', 'AGENTS.md', 'kb/writing.md', 'skills/x/SKILL.md', 'docs/wiki/wiki.md', 'tests/fixtures/a.md', '.github/a.md']

test('a change with prose for users starts the copy editor beside the code review, on those files only', async ($, on) => {
  const w = engine(on, { names: [...PROSE, ...NOT_PROSE] })
  const r = await toReview($, w)
  expect(w.spawns.map(s => s.subagentType)).toEqual(['ndev:diff-reviewer', 'ndev:copy-editor'])
  const prompt = w.spawns[1]!.prompt
  for (const p of PROSE) expect(prompt).toContain(p)
  for (const p of NOT_PROSE) expect(prompt).not.toContain(p)
  expect(w.spawns[1]!.cwd).toBe(ROOT)
  expect(r.text).toContain('copy editor')
  expect(w.state()?.reviewCopy).toBeDefined()
})

test('a change with no prose for users starts no copy editor', async ($, on) => {
  const w = engine(on, { names: NOT_PROSE })
  const r = await toReview($, w)
  expect(w.spawns.map(s => s.subagentType)).toEqual(['ndev:diff-reviewer'])
  expect(r.text).not.toContain('copy editor')
})

test('the answer of the copy editor reaches the main agent in its own words, and the record keeps it', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing', prs: [12], hooks: { review: { firedAt: 1, agentId: 'reviewer-1' } }, reviewCopy: { agentId: 'copy-1' } } as never })
  await start($, w)
  await $.turn.complete({ agentId: 'copy-1', answer: 'VALE: ran, 0 alerts\nFINDINGS: 1\n1. A slogan.' } as never)
  await settle()
  expect(w.state()?.reviewCopy?.answer).toContain('A slogan')
  expect(w.prompts.join('\n')).toContain('The copy edit of')
  expect(w.prompts.join('\n')).toContain('A slogan')
})

test('a copy editor that did not start is named, and the repair names the files', async ($, on) => {
  const w = engine(on, { names: PROSE })
  w.s.spawnDeny = 'no such agent'
  const r = await toReview($, w)
  expect(r.text).toContain('The copy editor did not start: no such agent')
  expect(r.text).toContain('ndev:copy-editor')
  expect(r.text).toContain(PROSE[0]!)
})

test('a list of changed files that fails tells the agent why the copy editor did not start', async ($, on) => {
  const w = engine(on, { names: PROSE })
  await start($, w)
  w.s.dirty = [' M a.ts']
  w.s.copyDiffFails = 'bad revision'
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'] })
  expect(r.text).toContain('The copy editor did not start')
  expect(r.text).toContain('exited 128')
  expect(r.text).toContain('bad revision')
})

// Each reviewer is restarted by itself, and its answer does not depend on one write.
const EDITING = { state: 'reviewing', prs: [12] }
const live = (id: string, status = 'running') => ({ id, type: 't', description: 'd', status })

test('a resume starts only the copy editor when only its answer was lost', async ($, on) => {
  const w = engine(on, { names: PROSE, wf: { ...EDITING, hooks: { review: { firedAt: 1, agentId: 'r-1', answer: 'code is fine' } }, reviewCopy: { agentId: 'gone' } } as never })
  await start($, w)
  const said = (await tool($, 'started', { issue: 7 })).text
  expect(w.spawns.map(s => s.subagentType)).toEqual(['ndev:copy-editor'])
  expect(said).toContain('code is fine')
})

test('a resume starts only the code review when the copy editor still runs', async ($, on) => {
  const w = engine(on, { names: PROSE, wf: { ...EDITING, hooks: { review: { firedAt: 1, agentId: 'gone' } }, reviewCopy: { agentId: 'copy-1' } } as never })
  w.s.agents = [live('copy-1')] as never
  await start($, w)
  const said = (await tool($, 'started', { issue: 7 })).text
  expect(w.spawns.map(s => s.subagentType)).toEqual(['ndev:diff-reviewer'])
  expect(w.state()?.reviewCopy?.agentId).toBe('copy-1')
  expect(said).toContain('copy-1')
})

test('a resume takes a reviewer that has ended, with no answer, as lost', async ($, on) => {
  const w = engine(on, { wf: { ...EDITING, hooks: { review: { firedAt: 1, agentId: 'r-1' } } } as never })
  w.s.agents = [live('r-1', 'completed')] as never
  await start($, w)
  await tool($, 'started', { issue: 7 })
  expect(w.spawns.map(s => s.subagentType)).toEqual(['ndev:diff-reviewer'])
})

test('a copy editor that did not start stays on the record, and a resume tries it again', async ($, on) => {
  const w = engine(on, { names: PROSE })
  w.s.spawnDeny = 'no such agent'
  await toReview($, w)
  expect((w.state()?.reviewCopy as { failed?: string }).failed).toContain('no such agent')
  const tries = w.spawns.filter(s => s.subagentType === 'ndev:copy-editor').length
  w.s.spawnDeny = ''
  await tool($, 'started', { issue: 7 })
  expect(w.spawns.filter(s => s.subagentType === 'ndev:copy-editor').length).toBe(tries + 1)
  expect((w.state()?.reviewCopy as { failed?: string }).failed).toBeUndefined()
})

test('an answer survives a stale write', async ($, on) => {
  const w = engine(on, { wf: { ...EDITING, hooks: { review: { firedAt: 1, agentId: 'r-1' } }, reviewCopy: { agentId: 'copy-1' } } as never })
  await start($, w)
  w.s.staleSaves = 1
  await $.turn.complete({ agentId: 'copy-1', answer: 'VALE: ran, 0 alerts\nFINDINGS: 1\nA slogan.' } as never)
  await settle()
  expect(w.state()?.reviewCopy?.answer).toContain('A slogan')
  expect(w.prompts.join('\n')).toContain('A slogan')
})

test('an answer that cannot be saved still reaches the main agent, which is told', async ($, on) => {
  const w = engine(on, { wf: { ...EDITING, hooks: { review: { firedAt: 1, agentId: 'r-1' } } } as never })
  await start($, w)
  w.s.staleSaves = 99
  await $.turn.complete({ agentId: 'r-1', answer: 'A real fault.' } as never)
  await settle()
  w.s.staleSaves = 0
  const told = w.prompts.join('\n')
  expect(told).toContain('A real fault.')
  expect(told).toContain('was not saved')
  expect(told).toContain('exited 5')
})

for (const [name, ending] of [['an empty answer', { answer: '  ' }], ['an error', { reason: 'error', answer: 'part of a rep' }]] as const) {
  test(`a reviewer that ends with ${name} is named as a failure, and does not count as an answer`, async ($, on) => {
    const w = engine(on, { wf: { ...EDITING, hooks: { review: { firedAt: 1, agentId: 'r-1' } }, reviewCopy: { agentId: 'copy-1' } } as never })
    await start($, w)
    await $.turn.complete({ agentId: 'copy-1', ...ending } as never)
    await settle()
    expect(w.state()?.reviewCopy?.answer).toBeUndefined()
    const told = w.prompts.join('\n')
    expect(told).toContain('The copy editor')
    expect(told).toContain('failed')
    expect(told).toContain('ndev:copy-editor')
  })
}
