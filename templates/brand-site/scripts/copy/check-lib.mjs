// Shared copy checker for the {{name}} banned list in public/ds/copy/banned.json.
// Used by scripts/copy/check.mjs and tests/copy.test.ts.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RULES_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/ds/copy/banned.json');
export const LEVELS = ['ban', 'flag'];
export const REGISTERS = ['internal', 'marketing', 'documentation', 'technical-documentation', 'agent'];
export const PROSE_EXTENSIONS = ['.md', '.mdx', '.txt', '.html'];

export function loadRules(file = RULES_PATH) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

// Replace a match with spaces, keeping newlines so line numbers stay correct.
const blank = (s) => s.replace(/[^\n]/g, ' ');

// Keep only the text a reader sees. Code, link targets, quoted examples and
// regions between copy-check markers are not checked.
export function proseOf(text) {
  return text
    .replace(/(?:\{\/\*|<!--)\s*copy-check:\s*off\s*(?:\*\/\}|-->)[\s\S]*?(?:\{\/\*|<!--)\s*copy-check:\s*on\s*(?:\*\/\}|-->)/g, blank)
    .replace(/^(?:---\n[\s\S]*?\n---\n)/, blank)
    .replace(/```[\s\S]*?```/g, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/^(?:import|export) .*$/gm, blank)
    .replace(/\]\([^)\s]*\)/g, blank)
    .replace(/https?:\/\/\S+/g, blank)
    .replace(/style=\{\{[^}]*\}\}/g, blank)
    .replace(/“[^”]*”/g, blank)
    .replace(/<\/?[A-Za-z][^<>]*?>/g, (tag) => {
      const values = [...tag.matchAll(/\b(?:alt|caption|label|title|description)="([^"]*)"/g)].map((m) => m[1]).join(' ');
      return values.padEnd(tag.length, ' ').slice(0, tag.length).replace(/[^\n]/g, (c, i) => (tag[i] === '\n' ? '\n' : c));
    });
}

// Regions that hold marketing copy inside another file: <Demo> blocks, and
// text between copy-check: marketing and copy-check: on markers. The marketing
// register applies there.
const MARKETING = /<Demo\b[\s\S]*?<\/Demo>|(?:\{\/\*|<!--)\s*copy-check:\s*marketing\s*(?:\*\/\}|-->)[\s\S]*?(?:\{\/\*|<!--)\s*copy-check:\s*on\s*(?:\*\/\}|-->)/g;

export function checkText(text, { register = 'documentation', rules = loadRules() } = {}) {
  if (!REGISTERS.includes(register)) throw new Error(`unknown register '${register}'; use one of ${REGISTERS.join(', ')}`);
  const prose = proseOf(text);
  const lineAt = (index) => prose.slice(0, index).split('\n').length;
  const marketing = [...text.matchAll(MARKETING)].map((m) => [m.index, m.index + m[0].length]);
  const registerAt = (i) => (marketing.some(([a, b]) => i >= a && i < b) ? 'marketing' : register);
  const findings = [];
  for (const word of rules.words) {
    const re = new RegExp(word.pattern, word.caseSensitive ? 'gu' : 'giu');
    for (const m of prose.matchAll(re)) {
      const at = registerAt(m.index);
      if (word.registers && !word.registers.includes(at)) continue;
      if (word.allow?.includes(at)) continue;
      findings.push({ line: lineAt(m.index), level: word.level, term: word.term, match: m[0], instead: word.instead, group: word.group });
    }
  }
  for (const c of rules.constructions) {
    if (!c.pattern) continue;
    for (const m of prose.matchAll(new RegExp(c.pattern, 'giu'))) {
      findings.push({ line: lineAt(m.index), level: 'flag', term: c.name, match: m[0], instead: c.fix, group: 'construction' });
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

export function validateRules(rules) {
  const errors = [];
  const groups = new Set(rules.groups.map((g) => g.id));
  const sources = new Set(Object.keys(rules.sources));
  const seen = new Set();
  for (const w of rules.words) {
    const id = `word '${w.term}'`;
    if (seen.has(w.term)) errors.push(`${id} is listed twice`);
    seen.add(w.term);
    if (!groups.has(w.group)) errors.push(`${id} has unknown group '${w.group}'`);
    if (!sources.has(w.source)) errors.push(`${id} has unknown source '${w.source}'`);
    if (!LEVELS.includes(w.level)) errors.push(`${id} has unknown level '${w.level}'`);
    if (!w.instead) errors.push(`${id} has no replacement advice`);
    for (const r of [...(w.registers ?? []), ...(w.allow ?? [])]) if (!REGISTERS.includes(r)) errors.push(`${id} has unknown register '${r}'`);
    try { new RegExp(w.pattern, 'giu'); } catch (e) { errors.push(`${id} has an invalid pattern (${e.message})`); }
  }
  for (const c of rules.constructions) {
    if (!c.id || !c.name || !c.example || !c.fix) errors.push(`construction '${c.id ?? c.name}' is missing a field`);
    if (!sources.has(c.source)) errors.push(`construction '${c.id}' has unknown source '${c.source}'`);
    if (c.pattern) { try { new RegExp(c.pattern, 'giu'); } catch (e) { errors.push(`construction '${c.id}' has an invalid pattern (${e.message})`); } }
  }
  return errors;
}
