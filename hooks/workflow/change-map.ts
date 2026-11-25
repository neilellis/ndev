// The change map: which types each issue and each changed file hold, for the CI of the pushed commit.
// It stands as one hidden line in the PR body, because a pull_request event carries the body with no
// API call. kb/workflow.md, "The change map for CI", holds the contract for a reader.
import { CHANGE_TYPES, inferChangeTypes, typeOfPath, type ChangeType } from './change-types'

export const CHANGE_MAP_LIMIT = 30_000 // A PR body takes 65536 characters, and the plan shares it.
const OPEN = '<!-- ndev:change-map '
const CLOSE = ' -->'
const LINE = /\n*^<!-- ndev:change-map .*-->[ \t\r]*$/gm

export type ChangeMap = {
  version: 1
  sha: string
  issues: Record<string, { changeTypes: ChangeType[] }>
  files: Record<string, ChangeType[]>
}

export function buildChangeMap(sha: string, issues: readonly { issue: number; changeTypes: readonly ChangeType[] }[], paths: readonly string[]): ChangeMap {
  const inPaths = inferChangeTypes(paths)
  const inOrder = (types: readonly ChangeType[]) => CHANGE_TYPES.filter(type => types.includes(type) || inPaths.includes(type))
  return {
    version: 1,
    sha,
    issues: Object.fromEntries(issues.map(({ issue, changeTypes }) => [String(issue), { changeTypes: inOrder(changeTypes) }])),
    files: Object.fromEntries(paths.map(path => [path, [typeOfPath(path)]])),
  }
}

// No block means that CI runs everything, so a map that says nothing or does not fit is not written.
export function changeMapBlock(map: ChangeMap): string | undefined {
  if (!Object.keys(map.files).length) return undefined
  // Still valid JSON, and a path that holds --> cannot close the comment.
  const block = `${OPEN}${JSON.stringify(map).replaceAll('>', '\\u003e')}${CLOSE}`
  return block.length > CHANGE_MAP_LIMIT ? undefined : block
}

export function withChangeBlock(body: string, block: string | undefined): string {
  const rest = body.replace(LINE, '').trimEnd()
  return block ? `${rest}\n\n${block}` : rest
}
