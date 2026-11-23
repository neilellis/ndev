#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const DIR = "docs/formal/requirements";
const HTML = `${DIR}/generated/requirements.html`;
const UP = "../".repeat(HTML.split("/").length - 1);
const NAME = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const STATUS = /^(Proposed|Accepted|Rejected|Retired|Superseded by (\d{4}))$/;
const STATUS_ORDER = ["Accepted", "Proposed", "Rejected", "Retired", "Superseded"];
const IN_FORCE = ["Proposed", "Accepted"];
const ORIGINS = ["explicit", "implied", "PR"];
const PULL = /^https:\/\/\S+\/pull\/\d+/;
const METHODS = ["test", "check", "model", "eval", "review"];
const SECTIONS = ["Statement", "Source text", "Trace", "Notes"];
const CITATION = /^(.+)#L(\d+)-L(\d+)$/;
const LINK = /\[([^\]]+)\]\(([^()\s]+(?:\([^()\s]*\)[^()\s]*)*)\)/g;
const FLAGS = new Set(["check"]);
const COMMANDS = "new, list, search, quote, check, render, guard, agree, sources, ledger, uncovered, untraced, link, narrate, narrative, publish";
const PUBLISH = `${DIR}/extra/publish.json`;
const PUBLISH_KEYS = ["to", "format", "source", "route", "frontMatter", "meta"];
const MANIFEST = ".published";
const INLINE_PART = /(`[^`]+`|\[[^\]]+\]\((?:<[^>\n]*>|[^()\s]+(?:\([^()\s]*\)[^()\s]*)*)\)|https?:\/\/[^\s<>()]+)/;
const OUTLINE = `${DIR}/extra/outline.md`;
const NARRATIVE = `${DIR}/generated/narrative`;
const REQ_ID = /\bREQ-\d{4}\b/g;
const PULL_URL = /^https:\/\/\S+\/pull\/\d+$/;
const ISSUE_URL = /^https:\/\/\S+\/issues\/\d+$/;
const TRACE_LINK = /^- (PR|Issue): (.*)$/;
const GH_PRS = "gh pr list --state merged --limit 1000 --json number,title,url,closingIssuesReferences";
const LEDGER = `${DIR}/extra/ledger.md`;
const LEDGER_ENTRY = /^- (.+)#L(\d+)-L(\d+) ([0-9a-f]{12}): (.+)$/;
const TIERS = [[1, "requirements"], [2, "wiki"], [3, "readme"], [4, "other"]];
const NORMATIVE = /\b(must|shall|should|never|always|required|requires?|cannot|may not|will not|refuses?|only)\b/i;
const AGREED = /^(.+), (\d{4}-\d{2}-\d{2}), text ([0-9a-f]{12})$/;
const AGREED_FORM = `"- Agreed: <name>, YYYY-MM-DD, text <hash>"`;
const PROTECTED = ["Statement", "Source text"];
const SCRIPT = "requirements.mjs";

class Usage extends Error {}
class Failure extends Error {}

function parseArguments(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) positional.push(argv[i]);
    else if (FLAGS.has(argv[i].slice(2))) options[argv[i].slice(2)] = true;
    else {
      const value = argv[++i];
      if (value === undefined) throw new Usage(`${argv[i - 1]} needs a value`);
      options[argv[i - 1].slice(2)] = value;
    }
  }
  return { positional, options };
}

function findRoot(options) {
  if (options.root) return path.resolve(options.root);
  const out = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (out.status !== 0) throw new Failure(`Not inside a git repository: git rev-parse exited ${out.status}: ${out.stderr.trim()}. Run from the project, or pass --root <dir>.`);
  return out.stdout.trim();
}

function entries(root) {
  const dir = path.join(root, DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith(".md") && d.name !== "README.md").map((d) => d.name).sort().map((file) => ({ file, rel: `${DIR}/${file}`, full: path.join(dir, file), id: `REQ-${file.slice(0, 4)}` }));
}

function sectionBody(text, name) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${name}`);
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}

function read(entry) {
  return parse(entry, readFileSync(entry.full, "utf8"));
}

function parse(entry, text) {
  const field = (name) => text.match(new RegExp(`^- ${name}:[ \\t]*(.*)$`, "m"))?.[1].trim();
  const title = text.match(/^# (.+)$/m)?.[1].trim();
  const sections = Object.fromEntries(SECTIONS.map((name) => [name, sectionBody(text, name)]));
  return { ...entry, text, field, status: field("Status"), section: field("Section") ?? "", title: title ?? entry.file, hasTitle: title !== undefined, sections };
}

function fileLines(root, rel) {
  const full = path.resolve(root, rel);
  if (path.isAbsolute(rel) || path.relative(root, full).startsWith("..")) return { error: `${rel} is outside the project. Name a file by its path from the repository root.` };
  if (!existsSync(full)) return { error: `${rel} does not exist.` };
  const lines = readFileSync(full, "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return { lines };
}

const inRange = (lines, first, last) => first >= 1 && last >= first && last <= lines.length;
const outOfRange = (rel, lines, first, last) => `lines ${first} to ${last} are not in ${rel}, which has ${lines.length} lines.`;

function sourceText(body) {
  const sources = [];
  const stray = [];
  for (const line of (body ?? "").split("\n")) {
    if (line.startsWith("- ")) sources.push({ citation: line.slice(2).trim(), quote: [] });
    else if (line.startsWith(">") && sources.length) sources.at(-1).quote.push(line.replace(/^> ?/, ""));
    else if (line.trim()) stray.push(line.trim());
  }
  for (const source of sources) {
    const cited = source.citation.match(CITATION);
    if (cited) Object.assign(source, { rel: cited[1], first: Number(cited[2]), last: Number(cited[3]) });
    else if (/^https:\/\/\S+$/.test(source.citation)) source.url = source.citation;
    else source.bad = true;
  }
  return { sources, stray };
}

function located(lines, quote) {
  const wanted = quote.map((l) => l.trimEnd());
  for (let start = 0; start + wanted.length <= lines.length; start++) if (wanted.every((line, i) => lines[start + i].trimEnd() === line)) return start + 1;
  return undefined;
}

function sourceProblem(root, source) {
  const found = fileLines(root, source.rel);
  if (found.error) return found.error;
  const valid = inRange(found.lines, source.first, source.last);
  const wanted = source.quote.map((l) => l.trimEnd());
  const cited = valid ? found.lines.slice(source.first - 1, source.last).map((l) => l.trimEnd()) : [];
  if (valid && cited.length === wanted.length && cited.every((line, i) => line === wanted[i])) return undefined;
  const start = located(found.lines, source.quote);
  if (start !== undefined) return `the source text is now at ${source.rel}#L${start}-L${start + source.quote.length - 1}. The text did not change: correct the line numbers.`;
  if (!valid) return outOfRange(source.rel, found.lines, source.first, source.last);
  return `those lines no longer hold the quoted source text. Do not change the Source text or the Statement to match. Show the human the old and the new text, and change the record only when they agree.`;
}

function slug(sentence) {
  const words = sentence.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return words.length <= 80 ? words : words.slice(0, 80).replace(/-[^-]*$/, "");
}

function inspect(root) {
  const problems = [];
  const records = [];
  const numbers = new Map();
  const named = [];
  for (const entry of entries(root)) {
    if (!NAME.test(entry.file)) {
      problems.push(`${entry.rel}: file name does not match NNNN-<title>.md (lowercase words joined by hyphens). Rename it.`);
      continue;
    }
    named.push(entry);
    const number = entry.file.slice(0, 4);
    numbers.set(number, [...(numbers.get(number) ?? []), entry.rel]);
  }
  for (const [number, files] of numbers) if (files.length > 1) problems.push(`duplicate number ${number}: ${files.join(", ")}. Numbers are never reused: renumber the newer file.`);
  for (const entry of named) {
    const record = read(entry);
    records.push(record);
    const number = entry.file.slice(0, 4);
    const fail = (message) => problems.push(`${entry.rel}: ${message}`);
    if (!record.hasTitle) fail(`no "# <short title>" line.`);
    const id = record.field("ID");
    if (id !== entry.id) fail(`"- ID: ${id ?? ""}" does not match the file number. Use "- ID: ${entry.id}".`);
    if (record.status === undefined) fail(`no "- Status:" line. Add "- Status: Proposed".`);
    else if (!STATUS.test(record.status)) fail(`status "${record.status}" is not Proposed, Accepted, Rejected, Retired or Superseded by NNNN.`);
    else {
      const by = record.status.match(/^Superseded by (\d{4})$/)?.[1];
      if (by && by === number) fail(`${record.status} names itself. Name the record that replaces it.`);
      else if (by && !numbers.has(by)) fail(`${record.status}, which does not exist in ${DIR}.`);
      else if (by && by < number) fail(`${record.status}, which is older. A replacement is a new record with a higher number.`);
    }
    const origin = record.field("Origin");
    if (!ORIGINS.includes(origin)) fail(`origin "${origin ?? ""}" is not explicit, implied or PR.`);
    const date = record.field("Date");
    if (date === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`"- Date:" needs YYYY-MM-DD (got "${date ?? "no line"}").`);
    const verification = record.field("Verification");
    if (!verification) fail(`no "- Verification:" value. Use unassigned, or one or more of ${METHODS.join(", ")}.`);
    else if (verification !== "unassigned") for (const method of verification.split(",").map((m) => m.trim())) if (!METHODS.includes(method)) fail(`verification "${method}" is not unassigned, ${METHODS.slice(0, -1).join(", ")} or ${METHODS.at(-1)}.`);
    const agreed = record.field("Agreed");
    if (agreed !== undefined && !AGREED.test(agreed)) fail(`"- Agreed: ${agreed}" does not have the form ${AGREED_FORM}. Only a human writes it, with: ${SCRIPT} agree ${entry.id} --by "<name>"`);
    const proposed = record.status === "Proposed";
    for (const name of ["Section", "Decided by"]) {
      const value = record.field(name);
      if (value === undefined) fail(`no "- ${name}:" line.`);
      else if (!value && !proposed) fail(`"- ${name}:" has no value, and the status is ${record.status}. Fill it, or keep the status Proposed.`);
    }
    for (const name of ["Statement", "Source text"]) {
      const body = record.sections[name];
      if (body === undefined) fail(`missing the section "## ${name}".`);
      else if (!body && !proposed) fail(`the section "## ${name}" is empty, and the status is ${record.status}. Fill it, or keep the status Proposed.`);
    }
    const { sources, stray } = sourceText(record.sections["Source text"]);
    const form = `Each source is "- <path>#L<first>-L<last>" or "- <https link>", then its quote. Make one with: ${SCRIPT} quote <path> <first> <last>`;
    if (origin === "PR" && sources.length && !sources.some((source) => PULL.test(source.url ?? ""))) fail(`the origin is PR, and the source text names no pull request. Add "- <https link to the pull request>" and its quote.`);
    for (const line of stray) fail(`source text line "${line}" belongs to no citation. ${form}`);
    for (const line of (record.sections.Trace ?? "").split("\n")) {
      const link = line.trim().match(TRACE_LINK);
      if (link?.[1] === "PR" && !PULL_URL.test(link[2].trim())) fail(`trace line "${line.trim()}" is not a link to a pull request.`);
      if (link?.[1] === "Issue" && !ISSUE_URL.test(link[2].trim())) fail(`trace line "${line.trim()}" is not a link to an issue.`);
    }
    for (const source of sources) {
      if (source.bad) fail(`citation "${source.citation}" is not a path with lines or an https link. ${form}`);
      else if (!source.quote.some((l) => l.trim())) fail(`source ${source.citation} has no quote. ${form}`);
      else if (source.rel && IN_FORCE.includes(record.status)) {
        const problem = sourceProblem(root, source);
        if (problem) fail(`source ${source.citation}: ${problem}`);
      }
    }
  }
  return { problems, records };
}

function valid(root) {
  const { problems, records } = inspect(root);
  if (problems.length) throw new Failure(problems.join("\n"));
  return records;
}

function check(root) {
  const count = valid(root).length;
  return `${count} record${count === 1 ? "" : "s"} checked: no problems\n`;
}

function row(records) {
  const width = Math.max(...records.map((r) => (r.status ?? "NO STATUS").length));
  return records.map((r) => `${r.id}  ${(r.status ?? "NO STATUS").padEnd(width)}  ${r.title}  ${r.rel}`).join("\n") + "\n";
}

function list(root, options) {
  const all = entries(root).map(read);
  if (!all.length) return `No records in ${DIR}\n`;
  const records = all.filter((r) => (options.status === undefined || (r.status ?? "").startsWith(options.status)) && (options.section === undefined || r.section === options.section));
  if (!records.length) return `No record matches the filter (${all.length} record${all.length === 1 ? "" : "s"} in ${DIR})\n`;
  return row(records);
}

function search(root, terms) {
  if (!terms.length) throw new Usage("search needs at least one term");
  const records = entries(root).map(read);
  const wanted = terms.map((t) => t.toLowerCase());
  const hits = records.filter((r) => wanted.every((t) => `${r.id}\n${r.file}\n${r.text}`.toLowerCase().includes(t)));
  const label = `searched ${records.length} record${records.length === 1 ? "" : "s"}`;
  if (!hits.length) return `No record matches ${terms.map((t) => `"${t}"`).join(" ")} (${label})\n`;
  return row(hits) + `(${label})\n`;
}

function create(root, sentence, options) {
  const origin = options.origin ?? "explicit";
  if (!ORIGINS.includes(origin)) throw new Usage(`Unknown origin "${origin}": use explicit, implied or PR`);
  const title = (sentence ?? "").trim();
  if (!title || !slug(title)) throw new Usage(`new needs a short title, for example: new "The report names each source"`);
  const existing = entries(root);
  const bad = existing.find((e) => !NAME.test(e.file));
  if (bad) throw new Failure(`${bad.rel} does not match NNNN-<title>.md, so the next number is unknown. Rename it, or run check.`);
  const next = String(Math.max(0, ...existing.map((e) => Number(e.file.slice(0, 4)))) + 1).padStart(4, "0");
  const full = path.join(root, DIR, `${next}-${slug(title)}.md`);
  const fields = [`- ID: REQ-${next}`, `- Status: Proposed`, `- Origin: ${origin}`, `- Section: ${options.section ?? ""}`.trimEnd(), `- Date: ${new Date().toISOString().slice(0, 10)}`, `- Decided by:`, `- Verification: unassigned`];
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, `# ${title}\n\n${fields.join("\n")}\n` + SECTIONS.map((s) => `\n## ${s}\n`).join(""), { flag: "wx" });
  return `${full}\n`;
}

function quote(root, rel, first, last) {
  if (!rel || !/^\d+$/.test(first ?? "") || !/^\d+$/.test(last ?? "")) throw new Usage("quote needs <path> <first line> <last line>, for example: quote docs/guide.md 12 14");
  const found = fileLines(root, rel);
  if (found.error) throw new Failure(found.error);
  if (!inRange(found.lines, Number(first), Number(last))) throw new Failure(outOfRange(rel, found.lines, Number(first), Number(last)));
  const quoted = found.lines.slice(Number(first) - 1, Number(last)).map((line) => (line ? `> ${line}` : ">"));
  return `- ${rel}#L${Number(first)}-L${Number(last)}\n\n${quoted.join("\n")}\n`;
}

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const emphasis = (raw) => escape(raw).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>");

function anchor(text, href) {
  const scheme = /^[a-z][a-z0-9+.-]*:/i.test(href);
  if (scheme && !/^(https?:|mailto:)/i.test(href)) return emphasis(text);
  const target = scheme || href.startsWith("#") || href.startsWith("/") ? href : `../${href}`;
  return `<a href="${escape(target)}">${emphasis(text)}</a>`;
}

function linked(raw) {
  let out = "";
  let last = 0;
  for (const match of raw.matchAll(LINK)) {
    out += emphasis(raw.slice(last, match.index)) + anchor(match[1], match[2]);
    last = match.index + match[0].length;
  }
  return out + emphasis(raw.slice(last));
}

const inline = (raw) => raw.split(/(`[^`]+`)/).map((part) => (/^`[^`]+`$/.test(part) ? `<code>${escape(part.slice(1, -1))}</code>` : linked(part))).join("");

function blocks(markdown) {
  const out = [];
  let kind = null;
  let buffer = [];
  const flush = () => {
    if (kind === "text") out.push(`<p>${inline(buffer.join("\n"))}</p>`);
    if (kind === "list") out.push(`<ul>\n${buffer.map((item) => `<li>${inline(item)}</li>`).join("\n")}\n</ul>`);
    if (kind === "quote") out.push(`<blockquote>\n${blocks(buffer.join("\n"))}\n</blockquote>`);
    buffer = [];
  };
  for (const line of markdown.split("\n")) {
    if (kind === "list" && /^\s+\S/.test(line)) {
      buffer[buffer.length - 1] += ` ${line.trim()}`;
      continue;
    }
    const type = !line.trim() ? null : line.startsWith(">") ? "quote" : line.startsWith("- ") ? "list" : "text";
    if (type !== kind) {
      flush();
      kind = type;
    }
    if (type === "quote") buffer.push(line.replace(/^> ?/, ""));
    else if (type === "list") buffer.push(line.slice(2));
    else if (type === "text") buffer.push(line);
  }
  flush();
  return out.join("\n");
}

function article(record) {
  const sources = sourceText(record.sections["Source text"]).sources.map((s) => `<li><a href="${escape(s.url ?? `${UP}${encodeURI(s.rel)}#L${s.first}-L${s.last}`)}">${escape(s.citation)}</a>\n<blockquote class="source">${escape(s.quote.join("\n"))}</blockquote></li>`);
  const decided = record.field("Decided by") ? `Decided by ${escape(record.field("Decided by"))}, ${escape(record.field("Date"))}` : `Dated ${escape(record.field("Date"))}`;
  const meta = [escape(record.status), escape(record.field("Origin")), `Verification: ${escape(record.field("Verification"))}`, decided, `<a href="../${encodeURI(record.file)}">record</a>`];
  const optional = ["Trace", "Notes"].filter((name) => record.sections[name]).map((name) => `<h4>${name}</h4>\n${blocks(record.sections[name])}`);
  return [
    `<article id="${record.id}" class="status-${record.status.split(" ")[0].toLowerCase()}">`,
    `<h3><a href="#${record.id}">${record.id}</a> ${escape(record.title)}</h3>`,
    `<p class="meta">${meta.join(" · ")}</p>`,
    `<div class="statement">\n${blocks(record.sections.Statement ?? "")}\n</div>`,
    ...(sources.length ? [`<h4>Source text</h4>\n<ul>\n${sources.join("\n")}\n</ul>`] : []),
    ...optional,
    `</article>`,
  ].join("\n");
}

const STYLE = `:root{--ink:#1c1c1c;--soft:#5b5b5b;--line:#d9d9d9;--paper:#fff;--tint:#f5f5f2;--link:#0b57a4}
@media (prefers-color-scheme:dark){:root{--ink:#e8e8e6;--soft:#a3a3a0;--line:#3a3a38;--paper:#161615;--tint:#20201f;--link:#8ab4f8}}
body{margin:0 auto;max-width:52rem;padding:2rem 1rem 4rem;background:var(--paper);color:var(--ink);font:1rem/1.55 system-ui,sans-serif}
a{color:var(--link)}
h2{margin-top:3rem;padding-bottom:.3rem;border-bottom:1px solid var(--line)}
article{margin:1.5rem 0;padding:1rem 1.25rem;border:1px solid var(--line);border-radius:.4rem}
article h3{margin:0 0 .25rem;font-size:1.05rem}
article h4{margin:1rem 0 .25rem;font-size:.85rem;color:var(--soft)}
.meta,.summary{margin:0;color:var(--soft);font-size:.85rem}
.statement{margin-top:.75rem}
.status-proposed{border-style:dashed}
.status-rejected,.status-retired,.status-superseded{background:var(--tint)}
blockquote{margin:.75rem 0;padding:.1rem 1rem;border-left:3px solid var(--line)}
code{font-size:.9em}
.source{white-space:pre-wrap;color:var(--soft)}
.narrative{margin:1rem 0}
.stale{border-left:3px solid var(--line);padding-left:1rem}
.warning{color:var(--soft);font-style:italic}`;

function narrativeHtml(narrative, current) {
  if (!narrative) return [];
  const body = blocks(narrative.prose.split(/(`[^`]+`|\[[^\]]*\]\([^)]*\))/).map((part, i) => (i % 2 ? part : part.replace(REQ_ID, (id) => `[${id}](#${id})`))).join(""));
  const warning = current ? [] : [`<p class="warning">The records of this section changed after this text was written.</p>`];
  return [`<div class="narrative${current ? "" : " stale"}">`, ...warning, body, `</div>`];
}

function counted(records) {
  const counts = STATUS_ORDER.map((status) => [status, records.filter((r) => r.status.startsWith(status)).length]).filter(([, n]) => n).map(([status, n]) => `${n} ${status}`);
  return `${records.length} record${records.length === 1 ? "" : "s"}${counts.length ? `: ${counts.join(", ")}` : ""}.`;
}

function document(records, { title = "Requirements", order = [], narratives = new Map() } = {}) {
  const inForce = records.filter((r) => IN_FORCE.includes(r.status));
  const others = records.filter((r) => !IN_FORCE.includes(r.status));
  const groups = new Map(order.map((name) => [name, []]));
  for (const record of inForce) groups.set(record.section, [...(groups.get(record.section) ?? []), record]);
  const named = [...groups].map(([name, members]) => ({ id: `section-${slug(name) || "none"}`, name: name || "No section", members, narrative: narratives.get(name) }));
  if (others.length) named.push({ id: "not-in-force", name: "Not in force", members: others });
  const summary = counted(records);
  return [
    `<!doctype html>`,
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escape(title)}</title>`,
    `<style>\n${STYLE}\n</style>`,
    `</head>`,
    `<body>`,
    `<header>`,
    `<h1>${escape(title)}</h1>`,
    `<p class="summary">${summary} Generated from ${DIR}. Do not edit this file.</p>`,
    `<nav>\n<ul>\n${named.map((g) => `<li><a href="#${g.id}">${escape(g.name)}</a> (${g.members.length})</li>`).join("\n")}\n</ul>\n</nav>`,
    `</header>`,
    `<main>`,
    ...named.map((g) => [`<section id="${g.id}">`, `<h2>${escape(g.name)}</h2>`, ...narrativeHtml(g.narrative, g.narrative?.hash === sectionHash(g.members)), ...g.members.map(article), `</section>`].join("\n")),
    `</main>`,
    `</body>`,
    `</html>`,
    ``,
  ].join("\n");
}

function outline(root, records) {
  const full = path.join(root, OUTLINE);
  if (!existsSync(full)) return {};
  const problems = [];
  let title;
  const order = [];
  readFileSync(full, "utf8").split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const heading = line.match(/^(#{1,2}) (.+)$/);
    if (!heading) problems.push(`${OUTLINE}: line ${i + 1} is not a heading. The outline holds only "# <title>" and "## <section>" lines.`);
    else if (heading[1] === "#") {
      if (title !== undefined) problems.push(`${OUTLINE}: line ${i + 1} is a second title. The outline has one "# <title>" line.`);
      title ??= heading[2].trim();
    } else if (order.includes(heading[2].trim())) problems.push(`${OUTLINE}: line ${i + 1} names the section "${heading[2].trim()}" again.`);
    else order.push(heading[2].trim());
  });
  const used = new Set(records.filter((r) => IN_FORCE.includes(r.status)).map((r) => r.section));
  for (const record of records) if (IN_FORCE.includes(record.status) && !record.section) problems.push(`${record.id} has no section. Set its Section to a section of ${OUTLINE}.`);
  for (const record of records) if (IN_FORCE.includes(record.status) && record.section && !order.includes(record.section)) problems.push(`${record.id} has the section "${record.section}", which is not in ${OUTLINE}. Add the section to the outline, or correct the record.`);
  for (const name of order) if (!used.has(name)) problems.push(`${OUTLINE}: the section "${name}" has no record in force. Remove it from the outline.`);
  if (problems.length) throw new Failure(problems.join("\n"));
  return { title, order };
}

function sectionRecords(records) {
  const groups = new Map();
  const problems = [];
  for (const record of records.filter((r) => IN_FORCE.includes(r.status))) {
    if (!record.section) problems.push(`${record.id} has no section. Set its Section, so that a narrative can describe it.`);
    else groups.set(record.section, [...(groups.get(record.section) ?? []), record]);
  }
  const files = new Map();
  for (const name of groups.keys()) {
    const file = path.basename(narrativePath(name));
    if (files.has(file)) problems.push(`The sections "${files.get(file)}" and "${name}" have the same file name ${file}. Rename one section.`);
    else files.set(file, name);
  }
  if (problems.length) throw new Failure(problems.join("\n"));
  return groups;
}

const sectionHash = (members) => createHash("sha256").update([...members].sort((a, b) => a.id.localeCompare(b.id)).map((r) => `${r.id}\n${r.sections.Statement ?? ""}`).join("\n")).digest("hex").slice(0, 12);
const narrativePath = (name) => `${NARRATIVE}/${slug(name) || "none"}.md`;

function narratives(root) {
  const dir = path.join(root, NARRATIVE);
  const found = new Map();
  if (!existsSync(dir)) return found;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const rel = `${NARRATIVE}/${file}`;
    const lines = readFileSync(path.join(dir, file), "utf8").split(/\r?\n/);
    const section = lines[0]?.match(/^- Section: (.+)$/)?.[1];
    const hash = lines[1]?.match(/^- Records: ([0-9a-f]{12})$/)?.[1];
    if (!section || !hash || lines[2] !== "") throw new Failure(`${rel} does not start with "- Section: <name>", "- Records: <hash>" and a blank line. Write it again with: ${SCRIPT} narrate "<section>" --from <file>`);
    found.set(section, { rel, section, hash, prose: lines.slice(3).join("\n").replace(/\n+$/, "") });
  }
  return found;
}

function sentences(prose) {
  const units = [];
  let current = [];
  const flush = () => {
    if (current.length) units.push(current.join(" "));
    current = [];
  };
  for (const line of prose.split("\n")) {
    if (!line.trim()) flush();
    else if (/^\s*(?:[-*] |\d+\. )/.test(line)) {
      flush();
      current.push(line.replace(/^\s*(?:[-*] |\d+\. )/, ""));
    } else current.push(line.replace(/^\s*> ?/, ""));
  }
  flush();
  return units.flatMap((unit) => unit.split(/(?<=[.!?])\s+(?=[A-Z"“])/)).map((s) => s.trim()).filter(Boolean);
}

const cites = (sentence) => sentence.replace(/`[^`]+`/g, "").match(REQ_ID);

function narrate(root, name, options) {
  if (!name) throw new Usage(`narrate needs "<section>" [--from <file>]`);
  const records = valid(root);
  const groups = sectionRecords(records);
  const members = groups.get(name);
  if (!members) throw new Failure(`No record in force has the section "${name}". The sections are: ${[...groups.keys()].join(", ")}`);
  const hash = sectionHash(members);
  if (!options.from) {
    const stored = narratives(root).get(name);
    const state = !stored ? "missing" : stored.hash === hash ? "current" : "stale";
    return `${members.length} record${members.length === 1 ? "" : "s"} in force in "${name}"\n${members.map((r) => `${r.id} ${r.status}: ${(r.sections.Statement ?? "").replace(/\s+/g, " ").trim()}`).join("\n")}\nNarrative: ${state}\n`;
  }
  const source = path.resolve(root, options.from);
  if (!existsSync(source)) throw new Failure(`${options.from} does not exist.`);
  const prose = readFileSync(source, "utf8").replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const ids = new Set(members.map((r) => r.id));
  const problems = [];
  prose.split("\n").forEach((line, i) => {
    if (/^#{1,6}\s/.test(line)) problems.push(`${options.from}: line ${i + 1} is a heading. The section heading comes from the outline.`);
  });
  for (const sentence of sentences(prose.split("\n").filter((line) => !/^#{1,6}\s/.test(line)).join("\n"))) {
    const word = sentence.match(NORMATIVE)?.[0];
    if (word && !cites(sentence)) problems.push(`${options.from}: "${sentence}" has the normative word "${word}" and cites no REQ-NNNN. Cite the record that states it, or reword the sentence.`);
  }
  for (const id of new Set(prose.match(REQ_ID) ?? [])) if (!ids.has(id)) problems.push(`${options.from}: ${id} is not a record in force in the section "${name}".`);
  if (!prose.trim()) problems.push(`${options.from} is empty.`);
  if (problems.length) throw new Failure(problems.join("\n"));
  const rel = narrativePath(name);
  mkdirSync(path.join(root, NARRATIVE), { recursive: true });
  writeFileSync(path.join(root, rel), `- Section: ${name}\n- Records: ${hash}\n\n${prose}\n`);
  return `${rel}\n`;
}

function narrative(root) {
  const groups = sectionRecords(valid(root));
  const stored = narratives(root);
  const rows = [];
  const problems = [];
  for (const [name, members] of groups) {
    const found = stored.get(name);
    const state = !found ? "missing" : found.hash === sectionHash(members) ? "current" : "stale";
    rows.push(`${name}  ${state}`);
    if (state === "missing") problems.push(`${name}: no narrative. Write it with: ${SCRIPT} narrate "${name}" --from <file>`);
    if (state === "stale") problems.push(`${name}: the records changed after the narrative was written. Read them with: ${SCRIPT} narrate "${name}", then write it again with: ${SCRIPT} narrate "${name}" --from <file>`);
  }
  for (const found of stored.values()) if (!groups.has(found.section)) problems.push(`${found.rel} names the section "${found.section}", which no record in force has. Delete the file, or write it again for a section that exists.`);
  process.stdout.write(rows.join("\n") + (rows.length ? "\n" : ""));
  if (problems.length) throw new Failure(problems.join("\n"));
  return `${groups.size} section${groups.size === 1 ? "" : "s"}: each narrative is current\n`;
}

function render(root, options) {
  const records = valid(root);
  const html = document(records, { ...outline(root, records), narratives: narratives(root) });
  const full = path.join(root, HTML);
  if (options.check) {
    if (!existsSync(full)) throw new Failure(`${HTML} does not exist. Write it with: ${SCRIPT} render`);
    if (readFileSync(full, "utf8") !== html) throw new Failure(`${HTML} is not current: the records changed after it was written. Write it again with: ${SCRIPT} render`);
    return `${HTML} is current\n`;
  }
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, html);
  return `${full}\n`;
}

function publishConfig(root) {
  const full = path.join(root, PUBLISH);
  if (!existsSync(full)) throw new Failure(`${PUBLISH} does not exist. Write it with the keys "to" (the folder for the pages, inside the project) and "format" ("md" or "mdx"), and optionally "source", "route", "frontMatter" and "meta".`);
  let config;
  try {
    config = JSON.parse(readFileSync(full, "utf8"));
  } catch (error) {
    throw new Failure(`${PUBLISH} is not valid JSON: ${error.message}`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Failure(`${PUBLISH} is not a JSON object.`);
  const problems = [];
  for (const key of Object.keys(config)) if (!PUBLISH_KEYS.includes(key)) problems.push(`${PUBLISH}: unknown key "${key}". The keys are ${PUBLISH_KEYS.join(", ")}.`);
  if (!["md", "mdx"].includes(config.format)) problems.push(`${PUBLISH}: "format" is ${JSON.stringify(config.format ?? null)}. Use "md" or "mdx".`);
  const to = typeof config.to === "string" ? path.relative(root, path.resolve(root, config.to)) : "";
  const first = to.split(path.sep)[0];
  if (!to || first === ".." || first === ".git" || path.isAbsolute(to) || to.split(path.sep).join("/") === DIR) problems.push(`${PUBLISH}: "to" is ${JSON.stringify(config.to ?? null)}, which is not a folder inside the project.`);
  if (config.source !== undefined && !/^https?:\/\/\S+$/.test(config.source)) problems.push(`${PUBLISH}: "source" is ${JSON.stringify(config.source)}. Use the web address under which the project's files show, for example https://github.com/<owner>/<repo>/blob/main/.`);
  if (config.format === "mdx" && config.route === undefined) problems.push(`${PUBLISH}: "route" is needed with "format": "mdx". Set it to the path at which the app serves the folder, for example /requirements.`);
  if (config.route !== undefined && !/^\/\S*$/.test(config.route)) problems.push(`${PUBLISH}: "route" is ${JSON.stringify(config.route)}. Use the path of the pages on the site, for example /requirements.`);
  if (config.meta !== undefined && config.meta !== "nextra") problems.push(`${PUBLISH}: "meta" is ${JSON.stringify(config.meta)}. The only value is "nextra".`);
  const front = config.frontMatter ?? {};
  if (typeof front !== "object" || Array.isArray(front)) problems.push(`${PUBLISH}: "frontMatter" is not an object.`);
  else
    for (const [key, value] of Object.entries(front)) {
      if (key === "title") problems.push(`${PUBLISH}: "frontMatter"."title" is not allowed. The title comes from the outline and the section.`);
      else if (typeof value !== "string" && !(Array.isArray(value) && value.every((item) => typeof item === "string"))) problems.push(`${PUBLISH}: "frontMatter"."${key}" is not text or a list of text.`);
    }
  if (problems.length) throw new Failure(problems.join("\n"));
  return { to: to.split(path.sep).join("/"), mdx: config.format === "mdx", ext: `.${config.format}`, source: config.source?.replace(/\/?$/, "/"), route: config.route?.replace(/\/$/, ""), front, meta: config.meta };
}

function publication(root, config) {
  const records = valid(root);
  const { title = "Requirements", order = [] } = outline(root, records);
  const groups = sectionRecords(records);
  const names = [...order.filter((name) => groups.has(name)), ...[...groups.keys()].filter((name) => !order.includes(name))];
  const pages = names.map((name) => ({ name, slug: slug(name) || "none", members: groups.get(name) }));
  const others = records.filter((r) => !IN_FORCE.includes(r.status));
  if (others.length) pages.push({ name: "Not in force", slug: "not-in-force", members: others });
  const seen = new Map();
  for (const p of pages) {
    if (p.slug === "index" || seen.has(p.slug)) throw new Failure(`The section "${p.name}" gives the page name ${p.slug}${config.ext}, which ${p.slug === "index" ? "the index uses" : `the section "${seen.get(p.slug)}" uses too`}. Rename the section.`);
    seen.set(p.slug, p.name);
  }
  const route = (name) => (config.mdx ? `${config.route}/${name}` : `${name}${config.ext}`);
  const fileLink = (rel) => (config.source ? `${config.source}${encodeURI(rel)}` : encodeURI(path.posix.relative(config.to, rel)));
  const home = new Map(pages.flatMap((p) => p.members.map((r) => [r.id, p])));
  const plain = (raw) => {
    const escaped = raw.replace(/</g, "&lt;");
    return config.mdx ? escaped.replace(/[{}]/g, "\\$&") : escaped;
  };
  const address = (href, base) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || /^[#/<]/.test(href)) return href;
    const [file, fragment] = href.split(/(?=#)/);
    return fileLink(path.posix.normalize(path.posix.join(base, file))) + (fragment ?? "");
  };
  const inline = (raw, base, here) =>
    raw
      .split(INLINE_PART)
      .map((part, i) => {
        if (i % 2 === 0) return here ? plain(part).replace(REQ_ID, (id) => (home.has(id) ? `[${id}](${home.get(id) === here ? "" : route(home.get(id).slug)}#${id})` : id)) : plain(part);
        if (part.startsWith("`") || /^https?:/.test(part)) return part;
        const [, label, href] = part.match(/^\[([^\]]+)\]\((.+)\)$/);
        return `[${inline(label, base)}](${address(href, base)})`;
      })
      .join("");
  const markdown = (raw, base, here) => {
    const out = [];
    let paragraph = [];
    let fence;
    const flush = () => {
      if (paragraph.length) out.push(inline(paragraph.join("\n"), base, here));
      paragraph = [];
    };
    for (const line of raw.split("\n")) {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
      if (fence) {
        out.push(line);
        if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length).trim()) fence = undefined;
      } else if (marker) {
        flush();
        fence = marker;
        out.push(line);
      } else if (!line.trim()) {
        flush();
        out.push(line);
      } else paragraph.push(line);
    }
    flush();
    return out.join("\n");
  };
  const text = (raw) => inline(raw, DIR);
  const yaml = (value) => JSON.stringify(value);
  const frontMatter = (name, members) => {
    const lines = [`title: ${yaml(name)}`];
    for (const [key, value] of Object.entries(config.front)) {
      if (typeof value === "string") lines.push(`${key}: ${yaml(value)}`);
      else lines.push(`${key}:`, ...value.flatMap((item) => (item === "{records}" ? members.map((r) => r.rel) : [item])).map((item) => `  - ${yaml(item)}`));
    }
    return `---\n${lines.join("\n")}\n---\n`;
  };
  const fence = (lines) => "`".repeat(Math.max(3, ...lines.map((line) => Math.max(0, ...(line.match(/`+/g) ?? []).map((run) => run.length + 1)))));
  const sourceLink = (s) => s.url ?? `${fileLink(s.rel)}#L${s.first}-L${s.last}`;
  const entry = (record, here) => {
    const decided = record.field("Decided by") ? `Decided by ${record.field("Decided by")}, ${record.field("Date")}` : `Dated ${record.field("Date")}`;
    const meta = [record.status, record.field("Origin"), `Verification: ${record.field("Verification")}`, decided].map(text).join(" · ");
    const parts = [`<a id="${record.id}"></a>`, `## ${record.id} ${text(record.title)}`, `${meta} · [record](${fileLink(record.rel)})`, markdown(record.sections.Statement ?? "", DIR, here)];
    const sources = sourceText(record.sections["Source text"]).sources;
    if (sources.length) parts.push("### Source text", ...sources.map((s) => [`- [${text(s.citation)}](${sourceLink(s)})`, ...(s.quote.length ? [`${fence(s.quote)}text\n${s.quote.join("\n")}\n${fence(s.quote)}`] : [])].join("\n\n")));
    for (const name of ["Trace", "Notes"]) if (record.sections[name]) parts.push(`### ${name}`, markdown(record.sections[name], DIR, here));
    return parts.join("\n\n");
  };
  const stored = narratives(root);
  const files = new Map();
  for (const p of pages) {
    const found = p.slug === "not-in-force" ? undefined : stored.get(p.name);
    const prose = found ? [...(found.hash === sectionHash(p.members) ? [] : ["> The records of this section changed after this text was written."]), markdown(found.prose, NARRATIVE, p)] : [];
    files.set(`${p.slug}${config.ext}`, `${frontMatter(p.name, p.members)}\n${[`# ${text(p.name)}`, ...prose, ...p.members.map((r) => entry(r, p))].join("\n\n")}\n`);
  }
  const listed = pages.map((p) => `- [${text(p.name)}](${route(p.slug)}) (${p.members.length})`).join("\n");
  files.set(`index${config.ext}`, `${frontMatter(title, records)}\n# ${text(title)}\n\n${counted(records)}\n\n${listed}\n`);
  const json = pages.flatMap((p) =>
    p.members.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      origin: r.field("Origin"),
      section: r.section,
      date: r.field("Date"),
      decidedBy: r.field("Decided by") ?? "",
      verification: r.field("Verification"),
      statement: r.sections.Statement ?? "",
      sources: sourceText(r.sections["Source text"]).sources.map((s) => ({ citation: s.citation, link: sourceLink(s) })),
      trace: r.sections.Trace ?? "",
      notes: r.sections.Notes ?? "",
      page: route(p.slug),
      record: fileLink(r.rel),
    })),
  );
  files.set("requirements.json", `${JSON.stringify({ title, records: json }, null, 2)}\n`);
  if (config.meta === "nextra") files.set("_meta.js", `export default {\n${[["index", title], ...pages.map((p) => [p.slug, p.name])].map(([key, name]) => `  ${yaml(key)}: ${yaml(name)}`).join(",\n")}\n};\n`);
  return files;
}

function publish(root, options) {
  const config = publishConfig(root);
  const files = publication(root, config);
  const dir = path.join(root, config.to);
  const manifest = path.join(dir, MANIFEST);
  const shown = (name) => `${config.to}/${name}`;
  const last = new Set(existsSync(manifest) ? readFileSync(manifest, "utf8").split("\n").filter(Boolean) : []);
  const strange = [...last].filter((name) => /[\/\\]/.test(name) || name === "." || name === "..");
  if (strange.length) throw new Failure(strange.map((name) => `${shown(MANIFEST)}: "${name}" is not a plain file name. Correct the file, or delete it and the files that it names.`).join("\n"));
  const listing = `${[...files.keys()].sort().join("\n")}\n`;
  const problems = [];
  for (const name of files.keys()) if (existsSync(path.join(dir, name)) && !last.has(name)) problems.push(`${shown(name)} exists and the last publish did not write it. Move it, or set "to" in ${PUBLISH} to a folder of its own.`);
  const left = [...last].filter((name) => !files.has(name) && existsSync(path.join(dir, name)));
  if (options.check) {
    for (const [name, content] of files) {
      const full = path.join(dir, name);
      if (!existsSync(full)) problems.push(`${shown(name)} is missing.`);
      else if (last.has(name) && readFileSync(full, "utf8") !== content) problems.push(`${shown(name)} is not current.`);
    }
    for (const name of left) problems.push(`${shown(name)} is left from the last publish.`);
    if (!existsSync(manifest)) problems.push(`${shown(MANIFEST)} is missing.`);
    else if (readFileSync(manifest, "utf8") !== listing) problems.push(`${shown(MANIFEST)} is not current.`);
    if (problems.length) throw new Failure(`${problems.join("\n")}\nWrite them again with: ${SCRIPT} publish`);
    return `${config.to}: ${files.size} files are current\n`;
  }
  if (problems.length) throw new Failure(problems.join("\n"));
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of files) writeFileSync(path.join(dir, name), content);
  for (const name of left) rmSync(path.join(dir, name));
  writeFileSync(manifest, listing);
  return `${config.to}: ${files.size} files written${left.length ? `, ${left.length} removed` : ""}\n`;
}

const unnumbered = (body) => (body ?? "").split("\n").map((line) => (line.startsWith("- ") && !/^- https:\/\//.test(line) && CITATION.test(line.slice(2).trim()) ? `- ${line.slice(2).trim().replace(CITATION, "$1")}` : line)).join("\n");
const protectedParts = (record) => ({ Statement: record.sections.Statement ?? "", "Source text": unnumbered(record.sections["Source text"]) });
const textHash = (record) => createHash("sha256").update(PROTECTED.map((name) => `## ${name}\n${protectedParts(record)[name]}`).join("\n")).digest("hex").slice(0, 12);
const indented = (text) => (text || "(empty)").split("\n").map((line) => `    ${line}`).join("\n");

function git(root, args) {
  const out = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (out.status !== 0) throw new Failure(`git ${args.join(" ")} exited ${out.status}: ${out.stderr.trim()}`);
  return out.stdout;
}

function guard(root, options) {
  const base = options.base;
  if (!base) throw new Usage("guard needs --base <git ref>, for example: guard --base origin/main");
  git(root, ["rev-parse", "--verify", `${base}^{commit}`]);
  const named = entries(root).filter((e) => NAME.test(e.file));
  const problems = [];
  for (const id of new Set(named.map((e) => e.id))) {
    const files = named.filter((e) => e.id === id).map((e) => e.rel);
    if (files.length > 1) problems.push(`duplicate number ${id.slice(4)}: ${files.join(", ")}. Numbers are never reused: renumber the newer file.`);
  }
  const current = new Map(named.map((e) => [e.id, read(e)]));
  for (const rel of git(root, ["ls-tree", "--name-only", base, "--", `${DIR}/`]).split("\n").filter(Boolean)) {
    const file = path.posix.basename(rel);
    if (!NAME.test(file)) continue;
    const old = parse({ file, rel, id: `REQ-${file.slice(0, 4)}` }, git(root, ["show", `${base}:./${rel}`]));
    const now = current.get(old.id);
    if (!now) {
      problems.push(`${old.id} (${rel} at ${base}) is deleted. A record is never deleted: restore it, and give it the status Retired or Rejected.`);
      continue;
    }
    const before = protectedParts(old);
    const after = protectedParts(now);
    const changed = PROTECTED.filter((name) => before[name] !== after[name]);
    if (!changed.length) continue;
    const agreed = now.field("Agreed")?.match(AGREED);
    if (agreed && agreed[3] === textHash(now)) continue;
    const parts = changed.map((name) => `the ${name}`).join(" and ");
    const why = agreed ? "the Agreed line is for other text: the text changed after the human agreed" : "no human agreed to the change";
    const diff = changed.map((name) => `  ${name}, old:\n${indented(old.sections[name])}\n  ${name}, new:\n${indented(now.sections[name])}`).join("\n");
    problems.push(`${now.rel}: ${parts} changed since ${base}, and ${why}.\n${diff}\n  Show the human the old and the new text. When they agree, they run: ${SCRIPT} agree ${now.id} --by "<name>". Otherwise, restore the old text.`);
  }
  if (problems.length) throw new Failure(problems.join("\n"));
  return `${current.size} record${current.size === 1 ? "" : "s"} guarded against ${base}: no protected text changed without agreement\n`;
}

function agree(root, id, options) {
  if (!/^REQ-\d{4}$/.test(id ?? "") || !options.by?.trim()) throw new Usage(`agree needs <REQ-NNNN> --by "<name>", for example: agree REQ-0001 --by "Ann Smith"`);
  if (!process.stdin.isTTY) throw new Failure(`agree records the agreement of a human to a changed Statement or Source text, so only a human runs it, in a terminal. Show the human the old and the new text, and ask them to run: ${SCRIPT} agree ${id} --by "<name>"`);
  const entry = entries(root).find((e) => e.id === id && NAME.test(e.file));
  if (!entry) throw new Failure(`${id} is not a record in ${DIR}.`);
  const record = read(entry);
  const line = `- Agreed: ${options.by.trim()}, ${new Date().toISOString().slice(0, 10)}, text ${textHash(record)}`;
  let text;
  if (/^- Agreed:.*$/m.test(record.text)) text = record.text.replace(/^- Agreed:.*$/m, () => line);
  else if (/^- Verification:.*$/m.test(record.text)) text = record.text.replace(/^- Verification:.*$/m, (found) => `${found}\n${line}`);
  else throw new Failure(`${entry.rel} has no "- Verification:" line, so the Agreed line has no place. Run: ${SCRIPT} check`);
  writeFileSync(entry.full, text);
  return `${entry.rel}: ${line.slice(2)}\n`;
}

function tier(rel) {
  const parts = rel.split("/");
  const stem = parts.at(-1).replace(/\.mdx?$/i, "");
  if (parts.slice(0, -1).some((p) => /^(requirements?|specs?|specifications?)$/i.test(p)) || /^(north[_-]?star|requirements?|specs?|specifications?|prd)$/i.test(stem)) return 1;
  if (parts.some((p) => /^wiki$/i.test(p) || /\.wiki$/i.test(p))) return 2;
  if (/^readme$/i.test(stem)) return 3;
  return 4;
}

function documents(root) {
  return git(root, ["ls-files", "-z", "--", "*.md", "*.mdx"]).split("\0").filter((rel) => rel && !rel.startsWith(`${DIR}/`)).map((rel) => ({ rel, tier: tier(rel) })).sort((a, b) => a.tier - b.tier || (a.rel < b.rel ? -1 : 1));
}

function sources(root, options) {
  if (options.tier !== undefined && !TIERS.some(([n]) => String(n) === options.tier)) throw new Usage(`--tier takes ${TIERS.map(([n, kind]) => `${n} (${kind})`).join(", ")}`);
  const found = documents(root).filter((d) => options.tier === undefined || String(d.tier) === options.tier);
  if (!found.length) return `No tracked document${options.tier ? ` in tier ${options.tier}` : ""}\n`;
  return found.map((d) => `${d.tier}  ${TIERS[d.tier - 1][1].padEnd(12)}  ${d.rel}`).join("\n") + "\n";
}

const linesHash = (lines) => createHash("sha256").update(lines.map((l) => l.trimEnd()).join("\n")).digest("hex").slice(0, 12);

function ledgerEntries(root) {
  const full = path.join(root, LEDGER);
  if (!existsSync(full)) return { entries: [], problems: [] };
  const entries = [];
  const problems = [];
  for (const line of readFileSync(full, "utf8").split("\n").filter((l) => l.startsWith("- "))) {
    const m = line.match(LEDGER_ENTRY);
    if (!m) problems.push(`${LEDGER}: "${line}" does not have the form "- <path>#L<first>-L<last> <hash>: <reason>". Write entries with: ${SCRIPT} ledger <path> <first> <last> "<reason>"`);
    else entries.push({ rel: m[1], first: Number(m[2]), last: Number(m[3]), hash: m[4], reason: m[5], citation: `${m[1]}#L${m[2]}-L${m[3]}` });
  }
  return { entries, problems };
}

function ledger(root, rel, first, last, reason) {
  if (!rel || !/^\d+$/.test(first ?? "") || !/^\d+$/.test(last ?? "") || !reason?.trim()) throw new Usage(`ledger needs <path> <first line> <last line> "<reason>", for example: ledger docs/guide.md 4 6 "background: the history of the tool"`);
  const found = fileLines(root, rel);
  if (found.error) throw new Failure(found.error);
  const [a, b] = [Number(first), Number(last)];
  if (!inRange(found.lines, a, b)) throw new Failure(outOfRange(rel, found.lines, a, b));
  const citation = `${rel}#L${a}-L${b}`;
  if (ledgerEntries(root).entries.some((e) => e.citation === citation)) throw new Failure(`${citation} is already in the ledger (${LEDGER}).`);
  const full = path.join(root, LEDGER);
  const head = existsSync(full) ? readFileSync(full, "utf8") : `# Ledger\n\nLines of the project's documents that hold no requirement, and why. Write entries with ${SCRIPT} ledger.\n\n`;
  const entry = `- ${citation} ${linesHash(found.lines.slice(a - 1, b))}: ${reason.trim()}`;
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, `${head.replace(/\n*$/, "\n")}${head.includes("\n- ") ? "" : "\n"}${entry}\n`);
  return `${LEDGER}: ${entry.slice(2)}\n`;
}

function prose(rel, lines, mdx) {
  const out = [];
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    if (end < 0) throw new Failure(`${rel}: the front matter that starts at line 1 has no closing "---". Close it, or remove the first line.`);
    start = end + 1;
  }
  let fence = null;
  let comment = false;
  for (let i = start; i < lines.length; i++) {
    const text = lines[i].trim();
    if (comment) {
      if (text.includes("-->")) comment = false;
      continue;
    }
    if (fence) {
      if (text.startsWith(fence)) fence = null;
      continue;
    }
    const opened = text.match(/^(`{3,}|~{3,})/);
    if (opened) {
      fence = opened[1];
      continue;
    }
    if (text.startsWith("<!--")) {
      comment = !text.includes("-->");
      continue;
    }
    if (/^(=+|-+)$/.test(text) && out.at(-1)?.number === i) {
      out.pop();
      continue;
    }
    if (!text || /^#{1,6}(\s|$)/.test(text) || /^([-*_]\s*){3,}$/.test(text) || (/^[|:\-\s]+$/.test(text) && text.includes("|") && text.includes("-")) || /^\[[^\]]+\]:\s/.test(text)) continue;
    if (mdx && (/^(import|export)\s/.test(text) || /^<\/?[A-Z][^<>]*>$/.test(text))) continue;
    out.push({ number: i + 1, text });
  }
  return out;
}

function uncovered(root, paths) {
  const targets = paths.length ? paths : documents(root).filter((d) => d.tier === 1).map((d) => d.rel);
  if (!targets.length) throw new Failure(`No tier 1 document to read. Name the documents: ${SCRIPT} uncovered <path>...`);
  const cited = entries(root).filter((e) => NAME.test(e.file)).flatMap((e) => sourceText(read(e).sections["Source text"]).sources.filter((s) => s.rel));
  const { entries: held, problems } = ledgerEntries(root);
  const rows = [];
  let total = 0;
  let byRecord = 0;
  let byLedger = 0;
  const fresh = held.filter((entry) => {
    const found = fileLines(root, entry.rel);
    if (found.error) problems.push(`ledger entry ${entry.citation}: ${found.error} Remove the entry, or restore the file.`);
    else if (inRange(found.lines, entry.first, entry.last) && linesHash(found.lines.slice(entry.first - 1, entry.last)) === entry.hash) return true;
    else problems.push(`ledger entry ${entry.citation}: the lines changed after the entry was written. Read them again: write a record, or remove the entry and record the lines again with ${SCRIPT} ledger.`);
    return false;
  });
  for (const rel of targets) {
    const found = fileLines(root, rel);
    if (found.error) throw new Failure(found.error);
    for (const line of prose(rel, found.lines, rel.endsWith(".mdx"))) {
      total++;
      const covers = (s) => s.rel === rel && s.first <= line.number && line.number <= s.last;
      if (cited.some(covers)) byRecord++;
      else if (fresh.some(covers)) byLedger++;
      else rows.push({ rel, ...line, normative: NORMATIVE.test(line.text) });
    }
  }
  const files = `${targets.length} file${targets.length === 1 ? "" : "s"}`;
  if (!rows.length && !problems.length) return `${total} prose line${total === 1 ? "" : "s"} in ${files}: ${byRecord} cited by records, ${byLedger} in the ledger, 0 not accounted for\n`;
  process.stdout.write(rows.map((r) => `${r.rel}:${r.number}  ${r.normative ? "normative  " : ""}${r.text}`).join("\n") + (rows.length ? "\n" : ""));
  const normative = rows.filter((r) => r.normative).length;
  const summary = `${rows.length} of ${total} prose lines in ${files} not accounted for${normative ? ` (${normative} normative)` : ""}. Write a record for each requirement, and a ledger entry for the other lines.`;
  throw new Failure([...problems, summary].join("\n"));
}

function pullRequests(root, file) {
  if (!file) throw new Usage(`needs --prs <file>, made with: ${GH_PRS} > <file>`);
  const full = path.resolve(root, file);
  if (!existsSync(full)) throw new Failure(`${file} does not exist. Make it with: ${GH_PRS} > ${file}`);
  let data;
  try {
    data = JSON.parse(readFileSync(full, "utf8"));
  } catch (error) {
    throw new Failure(`${file} is not JSON: ${error.message}. Make it with: ${GH_PRS} > ${file}`);
  }
  if (!Array.isArray(data)) throw new Failure(`${file} is not a list of pull requests. Make it with: ${GH_PRS} > ${file}`);
  return data.map((pr, i) => {
    if (!PULL_URL.test(pr?.url ?? "")) throw new Failure(`${file}: entry ${i + 1} has no pull request url. Make the file with: ${GH_PRS} > ${file}`);
    const where = `${file}: entry ${i + 1} (${pr.url})`;
    if (!Array.isArray(pr.closingIssuesReferences)) throw new Failure(`${where} has no closingIssuesReferences list. Make the file with: ${GH_PRS} > ${file}`);
    const issues = pr.closingIssuesReferences.map((issue, j) => {
      if (!ISSUE_URL.test(issue?.url ?? "")) throw new Failure(`${where} closing issue ${j + 1} has no issue url. Make the file with: ${GH_PRS} > ${file}`);
      return issue.url;
    });
    return { number: pr.number, title: pr.title ?? "", url: pr.url, issues };
  });
}

function traces(record) {
  const prs = new Set();
  const issues = new Set();
  for (const line of (record.sections.Trace ?? "").split("\n")) {
    const link = line.trim().match(TRACE_LINK);
    if (link) (link[1] === "PR" ? prs : issues).add(link[2].trim());
  }
  for (const source of sourceText(record.sections["Source text"]).sources) {
    const pull = source.url?.match(PULL)?.[0];
    if (pull) prs.add(pull);
  }
  return { prs, issues };
}

function untraced(root, options) {
  const prs = pullRequests(root, options.prs);
  const records = entries(root).filter((e) => NAME.test(e.file)).map((e) => read(e)).map((r) => ({ ...r, links: traces(r) }));
  const missing = [];
  const problems = [];
  for (const pr of prs) {
    const tracing = records.filter((r) => r.links.prs.has(pr.url));
    if (!tracing.length) missing.push(pr);
    for (const record of tracing) for (const issue of pr.issues) if (!record.links.issues.has(issue)) problems.push(`${record.id} traces ${pr.url}, which closes ${issue}, and does not link it. Run: ${SCRIPT} link ${record.id} ${pr.url} --prs ${options.prs}`);
  }
  if (!missing.length && !problems.length) return `${prs.length} merged pull request${prs.length === 1 ? "" : "s"}: each traces to a record, with the issues it closes\n`;
  missing.sort((a, b) => a.number - b.number);
  process.stdout.write(missing.map((pr) => `#${pr.number}  ${pr.title}  ${pr.url}`).join("\n") + (missing.length ? "\n" : ""));
  if (missing.length) problems.push(`${missing.length} of ${prs.length} merged pull requests trace to no record. Link each to the records it implements with ${SCRIPT} link, or write a record with: ${SCRIPT} new "<title>" --origin PR`);
  throw new Failure(problems.join("\n"));
}

function link(root, id, url, options) {
  if (!/^REQ-\d{4}$/.test(id ?? "") || !PULL_URL.test(url ?? "") || (options.issue !== undefined && !ISSUE_URL.test(options.issue))) throw new Usage(`link needs <REQ-NNNN> <pull request link> [--prs <file>] [--issue <issue link>], for example: link REQ-0001 https://github.com/o/r/pull/12 --prs prs.json`);
  const entry = entries(root).find((e) => e.id === id && NAME.test(e.file));
  if (!entry) throw new Failure(`${id} is not a record in ${DIR}.`);
  const issues = [];
  if (options.prs) {
    const pr = pullRequests(root, options.prs).find((p) => p.url === url);
    if (!pr) throw new Failure(`${url} is not in ${options.prs}. Make the file again with: ${GH_PRS} > ${options.prs}`);
    issues.push(...pr.issues);
  }
  if (options.issue) issues.push(options.issue);
  const record = read(entry);
  const held = (record.sections.Trace ?? "").split("\n").map((line) => line.trim());
  const added = [`- PR: ${url}`, ...issues.map((issue) => `- Issue: ${issue}`)].filter((line, i, all) => !held.includes(line) && all.indexOf(line) === i);
  if (!added.length) return `${id} already links ${url}${issues.length ? " and the issues it closes" : ""}\n`;
  const eol = record.text.includes("\r\n") ? "\r\n" : "\n";
  const lines = record.text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "## Trace");
  if (start < 0) throw new Failure(`${entry.rel} has no "## Trace" section. Run: ${SCRIPT} check`);
  const after = lines.slice(start + 1).findIndex((line) => line.startsWith("## "));
  const end = after < 0 ? lines.length : start + 1 + after;
  const body = lines.slice(start + 1, end);
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body.at(-1).trim()) body.pop();
  const tail = lines.slice(end);
  writeFileSync(entry.full, [...lines.slice(0, start + 1), "", ...body, ...added, ...(tail.length ? ["", ...tail] : [""])].join(eol));
  return `${entry.rel}: ${added.join(", ")}\n`;
}

try {
  const { positional, options } = parseArguments(process.argv.slice(2));
  const [command, ...rest] = positional;
  const root = () => findRoot(options);
  const commands = {
    new: () => create(root(), rest[0], options),
    list: () => list(root(), options),
    search: () => search(root(), rest),
    quote: () => quote(root(), rest[0], rest[1], rest[2]),
    check: () => check(root()),
    render: () => render(root(), options),
    guard: () => guard(root(), options),
    agree: () => agree(root(), rest[0], options),
    sources: () => sources(root(), options),
    ledger: () => ledger(root(), rest[0], rest[1], rest[2], rest[3]),
    uncovered: () => uncovered(root(), rest),
    untraced: () => untraced(root(), options),
    link: () => link(root(), rest[0], rest[1], options),
    narrate: () => narrate(root(), rest[0], options),
    narrative: () => narrative(root()),
    publish: () => publish(root(), options),
  };
  if (!commands[command]) throw new Usage(`Unknown command "${command ?? ""}": use ${COMMANDS}`);
  process.stdout.write(commands[command]());
} catch (error) {
  if (!(error instanceof Usage || error instanceof Failure)) throw error;
  process.stderr.write(`requirements: ${error.message}\n`);
  process.exitCode = error instanceof Usage ? 2 : 1;
}
