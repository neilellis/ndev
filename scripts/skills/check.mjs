#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const USAGE = 'Usage: node scripts/skills/check.mjs [--root <repository folder>]'

const FIELDS = {
  name: 'text',
  description: 'text',
  license: 'text',
  compatibility: 'text',
  'allowed-tools': 'text',
  metadata: 'map',
  'argument-hint': 'text',
  'disable-model-invocation': 'boolean',
  'user-invocable': 'boolean',
  model: 'text',
}

const LIMITS = { name: 64, description: 1024, compatibility: 500 }

function usage(message) {
  process.stderr.write(`skills check: ${message}\n${USAGE}\n`)
  process.exit(2)
}

function parseArgs(argv) {
  let root = fileURLToPath(new URL('../../', import.meta.url))
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') {
      if (!argv[i + 1]) usage('--root needs a folder.')
      root = argv[++i]
    } else usage(`unknown argument ${JSON.stringify(argv[i])}.`)
  }
  return root
}

function scalar(raw) {
  if (raw.startsWith('"')) {
    try {
      const value = JSON.parse(raw)
      return typeof value === 'string' ? { value } : { invalid: true }
    } catch {
      return { invalid: true }
    }
  }
  if (raw.startsWith("'")) {
    const quoted = raw.match(/^'((?:[^']|'')*)'$/)
    return quoted ? { value: quoted[1].replaceAll("''", "'") } : { invalid: true }
  }
  if (raw === 'true' || raw === 'false') return { value: raw === 'true' }
  if (['~', 'null', 'Null', 'NULL'].includes(raw)) return { value: null }
  const indicator = raw.match(/^([>|[\]{}&*!%@`#,?]|- )/)
  if (indicator) return { problem: `starts with ${JSON.stringify(indicator[1].trim())}, which YAML reads as syntax. Repair: put the value in double quotes.` }
  if (raw.includes(': ')) return { problem: 'holds ": " in a value without quotes, which YAML reads as a second key. Repair: put the value in double quotes.' }
  if (raw.endsWith(':')) return { problem: 'ends with ":" in a value without quotes, which YAML rejects. Repair: put the value in double quotes.' }
  if (raw.includes(' #')) return { problem: 'holds " #" in a value without quotes, which YAML reads as a comment. Repair: put the value in double quotes.' }
  return { value: raw }
}

function frontMatter(text) {
  const lines = text.split('\n').map(line => line.replace(/\r$/, ''))
  if (lines[0] !== '---') return { problems: ['no front matter. Repair: start the file with a "---" line, "name: <folder name>", "description: <when to use the skill>" and a "---" line.'] }
  const close = lines.indexOf('---', 1)
  if (close < 0) return { problems: ['the front matter has no closing "---" line. Repair: add a "---" line after the last field.'] }
  const data = {}
  const problems = []
  let map
  for (let i = 1; i < close; i += 1) {
    const line = lines[i]
    if (!line.trim() || /^\s*#/.test(line)) continue
    const top = line.match(/^([A-Za-z0-9_-]+):(?: (.*))?$/)
    const nested = line.match(/^ {2}([A-Za-z0-9_-]+): (.+)$/)
    let key, raw, target
    if (top) {
      ;[, key, raw] = top
      raw = (raw ?? '').trim()
      if (Object.hasOwn(data, key)) {
        problems.push(`"${key}" is in the front matter more than once. Repair: keep one.`)
        continue
      }
      if (!raw) {
        data[key] = map = {}
        continue
      }
      map = undefined
      target = data
    } else if (nested && map) {
      ;[, key, raw] = nested
      raw = raw.trim()
      target = map
      if (Object.hasOwn(map, key)) {
        problems.push(`"${key}" is in a map of the front matter more than once. Repair: keep one.`)
        continue
      }
    } else return { problems: [`line ${i + 1} is not valid: ${JSON.stringify(line)}. This check reads "key: value" on one line, "  key: value" lines under metadata, and whole-line comments; it does not read lists or values that run onto a second line. Repair: write the field in one of those forms.`] }
    const parsed = scalar(raw)
    if (parsed.invalid) return { problems: [`line ${i + 1} is not valid: ${JSON.stringify(line)}. A quoted value must close at the end of the line, with nothing after it, and use JSON escapes inside double quotes. Repair: close the quotes, escape a quote inside them, and move a comment to its own line.`] }
    target[key] = parsed.value
    if (parsed.problem) problems.push(`"${key}" ${parsed.problem}`)
  }
  return { data, problems }
}

function fields(data, folder) {
  const problems = []
  for (const [key, value] of Object.entries(data)) {
    const kind = FIELDS[key]
    if (!kind) {
      problems.push(`"${key}" is not a known skill field. Known fields: ${Object.keys(FIELDS).join(', ')}. Repair: correct the name, or remove the field.`)
      continue
    }
    if (value === undefined) continue
    if (kind === 'boolean' && typeof value !== 'boolean') problems.push(`"${key}" must be true or false without quotes, not ${JSON.stringify(value)}.`)
    if (kind === 'text' && typeof value !== 'string') problems.push(`"${key}" must be text, not ${value === null || (typeof value === 'object' && !Object.keys(value).length) ? 'empty' : typeof value === 'object' ? 'a nested map' : JSON.stringify(value)}. Repair: write "${key}: <text>" on one line.`)
    if (kind === 'map' && (typeof value !== 'object' || value === null || Object.values(value).some(entry => typeof entry !== 'string'))) problems.push(`"${key}" must be a map of text values, written as "  key: value" lines under "${key}:".`)
    if (typeof value === 'string' && LIMITS[key] && value.length > LIMITS[key]) problems.push(`"${key}" has ${value.length} characters; the limit is ${LIMITS[key]}. Repair: shorten it.`)
  }
  if (!Object.hasOwn(data, 'name')) problems.push(`no "name". Repair: add "name: ${folder}".`)
  else if (typeof data.name === 'string') {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(data.name)) problems.push(`"name" ${JSON.stringify(data.name)} is not kebab-case. Repair: use lower-case letters, digits and single hyphens, and rename the folder to match.`)
    else if (data.name !== folder) problems.push(`"name" is "${data.name}", but the folder is "${folder}". Repair: make them the same.`)
  }
  if (!Object.hasOwn(data, 'description')) problems.push('no "description". Repair: add "description: <what the skill does and when to use it>".')
  else if (typeof data.description === 'string') {
    if (!data.description.trim()) problems.push('"description" is empty. Repair: say what the skill does and when to use it.')
  }
  return problems
}

function nestedSkills(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules') return []
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return [...(existsSync(join(path, 'SKILL.md')) ? [join(path, 'SKILL.md')] : []), ...nestedSkills(path)]
    return []
  })
}

function check(root) {
  const skills = join(root, 'skills')
  if (!existsSync(skills) || !statSync(skills).isDirectory()) usage(`no skills folder at ${skills}.`)
  const folders = readdirSync(skills, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name).sort()
  if (!folders.length) usage(`no skill folder in ${skills}, so nothing was checked.`)
  const report = []
  for (const folder of folders) {
    const dir = join(skills, folder)
    const file = join(dir, 'SKILL.md')
    const problems = []
    if (!existsSync(file)) problems.push([relative(root, dir), 'no SKILL.md. Repair: add one, or remove the folder.'])
    else {
      const parsed = frontMatter(readFileSync(file, 'utf8'))
      for (const problem of [...parsed.problems, ...(parsed.data ? fields(parsed.data, folder) : [])]) problems.push([relative(root, file), problem])
    }
    for (const inner of nestedSkills(dir)) problems.push([relative(root, inner), 'a second SKILL.md inside the skill; a harness can load it as a separate skill. Repair: rename it, for example to references/<topic>.md.'])
    if (problems.length) report.push(problems)
  }
  return { folders, report }
}

const root = parseArgs(process.argv.slice(2))
const { folders, report } = check(root)
if (report.length) {
  const lines = report.flat()
  process.stderr.write(lines.map(([path, problem]) => `${path}: ${problem}\n`).join(''))
  process.stderr.write(`${lines.length} problem${lines.length === 1 ? '' : 's'} in ${report.length} skill${report.length === 1 ? '' : 's'}.\n`)
  process.exit(1)
}
process.stdout.write(`${folders.length} skill${folders.length === 1 ? '' : 's'} valid in ${join(root, 'skills')}\n`)
