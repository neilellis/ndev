#!/usr/bin/env node
// Make a brand site from the plugin's brand-site template.
//
//   node scaffold.mjs --target <empty or new folder> --config <brand.json> [--template <folder>]
//
// brand.json gives the project's identity (see KEYS). The script fills every {{key}} in the
// template, restores the template's test files (*.test.ts.tmpl -> *.test.ts) and builds the
// Vale style. It builds the site in a staging folder beside the target and moves it into place
// only when every step passed, so a refusal or a failure leaves the target unchanged.
// Files that the template's .gitignore names (build output, dependencies) are not copied.
// Exit 0: made. Exit 1: refused or failed; stderr names each cause.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATE = path.resolve(HERE, '../../../templates/brand-site');

// Required keys, then optional keys that have a derived default.
const REQUIRED = {
  name: 'the brand name, exactly as written, for example "Acme Widgets"',
  product: 'the main product name; use the brand name when there is none',
  domain: 'the public domain, for example "acme.example"',
  siteUrl: 'the URL the brand site will have, for example "https://brand.acme.example"',
  repo: 'the brand site repository or folder, for example "acme/acme-brand" or "acme/app (apps/brand)"',
  sourceRepo: 'the repository the brand comes from, for example "acme/acme-web"',
  source: 'the short name of that source, used in provenance lines, for example "acme-web"',
};
const OPTIONAL = ['filmSource', 'nameSpoken', 'domainSpoken', 'slug', 'style'];
// Values go into JSON, JSX attributes, MDX and Markdown code spans without escaping.
const UNSAFE = /["\\<>{}`\u0000-\u001f]/;
const SLUG = /^[a-z0-9][a-z0-9._-]*$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const PLACEHOLDER = /\{\{([A-Za-z]+)\}\}/g;

function fail(lines) {
  for (const line of [].concat(lines)) console.error(`brand scaffold: ${line}`);
  process.exit(1);
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!['--target', '--config', '--template'].includes(flag)) fail(`unknown argument "${flag}". Usage: scaffold.mjs --target <folder> --config <brand.json> [--template <folder>]`);
    if (argv[i + 1] === undefined) fail(`${flag} needs a value`);
    out[flag.slice(2)] = path.resolve(argv[i + 1]);
  }
  for (const need of ['target', 'config']) if (!out[need]) fail(`--${need} is required`);
  return out;
}

function values(configFile) {
  let config;
  try {
    config = JSON.parse(readFileSync(configFile, 'utf8'));
  } catch (error) {
    fail(`cannot read ${configFile}: ${error.message}`);
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) fail(`${configFile} must hold one JSON object, such as { "name": "Acme Widgets", … }`);
  const problems = [];
  for (const key of Object.keys(config)) {
    if (!(key in REQUIRED) && !OPTIONAL.includes(key)) problems.push(`unknown key "${key}" in ${configFile}. The keys are ${[...Object.keys(REQUIRED), ...OPTIONAL].join(', ')}`);
    else if (typeof config[key] !== 'string' || !config[key].trim()) problems.push(`"${key}" in ${configFile} must be a non-empty string`);
    else if (UNSAFE.test(config[key])) problems.push(`"${key}" in ${configFile} cannot hold " \\ < > { } \` or a control character; got ${JSON.stringify(config[key])}`);
  }
  for (const [key, meaning] of Object.entries(REQUIRED)) if (!(key in config)) problems.push(`"${key}" is missing from ${configFile}: ${meaning}`);
  if (problems.length) fail(problems);

  // slug and style are made from the name's plain letters, so a name with others must give both.
  if (/[^\x20-\x7e]/.test(config.name) && !(config.slug && config.style)) {
    fail(`"name" ${JSON.stringify(config.name)} has letters outside A to Z, so give "slug" and "style" (for example "acme-brand" and "Acme") in ${configFile}`);
  }
  const words = config.name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const v = {
    ...config,
    nameSpoken: config.nameSpoken ?? config.name,
    domainSpoken: config.domainSpoken ?? config.domain.replaceAll('.', ' dot '),
    slug: config.slug ?? `${words.join('-').toLowerCase()}-brand`,
    style: config.style ?? (words.join('') || 'House'),
    initials: words.slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?',
    // Width of the text wordmark's viewBox: about 0.56em for each character at 64px.
    wordmarkWidth: String(Math.ceil(config.name.length * 36) + 8),
    filmSource: config.filmSource ?? 'no film yet',
    filmClause: config.filmSource ? ` (the website) and \`${config.filmSource}\` (the film)` : '',
  };
  if (!SLUG.test(v.slug)) fail(`"slug" must be a package name: lower-case letters, digits, ".", "_" and "-", starting with a letter or digit; got "${v.slug}"`);
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(v.style)) fail(`"style" must be letters and digits, starting with a letter (it names the Vale style): got "${v.style}"`);
  return v;
}

// The template's .gitignore as a test on one path segment: "dir/", "*.ext", "name*" and "name".
function ignored(template) {
  const file = path.join(template, '.gitignore');
  const globs = existsSync(file) ? readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : [];
  const res = globs.map((g) => new RegExp(`^${g.replace(/^\/|\/$/g, '').replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`));
  return (name) => name === 'node_modules' || name === '.git' || res.some((re) => re.test(name));
}

function walk(dir, skip, root = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, skip, root));
    else if (entry.isFile()) out.push(full);
    else fail(`${full} in the template is not a file or a folder (a link?). Replace it with a file, or add it to ${root}/.gitignore`);
  }
  return out;
}

const opts = args(process.argv.slice(2));
const template = opts.template ?? DEFAULT_TEMPLATE;
if (!existsSync(path.join(template, 'scripts/copy/vale.mjs'))) fail(`${template} is not a brand-site template: scripts/copy/vale.mjs is missing`);
if (existsSync(opts.target) && !statSync(opts.target).isDirectory()) fail(`${opts.target} is not a folder. Choose a new folder for the brand site`);
if (existsSync(opts.target) && readdirSync(opts.target).length) fail(`${opts.target} is not empty. Choose a new folder, or move its files away first`);
const v = values(opts.config);

// Fill every file in memory first, so a leftover placeholder writes nothing.
const out = [];
const leftovers = [];
for (const file of walk(template, ignored(template))) {
  const rel = path.relative(template, file).replace(/\.test\.ts\.tmpl$/, '.test.ts');
  const bytes = readFileSync(file);
  let text;
  try {
    text = UTF8.decode(bytes);
  } catch {
    out.push([rel, bytes, file]);
    continue;
  }
  const body = text.replace(PLACEHOLDER, (whole, key) => (key in v ? v[key] : whole));
  for (const [, key] of body.matchAll(PLACEHOLDER)) leftovers.push(`${rel}: {{${key}}} has no value. Add "${key}" to the config, or remove it from the template`);
  out.push([rel, body, file]);
}
if (leftovers.length) fail(leftovers);

mkdirSync(path.dirname(opts.target), { recursive: true });
const stage = mkdtempSync(path.join(path.dirname(opts.target), `.${path.basename(opts.target)}-scaffold-`));
for (const [rel, body, src] of out) {
  const dest = path.join(stage, rel);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, body, { mode: statSync(src).mode });
}

const vale = spawnSync(process.execPath, ['scripts/copy/vale.mjs', '--write'], { cwd: stage, encoding: 'utf8' });
if (vale.status !== 0) {
  rmSync(stage, { recursive: true, force: true });
  fail([`"node scripts/copy/vale.mjs --write" failed (exit ${vale.status}), so ${opts.target} was not made:`, (vale.stderr || vale.stdout || String(vale.error)).trim(),
    `Fix scripts/copy/vale.mjs or public/ds/copy/banned.json in ${template}, then run the scaffold again`]);
}
if (existsSync(opts.target)) rmdirSync(opts.target);
renameSync(stage, opts.target);
console.log(JSON.stringify({ target: opts.target, files: out.length, style: v.style, slug: v.slug }));
