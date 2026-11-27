import type { EngineInterface } from 'claude-code'

import { RECORD } from './worktree-stacks'

// A linked worktree keeps its own mode and steering under "settings" in .neil-dev.worktree.json
// (git-ignored), ahead of the project's .ndev.json. The main checkout keeps no such file, so
// there the project file is used. scripts/work/worktree_env.mjs owns the file.
export type WorktreeSettings = { mode?: string; steering?: string }

function script($: EngineInterface) {
  return `${$.plugin.root}/scripts/work/worktree-env.sh`
}
const said = (r: { stdout: string; stderr: string }) => (r.stderr.trim() || r.stdout.trim() || 'no output').replace(/\s+/g, ' ').slice(0, 400)

// Creates the record when a linked worktree has none. Returns the problem, or undefined when the
// record exists or the folder is the main checkout (which keeps none).
export async function ensureRecord($: EngineInterface, dir: string): Promise<string | undefined> {
  const r = await $.process.run(['bash', script($), 'init', '--worktree', dir], { cwd: dir, timeoutMs: 20000 })
  return r.exitCode === 0 ? undefined : `worktree-env.sh init exited ${r.exitCode} for ${dir}: ${said(r)}`
}

// The settings of the record at `root`, or undefined when the worktree has no record. Throws,
// naming the file, when it cannot be read.
export async function readSettings($: EngineInterface, root: string): Promise<WorktreeSettings | undefined> {
  const path = `${root}/${RECORD}`
  if (!(await $.fs.exists(path))) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(await $.fs.read(path))
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${String(error).slice(0, 160)})`)
  }
  const s = (parsed as { settings?: WorktreeSettings } | null)?.settings
  return s ?? {}
}

// Saves one setting through the script. Returns the problem, or undefined when saved.
export async function saveWorktreeSetting($: EngineInterface, root: string, key: 'mode' | 'steering', value: string): Promise<string | undefined> {
  const r = await $.process.run(['bash', script($), 'set-setting', '--key', key, '--value', value, '--worktree', root], { cwd: root, timeoutMs: 20000 })
  return r.exitCode === 0 ? undefined : `worktree-env.sh set-setting exited ${r.exitCode}: ${said(r)}`
}
