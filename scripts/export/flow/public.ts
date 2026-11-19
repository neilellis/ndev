import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { CliError, atomicJson, checked, gitWorkspace, locked, readObject, stateRoot, worktreeScript } from '../../ndev/common.mjs'
import { finishRound, interviewOnly, parseChatAnswers, parseRound, roundMarkdown } from '../../../hooks/workflow/interview-model.ts'
import type { Mode } from '../../../types'
import { readProject } from '../../ndev/project.mjs'
export { secretFiles, findInText } from '../../../hooks/workflow/secrets.ts'
export { readWorkflowRecords } from '../../ndev/waits.mjs'

export function issueRequest(root: string, repo: string, identity: string[]) {
  const hash = createHash('sha256').update(JSON.stringify([repo, ...identity])).digest('hex')
  const dir = join(gitWorkspace(root).commonDir, 'ndev-issue-requests')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, hash + '.json')
  return locked(path, () => {
    if (existsSync(path)) {
      const record = readObject(path)
      if (typeof record.id !== 'string' || !/^[0-9a-f-]{36}$/.test(record.id) || !Number.isFinite(record.startedAt) || record.repo !== repo || (record.issue !== undefined && !(Number.isSafeInteger(record.issue) && record.issue > 0))) throw new CliError(1, `Invalid issue request in ${path}.`, { repair: 'Inspect the issue request and GitHub before retrying.' })
      return { record, path, recover: true }
    }
    const record = { id: randomUUID(), repo, startedAt: Date.now() }
    atomicJson(path, record)
    return { record, path, recover: false }
  })
}
export function rememberIssue(path: string, id: string, issue: number) {
  locked(path, () => {
    const request = readObject(path)
    if (request.id !== id || (request.issue && request.issue !== issue)) throw new CliError(5, `Issue request ${id} conflicts with the receipt in ${path}.`, { repair: 'Inspect the GitHub issues before retrying.' })
    atomicJson(path, { ...request, issue })
  })
  return issue
}

export function settings(root: string) {
  const config = readProject(root)
  const path = join(root, '.neil-dev.worktree.json')
  const local = readObject(path, { missing: {} }).settings ?? {}
  return { ...config, mode: local.mode ?? config.mode, steering: local.steering ?? config.steering }
}

const commands: Record<string, [string, string]> = {
  help: ['', ''],
  guide: ['', ''],
  status: ['', 'issue pr'],
  start: ['issue', 'short-name mode take-over'],
  create: ['short-name', 'description-file mode'],
  hotfix: ['short-name', 'issue description-file'],
  comment: ['', 'issue pr message-file'],
  interview: ['', 'issue pr round-file answers-file finish'],
  'finished-interview': ['', 'issue pr'],
  'finished-plan': ['', 'issue markdown-file'],
  'finished-hacking': ['', 'issue pr'],
  checkpoint: ['', 'issue pr message file change-type worktree'],
  'finished-development': ['', 'issue pr message file change-type body-file hardening human-confirmation'],
  'push-draft': ['', 'issue pr sha review'],
  'finished-review': ['', 'issue pr review waive-review deadcode remembered'],
  'finished-checks': ['', 'issue pr'],
  'finished-smoke': ['', 'issue pr report-file skipped'],
  'finished-revision': ['', 'issue pr'],
  done: ['', 'issue pr message remembered'],
  blocked: ['', 'issue pr message'],
  unblock: ['answer?', 'issue pr'],
  'follow-up': ['', 'issue pr mode message-file existing-issue'],
  'add-migration': ['name', 'issue pr workdir new-version'],
  'request-secret': ['name', ''],
  mode: ['mode?', 'issue pr'],
  steering: ['steering?', 'issue pr reason'],
  skip: ['reason?', 'issue pr'],
  goto: ['state reason?', 'issue pr'],
  off: ['reason?', 'issue pr project'],
  on: ['', 'issue pr project'],
}
export const help = Object.keys(commands).map(command => usage(command)).join('\n')
function usage(command: string) {
  const [positionals, options] = commands[command]!
  const flags = options.split(' ').filter(Boolean).map(key => ['project', 'take-over', 'finish', 'new-version'].includes(key) ? `[--${key}]` : `[--${key} <${key}>]`)
  return ['ndev flow', command, ...positionals.split(' ').filter(Boolean).map(name => name.endsWith('?') ? `[<${name.slice(0, -1)}>]` : `<${name}>`), ...flags].join(' ')
}
const inputError = (message: string, command: string) => new CliError(2, message, { repair: usage(command) })
export function inputFile(path: string) {
  try { return readFileSync(path === '-' ? 0 : path, 'utf8') }
  catch (error) { throw new CliError(2, `Cannot read ${path}: ${(error as Error).message}`, { repair: 'Supply a readable file or use - for stdin.' }) }
}
export function parse(argv: string[]) {
  const [command = 'help', ...rest] = argv
  if (command === '--help') return { text: help }
  if (!Object.hasOwn(commands, command)) throw new CliError(2, `Unknown flow command "${command}".`, { repair: 'ndev flow help' })
  if (rest.includes('--help')) return { text: usage(command) }
  if (command === 'help') return { text: help }
  const [pos, keys] = commands[command]!
  const positional = pos.split(' ').filter(Boolean)
  const options = Object.fromEntries(keys.split(' ').filter(Boolean).map(key => [key, {
    type: ['project', 'take-over', 'finish', 'new-version'].includes(key) ? 'boolean' : 'string',
    multiple: ['file', 'change-type', 'existing-issue'].includes(key) || command === 'finished-development' && ['issue', 'pr'].includes(key),
  }]))
  let parsed
  try { parsed = parseArgs({ args: rest, options, allowPositionals: true, tokens: true }) }
  catch (error) { throw inputError((error as Error).message, command) }
  if (parsed.positionals.length > positional.length || parsed.positionals.length < positional.filter(key => !key.endsWith('?')).length) throw inputError(`Expected ${usage(command)}.`, command)
  const args: Record<string, string> = {}
  const numbers: Record<string, number[]> = {}
  const seen = new Set<string>()
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue
    if (seen.has(token.name) && !options[token.name]?.multiple) throw inputError(`Repeated --${token.name}.`, command)
    seen.add(token.name)
  }
  const values = { ...Object.fromEntries(positional.slice(0, parsed.positionals.length).map((key, index) => [key.replace('?', ''), parsed.positionals[index]])), ...parsed.values }
  for (const [key, value] of Object.entries(values)) {
    const items = (Array.isArray(value) ? value : [value]).map(String)
    if (items.some(item => !item.trim())) throw inputError(`Empty value for ${key}.`, command)
    if (['issue', 'pr', 'existing-issue'].includes(key)) {
      if (items.some(item => !/^[1-9]\d*$/.test(item) || !Number.isSafeInteger(Number(item)))) throw inputError(`Invalid ${key} number: ${items.join(', ')}.`, command)
      numbers[key] = [...new Set(items.map(Number))]
    }
    if (key === 'file' || key === 'change-type') args[key === 'file' ? 'files' : 'change-types'] = '\0' + items.join('\0')
    else args[key] = items[0]!
  }
  if (command !== 'finished-development' && args.issue && args.pr) throw inputError('Choose one target, --issue or --pr.', command)
  if (args.project && (args.issue || args.pr)) throw inputError('--project conflicts with an issue or PR target.', command)
  if (args.mode && !['follow-up'].includes(command) && !['light', 'heavy', 'hack'].includes(args.mode)) throw inputError(`Unknown workflow mode "${args.mode}".`, command)
  for (const name of ['message', 'report']) {
    const path = args[name + '-file']
    if (path) args[name] = inputFile(path)
  }
  if (args['markdown-file']) args.file = args['markdown-file']
  if (args.answer) args.message = args.answer
  return { command, args, numbers }
}
export function confirm(action: string, target: string, revision: string | number, root: string, json: boolean) {
  const phrase = `confirm ${action} ${target} ${revision}`
  const text = `In ${root}, confirm ${action} for ${target} at revision ${revision}. Run the command in a terminal and type "${phrase}".`
  if (json || !process.stdin.isTTY || !process.stderr.isTTY) return { nextAction: { action, target, revision, root, confirmation: 'terminal' }, text }
  process.stderr.write(text + '\n> ')
  const buf = Buffer.alloc(1024)
  const size = readSync(0, buf, 0, buf.length, null)
  if (buf.toString('utf8', 0, size).trim() !== phrase) throw new CliError(1, `Confirmation did not match ${action} for ${target} at revision ${revision}.`)
}
export function projectSwitch(root: string, enabled: boolean, json: boolean) {
  const file = join(root, '.neil-dev.json')
  const current = () => readObject(file, { missing: {} })
  const revision = (config: object) => createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 12)
  const before = revision(current())
  const action = confirm(enabled ? 'on' : 'off', 'project', before, root, json)
  if (action) return action
  locked(file, () => {
    const config = current()
    if (revision(config) !== before) throw new CliError(5, `${file} changed since confirmation. Read the settings and retry.`)
    atomicJson(file, { ...config, workflow: enabled })
  })
  return { root, enabled, text: `Project workflow is ${enabled ? 'on' : 'off'} in ${root}.` }
}
function updateRound(root: string, issue: number, mode: Mode, args: Record<string, string>) {
  const path = join(root, `.neil-dev.issue-${issue}.json`)
  const actions = ['round-file', 'answers-file', 'finish'].filter(key => args[key])
  if (actions.length > 1) throw inputError('Choose one interview action per call.', 'interview')
  const file = interviewOnly(issue, readObject(path))
  function view() {
    const roundId = file.chatRound && createHash('sha256').update(JSON.stringify(file.chatRound)).digest('hex')
    return { issue, roundId, title: file.chatRound?.title || `Interview for #${issue}`, status: file.chatRound ? 'Awaiting answers' : 'No pending questions', questions: file.chatRound?.questions || [], rounds: file.rounds, round: file.chatRound,
      actions: file.chatRound ? [{ id: 'interview.answer', label: 'Submit answers', input: { issue, roundId } }] : [],
      text: file.chatRound ? roundMarkdown(file.chatRound, file) : `Interview for #${issue}: ${file.rounds.length} recorded rounds.` }
  }
  if (!actions.length) return view()
  if (args.finish && file.chatRound) throw new CliError(1, `Round "${file.chatRound.title}" still needs answers.`, { repair: 'ndev flow interview --answers-file <file>' })
  if (args.finish) return
  if (args['round-file']) {
    if (file.chatRound) throw new CliError(1, `Round "${file.chatRound.title}" still needs answers.`)
    const parsed = parseRound(inputFile(args['round-file']), file, mode)
    if ('problems' in parsed) throw inputError(parsed.problems.join('\n'), 'interview')
    file.chatRound = parsed.round
  } else {
    if (!file.chatRound) throw new CliError(1, `Issue #${issue} has no pending interview round.`)
    const parsed = parseChatAnswers(inputFile(args['answers-file']!), file.chatRound)
    if ('problems' in parsed) throw inputError(parsed.problems.join('\n'), 'interview')
    file.rounds.push(finishRound(file.chatRound, parsed.answers, 'submitted', Date.now()))
    delete file.chatRound
  }
  checked('bash', [worktreeScript, 'set-interview', '--worktree', root], { cwd: root, input: JSON.stringify(file) })
  return view()
}

export function interviewRound(root: string, issue: number, mode: Mode, args: Record<string, string>) {
  const file = join(root, `.neil-dev.issue-${issue}.json`)
  return locked(file + '.interview', () => updateRound(root, issue, mode, args))
}

function bindingPath(root: string, session: string) {
  const key = createHash('sha256').update(JSON.stringify([gitWorkspace(root).commonDir, session])).digest('hex')
  return join(stateRoot(), 'flow-bindings', key + '.json')
}
export function bind(root: string, issue: number, session: string) {
  const file = bindingPath(root, session)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  locked(file, () => atomicJson(file, { root, issue, session }))
}
export function binding(root: string, session: string) {
  const source = gitWorkspace(root)
  const record = readObject(bindingPath(root, session), { missing: {} })
  if (!record.root || record.session !== session || !Number.isSafeInteger(record.issue)) return
  if (record.root !== root && source.linked) return
  if (!existsSync(record.root) || gitWorkspace(record.root).commonDir !== source.commonDir) return
  if (existsSync(join(record.root, `.neil-dev.issue-${record.issue}.json`))) return record
}
