#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const SECTIONS = ["Context", "Decision", "Considered options", "Consequences"];
const FIELDS = ["Status", "Date", "Decided by", "Source", "Issue"];
const KINDS = {
  adr: { dir: "docs/adr", last: "Related PDR", lastDefault: "none" },
  pdr: { dir: "docs/pdr", last: "Requirement changed", lastDefault: "" },
};
const NAME = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const STATUS = /^(Proposed|Accepted|Superseded by (\d{4}))$/;
const COMMANDS = "list, search, new, check";

class Usage extends Error {}
class Failure extends Error {}

function parseArguments(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const value = argv[++i];
      if (value === undefined) throw new Usage(`${argv[i - 1]} needs a value`);
      options[argv[i - 1].slice(2)] = value;
    } else positional.push(argv[i]);
  }
  return { positional, options };
}

function findRoot(options) {
  if (options.root) return path.resolve(options.root);
  const out = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (out.status !== 0) throw new Failure(`Not inside a git repository: git rev-parse exited ${out.status}: ${out.stderr.trim()}. Run from the project, or pass --root <dir>.`);
  return out.stdout.trim();
}

function kindsFor(name) {
  if (name === undefined) return Object.keys(KINDS);
  if (!KINDS[name]) throw new Usage(`Unknown kind "${name}": use adr or pdr`);
  return [name];
}

function entries(root, kind) {
  const dir = path.join(root, KINDS[kind].dir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith(".md") && d.name !== "README.md").map((d) => d.name).sort().map((file) => ({ kind, file, rel: `${KINDS[kind].dir}/${file}`, full: path.join(dir, file) }));
}

function read(entry) {
  const text = readFileSync(entry.full, "utf8");
  const field = (name) => text.match(new RegExp(`^- ${name}:[ \\t]*(.*)$`, "m"))?.[1].trim();
  const title = text.match(/^# (.+)$/m)?.[1];
  return { ...entry, text, field, status: field("Status"), title: title ?? entry.file };
}

function sectionBody(text, name) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${name}`);
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}

function list(root, kindName) {
  const records = kindsFor(kindName).flatMap((k) => entries(root, k)).map(read);
  if (!records.length) return `No records in ${kindsFor(kindName).map((k) => KINDS[k].dir).join(" or ")}\n`;
  const width = Math.max(...records.map((r) => r.rel.length));
  return records.map((r) => `${r.rel.padEnd(width)}  ${r.status ?? "NO STATUS"}  ${r.title}`).join("\n") + "\n";
}

function search(root, terms, kindName) {
  if (!terms.length) throw new Usage("search needs at least one term");
  const records = kindsFor(kindName).flatMap((k) => entries(root, k)).map(read);
  const wanted = terms.map((t) => t.toLowerCase());
  const hits = records.filter((r) => wanted.every((t) => `${r.file}\n${r.text}`.toLowerCase().includes(t)));
  const label = `searched ${records.length} record${records.length === 1 ? "" : "s"}`;
  if (!hits.length) return `No record matches ${terms.map((t) => `"${t}"`).join(" ")} (${label})\n`;
  return hits.map((r) => `${r.rel}  ${r.status ?? "NO STATUS"}  ${r.title}`).join("\n") + `\n(${label})\n`;
}

function slug(sentence) {
  const words = sentence.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return words.length <= 80 ? words : words.slice(0, 80).replace(/-[^-]*$/, "");
}

function template(kind, title, issue, today) {
  const { last, lastDefault } = KINDS[kind];
  const lines = [`- Status: Proposed`, `- Date: ${today}`, `- Decided by:`, `- Source:`, `- Issue: ${issue ?? ""}`.trimEnd(), `- ${last}: ${lastDefault}`.trimEnd()];
  return `# ${title}\n\n${lines.join("\n")}\n` + SECTIONS.map((s) => `\n## ${s}\n`).join("");
}

function create(root, kind, sentence, issue) {
  if (!KINDS[kind]) throw new Usage(`Unknown kind "${kind}": use adr or pdr`);
  const title = (sentence ?? "").trim();
  if (!title || !slug(title)) throw new Usage(`new needs the ${kind.toUpperCase()} as a sentence, for example: new ${kind} "Sessions live in Redis"`);
  const existing = entries(root, kind);
  const bad = existing.find((e) => !NAME.test(e.file));
  if (bad) throw new Failure(`${bad.rel} does not match NNNN-<sentence>.md, so the next number is unknown. Rename it, or run check.`);
  const next = String(Math.max(0, ...existing.map((e) => Number(e.file.slice(0, 4)))) + 1).padStart(4, "0");
  const full = path.join(root, KINDS[kind].dir, `${next}-${slug(title)}.md`);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, template(kind, title, issue, new Date().toISOString().slice(0, 10)), { flag: "wx" });
  return `${full}\n`;
}

function check(root) {
  const problems = [];
  let count = 0;
  for (const kind of Object.keys(KINDS)) {
    const all = entries(root, kind);
    const numbers = new Map();
    const named = [];
    for (const entry of all) {
      if (!NAME.test(entry.file)) {
        problems.push(`${entry.rel}: file name does not match NNNN-<sentence>.md (lowercase words joined by hyphens). Rename it.`);
        continue;
      }
      named.push(entry);
      const number = entry.file.slice(0, 4);
      numbers.set(number, [...(numbers.get(number) ?? []), entry.rel]);
    }
    for (const [number, files] of numbers) if (files.length > 1) problems.push(`duplicate number ${number}: ${files.join(", ")}. Numbers are never reused: renumber the newer file.`);
    for (const entry of named) {
      count++;
      const record = read(entry);
      if (record.status === undefined && record.text.includes("**Status:**")) {
        problems.push(`${entry.rel}: old format ("**Status:**" line). Rewrite it to the template in kb/adr.md: "- Status:", "- Date:", "- Decided by:", "- Source:", "- Issue:" lines and the sections Context, Decision, Considered options, Consequences. Keep the decision and its reasons.`);
        continue;
      }
      if (!record.text.match(/^# .+$/m)) problems.push(`${entry.rel}: no "# <the decision, as a sentence>" title.`);
      if (record.status === undefined) problems.push(`${entry.rel}: no "- Status:" line. Add "- Status: Proposed".`);
      else {
        if (!STATUS.test(record.status)) problems.push(`${entry.rel}: status "${record.status}" is not Proposed, Accepted or Superseded by NNNN.`);
        const by = record.status.match(/^Superseded by (\d{4})$/)?.[1];
        if (by && by === entry.file.slice(0, 4)) problems.push(`${entry.rel}: ${record.status} names itself. Name the record that replaces it.`);
        else if (by && !numbers.has(by)) problems.push(`${entry.rel}: ${record.status}, which does not exist in ${KINDS[kind].dir}.`);
        else if (by && by < entry.file.slice(0, 4)) problems.push(`${entry.rel}: ${record.status}, which is older. A replacement is a new record with a higher number.`);
      }
      const proposed = record.status === "Proposed";
      const date = record.field("Date");
      if (date === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date)) problems.push(`${entry.rel}: "- Date:" needs YYYY-MM-DD (got "${date ?? "no line"}").`);
      for (const name of [...FIELDS.slice(2), KINDS[kind].last]) {
        const value = record.field(name);
        if (value === undefined) problems.push(`${entry.rel}: no "- ${name}:" line. The template is in the skill.`);
        else if (!value && !proposed) problems.push(`${entry.rel}: "- ${name}:" has no value, and the status is ${record.status}. Fill it, or keep the status Proposed.`);
      }
      for (const section of SECTIONS) {
        const body = sectionBody(record.text, section);
        if (body === undefined) problems.push(`${entry.rel}: missing the section "## ${section}".`);
        else if (!body && !proposed) problems.push(`${entry.rel}: the section "## ${section}" is empty, and the status is ${record.status}. Fill it, or keep the status Proposed.`);
      }
    }
  }
  if (problems.length) throw new Failure(problems.join("\n"));
  return `${count} records checked: no problems\n`;
}

try {
  const { positional, options } = parseArguments(process.argv.slice(2));
  const [command, ...rest] = positional;
  const root = () => findRoot(options);
  const commands = {
    list: () => list(root(), rest[0]),
    search: () => search(root(), rest, options.kind),
    new: () => create(root(), rest[0], rest[1], options.issue),
    check: () => check(root()),
  };
  if (!commands[command]) throw new Usage(`Unknown command "${command ?? ""}": use ${COMMANDS}`);
  process.stdout.write(commands[command]());
} catch (error) {
  if (!(error instanceof Usage || error instanceof Failure)) throw error;
  process.stderr.write(`records: ${error.message}\n`);
  process.exitCode = error instanceof Usage ? 2 : 1;
}
