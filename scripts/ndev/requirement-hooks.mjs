import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gitCode, RAW_GIT } from '../../hooks/workflow/git-guard.ts'
import { CliError, run } from './common.mjs'
import { fixedChanges, parseRecord } from '../requirements/requirements.mjs'

const RECORDS = 'docs/formal/requirements'
const DEPRECATED = 'docs/formal/deprecated'
const RECORD_FILE = /^docs\/formal\/(?:requirements|deprecated)\/\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/
const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url))
const RAW_CREATE = /(?:^|[;&|(\n`\s])gh(?:\s+(?:-R|--repo)[\s=]\S+)?\s+(issue|pr)\s+create(?=[\s;&|)`]|$)/
const GH_SH = fileURLToPath(new URL('../github/gh.sh', import.meta.url))
const SAVES = /(?:^|[;&|(\n`\s/])ndev\s+flow\s+(?:checkpoint|finished-development)(?=[\s;&|)`]|$)/

export function hasRecords(root) {
  return existsSync(join(root, RECORDS))
}

export function rawCreateReason(root, command) {
  if (!hasRecords(root)) return undefined
  const match = gitCode(command).match(RAW_CREATE)
  if (!match) return undefined
  const helper = match[1] === 'issue' ? 'issue-new --title "<title>" --body-file <file>' : 'pr-new --title "<title>" --body-file <file> --base <base> --head <branch>'
  return `This project keeps requirement records in ${RECORDS}, and each ${match[1] === 'issue' ? 'issue' : 'pull request'} must cite one in force. A raw gh ${match[1]} create does not check that. Use ${GH_SH} ${helper}: it refuses a body that cites no record. Find the record with ndev requirements search <words>, or create a Proposed record with ndev requirements new "<title>" --author "<who asked for it>".`
}

export function savesCommit(command) {
  const code = gitCode(command)
  return [...code.matchAll(RAW_GIT)].some(match => match[2] === 'commit') || SAVES.test(code)
}

function changedRecordKey(root) {
  const status = run('git', ['status', '--porcelain', '--untracked-files=all', '--', RECORDS, DEPRECATED], { cwd: root })
  if (status.status !== 0) throw new CliError(1, `git status -- ${RECORDS} ${DEPRECATED} in ${root} exited ${status.status}: ${status.stderr.trim() || status.stdout.trim()}`, { repair: `Run git status in ${root} and repair the repository.` })
  const names = status.stdout.split('\n').filter(Boolean).map(line => line.slice(3).replace(/^.* -> /, '')).sort()
  if (!names.length) return null
  const hash = createHash('sha256')
  for (const name of names) {
    const file = join(root, name)
    hash.update(`${name}\0`).update(existsSync(file) ? readFileSync(file) : '\0deleted').update('\0')
  }
  return hash.digest('hex')
}

const CHECKS = ['links', 'explained', 'levels', 'fixed']

export function recordCheck(root, cached) {
  if (!hasRecords(root)) return null
  const key = changedRecordKey(root)
  if (!key) return null
  if (cached?.key === key) return { ...cached, fresh: false }
  const failed = []
  for (const name of CHECKS) {
    const ran = run(process.execPath, [CLI, 'requirements', name, '--base', 'HEAD', '--root', root], { cwd: root, timeout: 120_000 })
    const output = [ran.stdout.trim(), ran.stderr.trim()].filter(Boolean).join('\n')
    if (ran.status !== 0 && ran.status !== 1) throw new CliError(1, `ndev requirements ${name} --base HEAD in ${root} exited ${ran.status}: ${output || 'no output'}`, { repair: `Run ndev requirements ${name} --base HEAD in ${root} and repair the cause.` })
    if (ran.status === 1) failed.push({ output, command: `ndev requirements ${name} --base HEAD` })
  }
  return { key, ok: !failed.length, output: failed.map(f => f.output).join('\n'), commands: failed.map(f => f.command), fresh: true }
}

export function recordProblemNote(result) {
  return `The changed requirement records have problems:\n${result.output}\nCorrect the records. A commit is refused until ${result.commands.join(' and ')} pass${result.commands.length === 1 ? 'es' : ''}.`
}

export function recordCommitReason(result) {
  return `The changed requirement records have problems, so this commit is refused:\n${result.output}\nCorrect the records, then check with: ${result.commands.join(' and ')}`
}

const LIST_LIMIT = 20
const GIT_ADD = /(?:^|[;&|(\n`\s])git\s+add(?=\s)/g
const ADD_ALL = new Set(['-A', '--all', '-u', '--update'])

function wordsAfter(code, index) {
  const words = []
  let word = ''
  let quote = ''
  for (const char of code.slice(index)) {
    if (quote) {
      if (char === quote) quote = ''
      else word += char
    } else if (char === '"' || char === "'") quote = char
    else if (/[;&|\n)`]/.test(char)) break
    else if (/\s/.test(char)) {
      if (word) words.push(word)
      word = ''
    } else word += char
  }
  if (word) words.push(word)
  return words
}

function gitNames(root, args) {
  const command = ['--literal-pathspecs', args[0], '-z', ...args.slice(1)]
  const ran = run('git', command, { cwd: root })
  if (ran.status !== 0) throw new CliError(1, `git ${command.join(' ')} in ${root} exited ${ran.status}: ${ran.stderr.trim() || ran.stdout.trim()}`, { repair: `Run git ${args.join(' ')} in ${root} and repair the repository.` })
  return ran.stdout.split('\0').filter(Boolean)
}

export function commitFiles(root, cwd, command) {
  const code = gitCode(command)
  const paths = new Set()
  const fromCwd = path => relative(realpathSync(root), resolve(realpathSync(cwd), path))
  const unstaged = () => gitNames(root, ['diff', '--name-only']).forEach(file => paths.add(file))
  let commits = false
  for (const match of code.matchAll(RAW_GIT)) {
    if (match[2] !== 'commit') continue
    commits = true
    if (wordsAfter(code, match.index + match[0].length).some(word => word === '--all' || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(word))) unstaged()
  }
  for (const match of code.matchAll(new RegExp(SAVES.source, 'g'))) {
    commits = true
    const words = wordsAfter(code, match.index + match[0].length)
    words.forEach((word, index) => {
      if (word === '--file' && words[index + 1]) paths.add(fromCwd(words[index + 1]))
      else if (word.startsWith('--file=')) paths.add(fromCwd(word.slice('--file='.length)))
    })
  }
  if (!commits) return []
  for (const match of code.matchAll(GIT_ADD)) {
    const words = wordsAfter(code, match.index + match[0].length)
    if (words.some(word => ADD_ALL.has(word))) unstaged()
    words.filter(word => !word.startsWith('-')).forEach(word => paths.add(fromCwd(word)))
  }
  gitNames(root, ['diff', '--cached', '--name-only']).forEach(file => paths.add(file))
  return [...paths].filter(path => path && !path.startsWith('../') && !isAbsolute(path))
}

export function requirementsList(root, files, label) {
  if (!hasRecords(root) || !files.length) return undefined
  const targets = [...new Set(gitNames(root, ['ls-files', '--', ...files]))].filter(file => !file.startsWith(`${RECORDS}/`) && !file.startsWith(`${DEPRECATED}/`)).sort()
  if (!targets.length) return undefined
  const command = `ndev requirements for --json ${targets.join(' ')}`
  const ran = run(process.execPath, [CLI, 'requirements', 'for', '--json', '--root', root, '--', ...targets], { cwd: root, timeout: 120_000 })
  const output = [ran.stdout.trim(), ran.stderr.trim()].filter(Boolean).join('\n') || 'no output'
  const repair = `Run ${command} in ${root} and repair the cause.`
  if (ran.status !== 0) throw new CliError(1, `${command} in ${root} exited ${ran.status}: ${output}`, { repair })
  let answer
  try {
    answer = JSON.parse(ran.stdout).result.targets
    if (!Array.isArray(answer)) throw new Error('result.targets is not a list')
  } catch (error) {
    throw new CliError(1, `${command} in ${root} gave output that is not its JSON answer (${error.message}): ${output.slice(0, 500)}`, { repair })
  }
  const found = new Map()
  for (const target of answer) {
    for (const record of target.records) if (record.lines.some(line => line.startsWith('- File:'))) found.set(record.id, record)
  }
  if (!found.size) return undefined
  const records = [...found.values()].sort((a, b) => a.id.localeCompare(b.id))
  const lines = records.slice(0, LIST_LIMIT).map(record => `- ${record.id} ${record.title}: ${record.statement.replace(/\s+/g, ' ').trim()}`)
  if (records.length > LIST_LIMIT) lines.push(`${records.length - LIST_LIMIT} more. Run: ndev requirements for ${targets.join(' ')}`)
  return `The requirements in force for ${label ?? targets.join(' ')}. The change must meet each:\n${lines.join('\n')}`
}

function edited(tool, input, before) {
  if (tool === 'write') return typeof input.content === 'string' ? input.content : undefined
  const edits = tool === 'multiedit' ? input.edits : tool === 'edit' ? [input] : undefined
  if (!Array.isArray(edits)) return undefined
  let text = before
  for (const edit of edits) {
    if (typeof edit?.old_string !== 'string' || typeof edit.new_string !== 'string' || !edit.old_string || !text.includes(edit.old_string)) return undefined
    text = edit.replace_all ? text.split(edit.old_string).join(edit.new_string) : text.replace(edit.old_string, () => edit.new_string)
  }
  return text
}

export function fixedEditReason(root, file, tool, input) {
  if (!RECORD_FILE.test(file)) return undefined
  const full = join(root, file)
  if (!existsSync(full)) return undefined
  const before = readFileSync(full, 'utf8')
  const after = edited(tool, input, before)
  if (after === undefined) return undefined
  const old = parseRecord(file, before)
  const now = parseRecord(file, after)
  if (!old.front.data || !now.front.data) return undefined
  const changed = fixedChanges(old, now)
  if (!changed.length) return undefined
  return `${old.id} keeps its id, title, author and origin after it is created, and this edit changes the ${changed.join(' and the ')}. Leave them as they are. To change the requirement, ask the human to deprecate the record and create a new one: ndev requirements deprecate ${old.id} --reason "<why>" --decided-by "<name>" --by <REQ-NNNN>`
}
