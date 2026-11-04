import { expect, test } from 'claude-code/testing'

import { COMMENT_LIMIT, chainOf, commentBody, emptyFile, exitProblem, finishRound, labelsOf, parseRound, resultOf, startingAnswers } from '../hooks/workflow/interview-model'
import type { InterviewQuestion, InterviewRound } from '../hooks/workflow/interview-model'

const free = (id: string, extra: Partial<InterviewQuestion> = {}): InterviewQuestion => ({ id, header: id, question: `${id}?`, suggested: 'yes', ...extra })
const ROUND: InterviewRound = {
  title: 'Login',
  questions: [
    { id: 'store', header: 'Store', question: 'Where?', options: [{ label: 'Redis', recommended: true }, { label: 'Cookie' }] },
    free('name'),
  ],
}
const problems = (raw: unknown, mode: 'light' | 'heavy' = 'heavy', file = emptyFile(7)) => {
  const r = parseRound(raw, file, mode)
  return 'problems' in r ? r.problems.join('\n') : ''
}
const recorded = (ids: string[], extra: Partial<InterviewQuestion> = {}) => {
  const round = { title: 'R', questions: ids.map(id => free(id, extra)) }
  return finishRound(round, startingAnswers(round, undefined), 'submitted', 1)
}

test('a round is taken as an object or as its JSON', () => {
  expect(parseRound(ROUND, emptyFile(7), 'heavy')).toEqual({ round: ROUND })
  expect(parseRound(JSON.stringify(ROUND), emptyFile(7), 'heavy')).toEqual({ round: ROUND })
  expect(problems('{not json')).toContain('not valid JSON')
})

test('a bad round lists every problem at once', () => {
  const said = problems({ title: 'T', questions: [
    { id: 'a', header: 'A', question: 'A?', options: [{ label: 'x' }] },
    { id: 'a', question: 'B?', suggested: 's' },
    { id: 'c', header: 'C', question: 'C?' },
    { id: 'd', header: 'D', question: 'D?', suggested: 's', followUpTo: 'nope' },
    { id: 'e', header: 'E', question: 'E?', options: [{ label: 'x', recommended: true }, { label: 'y', recommended: true }] },
  ] })
  for (const part of ['"a" has no option with recommended', '"a": the id is already used', '"a" needs a header', '"c" has no options, so it needs a suggested', '"d": followUpTo "nope"', '"e" takes one answer']) expect(said).toContain(part)
})

test('ids are unique across rounds, and a follow-up can name a question of an earlier round', () => {
  const file = { ...emptyFile(7), rounds: [recorded(['a'])] }
  expect(problems({ title: 'T', questions: [free('a')] }, 'heavy', file)).toContain('already used')
  expect(problems({ title: 'T', questions: [free('b', { followUpTo: 'a' })] }, 'heavy', file)).toBe('')
})

test('light mode allows 5 questions and 5 follow-ups over all rounds; heavy has no limit', () => {
  const five = { ...emptyFile(7), rounds: [recorded(['a', 'b', 'c', 'd', 'e'])] }
  expect(problems({ title: 'T', questions: [free('f')] }, 'light', five)).toContain('allows 5 questions, and this round makes 6')
  expect(problems({ title: 'T', questions: [free('f')] }, 'heavy', five)).toBe('')
  const follow = (ids: string[]) => ({ title: 'T', questions: ids.map(id => free(id, { followUpTo: 'a' })) })
  expect(problems(follow(['f', 'g', 'h', 'i', 'j']), 'light', five)).toBe('')
  expect(problems(follow(['f', 'g', 'h', 'i', 'j', 'k']), 'light', five)).toContain('allows 5 follow-up questions, and this round makes 6')
})

test('after Trust Me Bro no round is taken', () => {
  const round = { title: 'R', questions: [free('a')] }
  const file = { ...emptyFile(7), rounds: [finishRound(round, startingAnswers(round, undefined), 'trustMeBro', 1)] }
  expect(problems({ title: 'T', questions: [free('b')] }, 'heavy', file)).toContain('Trust Me Bro')
})

test('labels number the questions, and a chain runs from the first question to this one', () => {
  const questions = [free('a'), free('b', { followUpTo: 'a' }), free('c', { followUpTo: 'b' })]
  expect(labelsOf(questions)).toEqual({ a: 'Q1', b: 'Q2', c: 'Q3' })
  expect(chainOf('c', questions)).toEqual(['a', 'b', 'c'])
})

test('a draft fills what it knows, and the recommendation fills the rest', () => {
  const draft = { store: { selected: ['Cookie'], other: '', notes: 'n', touched: true } }
  expect(startingAnswers(ROUND, draft)).toEqual({ store: draft.store, name: { selected: [], other: 'yes', notes: '', touched: false } })
})

test('Trust Me Bro marks whose answer each one is, and the agent sees it', () => {
  const answers = startingAnswers(ROUND, undefined)
  answers.store = { selected: ['Cookie'], other: '', notes: '', touched: true }
  const done = finishRound(ROUND, answers, 'trustMeBro', 1)
  expect(done.answers.map(a => [a.id, a.source])).toEqual([['store', 'human'], ['name', 'recommended']])
  expect(resultOf(done, ROUND).trustMeBro).toBe(true)
})

test('closing the pane keeps only what the human touched, and names the rest', () => {
  const answers = startingAnswers(ROUND, undefined)
  answers.name = { selected: [], other: 'sid', notes: '', touched: true }
  const done = finishRound(ROUND, answers, 'dismissed', 1)
  expect(done.answers.map(a => a.id)).toEqual(['name'])
  expect(resultOf(done, ROUND)).toMatchObject({ dismissed: true, notAnswered: ['store'] })
})

test('only a heavy issue with no answers and no parent cannot leave', () => {
  const heavy = { mode: 'heavy', steering: 'interactive' } as const
  expect(exitProblem(emptyFile(7), heavy)).toContain('/flow skip')
  expect(exitProblem(emptyFile(7), { ...heavy, mode: 'light' })).toBeUndefined()
  expect(exitProblem(emptyFile(7), { ...heavy, steering: 'auto' })).toBeUndefined()
  expect(exitProblem({ ...emptyFile(7), startedByFollowUp: { of: 3, at: 1 } }, heavy)).toBeUndefined()
  expect(exitProblem({ ...emptyFile(7), rounds: [recorded(['a'])] }, heavy)).toBeUndefined()
})

test('the comment carries the marker and says whose answer each one is, and a long one is cut with a pointer to the file', () => {
  const round = { title: 'R', questions: [free('a'), free('b', { followUpTo: 'a' })] }
  const body = commentBody({ ...emptyFile(7), rounds: [finishRound(round, startingAnswers(round, undefined), 'trustMeBro', 1)] })
  expect(body).toContain('<!-- ndev:interview issue=7 -->')
  expect(body).toContain("Answer (the agent's recommendation): yes")
  expect(body).toContain('(follow-up to Q1)')
  expect(body).toContain('Trust Me Bro')
  const long = commentBody({ ...emptyFile(7), rounds: [recorded(['a'], { question: 'x'.repeat(COMMENT_LIMIT) })] })
  expect(long.length).toBeLessThanOrEqual(COMMENT_LIMIT)
  expect(long).toContain('.neil-dev.issue-7.json')
})
