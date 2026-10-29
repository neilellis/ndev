// The walk's pure logic: arguments, config, page URLs, the report and reply protocol, the guard and the final report.
// index.tsx wires it to the engine; nothing here reaches `$`.

import type { WalkAsk as Ask, WalkFinding as Finding, WalkRun as Run } from '../../types'

export const PLUGIN = 'ndev'
export const TOOL = <N extends string>(name: N) => `mcp__ndev__${name}` as const
export const AGENT = `${PLUGIN}:walk`
export const CONFIG_FILE = '.walk-doc.json'
export const MAX_RESTARTS = 20
export const SAME_STEP_LIMIT = 10
export const BLOCKING = ['OMISSION', 'BUG', 'INCORRECT', 'BLOCKED'] as const
export type Code = (typeof BLOCKING)[number]
export type { Ask, Finding, Run }
export const DEFAULT_PERSONA = 'a competent developer who has never seen this project before'

export type Config = {
  // argv of the docs dev server, run from the repo root; `{port}` is replaced by the chosen port.
  devCommand: string[]
  // Where the docs pages live; a page's URL is its path under this folder.
  contentRoot: string
  // Repo-relative folders and files the Walk agent may not read.
  deny: string[]
  // Commands the main agent runs once, after the walk and before the report.
  finish: string[]
  // How these docs embed recordings and screenshots, told to the main agent with each RECORD.
  media: string
  // The command that files an issue for a product fault the docs flow does not need fixed; '' files none.
  issues: string
  // What the person wants every reader told: what it can use, where things are. /walk-doc tip adds one.
  tips: string[]
  // Who the reader is, unless /walk-doc --persona names one.
  persona: string
  // The project-root file of KEY=VALUE pairs the reader may use (passwords the docs say to ask for); null: none.
  valuesFile: string | null
  // The valuesFile keys the reader gets, when the file also holds keys it must not see (an API key); null: every key.
  valueKeys: string[] | null
  // How the reader gets a fresh Linux machine or container, and the bash that deletes a walk's machines by
  // name prefix ({prefix}); null: the reader works on this computer only.
  machines: { guide: string[]; cleanup: string } | null
}

// The example value each refusal shows, so the person can copy it into the file.
const EXAMPLES: Record<string, unknown> = {
  devCommand: ['pnpm', 'dev', '--port', '{port}'],
  contentRoot: 'docs/content',
  deny: ['src', 'scripts', 'internal-docs'],
  finish: ['pnpm run check-docs'],
  media: 'Copy media into public/media/ and embed a screenshot as ![caption](/media/name.jpg).',
  issues: 'gh issue create --title <title> --body-file <file>',
  tips: ['Docker is installed and running.'],
  persona: 'a developer on a Linux laptop who has never seen this project before',
  valuesFile: '.neil-dev.env',
  valueKeys: ['DOWNLOAD_USER', 'DOWNLOAD_PASSWORD'],
  machines: { guide: ['For a Linux install, make a fresh container: docker run -d --name <name> ubuntu sleep infinity.'], cleanup: 'ids=$(docker ps -aq --filter name=^{prefix}) || exit 1; [ -z "$ids" ] || docker rm -f $ids' },
}
const example = (key: string) => `for example "${key}": ${JSON.stringify(EXAMPLES[key])}`
const REQUIRED = ['devCommand', 'contentRoot', 'deny', 'finish', 'media', 'issues']
// A config with every required key, for the refusal when the file is absent.
export const exampleConfig = () => JSON.stringify(Object.fromEntries(REQUIRED.map(k => [k, EXAMPLES[k]])))

export function newRun(a: {
  runId: string; target: string; startUrls: string[]; persona: string; root: string; home: string
  port: number; pid: number; now: number; allowedPaths: string[]; reRecord?: boolean
}): Run {
  return {
    runId: a.runId, phase: 'walking', target: a.target, startUrls: a.startUrls, persona: a.persona, root: a.root,
    home: a.home, port: a.port, pid: a.pid, attempt: 1, agentId: null, agentIds: [], stepBlocks: {}, findings: [],
    denials: [], allowedPaths: a.allowedPaths, startedAt: a.now, summary: null, nudges: 0,
    reRecord: a.reRecord ?? false,
  }
}

export const workspaceOf = (run: Run, attempt = run.attempt) => `${run.home}/.walk-doc/${run.runId}/attempt-${attempt}`
export const runDirOf = (run: Run) => `${run.root}/walk-run/${run.runId}`
export const machineName = (run: Run, attempt = run.attempt) => `walk-${run.runId}-${attempt}`

// --re-record may stand anywhere outside the quoted persona; it asks the reader to record each recording on the page again.
export function parseArgs(args: string): { target: string; persona: string | null; reRecord: boolean } | { error: string } {
  const flag = /(^|\s)--re-record(?=\s|$)/
  const reRecord = flag.test(args)
  const m = /^\s*(\S+)(?:\s+--persona\s+(?:"([^"]*)"|'([^']*)'|(.+?)))?\s*$/.exec(args.replace(flag, ' '))
  if (m === null || m[1]!.startsWith('--')) return { error: 'Usage: /walk-doc <path|url> [--persona "who the reader is"] [--re-record]. Give a docs content file or folder, or a docs URL. During a walk: /walk-doc ask <question>, /walk-doc restart [note], /walk-doc tip <text> or /walk-doc stop.' }
  const persona = m[2] ?? m[3] ?? m[4] ?? null
  return { target: m[1]!, persona: persona === null || persona.trim() === '' ? null : persona.trim(), reRecord }
}

// Every key the project must supply is refused, when absent or wrong, with the key, the file and an example value.
export function parseConfig(text: string, file = CONFIG_FILE): Config {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${String(error)}. Fix the file at the project root.`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${file} must be a JSON object with the keys ${REQUIRED.join(', ')}, for example ${exampleConfig()}.`)
  }
  const o = raw as Record<string, unknown>
  const unknown = Object.keys(o).find(k => !(k in EXAMPLES))
  if (unknown !== undefined) throw new Error(`${unknown} is not a key of ${file}. The keys are ${Object.keys(EXAMPLES).join(', ')}. Fix or remove it.`)
  const strings = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string')
  const missing = (key: string, what: string) => new Error(`${key} is missing in ${file}: give ${what}, ${example(key)}.`)
  const wrong = (key: string, what: string) => new Error(`${key} in ${file} must be ${what}, ${example(key)}.`)
  const required = (key: string, what: string, ok: (v: unknown) => boolean, kind: string) => {
    if (o[key] === undefined || o[key] === '') throw missing(key, what)
    if (!ok(o[key])) throw wrong(key, kind)
  }
  required('devCommand', "the docs dev server's argv, run from the project root", v => strings(v) && (v as string[]).length > 0, 'a list of strings: the argv')
  if (!(o.devCommand as string[]).some(x => x.includes('{port}'))) {
    throw new Error(`devCommand in ${file} has no {port}: the walk picks a free port, so the command must take it, ${example('devCommand')}.`)
  }
  required('contentRoot', 'the folder that holds the docs pages', v => typeof v === 'string', 'a string: the folder that holds the docs pages')
  required('deny', 'the project-relative folders and files the reader may not read', strings, 'a list of project-relative paths')
  required('finish', 'the commands the main agent runs after the walk ([] for none)', strings, 'a list of commands')
  required('media', 'how these docs embed recordings and screenshots', v => typeof v === 'string', 'a string: how the docs embed recordings and screenshots')
  if (o.issues === undefined) throw missing('issues', 'the command that files an issue ("" to file none)')
  if (typeof o.issues !== 'string') throw wrong('issues', 'a string: the command that files an issue')
  if (o.tips !== undefined && !strings(o.tips)) throw wrong('tips', 'a list of strings: what every reader is told')
  if (o.persona !== undefined && (typeof o.persona !== 'string' || o.persona.trim() === '')) throw wrong('persona', 'a non-empty string: who the reader is')
  if (o.valuesFile !== undefined && (typeof o.valuesFile !== 'string' || o.valuesFile === '' || o.valuesFile.includes('/'))) throw wrong('valuesFile', 'a file name at the project root')
  if (o.valueKeys !== undefined && (!strings(o.valueKeys) || !(o.valueKeys as string[]).every(k => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)))) throw wrong('valueKeys', 'a list of KEY names from the valuesFile')
  if (o.valueKeys !== undefined && o.valuesFile === undefined) throw new Error(`valueKeys in ${file} needs valuesFile: it names keys of that file, ${example('valuesFile')}.`)
  const m = o.machines as { guide?: unknown; cleanup?: unknown } | undefined
  if (m !== undefined && (typeof m !== 'object' || m === null || !strings(m.guide) || typeof m.cleanup !== 'string')) {
    throw wrong('machines', 'an object with guide (a list of lines for the reader) and cleanup (bash)')
  }
  if (m !== undefined && !(m.cleanup as string).includes('{prefix}')) {
    throw new Error(`machines.cleanup in ${file} has no {prefix}: it must delete only the machines whose name starts with the walk's prefix, ${example('machines')}.`)
  }
  return {
    devCommand: o.devCommand as string[],
    contentRoot: trimSlashes(o.contentRoot as string),
    deny: (o.deny as string[]).map(trimSlashes),
    finish: o.finish as string[],
    media: o.media as string,
    issues: o.issues,
    tips: (o.tips as string[] | undefined) ?? [],
    persona: (o.persona as string | undefined)?.trim() ?? DEFAULT_PERSONA,
    valuesFile: (o.valuesFile as string | undefined) ?? null,
    valueKeys: (o.valueKeys as string[] | undefined) ?? null,
    machines: m === undefined ? null : { guide: m.guide as string[], cleanup: m.cleanup as string },
  }
}

// A tip typed in quotes, as for a shell, is kept without them.
export const cleanTip = (tip: string) => tip.trim().replace(/^"([^"]*)"$|^'([^']*)'$/, '$1$2').trim()

// /walk-doc tip: the config text with one more tip, for the file at the repo root.
export function addTip(text: string, tip: string): string {
  const t = cleanTip(tip)
  if (t === '') throw new Error('Usage: /walk-doc tip <text>. Say what every reader should know.')
  const config = parseConfig(text)
  if (config.tips.includes(t)) throw new Error(`that tip is already in ${CONFIG_FILE}: ${t}`)
  const raw = JSON.parse(text) as Record<string, unknown>
  return `${JSON.stringify({ ...raw, tips: [...config.tips, t] }, null, 2)}\n`
}

export const tipsNote = (tips: string[]) => (tips.length === 0 ? '' : ['Tips from the person who runs this walk:', ...tips.map(t => `- ${t}`)].join('\n'))

const trimSlashes = (p: string) => p.replace(/^\.\//, '').replace(/\/+$/, '')
export const isUrl = (target: string) => /^https?:\/\//.test(target)

export function pageUrl(target: string, config: Config, base: string): string {
  if (isUrl(target)) return target
  const rel = trimSlashes(target)
  if (rel !== config.contentRoot && !rel.startsWith(`${config.contentRoot}/`)) {
    throw new Error(`${target} is not under the content root ${config.contentRoot} (${CONFIG_FILE}). Give a docs page or folder under it, or a docs URL.`)
  }
  let page = rel.slice(config.contentRoot.length).replace(/^\//, '').replace(/\.mdx?$/, '')
  page = page === 'index' ? '' : page.replace(/\/index$/, '')
  return `${base}/${page === '' ? '' : `${page}/`}`
}

// Inline code spans that look like a file path: a slash with a dotted last part, or a ~ path.
export function docsNamedPaths(mdx: string): string[] {
  const found = new Set<string>()
  for (const m of mdx.matchAll(/`([^`\s]+)`/g)) {
    const p = m[1]!
    const isPath = p.startsWith('~/') || (p.includes('/') && /\.[A-Za-z0-9]+$/.test(p.split('/').pop() ?? ''))
    if (isPath && !/^https?:/.test(p) && !p.startsWith('./')) found.add(p)
  }
  return [...found]
}

type ReportInput = { code?: unknown; step?: unknown; expected?: unknown; actual?: unknown; evidence?: unknown }

// How the main agent treats a product fault: fix it as it happens; an issue only when it cannot; never a workaround in the docs.
export const faultRule = (issues: string) =>
  `Fix a product fault in the product as it happens, wherever you can, even when the docs flow could step round it. Never document a workaround for it. If the docs flow needs it and you cannot fix it, escalate. Only when you cannot fix it now and the docs flow does not need it, leave the docs as they were and ${issues === '' ? 'say in your reply that an issue is needed: no issue command is set ("issues" in .walk-doc.json) to file an issue with.' : `file an issue with: ${issues}`}`

export function recordReport(run: Run, input: ReportInput, now: number, issues = ''): { run: Run; walkReply: string; mainMessage: string } {
  if (input.code === 'ENHANCE') throw new Error('ENHANCE does not stop the walk: call walk_enhance with the note and carry on.')
  if (input.code === 'RECORD') throw new Error('RECORD does not stop the walk: call walk_record with the file and carry on.')
  if (!BLOCKING.includes(input.code as Code)) throw new Error(`code must be one of ${BLOCKING.join(', ')}; got ${JSON.stringify(input.code)}.`)
  for (const field of ['step', 'expected', 'actual', 'evidence'] as const) {
    if (typeof input[field] !== 'string' || (input[field] as string).trim() === '') {
      throw new Error(`walk_report needs a non-empty ${field}. step: the page and heading; expected: what the docs say, quoted; actual: what happened; evidence: the command, exit code and output, or the screenshot.`)
    }
  }
  if (run.phase === 'awaiting') throw new Error('The walk already waits for the main agent on an earlier report. End your turn now.')
  if (run.phase !== 'walking') throw new Error(`The walk is ${run.phase}; there is nothing to report to. Stop.`)
  const code = input.code as Code
  const step = (input.step as string).trim()
  const finding: Finding = {
    n: run.findings.length + 1, code, step, expected: input.expected as string, actual: input.actual as string,
    evidence: input.evidence as string, attempt: run.attempt, at: now, resolution: null,
  }
  const next: Run = {
    ...run,
    phase: 'awaiting',
    findings: [...run.findings, finding],
    stepBlocks: { ...run.stepBlocks, [step]: (run.stepBlocks[step] ?? 0) + 1 },
  }
  return { run: next, walkReply: 'Report recorded. End your turn now and wait: the main agent answers with CONTINUE, or a fresh reader takes over.', mainMessage: mainMessage(next, finding, issues) }
}

function mainMessage(run: Run, f: Finding, issues: string): string {
  const blocks = run.stepBlocks[f.step] ?? 0
  const lines = [
    `Walk report #${f.n}: ${f.code} at ${f.step} (attempt ${run.attempt}, ${blocks} block${blocks === 1 ? '' : 's'} on this step).`,
    `Expected (the docs): ${f.expected}`,
    `Actual: ${f.actual}`,
    `Evidence: ${f.evidence}`,
    '',
    'Fix it like a developer on this branch: docs, code or both, one commit per fix with a message that starts "walk-doc ' + f.code + ':". Do not push, and open no worktree or PR. Helpers may work in parallel.',
    faultRule(issues),
  ]
  if (f.code === 'BUG' || f.code === 'INCORRECT') {
    lines.push('First check whether this branch already fixes it (git log, the regression test): the reader may run a released build that predates the branch, such as a published image. If it does, change nothing: reply CONTINUE naming the commit, and tell the reader which faults to expect from the older build.')
  }
  if (f.code === 'BLOCKED') {
    lines.push('BLOCKED comes to you, not the person. Try every route a developer at a laptop would: existing local credentials (.env, keychain, gh auth) passed on without printing them, a dev or local mode, a free sign-up, a stub or mock the docs describe, a helper to diagnose. No paid sign-ups and no third-party accounts in the person\'s name: for those, call walk_escalate.')
  }
  if (f.code === 'INCORRECT') lines.push('Decide which side is wrong. If you cannot tell whether the docs or the product is right, that is the person\'s product decision: call walk_escalate.')
  if (blocks >= SAME_STEP_LIMIT) lines.push(`This step has blocked ${blocks} times. Change approach: RESTART with a fresh reader, or diagnose with a helper and CONTINUE with new_approach saying what changed. Escalate only if it blocks again after that.`)
  // a dev server's file watcher can drop an edit; the reader then retries against the old page
  lines.push('', 'Before you reply, fetch each changed page from the docs server and confirm it serves your change. If it does not, touch the file and fetch again. A long page can take a minute or more to rebuild: a Next dev server writes an emit event to .next/trace when a rebuild finishes, so look for one after your touch before you call the change unserved.')
  lines.push('Then call walk_reply with action CONTINUE (the same reader retries the step) or RESTART (a fresh reader and a fresh environment from step 1), a note, and changed: the pages you changed.')
  return lines.join('\n')
}

// ENHANCE goes to the main agent at once, and the reader carries on without waiting for the answer.
export function recordEnhance(run: Run, input: { step?: unknown; note?: unknown }, now: number, issues = ''): { run: Run; walkReply: string; mainMessage: string } {
  const note = typeof input.note === 'string' ? input.note.trim() : ''
  if (note === '') throw new Error('walk_enhance needs a non-empty note: what could be better, and where.')
  if (run.phase !== 'walking' && run.phase !== 'awaiting') throw new Error(`The walk is ${run.phase}; there is nothing to note it to. Stop.`)
  const step = typeof input.step === 'string' && input.step.trim() !== '' ? input.step.trim() : '(no step given)'
  const finding: Finding = { n: run.findings.length + 1, code: 'ENHANCE', step, expected: '', actual: note, evidence: '', attempt: run.attempt, at: now, resolution: null }
  return {
    run: { ...run, findings: [...run.findings, finding] },
    walkReply: 'Noted and sent to the main agent. Carry on with the walk; do not wait for an answer.',
    mainMessage: [
      `Walk ENHANCE #${finding.n} at ${step} (the reader carries on): ${note}`,
      '',
      faultRule(issues),
      `If it is worth doing, do it on this branch in one commit that starts "walk-doc ENHANCE:". Then call walk_reply with action NOTED, answers: ${finding.n}, a note (what you changed, or why not) and changed: the pages you changed. The answer shows in the walk pane; the reader is not stopped.`,
    ].join('\n'),
  }
}

const MEDIA_TYPES = ['.cast', '.webm', '.gif', '.jpg', '.jpeg']
type RecordInput = { step?: unknown; file?: unknown; mode?: unknown; replaces?: unknown; caption?: unknown }

// RECORD asks the main agent to put a recording or screenshot in the docs; the reader carries on without waiting.
export function recordMedia(run: Run, input: RecordInput, config: Config, now: number, pluginRoot: string): { run: Run; walkReply: string; mainMessage: string } {
  if (run.phase !== 'walking' && run.phase !== 'awaiting') throw new Error(`The walk is ${run.phase}; there is nothing to record it to. Stop.`)
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const file = text(input.file)
  const walkDir = `${run.home}/.walk-doc/${run.runId}/`
  if (!file.startsWith(walkDir) || file.includes('/../')) throw new Error(`walk_record needs a file in this walk's folder ${walkDir}; your media folder is ${mediaDirOf(run)}. Got ${JSON.stringify(file)}.`)
  if (!MEDIA_TYPES.some(t => file.toLowerCase().endsWith(t))) throw new Error(`walk_record takes a .cast, .webm, .gif or .jpg file; got ${file}. Save a screenshot as JPEG with browser_take_screenshot and a filename ending .jpg, or convert one with: sips -s format jpeg <screenshot> --out <name>.jpg`)
  if (input.mode !== 'INSERT' && input.mode !== 'REPLACE') throw new Error(`walk_record mode must be INSERT or REPLACE; got ${JSON.stringify(input.mode)}.`)
  const replaces = text(input.replaces)
  if (input.mode === 'REPLACE' && replaces === '') throw new Error('REPLACE needs replaces: the image or recording on the page it replaces, as its URL path.')
  const caption = text(input.caption)
  if (caption === '') throw new Error('walk_record needs a caption: what the recording or screenshot shows a reader.')
  const step = text(input.step) || '(no step given)'
  const placing = input.mode === 'REPLACE' ? `REPLACE ${replaces}` : 'INSERT'
  const finding: Finding = { n: run.findings.length + 1, code: 'RECORD', step, expected: placing, actual: caption, evidence: file, attempt: run.attempt, at: now, resolution: null }
  return {
    run: { ...run, findings: [...run.findings, finding] },
    walkReply: 'Sent to the main agent, which decides whether it goes in the docs. Carry on with the walk; do not wait for an answer.',
    mainMessage: [
      `Walk RECORD #${finding.n} at ${step} (the reader carries on): ${placing}`,
      `File: ${file}`,
      `Caption: ${caption}`,
      '',
      `Put it in the docs only if it helps a reader. ${input.mode === 'REPLACE' ? `Replace ${replaces} on that page with it.` : 'Insert it at that step.'} Copy the file into the docs' public files and embed it the way these docs already show recordings and screenshots.`,
      file.endsWith('.cast')
        ? `A terminal recording of a single or simple command: do not embed the recording. Put the command and its output in one fenced text code block, the command first as $ <command>, with the text from asciinema convert -f txt ${file} -. Leave out lines the reader did not type (the reader's own checks) and replace personal paths. Use a recording player only for a lot of scrolling output, a wizard, several commands or TUI effects (progress bars, spinners, redrawn screens, colour), and then publish its text too: asciinema convert -f txt ${file} <name>.txt. A wizard is a player even when the cast holds only part of it. Before publishing a cast, remove the reader's personal paths, its own markers and keypresses such as Ctrl+C, and the recording command in its header, and check it holds no secret. A cast with one output event cannot animate, as a pipe in the reader's command held the output back: place it, then ask the reader with walk_ask for an unfiltered recording.`
        : '',
      file.endsWith('.webm')
        ? `A browser video from Playwright: make it a GIF for the page with bash ${pluginRoot}/scripts/walk-doc/video-to-gif.sh ${file} <name>.gif. The reader's thinking time between actions records as minutes of still screen; the script caps each still stretch at 2.5 seconds (--hold), which keeps the reader's deliberate pauses and ignores a blinking text caret, so the GIF keeps every action and arrow. Look at the result before placing it.`
        : '',
      config.media,
      `Commit it in one commit that starts "walk-doc RECORD:". Then call walk_reply with action NOTED, answers: ${finding.n}, a note (what you placed where, or why not) and changed: the pages you changed. The answer shows in the walk pane; the reader is not stopped.`,
    ].filter(Boolean).join('\n'),
  }
}

const OUTPUT_FILTERS = ['sed', 'tail', 'head', 'grep', 'awk', 'cut', 'tr', 'sort', 'uniq', 'tee', 'less', 'more', 'cat', 'col']

// A full-screen program (it enters the alternate screen) that left it within a second of entering: its output was
// buffered, so nobody can watch it. Version 2 casts carry absolute times, version 3 the time since the last event.
function heldScreens(cast: string): boolean {
  const [header, ...lines] = cast.split('\n')
  let relative = true
  try {
    relative = (JSON.parse(header ?? "") as { version?: number }).version !== 2
  } catch {
    return false // no readable header: the other checks name the fault
  }
  let now = 0, entered: number | null = null, left: number | null = null
  for (const line of lines) {
    let ev: unknown[]
    try {
      ev = JSON.parse(line) as unknown[]
    } catch {
      continue // a torn last line is not an event
    }
    now = relative ? now + Number(ev[0]) : Number(ev[0])
    if (ev[1] !== 'o') continue
    const data = String(ev[2])
    if (entered === null && data.includes('\x1b[?1049h')) entered = now
    if (entered !== null && data.includes('\x1b[?1049l')) left = now
  }
  return entered !== null && (left ?? now) - entered < 1
}

// Why a .cast is not a real recording of what a reader sees: output held back into one chunk, a command that filters
// or redirects its output (from the NNN.sh beside it, when there is one), or a value from the values file in either.
export function castProblems(cast: string, script: string | null, secrets: [string, string][], valuesFile = 'the values file'): string[] {
  const problems: string[] = []
  const output = cast.split('\n').slice(1).filter(line => {
    try {
      const ev = JSON.parse(line) as unknown[]
      return ev[1] === 'o' && String(ev[2]).trim() !== ''
    } catch {
      return false // the header or a torn last line is not an output event
    }
  })
  if (output.length < 2) problems.push(`It holds its output in one chunk, so it cannot play back as it ran: a pipe or a redirect held the output back until the command ended.`)
  if (heldScreens(cast)) problems.push('It shows a full-screen program for under a second: its screens were held back and arrived together, so it plays as a flash. Run it with a terminal attached all the way (for example ssh -t into a machine, or expect on this computer), and pause a few seconds before each key so every screen stays up.')
  if (script !== null) {
    const filter = OUTPUT_FILTERS.find(f => new RegExp(`\\|&?\\s*${f}\\b`).test(script))
    if (filter) problems.push(`The command filters its output through ${filter}, so the recording is not what a reader sees.`)
    if (/(^|[^0-9&<>])>>?\s*(?!&|\/dev\/null)[^\s|;&]/.test(script)) problems.push('The command sends its output to a file, so the recording does not show it.')
  }
  for (const [key, value] of secrets) {
    if (value.length >= 4 && (cast.includes(value) || (script ?? '').includes(value))) problems.push(`It holds the value of ${key} from ${valuesFile}. Pass it as "$(cat <file>)" or in an environment variable set where the recording does not show it.`)
  }
  return problems
}

export const mediaDirOf = (run: Run, attempt = run.attempt) => `${workspaceOf(run, attempt)}/media`

// A Walk Bash command, rewritten to run under asciinema in the attempt's media folder: NNN.sh holds the command,
// NNN.cast the recording and NNN.txt its text. The reader still gets the output, the exit code and a changed folder.
export function recordedBash(run: Run, command: string, seq: number): { command: string; cast: string } {
  const dir = mediaDirOf(run)
  const base = `${dir}/${String(seq).padStart(3, '0')}`
  const q = (s: string) => shellQuote([s])
  // The EXIT trap also runs when the command calls exit, so the code and the folder are always kept.
  const runner = [`trap '__walk_rc=$?; pwd > ${q(`${base}.pwd`)}; echo "$__walk_rc" > ${q(`${base}.rc`)}' EXIT`, `. ${q(`${base}.sh`)} < /dev/null`].join('\n')
  return {
    cast: `${base}.cast`,
    command: [
      `mkdir -p ${q(dir)} && printf '%s\\n' ${q(command)} > ${q(`${base}.sh`)} && printf '%s\\n' ${q(runner)} > ${q(`${base}.run.sh`)}`,
      `asciinema rec --headless --quiet --overwrite --idle-time-limit 2 --window-size 120x40 --command ${q(`bash ${q(`${base}.run.sh`)}`)} ${q(`${base}.cast`)} < /dev/null`,
      `asciinema convert -f txt ${q(`${base}.cast`)} ${q(`${base}.txt`)} > /dev/null && cat ${q(`${base}.txt`)}`,
      `[ -f ${q(`${base}.pwd`)} ] && cd "$(cat ${q(`${base}.pwd`)})"`,
      // exec replaces the shell, so its EXIT trap never runs: then the code comes from the cast's exit event.
      `__walk_rc=$(cat ${q(`${base}.rc`)} 2>/dev/null || sed -n ${q('s/^\\[[^,]*, *"x", *"\\([0-9]*\\)"\\]$/\\1/p')} ${q(`${base}.cast`)} | tail -n 1)`,
      `[ -n "$__walk_rc" ] || echo "walk-doc: the recording ${base}.cast did not finish, so the exit code is lost. Run the command again." >&2`,
      `echo "[walk-doc recorded: ${base}.cast]" >&2`,
      `(exit "\${__walk_rc:-1}")`,
    ].join('; '),
  }
}

type ReplyInput = { action?: unknown; note?: unknown; changed?: unknown; newApproach?: unknown; answers?: unknown }
export type ReplyEffect =
  | { effect: 'send'; run: Run; to: string; text: string }
  | { effect: 'spawn'; run: Run }
  | { effect: 'record'; run: Run }
  | { effect: 'refuse'; reason: string }

// ENHANCE notes and RECORD requests never stop the reader; the main agent answers them with NOTED.
export const isNonBlocking = (f: Finding) => f.code === 'ENHANCE' || f.code === 'RECORD'
// The blocking report the walk waits on.
const lastBlocking = (run: Run) => [...run.findings].reverse().find(f => !isNonBlocking(f))

// /walk-doc restart: the person starts a fresh reader at any point. A waiting report is closed as RESTART.
export function restartByPerson(run: Run, note: string, now: number): Run {
  if (run.attempt - 1 >= MAX_RESTARTS) throw new Error(`the walk has used its ${MAX_RESTARTS} restarts. Run /walk-doc stop, then /walk-doc again.`)
  if ((run.phase === 'awaiting' || run.phase === 'escalated') && lastBlocking(run) !== undefined) {
    const r = applyReply(run, { action: 'RESTART', note: note || 'Restarted by the person.', changed: [] }, now)
    if (r.effect !== 'spawn') throw new Error(r.effect === 'refuse' ? r.reason : `RESTART gave ${r.effect}`)
    return r.run
  }
  return { ...run, phase: 'walking', attempt: run.attempt + 1, agentId: null, stepBlocks: {} }
}

export function applyReply(run: Run, input: ReplyInput, now: number): ReplyEffect {
  if (input.action === 'NOTED') return noteAnswer(run, input, now)
  if (run.phase !== 'awaiting' && run.phase !== 'escalated') return { effect: 'refuse', reason: `The walk is ${run.phase}, not waiting for a reply. walk_status shows where it stands.` }
  const note = typeof input.note === 'string' ? input.note.trim() : ''
  if (note === '') return { effect: 'refuse', reason: 'walk_reply needs a note: what you changed, or why nothing needed to.' }
  const changed = Array.isArray(input.changed) ? input.changed.filter((c): c is string => typeof c === 'string') : []
  const last = lastBlocking(run)
  if (last === undefined) return { effect: 'refuse', reason: 'No blocking report is waiting. Answer an ENHANCE or RECORD note with action NOTED.' }
  const resolve = (action: 'CONTINUE' | 'RESTART') =>
    run.findings.map(f => (f.n === last.n ? { ...f, resolution: { action, note, changed, at: now } } : f))
  if (input.action === 'RESTART') {
    if (run.attempt - 1 >= MAX_RESTARTS) {
      return { effect: 'refuse', reason: `The walk has used its ${MAX_RESTARTS} restarts. CONTINUE with this reader, or call walk_escalate.` }
    }
    return { effect: 'spawn', run: { ...run, phase: 'walking', attempt: run.attempt + 1, agentId: null, stepBlocks: {}, findings: resolve('RESTART') } }
  }
  if (input.action !== 'CONTINUE') return { effect: 'refuse', reason: `action must be CONTINUE, RESTART or NOTED; got ${JSON.stringify(input.action)}.` }
  const newApproach = typeof input.newApproach === 'string' ? input.newApproach.trim() : ''
  if ((run.stepBlocks[last.step] ?? 0) >= SAME_STEP_LIMIT && newApproach === '') {
    return { effect: 'refuse', reason: `${last.step} has blocked ${run.stepBlocks[last.step]} times. RESTART with a fresh reader, or CONTINUE with new_approach saying what a helper found and what changed.` }
  }
  if (run.agentId === null) return { effect: 'refuse', reason: 'No Walk agent is on record to resume. RESTART to start a fresh one.' }
  const text = [
    'CONTINUE.',
    changed.length > 0 ? `Pages changed: ${changed.join(', ')}. Reload them in the browser before you go on.` : 'No pages changed.',
    `Main agent's note: ${note}`,
    newApproach === '' ? '' : `New approach: ${newApproach}`,
    `Retry the step that blocked (${last.step}) exactly as the docs now say, then carry on.`,
  ].filter(Boolean).join('\n')
  return { effect: 'send', run: { ...run, phase: 'walking', nudges: 0, findings: resolve('CONTINUE') }, to: run.agentId, text }
}

// The main agent's answer to an ENHANCE or RECORD note: kept for the pane and the report; the reader is not resumed.
function noteAnswer(run: Run, input: ReplyInput, now: number): ReplyEffect {
  const note = typeof input.note === 'string' ? input.note.trim() : ''
  if (note === '') return { effect: 'refuse', reason: 'walk_reply needs a note: what you changed, or why nothing needed to.' }
  const f = run.findings.find(x => x.n === input.answers)
  if (f === undefined || !isNonBlocking(f) || f.resolution !== null) {
    const open = run.findings.filter(x => isNonBlocking(x) && x.resolution === null).map(x => `#${x.n} ${x.code}`)
    return { effect: 'refuse', reason: `NOTED needs answers: the number of an unanswered ENHANCE or RECORD note; #${String(input.answers)} is not one. Open: ${open.join(', ') || 'none'}.` }
  }
  const changed = Array.isArray(input.changed) ? input.changed.filter((c): c is string => typeof c === 'string') : []
  const findings = run.findings.map(x => (x.n === f.n ? { ...x, resolution: { action: 'NOTED' as const, note, changed, at: now } } : x))
  return { effect: 'record', run: { ...run, findings } }
}

// The main agent hands a decision to the person: only after it tried the routes a developer would.
export function escalate(run: Run, input: { question?: unknown; tried?: unknown }, now: number): { run: Run; text: string } {
  if (run.phase !== 'awaiting') throw new Error(`The walk is ${run.phase}, not waiting on a report; there is nothing to escalate.`)
  const question = typeof input.question === 'string' ? input.question.trim() : ''
  const tried = Array.isArray(input.tried) ? input.tried.filter((t): t is string => typeof t === 'string' && t.trim() !== '') : []
  if (question === '') throw new Error('walk_escalate needs a question: the one decision or input the person must give.')
  if (tried.length === 0) throw new Error('walk_escalate needs tried: the routes you tried first (local credentials, a dev mode, a free sign-up, a stub, a helper). Escalation is the last resort.')
  const f = lastBlocking(run)!
  const findings = run.findings.map(x => (x.n === f.n ? { ...x, resolution: { action: 'ESCALATED' as const, note: question, changed: [], at: now } } : x))
  const text = `walk-doc needs you (${run.target}, ${f.code} at ${f.step}): ${question} Tried: ${tried.join('; ')}.`
  return { run: { ...run, phase: 'escalated', findings }, text }
}

export type Stopped =
  | { kind: 'ignore'; run: Run }
  | { kind: 'nudge'; run: Run; text: string }
  | { kind: 'main'; run: Run; text: string }

// The Walk agent's turn ended. Fine after a report; otherwise it stopped without one.
export function walkStopped(run: Run, agentId: string): Stopped {
  if (agentId !== run.agentId || run.phase !== 'walking') return { kind: 'ignore', run }
  if (run.nudges < 2) {
    return {
      kind: 'nudge',
      run: { ...run, nudges: run.nudges + 1 },
      text: 'You ended your turn without walk_report or walk_done. If you are stuck, call walk_report with the right code and end your turn. If the docs are finished, call walk_done. Otherwise carry on with the next step.',
    }
  }
  return {
    kind: 'main',
    run: { ...run, phase: 'awaiting', nudges: 0, findings: [...run.findings, {
      n: run.findings.length + 1, code: 'BUG', step: '(none: the Walk agent stopped)', expected: 'a report or walk_done',
      actual: 'The Walk agent ended its turn three times without either.', evidence: 'its last answers', attempt: run.attempt, at: 0, resolution: null,
    }] },
    text: 'The Walk agent ended its turn three times without walk_report or walk_done. Read its last answer with walk_status, then walk_reply: CONTINUE with guidance, or RESTART with a fresh reader.',
  }
}

// The main agent asks the reader for help (a recording, a check, what it sees); the reader answers with walk_answer.
export function askWalk(run: Run, input: { question?: unknown }, now: number): { run: Run; to: string; text: string } {
  const question = typeof input.question === 'string' ? input.question.trim() : ''
  if (question === '') throw new Error('walk_ask needs a question: what you want the reader to do or tell you.')
  if (run.agentId === null) throw new Error('no Walk agent is running to ask. Call walk_status; walk_reply RESTART starts one.')
  const n = (run.asks ?? []).length + 1
  return {
    run: { ...run, asks: [...(run.asks ?? []), { n, question, at: now, answer: null }] },
    to: run.agentId,
    text: [
      `ASK #${n} from the main agent: ${question}`,
      '',
      'Do what it asks if a reader could, with what the docs give you. For a recording or screenshot, do the step, then send the file with walk_record.',
      `Then call walk_answer with asks: ${n} and your answer.`,
      'Then go back to what you were doing: carry on with the walk, or end your turn if you were waiting for a reply to a report.',
    ].join('\n'),
  }
}

export function answerAsk(run: Run, input: { asks?: unknown; answer?: unknown }, now: number): { run: Run; mainMessage: string; walkReply: string } {
  const answer = typeof input.answer === 'string' ? input.answer.trim() : ''
  if (answer === '') throw new Error('walk_answer needs an answer: what you did or found.')
  const asks = run.asks ?? []
  const ask = asks.find(a => a.n === input.asks)
  if (ask === undefined) throw new Error(`there is no question #${String(input.asks)}. Questions asked so far: ${asks.map(a => `#${a.n}`).join(', ') || 'none'}.`)
  if (ask.answer !== null) throw new Error(`question #${ask.n} is already answered. Carry on.`)
  return {
    run: { ...run, asks: asks.map(a => (a === ask ? { ...a, answer: { text: answer, at: now } } : a)) },
    mainMessage: `ANSWER #${ask.n} from the Walk agent to "${ask.question}":\n${answer}`,
    walkReply: 'Sent to the main agent. Go back to what you were doing: carry on with the walk, or end your turn if you were waiting for a reply to a report.',
  }
}

// Tools the Walk agent never uses: delegation, messaging, the main agent's side of the walk, and skills (project knowledge).
const WALK_DENIED_TOOLS = new Set(['Agent', 'SendMessage', 'Workflow', 'Skill', 'EnterWorktree', 'ExitWorktree', 'Artifact', 'TeamCreate', 'CronCreate', 'RemoteTrigger'])
// The main agent's tools, with fix-all-prs's report tool, which shares the ndev server.
export const MAIN_ONLY = ['walk_reply', 'walk_escalate', 'walk_finish', 'walk_status', 'walk_ask', 'report'].map(TOOL)
const MAIN_ONLY_TOOLS = new Set<string>(MAIN_ONLY)
const SEARCH_COMMANDS = /^(rg|ag|ack|grep\s+-[a-zA-Z]*r|git\s+(grep|log|show|blame))\b/
const PATH_TOOLS: Record<string, string> = { Read: 'file_path', Edit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path', Grep: 'path', Glob: 'path' }

export type GuardCall = { tool: string; agentId: string | undefined; input: Record<string, unknown> }

// The walk browser's tools, as the plugin's Playwright server names them.
const BROWSER = (name: string) => `mcp__plugin_${PLUGIN}_playwright__${name}`
const CLICK = BROWSER('browser_click')
const CLICK_NEEDS_ARROW = "walk-doc: point at the target before you click it, so the recording shows where the click goes. Call browser_evaluate with walkArrow.point('<target>', { text: '<what to do>', untilClick: true }), then click."

// How long the arrow's caption needs to be read before the reader clicks: 2000 ms plus 50 ms a character, at most 5000 ms.
export const arrowDwell = (captionLength: number): number => Math.min(5000, 2000 + 50 * captionLength)

// The dwell an arming call sets (a walkArrow.point with untilClick), from the length of its text; null for any other call.
export function arrowDwellOf(fn: string): number | null {
  if (!/\bwalkArrow\.point\(/.test(fn) || !/\buntilClick\s*:\s*true\b/.test(fn)) return null
  const caption = /\btext\s*:\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/.exec(fn)
  return arrowDwell(caption === null ? 0 : caption[2]!.length)
}

// Whether a walkArrow stays up for the reader's next click, after a call that did or did not succeed.
// A pointing arrow with untilClick arms it; a click, a new page, walkArrow.stop() or another arrow uses it up.
export function arrowAfter(armed: boolean, call: { tool: string; input: Record<string, unknown> }, succeeded: boolean): boolean {
  if (call.tool === BROWSER('browser_navigate') || call.tool === BROWSER('browser_navigate_back')) return false
  if (call.tool === CLICK) return succeeded ? false : armed
  if (call.tool !== BROWSER('browser_evaluate')) return armed
  const fn = typeof call.input.function === 'string' ? call.input.function : ''
  if (!/\bwalkArrow\.\w+\(/.test(fn)) return armed
  return succeeded && /\bwalkArrow\.point\(/.test(fn) && /\buntilClick\s*:\s*true\b/.test(fn) && !/\bwalkArrow\.stop\(/.test(fn)
}

// null lets the call through; a string is the denial, naming what was refused and why.
export function guardCall(run: Run, config: Config, call: GuardCall, now: number = Date.now()): string | null {
  if (call.agentId === undefined || !run.agentIds.includes(call.agentId)) return null
  if (WALK_DENIED_TOOLS.has(call.tool)) return `walk-doc: the Walk agent works alone; ${call.tool} is denied. Report with walk_report or walk_enhance.`
  if (MAIN_ONLY_TOOLS.has(call.tool)) return `walk-doc: ${call.tool} belongs to the main agent. Report with walk_report and end your turn.`
  if (call.tool === CLICK && run.arrowArmed !== true) return CLICK_NEEDS_ARROW
  if (call.tool === CLICK) {
    const remaining = (run.arrowArmedAt ?? 0) + (run.arrowDwellMs ?? 0) - now
    if (remaining > 0) return `walk-doc: the arrow's caption needs time to be read; ${remaining} ms of its dwell remain. Call browser_wait_for with time=${Math.ceil(remaining / 1000)} so the reader can read the arrow's caption, then click.`
  }
  const field = PATH_TOOLS[call.tool]
  if (field !== undefined) {
    const p = call.input[field]
    if (typeof p !== 'string' || p === '') return `walk-doc: give ${call.tool} an explicit ${field} in your workspace ${workspaceOf(run)}; a search from the default folder could read the project's source.`
    const denied = deniedPath(run, config, p)
    // An absolute or climbing Glob pattern reaches past its path, so the pattern is checked from that path too.
    if (denied !== null || call.tool !== 'Glob' || typeof call.input.pattern !== 'string') return denied
    const pattern = expandHome(run, call.input.pattern)
    return deniedGlob(run, config, pattern.startsWith('/') ? pattern : `${p}/${pattern}`)
  }
  if (call.tool === 'Bash') {
    const command = typeof call.input.command === 'string' ? call.input.command : ''
    if (/\bgit\s+(push|commit)\b/.test(command)) return 'walk-doc: git push and git commit are denied. A reader does not change the project; report what you needed.'
    if (/(^|[;&|]\s*)sudo\b/.test(command)) {
      return config.machines === null
        ? 'walk-doc: sudo on this computer is denied. If a step needs root, report BLOCKED.'
        : 'walk-doc: sudo on this computer is denied. If the docs need root, run the step in your own machine or container, or report BLOCKED.'
    }
    // A heuristic, not a sandbox: it resolves $HOME and ~, reads relative paths from both the project and the
    // workspace, treats a glob as everything it could match, and checks bare names after a cd into the project.
    const tokens = command.split(/[\s;&|<>()'"=]+/).map(t => expandHome(run, t)).filter(t => t !== '' && !/^[a-z]+:\/\//.test(t))
    const intoRoot = tokens.some((t, i) => tokens[i - 1] === 'cd' && normalise(t.startsWith('/') ? t : `${run.root}/${t}`) === normalise(run.root))
    for (const token of tokens) {
      const values = deniedValues(config, token)
      if (values !== null) return values
      if (!token.includes('/') && !intoRoot) continue
      const bases = token.startsWith('/') ? [''] : token.includes('/') ? [`${run.root}/`, `${workspaceOf(run)}/`] : [`${run.root}/`]
      for (const base of bases) {
        const denial = /[*?[]/.test(token) ? deniedGlob(run, config, `${base}${token}`) : deniedPath(run, config, `${base}${token}`, token)
        if (denial !== null) return denial
      }
    }
    if (SEARCH_COMMANDS.test(command.trim()) && !command.includes(workspaceOf(run))) {
      return `walk-doc: searching the project is denied. Search inside your workspace ${workspaceOf(run)}, or read the rendered docs.`
    }
  }
  return null
}

// The files under ~/.claude/projects/<project>/<session>/tool-results/ that a tool result names: where Claude Code
// saved an output too long to show. Only these, from the Walk agent's own results, are opened to it.
export function savedOutputs(run: Run, value: unknown): string[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  const home = run.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const seg = `[^/\\s"'\\\\]+`
  const found = text.match(new RegExp(`${home}/\\.claude/projects/${seg}/${seg}/tool-results/${seg}`, 'g')) ?? []
  return [...new Set(found.filter(p => !p.split('/').some(part => part === '..' || part === '.')))]
}

// $HOME, ${HOME} and ~ as the shell expands them, so a path through them is checked as the path it names.
function expandHome(run: Run, token: string): string {
  return token.replace(/^(\$\{HOME\}|\$HOME|~)(?=\/|$)/, run.home)
}

// The files of private values. The reader gets only the valueKeys, in its prompt, and never reads the file:
// ndev's credentials file and the config's valuesFile, by name, in any checkout.
const CREDENTIALS_FILE = '.neil-dev.env'
const valuesNames = (config: Config) => [...new Set([CREDENTIALS_FILE, ...(config.valuesFile === null ? [] : [config.valuesFile.split('/').pop()!])])]

// A shell glob over one path part; a dotfile matches only a pattern that starts with a dot, as in the shell.
function globMatches(pattern: string, name: string): boolean {
  if (name.startsWith('.') && !pattern.startsWith('.')) return false
  const source = pattern.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*+/g, '[^/]*').replace(/\?/g, '[^/]')
  return new RegExp(`^${source}$`).test(name)
}

function deniedValues(config: Config, given: string, raw = given): string | null {
  const last = given.replace(/\/+$/, '').split('/').pop() ?? ''
  const hit = valuesNames(config).find(n => (/[*?[]/.test(last) ? globMatches(last, n) : last === n))
  return hit === undefined ? null : `walk-doc: ${raw} could be ${hit}, the file of private values, which is denied to the Walk agent. The values the docs need are in your prompt.`
}

// The directories the Walk agent may not read.
function deniedDirs(run: Run, config: Config): string[] {
  return [`${run.home}/.claude`, `${run.root}/${config.contentRoot}`, ...config.deny.map(d => `${run.root}/${d}`)].map(normalise)
}

// A glob is denied when anything it could match is: its fixed part leads into, or lies under, a denied directory.
function deniedGlob(run: Run, config: Config, pattern: string): string | null {
  const values = deniedValues(config, pattern)
  if (values !== null) return values
  const fixed = pattern.slice(0, pattern.search(/[*?[]|$/))
  const prefix = fixed.endsWith('/') ? `${normalise(fixed)}/`.replace(/^\/\/$/, '/') : normalise(fixed)
  const hit = deniedDirs(run, config).find(d => d.startsWith(prefix) || prefix.startsWith(`${d}/`))
  return hit === undefined ? null : `walk-doc: the pattern ${pattern} could match ${hit}, which is denied to the Walk agent. Name the files in your workspace or a page the docs give.`
}

function deniedPath(run: Run, config: Config, given: string, raw = given): string | null {
  const abs = given.startsWith('~/') ? `${run.home}${given.slice(1)}` : given.startsWith('/') ? given : `${run.root}/${given}`
  const path = normalise(abs)
  const values = deniedValues(config, path, raw)
  if (values !== null) return values
  const allowed = run.allowedPaths.map(p => normalise(p.startsWith('~/') ? `${run.home}${p.slice(1)}` : `${run.root}/${p}`))
  if (allowed.includes(path) || (run.savedOutputs ?? []).includes(path)) return null
  const under = (dir: string) => path === dir || path.startsWith(`${dir}/`)
  if (under(normalise(`${run.home}/.claude`))) return `walk-doc: ${raw} is under ~/.claude, which is denied to the Walk agent.`
  if (under(normalise(`${run.root}/${config.contentRoot}`))) return `walk-doc: ${raw} is the docs source; read the rendered pages at the dev server instead.`
  for (const d of config.deny) {
    if (under(normalise(`${run.root}/${d}`))) return `walk-doc: ${raw} is denied to the Walk agent (${d}/ is project source or internal docs). If the docs tell you to open it, report OMISSION or INCORRECT.`
  }
  return null
}

function normalise(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

export const shellQuote = (argv: readonly string[]) => argv.map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')

// The recipient and the text are arguments, so no text can change the script.
export function imessageArgv(to: string, text: string): string[] {
  return [
    'osascript',
    '-e', 'on run argv',
    '-e', 'tell application "Messages"',
    '-e', 'set targetService to 1st account whose service type = iMessage',
    '-e', 'send (item 2 of argv) to participant (item 1 of argv) of targetService',
    '-e', 'end tell',
    '-e', 'end run',
    to,
    text,
  ]
}

export function reportMarkdown(run: Run): string {
  const lines = [
    `# Walk report: ${run.target}`,
    '',
    `Run ${run.runId}. Phase: ${run.phase}. Attempts: ${run.attempt} (${run.attempt - 1} restart${run.attempt === 2 ? '' : 's'} of ${MAX_RESTARTS}). Persona: ${run.persona}.`,
    run.summary === null ? '' : `\nWalk summary: ${run.summary}`,
    '',
    `## Findings (${run.findings.length})`,
    '',
  ]
  for (const f of run.findings) {
    lines.push(`### #${f.n} ${f.code} at ${f.step} (attempt ${f.attempt})`, '')
    if (f.code === 'RECORD') lines.push(`- Placing: ${f.expected}`, `- File: ${f.evidence}`, `- Caption: ${f.actual}`)
    else lines.push(`- Expected: ${f.expected}`, `- Actual: ${f.actual}`, `- Evidence: ${f.evidence}`)
    lines.push(f.resolution === null ? '- Resolution: **open**' : `- Resolution: ${f.resolution.action}: ${f.resolution.note}${f.resolution.changed.length > 0 ? ` (changed: ${f.resolution.changed.join(', ')})` : ''}`, '')
  }
  const asks = run.asks ?? []
  if (asks.length > 0) {
    lines.push(`## Questions to the reader (${asks.length})`, '')
    for (const a of asks) lines.push(`- #${a.n} ${a.question}`, `  - Answer: ${a.answer === null ? '**none**' : a.answer.text}`)
    lines.push('')
  }
  lines.push(`## Guard denials (${run.denials.length})`, '', 'Check these for an over-tight rule.', '', ...run.denials.map(d => `- ${d.tool}: ${d.detail}`), '')
  return lines.join('\n')
}

// A folder and each folder above it, nearest first, ending at the filesystem root.
export function ancestorsOf(dir: string): string[] {
  const parts = dir.split('/').filter(Boolean)
  const out: string[] = []
  for (let i = parts.length; i > 0; i--) out.push(`/${parts.slice(0, i).join('/')}`)
  out.push('/')
  return out
}

export type ChatKind = Finding['code'] | NonNullable<Finding['resolution']>['action'] | 'ASK' | 'ANSWER'
export interface ChatMessage { from: 'Walk' | 'Main'; kind: ChatKind; text: string; at: number }

// Theme keys, so the colours follow the person's light or dark theme.
export const CHAT_COLOR: Record<ChatKind, string> = {
  BUG: 'error', INCORRECT: 'warning', OMISSION: 'suggestion', BLOCKED: 'permission', ENHANCE: 'subtle', RECORD: 'planMode',
  CONTINUE: 'success', RESTART: 'claude', ESCALATED: 'merged', NOTED: 'remember', ASK: 'autoAccept', ANSWER: 'ide',
}

// The conversation between the Walk agent and the main agent, oldest first, each message whole.
export function chatMessages(run: Run): ChatMessage[] {
  const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
  const out: ChatMessage[] = []
  for (const f of run.findings) {
    const said = f.code === 'RECORD' ? `${f.expected} ${f.evidence.split('/').pop()}: ${f.actual}` : f.actual
    out.push({ from: 'Walk', kind: f.code, text: oneLine(`#${f.n} ${f.code} at ${f.step}: ${said}`), at: f.at })
    if (f.resolution !== null) out.push({ from: 'Main', kind: f.resolution.action, text: oneLine(`${f.resolution.action} #${f.n}: ${f.resolution.note}`), at: f.resolution.at })
  }
  for (const a of run.asks ?? []) {
    out.push({ from: 'Main', kind: 'ASK', text: oneLine(`ASK #${a.n}: ${a.question}`), at: a.at })
    if (a.answer !== null) out.push({ from: 'Walk', kind: 'ANSWER', text: oneLine(`ANSWER #${a.n}: ${a.answer.text}`), at: a.answer.at })
  }
  return out.sort((a, b) => a.at - b.at)
}

// KEY=VALUE lines from the project's values file; # comments, blank lines and an `export ` prefix are allowed.
export function parseEnvFile(text: string, file: string): Record<string, string> {
  const values: Record<string, string> = {}
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) return
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (m === null) throw new Error(`${file} line ${i + 1} is not KEY=VALUE (the line is not shown: it can hold a private value). Fix or remove that line.`)
    const value = m[2]!
    values[m[1]!] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value
  })
  return values
}

// The values the reader may see: only the valueKeys when the config names them. A named key the file does not set
// is refused, so a walk never starts without a value the docs ask for. The refusal never shows a value.
export function readerValues(values: Record<string, string>, keys: string[] | null, file: string): Record<string, string> {
  if (keys === null) return values
  const missing = keys.filter(k => !values[k])
  if (missing.length > 0) throw new Error(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set in ${file}, and valueKeys names ${missing.length === 1 ? 'it' : 'them'}. Add ${missing.map(k => `${k}=<value>`).join(' and ')} to that file (never in chat), or remove ${missing.length === 1 ? 'it' : 'them'} from valueKeys.`)
  return Object.fromEntries(keys.map(k => [k, values[k]!]))
}

// What the reader is told about the values the person put in the values file.
export function valuesNote(values: Record<string, string>, file: string): string {
  const keys = Object.keys(values)
  if (keys.length === 0) return ''
  return [
    `Values the person has given you for this walk (from ${file}). Use them where the docs say to ask someone for them:`,
    ...keys.map(k => `- ${k}=${values[k]}`),
  ].join('\n')
}
