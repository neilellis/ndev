import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import { answerText, chainOf, hasAnswer, labelsOf } from './interview-model'
import type { DraftAnswer, InterviewOption, InterviewQuestion, InterviewRound, RoundEnd } from './interview-model'

// The interview pane: one question at a time, then a review. It holds the answers in this atom. The
// interview tool holds its call open, saves the drafts, and reads the outcome from here.
export const PANE = 'interview'
const TITLE = 'Interview'
const MARKDOWN_MOST = 10_000

// A question from an earlier round, for the recap above a follow-up.
export type EarlierQuestion = { id: string; question: InterviewQuestion; answer: string; notes?: string }
export type PaneCall = {
  id: string
  issue: number
  round: InterviewRound
  answers: Record<string, DraftAnswer>
  index: number
  stage: 'question' | 'review'
  earlier: EarlierQuestion[]
  problem?: string
  outcome?: RoundEnd
}
export type InterviewView = { call?: PaneCall }

const interviewView = atom({ plugin: 'ndev', key: 'interviewView' } as const, {} as InterviewView, { shape: 'interview-view-1' })

// A hook that holds open reads an atom as it stood when the hook began, so the interview tool cannot
// see a press through the atom. The call lives here, and the atom only makes the pane draw again. A
// reload empties this, and the hold ends with it, so the pane then says that no interview is open.
let open: PaneCall | undefined

async function publish($: EngineInterface, call: PaneCall | undefined) {
  open = call
  await update($, interviewView, () => (call ? { call } : {}))
}

const edit = async ($: EngineInterface, change: (call: PaneCall) => PaneCall) => {
  if (open && !open.outcome) await publish($, change(open))
}

const setAnswer = ($: EngineInterface, id: string, change: (a: DraftAnswer) => DraftAnswer) =>
  edit($, call => ({ ...call, problem: undefined, answers: { ...call.answers, [id]: { ...change(call.answers[id]!), touched: true } } }))

const pick = ($: EngineInterface, q: InterviewQuestion, value: string) =>
  setAnswer($, q.id, a => {
    if (!q.multiSelect) return { ...a, selected: [value], other: '' }
    return { ...a, selected: a.selected.includes(value) ? a.selected.filter(x => x !== value) : [...a.selected, value] }
  })

// Next makes the answer the human's, because the human has seen it.
const forward = ($: EngineInterface) =>
  edit($, call => {
    const q = call.round.questions[call.index]!
    const a = call.answers[q.id]!
    if (!hasAnswer(a)) return { ...call, problem: `"${q.header}" needs an answer, or use Trust Me Bro.` }
    const answers = { ...call.answers, [q.id]: { ...a, touched: true } }
    const isLast = call.index + 1 >= call.round.questions.length
    return { ...call, answers, problem: undefined, index: isLast ? call.index : call.index + 1, stage: isLast ? 'review' : 'question' }
  })

const end = ($: EngineInterface, outcome: RoundEnd) => edit($, call => ({ ...call, outcome }))

const optionsText = (q: InterviewQuestion) =>
  (q.options as InterviewOption[]).map(o => [`**${o.label}**${o.recommended ? ' (recommended)' : ''}`, o.description, o.preview].filter(Boolean).join('\n\n')).join('\n\n---\n\n')

const fit = (text: string) => (text.length > MARKDOWN_MOST ? `${text.slice(0, MARKDOWN_MOST - 40)}\n\n(cut to fit the pane)` : text)

export function interviewPane(on: On) {
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    await read($, interviewView)
    const call = open
    if (!call) return <Text color="subtle">No interview now. The agent opens this pane when it asks.</Text>
    if (e.surface === 'mobile') return <Text>#{call.issue} has an interview. Answer it in the terminal: this screen cannot show the answer fields.</Text>
    if (call.outcome) return <Text color="success">The answers went to the agent.</Text>
    const { Input, Select, Markdown } = $.ui.resolve(e) as unknown as Record<string, (props: Record<string, unknown>) => never>

    const asked = call.round.questions
    const everything = [...call.earlier.map(q => q.question), ...asked]
    const labels = labelsOf(everything)
    // What a follow-up follows: the chain, the parent question and its answer as it stands.
    const followUp = (q: InterviewQuestion, recapKey: string) => {
      const parent = q.followUpTo ? everything.find(x => x.id === q.followUpTo) : undefined
      if (!parent) return null
      const inRound = call.answers[parent.id]
      const before = call.earlier.find(x => x.id === parent.id)
      const text = inRound ? answerText(inRound) : (before?.answer ?? 'no answer')
      const notes = (inRound ? inRound.notes : before?.notes) ?? ''
      return (
        <Box flexDirection="column">
          <Text color="warning">{`Follow-up to ${labels[parent.id]} · ${chainOf(q.id, everything).map(id => labels[id]).join(' › ')}`}</Text>
          <Box borderStyle="round" paddingX={1}>
            <Markdown key={recapKey} text={fit(`${parent.question}\n\n**Answer:** ${text}${notes.trim() ? `\n\n**Notes:** ${notes.trim()}` : ''}`)} />
          </Box>
        </Box>
      )
    }
    const buttons = (first: unknown) => (
      <Box gap={2} flexWrap="wrap">
        {first as never}
        <Button key="trust" label="Trust Me Bro" onPress={() => { void end($, 'trustMeBro') }} />
        <Button key="close" label="Close for now" plain onPress={() => { void end($, 'dismissed') }} />
      </Box>
    )

    if (call.stage === 'review') {
      const before = call.earlier.map(x => labels[x.id]!)
      const beforeText = before.length === 1 ? `${before[0]} was` : `${before[0]} to ${before[before.length - 1]} were`
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text weight="bold" color="claude">{call.round.title}</Text>
            <Text color="subtle">#{call.issue}: check your {asked.length === 1 ? 'answer' : `${asked.length} answers`}, then send</Text>
            {before.length > 0 && <Text color="subtle">{`${beforeText} answered in an earlier round.`}</Text>}
          </Box>
          {asked.map((q, i) => {
            const a = call.answers[q.id]!
            return (
              <Box key={`row-${q.id}`} flexDirection="column" gap={1} borderStyle="round" borderColor="subtle" paddingX={1}>
                <Box justifyContent="space-between" gap={2}>
                  <Text weight="bold" color="claude">{`${labels[q.id]} ${q.header}`}</Text>
                  <Button key={`edit-${q.id}`} label="Edit" onPress={() => { void edit($, c => ({ ...c, stage: 'question', index: i })) }} />
                </Box>
                {followUp(q, `recap-${q.id}`)}
                <Markdown key={`question-${q.id}`} text={fit(q.question)} />
                <Box flexDirection="column">
                  <Text color="success" weight="bold">{`✔ ${answerText(a)}`}</Text>
                  {a.notes.trim() ? <Text color="subtle">{`Notes: ${a.notes.trim()}`}</Text> : null}
                </Box>
              </Box>
            )
          })}
          {buttons(<Button key="submit" label="Send the answers" variant="primary" autoFocus onPress={() => { void end($, 'submitted') }} />)}
        </Box>
      )
    }

    const q = asked[call.index]!
    const a = call.answers[q.id]!
    const chain = chainOf(q.id, everything)
    return (
      <Box flexDirection="column" gap={1}>
        <Text weight="bold" color="claude">{call.round.title}</Text>
        <Text color="subtle">#{call.issue}, question {call.index + 1} of {asked.length} in this round</Text>
        {call.index === 0 && call.round.intro && <Markdown key="intro" text={fit(call.round.intro)} />}
        {followUp(q, 'recap')}
        <Box flexDirection="column" gap={1} paddingLeft={(chain.length - 1) * 2}>
          <Text weight="bold">{labels[q.id]} {q.header}</Text>
          <Markdown key="question" text={fit(q.question)} />
          {q.context && <Markdown key="context" text={fit(q.context)} />}
          {q.options && <Markdown key="options" text={fit(optionsText(q))} />}
          {q.options && (
            <Select
              key={`pick-${q.id}`}
              label={q.multiSelect ? 'Pick each that applies' : 'Pick one'}
              autoFocus
              value={q.multiSelect ? undefined : a.selected[0]}
              options={q.options.map(o => ({ value: o.label, label: q.multiSelect ? `${a.selected.includes(o.label) ? '☑' : '☐'} ${o.label}` : o.label }))}
              onSelect={(value: string) => { void pick($, q, value) }}
            />
          )}
          <Input
            key={`other-${q.id}`}
            label={q.options ? 'Other answer' : 'Your answer'}
            value={a.other}
            {...(q.options ? {} : { autoFocus: true as const })}
            onInput={(value: string) => { void setAnswer($, q.id, x => ({ ...x, other: value, selected: q.multiSelect || !value.trim() ? x.selected : [] })) }}
            onSubmit={() => { void forward($) }}
          />
          <Input
            key={`notes-${q.id}`}
            label="Notes"
            value={a.notes}
            onInput={(value: string) => { void setAnswer($, q.id, x => ({ ...x, notes: value })) }}
            onSubmit={() => { void forward($) }}
          />
        </Box>
        {call.problem && <Text color="error">{call.problem}</Text>}
        {buttons(
          <Box gap={2}>
            {call.index > 0 && <Button key="back" label="Back" plain onPress={() => { void edit($, c => ({ ...c, index: c.index - 1, problem: undefined })) }} />}
            <Button key="next" label={call.index + 1 < asked.length ? 'Next' : 'Review'} onPress={() => { void forward($) }} />
          </Box>,
        )}
      </Box>
    )
  })

  // The close mark ends the round as Close for now does. The tool's own close finds an outcome there.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await end($, 'dismissed')
    return next(e)
  })
}

export async function showInterview($: EngineInterface, call: PaneCall) {
  await publish($, call)
}
export async function clearInterview($: EngineInterface) {
  await publish($, undefined)
}
export function interviewCall(): PaneCall | undefined {
  return open
}
export function openInterviewPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: TITLE, focus: true })
}
export function closeInterviewPane($: EngineInterface) {
  return $.ui.close({ id: PANE })
}
