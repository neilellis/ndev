export type DebtRuling = { verdict: 'fixed' | 'issue-filed' | 'accepted'; reason: string; evidence?: string; issue?: number }
export type EpicDebt = { key: string; kind: 'skipped-check' | 'merge-without-review' | 'gate-override'; note: string; at: number; sub?: number; check?: string; ruling?: DebtRuling }
export type ClosingEvidence = {
  sha: string
  branch: string
  suites: { command: string[]; exitCode: number; sha: string; log: string; skippedChecks: string[] }[]
  review: {
    baseSha: string
    sha: string
    model: string
    reviewer: string
    requirements: { id: string; status: 'done' | 'changed' | 'missing'; evidence: string; ruling?: DebtRuling }[]
    findings: { id: string; evidence: string; ruling: DebtRuling }[]
  }
  adrs: ClosingAdr[]
}
export type ClosingAdr = { decision: string; path: string }
export type DebtLedger = { epic: number; state: string; debts?: EpicDebt[] }
export class DebtRefused extends Error {
  code = 1
  repair: string
  constructor(message: string, repair: string) {
    super(message)
    this.repair = repair
  }
}
const ADR_PATH = /^docs\/adr\/\d{4}-[a-z0-9]+(-[a-z0-9]+)*\.md$/

type ClosingEpic = {
  baseSha?: string
  coordinatorModel?: string
  fullSuites?: string[][]
  owner?: { session: string }
  debts?: EpicDebt[]
  issues: Record<string, { issue: number; state: string; reviewer?: string; verdict?: string; mergedUnverified?: boolean }>
}
export type ClosingContext = { branch: string; defaultBranch: string; head: string; remoteHead: string; dirty: boolean; requirements: string[]; decisions: string[] }
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value)
const issue = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
export const closingSha = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
export const requirementIds = (source: string): string[] => [...new Set(source.match(/\bR-?\d+\b/g) ?? [])]
export const decisionIds = (source: string): string[] => [...new Set(source.match(/\bD\d+\b/g) ?? [])]

export function configureClosing(epic: { baseSha?: string; coordinatorModel?: string; fullSuites?: string[][]; posture?: string }, values: Record<string, unknown>): void {
  if (values.baseSha !== undefined) {
    if (!closingSha(values.baseSha) || epic.baseSha && epic.baseSha !== values.baseSha) throw new Error('The original epic base SHA must be a full commit and cannot be replaced')
    epic.baseSha = values.baseSha
  }
  if (values.coordinatorModel !== undefined) {
    if (!text(values.coordinatorModel) || epic.coordinatorModel && epic.coordinatorModel !== values.coordinatorModel.trim()) throw new Error('The original coordinator model must be named and cannot be replaced')
    epic.coordinatorModel = values.coordinatorModel.trim()
  }
  if (values.fullSuites !== undefined) {
    const suites = values.fullSuites
    if (!Array.isArray(suites) || !suites.length || suites.some(command => !Array.isArray(command) || !command.length || !command.every(text))) throw new Error('Full suites must be a non-empty list of command argument arrays')
    const keys = suites.map(command => JSON.stringify(command))
    if (new Set(keys).size !== keys.length || epic.fullSuites?.some(command => !keys.includes(JSON.stringify(command)))) throw new Error('The full-suite plan cannot duplicate or remove a command')
    epic.fullSuites = suites.map(command => [...command])
  }
  if (values.posture !== undefined) {
    if (!['standard', 'deadline'].includes(String(values.posture))) throw new Error('Posture must be standard or deadline')
    epic.posture = String(values.posture)
  }
}

export function rulingProblem(ruling: unknown): string | undefined {
  if (!object(ruling) || !['fixed', 'issue-filed', 'accepted'].includes(ruling.verdict) || !text(ruling.reason)) return 'needs a ruling: fixed, issue-filed or accepted, with a reason'
  if (ruling.verdict === 'fixed' && !text(ruling.evidence)) return 'a fixed ruling needs evidence'
  if (ruling.verdict === 'issue-filed' && !issue(ruling.issue)) return 'an issue-filed ruling needs a positive issue number'
}

export function debtProblem(debt: unknown): string | undefined {
  if (!object(debt) || !text(debt.key) || !/^[a-z0-9][a-z0-9._:-]{0,119}$/.test(debt.key)) return 'debt needs a stable key of lower-case letters, numbers, dots, colons, underscores or hyphens'
  if (!['skipped-check', 'merge-without-review', 'gate-override'].includes(debt.kind) || !text(debt.note)) return 'debt needs a kind and a note'
  if (debt.sub !== undefined && !issue(debt.sub)) return 'debt sub must be a positive issue number'
  if (debt.kind === 'skipped-check' && !text(debt.check)) return 'skipped-check debt needs the check name'
  if (debt.kind === 'merge-without-review' && !issue(debt.sub)) return 'merge-without-review debt needs the sub-issue'
}

export const DEBT_CAP = 4

function debtRoom(epic: DebtLedger, keys: string[], cap: number, places = keys.length): void {
  const named = keys.join(', ')
  if (epic.state === 'done') throw new DebtRefused(`Debt ${named} is not recorded: epic #${epic.epic} is done and takes no new debt.`, `File what remains as a new issue that names epic #${epic.epic}.`)
  const open = (epic.debts ?? []).filter(item => !item.ruling).map(item => item.key)
  if (open.length + places > cap) throw new DebtRefused(`Debt ${named} is not recorded: epic #${epic.epic} has ${open.length} open debts, and the cap is ${cap}.`, `Rule on ${open.join(', ')} with ndev epic ruling ${epic.epic} <key> --file <ruling.json> or the epicDebtRuling tool, then retry.`)
}

export function recordDebts(epic: DebtLedger, debts: Omit<EpicDebt, 'at' | 'ruling'>[], at: number, { cap = DEBT_CAP, places }: { cap?: number; places?: number } = {}): void {
  const fresh = debts.filter(debt => !epic.debts?.some(item => item.key === debt.key)).map(debt => debt.key)
  if (fresh.length) debtRoom(epic, fresh, cap, places ?? fresh.length)
  for (const debt of debts) recordDebt(epic, debt, at, Infinity)
}

// Model: models/workflow/epic_workflow.qnt#recordDebt
export function recordDebt(epic: DebtLedger, debt: Omit<EpicDebt, 'at' | 'ruling'>, at: number, cap = DEBT_CAP): EpicDebt {
  if (!object(debt) || 'at' in debt || 'ruling' in debt) throw new Error('New debt cannot supply its timestamp or ruling; record a separate ruling')
  if (epic.debts !== undefined && !Array.isArray(epic.debts)) throw new Error('Epic debt must be a list')
  const problem = debtProblem(debt)
  if (problem) throw new Error(problem)
  const found = epic.debts?.find(item => item.key === debt.key)
  if (found) {
    if (found.kind !== debt.kind || found.note !== debt.note || found.sub !== debt.sub || found.check !== debt.check) throw new Error(`Debt ${debt.key} already records a different event; use a new key`)
    return found
  }
  debtRoom(epic, [debt.key], cap)
  const entry = { ...debt, at }
  epic.debts = [...(epic.debts ?? []), entry]
  return entry
}

// Model: models/workflow/epic_workflow.qnt#recordMerged
export function mergeDebts(epic: DebtLedger, sub: { issue: number; pr?: number }, reviewed: boolean, verified: boolean, at: number, override?: string, cap = DEBT_CAP): void {
  recordDebts(epic, [
    ...(reviewed ? [] : [{ key: `merge:${sub.issue}:pr:${sub.pr}:review`, kind: 'merge-without-review' as const, sub: sub.issue, note: `PR #${sub.pr} merged without a recorded review` }]),
    ...(verified ? [] : [{ key: `merge:${sub.issue}:pr:${sub.pr}:verification`, kind: 'skipped-check' as const, sub: sub.issue, check: 'verification', note: `PR #${sub.pr} merged without current verification` }]),
    ...(override ? [{ key: `merge:${sub.issue}:override`, kind: 'gate-override' as const, sub: sub.issue, note: override }] : []),
  ], at, { cap })
}

// Model: models/workflow/epic_workflow.qnt#finishPhase
export function debtProblems(epic: ClosingEpic): string[] {
  const problems: string[] = []
  if (!object(epic.issues)) return ['Epic issues must be an object']
  if (epic.debts !== undefined && !Array.isArray(epic.debts)) return ['Epic debt must be a list']
  const keys = new Set<string>()
  for (const debt of epic.debts ?? []) {
    const shape = debtProblem(debt)
    if (shape) { problems.push(shape); continue }
    if (keys.has(debt.key)) problems.push(`Debt ${debt.key} is duplicated`)
    keys.add(debt.key)
    const problem = rulingProblem(debt.ruling)
    if (problem) problems.push(`Debt ${debt.key} ${problem}`)
  }
  for (const sub of Object.values(epic.issues)) {
    if (!object(sub)) { problems.push('Each sub-issue must be an object'); continue }
    if (sub.state !== 'merged') { problems.push(`Sub-issue #${sub.issue} is ${sub.state}, not merged`); continue }
    if (!(text(sub.reviewer) && ['approve', 'changes'].includes(sub.verdict ?? '')) && !(epic.debts ?? []).some(debt => debt.kind === 'merge-without-review' && debt.sub === sub.issue)) problems.push(`Sub-issue #${sub.issue} has no recorded review or merge-without-review debt`)
    if (sub.mergedUnverified && !(epic.debts ?? []).some(debt => debt.kind === 'skipped-check' && debt.sub === sub.issue && debt.check === 'verification')) problems.push(`Sub-issue #${sub.issue} needs skipped verification debt`)
  }
  return problems
}

export function closingProblems(epic: ClosingEpic, receipt: unknown, context: ClosingContext): string[] {
  const problems = debtProblems(epic)
  if (!object(receipt)) return [...problems, 'Closing needs structured evidence in a closing-file']
  if (!closingSha(epic.baseSha)) problems.push('Record the original epic base SHA before closing')
  if (!text(epic.coordinatorModel)) problems.push('Record the coordinator model before closing')
  if (!Array.isArray(epic.fullSuites) || !epic.fullSuites.length) problems.push('Record the full-suite command plan before closing')
  if (context.branch !== context.defaultBranch || context.dirty) problems.push(`Closing must run on the clean default branch ${context.defaultBranch}`)
  if (!closingSha(context.head) || context.head !== context.remoteHead || receipt.sha !== context.head || receipt.branch !== context.defaultBranch) problems.push(`Closing SHA and branch must match ${context.defaultBranch}@${context.remoteHead}`)
  if (!Array.isArray(receipt.suites) || !receipt.suites.length) problems.push('Closing needs full-suite receipts')
  else for (const [suiteIndex, suite] of receipt.suites.entries()) {
    if (!object(suite) || !Array.isArray(suite.command) || !suite.command.length || !suite.command.every(text) || !text(suite.log)) problems.push('Each full-suite receipt needs its command and log')
    if (!object(suite) || suite.exitCode !== 0 || suite.sha !== context.head) problems.push('Each full suite must exit 0 at the closing SHA')
    if (!object(suite) || !Array.isArray(suite.skippedChecks) || !suite.skippedChecks.every(text)) problems.push('Each full suite needs its skippedChecks list, including an empty list')
    else for (const [skipIndex, check] of suite.skippedChecks.entries()) {
      const key = `closing:${context.head}:suite:${suiteIndex}:skip:${skipIndex}`
      if (!(epic.debts ?? []).some(debt => debt.kind === 'skipped-check' && debt.key === key && debt.sub === undefined && debt.check === check)) problems.push(`Closing skipped check ${check} needs recorded debt ${key}`)
    }
  }
  for (const command of epic.fullSuites ?? []) if (!(Array.isArray(receipt.suites) && receipt.suites.some((suite: any) => object(suite) && JSON.stringify(suite.command) === JSON.stringify(command)))) problems.push(`Full suite ${JSON.stringify(command)} has no receipt`)
  const review = receipt.review
  if (!object(review)) return [...problems, 'Closing needs a whole-epic review']
  if (review.baseSha !== epic.baseSha || review.sha !== context.head) problems.push('Whole-epic review must cover the original base..closing SHA')
  if (!text(review.model) || !text(review.reviewer) || review.model.trim().toLowerCase() === epic.coordinatorModel?.trim().toLowerCase() || review.reviewer === epic.owner?.session) problems.push('Whole-epic review needs another model and reviewer')
  if (!context.requirements.length) problems.push('The committed spec has no numbered R1 or R-1 requirements')
  const rows = Array.isArray(review.requirements) ? review.requirements : []
  const ids = new Set<string>()
  for (const row of rows) {
    if (!object(row) || !text(row.id) || !['done', 'changed', 'missing'].includes(row.status) || !text(row.evidence)) { problems.push('Each R-id needs done, changed or missing with evidence'); continue }
    if (ids.has(row.id)) problems.push(`Requirement ${row.id} is duplicated`)
    ids.add(row.id)
    if (!context.requirements.includes(row.id)) problems.push(`Unknown requirement ${row.id}`)
    if (row.status !== 'done') {
      const problem = rulingProblem(row.ruling)
      if (problem) problems.push(`Requirement ${row.id} ${problem}`)
    }
  }
  for (const id of context.requirements) if (!ids.has(id)) problems.push(`Requirement ${id} is missing from the whole-epic review`)
  if (!Array.isArray(review.findings)) problems.push('Whole-epic review needs a findings list, including an empty list when clear')
  else {
    const findings = new Set<string>()
    for (const finding of review.findings) {
      if (!object(finding) || !text(finding.id) || !text(finding.evidence)) { problems.push('Each finding needs an identifier and evidence'); continue }
      if (findings.has(finding.id)) problems.push(`Finding ${finding.id} is duplicated`)
      findings.add(finding.id)
      const problem = rulingProblem(finding.ruling)
      if (problem) problems.push(`Finding ${finding.id} ${problem}`)
    }
  }
  return [...problems, ...adrProblems(receipt.adrs, context.decisions)]
}

function adrProblems(adrs: unknown, decisions: string[]): string[] {
  if (!Array.isArray(adrs)) return ['Closing needs adrs: one { "decision": "D3", "path": "docs/adr/NNNN-<slug>.md" } for each ruled D that passes the three ADR tests (kb/adr.md), or an empty list when none does']
  const problems: string[] = []
  const seen = new Set<string>()
  for (const adr of adrs) {
    if (!object(adr) || typeof adr.decision !== 'string' || !/^D\d+$/.test(adr.decision)) { problems.push(`Each ADR needs the D-id of its decision, such as D3, and one is ${JSON.stringify(adr)}`); continue }
    if (typeof adr.path !== 'string' || !ADR_PATH.test(adr.path)) problems.push(`The ADR of ${adr.decision} needs a path docs/adr/NNNN-<slug>.md, and it is ${JSON.stringify(adr.path)}`)
    if (!decisions.includes(adr.decision)) problems.push(`${adr.decision} is not in the decisions log of the committed spec, so its ADR cannot be checked against it`)
    if (seen.has(adr.decision)) problems.push(`${adr.decision} names an ADR twice`)
    seen.add(adr.decision)
  }
  return problems
}

export function closingFollowups(epic: { debts?: EpicDebt[] }, report: ClosingEvidence): { id: string; issue: number }[] {
  const rows = [...(epic.debts ?? []).map(debt => ({ id: `Debt ${debt.key}`, ruling: debt.ruling })), ...report.review.requirements.map(row => ({ id: `Requirement ${row.id}`, ruling: row.ruling })), ...report.review.findings.map(row => ({ id: `Finding ${row.id}`, ruling: row.ruling }))]
  return rows.filter(row => row.ruling?.verdict === 'issue-filed').map(row => ({ id: row.id, issue: row.ruling!.issue! }))
}
