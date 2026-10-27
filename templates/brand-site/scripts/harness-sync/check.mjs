#!/usr/bin/env node
// Check harness parity for {{name}}.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const errors = [];
const skillRoots = ['.agents/skills', '.claude/skills'];

async function skillMap(relativeRoot) {
  const absoluteRoot = path.join(root, relativeRoot);
  let entries;
  try {
    entries = await readdir(absoluteRoot, { withFileTypes: true });
  } catch (error) {
    errors.push(`${relativeRoot}: cannot read skill tree (${error.message})`);
    return new Map();
  }
  const result = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      errors.push(`${relativeRoot}/${entry.name}: unexpected file; skills must be directories`);
      continue;
    }
    const skillPath = path.join(absoluteRoot, entry.name, 'SKILL.md');
    try {
      result.set(entry.name, await readFile(skillPath, 'utf8'));
      const files = await readdir(path.dirname(skillPath), { withFileTypes: true });
      for (const file of files) {
        const filePath = path.join(path.dirname(skillPath), file.name);
        const fileStat = await stat(filePath);
        if (file.isFile() && (fileStat.mode & 0o111) !== 0) {
          errors.push(`${path.relative(root, filePath)}: executable in skill tree; move it to scripts/`);
        }
      }
    } catch (error) {
      errors.push(`${relativeRoot}/${entry.name}/SKILL.md: missing or unreadable (${error.message})`);
    }
  }
  return result;
}

const [codexSkills, claudeSkills] = await Promise.all(skillRoots.map(skillMap));
for (const name of [...new Set([...codexSkills.keys(), ...claudeSkills.keys()])].sort()) {
  if (!codexSkills.has(name) || !claudeSkills.has(name)) {
    errors.push(`skill '${name}' exists in only one harness tree`);
  } else if (codexSkills.get(name) !== claudeSkills.get(name)) {
    errors.push(`skill '${name}' bodies differ; update both SKILL.md files`);
  }
}
for (const [left, right] of [['AGENTS.md', 'CLAUDE.md']]) {
  try {
    const [a, b] = await Promise.all([readFile(path.join(root, left), 'utf8'), readFile(path.join(root, right), 'utf8')]);
    if (a !== b) errors.push(`${left} and ${right} differ; keep repository rules aligned`);
  } catch (error) {
    errors.push(`repository rules missing or unreadable (${error.message})`);
  }
}

try {
  const rules = await readFile(path.join(root, 'CLAUDE.md'), 'utf8');
  const table = rules.split('## Skills')[1]?.split('\n## ')[0] ?? '';
  const named = [...table.matchAll(/^\|[^|]*\|(.*)\|\s*$/gm)].flatMap((m) => [...m[1].matchAll(/`([a-z0-9-]+)`/g)].map((n) => n[1]));
  if (!named.length) errors.push('CLAUDE.md: Skills table is missing or names no skills');
  for (const name of named) {
    if (!claudeSkills.has(name)) errors.push(`CLAUDE.md names skill '${name}', which does not exist`);
  }
  for (const name of claudeSkills.keys()) {
    if (!named.includes(name)) errors.push(`skill '${name}' is not listed in the CLAUDE.md Skills table`);
  }
} catch (error) {
  errors.push(`CLAUDE.md: cannot check the Skills table (${error.message})`);
}

if (errors.length) {
  for (const error of errors) console.error(`harness-sync: ${error}`);
  process.exitCode = 1;
} else {
  console.log(`harness-sync: ${codexSkills.size} skill bodies and repository rules agree`);
}
