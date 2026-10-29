import { expect, test } from 'claude-code/testing'

import {
  MAX_RESTARTS, SAME_STEP_LIMIT, applyReply, savedOutputs, escalate, walkStopped, docsNamedPaths, guardCall, imessageArgv, newRun, pageUrl, parseArgs,
  castProblems, parseConfig, recordEnhance, recordMedia, recordedBash, recordReport, chatMessages, CHAT_COLOR, parseEnvFile, valuesNote, reportMarkdown, shellQuote, ancestorsOf, addTip, tipsNote,
} from '../hooks/walk-doc/walk'
import type { Config, Run } from '../hooks/walk-doc/walk'
import { WALK_SYSTEM_PROMPT, walkTask } from '../hooks/walk-doc/prompts'
import { MACHINES, REQUIRED_KEYS, fixture, fixtureWithout } from './walk-doc-fixture'

const config: Config = parseConfig(fixture())

const run = (over: Partial<Run> = {}): Run => ({
  ...newRun({ runId: 'r1', target: 'apps/docs/content/installation', startUrls: ['http://localhost:4000/installation/'], persona: 'p', root: '/repo', home: '/home/n', port: 4000, pid: 42, now: 0, allowedPaths: [] }),
  ...over,
})

const report = { code: 'OMISSION', step: 'installation/quick-start#install', expected: 'a command', actual: 'none given', evidence: 'page text' }

// The run after a reply the walk accepted; a refusal fails the test with its reason.
function accepted(r: ReturnType<typeof applyReply>) {
  if (r.effect === 'refuse') throw new Error(r.reason)
  return r.run
}

test('parseArgs reads the target and an optional quoted persona', () => {
  expect(parseArgs('apps/docs/content/installation')).toEqual({ target: 'apps/docs/content/installation', persona: null, reRecord: false })
  expect(parseArgs('apps/docs/content/x.mdx --persona "an ops engineer on Linux"')).toEqual({ target: 'apps/docs/content/x.mdx', persona: 'an ops engineer on Linux', reRecord: false })
  expect(parseArgs('')).toEqual({ error: expect.stringContaining('/walk-doc <path|url>') })
  for (const form of ['/walk-doc ask <question>', '/walk-doc restart [note]', '/walk-doc tip <text>', '/walk-doc stop']) expect(parseArgs('')).toEqual({ error: expect.stringContaining(form) })
})

test('parseArgs reads --re-record before or after the target and the persona', () => {
  expect(parseArgs('/manuals/operations-manual/ --re-record')).toEqual({ target: '/manuals/operations-manual/', persona: null, reRecord: true })
  expect(parseArgs('--re-record /manuals/operations-manual/')).toEqual({ target: '/manuals/operations-manual/', persona: null, reRecord: true })
  expect(parseArgs('x.mdx --re-record --persona "an ops engineer"')).toEqual({ target: 'x.mdx', persona: 'an ops engineer', reRecord: true })
  expect(parseArgs('x.mdx --persona "an ops engineer" --re-record')).toEqual({ target: 'x.mdx', persona: 'an ops engineer', reRecord: true })
  expect(parseArgs('--re-record')).toEqual({ error: expect.stringContaining('[--re-record]') })
})

test('a --re-record walk tells every reader to re-record each recording on the page; a plain walk does not', () => {
  const plain = walkTask(run(), config)
  const again = walkTask(run({ reRecord: true }), config)
  expect(plain).not.toMatch(/re-record/i)
  expect(again).toMatch(/Re-record every recording[^\n]*GIF[^\n]*screenshot[^\n]*terminal cast/)
  expect(again).toMatch(/walk_record[^\n]*REPLACE[^\n]*replaces/)
  expect(again).toMatch(/even when it still looks right/)
  expect(newRun({ runId: 'r', target: 't', startUrls: [], persona: 'p', root: '/', home: '/h', port: 1, pid: 1, now: 0, allowedPaths: [], reRecord: true }).reRecord).toBe(true)
  expect(run().reRecord).toBe(false)
})

test('parseConfig refuses a config without the dev command, naming the field and the file', () => {
  expect(() => parseConfig('{"contentRoot":"c"}')).toThrow(/devCommand.*\.walk-doc\.json/)
  expect(() => parseConfig('{"devCommand":["x"],"contentRoot":"c"}')).toThrow(/\{port\}/)
})

test('pageUrl maps content files and folders to dev-server pages, and keeps a URL as given', () => {
  const base = 'http://localhost:4000'
  expect(pageUrl('apps/docs/content/installation/quick-start.mdx', config, base)).toBe(`${base}/installation/quick-start/`)
  expect(pageUrl('apps/docs/content/installation/index.mdx', config, base)).toBe(`${base}/installation/`)
  expect(pageUrl('apps/docs/content/installation', config, base)).toBe(`${base}/installation/`)
  expect(pageUrl('apps/docs/content/index.mdx', config, base)).toBe(`${base}/`)
  expect(pageUrl('https://docs.example.com/guide/', config, base)).toBe('https://docs.example.com/guide/')
  expect(() => pageUrl('apps/ui/src/x.ts', config, base)).toThrow(/not under the content root apps\/docs\/content/)
})

test('docsNamedPaths collects the file paths a page tells the reader to use', () => {
  const mdx = 'Edit `config/foo.json`, then run `./acme doctor`. See `~/.acme/env`. Not `pnpm install` or `A/B testing`.'
  expect(docsNamedPaths(mdx)).toEqual(['config/foo.json', '~/.acme/env'])
})

test('a blocking report waits for the main agent and counts blocks per step', () => {
  const first = recordReport(run(), report, 10)
  expect(first.run.phase).toBe('awaiting')
  expect(first.run.findings).toHaveLength(1)
  expect(first.run.stepBlocks[report.step]).toBe(1)
  expect(first.walkReply).toMatch(/End your turn now/)
  expect(first.mainMessage).toMatch(/OMISSION/)
  expect(first.mainMessage).toMatch(/walk_reply/)
})

test('a report is refused when a field is missing or the code is unknown, and nothing is recorded', () => {
  expect(() => recordReport(run(), { ...report, code: 'ENHANCE' }, 1)).toThrow(/walk_enhance/)
  expect(() => recordReport(run(), { ...report, code: 'NOPE' }, 1)).toThrow(/OMISSION, BUG, INCORRECT, BLOCKED/)
  expect(() => recordReport(run(), { ...report, actual: ' ' }, 1)).toThrow(/actual/)
  expect(() => recordReport(run({ phase: 'awaiting' }), report, 1)).toThrow(/already waits/)
})

test('a BUG or INCORRECT tells the main agent to check the branch first, as the reader may run an older release', () => {
  for (const code of ['BUG', 'INCORRECT']) {
    const { mainMessage } = recordReport(run(), { ...report, code }, 1)
    expect(mainMessage).toMatch(/already fix[^\n]*released build[^\n]*CONTINUE[^\n]*commit/)
  }
  expect(recordReport(run(), report, 1).mainMessage).not.toMatch(/released build/)
})

test('BLOCKED goes to the main agent, never straight to the person', () => {
  const { mainMessage } = recordReport(run(), { ...report, code: 'BLOCKED' }, 1)
  expect(mainMessage).toMatch(/Try every route/)
  expect(mainMessage).toMatch(/walk_escalate/)
})

test('a product fault is fixed as it happens, filed as an issue only when it cannot be fixed now, never documented as a workaround', () => {
  const ISSUES = 'bash scripts/github/gh.sh issue-new --title <t> --body-file <f>'
  const blocking = recordReport(run(), report, 1, ISSUES).mainMessage
  const enhance = recordEnhance(run(), { step: 's', note: 'The container outlives the terminal' }, 1, ISSUES).mainMessage
  for (const m of [blocking, enhance]) {
    expect(m).toMatch(/Never document a workaround/)
    expect(m).toMatch(/Fix a product fault in the product as it happens/)
    expect(m).toMatch(/Only when you cannot fix it[\s\S]*file an issue/)
    expect(m).toContain(`file an issue with: ${ISSUES}`)
  }
  expect(blocking).not.toMatch(/open no issue/)
  expect(recordReport(run(), report, 1).mainMessage).toMatch(/no issue command is set[\s\S]*"issues"/)
  expect(() => parseConfig(fixture({ issues: 3 }))).toThrow(/issues/)
})

test('ENHANCE tells the main agent and lets the reader carry on; NOTED records the answer without resuming anyone', () => {
  const sent = recordEnhance(run({ agentId: 'a1', agentIds: ['a1'] }), { step: '/installation/#install', note: 'Add a copy button' }, 5)
  expect(sent.run.phase).toBe('walking')
  expect(sent.run.findings[0]).toMatchObject({ n: 1, code: 'ENHANCE', step: '/installation/#install', actual: 'Add a copy button', resolution: null })
  expect(sent.run.stepBlocks).toEqual({})
  expect(sent.walkReply).toMatch(/Carry on/)
  expect(sent.mainMessage).toMatch(/ENHANCE #1[\s\S]*Add a copy button[\s\S]*walk-doc ENHANCE:[\s\S]*NOTED[\s\S]*answers: 1/)
  const noted = applyReply(sent.run, { action: 'NOTED', answers: 1, note: 'Added it', changed: ['/installation/'] }, 6)
  expect(noted.effect).toBe('record')
  expect(accepted(noted).phase).toBe('walking')
  expect(accepted(noted).findings[0]!.resolution).toEqual({ action: 'NOTED', note: 'Added it', changed: ['/installation/'], at: 6 })
  expect(applyReply(sent.run, { action: 'CONTINUE', note: 'x' }, 6)).toMatchObject({ effect: 'refuse' })
  expect(applyReply(sent.run, { action: 'NOTED', answers: 2, note: 'x' }, 6)).toMatchObject({ effect: 'refuse', reason: expect.stringContaining('#2') })
  expect(() => recordEnhance(run(), { step: 's', note: ' ' }, 1)).toThrow(/note/)
})

test('a blocking reply answers the blocking report, not a later ENHANCE note', () => {
  let r = recordReport(run({ agentId: 'a1', agentIds: ['a1'] }), report, 1).run
  r = recordEnhance(r, { step: 's', note: 'n' }, 2).run
  const cont = accepted(applyReply(r, { action: 'CONTINUE', note: 'fixed' }, 3))
  expect(cont.findings.map(f => f.resolution?.action ?? null)).toEqual(['CONTINUE', null])
})

test('CONTINUE resumes the same Walk agent; RESTART asks for a fresh one', () => {
  const waiting = recordReport(run({ agentId: 'a1', agentIds: ['a1'] }), report, 1).run
  const cont = applyReply(waiting, { action: 'CONTINUE', note: 'Added the command', changed: ['installation/quick-start'] }, 2)
  expect(cont.effect).toBe('send')
  if (cont.effect !== 'send') throw new Error('unreachable')
  expect(cont.to).toBe('a1')
  expect(cont.text).toMatch(/CONTINUE[\s\S]*installation\/quick-start[\s\S]*Added the command/)
  expect(cont.run.phase).toBe('walking')
  const restart = applyReply(waiting, { action: 'RESTART', note: 'Reworked the page' }, 2)
  expect(restart.effect).toBe('spawn')
  expect(accepted(restart).attempt).toBe(2)
  expect(accepted(restart).stepBlocks).toEqual({})
})

test('a reply is refused unless the walk waits for one', () => {
  expect(applyReply(run(), { action: 'CONTINUE', note: 'x' }, 1)).toEqual({ effect: 'refuse', reason: expect.stringMatching(/not waiting/) })
})

test(`RESTART is refused past ${MAX_RESTARTS} restarts`, () => {
  const waiting = recordReport(run({ attempt: MAX_RESTARTS + 1 }), report, 1).run
  const r = applyReply(waiting, { action: 'RESTART', note: 'again' }, 2)
  expect(r).toEqual({ effect: 'refuse', reason: expect.stringMatching(/20 restarts/) })
})

test(`the ${SAME_STEP_LIMIT}th block on one step forces a change of approach before CONTINUE`, () => {
  let r = run({ agentId: 'a1', agentIds: ['a1'] })
  for (let i = 0; i < SAME_STEP_LIMIT; i++) {
    r = recordReport(r, report, i).run
    if (i < SAME_STEP_LIMIT - 1) {
      const c = applyReply(r, { action: 'CONTINUE', note: 'try' }, i)
      expect(c.effect).toBe('send')
      r = accepted(c)
    }
  }
  expect(applyReply(r, { action: 'CONTINUE', note: 'try' }, 99)).toEqual({ effect: 'refuse', reason: expect.stringMatching(/new_approach/) })
  expect(applyReply(r, { action: 'CONTINUE', note: 'try', newApproach: 'a helper traced the failing install' }, 99).effect).toBe('send')
  expect(applyReply(r, { action: 'RESTART', note: 'fresh reader' }, 99).effect).toBe('spawn')
})

test('the guard leaves the main agent and other subagents alone', () => {
  const r = run({ agentIds: ['walk1'] })
  expect(guardCall(r, config, { tool: 'Read', agentId: undefined, input: { file_path: '/repo/apps/ui/x.ts' } })).toBeNull()
  expect(guardCall(r, config, { tool: 'Read', agentId: 'other', input: { file_path: '/repo/apps/ui/x.ts' } })).toBeNull()
})

test('the guard denies the Walk agent the repo source, internal docs, the docs source and ~/.claude', () => {
  const r = run({ agentIds: ['w'] })
  const call = (tool: string, input: Record<string, unknown>) => guardCall(r, config, { tool, agentId: 'w', input })
  expect(call('Read', { file_path: '/repo/apps/ui/x.ts' })).toMatch(/apps\/ui\/x\.ts/)
  expect(call('Read', { file_path: '/repo/docs/wiki/wiki.md' })).toMatch(/denied/)
  expect(call('Grep', { pattern: 'x', path: '/home/n/.claude/skills' })).toMatch(/\.claude/)
  expect(call('Grep', { pattern: 'x' })).toMatch(/path/)
  expect(call('Bash', { command: 'cat /repo/scripts/push-checked.sh' })).toMatch(/scripts/)
  expect(call('Bash', { command: 'git push origin HEAD' })).toMatch(/git push/)
  expect(call('Bash', { command: 'sudo rm -rf /' })).toMatch(/sudo/)
  expect(call('Agent', { prompt: 'x' })).toMatch(/Agent/)
  expect(call('mcp__ndev__walk_reply', { action: 'CONTINUE' })).toMatch(/main agent/)
})

test('the guard keeps the fix-all-prs report tool from the Walk agent', () => {
  const r = run({ agentIds: ['w'] })
  expect(guardCall(r, config, { tool: 'mcp__ndev__report', agentId: 'w', input: { pr: 1, outcome: 'pushed' } })).toMatch(/main agent/)
  expect(guardCall(r, config, { tool: 'mcp__ndev__report', agentId: undefined, input: { pr: 1, outcome: 'pushed' } })).toBeNull()
})

test('the guard sees through $HOME, globs, paths relative to the workspace and a Glob pattern', () => {
  const r = run({ agentIds: ['w'] })
  const call = (tool: string, input: Record<string, unknown>) => guardCall(r, config, { tool, agentId: 'w', input })
  expect(call('Bash', { command: 'cat $HOME/.claude/settings.json' })).toMatch(/\.claude/)
  expect(call('Bash', { command: 'cat "${HOME}/.claude/settings.json"' })).toMatch(/\.claude/)
  expect(call('Bash', { command: 'cat ../../../.claude/settings.json' })).toMatch(/\.claude/)
  expect(call('Bash', { command: 'cat ~/.cl*/settings.json' })).toMatch(/denied/)
  expect(call('Bash', { command: 'ls /repo/ap?s' })).toMatch(/denied/)
  expect(call('Bash', { command: 'cd /repo && cat apps' })).toMatch(/apps/)
  expect(call('Glob', { pattern: '/repo/apps/**/*.ts', path: '/home/n/.walk-doc/r1/attempt-1' })).toMatch(/apps/)
  expect(call('Glob', { pattern: '../../../.claude/**', path: '/home/n/.walk-doc/r1/attempt-1' })).toMatch(/\.claude/)
  expect(call('Glob', { pattern: '**/*.cast', path: '/home/n/.walk-doc/r1/attempt-1' })).toBeNull()
  expect(call('Bash', { command: 'ls *.txt && echo $PATH' })).toBeNull()
  expect(call('Bash', { command: 'ls $HOME/.walk-doc/r1/attempt-1/media' })).toBeNull()
})

test('savedOutputs finds the saved tool output paths in a result, and nothing else under ~/.claude', () => {
  const r = run()
  expect(savedOutputs(r, { stdout: 'x', persistedOutputPath: '/home/n/.claude/projects/p/s/tool-results/b1.txt' })).toEqual(['/home/n/.claude/projects/p/s/tool-results/b1.txt'])
  expect(savedOutputs(r, 'Output saved to: /home/n/.claude/projects/p/s/tool-results/mcp-x-1.json\nmore')).toEqual(['/home/n/.claude/projects/p/s/tool-results/mcp-x-1.json'])
  expect(savedOutputs(r, { stdout: '/home/n/.claude/settings.json /home/n/.claude/projects/p/s/tool-results/../../x.jsonl' })).toEqual([])
  expect(savedOutputs(r, 'ran')).toEqual([])
})

test('the guard opens exactly the saved outputs the Walk agent was given', () => {
  const r = run({ agentIds: ['w'], savedOutputs: ['/home/n/.claude/projects/p/s/tool-results/b1.txt'] })
  const call = (input: Record<string, unknown>) => guardCall(r, config, { tool: 'Read', agentId: 'w', input })
  expect(call({ file_path: '/home/n/.claude/projects/p/s/tool-results/b1.txt' })).toBeNull()
  expect(call({ file_path: '~/.claude/projects/p/s/tool-results/b1.txt' })).toBeNull()
  expect(call({ file_path: '/home/n/.claude/projects/p/s/tool-results/b2.txt' })).toMatch(/\.claude/)
})

test('the guard lets the Walk agent work: its workspace, the rendered docs and files the docs name', () => {
  const r = run({ agentIds: ['w'], allowedPaths: ['config/foo.json'] })
  const call = (tool: string, input: Record<string, unknown>) => guardCall(r, config, { tool, agentId: 'w', input })
  expect(call('Write', { file_path: '/home/n/.walk-doc/r1/attempt-1/notes.txt', content: '' })).toBeNull()
  expect(call('Bash', { command: 'curl -s http://localhost:4000/installation/' })).toBeNull()
  expect(call('Bash', { command: 'cd /repo && ./acme doctor' })).toBeNull()
  expect(call('Edit', { file_path: '/repo/config/foo.json', old_string: 'a', new_string: 'b' })).toBeNull()
  expect(call('Bash', { command: 'vm run walk-r1-1 sudo apt-get install -y curl' })).toBeNull()
  expect(call('mcp__plugin_ndev_playwright__browser_navigate', { url: 'http://localhost:4000/' })).toBeNull()
})

test('shellQuote quotes each argument for bash', () => {
  expect(shellQuote(['pnpm', 'dev', "it's"])).toBe(`'pnpm' 'dev' 'it'\\''s'`)
})

test('the iMessage argv keeps the recipient and text out of the script', () => {
  const argv = imessageArgv('+44 7700 900000', 'walk blocked "x"')
  expect(argv[0]).toBe('osascript')
  expect(argv.slice(-2)).toEqual(['+44 7700 900000', 'walk blocked "x"'])
})

test('the report lists every finding, ENHANCE notes among them, its resolution and denials', () => {
  let r = recordReport(run({ agentId: 'a1', agentIds: ['a1'] }), report, 1).run
  r = accepted(applyReply(r, { action: 'CONTINUE', note: 'Added the install command', changed: ['installation/quick-start'] }, 2))
  r = recordEnhance(r, { step: 'installation/', note: 'Shorter intro' }, 3).run
  r = { ...r, denials: [{ tool: 'Read', detail: '/repo/apps/x', at: 4 }] }
  const md = reportMarkdown(r)
  expect(md).toMatch(/OMISSION/)
  expect(md).toMatch(/Added the install command/)
  expect(md).toMatch(/Shorter intro/)
  expect(md).toMatch(/\/repo\/apps\/x/)
})

test('only the main agent escalates, it must say what it tried, and the reply after the answer is accepted', () => {
  const waiting = recordReport(run({ agentId: 'a1', agentIds: ['a1'] }), { ...report, code: 'BLOCKED' }, 1).run
  expect(() => escalate(run(), { question: 'q', tried: ['x'] }, 2)).toThrow(/not waiting/)
  expect(() => escalate(waiting, { question: 'Which account?', tried: [] }, 2)).toThrow(/tried/)
  const { run: up, text } = escalate(waiting, { question: 'Which account?', tried: ['.env', 'gh auth'] }, 2)
  expect(up.phase).toBe('escalated')
  expect(text).toMatch(/Which account\?/)
  expect(applyReply(up, { action: 'CONTINUE', note: 'Person gave the key' }, 3).effect).toBe('send')
})

test('a Walk agent that ends its turn without a report is nudged twice, then the main agent hears', () => {
  const r = run({ agentId: 'a1', agentIds: ['a1'] })
  const one = walkStopped(r, 'a1')
  expect(one.kind).toBe('nudge')
  const two = walkStopped(one.run, 'a1')
  expect(two.kind).toBe('nudge')
  const three = walkStopped(two.run, 'a1')
  expect(three.kind).toBe('main')
  expect(three.run.phase).toBe('awaiting')
  expect(walkStopped(r, 'other').kind).toBe('ignore')
  expect(walkStopped(recordReport(r, report, 1).run, 'a1').kind).toBe('ignore')
})

test('chatMessages shows reports, ENHANCE notes and replies in full as one conversation, oldest first', () => {
  let r = recordReport(run({ agentId: 'a1', agentIds: ['a1'] }), report, 1).run
  r = accepted(applyReply(r, { action: 'CONTINUE', note: 'added the install command' }, 2))
  r = recordEnhance(r, { step: 'installation/', note: 'a diagram would help' }, 3).run
  r = recordReport(r, { ...report, code: 'BUG', actual: 'y'.repeat(200) }, 4).run
  r = accepted(applyReply(r, { action: 'NOTED', answers: 2, note: 'added a diagram' }, 5))
  const chat = chatMessages(r)
  expect(chat.map(m => m.from)).toEqual(['Walk', 'Main', 'Walk', 'Walk', 'Main'])
  expect(chat.map(m => m.kind)).toEqual(['OMISSION', 'CONTINUE', 'ENHANCE', 'BUG', 'NOTED'])
  expect(chat[0]!.text).toBe('#1 OMISSION at installation/quick-start#install: none given')
  expect(chat[2]!.text).toBe('#2 ENHANCE at installation/: a diagram would help')
  // A bubble grows to fit its message, so nothing is cut.
  expect(chat[3]!.text).toBe(`#3 BUG at installation/quick-start#install: ${'y'.repeat(200)}`)
  expect(chat[4]!.text).toBe('NOTED #2: added a diagram')
})

test('ancestorsOf walks from a folder up to the filesystem root', () => {
  expect(ancestorsOf('/repo/.claude/mods/x/')).toEqual(['/repo/.claude/mods/x', '/repo/.claude/mods', '/repo/.claude', '/repo', '/'])
})

test('each chat kind has its own colour, so a BUG never looks like a CONTINUE', () => {
  const colours = Object.values(CHAT_COLOR)
  expect(Object.keys(CHAT_COLOR).sort()).toEqual(['ANSWER', 'ASK', 'BLOCKED', 'BUG', 'CONTINUE', 'ENHANCE', 'ESCALATED', 'INCORRECT', 'NOTED', 'OMISSION', 'RECORD', 'RESTART'])
  expect(new Set(colours).size).toBe(colours.length)
})

test('parseEnvFile reads KEY=VALUE lines, skips comments and blanks, and strips quotes', () => {
  expect(parseEnvFile('# the download site\nDOWNLOAD_USER=download\n\nDOWNLOAD_PASSWORD="a b=c"\nexport TOKEN=\'x\'\n', '/repo/.env.walk-docs'))
    .toEqual({ DOWNLOAD_USER: 'download', DOWNLOAD_PASSWORD: 'a b=c', TOKEN: 'x' })
})

test('parseEnvFile refuses a line that is not KEY=VALUE, naming the file and the line', () => {
  expect(() => parseEnvFile('GOOD=1\nnot a pair\n', '/repo/.env.walk-docs')).toThrow(/\/repo\/\.env\.walk-docs line 2/)
})

test('valuesNote hands the values to the reader, and says nothing when there are none', () => {
  expect(valuesNote({}, '.walk-values')).toBe('')
  const note = valuesNote({ DOWNLOAD_USER: 'download', DOWNLOAD_PASSWORD: 'pw' }, '.walk-values')
  expect(note).toContain('(from .walk-values)')
  expect(note).toContain('DOWNLOAD_USER=download')
  expect(note).toContain('DOWNLOAD_PASSWORD=pw')
})

test('a Walk Bash command runs under asciinema into the attempt media folder, and keeps its output, exit code and folder', () => {
  const w = recordedBash(run(), 'cd /tmp && ls', 7)
  expect(w.cast).toBe('/home/n/.walk-doc/r1/attempt-1/media/007.cast')
  expect(w.command).toContain(`asciinema rec --headless --quiet --overwrite`)
  expect(w.command).toContain(shellQuote(['cd /tmp && ls']))
  expect(w.command).toContain('< /dev/null')
  expect(w.command).toContain('asciinema convert -f txt')
  expect(w.command).toMatch(/__walk_rc=\$\(cat .*007\.rc.*\(exit "\$\{__walk_rc:-1\}"\)$/)
  // exec replaces the shell, so the EXIT trap never runs; the code comes from the cast's exit event instead.
  expect(w.command).toContain('"x"')
  expect(recordedBash(run({ attempt: 2 }), 'ls', 12).cast).toBe('/home/n/.walk-doc/r1/attempt-2/media/012.cast')
})

test('RECORD asks the main agent to insert or replace a recording or screenshot, and the reader carries on', () => {
  const media = '/home/n/.walk-doc/r1/attempt-1/media'
  const withHint = parseConfig(fixture())
  const r = run({ agentId: 'a1', agentIds: ['a1'] })
  const sent = recordMedia(r, { step: '/installation/#install', file: `${media}/003.cast`, mode: 'INSERT', caption: 'The installer run' }, withHint, 5, '/plugins/dwt')
  expect(sent.run.phase).toBe('walking')
  expect(sent.run.findings[0]).toMatchObject({ n: 1, code: 'RECORD', step: '/installation/#install', expected: 'INSERT', actual: 'The installer run', evidence: `${media}/003.cast`, resolution: null })
  expect(sent.walkReply).toMatch(/Carry on/)
  expect(sent.mainMessage).toMatch(/RECORD #1[\s\S]*INSERT[\s\S]*003\.cast[\s\S]*asciinema convert[\s\S]*Casts go in public\/recordings[\s\S]*walk-doc RECORD:[\s\S]*NOTED[\s\S]*answers: 1/)
  expect(sent.mainMessage).toMatch(/single or simple command[^\n]*one fenced text code block[^\n]*\$ <command>[\s\S]*player only for a lot of scrolling output, a wizard, several commands or TUI effects[\s\S]*Casts go in public\/recordings/)
  const replaced = recordMedia(r, { step: 's', file: `${media}/4.jpg`, mode: 'REPLACE', replaces: '/manuals/screenshots/operations-2.png', caption: 'The import page' }, config, 6, '/plugins/dwt')
  expect(replaced.run.findings[0]!.expected).toBe('REPLACE /manuals/screenshots/operations-2.png')
  expect(() => recordMedia(r, { step: 's', file: `${media}/4.jpg`, mode: 'REPLACE', caption: 'c' }, config, 6, '/plugins/dwt')).toThrow(/replaces/)
  expect(() => recordMedia(r, { step: 's', file: `${media}/4.png`, mode: 'INSERT', caption: 'c' }, config, 6, '/plugins/dwt')).toThrow(/\.cast, \.webm, \.gif/)
  expect(() => recordMedia(r, { step: 's', file: '/repo/x.gif', mode: 'INSERT', caption: 'c' }, config, 6, '/plugins/dwt')).toThrow(/\/home\/n\/\.walk-doc\/r1\//)
  expect(() => recordMedia(r, { step: 's', file: `${media}/4.gif`, mode: 'INSERT', caption: ' ' }, config, 6, '/plugins/dwt')).toThrow(/caption/)
  expect(() => recordMedia(r, { step: 's', file: `${media}/4.gif`, mode: 'MOVE', caption: 'c' }, config, 6, '/plugins/dwt')).toThrow(/INSERT or REPLACE/)
  const noted = applyReply(sent.run, { action: 'NOTED', answers: 1, note: 'Embedded it under Install', changed: ['/installation/'] }, 7)
  expect(accepted(noted).findings[0]!.resolution).toMatchObject({ action: 'NOTED', note: 'Embedded it under Install' })
  expect(chatMessages(accepted(noted)).map(m => m.kind)).toEqual(['RECORD', 'NOTED'])
  expect(() => parseConfig(fixture({ media: 3 }))).toThrow(/media/)
})

test('the reader is told to send RECORD for every step worth seeing and for every screenshot that no longer matches', () => {
  expect(WALK_SYSTEM_PROMPT).not.toMatch(/Only when one is worth adding/)
  expect(WALK_SYSTEM_PROMPT).toMatch(/After each step you finish that a reader would want to see[^\n]*walk_record[^\n]*INSERT/)
  expect(WALK_SYSTEM_PROMPT).toMatch(/screenshot on the page differs from what you see[^\n]*REPLACE/)
})

test('a browser step arrives as a Playwright video, and the main agent is told how to make it a GIF', () => {
  const r = run({ phase: 'walking' })
  const media = '/home/n/.walk-doc/r1/attempt-1/media'
  const sent = recordMedia(r, { step: 's', file: `${media}/step-3.webm`, mode: 'INSERT', caption: 'The import' }, config, 6, '/plugins/dwt')
  expect(sent.run.findings[0]!.evidence).toBe(`${media}/step-3.webm`)
  expect(sent.mainMessage).toContain(`bash /plugins/dwt/scripts/walk-doc/video-to-gif.sh ${media}/step-3.webm <name>.gif`)
  expect(sent.mainMessage).toMatch(/thinking time[^\n]*still stretch/)
  expect(() => recordMedia(r, { step: 's', file: `${media}/4.png`, mode: 'INSERT', caption: 'c' }, config, 6, '/plugins/dwt')).toThrow(/\.webm/)
})

test('the reader drives a 1028x768 Playwright browser and records with its video tools, never claude-in-chrome', () => {
  expect(WALK_SYSTEM_PROMPT).not.toMatch(/claude-in-chrome|gif_creator|resize_window/)
  expect(WALK_SYSTEM_PROMPT).toMatch(/browser_navigate/)
  expect(WALK_SYSTEM_PROMPT).toMatch(/wait 8 seconds[^\n]*browser_start_video/)
  expect(WALK_SYSTEM_PROMPT).toMatch(/browser_start_video[^\n]*size \{ width: 1028, height: 768 \}/)
  expect(WALK_SYSTEM_PROMPT).toMatch(/window\.innerWidth[^\n]*1028[^\n]*BLOCKED/)
  expect(WALK_SYSTEM_PROMPT).toMatch(/never call browser_video_show_actions/)
})

test('the reader points, magnifies and clears with walkArrow', () => {
  expect(WALK_SYSTEM_PROMPT).toMatch(/browser_evaluate[^\n]*walkArrow\.point\([^\n]*untilClick: true/)
  expect(WALK_SYSTEM_PROMPT).toMatch(/walkArrow\.magnify\([^\n]*untilBlur: true/)
  expect(WALK_SYSTEM_PROMPT).toMatch(/walkArrow\.stop\(\)[^\n]*browser_take_screenshot/)
  expect(WALK_SYSTEM_PROMPT).toMatch(/walkArrow[^\n]*NOT_FOUND[^\n]*INCORRECT/)
})

test('the Walk prompt tells the reader to answer an ASK with walk_answer and go back to its walk', () => {
  expect(WALK_SYSTEM_PROMPT).toMatch(/ASK #n[\s\S]*mcp__ndev__walk_answer[^\n]*asks: n[^\n]*go back to what you were doing/)
})

test('a RECORD message keeps a wizard a player even when only part of it is recorded, and says what to clean from the cast', () => {
  const r = run({ agentId: 'a1', agentIds: ['a1'] })
  const sent = recordMedia(r, { step: 's', file: '/home/n/.walk-doc/r1/attempt-1/media/020.cast', mode: 'INSERT', caption: 'c' }, parseConfig(fixture()), 7, '/plugins/dwt')
  expect(sent.mainMessage).toMatch(/A wizard is a player even when the cast holds only part of it/)
  expect(sent.mainMessage).toMatch(/Before publishing a cast[^\n]*personal paths[^\n]*Ctrl\+C[^\n]*command in its header[^\n]*secret[\s\S]*one output event cannot animate[^\n]*ask the reader/)
})

test('the Walk prompt tells the reader to record a step unfiltered, with secrets kept out, and to caption only what the file shows', () => {
  expect(WALK_SYSTEM_PROMPT).toMatch(/no sed, tail, head or grep on its output[^\n]*secrets only through environment variables[^\n]*caption says only what the file shows/)
})

test('castProblems passes a live recording of a plain command and lists each fault of a faked one', () => {
  const live = '{"version":3}\n[0.5, "o", "Web port: "]\n[1.0, "o", "3111\\r\\n"]\n[0.2, "x", "0"]'
  expect(castProblems(live, 'cd ~/acme && expect setup.exp', [])).toEqual([])
  expect(castProblems(live, 'expect setup.exp 2>&1 > /dev/null', [])).toEqual([])
  expect(castProblems(live, null, [])).toEqual([])
  const faults = castProblems('{"version":3}\n[9, "o", "all"]', 'X=pw1234 run | head -5', [['X', 'pw1234']], '.walk-values')
  expect(faults.join('\n')).toMatch(/one chunk[\s\S]*through head[\s\S]*value of X from \.walk-values/)
})

test('castProblems refuses a full-screen program whose screens all arrived at once, and passes one that stayed up', () => {
  const esc = String.fromCharCode(27)
  const ev = (t: number, d: string) => JSON.stringify([t, 'o', d])
  const screens = (gap: number) => ['{"version":3}', ev(0.1, 'spawn ./acme monitor\r\n'), ev(20, `${esc}[?1049hREADING`),
    ...Array.from({ length: 30 }, (_, i) => ev(i % 10 === 0 ? gap : 0, `screen ${i}`)), ev(0, `${esc}[?1049l`), '[0.1, "x", "0"]'].join('\n')
  expect(castProblems(screens(0), 'orb -m vm bash -c "expect monitor.exp"', []).join('\n'))
    .toMatch(/full-screen program[^\n]*under a second[^\n]*terminal[^\n]*pause/)
  expect(castProblems(screens(2), 'orb -m vm bash -c "expect monitor.exp"', [])).toEqual([])
  // Version 2 casts carry absolute times, so the span is the difference, not the sum.
  const v2 = ['{"version":2}', ev(1, `${esc}[?1049h`), ev(1.2, 'a'), ev(1.3, 'b'), ev(1.4, `${esc}[?1049l`)].join('\n')
  expect(castProblems(v2, null, []).join('\n')).toMatch(/under a second/)
})

test('the reader is told the red pointer is the walk overlay, kept on purpose, and that cursor: false hides only Playwright markers', () => {
  expect(WALK_SYSTEM_PROMPT).toMatch(/red pointer[^\n]*cursor\.js[^\n]*on purpose[^\n]*cursor: false[^\n]*only[^\n]*Playwright/)
  expect(WALK_SYSTEM_PROMPT).toMatch(/never report[^\n]*(pointer|overlay)/i)
})

test('tips: the config keeps a list of tips, addTip appends one, and the reader is told them', () => {
  const base = fixture()
  expect(parseConfig(base).tips).toEqual([])
  expect(() => parseConfig(fixture({ tips: 'x' }))).toThrow(/tips/)
  const once = addTip(base, 'The installer can reach the registry.')
  const twice = addTip(once, 'Use a container.')
  expect(parseConfig(twice).tips).toEqual(['The installer can reach the registry.', 'Use a container.'])
  expect(twice).toMatch(/\n  "tips": \[\n/)
  expect(() => addTip(twice, '  ')).toThrow(/Usage: \/walk-doc tip/)
  expect(() => addTip(twice, 'Use a container.')).toThrow(/already/)
  expect(tipsNote([])).toBe('')
  expect(tipsNote(['a', 'b'])).toBe('Tips from the person who runs this walk:\n- a\n- b')
})

test('addTip keeps a quoted tip without its quotes, as a shell reads it, and keeps quotes inside the tip', () => {
  expect(parseConfig(addTip(fixture(), '"Set up the demo on a VM"')).tips).toEqual(['Set up the demo on a VM'])
  expect(parseConfig(addTip(fixture(), "'Set up the demo on a VM'")).tips).toEqual(['Set up the demo on a VM'])
  expect(parseConfig(addTip(fixture(), 'Say "yes" at the prompt')).tips).toEqual(['Say "yes" at the prompt'])
  expect(parseConfig(addTip(fixture(), '"yes" or "no"')).tips).toEqual(['"yes" or "no"'])
  expect(parseConfig(addTip(fixture(), '"Don\'t skip the VM"')).tips).toEqual(["Don't skip the VM"])
  expect(() => addTip(fixture(), '""')).toThrow(/Usage: \/walk-doc tip/)
})

test('parseConfig refuses each missing required key, naming the key, the file and an example value', () => {
  for (const key of REQUIRED_KEYS) {
    expect(() => parseConfig(fixtureWithout(key), '/repo/.walk-doc.json')).toThrow(new RegExp(`^${key} is missing in /repo/\\.walk-doc\\.json[^\\n]*for example "${key}": `))
  }
  expect(() => parseConfig(fixture({ media: '' }))).toThrow(/media is missing in \.walk-doc\.json[^\n]*for example "media": /)
  expect(() => parseConfig(fixture({ deny: 'src' }))).toThrow(/deny in \.walk-doc\.json must be a list[^\n]*for example "deny": \[/)
})

test('the optional keys default to project-neutral values, and a bad value is refused with an example', () => {
  const c = parseConfig(fixture())
  expect(c.tips).toEqual([])
  expect(c.persona).toBe('a competent developer who has never seen this project before')
  expect(c.valuesFile).toBeNull()
  expect(c.machines).toBeNull()
  expect(parseConfig(fixture({ persona: 'an SRE on Linux', valuesFile: '.walk-values', machines: MACHINES }))).toMatchObject({ persona: 'an SRE on Linux', valuesFile: '.walk-values', machines: MACHINES })
  expect(() => parseConfig(fixture({ persona: '' }))).toThrow(/persona in \.walk-doc\.json[^\n]*for example "persona": /)
  expect(() => parseConfig(fixture({ valuesFile: 3 }))).toThrow(/valuesFile in \.walk-doc\.json[^\n]*for example "valuesFile": /)
  expect(() => parseConfig(fixture({ machines: { guide: 'x', cleanup: 'y {prefix}' } }))).toThrow(/machines in \.walk-doc\.json[^\n]*for example "machines": /)
  expect(() => parseConfig(fixture({ machines: { guide: ['x'], cleanup: 'vm delete' } }))).toThrow(/machines\.cleanup[^\n]*\{prefix\}/)
})

test('the reader prompt is project-neutral: no machine tool, operating system or product is named', () => {
  expect(WALK_SYSTEM_PROMPT).not.toMatch(/OrbStack|\borb\b|\bMac\b|NovusLens|Novus|\blens\b|quick-start|docker ps/)
  expect(WALK_SYSTEM_PROMPT).toMatch(/On this computer never use sudo/)
  const plain = walkTask(run(), config)
  expect(plain).not.toMatch(/walk-r1-1|machine/i)
})

test('the project machines guide and the attempt machine name reach the reader task', () => {
  const task = walkTask(run({ attempt: 2 }), parseConfig(fixture({ machines: MACHINES })))
  expect(task).toContain(MACHINES.guide[0])
  expect(task).toContain('If you need a Linux machine or a container, name it walk-r1-2.')
  expect(task).toMatch(/Inside your own machine or container you may use sudo/)
})

test('the configured persona is the reader unless /walk-doc names one', () => {
  expect(walkTask(run({ persona: 'an SRE on Linux' }), config)).toContain('You are an SRE on Linux.')
})

test('the sudo denial names the machines route only when the project sets machines', () => {
  const r = run({ agentIds: ['w'] })
  const sudo = { tool: 'Bash', agentId: 'w', input: { command: 'sudo apt-get install x' } }
  const plain = guardCall(r, config, sudo)!
  expect(plain).toMatch(/sudo on this computer is denied[^\n]*report BLOCKED/)
  expect(plain).not.toMatch(/OrbStack|Mac|machine or container/)
  expect(guardCall(r, parseConfig(fixture({ machines: MACHINES })), sudo)).toMatch(/your own machine or container/)
})

test('the configured issue command and media notes reach the main agent', () => {
  expect(recordReport(run(), report, 1, config.issues).mainMessage).toContain(`file an issue with: ${config.issues}`)
  const media = '/home/n/.walk-doc/r1/attempt-1/media'
  const sent = recordMedia(run({ agentId: 'a1', agentIds: ['a1'] }), { step: 's', file: `${media}/1.jpg`, mode: 'INSERT', caption: 'c' }, config, 1, '/p')
  expect(sent.mainMessage).toContain(config.media)
})

test('a key that walk-doc does not know is refused with the file and the known keys, so a typo is not a silent default', () => {
  expect(() => parseConfig(fixture({ machine: MACHINES }))).toThrow(/machine is not a key of \.walk-doc\.json\. The keys are devCommand, .*machines/)
  expect(() => parseConfig(fixture({ valuefile: '.env.walk-docs' }))).toThrow(/valuefile is not a key/)
})

test('a config that is not a JSON object is refused as such, not as a missing key', () => {
  for (const text of ['[]', 'null', '"x"']) expect(() => parseConfig(text)).toThrow(/\.walk-doc\.json must be a JSON object/)
})
