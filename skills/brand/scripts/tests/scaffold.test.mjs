// Proves scaffold.mjs through its command line: a full brand site from the real template,
// and each refusal with the identifier it names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scaffold.mjs');
const CONFIG = {
  name: 'Acme Widgets', product: 'WidgetHub', domain: 'acme.example', siteUrl: 'https://brand.acme.example',
  repo: 'acme/acme-brand', sourceRepo: 'acme/acme-web', source: 'acme-web',
};

const scratch = () => mkdtempSync(path.join(tmpdir(), 'brand-scaffold-'));
function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function withConfig(dir, config) {
  const file = path.join(dir, 'brand.json');
  writeFileSync(file, JSON.stringify(config));
  return file;
}
function files(dir) {
  return readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f)).filter((f) => statSync(f).isFile());
}

test('a full site has no placeholder, no source brand, generated Vale files and live tests', () => {
  const dir = scratch();
  const target = path.join(dir, 'site');
  const r = run(['--target', target, '--config', withConfig(dir, CONFIG)]);
  assert.equal(r.code, 0, r.err);
  const text = files(target).filter((f) => !/\.(otf|woff2?|png|jpg|zip)$/.test(f));
  for (const f of text) {
    const body = readFileSync(f, 'utf8');
    assert.doesNotMatch(body, /\{\{[A-Za-z]+\}\}/, `placeholder left in ${f}`);
  }
  assert.ok(existsSync(path.join(target, 'public/ds/copy/vale/AcmeWidgets.zip')), 'Vale zip not generated');
  assert.ok(existsSync(path.join(target, 'lib/tokens.test.ts')), 'test files not renamed');
  assert.equal(files(target).filter((f) => f.endsWith('.tmpl')).length, 0);
  assert.match(readFileSync(path.join(target, 'package.json'), 'utf8'), /"name": "acme-widgets-brand"/);
  assert.match(readFileSync(path.join(target, 'app/components/Wordmark.tsx'), 'utf8'), />Acme Widgets</);
  assert.match(readFileSync(path.join(target, 'AGENTS.md'), 'utf8'), /comes from `acme\/acme-web`\./);
});

test('a film source is named in the agent rules', () => {
  const dir = scratch();
  const target = path.join(dir, 'site');
  const r = run(['--target', target, '--config', withConfig(dir, { ...CONFIG, filmSource: 'acme/acme-film' })]);
  assert.equal(r.code, 0, r.err);
  assert.match(readFileSync(path.join(target, 'AGENTS.md'), 'utf8'), /`acme\/acme-web` \(the website\) and `acme\/acme-film` \(the film\)/);
});

test('a missing required key is refused with the key named, and nothing is written', () => {
  const dir = scratch();
  const target = path.join(dir, 'site');
  const { domain, ...rest } = CONFIG;
  const r = run(['--target', target, '--config', withConfig(dir, rest)]);
  assert.equal(r.code, 1);
  assert.match(r.err, /"domain"/);
  assert.equal(existsSync(target), false);
});

test('an unknown config key is refused with the key named', () => {
  const dir = scratch();
  const r = run(['--target', path.join(dir, 'site'), '--config', withConfig(dir, { ...CONFIG, colour: 'red' })]);
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown key "colour"/);
  assert.equal(existsSync(path.join(dir, 'site')), false);
});

test('a target that is not empty is refused and left as it was', () => {
  const dir = scratch();
  const target = path.join(dir, 'site');
  mkdirSync(target);
  writeFileSync(path.join(target, 'keep.txt'), 'mine');
  const r = run(['--target', target, '--config', withConfig(dir, CONFIG)]);
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`${target.replace(/[/.]/g, '\\$&')} is not empty`));
  assert.deepEqual(readdirSync(target), ['keep.txt']);
});

test('a placeholder the config cannot fill fails with the file and the key named', () => {
  const dir = scratch();
  const template = path.join(dir, 'template');
  mkdirSync(path.join(template, 'scripts/copy'), { recursive: true });
  writeFileSync(path.join(template, 'page.md'), 'Hello {{mystery}}\n');
  writeFileSync(path.join(template, 'scripts/copy/vale.mjs'), '');
  const r = run(['--target', path.join(dir, 'site'), '--config', withConfig(dir, CONFIG), '--template', template]);
  assert.equal(r.code, 1);
  assert.match(r.err, /page\.md: \{\{mystery\}\}/);
  assert.equal(existsSync(path.join(dir, 'site')), false);
});

// Review findings: each test below failed before the fix it names.

function tinyTemplate(dir, vale = '') {
  const template = path.join(dir, 'template');
  mkdirSync(path.join(template, 'scripts/copy'), { recursive: true });
  writeFileSync(path.join(template, 'scripts/copy/vale.mjs'), vale);
  writeFileSync(path.join(template, 'page.md'), '# {{name}}\n');
  return template;
}

test('a value with a character that breaks JSON, JSX or Markdown is refused with the key named', () => {
  const dir = scratch();
  const r = run(['--target', path.join(dir, 'site'), '--config', withConfig(dir, { ...CONFIG, name: 'Acme "Best" Widgets' })]);
  assert.equal(r.code, 1);
  assert.match(r.err, /"name" .*cannot hold/);
  assert.equal(existsSync(path.join(dir, 'site')), false);
});

test('a name with no plain letters needs slug and style, and a bad slug is refused', () => {
  const dir = scratch();
  let r = run(['--target', path.join(dir, 'site'), '--config', withConfig(dir, { ...CONFIG, name: 'Café Ölü' })]);
  assert.equal(r.code, 1);
  assert.match(r.err, /"slug" and "style"/);
  r = run(['--target', path.join(dir, 'site'), '--config', withConfig(dir, { ...CONFIG, slug: 'Acme Brand' })]);
  assert.equal(r.code, 1);
  assert.match(r.err, /"slug" must be/);
});

test('a config that is not an object, or a target that is a file, is refused by name', () => {
  const dir = scratch();
  writeFileSync(path.join(dir, 'null.json'), 'null');
  let r = run(['--target', path.join(dir, 'site'), '--config', path.join(dir, 'null.json')]);
  assert.equal(r.code, 1);
  assert.match(r.err, /null\.json must hold one JSON object/);
  writeFileSync(path.join(dir, 'file'), 'x');
  r = run(['--target', path.join(dir, 'file'), '--config', withConfig(dir, CONFIG)]);
  assert.equal(r.code, 1);
  assert.match(r.err, /file is not a folder/);
});

test('ignored build output is not copied, and other bytes are copied unchanged', () => {
  const dir = scratch();
  const template = tinyTemplate(dir);
  writeFileSync(path.join(template, '.gitignore'), '.next/\n*.tsbuildinfo\nnode_modules/\n');
  mkdirSync(path.join(template, '.next/cache'), { recursive: true });
  writeFileSync(path.join(template, '.next/cache/a.pack'), 'x');
  writeFileSync(path.join(template, 'tsconfig.tsbuildinfo'), 'x');
  mkdirSync(path.join(template, 'node_modules/.bin'), { recursive: true });
  symlinkSync(path.join(template, 'missing'), path.join(template, 'node_modules/.bin/dangling'));
  const bytes = Buffer.from([0x89, 0x00, 0xff, 0xfe, 0x7b, 0x7b]);
  writeFileSync(path.join(template, 'data.bin'), bytes);
  const target = path.join(dir, 'site');
  const r = run(['--target', target, '--config', withConfig(dir, CONFIG), '--template', template]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readdirSync(target, { recursive: true }).sort(), ['.gitignore', 'data.bin', 'page.md', 'scripts', 'scripts/copy', 'scripts/copy/vale.mjs']);
  assert.deepEqual(readFileSync(path.join(target, 'data.bin')), bytes);
});

test('when the Vale step fails, its output is shown and the target is not created', () => {
  const dir = scratch();
  const template = tinyTemplate(dir, 'console.error("banned.json is broken"); process.exit(3);\n');
  const target = path.join(dir, 'site');
  const r = run(['--target', target, '--config', withConfig(dir, CONFIG), '--template', template]);
  assert.equal(r.code, 1);
  assert.match(r.err, /exit 3/);
  assert.match(r.err, /banned\.json is broken/);
  assert.equal(existsSync(target), false);
  assert.deepEqual(readdirSync(dir).sort(), ['brand.json', 'template']);
});
