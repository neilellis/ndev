export const RECORDS_DIR = 'docs/formal/requirements'
export const IN_FORCE = ['Proposed', 'Open', 'Accepted']
const VERIFIED_BY = /\b(tests?|checks?|models?|quint)\b|\.qnt\b/i
const UNVERIFIED = /^\W*(no|none|tbd|todo|later)\b|\b(tbd|todo|not yet|to be decided)\b/i

export type RecordSummary = { id: string; status: string; statement: string; prs: string[]; file: string }

export const citedIds = (text: string): string[] => [...new Set(text.match(/\bREQ-\d{4}\b/g) ?? [])]

export const recordFileOf = (id: string, files: string[]): string | undefined =>
  files.find(f => f.startsWith(`${id.slice(4)}-`) && f.endsWith('.md'))

export function planLine(text: string, name: string): string | undefined {
  return new RegExp(`^[\\s>*+-]*(?:\\*\\*|__)?${name}(?:\\*\\*|__)?:(?:\\*\\*|__)?[ \\t]*(.*)$`, 'im').exec(text)?.[1].trim()
}

function section(text: string, name: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex(l => l.trim() === `## ${name}`)
  if (start < 0) return ''
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim()
}

export function summarise(file: string, text: string): RecordSummary {
  const field = (name: string) => new RegExp(`^${name}:[ \\t]*["']?(.*?)["']?[ \\t]*$`, 'm').exec(text.split(/^---$/m)[1] ?? '')?.[1] ?? ''
  const prs = [...section(text, 'Trace').matchAll(/^\s*-\s*PR:\s*(\S+)/gm)].map(m => m[1])
  return { id: field('id'), status: field('status'), statement: section(text, 'Statement').replace(/\s+/g, ' '), prs, file }
}

export function issueRecordNotes(issue: number, cited: string[], records: RecordSummary[]): string[] {
  const found = records.map(r => `- ${r.id} (${r.status}): ${r.statement}`)
  const missing = cited.filter(id => !records.some(r => r.id === id)).map(id => `- ${id} has no record in ${RECORDS_DIR}.`)
  const lines = [...found, ...missing]
  if (records.some(r => IN_FORCE.includes(r.status))) return [`The records that issue #${issue} fulfils:\n${lines.join('\n')}\nStart from these records: the work exists to fulfil them.`]
  return [`${lines.length ? `Issue #${issue} cites no record in force:\n${lines.join('\n')}\n` : `Issue #${issue} cites no requirement record. `}Find the record that this work fulfils with ndev requirements for <file> or ndev requirements search <words>, and cite it in the issue. If no record states the requirement, create one with the status Proposed (kb/requirements.md).`]
}

export function verificationProblems(plan: string, ids: string[]): string[] {
  const verifier = (id: string) => new RegExp(`^[\\s>*+-]*(?:\\*\\*|__)?${id}:(?:\\*\\*|__)?[ \\t]*(.*)$`, 'gim')
  const verified = (id: string) => [...plan.matchAll(verifier(id))].some(m => VERIFIED_BY.test(m[1]) && !UNVERIFIED.test(m[1]))
  return ids.filter(id => !verified(id))
    .map(id => `${id} has no line that says how it is verified: add "${id}: <the test, check or model that verifies it>"`)
}

export function traceProblems(records: RecordSummary[], prUrl: string): string[] {
  return records.filter(r => IN_FORCE.includes(r.status) && !r.prs.includes(prUrl))
    .map(r => `${r.id} does not link this PR in its Trace (${RECORDS_DIR}/${r.file}). Repair: ndev requirements link ${r.id} ${prUrl}, then commit the record`)
}
