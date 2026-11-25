#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNTIME_FILE = 'scripts/test/sdk-runtime.json'
const KNOWN_FILE = 'scripts/test/sdk-known-failures.json'

function parse(argv) {
  const options = { root: fileURLToPath(new URL('../../', import.meta.url)), runtime: process.env.NDEV_SDK_CLAUDE || 'claude' }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root' || argv[i] === '--runtime') {
      if (!argv[i + 1]) fail([`${argv[i]} needs a value. Usage: sdk.mjs [--root <dir>] [--runtime <claude binary>]`])
      options[argv[i].slice(2)] = argv[++i]
    } else fail([`Unknown option ${argv[i]}. Usage: sdk.mjs [--root <dir>] [--runtime <claude binary>]`])
  }
  return options
}

function fail(problems) {
  process.stderr.write(`${problems.join('\n')}\n`)
  process.exit(1)
}

function readJson(root, file, shape) {
  const path = join(root, file)
  if (!existsSync(path)) fail([`${file} is missing in ${root}. ${shape}`])
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail([`${file}: not valid JSON (${error.message}). ${shape}`])
  }
}

function pinned(root) {
  const shape = 'It holds {"package": "@anthropic-ai/claude-code", "version": "<exact version>"}.'
  const runtime = readJson(root, RUNTIME_FILE, shape)
  if (typeof runtime?.package !== 'string' || !/^\d+\.\d+\.\d+$/.test(runtime?.version ?? '')) fail([`${RUNTIME_FILE}: ${shape}`])
  return runtime
}

function known(root) {
  const shape = 'It is a list of {"test": "<test file>: <test name>", "reason": "<why it fails, with the issue>"}; an empty list means no known failure.'
  const list = readJson(root, KNOWN_FILE, shape)
  if (!Array.isArray(list)) fail([`${KNOWN_FILE}: not a list. ${shape}`])
  const problems = []
  for (const entry of list) {
    if (typeof entry?.test !== 'string' || !entry.test.trim()) problems.push(`${KNOWN_FILE}: an entry has no test name. ${shape}`)
    else if (typeof entry.reason !== 'string' || !entry.reason.trim()) problems.push(`${KNOWN_FILE}: the entry for ${entry.test} gives no reason. Say why it fails and name the issue.`)
  }
  if (problems.length) fail(problems)
  return list.map(entry => entry.test)
}

function checkRuntime(runtime, wanted) {
  const install = `Repair: npm install --prefix <folder> ${wanted.package}@${wanted.version}, then run with NDEV_SDK_CLAUDE=<folder>/node_modules/.bin/claude`
  const probe = spawnSync(runtime, ['--version'], { encoding: 'utf8' })
  if (probe.error) fail([`The SDK runtime ${runtime} could not start: ${probe.error.message}. ${install}`])
  const version = probe.stdout.trim().split(/\s+/)[0]
  if (probe.status !== 0 || version !== wanted.version) fail([`The SDK runtime ${runtime} is version ${version || 'unknown'} (exit ${probe.status}: ${probe.stdout.trim()} ${probe.stderr.trim()}), and ${RUNTIME_FILE} pinned ${wanted.version}. ${install}`])
}

function tracked(root) {
  const out = spawnSync('git', ['-C', root, 'ls-files', '-z', '--', '*.test.ts', '*.test.tsx'], { encoding: 'utf8' })
  if (out.status !== 0) fail([`git ls-files in ${root} exited ${out.status}: ${out.stderr.trim()}`])
  return out.stdout.split('\0').filter(Boolean).sort()
}

function parseReport(text) {
  const tests = []
  let file
  let summary
  for (const line of text.split('\n')) {
    const header = /^(\S+\.test\.tsx?):$/.exec(line)
    const result = /^\((pass|fail|skip|todo)\) (.*?)(?: \[[\d.]+m?s\])?$/.exec(line)
    const ran = /^Ran (\d+) tests across (\d+) files?/.exec(line)
    if (header) file = header[1]
    else if (result) tests.push({ file, status: result[1], key: `${file}: ${result[2]}` })
    else if (ran) summary = { tests: Number(ran[1]), files: Number(ran[2]) }
  }
  return { tests, summary }
}

const options = parse(process.argv.slice(2))
const wanted = pinned(options.root)
const expected = known(options.root)
checkRuntime(options.runtime, wanted)
const files = tracked(options.root)
if (!files.length) fail([`No tracked *.test.ts or *.test.tsx file in ${options.root}.`])

const home = mkdtempSync(join(tmpdir(), 'ndev-sdk-home-'))
const env = { ...process.env, HOME: home }
delete env.ANTHROPIC_API_KEY
delete env.CLAUDE_CODE_OAUTH_TOKEN
delete env.ANTHROPIC_AUTH_TOKEN
const ran = spawnSync(options.runtime, ['plugin', 'test', '.'], { cwd: options.root, encoding: 'utf8', env, maxBuffer: 256 * 1024 * 1024 })
rmSync(home, { recursive: true, force: true })
if (ran.error) fail([`${options.runtime} plugin test . could not run: ${ran.error.message}`])
const output = `${ran.stdout}${ran.stderr}`
process.stdout.write(output)

const { tests, summary } = parseReport(output)
const failed = tests.filter(test => test.status === 'fail')
const skipped = tests.filter(test => test.status === 'skip' || test.status === 'todo')
const passed = tests.filter(test => test.status === 'pass')
const problems = []

if (!summary) problems.push(`The run printed no "Ran N tests across M files" line, so it did not finish (${options.runtime} plugin test . exited ${ran.status}).`)
else if (summary.tests !== tests.length) problems.push(`The run printed ${summary.tests} tests and reported ${tests.length}.`)
const reported = new Set(tests.map(test => test.file))
for (const file of files) if (!reported.has(file)) problems.push(`The run did not report ${file}, which git tracks. Repair: run \`${options.runtime} plugin test .\` and read the output for that file.`)
for (const file of reported) if (!files.includes(file)) problems.push(`The run reported ${file}, which git does not track. Repair: git add it, or delete it.`)
if (skipped.length) problems.push(`Skipped tests are not allowed: ${skipped.map(test => test.key).join('; ')}. Repair: run them, or delete them.`)
for (const test of failed) if (!expected.includes(test.key)) problems.push(`Failed: ${test.key}. It is not in ${KNOWN_FILE}. Repair: fix it, or list it there with its reason and issue.`)
for (const key of expected) {
  const found = tests.find(test => test.key === key)
  if (!found) problems.push(`${KNOWN_FILE} lists ${key}, and the run did not report it. Repair: remove or correct the entry.`)
  else if (found.status === 'pass') problems.push(`${key} is listed as a known failure and passes now. Remove it from ${KNOWN_FILE}.`)
}
if (!failed.length && ran.status !== 0) problems.push(`${options.runtime} plugin test . exited ${ran.status} with no failing test in its output. Read the output above.`)
if (failed.length && ran.status === 0) problems.push(`${options.runtime} plugin test . exited 0 and its output lists ${failed.length} failing tests.`)

const knownFailures = failed.filter(test => expected.includes(test.key))
process.stdout.write(`\nSDK suite: ${passed.length} passed, ${failed.length - knownFailures.length} failed, ${skipped.length} skipped, ${knownFailures.length} known failures across ${reported.size} files.\n`)
for (const test of knownFailures) process.stdout.write(`Known failure: ${test.key}\n`)
if (problems.length) fail(problems)
