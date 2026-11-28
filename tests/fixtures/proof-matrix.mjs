import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const flags = {}
const routes = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i]
  else routes.push(argv[i])
}
const out = flags.out
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'argv.json'), JSON.stringify(argv))
if (process.env.FAKE_MATRIX_EXIT) {
  console.error('fake matrix cannot run: no playwright')
  process.exit(Number(process.env.FAKE_MATRIX_EXIT))
}
const viewports = flags.viewports.split(',').map(row => row.split(':')[0])
const cells = []
for (const route of routes) {
  const response = await fetch(`${flags.base}${route}`)
  for (const viewport of viewports) {
    for (const scheme of flags.schemes.split(',')) {
      const cell = { route, viewport, scheme, findings: [] }
      if (response.status >= 400) cell.error = `HTTP ${response.status}`
      else {
        cell.screenshot = join(out, 'shots', route.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'root', `${viewport}-${scheme}.jpg`)
        mkdirSync(join(cell.screenshot, '..'), { recursive: true })
        writeFileSync(cell.screenshot, `${flags.base}${route} ${viewport} ${scheme}`)
        if (route === '/settings' && scheme === 'dark') cell.findings.push({ check: 'contrast', severity: 'error', selector: 'p', detail: 'contrast 2.1:1' })
      }
      cells.push(cell)
    }
  }
}
if (process.env.FAKE_MATRIX_NO_REPORT) process.exit(0)
writeFileSync(join(out, 'report.json'), JSON.stringify({ base: flags.base, cells }))
process.exit(cells.some(cell => cell.error || cell.findings.length) ? 1 : 0)
