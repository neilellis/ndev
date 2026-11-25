#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXCEPTIONS = 'scripts/test/exceptions.json'

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function parse(argv) {
  const options = { root: fileURLToPath(new URL('../../', import.meta.url)), list: false, forward: [] }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') {
      if (!argv[i + 1]) fail('--root needs a folder. Usage: run.mjs [--root <dir>] [--list] [node --test options]')
      options.root = argv[++i]
    } else if (argv[i] === '--list') options.list = true
    else options.forward.push(argv[i])
  }
  return options
}

function tracked(root) {
  const out = spawnSync('git', ['-C', root, 'ls-files', '-z', '--', '*.test.mjs'], { encoding: 'utf8' })
  if (out.status !== 0) fail(`git ls-files in ${root} exited ${out.status}: ${out.stderr.trim()}`)
  return out.stdout.split('\0').filter(Boolean).sort()
}

function exceptions(root, files) {
  const file = join(root, EXCEPTIONS)
  if (!existsSync(file)) return new Set()
  let list
  try {
    list = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`${EXCEPTIONS}: not valid JSON (${error.message}). It is a list of {"path": "<test file>", "reason": "<why npm test leaves it out>"}.`)
  }
  if (!Array.isArray(list)) fail(`${EXCEPTIONS}: not a list. It is a list of {"path": "<test file>", "reason": "<why npm test leaves it out>"}.`)
  const problems = []
  for (const entry of list) {
    if (!files.includes(entry?.path)) problems.push(`${EXCEPTIONS}: ${entry?.path} is not a tracked test file. Remove the exception, or correct its path.`)
    else if (typeof entry.reason !== 'string' || !entry.reason.trim()) problems.push(`${EXCEPTIONS}: the exception for ${entry.path} gives no reason. Say why npm test leaves it out.`)
  }
  if (problems.length) fail(problems.join('\n'))
  return new Set(list.map(entry => entry.path))
}

const options = parse(process.argv.slice(2))
const files = tracked(options.root)
const skipped = exceptions(options.root, files)
const chosen = files.filter(file => !skipped.has(file))
if (options.list) {
  process.stdout.write(chosen.map(file => `${file}\n`).join(''))
  process.exit(0)
}
if (!chosen.length) fail(`No tracked *.test.mjs file to run in ${options.root}.`)
const ran = spawnSync(process.execPath, ['--test', ...options.forward, ...chosen], { cwd: options.root, stdio: 'inherit' })
if (ran.error) fail(`node --test could not start: ${ran.error.message}`)
process.exit(ran.status ?? 1)
