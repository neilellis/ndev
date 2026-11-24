import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gitCode, RAW_GIT } from '../../hooks/workflow/git-guard.ts'
import { CliError, run } from './common.mjs'

const RECORDS = 'docs/formal/requirements'
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
  const status = run('git', ['status', '--porcelain', '--untracked-files=all', '--', RECORDS], { cwd: root })
  if (status.status !== 0) throw new CliError(1, `git status -- ${RECORDS} in ${root} exited ${status.status}: ${status.stderr.trim() || status.stdout.trim()}`, { repair: `Run git status in ${root} and repair the repository.` })
  const names = status.stdout.split('\n').filter(Boolean).map(line => line.slice(3).replace(/^.* -> /, '')).sort()
  if (!names.length) return null
  const hash = createHash('sha256')
  for (const name of names) {
    const file = join(root, name)
    hash.update(`${name}\0`).update(existsSync(file) ? readFileSync(file) : '\0deleted').update('\0')
  }
  return hash.digest('hex')
}

export function recordLinkCheck(root, cached) {
  if (!hasRecords(root)) return null
  const key = changedRecordKey(root)
  if (!key) return null
  if (cached?.key === key) return { ...cached, fresh: false }
  const ran = run(process.execPath, [CLI, 'requirements', 'links', '--base', 'HEAD', '--root', root], { cwd: root, timeout: 120_000 })
  const output = [ran.stdout.trim(), ran.stderr.trim()].filter(Boolean).join('\n')
  if (ran.status !== 0 && ran.status !== 1) throw new CliError(1, `ndev requirements links --base HEAD in ${root} exited ${ran.status}: ${output || 'no output'}`, { repair: `Run ndev requirements links --base HEAD in ${root} and repair the cause.` })
  return { key, ok: ran.status === 0, output, fresh: true }
}

export function linkProblemNote(result) {
  return `The changed requirement records link what does not exist or what did not implement them:\n${result.output}\nCorrect the Trace lines. A commit is refused until ndev requirements links --base HEAD passes.`
}

export function linkCommitReason(result) {
  return `The changed requirement records have link problems, so this commit is refused:\n${result.output}\nCorrect the Trace lines, then check with: ndev requirements links --base HEAD`
}
