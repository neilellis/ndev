#!/usr/bin/env node
// Check a project against its brand site, and optionally fix what is mechanical.
//
//   node audit.mjs --brand <brand site folder> [--fix] [--json] [--register <register>] <project folder>
//
// Reads the brand's tokens from <brand>/public/ds/tokens/*.css and its banned list through
// <brand>/scripts/copy/check-lib.mjs. Reports, with file and line:
//   colour-literal    a colour that equals a token; use var(--token). --fix does this in stylesheets.
//   off-brand-colour  a colour that is not in the brand; the nearest token is named.
//   off-brand-font    a font family that the type tokens do not name.
//   banned-word       a banned word in prose (error); a flagged word or construction (warning).
//   brand-unfinished  the brand site still has BRAND-TODO.md (warning).
// Prose is judged in the "documentation" register unless --register names another.
// Colours: #hex, rgb() and rgba(), with or without transparency. Not checked: hsl(), oklch(),
// named colours and the font shorthand. In scripts, only colours inside strings count. --fix
// rewrites plain .css only; Sass and Less colour maths needs real colours, so those are reported.
// Not checked: dependencies, build output, agent folders, nested worktrees and *.min.* files.
// A linked file is checked; a linked folder is not followed, and is reported as a warning.
// Exit 0: no errors. Exit 1: errors. Exit 2: nothing checked, the brand cannot be read, or a crash.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const STYLES = ['.css', '.scss', '.sass', '.less'];
const SCRIPTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
// Single-file components hold markup and <style> blocks, so they are read like stylesheets.
const COMPONENTS = ['.vue', '.svelte', '.astro'];
const PROSE = ['.md', '.mdx', '.txt', '.html'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', '.vercel', '.turbo', '.cache', 'vendor', '.worktrees', '.claude', '.agents']);
const GENERIC_FONTS = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'emoji', 'math', 'fangsong',
  'inherit', 'initial', 'unset', 'revert', 'revert-layer', '-apple-system', 'blinkmacsystemfont']);
const CHANNEL = String.raw`\s*[\d.]+%?\s*`;
const COLOUR = new RegExp(String.raw`#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|rgba?\(${CHANNEL}[,\s]${CHANNEL}[,\s]${CHANNEL}(?:[,/]${CHANNEL})?\)`, 'g');

process.on('uncaughtException', (error) => {
  console.error(`brand audit: crashed, so nothing is reported: ${error.stack}`);
  process.exit(2);
});

function stop(lines) {
  for (const line of [].concat(lines)) console.error(`brand audit: ${line}`);
  process.exit(2);
}

function read(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    stop(`cannot read ${file}: ${error.code ?? error.message}. Fix its permissions, or move it out of the project`);
  }
}

function parseArgs(argv) {
  const opts = { fix: false, json: false, register: 'documentation' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fix') opts.fix = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--register') opts.register = argv[++i] ?? stop('--register needs a value');
    else if (a === '--brand') opts.brand = path.resolve(argv[++i] ?? stop('--brand needs a folder'));
    else if (a.startsWith('--')) stop(`unknown argument "${a}". Usage: audit.mjs --brand <brand site folder> [--fix] [--json] [--register <register>] <project folder>`);
    else if (opts.project) stop(`one project folder only; got "${opts.project}" and "${a}"`);
    else opts.project = path.resolve(a);
  }
  if (!opts.brand) stop('--brand is required: the brand site folder ("branding.path" in .neil-dev.json)');
  opts.project ??= process.cwd();
  if (!existsSync(opts.project) || !statSync(opts.project).isDirectory()) stop(`${opts.project} is not a folder. Give the project root`);
  return opts;
}

// A colour literal to { rgb: "#rrggbb", alpha: 0..1 }; null when it is not a colour.
function parse(literal) {
  let m = literal.match(/^#([0-9a-f]+)$/i);
  if (m) {
    let h = m[1].toLowerCase();
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    return { rgb: `#${h.slice(0, 6)}`, alpha: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1 };
  }
  m = literal.match(/^rgba?\(\s*([\d.]+)(%?)\s*[,\s]\s*([\d.]+)(%?)\s*[,\s]\s*([\d.]+)(%?)\s*(?:[,/]\s*([\d.]+)(%?)\s*)?\)$/i);
  if (!m) return null;
  const channel = (n, pct) => Math.min(255, Math.round(pct ? Number(n) * 2.55 : Number(n)));
  const rgb = [[m[1], m[2]], [m[3], m[4]], [m[5], m[6]]].map(([n, pct]) => channel(n, pct).toString(16).padStart(2, '0'));
  const alpha = m[7] === undefined ? 1 : Math.min(1, Number(m[7]) / (m[8] ? 100 : 1));
  return { rgb: `#${rgb.join('')}`, alpha };
}

function distance(a, b) {
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [rgb(a), rgb(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

function readBrand(brand) {
  const dir = path.join(brand, 'public/ds/tokens');
  const repair = 'Run "/brand create" to make the brand site, or set "branding.path" in .neil-dev.json to its folder';
  if (!existsSync(dir)) stop([`${brand} has no public/ds/tokens folder, so it is not a brand site.`, repair]);
  // Every declaration counts: a token set again for dark mode or a theme adds a value.
  const tokens = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.css')).sort()) {
    for (const m of read(path.join(dir, file)).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens.push([m[1], m[2].trim()]);
  }
  // Primitive colour values only: a semantic token that points at another (var(--…)) is not a value.
  const colours = new Map();
  for (const [name, value] of tokens) {
    const c = parse(value);
    if (c && c.alpha === 1 && !colours.has(c.rgb)) colours.set(c.rgb, name);
  }
  // Lower-case name to the name as the tokens write it.
  const fonts = new Map();
  for (const [name, value] of tokens) {
    if (!name.startsWith('--font')) continue;
    for (const f of familyNames(value)) fonts.set(f.toLowerCase(), f);
  }
  if (!colours.size) stop([`${dir} defines no colour token.`, repair]);
  const lib = path.join(brand, 'scripts/copy/check-lib.mjs');
  const rules = path.join(brand, 'public/ds/copy/banned.json');
  if (!existsSync(lib) || !existsSync(rules)) stop([`${brand} has no copy checker (scripts/copy/check-lib.mjs and public/ds/copy/banned.json).`, repair]);
  return { colours, fonts, lib, rules, unfinished: existsSync(path.join(brand, 'BRAND-TODO.md')) };
}

function familyNames(value) {
  return value.replace(/!important/gi, '').split(',').map((f) => f.trim().replace(/^["'`]|["'`]$/g, '').trim())
    .filter((f) => f && !f.startsWith('var(') && !/[{}$]/.test(f) && !GENERIC_FONTS.has(f.toLowerCase()) && !f.toLowerCase().startsWith('ui-'));
}

// The text with everything that cannot hold a colour value blanked to spaces, so offsets and
// line numbers stay the same. Stylesheets lose their comments; scripts keep only string contents.
function view(text, ext) {
  const out = [...text];
  const blank = (from, to) => { for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ' '; };
  if (!SCRIPTS.includes(ext)) {
    const comment = ext === '.css' ? /\/\*[\s\S]*?\*\//g : /\/\*[\s\S]*?\*\/|(?<![:\w])\/\/[^\n]*/g;
    for (const m of text.matchAll(comment)) blank(m.index, m.index + m[0].length);
    return out.join('');
  }
  let i = 0;
  let code = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === '"' || c === "'" || c === '`') {
      blank(code, i + 1);
      let j = i + 1;
      while (j < text.length && text[j] !== c && !(c !== '`' && text[j] === '\n')) j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
      code = j;
      continue;
    } else {
      i++;
      continue;
    }
    // A comment ends here: blank it with the code before it.
    blank(code, i);
    code = i;
  }
  blank(code, text.length);
  return out.join('');
}

function lineOf(text, at) {
  let n = 1;
  for (let i = 0; i < at; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function walk(root, skip, warnings) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    stop(`cannot read the folder ${root}: ${error.code ?? error.message}`);
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (SKIP_DIRS.has(entry.name) && !entry.isFile()) continue;
    if (entry.isSymbolicLink()) {
      let real;
      try {
        real = realpathSync(full);
      } catch {
        warnings.push([full, 'the link points at nothing, so it is not checked']);
        continue;
      }
      if (real === skip) continue;
      if (statSync(real).isFile()) {
        if (!/\.min\.\w+$/.test(entry.name)) out.push(full);
      } else warnings.push([full, `a linked folder is not followed; check ${real} on its own`]);
    } else if (entry.isDirectory()) {
      // A folder with a .git file is another worktree or repository: it is checked on its own.
      if (realpathSync(full) !== skip && !existsSync(path.join(full, '.git'))) out.push(...walk(full, skip, warnings));
    } else if (entry.isFile() && !/\.min\.\w+$/.test(entry.name)) out.push(full);
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
const brand = readBrand(opts.brand);
const { checkText, loadRules, REGISTERS } = await import(pathToFileURL(brand.lib).href);
if (!checkText || !loadRules || !REGISTERS) stop(`${brand.lib} does not export checkText, loadRules and REGISTERS. Copy scripts/copy/check-lib.mjs from the plugin's templates/brand-site`);
if (!REGISTERS.includes(opts.register)) stop(`unknown register '${opts.register}'; use one of ${REGISTERS.join(', ')}`);
const rules = loadRules(brand.rules);
const fontList = [...brand.fonts.values()].join(', ');

const findings = [];
let fixed = 0;
let checked = 0;
if (brand.unfinished) {
  findings.push({ file: path.relative(opts.project, path.join(opts.brand, 'BRAND-TODO.md')), line: 1, kind: 'brand-unfinished', severity: 'warning',
    message: 'the brand site still has defaults from the template; work through BRAND-TODO.md' });
}

const skip = realpathSync(opts.brand);
const linkWarnings = [];
for (const file of walk(opts.project, skip, linkWarnings)) {
  const ext = path.extname(file);
  const rel = path.relative(opts.project, file);
  if (PROSE.includes(ext)) {
    checked++;
    for (const f of checkText(read(file), { rules, register: opts.register })) {
      findings.push({ file: rel, line: f.line, kind: 'banned-word', severity: f.level === 'ban' ? 'error' : 'warning',
        message: `"${f.match}" (${f.term}): ${f.instead}` });
    }
  }
  if (!STYLES.includes(ext) && !SCRIPTS.includes(ext) && !COMPONENTS.includes(ext)) continue;
  checked++;
  const text = read(file);
  const seen = view(text, ext);
  const edits = [];
  for (const m of seen.matchAll(COLOUR)) {
    const [literal] = m;
    const at = m.index;
    const before = seen.slice(Math.max(0, at - 40), at);
    // Not a colour value: an ID selector, a fragment link, or "#" inside a name.
    if (/[\w.$-]$/.test(before) || /url\(\s*['"]?$/i.test(before) || /(?:href|to)\s*=\s*\{?\s*['"`]?$/.test(before)) continue;
    if (!SCRIPTS.includes(ext) && literal.startsWith('#') && /^[^;}]*\{/.test(seen.slice(at))) continue;
    const c = parse(literal);
    if (!c) continue;
    const line = lineOf(text, at);
    const token = brand.colours.get(c.rgb);
    // A custom property or a Sass or Less variable set to a brand value mirrors the token.
    const lineStart = text.lastIndexOf('\n', at - 1) + 1;
    if (token && c.alpha === 1 && /(?:--[\w-]+|[$@][\w-]+)['"]?\s*:[^;{}]*$/.test(text.slice(lineStart, at))) continue;
    if (!token) {
      const [near, name] = [...brand.colours].sort((a, b) => distance(c.rgb, a[0]) - distance(c.rgb, b[0]))[0];
      findings.push({ file: rel, line, kind: 'off-brand-colour', severity: 'error', message: `${literal} is not a brand colour; the nearest is ${name} (${near})` });
    } else if (c.alpha < 1) {
      const pct = Math.round(c.alpha * 100);
      findings.push({ file: rel, line, kind: 'colour-literal', severity: 'warning',
        message: `${literal} is ${token} with transparency; use color-mix(in srgb, var(${token}) ${pct}%, transparent)` });
    } else if (opts.fix && ext === '.css') {
      edits.push([at, literal.length, `var(${token})`]);
    } else {
      findings.push({ file: rel, line, kind: 'colour-literal', severity: 'error', message: `${literal} is ${token}; use var(${token})` });
    }
  }
  const fonts = SCRIPTS.includes(ext)
    ? text.matchAll(/font-?family['"]?\s*:\s*(['"`])((?:(?!\1)[^\n])*)\1/gi)
    : seen.matchAll(/font-family\s*:\s*()([^;}\n]+)/gi);
  for (const m of fonts) {
    for (const name of familyNames(m[2])) {
      if (!brand.fonts.has(name.toLowerCase())) {
        findings.push({ file: rel, line: lineOf(text, m.index), kind: 'off-brand-font', severity: 'error', message: `"${name}" is not a brand font; the brand fonts are ${fontList}` });
      }
    }
  }
  if (edits.length) {
    let next = text;
    for (const [at, length, value] of edits.reverse()) next = next.slice(0, at) + value + next.slice(at + length);
    try {
      writeFileSync(file, next);
    } catch (error) {
      stop(`cannot write ${file}: ${error.code ?? error.message}. Nothing else in it was changed`);
    }
    fixed += edits.length;
  }
}
for (const [file, message] of linkWarnings) findings.push({ file: path.relative(opts.project, file), line: 1, kind: 'skipped-link', severity: 'warning', message });

if (!checked) stop(`${opts.project} has no stylesheet, script or prose file to check (${[...STYLES, ...SCRIPTS, ...PROSE].join(' ')})`);
findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
const errors = findings.filter((f) => f.severity === 'error').length;
if (opts.json) {
  console.log(JSON.stringify({ checked, fixed, errors, findings }, null, 2));
} else {
  for (const f of findings) console.log(`${f.file}:${f.line} ${f.severity} ${f.kind}: ${f.message}`);
  console.log(`brand audit: ${checked} files checked, ${errors} errors, ${findings.length - errors} warnings${opts.fix ? `, ${fixed} colours fixed` : ''}`);
}
process.exitCode = errors ? 1 : 0;
