// The shared harness of the workflow tests (tests/workflow-*.test.ts): the fake engine, the helpers and the
// fixtures. It is not a test file, so the runner does not run it. A test file imports what it uses from here.
import { expect, test } from 'claude-code/testing'
import type { WorkflowLive } from '../types'

export type Body = Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>
export type On = Parameters<Body>[1]
export type Dollar = Parameters<Body>[0]

export const ROOT = '/proj'
export const RECORD = `${ROOT}/.neil-dev.worktree.json`
export const CONFIG = `${ROOT}/.neil-dev.json`
export const REPO = 'acme/w'
export const SHA = 'aaaaaaaa11111111'
export const STREAM_CAP = 4194304 // What $.process.run keeps of each stream, and the most $.fs.write takes.
// Blocks the event loop just after a mocked $ call resolves, so the time falls to the hook that made the call.
export const spinAfter = (ms: number) => setTimeout(() => { const end = Date.now() + ms; while (Date.now() < end) { /* the hook's own time */ } }, 0)
export const ok = (stdout = '', exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })

export const flow = (over: Record<string, unknown> = {}) => ({
  rev: 1, issue: 7, root: ROOT, repo: REPO, base: 'main', branch: 'issue-7', prs: [12], state: 'developing',
  evidence: {}, attempts: 0, nudges: { count: 0 }, followUps: [], migrations: [], history: [], owner: { session: 's1', at: 0 }, baseCheck: { sha: SHA, script: 'pre-commit-check.sh', exitCode: 0, at: 0 }, ...over,
})
// A record past development sits under prs, as the merge point leaves it, and its issue waits as developed.
export const PR_STAGES = ['reviewing', 'ci', 'smoke', 'finishing', 'revising', 'done']
export const onPr = (r: Record<string, unknown>) => !r.direct && !r.pr && (r.prs as number[] | undefined)?.[0] !== undefined && (PR_STAGES.includes(r.state as string) || (['blocked', 'wait'].includes(r.state as string) && PR_STAGES.includes(r.previous as string)))
export const held = (...records: Record<string, unknown>[]) => {
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
// The state of a worktree as a reader sees it: the old keys of the worktree file, and over them the issue files.
export const heldOn = (files: Map<string, string> | undefined, root = ROOT) => {
  const file = JSON.parse(files?.get(`${root}/.neil-dev.worktree.json`) ?? '{}') as { workflows?: Record<string, unknown>; prs?: Record<string, unknown> }
  const workflows = { ...file.workflows }
  const prs = { ...file.prs }
  for (const [path, body] of files ?? []) {
    if (!new RegExp(`^${root}/\\.neil-dev\\.issue-\\d+\\.json$`).test(path)) continue
    const held = JSON.parse(body) as { issue: number; workflow?: unknown; prs?: Record<string, unknown> }
    if (held.workflow) workflows[held.issue] = held.workflow
    Object.assign(prs, held.prs)
  }
  return { workflows, prs }
}
export const pull = (over: Record<string, unknown> = {}) => ({
  number: 12, state: 'open', merged: false, draft: false, mergeable: true, mergeable_state: 'clean',
  body: 'Closes #7', created_at: '2026-11-01T00:00:00Z', head: { sha: SHA, ref: 'issue-7' }, ...over,
})
export const CHECKS = (...runs: { name: string; status?: string; conclusion: string | null; started_at?: string }[]) => ({ check_runs: runs.map(r => ({ status: 'completed', ...r })) })

export type Opts = {
  refuseCommand?: RegExp; wf?: Record<string, unknown> | null; config?: Record<string, unknown>; pr?: Record<string, unknown>; checks?: unknown; scripts?: boolean; skillFiles?: boolean; files?: Record<string, string>; guide?: boolean; main?: boolean; names?: string[] }

// A fake engine: a linked worktree at /proj, a simulated git and a simulated GitHub. Only the
// process and file boundaries are fake: the plugin's tools, machine and watchdog all really run.
export let registeredTools: unknown[] = []
export let onIssue = 7
export const engine = (on: On, opts: Opts = {}) => {
  const files = new Map<string, string>(Object.entries({
    [`${ROOT}/.ndev-inited`]: '',
    [CONFIG]: JSON.stringify({ github: { repo: REPO, board: null }, mode: 'light', steering: 'auto', ...opts.config }),
    ...(opts.wf === null ? {} : { [RECORD]: held(flow(opts.wf ?? {})) }),
    ...opts.files,
  }))
  const s = {
    spawnedAtSweep: -1, ahead: undefined as string | undefined, claimFails: '', boardFails: '', boardCards: [{ number: 7, itemId: 'I7' }] as { number: number; itemId: string }[], sweepExit: 0, sweepOutput: 'base 2, head 2', stopFails: '', now: 0, sha: SHA, upstream: SHA, dirty: [] as string[], untracked: [] as string[], staged: false, failCheck: '', hugeCheck: '', hugeExit: 0, scripts: opts.scripts ?? true, agents: [] as { id: string; status: string }[],
    otherWorktrees: [] as string[], worktreeListFails: '', checkHold: undefined as Promise<void> | undefined, checkMs: {} as Record<string, number>, checkStops: [] as string[],
    prReadsFor: undefined as Record<number, unknown[]> | undefined, issueReadsFor: undefined as Record<number, unknown[]> | undefined,
    main: opts.main ?? false, claims: [] as string[], names: opts.names ?? ['a.ts'], copyDiffFails: '', draft: '', ghFails: '', orcaOn: false, env: {} as Record<string, string>, orcaFails: '', issueAnswer: undefined as string | undefined, modelFails: false, spawnDeny: '', sleepHold: undefined as Promise<void> | undefined, resumed: false, orcaLinked: null as number | null, branch: undefined as string | undefined, pr: pull(opts.pr), checks: (opts.checks ?? CHECKS({ name: 'ci', conclusion: 'success' })) as unknown,
    probeLimits: [] as (number | undefined)[], issueReadMs: 0, editFails: '', rmFails: '', failRead: undefined as ((path: string) => boolean) | undefined, sleepYields: false, sleepSpinMs: 0, clockSleeps: 0, staleSaves: 0, saves: 0, failWrite: undefined as ((path: string) => boolean) | undefined, sleepAdvances: false, sleepDrift: [] as number[], sleepAborts: 0, sleepFails: '', immediate: [] as string[], probe: undefined as ((argv: string[]) => Promise<{ exitCode: number; stdout?: string; stderr?: string }> | { exitCode: number; stdout?: string; stderr?: string }) | undefined, probes: [] as string[],
    duringDiff: undefined as (() => Promise<unknown>) | undefined, duringTurnEnd: undefined as (() => Promise<unknown>) | undefined, diffFails: '', orcaGone: false, orcaReachable: true, pageUrl: undefined as string | undefined, pageWidth: undefined as number | undefined, viewportWidth: 0, viewportHeight: 0, pageHeight: undefined as number | undefined, stuckAt: undefined as number | undefined, scrollY: 0, shotsAt: [] as number[], sameImages: false, cmpFails: '', dark: false, cpFails: '',
    merging: undefined as string | undefined, unchanged: [] as string[], removed: [] as string[], renamedFrom: [] as string[], fromBase: [] as string[], checkEnv: {} as Record<string, Record<string, string> | undefined>,
    originHead: 'origin/main', githubBase: 'main', defaultBranchFails: '', branchPrs: [] as { number: number; state: string; merged: boolean }[],
    ops: new Set<string>(), pushFails: '', leaseOk: false, remoteOnly: ['cccc9'] as string[], replaced: [] as string[], leases: [] as string[], noOpenPr: false, diffText: '', commitAt: -3_600_000, commitIso: '2026-11-01T00:00:00Z', commitUnknown: false, workflowsDir: false, blobSize: '', promptFails: false, comments: [] as unknown[], commitDirs: [] as (string | undefined)[],
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
  const statuses: (string | undefined)[] = []
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
  // The turn-end handlers that run before the workflow's own (fix-all-prs, walk-doc, dead waits) run after this one.
  on('turn.complete', async () => { const hold = s.duringTurnEnd; s.duringTurnEnd = undefined; if (hold) await hold(); return { text: 'text' } as never })
  for (const name of ['Edit', 'Bash'] as const) on('tool.call', { tool: name }, () => ({ result: 'ok' }) as never)
  on('prompt.compose', () => ({ sections: [] }))
  on('prompt.read', () => ({ value: { text: s.draft, cursor: 0 } }))
  on('prompt.submit', (_, e) => { if (s.promptFails) throw new Error('refused by the host'); prompts.push(e.text); return { text: e.text } })
  on('agent.list', () => ({ value: s.agents }) as never)
  on('env.get', (_, e) => ({ value: s.env[e.name] ?? (e.name === 'HOME' ? '/home/neil' : e.name === 'ORCA_WORKSPACE_ID' && s.orcaOn ? 'workspace-1' : undefined) }) as never)
  const guide = (path: string) => {
    if (path.endsWith('/kb/workflow.md')) return opts.guide !== false ? '# The guide' : undefined
    const skill = /\/skills\/(work-light|work-heavy)\/SKILL\.md$/.exec(path)
    if (skill && opts.skillFiles !== false) return `---\nname: ${skill[1]}\ndescription: "the listing"\n---\n\n# The ${skill[1]} method\n\nRun \`\${CLAUDE_PLUGIN_ROOT}/scripts/x.sh\`.\n`
    for (const name of ['kb/ui-components.md', 'kb/libraries.md', 'skills/motion/SKILL.md', 'skills/motion/references/delight.md']) if (path.endsWith(`/${name}`)) return `SOURCE ${name}`
    return undefined
  }
  const isFolder = (path: string) => [...files.keys()].some(k => k.startsWith(`${path}/`))
  on('fs.exists', (_, e) => ({ value: e.path.startsWith('/home/neil/dev-wiki') || files.has(e.path) || isFolder(e.path) || guide(e.path) !== undefined }))
  on('fs.list', (_, e) => ({ value: [...files.keys()].filter(k => k.startsWith(`${e.path}/`) && !k.slice(e.path.length + 1).includes('/')).map(k => ({ name: k.slice(e.path.length + 1), kind: 'file', size: 0, isLink: false })) }) as never)
  on('fs.read', (_, e) => {
    if (s.failRead?.(e.path)) throw new Error(`no permission: ${e.path}`)
    return { value: guide(e.path) ?? files.get(e.path) ?? '' }
  })
  on('fs.write', (_, e) => {
    if (s.failWrite?.(e.path)) throw new Error(`disk full: ${e.path}`)
    const size = new TextEncoder().encode(e.text).length
    if (size > STREAM_CAP) throw new Error(`ndev: $.fs.write: ${e.path} refused: ${size} bytes is over the ${STREAM_CAP}-byte limit`)
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.notify', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.status', (_, e) => { statuses.push(e.text); return { value: undefined } })
  on('ui.log', () => ({ value: undefined }) as never)
  on('session.cwd', () => ({ value: ROOT }) as never)
  let refReads = 0
  // What a check script answers: held while checkHold holds, failed for failCheck, cut for hugeCheck.
  type Answer = { value: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean } }
  const checkAnswer = async (script: string): Promise<Answer> => {
    if (s.hugeCheck && script.includes(s.hugeCheck)) return { value: { exitCode: s.hugeExit, stdout: `${'x'.repeat(STREAM_CAP - 5)}\nlast`, stderr: '', isStdoutTruncated: true, isStderrTruncated: false } }
    if (s.checkHold) await s.checkHold
    return s.failCheck && script.includes(s.failCheck) ? ok('lint: broken line', 3) : ok('passed')
  }
  const checkRuns = new Map<string, { at: number; ms: number; answer: Promise<Answer>; done?: Answer['value'] }>()
  on('process.run', (_, e) => {
    const a = e.argv.map(String)
    const line = a.join(' ')
    // The host refuses a timeout that is not a whole number of ms, as $.process.run does in a session.
    const limit = e.init?.timeoutMs
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 600_000)) throw new Error('ndev: process.run: init.timeoutMs is a whole number of ms, 1 to 600000 (host check)')
    if (a[0] === 'rm' && s.rmFails) return ok('', 1, s.rmFails)
    if (a[0] === 'rm') { files.delete(a.at(-1)!); return ok() }
    // The host aborts a pause that outran its limit, as when the computer slept through it: the time has
    // passed, and the call rejects. A hook that throws is skipped, so the call rejects as no implementation.
    if (a[0] === 'sleep' && s.sleepAborts > 0) { s.sleepAborts -= 1; s.now += limit ?? 0; throw new Error(`ndev: $.process.run(sleep) aborted: still running after ${limit}ms`) }
    if (a[0] === 'sleep' && s.sleepFails) throw new Error(s.sleepFails)
    // A pause of 0.2 s is a call that waits for its turn (whenTurnsFree). A real sleep lets the call that has the
    // turn go on, so this one yields too: a loop of pauses that resolve at once would hold the event loop.
    if (a[0] === 'sleep') return (async () => { if (s.sleepYields || a[1] === '0.2') await new Promise(r => setTimeout(r, 1)); await s.sleepHold; if (s.sleepAdvances) s.now += Number(a[1]) * 1000 + (s.sleepDrift.shift() ?? 0); if (s.sleepSpinMs) spinAfter(s.sleepSpinMs); return ok() })() as never
    if (s.probe && (a[0] === 'curl' || a[0] === 'ps' || (a[0] === 'bash' && a[1] === '-c'))) {
      s.probes.push(line)
      s.probeLimits.push(e.init?.timeoutMs)
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
      // As real git does: with MERGE_HEAD named, the base of the hypothetical merge of HEAD and MERGE_HEAD.
      if (a[1] === 'diff' && line.includes('--cached --name-only --no-renames') && s.diffFails) return ok('', 128, s.diffFails)
      if (a[1] === 'merge-base') return a.includes('--is-ancestor') ? ok() : ok(`${a.includes('MERGE_HEAD') && s.merging ? NEW_BASE : OLD_BASE}\n`)
      if (a[1] === 'rev-parse' && a.includes('MERGE_HEAD')) return s.merging ? ok(`${s.merging}\n`) : ok('', 1)
      if (a[1] === 'fetch') return ok()
      if (line.includes('--abbrev-ref')) return ok(`${s.branch ?? 'issue-7'}\n`)
      if (a[1] === 'rev-parse' && a[2] === 'HEAD') return ok(`${s.sha}\n`)
      if (a[1] === 'rev-parse' && a[2]?.startsWith('origin/')) return ok(`${s.upstream}\n`)
      // As real git does: the commits of the remote branch that HEAD and every other remote ref lack.
      if (a[1] === 'rev-list' && a.some(x => x.startsWith('--remotes'))) return ok(s.remoteOnly.map(c => `${c}\n`).join(''))
      // As real git does: git cherry HEAD origin/<branch> marks with - each remote commit whose change HEAD holds.
      if (a[1] === 'cherry') return ok(s.remoteOnly.map(c => `${s.replaced.includes(c) ? '-' : '+'} ${c}\n`).join(''))
      if (a[1] === 'log' && line.includes('--no-walk')) return ok(s.remoteOnly.filter(c => a.includes(c)).map(c => `${c} subject of ${c}\n`).join(''))
      if (a[1] === 'rev-list' && s.ahead !== undefined) return ok(`${s.ahead}\n`)
      if (a[1] === 'rev-parse') return ok(`${ROOT}\n`)
      // As real git does: a folder of untracked files is one line, unless the call asks for all of them.
      if (a[1] === 'status') return ok([...s.dirty, ...(s.untracked.length ? (a.includes('--untracked-files=all') ? s.untracked.map(f => `?? ${f}`) : [`?? ${s.untracked[0]!.replace(/[^/]+$/, '')}`]) : [])].join('\n'))
      if (a[1] === 'remote') return ok(`git@github.com:${REPO}.git\n`)
      if (a[1] === 'symbolic-ref') return ok(`${s.originHead}\n`)
      if (a[1] === 'log' && line.includes('--grep=')) return ok([...s.ops].some(op => line.includes(`Ndev-Op: ${op}$`)) ? `${s.sha}\n` : '')
      if (a[1] === 'log' && line.includes('%ct')) return ok(`${s.commitAt / 1000}\n`)
      if (a[1] === 'log' && line.includes('%cI')) return s.commitUnknown ? ok('', 128, `fatal: bad object ${a.at(-1)}`) : ok(`${s.commitIso}\n`)
      if (a[1] === 'log') return ok('')
      if (a[1] === 'ls-tree') return ok(s.workflowsDir ? 'tree .github/workflows\n' : '')
      if (a[1] === 'ls-files') return ok(line.includes('*.py') ? s.names.filter(n => n.endsWith('.py')).join('\n') : '')
      if (a[1] === 'reset') { s.staged = false; steps.push('reset'); return ok() }
      if (a[1] === 'stash') return ok('')
      if (a[1] === 'check-ignore') return ok('x\n')
      if (a[1] === 'cat-file') return s.blobSize ? ok(`${s.blobSize}\n`) : ok('', 1)
      if (a[1] === 'worktree') return s.worktreeListFails ? ok('', 128, s.worktreeListFails) : ok([ROOT, ...s.otherWorktrees].map(path => `worktree ${path}\n`).join(''))
      // As real git does: git add of a file that equals its HEAD version stages nothing.
      if (a[1] === 'add' && a.slice(a.indexOf('--') + 1).every(f => s.unchanged.includes(f))) return ok()
      // As real git does: a path whose deletion is already staged is in neither the tree nor the index, so no pathspec matches it.
      if (a[1] === 'add') { const gone = a.slice(a.indexOf('--') + 1).find(f => s.removed.includes(f) || s.renamedFrom.includes(f)); if (gone) return ok('', 128, `fatal: pathspec '${gone}' did not match any files`); s.staged = true; return ok() }
      if (s.copyDiffFails && line.includes('--name-only --diff-filter=d origin/')) return ok('', 128, s.copyDiffFails)
      // As real git does: rename detection lists the old path of a staged rename as R, and only --no-renames lists it as D.
      if (a[1] === 'diff' && line.includes('--cached --name-only') && line.includes('--diff-filter=D')) return ok([...s.removed, ...(a.includes('--no-renames') ? s.renamedFrom : [])].map(f => `${f}\n`).join(''))
      // As real git does: the staged files that differ from MERGE_HEAD, so not those that the base brought in unchanged.
      if (a[1] === 'diff' && line.includes('--cached --name-only --diff-filter=d MERGE_HEAD')) return ok(s.names.filter(f => !s.fromBase.includes(f)).map(f => `${f}\n`).join(''))
      if (a[1] === 'diff' && line.includes('--name-only')) return s.diffFails && line.includes('...') ? ok('', 128, s.diffFails) : ok(`${s.names.join('\n')}\n`)
      if (a[1] === 'diff' && a[2] === 'HEAD' && s.duringDiff) { const hold = s.duringDiff; s.duringDiff = undefined; return hold().then(() => ok(s.diffText)) as never }
      if (a[1] === 'diff' && a[2] === 'HEAD') return ok(s.diffText)
      if (a[1] === 'diff') return ok('', s.staged ? 1 : 0)
      if (a[1] === 'commit') { s.commitDirs.push(e.init?.cwd); const op = /Ndev-Op: (\S+)/.exec(line)?.[1]; if (op) s.ops.add(op); steps.push('commit'); commits.push(line); s.staged = false; s.sha = `bbbb${commits.length}`; return ok() }
      if (a[1] === 'push' && line.includes('--force-with-lease')) s.leases.push(line)
      if (a[1] === 'push' && s.pushFails && !(s.leaseOk && line.includes('--force-with-lease'))) return ok('', 1, s.pushFails)
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
        const root = a[a.indexOf('--worktree') + 1]!
        const record = `${root}/.neil-dev.worktree.json`
        type Saved = { issue: number; pr?: number; rev?: number }
        const onFile = JSON.parse(files.get(record) ?? '{}') as { workflow?: Saved; workflows?: Record<string, Saved>; prs?: Record<string, Saved>; leads?: Record<string, number>; settings?: unknown; resources?: unknown }
        const issueAt = (n: number) => `${root}/.neil-dev.issue-${n}.json`
        const inFile = (n: number) => JSON.parse(files.get(issueAt(n)) ?? `{"version":1,"issue":${n}}`) as { version: number; issue: number; workflow?: Saved; prs?: Record<string, Saved> }
        const leads = { ...onFile.leads }
        const written = JSON.parse(String(e.init?.stdin)) as Saved
        // The old keys move at the first write, and what an issue file holds stays.
        const oldIssues = { ...(onFile.workflow ? { [onFile.workflow.issue]: onFile.workflow } : {}), ...onFile.workflows }
        const oldPrs = { ...onFile.prs }
        for (const old of Object.values(oldIssues)) files.set(issueAt(old.issue), JSON.stringify({ ...inFile(old.issue), workflow: inFile(old.issue).workflow ?? old }))
        for (const [n, old] of Object.entries(oldPrs)) {
          leads[n] ??= old.issue
          const at = inFile(leads[n]!)
          files.set(issueAt(leads[n]!), JSON.stringify({ ...at, prs: { [n]: old, ...at.prs } }))
        }
        if (written.pr) leads[written.pr] ??= written.issue
        const moved = Object.keys(oldIssues).length + Object.keys(oldPrs).length > 0
        if (moved || JSON.stringify(leads) !== JSON.stringify(onFile.leads ?? {})) files.set(record, JSON.stringify({ version: 2, settings: onFile.settings, resources: onFile.resources ?? {}, leads }))
        const lead = written.pr ? leads[written.pr]! : written.issue
        const held = inFile(lead)
        const was = (written.pr ? held.prs?.[written.pr]?.rev : held.workflow?.rev) ?? 0
        const rev = Number(a[a.indexOf('--expect-rev') + 1]) + 1
        if (was !== rev - 1) return ok('', 5, `the workflow of ${written.pr ? `PR #${written.pr}` : `#${written.issue}`} is at revision ${was}, and this writer expected ${rev - 1}`)
        files.set(issueAt(lead), JSON.stringify(written.pr ? { ...held, prs: { ...held.prs, [written.pr]: { ...written, rev } } } : { ...held, workflow: { ...written, rev } }))
        return ok(`${rev}\n`)
      }
      if (a[2] === 'set-interview') {
        const written = JSON.parse(String(e.init?.stdin)) as { issue: number }
        const at = `${a[a.indexOf('--worktree') + 1]}/.neil-dev.issue-${written.issue}.json`
        if (s.failWrite?.(at)) return ok('', 2, `disk full: ${at}`)
        const held = JSON.parse(files.get(at) ?? '{}') as { workflow?: unknown; prs?: unknown }
        files.set(at, JSON.stringify({ ...written, ...(held.workflow ? { workflow: held.workflow } : {}), ...(held.prs ? { prs: held.prs } : {}) }))
        return ok()
      }
      if (a[2] === 'stop-all') {
        steps.push(`worktree-env.sh ${a.slice(2).join(' ')}`)
        if (s.stopFails) return ok('', 1, s.stopFails)
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
      if (a[2] === 'issue-read') s.now += Math.min(s.issueReadMs, e.init?.timeoutMs ?? Infinity)
      const scripted = (a[2] === 'pr-read' ? s.prReadsFor : a[2] === 'issue-read' ? s.issueReadsFor : undefined)?.[Number(a[3])]?.shift()
      if (typeof scripted === 'string') return ok('', 1, scripted)
      if (scripted) return ok(JSON.stringify(scripted))
      if (a[2] === 'pr-read') return ok(JSON.stringify(s.pr))
      if (a[2] === 'issue-read') return ok(JSON.stringify({ state: 'open', title: 'T' }))
      if (a[2] === 'issue-new') return ok('{"number":31}\n')
      if (a[2] === 'default-branch') return s.defaultBranchFails ? ok('', 1, s.defaultBranchFails) : ok(JSON.stringify({ default_branch: s.githubBase }))
      if (a[2] === 'pr-list' && line.includes('--state all')) return ok(s.branchPrs.map(p => JSON.stringify(p)).join('\n'))
      if (a[2] === 'pr-list') return ok(s.noOpenPr ? '' : '{"number":12}\n')
      if (a[2] === 'pr-new') return ok(`https://github.com/${REPO}/pull/13\n`)
      if (a[2] === 'pr-edit') return ok('')
      if (a[2] === 'subissues') return s.linkFails ? ok('', 1, s.linkFails) : ok('')
      if (a[2] === 'commit-checks') return ok(JSON.stringify({ statuses: [], ...(s.checks as object) }))
      if (a[2] === 'feedback') return ok((s.comments as unknown[]).map(c => JSON.stringify(c)).join('\n'))
      if (a[2] === 'pr-ready') { ready.push(line); s.pr = { ...s.pr, draft: false }; return ok() }
      if (a[2] === 'comment') return ok(`https://github.com/o/r/issues/${a[3]}#issuecomment-${1000 + Number(a[3])}\n`)
      if (a[2] === 'comment-edit' && s.editFails) return ok('', 1, s.editFails)
      if (a[2] === 'comment-edit') return ok('https://github.com/o/r/issues/7#issuecomment-1\n')
      if (a[2] === 'pr-review' || a[2] === 'label') return ok()
      return ok('', 1, `gh.sh not faked: ${line}`)
    }
    if (a[0] === 'bash' && a[1]?.endsWith('merge.sh')) {
      merges.push(a[2] as string)
      return ok(JSON.stringify({ pr: 12, merged: true }))
    }
    if (a[0] === 'bash' && a[1]?.endsWith('init-worktree-submodules.sh')) {
      submodules.push({ command: JSON.parse(String(e.init?.stdin)).tool_input.command, paths: e.init?.env?.WORKTREE_SUBMODULES })
    }
    if (a[0] === 'bash' && a[1]?.endsWith('worktree_claim.sh')) s.claims.push(a.slice(2).join(' '))
    if (a[0] === 'bash' && a[1]?.endsWith('worktree_claim.sh')) return s.claimFails ? ok('', 1, s.claimFails) : ok('/claimed/issue-7\n')
    if (a[0] === 'bash' && a[1]?.endsWith('board.sh')) {
      steps.push(`board.sh ${a.slice(2).join(' ')}`)
      if (s.boardFails) return ok('', 1, s.boardFails)
      if (a[2] === 'items') return ok(s.boardCards.map(c => JSON.stringify(c)).join('\n'))
      return ok()
    }
    if (a[0] === 'bash' && (a[1]?.endsWith('/sweep.sh') || a[1]?.endsWith('/sweep-ts.sh'))) {
      steps.push(`${a[1].split('/').pop()} ${a.slice(2).join(' ')}`)
      s.spawnedAtSweep = spawns.length
      return ok(s.sweepOutput, s.sweepExit)
    }
    // run-check.sh starts a check detached and waits for it in parts, each shorter than the host's limit.
    if (a[0] === 'bash' && a[1]?.endsWith('/run-check.sh')) {
      const [sub, dir] = [a[2], a[3]!]
      if (sub === 'start') {
        const script = a[4]!
        steps.push(`${script.split('/').pop()}${a.length > 5 ? ` ${a.slice(5).join(' ')}` : ''}`)
        s.checkEnv[script.split('/').pop()!.replace(/^ndev-/, '')] = e.init?.env
        const ms = Object.entries(s.checkMs).find(([name]) => script.includes(name))?.[1] ?? 0
        checkRuns.set(dir, { at: s.now, ms, answer: checkAnswer(script) })
        return ok('4242\n')
      }
      if (sub === 'stop') { s.checkStops.push(a[3]!); return ok() }
      const one = checkRuns.get(dir)
      if (!one) return ok('', 2, `run-check.sh: no run in ${dir}`)
      if (sub === 'wait') {
        const left = one.at + one.ms - s.now
        if (left > Number(a[5]) * 1000) { s.now += Number(a[5]) * 1000; return ok('', 124) }
        s.now += Math.max(0, left)
        return (async () => { one.done = (await one.answer).value; return ok(`${one.done.exitCode}\n`) })() as never
      }
      if (sub === 'out' || sub === 'err') {
        const d = one.done ?? { stdout: 'partial', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
        return { value: { exitCode: 0, stdout: sub === 'out' ? d.stdout : d.stderr, stderr: '', isStdoutTruncated: sub === 'out' ? d.isStdoutTruncated : d.isStderrTruncated, isStderrTruncated: false } }
      }
    }
    if (a[0] === 'bash' && a[1]?.includes('.sh')) {
      steps.push(`${a[1].split('/').pop()}${a.length > 2 ? ` ${a.slice(2).join(' ')}` : ''}`)
      s.checkEnv[a[1].split('/').pop()!.replace(/^ndev-/, '')] = e.init?.env
      // A check that runs for a time on the clock. The host stops a run that outlasts its limit, and the call rejects.
      const ms = Object.entries(s.checkMs).find(([name]) => a[1]!.includes(name))?.[1]
      if (ms !== undefined && limit !== undefined && ms > limit) { s.now += limit; throw new Error(`ndev: $.process.run(bash) aborted: still running after ${limit}ms`) }
      if (ms !== undefined) s.now += ms
      return checkAnswer(a[1]) as never
    }
    if (a[0] === 'mkdir') return ok()
    if (a[0] === 'cmp') { if (s.cmpFails) return ok('', 2, s.cmpFails); return ok('', s.sameImages ? 0 : 1) }
    if (a[0] === 'cp') { if (s.cpFails) return ok('', 1, s.cpFails); copies.push(a.at(-1) as string); return ok() }
    if (a[0] === 'orca') {
      if (s.orcaGone) throw new Error('spawn orca ENOENT')
      orcaCalls.push(a.slice(1) as string[])
      // The answers of the browser commands, as Orca 1.4.247 gives them.
      const answer = (result: unknown) => ok(JSON.stringify({ ok: true, result }))
      if (a[1] === 'status') return answer({ runtime: { reachable: s.orcaReachable } })
      if (a[1] === 'tab' && a[2] === 'create') { if (s.orcaFails) return ok(JSON.stringify({ ok: false, error: { code: 'browser_host_unavailable', message: s.orcaFails } }), 1); s.pageUrl ??= a[a.indexOf('--url') + 1]; return answer({ browserPageId: 'page-1' }) }
      if (a[1] === 'viewport') { s.viewportWidth = Number(a[a.indexOf('--width') + 1]); s.viewportHeight = Number(a[a.indexOf('--height') + 1]); return answer({}) }
      if (a[1] === 'exec') { s.dark = a.join(' ').includes('set media dark'); return answer({ set: true }) }
      if (a[1] === 'eval') {
        const expression = a[a.indexOf('--expression') + 1] as string
        if (expression.includes('scrollTo')) {
          const total = s.pageHeight ?? s.viewportHeight
          s.scrollY = Math.min(Number(/top:\s*(\d+)/.exec(expression)![1]), total - s.viewportHeight, s.stuckAt ?? Infinity)
          return answer({ result: JSON.stringify([s.scrollY, s.viewportHeight, total]) })
        }
        return answer({ result: expression.includes('innerWidth') ? String(s.pageWidth ?? s.viewportWidth) : expression.includes('location') ? s.pageUrl : String(s.dark) })
      }
      if (a[1] === 'screenshot' || a[1] === 'full-screenshot') s.shotsAt.push(s.scrollY)
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
  const onRecord = () => heldOn(files) as { workflows?: Record<string, Held>; prs?: Record<string, Held> }
  const prRecord = (n: number) => onRecord().prs?.[n]
  const issueRecord = (n: number) => onRecord().workflows?.[n]
  // The record that acts for this issue now: its PR record, once the PR is past its developers.
  const state = (issue = 7) => {
    const own = issueRecord(issue)
    const carrier = own?.state === 'developed' ? prRecord(own.prs[0]!) : undefined
    return carrier && carrier.state !== 'developing' ? carrier : own
  }
  liveFiles = files
  return { commandNames, s, spawns, modelCalls, issueAsks, fills, orcaCalls, copies, gh, ready, prompts, toasts, compacts, pushes, commits, alerts, merges, steps, submodules, files, state, prRecord, issueRecord, timers, statuses }
}
export type W = ReturnType<typeof engine>

// The fix-all-prs feature has its own timer, which idle() also fires, and this one read. hooks/workflow never makes it.
export const isFixAllPrsRead = (line: string) => /^bash \S*\/scripts\/github\/gh\.sh repo-read$/.test(line)
export const pendingAfters: (() => void)[] = []
export const settle = () => new Promise(resolve => setTimeout(resolve, 30))
export const start = async ($: Dollar, w?: W) => {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: false })
  await settle()
  if (w) w.gh.length = 0 // fix-all-prs reads the repository at the start of a session; that is not the workflow.
}
// Each state tool names its issue. A test names it only when the issue is the point of the test.
export const STATE_TOOLS = ['interview', 'setSteering', 'finishedPlan', 'finishedInterview', 'finishedHacking', 'checkpoint', 'finishedDevelopment', 'finishedReview', 'finishedChecks', 'finishedSmoke', 'finishedRevision', 'blocked', 'unblocked', 'done', 'followUp', 'addMigration', 'waitForSubAgent', 'waitForURL', 'waitForProcessEnd', 'waitForSeconds', 'waitFor', 'waitForPR', 'waitForIssue', 'waitForState']
export let liveFiles: Map<string, string> | undefined
// A test names its target only when the target is the point of the test: the issue, or its PR once it has moved on.
export function callFor(name: string): Record<string, unknown> {
  if (name === 'finishedDevelopment') return { issues: [onIssue] }
  if (name === 'waitForPR') return { issue: onIssue }
  const onFile = heldOn(liveFiles) as { workflows?: Record<string, { state: string; prs: number[] }>; prs?: Record<string, { state: string }> }
  const own = onFile.workflows?.[onIssue]
  const n = own?.state === 'developed' ? own.prs[0] : undefined
  return n !== undefined && onFile.prs?.[n] && onFile.prs[n]!.state !== 'developing' ? { pr: n } : { issue: onIssue }
}
export const tool = async ($: Dollar, name: string, args: Record<string, unknown> = {}) => {
  const named = STATE_TOOLS.includes(name) && !('issue' in args) && (name === 'waitForPR' || !('pr' in args)) ? { ...callFor(name), ...args } : args
  const r = await $.tool.call({ tool: `mcp__ndev__${name}`, ...named } as never) as { result: string; isError?: boolean }
  if (name === 'started' && !r.isError) onIssue = Number(args.issue)
  return { text: String(r.result), isError: !!r.isError }
}
export const command = async ($: Dollar, args: string) => {
  const out = String(((await $.command.run({ command: 'flow', args } as never)) as { text: string }).text)
  pendingAfters.splice(0).forEach(fire => fire()) // A command tells the agent just after its hook returns.
  await settle()
  return out
}
export const turnEnds = async ($: Dollar, reason = 'answer') => {
  await $.turn.complete({ reason, answer: 'text', durationMs: 1, isAborted: reason === 'aborted', turnId: 't1' } as never)
  await settle()
}
// One idle period passes, and the watchdog's timer fires.
export const idle = async (w: W) => {
  w.s.now += 21 * 60_000
  w.timers.splice(0).forEach(fire => fire())
  await settle()
}

// ---- done ----
export const finishing = (over: Record<string, unknown> = {}) => ({ state: 'finishing', evidence: { checks: { sha: SHA, text: 'green' } }, ...over })

// An issue that another change already fixed: closed on GitHub, no diff on the branch, its draft PR closed.
export const alreadyFixed = (w: W) => { w.s.issueReadsFor = { 7: [{ state: 'closed', title: 'T' }] } }

// ---- the workflow watches the checks, so the agent starts no wait of its own ----
// One check period passes, and the watchdog's timer fires.
export const poll = async (w: W, ms = 4 * 60_000) => {
  w.s.now += ms
  w.timers.splice(0).forEach(fire => fire())
  await settle()
}
export const RUNNING = CHECKS({ name: 'unit tests', status: 'in_progress', conclusion: null })

// ---- Orca: the workspace shows the workflow ----
export const arg = (call: string[] | undefined, flag: string) => (call && call.includes(flag) ? call[call.indexOf(flag) + 1] : undefined)
export const inOrca = (w: W) => {
  w.s.orcaOn = true
  w.s.orcaFails = ''
}

// ---- followUp with the mode worktree ----
export const workerStarts = (w: W) => w.orcaCalls.filter(c => c[0] === 'orchestration' && c[1] === 'worker-start')
export const onDeveloping = async ($: Dollar, on: On) => {
  const w = engine(on, { wf: { state: 'developing', shortName: 'add-sub' } })
  inOrca(w)
  await start($, w)
  return w
}

// ---- a follow-up agent works in its own worktree ----
export const CLAIMED = '/claimed/issue-7'
export const AGENT = { agentId: 'agent-31', worktree: CLAIMED }
export const startFollowUp = async ($: Dollar, w: W) => {
  await start($, w)
  const r = await tool($, 'followUp', { mode: 'subagent', message: 'Tidy the loader\nbody' })
  expect(r.text).toContain(CLAIMED)
}

// ---- what the workflow took over from the hooks ----
export const QUALITY = { quality: { editedFileGuards: {}, precheckReminder: {}, worktreeSubmodules: { paths: ['.claude/agents'] } } }
export const hookCall = async ($: Dollar, name: 'Edit' | 'Bash', args: Record<string, unknown>) =>
  (await $.tool.call({ tool: name, ...args } as never)) as { context?: string[] }

export const OLD_BASE = '2ce42c95'.padEnd(40, '0')
export const NEW_BASE = '13f28e82'.padEnd(40, '0')

// ---- one record per issue ----
export const bodyFile = (w: W) => [...w.files.keys()].find(k => k.endsWith('ndev-pr-body.md'))!
export const seven = (over: Record<string, unknown> = {}) => flow(over)
export const twelve = (over: Record<string, unknown> = {}) => flow({ issue: 12, shortName: 'other', ...over })

export const noChecks = { check_runs: [] }

export const remark = { id: 55, body: 'please change this', user: { login: 'human', type: 'User' }, created_at: '2026-11-02T00:00:00Z' }

// ---- a PR that a human merged while the workflow was in finishing ----
export const MERGED_PR = { state: 'closed', merged: true, mergeable: null, mergeable_state: 'unknown' }

export const unblock = async ($: Dollar, args: string) => {
  const out = String(((await $.command.run({ command: 'unblock', args } as never)) as { text: string }).text)
  pendingAfters.splice(0).forEach(fire => fire())
  await settle()
  return out
}

// What a reader sees once a wait is over: the earlier state, and no word of a wait that holds the agent.
export const expectBackIn = async ($: Dollar, w: W, state: string) => {
  expect(w.state()?.state).toBe(state)
  expect(w.state()?.waiting).toBeUndefined()
  const said = (await tool($, 'status')).text
  expect(said).toContain(`State: ${state}.`)
  expect(said).not.toContain('A wait tool holds')
}

// ---- A session with no issue asks the human ----

export const workflowSection = async ($: Dollar) => {
  const { sections } = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never)
  return sections.find((x: { id: string }) => x.id === 'ndev:workflow')?.text as string | undefined
}

export const noIssue = (on: On) => {
  const w = engine(on, { wf: null })
  w.s.branch = 'main'
  return w
}

export const talk = async ($: Dollar) => {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 15; i++) await settle() // The question comes after the dialogs before it, in a void chain.
}

// ---- A bug in the workflow goes to an agent in the plugin's own checkout ----

export const launches = (w: { orcaCalls: string[][] }) => w.orcaCalls.filter(c => c[0] === 'agent' && c[1] === 'launch')
export const promptOf = (c: string[]) => c[c.indexOf('--prompt') + 1]!

// ---- finishedDevelopment starts the code review itself ----

export const toReview = async ($: Dollar, w: ReturnType<typeof engine>) => {
  await start($, w)
  w.s.dirty = [' M a.ts']
  return tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'] })
}

export const TWO_AXES = { config: { mode: 'heavy' }, wf: { state: 'reviewing', prs: [12], hooks: { review: { firedAt: 1, agentId: 'r-1' } }, reviewSpec: { agentId: 'r-2' } } as never } as never

// ---- screenshot ----

export const orcaVerbs = (w: W) => w.orcaCalls.map(c => (c[0] === 'tab' ? `tab ${c[1]}` : c[0]))
export const SHOTS = `${ROOT}/.git/worktrees/x/ndev-screenshots/${SHA.slice(0, 8)}`

// ---- waitForState ----
export const OTHER = '/other'
export const RECORD_BASE = { root: OTHER, repo: 'o/r', base: 'main', branch: 'b', evidence: {}, attempts: 0, nudges: { count: 0 }, followUps: [], history: [] }
export const putIssue = (w: W, issue: number, record: Record<string, unknown>) => w.files.set(`${OTHER}/.neil-dev.issue-${issue}.json`, JSON.stringify({ version: 1, issue, workflow: { ...RECORD_BASE, issue, prs: [], state: 'developing', ...record } }))
export const startForState = async ($: Dollar, on: On) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  w.s.otherWorktrees = [OTHER]
  return w
}

// The merge point: from finishedDevelopment on, the PR and not one issue goes through review and CI.
export const mine = (over = {}) => ({ owner: { session: 's1', at: 0 }, ...over })

// ---- what the /view pane reads: the live file beside the record ----
export const liveFile = (w: ReturnType<typeof engine>, name: string) => {
  const entry = [...w.files.entries()].find(([path]) => path.endsWith(`/ndev-live-${name}.json`))
  return entry ? (JSON.parse(entry[1]) as WorkflowLive) : undefined
}

// ---- the copy editor beside the code review ----

export const PROSE = ['apps/docs/content/using/overview.mdx', 'README.md']
export const NOT_PROSE = ['a.ts', 'CLAUDE.md', 'AGENTS.md', 'kb/writing.md', 'skills/x/SKILL.md', 'docs/wiki/wiki.md', 'tests/fixtures/a.md', '.github/a.md']

// Each reviewer is restarted by itself, and its answer does not depend on one write.
export const EDITING = { state: 'reviewing', prs: [12] }
export const live = (id: string, status = 'running') => ({ id, type: 't', description: 'd', status })

// ---- the interview ----
export const INTERVIEW_FILE = `${ROOT}/.neil-dev.issue-7.json`
export const INTERVIEW_PANE = { plugin: 'ndev', component: 'Pane', requestId: 'interview', props: { title: 'Interview', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const
export const ROUND = {
  title: 'The login page',
  intro: 'First round.',
  questions: [
    { id: 'store', header: 'Session store', question: 'Where do **sessions** live?', context: 'They outlive a deploy.', options: [{ label: 'Redis', description: 'Fast and shared.', recommended: true }, { label: 'Cookie', preview: '`set-cookie: s=...`' }] },
    { id: 'name', header: 'Cookie name', question: 'What name?', suggested: 'sid' },
    { id: 'browsers', header: 'Browsers', question: 'Which browsers?', multiSelect: true, options: [{ label: 'Safari', recommended: true }, { label: 'Chrome', recommended: true }, { label: 'Edge' }] },
  ],
}
export const asking = (extra: Record<string, unknown> = {}) => ({ state: 'interviewing', steering: 'interactive', ...extra })
export const human = async ($: Dollar, w: W) => {
  w.s.sleepYields = true // A round's loop must leave room for the test's own timers.
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await settle()
  w.gh.length = 0
}
// The call holds until the pane ends it. The kit cannot mount while a loop spins, so the fake sleep stays
// pending while the test works the pane: tick lets one more pass of the loop run, and done ends the hold.
export const round = async ($: Dollar, w: W, json: unknown = ROUND, surface: 'terminal' | 'mobile' = 'terminal') => {
  let wake = () => {}
  const hold = () => { w.s.sleepHold = new Promise<void>(resolve => { wake = resolve }) }
  hold()
  const answer = tool($, 'interview', { interviewJson: json })
  await settle()
  const tick = async () => { const go = wake; hold(); go(); await settle() }
  const done = () => { const go = wake; w.s.sleepHold = Promise.resolve(); go(); return answer }
  return { done, tick, ui: await $.ui.mount({ ...INTERVIEW_PANE, surface }) }
}
export const answersIn = (r: { text: string }) => JSON.parse(r.text.split('\n')[0]!) as { answers: { id: string; selected: string[]; other?: string; notes?: string; source?: string }[]; trustMeBro?: boolean; dismissed?: boolean; notAnswered?: string[] }
export const interviewFile = (w: W) => JSON.parse(w.files.get(INTERVIEW_FILE)!) as { rounds: { answers: unknown[] }[]; draft?: Record<string, { selected: string[] }>; commentIds?: { issue?: number; pr?: number }; posted?: boolean; closed?: { asked: boolean }; startedByFollowUp?: { of: number } }

export const POSTED_ONCE = { version: 1, issue: 7, rounds: [{ title: 'R', questions: [], answers: [{ id: 'a', selected: ['x'], other: '', notes: '' }], at: 1 }], commentIds: { issue: 55, pr: 66 } }

// ---- the board follows the state ----
export const BOARD = { config: { github: { repo: REPO, board: { owner: 'o', number: 1 } } } }
export const moves = (w: W) => w.steps.filter(l => l.startsWith('board.sh move'))

// ---- done stops the resources ----
export const finished = (over: Record<string, unknown> = {}) => ({ wf: finishing(), pr: pull(), checks: CHECKS({ name: 'ci', conclusion: 'success' }), ...over })
export const DONE = { message: 'finished', remembered: 'none: nothing durable' }

// Hack mode: the hack commits on this computer only, and hardening makes the change strict before the review pushes it.
export const HACK = { config: { mode: 'hack', steering: 'interactive' } }
