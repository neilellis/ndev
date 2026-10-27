import type { EngineInterface } from 'claude-code'

import { REPO } from './config'
import type { Board, GitHub, LoadedConfig } from './config'

// The set-up dialog: it asks for the project's GitHub repository and board once, so no skill or
// script looks them up again. An answer that is one of the options, or exact, is kept as it is.
// Free text ("the roadmap board") is handed to an agent, which resolves it and writes the file.

export const LATER = 'Ask me later'
export const NO_REPO = 'No GitHub repository'
export const NO_BOARD = 'No project board'

export type SetupResult =
  | { kind: 'save'; github: GitHub }
  | { kind: 'agent'; known: Partial<GitHub>; typed: string[] }
  | { kind: 'later'; reason: string }

type Found = { boards: { number: number; title: string }[]; error?: string }

// Resolves to undefined when the dialog is dismissed: the user chose not to answer now.
async function ask($: EngineInterface, question: string, header: string, options: string[]) {
  try {
    return (await $.ui.ask(question, { header, options })).trim()
  } catch {
    return undefined
  }
}

async function detectRepo($: EngineInterface, root: string) {
  const ran = await $.process.run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
    cwd: root,
    timeoutMs: 15000,
  })
  const repo = ran.stdout.trim()
  return ran.exitCode === 0 && REPO.test(repo) ? repo : undefined
}

async function listBoards($: EngineInterface, owner: string, root: string): Promise<Found> {
  const ran = await $.process.run(['gh', 'project', 'list', '--owner', owner, '--format', 'json', '--limit', '30'], {
    cwd: root,
    timeoutMs: 15000,
  })
  if (ran.exitCode !== 0) {
    return { boards: [], error: `gh project list --owner ${owner} exited ${ran.exitCode}: ${ran.stderr.trim().slice(0, 160)}` }
  }
  try {
    const parsed = JSON.parse(ran.stdout) as { projects?: { number: number; title: string; closed?: boolean }[] }
    return { boards: (parsed.projects ?? []).filter(p => p.closed !== true) }
  } catch (error) {
    return { boards: [], error: `gh project list --owner ${owner} gave output that is not JSON: ${String(error).slice(0, 120)}` }
  }
}

const boardLabel = (b: { number: number; title: string }) => `#${b.number} ${b.title}`.slice(0, 60)

// An exact board answer: a listed label, "#3", "3" or "owner/3".
const exactBoard = (answer: string, owner: string | undefined, boards: Found['boards']): Board | undefined => {
  const listed = boards.find(b => boardLabel(b) === answer)
  if (listed && owner) return { owner, number: listed.number }
  const number = /^#?(\d+)$/.exec(answer)
  if (number && owner) return { owner, number: Number(number[1]) }
  const qualified = /^([A-Za-z0-9_.-]+)\/#?(\d+)$/.exec(answer)
  if (qualified) return { owner: qualified[1] as string, number: Number(qualified[2]) }
  return undefined
}

// Asks for the values that are missing (all of them when `all`), and says what to do with the answers.
export async function runSetup($: EngineInterface, loaded: LoadedConfig, all: boolean): Promise<SetupResult> {
  const current = all ? undefined : loaded.config.github
  const typed: string[] = []
  let repo: string | null | undefined = current?.repo

  if (current === undefined) {
    const found = await detectRepo($, loaded.root)
    const answer = await ask(
      $,
      found
        ? `This project's origin is ${found}. Which GitHub repository is this project (or type owner/name under Other)?`
        : 'No GitHub repository was found from the git remote. Which GitHub repository is this project (type owner/name under Other)?',
      'Repository',
      found ? [found, NO_REPO, LATER] : [NO_REPO, LATER],
    )
    if (answer === undefined) return { kind: 'later', reason: 'the dialog was closed' }
    if (answer === LATER) return { kind: 'later', reason: 'you chose to answer later' }
    if (answer === NO_REPO) return { kind: 'save', github: { repo: null, board: null } }
    if (REPO.test(answer)) repo = answer
    else typed.push(`Repository: "${answer}"`)
  }

  const owner = repo ? repo.split('/')[0] : undefined
  const found: Found = owner ? await listBoards($, owner, loaded.root) : { boards: [] }
  if (found.error) {
    $.ui.toast(`ndev: ${found.error}. Repair: gh auth refresh -s read:project, then /dev-setup.`)
  }
  const shown = found.boards.slice(0, 2)
  const answer = await ask(
    $,
    found.boards.length > shown.length
      ? `${owner} has ${found.boards.length} project boards. Which board does this project use (type its number or name under Other)?`
      : 'Which GitHub project board does this project use (type its number or name under Other)?',
    'Board',
    [...shown.map(boardLabel), NO_BOARD, LATER],
  )
  const known: Partial<GitHub> = repo === undefined ? {} : { repo }

  if (answer === undefined || answer === LATER) {
    if (typed.length > 0) return { kind: 'agent', known, typed }
    if (repo === undefined || current !== undefined) {
      return { kind: 'later', reason: answer === undefined ? 'the dialog was closed' : 'you chose to answer later' }
    }
    return { kind: 'save', github: { repo } }
  }
  if (answer === NO_BOARD) {
    if (typed.length > 0) return { kind: 'agent', known: { ...known, board: null }, typed }
    return { kind: 'save', github: { repo: repo as string | null, board: null } }
  }
  const board = exactBoard(answer, owner, found.boards)
  if (board && typed.length === 0) return { kind: 'save', github: { repo: repo as string | null, board } }
  if (board) return { kind: 'agent', known: { ...known, board }, typed }
  return { kind: 'agent', known, typed: [...typed, `Project board: "${answer}"`] }
}

// The task for the agent that turns typed answers into the `github` key.
export const agentPrompt = (path: string, known: Partial<GitHub>, typed: string[]) =>
  [
    `Set the "github" key of ${path} from the user's answers to the ndev set-up dialog.`,
    `Values already known: ${JSON.stringify(known)}.`,
    `The user typed: ${typed.join('; ')}.`,
    'Resolve each typed answer with gh: `gh repo view <name> --json nameWithOwner` for a repository, `gh project list --owner <owner> --format json` for a board (match by title or number).',
    'The key must be { "repo": "owner/name" or null, "board": { "owner": "<org or user>", "number": <n> } or null }.',
    'Change only the "github" key. Keep every other key as it is, and write the file as JSON with 2-space indents and a final newline.',
    'If an answer matches no value or more than one, do not guess: leave the file unchanged and report what the user must give. Otherwise report the value you wrote in one line.',
  ].join('\n')
