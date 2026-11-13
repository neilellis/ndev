import { expect, test } from 'claude-code/testing'

import { boardColumn } from '../hooks/workflow/machine'
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
  evidence: {}, attempts: 0, nudges: { count: 0 }, followUps: [], migrations: [], history: [], owner: { session: 's1', at: 0 }, baseCheck: { sha: SHA, script: 'pre-commit-check.sh', exitCode: 0, at: 0 }, ...over,
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
// The state of a worktree as a reader sees it: the old keys of the worktree file, and over them the issue files.
const heldOn = (files: Map<string, string> | undefined, root = ROOT) => {
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
const pull = (over: Record<string, unknown> = {}) => ({
  number: 12, state: 'open', merged: false, draft: false, mergeable: true, mergeable_state: 'clean',
  body: 'Closes #7', created_at: '2026-11-01T00:00:00Z', head: { sha: SHA, ref: 'issue-7' }, ...over,
})
const CHECKS = (...runs: { name: string; status?: string; conclusion: string | null; started_at?: string }[]) => ({ check_runs: runs.map(r => ({ status: 'completed', ...r })) })

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
    spawnedAtSweep: -1, ahead: undefined as string | undefined, claimFails: '', boardFails: '', boardCards: [{ number: 7, itemId: 'I7' }] as { number: number; itemId: string }[], sweepExit: 0, sweepOutput: 'base 2, head 2', stopFails: '', now: 0, sha: SHA, upstream: SHA, dirty: [] as string[], untracked: [] as string[], staged: false, failCheck: '', hugeCheck: '', hugeExit: 0, scripts: opts.scripts ?? true, agents: [] as { id: string; status: string }[],
    otherWorktrees: [] as string[], worktreeListFails: '', checkHold: undefined as Promise<void> | undefined, checkMs: {} as Record<string, number>, checkStops: [] as string[],
    prReadsFor: undefined as Record<number, unknown[]> | undefined, issueReadsFor: undefined as Record<number, unknown[]> | undefined,
    main: opts.main ?? false, claims: [] as string[], names: opts.names ?? ['a.ts'], copyDiffFails: '', draft: '', ghFails: '', orcaOn: false, orcaFails: '', issueAnswer: undefined as string | undefined, modelFails: false, spawnDeny: '', sleepHold: undefined as Promise<void> | undefined, resumed: false, orcaLinked: null as number | null, branch: undefined as string | undefined, pr: pull(opts.pr), checks: (opts.checks ?? CHECKS({ name: 'ci', conclusion: 'success' })) as unknown,
    probeLimits: [] as (number | undefined)[], issueReadMs: 0, editFails: '', rmFails: '', failRead: undefined as ((path: string) => boolean) | undefined, sleepYields: false, clockSleeps: 0, staleSaves: 0, saves: 0, failWrite: undefined as ((path: string) => boolean) | undefined, sleepAdvances: false, sleepDrift: [] as number[], sleepAborts: 0, sleepFails: '', immediate: [] as string[], probe: undefined as ((argv: string[]) => Promise<{ exitCode: number; stdout?: string; stderr?: string }> | { exitCode: number; stdout?: string; stderr?: string }) | undefined, probes: [] as string[],
    duringDiff: undefined as (() => Promise<unknown>) | undefined, duringTurnEnd: undefined as (() => Promise<unknown>) | undefined, diffFails: '', orcaGone: false, orcaReachable: true, pageUrl: undefined as string | undefined, pageWidth: undefined as number | undefined, viewportWidth: 0, viewportHeight: 0, pageHeight: undefined as number | undefined, stuckAt: undefined as number | undefined, scrollY: 0, shotsAt: [] as number[], sameImages: false, cmpFails: '', dark: false, cpFails: '',
    merging: undefined as string | undefined, unchanged: [] as string[], removed: [] as string[], renamedFrom: [] as string[], fromBase: [] as string[], checkEnv: {} as Record<string, Record<string, string> | undefined>,
    originHead: 'origin/main', githubBase: 'main', defaultBranchFails: '', branchPrs: [] as { number: number; state: string; merged: boolean }[],
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
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/neil' : e.name === 'ORCA_WORKSPACE_ID' && s.orcaOn ? 'workspace-1' : undefined }) as never)
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
    if (a[0] === 'sleep') return (async () => { if (s.sleepYields) await new Promise(r => setTimeout(r, 1)); await s.sleepHold; if (s.sleepAdvances) s.now += Number(a[1]) * 1000 + (s.sleepDrift.shift() ?? 0); return ok() })() as never
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
const STATE_TOOLS = ['interview', 'setSteering', 'finishedPlan', 'finishedInterview', 'checkpoint', 'finishedDevelopment', 'finishedReview', 'finishedChecks', 'finishedSmoke', 'finishedRevision', 'blocked', 'unblocked', 'done', 'followUp', 'addMigration', 'waitForSubAgent', 'waitForURL', 'waitForProcessEnd', 'waitForSeconds', 'waitFor', 'waitForPR', 'waitForIssue', 'waitForState']
let liveFiles: Map<string, string> | undefined
// A test names its target only when the target is the point of the test: the issue, or its PR once it has moved on.
function callFor(name: string): Record<string, unknown> {
  if (name === 'finishedDevelopment') return { issues: [onIssue] }
  if (name === 'waitForPR') return { issue: onIssue }
  const onFile = heldOn(liveFiles) as { workflows?: Record<string, { state: string; prs: number[] }>; prs?: Record<string, { state: string }> }
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

test('finishedDevelopment takes a new file in an untracked folder when the file is named', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.untracked = ['apps/new/page.tsx']
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'Add the page', files: ['apps/new/page.tsx'] })
  expect(r.isError).toBe(false)
  expect(w.commits.length).toBe(1)
})

for (const [name, args] of [['checkpoint', {}], ['finishedDevelopment', { prs: [12] }]] as const) {
  test(`${name} commits a named file whose deletion git rm already staged`, async ($, on) => {
    const w = engine(on)
    await start($, w)
    w.s.dirty = ['D  sql/old.test.sql', ' M a.ts']
    w.s.removed = ['sql/old.test.sql']
    const r = await tool($, name, { ...args, message: 'Drop the old test', files: ['sql/old.test.sql', 'a.ts'] })
    expect(r.text).not.toContain('pathspec')
    expect(r.isError).toBe(false)
    expect(w.commits.length).toBe(1)
  })
}

for (const [name, args] of [['checkpoint', {}], ['finishedDevelopment', { prs: [12] }]] as const) {
  test(`${name} commits a staged rename and a staged deletion when both old paths are named`, async ($, on) => {
    const w = engine(on)
    await start($, w)
    w.s.dirty = ['D  src/report-inputs.ts', 'RM test/report-inputs.test.ts -> test/report-block.test.ts']
    w.s.removed = ['src/report-inputs.ts']
    w.s.renamedFrom = ['test/report-inputs.test.ts']
    const r = await tool($, name, { ...args, message: 'Rename the test', files: ['src/report-inputs.ts', 'test/report-inputs.test.ts', 'test/report-block.test.ts'] })
    expect(r.text).not.toContain('pathspec')
    expect(r.isError).toBe(false)
    expect(w.commits.length).toBe(1)
  })
}

test('finishedDevelopment refuses the one unnamed file of an untracked folder, and names that file', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.untracked = ['apps/new/page.tsx', 'apps/new/secret.txt']
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'Add the page', files: ['apps/new/page.tsx'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('these changed files are not named: apps/new/secret.txt.')
  expect(w.commits.length).toBe(0)
})

test('finishedDevelopment still takes an untracked folder when the folder is named', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.untracked = ['apps/new/page.tsx', 'apps/new/layout.tsx']
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'Add the page', files: ['apps/new/'] })
  expect(r.isError).toBe(false)
  expect(w.commits.length).toBe(1)
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

// An issue that another change already fixed: closed on GitHub, no diff on the branch, its draft PR closed.
const alreadyFixed = (w: W) => { w.s.issueReadsFor = { 7: [{ state: 'closed', title: 'T' }] } }

test('done in development ends the workflow of an issue that was closed with no change', async ($, on) => {
  const w = engine(on, { pr: { state: 'closed', draft: true }, names: [] })
  await start($, w)
  alreadyFixed(w)
  const r = await tool($, 'done', { message: 'already fixed on main by e22097f9', remembered: 'nothing: no change' })
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('done')
  expect(w.state()?.doneMessage).toBe('already fixed on main by e22097f9')
  // Nothing waits for a human: Orca and the board show the issue as complete.
  expect(w.state()?.closedNoChange).toBe(true)
})

test('done in development refuses while the issue is open, and says why', async ($, on) => {
  const w = engine(on, { pr: { state: 'closed', draft: true }, names: [] })
  await start($, w)
  const r = await tool($, 'done', { message: 'already fixed', remembered: 'nothing: no change' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('issue #7 is open')
  expect(w.state()?.state).toBe('developing')
})

test('done in development refuses a branch that holds a change', async ($, on) => {
  const w = engine(on, { pr: { state: 'closed', draft: true }, names: ['a.ts'] })
  await start($, w)
  alreadyFixed(w)
  const r = await tool($, 'done', { message: 'already fixed', remembered: 'nothing: no change' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('a.ts')
  expect(r.text).toContain('finishedDevelopment')
  expect(w.state()?.state).toBe('developing')
})

// fcc-proto #465: PR #793 merged by hand with its issues closed, and done refused because the squashed branch
// still differs from main. A merged PR is the end of the work, whatever the branch holds.
test('done in development ends an issue whose PR merged outside the workflow', async ($, on) => {
  const w = engine(on, { pr: { state: 'closed', merged: true }, names: ['a.ts'] })
  await start($, w)
  alreadyFixed(w)
  const r = await tool($, 'done', { message: 'merged by hand as b366d05e', remembered: 'nothing: merged by hand' })
  expect(r.text).not.toContain('Not done')
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('done')
  expect(r.text).toContain('PR #12 is already merged')
  expect(r.text).not.toContain('closed with no change')
})

test('done in development refuses while the draft PR is open, and names the repair', async ($, on) => {
  const w = engine(on, { pr: { draft: true }, names: [] })
  await start($, w)
  alreadyFixed(w)
  const r = await tool($, 'done', { message: 'already fixed', remembered: 'nothing: no change' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('gh pr close 12')
  expect(w.state()?.state).toBe('developing')
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

// The turn-end handlers before the reminder can take seconds on a loaded machine. A queued prompt (a
// plugin message) can start the next turn meanwhile, and the turn end of the old turn must not mark it
// as ended: the reminder of #485 said "interviewing" one turn late, after blocked had moved it.
test('a turn that starts while the earlier turn-end handlers run gets no stale reminder queued behind it', async ($, on) => {
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  const w = engine(on)
  await start($, w)
  w.s.duringTurnEnd = () => $.turn.start({ text: 'The ndev plugin sent a message', turnId: 't2' })
  await turnEnds($)
  expect(w.prompts).toEqual([])
  expect(await command($, 'status')).toContain('quiet: the turn t2 started before the end of the turn t1 was checked')
})

// The host queues a prompt that comes while a turn runs, and gives it to the model only when that turn
// ends: the reminder of PR #444 said "reviewing" 44 minutes later, after finishedReview had moved it to ci.
test('a turn that starts while the turn-end reminder is built gets no stale reminder queued behind it', async ($, on) => {
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  const w = engine(on)
  await start($, w)
  // A queued prompt (a review's answer) starts the next turn while the reminder reads the worktree.
  w.s.duringDiff = () => $.turn.start({ text: 'the review has ended', turnId: 't2' })
  await turnEnds($)
  expect(w.prompts).toEqual([])
  expect(await command($, 'status')).toContain('a turn started before the reminder')
})

// The host holds a plugin's prompt until the session is idle. In analytics PR #2769 the reviews' answers started
// a turn just as the reminder went out, and that turn ran for two hours: blocked was called in it, and then
// the model read "reviewing". Nothing can take the prompt back, so the turn that it starts is cancelled.
test('a reminder that the host delivers after the state moved cancels its own turn before the model reads it', async ($, on) => {
  const aborted: string[] = []
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.abort', (_, e) => { aborted.push(e.turnId); return { value: undefined } as never })
  const w = engine(on)
  await start($, w)
  await turnEnds($)
  expect(w.prompts.length).toBe(1)
  // Another prompt got in first, and its turn blocks the workflow.
  await $.turn.start({ text: 'the review has ended', turnId: 't2' })
  await tool($, 'blocked', { message: 'help' })
  await $.turn.complete({ reason: 'answer', answer: 'text', durationMs: 1, isAborted: false, turnId: 't2' } as never)
  await settle()
  expect(w.prompts.length).toBe(1)
  await $.turn.start({ text: `The ndev plugin sent a message:\n${w.prompts[0]}`, turnId: 't3' })
  expect(aborted).toEqual(['t3'])
  const status = await command($, 'status')
  expect(status).toContain('named the state "developing"')
  expect(status).toContain('is now in the state "blocked"')
})

// In lens PR #315 a reminder for "reviewing" was queued on 11 Nov by a plugin process that kept no record of
// it, and the host delivered it 41 hours later, after a restart, when finishedReview had moved the PR to ci.
// The record of sent reminders did not hold it, so the turn was not cancelled. The words of the reminder name the state.
test('a reminder with no record of its sending is cancelled when the state it names no longer holds', async ($, on) => {
  const aborted: string[] = []
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.abort', (_, e) => { aborted.push(e.turnId); return { value: undefined } as never })
  const w = engine(on)
  await start($, w)
  expect(w.state()?.state).toBe('developing')
  const old = 'The workflow is not finished, so the turn does not end here. issue #7 is in the state "reviewing". Review: your last commit is not pushed yet. Do not end the turn before you call done or blocked.'
  await $.turn.start({ text: `The ndev plugin sent a message:\n${old}`, turnId: 't2' })
  expect(aborted).toEqual(['t2'])
  const status = await command($, 'status')
  expect(status).toContain('named the state "reviewing"')
  expect(status).toContain('is now in the state "developing"')
  // The same words with the state that holds start their turn.
  await $.turn.start({ text: `The ndev plugin sent a message:\n${old.replace('"reviewing"', '"developing"')}`, turnId: 't3' })
  expect(aborted).toEqual(['t2'])
})

test('a reminder that the host delivers while its state still holds starts its turn', async ($, on) => {
  const aborted: string[] = []
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.abort', (_, e) => { aborted.push(e.turnId); return { value: undefined } as never })
  const w = engine(on)
  await start($, w)
  await turnEnds($)
  await $.turn.start({ text: `The ndev plugin sent a message:\n${w.prompts[0]}`, turnId: 't2' })
  // A turn with other words is never cancelled, whatever the state.
  await tool($, 'blocked', { message: 'help' })
  await $.turn.start({ text: 'the human typed this', turnId: 't3' })
  expect(aborted).toEqual([])
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

test('idle ignores a cancelled run that a newer run of the same check replaced', async ($, on) => {
  const w = engine(on, { pr: { mergeable_state: 'blocked' }, checks: CHECKS(
    { name: 'checks', conclusion: 'cancelled', started_at: '2026-01-01T10:00:00Z' },
    { name: 'checks', status: 'in_progress', conclusion: null, started_at: '2026-01-01T10:00:02Z' }) })
  await start($, w)
  await idle(w)
  expect(w.prompts.join('\n')).not.toContain('failed checks')
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

// #679 in fcc-proto: another writer saved the PR record while the idle check read GitHub, and the idle
// check's own save then failed with "set-workflow exited 5 ... at revision 6, and this writer expected 5".
test('an idle check that loses the save to another writer tries again at the next tick, and reports no bug', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.staleSaves = 1
  await idle(w)
  expect(w.toasts.join()).not.toContain('the idle check failed')
  expect(w.prompts).toHaveLength(0)
  await poll(w, 61_000)
  expect(w.prompts).toHaveLength(1)
  expect(w.toasts.join()).not.toContain('exited 5')
})

test('an idle check that loses its save on each tick says so, with the error and the repair', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.staleSaves = 99
  await idle(w)
  await poll(w, 61_000)
  expect(w.toasts.join()).not.toContain('the idle check failed')
  await poll(w, 61_000)
  expect(w.toasts.join()).toContain('the idle check failed')
  expect(w.toasts.join()).toContain('exited 5')
  expect(w.toasts.join()).toContain('on 3 ticks in a row')
  expect(w.prompts).toHaveLength(0)
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

test('status in done reads the PR: a conflict is named with its repair, and the PR is not called ready', async ($, on) => {
  const w = engine(on, { wf: { state: 'done' }, pr: { mergeable: false, mergeable_state: 'dirty' } })
  await start($, w)
  const r = await tool($, 'status', { pr: 12 })
  expect(r.text).toContain('PR #12 has merge conflicts')
  expect(r.text).toContain('ndev:resolving-merge-conflicts')
  expect(r.text).toContain('(dirty)')
  expect(r.text).toContain('checkpoint')
  expect(r.text).not.toContain('ready for a human')
  expect(w.state()?.state).toBe('done')
})

test('status in done says that GitHub is still computing, and does not call the PR ready', async ($, on) => {
  const w = engine(on, { wf: { state: 'done' }, pr: { mergeable: null, mergeable_state: 'unknown' } })
  await start($, w)
  const r = await tool($, 'status')
  expect(r.text).toContain('GitHub has not finished computing whether PR #12 can merge')
  expect(r.text).not.toContain('ready for a human')
})

test('status in done that cannot read the PR says so, and does not call the PR ready', async ($, on) => {
  const w = engine(on, { wf: { state: 'done' } })
  await start($, w)
  w.s.prReadsFor = { 12: ['HTTP 502 from GitHub'] }
  const r = await tool($, 'status')
  expect(r.text).toContain('PR #12 was not read')
  expect(r.text).toContain('HTTP 502')
  expect(r.text).not.toContain('ready for a human')
})

test('status in done calls a clean PR ready only after it reads it', async ($, on) => {
  const w = engine(on, { wf: { state: 'done' } })
  await start($, w)
  expect((await tool($, 'status')).text).toContain('ready for a human to merge')
  w.s.pr = pull({ state: 'closed', merged: true, mergeable: null, mergeable_state: 'unknown' })
  const merged = await tool($, 'status')
  expect(merged.text).toContain('PR #12 is merged')
  expect(merged.text).not.toContain('ready for a human')
})

test('/flow status in done reads no PR, so it does not call the PR ready, and names the tool that reads it', async ($, on) => {
  const w = engine(on, { wf: { state: 'done' } })
  await start($, w)
  const out = await command($, 'status')
  expect(out).not.toContain('ready for a human')
  expect(out).toContain('call status')
})

test('a conflict fix on a finished PR that is still open commits through checkpoint and goes back to the checks', async ($, on) => {
  const w = engine(on, { wf: { state: 'done' }, pr: { mergeable: false, mergeable_state: 'dirty' } })
  await start($, w)
  w.s.dirty = ['M  CLAUDE.md']
  const r = await tool($, 'checkpoint', { message: 'Merge main', files: ['CLAUDE.md'] })
  expect(r.isError).toBe(false)
  expect(w.commits.length).toBe(1)
  expect(w.pushes.length).toBe(1)
  expect(w.state()?.state).toBe('ci')
})

for (const [name, pr, said] of [['merged', { state: 'closed', merged: true }, 'merged'], ['closed', { state: 'closed', merged: false }, 'closed with no merge']] as const) {
  test(`checkpoint on a finished PR that is ${name} commits nothing and says why`, async ($, on) => {
    const w = engine(on, { wf: { state: 'done' }, pr })
    await start($, w)
    w.s.dirty = [' M a.ts']
    const r = await tool($, 'checkpoint', { message: 'late', files: ['a.ts'] })
    expect(r.isError).toBe(true)
    expect(r.text).toContain(`PR #12 is ${said}`)
    expect(r.text).toContain('issue_only')
    expect(w.commits.length).toBe(0)
    expect(w.state()?.state).toBe('done')
  })
}

test('checkpoint on finished work with no PR is still refused', async ($, on) => {
  const w = engine(on, { wf: { state: 'done', direct: true, prs: [] } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'checkpoint', { message: 'late', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(w.commits.length).toBe(0)
  expect(w.state()?.state).toBe('done')
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

test('a read of the checks that loses its save to another writer reads again at the next tick', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, checks: CHECKS({ name: 'unit tests', conclusion: 'failure' }) })
  await start($, w)
  w.s.staleSaves = 1
  await poll(w)
  expect(w.toasts.join()).not.toContain('the idle check failed')
  expect(w.prompts).toHaveLength(0)
  await poll(w, 61_000)
  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0]).toContain('unit tests')
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
  // The workflow has PR #12 now, so the workspace takes the PR's number.
  expect(w.orcaCalls.flat().join(' ')).toContain('--display-name 12-add-sub')
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
  expect(JSON.parse(w.files.get(`${CLAIMED}/.neil-dev.issue-31.json`)!).workflow.changeTypes).toEqual(['tests', 'backend'])
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
  expect(JSON.parse(w.files.get(`${CLAIMED}/.neil-dev.issue-31.json`)!).workflow.issue).toBe(31)
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

// The session can lose its link to the record that holds the followUp entry (a lost hooks worker, a
// restart). The agent's own record, which only followUp writes, still says that followUp started it.
test('a followUp agent commits through checkpoint when the session no longer sees the followUp entry: its own record says followUp started it', async ($, on) => {
  const w = engine(on, { files: { [`${CLAIMED}/.neil-dev.issue-31.json`]: JSON.stringify({ version: 1, issue: 31, workflow: flow({ issue: 31, root: CLAIMED, prs: [], owner: undefined, followUpOf: 7 }) }) } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'checkpoint', { issue: 31, message: 'm', files: ['a.ts'], ...AGENT })
  expect(r.text).not.toContain('Refused')
  expect(r.isError).toBe(false)
  expect(w.s.commitDirs).toEqual([CLAIMED])
})

test('checkpoint still refuses a worktree whose record followUp did not write, and says where it looked', async ($, on) => {
  const elsewhere = '/claimed/issue-9'
  const w = engine(on, { files: { [`${elsewhere}/.neil-dev.issue-9.json`]: JSON.stringify({ version: 1, issue: 9, workflow: flow({ issue: 9, root: elsewhere, prs: [], owner: undefined }) }) } })
  await startFollowUp($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'checkpoint', { issue: 9, message: 'm', files: ['a.ts'], agentId: 'agent-9', worktree: elsewhere })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('did not start an agent')
  expect(r.text).toContain(`${elsewhere}/.neil-dev.issue-9.json`)
  expect(r.text).toContain(ROOT)
  expect(r.text).toContain(CLAIMED)
  expect(w.s.commitDirs).toEqual([])
})

test('the worktree of a followUp agent is on the record, so another session can read it after a restart', async ($, on) => {
  const w = engine(on)
  await startFollowUp($, w)
  expect(w.state()?.followUps?.[0]?.worktree).toBe(CLAIMED)
})

test('checks pending at done: the commit that done waits for is on the record, so a new session watches it', async ($, on) => {
  const w = engine(on, { wf: { state: 'finishing', evidence: { checks: { sha: SHA, text: 'green' } } }, checks: RUNNING })
  await start($, w)
  await tool($, 'done', { message: 'm', remembered: 'nothing: small' })
  expect(w.state()?.doneWaitsFor).toBe(SHA)
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

const OLD_BASE = '2ce42c95'.padEnd(40, '0')
const NEW_BASE = '13f28e82'.padEnd(40, '0')

test('a commit that ends a merge of the base gives the checks the new merge base, not the old one', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.dirty = ['M  a.ts']
  w.s.merging = NEW_BASE
  await tool($, 'checkpoint', { message: 'Merge origin/main', files: ['a.ts'] })
  expect(w.s.checkEnv['pre-commit-check.sh']?.NDEV_MERGE_BASE).toBe(NEW_BASE)
})

test('a commit with no merge gives the checks the merge base of HEAD', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.dirty = [' M a.ts']
  await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  expect(w.s.checkEnv['pre-commit-check.sh']?.NDEV_MERGE_BASE).toBe(OLD_BASE)
})

test('a failed check during a merge says that HEAD is the commit before the merge, and names NDEV_MERGE_BASE', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.dirty = ['M  a.ts']
  w.s.merging = NEW_BASE
  w.s.failCheck = 'pre-commit-check'
  const r = await tool($, 'checkpoint', { message: 'Merge origin/main', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('A merge is in progress')
  expect(r.text).toContain(`NDEV_MERGE_BASE=${NEW_BASE}`)
})

test('a merge that changes no file is still committed as the merge, and pushed', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.merging = NEW_BASE
  w.s.unchanged = ['a.ts']
  const r = await tool($, 'checkpoint', { message: 'Merge origin/main', files: ['a.ts'] })
  expect(r.isError).toBe(false)
  expect(w.commits).toHaveLength(1)
  expect(w.commits[0]).toContain('Merge origin/main')
  expect(w.pushes).toHaveLength(1)
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

test('a commit that ends a merge of the base runs fast-checks.sh only on the files that differ from the base, and says so', async ($, on) => {
  const w = engine(on, { names: ['mine.ts', 'PublishView.tsx', 'TrackedClaims.tsx'] })
  await start($, w)
  w.s.dirty = ['M  mine.ts', 'M  PublishView.tsx', 'M  TrackedClaims.tsx']
  w.s.merging = NEW_BASE
  w.s.fromBase = ['PublishView.tsx', 'TrackedClaims.tsx']
  const r = await tool($, 'checkpoint', { message: 'Merge origin/main', files: ['mine.ts', 'PublishView.tsx', 'TrackedClaims.tsx'] })
  expect(w.steps).toContain('fast-checks.sh mine.ts')
  expect(r.text).toContain('2 staged files came from the base unchanged')
})

test('the checks get the keys of the worktree .neil-dev.env that checkEnv in .neil-dev.json names, and no other', async ($, on) => {
  const w = engine(on, { files: { [CONFIG]: JSON.stringify({ checkEnv: ['TEST_DB_URL', 'QUOTED'] }), [`${ROOT}/.neil-dev.env`]: '# graph\nFALKORDB_URL=rediss://graph.example.com:6380\nTEST_DB_URL=redis://localhost:6379\nexport QUOTED="a b"\n' } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  expect(w.s.checkEnv['pre-commit-check.sh']?.TEST_DB_URL).toBe('redis://localhost:6379')
  expect(w.s.checkEnv['pre-commit-check.sh']?.QUOTED).toBe('a b')
  expect(w.s.checkEnv['pre-commit-check.sh']?.FALKORDB_URL).toBeUndefined()
  expect(w.s.checkEnv['pre-commit-check.sh']?.NDEV_MERGE_BASE).toBe(OLD_BASE)
})

// fcc-proto PR #828: .neil-dev.env held FALKORDB_URL and FALKORDB_CA of the hosted graph server, for kb:publish. The
// test scripts start a local server only when FALKORDB_URL is unset, so with that key the tests wrote to the hosted one.
test('with no checkEnv in .neil-dev.json the checks get no key of .neil-dev.env, so the tests do not reach hosted services', async ($, on) => {
  const w = engine(on, { files: { [`${ROOT}/.neil-dev.env`]: 'FALKORDB_URL=rediss://graph.example.com:6380\nFALKORDB_CA=/keys/ca.pem\n' } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  expect(w.s.checkEnv['pre-commit-check.sh']?.FALKORDB_URL).toBeUndefined()
  expect(w.s.checkEnv['pre-commit-check.sh']?.FALKORDB_CA).toBeUndefined()
  expect(w.s.checkEnv['pre-commit-check.sh']?.NDEV_MERGE_BASE).toBe(OLD_BASE)
})

test('a check that fails names the .neil-dev.env keys it did not get and how to give one', async ($, on) => {
  const w = engine(on, { files: { [`${ROOT}/.neil-dev.env`]: 'FALKORDB_URL=rediss://graph.example.com:6380\nFALKORDB_CA=/keys/ca.pem\n' } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  w.s.failCheck = 'pre-commit-check'
  const r = await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('did not get FALKORDB_URL, FALKORDB_CA')
  expect(r.text).toContain('checkEnv')
  expect(r.text).not.toContain('graph.example.com')
})

test('a key that checkEnv names but .neil-dev.env does not set stops the check and names the key and the repair', async ($, on) => {
  const w = engine(on, { files: { [CONFIG]: JSON.stringify({ checkEnv: ['TEST_DB_URL'] }), [`${ROOT}/.neil-dev.env`]: 'FALKORDB_URL=rediss://graph.example.com:6380\n' } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('TEST_DB_URL')
  expect(r.text).toContain('neil-dev-env.mjs init --key TEST_DB_URL')
  expect(w.steps).not.toContain('pre-commit-check.sh')
})

test('a .neil-dev.env line that is not KEY=VALUE stops the check and names the file and the line, not the value', async ($, on) => {
  const w = engine(on, { files: { [`${ROOT}/.neil-dev.env`]: 'FALKORDB_URL=redis://localhost:6379\nsecret-without-key\n' } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain(`${ROOT}/.neil-dev.env line 2 is not KEY=VALUE`)
  expect(r.text).not.toContain('secret-without-key')
  expect(w.steps).not.toContain('pre-commit-check.sh')
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

test('a pre-ready check that runs for 19 minutes runs to the end, and the push goes on', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' } })
  await start($, w)
  w.s.sha = 'cccc'
  w.s.checkMs = { 'pre-ready-check.sh': 19 * 60_000 }
  const r = await tool($, 'finishedReview', { remembered: 'nothing: small', review: 'clean', deadcode: 'clean' })
  expect(r.text).not.toContain('exited 127')
  expect(r.isError).toBe(false)
  expect(w.pushes.length).toBe(1)
})

test('a check that outruns the whole limit is stopped, and the refusal names the limit, the time and the log', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' } })
  await start($, w)
  w.s.sha = 'cccc'
  w.s.checkMs = { 'pre-ready-check.sh': 5 * 60 * 60_000 }
  const r = await tool($, 'finishedReview', { remembered: 'nothing: small', review: 'clean', deadcode: 'clean' })
  expect(r.isError).toBe(true)
  expect(w.pushes.length).toBe(0)
  expect(r.text).toContain('pre-ready-check.sh was still running after 60 minutes')
  expect(r.text).toContain('ndev-pre-ready-check.sh.log')
  expect(r.text).not.toContain('exited 127')
  expect(w.s.checkStops).toEqual(['4242'])
})

test('a held commit can be pushed with an empty checkpoint after a human skips the review', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' } })
  await start($, w)
  w.s.sha = 'cccc'
  const r = await tool($, 'checkpoint', { message: 'push the held commit', files: [] })
  expect(r.isError).toBe(false)
  expect(w.pushes.length).toBe(1)
})

// In fcc-proto PR #779 (state "reviewing", one held commit) the push hook named "checkpoint with no files"
// as the way to push it, and checkpoint then refused for a missing file list. In review the commit is
// held for finishedReview, so neither answer may name the empty checkpoint, and both name the real routes.
test('in review the push hook does not offer an empty checkpoint, and names finishedReview', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' } })
  await start($, w)
  const r = await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' } as never) as { deny?: string }
  expect(r.deny).not.toContain('With no files it pushes a held commit')
  expect(r.deny).toContain('finishedReview')
  expect(r.deny).toContain('/flow skip')
})

test('while an issue waits for the others on its PR the push hook names finishedDevelopment, not a skip alone', async ($, on) => {
  const w = engine(on, { wf: { state: 'developed' } })
  await start($, w)
  const r = await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' } as never) as { deny?: string }
  expect(r.deny).not.toContain('With no files it pushes a held commit')
  expect(r.deny).toContain('finishedDevelopment')
})

test('after review the push hook still offers an empty checkpoint for a held commit', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' } })
  await start($, w)
  const r = await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' } as never) as { deny?: string }
  expect(r.deny).toContain('With no files it pushes a held commit')
})

test('an empty checkpoint in review names the held commit and finishedReview, not a missing file list', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' } })
  await start($, w)
  w.s.sha = 'cccc1234'
  const r = await tool($, 'checkpoint', { message: 'push the held commit', files: [] })
  expect(r.isError).toBe(true)
  expect(w.pushes.length).toBe(0)
  expect(r.text).not.toContain('needs the files to commit')
  expect(r.text).toContain('cccc1234')
  expect(r.text).toContain('"reviewing"')
  expect(r.text).toContain('finishedReview')
  expect(r.text).toContain('/flow skip')
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

test('a session that Claude Code continued into this one keeps the workflow of the old session, with no takeOver', async ($, on) => {
  const w = engine(on, { wf: { owner: { session: 'old', at: 0 } } })
  await start($, w)
  // The last line of the old transcript says: continued-in, continuedInSessionId s1.
  w.s.probe = argv => ({ exitCode: 0, stdout: argv.includes('old') ? 's1\n' : '' })
  const r = await tool($, 'blocked', { message: 'need the human' })
  expect(r.text).not.toContain('owns this workflow')
  expect(w.state()?.owner?.session).toBe('s1')
  expect(w.s.probes.join('\n')).toContain('continuedInSessionId')
})

test('a session that no transcript continued into this one is still refused, and the refusal names the check', async ($, on) => {
  const w = engine(on, { wf: { owner: { session: 'old', at: 0 } } })
  await start($, w)
  w.s.probe = () => ({ exitCode: 0, stdout: 'someone-else\n' })
  const r = await tool($, 'blocked', { message: 'need the human' })
  expect(r.text).toContain('owns this workflow')
  expect(r.text).toContain('continued into')
  expect(w.state()?.owner?.session).toBe('old')
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

test('started takes the base from GitHub when the local origin/HEAD is stale', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  w.s.originHead = 'origin/initial-site'
  w.s.branch = 'fix/new-work'
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(r.isError).toBe(false)
  expect(w.state()?.base).toBe('main')
})

test('started refuses and records nothing when GitHub does not say the default branch, and says why', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  w.s.defaultBranchFails = 'HTTP 502 from api.github.com'
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('HTTP 502 from api.github.com')
  expect(w.state()).toBeUndefined()
})

test('started does not claim a branch whose PR has merged, and names the repair', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  w.s.branch = 'fix/lens-hybrid-copy'
  w.s.branchPrs = [{ number: 58, state: 'closed', merged: true }]
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('fix/lens-hybrid-copy')
  expect(r.text).toContain('#58')
  expect(r.text).toContain('git -C /')
  expect(r.text).toContain('origin/main')
  expect(w.state()).toBeUndefined()
  expect(w.pushes).toEqual([])
})

test('started keeps a branch that has an open PR beside a merged one', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  w.s.branch = 'fix/second-round'
  w.s.branchPrs = [{ number: 58, state: 'closed', merged: true }, { number: 70, state: 'open', merged: false }]
  expect((await tool($, 'started', { issue: 7, shortName: 'add-sub' })).isError).toBe(false)
  expect(w.state()?.branch).toBe('fix/second-round')
})

test('started keeps a branch whose only PR was closed without a merge', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  w.s.branch = 'fix/reopened'
  w.s.branchPrs = [{ number: 59, state: 'closed', merged: false }]
  expect((await tool($, 'started', { issue: 7, shortName: 'add-sub' })).isError).toBe(false)
  expect(w.state()?.branch).toBe('fix/reopened')
})

test('create names the filed issue when the branch of the worktree has merged', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  w.s.branch = 'fix/lens-hybrid-copy'
  w.s.branchPrs = [{ number: 58, state: 'closed', merged: true }]
  const r = await tool($, 'create', { shortName: 'deactivate-halloween', description: 'Deactivate halloween', mode: 'light' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('Issue #31')
  expect(r.text).toContain('fix/lens-hybrid-copy')
  expect(r.text).toContain('Do not call create again')
  expect(w.pushes).toEqual([])
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

test('a generated report that opens with a machine marker is not feedback at done', async ($, on) => {
  const w = engine(on, { wf: finishing() })
  await start($, w)
  w.s.comments = [{ id: 6633384837, body: '<!-- visual-diff -->\n## Visual diff', user: { login: 'human', type: 'User' }, created_at: '2026-11-02T00:00:00Z' }]
  w.s.commitIso = '2026-11-01T00:00:00Z'
  w.s.now = Date.parse('2026-11-03T00:00:00Z')
  const r = await tool($, 'done', { message: 'finished', remembered: 'nothing: small' })
  expect(r.text).not.toContain('has no answer')
  expect(w.state()?.state).not.toBe('revising')
})

// ---- a PR that a human merged while the workflow was in finishing ----
const MERGED_PR = { state: 'closed', merged: true, mergeable: null, mergeable_state: 'unknown' }
test('done on a PR that a human merged marks the work done and merged, and asks for no more checks', async ($, on) => {
  const w = engine(on, { wf: { ...finishing(), evidence: {} }, pr: MERGED_PR, checks: CHECKS({ name: 'unit tests', conclusion: 'failure' }) })
  await start($, w)
  w.s.upstream = ''
  const r = await tool($, 'done', { message: 'finished', remembered: 'nothing: small' })
  expect(r.isError).toBe(false)
  expect(r.text).not.toContain('Call done again')
  expect(w.state()?.state).toBe('done')
  expect(w.state()?.merged).toBe(true)
  expect(w.merges).toEqual([])
})

test('done on a merged PR reads no comment as feedback', async ($, on) => {
  const w = engine(on, { wf: finishing(), pr: MERGED_PR })
  await start($, w)
  w.s.comments = [remark]
  const r = await tool($, 'done', { message: 'finished', remembered: 'nothing: small' })
  expect(r.text).not.toContain('has no answer')
  expect(w.state()?.state).toBe('done')
})

test('done on a merged PR names each listed migration, and how to record one that was applied by hand', async ($, on) => {
  const path = 'supabase/migrations/20261104192428_prompt_store_tools.sql'
  const w = engine(on, { wf: { ...finishing(), migrations: [{ name: 'prompt_store_tools', path }] }, names: [path], pr: MERGED_PR })
  await start($, w)
  const r = await tool($, 'done', { message: 'finished', remembered: 'nothing: small' })
  expect(w.state()?.state).toBe('done')
  expect(r.text).toContain(path)
  expect(r.text).toContain('/ndev:merge 12')
  expect(r.text).toContain('supabase migration repair 20261104192428 --status applied')
})

test('done on a merged PR says when this worktree holds work that did not merge', async ($, on) => {
  const w = engine(on, { wf: finishing(), pr: { ...MERGED_PR, head: { sha: 'f'.repeat(40), ref: 'issue-7' } } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'done', { message: 'finished', remembered: 'nothing: small' })
  expect(w.state()?.state).toBe('done')
  expect(r.text).toContain('a.ts')
  expect(r.text).toContain('not the merged head')
})

test('done on a PR closed with no merge still refuses, names the repair, and does not say to call again for mergeability', async ($, on) => {
  const w = engine(on, { wf: finishing(), pr: { state: 'closed', merged: false, mergeable: null } })
  await start($, w)
  const r = await tool($, 'done', { message: 'finished', remembered: 'nothing: small' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('closed with no merge')
  expect(r.text).toContain('gh pr reopen 12')
  expect(r.text).not.toContain('has not finished computing')
  expect(w.state()?.state).toBe('finishing')
})

test('feedback at done names how to answer a comment that asks for no change', async ($, on) => {
  const w = engine(on, { wf: finishing() })
  await start($, w)
  w.s.comments = [remark]
  const r = await tool($, 'done', { message: 'finished', remembered: 'nothing: small' })
  expect(w.state()?.state).toBe('revising')
  expect(r.text).toContain('ack:<its id>')
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
// On a loaded computer each slice of a pause costs the hook some of its own ten seconds. Past them the host
// drops the hook, and the agent reads "no tool.call hook answered this call". The test kit counts that time
// and does not drop the hook, so the proof is that the wait ends inside the pause, before the time is spent.
// A large record makes each read of it slow, and that time is the hook's own. The pauses grow to make the time
// last, so how many checks run first depends on how busy the computer is.
test('a wait whose own time runs low during a long pause stops inside the pause, and names the cause and the repair', { timeoutMs: 180_000 }, async ($, on) => {
  const w = engine(on, { wf: { ballast: Array.from({ length: 3_000_000 }, (_, i) => ({ n: i, at: 0 })) } })
  await start($, w)
  w.s.sleepAdvances = true
  w.s.probe = () => ({ exitCode: 1 })
  const r = await tool($, 'waitFor', { shell_command: 'false', period: 1100 })
  expect(r.isError).toBe(true)
  expect(r.text).toMatch(/waitFor stopped its wait for `false` to exit 0 after \d+ attempts/)
  expect(r.text).toContain("the host's time budget for one hook is nearly spent")
  expect(r.text).toContain('ms are left of 10000 ms')
  expect(r.text).toContain('Repair: call waitFor again')
  expect(w.state()?.state).toBe('developing')
})

// Without an answer the agent reads only "no tool.call hook answered this call", as it does when a hook runs past its budget.
test('a workflow tool whose hook the host drops still answers, with the tool, the cause and the repair', async ($, on) => {
  const w = engine(on)
  await start($, w)
  // The hook reads the clock before its own error handling starts, and again inside it.
  Object.defineProperty(w.s, 'now', { get: () => { throw new Error('the clock broke') } })
  const r = await tool($, 'waitFor', { shell_command: 'false' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('workflow waitFor gave no answer')
  expect(r.text).toContain('its hook failed outside its own error handling')
  expect(r.text).toContain('clock.now')
  expect(r.text).toContain('Repair: call status and read the state, then call waitFor again')
})

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

test('waitFor goes on past a pause that the host aborts after it ran over', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  w.s.sleepAborts = 1
  let exits = [1, 0]
  w.s.probe = () => ({ exitCode: exits.shift() ?? 0 })
  const r = await tool($, 'waitFor', { shell_command: 'test -f /tmp/x', period: 2 })
  expect(r.isError).toBe(false)
  expect(w.s.sleepAborts).toBe(0)
  expect(w.state()?.state).toBe('developing')
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

test('a wait can hold for 1200 s in all: a longer timeout or secs is refused, and nothing changes', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  for (const [name, args] of [
    ['waitFor', { shell_command: 'true', timeout: 1201 }],
    ['waitForSeconds', { secs: 1201 }],
    ['waitForSeconds', { secs: 5, timeout: 3600 }],
  ] as const) {
    const r = await tool($, name, args)
    expect(r.isError).toBe(true)
    expect(r.text).toContain('1200 s')
    expect(w.state()?.state).toBe('developing')
  }
  expect((await tool($, 'waitForSeconds', { secs: 1200 })).isError).toBe(false)
})

test('with no timeout a wait gives up within 1200 s, and its last check runs just before the end', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  w.s.probe = () => ({ exitCode: 1 })
  const startedAt = w.s.now
  const r = await tool($, 'waitFor', { shell_command: 'false', period: 100 })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('timeout of 1200 s')
  expect(w.s.now - startedAt).toBeLessThanOrEqual(1_200_000)
  expect(w.s.probes.length).toBe(13)
  expect(w.state()?.state).toBe('developing')
})

test('a check may run only for what is left of the timeout', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  w.s.probe = () => ({ exitCode: 1 })
  await tool($, 'waitFor', { shell_command: 'false', period: 100, timeout: 130 })
  expect(w.s.probeLimits).toEqual([60_000, 20_000, 10_000])
})

test('a wait sees a condition that comes true in its last period, and does not hold to the end with no check', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  const startedAt = w.s.now
  w.s.probe = () => ({ exitCode: w.s.now - startedAt > 100_000 ? 0 : 1 })
  const r = await tool($, 'waitFor', { shell_command: 'x', period: 100, timeout: 130 })
  expect(r.isError).toBe(false)
  expect(w.s.probes.length).toBe(3)
})

test('waitForSeconds with secs above its timeout is refused, because it could not end well', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  const r = await tool($, 'waitForSeconds', { secs: 600, timeout: 300 })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('Nothing changed')
  expect(w.state()?.state).toBe('developing')
})

test('a wait behind a long call starts nothing past its timeout, and says so', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  w.s.sleepYields = true
  let release = () => {}
  w.s.checkHold = new Promise<void>(resolve => { release = resolve })
  const held = tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  await settle()
  const startedAt = w.s.now
  // The hold ends in time for a wait that ignores its timeout to fail here, and not to hang the file.
  const watch = setInterval(() => { if (w.s.now - startedAt > 60_000) release() }, 1)
  const r = await tool($, 'waitFor', { shell_command: 'true', timeout: 30 })
  clearInterval(watch)
  release()
  await held
  expect(r.isError).toBe(true)
  expect(r.text).toContain('Nothing changed')
  expect(w.s.now - startedAt).toBeLessThanOrEqual(30_000)
  expect(w.s.probes.length).toBe(0)
})

test('a wait ends within its timeout while another call holds the queue', async ($, on) => {
  const w = engine(on)
  await startFollowUp($, w)
  w.s.sleepAdvances = true
  w.s.sleepYields = true
  w.s.dirty = [' M a.ts']
  let release = () => {}
  w.s.checkHold = new Promise<void>(resolve => { release = resolve })
  const startedAt = w.s.now
  // A helper's checkpoint holds the queue through its checks, while the main agent waits.
  let held: ReturnType<typeof tool> | undefined
  w.s.probe = () => {
    held ??= tool($, 'checkpoint', { issue: 31, message: 'm', files: ['a.ts'], ...AGENT })
    return { exitCode: 1 }
  }
  const watch = setInterval(() => { if (w.s.now - startedAt > 60_000) release() }, 1)
  const r = await tool($, 'waitFor', { shell_command: 'false', period: 10, timeout: 30 })
  clearInterval(watch)
  const endedAt = w.s.now
  release()
  await held
  expect(r.isError).toBe(true)
  expect(r.text).toContain('timeout of 30 s')
  expect(endedAt - startedAt).toBeLessThanOrEqual(30_000)
  expect(w.state()?.state).toBe('developing')
})

test('one check of many issues stops reading when its time is up', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  w.s.issueReadMs = 8_000
  const startedAt = w.s.now
  const r = await tool($, 'waitForIssue', { waitOn: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], state: 'closed', timeout: 30 })
  expect(r.isError).toBe(true)
  expect(w.s.now - startedAt).toBeLessThanOrEqual(30_000)
})

test('a check stopped by what is left of the timeout says so, and is not reported as a command that did not run', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  w.s.probe = () => {
    w.s.now += 60_000
    throw new Error('the command was still running')
  }
  const r = await tool($, 'waitFor', { shell_command: 'slow', timeout: 30 })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('stopped after')
  expect(r.text).not.toContain('did not run')
})

test('a long period does not raise the notice after the first check', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  const seen: number[] = []
  w.s.probe = () => {
    seen.push(w.alerts.length)
    return { exitCode: 1 }
  }
  await tool($, 'waitFor', { shell_command: 'false', period: 900 })
  expect(seen).toEqual([0, 0, 1])
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

// fcc-proto, load 120-190 on 10 cores: each 2 s slice of a pause cost the hook about 100-230 ms of its own ten
// seconds, so a wait with a timeout of 1200 s stopped after 1-4 checks. A large record makes each read of it slow,
// and that time is the hook's own, as in the test above. How slow depends on the computer and its load, so the
// test sizes the record for about 60 ms a read. The wait spaces its pauses so that its own time lasts.
test('waitForProcessEnd on a busy host holds until the process ends', { timeoutMs: 180_000 }, async ($, on) => {
  const sample = JSON.stringify(Array.from({ length: 10_000 }, (_, i) => ({ n: i, at: 0 })))
  const from = Date.now()
  for (let i = 0; i < 20; i++) JSON.parse(sample)
  const length = Math.min(2_000_000, Math.round((10_000 * 60) / Math.max((Date.now() - from) / 20, 0.05)))
  const w = engine(on, { wf: { ballast: Array.from({ length }, (_, i) => ({ n: i, at: 0 })) } })
  await start($, w)
  w.s.sleepAdvances = true
  const endsAt = w.s.now + 1_000_000
  w.s.probe = () => (w.s.now >= endsAt ? { exitCode: 1 } : { exitCode: 0, stdout: 'S' })
  const r = await tool($, 'waitForProcessEnd', { pid: 95794, period: 60, timeout: 1200 })
  expect(r.text).not.toContain("the host's time budget for one hook is nearly spent")
  expect(r.isError).toBe(false)
  expect(r.text).toContain('The wait for process 95794 ended')
  expect(w.s.now).toBeGreaterThanOrEqual(endsAt)
  expect(w.state()?.state).toBe('developing')
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

test('a wait starts well when another writer gets in first', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  let answers = [{ exitCode: 0, stdout: 'S' }, { exitCode: 1 }]
  w.s.probe = () => answers.shift() ?? { exitCode: 1 }
  w.s.staleSaves = 1
  const r = await tool($, 'waitForProcessEnd', { pid: 4242 })
  expect(r.text).not.toContain('exited 5')
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('developing')
})

test('a wait that raises its alert survives another writer getting in first', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  let n = 0
  w.s.probe = () => {
    n += 1
    // The alert is saved after the check that passes half the attempts.
    if (n === 2) w.s.staleSaves = 1
    return n >= 3 ? { exitCode: 1 } : { exitCode: 0, stdout: 'S' }
  }
  const r = await tool($, 'waitForProcessEnd', { pid: 4242, attempts: 3 })
  expect(r.text).not.toContain('exited 5')
  expect(r.isError).toBe(false)
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

// What a reader sees once a wait is over: the earlier state, and no word of a wait that holds the agent.
const expectBackIn = async ($: Dollar, w: W, state: string) => {
  expect(w.state()?.state).toBe(state)
  expect(w.state()?.waiting).toBeUndefined()
  const said = (await tool($, 'status')).text
  expect(said).toContain(`State: ${state}.`)
  expect(said).not.toContain('A wait tool holds')
}

test('a wait whose check throws goes back to the earlier state', async ($, on) => {
  const w = engine(on)
  await start($, w)
  // One read of the record fails during the wait, and the reads after it work.
  let isBroken = false
  w.s.failRead = (path: string) => {
    if (!isBroken || !path.includes('.neil-dev.')) return false
    isBroken = false
    return true
  }
  w.s.probe = () => {
    isBroken = true
    return { exitCode: 1 }
  }
  const r = await tool($, 'waitFor', { shell_command: 'check' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('waitFor for')
  await expectBackIn($, w, 'developing')
})

test('an interrupt that the host goes on from without the hook still ends the wait at the end of the turn', async ($, on) => {
  const w = engine(on)
  await start($, w)
  // The host lets a hook linger for 5 s after an interrupt, so this hook never gets its own say.
  w.s.probe = () => ({ exitCode: 1 })
  let release!: () => void
  w.s.sleepHold = new Promise<void>(resolve => { release = resolve })
  const call = tool($, 'waitFor', { shell_command: 'false', period: 30 })
  await settle()
  expect(w.state()?.state).toBe('wait')
  await turnEnds($, 'aborted')
  await expectBackIn($, w, 'developing')
  // A later wait is legal again, and the lingering hook that wakes at last changes nothing.
  w.s.sleepAdvances = true
  release()
  await call
  await expectBackIn($, w, 'developing')
  w.s.probe = () => ({ exitCode: 0 })
  expect((await tool($, 'waitFor', { shell_command: 'check' })).isError).toBe(false)
})

test('a normal end of a turn ends a wait of this session that no wait tool holds', async ($, on) => {
  const w = engine(on, { wf: { state: 'wait', previous: 'ci', waiting: { id: 'old', tool: 'waitFor', what: 'old', at: 0 } } })
  await start($, w)
  await turnEnds($)
  await expectBackIn($, w, 'ci')
})

test('the end of a session ends its wait, and withdraws its notice', async ($, on) => {
  const alert = { group: 'g1', pid: 42 }
  const w = engine(on, { wf: { state: 'wait', previous: 'ci', waiting: { id: 'old', tool: 'waitFor', what: 'old', at: 0, alert } } })
  await start($, w)
  await $.session.end({ reason: 'other', sessionId: 's1' } as never)
  await settle()
  expect(w.state()?.state).toBe('ci')
  expect(w.state()?.waiting).toBeUndefined()
  expect(w.alerts.join('\n')).toContain('withdraw')
})

test('status names a wait with no holder in this session, and started takes the state back and withdraws its notice', async ($, on) => {
  const w = engine(on, { wf: { state: 'wait', previous: 'ci', waiting: { id: 'old', tool: 'waitFor', what: '`check` to exit 0', at: 0, alert: { group: 'g1', pid: 42 } } } })
  await start($, w)
  const said = (await tool($, 'status')).text
  expect(said).not.toContain('A wait tool holds')
  expect(said).toContain('No wait tool runs')
  expect(said).toContain('waitFor')
  expect(said).toContain('started')
  expect(w.state()?.state).toBe('wait') // status changes nothing.
  expect(w.alerts).toEqual([])
  await tool($, 'started', { issue: 7 })
  expect(w.alerts).toEqual(['withdraw'])
  await expectBackIn($, w, 'ci')
})

test('status says that a wait whose owner died has no holder, and started takes the state back', async ($, on) => {
  const w = engine(on, { wf: { state: 'wait', previous: 'ci', waiting: { id: 'old', tool: 'waitFor', what: 'old', at: 0 }, owner: { session: 'dead', at: -3_600_000 } } })
  await start($, w)
  const said = (await tool($, 'status')).text
  expect(said).not.toContain('A wait tool holds')
  expect(said).toContain('No wait tool runs')
  expect(said).toContain('Call started with issue 7')
  await tool($, 'started', { issue: 7 })
  await expectBackIn($, w, 'ci')
})

test('status leaves a wait of another live session as it is, and names that session', async ($, on) => {
  const w = engine(on, { wf: { state: 'wait', previous: 'ci', waiting: { id: 'theirs', tool: 'waitFor', what: 'theirs', at: 0 }, owner: { session: 'other', at: 0 } } })
  await start($, w)
  const said = (await tool($, 'status')).text
  expect(said).toContain('the session other')
  expect(said).toContain('takeOver true')
  expect(said).not.toContain('A wait tool holds')
  expect(said).not.toContain('No wait tool runs')
  await turnEnds($, 'aborted')
  expect(w.state()?.state).toBe('wait')
})

test('status says that a running wait holds the agent', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.probe = () => ({ exitCode: 1 })
  let release!: () => void
  w.s.sleepHold = new Promise<void>(resolve => { release = resolve })
  const call = tool($, 'waitFor', { shell_command: 'false', period: 30 })
  await settle()
  const said = (await tool($, 'status')).text
  expect(said).toContain('A wait tool holds')
  expect(said).not.toContain('No wait tool runs')
  await unblock($, 'go on')
  release()
  await call
})

test('a wait finds its record when the record moves files mid-wait', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const issueFile = `${ROOT}/.neil-dev.issue-7.json`
  w.s.probe = () => {
    // The old keys of the worktree file and the issue file are the two places a record can be.
    const held = JSON.parse(w.files.get(issueFile)!) as { workflow: unknown }
    w.files.set(RECORD, JSON.stringify({ workflows: { 7: held.workflow } }))
    w.files.delete(issueFile)
    return { exitCode: 0 }
  }
  const r = await tool($, 'waitFor', { shell_command: 'check' })
  expect(r.isError).toBe(false)
  expect(r.text).not.toContain('is gone')
  await expectBackIn($, w, 'developing')
})

test('a wait outlasts a record that is away for a moment, and goes on', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const issueFile = `${ROOT}/.neil-dev.issue-7.json`
  w.s.probe = () => {
    const body = w.files.get(issueFile)!
    w.files.delete(issueFile)
    // The record comes back while the wait sleeps before its next read.
    w.s.sleepHold = { then: (done: () => void) => { w.files.set(issueFile, body); w.s.sleepHold = undefined; done() } } as unknown as Promise<void>
    return { exitCode: 0 }
  }
  const r = await tool($, 'waitFor', { shell_command: 'check' })
  expect(r.isError).toBe(false)
  expect(r.text).not.toContain('is gone')
  await expectBackIn($, w, 'developing')
})

test('a wait follows its own record when the agent goes to another issue mid-wait', async ($, on) => {
  const w = engine(on, { files: { [`${ROOT}/.neil-dev.issue-8.json`]: JSON.stringify({ version: 1, issue: 8, workflow: flow({ issue: 8, branch: 'issue-8', prs: [13], owner: undefined }) }) } })
  await start($, w)
  await tool($, 'started', { issue: 7 })
  let finish!: (v: { exitCode: number }) => void
  w.s.probe = () => new Promise(resolve => { finish = resolve })
  const call = tool($, 'waitFor', { issue: 7, shell_command: 'check' })
  await settle()
  expect(w.state(7)?.state).toBe('wait')
  await tool($, 'started', { issue: 8 })
  expect(w.state(8)?.owner?.session).toBe('s1')
  finish({ exitCode: 0 })
  const r = await call
  expect(r.text).not.toContain('A human moved')
  expect(r.text).toContain('ended after 1 checks')
  expect(w.state(7)?.state).toBe('developing')
})

test('an interrupt ends a wait whose record this agent left for another issue', async ($, on) => {
  const w = engine(on, { files: { [`${ROOT}/.neil-dev.issue-8.json`]: JSON.stringify({ version: 1, issue: 8, workflow: flow({ issue: 8, branch: 'issue-8', prs: [13], owner: undefined }) }) } })
  await start($, w)
  await tool($, 'started', { issue: 7 })
  let finish!: (v: { exitCode: number }) => void
  w.s.probe = () => new Promise(resolve => { finish = resolve }) // The host goes on without this hook.
  const call = tool($, 'waitFor', { issue: 7, shell_command: 'check' })
  await settle()
  await tool($, 'started', { issue: 8 })
  expect(w.state(7)?.owner).toBeUndefined()
  await turnEnds($, 'aborted')
  expect(w.state(7)?.state).toBe('developing')
  expect(w.state(7)?.waiting).toBeUndefined()
  finish({ exitCode: 1 })
  await call
  expect(w.state(7)?.state).toBe('developing')
})

test('the end of a turn ends a stopped wait on a PR record that no issue shows', async ($, on) => {
  const waiting = { id: 'old', tool: 'waitFor', what: 'old', at: 0 }
  const seven = flow({ state: 'developing', prs: [13] })
  const w = engine(on, { files: { [`${ROOT}/.neil-dev.issue-7.json`]: JSON.stringify({ version: 1, issue: 7, workflow: seven, prs: { 13: flow({ pr: 13, issues: [7], state: 'wait', previous: 'developing', waiting }) } }) } })
  await start($, w)
  await turnEnds($)
  expect(w.prRecord(13)?.state).toBe('developing')
  expect(w.prRecord(13)?.waiting).toBeUndefined()
})

test('/flow status tells the truth about a wait that nothing holds', async ($, on) => {
  engine(on, { wf: { state: 'wait', previous: 'ci', waiting: { id: 'old', tool: 'waitFor', what: 'old', at: 0 } } })
  await start($)
  const out = await command($, 'status')
  expect(out).not.toContain('A wait tool holds')
  expect(out).toContain('No wait tool runs')
  expect(out).toContain('started')
})

test('status names /unblock only for the record that /unblock reads', async ($, on) => {
  const waiting = { id: 'old', tool: 'waitFor', what: 'old', at: 0 }
  const w = engine(on, { files: { [`${ROOT}/.neil-dev.issue-8.json`]: JSON.stringify({ version: 1, issue: 8, workflow: flow({ issue: 8, branch: 'issue-8', prs: [13], owner: undefined, state: 'wait', previous: 'ci', waiting }) }) } })
  await start($, w)
  await tool($, 'started', { issue: 7 })
  const other = (await tool($, 'status', { issue: 8 })).text
  expect(other).toContain('No wait tool runs')
  expect(other).toContain('started with issue 8')
  expect(other).not.toContain('/unblock')
})

test('a failed read at the end of a turn does not claim that a wait is stuck', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.files.set(`${ROOT}/.neil-dev.issue-9.json`, '{ not json')
  await turnEnds($)
  const said = w.toasts.join('\n')
  expect(said).toContain('.neil-dev.issue-9.json')
  expect(said).not.toContain('the state stays "wait"')
  w.files.delete(`${ROOT}/.neil-dev.issue-9.json`)
})

test('a wait whose record does not come back says what it read and names the repair', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.probe = () => {
    w.files.delete(`${ROOT}/.neil-dev.issue-7.json`)
    w.files.delete(RECORD)
    return { exitCode: 0 }
  }
  const r = await tool($, 'waitFor', { shell_command: 'check' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('issue #7')
  expect(r.text).toContain(ROOT)
  expect(r.text).toContain('.neil-dev.worktree.json')
  expect(r.text).toContain('call started with issue 7')
  expect(r.text).not.toContain('The state stays "wait"')
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

// #661 in fcc-proto: /flow off answered "set-workflow exited 5 ... at revision 41, and this writer expected 40"
// and changed nothing, when the agent's own tool saved the record between the command's read and its write.
test('/flow off reads the record again and turns the workflow off when another writer gets in first', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.staleSaves = 1
  const text = await command($, 'off doing this by hand')
  expect(text).not.toContain('exited 5')
  expect(w.state()?.off).toMatchObject({ reason: 'doing this by hand' })
})

test('/flow off names its retries and the repair when another writer changes the record each time', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.staleSaves = 99
  const text = await command($, 'off by hand')
  expect(text).toContain('exited 5')
  expect(text).toContain('/flow off read the record again 3 times')
  expect(text).toContain('Repair:')
  expect(w.state()?.off).toBeUndefined()
})

// fcc-proto #465: /flow off found no record of this agent, so it turned the workflow off for the session and said
// "no reminder comes". A later tool call made this session the owner of #465, and the turn-end reminder came back.
test('/flow off for the session stops the reminders, also for a record that this session holds later', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  expect(await command($, 'off')).toContain('off for this session')
  w.files.set(RECORD, held(flow()))
  await turnEnds($)
  await idle(w)
  expect(w.prompts).toEqual([])
})

test('/flow off for the session names the records in the worktree, and their tools that move the state refuse', async ($, on) => {
  const w = engine(on, { wf: null, files: { [RECORD]: held(flow({ owner: undefined }), flow({ issue: 8, branch: 'issue-8', prs: [13], owner: undefined })) } })
  await start($, w)
  const said = await command($, 'off')
  expect(said).toContain('off for this session')
  expect(said).toContain('issue #7 in the state "developing"')
  expect(said).toContain('issue #8 in the state "developing"')
  const refused = await tool($, 'blocked', { issue: 7, message: 'stuck' })
  expect(refused.isError).toBe(true)
  expect(refused.text).toContain('turned the workflow off for this session')
  expect(refused.text).toContain('/flow on')
  expect(w.state()?.state).toBe('developing')
  expect(w.state()?.owner).toBeUndefined()
  const read = await tool($, 'status', { issue: 7 })
  expect(read.isError).toBe(false)
  expect(read.text).toContain('developing')
})

test('/flow off for the session leaves the tools that keep the state, such as addMigration', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  await command($, 'off')
  w.files.set(RECORD, held(flow()))
  const r = await tool($, 'addMigration', { issue: 7, name: 'add_table' })
  expect(r.text).not.toContain('turned the workflow off for this session')
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
  await tool($, 'finishedInterview', { issue: 7 })
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

test('a loop of new bugs stops at the hourly limit and says so', async ($, on) => {
  const w = engine(on)
  w.s.branch = 'main'
  for (let i = 0; i < 5; i++) await tool($, 'reportWorkflowBug', { title: `bug ${i}`, details: 'a' })
  const over = await tool($, 'reportWorkflowBug', { title: 'bug six', details: 'a' })
  expect(launches(w)).toHaveLength(5)
  expect(over.isError).toBe(true)
  expect(over.text).toContain('bug six')
  expect(over.text).toContain('limit')
})

test('the limit of bug agents frees up after an hour, and only then', async ($, on) => {
  const w = engine(on)
  w.s.branch = 'main'
  for (let i = 0; i < 5; i++) await tool($, 'reportWorkflowBug', { title: `bug ${i}`, details: 'a' })
  w.s.now += 3_599_000
  const inside = await tool($, 'reportWorkflowBug', { title: 'bug six', details: 'a' })
  expect(inside.isError).toBe(true)
  expect(inside.text).toContain('5 bug agents in an hour')
  w.s.now += 2_000
  const after = await tool($, 'reportWorkflowBug', { title: 'bug six', details: 'a' })
  expect(after.isError).toBe(false)
  expect(launches(w)).toHaveLength(6)
})

test('the same bug starts no second agent for 24 hours, past the hourly limit', async ($, on) => {
  const w = engine(on)
  w.s.branch = 'main'
  await tool($, 'reportWorkflowBug', { title: 'done refuses a clean tree', details: 'a' })
  w.s.now += 2 * 3_600_000
  const again = await tool($, 'reportWorkflowBug', { title: 'done refuses a clean tree', details: 'b' })
  expect(launches(w)).toHaveLength(1)
  expect(again.text).toContain('already')
  w.s.now += 22 * 3_600_000 + 1_000
  await tool($, 'reportWorkflowBug', { title: 'done refuses a clean tree', details: 'c' })
  expect(launches(w)).toHaveLength(2)
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

const TWO_AXES = { config: { mode: 'heavy' }, wf: { state: 'reviewing', prs: [12], hooks: { review: { firedAt: 1, agentId: 'r-1' } }, reviewSpec: { agentId: 'r-2' } } as never } as never

test('the report of each axis names that axis and what it is for', async ($, on) => {
  const w = engine(on, TWO_AXES)
  await start($, w)
  await $.turn.complete({ agentId: 'r-2', answer: 'Critical: the issue asks for b.ts:9' } as never)
  await settle()
  await $.turn.complete({ agentId: 'r-1', answer: 'Important: a.ts:3 breaks a written rule' } as never)
  await settle()
  const [spec, standards] = w.prompts.filter(p => p.includes('b.ts:9') || p.includes('a.ts:3'))
  expect(spec).toContain('The specification review of')
  expect(spec).toContain('whether the diff does all that the issue, the plan and the interview answers ask')
  expect(spec).toContain('The standards review gives its own report')
  expect(spec).toContain('when both reports have come')
  expect(standards).toContain('The standards review of')
  expect(standards).toContain('the rules that the repository wrote down')
  expect(standards).toContain('The specification review gives its own report')
})

test('the one reviewer of a light change says that it covers both questions', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing', prs: [12], hooks: { review: { firedAt: 1, agentId: 'r-1' } } } })
  await start($, w)
  await $.turn.complete({ agentId: 'r-1', answer: 'Critical: a.ts:3 loses the error' } as never)
  await settle()
  const said = w.prompts.join('\n')
  expect(said).toContain('The code review of')
  expect(said).toContain('the written rules of the repository and the issue')
  expect(said).not.toContain('gives its own report')
})

test('a failed axis is named, and its repair carries the question of that axis', async ($, on) => {
  const w = engine(on, TWO_AXES)
  await start($, w)
  await $.turn.complete({ agentId: 'r-2', answer: '', reason: 'error' } as never)
  await settle()
  const said = w.prompts.join('\n')
  expect(said).toContain('The specification review of')
  expect(said).toContain('failed')
  expect(said).toContain('Review axis: specification.')
})

test('a resume names the axis of each answer', async ($, on) => {
  const w = engine(on, { config: { mode: 'heavy' }, wf: { state: 'reviewing', prs: [12], hooks: { review: { firedAt: 1, agentId: 'r-1', answer: 'standards are fine' } }, reviewSpec: { agentId: 'r-2', answer: 'the spec is met' } } as never })
  await start($, w)
  const said = (await tool($, 'started', { issue: 7 })).text
  expect(said).toContain('The standards review answered:\nstandards are fine')
  expect(said).toContain('The specification review answered:\nthe spec is met')
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

test('the checks get NDEV_CHANGE_TYPES: the declared types, those recorded, and those of each path that differs from the merge base', async ($, on) => {
  const w = engine(on, { names: ['lib/a.ts', 'README.md'] })
  await start($, w)
  w.s.dirty = [' M lib/a.ts', ' M README.md']
  await tool($, 'checkpoint', { message: 'm', files: ['lib/a.ts', 'README.md'], changeTypes: ['web'] })
  for (const check of ['fast-checks.sh', 'pre-commit-check.sh', 'pre-push-check.sh']) expect(w.s.checkEnv[check]?.NDEV_CHANGE_TYPES).toBe('web,backend,docs')
  // The checks run before the commit: a staged path is the branch's change already, and a recorded type stays.
  w.s.names = ['lib/a.ts', 'README.md', 'supabase/migrations/1_a.sql']
  w.s.dirty = ['A  supabase/migrations/1_a.sql']
  await tool($, 'checkpoint', { message: 'n', files: ['supabase/migrations/1_a.sql'] })
  expect(w.s.checkEnv['pre-commit-check.sh']?.NDEV_CHANGE_TYPES).toBe('web,backend,database,docs')
})

test('when the branch paths cannot be read, the checks get no NDEV_CHANGE_TYPES and the answer says the scripts read their own diff', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.dirty = [' M a.ts']
  w.s.diffFails = 'fatal: bad revision'
  const r = await tool($, 'checkpoint', { message: 'm', files: ['a.ts'], changeTypes: ['web'] })
  expect(w.s.checkEnv['pre-commit-check.sh']?.NDEV_CHANGE_TYPES).toBeUndefined()
  expect(r.text).toContain('NDEV_CHANGE_TYPES was not set')
  expect(r.text).toContain('fatal: bad revision')
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
  expect(orcaVerbs(w)).toContain('screenshot')
  expect(w.orcaCalls.some(c => c[0] === 'wait' && c.includes('2000'))).toBe(true)
})

// Orca's full-screenshot and a viewport taller than its real surface both wrap and repeat the top of the page.
test('a full page taller than the viewport is taken in scrolled images that reach its end, and never with full-screenshot', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.pageHeight = 2000
  const r = await tool($, 'screenshot', { url: 'https://x.test/', viewports: ['320x640'], schemes: ['light'], fullPage: true })
  expect(r.isError).toBe(false)
  expect(orcaVerbs(w)).not.toContain('full-screenshot')
  expect(w.orcaCalls.filter(c => c[0] === 'viewport')).toHaveLength(1)
  // Each step overlaps the one before, so that a pinned header hides nothing, and the last reaches the end.
  expect(w.s.shotsAt).toEqual([0, 512, 1024, 1360])
  expect(w.copies).toEqual([1, 2, 3, 4].map(n => `${SHOTS}/x-test-home-320x640-light-part${n}.png`))
  expect(r.text).toContain('Saved 4 images')
  expect(r.text).toContain('-part4.png')
})

test('a full page with no end stops at the limit and says how much it did not take', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.pageHeight = 1_000_000
  const r = await tool($, 'screenshot', { url: 'https://x.test/', viewports: ['320x640'], schemes: ['light'], fullPage: true })
  expect(r.isError).toBe(false)
  expect(w.copies).toHaveLength(40)
  expect(r.text).toContain('not the whole page')
  expect(r.text).toContain('1000000')
})

test('a full page that will not scroll to its end says so', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.pageHeight = 2000
  w.s.stuckAt = 0
  const r = await tool($, 'screenshot', { url: 'https://x.test/', viewports: ['320x640'], schemes: ['light'], fullPage: true })
  expect(r.isError).toBe(false)
  expect(w.s.shotsAt).toEqual([0])
  expect(r.text).toContain('not the whole page')
})

test('a page that looks the same in light and dark gets a warning that names the images and the repair', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sameImages = true
  const r = await tool($, 'screenshot', { url: 'https://x.test/cart', viewports: ['320x640', '800x600'], schemes: ['light', 'dark'] })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('WARNING')
  expect(r.text).toContain('did not change between light and dark')
  expect(r.text).toContain(`${SHOTS}/x-test-cart-320x640-dark.png`)
  expect(r.text).toContain(`${SHOTS}/x-test-cart-800x600-dark.png`)
  expect(r.text).toContain('orca storage local set')
})

test('a page that changes between light and dark gets no warning, and one scheme is not compared', async ($, on) => {
  const w = engine(on)
  await start($, w)
  expect((await tool($, 'screenshot', { url: 'https://x.test/cart', viewports: ['320x640'] })).text).not.toContain('WARNING')
  w.s.sameImages = true
  expect((await tool($, 'screenshot', { url: 'https://x.test/cart', viewports: ['320x640'], schemes: ['dark'] })).text).not.toContain('WARNING')
})

test('a comparison that cannot run is a refusal that names the files and the cause', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.cmpFails = 'cmp: No such file or directory'
  const r = await tool($, 'screenshot', { url: 'https://x.test/cart', viewports: ['320x640'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('exited 2')
  expect(r.text).toContain('No such file')
  expect(r.text).toContain(`${SHOTS}/x-test-cart-320x640-dark.png`)
  expect(orcaVerbs(w).at(-1)).toBe('tab close')
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

// ---- the line under the prompt during a long tool call ----
test('a long tool call shows its name, its step and the time under the prompt, and the line goes back when it ends', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const shownBefore = w.statuses.at(-1)
  let release = () => {}
  w.s.checkHold = new Promise<void>(resolve => { release = resolve })
  const held = tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  await settle()
  expect(w.statuses.filter(x => x?.includes('checkpoint'))).toEqual([])
  w.s.now += 125_000
  w.timers.splice(0).forEach(fire => fire())
  await settle()
  const line = w.statuses.at(-1)!
  expect(line).toContain(String(shownBefore))
  expect(line).toContain('checkpoint 2m 5s')
  expect(line).toMatch(/fast-checks\.sh 2m 5s of at most 1h 0m/)
  release()
  expect((await held).isError).toBe(false)
  expect(w.statuses.at(-1)).toBe(shownBefore)
})

test('a short tool call does not write the status line', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const before = w.statuses.length
  await tool($, 'status')
  expect(w.statuses.length).toBe(before)
})

test('a call that waits behind a long call does not take its line', async ($, on) => {
  const w = engine(on)
  await start($, w)
  let release = () => {}
  w.s.checkHold = new Promise<void>(resolve => { release = resolve })
  const held = tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  await settle()
  const queued = tool($, 'status')
  await settle()
  w.s.now += 125_000
  w.timers.splice(0).forEach(fire => fire())
  await settle()
  const line = w.statuses.at(-1)!
  expect(line).toContain('checkpoint 2m 5s')
  expect(line).toContain('fast-checks.sh')
  expect(w.statuses.filter(x => x?.includes('ndev status'))).toEqual([])
  release()
  await held
  await queued
})

test('a tool call that fails puts the line back too, and a wait tool has its own display and adds no line', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const shownBefore = w.statuses.at(-1)
  let release = () => {}
  w.s.checkHold = new Promise<void>(resolve => { release = resolve })
  w.s.failCheck = 'fast-checks'
  const held = tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  await settle()
  w.timers.splice(0).forEach(fire => fire())
  await settle()
  expect(w.statuses.at(-1)).toContain('checkpoint')
  release()
  expect((await held).isError).toBe(true)
  expect(w.statuses.at(-1)).toBe(shownBefore)
  w.s.sleepAdvances = true
  const before = w.statuses.length
  await tool($, 'waitForSeconds', { secs: 1 })
  expect(w.statuses.length).toBe(before)
})

// ---- waitForState ----
const OTHER = '/other'
const RECORD_BASE = { root: OTHER, repo: 'o/r', base: 'main', branch: 'b', evidence: {}, attempts: 0, nudges: { count: 0 }, followUps: [], history: [] }
const putIssue = (w: W, issue: number, record: Record<string, unknown>) => w.files.set(`${OTHER}/.neil-dev.issue-${issue}.json`, JSON.stringify({ version: 1, issue, workflow: { ...RECORD_BASE, issue, prs: [], state: 'developing', ...record } }))
const startForState = async ($: Dollar, on: On) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  w.s.otherWorktrees = [OTHER]
  return w
}

test('waitForState holds until an issue in another worktree reaches the state, with no GitHub call, and the state goes back', async ($, on) => {
  const w = await startForState($, on)
  putIssue(w, 9, { state: 'developing' })
  const before = w.gh.length
  let release = () => {}
  w.s.sleepHold = new Promise<void>(resolve => { release = resolve })
  const held = tool($, 'waitForState', { issue_id: 9, state: 'ci', period: 60 })
  await settle()
  expect(w.state()?.state).toBe('wait')
  putIssue(w, 9, { state: 'ci' })
  release()
  const r = await held
  expect(r.isError).toBe(false)
  expect(r.text).toContain('Issue #9')
  expect(r.text).toContain('state "ci"')
  expect(w.gh.length).toBe(before)
  expect(w.state()?.state).toBe('developing')
})

test('waitForState does not hold for a state that the issue is already past or passed through during the wait', async ($, on) => {
  const w = await startForState($, on)
  putIssue(w, 9, { state: 'smoke' })
  const past = await tool($, 'waitForState', { issue_id: 9, state: 'reviewing', period: 60 })
  expect(past.isError).toBe(false)
  expect(past.text).toContain('past "reviewing"')
  putIssue(w, 9, { state: 'developing', history: [{ at: w.s.now, tool: 'blocked', from: 'developing', to: 'blocked' }, { at: w.s.now, tool: 'unblocked', from: 'blocked', to: 'developing' }] })
  const through = await tool($, 'waitForState', { issue_id: 9, state: 'blocked', period: 60 })
  expect(through.isError).toBe(false)
  expect(through.text).toContain('during this wait')
})

test('waitForState follows an issue into its PR record, and reads a blocked issue as still at its stage', async ($, on) => {
  const w = await startForState($, on)
  w.files.set(`${OTHER}/.neil-dev.issue-9.json`, JSON.stringify({ version: 1, issue: 9, workflow: { ...RECORD_BASE, issue: 9, prs: [44], state: 'developed' }, prs: { 44: { ...RECORD_BASE, issue: 9, issues: [9], pr: 44, prs: [44], state: 'ci' } } }))
  const r = await tool($, 'waitForState', { issue_id: 9, state: 'ci', period: 60 })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('PR #44')
  putIssue(w, 10, { state: 'blocked', previous: 'developing' })
  const held = await tool($, 'waitForState', { issue_id: 10, state: 'reviewing', period: 60, attempts: 2 })
  expect(held.isError).toBe(true)
  expect(held.text).toContain('gave up')
})

test('waitForState ends for an issue held at the state or past it, and holds for a sign-off that has not yet reached it', async ($, on) => {
  const w = await startForState($, on)
  const reached = [{ at: 1, tool: 'finishedReview', from: 'reviewing', to: 'ci' }]
  w.s.now += 10_000
  putIssue(w, 9, { state: 'blocked', previous: 'ci', history: reached })
  const atState = await tool($, 'waitForState', { issue_id: 9, state: 'ci', period: 60, attempts: 2 })
  expect(atState.isError).toBe(false)
  expect(atState.text).toContain('held in "blocked"')
  putIssue(w, 10, { state: 'wait', previous: 'revising', history: reached })
  const past = await tool($, 'waitForState', { issue_id: 10, state: 'reviewing', period: 60, attempts: 2 })
  expect(past.isError).toBe(false)
  expect(past.text).toContain('past "reviewing"')
  putIssue(w, 11, { state: 'blocked', previous: 'developing', history: [{ at: 1, tool: 'finishedPlan', from: 'planning', to: 'blocked' }] })
  const signOff = await tool($, 'waitForState', { issue_id: 11, state: 'developing', period: 60, attempts: 2 })
  expect(signOff.isError).toBe(true)
  expect(signOff.text).toContain('gave up')
})

test('waitForState ends at once when the issue is done or off and did not reach the state, and says so', async ($, on) => {
  const w = await startForState($, on)
  putIssue(w, 9, { state: 'done' })
  const done = await tool($, 'waitForState', { issue_id: 9, state: 'revising', period: 60 })
  expect(done.text).toContain('did not reach the state "revising"')
  putIssue(w, 10, { state: 'developing', off: true })
  const off = await tool($, 'waitForState', { issue_id: 10, state: 'ci', period: 60 })
  expect(off.text).toContain('workflow off')
})

test('waitForState goes on for an issue with no record, names a file it cannot read, and names the exit code of a failed worktree list', async ($, on) => {
  const w = await startForState($, on)
  const none = await tool($, 'waitForState', { issue_id: 9, state: 'ci', period: 60, attempts: 2 })
  expect(none.isError).toBe(true)
  expect(none.text).toContain('has no workflow record')
  expect(none.text).toContain(OTHER)
  w.files.set(`${OTHER}/.neil-dev.worktree.json`, 'not json')
  const unread = await tool($, 'waitForState', { issue_id: 9, state: 'ci', period: 60, attempts: 1 })
  expect(unread.isError).toBe(true)
  expect(unread.text).toContain('Not read')
  w.s.worktreeListFails = 'not a git repository'
  const failed = await tool($, 'waitForState', { issue_id: 9, state: 'ci', period: 60, attempts: 1 })
  expect(failed.isError).toBe(true)
  expect(failed.text).toContain('exit code 128: not a git repository')
})

test('waitForState refuses a state that is not a workflow state, a missing issue, and the issue that this agent is on', async ($, on) => {
  const w = await startForState($, on)
  const bad = await tool($, 'waitForState', { issue_id: 9, state: 'green' })
  expect(bad.isError).toBe(true)
  expect(bad.text).toContain('finishing')
  expect((await tool($, 'waitForState', { state: 'ci' })).text).toContain('issue_id')
  const own = await tool($, 'waitForState', { issue_id: 7, state: 'ci' })
  expect(own.isError).toBe(true)
  expect(own.text).toContain('this agent is on it')
  expect(w.state()?.state).toBe('developing')
  const specs = registeredTools as { name: string; inputSchema: { required: string[]; properties: Record<string, { enum?: string[] }> } }[]
  const schema = specs.find(x => x.name === 'waitForState')!.inputSchema
  expect(schema.required).toEqual(expect.arrayContaining(['issue_id', 'state']))
  expect(schema.properties.state!.enum).toContain('wait')
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

test('a PR that has merged takes no new issue: it goes to a new worktree, and the answer names the state', async ($, on) => {
  const w = engine(on, { wf: { state: 'done', merged: true }, pr: pull({ state: 'closed', merged: true }) })
    await start($, w)
    const r = await tool($, 'started', { issue: 31, shortName: 'more-work' })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('PR #12 of /proj is merged')
    expect(w.s.claims).toEqual(['/main 31 origin/main'])
    expect(w.issueRecord(31)).toBeUndefined()
})

test('a PR that was closed with no merge takes no new issue: it goes to a new worktree, and the answer names the state', async ($, on) => {
  const w = engine(on, { wf: { state: 'done' }, pr: pull({ state: 'closed' }) })
    await start($, w)
    const r = await tool($, 'started', { issue: 31, shortName: 'more-work' })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('PR #12 of /proj is closed')
    expect(w.s.claims).toEqual(['/main 31 origin/main'])
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

test('addMigration refuses a listed migration whose file is gone, and names the repair', async ($, on) => {
  const w = engine(on, { wf: { state: 'smoke', migrations: [{ name: 'audiences', path: 'supabase/migrations/20261105153912_audiences.sql' }] } })
  w.files.set(`${ROOT}/supabase/config.toml`, '')
  await start($, w)
  const r = await tool($, 'addMigration', { name: 'audiences' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain(`${ROOT}/supabase/migrations/20261105153912_audiences.sql does not exist`)
  expect(r.text).toContain('newVersion')
})

test('addMigration with newVersion gives a listed migration a new version, carries its SQL and lists the new path only', async ($, on) => {
  const old = 'supabase/migrations/20261105153912_audiences.sql'
  const w = engine(on, { wf: { state: 'smoke', migrations: [{ name: 'audiences', path: old }] } })
  w.files.set(`${ROOT}/supabase/config.toml`, '')
  w.files.set(`${ROOT}/${old}`, 'create table t();\n')
  w.s.now = Date.UTC(2026, 10, 5, 16, 30, 0)
  await start($, w)
  const r = await tool($, 'addMigration', { name: 'audiences', newVersion: true })
  expect(r.isError).toBe(false)
  const fresh = 'supabase/migrations/20261105163000_audiences.sql'
  expect(w.files.get(`${ROOT}/${fresh}`)).toBe('create table t();\n')
  expect(r.text).toContain(`${ROOT}/${fresh}`)
  expect(r.text).toContain(`delete ${ROOT}/${old}`)
  const body = w.files.get(bodyFile(w))!
  expect(body).toContain(fresh)
  expect(body).not.toContain(old)
})

test('addMigration gives a version after the newest migration file, when that file is dated after the clock', async ($, on) => {
  const old = 'supabase/migrations/20261105153912_audiences.sql'
  const w = engine(on, { wf: { state: 'smoke', migrations: [{ name: 'audiences', path: old }] } })
  w.files.set(`${ROOT}/supabase/config.toml`, '')
  w.files.set(`${ROOT}/${old}`, 'create table t();\n')
  w.files.set(`${ROOT}/supabase/migrations/20261109235959_future_dated.sql`, 'select 1;\n')
  w.s.now = Date.UTC(2026, 10, 9, 12, 39, 18)
  await start($, w)
  const r = await tool($, 'addMigration', { name: 'audiences', newVersion: true })
  expect(r.isError).toBe(false)
  expect(w.files.get(`${ROOT}/supabase/migrations/20261110000000_audiences.sql`)).toBe('create table t();\n')
  const added = await tool($, 'addMigration', { name: 'other_one' })
  expect(added.isError).toBe(false)
  expect(w.files.has(`${ROOT}/supabase/migrations/20261110000001_other_one.sql`)).toBe(true)
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
  expect(seen).toMatchObject({ tool: 'waitFor', period: 30, most: 4, timeoutS: 90 })
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

// A session in a worktree cannot change its folder to the main checkout, so started claims the new
// worktree from the main checkout for it, and the merged PR gets nothing new.
for (const owner of [undefined, { session: 'other', at: 0 }]) {
  test(`started in a worktree whose PR has merged claims a new worktree from the main checkout (${owner ? 'another session' : 'this session'})`, async ($, on) => {
    const w = engine(on, { wf: { state: 'done', ...(owner ? { owner } : {}) }, pr: { state: 'closed', merged: true } })
    await start($, w)
    const r = await tool($, 'started', { issue: 9, shortName: 'new-thing' })
    expect(r.text).not.toContain('Refused')
    expect(r.isError).toBe(false)
    expect(w.s.claims).toEqual(['/main 9 origin/main'])
    expect(r.text).toContain('/claimed/issue-7')
    expect(w.issueRecord(9)).toBeUndefined()
  })
}

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

// ---- the interview ----
const INTERVIEW_FILE = `${ROOT}/.neil-dev.issue-7.json`
const INTERVIEW_PANE = { plugin: 'ndev', component: 'Pane', requestId: 'interview', props: { title: 'Interview', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const
const ROUND = {
  title: 'The login page',
  intro: 'First round.',
  questions: [
    { id: 'store', header: 'Session store', question: 'Where do **sessions** live?', context: 'They outlive a deploy.', options: [{ label: 'Redis', description: 'Fast and shared.', recommended: true }, { label: 'Cookie', preview: '`set-cookie: s=...`' }] },
    { id: 'name', header: 'Cookie name', question: 'What name?', suggested: 'sid' },
    { id: 'browsers', header: 'Browsers', question: 'Which browsers?', multiSelect: true, options: [{ label: 'Safari', recommended: true }, { label: 'Chrome', recommended: true }, { label: 'Edge' }] },
  ],
}
const asking = (extra: Record<string, unknown> = {}) => ({ state: 'interviewing', steering: 'interactive', ...extra })
const human = async ($: Dollar, w: W) => {
  w.s.sleepYields = true // A round's loop must leave room for the test's own timers.
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await settle()
  w.gh.length = 0
}
// The call holds until the pane ends it. The kit cannot mount while a loop spins, so the fake sleep stays
// pending while the test works the pane: tick lets one more pass of the loop run, and done ends the hold.
const round = async ($: Dollar, w: W, json: unknown = ROUND, surface: 'terminal' | 'mobile' = 'terminal') => {
  let wake = () => {}
  const hold = () => { w.s.sleepHold = new Promise<void>(resolve => { wake = resolve }) }
  hold()
  const answer = tool($, 'interview', { interviewJson: json })
  await settle()
  const tick = async () => { const go = wake; hold(); go(); await settle() }
  const done = () => { const go = wake; w.s.sleepHold = Promise.resolve(); go(); return answer }
  return { done, tick, ui: await $.ui.mount({ ...INTERVIEW_PANE, surface }) }
}
const answersIn = (r: { text: string }) => JSON.parse(r.text.split('\n')[0]!) as { answers: { id: string; selected: string[]; other?: string; notes?: string; source?: string }[]; trustMeBro?: boolean; dismissed?: boolean; notAnswered?: string[] }
const interviewFile = (w: W) => JSON.parse(w.files.get(INTERVIEW_FILE)!) as { rounds: { answers: unknown[] }[]; draft?: Record<string, { selected: string[] }>; commentIds?: { issue?: number; pr?: number }; posted?: boolean; closed?: { asked: boolean }; startedByFollowUp?: { of: number } }

test('started asks first under interactive steering, and goes past the interview under auto', async ($, on) => {
  const w = engine(on, { wf: null, config: { mode: 'heavy', steering: 'interactive' } })
  await human($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(w.state()?.state).toBe('interviewing')
  expect(w.state()?.prs).toEqual([12])
  expect(r.text).toContain('ndev:interview')
  expect(w.files.get(`/main/.git/info/exclude`)).toContain('.neil-dev.issue-*.json')
})

test('the answers and the record share the issue file, and neither writer loses the other', async ($, on) => {
  const w = engine(on, { wf: null, config: { mode: 'light', steering: 'interactive' } })
  await human($, w)
  await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(w.state()?.state).toBe('interviewing')
  const r = await tool($, 'interview')
  expect(r.isError).toBe(false)
  const held = JSON.parse(w.files.get(INTERVIEW_FILE)!)
  expect(held.closed?.asked).toBe(false)
  expect(held.rounds).toEqual([])
  expect(held.workflow.state).toBe('developing')
  expect(w.state()?.state).toBe('developing')
})

test('a hand-over gives the worker the answers of the parent and not its workflow', async ($, on) => {
  const parent = { version: 1, issue: 3, rounds: [{ title: 'R', questions: [], answers: [], at: 1 }], workflow: { issue: 3, state: 'ci', rev: 4 }, prs: { 12: { issue: 3, pr: 12, rev: 2 } } }
  const handOver = '/main/.git/ndev-interview-handover-7.json'
  const w = engine(on, { wf: null, config: { mode: 'heavy', steering: 'interactive' }, files: { [handOver]: JSON.stringify({ followUpOf: 3, at: 5, files: [{ name: '.neil-dev.issue-3.json', text: JSON.stringify(parent) }] }) } })
  await human($, w)
  await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  const child = JSON.parse(w.files.get(`${ROOT}/.neil-dev.issue-3.json`)!)
  expect(child.rounds).toEqual(parent.rounds)
  expect(child.workflow).toBeUndefined()
  expect(child.prs).toBeUndefined()
})

test('a hand-over into a file that holds only a workflow still marks the follow-up, and keeps the workflow', async ($, on) => {
  const handOver = '/main/.git/ndev-interview-handover-7.json'
  const record = flow(asking({ mode: 'heavy' }))
  const w = engine(on, { wf: null, config: { steering: 'interactive' }, files: { [INTERVIEW_FILE]: JSON.stringify({ version: 1, issue: 7, workflow: record }), [handOver]: JSON.stringify({ followUpOf: 3, at: 5, files: [] }) } })
  await human($, w)
  await tool($, 'started', { issue: 7 })
  const held = JSON.parse(w.files.get(INTERVIEW_FILE)!)
  expect(held.startedByFollowUp).toEqual({ of: 3, at: 5 })
  expect(held.workflow.issue).toBe(7)
})

test('a worker passes on the answers that it was handed, though it has no workflow for them', async ($, on) => {
  const w = engine(on, { wf: { mode: 'heavy' }, config: { steering: 'interactive' }, files: { [`${ROOT}/.neil-dev.issue-3.json`]: JSON.stringify({ version: 1, issue: 3, rounds: [{ title: 'R', questions: [], answers: [], at: 1 }] }) } })
  await human($, w)
  w.s.orcaOn = true
  await tool($, 'followUp', { mode: 'worktree', message: 'Add the child\nThe body' })
  const left = [...w.files.keys()].find(k => k.startsWith('/main/.git/ndev-interview-handover-'))
  expect(JSON.parse(w.files.get(left!)!).files.map((f: { name: string }) => f.name)).toContain('.neil-dev.issue-3.json')
})

test('a round shows rich text; Select and Input change the answers that the agent gets; the file and both comments hold them', async ($, on) => {
  const w = engine(on, { wf: asking({ mode: 'heavy' }) })
  await human($, w)
  const { done, ui } = await round($, w)
  expect((await ui.find({ key: 'question' }))?.text).toContain('Where do **sessions** live?')
  expect((await ui.find({ key: 'context' }))?.text).toContain('They outlive a deploy.')
  expect((await ui.find({ key: 'options' }))?.text).toContain('`set-cookie: s=...`')
  await ui.select({ key: 'pick-store', value: 'Cookie' })
  await ui.input({ key: 'notes-store', text: 'Only for now.', kind: 'change' })
  await ui.press({ key: 'next' })
  await ui.input({ key: 'other-name', text: 'session', kind: 'change' })
  await ui.press({ key: 'next' })
  await ui.select({ key: 'pick-browsers', value: 'Edge' })
  await ui.select({ key: 'pick-browsers', value: 'Safari' })
  await ui.press({ key: 'next' })
  expect((await ui.find({ type: 'Text', text: /Session store/ }))?.text).toBe('Q1 Session store')
  expect((await ui.find({ type: 'Text', text: /Cookie/ }))?.text).toBe('✔ Cookie')
  expect((await ui.find({ type: 'Text', text: /Only for now/ }))?.text).toBe('Notes: Only for now.')
  await ui.press({ key: 'edit-name' })
  expect((await ui.find({ key: 'other-name' }))).toBeDefined()
  await ui.press({ key: 'back' })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'submit' })
  const r = await done()
  await ui.unmount()
  expect(r.isError).toBe(false)
  expect(answersIn(r).answers).toEqual([
    { id: 'store', selected: ['Cookie'], notes: 'Only for now.' },
    { id: 'name', selected: [], other: 'session' },
    { id: 'browsers', selected: ['Chrome', 'Edge'] },
  ])
  expect(w.state()?.state).toBe('interviewing')
  expect(w.state()?.asking).toBeUndefined()
  const file = interviewFile(w)
  expect(file.rounds[0]!.answers.length).toBe(3)
  expect(file.commentIds).toEqual({ issue: 1007, pr: 1012, prNumber: 12 })
  expect(file.posted).toBe(true)
  const posts = w.gh.filter(l => l.includes(' comment '))
  expect(posts.length).toBe(2)
  expect(posts[0]).toContain('ndev:interview issue=7')
})

test('the next round edits the two comments in place, and interview() goes on: planning when heavy', async ($, on) => {
  const w = engine(on, { wf: asking({ mode: 'heavy' }) })
  await human($, w)
  const one = await round($, w, { title: 'One', questions: [ROUND.questions[1]] })
  await one.ui.press({ key: 'next' })
  await one.ui.press({ key: 'submit' })
  await one.done()
  await one.ui.unmount()
  w.gh.length = 0
  const two = await round($, w, { title: 'Two', questions: [{ id: 'ttl', header: 'Lifetime', question: 'How long?', followUpTo: 'name', suggested: '1 day' }] })
  expect((await two.ui.find({ type: 'Text', text: /Follow-up/ }))?.text).toBe('Follow-up to Q1 · Q1 › Q2')
  const recap = (await two.ui.find({ key: 'recap' }))?.text
  expect(recap).toContain('What name?')
  expect(recap).toContain('sid')
  await two.ui.press({ key: 'next' })
  await two.ui.press({ key: 'submit' })
  await two.done()
  await two.ui.unmount()
  expect(w.gh.filter(l => l.includes(' comment ')).length).toBe(0)
  const edits = w.gh.filter(l => l.includes(' comment-edit '))
  expect(edits.map(l => l.split(' comment-edit ')[1]!.split(' ')[0])).toEqual(['1007', '1012'])
  const out = await tool($, 'interview')
  expect(out.isError).toBe(false)
  expect(w.state()?.state).toBe('planning')
  expect(interviewFile(w).closed?.asked).toBe(true)
})

test('a pause that the host aborts after it ran over does not end the round, as when the computer slept', async ($, on) => {
  const w = engine(on, { wf: asking() })
  await human($, w)
  w.s.sleepAborts = 2
  const { done, ui } = await round($, w, { title: 'One', questions: [ROUND.questions[1]] })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'submit' })
  const r = await done()
  await ui.unmount()
  expect(r.isError).toBe(false)
  expect(w.s.sleepAborts).toBe(0)
  expect(answersIn(r).answers.map(a => a.id)).toEqual(['name'])
})

test('a pause that cannot start still fails the round, and names the command and the cause', async ($, on) => {
  const w = engine(on, { wf: asking() })
  await human($, w)
  w.s.sleepFails = 'spawn sleep ENOENT'
  const answer = tool($, 'interview', { interviewJson: { title: 'One', questions: [ROUND.questions[1]] } })
  const r = await answer
  expect(r.isError).toBe(true)
  expect(r.text).toContain('sleep 2 exited 127 after 0ms in /proj')
  expect(r.text).toContain('sleep did not run')
})

test('a follow-up inside the round recaps the answer as it stands', async ($, on) => {
  const w = engine(on, { wf: asking() })
  await human($, w)
  const { done, ui } = await round($, w, { title: 'One', questions: [ROUND.questions[0], { id: 'ttl', header: 'Lifetime', question: 'How long?', followUpTo: 'store', suggested: '1 day' }] })
  await ui.select({ key: 'pick-store', value: 'Cookie' })
  await ui.press({ key: 'next' })
  expect((await ui.find({ key: 'recap' }))?.text).toContain('Cookie')
  await ui.press({ key: 'close' })
  await done()
  await ui.unmount()
})

test('the review is a list of questions and answers, with the follow-up, the earlier rounds and real buttons', async ($, on) => {
  const w = engine(on, { wf: asking({ mode: 'heavy' }) })
  await human($, w)
  const one = await round($, w, { title: 'One', questions: [ROUND.questions[1]] })
  await one.ui.press({ key: 'next' })
  await one.ui.press({ key: 'submit' })
  await one.done()
  await one.ui.unmount()
  const { done, ui } = await round($, w, { title: 'Two', questions: [ROUND.questions[0], { id: 'ttl', header: 'Lifetime', question: 'How long?', followUpTo: 'name', suggested: '1 day' }] })
  await ui.select({ key: 'pick-store', value: 'Cookie' })
  await ui.input({ key: 'notes-store', text: 'Only for now.', kind: 'change' })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'next' })
  expect((await ui.find({ type: 'Text', text: /earlier round/ }))?.text).toBe('Q1 was answered in an earlier round.')
  expect((await ui.find({ type: 'Text', text: /Session store/ }))?.text).toBe('Q2 Session store')
  expect((await ui.find({ key: 'question-store' }))?.text).toContain('Where do **sessions** live?')
  const answer = await ui.find({ type: 'Text', text: /Cookie/ })
  expect(answer?.text).toBe('✔ Cookie')
  expect(answer?.props.color).toBe('success')
  expect((await ui.find({ type: 'Text', text: /Only for now/ }))?.text).toBe('Notes: Only for now.')
  expect(await ui.find({ key: 'recap-store' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /Follow-up/ }))?.text).toBe('Follow-up to Q1 · Q1 › Q3')
  const recap = (await ui.find({ key: 'recap-ttl' }))?.text
  expect(recap).toContain('What name?')
  expect(recap).toContain('sid')
  expect((await ui.find({ key: 'edit-store' }))?.props.plain).toBeUndefined()
  const send = await ui.find({ key: 'submit' })
  expect(send?.props.variant).toBe('primary')
  expect(send?.props.autoFocus).toBe(true)
  await ui.press({ key: 'edit-ttl' })
  expect((await ui.find({ type: 'Text', text: /question 2 of 2/ }))?.text).toContain('question 2 of 2')
  await ui.press({ key: 'close' })
  await done()
  await ui.unmount()
})

test('a question with no answer does not go on, and says why', async ($, on) => {
  const w = engine(on, { wf: asking() })
  await human($, w)
  const { done, ui } = await round($, w, { title: 'One', questions: [ROUND.questions[1]] })
  await ui.input({ key: 'other-name', text: '', kind: 'change' })
  await ui.press({ key: 'next' })
  expect((await ui.find({ type: 'Text', text: /needs an answer/ }))?.text).toContain('Cookie name')
  await ui.press({ key: 'close' })
  await done()
  await ui.unmount()
})

test('Trust Me Bro keeps the answers given, fills in the recommendations, and stops the questions', async ($, on) => {
  const w = engine(on, { wf: asking({ mode: 'heavy' }) })
  await human($, w)
  const { done, ui } = await round($, w)
  await ui.select({ key: 'pick-store', value: 'Cookie' })
  await ui.press({ key: 'trust' })
  const r = await done()
  await ui.unmount()
  expect(answersIn(r).trustMeBro).toBe(true)
  expect(answersIn(r).answers.map(a => [a.id, a.selected[0] ?? a.other, a.source])).toEqual([['store', 'Cookie', undefined], ['name', 'sid', 'recommended'], ['browsers', 'Safari', 'recommended']])
  expect(r.text).toContain('assumption')
  const again = await tool($, 'interview', { interviewJson: { title: 'More', questions: [{ id: 'x', header: 'X', question: 'X?', suggested: 's' }] } })
  expect(again.isError).toBe(true)
  expect(again.text).toContain('Trust Me Bro')
  expect((await tool($, 'interview')).isError).toBe(false)
  expect(w.state()?.state).toBe('planning')
})

test('Close for now returns what was answered as dismissed, and the state stays', async ($, on) => {
  const w = engine(on, { wf: asking() })
  await human($, w)
  const { done, ui } = await round($, w)
  await ui.select({ key: 'pick-store', value: 'Cookie' })
  await ui.press({ key: 'close' })
  const r = await done()
  await ui.unmount()
  expect(answersIn(r).dismissed).toBe(true)
  expect(answersIn(r).answers.map(a => a.id)).toEqual(['store'])
  expect(answersIn(r).notAnswered).toEqual(['name', 'browsers'])
  expect(w.state()?.state).toBe('interviewing')
})

test('the pane says when no round is open, and on a phone it sends the human to the terminal', async ($, on) => {
  const w = engine(on, { wf: asking() })
  await human($, w)
  const empty = await $.ui.mount({ ...INTERVIEW_PANE, surface: 'terminal' })
  expect(await empty.find({ type: 'Text', text: /No interview/ })).toBeDefined()
  await empty.unmount()
  const { done, ui } = await round($, w, ROUND, 'mobile')
  expect(await ui.find({ type: 'Text', text: /Answer it in the terminal/ })).toBeDefined()
  await ui.unmount()
  const desk = await $.ui.mount({ ...INTERVIEW_PANE, surface: 'terminal' })
  await desk.press({ key: 'close' })
  await done()
  await desk.unmount()
})

test('a draft saved by an earlier call comes back, and the draft is saved while the round is open', async ($, on) => {
  const w = engine(on, { wf: asking(), files: { [INTERVIEW_FILE]: JSON.stringify({ version: 1, issue: 7, rounds: [], draft: { store: { selected: ['Cookie'], other: '', notes: 'kept', touched: true } } }) } })
  await human($, w)
  const { done, tick, ui } = await round($, w)
  await ui.press({ key: 'next' })
  await ui.input({ key: 'notes-name', text: 'typed', kind: 'change' })
  await tick()
  expect(JSON.parse(w.files.get(INTERVIEW_FILE)!).draft.name.notes).toBe('typed')
  await ui.press({ key: 'trust' })
  const r = await done()
  await ui.unmount()
  expect(answersIn(r).answers[0]).toEqual({ id: 'store', selected: ['Cookie'], notes: 'kept' })
  expect(interviewFile(w).draft).toBeUndefined()
})

test('the watchdog stays quiet while a round is open, and Orca shows that the human is needed', async ($, on) => {
  const w = engine(on, { wf: asking() })
  await human($, w)
  const { done, ui } = await round($, w)
  expect(w.state()?.asking).toBeDefined()
  expect(w.alerts.length).toBe(1)
  const before = w.prompts.length
  await idle(w)
  await idle(w)
  expect(w.prompts.length).toBe(before)
  await ui.press({ key: 'close' })
  await done()
  await ui.unmount()
  expect(w.state()?.asking).toBeUndefined()
})

test('no question goes to a human who is not there: auto and a session with no human refuse, and name the way on', async ($, on) => {
  const w = engine(on, { wf: asking({ steering: 'auto' }) })
  await human($, w)
  const auto = await tool($, 'interview', { interviewJson: ROUND })
  expect(auto.isError).toBe(true)
  expect(auto.text).toContain('auto steering')
  expect((await tool($, 'interview')).isError).toBe(false)
  expect(w.state()?.state).toBe('developing')
})

test('in a session with no human the round refuses and names setSteering', async ($, on) => {
  const w = engine(on, { wf: asking() })
  await start($, w)
  const r = await tool($, 'interview', { interviewJson: ROUND })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('setSteering')
  expect(w.state()?.state).toBe('interviewing')
})

test('a bad round refuses with each problem and opens no pane', async ($, on) => {
  const w = engine(on, { wf: asking() })
  await human($, w)
  const r = await tool($, 'interview', { interviewJson: { title: 'T', questions: [{ id: 'a', header: 'A', question: 'A?' }] } })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('suggested')
  expect(w.state()?.asking).toBeUndefined()
})

test('interview() with no questions goes on when light, and a heavy issue refuses it, naming /flow skip', async ($, on) => {
  const light = engine(on, { wf: asking({ mode: 'light' }) })
  await human($, light)
  const r = await tool($, 'interview')
  expect(r.isError).toBe(false)
  expect(r.text).toContain('No questions asked')
  expect(light.state()?.state).toBe('developing')
})

test('a heavy issue with no answers cannot leave by itself, and a human can skip it', async ($, on) => {
  const w = engine(on, { wf: asking({ mode: 'heavy' }) })
  await human($, w)
  const r = await tool($, 'interview')
  expect(r.isError).toBe(true)
  expect(r.text).toContain('/flow skip')
  expect(w.state()?.state).toBe('interviewing')
  await command($, 'skip no decisions are open')
  expect(w.state()?.state).toBe('planning')
})

test('when GitHub fails the agent still gets the answers and the failure, and the exit waits for the comments', async ($, on) => {
  const w = engine(on, { wf: asking() })
  await human($, w)
  w.s.ghFails = ' comment 7'
  const { done, ui } = await round($, w, { title: 'One', questions: [ROUND.questions[1]] })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'submit' })
  const r = await done()
  await ui.unmount()
  expect(answersIn(r).answers[0]!.other).toBe('sid')
  expect(r.text).toContain('gh.sh comment 7')
  expect(interviewFile(w).posted).toBe(false)
  const refused = await tool($, 'interview')
  expect(refused.isError).toBe(true)
  expect(refused.text).toContain('gh.sh comment 7')
  expect(w.state()?.state).toBe('interviewing')
  w.s.ghFails = ''
  expect((await tool($, 'interview')).isError).toBe(false)
  expect(w.state()?.state).toBe('developing')
  expect(interviewFile(w).commentIds?.issue).toBe(1007)
})

test('setSteering sets auto with a reason on the issue and the PR, leaves the interview, and takes nothing else', async ($, on) => {
  const w = engine(on, { wf: asking({ mode: 'heavy' }) })
  await human($, w)
  expect((await tool($, 'setSteering', { steering: 'interactive', reason: 'x' })).text).toContain('/flow steering interactive')
  expect((await tool($, 'setSteering', { steering: 'auto' })).text).toContain('needs a reason')
  expect(w.state()?.steering).toBe('interactive')
  const r = await tool($, 'setSteering', { steering: 'auto', reason: 'this run uses claude -p' })
  expect(r.isError).toBe(false)
  expect(w.state()?.steering).toBe('auto')
  expect(w.state()?.state).toBe('planning')
  const said = w.gh.filter(l => l.includes('this run uses claude -p'))
  expect(said.map(l => l.split(' comment ')[1]!.split(' ')[0])).toEqual(['7', '12'])
})

test('a followUp worker gets the interview files: the parent leaves them, and the child takes them at started', async ($, on) => {
  const parent = { version: 1, issue: 7, rounds: [{ title: 'R', questions: [], answers: [], at: 1 }] }
  const w = engine(on, { wf: { mode: 'heavy' }, config: { steering: 'interactive' }, files: { [INTERVIEW_FILE]: JSON.stringify(parent) } })
  await human($, w)
  w.s.orcaOn = true
  const r = await tool($, 'followUp', { mode: 'worktree', message: 'Add the child\nThe body' })
  expect(r.isError).toBe(false)
  const left = [...w.files.keys()].find(k => k.startsWith('/main/.git/ndev-interview-handover-'))
  expect(left).toBeDefined()
  expect(JSON.parse(w.files.get(left!)!).files[0].name).toBe('.neil-dev.issue-7.json')
  expect(w.orcaCalls.some(c => c.join(' ').includes('.neil-dev.issue-7.json'))).toBe(true)
})

test('the child of a followUp takes the answers at started, and a heavy child can leave with no questions', async ($, on) => {
  const parentFile = JSON.stringify({ version: 1, issue: 3, rounds: [{ title: 'R', questions: [], answers: [], at: 1 }] })
  const handOver = '/main/.git/ndev-interview-handover-7.json'
  const w = engine(on, { wf: null, config: { mode: 'heavy', steering: 'interactive' }, files: { [handOver]: JSON.stringify({ followUpOf: 3, at: 5, files: [{ name: '.neil-dev.issue-3.json', text: parentFile }] }) } })
  await human($, w)
  await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(w.state()?.state).toBe('interviewing')
  expect(JSON.parse(w.files.get(`${ROOT}/.neil-dev.issue-3.json`)!)).toEqual(JSON.parse(parentFile))
  expect(JSON.parse(w.files.get(INTERVIEW_FILE)!).startedByFollowUp).toEqual({ of: 3, at: 5 })
  const r = await tool($, 'interview')
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('planning')
})

// ---- the interview: what the review found ----
test('an Other answer replaces the recommendation, and a picked option replaces the Other answer', async ($, on) => {
  const w = engine(on, { wf: asking() })
  await human($, w)
  const { done, ui } = await round($, w, { title: 'One', questions: [ROUND.questions[0]] })
  await ui.input({ key: 'other-store', text: 'Memcached', kind: 'change' })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'submit' })
  const typed = answersIn(await done()).answers[0]!
  expect(typed.selected).toEqual([])
  expect(typed.other).toBe('Memcached')
  await ui.unmount()

  const again = await round($, w, { title: 'Two', questions: [{ ...ROUND.questions[0], id: 'store2' }] })
  await again.ui.input({ key: 'other-store2', text: 'Memcached', kind: 'change' })
  await again.ui.select({ key: 'pick-store2', value: 'Cookie' })
  await again.ui.press({ key: 'next' })
  await again.ui.press({ key: 'submit' })
  const picked = answersIn(await again.done()).answers[0]!
  expect(picked.selected).toEqual(['Cookie'])
  expect(picked.other).toBeUndefined()
  await again.ui.unmount()
})

test('leaving the interview runs the base check when light, so finishedInterview is not a second step', async ($, on) => {
  const w = engine(on, { wf: asking({ baseCheck: undefined }) })
  await human($, w)
  w.steps.length = 0
  const r = await tool($, 'interview')
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('developing')
  expect(w.steps).toContain('pre-commit-check.sh')
  expect(w.state()?.baseCheck).toMatchObject({ script: 'pre-commit-check.sh', exitCode: 0 })
  expect(r.text).not.toContain('call finishedInterview')
})

test('a base that fails names the failure when the interview ends, and the state still goes on', async ($, on) => {
  const w = engine(on, { wf: asking({ baseCheck: undefined }) })
  await human($, w)
  w.s.failCheck = 'pre-commit-check.sh'
  const r = await tool($, 'interview')
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('developing')
  expect(r.text).toContain('pre-commit-check.sh exited')
})

test('a heavy interview leaves the base check to finishedPlan', async ($, on) => {
  const answered = { version: 1, issue: 7, rounds: [{ title: 'R', questions: [], answers: [{ id: 'a', selected: ['x'], other: '', notes: '' }], at: 1 }], posted: true }
  const w = engine(on, { wf: asking({ mode: 'heavy', baseCheck: undefined }), files: { [INTERVIEW_FILE]: JSON.stringify(answered) } })
  await human($, w)
  w.steps.length = 0
  await tool($, 'interview')
  expect(w.state()?.state).toBe('planning')
  expect(w.steps).not.toContain('pre-push-check.sh')
})

test('the pane shows one round: a second issue is refused and the first round goes on', async ($, on) => {
  const seven = flow(asking())
  const eight = flow(asking({ issue: 8, prs: [13] }))
  const w = engine(on, { files: { [RECORD]: held(seven, eight) } })
  await human($, w)
  await tool($, 'started', { issue: 7 })
  const { done, ui } = await round($, w, { title: 'One', questions: [ROUND.questions[1]] })
  await tool($, 'started', { issue: 8 })
  const second = await tool($, 'interview', { interviewJson: { title: 'Two', questions: [ROUND.questions[1]] } })
  expect(second.isError).toBe(true)
  expect(second.text).toContain('for #7 is already open')
  await ui.press({ key: 'next' })
  await ui.press({ key: 'submit' })
  expect((await done()).isError).toBe(false)
  await ui.unmount()
})

test('a stale write while a finished round lets go is a warning: the answers still reach the agent', async ($, on) => {
  const w = engine(on, { wf: asking() })
  await human($, w)
  const { done, ui } = await round($, w, { title: 'One', questions: [ROUND.questions[1]] })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'submit' })
  w.s.staleSaves = 1
  const r = await done()
  expect(r.isError).toBe(false)
  expect(answersIn(r).answers[0]!.id).toBe('name')
  expect(interviewFile(w).rounds.length).toBe(1)
  await ui.unmount()
})

test('a write that fails while the round ends keeps the answers in the draft', async ($, on) => {
  const w = engine(on, { wf: asking() })
  await human($, w)
  const { done, ui } = await round($, w, { title: 'One', questions: [ROUND.questions[1]] })
  await ui.input({ key: 'other-name', text: 'mine', kind: 'change' })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'submit' })
  let writes = 0
  w.s.failWrite = (path: string) => path === INTERVIEW_FILE && ++writes > 1
  const r = await done()
  expect(r.isError).toBe(true)
  expect(interviewFile(w).draft?.name).toMatchObject({ other: 'mine' })
  await ui.unmount()
})

test('with no PR yet, the interview does not count as posted, and the exit names started', async ($, on) => {
  const w = engine(on, { wf: asking({ prs: [] }) })
  await human($, w)
  const { done, ui } = await round($, w, { title: 'One', questions: [ROUND.questions[1]] })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'submit' })
  await done()
  await ui.unmount()
  expect(interviewFile(w).posted).toBe(false)
  const r = await tool($, 'interview')
  expect(r.isError).toBe(true)
  expect(r.text).toContain('call started')
  expect(w.state()?.state).toBe('interviewing')
})

const POSTED_ONCE = { version: 1, issue: 7, rounds: [{ title: 'R', questions: [], answers: [{ id: 'a', selected: ['x'], other: '', notes: '' }], at: 1 }], commentIds: { issue: 55, pr: 66 } }

test('a comment that was deleted is posted again', async ($, on) => {
  const file = POSTED_ONCE
  const w = engine(on, { wf: asking(), files: { [INTERVIEW_FILE]: JSON.stringify(file) } })
  await human($, w)
  w.s.editFails = 'gh: Not Found (HTTP 404)'
  expect((await tool($, 'interview')).isError).toBe(false)
  expect(interviewFile(w).commentIds).toEqual({ issue: 1007, pr: 1012, prNumber: 12 })
})

test('another failure of a comment edit names the command, and the issue stays', async ($, on) => {
  const down = engine(on, { wf: asking(), files: { [INTERVIEW_FILE]: JSON.stringify(POSTED_ONCE) } })
  await human($, down)
  down.s.editFails = 'gh: HTTP 502'
  const r = await tool($, 'interview')
  expect(r.isError).toBe(true)
  expect(r.text).toContain('comment-edit 55')
  expect(r.text).toContain('HTTP 502')
  expect(down.state()?.state).toBe('interviewing')
})

test('setSteering out of the interview posts what is not posted, closes the file, and withdraws a left alert', async ($, on) => {
  const file = { version: 1, issue: 7, rounds: [{ title: 'R', questions: [], answers: [{ id: 'a', selected: ['x'], other: '', notes: '' }], at: 1 }], posted: false }
  const w = engine(on, { wf: asking({ asking: { at: 1, group: 'g' } }), files: { [INTERVIEW_FILE]: JSON.stringify(file) } })
  await human($, w)
  const r = await tool($, 'setSteering', { steering: 'auto', reason: 'no human' })
  expect(r.isError).toBe(false)
  expect(interviewFile(w).posted).toBe(true)
  expect(interviewFile(w).closed).toBeDefined()
  expect(w.alerts).toContain('withdraw')
  expect(w.state()?.asking).toBeUndefined()
})

test('/flow skip out of the interview withdraws a left alert', async ($, on) => {
  const w = engine(on, { wf: asking({ asking: { at: 1, group: 'g' } }) })
  await human($, w)
  await command($, 'skip the human decides')
  expect(w.state()?.state).toBe('developing')
  expect(w.alerts).toContain('withdraw')
  expect(w.state()?.asking).toBeUndefined()
})

test('a new round withdraws the alert that a reload left', async ($, on) => {
  const w = engine(on, { wf: asking({ asking: { at: 1, group: 'old' } }) })
  await human($, w)
  const { done, ui } = await round($, w, { title: 'One', questions: [ROUND.questions[1]] })
  expect(w.alerts[0]).toBe('withdraw')
  await ui.press({ key: 'close' })
  await done()
  await ui.unmount()
})

test('a pane that cannot show lets go of the notification and of the round', async ($, on) => {
  const w = engine(on, { wf: asking() })
  await human($, w)
  w.s.staleSaves = 1
  const r = await tool($, 'interview', { interviewJson: { title: 'One', questions: [ROUND.questions[1]] } })
  expect(r.isError).toBe(true)
  expect(w.alerts).toEqual(['raise', 'withdraw'])
  expect(w.state()?.asking).toBeUndefined()
  w.s.sleepYields = true
  const again = await round($, w, { title: 'Two', questions: [ROUND.questions[1]] })
  await again.ui.press({ key: 'close' })
  expect((await again.done()).isError).toBe(false)
  await again.ui.unmount()
})

test('a human who thinks for a long time keeps the workflow: the hold refreshes the owner', async ($, on) => {
  const w = engine(on, { wf: asking({ owner: { session: 's1', at: 0 } }) })
  await human($, w)
  const { done, tick, ui } = await round($, w, { title: 'One', questions: [ROUND.questions[1]] })
  w.s.now += 6 * 60_000
  await tick()
  await tick()
  expect(w.state()?.owner?.at).toBeGreaterThan(5 * 60_000)
  await ui.press({ key: 'close' })
  await done()
  await ui.unmount()
})

test('a worker that does not start takes back its hand-over, so a later issue is not relaxed by it', async ($, on) => {
  const parent = { version: 1, issue: 7, rounds: [{ title: 'R', questions: [], answers: [], at: 1 }] }
  const w = engine(on, { wf: { mode: 'heavy' }, config: { steering: 'interactive' }, files: { [INTERVIEW_FILE]: JSON.stringify(parent) } })
  await human($, w)
  w.s.orcaOn = true
  w.s.workerReceipt = { state: 'failed', lastError: 'no room', failedStage: 'spawn' }
  const r = await tool($, 'followUp', { mode: 'worktree', message: 'Add the child\nThe body' })
  expect(r.isError).toBe(true)
  expect([...w.files.keys()].some(k => k.startsWith('/main/.git/ndev-interview-handover-'))).toBe(false)
  expect(r.text).toContain('no room')
})

test('a hand-over that cannot be taken back names its file and the repair', async ($, on) => {
  const parent = { version: 1, issue: 7, rounds: [{ title: 'R', questions: [], answers: [], at: 1 }] }
  const w = engine(on, { wf: { mode: 'heavy' }, config: { steering: 'interactive' }, files: { [INTERVIEW_FILE]: JSON.stringify(parent) } })
  await human($, w)
  w.s.orcaOn = true
  w.s.workerReceipt = { state: 'failed', lastError: 'no room', failedStage: 'spawn' }
  w.s.rmFails = 'rm: read-only file system'
  const r = await tool($, 'followUp', { mode: 'worktree', message: 'Add the child\nThe body' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('read-only file system')
  expect(r.text).toContain('Repair: delete it')
  expect(r.text).toContain('ndev-interview-handover-')
})

test('the record says a new round is not posted before the post starts, so a crash cannot lose the post', async ($, on) => {
  const earlier = { version: 1, issue: 7, rounds: [{ title: 'R', questions: [], answers: [{ id: 'a', selected: ['x'], other: '', notes: '' }], at: 1 }], commentIds: { issue: 55, pr: 66 }, posted: true }
  const w = engine(on, { wf: asking(), files: { [INTERVIEW_FILE]: JSON.stringify(earlier) } })
  await human($, w)
  const seen: unknown[] = []
  w.s.failWrite = (path: string) => {
    if (path === INTERVIEW_FILE) seen.push(JSON.parse(w.files.get(path)!).posted)
    return false
  }
  const { done, ui } = await round($, w, { title: 'One', questions: [ROUND.questions[1]] })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'submit' })
  expect((await done()).isError).toBe(false)
  await ui.unmount()
  expect(seen).toContain(false)
  expect(interviewFile(w).posted).toBe(true)
})

test('a parent interview file that cannot be read names the file and the cause', async ($, on) => {
  const w = engine(on, { wf: { mode: 'heavy' }, config: { steering: 'interactive' } })
  await human($, w)
  w.s.orcaOn = true
  w.s.failRead = (path: string) => path === INTERVIEW_FILE
  const r = await tool($, 'followUp', { mode: 'worktree', message: 'Add the child\nThe body' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain(INTERVIEW_FILE)
  expect(w.orcaCalls.some(c => c.join(' ').includes('worktree create'))).toBe(false)
  expect(r.text).toContain('Repair: fix the file')
})

// ---- the board follows the state ----
const BOARD = { config: { github: { repo: REPO, board: { owner: 'o', number: 1 } } } }
const moves = (w: W) => w.steps.filter(l => l.startsWith('board.sh move'))

test('a change of column moves the card, and a change inside a column does not', async ($, on) => {
  const w = engine(on, { ...BOARD, wf: { state: 'developing', board: 'progress' } })
  await start($, w)
  await tool($, 'blocked', { message: 'Which colour?' })
  expect(moves(w)).toEqual(['board.sh move I7 awaiting'])
  await tool($, 'unblocked', { message: 'Blue' })
  expect(moves(w)).toEqual(['board.sh move I7 awaiting', 'board.sh move I7 progress'])
  w.s.dirty = [' M a.ts']
  await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'] })
  expect(moves(w).length).toBe(2)
})

test('finishedReview leaves the card in progress: automated development goes on through the checks', async ($, on) => {
  const w = engine(on, { ...BOARD, wf: { state: 'reviewing', board: 'progress' } })
  await start($, w)
  const r = await tool($, 'finishedReview', { review: 'clean', deadcode: 'clean', remembered: 'nothing: small' })
  expect(r.isError).toBe(false)
  expect(moves(w)).toEqual([])
})

test('done puts the card in In review, because no automated development is left', async ($, on) => {
  const w = engine(on, { ...BOARD, wf: finishing({ board: 'progress' }), pr: pull(), checks: CHECKS({ name: 'ci', conclusion: 'success' }) })
  await start($, w)
  const r = await tool($, 'done', { message: 'finished', remembered: 'none: nothing durable' })
  expect(r.isError).toBe(false)
  expect(moves(w)).toEqual(['board.sh move I7 review'])
})

test('a done that merges puts the card in Done', async ($, on) => {
  const w = engine(on, { config: { ...BOARD.config, projectLevel: 'poc' }, wf: finishing({ board: 'progress' }), pr: pull(), checks: CHECKS({ name: 'ci', conclusion: 'success' }) })
  await start($, w)
  const r = await tool($, 'done', { message: 'finished', remembered: 'none: nothing durable' })
  expect(r.isError).toBe(false)
  expect(moves(w)).toEqual(['board.sh move I7 done'])
})

test('a board that fails shows a toast, does not stop the tool, and the next change tries again', async ($, on) => {
  const w = engine(on, { ...BOARD, wf: { state: 'developing', board: 'progress' } })
  await start($, w)
  w.s.boardFails = 'token expired'
  const r = await tool($, 'blocked', { message: 'Which colour?' })
  expect(r.isError).toBe(false)
  expect(w.toasts.join('\n')).toContain('#7')
  expect(w.toasts.join('\n')).toContain('token expired')
  expect(w.state()?.board).toBe('progress')
  w.s.boardFails = ''
  await tool($, 'unblocked', { message: 'Blue' })
  expect(w.state()?.board).toBe('progress')
  expect(moves(w)).toEqual([])
  await tool($, 'blocked', { message: 'Again' })
  expect(moves(w)).toEqual(['board.sh move I7 awaiting'])
})

test('an issue with no card shows a toast once and does not read the board at each save', async ($, on) => {
  const w = engine(on, { ...BOARD, wf: { state: 'developing', board: 'progress' } })
  await start($, w)
  w.s.boardCards = []
  await tool($, 'blocked', { message: 'Which colour?' })
  expect(w.toasts.join('\n')).toContain('Issue #7 has no card')
  expect(w.state()?.board).toBe('awaiting')
})

test('with no board or with the workflow off, nothing reads the board', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  await tool($, 'blocked', { message: 'Which colour?' })
  expect(w.steps.filter(l => l.startsWith('board.sh'))).toEqual([])
})

// ---- the base check, after the interview and before development ----
test('a new light issue names finishedInterview, and no commit goes in before it', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'fix-thing', mode: 'light' })
  expect(r.text).toContain('finishedInterview')
  w.s.dirty = [' M a.ts']
  const early = await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  expect(early.isError).toBe(true)
  expect(early.text).toContain('finishedInterview')
  const also = await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'] })
  expect(also.isError).toBe(true)
  expect(also.text).toContain('finishedInterview')
  w.steps.length = 0
  const checked = await tool($, 'finishedInterview', { issue: 7 })
  expect(checked.isError).toBe(false)
  expect(w.steps).toEqual(['pre-commit-check.sh'])
  expect(w.state()?.baseCheck).toMatchObject({ script: 'pre-commit-check.sh', exitCode: 0 })
  expect(checked.text).not.toContain('call finishedInterview')
  w.s.staged = true
  const late = await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  expect(late.isError).toBe(false)
})

test('a failed base check names the script, the exit code, the output and the log, and stops nothing', async ($, on) => {
  const w = engine(on, { wf: { baseCheck: undefined } })
  await start($, w)
  w.s.failCheck = 'pre-commit-check.sh'
  const r = await tool($, 'finishedInterview', { issue: 7 })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('pre-commit-check.sh')
  expect(r.text).toContain('exited 3')
  expect(r.text).toContain('lint: broken line')
  expect(r.text).toContain('ndev-pre-commit-check.sh.log')
  expect(r.text).toContain('followUp')
  expect(r.text).toContain('blocked')
  expect(r.text).not.toContain('Nothing was pushed')
  expect(w.state()?.baseCheck).toMatchObject({ exitCode: 3 })
  // After a repair the agent runs it again.
  w.s.failCheck = ''
  const again = await tool($, 'finishedInterview', { issue: 7 })
  expect(again.isError).toBe(false)
  expect(w.state()?.baseCheck).toMatchObject({ exitCode: 0 })
})

test('finishedInterview is valid only in development', async ($, on) => {
  const w = engine(on, { wf: { state: 'planning', mode: 'heavy', baseCheck: undefined } })
  await start($, w)
  const r = await tool($, 'finishedInterview', { issue: 7 })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('planning')
  expect(w.steps).toEqual([])
})

test('heavy runs pre-push-check.sh in finishedPlan, before the sign-off reaches the human', async ($, on) => {
  const plan = `${ROOT}/plan.md`
  const w = engine(on, { wf: { state: 'planning', mode: 'heavy', steering: 'interactive', baseCheck: undefined }, files: { [plan]: 'Test entry point: the CLI\n' } })
  await start($, w)
  w.s.failCheck = 'pre-push-check.sh'
  const r = await tool($, 'finishedPlan', { issue: 7, markdown_file: plan })
  expect(r.isError).toBe(false)
  expect(w.steps).toEqual(['pre-push-check.sh'])
  expect(w.state()?.baseCheck).toMatchObject({ script: 'pre-push-check.sh', exitCode: 3 })
  expect(w.state()?.state).toBe('blocked')
  expect(w.state()?.blocked?.message).toContain('pre-push-check.sh')
  expect(w.alerts.length).toBeGreaterThan(0)
})

test('heavy needs no finishedInterview after finishedPlan', async ($, on) => {
  const plan = `${ROOT}/plan.md`
  const w = engine(on, { wf: { state: 'planning', mode: 'heavy', baseCheck: undefined }, files: { [plan]: 'Test entry point: the CLI\n' } })
  await start($, w)
  const r = await tool($, 'finishedPlan', { issue: 7, markdown_file: plan })
  expect(r.text).not.toContain('finishedInterview')
  w.s.dirty = [' M a.ts']
  expect((await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })).isError).toBe(false)
})

test('a record that is past development needs no base check for its commits', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing', baseCheck: undefined } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  expect((await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })).isError).toBe(false)
})

// ---- the dead-code sweep ----
test('the review stage runs the Python sweep over every tracked root, and gives the result', async ($, on) => {
  const w = engine(on, { names: ['src/a.py', 'scripts/b.py', 'c.md'] })
  w.s.sweepExit = 1
  w.s.sweepOutput = 'src/a.py:3: DC02 unused name'
  const r = await toReview($, w)
  expect(w.steps).toContain('sweep.sh --base origin/main scripts src')
  expect(w.steps.some(l => l.startsWith('sweep-ts.sh'))).toBe(false)
  expect(r.text).toContain('src/a.py:3: DC02 unused name')
  expect(w.prRecord(12)?.deadcode).toMatchObject({ sha: expect.any(String), results: [{ language: 'Python', exitCode: 1 }] })
})

test('the review stage runs the TypeScript sweep for a TypeScript change', async ($, on) => {
  const w = engine(on, { names: ['a.tsx'] })
  const r = await toReview($, w)
  expect(w.steps).toContain('sweep-ts.sh origin/main')
  expect(r.text).toContain('base 2, head 2')
})

test('a sweep that could not measure is reported as that, never as a pass', async ($, on) => {
  const w = engine(on, { names: ['a.ts'] })
  w.s.sweepExit = 2
  w.s.sweepOutput = 'no knip.json'
  const r = await toReview($, w)
  expect(r.text).toContain('did not measure')
  expect(r.text).toContain('no knip.json')
  expect(r.text).toContain('exited 2')
  expect(r.text).not.toContain('found nothing new')
})

test('a change with no Python or TypeScript runs no sweep, and says so', async ($, on) => {
  const w = engine(on, { names: ['README.md'] })
  const r = await toReview($, w)
  expect(w.steps.some(l => l.startsWith('sweep'))).toBe(false)
  expect(r.text).toContain('no Python or TypeScript')
})

test('a resume in review runs a sweep that a crash lost, and not one that ran', async ($, on) => {
  const w = engine(on, { names: ['a.ts'], wf: { state: 'reviewing', hooks: { review: { firedAt: 0, answer: 'clean' } } } })
  await start($, w)
  await tool($, 'started', { issue: 7 })
  expect(w.steps.filter(l => l.startsWith('sweep-ts.sh')).length).toBe(1)
  await tool($, 'started', { issue: 7 })
  expect(w.steps.filter(l => l.startsWith('sweep-ts.sh')).length).toBe(1)
})

test('finishedReview keeps the result of the plugin sweep in the evidence', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing', deadcode: { sha: SHA, results: [{ language: 'TypeScript', exitCode: 1, output: 'a.ts: unused' }] } } })
  await start($, w)
  await tool($, 'finishedReview', { review: 'clean', deadcode: 'a.ts is live', remembered: 'nothing: small' })
  const text = w.state()?.evidence.review?.text ?? ''
  expect(text).toContain('a.ts is live')
  expect(text).toContain('TypeScript')
})

// ---- the body of a light PR ----
test('finishedDevelopment puts body_file in the PR body and keeps the Closes line', async ($, on) => {
  const note = `${ROOT}/note.md`
  const w = engine(on, { files: { [note]: 'Problem and evidence.\n' } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'], body_file: 'note.md' })
  expect(r.isError).toBe(false)
  expect(w.gh.some(l => l.includes('pr-edit 12'))).toBe(true)
  const body = [...w.files.values()].find(v => v.includes('Problem and evidence.') && v.includes('Closes #7'))
  expect(body).toBeDefined()
})

test('a body_file that is missing refuses before anything is committed', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'], body_file: 'gone.md' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain(`${ROOT}/gone.md`)
  expect(w.commits.length).toBe(0)
  expect(w.state()?.state).toBe('developing')
})

// ---- the copy editor ----
test('the answer of a copy editor says that Vale not run is not a pass', async ($, on) => {
  const w = engine(on, { names: ['README.md', 'a.ts'] })
  const r = await toReview($, w)
  const prompt = w.spawns.find(s => s.subagentType === 'ndev:copy-editor')!.prompt
  expect(prompt).toContain('/scripts/docs/readability.sh')
  expect(r.isError).toBe(false)
})

// ---- hotfix ----
test('hotfix files the issue, gives it its own worktree and PR, and turns the workflow off there', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  const r = await tool($, 'hotfix', { shortName: 'fix-login-redirect' })
  expect(r.isError).toBe(false)
  expect(w.gh.find(l => l.includes('issue-new'))).toContain('Hotfix: fix login redirect')
  expect(r.text).toContain('Issue #31')
  expect(r.text).toContain(CLAIMED)
  expect(r.text).toContain(`https://github.com/${REPO}/pull/`)
  expect(r.text).toContain('--no-verify')
  const record = JSON.parse(w.files.get(`${CLAIMED}/.neil-dev.issue-31.json`)!).workflow
  expect(record.off.reason).toContain('hotfix')
  expect(record.prs.length).toBe(1)
  // The session's own issue goes on: it did not join, and its record did not move.
  expect(w.state(7)?.state).toBe('developing')
  expect(w.state(7)?.prs).toEqual([12])
  expect((await tool($, 'status')).text).toContain('#7')
})

test('a commit that names the worktree of a hotfix passes the git guard, and only then', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  const commit = { tool: 'Bash', command: `git -C ${CLAIMED} commit -m fix` } as never
  expect((await $.tool.call(commit) as { deny?: string }).deny).toContain('checkpoint')
  await tool($, 'hotfix', { shortName: 'fix-login' })
  expect((await $.tool.call(commit) as { deny?: string }).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: `git -C ${CLAIMED} push` } as never) as { deny?: string }).deny).toBeUndefined()
  // The session's own issue keeps its guard.
  expect((await $.tool.call({ tool: 'Bash', command: 'git commit -m x' } as never) as { deny?: string }).deny).toContain('checkpoint')
  expect((await $.tool.call({ tool: 'Bash', command: `git -C ${CLAIMED} commit -m fix && git push` } as never) as { deny?: string }).deny).toContain('checkpoint')
})

test('a wait for the PR of a hotfix passes while the workflow watches the checks of its own PR', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, checks: RUNNING })
  await start($, w)
  const wait = (n: string) => $.tool.call({ tool: 'Bash', command: `/x/scripts/github/wait-for-pr-change.sh ${n} --skip-success --json` } as never) as Promise<{ deny?: string }>
  expect((await wait('12')).deny).toContain('The workflow watches the checks')
  const r = await tool($, 'hotfix', { shortName: 'fix-login' })
  const pr = /\/pull\/(\d+)/.exec(r.text)![1]!
  expect((await wait(pr)).deny).toBeUndefined()
  expect((await wait('99')).deny).toContain('The workflow watches the checks')
})

test('the sweep ends before a reviewer starts, so a reviewer that ends finds its record on disk', async ($, on) => {
  const w = engine(on, { names: ['a.ts'] })
  await start($, w)
  w.s.dirty = [' M a.ts']
  await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'] })
  expect(w.s.spawnedAtSweep).toBe(0)
  expect(w.state()?.deadcode).toBeDefined()
})

test('/flow goto reviewing runs the sweep, and replaces a result from an earlier commit', async ($, on) => {
  const old = { sha: 'old', results: [{ language: 'TypeScript', exitCode: 0, output: 'stale result' }] }
  const w = engine(on, { names: ['a.ts'], wf: { state: 'developing', deadcode: old } })
  await start($, w)
  await command($, 'goto reviewing because the review was lost')
  expect(w.steps.filter(l => l.startsWith('sweep-ts.sh')).length).toBe(1)
  expect(JSON.stringify(w.state()?.deadcode)).not.toContain('stale result')
})

test('body_file does not replace the plan in the PR body', async ($, on) => {
  const note = `${ROOT}/note.md`
  const w = engine(on, { files: { [note]: 'Problem and evidence.\n' } })
  await start($, w)
  w.s.pr = { ...w.s.pr, body: '<!-- ndev:plan:7 -->\nThe signed plan.\nTest entry point: x\nCloses #7\n<!-- /ndev:plan:7 -->\n' }
  w.s.dirty = [' M a.ts']
  expect((await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'], body_file: 'note.md' })).isError).toBe(false)
  const body = [...w.files.values()].find(v => v.includes('ndev:body'))!
  expect(body).toContain('The signed plan.')
  expect(body).toContain('Test entry point: x')
  expect(body.match(/Closes #7/g)?.length).toBe(1)
})

test('an issue that followUp this_agent adds has no interview, so its commits are not refused', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  await tool($, 'finishedInterview')
  const made = await tool($, 'followUp', { mode: 'this_agent', message: 'Sub work' })
  const child = Number(/issues\/(\d+)/.exec(made.text)![1])
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'finishedDevelopment', { issues: [7, child], prs: w.state()!.prs, message: 'm', files: ['a.ts'] })
  expect(r.isError, r.text).toBe(false)
  expect(r.text).not.toContain('no base check')
})

test('a base check with no script does not say passed', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing', noChecks: true, baseCheck: undefined } })
  await start($, w)
  const r = await tool($, 'finishedInterview')
  expect(r.text).toContain('did not run')
  expect(r.text).not.toContain('passed on')
})

test('a base check on a branch that holds commits does not say that the work changed nothing', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  w.s.ahead = '3'
  w.s.failCheck = 'pre-commit-check'
  const r = await tool($, 'finishedInterview')
  expect(r.text).toContain('exited 3')
  expect(r.text).not.toContain('before this work changed anything')
  w.s.ahead = '0'
  expect((await tool($, 'finishedInterview')).text).toContain('before this work changed anything')
})

test('done with an error in the settings stops nothing, and names the repair', async ($, on) => {
  const w = engine(on, finished({ files: { [CONFIG]: '{ not json' } }))
  await start($, w)
  const r = await tool($, 'done', DONE)
  expect(w.steps.filter(l => l.includes('stop-all'))).toEqual([])
  expect(r.text).toContain('did not stop')
  expect(r.text).toContain(`stop-all --worktree ${ROOT}`)
})

test('a straw_man hotfix opens no pass on the checkout of the session', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' }, config: { projectLevel: 'straw_man' } })
  await start($, w)
  const r = await tool($, 'hotfix', { shortName: 'fix-login' })
  expect(r.text).toContain('checkpoint')
  const main = (await $.tool.call({ tool: 'Bash', command: `git -C ${ROOT} commit -m fix` } as never)) as { deny?: string }
  expect(main.deny).toContain('checkpoint')
})

test('a push from a hotfix worktree goes only to its own branch', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  await tool($, 'hotfix', { shortName: 'fix-login' })
  const branch = JSON.parse(w.files.get(`${CLAIMED}/.neil-dev.issue-31.json`)!).workflow.branch as string
  const push = async (rest: string) => ((await $.tool.call({ tool: 'Bash', command: `git -C ${CLAIMED} push ${rest}` } as never)) as { deny?: string }).deny
  expect(await push('')).toBeUndefined()
  expect(await push(`-u origin ${branch}`)).toBeUndefined()
  expect(await push('origin HEAD')).toBeUndefined()
  expect(await push('origin claude/issue-7')).toContain('hotfix')
  expect(await push('origin HEAD:main')).toContain('hotfix')
  expect(await push('--all')).toContain('hotfix')
  expect(await push(`--force origin ${branch}`)).toContain('hotfix')
})

test('a push from a hotfix worktree passes with its output redirected or piped, and a refusal names the hotfix branch', async ($, on) => {
  const w = engine(on, { wf: { state: 'blocked' } })
  await start($, w)
  await tool($, 'hotfix', { shortName: 'fix-login' })
  const branch = JSON.parse(w.files.get(`${CLAIMED}/.neil-dev.issue-31.json`)!).workflow.branch as string
  const push = async (rest: string) => ((await $.tool.call({ tool: 'Bash', command: `git -C ${CLAIMED} push ${rest}` } as never)) as { deny?: string }).deny
  expect(await push('2>&1')).toBeUndefined()
  expect(await push('2>&1 | tail -5')).toBeUndefined()
  expect(await push('origin HEAD 2>&1')).toBeUndefined()
  expect(await push(`-u origin ${branch} 2>/dev/null; echo done`)).toBeUndefined()
  expect(await push('origin HEAD:main 2>&1')).toContain(branch)
  // checkpoint does not commit in a hotfix worktree, and its refusal names the plain git push.
  const r = await tool($, 'checkpoint', { issue: 31, message: 'm', files: [], worktree: CLAIMED })
  expect(r.isError).toBe(true)
  expect(r.text).toContain(`git -C ${CLAIMED} push origin ${branch}`)
})

test('a retry with the issue files nothing more, and its worktree and PR pass the guards', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  w.s.claimFails = 'no free slot'
  const failed = await tool($, 'hotfix', { shortName: 'fix-login' })
  expect(failed.text).toContain('issue: 31')
  const filed = w.gh.filter(l => l.includes('issue-new')).length
  w.s.claimFails = ''
  const r = await tool($, 'hotfix', { shortName: 'fix-login', issue: 31 })
  expect(r.isError).toBe(false)
  expect(w.gh.filter(l => l.includes('issue-new')).length).toBe(filed)
  expect(((await $.tool.call({ tool: 'Bash', command: `git -C ${CLAIMED} commit -m fix` } as never)) as { deny?: string }).deny).toBeUndefined()
  // A second retry after the PR opened uses the same record.
  expect((await tool($, 'hotfix', { shortName: 'fix-login', issue: 31 })).isError).toBe(false)
})

test('the board comes from the main checkout when the worktree has no board setting', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing', board: 'progress' }, files: { '/main/.neil-dev.json': JSON.stringify(BOARD.config) } })
  await start($, w)
  await tool($, 'blocked', { message: 'Which colour?' })
  expect(moves(w)).toEqual(['board.sh move I7 awaiting'])
})

test('a settings file with an error shows a toast and moves no card', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing', board: 'progress' }, files: { [CONFIG]: '{ not json' } })
  await start($, w)
  const r = await tool($, 'blocked', { message: 'Which colour?' })
  expect(r.isError).toBe(false)
  expect(moves(w)).toEqual([])
  expect(w.toasts.join('\n')).toContain(`the board does not show awaiting for issue #7: ${CONFIG} has an error`)
})

test('a straw_man issue that is done goes to Done: the commit is on the base branch', () => {
  expect(boardColumn({ state: 'done', direct: true })).toBe('done')
  expect(boardColumn({ state: 'done' })).toBe('review')
})

test('hotfix takes the title from the description when there is one', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  await tool($, 'hotfix', { shortName: 'fix-login', description: 'Login loops\n\nThe body.' })
  expect(w.gh.find(l => l.includes('issue-new'))).toContain('Login loops')
})

test('hotfix refuses a bad shortName, and a project with no workflow, before it files anything', async ($, on) => {
  const w = engine(on, { wf: null, config: { workflow: false } })
  await start($, w)
  expect((await tool($, 'hotfix', { shortName: 'Fix Login' })).isError).toBe(true)
  expect((await tool($, 'hotfix', { shortName: 'fix-login' })).isError).toBe(true)
  expect(w.gh.filter(l => l.includes('issue-new'))).toEqual([])
})

test('a hotfix that fails after the issue names the issue, so that a retry does not file it twice', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  w.s.claimFails = 'no free slot'
  const r = await tool($, 'hotfix', { shortName: 'fix-login' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('#31')
  expect(r.text).toContain('no free slot')
  expect(r.text).toContain('worktree_claim.sh')
})

// ---- done stops the resources ----
const finished = (over: Record<string, unknown> = {}) => ({ wf: finishing(), pr: pull(), checks: CHECKS({ name: 'ci', conclusion: 'success' }), ...over })
const DONE = { message: 'finished', remembered: 'none: nothing durable' }

test('done stops the stacks and the dev servers of the worktree, and leaves the worktree to Orca', async ($, on) => {
  const w = engine(on, finished())
  await start($, w)
  const r = await tool($, 'done', DONE)
  expect(r.isError).toBe(false)
  expect(w.steps).toContain(`worktree-env.sh stop-all --background --on-end stop-and-delete --worktree ${ROOT}`)
})

test('done keeps to the policy of the project for stacks', async ($, on) => {
  const w = engine(on, finished({ config: { worktreeStacks: { onSessionEnd: 'keep-running' } } }))
  await start($, w)
  await tool($, 'done', DONE)
  expect(w.steps).toContain(`worktree-env.sh stop-all --background --on-end keep-running --worktree ${ROOT}`)
})

test('done stops nothing while another issue in the worktree is unfinished', async ($, on) => {
  const w = engine(on, finished({ files: { [RECORD]: held(flow(finishing()), flow({ issue: 8, prs: [13], state: 'developing' })) } }))
  await start($, w)
  const r = await tool($, 'done', { ...DONE, pr: 12 })
  expect(r.isError).toBe(false)
  expect(w.steps.some(l => l.includes('stop-all'))).toBe(false)
})

test('a stop that fails does not undo done, and names the repair', async ($, on) => {
  const w = engine(on, finished())
  await start($, w)
  w.s.stopFails = 'record is version 1'
  const r = await tool($, 'done', DONE)
  expect(r.isError).toBe(false)
  expect(r.text).toContain('record is version 1')
  expect(r.text).toContain(`stop-all --worktree ${ROOT}`)
  expect(w.state()?.state).toBe('done')
})

// ---- the incomprehensible label ----
test('started names the incomprehensible label', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'fix-thing' })
  expect(r.text).toContain('incomprehensible')
})

// fcc-proto PR #660: a human merged the PR while the workflow stood in ci, and the agent then pushed a merge of
// main through checkpoint. finishedChecks refused for the head that a merged PR can never take, and done refused
// in ci, so the record could not end.
test('in ci, a PR that a human merged ends through done, and finishedChecks names done', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, pr: { ...MERGED_PR, head: { sha: 'f'.repeat(40), ref: 'issue-7' } } })
  await start($, w)
  const c = await tool($, 'finishedChecks', {})
  expect(c.isError).toBe(true)
  expect(c.text).toContain('PR #12 is merged')
  expect(c.text).toContain('call done')
  expect(c.text).not.toContain('Push it')
  const r = await tool($, 'done', { message: 'merged by the human', remembered: 'nothing: merged by hand' })
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('done')
  expect(r.text).toContain('PR #12 is already merged')
  expect(r.text).toContain('not the merged head')
})

test('in ci, checkpoint refuses to commit or push to the branch of a merged PR', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, pr: MERGED_PR })
  await start($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'checkpoint', { message: 'merge main', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('PR #12 is merged')
  expect(r.text).toContain('call done')
  expect(w.commits.length).toBe(0)
  expect(w.pushes.length).toBe(0)
})
