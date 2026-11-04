// walk-doc: /walk-doc starts the docs dev server and a fresh Walk agent that follows the docs as a reader.
// The Walk agent reports through walk_report / walk_enhance / walk_done; the main agent answers with walk_reply,
// asks the reader for help with walk_ask (answered by walk_answer),
// hands a decision to the person with walk_escalate, and closes the run with walk_finish. A guard keeps the Walk
// agent out of the project's source and internal docs.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions, TurnCompleteInput } from 'claude-code'

import { WALK_SYSTEM_PROMPT, walkTask } from './prompts'
import {
  AGENT, CONFIG_FILE, MAIN_ONLY, PLUGIN, TOOL, ancestorsOf, answerAsk, applyReply, arrowAfter, arrowDwellOf, askWalk, docsNamedPaths, escalate, guardCall, imessageArgv, savedOutputs, isUrl,
  newRun, pageUrl, parseArgs, parseConfig, recordCopy, docsPagesOpened, docsPagesShown, keepCopyWrites, settleCopyReviews, newCopyPages, pageProse, recordEnhance, recordMedia, castProblems, restartByPerson, recordedBash, isNonBlocking, recordReport, chatMessages, CHAT_COLOR, parseEnvFile, readerValues, valuesNote, exampleConfig, addTip, cleanTip, tipsNote, reportMarkdown, runDirOf, shellQuote,
  walkStopped, workspaceOf,
} from './walk'
import type { Config, Run } from './walk'
import { showIdleStatus } from '../workflow/progress'

const PANE = 'walk-doc'
// The first page compile takes minutes on a loaded machine; each probe is bounded so the loop keeps its own deadline, inside the host's 600 s limit on one process.run.
const READY_SECONDS = 540
const PROBE_SECONDS = 20
const CHAT_SHOWN = 12
const runAtom = atom({ plugin: 'ndev', key: 'walkRun' } as const, null as Run | null, { shape: 'run-1' })
const isActive = (run: Run | null): run is Run => run !== null && run.phase !== 'finished'

const WALK_TOOLS = [
  { name: 'walk_report', description: 'Walk agent only. Report a blocking finding (OMISSION, BUG, INCORRECT or BLOCKED), then end your turn and wait.', inputSchema: {
    type: 'object', required: ['code', 'step', 'expected', 'actual', 'evidence'], properties: {
      code: { type: 'string', enum: ['OMISSION', 'BUG', 'INCORRECT', 'BLOCKED'] },
      step: { type: 'string', description: 'The page URL and heading of the step.' },
      expected: { type: 'string', description: 'What the docs say, quoted.' },
      actual: { type: 'string', description: 'What happened.' },
      evidence: { type: 'string', description: 'The exact command, exit code and output, or what the screen showed.' },
    } } },
  { name: 'walk_enhance', description: 'Walk agent only. Send the main agent something the docs could do better, then carry on without waiting.', inputSchema: {
    type: 'object', required: ['step', 'note'], properties: {
      step: { type: 'string', description: 'The page URL and heading the note is about.' },
      note: { type: 'string', description: 'What could be better, and how.' },
    } } },
  { name: 'walk_record', description: 'Walk agent only. Ask the main agent to put a recording or screenshot from your media folder in the docs, then carry on without waiting. Only for one worth adding.', inputSchema: {
    type: 'object', required: ['step', 'file', 'mode', 'caption'], properties: {
      step: { type: 'string', description: 'The page URL and heading the recording belongs to.' },
      file: { type: 'string', description: 'The .cast, .gif or .jpg file in your media folder.' },
      mode: { type: 'string', enum: ['INSERT', 'REPLACE'], description: 'INSERT adds it at the step; REPLACE swaps it for an image or recording on the page.' },
      replaces: { type: 'string', description: 'For REPLACE: the URL path of the image or recording it replaces.' },
      caption: { type: 'string', description: 'What it shows a reader.' },
    } } },
  { name: 'walk_answer', description: 'Walk agent only. Answer a question the main agent sent you with walk_ask, then go back to what you were doing.', inputSchema: {
    type: 'object', required: ['asks', 'answer'], properties: {
      asks: { type: 'number', description: 'The number of the question (ASK #n).' },
      answer: { type: 'string', description: 'What you did or found, with the paths of any files you made.' },
    } } },
  { name: 'walk_done', description: 'Walk agent only. Say the docs are finished, with a short summary, then end your turn.', inputSchema: {
    type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } } },
  { name: 'walk_reply', description: 'Main agent only, during /walk-doc. Answer a Walk report after fixing it: CONTINUE resumes the same reader; RESTART starts a fresh reader in a fresh environment; NOTED answers an ENHANCE, RECORD or COPY note in the pane without touching the reader.', inputSchema: {
    type: 'object', required: ['action', 'note'], properties: {
      action: { type: 'string', enum: ['CONTINUE', 'RESTART', 'NOTED'] },
      answers: { type: 'number', description: 'For NOTED: the number of the ENHANCE, RECORD or COPY note you answer.' },
      note: { type: 'string', description: 'What you changed, or why nothing needed to.' },
      changed: { type: 'array', items: { type: 'string' }, description: 'The docs pages you changed, as URL paths.' },
      new_approach: { type: 'string', description: 'Required for CONTINUE after 10 blocks on one step: what a helper found and what changed.' },
    } } },
  { name: 'walk_escalate', description: 'Main agent only, during /walk-doc. Last resort: hand one decision or input to the person, who is texted. Say what you tried first.', inputSchema: {
    type: 'object', required: ['question', 'tried'], properties: { question: { type: 'string' }, tried: { type: 'array', items: { type: 'string' } } } } },
  { name: 'walk_finish', description: 'Main agent only, during /walk-doc. Close the walk after the finish duties: writes the report, stops the dev server and the Walk machines, texts the person.', inputSchema: {
    type: 'object', properties: { summary: { type: 'string', description: 'What was fixed and what is left open.' } } } },
  { name: 'walk_ask', description: 'Main agent only, during /walk-doc. Ask the Walk agent for help without stopping it: a recording or screenshot of a step, a check, what it sees. The answer arrives as a message.', inputSchema: {
    type: 'object', required: ['question'], properties: { question: { type: 'string', description: 'What you want the reader to do or tell you.' } } } },
  { name: 'walk_status', description: 'Main agent only, during /walk-doc. The walk as JSON: phase, attempt, findings (with ENHANCE, RECORD and COPY notes), the pages sent to the copy editor, denials.', inputSchema: { type: 'object', properties: {} } },
] as const

// Set by walkDoc (the person's plugin config) and session.start (the project root).
let textTo = ''
let root = ''
// The descriptions of Walk spawns /walk-doc has under way: the engine routes each through the Agent tool call.
const ownSpawns = new Set<string>()

function log($: EngineInterface, line: string) {
  $.ui.log(`walk-doc: ${line}`, { to: 'debug' })
}

async function loadConfig($: EngineInterface, at = root): Promise<Config> {
  let text: string
  try {
    text = await $.fs.read(`${at}/${CONFIG_FILE}`)
  } catch (error) {
    throw new Error(`cannot read ${at}/${CONFIG_FILE}: ${String(error)}. Add it at the project root with every required key, for example ${exampleConfig()}. The ndev README (/walk-doc) describes each key.`)
  }
  return parseConfig(text, `${at}/${CONFIG_FILE}`)
}

// The project root is the nearest folder at or above the session's folder that holds the config; null: none does.
async function findRoot($: EngineInterface, cwd: string): Promise<string | null> {
  for (const dir of ancestorsOf(cwd)) {
    if (await $.fs.exists(`${dir === '/' ? '' : dir}/${CONFIG_FILE}`)) return dir
  }
  return null
}

// During a walk the main agent repairs the values file; the run waits for the retried call.
const MID_WALK_RETRY = 'The main agent restores it. Then retry the call.'

async function git($: EngineInterface, at: string, args: string[]): Promise<string> {
  const ran = await $.process.run(['git', '-C', at, ...args], { timeoutMs: 10_000 })
  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed in ${at} (exit ${ran.exitCode}): ${(ran.stderr || ran.stdout).trim()}`)
  return ran.stdout.trim()
}

// The config's valuesFile, at the root of this checkout or else of the main project checkout, which every worktree shares.
// The values file is git-ignored, so a new worktree has none: the walk refuses rather than start a reader without them.
// git worktree list names the main checkout first, symlinks resolved, in any layout (worktree, submodule, separate git dir).
async function findValues($: EngineInterface, at: string, config: Config, retry = 'Then run /walk-doc again.'): Promise<{ file: string; place: string } | null> {
  if (config.valuesFile === null) return null
  const name = config.valuesFile
  const worktrees = (await git($, at, ['worktree', 'list', '--porcelain'])).split(/\n\s*\n/).map(block => block.split('\n'))
  const first = worktrees[0] ?? []
  const firstPath = (first.find(l => l.startsWith('worktree ')) ?? '').slice('worktree '.length)
  const main = first.includes('bare') ? null : firstPath
  if (await $.fs.exists(`${at}/${name}`)) {
    const here = await git($, at, ['rev-parse', '--show-toplevel'])
    const place = here === main ? 'in the main project checkout' : main === null ? `in this worktree of the bare repository ${firstPath}` : `in this worktree, not in the main project checkout ${main}`
    return { file: `${at}/${name}`, place }
  }
  if (main === null) throw new Error(`the values file ${name} is not in ${at}, and the bare repository ${firstPath} has no main project checkout. Create ${at}/${name} with one KEY=VALUE per line (# comments allowed), or remove valuesFile from ${CONFIG_FILE}. ${retry}`)
  if (await $.fs.exists(`${main}/${name}`)) return { file: `${main}/${name}`, place: 'in the main project checkout' }
  let copy: string | null = null
  for (const block of worktrees.slice(1)) {
    const w = (block.find(l => l.startsWith('worktree ')) ?? '').slice('worktree '.length)
    if (copy === null && w !== '' && await $.fs.exists(`${w}/${name}`)) copy = `${w}/${name}`
  }
  const repair = copy === null
    ? `Create ${main}/${name} with one KEY=VALUE per line (# comments allowed), or remove valuesFile from ${CONFIG_FILE}.`
    : `Copy the one in another worktree to the main project checkout, where every worktree finds it: cp ${shellQuote([copy, `${main}/${name}`])}.`
  throw new Error(`the values file ${name} is in neither ${at} nor the main project checkout ${main}. ${repair} ${retry}`)
}

// The values the person keeps for walks, with where they came from, for the reader.
async function loadValues($: EngineInterface, at: string, config: Config, retry?: string): Promise<string> {
  const found = await findValues($, at, config, retry)
  if (found === null) return ''
  return valuesNote(readerValues(parseEnvFile(await $.fs.read(found.file), found.file), config.valueKeys, found.file), `${found.file}, ${found.place}`)
}

// The valuesFile values as [key, value] pairs, so walk_record can refuse a recording that shows one.
async function loadSecrets($: EngineInterface, at: string, config: Config): Promise<[string, string][]> {
  const found = await findValues($, at, config, MID_WALK_RETRY)
  if (found === null) return []
  return Object.entries(parseEnvFile(await $.fs.read(found.file), found.file))
}

const RECORD_AGAIN = 'Record it again: run the command on its own, as a reader types it, with nothing after it on the line: no pipe, no redirect. Answer its prompts with an expect script you wrote in an earlier command, with log_user 1 so each question and answer shows as it happens. Then call walk_record with the new cast.'

async function sh($: EngineInterface, script: string, timeoutMs = 30_000) {
  return $.process.run(['bash', '-c', script], { cwd: root, timeoutMs })
}

async function sendText($: EngineInterface, message: string): Promise<string> {
  if (textTo === '') return 'No text was sent: textTo is empty in the ndev plugin config (/config).'
  const ran = await $.process.run(imessageArgv(textTo, message), { timeoutMs: 30_000 })
  if (ran.exitCode !== 0) {
    const why = `the iMessage to ${textTo} did not send (osascript exit ${ran.exitCode}): ${(ran.stderr || ran.stdout).trim().slice(0, 300)}`
    log($, `WARNING: ${why}`)
    return `No text was sent: ${why}. Check that Messages is signed in to iMessage.`
  }
  return `Texted ${textTo}.`
}

// A prompt cannot be submitted from inside the hook that holds the turn, so it goes on the next tick.
function tellMain($: EngineInterface, message: string) {
  $.clock.after(0, () => {
    void $.prompt.submit({ text: message }).catch((error: unknown) => {
      log($, `ERROR: the message for the main agent did not submit: ${String(error)}`)
      $.ui.toast(`walk-doc: a Walk report did not reach Claude. Send any message, then ask for walk_status.`)
    })
  })
}

// walk_ask and /walk-doc ask: send the reader a numbered question; its walk_answer reaches the main agent.
async function sendAsk($: EngineInterface, question: unknown): Promise<string> {
  const run = await read($, runAtom)
  if (!isActive(run)) throw new Error('no walk is running.')
  const out = askWalk(run, { question }, await $.clock.now())
  const sent = await $.session.send({ to: { agentId: out.to }, text: out.text })
  if (!sent.isDelivered) throw new Error(`the question did not reach the Walk agent ${out.to}: ${sent.reason}. Call walk_status; walk_reply RESTART starts a fresh reader.`)
  await save($, out.run)
  return `ASK #${out.run.asks!.length} sent to the Walk agent. Its answer arrives as a message; carry on meanwhile.`
}

async function save($: EngineInterface, run: Run) {
  let saved = run
  await update($, runAtom, fresh => {
    saved = fresh === null ? run : keepCopyWrites(run, fresh)
    return saved
  })
  await writeRun($, saved)
}

async function writeRun($: EngineInterface, run: Run) {
  try {
    await $.fs.write(`${runDirOf(run)}/run.json`, JSON.stringify(run, null, 2))
  } catch (error) {
    log($, `WARNING: cannot write ${runDirOf(run)}/run.json: ${String(error)}`)
  }
  showIdleStatus($, statusLine(run))
}

// Runs the project's machines.cleanup for the machines a Walk run named, and reports what it could not remove.
async function cleanMachines($: EngineInterface, run: Run): Promise<string> {
  const { machines } = await loadConfig($, run.root)
  if (machines === null) return ''
  const script = machines.cleanup.replaceAll('{prefix}', `walk-${run.runId}-`)
  const ran = await sh($, script, 120_000)
  return ran.exitCode === 0 ? '' : ` Some Walk machines did not delete (machines.cleanup in ${CONFIG_FILE} exit ${ran.exitCode}): ${(ran.stderr || ran.stdout).trim().slice(0, 300)}. Remove them by hand: ${script}`
}

async function spawnWalk($: EngineInterface, run: Run, ask = ''): Promise<Run> {
  const ws = workspaceOf(run)
  const made = await $.process.run(['mkdir', '-p', ws], { timeoutMs: 10_000 })
  if (made.exitCode !== 0) throw new Error(`cannot make the Walk workspace ${ws} (mkdir exit ${made.exitCode}): ${made.stderr.trim()}`)
  const description = `walk-doc ${run.runId} attempt ${run.attempt}`
  ownSpawns.add(description)
  let spawned
  try {
    const config = await loadConfig($, run.root)
    spawned = await $.agent.spawn({ subagentType: AGENT, prompt: [walkTask(run, config), ask === '' ? '' : `The person who runs this walk asks: ${ask}`, tipsNote(config.tips), await loadValues($, run.root, config)].filter(Boolean).join('\n\n'), description, cwd: ws })
  } finally {
    ownSpawns.delete(description)
  }
  if (spawned.deny !== undefined) throw new Error(`the Walk agent did not start: ${spawned.deny}`)
  // The spawn result carries the id; the agent list is the API's other record of it, keyed here by the unique description.
  const agentId = spawned.agentId ?? (await $.agent.list()).find(a => a.type === AGENT && a.description === description)?.id
  if (agentId === undefined) throw new Error(`the Walk agent "${description}" started but neither the spawn result nor $.agent.list() names its id, so its reports could not be matched. Run /walk-doc stop, then /walk-doc again.`)
  return { ...run, agentId, agentIds: [...run.agentIds, agentId], nudges: 0 }
}

// The dev server leads its own process group (set -m at start), so one signal reaches pnpm, next and their children.
async function killGroup($: EngineInterface, pid: number) {
  return $.process.run(['kill', '-TERM', '--', `-${pid}`], { timeoutMs: 10_000 })
}

async function stopServer($: EngineInterface, run: Run): Promise<string> {
  const ran = await killGroup($, run.pid)
  return ran.exitCode === 0 ? '' : ` The dev server (process group ${run.pid}) may still run (kill exit ${ran.exitCode}: ${ran.stderr.trim()}): kill -TERM -- -${run.pid}`
}

// The walk records each command the reader runs, so it refuses to start without the recorder.
async function requireAsciinema($: EngineInterface): Promise<void> {
  let why: string
  try {
    const ran = await $.process.run(['asciinema', '--version'], { timeoutMs: 10_000 })
    if (ran.exitCode === 0) return
    why = `asciinema --version exit ${ran.exitCode}: ${ran.stderr.trim()}`
  } catch (error) {
    why = error instanceof Error ? error.message : String(error)
  }
  throw new Error(`asciinema does not run (${why}). The walk records each command the reader runs. Install it with: brew install asciinema`)
}

// The reader drives the plugin's Playwright server. The host connects it at session start and keeps the
// result, so a server that failed then (a slow npx start past the host's connect limit) stays failed.
async function requireBrowser($: EngineInterface): Promise<string> {
  const repair = `Run /mcp, reconnect plugin:${PLUGIN}:playwright, then run /walk-doc again. If the reconnect times out, start Claude Code with MCP_TIMEOUT=120000 so its first npx start has time.`
  let browser: Awaited<ReturnType<EngineInterface['mcp']['connect']>>
  try {
    browser = await $.mcp.connect('playwright')
  } catch (error) {
    throw new Error(`the walk browser plugin:${PLUGIN}:playwright did not connect: ${error instanceof Error ? error.message : String(error)}. ${repair}`)
  }
  if (browser.isConnected) return browser.server
  throw new Error(`the walk browser plugin:${PLUGIN}:playwright is not connected (${browser.reason}): ${browser.message} ${repair}`)
}

// The reader's recordings need the red cursor and walkArrow, which the Playwright server loads as
// init scripts when it starts. A server started before the plugin's config changed lacks them.
async function requireOverlay($: EngineInterface, server: string, url: string): Promise<void> {
  let seen: string
  try {
    await $.mcp.call(server, 'browser_navigate', { url })
    const result = await $.mcp.call(server, 'browser_evaluate', { function: '() => `overlay:${typeof window.walkArrow?.point}/${window.__walkCursor === true}`' })
    seen = result.content.map(c => ('text' in c ? c.text : '')).join(' ')
    if (!result.isError && seen.includes('overlay:function/true')) return
  } catch (error) {
    seen = error instanceof Error ? error.message : String(error)
  }
  throw new Error(`the walk browser lacks the cursor and arrow overlay (skills/browser-arrows/scripts/cursor.js and arrow.js): the page at ${url} reported ${seen.trim()}. The Playwright server was started without the plugin's init scripts. Run /mcp, reconnect ${server}, then run /walk-doc again.`)
}

async function startWalk($: EngineInterface, args: string): Promise<string> {
  const parsed = parseArgs(args)
  if ('error' in parsed) throw new Error(parsed.error)
  const config = await loadConfig($)
  const current = await read($, runAtom)
  await requireAsciinema($)
  if (isActive(current)) throw new Error(`a walk of ${current.target} is still ${current.phase}. Finish it with walk_finish, or run /walk-doc stop.`)
  // Before the dev server: its first compile can take minutes, and a walk without its browser cannot start.
  const browser = await requireBrowser($)
  const values = await findValues($, root, config)
  // A valueKeys key the file lacks is refused here, not after the dev server's first compile.
  if (values !== null) readerValues(parseEnvFile(await $.fs.read(values.file), values.file), config.valueKeys, values.file)
  let target = parsed.target.replace(/^\.\//, '')
  if (target.startsWith('/') && !target.startsWith(`${root}/`)) {
    // A docs-site path such as /manuals/operations-manual/ names a page or a section under the content root.
    const base = `${config.contentRoot}/${target.replace(/^\/+|\/+$/g, '')}`.replace(/\/$/, '')
    const found = await sh($, `for c in ${shellQuote([`${base}.mdx`, `${base}.md`, base])}; do [ -e "$c" ] && { echo "$c"; exit 0; }; done; exit 3`)
    if (found.exitCode !== 0) throw new Error(`the docs-site path ${target} has no page under ${config.contentRoot}: none of ${base}.mdx, ${base}.md or ${base}/ exists (exit ${found.exitCode}). Give a docs page or folder, or a docs URL.`)
    target = found.stdout.trim()
  } else if (target.startsWith(`${root}/`)) target = target.slice(root.length + 1)

  const allowed = new Set<string>()
  if (!isUrl(target)) {
    const listed = await sh($, `test -e ${shellQuote([target])} || { echo "missing" >&2; exit 3; }; find ${shellQuote([target])} -type f \\( -name '*.mdx' -o -name '*.md' \\)`)
    if (listed.exitCode !== 0) throw new Error(`${target} does not exist under ${root} (exit ${listed.exitCode}: ${listed.stderr.trim()}). Give a docs page or folder under ${config.contentRoot}.`)
    for (const file of listed.stdout.split('\n').filter(Boolean)) {
      for (const p of docsNamedPaths(await $.fs.read(`${root}/${file}`))) allowed.add(p)
    }
  }

  const runId = `${(await $.clock.now()).toString(36)}${Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0')}`
  const port = await sh($, `python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'`)
  if (port.exitCode !== 0) throw new Error(`cannot pick a free port (python3 exit ${port.exitCode}): ${port.stderr.trim()}`)
  const portNo = Number(port.stdout.trim())
  const base = `http://localhost:${portNo}`
  const startUrls = [pageUrl(target, config, base)]
  const runDir = `${root}/walk-run/${runId}`
  const logFile = `${runDir}/devserver.log`
  const command = shellQuote(config.devCommand.map(a => a.replaceAll('{port}', String(portNo))))
  // set -m gives the server its own process group, so a stop ends pnpm, next and every child under them.
  // Polling, because a machine running many dev servers runs out of file-event watchers: the server then
  // never sees an edit, keeps serving stale pages, and only a restart clears it.
  const started = await sh($, `set -m; mkdir -p ${shellQuote([runDir])} && nohup env WATCHPACK_POLLING=true CHOKIDAR_USEPOLLING=1 ${command} >${shellQuote([logFile])} 2>&1 < /dev/null & echo $!`)
  const pid = Number(started.stdout.trim())
  if (started.exitCode !== 0 || !Number.isInteger(pid) || pid <= 0) {
    throw new Error(`the docs dev server did not start (exit ${started.exitCode}): ${started.stderr.trim()}. Command: ${command}`)
  }
  const probe = isUrl(target) ? `${base}/` : startUrls[0]!
  let ready: Awaited<ReturnType<typeof sh>>
  try {
    ready = await sh($, `end=$((SECONDS + ${READY_SECONDS})); while [ $SECONDS -lt $end ]; do curl -sf --max-time ${PROBE_SECONDS} -o /dev/null ${shellQuote([probe])} && exit 0; kill -0 ${pid} 2>/dev/null || exit 4; sleep 1; done; exit 5`, (READY_SECONDS + PROBE_SECONDS + 30) * 1000)
  } catch (error) {
    await killGroup($, pid)
    throw new Error(`/walk-doc was interrupted while the docs dev server started (${error instanceof Error ? error.message : String(error)}). The server (process group ${pid}) is stopped; its log is ${logFile}. Run /walk-doc again.`)
  }
  if (ready.exitCode !== 0) {
    const tail = await sh($, `tail -n 30 ${shellQuote([logFile])}`)
    await killGroup($, pid)
    const load = ready.exitCode === 4 ? '' : ` Machine: ${(await sh($, 'uptime')).stdout.trim()}. A first page compile on a loaded machine can take longer: close what loads it and run /walk-doc again.`
    const why = ready.exitCode === 4 ? 'the server exited' : `${probe} did not answer within ${READY_SECONDS} s`
    throw new Error(`the docs dev server is not ready: ${why}.${load} Command: ${command} (pid ${pid}). Last log lines (${logFile}):\n${tail.stdout}`)
  }

  try {
    await requireOverlay($, browser, probe)
  } catch (error) {
    await killGroup($, pid)
    throw error
  }

  let run: Run
  try {
    const home = (await $.env.get('HOME')) ?? ''
    if (home === '') throw new Error('HOME is not set, so the Walk workspace has no home.')
    run = newRun({ runId, target, startUrls, persona: parsed.persona ?? config.persona, root, home, port: portNo, pid, now: await $.clock.now(), allowedPaths: [...allowed], reRecord: parsed.reRecord })
    run = await spawnWalk($, run)
    await save($, run)
  } catch (error) {
    // No run is saved yet, so /walk-doc stop could not find this server: stop it here.
    await killGroup($, pid)
    throw new Error(`the Walk agent did not start (${error instanceof Error ? error.message : String(error)}). The docs dev server (process group ${pid}) is stopped; its log is ${logFile}.`)
  }
  void $.ui.open({ id: PANE, title: 'Walk' })
  return [
    `Walk ${runId} started on ${startUrls[0]}.`,
    `Docs dev server: ${base}/ (pid ${pid}, log ${logFile}).`,
    ...(values === null ? [] : [`Values: ${values.file}, ${values.place}.`]),
    `Reader: ${run.persona}. Workspace: ${workspaceOf(run)}.${run.reRecord === true ? ' Re-record: the reader records every recording on the page again and sends each with walk_record REPLACE.' : ''}`,
    'Walk reports reach Claude as messages. Claude fixes on this branch and answers with walk_reply.',
  ].join('\n')
}

// /walk-doc tip <text>: kept in .walk-doc.json for every later reader, and sent now to the running one.
async function addWalkTip($: EngineInterface, tip: string): Promise<string> {
  const run = await read($, runAtom)
  const at = isActive(run) ? run.root : root
  const file = `${at}/${CONFIG_FILE}`
  const text = addTip(await $.fs.read(file), tip)
  await $.fs.write(file, text)
  const saved = `Saved the tip in ${file}; every new reader is told it.`
  if (!isActive(run) || run.agentId === null) return `${saved} No walk is running, so no reader was sent it.`
  const sent = await $.session.send({ to: { agentId: run.agentId }, text: `TIP from the person who runs this walk: ${cleanTip(tip)}\nUse it from now on, and carry on with what you were doing.` })
  return sent.isDelivered ? `${saved} Sent to the reader.` : `${saved} It did not reach the reader ${run.agentId} (${sent.reason}); send it with walk_ask.`
}

// /walk-doc restart [note]: a fresh reader in a new attempt workspace, told the person's note. The engine cannot stop
// an agent, so the old reader is told to stop and the guard refuses its further tool calls.
async function restartWalk($: EngineInterface, note: string): Promise<string> {
  const run = await read($, runAtom)
  if (!isActive(run)) throw new Error('no walk is running. Start one with /walk-doc <path>.')
  const old = run.agentId
  const restarted = restartByPerson(run, note, await $.clock.now())
  let told = ''
  if (old !== null) {
    const sent = await $.session.send({ to: { agentId: old }, text: 'STOP: the person restarted the walk and a fresh reader takes over. End your turn now; run nothing more.' })
    if (!sent.isDelivered) told = ` The old reader ${old} was not told to stop (${sent.reason}); the guard refuses its tool calls.`
  }
  const cleaned = await cleanMachines($, run)
  const next = await spawnWalk($, restarted, note)
  await save($, next)
  return `Restarted: a fresh reader started, attempt ${next.attempt} (${next.attempt - 1} of 20 restarts used).${note === '' ? '' : ` It was told: ${note}`}${told}${cleaned}`
}

async function stopWalk($: EngineInterface): Promise<string> {
  const run = await read($, runAtom)
  if (!isActive(run)) return 'No walk is running.'
  const settled = settleCopyReviews(run)
  return `${await finish($, settled.run, 'Stopped by /walk-doc stop.')}${settled.lostNote}`
}

// One docs page the reader has opened goes to the copy editor. The reader does not wait for it.
const COPY_AGENT = 'ndev:copy-editor'
// A review row with no agent yet counts as running only while its send is here. After a reload of the hooks it is lost.
const copySends = new Set<string>()
const copySendKey = (run: Run, url: string) => `${run.runId} ${url}`

async function wakeWhenReviewsEnd($: EngineInterface) {
  const run = await read($, runAtom)
  if (!isActive(run) || run.phase !== 'done' || (run.copyReviews ?? []).some(c => c.state === 'running')) return
  tellMain($, 'Every copy review has ended. When each COPY note has its answer, call walk_finish.')
}

async function sendPageToCopyEditor($: EngineInterface, run: Run, url: string): Promise<void> {
  const isRunning = (c: { url: string; state: string }) => c.url === url && c.state === 'running'
  const failed = async (detail: string) => {
    await update($, runAtom, r => (r === null ? r : { ...r, copyReviews: (r.copyReviews ?? []).map(c => (isRunning(c) ? { ...c, state: 'failed' as const, detail } : c)) }))
    if (!isActive(await read($, runAtom))) return
    tellMain($, `The copy editor did not review ${url}: ${detail} The reader carries on. Repair: fix the cause, then start the ${COPY_AGENT} agent by hand with the text of the page.`)
    await wakeWhenReviewsEnd($)
  }
  try {
    const page = await $.process.run(['curl', '--silent', '--show-error', '--fail', '--location', '--max-time', '30', url], { timeoutMs: 40_000 })
    if (page.exitCode !== 0) return await failed(`curl exit ${page.exitCode}: ${page.stderr.trim().slice(0, 300)}.`)
    const text = pageProse(page.stdout)
    if (text === '') return await failed('the page has no text after the code and the navigation are removed.')
    const file = `${runDirOf(run)}/copy/${url.replace(/^https?:\/\/[^/]+\//, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'home'}.md`
    await $.fs.write(file, `${text}\n`)
    const description = `Copy edit ${url}`
    const spawned = await $.agent.spawn({
      subagentType: COPY_AGENT, description, cwd: run.root,
      prompt: `Edit the copy of one docs page, which is the text in ${file}. It came from ${url}. The project root is ${run.root}. The plugin root is ${$.plugin.root}. Judge the language only: another agent checks the instructions.`,
    })
    if (spawned.deny !== undefined) return await failed(`the agent did not start: ${spawned.deny}.`)
    const agentId = spawned.agentId ?? (await $.agent.list()).find(a => a.description === description)?.id ?? null
    if (agentId === null) return await failed('the agent started, but neither the spawn result nor the agent list names its id, so its answer could not be matched.')
    await update($, runAtom, r => (r === null ? r : { ...r, copyReviews: (r.copyReviews ?? []).map(c => (isRunning(c) ? { ...c, file, agentId } : c)) }))
  } catch (error) {
    log($, `ERROR: copy review of ${url}: ${String(error)}`)
    await failed(`${error instanceof Error ? error.message : String(error)}.`)
  } finally {
    copySends.delete(copySendKey(run, url))
  }
}

async function finish($: EngineInterface, run: Run, summary: string): Promise<string> {
  const done: Run = { ...run, phase: 'finished', summary: run.summary === null ? summary : `${run.summary}\n\nMain agent: ${summary}` }
  const reportPath = `${runDirOf(run)}/report.md`
  await $.fs.write(reportPath, reportMarkdown(done))
  const notes = (await stopServer($, run)) + (await cleanMachines($, run))
  await save($, done)
  showIdleStatus($, undefined)
  const open = done.findings.filter(f => f.resolution === null || f.resolution.action === 'ESCALATED').length
  const texted = await sendText($, `walk-doc finished ${run.target}: ${done.findings.length} findings, ${open} open, ${done.attempt - 1} restarts. Report: ${reportPath}`)
  return `Walk finished. Report: ${reportPath}.${notes} ${texted}`
}

// A Walk agent's turn ended: fine after a report, otherwise nudge it, then tell the main agent.
// register.ts calls it from the plugin's one turn.complete hook, after the turn's own result.
export async function walkDocTurn($: EngineInterface, e: TurnCompleteInput) {
  if (e.agentId === undefined) return
  const run = await read($, runAtom)
  if (!isActive(run)) return
  if ((run.copyReviews ?? []).some(c => c.agentId === e.agentId)) {
    // The answer matters more than the config, which only adds the project's issue rule to the message.
    let issues = ''
    try {
      issues = (await loadConfig($, run.root)).issues
    } catch (error) {
      log($, `WARNING: copy answer of ${e.agentId}: cannot read the walk config: ${String(error)}`)
    }
    const now = await $.clock.now()
    const out: { run: Run | null; message: string | null } = { run: null, message: null }
    // Two editors can end together, so the answer goes on the run as it is now.
    await update($, runAtom, r => {
      if (r === null) return r
      const copy = recordCopy(r, e.agentId!, e.answer, now, issues)
      out.run = copy.run
      out.message = copy.mainMessage
      return copy.run
    })
    if (out.run !== null) await writeRun($, out.run)
    if (out.message !== null) tellMain($, out.message)
    await wakeWhenReviewsEnd($)
    return
  }
  const out = walkStopped(run, e.agentId)
  if (out.kind === 'ignore') return
  await save($, out.run)
  if (out.kind === 'nudge') {
    const sent = await $.session.send({ to: { agentId: e.agentId }, text: out.text })
    if (!sent.isDelivered) tellMain($, `The Walk agent ${e.agentId} stopped without a report, and the nudge did not reach it: ${sent.reason}. Call walk_status, then walk_reply RESTART.`)
  } else tellMain($, `${out.text}\n\nIts last answer:\n${e.answer.slice(0, 2000)}`)
}

// The command is always there, so /walk-doc in a project without the config names it. The reader and its tools
// are offered only in a project that has the config. register.ts calls it from the plugin's one session.start hook.
export async function startWalkDoc($: EngineInterface, cwd: string) {
  const found = await findRoot($, cwd)
  root = found ?? cwd
  await $.command.register({ name: 'walk-doc', description: 'Walk a docs page or folder as a reader: /walk-doc <path|url> [--persona "…"] [--re-record], /walk-doc ask <question>, /walk-doc restart [note], /walk-doc tip <text>, or /walk-doc stop', argumentHint: '<path|url> [--persona "…"] [--re-record] | ask <question> | restart [note] | tip <text> | stop' })
  if (found === null) return
  await $.agent.register({
    name: 'walk', description: 'The /walk-doc docs reader. Spawned only by /walk-doc.', prompt: WALK_SYSTEM_PROMPT,
    disallowedTools: ['Agent', 'SendMessage', 'Workflow', 'Skill', 'EnterWorktree', 'ExitWorktree', 'Artifact', ...MAIN_ONLY],
    omitClaudeMd: true, model: 'inherit',
  })
  for (const tool of WALK_TOOLS) await $.tool.register({ ...tool, inputSchema: tool.inputSchema as unknown as Record<string, unknown>, isDeferred: false })
  const run = await read($, runAtom)
  if (isActive(run)) showIdleStatus($, statusLine(run))
}

// Called from register.ts's session.end (the engine takes one unmatched hook per event).
// A dev server outlives Claude unless something stops it; the run stays, so walk_status still shows it.
export async function walkDocEnd($: EngineInterface) {
  const run = await read($, runAtom)
  if (isActive(run)) await killGroup($, run.pid)
}

export const walkDoc = (on: On, options: PluginOptions) => {
  textTo = typeof options.textTo === 'string' ? options.textTo.trim() : ''

  // The type stays offered: the engine checks the offer when session.send resumes a stopped Walk agent.
  // The model's own Agent call is refused instead, so only /walk-doc starts one.
  on('tool.call', { tool: 'Agent' }, async (_$, e, next) => {
    const input = e as { subagent_type?: unknown; description?: unknown }
    if (input.subagent_type !== AGENT) return next(e)
    if (typeof input.description === 'string' && ownSpawns.has(input.description)) return next(e)
    return { deny: `walk-doc: a Walk agent is started only by /walk-doc, which gives it its workspace and its guard. Run /walk-doc <page>.` }
  })

  on('command.run', { command: 'walk-doc' }, async ($, e) => {
    try {
      const args = e.args.trim()
      if (args === 'stop') return { text: await stopWalk($) }
      if (args === 'restart' || args.startsWith('restart ')) return { text: await restartWalk($, args.slice(7).trim().replace(/^--\s*/, '')) }
      if (args === 'tip' || args.startsWith('tip ')) return { text: await addWalkTip($, args.slice(3).trim().replace(/^--\s*/, '')) }
      if (args === 'ask' || args.startsWith('ask ')) {
        const question = args.slice(3).trim()
        if (question === '') throw new Error('Usage: /walk-doc ask <question>. Say what you want the reader to do or tell you.')
        return { text: await sendAsk($, question) }
      }
      return { text: await startWalk($, e.args) }
    } catch (error) {
      return { text: `walk-doc: ${error instanceof Error ? error.message : String(error)}`, exitCode: 1 }
    }
  })

  // The guard: every tool call of a Walk agent of the running walk.
  on('tool.call', async ($, e, next) => {
    const run = await read($, runAtom)
    if (!isActive(run)) return next(e)
    const config = await loadConfig($, run.root)
    const { tool, tool_use_id: _id, agentId, ...input } = e as unknown as Record<string, unknown> & { tool: string; agentId?: string }
    const denial = guardCall(run, config, { tool, agentId, input }, await $.clock.now())
    const isWalk = agentId !== undefined && run.agentIds.includes(agentId)
    if (isWalk && run.agentId !== null && agentId !== run.agentId) return { deny: `You were replaced: a fresh reader took over this walk (attempt ${run.attempt}). End your turn now; run nothing more.` }
    const sendCopyPages = async (found: string[]) => {
      const pages = newCopyPages(run, found)
      if (pages.length === 0) return
      const at = await $.clock.now()
      // Two calls of the reader can open one page, so only the pages that this update adds are sent.
      let added: string[] = []
      await update($, runAtom, r => {
        if (r === null) return r
        added = newCopyPages(r, pages)
        return { ...r, copyReviews: [...(r.copyReviews ?? []), ...added.map(url => ({ url, file: null, agentId: null, state: 'running' as const, detail: '', at }))] }
      })
      for (const url of added) {
        copySends.add(copySendKey(run, url))
        $.clock.after(0, () => void sendPageToCopyEditor($, run, url))
      }
    }
    if (denial === null && isWalk) await sendCopyPages(docsPagesOpened(run, tool, input))
    // An output too long to show is saved under ~/.claude; the Walk agent may read back only its own.
    const keepSaved = async (result: Awaited<ReturnType<typeof next>>) => {
      const paths = savedOutputs(run, result)
      if (paths.length > 0) await update($, runAtom, r => (r === null ? r : { ...r, savedOutputs: [...new Set([...(r.savedOutputs ?? []), ...paths])] }))
      return result
    }
    if (denial === null && tool === 'Bash' && isWalk && typeof input.command === 'string') {
      // Every command the reader runs is recorded; only a RECORD puts a recording in the docs.
      let seq = 0
      await update($, runAtom, r => {
        if (r === null) return r
        seq = (r.recorded ?? 0) + 1
        return { ...r, recorded: seq }
      })
      if (seq === 0) throw new Error('the walk ended while the command was being recorded')
      return keepSaved(await next({ ...e, command: recordedBash(run, input.command, seq).command } as typeof e))
    }
    if (denial === null && isWalk) {
      const result = await next(e)
      if (tool.startsWith(`mcp__plugin_${PLUGIN}_playwright__`)) {
        await sendCopyPages(docsPagesShown(run, result)).catch((error: unknown) => log($, `ERROR: copy review after ${tool}: ${String(error)}`))
      }
      const armed = arrowAfter(run.arrowArmed === true, { tool, input }, result.deny === undefined && result.isError !== true)
      const dwell = tool === `mcp__plugin_${PLUGIN}_playwright__browser_evaluate` && typeof input.function === 'string' ? arrowDwellOf(input.function) : null
      if (armed && dwell !== null) {
        const armedAt = await $.clock.now()
        await update($, runAtom, r => (r === null ? r : { ...r, arrowArmed: true, arrowArmedAt: armedAt, arrowDwellMs: dwell }))
      } else if (armed !== (run.arrowArmed === true)) await update($, runAtom, r => (r === null ? r : { ...r, arrowArmed: armed }))
      return keepSaved(result)
    }
    if (denial === null) return next(e)
    await update($, runAtom, r => (r === null ? r : { ...r, denials: [...r.denials, { tool, detail: denial, at: Date.now() }] }))
    return { deny: denial }
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    const why = `${next.error.kind}: ${next.error.message ?? 'no message'}`
    log($, `guard failed on ${e.tool} (agent ${e.agentId ?? 'main'}): ${why}`)
    // The guard is for Walk agents: its own failure never blocks the main agent.
    if (e.agentId === undefined) return next(e)
    return { deny: `walk-doc: the guard failed (${why}), so the call is refused. Run /walk-doc stop, fix the cause, then /walk-doc again.` }
  })

  const answer = (text: string) => ({ result: text })
  const refuse = (text: string) => ({ deny: `walk-doc: ${text}` })

  on('tool.call', { tool: TOOL('walk_report') }, async ($, e) => {
    const run = await read($, runAtom)
    if (!isActive(run) || e.agentId === undefined || !run.agentIds.includes(e.agentId)) return refuse('walk_report is for the Walk agent of a running walk.')
    try {
      const out = recordReport(run, e as never, await $.clock.now(), (await loadConfig($, run.root)).issues)
      await save($, out.run)
      tellMain($, out.mainMessage)
      return answer(out.walkReply)
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error))
    }
  })

  on('tool.call', { tool: TOOL('walk_enhance') }, async ($, e) => {
    const run = await read($, runAtom)
    if (!isActive(run) || e.agentId === undefined || !run.agentIds.includes(e.agentId)) return refuse('walk_enhance is for the Walk agent of a running walk.')
    try {
      const out = recordEnhance(run, e as never, await $.clock.now(), (await loadConfig($, run.root)).issues)
      await save($, out.run)
      tellMain($, out.mainMessage)
      return answer(out.walkReply)
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error))
    }
  })

  on('tool.call', { tool: TOOL('walk_record') }, async ($, e) => {
    const run = await read($, runAtom)
    if (!isActive(run) || e.agentId === undefined || !run.agentIds.includes(e.agentId)) return refuse('walk_record is for the Walk agent of a running walk.')
    try {
      const config = await loadConfig($, run.root)
      const out = recordMedia(run, e as never, config, await $.clock.now(), $.plugin.root)
      const file = out.run.findings.at(-1)!.evidence
      if (!(await $.fs.exists(file))) return refuse(`there is no file at ${file}. Save the recording or screenshot in your media folder first, then call walk_record again.`)
      if (file.endsWith('.cast')) {
        const script = file.replace(/\.cast$/, '.sh')
        const problems = castProblems(await $.fs.read(file), (await $.fs.exists(script)) ? await $.fs.read(script) : null, await loadSecrets($, run.root, config), config.valuesFile ?? undefined)
        if (problems.length > 0) return refuse([`${file.split('/').at(-1)} is not a real recording:`, ...problems.map(p => `- ${p}`), RECORD_AGAIN].join('\n'))
      }
      await save($, out.run)
      tellMain($, out.mainMessage)
      return answer(out.walkReply)
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error))
    }
  })

  on('tool.call', { tool: TOOL('walk_done') }, async ($, e) => {
    const run = await read($, runAtom)
    if (!isActive(run) || e.agentId !== run.agentId || run.phase !== 'walking') return refuse('walk_done is for the current Walk agent while it walks.')
    const summary = String((e as { summary?: unknown }).summary ?? '').trim()
    const done: Run = { ...run, phase: 'done', summary }
    await save($, done)
    const config = await loadConfig($, run.root)
    const pending = done.findings.filter(x => isNonBlocking(x) && x.resolution === null).map(x => `- #${x.n} ${x.code} at ${x.step}: ${x.actual}`)
    tellMain($, [
      `The Walk agent finished ${run.target} on attempt ${run.attempt}. Its summary: ${summary}`,
      pending.length > 0 ? `\nENHANCE, RECORD and COPY notes not yet answered (answer each with walk_reply NOTED):\n${pending.join('\n')}` : '',
      ...(config.finish.length > 0 ? ['\nThen run the finish duties once:', ...config.finish.map(c => `- ${c}`)] : []),
      'Then call walk_finish with a summary.',
    ].join('\n'))
    return answer('Done. End your turn.')
  })

  on('tool.call', { tool: TOOL('walk_reply') }, async ($, e) => {
    if (e.agentId !== undefined) return refuse('walk_reply belongs to the main agent.')
    const run = await read($, runAtom)
    if (!isActive(run)) return refuse('no walk is running.')
    const input = e as unknown as { action?: unknown; note?: unknown; changed?: unknown; new_approach?: unknown; answers?: unknown }
    // A reader that is walking has no report to answer; RESTART retires it the way /walk-doc restart does.
    if (input.action === 'RESTART' && run.phase === 'walking') {
      const note = typeof input.note === 'string' ? input.note.trim() : ''
      if (note === '') return refuse('walk_reply needs a note: what you changed, or why nothing needed to.')
      try {
        return answer(`RESTART: ${await restartWalk($, note)} End your turn; the next report arrives as a message.`)
      } catch (error) {
        return refuse(error instanceof Error ? error.message : String(error))
      }
    }
    const r = applyReply(run, { action: input.action, note: input.note, changed: input.changed, newApproach: input.new_approach, answers: input.answers }, await $.clock.now())
    if (r.effect === 'refuse') return refuse(r.reason)
    if (r.effect === 'record') {
      await save($, r.run)
      return answer(`NOTED: the answer to #${String(input.answers)} is in the walk pane. The reader was not stopped.`)
    }
    if (r.effect === 'send') {
      let values: string
      try {
        values = await loadValues($, run.root, await loadConfig($, run.root), MID_WALK_RETRY)
      } catch (error) {
        return refuse(error instanceof Error ? error.message : String(error))
      }
      const sent = await $.session.send({ to: { agentId: r.to }, text: [r.text, values].filter(Boolean).join('\n\n') })
      if (!sent.isDelivered) return refuse(`CONTINUE did not reach the Walk agent ${r.to}: ${sent.reason}. RESTART starts a fresh reader.`)
      await save($, r.run)
      return answer('CONTINUE sent to the Walk agent. End your turn; the next report arrives as a message.')
    }
    const cleaned = await cleanMachines($, run)
    try {
      const next = await spawnWalk($, r.run)
      await save($, next)
      return answer(`RESTART: a fresh reader started, attempt ${next.attempt} (${next.attempt - 1} of 20 restarts used).${cleaned} End your turn; the next report arrives as a message.`)
    } catch (error) {
      await save($, { ...run })
      return refuse(`${error instanceof Error ? error.message : String(error)}.${cleaned}`)
    }
  })

  on('tool.call', { tool: TOOL('walk_escalate') }, async ($, e) => {
    if (e.agentId !== undefined) return refuse('walk_escalate belongs to the main agent.')
    const run = await read($, runAtom)
    if (!isActive(run)) return refuse('no walk is running.')
    try {
      const out = escalate(run, e as never, await $.clock.now())
      await save($, out.run)
      const texted = await sendText($, out.text)
      return answer(`Escalated. ${texted} Ask the person the question in your reply and end your turn. After their answer, fix and call walk_reply.`)
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error))
    }
  })

  on('tool.call', { tool: TOOL('walk_finish') }, async ($, e) => {
    if (e.agentId !== undefined) return refuse('walk_finish belongs to the main agent.')
    const run = await read($, runAtom)
    if (!isActive(run)) return refuse('no walk is running.')
    // A copy editor that still runs holds the walk open. One that a restart lost is recorded and does not.
    const live = new Set((await $.agent.list()).filter(a => ['pending', 'running', 'waiting'].includes(a.status)).map(a => a.id))
    const running = (run.copyReviews ?? []).filter(c => c.state === 'running' && (c.agentId === null ? copySends.has(copySendKey(run, c.url)) : live.has(c.agentId)))
    if (running.length > 0) return refuse(`The copy editor still reviews ${running.map(c => c.url).join(', ')}. Each answer comes to you as a message. If none comes, call walk_finish again: a review whose agent has ended is recorded as lost.`)
    const settled = settleCopyReviews(run)
    return answer(`${await finish($, settled.run, String((e as { summary?: unknown }).summary ?? '').trim())}${settled.lostNote}`)
  })

  on('tool.call', { tool: TOOL('walk_ask') }, async ($, e) => {
    if (e.agentId !== undefined) return refuse('walk_ask belongs to the main agent.')
    try {
      return answer(await sendAsk($, (e as { question?: unknown }).question))
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error))
    }
  })

  on('tool.call', { tool: TOOL('walk_answer') }, async ($, e) => {
    const run = await read($, runAtom)
    if (!isActive(run) || e.agentId === undefined || !run.agentIds.includes(e.agentId)) return refuse('walk_answer is for the Walk agent of a running walk.')
    try {
      const out = answerAsk(run, e as never, await $.clock.now())
      await save($, out.run)
      tellMain($, out.mainMessage)
      return answer(out.walkReply)
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error))
    }
  })

  on('tool.call', { tool: TOOL('walk_status') }, async ($, e) => {
    if (e.agentId !== undefined) return refuse('walk_status belongs to the main agent.')
    const run = await read($, runAtom)
    return answer(run === null ? 'No walk has run in this session.' : JSON.stringify(run, null, 2))
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const run = await read($, runAtom)
    if (run === null) return <Text dimColor>No walk yet. /walk-doc &lt;path|url&gt;</Text>
    const counts = ['OMISSION', 'BUG', 'INCORRECT', 'BLOCKED', 'ENHANCE', 'RECORD', 'COPY'].map(c => `${c} ${run.findings.filter(f => f.code === c).length}`).join(' · ')
    const chat = chatMessages(run)
    return (
      <Box flexDirection="column">
        <Text bold>{run.target}</Text>
        <Text>Docs: http://localhost:{run.port}/</Text>
        <Text>{run.phase} · attempt {run.attempt} · restarts {run.attempt - 1}/20</Text>
        <Text>{counts} · denials {run.denials.length}</Text>
        {chat.length > 0 && <Text bold>Walk ⇄ main agent</Text>}
        {chat.length > CHAT_SHOWN && <Text dimColor>…{chat.length - CHAT_SHOWN} earlier (walk_status lists all)</Text>}
        {chat.slice(-CHAT_SHOWN).map(m => (
          <Box key={`${m.at}-${m.from}-${m.text}`} borderStyle="round" borderColor={CHAT_COLOR[m.kind]} paddingX={1} width="85%" alignSelf={m.from === 'Walk' ? 'flex-start' : 'flex-end'} flexDirection="column">
            <Text bold color={CHAT_COLOR[m.kind]}>{m.from === 'Walk' ? 'Walk' : 'Main'} · {m.kind}</Text>
            <Text wrap="wrap">{m.text}</Text>
          </Box>
        ))}
      </Box>
    )
  })
}

function statusLine(run: Run): string | undefined {
  if (run.phase === 'finished') return undefined
  return `walk-doc: ${run.phase} · attempt ${run.attempt} · ${run.findings.length} findings · http://localhost:${run.port}/`
}
