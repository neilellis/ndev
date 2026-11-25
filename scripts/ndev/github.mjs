import { basename, join } from 'node:path'
import { CliError, releaseRoot, run } from './common.mjs'

const needs = {
  'issue-read': ['<issue>'], 'pr-read': ['<pr>'], 'issue-edit': ['<issue>'], 'pr-edit': ['<pr>'],
  'pr-ready': ['<pr>'], 'pr-reopen': ['<pr>'], label: ['<issue-or-pr>', '<label>'], unlabel: ['<issue-or-pr>', '<label>'],
  labelled: ['<label>'], feedback: ['<issue>', '<pr>'], 'issues-by-milestone': ['<exact title>'],
  'pr-search': ['<query>'], 'pr-diff': ['<pr>'], 'pr-commit-dates': ['<pr>'], 'view-json': ['pr|issue'], 'run-status': ['<run-id>'],
  comment: ['<issue-or-pr>', '--body', '<text>'], dump: ['issue|pr', '<n>'],
  subissues: { link: ['<parent>', '<child>'], list: ['<parent>'] },
  'blocked-by': { add: ['<issue>', '<blocker>'], remove: ['<issue>', '<blocker>'], list: ['<issue>'], blocking: ['<issue>'] },
  board: { ready: [], awaiting: [], items: [], fields: [], move: ['<item-id>', '<column>'], set: ['<item-id>', '<field>', '<value>'], add: ['<issue>'] },
}

function checkArguments(verb, argv) {
  const repair = `ndev github ${verb} --help`
  const shape = needs[verb]
  if (!shape) return
  if (Array.isArray(shape)) {
    if (argv.length < shape.length) throw new CliError(2, `ndev github ${verb} needs ${shape.join(' ')}.`, { repair })
    return
  }
  const [sub, ...rest] = argv
  if (!sub) throw new CliError(2, `ndev github ${verb} needs one of ${Object.keys(shape).join(', ')}.`, { repair })
  if (!Object.hasOwn(shape, sub)) throw new CliError(2, `ndev github ${verb} has no subcommand ${JSON.stringify(sub)}.`, { repair })
  if (rest.length < shape[sub].length) throw new CliError(2, `ndev github ${verb} ${sub} needs ${shape[sub].join(' ')}.`, { repair })
}

const parsed = line => {
  try { return JSON.parse(line) } catch { return line }
}

const helpers = {
  dump: { executable: 'python3', script: 'scripts/github/dump.py', timeout: 300_000 },
  'merge-main': { executable: 'bash', script: 'scripts/github/merge-main-into-open-prs.sh', timeout: 0 },
}

function invocation(verb, argv) {
  const helper = helpers[verb]
  if (helper) {
    const script = join(releaseRoot, helper.script)
    return { executable: helper.executable, argv: [script, ...argv], label: [basename(script), ...argv].join(' '), command: [script, ...argv].join(' '), timeout: helper.timeout }
  }
  const script = process.env.NDEV_FLOW_GH || join(releaseRoot, 'scripts/github/gh.sh')
  return { executable: 'bash', argv: [script, verb, ...argv], label: ['gh.sh', verb, ...argv].join(' '), command: [script, verb, ...argv].join(' '), timeout: 300_000, posts: true }
}

export function runGitHub([verb, ...argv]) {
  checkArguments(verb, argv)
  const call = invocation(verb, argv)
  const result = run(call.executable, call.argv, { cwd: process.cwd(), env: process.env, timeout: call.timeout })
  if (result.stderr.trim() && result.status === 0) process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`)
  if (result.status !== 0) {
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n') || 'no output'
    const message = `${call.label} exited ${result.status}: ${output}`
    const details = { command: call.command, exitCode: result.status, output }
    if (result.status === 2) throw new CliError(2, message, { details, ...(/^(gh\.sh: )?usage:/m.test(output) ? { repair: `ndev github ${verb} --help` } : {}) })
    if (result.status === 3 && call.posts) throw new CliError(1, message, { repair: `Nothing was posted. Fix what the message names, then run ndev github ${verb} again.`, details })
    throw new CliError(1, message, { details })
  }
  const lines = result.stdout.split('\n').filter(line => line.trim()).map(parsed)
  return { lines, text: result.stdout.replace(/\n$/, '') }
}
