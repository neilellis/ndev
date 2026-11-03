import { loadWorkflow } from './workflow/tools'
import { flowPicture } from './workflow/machine'
import type { FlowMark, State } from './workflow/machine'
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { ResourceView, ViewServer, ViewStack, ViewTree } from '../types'
import { loadConfigAt } from './config'
import { fileUrl, issueUrl, pullUrl } from './links'

// The /view pane: the ndev files and the running resources of the current git worktree of the
// project, with the controls to create or copy a file and to stop, open or copy a resource.
// The lists come from two scripts: ndev-files.sh (files) and worktree-env.sh (resources).

const PANE = 'view'
const TITLE = 'ndev view'
const POLL_MS = 5000
// A stop is armed by its first press and runs on the second, if it comes within this time.
const ARM_MS = 5000
const RECORD = '.neil-dev.worktree.json'
const WRITABLE = ['.neil-dev.json', '.neil-dev.env']

const view = atom({ plugin: 'ndev', key: 'resourceView' } as const, { trees: [], busy: [] } as ResourceView, { shape: 'resource-view-1' })

// The module's own: the project folder from session.start, and the poll timer.
let repo: string | undefined
let poll: { cancel: () => void } | undefined

type Run = { exitCode: number; stdout: string; stderr: string }

// One line of what a script printed: its own words, not "failed".
const detail = (r: Run) => (r.stderr.trim() || r.stdout.trim() || 'no output').replace(/\s+/g, ' ')
const failure = (what: string, r: Run) => `${what}: exit code ${r.exitCode}: ${detail(r)}`

const filesScript = ($: EngineInterface) => `${$.plugin.root}/scripts/work/ndev-files.sh`
const envScript = ($: EngineInterface) => `${$.plugin.root}/scripts/work/worktree-env.sh`

async function run($: EngineInterface, script: string, args: string[]): Promise<Run> {
  const r = await $.process.run(['bash', script, ...args], { cwd: repo, timeoutMs: 120000 })
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
}

type ListedFile = { name: string; isKnown: boolean; present: boolean; isIgnored: boolean }
type Listed = { path: string; branch: string; isMain: boolean; files: ListedFile[]; problem?: string }
type Record2 = {
  resources?: {
    docker?: { kind: string; projectId: string; workdir: string; live: boolean | null; liveError?: string; lastStop?: { output?: string } }[]
    'dev-servers'?: Record<string, { pid: number; port: number; command: string; cwd: string; live: boolean; lastStop?: { output?: string } }>
  }
}

// The flow line in parts, so the issue and the PR can be drawn as links: text, then a number, then text.
function workflowParts(w: NonNullable<ViewTree['workflow']>) {
  const state = w.previous ? `${w.state} (was ${w.previous})` : w.state
  return { head: `${state}, issue `, issue: w.issue, mid: w.prs[0] ? ', PR ' : '', pr: w.prs[0], tail: w.blocked ? `: ${w.blocked}` : '' }
}

// How each step of the flow looks: its mark, and the colour of its box.
const MARK: Record<FlowMark, { sign: string; color: 'success' | 'claude' | 'warning' | 'subtle' }> = {
  passed: { sign: '✔', color: 'success' },
  current: { sign: '●', color: 'claude' },
  blocked: { sign: '▲', color: 'warning' },
  waiting: { sign: '◷', color: 'claude' },
  later: { sign: '○', color: 'subtle' },
  skipped: { sign: '–', color: 'subtle' },
}

async function readTree($: EngineInterface, t: Listed): Promise<ViewTree> {
  const tree: ViewTree = { path: t.path, branch: t.branch, isMain: t.isMain, files: t.files, problem: t.problem, servers: [], stacks: [] }
  if (!t.files.some(f => f.name === RECORD && f.present)) return tree
  const r = await run($, envScript($), ['list', '--json', '--live', '--worktree', t.path])
  if (r.exitCode !== 0) return { ...tree, resourceError: failure(`The resources of ${t.path} could not be read`, r) }
  try {
    const resources = (JSON.parse(r.stdout) as Record2).resources ?? {}
    const servers: ViewServer[] = Object.entries(resources['dev-servers'] ?? {}).map(([name, s]) => ({
      name, pid: s.pid, port: s.port, command: s.command, cwd: s.cwd, live: s.live, lastStopOutput: s.lastStop?.output,
    }))
    const stacks: ViewStack[] = (resources.docker ?? []).map(s => ({
      kind: s.kind, projectId: s.projectId, workdir: s.workdir, live: s.live, liveError: s.liveError, lastStopOutput: s.lastStop?.output,
    }))
    const wf = await loadWorkflow($, t.path)
    const workflow = wf && { state: wf.state, previous: wf.previous, issue: wf.issue, repo: wf.repo, prs: wf.prs, blocked: wf.blocked?.message, visited: (wf.history ?? []).flatMap(h => (h.from ? [h.from, h.to] : [h.to])) }
    return { ...tree, servers, stacks, workflow }
  } catch (error) {
    return { ...tree, resourceError: `The resources of ${t.path} could not be read: worktree-env.sh list printed no JSON (${(error as Error).message}). Run: bash ${envScript($)} list --json --live --worktree ${t.path}` }
  }
}

// Reads the files of every worktree, then the resources of each one that has a record.
export async function refresh($: EngineInterface) {
  if (!repo) {
    await update($, view, v => ({ ...v, error: 'The pane has no project folder. Start a new session in the project.' }))
    return
  }
  const listed = await run($, filesScript($), ['list', '--json', '--repo', repo])
  if (listed.exitCode !== 0) {
    await update($, view, v => ({ ...v, trees: [], repo, error: failure(`The worktrees of ${repo} could not be listed (ndev-files.sh list)`, listed) }))
    return
  }
  // Only the worktree the session is in is shown; the main checkout is read for Copy from main.
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: repo, timeoutMs: 10000 })
  if (top.exitCode !== 0) {
    await update($, view, v => ({ ...v, trees: [], repo, error: failure(`${repo} is not in a git worktree (git rev-parse --show-toplevel)`, { exitCode: top.exitCode, stdout: top.stdout, stderr: top.stderr }) }))
    return
  }
  const current = top.stdout.trim()
  let trees: ViewTree[]
  try {
    const { worktrees } = JSON.parse(listed.stdout) as { worktrees: Listed[] }
    if (!worktrees.some(t => t.path === current)) throw new Error(`${current} is not one of: ${worktrees.map(t => t.path).join(', ')}`)
    trees = await Promise.all(worktrees.map(t => (t.path === current ? readTree($, t) : { path: t.path, branch: t.branch, isMain: t.isMain, files: t.files, problem: t.problem, servers: [], stacks: [] })))
  } catch (error) {
    await update($, view, v => ({ ...v, trees: [], repo, error: `ndev-files.sh list printed something that is not the worktree list (${(error as Error).message}): ${detail(listed)}` }))
    return
  }
  const checkedAt = await $.clock.now()
  const main = trees.find(t => t.isMain)?.path
  let loaded = await loadConfigAt($, current)
  if (!loaded.exists && main && main !== current) loaded = await loadConfigAt($, main)
  const services = loaded.config.services
  const servicesError = loaded.error ? `${loaded.path} could not be read: ${loaded.error}` : undefined
  await update($, view, v => ({ ...v, trees, repo, current, error: undefined, checkedAt, services, servicesError }))
}

function startPolling($: EngineInterface) {
  if (poll) return
  poll = $.clock.every(POLL_MS, () => { void refresh($) })
}

// Runs one script action, then shows what it did and reads the lists again.
async function act($: EngineInterface, key: string, what: string, script: string, args: string[]) {
  await update($, view, v => ({ ...v, armed: undefined, busy: [...v.busy, key] }))
  let notice: ResourceView['notice']
  try {
    const r = await run($, script, args)
    notice = r.exitCode === 0 ? { text: `${what}: done.`, isError: false } : { text: failure(`${what} failed`, r), isError: true }
  } catch (error) {
    notice = { text: `${what} failed: ${(error as Error).message}`, isError: true }
  }
  await update($, view, v => ({ ...v, busy: v.busy.filter(k => k !== key), notice }))
  await refresh($)
}

// A stop's first press arms it; the second, within ARM_MS, runs it. Any other press disarms it.
async function press2($: EngineInterface, key: string, go: () => Promise<void>) {
  const now = await $.clock.now()
  const { armed } = await read($, view)
  if (armed?.key === key && now - armed.at <= ARM_MS) {
    await go()
    return
  }
  await update($, view, v => ({ ...v, armed: { key, at: now } }))
}

// From register.ts's session.start: the command, and the project folder the lists are read for.
export async function startView($: EngineInterface, cwd: string) {
  repo = cwd
  poll?.cancel()
  poll = undefined
  await $.command.register({ name: 'view', description: 'Show the ndev files and the running resources of the current worktree, in a pane' })
}

async function openView($: EngineInterface) {
    // A linked worktree without a record gets an empty one, as at session start.
    const made = repo ? await $.process.run(['bash', envScript($), 'init', '--worktree', repo], { cwd: repo, timeoutMs: 20000 }) : undefined
    await refresh($)
    if (made && made.exitCode !== 0) {
      await update($, view, v => ({ ...v, notice: { text: failure('The worktree record could not be created (worktree-env.sh init)', made), isError: true } }))
    }
    startPolling($)
    await $.ui.open({ id: PANE, title: TITLE, backgroundColor: 'transparent' })
    const { current, error } = await read($, view)
    return { text: error ? `ndev view opened, but the lists could not be read: ${error}` : `ndev view opened for ${current}.` }
}

export const resourceView = (on: On) => {
  on('command.run', { command: 'view' }, $ => openView($))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const { trees: all, current, error, notice, services, servicesError, armed, busy } = await read($, view)
    const main = all.find(t => t.isMain)
    const trees = all.filter(t => t.path === current)
    const isArmed = (key: string) => armed?.key === key
    const isBusy = (key: string) => busy.includes(key)
    const stopLabel = (key: string, label: string) => (isBusy(key) ? 'Stopping…' : isArmed(key) ? `Press again: ${label}` : label)
    const word = (live: boolean | null) => (live === null ? '?' : live ? '●' : '○')
    const heading = (label: string) => <Text color="subtle" weight="bold">{label}</Text>

    const flowNode = (state: string, mark: FlowMark) => {
      const look = MARK[mark]
      const isHere = mark === 'current' || mark === 'blocked' || mark === 'waiting'
      return (
        <Box key={`node:${state}`} borderStyle="round" borderColor={look.color} borderDimColor={mark === 'later' || mark === 'skipped'} paddingX={1} flexShrink={0}>
          <Text color={look.color} weight={isHere ? 'bold' : undefined} dimColor={mark === 'later' || mark === 'skipped'}>{`${look.sign} ${state}`}</Text>
        </Box>
      )
    }

    // The flow as a chain of boxes, so a look shows where this session stands. A narrow pane wraps the chain.
    const flowChart = (w: NonNullable<ViewTree['workflow']>) => {
      const parts = workflowParts(w)
      const picture = flowPicture({ state: w.state as State, previous: w.previous as State | undefined }, (w.visited ?? []) as State[])
      return (
        <Box key="flow" flexDirection="column">
          {heading('Workflow')}
          <Text color={w.state === 'blocked' ? 'warning' : undefined} weight="bold">
            {parts.head}
            {w.repo ? <Link href={issueUrl(w.repo, parts.issue)} label={`#${parts.issue}`} /> : `#${parts.issue}`}
            {parts.mid}
            {parts.pr !== undefined && (w.repo ? <Link href={pullUrl(w.repo, parts.pr)} label={`#${parts.pr}`} /> : `#${parts.pr}`)}
            {parts.tail}
          </Text>
          <Box flexWrap="wrap">
            {picture.steps.map((step, i) => (
              <Box key={`step:${step.state}`} alignItems="center" flexShrink={0}>
                {i > 0 && <Text color="subtle">──→</Text>}
                {flowNode(step.state, step.mark)}
              </Box>
            ))}
          </Box>
          {picture.revising && (
            <Box alignItems="center">
              <Text color="subtle">↺ feedback ──→</Text>
              {flowNode('revising', picture.revising)}
              <Text color="subtle">──→ back to ci</Text>
            </Box>
          )}
        </Box>
      )
    }

    const fileRow = (t: ViewTree, f: ViewTree['files'][number]) => {
      const missingKey = (verb: string) => `${verb}:${t.path}:${f.name}`
      // A missing file can be created; a linked worktree can also copy the main checkout's file, when it has one.
      const canCopy = !t.isMain && main?.files.some(m => m.name === f.name && m.present)
      return (
        <Box key={`${t.path}:${f.name}`} gap={2}>
          {f.present
            ? <Text color="success">✔ <Link href={fileUrl(`${t.path}/${f.name}`)} label={f.name} /></Text>
            : <Text color="error">{`✖ ${f.name} (missing)`}</Text>}
          {!f.present && WRITABLE.includes(f.name) && canCopy && (
            <Button key={missingKey('copy')} label="Copy from main" plain onPress={() => { void act($, missingKey('copy'), `Copy ${f.name} to ${t.path}`, filesScript($), ['copy', '--file', f.name, '--worktree', t.path, '--repo', repo ?? t.path]) }} />
          )}
          {!f.present && WRITABLE.includes(f.name) && (
            <Button key={missingKey('create')} label="Create" plain onPress={() => { void act($, missingKey('create'), `Create ${f.name} in ${t.path}`, filesScript($), ['create', '--file', f.name, '--worktree', t.path, '--repo', repo ?? t.path]) }} />
          )}
        </Box>
      )
    }

    const serverRow = (t: ViewTree, s: ViewServer) => {
      const id = `${t.path}:${s.name}`
      const stopKey = `stop:${id}`
      return (
        <Box key={id} flexDirection="column">
          <Box gap={2}>
            <Text color={s.live ? 'success' : 'subtle'}>{`${word(s.live)} ${s.name}   :${s.port}   ${s.live ? 'running' : 'stopped'}`}</Text>
            {s.live && <Button key={`open:${id}`} label="Open" plain onPress={() => { void $.process.run(['open', `http://localhost:${s.port}`]) }} />}
            <Button key={`copy-port:${id}`} label="Copy port" plain onPress={press => { void $.ui.copy({ text: String(s.port), surface: press.surface }) }} />
            <Button key={`copy-command:${id}`} label="Copy command" plain onPress={press => { void $.ui.copy({ text: s.command, surface: press.surface }) }} />
            {s.live && <Button key={stopKey} label={stopLabel(stopKey, 'Stop')} plain onPress={() => { void press2($, stopKey, () => act($, stopKey, `Stop dev server ${s.name}`, envScript($), ['stop', '--name', s.name, '--worktree', t.path])) }} />}
          </Box>
          {s.lastStopOutput && <Text color="error">{`  The last stop failed: ${s.lastStopOutput}`}</Text>}
        </Box>
      )
    }

    const stackRow = (t: ViewTree, s: ViewStack) => {
      const id = `${t.path}:${s.kind}:${s.projectId}`
      const state = s.live === null ? `unknown: ${s.liveError ?? 'docker did not answer'}` : s.live ? 'running' : 'stopped'
      const stop = (which: 'keep' | 'delete', label: string, policy: string) => {
        const key = `stop-${which}:${id}`
        return <Button key={key} label={stopLabel(key, label)} plain onPress={() => { void press2($, key, () => act($, key, `Stop ${s.kind} ${s.projectId} (${policy})`, envScript($), ['stop', '--kind', s.kind, '--project-id', s.projectId, '--on-end', policy, '--worktree', t.path])) }} />
      }
      return (
        <Box key={id} flexDirection="column">
          <Box gap={2}>
            <Text color={s.live ? 'success' : 'subtle'}>{`${word(s.live)} ${s.kind} ${s.projectId}   ${state}`}</Text>
            {stop('keep', 'Stop, keep data', 'stop-keep-data')}
            {stop('delete', 'Stop and delete data', 'stop-and-delete')}
          </Box>
          {s.lastStopOutput && <Text color="error">{`  The last stop failed: ${s.lastStopOutput}`}</Text>}
        </Box>
      )
    }

    const stopAll = (t: ViewTree, which: 'keep' | 'delete', label: string, policy: string) => {
      const key = `stop-all-${which}:${t.path}`
      return <Button key={key} label={stopLabel(key, label)} plain onPress={() => { void press2($, key, () => act($, key, `Stop everything in ${t.path} (${policy})`, envScript($), ['stop-all', '--on-end', policy, '--worktree', t.path])) }} />
    }

    return (
      <Box flexDirection="column" gap={1}>
        {error && <Text color="error">{error}</Text>}
        {notice && <Text color={notice.isError ? 'error' : 'success'}>{notice.text}</Text>}
        {servicesError && <Text color="error">{servicesError}</Text>}
        {services && Object.keys(services).length > 0 && (
          <Box gap={2}>
            {heading('Services')}
            {Object.entries(services).map(([name, s]) => <Link key={`service:${name}`} href={s.url} label={name} />)}
          </Box>
        )}
        {trees.map(t => (
          <Box key={t.path} flexDirection="column" gap={1}>
            <Box flexDirection="column">
              <Text weight="bold" color="claude">{`${t.branch}  `}<Link href={fileUrl(t.path)} label={t.path} />{t.isMain ? '  (main checkout)' : ''}</Text>
              {t.problem && <Text color="error">{t.problem}</Text>}
            </Box>
            {t.workflow && flowChart(t.workflow)}
            <Box key="files" flexDirection="column">
              {heading('Files')}
              <Box flexWrap="wrap" columnGap={3}>{t.files.map(f => fileRow(t, f))}</Box>
            </Box>
            {t.resourceError && <Text color="error">{t.resourceError}</Text>}
            {(t.servers.length > 0 || t.stacks.length > 0) && (
              <Box key="resources" flexDirection="column">
                {heading('Running')}
                {t.servers.map(s => serverRow(t, s))}
                {t.stacks.map(s => stackRow(t, s))}
                <Box gap={2}>
                  {stopAll(t, 'keep', 'Stop all, keep data', 'stop-keep-data')}
                  {stopAll(t, 'delete', 'Stop all and delete data', 'stop-and-delete')}
                </Box>
              </Box>
            )}
          </Box>
        ))}
        <Box gap={2}>
          <Button key="refresh" label="Refresh" hotkey="r" plain onPress={() => { void refresh($) }} />
        </Box>
      </Box>
    )
  })
}
