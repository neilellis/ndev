// Orca serves a panel as one HTML page: relative <link>/<script src> files do not load.
// This inlines panel-src/app.css and panel-src/app.js into panel/index.html.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8'))
const src = (f) => readFileSync(new URL(`../panel-src/${f}`, import.meta.url), 'utf8')
const csp = "default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"
const html = src('index.html')
  .replace('<title>', `<meta http-equiv="Content-Security-Policy" content="${csp}" />\n    <title>`)
  .replace('<link rel="stylesheet" href="app.css" />', () => `<style>\n${src('app.css')}</style>`)
  .replace('<script type="module" src="app.js"></script>', () => `<script type="module">\n${src('app.js').replaceAll('</script', '<\\/script')}</script>`)
for (const marker of ['href="app.css"', 'src="app.js"']) if (html.includes(marker)) throw new Error(`build.mjs: ${marker} was not inlined`)
mkdirSync(new URL('../panel/', import.meta.url), { recursive: true })
writeFileSync(new URL('../panel/index.html', import.meta.url), html)
console.log(`panel/index.html written (${html.length} bytes)`)

const snapshotTemplate = src('snapshot.html')
const snapshotStyle = src('snapshot.css')
const snapshotScript = src('snapshot.js').replaceAll('</script', '<\\/script')
for (const panel of manifest.contributes.panels.filter(panel => panel.id !== 'files')) {
  const triage = panel.id === 'triage'
  const style = triage ? snapshotStyle + src('triage.css') : snapshotStyle
  const script = triage ? src('triage.js').replaceAll('</script', '<\\/script') + '\n' + snapshotScript : snapshotScript
  const frame = snapshotTemplate.replaceAll('{{id}}', panel.id).replaceAll('{{title}}', panel.title)
    .replace('<title>', `<meta http-equiv="Content-Security-Policy" content="${csp}" />\n    <title>`)
    .replace('<link rel="stylesheet" href="snapshot.css" />', () => `<style>\n${style}</style>`)
    .replace('<script type="module" src="snapshot.js"></script>', () => `<script type="module">\n${script}</script>`)
  writeFileSync(new URL(`../${panel.entry}`, import.meta.url), frame)
}
