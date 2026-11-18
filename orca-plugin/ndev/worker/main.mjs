import { execFile } from 'node:child_process'
import { access, constants, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, delimiter } from 'node:path'
import { promisify } from 'node:util'
import { inspectWorkspace, NdevError } from './files.mjs'
import { readResources } from './resources.mjs'

const run = promisify(execFile)
const panels = ['files', 'view', 'interview', 'walk-doc', 'triage', 'fix-all-prs', 'responsive-matrix']

async function findNdev() {
  const configured = process.env.NDEV_PANEL_CLI
  const home = process.env.HOME || homedir()
  const paths = (process.env.PATH ?? '').split(delimiter).filter(path => isAbsolute(path))
  const candidates = configured ? [configured] : [join(home, '.local', 'bin', 'ndev'), ...paths.map(path => join(path, 'ndev'))]
  for (const binary of candidates) {
    if (!isAbsolute(binary)) throw new NdevError('ndev_unavailable', 'NDEV_PANEL_CLI must be an absolute path to an installed ndev executable.')
    try {
      await access(binary, constants.X_OK)
      return binary
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error
    }
  }
  throw new NdevError('ndev_unavailable', 'The ndev executable is unavailable to Orca. Repair: install ndev or set NDEV_PANEL_CLI to the installed executable in Orca’s environment.')
}

async function ndevBridge(cwd, args, timeout = 20_000) {
  const binary = await findNdev()
  try {
    const { stdout } = await run(binary, ['--json', 'pane', 'bridge', ...args], { cwd, timeout, maxBuffer: 8 * 1024 * 1024 })
    const reply = JSON.parse(stdout)
    return reply?.result ?? reply
  } catch (error) {
    let details
    try {
      details = JSON.parse(error.stdout)?.error
    } catch (parseError) {
      if (!(parseError instanceof SyntaxError)) throw parseError
    }
    const output = details?.message || error.stderr?.trim() || error.stdout?.trim() || error.message
    throw new NdevError(details?.code ?? 'ndev_cli', `ndev pane bridge ${args.slice(0, 2).join(' ')} failed (exit ${error.code ?? error.signal ?? 'unknown'}): ${output}${details?.repair ? `\nRepair: ${details.repair}` : ''}`)
  }
}

async function inspect(directory) {
  return { ...(await inspectWorkspace(directory)), resources: await readResources(directory) }
}

function assertPanel(panelId) {
  if (!panels.includes(panelId)) throw new NdevError('invalid_params', `Unknown panel "${panelId}".`)
}

function canRead(row) {
  return (row.hostId === null || row.hostId === 'local') && isAbsolute(row.path)
}

export default async function activate(orca, { bridge = ndevBridge, readWorkspace = inspect } = {}) {
  const context = () => orca.host.call('workspace.readContext', {})
  const inventory = () => orca.host.call('workspace.list', {})
  const sameContext = async id => {
    if ((await context())?.workspaceId !== id) throw new NdevError('workspace_changed', 'The active worktree changed. Refresh the panel and try again.')
  }

  async function workspace() {
    const current = await context()
    if (!current?.workspaceId) throw new NdevError('no_workspace', 'Select a Git worktree in Orca.')
    const { workspaces } = await inventory()
    const selected = workspaces.find(row => row.id === current.workspaceId)
    if (!selected || !canRead(selected)) throw new NdevError('remote_workspace', 'The panel bridge cannot access this worktree from the desktop. Run ndev in that workspace for the text view.')
    if (selected.kind !== 'worktree') throw new NdevError('no_worktree', 'Select a Git worktree in Orca.')
    const directory = await realpath(selected.path)
    await sameContext(selected.id)
    return { id: selected.id, directory }
  }

  orca.panels.handle('panel.snapshot', async ({ panelId }) => {
    assertPanel(panelId)
    const { id, directory } = await workspace()
    const state = await bridge(directory, ['snapshot', panelId])
    await sameContext(id)
    return state
  })

  orca.panels.handle('panel.action', async ({ panelId, worktreeId, expectedRevision, actionId, input }) => {
    assertPanel(panelId)
    const { id, directory } = await workspace()
    const snapshot = await bridge(directory, ['snapshot', panelId])
    if (worktreeId !== snapshot.worktreeId) throw new NdevError('wrong_worktree', 'The action belongs to a different worktree. Refresh the panel.')
    if (expectedRevision !== snapshot.revision) throw new NdevError('stale_revision', `The panel is on revision ${expectedRevision}, and the worktree is on ${snapshot.revision}. Refresh the panel.`)
    await sameContext(id)
    return await bridge(directory, ['action', panelId, JSON.stringify({ worktreeId, expectedRevision, actionId, input })], 245_000)
  })

  orca.panels.handle('workspaces.list', async () => {
    const current = await context()
    const { workspaces } = await inventory()
    const entries = await Promise.all(workspaces.filter(row => row.kind === 'worktree' && canRead(row)).map(async row => {
      const focused = row.id === current?.workspaceId
      const result = { name: row.name, branch: row.branch, focused, dir: row.path }
      try {
        const workspace = await readWorkspace(row.path)
        const snapshot = focused ? await bridge(row.path, ['snapshot', 'files']) : undefined
        return { ...result, ...workspace, snapshot }
      } catch (error) {
        return { ...result, files: [], problem: `[${error.code ?? 'error'}] ${error.message}` }
      }
    }))
    if (current?.workspaceId) await sameContext(current.workspaceId)
    return entries.sort((a, b) => Number(b.focused) - Number(a.focused))
  })
}
