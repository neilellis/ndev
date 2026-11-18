import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'

const password = randomBytes(32).toString('base64url')
const server = spawn('opencode', ['serve', '--stdio', '--port', '0'], {
  env: { ...process.env, OPENCODE_PASSWORD: password }, stdio: ['pipe', 'pipe', 'inherit'],
})
const stopped = once(server, 'close')
const lines = createInterface({ input: server.stdout })
const deadline = AbortSignal.timeout(20000)
deadline.addEventListener('abort', () => server.kill())
try {
  const [ready] = await Promise.race([once(lines, 'line'), stopped.then(([code, signal]) => { throw new Error(`opencode exited before readiness (${code ?? signal})`) })])
  const { url } = JSON.parse(ready)
  const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` }
  async function list(name) {
    const response = await fetch(new URL(`/api/${name}`, url), { headers, signal: deadline })
    if (!response.ok) throw new Error(`opencode /api/${name} returned ${response.status}: ${await response.text()}`)
    return (await response.json()).data
  }
  while (true) {
    const [plugins, agents, skills] = await Promise.all(['plugin', 'agent', 'skill'].map(list))
    const plugin = plugins.find(entry => entry.id === 'ndev')
    if (plugin?.state?.status === 'failed') throw new Error(`ndev plugin failed: ${JSON.stringify(plugin.state)}`)
    if (plugin?.state?.status === 'active' && agents.some(agent => agent.id === 'ndev-diff-reviewer') && skills.some(skill => skill.id === 'ndev-work-light')) break
    if (deadline.aborted) throw new Error('opencode did not discover ndev, ndev-diff-reviewer and ndev-work-light before timeout')
    await delay(100, undefined, { signal: deadline })
  }
} finally {
  server.stdin.end()
  lines.close()
  const [code, signal] = await stopped
  if (code !== 0) throw new Error(`opencode serve failed (exit ${code ?? signal})`)
}
