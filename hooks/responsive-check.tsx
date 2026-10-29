import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { RcCell, RcProgress, RcStatus, RcTop, ResponsiveView } from '../types'

// The responsive-check matrix pane: routes x viewports x light/dark, drawn live from the
// progress file the skill's runner writes (skills/responsive-check/scripts/responsive-check.mjs).
// It opens by itself when a Bash call runs the runner, and on /responsive-matrix.

const PANE = 'responsive-check'
const TITLE = 'Responsive matrix'
const POLL_MS = 700
export const RUNNER = /responsive-check\.mjs\b/

const view = atom({ plugin: 'ndev', key: 'responsiveView' } as const, { frame: 0 } as ResponsiveView, { shape: 'rc-view-1' })

// The poll timer: the module's own, so a reload starts it again from session.start.
let poll: { cancel: () => void } | undefined

const GLYPH: Record<RcStatus, { mark: string; color: string; word: string }> = {
  ok: { mark: '●', color: 'success', word: 'pass' },
  warn: { mark: '▲', color: 'warning', word: 'warn' },
  error: { mark: '✖', color: 'error', word: 'fail' },
  failed: { mark: '⊘', color: 'error', word: 'did not load' },
  running: { mark: '◐', color: 'claude', word: 'checking' },
  pending: { mark: '·', color: 'subtle', word: 'waiting' },
}
const SPIN = ['◐', '◓', '◑', '◒']
const SCHEME = { light: '☀', dark: '☾' } as const
const ENGINE: Record<string, string> = { webkit: 'WebKit', chromium: 'Chromium', firefox: 'Firefox' }

async function latestPath($: EngineInterface) {
  const home = await $.env.get('HOME')
  if (!home) throw new Error('HOME is not set, so the pointer to the newest run cannot be found')
  return `${home}/.cache/ndev/responsive-check/latest.json`
}

// Reads the newest run. A missing pointer is no run yet; anything else unreadable is an error.
// While a runner call waits to start (`since`), an older run does not count. `isFinal`: the
// runner has exited, so waiting ends either way.
export async function refresh($: EngineInterface, isFinal = false) {
  const { since } = await read($, view)
  let progress: RcProgress | undefined
  let error: string | undefined
  try {
    const pointer = await latestPath($)
    if (await $.fs.exists(pointer)) {
      const { progress: path } = JSON.parse(await $.fs.read(pointer)) as { progress: string }
      progress = JSON.parse(await $.fs.read(path)) as RcProgress
    }
  } catch (e) {
    error = `Cannot read the newest run: ${(e as Error).message}. Run the check again; it rewrites the files.`
  }
  if (progress && since !== undefined && progress.startedAt < since) progress = undefined
  if (!progress && since !== undefined && isFinal && !error) error = 'The runner exited before it wrote any progress: read its output in the transcript (exit 2 names the fix).'
  let top: RcTop[] | undefined
  if (progress?.state === 'done' && progress.report) {
    try {
      top = topFindings(JSON.parse(await $.fs.read(progress.report)) as Report)
    } catch (e) {
      error = `Cannot read ${progress.report}: ${(e as Error).message}`
    }
  }
  const isWaiting = !progress && since !== undefined && !isFinal
  await update($, view, v => ({
    progress: progress ?? (since === undefined ? v.progress : undefined),
    top: top ?? (progress?.state === 'done' ? v.top : undefined),
    error,
    since: isWaiting || progress?.state === 'running' ? since : undefined,
    frame: v.frame + 1,
  }))
  if (!isWaiting && progress?.state !== 'running') stopPolling()
}

type Report = { cells: { findings: { check: string; severity: 'error' | 'warning'; selector: string; detail: string }[] }[] }

// The same check on the same element, counted across cells; errors first, then the widest spread.
export function topFindings(report: Report, limit = 6): RcTop[] {
  const groups = new Map<string, RcTop>()
  for (const cell of report.cells) {
    for (const f of cell.findings) {
      const key = `${f.check} ${f.selector}`
      const g = groups.get(key)
      if (g) g.cells += 1
      else groups.set(key, { ...f, cells: 1 })
    }
  }
  return [...groups.values()]
    .sort((a, b) => (a.severity === b.severity ? b.cells - a.cells : a.severity === 'error' ? -1 : 1))
    .slice(0, limit)
}

function startPolling($: EngineInterface) {
  if (poll) return
  poll = $.clock.every(POLL_MS, () => { void refresh($) })
}

function stopPolling() {
  poll?.cancel()
  poll = undefined
}

const count = (cells: RcCell[], ...s: RcStatus[]) => cells.filter(c => s.includes(c.status)).length

function elapsed(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

const fit = (s: string, w: number) => (s.length > w ? `${s.slice(0, Math.max(1, w - 1))}…` : s)

// From register.ts's session.start: the command, and the poll again after a reload mid-run.
export async function startResponsiveCheck($: EngineInterface) {
  await $.command.register({ name: 'responsive-matrix', description: 'Show the newest responsive-check run as a live matrix pane' })
  const v = await read($, view)
  if (v.progress?.state === 'running' || v.since !== undefined) startPolling($)
}

export const responsiveCheck = (on: On) => {

  on('command.run', { command: 'responsive-matrix' }, async $ => {
    await refresh($)
    const v = await read($, view)
    if (v.progress?.state === 'running') startPolling($)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: v.progress ? `Responsive matrix opened: ${v.progress.base}, ${v.progress.state}.` : 'Responsive matrix opened. No run yet: run the responsive-check skill.' }
  })

  // The runner starts: open the pane and follow its progress file until the run ends.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String((e as { command?: unknown }).command ?? '')
    if (!RUNNER.test(command)) return next(e)
    const since = await $.clock.now()
    await update($, view, v => ({ ...v, progress: undefined, top: undefined, error: undefined, since }))
    void $.ui.open({ id: PANE, title: TITLE })
    startPolling($)
    const ran = await next(e)
    await refresh($, true)
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { progress: p, top, error, frame } = await read($, view)
    const columns = e.props.bodyColumns
    const now = await $.clock.now()

    if (!p) {
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
            <Text weight="bold" color="claude">Responsive matrix</Text>
            <Text color="subtle">No run yet. Ask for a responsive check, or run the skill's responsive-check.mjs; this pane follows it live.</Text>
          </Box>
          {error && <Text color="error">{error}</Text>}
        </Box>
      )
    }

    const cells = p.cells
    const total = cells.length
    const done = total - count(cells, 'pending', 'running')
    const isRunning = p.state === 'running'
    const spin = SPIN[frame % SPIN.length]
    const glyph = (s: RcStatus) => (s === 'running' ? { ...GLYPH.running, mark: spin } : GLYPH[s])

    // The state chip in the header.
    const chip = p.state === 'failed'
      ? { text: '⊘ stopped', color: 'error' }
      : isRunning
        ? { text: `${spin} checking ${done}/${total}`, color: 'claude' }
        : count(cells, 'error', 'failed')
          ? { text: '✖ problems found', color: 'error' }
          : count(cells, 'warn')
            ? { text: '▲ passed with warnings', color: 'warning' }
            : { text: '● all clear', color: 'success' }

    // A bar made of the cells themselves: pass, warn, fail, checking, then waiting.
    const barWidth = Math.max(10, Math.min(48, columns - 16))
    const parts: [RcStatus, string][] = [['ok', '█'], ['warn', '█'], ['error', '█'], ['failed', '█'], ['running', '▒'], ['pending', '░']]
    let used = 0
    const segments = parts.map(([s, ch], i) => {
      const n = count(cells, s)
      const w = i === parts.length - 1 ? barWidth - used : Math.round((n / Math.max(1, total)) * barWidth)
      used += w
      return { s, text: ch.repeat(Math.max(0, w)) }
    })
    const percent = Math.round((done / Math.max(1, total)) * 100)

    // The grid: one row per viewport, and per route one cell for each scheme.
    const nameW = Math.min(22, Math.max(...p.viewports.map(v => v.name.length)))
    const labelW = nameW + 6 + 9
    const cellW = 5
    const groupW = (route: string) => Math.max(p.schemes.length * cellW, Math.min(16, route.length)) + 2
    const shown: string[] = []
    let room = columns - labelW - 2
    for (const r of p.routes) {
      if (room < groupW(r)) break
      shown.push(r)
      room -= groupW(r)
    }
    const hidden = p.routes.length - shown.length
    const cellOf = (route: string, viewport: string, scheme: string) => cells.find(c => c.route === route && c.viewport === viewport && c.scheme === scheme)
    const current = cells.find(c => c.status === 'running')

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column" borderStyle="round" borderColor={chip.color === 'claude' ? 'claude' : chip.color} paddingX={1}>
          <Box justifyContent="space-between">
            <Text weight="bold" color="claude">Responsive matrix</Text>
            <Text color={chip.color} weight="bold">{chip.text}</Text>
          </Box>
          <Text color="subtle">
            {fit(p.base, Math.max(10, columns - 40))} · {p.routes.length} route{p.routes.length === 1 ? '' : 's'} × {p.viewports.length} viewports × {p.schemes.map(s => SCHEME[s]).join(' ')}
            {' · '}{isRunning ? `running ${elapsed(now - p.startedAt)}` : `took ${elapsed(p.updatedAt - p.startedAt)}`}
          </Text>
          <Text>
            {segments.map(seg => <Text key={seg.s} color={GLYPH[seg.s].color}>{seg.text}</Text>)}
            <Text weight="bold"> {String(percent).padStart(3)}%</Text>
          </Text>
          <Text>
            <Text color="success">● {count(cells, 'ok')} pass</Text>
            <Text color="subtle">   </Text>
            <Text color="warning">▲ {count(cells, 'warn')} warn</Text>
            <Text color="subtle">   </Text>
            <Text color="error">✖ {count(cells, 'error', 'failed')} fail</Text>
            {isRunning && <Text color="subtle">   · {count(cells, 'pending', 'running')} to go</Text>}
          </Text>
          {current && <Text color="claude">{spin} {current.route} · {current.viewport} · {SCHEME[current.scheme]} {current.scheme}</Text>}
        </Box>

        {p.error && <Text color="error">{p.error}</Text>}
        {error && <Text color="error">{error}</Text>}

        <Box flexDirection="column">
          <Text>
            <Text>{' '.repeat(labelW)}</Text>
            {shown.map(r => <Text key={`r-${r}`} color="suggestion" weight="bold">{fit(r, groupW(r) - 2).padEnd(groupW(r))}</Text>)}
          </Text>
          <Text>
            <Text>{' '.repeat(labelW)}</Text>
            {shown.map(r => <Text key={`s-${r}`} color="subtle">{p.schemes.map(s => SCHEME[s].padEnd(cellW)).join('').padEnd(groupW(r))}</Text>)}
          </Text>
          {p.viewports.map(v => (
            <Text key={`v-${v.name}`}>
              <Text weight="semibold">{fit(v.name, nameW).padEnd(nameW)}</Text>
              <Text color="subtle" tabular>{String(v.width).padStart(5)} </Text>
              <Text color="subtle" dimColor>{(ENGINE[v.engine] ?? v.engine).padEnd(9)}</Text>
              {shown.map(r => (
                <Text key={`c-${v.name}-${r}`}>
                  {p.schemes.map(s => {
                    const c = cellOf(r, v.name, s)
                    const g = glyph(c?.status ?? 'pending')
                    const n = c ? c.errors || c.warnings : 0
                    return <Text key={s} color={g.color} weight={c?.status === 'error' ? 'bold' : 'regular'}>{`${g.mark}${n > 0 ? String(Math.min(n, 99)) : ''}`.padEnd(cellW)}</Text>
                  })}
                  <Text>{' '.repeat(groupW(r) - p.schemes.length * cellW)}</Text>
                </Text>
              ))}
            </Text>
          ))}
          {hidden > 0 && <Text color="subtle" italic>+{hidden} more route{hidden === 1 ? '' : 's'}: widen the pane to see them.</Text>}
        </Box>

        {top && top.length > 0 && (
          <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
            <Text weight="bold" color="claude">Top findings</Text>
            {top.map((f, i) => (
              <Box key={`t-${i}`} flexDirection="column">
                <Text>
                  <Text color={f.severity === 'error' ? 'error' : 'warning'}>{f.severity === 'error' ? '✖' : '▲'} {f.check.padEnd(12)}</Text>
                  <Text color="suggestion">{fit(f.selector, Math.max(10, columns - 34))}</Text>
                  <Text color="subtle"> ×{f.cells} cell{f.cells === 1 ? '' : 's'}</Text>
                </Text>
                <Text color="subtle">  {fit(f.detail, Math.max(10, columns - 6))}</Text>
              </Box>
            ))}
          </Box>
        )}
        {!isRunning && top && top.length === 0 && p.state === 'done' && <Text color="success">No findings in any cell.</Text>}

        <Text color="subtle" dimColor>
          ☀ light  ☾ dark   ● pass  ▲ warn  ✖ fail  ⊘ did not load  ◐ checking  · waiting   digits: findings in the cell
        </Text>
        <Box gap={2}>
          <Button key="refresh" label="Refresh" hotkey="r" plain onPress={() => { void refresh($) }} />
          {p.out && <Button key="open" label="Open screenshots" hotkey="o" plain onPress={() => { void $.process.run(['open', p.out]) }} />}
        </Box>
      </Box>
    )
  })
}
