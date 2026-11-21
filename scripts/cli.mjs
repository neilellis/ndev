import { CliError } from './ndev/common.mjs'
import release from '../package.json' with { type: 'json' }

const { version } = release
const groups = {
  project: {
    description: 'Read and set project and worktree settings',
    module: './ndev/project.mjs', run: 'runProject',
    commands: {
      status: '', setup: '[--repo <owner/name>|--no-repo] [--board <owner/number>|--no-board]',
      mode: '[light|heavy|hack]', steering: '[interactive|auto]', init: '',
      credentials: '[--copy-from-main|--init]', learn: '', guidance: '<kind> <description>',
      'report-workflow-bug': '--title <title> --details <text>',
    },
  },
  flow: {
    description: 'Start and advance the work on an issue or pull request',
    module: './export/flow/cli.ts', run: 'runFlow',
    commands: {
      help: '', guide: '', status: '[--issue <n>|--pr <n>]',
      start: '<issue> [--pr <n>] [--short-name <slug>] [--mode <mode>] [--take-over]',
      repair: '--issue <n> --pr <n> [--take-over]',
      create: '<short-name> --description-file <file> [--mode <mode>]',
      hotfix: '<short-name> [--issue <n>] [--description-file <file>]',
      comment: '--issue <n>|--pr <n> --message-file <file>',
      interview: '[--round-file <json>|--answers-file <json>|--finish]',
      'finished-interview': '', 'finished-plan': '--markdown-file <file>', 'finished-hacking': '',
      checkpoint: '--message <text> --file <path>... [--change-type <type>]... [--worktree <path>]',
      'finished-development': '[--issue <n>]... [--pr <n>]... [--message <text>] [--file <path>]... [--change-type <type>]... [--body-file <file>] [--hardening <text>] [--human-confirmation <text>]',
      'push-draft': '[--issue <n>|--pr <n>] --sha <full-reviewed-sha> --review <text>',
      'finished-review': '(--review <text> | --waive-review <reason>) --deadcode <text> --remembered <text>',
      'finished-checks': '', 'finished-smoke': '--report-file <file>|--skipped <reason>',
      'finished-revision': '', done: '--message <text> [--remembered <text>]',
      blocked: '--message <text>', unblock: '[<answer>]',
      'follow-up': '--mode <this_agent|subagent|worktree|issue_only> --message-file <file> [--existing-issue <n>]...',
      'add-migration': '<name> [--workdir <path>] [--new-version]', 'request-secret': '<name>',
      mode: '[light|heavy|hack]', steering: '[interactive|auto] [--reason <text>]', skip: '[<reason>]',
      goto: '<state> [<reason>]', off: '[<reason>] [--project]', on: '[--project]',
    },
  },
  wait: {
    description: 'Wait for a named condition',
    module: './ndev/waits.mjs', run: 'runWait',
    commands: {
      agent: '<dispatch-id|session-id>', url: '<url>', process: '<pid>', seconds: '<seconds>',
      command: '-- <executable> [<arg>...]', pr: '<target-pr> <open|closed|merged|draft|ready|mergeable>',
      issue: '<open|closed> <target-issue>...', state: '<target-issue> <state>',
    },
  },
  epic: {
    description: 'Coordinate issues and workers for an epic',
    module: './ndev/epic.mjs', run: 'runEpic',
    commands: {
      start: '[<issue>|--title <text>] [--short-name <slug>] [--parallel <n>] [--implementer <agent>] [--implementer-model <model>] [--reviewer <agent>] [--reviewer-model <model>] [--run <id>] [--repo-id <id>] [--remote [<server>]|--local] [--remote-repo <selector>] [--take-over] [--base-sha <sha>] [--coordinator-model <model>] [--posture <standard|deadline>] [--full-suites-file <json>]',
      import: '<epic> --issues-file <json> --evidence <text>',
      phase: '<epic> <phase> --evidence <text> [--file <path>]... [--aim <text>] [--issues-file <json>] [--closing-file <json>]',
      debt: '<epic> --file <json>', ruling: '<epic> <debt-key> --file <json>',
      next: '<epic>', brief: '<epic> <sub> <implementer|reviewer> [--pr <n>]',
      issue: '<epic> <sub> <state> [--pr <n>] [--worker <id>] [--workspace <selector>] [--verdict <approve|changes>] [--note <text>] [--override <reason>]',
      status: '[<epic>]', skip: '[<reason>] [--issue <n>]', goto: '<state> [<reason>] [--issue <n>]', off: '[--issue <n>]',
    },
  },
  remote: {
    description: 'Select and manage a saved Orca server',
    module: './ndev/remote.mjs', run: 'runRemote',
    commands: {
      status: '', set: '<server>', list: '', off: '',
      create: '<name> [--context <name>] [--type <type>] [--location <location>] [--ssh-key <key>] [--floating-ip <name-or-id>] [--yes]',
      remove: '<name> [--context <name>] [--floating-ip <name-or-id>] [--forget] [--unverified-host] [--yes]',
      import: '<hetzner-id> --context <name> [--floating-ip <name-or-id>] [--name <name>] [--yes]',
      resize: '[<type>] [--context <name>] [--server <selector>] [--ssh <user@host>] [--agent <agent>] [--yes]',
    },
  },
  triage: {
    description: 'Group issues and coordinate work in Orca',
    module: './ndev/triage.mjs', run: 'runTriage',
    commands: {
      start: '[--dry-run] [--codex] [--open] [--batch <n>|--sequential] [--since <n>] [--reverse] [--bugs-only] [--mine] [--remote [<server>]] [--hint <text>]',
      clean: '[--since <n>] [--reverse] [--mine] [--hint <text>]', groups: '--file <json>',
      'clean-verdicts': '--file <json>', confirm: '--issue <n> --revision <n> <close|keep>',
      launch: '', refresh: '', reset: '', status: '',
    },
  },
  'fix-prs': {
    description: 'Run and inspect the pull request queue',
    module: './ndev/fix-prs.mjs', run: 'runFixPrs',
    commands: {
      start: '[--no-merge]', status: '', pause: '', resume: '', skip: '<pr>', retry: '<pr>',
      report: '<pr> <pushed|blocked> [--reason <text>] [--worktree <path>]',
    },
  },
  pane: {
    description: 'Show worktree and browser data in Orca or as text',
    module: './ndev/panes.mjs', run: 'runPane',
    commands: {
      view: '[--open]', 'responsive-matrix': '[--open]',
      screenshot: '<url> [--viewport <width>x<height>]... [--scheme <light|dark>]... [--full-page] [--wait-seconds <n>]',
      files: '<create|copy-from-main> <name>', resources: '<stop-server|stop-stack|stop-all|forget> <args>',
    },
    internal: ['bridge'],
  },
  'walk-doc': {
    description: 'Run a fresh reader through the documentation',
    module: './ndev/walk-doc.mjs', run: 'runWalkDoc',
    commands: {
      start: '<path-or-url> [--persona <text>] [--re-record] [--open]', ask: '<question>',
      answer: '<ask-number> <text>', restart: '[<note>]', tip: '<text>', stop: '', status: '',
      report: '--file <json>', enhance: '--file <json>', record: '--file <json>', reply: '--file <json>',
      escalate: '--file <json>', done: '<summary>', finish: '[<summary>]',
    },
  },
  install: {
    description: 'Install or verify ndev for an agent harness',
    module: './export/export.mjs', run: 'runInstall',
    usage: '<harness|all> [--prefix <dir>] [--dry-run] [--panels] [--approve <fingerprint>]',
    commands: { verify: '<harness|all> [--prefix <dir>]' },
  },
  'chat-guard': {
    description: 'Protect native Orca chats from expensive idle sends',
    module: './ndev/chat-guard.mjs', run: 'runChatGuard',
    commands: { on: '', off: '', status: '' },
  },
  hook: {
    description: 'Handle a native harness event',
    module: './ndev/hooks.mjs', run: 'runHook',
    usage: '<event> [--harness <harness>]',
    commands: {
      'session-start': '', 'prompt-submit': '', 'prompt-context': '', 'pre-tool-use': '',
      'post-tool-use': '', 'turn-start': '', 'turn-complete': '', 'session-end': '', compact: '',
    },
  },
  watch: {
    description: 'Watch the session and its checks in an Orca terminal',
    module: './ndev/watch.mjs', run: 'runWatch',
    usage: '[--session <id>] [--worktree <selector>] [--once]',
  },
}

const standardFlags = ' [--help] [--json]'
const flowTarget = '\nMost transitions accept --issue <n> or --pr <n> to select the workflow.'
const waitFlags = '\nWait options: --issue <n>|--pr <n> --period <seconds> --attempts <n> --timeout <seconds>'

function help(group, command) {
  if (!group) {
    const entries = Object.entries(groups).map(([name, { description }]) => `  ${name.padEnd(10)} ${description}`)
    return ['Usage: ndev <group> <command> [options]', '', ...entries, '', 'Use ndev <group> --help for commands, or ndev --version.'].join('\n')
  }
  const definition = groups[group]
  const usage = definition.usage ? `ndev ${group} ${definition.usage}` : `ndev ${group} <command>`
  const commands = Object.entries(definition.commands ?? {}).map(([name, args]) => `  ndev ${group} ${name}${args ? ` ${args}` : ''}`)
  const extra = group === 'flow' ? flowTarget : group === 'wait' ? waitFlags : ''
  if (command && Object.hasOwn(definition.commands ?? {}, command)) {
    const args = definition.commands[command]
    return `Usage: ndev ${group} ${command}${args ? ` ${args}` : ''}${standardFlags}${extra}`
  }
  return [`Usage: ${usage}${standardFlags}`, definition.description, ...commands, extra].filter(Boolean).join('\n')
}

function commonFlags(argv) {
  const boundary = argv.indexOf('--')
  const flags = boundary < 0 ? argv : argv.slice(0, boundary)
  const trailing = boundary < 0 ? [] : argv.slice(boundary)
  const json = flags.includes('--json')
  const wantsHelp = flags.includes('--help') || flags.includes('-h')
  const command = flags.filter(argument => !['--json', '--help', '-h'].includes(argument))
  return { argv: [...command, ...trailing], json, wantsHelp }
}

async function execute(argv, wantsHelp, json) {
  const [group, verb, ...tail] = argv
  if (group === '--version' && !verb) return { version, text: version }
  if (!group || (group === 'help' && !verb)) return { text: help() }
  if (!Object.hasOwn(groups, group)) throw new CliError(2, `Unknown group ${JSON.stringify(group)}.`, { repair: 'ndev --help' })
  const definition = groups[group]
  const commandExists = Object.hasOwn(definition.commands ?? {}, verb)
  if (wantsHelp || verb === 'help' || (!verb && !definition.usage)) return { text: help(group, commandExists && verb !== 'help' ? verb : undefined) }
  if (!definition.usage && !commandExists && !definition.internal?.includes(verb)) {
    throw new CliError(2, `Unknown ${group} command ${JSON.stringify(verb)}.`, { repair: `ndev ${group} --help` })
  }
  if (group === 'flow' && verb === 'unblock') {
    const { cancelActiveWait } = await import('./ndev/waits.mjs')
    const ended = cancelActiveWait(tail)
    if (ended) return ended
  }
  const implementation = await import(definition.module)
  const handler = implementation[definition.run]
  if (typeof handler !== 'function') throw new Error(`The ndev release does not export ${definition.run} from ${definition.module}.`)
  const subcommand = verb === undefined ? [] : [verb, ...tail]
  if (group !== 'flow') return ['epic', 'triage', 'walk-doc'].includes(group) ? handler(subcommand, { json }) : handler(subcommand)
  const result = await handler(subcommand, { json })
  if (verb === 'interview' && Array.isArray(result?.questions)) {
    const { publishPanel } = await import('./ndev/panes.mjs')
    await publishPanel('interview', result, { cwd: result.root })
  }
  return result
}

function print(result, json) {
  if (json) {
    const output = result?.version === version && result.text === version ? { version } : result
    console.log(JSON.stringify({ ok: true, result: output ?? {} }))
  } else if (result?.native !== undefined) {
    if (result.native !== null) console.log(JSON.stringify(result.native))
  } else if (result !== undefined) {
    console.log(typeof result === 'string' ? result : result.text ?? JSON.stringify(result, null, 2))
  }
}

const { argv, json, wantsHelp } = commonFlags(process.argv.slice(2))
try {
  print(await execute(argv, wantsHelp, json), json)
} catch (error) {
  const code = Number.isInteger(error.code) && error.code > 0 && error.code < 126 ? error.code : 1
  const kind = error.errorCode ?? (code === 2 ? 'invalid_argument' : code === 3 ? 'timeout' : code === 4 ? 'cancelled' : code === 5 ? 'conflict' : 'operation_failed')
  if (json) {
    console.log(JSON.stringify({ ok: false, error: { code: kind, message: error.message, details: error.details, repair: error.repair } }))
  } else {
    const repair = error.repair && ` Repair: ${error.repair}`
    console.error(`ndev: ${error.message}${repair || ''}`)
  }
  process.exitCode = code
}
