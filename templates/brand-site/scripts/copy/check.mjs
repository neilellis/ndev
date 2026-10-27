#!/usr/bin/env node
// Check prose against the {{name}} banned list.
//   node scripts/copy/check.mjs [--register <register>] <file>... | -
// The register is internal, marketing, documentation (the default),
// technical-documentation or agent.
// Exit codes: 0 no banned words, 1 banned words found, 2 nothing was checked.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { checkText, PROSE_EXTENSIONS, REGISTERS } from './check-lib.mjs';

const args = process.argv.slice(2);
const usage = `usage: node scripts/copy/check.mjs [--register ${REGISTERS.join('|')}] <file>... | -`;
let register = 'documentation';
const at = args.indexOf('--register');
if (at !== -1) {
  register = args[at + 1];
  args.splice(at, 2);
  if (!REGISTERS.includes(register)) { console.error(`copy-check: unknown register '${register}'\n${usage}`); process.exit(2); }
}
const files = args;
if (!files.length || files.some((f) => f.startsWith('--'))) {
  console.error(usage);
  process.exit(2);
}

const inputs = [];
for (const file of files) {
  if (file === '-') { inputs.push(['stdin', readFileSync(0, 'utf8')]); continue; }
  if (!existsSync(file)) { console.error(`copy-check: no such file: ${file} (nothing was checked; this is not a pass)`); process.exit(2); }
  if (!PROSE_EXTENSIONS.includes(path.extname(file))) { console.error(`copy-check: ${file} is not ${PROSE_EXTENSIONS.join(', ')}; pass the text on stdin instead`); process.exit(2); }
  inputs.push([file, readFileSync(file, 'utf8')]);
}

let bans = 0;
let flags = 0;
for (const [name, text] of inputs) {
  for (const f of checkText(text, { register })) {
    if (f.level === 'ban') bans++; else flags++;
    console.log(`${name}:${f.line}: ${f.level === 'ban' ? 'BANNED' : 'check '} “${f.match}” (${f.term}) → ${f.instead}`);
  }
}
console.log(`copy-check: ${inputs.length} file(s), ${bans} banned, ${flags} to check by eye (${register} register)`);
process.exit(bans ? 1 : 0);
