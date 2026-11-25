// Proves audit.mjs through its command line against a small brand site and project built in a
// temporary folder. The brand site uses the template's real copy checker and banned list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '../audit.mjs');
const TEMPLATE = path.resolve(HERE, '../../../../templates/brand-site');

function write(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
}

function brandSite(root) {
  write(root, {
    'public/ds/tokens/colors.css': ':root {\n  --navy-800: #102b4a;\n  --white: #ffffff;\n  --red-600: #c0392b;\n  --canvas: var(--white);\n}\n',
    'public/ds/tokens/typography.css': ':root {\n  --font-sans: "Source Sans", Arial, sans-serif;\n}\n',
  });
  cpSync(path.join(TEMPLATE, 'scripts/copy/check-lib.mjs'), path.join(root, 'scripts/copy/check-lib.mjs'));
  cpSync(path.join(TEMPLATE, 'public/ds/copy/banned.json'), path.join(root, 'public/ds/copy/banned.json'));
  return root;
}

function setup(projectFiles) {
  const dir = mkdtempSync(path.join(tmpdir(), 'brand-audit-'));
  const brand = brandSite(path.join(dir, 'brand'));
  const project = path.join(dir, 'project');
  mkdirSync(project);
  write(project, projectFiles);
  return { brand, project };
}

function audit(brand, project, ...flags) {
  const r = spawnSync(process.execPath, [SCRIPT, '--brand', brand, ...flags, project], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const json = (r) => JSON.parse(r.out);

test('a project that uses only brand tokens, fonts and words is clean', () => {
  const { brand, project } = setup({
    'app/site.css': 'body { color: var(--navy-800); font-family: "Source Sans", sans-serif; }\n',
    'README.md': 'Use the export button to save the table.\n',
  });
  const r = audit(brand, project);
  assert.equal(r.code, 0, r.out + r.err);
});

test('a colour that equals a token is reported with the token to use', () => {
  const { brand, project } = setup({ 'app/site.css': 'a {\n  color: #102B4A;\n}\n' });
  const r = audit(brand, project, '--json');
  assert.equal(r.code, 1);
  const [f] = json(r).findings;
  assert.equal(f.file, 'app/site.css');
  assert.equal(f.line, 2);
  assert.equal(f.kind, 'colour-literal');
  assert.match(f.message, /var\(--navy-800\)/);
});

test('a colour that is not in the brand is reported with the nearest token', () => {
  const { brand, project } = setup({ 'app/Button.tsx': 'export const B = () => <b style={{ color: "#ff0000" }} />;\n' });
  const r = audit(brand, project, '--json');
  assert.equal(r.code, 1);
  const [f] = json(r).findings;
  assert.equal(f.kind, 'off-brand-colour');
  assert.match(f.message, /--red-600/);
});

test('rgb() colours are compared with the tokens too', () => {
  const { brand, project } = setup({ 'app/site.css': 'a { color: rgb(16, 43, 74); }\n' });
  const [f] = json(audit(brand, project, '--json')).findings;
  assert.equal(f.kind, 'colour-literal');
  assert.match(f.message, /var\(--navy-800\)/);
});

test('a font family outside the brand type tokens is reported', () => {
  const { brand, project } = setup({ 'app/site.css': 'h1 { font-family: "Comic Sans MS", cursive; }\n' });
  const r = audit(brand, project, '--json');
  assert.equal(r.code, 1);
  const [f] = json(r).findings;
  assert.equal(f.kind, 'off-brand-font');
  assert.match(f.message, /Comic Sans MS/);
  assert.match(f.message, /Source Sans/);
});

test('a banned word in prose is reported with its replacement', () => {
  const { brand, project } = setup({ 'docs/guide.md': 'Teams can utilise the export.\n' });
  const r = audit(brand, project, '--json');
  assert.equal(r.code, 1);
  const [f] = json(r).findings;
  assert.equal(f.kind, 'banned-word');
  assert.equal(f.line, 1);
  assert.match(f.message, /utilise.*use/);
});

test('--fix replaces token colours in stylesheets only, and the rest is still reported', () => {
  const { brand, project } = setup({
    'app/site.css': 'a { color: #102b4a; }\n:root { --brand: #102b4a; }\n',
    'app/Card.tsx': 'export const C = () => <i style={{ color: "#102b4a" }} />;\n',
  });
  const r = audit(brand, project, '--fix', '--json');
  assert.equal(readFileSync(path.join(project, 'app/site.css'), 'utf8'), 'a { color: var(--navy-800); }\n:root { --brand: #102b4a; }\n');
  assert.match(readFileSync(path.join(project, 'app/Card.tsx'), 'utf8'), /#102b4a/);
  assert.equal(r.code, 1);
  const out = json(r);
  assert.equal(out.fixed, 1);
  assert.deepEqual(out.findings.map((f) => f.file), ['app/Card.tsx']);
});

test('a custom property set to a brand value is a mirror of the token, not a finding', () => {
  const { brand, project } = setup({ 'app/site.css': ':root { --primary: #102b4a; }\n' });
  assert.equal(audit(brand, project).code, 0);
});

test('dependencies, build output and the brand site inside the project are not checked', () => {
  const { brand, project } = setup({
    'node_modules/x/a.css': 'a { color: #ff0000; }\n',
    '.next/static/a.css': 'a { color: #ff0000; }\n',
    'app/site.css': 'a { color: var(--white); }\n',
  });
  brandSite(path.join(project, 'apps/brand'));
  write(project, { 'apps/brand/app/page.mdx': 'Teams can utilise it. #ff0000\n' });
  const r = audit(path.join(project, 'apps/brand'), project);
  assert.equal(r.code, 0, r.out + r.err);
});

test('an unfinished brand site is a warning, not a failure', () => {
  const { brand, project } = setup({ 'app/site.css': 'a { color: var(--white); }\n' });
  writeFileSync(path.join(brand, 'BRAND-TODO.md'), '- [ ] Colours\n');
  const r = audit(brand, project, '--json');
  assert.equal(r.code, 0);
  assert.equal(json(r).findings[0].kind, 'brand-unfinished');
  assert.equal(json(r).findings[0].severity, 'warning');
});

test('a project with nothing to check exits 2', () => {
  const { brand, project } = setup({ 'data.bin': 'x' });
  const r = audit(brand, project);
  assert.equal(r.code, 2);
  assert.match(r.err, /no stylesheet, script or prose file/);
});

test('a brand folder without tokens exits 2 and names the folder and the repair', () => {
  const { project } = setup({ 'app/site.css': 'a {}\n' });
  const r = audit(project, project);
  assert.equal(r.code, 2);
  assert.match(r.err, new RegExp(`${project.replace(/[/.]/g, '\\$&')}.*public/ds/tokens`));
  assert.match(r.err, /\/brand create/);
});

test('nested worktrees, agent folders and minified files are not checked', () => {
  const { brand, project } = setup({
    '.worktrees/feature/app/site.css': 'a { color: #ff0000; }\n',
    'other/.git': 'gitdir: /somewhere\n',
    'other/app/site.css': 'a { color: #ff0000; }\n',
    '.claude/skills/x/SKILL.md': 'Teams can utilise it.\n',
    'public/app.min.css': 'a{color:#ff0000}\n',
    'app/site.css': 'a { color: var(--white); }\n',
  });
  const r = audit(brand, project);
  assert.equal(r.code, 0, r.out + r.err);
});

test('a font family built from template text is not read as a font name', () => {
  const { brand, project } = setup({ 'scripts/card.mjs': 'const css = `font-family: ${family}, sans-serif;`;\n' });
  const r = audit(brand, project);
  assert.equal(r.code, 0, r.out + r.err);
});

test('--register judges prose in that register, and an unknown register is refused', () => {
  const { brand, project } = setup({ 'docs/guide.md': 'Teams can utilise the export.\n' });
  assert.equal(json(audit(brand, project, '--register', 'marketing', '--json')).findings[0].kind, 'banned-word');
  const r = audit(brand, project, '--register', 'shouting');
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown register 'shouting'/);
});

// Review findings: each test below failed before the fix it names.

test('--fix changes only colour values: selectors, url(#id) and comments stay as they were', () => {
  const { brand, project } = setup({});
  writeFileSync(path.join(brand, 'public/ds/tokens/extra.css'), ':root {\n  --add: #aadddd;\n}\n');
  const css = '/* was #102b4a */\n#add-button { fill: url(#add); color: #102b4a; }\n';
  write(project, { 'app/site.css': css });
  const r = audit(brand, project, '--fix', '--json');
  assert.equal(readFileSync(path.join(project, 'app/site.css'), 'utf8'), '/* was #102b4a */\n#add-button { fill: url(#add); color: var(--navy-800); }\n');
  assert.equal(json(r).fixed, 1);
});

test('Sass and Less are reported but never rewritten, and a Sass variable set to a brand value is a mirror', () => {
  const scss = '$primary: #102b4a;\na { color: darken(#102b4a, 10%); }\n';
  const { brand, project } = setup({ 'app/site.scss': scss });
  const r = audit(brand, project, '--fix', '--json');
  assert.equal(readFileSync(path.join(project, 'app/site.scss'), 'utf8'), scss);
  const out = json(r);
  assert.equal(out.fixed, 0);
  assert.deepEqual(out.findings.map((f) => [f.line, f.kind]), [[2, 'colour-literal']]);
});

test('every value of a token counts, so a dark-mode value does not hide the light one', () => {
  const { brand, project } = setup({ 'app/site.css': 'body { background: #fafafa; }\n' });
  writeFileSync(path.join(brand, 'public/ds/tokens/theme.css'), ':root { --bg: #fafafa; }\n@media (prefers-color-scheme: dark) { :root { --bg: #111111; } }\n');
  const out = json(audit(brand, project, '--json'));
  assert.deepEqual(out.findings.map((f) => f.kind), ['colour-literal']);
  assert.match(out.findings[0].message, /--bg/);
});

test('colours with transparency, percentages or decimals are checked, not skipped', () => {
  const { brand, project } = setup({ 'app/site.css': [
    'a { color: rgba(16, 43, 74, 0.5); }',
    'b { color: #ff000080; }',
    'i { color: rgb(100%, 0%, 0%); }',
    'u { color: rgb(16.4 43 74 / 50%); }',
  ].join('\n') + '\n' });
  const r = audit(brand, project, '--json');
  assert.equal(r.code, 1);
  assert.deepEqual(json(r).findings.map((f) => [f.line, f.kind, f.severity]), [
    [1, 'colour-literal', 'warning'], [2, 'off-brand-colour', 'error'], [3, 'off-brand-colour', 'error'], [4, 'colour-literal', 'warning'],
  ]);
  assert.match(json(r).findings[0].message, /--navy-800.*transparen/);
});

test('font values end at the property: script objects, !important and every match on a line', () => {
  const { brand, project } = setup({
    'app/a.tsx': "const s = { fontFamily: 'Source Sans', fontSize: 12 };\n",
    'app/b.css': 'p { font-family: inherit !important; }\n',
    'app/c.css': 'p { font-family: "Source Sans"; } h1 { font-family: "Comic Sans MS"; }\n',
  });
  const out = json(audit(brand, project, '--json'));
  assert.deepEqual(out.findings.map((f) => [f.file, f.kind]), [['app/c.css', 'off-brand-font']]);
  assert.match(out.findings[0].message, /Comic Sans MS/);
});

test('in scripts, only colours inside strings count, so a private member such as #add is not a colour', () => {
  const { brand, project } = setup({ 'app/q.ts': 'class Q { #add(x) { return this.#bad + x; } }\nconst c = "#ff0000"; // #102b4a\n' });
  const out = json(audit(brand, project, '--json'));
  assert.deepEqual(out.findings.map((f) => [f.line, f.kind]), [[2, 'off-brand-colour']]);
});

test('a project folder that does not exist or a file that cannot be read exits 2 with the path', () => {
  const { brand, project } = setup({ 'app/site.css': 'a { color: var(--white); }\n' });
  let r = audit(brand, path.join(project, 'missing'));
  assert.equal(r.code, 2);
  assert.match(r.err, /missing is not a folder/);
  chmodSync(path.join(project, 'app/site.css'), 0o000);
  r = audit(brand, project);
  chmodSync(path.join(project, 'app/site.css'), 0o644);
  assert.equal(r.code, 2);
  assert.match(r.err, /cannot read .*app\/site\.css: EACCES/);
});

test('a linked stylesheet is checked, and a brand site reached through a link is still left out', () => {
  const { brand, project } = setup({ 'shared/theme.css': 'a { color: #ff0000; }\n' });
  mkdirSync(path.join(project, 'app'));
  symlinkSync(path.join(project, 'shared/theme.css'), path.join(project, 'app/theme.css'));
  symlinkSync(brand, path.join(project, 'brand-link'));
  const out = json(audit(path.join(project, 'brand-link'), project, '--json'));
  assert.deepEqual(out.findings.map((f) => f.file).sort(), ['app/theme.css', 'shared/theme.css']);
});
