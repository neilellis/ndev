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

const newerRun = (a, b) => a.createdAt === b.createdAt ? a.databaseId > b.databaseId : a.createdAt > b.createdAt

export function settleBranch(branch, sha, runs) {
  if (!Array.isArray(runs)) throw new CliError(1, `gh run list for ${branch} at ${sha} printed no list: ${JSON.stringify(runs)}.`, { repair: 'Run gh auth status and retry.' })
  const latest = new Map()
  for (const run of runs) {
    if (!run.workflowName) throw new CliError(1, `A run on ${branch} at ${sha} has no workflow name: ${JSON.stringify(run)}.`, { repair: `Run gh run list --branch ${branch} --commit ${sha} and inspect the runs.` })
    const seen = latest.get(run.workflowName)
    if (!seen || newerRun(run, seen)) latest.set(run.workflowName, run)
  }
  const all = [...latest.values()].sort((a, b) => a.workflowName.localeCompare(b.workflowName))
    .map(run => ({ name: run.workflowName, conclusion: (run.status === 'completed' ? run.conclusion : run.status).toUpperCase(), url: run.url ?? '', running: run.status !== 'completed' }))
  const workflows = all.map(({ running: unused, ...workflow }) => workflow)
  const at = `${branch} at ${sha.slice(0, 8)}`
  const list = items => items.map(item => `${item.name} (${item.conclusion})${item.url ? ` ${item.url}` : ''}`).join(', ')
  const running = all.filter(item => item.running)
  const failed = all.filter(item => !item.running && !passing.has(item.conclusion))
  if (!all.length) return { settled: false, branch, sha, workflows, detail: `No workflow run has started yet on ${at}.` }
  if (running.length) return { settled: false, branch, sha, workflows, detail: `Still running on ${at}: ${list(running)}.` }
  return { settled: true, failed, branch, sha, workflows, detail: failed.length ? `Workflows failed on ${at}: ${list(failed)}.` : `Workflows passed on ${at}: ${list(workflows)}.` }
}
