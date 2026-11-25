// The layout of the /view pane, with no drawing: each function answers rows of text spans and links.
// A row is what `top` prints: fixed columns, dim labels, and colour only where it says something.
// The drawing is in hooks/view.tsx.
import type { ViewServer, ViewStack, ViewTree, WorkflowView } from '../types'
import { checksUrl, commitUrl, fileUrl, issueUrl, pullUrl, repoUrl, treeUrl } from './links'
import { shownFull, span } from './workflow/live'
import type { InterviewFile, InterviewQuestion, RecordedRound } from './workflow/interview-model'
import type { FlowMark } from './workflow/machine'
import type { Workflow } from './workflow/tools'

export type Tone = 'success' | 'claude' | 'warning' | 'error' | 'subtle'
export type Seg = { text: string; href?: string; color?: Tone; bold?: boolean; dim?: boolean }
export type Row = Seg[]

const LABEL_WIDTH = 15
const BAR_WIDTH = 16
const RULE_WIDTH = 72
const WORKTREE_FILE = '.neil-dev.worktree.json'

// A link's address must be printable ASCII, up to 2048 characters. Anything else stays as text.
const link = (text: string, href: string): Seg => (href.length <= 2048 && /^[\x20-\x7e]+$/.test(href) ? { text, href } : { text })
// A path that cannot be encoded as an address stays as text.
function fileLink(text: string, path: string): Seg {
  try {
    return link(text, fileUrl(path))
  } catch {
    return { text }
  }
}
// The address of a URL that shownFull masked: its secret is not in the address, so the link opens the page.
const unmasked = (url: string) => url.replace(/\?•••.*$/, '').replace('://•••@', '://')
const dim = (text: string): Seg => ({ text, color: 'subtle' })
const ago = (now: number, at: number) => `${span(now - at)} ago`
const line = (label: string, ...value: Seg[]): Row => [dim(`  ${label.padEnd(LABEL_WIDTH)}`), ...value]
const between = <T>(items: T[][], gap: T): T[] => items.flatMap((item, i) => (i ? [gap, ...item] : item))

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The text as spans, with each URL, each #n and each path under the worktree as a link.
export function linked(text: string, where: { repo?: string; root?: string }): Seg[] {
  const parts = [String.raw`https?://[^\s<>"'\x60]+`, ...(where.repo ? [String.raw`#\d+`] : []), ...(where.root ? [`${escaped(where.root)}(?:/[^\\s<>"'\\x60]*)?(?=$|[\\s<>"'\\x60,;:!?)\\]]|\\.(?:$|\\s))`] : [])]
  const find = new RegExp(parts.join('|'), 'g')
  const out: Seg[] = []
  let from = 0
  for (const found of text.matchAll(find)) {
    const match = found[0].replace(/[.,;:!?)\]]+$/, '')
    if (found.index > from) out.push({ text: text.slice(from, found.index) })
    if (match.startsWith('/')) out.push(fileLink(match, match.replace(/\/$/, '') || '/'))
    else out.push(link(match, match.startsWith('#') ? issueUrl(where.repo ?? '', Number(match.slice(1))) : unmasked(match)))
    from = found.index + match.length
  }
  if (from < text.length) out.push({ text: text.slice(from) })
  return out
}

const fileSeg = (root: string, path: string, label = path): Seg => fileLink(label, path.startsWith('/') ? path : `${root}/${path}`)
const issueSeg = (repo: string | undefined, n: number): Seg => (repo ? link(`#${n}`, issueUrl(repo, n)) : { text: `#${n}` })
const prSeg = (repo: string | undefined, n: number): Seg => (repo ? link(`#${n}`, pullUrl(repo, n)) : { text: `#${n}` })
const shaSeg = (repo: string | undefined, sha: string): Seg => (repo ? link(sha.slice(0, 8), commitUrl(repo, sha)) : { text: sha.slice(0, 8) })
const refSeg = (repo: string | undefined, ref: string): Seg => (repo ? link(ref, treeUrl(repo, ref)) : { text: ref })

export function ruleRow(...title: Seg[]): Row {
  const width = title.reduce((sum, seg) => sum + seg.text.length, 0)
  return [dim('── '), ...title, dim(` ${'─'.repeat(Math.max(3, RULE_WIDTH - width))}`)]
}

// What the top of the pane says at a look.
export function headerRow(tree: ViewTree | undefined, now: number): Row {
  const clock = now ? new Date(now).toTimeString().slice(0, 8) : '--:--:--'
  const flows = tree?.workflows?.length ?? 0
  const up = tree?.servers.filter(s => s.live).length ?? 0
  const down = (tree?.servers.length ?? 0) - up
  const parts = [`${flows} workflow${flows === 1 ? '' : 's'}`, ...(tree?.servers.length ? [`${up} server${up === 1 ? '' : 's'} up, ${down} down`] : []), ...(tree?.stacks.length ? [`${tree.stacks.filter(s => s.live).length} of ${tree.stacks.length} stacks up`] : [])]
  return [{ text: 'ndev view', color: 'claude', bold: true }, dim(`  ${clock}  ·  ${parts.join('  ·  ')}`)]
}

// Each workflow that needs the human, before anything else.
export function attentionRows(tree: ViewTree): Row[] {
  return (tree.workflows ?? []).filter(w => w.state === 'blocked').map(w => {
    const who = w.pr ? `PR #${w.pr}` : `#${w.issue}`
    return [{ text: `▲ ${who} needs you: `, color: 'warning', bold: true }, ...linked(w.blocked ?? 'see the record below', { repo: w.repo })]
  })
}

const urgency = (w: WorkflowView) => (w.state === 'blocked' ? 0 : w.state === 'wait' ? 1 : w.state === 'done' ? 3 : 2)
export const byUrgency = (a: WorkflowView, b: WorkflowView) => urgency(a) - urgency(b)

// How far the flow has come, and how long it has stood here.
export function progressRow(picture: { steps: { state: string; mark: FlowMark }[] }, w: WorkflowView, now: number): Row {
  const done = picture.steps.filter(step => step.mark === 'passed').length
  const total = picture.steps.length
  const filled = Math.round((done / Math.max(1, total)) * BAR_WIDTH)
  const stood = w.since && now ? `  ${w.state} for ${span(now - w.since)}` : ''
  return [{ text: '█'.repeat(filled), color: 'success' }, dim('░'.repeat(BAR_WIDTH - filled)), dim(` ${done}/${total}${stood}`)]
}

// Every other field of a record: shown masked, in full, so a new field needs no change to the pane.
export const detailsRows = (fields: Record<string, unknown>): Record<string, string> => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, shownFull(key, value)]))

// What a failed stop recorded beside its output.
function stopRows(s: ViewServer | ViewStack): Row[] {
  const stop = s.lastStop
  if (!stop) return []
  const facts = [stop.exitCode !== undefined ? `exit ${stop.exitCode}` : '', stop.at ?? '', stop.command ? shownFull('command', stop.command) : ''].filter(Boolean)
  return [
    ...(facts.length ? [[dim(`    ${facts.join(' · ')}`)]] : []),
    ...(stop.repair ? [[dim(`    ${'repair'.padEnd(LABEL_WIDTH)}`), { text: shownFull('repair', stop.repair) }]] : []),
  ]
}

export function serverRows(s: ViewServer, now: number): Row[] {
  const started = s.startedAt && now ? [dim(` · started ${ago(now, s.startedAt)}`)] : []
  const cwd = s.cwd?.startsWith('/') ? [dim(' · '), fileLink(s.cwd, s.cwd)] : []
  return [
    [dim(`    pid ${s.pid}`), ...started, ...cwd],
    [dim(`    ${shownFull('command', s.command)}`)],
    ...Object.entries(s.details ?? {}).map(([key, value]) => [dim(`    ${key.padEnd(LABEL_WIDTH)}`), { text: value }]),
    ...stopRows(s),
  ]
}

export function stackRows(s: ViewStack): Row[] {
  return [
    ...(s.workdir?.startsWith('/') ? [[dim('    '), fileLink(s.workdir, s.workdir)]] : []),
    ...Object.entries(s.details ?? {}).map(([key, value]) => [dim(`    ${key.padEnd(LABEL_WIDTH)}`), { text: value }]),
    ...stopRows(s),
  ]
}

// What the worktree file holds beside the resources: its version, its settings and the lead issue of each PR.
export function worktreeRows(tree: ViewTree): Row[] {
  const held = tree.worktreeFile
  if (!held) return []
  const repo = [...(tree.held?.issues ?? []), ...(tree.held?.prs ?? [])][0]?.repo
  const present = tree.files.some(f => f.name === WORKTREE_FILE && f.present)
  return [
    ruleRow(present ? fileSeg(tree.path, WORKTREE_FILE, WORKTREE_FILE) : { text: WORKTREE_FILE }),
    ...(held.version !== undefined ? [line('version', { text: String(held.version) })] : []),
    ...Object.entries(held.settings ?? {}).map(([key, value]) => line(key, { text: shownFull(key, value) })),
    ...Object.entries(held.leads ?? {}).map(([pr, lead]) => [
      dim('  '), { text: 'PR ' }, prSeg(repo, Number(pr)), { text: '  lead issue ' }, issueSeg(repo, lead), { text: '  ' }, fileSeg(tree.path, `.neil-dev.issue-${lead}.json`, `.neil-dev.issue-${lead}.json`),
    ]),
  ]
}

// The fields that have their own rows in recordRows. All the others show as text.
const OWN_ROWS = new Set([
  'rev', 'issue', 'pr', 'issues', 'root', 'repo', 'base', 'branch', 'direct', 'prs', 'shortName', 'orca', 'doneMessage', 'state', 'previous', 'owner', 'lastSession', 'releasedAt', 'evidence',
  'off', 'attempts', 'nudges', 'followUps', 'followUpOf', 'migrations', 'blocked', 'mode', 'steering', 'history', 'doneWaitsFor', 'live', 'liveUnread', 'hooks', 'reviewSpec', 'reviewCopy', 'changeTypes', 'webFiles', 'typesUnread', 'feedbackAt',
])

type RecordPlace = { root: string; now: number; lead?: number; isPresent: (name: string) => boolean }

// A record that the rows below cannot draw: it costs its own rows, not the pane, and its text still shows.
export function undrawnRows(name: string, wf: unknown, error: unknown): Row[] {
  return [
    [{ text: `${name} could not be drawn: ${String(error).slice(0, 200)}. Repair: fix that field in the file. The record as the file holds it:`, color: 'error' }],
    [dim(`  ${shownFull('record', JSON.stringify(wf))}`)],
  ]
}

// The interview in an issue file: every round, question and answer. A file with no workflow has one too.
export function interviewRows(file: InterviewFile, place: { root: string; now?: number; repo?: string; pr?: number }): Row[] {
  const { root, now, repo, pr } = place
  const text = (key: string, value: unknown) => linked(shownFull(key, value), { repo, root })
  const when = (at: number) => (now ? ago(now, at) : '')
  const name = `.neil-dev.issue-${file.issue}.json`
  const comment = (label: string, href: string | undefined, id: number): Seg => (href ? link(label, `${href}#issuecomment-${id}`) : { text: `${label} (id ${id})` })
  const { issue: onIssue, pr: onPr } = file.commentIds ?? {}
  const comments = [
    ...(onIssue ? [comment(`comment on #${file.issue}`, repo && issueUrl(repo, file.issue), onIssue)] : []),
    ...(onPr ? [comment(pr ? `comment on PR #${pr}` : 'comment on the PR', repo && pr ? pullUrl(repo, pr) : undefined, onPr)] : []),
  ]
  const follows = file.startedByFollowUp
  const drafts = Object.entries(file.draft ?? {})
  const question = (q: InterviewQuestion, round: RecordedRound): Row[] => {
    const answer = round.answers.find(a => a.id === q.id)
    const said = answer && [...answer.selected, ...(answer.other ? [answer.other] : [])].join(', ')
    return [
      [dim(`    ${q.id}  `), ...text('header', q.header).map(seg => ({ ...seg, bold: true })), dim(q.multiSelect ? '  multi-select  ' : '  '), ...text('question', q.question)],
      ...(q.followUpTo ? [[dim(`      follows ${q.followUpTo}`)]] : []),
      ...(q.context ? [[dim('      '), ...text('context', q.context)]] : []),
      ...(q.options ?? []).flatMap((o): Row[] => [
        [dim(`      ${o.recommended ? '★' : '·'} `), ...text('option', o.label), ...(o.description ? [dim('  '), ...text('description', o.description)] : [])],
        ...(o.preview ? [[dim('        '), ...text('preview', o.preview)]] : []),
      ]),
      ...(q.suggested ? [[dim('      suggested  '), ...text('suggested', q.suggested)]] : []),
      ...(answer
        ? [[dim('      answer  '), ...text('answer', said || '(none)'), dim(`  ${answer.source}`)], ...(answer.notes ? [[dim('      notes  '), ...text('notes', answer.notes)]] : [])]
        : [[dim('      no answer')]]),
    ]
  }
  return [
    [{ text: `interview of #${file.issue}`, bold: true }, dim('  '), fileSeg(root, name, name)],
    ...(follows ? [line('started by', issueSeg(repo, follows.of), dim(`  followUp ${when(follows.at)}`))] : []),
    ...(file.posted !== undefined ? [line('posted', { text: file.posted ? 'yes' : 'not yet' })] : []),
    ...(comments.length ? [line('comments', ...comments.flatMap((seg, i) => (i ? [dim('  '), seg] : [seg])))] : []),
    ...(file.closed ? [line('closed', { text: `${when(file.closed.at)}${file.closed.asked ? '' : ', with no questions'}` })] : []),
    ...(drafts.length ? [line('draft', { text: `${drafts.length} draft answer${drafts.length === 1 ? '' : 's'}` })] : []),
    ...drafts.map(([id, d]): Row => [dim(`    ${id}  `), ...text('draft', [...d.selected, d.other, d.notes].filter(Boolean).join(', ') || '(empty)'), dim(d.touched ? '' : '  not touched')]),
    ...file.rounds.flatMap((round): Row[] => [
      line('round', ...text('title', round.title).map(seg => ({ ...seg, bold: true })), dim(`  ${when(round.at)}${round.dismissed ? '  closed by the human' : ''}${round.trustMeBro ? '  Trust Me Bro' : ''}`)),
      ...(round.intro ? [[dim('    '), ...text('intro', round.intro)]] : []),
      ...round.questions.flatMap(q => question(q, round)),
      // An answer whose question is not in its round is still what the human said.
      ...round.answers.filter(a => !round.questions.some(q => q.id === a.id)).map((a): Row => [dim(`    ${a.id}  no such question  `), ...text('answer', [...a.selected, a.other, a.notes].filter(Boolean).join(', ') || '(none)'), dim(`  ${a.source}`)]),
    ]),
    ...(file.rounds.length ? [] : [line('rounds', dim('none yet'))]),
  ]
}

// One record, every field. Its title names the file that holds it.
export function recordRows(wf: Workflow, place: RecordPlace): Row[] {
  const { root, now } = place
  const repo = wf.repo
  const where = { repo, root }
  const text = (key: string, value: unknown) => linked(shownFull(key, value), where)
  const name = `.neil-dev.issue-${place.lead ?? wf.issue}.json`
  const isOld = !place.isPresent(name)
  const title: Seg[] = [
    { text: wf.pr ? `PR #${wf.pr}` : `issue #${wf.issue}`, bold: true },
    ...(wf.pr ? [dim(`  lead #${place.lead ?? wf.issue}`)] : []),
    dim('  '),
    ...(isOld ? [fileSeg(root, WORKTREE_FILE, WORKTREE_FILE), dim('  (old keys: the next save moves it)')] : [fileSeg(root, name, name)]),
  ]
  const time = (key: string, at: number | undefined) => (at && now ? [line(key, { text: ago(now, at) })] : [])
  const answer = (label: string, value: { agentId?: string; answer?: string; result?: string; failed?: string; firedAt?: number } | undefined) => {
    if (!value) return []
    const facts = [...(value.firedAt && now ? [`fired ${ago(now, value.firedAt)}`] : []), ...(value.agentId ? [`agent ${value.agentId}`] : [])].join(' · ')
    return [
      line(label, dim(facts || 'started')),
      ...[['result', value.result], ['answer', value.answer], ['failed', value.failed]].flatMap(([key, said]) => (said ? [[dim(`    ${(key as string).padEnd(LABEL_WIDTH - 2)}`), ...text(key as string, said)]] : [])),
    ]
  }
  const evidence = Object.entries(wf.evidence ?? {}) as [string, { sha: string; text: string; byHuman?: boolean }][]
  const history = [...(wf.history ?? [])].reverse()
  const toolWidth = Math.max(0, ...history.map(h => h.tool.length))
  const atWidth = Math.max(0, ...history.map(h => (now ? ago(now, h.at).length : 0)))
  return [
    ruleRow(...title),
    line('state', { text: wf.previous ? `${wf.state} (was ${wf.previous})` : wf.state, bold: true }),
    ...(wf.pr ? [line('PR', prSeg(repo, wf.pr))] : []),
    ...(wf.issues ? [line('issues', ...between(wf.issues.map(n => [issueSeg(repo, n)]), { text: ' ' }))] : [line('issue', issueSeg(repo, wf.issue))]),
    ...(wf.prs?.length ? [line('PRs', ...between(wf.prs.map(n => [prSeg(repo, n), { text: ' ' }, repo ? link(`checks #${n}`, checksUrl(repo, n)) : { text: '' }]), { text: '  ' }))] : []),
    ...(repo ? [line('repo', link(repo, repoUrl(repo)))] : []),
    ...(wf.branch ? [line('branch', refSeg(repo, wf.branch))] : []),
    ...(wf.base ? [line('base', refSeg(repo, wf.base))] : []),
    ...(wf.direct ? [line('direct', { text: 'commits to the base branch' })] : []),
    ...(wf.shortName ? [line('shortName', { text: wf.shortName })] : []),
    ...(wf.root?.startsWith('/') ? [line('root', fileSeg(root, wf.root))] : []),
    ...(wf.rev !== undefined ? [line('rev', { text: String(wf.rev) })] : []),
    ...(wf.mode ? [line('mode', { text: wf.mode })] : []),
    ...(wf.steering ? [line('steering', { text: wf.steering })] : []),
    ...(wf.owner ? [line('owner', { text: `session ${wf.owner.session}` }, dim(wf.owner.at && now ? `  ${ago(now, wf.owner.at)}` : ''))] : []),
    ...(wf.lastSession ? [line('lastSession', { text: wf.lastSession })] : []),
    ...time('releasedAt', wf.releasedAt),
    ...(wf.blocked ? [line('blocked', { text: '', color: 'warning' }, ...text('message', wf.blocked.message), dim(`  ${[wf.blocked.at && now ? ago(now, wf.blocked.at) : '', wf.blocked.group ? `group ${wf.blocked.group}` : '', wf.blocked.pid ? `pid ${wf.blocked.pid}` : ''].filter(Boolean).join(' · ')}`))] : []),
    ...(wf.off ? [line('off', ...text('reason', wf.off.reason), dim(wf.off.at && now ? `  ${ago(now, wf.off.at)}` : ''))] : []),
    ...(wf.doneMessage ? [line('doneMessage', ...text('doneMessage', wf.doneMessage))] : []),
    ...(wf.orca ? [line('orca', { text: shownFull('orca', `${wf.orca.name ?? `#${wf.orca.issue}`} · ${wf.orca.status} · ${wf.orca.comment}${wf.orca.attention ? ' · needs attention' : ''}`) })] : []),
    ...evidence.map(([kind, proof]) => line(`${kind} proof`, shaSeg(repo, proof.sha), { text: '  ' }, ...text(kind, proof.text), ...(proof.byHuman ? [dim('  by the human')] : []))),
    ...(wf.doneWaitsFor ? [line('doneWaitsFor', shaSeg(repo, wf.doneWaitsFor))] : []),
    ...(wf.attempts !== undefined ? [line('attempts', { text: String(wf.attempts) })] : []),
    ...(wf.nudges ? [line('nudges', { text: shownFull('nudges', `${wf.nudges.count}${wf.nudges.fingerprint ? ` · ${wf.nudges.fingerprint}` : ''}`) })] : []),
    ...(wf.followUpOf ? [line('followUpOf', issueSeg(repo, wf.followUpOf))] : []),
    ...(wf.followUps ?? []).map(f => line('followUp', issueSeg(repo, f.issue), { text: `  ${f.mode}  ${shownFull('title', f.title)}` }, ...(f.worktree?.startsWith('/') ? [{ text: '  ' }, fileSeg(root, f.worktree)] : []), ...(f.issues?.length ? [{ text: '  carries ' }, ...between(f.issues.map(n => [issueSeg(repo, n)]), { text: ' ' })] : []), ...(f.dispatchId ? [dim(`  dispatch ${f.dispatchId}`)] : []), dim(`  ${f.hash}`))),
    ...(wf.migrations ?? []).map(m => line('migration', { text: `${m.name}  ` }, fileSeg(root, m.path))),
    ...(wf.changeTypes?.length ? [line('changeTypes', { text: wf.changeTypes.join(', ') })] : []),
    ...(wf.webFiles ?? []).map(path => line('webFile', fileSeg(root, path))),
    ...(wf.typesUnread ? [line('typesUnread', { text: shownFull('typesUnread', wf.typesUnread), color: 'error' })] : []),
    ...(wf.liveUnread ? [line('liveUnread', { text: shownFull('liveUnread', wf.liveUnread), color: 'error' })] : []),
    ...(wf.live ? [line('live saved', { text: `${wf.live.at && now ? ago(now, wf.live.at) : 'at the last save'} · ${wf.live.calls?.length ?? 0} calls` })] : []),
    ...time('feedbackAt', wf.feedbackAt),
    ...Object.entries(wf.hooks ?? {}).flatMap(([hook, value]) => answer(`hook ${hook}`, value)),
    ...answer('reviewSpec', wf.reviewSpec),
    ...answer('reviewCopy', wf.reviewCopy),
    ...Object.entries(wf).filter(([key, value]) => !OWN_ROWS.has(key) && value !== undefined && value !== null).map(([key, value]) => line(key, ...text(key, value))),
    ...(history.length ? [[dim('  history')]] : []),
    ...history.map(h => [dim(`    ${(now ? ago(now, h.at) : '').padEnd(atWidth)}  `), { text: `${h.tool.padEnd(toolWidth)}  ${h.from ? `${h.from} → ` : ''}${h.to}` }]),
  ]
}
