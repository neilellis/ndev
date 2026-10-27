import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Mode, Steering } from '../types'
import { CONFIG_FILE, loadConfig, missingGitHub, saveSetting } from './config'
import type { Branding, GitHub, LoadedConfig } from './config'
import { agentPrompt, runSetup } from './setup'
import { quality } from './quality'
import { fixAllPrs, startFixAllPrs } from './fix-all-prs'
import { initProjectSection, refreshInitProject, startInitProject } from './init-project'

const PLUGIN = 'ndev'

const mode = atom({ plugin: 'ndev', key: 'mode' } as const, 'light' as Mode)
const steering = atom(
  { plugin: 'ndev', key: 'steering' } as const,
  'interactive' as Steering,
)

// The project's .neil-dev.json as read at session start; the switches write back to it.
let project: LoadedConfig | undefined
// Set while an agent fills in the github key: the next prompt reads the file again.
let reloadPending = false

const MODES: readonly Mode[] = ['light', 'heavy']
const STEERINGS: readonly Steering[] = ['interactive', 'auto']

// The development skill for each mode and steering. Auto steering uses the board-driven
// orchestrators; a task given straight in the prompt still follows the interactive skill's method.
const SKILL: Record<Mode, Record<Steering, string>> = {
  light: { interactive: 'work-light', auto: 'work-light-auto' },
  heavy: { interactive: 'work-heavy', auto: 'work-heavy-auto' },
}

const MODE_TEXT: Record<Mode, string> = {
  light:
    'Development mode: LIGHT. One owner from diagnosis to PR, test first, a worktree, one PR, small helpers only for bounded tool-heavy subtasks. Do not chain planning, review and board skills automatically. If the change turns out to be multi-step, cross-cutting or high-risk, say so and suggest `/dev mode heavy`; do not switch by yourself.',
  heavy:
    'Development mode: HEAVY. A written plan, test-first implementation in stages, an independent review and staged verification before the PR leaves draft. Use it for multi-step features and cross-cutting or high-risk changes.',
}

const skillText = (m: Mode, s: Steering) =>
  s === 'interactive'
    ? `For development work, load the \`ndev:${SKILL[m].interactive}\` skill and follow it.`
    : `To deliver issues (a board pass, or \`--issue <n>\`), load the \`ndev:${SKILL[m].auto}\` skill and follow it. For a task given straight in the prompt with no issue, follow the \`ndev:${SKILL[m].interactive}\` method without stopping to ask.`

const STEERING_TEXT: Record<Steering, string> = {
  interactive:
    'Steering: INTERACTIVE. A human is steering. Confirm scope before a large change, ask when a decision is the human\'s to make, and report at each checkpoint (plan, red test, green, PR). Keep replies short and lead with the next action.',
  auto:
    'Steering: AUTO. No human is steering this session. Do not stop to ask questions: choose the sensible default, record each assumption in the PR description, and continue until the work is done and verified. Stop and leave a pickup note only at a hard blocker (missing credentials, a destructive or outward action without durable authorisation, a decision that would change the specification). Safety rules still apply: no push to the default branch, no `--no-verify`, no `claude -p` spend, no deletion of unknown work.',
}

const label = (m: Mode, s: Steering) => `dev: ${m} · ${s}`

const showStatus = async ($: EngineInterface) => {
  $.ui.status(label(await read($, mode), await read($, steering)))
}

// '' toggles; a known value sets it; anything else is refused with the choices.
const choose = <T extends string>(
  args: string,
  choices: readonly T[],
  current: T,
): T | undefined => {
  const word = args.trim().toLowerCase()
  if (word === '') return choices[(choices.indexOf(current) + 1) % choices.length]
  return choices.find(c => c === word)
}

// Only a project that sets `branding` in .neil-dev.json gets a brand; otherwise nothing names one.
const brandingText = (b: Branding | undefined) =>
  b === undefined
    ? undefined
    : `Branding: this project's brand is ${b.name ?? b.site}, defined at ${b.site}${b.guide ? `; its brand and writing guide is ${b.guide}` : ''}${b.path ? `; its source is ${b.path}` : ''}. Docs, diagram, copy and video skills take colours, type, logo and voice from it.`

// Only a project with a GitHub repository or board gets this line, so skills skip the look-up.
const githubText = (g: GitHub | undefined) =>
  g?.repo
    ? `GitHub (from ${CONFIG_FILE}; do not look these up again): repository ${g.repo}; ${g.board ? `project board ${g.board.owner} #${g.board.number}` : g.board === null ? 'no project board' : 'project board not set yet'}. The github and board scripts read these values from the file.`
    : undefined

const WIKI_TEXT =
  'Living development wiki: ~/dev-wiki (index `wiki.md`, rules `AGENTS.md`). At the start of development work, read the index once and open only the pages that fit. When you learn a reusable, project-neutral development lesson (a user correction, a non-obvious cause, a guard that lied or did not run, a procedure written a second time), record it with the `ndev:dev-wiki` skill before you finish the task. A project-only fact goes to the project wiki (the `remember` skill) instead.'

const LEARN_TEXT =
  'The user ran /learn. Load the `ndev:dev-wiki` skill and follow its /learn section: review this session for reusable development lessons, record each one in ~/dev-wiki, and report them in one line each. If there is none, say so.'

const CORRECTION_TEXT =
  'This prompt may correct how you work. Act on it. If it carries a reusable, project-neutral development lesson, record it with the `ndev:dev-wiki` skill; if it is project-only, use the `remember` skill; if it is neither, do nothing more.'

// Words a person uses to redirect the agent: at the start of the prompt, or as a standing rule.
const CORRECTION =
  /^\s*(no\b|nope\b|stop\b|wrong\b|don'?t\b|do not\b|not like that|that'?s not|instead\b|actually\b|i said\b|why did you\b)|\b(you should(n'?t)?|never do|always do|from now on)\b/i

// Creates ~/dev-wiki from the plugin's kb/ when it is absent. A failure is shown, never swallowed.
const initWiki = async ($: EngineInterface) => {
  try {
    const home = await $.env.get('HOME')
    if (!home) {
      $.ui.toast('dev-wiki: HOME is not set, so ~/dev-wiki was not created.')
      return
    }
    const wiki = `${home}/dev-wiki`
    if (await $.fs.exists(`${wiki}/wiki.md`)) return
    if (await $.fs.exists(wiki)) {
      $.ui.toast(`dev-wiki: ${wiki} exists without wiki.md; not initialised. Move it away to let the plugin create it.`)
      return
    }
    const ran = await $.process.run(
      ['bash', `${$.plugin.root}/scripts/wiki/init.sh`, wiki],
      { timeoutMs: 60000 },
    )
    $.ui.toast(
      ran.exitCode === 0
        ? `dev-wiki: created ${wiki} from the plugin kb/.`
        : `dev-wiki: init.sh exited ${ran.exitCode}: ${ran.stderr.trim().slice(0, 200)}`,
    )
  } catch (error) {
    $.ui.toast(`dev-wiki: init failed: ${String(error).slice(0, 200)}`)
  }
}

// Records a switch in the project's .neil-dev.json and says what happened.
async function persist($: EngineInterface, key: 'mode' | 'steering', value: string) {
  if (project === undefined) return ' Not saved: the project folder is not known yet.'
  if (project.error) return ` Not saved: ${project.path} has an error (${project.error}). Fix the file, then run the command again.`
  try {
    await saveSetting($, project, key, value)
    project = { ...project, exists: true, config: { ...project.config, [key]: value } }
    return ` Saved to ${CONFIG_FILE}; commit it to share the setting.`
  } catch (error) {
    return ` Not saved: writing ${project.path} failed: ${String(error).slice(0, 160)}`
  }
}

// Runs the set-up dialog, then saves the answers, or hands typed answers to an agent.
async function setup($: EngineInterface, all: boolean) {
  if (project === undefined) return 'Set-up did not run: the project folder is not known yet.'
  if (project.error) return `Set-up did not run: ${project.path} has an error (${project.error}). Fix the file, then run /dev-setup.`
  const result = await runSetup($, project, all)
  if (result.kind === 'later') return `Set-up skipped (${result.reason}). Run /dev-setup to answer, or the next session asks again.`
  if (result.kind === 'save') {
    try {
      await saveSetting($, project, 'github', result.github)
    } catch (error) {
      return `Set-up not saved: writing ${project.path} failed: ${String(error).slice(0, 160)}`
    }
    project = { ...project, exists: true, config: { ...project.config, github: result.github } }
    return `Saved github ${JSON.stringify(result.github)} to ${CONFIG_FILE}; commit it to share the setting.`
  }
  const spawned = await $.agent.spawn({
    prompt: agentPrompt(project.path, result.known, result.typed),
    description: `Fill in ${CONFIG_FILE} github`,
  })
  if ('deny' in spawned && spawned.deny) return `Set-up: the agent that resolves your answers did not start (${String(spawned.deny)}). Run /dev-setup again, or edit ${project.path} by hand.`
  reloadPending = true
  return `Set-up: an agent is resolving ${result.typed.join('; ')} and will write ${CONFIG_FILE}.`
}

async function switchMode($: EngineInterface, args: string) {
  const next = choose(args, MODES, await read($, mode))
  if (next === undefined) {
    return { text: `dev mode: "${args.trim()}" is not a mode. Use /dev mode light or /dev mode heavy.` }
  }
  await update($, mode, () => next)
  await showStatus($)

  return {
    text: `Development mode is now ${next}.${await persist($, 'mode', next)}`,
    context: [MODE_TEXT[next], skillText(next, await read($, steering))],
  }
}

async function switchSteering($: EngineInterface, args: string) {
  const next = choose(args, STEERINGS, await read($, steering))
  if (next === undefined) {
    return { text: `dev steering: "${args.trim()}" is not a steering. Use /dev steering interactive or /dev steering auto.` }
  }
  await update($, steering, () => next)
  await showStatus($)

  return {
    text: `Steering is now ${next}.${await persist($, 'steering', next)}`,
    context: [STEERING_TEXT[next], skillText(await read($, mode), next)],
  }
}

// What /dev shows: the commands, and this project's current settings.
async function helpText($: EngineInterface) {
  const g = project?.config.github
  const github =
    project === undefined ? 'project folder not known yet'
    : project.error ? `${project.path} has an error (${project.error})`
    : missingGitHub(project.config).length > 0 ? 'not set up; run /dev setup'
    : g?.repo ? `${g.repo}, ${g.board ? `board ${g.board.owner} #${g.board.number}` : 'no project board'}`
    : 'no GitHub repository'
  return [
    'ndev commands:',
    '  /dev                 show this help; run the set-up first if this project is not set up',
    '  /dev help            show this help',
    `  /dev setup           answer the set-up questions (GitHub repository and board) again; saved in ${CONFIG_FILE}`,
    '  /dev mode [light|heavy]             switch development mode (no value toggles)',
    '  /dev steering [interactive|auto]    switch steering (no value toggles)',
    '  /learn               review this session for lessons and record them in ~/dev-wiki',
    '  /dev-mode, /dev-steering and /dev-setup still work as before.',
    '',
    `Now: ${label(await read($, mode), await read($, steering))}. GitHub: ${github}.`,
  ].join('\n')
}

// Asks at session start when a value is missing. With no one to ask, says how to answer later.
async function setupIfMissing($: EngineInterface, isInteractive: boolean) {
  if (project === undefined || project.error) return
  const missing = missingGitHub(project.config)
  if (missing.length === 0) return
  if (!isInteractive) {
    $.ui.toast(`ndev: ${project.path} has no github ${missing.join(' or ')}. Run /dev-setup in an interactive session.`)
    return
  }
  $.ui.toast(await setup($, false))
}

export const register: Register = on => {
  quality(on, () => project)
  fixAllPrs(on)
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'dev',
      description: 'ndev: help, setup, mode and steering (runs the set-up first if this project is not set up)',
      argumentHint: '[help|setup|mode [light|heavy]|steering [interactive|auto]]',
    })
    await $.command.register({
      name: 'dev-mode',
      description: 'Switch development mode: light (work-light) or heavy (work-heavy). Same as /dev mode',
      argumentHint: '[light|heavy]',
    })
    await $.command.register({
      name: 'dev-steering',
      description: 'Switch steering: interactive (human steers) or auto. Same as /dev steering',
      argumentHint: '[interactive|auto]',
    })
    await $.command.register({
      name: 'dev-setup',
      description: `Answer the project set-up questions (GitHub repository and board) and save them in ${CONFIG_FILE}. Same as /dev setup`,
    })
    await $.command.register({
      name: 'learn',
      description: 'Review this session for development lessons and record them in ~/dev-wiki',
    })
    await startFixAllPrs($)
    project = await loadConfig($, e.cwd)
    await startInitProject($, e.cwd)
    if (project.error) {
      $.ui.toast(`ndev: ${project.path}: ${project.error}. Using light · interactive until it is fixed.`)
    }
    await update($, mode, () => project?.config.mode ?? 'light')
    await update($, steering, () => project?.config.steering ?? 'interactive')
    await showStatus($)
    void initWiki($)
    void setupIfMissing($, e.isInteractive)

    return next(e)
  })

  on('command.run', { command: 'dev-mode' }, async ($, e) => switchMode($, e.args))
  on('command.run', { command: 'dev-steering' }, async ($, e) => switchSteering($, e.args))

  // '' shows the help, or runs the set-up when this project has never answered it.
  // The first word picks the subcommand; the rest is its argument.
  on('command.run', { command: 'dev' }, async ($, e) => {
    const [first = '', ...rest] = e.args.trim().split(/\s+/)
    const word = first.toLowerCase()
    const args = rest.join(' ')
    if (word === 'mode') return switchMode($, args)
    if (word === 'steering') return switchSteering($, args)
    if (word === 'setup') return { text: await setup($, true) }
    if (word === 'help') return { text: await helpText($) }
    if (word !== '') return { text: `dev: "${e.args.trim()}" is not a choice. Use /dev, /dev help, /dev setup, /dev mode or /dev steering.` }
    if (project !== undefined && !project.error && missingGitHub(project.config).length > 0) return { text: await setup($, false) }
    return { text: await helpText($) }
  })

  on('command.run', { command: 'dev-setup' }, async $ => ({ text: await setup($, true) }))

  on('command.run', { command: 'learn' }, () => ({
    text: 'Reviewing this session for lessons.',
    context: [LEARN_TEXT],
  }))

  on('prompt.submit', async ($, e, next) => {
    if (reloadPending && project !== undefined) {
      project = await loadConfig($, project.root)
      if (missingGitHub(project.config).length === 0) reloadPending = false
    }
    await refreshInitProject($)
    return e.command === undefined && e.isMeta !== true && CORRECTION.test(e.text)
      ? next({ ...e, context: [...(e.context ?? []), CORRECTION_TEXT] })
      : next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const m = await read($, mode)
    const st = await read($, steering)
    const text = [
      MODE_TEXT[m],
      STEERING_TEXT[st],
      skillText(m, st),
      brandingText(project?.config.branding),
      githubText(project?.config.github),
      WIKI_TEXT,
      'The human lists the plugin commands with /dev, switches these with /dev mode and /dev steering (or /dev-mode and /dev-steering), sets the GitHub repository and board with /dev setup (or /dev-setup), and asks for a lesson review with /learn.',
    ]
      .filter(Boolean)
      .join('\n\n')

    return {
      sections: [
        ...composed.sections,
        { id: `${PLUGIN}:dev-mode`, text, scope: 'session' },
        ...[initProjectSection()].filter(s => s !== undefined),
      ],
    }
  })
}
