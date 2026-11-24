import { CliError } from './common.mjs'

const waiting = new Set(['PENDING', 'EXPECTED'])
const passing = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])

export function newestRuns(items) {
  const latest = new Map()
  for (const item of items) {
    const label = item.name || item.context
    if (!label) throw new CliError(1, `A check in the rollup has no name: ${JSON.stringify(item)}.`, { repair: 'Run gh pr checks <pr> and inspect the rollup.' })
    const key = `${item.workflowName ?? ''}\0${label}`
    const started = item.startedAt || (item.status === 'COMPLETED' || item.state ? '' : '9999')
    const seen = latest.get(key)
    if (!seen || started >= seen.started) latest.set(key, { started, item, label })
  }
  return [...latest.values()]
}

function newest(items) {
  return newestRuns(items).map(({ item, label }) => ({
    name: [item.workflowName, label].filter(Boolean).join('/'),
    conclusion: item.conclusion || item.state || item.status || '',
    running: item.__typename === 'StatusContext' || item.context ? waiting.has(item.state) : item.status !== 'COMPLETED',
    url: item.detailsUrl || item.targetUrl || '',
  }))
}

export function settleChecks(number, pr) {
  if (typeof pr.headRefOid !== 'string' || !pr.headRefOid || !Array.isArray(pr.statusCheckRollup)) {
    throw new CliError(1, `PR #${number} has no head SHA or check rollup from gh: ${JSON.stringify(pr)}.`, { repair: 'Run gh auth status and retry.' })
  }
  const all = newest(pr.statusCheckRollup).sort((a, b) => a.name.localeCompare(b.name))
  const running = all.filter(check => check.running)
  const failed = all.filter(check => !check.running && !passing.has(check.conclusion))
  const checks = all.map(({ running: unused, ...check }) => check)
  const sha = pr.headRefOid
  const list = items => items.map(check => `${check.name} (${check.conclusion})${check.url ? ` ${check.url}` : ''}`).join(', ')
  if (!all.length) return { satisfied: false, pr: number, sha, checks, detail: `No check has started yet on ${sha.slice(0, 8)}.` }
  if (running.length) return { satisfied: false, pr: number, sha, checks, detail: `Still running on ${sha.slice(0, 8)}: ${list(running)}.` }
  if (failed.length) {
    throw new CliError(1, `Checks failed on PR #${number} at ${sha.slice(0, 8)}: ${list(failed)}.`, {
      repair: `Read each log URL, fix the failure, commit with ndev flow checkpoint, then run ndev wait checks ${number}.`,
      details: { pr: number, sha, checks },
    })
  }
  return { satisfied: true, pr: number, sha, checks, detail: `Checks passed on ${sha.slice(0, 8)}: ${list(checks)}.` }
}
