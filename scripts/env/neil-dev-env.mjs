#!/usr/bin/env node
// The project's private credentials for ndev skills: .neil-dev.env at the repository root,
// git-ignored, mode 600, one KEY=VALUE per line (# comments allowed). The main checkout holds the
// file; a worktree gets a copy of it the first time a command here runs in that worktree.
//
//   neil-dev-env.mjs status [--json]           where the file is, and which key names it sets
//   neil-dev-env.mjs init [--from <file>] [--key NAME]...
//                                              create or extend the file from the exports in ~/.zshrc
//   neil-dev-env.mjs import <file>             merge the KEY=VALUE lines of another file, such as a
//                                              skill's old credentials file, into this one
//   neil-dev-env.mjs check NAME...             exit 1 when a named key is not set in the file
//   neil-dev-env.mjs run [--need NAME[,NAME]] -- <command> [args...]
//                                              run a command with the file's keys in its environment
//
// No command prints a value. init reads ~/.zshrc as text and never runs it.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FILE = '.neil-dev.env'
const SELF = fileURLToPath(import.meta.url)
const INIT = `node ${SELF} init`

// The keys that ndev skills read. `alias` is a second name that the same skills accept.
export const KEYS = [
  { name: 'OPENROUTER_API_KEY', alias: 'OPEN_ROUTER_API_KEY', use: 'speech for narration (video-narration, video-setup) and the semantic index of requirement records (ndev requirements index)' },
  { name: 'OPENAI_API_KEY', use: 'word timings for narration (video-narration, video-setup)' },
  { name: 'UNSPLASH_ACCESS_KEY', use: 'photographs (video-images, video-setup)' },
  { name: 'VERCEL_AUTOMATION_BYPASS_SECRET', use: 'protected Vercel previews (site-check)' },
]
const aliasOf = name => KEYS.find(k => k.name === name)?.alias

class Refusal extends Error {}

function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (r.error) throw new Refusal(`git ${args.join(' ')} did not start in ${cwd}: ${r.error.message}`)
  return r
}

// The checkout this command runs in, and the main project checkout that every worktree shares
// (null for a bare repository). git worktree list names the main checkout first.
function locate(cwd) {
  const top = git(cwd, ['rev-parse', '--show-toplevel'])
  if (top.status !== 0) throw new Refusal(`${cwd} is not in a git repository (git rev-parse exited ${top.status}: ${top.stderr.trim()}). ${FILE} lives at a repository root; run this inside the project.`)
  const root = realpathSync(top.stdout.trim())
  const list = git(root, ['worktree', 'list', '--porcelain'])
  if (list.status !== 0) throw new Refusal(`git worktree list exited ${list.status} in ${root}: ${list.stderr.trim()}`)
  const first = list.stdout.split(/\n\s*\n/)[0].split('\n')
  const path = (first.find(l => l.startsWith('worktree ')) ?? '').slice('worktree '.length)
  const main = first.includes('bare') || path === '' ? null : realpathSync(path)
  return { root, main }
}

function ignored(at) {
  const r = git(at, ['check-ignore', '-q', FILE])
  if (r.status === 0) return true
  if (r.status === 1) return false
  throw new Refusal(`git check-ignore ${FILE} exited ${r.status} in ${at}: ${r.stderr.trim()}`)
}

const ignoreRepair = at =>
  `${FILE} is not git-ignored in ${at}, so it was not written: a credentials file must never be committed. ` +
  `Repair: echo ${FILE} >> ${at}/.gitignore and commit it, or for this clone only: echo ${FILE} >> "$(git -C ${at} rev-parse --git-common-dir)/info/exclude". Then run the command again.`

// One KEY=VALUE per line; # comments and blank lines allowed; a value may be quoted.
export function parse(text, file) {
  const values = {}
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) return
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (m === null) throw new Refusal(`${file} line ${i + 1} is not KEY=VALUE (the line is not shown, as it may hold a secret). Fix or remove that line.`)
    values[m[1]] = /^(["']).*\1$/.test(m[2]) ? m[2].slice(1, -1) : m[2]
  })
  return values
}

function copyTo(from, to) {
  writeFileSync(to, readFileSync(from), { mode: 0o600 })
  chmodSync(to, 0o600)
}

// The file this checkout uses. A worktree without one gets a copy of the main checkout's file,
// only when git ignores it there. Returns null when neither checkout has the file.
function find(loc) {
  const here = join(loc.root, FILE)
  if (existsSync(here)) return { file: here, copiedFrom: null }
  if (loc.main === null || loc.main === loc.root) return null
  const there = join(loc.main, FILE)
  if (!existsSync(there)) return null
  if (!ignored(loc.root)) throw new Refusal(ignoreRepair(loc.root))
  copyTo(there, here)
  return { file: here, copiedFrom: there }
}

function load(loc) {
  const found = find(loc)
  if (found === null) return null
  const mode = statSync(found.file).mode & 0o777
  if (mode & 0o077) throw new Refusal(`${found.file} can be read by other users (mode ${mode.toString(8)}). Repair: chmod 600 ${found.file}`)
  return { ...found, values: parse(readFileSync(found.file, 'utf8'), found.file) }
}

const noFile = loc =>
  `There is no ${FILE} in ${loc.root}${loc.main && loc.main !== loc.root ? ` or in the main project checkout ${loc.main}` : ''}. ` +
  `Repair: ${INIT} (it takes the keys from the exports in ~/.zshrc), then add any key it lists as missing to the file by hand.`

const isSet = (values, name) => Boolean(values[name]) || Boolean(aliasOf(name) && values[aliasOf(name)])

function missingFrom(found, names) {
  const missing = names.filter(n => !isSet(found.values, n))
  if (missing.length === 0) return null
  return `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set in ${found.file}. ` +
    `Repair: the person adds ${missing.map(n => `${n}=<value>`).join(' and ')} to that file (never in chat), ` +
    `or exports ${missing.length === 1 ? 'it' : 'them'} in ~/.zshrc and runs ${INIT}.`
}

const PLAIN = /^[A-Za-z0-9_\-.:/+=@,~]*$/

// A literal value from an assignment in a shell file; null when it is not a plain value, and
// undefined when the assignment only prefixes one command (KEY=x cmd), so it sets nothing.
function literal(raw) {
  const s = raw.trim()
  let value, rest
  if (s.startsWith("'")) {
    const end = s.indexOf("'", 1)
    if (end < 0) return null
    value = s.slice(1, end)
    rest = s.slice(end + 1)
  } else if (s.startsWith('"')) {
    const end = s.indexOf('"', 1)
    if (end < 0) return null
    value = s.slice(1, end)
    if (/[$`\\']/.test(value)) return null
    rest = s.slice(end + 1)
  } else {
    value = s.split(/\s/)[0]
    if (!PLAIN.test(value)) return null
    rest = s.slice(value.length)
  }
  return rest.trim() === '' || rest.trim().startsWith('#') ? value : undefined
}

// The named keys assigned in a shell file, read as text. The last assignment wins.
function fromShell(text, names) {
  const found = {}
  const unusable = new Set()
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (m === null || !names.includes(m[1])) continue
    const value = literal(m[2])
    if (value === undefined) continue
    if (value === null || value === '') {
      unusable.add(m[1])
      delete found[m[1]]
    } else {
      found[m[1]] = value
      unusable.delete(m[1])
    }
  }
  return { found, unusable }
}

function line(name, value) {
  if (value.includes("'")) throw new Refusal(`The value of ${name} has a single quote, which ${FILE} cannot hold. Put a value without one in the file by hand.`)
  return `${name}=${PLAIN.test(value) ? value : `'${value}'`}`
}

function init(loc, from, extra) {
  const target = loc.main ?? loc.root
  if (!ignored(target)) throw new Refusal(ignoreRepair(target))
  const file = join(target, FILE)
  const existed = existsSync(file)
  let text = existed ? readFileSync(file, 'utf8') : `# Private credentials for ndev skills. Git-ignored; keep it mode 600.\n# One KEY=VALUE per line. Never commit, print or paste these values.\n`
  const have = existed ? parse(text, file) : {}
  // A worktree's copy is replaced below; keys added to it by hand go to the main checkout file first.
  const copy = loc.root !== target ? join(loc.root, FILE) : null
  const local = copy !== null && existsSync(copy) ? parse(readFileSync(copy, 'utf8'), copy) : {}
  const differ = Object.keys(local).filter(k => have[k] !== undefined && have[k] !== local[k])
  if (differ.length > 0) {
    throw new Refusal(`${differ.join(', ')} ${differ.length === 1 ? 'has' : 'have'} one value in ${copy} and another in ${file}. init copies ${file} over ${copy}, so the person keeps the right value in both files, then runs init again.`)
  }
  const fromCopy = Object.keys(local).filter(k => have[k] === undefined)
  const wanted = [...KEYS.map(k => k.name), ...extra]
  const names = [...wanted, ...KEYS.flatMap(k => (k.alias ? [k.alias] : []))]
  const shell = existsSync(from) ? fromShell(readFileSync(from, 'utf8'), names) : null
  const added = [], kept = [], missing = [], unusable = []
  const lines = fromCopy.map(k => line(k, local[k]))
  for (const k of fromCopy) have[k] = local[k]
  for (const name of wanted) {
    if (isSet(have, name)) { kept.push(name); continue }
    const alias = aliasOf(name)
    const source = shell?.found[name] !== undefined ? name : alias && shell?.found[alias] !== undefined ? alias : null
    if (source !== null) {
      lines.push(line(source, shell.found[source]))
      added.push(source)
      continue
    }
    if (shell?.unusable.has(name) || (alias && shell?.unusable.has(alias))) unusable.push(name)
    missing.push(name)
    const use = KEYS.find(k => k.name === name)?.use
    if (!text.includes(`# ${name}=`)) lines.push(`# ${name}=${use ? `    (${use})` : ''}`)
  }
  if (lines.length > 0) text = `${text.endsWith('\n') || text === '' ? text : `${text}\n`}${lines.join('\n')}\n`
  writeFileSync(file, text, { mode: 0o600 })
  chmodSync(file, 0o600)
  const copies = []
  if (loc.root !== target && ignored(loc.root)) {
    copyTo(file, join(loc.root, FILE))
    copies.push(join(loc.root, FILE))
  }
  const report = [
    `${existed ? 'Updated' : 'Created'} ${file} (mode 600)${copies.length ? `, and copied it to ${copies.join(', ')}` : ''}.`,
    `added from ${from}: ${added.join(', ') || 'none'}`,
    `already set: ${kept.join(', ') || 'none'}`,
    ...(fromCopy.length ? [`kept from the worktree copy ${copy}: ${fromCopy.join(', ')}`] : []),
    `missing: ${missing.join(', ') || 'none'}`,
  ]
  if (shell === null) report.push(`${from} does not exist, so no key came from it.`)
  if (unusable.length) report.push(`${unusable.join(', ')} in ${from} ${unusable.length === 1 ? 'is' : 'are'} not a plain value (it uses $, a quote, a shell operator such as ; or |, a command or a backslash), so it was not copied. Put the value in ${file} by hand.`)
  if (missing.length) report.push(`To add a missing key, the person fills in its commented line in ${file}, or exports it in ~/.zshrc and runs init again. A project may not need every key.`)
  return report.join('\n')
}

// Merges the KEY=VALUE lines of another file into the main checkout file, then refreshes this
// worktree's copy. A key already set to another value is refused by name, and nothing is written.
function importFrom(loc, from) {
  if (!existsSync(from)) throw new Refusal(`import: ${from} does not exist. Give the path of the KEY=VALUE file to merge into ${FILE}.`)
  const target = loc.main ?? loc.root
  if (!ignored(target)) throw new Refusal(ignoreRepair(target))
  const file = join(target, FILE)
  const existed = existsSync(file)
  let text = existed ? readFileSync(file, 'utf8') : `# Private credentials for ndev skills. Git-ignored; keep it mode 600.\n# One KEY=VALUE per line. Never commit, print or paste these values.\n`
  const have = existed ? parse(text, file) : {}
  const copy = loc.root !== target ? join(loc.root, FILE) : null
  if (copy !== null && existsSync(copy)) {
    const local = parse(readFileSync(copy, 'utf8'), copy)
    const apart = Object.keys(local).filter(k => have[k] !== local[k])
    if (apart.length > 0) throw new Refusal(`${apart.join(', ')} in ${copy} ${apart.length === 1 ? 'is' : 'are'} not in ${file} with the same value. Run ${INIT} in this worktree first, so import does not overwrite the worktree copy.`)
  }
  const incoming = parse(readFileSync(from, 'utf8'), from)
  const differ = Object.keys(incoming).filter(k => have[k] !== undefined && have[k] !== incoming[k])
  if (differ.length > 0) {
    throw new Refusal(`${differ.join(', ')} ${differ.length === 1 ? 'has' : 'have'} one value in ${from} and another in ${file}. Keep the right value in both files by hand, then run import again. Nothing was written.`)
  }
  const added = Object.keys(incoming).filter(k => have[k] === undefined)
  const same = Object.keys(incoming).filter(k => have[k] !== undefined)
  const lines = added.map(k => line(k, incoming[k]))
  if (lines.length > 0) text = `${text.endsWith('\n') || text === '' ? text : `${text}\n`}# from ${from}\n${lines.join('\n')}\n`
  writeFileSync(file, text, { mode: 0o600 })
  chmodSync(file, 0o600)
  const copied = copy !== null && ignored(loc.root)
  if (copied) copyTo(file, copy)
  return [
    `${existed ? 'Updated' : 'Created'} ${file} (mode 600)${copied ? `, and copied it to ${copy}` : ''}.`,
    ...(copy !== null && !copied ? [`${copy} was not updated: git does not ignore ${FILE} in ${loc.root}. Add it to .gitignore, then run ${INIT} there.`] : []),
    `added: ${added.join(', ') || 'none'}`,
    `already set to the same value: ${same.join(', ') || 'none'}`,
    `${from} is unchanged. Delete it once nothing reads it any more.`,
  ].join('\n')
}

function main(argv) {
  const [command, ...args] = argv
  const loc = locate(process.cwd())
  if (command === 'status') {
    const found = load(loc)
    const keys = found ? Object.keys(found.values).filter(k => found.values[k] !== '') : []
    const missing = found ? KEYS.map(k => k.name).filter(n => !isSet(found.values, n)) : KEYS.map(k => k.name)
    const status = { file: found?.file ?? null, copiedFrom: found?.copiedFrom ?? null, root: loc.root, main: loc.main, ignored: ignored(loc.root), keys, missing }
    if (args.includes('--json')) return console.log(JSON.stringify(status))
    if (found === null) return console.log(noFile(loc))
    console.log(`${found.file}${found.copiedFrom ? ` (copied from ${found.copiedFrom})` : ''}\nkeys: ${keys.join(', ') || 'none'}\nmissing ndev keys: ${missing.join(', ') || 'none'}`)
    return
  }
  if (command === 'init') {
    let from = join(process.env.HOME || homedir(), '.zshrc')
    const extra = []
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--from' && args[i + 1]) from = args[++i]
      else if (args[i] === '--key' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(args[i + 1] ?? '')) extra.push(args[++i])
      else throw new Refusal(`init: "${args[i]}" is not an option. Use --from <file> or --key NAME.`)
    }
    return console.log(init(loc, from, extra))
  }
  if (command === 'import') {
    if (args.length !== 1) throw new Refusal('import: give one file, such as: import .env.walk-docs')
    return console.log(importFrom(loc, args[0]))
  }
  if (command === 'check') {
    if (args.length === 0) throw new Refusal('check: name at least one key, such as: check OPENAI_API_KEY')
    const found = load(loc)
    if (found === null) throw new Refusal(noFile(loc))
    const problem = missingFrom(found, args)
    if (problem) throw new Refusal(problem)
    return console.log(`${args.join(', ')} set in ${found.file}.`)
  }
  if (command === 'run') {
    const dash = args.indexOf('--')
    if (dash < 0 || dash === args.length - 1) throw new Refusal('run: give the command after --, such as: run --need OPENAI_API_KEY -- node voice.mjs')
    const opts = args.slice(0, dash)
    const need = []
    for (let i = 0; i < opts.length; i++) {
      if (opts[i] === '--need' && opts[i + 1]) need.push(...opts[++i].split(',').filter(Boolean))
      else throw new Refusal(`run: "${opts[i]}" is not an option. Use --need NAME[,NAME].`)
    }
    const found = load(loc)
    if (found === null) throw new Refusal(noFile(loc))
    const problem = missingFrom(found, need)
    if (problem) throw new Refusal(problem)
    const env = { ...process.env, ...found.values }
    for (const k of KEYS) {
      if (!k.alias) continue
      if (!env[k.name] && found.values[k.alias]) env[k.name] = found.values[k.alias]
      if (!env[k.alias] && found.values[k.name]) env[k.alias] = found.values[k.name]
    }
    const [cmd, ...rest] = args.slice(dash + 1)
    const r = spawnSync(cmd, rest, { stdio: 'inherit', env })
    if (r.error) throw new Refusal(`run: ${cmd} did not start: ${r.error.message}`)
    if (r.signal) throw new Refusal(`run: ${cmd} was stopped by ${r.signal}.`)
    process.exitCode = r.status ?? 1
    return
  }
  throw new Refusal(`"${command ?? ''}" is not a command. Use status, init, import, check or run (see the top of ${SELF}).`)
}

try {
  main(process.argv.slice(2))
} catch (error) {
  if (!(error instanceof Refusal)) throw error
  process.stderr.write(`neil-dev-env: ${error.message}\n`)
  process.exitCode = 1
}
