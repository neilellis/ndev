// The interview's data, with no side effects: the check of a round, the limits, the labels, the
// answers and the comment. tools.ts does the work, and interview.tsx draws one round in its pane.
import type { Mode } from '../../types'

export const LIGHT_QUESTIONS = 5
export const LIGHT_FOLLOW_UPS = 5
// GitHub refuses a comment over 65536 characters. The file keeps what the comment cuts.
export const COMMENT_LIMIT = 60_000

export type InterviewOption = { label: string; description?: string; preview?: string; recommended?: boolean }
export type InterviewQuestion = {
  id: string
  header: string
  question: string
  context?: string
  multiSelect?: boolean
  followUpTo?: string
  options?: InterviewOption[]
  suggested?: string
}
export type InterviewRound = { title: string; intro?: string; questions: InterviewQuestion[] }
export type AnswerSource = 'human' | 'recommended'
export type InterviewAnswer = { id: string; selected: string[]; other?: string; notes?: string; source: AnswerSource }
export type RecordedRound = InterviewRound & { answers: InterviewAnswer[]; at: number; dismissed?: true; trustMeBro?: true }
// What the pane holds for a question while the human works. touched: the human has made it theirs.
export type DraftAnswer = { selected: string[]; other: string; notes: string; touched: boolean }
export type RoundEnd = 'submitted' | 'dismissed' | 'trustMeBro'
export type InterviewFile = {
  version: 1
  issue: number
  rounds: RecordedRound[]
  draft?: Record<string, DraftAnswer>
  commentIds?: { issue?: number; pr?: number }
  posted?: boolean
  closed?: { at: number; asked: boolean }
  startedByFollowUp?: { of: number; at: number }
}

export const interviewFileName = (issue: number) => `.neil-dev.issue-${issue}.json`
export const INTERVIEW_FILE_PATTERN = '.neil-dev.issue-*.json'
export const emptyFile = (issue: number): InterviewFile => ({ version: 1, issue, rounds: [] })
export const commentMarker = (issue: number) => `<!-- ndev:interview issue=${issue} -->`

const isText = (x: unknown): x is string => typeof x === 'string' && x.trim() !== ''
const allQuestions = (file: InterviewFile) => file.rounds.flatMap(r => r.questions)

// Checks one round against the rounds before it, and lists every problem at once. Takes an object or
// its JSON, because a model can send either.
export function parseRound(raw: unknown, file: InterviewFile, mode: Mode): { round: InterviewRound } | { problems: string[] } {
  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch (error) {
      return { problems: [`interviewJson is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`] }
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { problems: [`interviewJson must be an object with title and questions, and it is ${JSON.stringify(raw)?.slice(0, 80)}.`] }
  const round = value as InterviewRound
  const problems: string[] = []
  if (file.rounds.some(r => r.trustMeBro)) problems.push('The human chose Trust Me Bro, so the interview takes no more questions. State each remaining decision as an assumption, then call interview with no arguments.')
  if (!isText(round.title)) problems.push('title must be a text.')
  if (!Array.isArray(round.questions) || !round.questions.length) return { problems: [...problems, 'questions must be a list with at least one question.'] }
  const before = allQuestions(file)
  const seen = new Set(before.map(q => q.id))
  round.questions.forEach((q, i) => {
    const name = isText(q?.id) ? `Question "${q.id}"` : `Question ${i + 1}`
    if (!isText(q?.id)) problems.push(`${name} needs an id.`)
    else if (seen.has(q.id)) problems.push(`${name}: the id is already used in this interview. Ids are unique across all rounds of an issue.`)
    if (!isText(q?.header)) problems.push(`${name} needs a header, a short label.`)
    if (!isText(q?.question)) problems.push(`${name} needs a question.`)
    if (q?.followUpTo !== undefined && !seen.has(q.followUpTo)) problems.push(`${name}: followUpTo "${String(q.followUpTo)}" names no earlier question.`)
    if (q?.options === undefined) {
      if (!isText(q?.suggested)) problems.push(`${name} has no options, so it needs a suggested answer in suggested. The human must be able to accept your recommendation.`)
    } else if (!Array.isArray(q.options) || !q.options.length) {
      problems.push(`${name}: options must be a list with at least one option, or leave it out for a free-text question.`)
    } else {
      const labels = q.options.map(o => o?.label)
      if (!labels.every(isText)) problems.push(`${name}: each option needs a label.`)
      if (new Set(labels).size !== labels.length) problems.push(`${name}: two options have the same label.`)
      const recommended = q.options.filter(o => o?.recommended).length
      if (!recommended) problems.push(`${name} has no option with recommended: true. Each question needs your recommendation.`)
      if (recommended > 1 && !q.multiSelect) problems.push(`${name} takes one answer, and ${recommended} options are recommended.`)
    }
    if (isText(q?.id)) seen.add(q.id)
  })
  if (mode === 'light') {
    const all = [...before, ...round.questions]
    const followUps = all.filter(q => q?.followUpTo !== undefined).length
    const initial = all.length - followUps
    if (initial > LIGHT_QUESTIONS) problems.push(`Light mode allows ${LIGHT_QUESTIONS} questions, and this round makes ${initial}. Ask only the most pertinent ones.`)
    if (followUps > LIGHT_FOLLOW_UPS) problems.push(`Light mode allows ${LIGHT_FOLLOW_UPS} follow-up questions, and this round makes ${followUps}.`)
  }
  return problems.length ? { problems } : { round }
}

// Q1, Q2 and so on, across all rounds of the issue, so a follow-up can name its parent in any round.
export function labelsOf(questions: readonly InterviewQuestion[]): Record<string, string> {
  return Object.fromEntries(questions.map((q, i) => [q.id, `Q${i + 1}`]))
}

// The chain from the first question down to this one: Q3 › Q7 › Q9.
export function chainOf(id: string, questions: readonly InterviewQuestion[]): string[] {
  const byId = new Map(questions.map(q => [q.id, q]))
  const chain: string[] = []
  for (let q = byId.get(id); q && !chain.includes(q.id); q = q.followUpTo ? byId.get(q.followUpTo) : undefined) chain.unshift(q.id)
  return chain
}

const recommendedDraft = (q: InterviewQuestion): DraftAnswer => ({
  selected: (q.options ?? []).filter(o => o.recommended).map(o => o.label),
  other: q.options ? '' : (q.suggested ?? ''),
  notes: '',
  touched: false,
})

// Each question starts on the recommendation. A draft from an earlier call fills what it knows.
export function startingAnswers(round: InterviewRound, draft: Record<string, DraftAnswer> | undefined): Record<string, DraftAnswer> {
  return Object.fromEntries(round.questions.map(q => [q.id, draft?.[q.id] ?? recommendedDraft(q)]))
}

export const hasAnswer = (a: DraftAnswer) => a.selected.length > 0 || a.other.trim() !== ''

export function answerText(a: Pick<InterviewAnswer, 'selected' | 'other'>): string {
  return [...a.selected, ...(a.other?.trim() ? [a.other.trim()] : [])].join('; ') || 'no answer'
}

const finalAnswer = (id: string, a: DraftAnswer, source: AnswerSource): InterviewAnswer => ({
  id,
  selected: a.selected,
  ...(a.other.trim() ? { other: a.other.trim() } : {}),
  ...(a.notes.trim() ? { notes: a.notes.trim() } : {}),
  source,
})

// submitted: each answer is the human's. trustMeBro: only what the human touched is; the
// recommendations fill the rest. dismissed: only what the human touched is kept, so the agent asks the rest again.
export function finishRound(round: InterviewRound, answers: Record<string, DraftAnswer>, end: RoundEnd, at: number): RecordedRound {
  if (end === 'dismissed') {
    const questions = round.questions.filter(q => answers[q.id]?.touched && hasAnswer(answers[q.id]!))
    return { ...round, questions, answers: questions.map(q => finalAnswer(q.id, answers[q.id]!, 'human')), at, dismissed: true }
  }
  const sourceOf = (q: InterviewQuestion): AnswerSource => (end === 'submitted' || answers[q.id]!.touched ? 'human' : 'recommended')
  return { ...round, answers: round.questions.map(q => finalAnswer(q.id, answers[q.id]!, sourceOf(q))), at, ...(end === 'trustMeBro' ? { trustMeBro: true as const } : {}) }
}

// What the agent gets back.
export function resultOf(round: RecordedRound, asked: InterviewRound): Record<string, unknown> {
  const answered = new Set(round.answers.map(a => a.id))
  return {
    answers: round.answers.map(a => ({ id: a.id, selected: a.selected, ...(a.other ? { other: a.other } : {}), ...(a.notes ? { notes: a.notes } : {}), ...(a.source === 'recommended' ? { source: 'recommended' } : {}) })),
    ...(round.trustMeBro ? { trustMeBro: true } : {}),
    ...(round.dismissed ? { dismissed: true, notAnswered: asked.questions.filter(q => !answered.has(q.id)).map(q => q.id) } : {}),
  }
}

export const answeredRounds = (file: InterviewFile) => file.rounds.filter(r => r.answers.length > 0).length

// A heavy issue may leave with no answers only when followUp started its worker: the parent owns the choice.
export function exitProblem(file: InterviewFile, facts: { mode: Mode; steering: string }): string | undefined {
  if (facts.mode !== 'heavy' || facts.steering === 'auto' || answeredRounds(file) || file.startedByFollowUp) return undefined
  return 'A heavy issue needs an interview, and this one has no answers. Ask with interview(interviewJson). Only a human can skip it, with /flow skip <reason>.'
}

export function commentBody(file: InterviewFile): string {
  const questions = allQuestions(file)
  const labels = labelsOf(questions)
  const rounds = file.rounds.map(round => {
    const items = round.questions.map(q => {
      const a = round.answers.find(x => x.id === q.id)
      const from = a?.source === 'recommended' ? "the agent's recommendation" : "the human's answer"
      return [
        `**${labels[q.id]}: ${q.header}**${q.followUpTo ? ` (follow-up to ${labels[q.followUpTo] ?? q.followUpTo})` : ''}`,
        q.question,
        a ? `Answer (${from}): ${answerText(a)}` : 'Not answered.',
        ...(a?.notes ? [`Notes: ${a.notes}`] : []),
      ].join('\n\n')
    })
    const tags = [round.trustMeBro ? 'the human chose Trust Me Bro' : '', round.dismissed ? 'the human closed this round before the end' : ''].filter(Boolean).join(', ')
    return [`### ${round.title}${tags ? ` (${tags})` : ''}`, ...items].join('\n\n')
  })
  const head = `${commentMarker(file.issue)}\n## Interview for #${file.issue}`
  const full = [head, ...rounds].join('\n\n')
  if (full.length <= COMMENT_LIMIT) return full
  const cut = `The interview is longer than a comment can hold, so this shows its start. The whole text is in ${interviewFileName(file.issue)} in the worktree.`
  return `${full.slice(0, COMMENT_LIMIT - cut.length - 4)}\n\n${cut}`
}
