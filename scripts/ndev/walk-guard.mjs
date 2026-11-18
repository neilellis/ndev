import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { guardCall } from '../../hooks/walk-doc/walk.ts'
import { shellCode } from '../../hooks/shell-code.ts'

const TOOL_NAMES = {
  bash: 'Bash', shell: 'Bash', exec_command: 'Bash',
  read: 'Read', read_file: 'Read', edit: 'Edit', multiedit: 'Edit',
  write: 'Write', write_file: 'Write', notebookedit: 'NotebookEdit',
  grep: 'Grep', glob: 'Glob', apply_patch: 'Patch', patch: 'Patch',
  agent: 'Agent', task: 'Agent', spawn_agent: 'Agent', send_input: 'SendMessage',
  send_message: 'SendMessage', workflow: 'Workflow', skill: 'Skill', artifact: 'Artifact',
  enterworktree: 'EnterWorktree', exitworktree: 'ExitWorktree',
}
const PATH_FIELD = {
  Read: 'file_path', Edit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path', Grep: 'path', Glob: 'path',
}
const OWNER_TOOL = new Set(['start', 'ask', 'reply', 'restart', 'tip', 'escalate', 'finish', 'status', 'stop'])
const READER_TOOL = new Set(['report', 'enhance', 'record', 'answer', 'done'])
const ORIGINAL_NAME = /(?:^|[;&|(`\n'"])[ \t]*(?:(?:command|exec)\s+)?(?:[^\s;&|()]+\/)?ndev["']?\s+walk-doc\s+([a-z-]+)/g
const pathInside = (root, file) => {
  const remainder = relative(root, file)
  return remainder !== '..' && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder)
}

export function walkToolOf({ tool, command, input }) {
  const name = typeof tool === 'string' ? tool : ''
  const word = name.toLowerCase().split(/\.|__/).at(-1)
  const mapped = TOOL_NAMES[word] ?? name
  const data = input && typeof input === 'object' ? input : {}
  return { tool: mapped, input: { ...data, ...(mapped === 'Bash' ? { command: command || data.command || data.cmd || '' } : {}) } }
}

async function canonical(path) {
  try {
    return await realpath(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const info = await lstat(path).catch(problem => { if (problem.code !== 'ENOENT') throw problem })
    if (info?.isSymbolicLink()) throw Error(`Cannot resolve symbolic link ${path}.`)
    return join(await canonical(dirname(path)), relative(dirname(path), path))
  }
}

const pathFrom = (home, base, path) => resolve(base, path.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home))

function roleDenial(verb, role) {
  if (OWNER_TOOL.has(verb) && role === 'reader') return `walk-doc: ${verb} belongs to the owning Walk session.`
  if (READER_TOOL.has(verb) && role !== 'reader') return `walk-doc: ${verb} belongs to the current Walk reader.`
  return null
}

export async function checkWalkTool(walk, config, call, role, { workspace, cwd }) {
  const { tool, input } = walkToolOf(call)
  const command = typeof input.command === 'string' ? shellCode(input.command) : ''
  const verb = tool.startsWith('mcp__ndev__walk_') ? tool.slice('mcp__ndev__walk_'.length).replaceAll('_', '-') : undefined
  const verbDenial = [verb, ...[...command.matchAll(ORIGINAL_NAME)].map(match => match[1])]
    .map(name => roleDenial(name, role)).find(Boolean)
  if (verbDenial) return verbDenial
  if (role !== 'reader') return null

  const own = await canonical(workspace)
  const here = pathInside(own, cwd) ? cwd : own
  const callBase = input.workdir ?? input.cwd ?? here
  const base = typeof callBase === 'string' && callBase ? await canonical(pathFrom(walk.home, here, callBase)) : own
  const otherPaths = [...walk.allowedPaths, ...(walk.savedOutputs ?? [])].map(path => pathFrom(walk.home, walk.root, path))
  const canAccess = async (path, useBase = base) => {
    const resolved = await canonical(pathFrom(walk.home, useBase, path))
    const reason = guardCall(walk, config, { agentId: walk.agentId, tool: 'Read', input: { file_path: resolved } })
    if (reason) return reason
    if (pathInside(own, resolved) || otherPaths.includes(resolved)) return null
    return `walk-doc: ${path} is outside the reader workspace ${own}. Use the rendered docs or a file they name.`
  }
  if (!pathInside(own, base)) return `walk-doc: command working directory ${base} is outside the reader workspace ${own}.`
  if (tool === 'Patch') {
    const patch = input.patch ?? input.patchText ?? input.patch_text
    const targets = typeof patch === 'string'
      ? [...patch.matchAll(/^\*\*\* (?:(?:Add|Delete|Update) File|Move to): (.+)$/gm)].map(match => match[1].trim())
      : []
    if (!targets.length) return 'walk-doc: patch files must be explicit.'
    for (const file of targets) {
      const reason = await canAccess(file)
      if (reason) return reason
    }
    return null
  }
  const field = PATH_FIELD[tool]
  if (field) {
    const file = input[field] ?? input.filePath ?? input.filepath ?? input.path
    if (typeof file !== 'string' || !file.length) return `walk-doc: give ${tool} an explicit path inside ${own}.`
    const reason = await canAccess(file)
    if (reason) return reason
    const canonicalFile = await canonical(pathFrom(walk.home, base, file))
    if (tool === 'Glob' && typeof input.pattern === 'string') {
      const pattern = input.pattern
      if (pattern.split(/[\\/]/).includes('..')) return 'walk-doc: a glob cannot climb out of its search path.'
      const prefix = pattern.slice(0, pattern.search(/[*?[\]{]|$/))
      if (prefix) {
        const reason = await canAccess(prefix, canonicalFile)
        if (reason) return reason
      }
    }
    return guardCall(walk, config, { agentId: walk.agentId, tool, input: { ...input, [field]: canonicalFile } })
  }
  if (tool === 'Bash') {
    const reason = guardCall(walk, config, { agentId: walk.agentId, tool, input: { command } })
    if (reason && !reason.includes('searching the project is denied')) return reason
    const paths = command.split(/[\s;&|<>()'"=]+/).filter(word => /^(?:\/|~\/|\$\{?HOME\}?\/|\.\.?\/)/.test(word))
    for (const path of paths) {
      if (/^\/(?:bin|usr\/bin)\/[a-zA-Z0-9_.-]+$/.test(path)) continue
      const reason = await canAccess(path)
      if (reason) return reason
    }
    return null
  }
  if (tool.endsWith('browser_click')) return null
  return guardCall(walk, config, { agentId: walk.agentId, tool, input })
}
