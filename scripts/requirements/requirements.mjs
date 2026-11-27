import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliError } from "../ndev/common.mjs";
import { modelCheck, modelPin } from "./models.mjs";
import { discardReport, verify, verifyBrief, verifyJudge } from "./verify.mjs";

const DIR = "docs/formal/requirements";
const DEPRECATED = "docs/formal/deprecated";
const FIXED = ["id", "title", "author", "origin"];
const HTML = `${DIR}/generated/requirements.html`;
const UP = "../".repeat(HTML.split("/").length - 1);
const NAME = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const STATUS = /^(Proposed|Open|Accepted|Rejected|Retired|Superseded by (\d{4}))$/;
const STATUS_ORDER = ["Accepted", "Proposed", "Open", "Rejected", "Retired", "Superseded"];
const IN_FORCE = ["Proposed", "Open", "Accepted"];
const UNDECIDED = ["Proposed", "Open"];
const ORIGINS = ["explicit", "implied", "PR"];
const LEVELS = ["soft", "normal", "hard"];
const TYPES = ["principle", "product", "ux", "design", "operational", "implementation", "architectural", "process"];
const TYPE_LIST = `${TYPES.slice(0, -1).join(", ")} or ${TYPES.at(-1)}`;
const PULL = /^https:\/\/\S+\/pull\/\d+/;
const METHODS = ["test", "check", "model", "eval", "review"];
const SECTIONS = ["Statement", "Explanation", "Source text", "Trace", "Notes", "Log"];
const LOG_ENTRY = /^- \d{4}-\d{2}-\d{2}: \S.*$/;
const CITATION = /^(.+)#L(\d+)-L(\d+)$/;
const LINK = /\[([^\]]+)\]\(([^()\s]+(?:\([^()\s]*\)[^()\s]*)*)\)/g;
const FLAGS = new Set(["check", "clear", "flagged", "all"]);
const COMMANDS = "new, list, search, quote, check, render, guard, agree, flag, level, type, author, model, sync, log, sources, ledger, uncovered, untraced, link, file, decision, trace, links, explained, levels, types, cites, for, narrate, narrative, publish, references, retire, deprecate, fixed, model-check, model-pin, verify, verify-brief, verify-judge";
const PUBLISH = `${DIR}/extra/publish.json`;
const PUBLISH_KEYS = ["to", "format", "source", "route", "frontMatter", "meta", "groupBy"];
const TYPE_PAGES = {
  principle: ["Principle", "A guiding principle of the client: moral, ethical, commercial or intellectual. Decisions are made from it. It does not say what the product does."],
  product: ["Product", "A functional requirement of the product: what a user uses, and what the product does for them. A customer use case usually attaches to it."],
  ux: ["UX", "A product requirement that is not a direct function: the experience of using the product, such as feedback, flow, wording, waiting and accessibility."],
  design: ["Design", "A visual, audio or brand choice."],
  operational: ["Operational", "The operation of the product: hosting, infrastructure, deployment, backups, cost limits, monitoring and the browsers it supports."],
  architectural: ["Architectural", "How the product is built, without the fine detail: the parts, where data lives, and how the parts talk."],
  implementation: ["Implementation", "How one specific piece of the product is implemented."],
  process: ["Process", "How the team builds, checks, records and releases the product: the development workflow, CI, reviews, tests, decision records and documentation. It does not change what the product does."],
};
const MANIFEST = ".published";
const INLINE_PART = /(`[^`]+`|\[[^\]]+\]\((?:<[^>\n]*>|[^()\s]+(?:\([^()\s]*\)[^()\s]*)*)\)|https?:\/\/[^\s<>()]+)/;
const OUTLINE = `${DIR}/extra/outline.md`;
const NARRATIVE = `${DIR}/generated/narrative`;
const REQ_ID = /\bREQ-\d{4}\b/g;
const PULL_URL = /^https:\/\/\S+\/pull\/\d+$/;
const ISSUE_URL = /^https:\/\/\S+\/issues\/\d+$/;
const TRACE_LINK = /^- (PR|Issue|File): (.*)$/;
const TRACE_NONE = /^- None:(.*)$/;
const TRACE_DECISION = /^- (PDR|ADR): (.*)$/;
const DECISION_FOLDERS = { PDR: /^pdrs?$/i, ADR: /^(adrs?|decisions)$/i };
const GH_ISSUES = "gh issue list --state all --limit 10000 --json url,state";
const GH_PRS = "gh pr list --state merged --limit 1000 --json number,title,url,closingIssuesReferences";
const LEDGER = `${DIR}/extra/ledger.md`;
const LEDGER_ENTRY = /^- (.+)#L(\d+)-L(\d+) ([0-9a-f]{12}): (.+)$/;
const TIERS = [[1, "requirements"], [2, "wiki"], [3, "readme"], [4, "other"]];
const NORMATIVE = /\b(must|shall|should|never|always|required|requires?|cannot|may not|will not|refuses?|only)\b/i;
const AGREED = /^(.+), (\d{4}-\d{2}-\d{2}), text ([0-9a-f]{12})$/;
const AGREED_FORM = `"agreed: <name>, YYYY-MM-DD, text <hash>"`;
const FIELDS = { ID: "id", Title: "title", Status: "status", Origin: "origin", Level: "level", Type: "type", Section: "section", Date: "date", Source: "source", Author: "author", Supersedes: "supersedes", "Superseded by": "superseded_by", "Decided by": "decided_by", Verification: "verification", Model: "model", Issues: "issues", PRs: "prs", NFR: "nfr", Agreed: "agreed", Flagged: "flagged" };
const KEYS = Object.values(FIELDS);
const LISTS = ["source", "author", "supersedes", "verification", "model", "issues", "prs"];
const MODEL_ENTRY = /^([^#\s]+\.qnt)(?:#([A-Za-z_][A-Za-z0-9_]*))?$/;
const MODEL_FORM = "Give a .qnt path from the project root, with #<name> after it for one part of the model.";
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9 ._/#:-]*$/;
const UNSUPPORTED = /^[[\]{}|>&*!%@`#]|\s#|:$|: /;
const RESERVED = /^(true|false|yes|no|on|off|null|y|n)$/i;
const PROTECTED = ["Statement", "Source text"];
const SCRIPT = "ndev requirements";
const RETIRED = `${DIR}/extra/retired.md`;
const FROZEN = `${DIR}/extra/sources`;
const RETIRED_ENTRY = /^- (\S+) ([0-9a-f]{12}) (\S+)(?: keep (\S+))?$/;
const RETIRED_FORM = `"- <path> <hash> <decision record>", with "keep <file>,<file>" after it when files keep a reference`;

class Usage extends Error {}
class Failure extends Error {}

function parseArguments(argv) {
  const positional = [];
  const options = {};
  let unread;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!argv[i].startsWith("--")) positional.push(argv[i]);
    else if (FLAGS.has(argv[i].slice(2))) options[argv[i].slice(2)] = true;
    else {
      const name = argv[i];
      const value = argv[i + 1];
      if (value === undefined || (positional[0] === "verify" && value.startsWith("--"))) unread ??= `${name} needs a value`;
      else {
        options[name.slice(2)] = value;
        i++;
      }
    }
  }
  return { positional, options, unread };
}

function findRoot(options) {
  if (options.root) return path.resolve(options.root);
  const out = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (out.status !== 0) throw new Failure(`Not inside a git repository: git rev-parse exited ${out.status}: ${out.stderr.trim()}. Run from the project, or pass --root <dir>.`);
  return out.stdout.trim();
}

function entries(root) {
  return [DIR, DEPRECATED].flatMap((folder) => {
    const dir = path.join(root, folder);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith(".md") && d.name !== "README.md").map((d) => d.name).sort().map((file) => ({ file, rel: `${folder}/${file}`, full: path.join(dir, file), id: `REQ-${file.slice(0, 4)}`, deprecated: folder === DEPRECATED }));
  }).sort((a, b) => a.file.slice(0, 4).localeCompare(b.file.slice(0, 4)));
}

const recordPath = (rel) => rel.startsWith(`${DIR}/`) || rel.startsWith(`${DEPRECATED}/`);
const GONE = /^(Retired|Superseded by \d{4})$/;

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

function yamlValue(raw) {
  if (raw.startsWith('"')) return JSON.parse(raw);
  if (raw.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(raw)) throw new SyntaxError("unclosed single quote");
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  if (UNSUPPORTED.test(raw)) throw new SyntaxError("unsupported YAML");
  return raw;
}

function frontMatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return { body: text };
  const end = lines.indexOf("---", 1);
  if (end < 0) return { error: `the front matter has no closing "---" line.`, body: text };
  const data = {};
  let list;
  for (const line of lines.slice(1, end)) {
    if (!line.trim()) {
      list = undefined;
      continue;
    }
    const item = line.match(/^\s*- (.*)$/);
    const pair = line.match(/^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/);
    try {
      if (item && list) list.push(yamlValue(item[1].trim()));
      else if (!pair) return { error: `front matter line ${JSON.stringify(line)} is not "key: value" or "  - item".`, body: text };
      else if (Object.hasOwn(data, pair[1])) return { error: `"${pair[1]}" is in the front matter more than once.`, body: text };
      else {
        const raw = (pair[2] ?? "").trim();
        list = raw ? undefined : [];
        data[pair[1]] = raw === "[]" ? [] : raw ? yamlValue(raw) : list;
      }
    } catch {
      return { error: `front matter line ${JSON.stringify(line)} is not valid. Records use plain values, "double-quoted" or 'single-quoted' values, and lists of "  - item" lines. Quote a value with a special character.`, body: text };
    }
  }
  return { data, body: lines.slice(end + 1).join("\n"), eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

const yamlScalar = (value) => (PLAIN.test(value) && !UNSUPPORTED.test(value) && !value.endsWith(" ") && !RESERVED.test(value) && !/^[\d.]+$/.test(value) ? value : JSON.stringify(value));

function yamlLines(key, value) {
  if (!Array.isArray(value)) return [`${key}: ${yamlScalar(String(value))}`];
  if (!value.length) return [`${key}: []`];
  return [`${key}:`, ...value.map((item) => `  - ${typeof item === "number" ? item : yamlScalar(String(item))}`)];
}

function frontMatterText(data) {
  return ["---", ...KEYS.filter((k) => data[k] !== undefined).flatMap((k) => yamlLines(k, data[k])), "---", ""].join("\n");
}

function parse(entry, text) {
  const front = frontMatter(text);
  const data = front.data ?? {};
  const field = (name) => {
    const value = data[FIELDS[name] ?? name];
    if (value === undefined) return undefined;
    return Array.isArray(value) ? value.join(", ") : String(value).trim();
  };
  const author = data.author === undefined ? [] : (Array.isArray(data.author) ? data.author : [data.author]).map((name) => String(name).trim());
  const legacy = !front.data && !front.error && /^- ID:/m.test(text);
  const title = field("Title");
  const body = front.body.replace(/\r\n/g, "\n");
  const sections = Object.fromEntries(SECTIONS.map((name) => [name, sectionBody(body, name)]));
  return { ...entry, text, front, data, field, author, legacy, status: field("Status"), section: field("Section") ?? "", title: title || entry.file, hasTitle: Boolean(title), sections };
}

function setField(entry, key, value) {
  const record = read(entry);
  if (!record.front.data) throw new Failure(`${entry.rel} has no valid front matter, so "${key}" cannot change. Run: ${SCRIPT} check`);
  const { eol } = record.front;
  const lines = record.text.split(eol);
  const end = lines.indexOf("---", 1);
  const extent = (start) => {
    let stop = start + 1;
    while (stop < end && /^\s*- /.test(lines[stop])) stop += 1;
    return stop;
  };
  const at = (k) => lines.findIndex((line, i) => i > 0 && i < end && line.startsWith(`${k}:`));
  const found = at(key);
  if (value === undefined) {
    if (found < 0) return false;
    lines.splice(found, extent(found) - found);
  } else if (found > 0) lines.splice(found, extent(found) - found, ...yamlLines(key, value));
  else {
    const before = KEYS.slice(0, KEYS.indexOf(key)).map(at).filter((i) => i > 0);
    lines.splice(before.length ? extent(Math.max(...before)) : 1, 0, ...yamlLines(key, value));
  }
  writeFileSync(entry.full, lines.join(eol));
  return true;
}

const outside = (root, rel) => path.isAbsolute(rel) || path.relative(root, path.resolve(root, rel)).split(path.sep)[0] === "..";
const frozenCopy = (rel) => `${FROZEN}/${rel}`;
const contentHash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 12);

function retiredEntries(root) {
  const full = path.join(root, RETIRED);
  if (!existsSync(full)) return { entries: [], problems: [] };
  const entries = [];
  const problems = [];
  for (const line of readFileSync(full, "utf8").split("\n").filter((l) => l.startsWith("- "))) {
    const m = line.match(RETIRED_ENTRY);
    const keep = m?.[4]?.split(",") ?? [];
    if (!m || [m[1], m[3], ...keep].some((rel) => !rel || outside(root, rel))) problems.push(`${RETIRED}: "${line}" does not have the form ${RETIRED_FORM}, with paths inside the project. Retire a document with: ${SCRIPT} retire <path> --pdr <decision record>`);
    else entries.push({ rel: m[1], hash: m[2], pdr: m[3], keep, copy: frozenCopy(m[1]) });
  }
  return { entries, problems };
}

const retiredCache = new Map();
const retiredPaths = (root) => {
  if (!retiredCache.has(root)) retiredCache.set(root, new Set(retiredEntries(root).entries.map((e) => e.rel)));
  return retiredCache.get(root);
};

function retiredProblems(root) {
  const { entries, problems } = retiredEntries(root);
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.rel)) problems.push(`${RETIRED}: ${entry.rel} is on more than one line. Remove the repeated line.`);
    seen.add(entry.rel);
    if (existsSync(path.join(root, entry.rel))) problems.push(`${entry.rel} is retired and exists again. Delete it, or remove its line from ${RETIRED} and delete its frozen copy ${entry.copy}.`);
    const copy = path.join(root, entry.copy);
    if (!existsSync(copy)) problems.push(`${entry.copy}, the frozen copy of ${entry.rel}, is missing. Restore it from the git history.`);
    else if (contentHash(readFileSync(copy, "utf8")) !== entry.hash) problems.push(`${entry.copy}, the frozen copy of ${entry.rel}, changed after it was frozen. A frozen copy does not change: restore it from the git history.`);
    if (!existsSync(path.join(root, entry.pdr))) problems.push(`${entry.pdr}, the decision record for ${entry.rel}, does not exist.`);
    for (const file of entry.keep) if (!existsSync(path.join(root, file))) problems.push(`${file}, kept with a reference to the retired ${entry.rel}, does not exist. Remove it from the keep list of ${entry.rel} in ${RETIRED}.`);
  }
  return problems;
}

function fileLines(root, rel) {
  if (outside(root, rel)) return { error: `${rel} is outside the project. Name a file by its path from the repository root.` };
  let full = path.resolve(root, rel);
  if (!existsSync(full) && retiredPaths(root).has(rel)) full = path.join(root, frozenCopy(rel));
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
    if (record.legacy) {
      fail(`the fields are a "- Name: value" list under the title. Put them in YAML front matter at the top of the file, as in kb/requirements.md.`);
      continue;
    }
    if (record.front.error) {
      fail(record.front.error);
      continue;
    }
    if (!record.front.data) {
      fail(`no YAML front matter. The file starts with a "---" line, the fields, and a "---" line, as in kb/requirements.md.`);
      continue;
    }
    for (const [key, value] of Object.entries(record.data)) {
      if (!KEYS.includes(key)) fail(`"${key}" is not a field of a record. The fields are ${KEYS.join(", ")}.`);
      else if (Array.isArray(value) && !LISTS.includes(key)) fail(`"${key}" is a list. It takes one value.`);
    }
    const present = Object.keys(record.data).filter((key) => KEYS.includes(key));
    if (present.join() !== KEYS.filter((key) => present.includes(key)).join()) fail(`the fields are not in the order ${KEYS.join(", ")}. Put them in that order.`);
    if (!record.hasTitle) fail(`no "title" in the front matter. Add "title: <short title>".`);
    if (!sourceCurrent(record)) fail(`"source" is not the citations of the source text, in order (${[sourceField(record)].flat().join(", ") || "none"}): one value for one citation, a list for more. Run: ${SCRIPT} sync ${entry.id}`);
    const linked = linkFields(record);
    if (!numbersCurrent(record.data.issues, linked.issues)) fail(`"issues" is not the numbers of the issues in the Trace (${linked.issues.join(", ") || "none"}). Run: ${SCRIPT} sync ${entry.id}`);
    if (!numbersCurrent(record.data.prs, linked.prs)) fail(`"prs" is not the numbers of the pull requests in the Trace and the source text (${linked.prs.join(", ") || "none"}). Run: ${SCRIPT} sync ${entry.id}`);
    if (!record.author.length || record.author.some((name) => !name)) fail(`no "author". List the people who wrote the source text: ${SCRIPT} author ${entry.id} "<name>"`);
    const id = record.field("ID");
    if (id !== entry.id) fail(`"id: ${id ?? ""}" does not match the file number. Use "id: ${entry.id}".`);
    if (record.status === undefined) fail(`no "status". Add "status: Proposed".`);
    else if (!STATUS.test(record.status)) fail(`status "${record.status}" is not Proposed, Open, Accepted, Rejected, Retired or Superseded by NNNN.`);
    else {
      const by = record.status.match(/^Superseded by (\d{4})$/)?.[1];
      if (by && by === number) fail(`${record.status} names itself. Name the record that replaces it.`);
      else if (by && !numbers.has(by)) fail(`${record.status}, which does not exist in ${DIR} or ${DEPRECATED}.`);
      else if (by && by < number) fail(`${record.status}, which is older. A replacement is a new record with a higher number.`);
      if (GONE.test(record.status) && !entry.deprecated) fail(`the status is ${record.status}, and the record is not in ${DEPRECATED}. Run: ${SCRIPT} deprecate ${entry.id} --reason "<why>" --decided-by "<name>"`);
      if (!GONE.test(record.status) && entry.deprecated) fail(`the status is ${record.status}, and only a Retired or Superseded record is in ${DEPRECATED}. Move it back to ${DIR} with git mv.`);
    }
    const origin = record.field("Origin");
    if (!ORIGINS.includes(origin)) fail(`origin "${origin ?? ""}" is not explicit, implied or PR.`);
    for (const problem of levelProblems(record)) fail(problem);
    for (const problem of typeProblems(record)) fail(problem);
    const date = record.field("Date");
    if (date === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`"date" needs YYYY-MM-DD (got "${date ?? "no value"}").`);
    const verification = record.field("Verification");
    if (!verification) fail(`no "verification" value. Use unassigned, or a list of one or more of ${METHODS.join(", ")}.`);
    else if (verification !== "unassigned") for (const method of verification.split(",").map((m) => m.trim())) if (!METHODS.includes(method)) fail(`verification "${method}" is not unassigned, ${METHODS.slice(0, -1).join(", ")} or ${METHODS.at(-1)}.`);
    if (IN_FORCE.includes(record.status)) for (const model of modelEntries(record)) for (const problem of modelProblems(root, entry.id, model)) fail(problem);
    const agreed = record.field("Agreed");
    if (agreed !== undefined && !AGREED.test(agreed)) fail(`"agreed: ${agreed}" does not have the form ${AGREED_FORM}. Only a human writes it, with: ${SCRIPT} agree ${entry.id} --by "<name>"`);
    if ("flagged" in record.data && (typeof record.data.flagged !== "string" || !record.data.flagged.trim())) fail(`"flagged" has no text. Give the reason the record looks wrong, or remove it with: ${SCRIPT} flag ${entry.id} --clear`);
    const proposed = UNDECIDED.includes(record.status);
    for (const name of ["Section", "Decided by"]) {
      const value = record.field(name);
      if (value === undefined) fail(`no "${FIELDS[name]}" in the front matter.`);
      else if (!value && !proposed) fail(`"${FIELDS[name]}" has no value, and the status is ${record.status}. Fill it, or keep the status Proposed or Open.`);
    }
    for (const name of ["Statement", "Source text"]) {
      const body = record.sections[name];
      if (body === undefined) fail(`missing the section "## ${name}".`);
      else if (!body && !proposed) fail(`the section "## ${name}" is empty, and the status is ${record.status}. Fill it, or keep the status Proposed or Open.`);
    }
    for (const problem of explanationProblems(record)) fail(problem);
    if (record.sections.Log === undefined) fail(`missing the section "## Log".`);
    else {
      const logged = logEntries(record);
      if (!logged.length) fail(`the Log has no entry. Each record starts with "- YYYY-MM-DD: Created." Add it with: ${SCRIPT} log ${entry.id} "Created."`);
      for (const line of logged) if (!LOG_ENTRY.test(line)) fail(`Log line "${line}" is not "- YYYY-MM-DD: <what changed>". Add an entry with: ${SCRIPT} log ${entry.id} "<what changed>"`);
    }
    const { sources, stray } = sourceText(record.sections["Source text"]);
    const form = `Each source is "- <path>#L<first>-L<last>" or "- <https link>", then its quote. Make one with: ${SCRIPT} quote <path> <first> <last>`;
    if (origin === "PR" && sources.length && !sources.some((source) => PULL.test(source.url ?? ""))) fail(`the origin is PR, and the source text names no pull request. Add "- <https link to the pull request>" and its quote.`);
    for (const line of stray) fail(`source text line "${line}" belongs to no citation. ${form}`);
    const lines = traceLines(record);
    if ("nfr" in record.data && record.data.nfr !== "true") fail(`"nfr" takes the value true. Leave it out for a functional requirement.`);
    for (const line of lines.filter((l) => TRACE_NONE.test(l))) {
      if (record.data.nfr !== "true") fail(`trace line "${line}" is only for a non-functional requirement (nfr: true). Link what implements the requirement, or the issue that plans it.`);
      else if (!line.match(TRACE_NONE)[1].trim()) fail(`trace line "${line}" gives no reason. Write why nothing implements the requirement: "- None: <reason>".`);
      else if (lines.some((l) => TRACE_LINK.test(l))) fail(`trace line "${line}" is in a Trace that has a link. Remove it.`);
    }
    for (const line of (record.sections.Trace ?? "").split("\n")) {
      const link = line.trim().match(TRACE_LINK);
      if (link?.[1] === "PR" && !PULL_URL.test(link[2].trim())) fail(`trace line "${line.trim()}" is not a link to a pull request.`);
      if (link?.[1] === "Issue" && !ISSUE_URL.test(link[2].trim())) fail(`trace line "${line.trim()}" is not a link to an issue.`);
      if (link?.[1] === "File" && !filePattern(link[2].trim())) fail(`trace line "${line.trim()}" is not a path or pattern inside the project.`);
      const decision = line.trim().match(TRACE_DECISION);
      if (decision) {
        const rel = decision[2].trim();
        if (decisionKind(rel) !== decision[1]) fail(`trace line "${line.trim()}" is not a Markdown file in ${decision[1] === "PDR" ? "a pdr folder" : "an adr or decisions folder"}. Correct the path, or the kind of the line.`);
        else if (IN_FORCE.includes(record.status) && !existsSync(path.join(root, rel))) fail(`trace line "${line.trim()}" names a file that does not exist. Correct the path, or remove the line.`);
      }
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
  problems.push(...supersessionProblems(records));
  problems.push(...retiredProblems(root));
  return { problems, records };
}

function supersessionProblems(records) {
  const byRel = new Map(records.map((record) => [record.rel, record]));
  const problems = [];
  for (const record of records) {
    if (!record.data) continue;
    const number = record.file.slice(0, 4);
    const replaced = record.data.superseded_by;
    if (replaced !== undefined) {
      const target = byRel.get(String(replaced));
      if (!target) problems.push(`${record.rel}: "superseded_by: ${replaced}" names no record. Give the path of the record that replaces it, from the project root.`);
      else if (record.status !== `Superseded by ${target.file.slice(0, 4)}`) problems.push(`${record.rel}: "superseded_by" names ${target.id}, and the status is ${record.status}. The status of a replaced record is "Superseded by ${target.file.slice(0, 4)}".`);
    }
    for (const rel of [record.data.supersedes ?? []].flat().map(String)) {
      const target = byRel.get(rel);
      if (!target) problems.push(`${record.rel}: "supersedes: ${rel}" names no record. Give the path of the record that it replaces, from the project root.`);
      else if (target.status !== `Superseded by ${number}`) problems.push(`${record.rel}: "supersedes" names ${target.id}, whose status is ${target.status}. The status of a replaced record is "Superseded by ${number}".`);
    }
  }
  return problems;
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

function row(records, { flags = false } = {}) {
  const width = Math.max(...records.map((r) => (r.status ?? "NO STATUS").length));
  return records.map((r) => `${r.id}  ${(r.status ?? "NO STATUS").padEnd(width)}  ${r.title}  ${r.rel}${flags ? `\n  Flagged: ${r.field("Flagged")}` : ""}`).join("\n") + "\n";
}

function list(root, options) {
  if (options.level !== undefined && !LEVELS.includes(options.level)) throw new Usage(`Unknown level "${options.level}": use soft, normal or hard`);
  if (options.type !== undefined && !TYPES.includes(options.type)) throw new Usage(`Unknown type "${options.type}": use ${TYPE_LIST}`);
  const all = entries(root).map(read);
  if (!all.length) return `No records in ${DIR}\n`;
  const records = all.filter((r) => (options.status === undefined || (r.status ?? "").startsWith(options.status)) && (options.section === undefined || r.section === options.section) && (!options.flagged || Boolean(r.field("Flagged"))) && (options.level === undefined || r.field("Level") === options.level) && (options.type === undefined || r.field("Type") === options.type));
  if (!records.length) return `No record matches the filter (${all.length} record${all.length === 1 ? "" : "s"} in ${DIR})\n`;
  return row(records, { flags: Boolean(options.flagged) });
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
  const level = options.level ?? "normal";
  if (!LEVELS.includes(level)) throw new Usage(`Unknown level "${level}": use soft, normal or hard`);
  const type = options.type;
  const title = (sentence ?? "").trim();
  if (!title || !slug(title)) throw new Usage(`new needs a short title, for example: new "The report names each source" --author "Ann Smith"`);
  const author = (options.author ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  if (!author.length) throw new Usage(`new needs --author "<name>, <name>": the people who wrote the source text`);
  if (type === undefined) throw new Usage(`new needs --type <type>: one of ${TYPE_LIST}. See the Types section of the requirements format (kb/requirements.md).`);
  if (!TYPES.includes(type)) throw new Usage(`Unknown type "${type}": use ${TYPE_LIST}`);
  const existing = entries(root);
  const bad = existing.find((e) => !NAME.test(e.file));
  if (bad) throw new Failure(`${bad.rel} does not match NNNN-<title>.md, so the next number is unknown. Rename it, or run check.`);
  if (options.base) git(root, ["rev-parse", "--verify", `${options.base}^{commit}`]);
  const next = nextFree(root, options.base ? baseRecords(root, options.base) : []);
  const full = path.join(root, DIR, `${next}-${slug(title)}.md`);
  const data = { id: `REQ-${next}`, title, status: "Proposed", origin, level, type, section: (options.section ?? "").trim(), date: new Date().toISOString().slice(0, 10), source: [], author, decided_by: "", verification: "unassigned", issues: [], prs: [] };
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, frontMatterText(data) + SECTIONS.map((s) => (s === "Log" ? `\n## Log\n\n- ${data.date}: Created.\n` : `\n## ${s}\n`)).join(""), { flag: "wx" });
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

function article(record, retired) {
  const sources = sourceText(record.sections["Source text"]).sources.map((s) => `<li><a href="${escape(s.url ?? `${UP}${encodeURI(retired.has(s.rel) ? frozenCopy(s.rel) : s.rel)}#L${s.first}-L${s.last}`)}">${escape(s.citation)}</a>\n<blockquote class="source">${escape(s.quote.join("\n"))}</blockquote></li>`);
  const decided = record.field("Decided by") ? `Decided by ${escape(record.field("Decided by"))}, ${escape(record.field("Date"))}` : `Dated ${escape(record.field("Date"))}`;
  const meta = [escape(record.status), `Level: ${escape(record.field("Level") ?? "")}`, `Type: ${escape(record.field("Type") ?? "")}`, escape(record.field("Origin")), `Verification: ${escape(record.field("Verification"))}`, `Author: ${escape(record.author.join(", "))}`, decided, `<a href="../${encodeURI(record.file)}">record</a>`];
  const optional = ["Trace", "Notes", "Log"].filter((name) => record.sections[name]).map((name) => `<h4>${name}</h4>\n${blocks(record.sections[name])}`);
  return [
    `<article id="${record.id}" class="status-${record.status.split(" ")[0].toLowerCase()}">`,
    `<h3><a href="#${record.id}">${record.id}</a> ${escape(record.title)}</h3>`,
    `<p class="meta">${meta.join(" · ")}</p>`,
    ...(record.field("Flagged") ? [`<p class="flagged">Flagged: ${escape(record.field("Flagged"))}</p>`] : []),
    `<div class="statement">\n${blocks(record.sections.Statement ?? "")}\n</div>`,
    ...(record.sections.Explanation ? [`<h4>Explanation</h4>\n<div class="explanation">\n${blocks(record.sections.Explanation)}\n</div>`] : []),
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
.status-open{border-style:dashed;border-color:var(--link)}
.flagged{margin:.5rem 0 0;padding:.25rem .75rem;border-left:3px solid var(--link);font-size:.9rem}
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
  const flagged = records.filter((r) => r.field("Flagged")).length;
  return `${records.length} record${records.length === 1 ? "" : "s"}${counts.length ? `: ${counts.join(", ")}` : ""}.${flagged ? ` ${flagged} flagged.` : ""}`;
}

function document(records, { title = "Requirements", order = [], narratives = new Map(), retired = new Set() } = {}) {
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
    ...named.map((g) => [`<section id="${g.id}">`, `<h2>${escape(g.name)}</h2>`, ...narrativeHtml(g.narrative, g.narrative?.hash === sectionHash(g.members)), ...g.members.map((r) => article(r, retired)), `</section>`].join("\n")),
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
  const html = document(records, { ...outline(root, records), narratives: narratives(root), retired: retiredPaths(root) });
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
  if (config.groupBy !== undefined && config.groupBy !== "type") problems.push(`${PUBLISH}: "groupBy" is ${JSON.stringify(config.groupBy)}. The only value is "type". Leave it out for one page for each section.`);
  const front = config.frontMatter ?? {};
  if (typeof front !== "object" || Array.isArray(front)) problems.push(`${PUBLISH}: "frontMatter" is not an object.`);
  else
    for (const [key, value] of Object.entries(front)) {
      if (key === "title") problems.push(`${PUBLISH}: "frontMatter"."title" is not allowed. The title comes from the outline and the section.`);
      else if (key === "description") problems.push(`${PUBLISH}: "frontMatter"."description" is not allowed. Each page has its own description, made from its records.`);
      else if (typeof value !== "string" && !(Array.isArray(value) && value.every((item) => typeof item === "string"))) problems.push(`${PUBLISH}: "frontMatter"."${key}" is not text or a list of text.`);
    }
  if (problems.length) throw new Failure(problems.join("\n"));
  return { to: to.split(path.sep).join("/"), mdx: config.format === "mdx", ext: `.${config.format}`, source: config.source?.replace(/\/?$/, "/"), route: config.route?.replace(/\/$/, ""), front, meta: config.meta, byType: config.groupBy === "type" };
}

function publication(root, config) {
  const records = valid(root);
  const { title = "Requirements", order = [] } = outline(root, records);
  const groups = sectionRecords(records);
  const names = [...order.filter((name) => groups.has(name)), ...[...groups.keys()].filter((name) => !order.includes(name))];
  const folders = [];
  const pages = [];
  if (config.byType) {
    const untyped = [...groups.values()].flat().filter((r) => !TYPES.includes(r.field("Type")));
    if (untyped.length) throw new Failure(`${untyped.map((r) => r.id).join(", ")} ${untyped.length === 1 ? "has" : "have"} no type, and "groupBy": "type" puts each page under its type. Set it with: ${SCRIPT} type <REQ-NNNN> <type>, where <type> is one of ${TYPE_LIST}.`);
    for (const type of Object.keys(TYPE_PAGES)) {
      const typed = names.map((name) => ({ name, section: name, slug: `${type}/${slug(name) || "none"}`, members: groups.get(name).filter((r) => r.field("Type") === type) })).filter((p) => p.members.length);
      if (!typed.length) continue;
      folders.push({ type, name: TYPE_PAGES[type][0], about: TYPE_PAGES[type][1], slug: `${type}/index`, pages: typed, members: typed.flatMap((p) => p.members) });
      pages.push(...typed);
    }
  } else pages.push(...names.map((name) => ({ name, section: name, slug: slug(name) || "none", members: groups.get(name) })));
  const others = records.filter((r) => !IN_FORCE.includes(r.status));
  if (others.length) pages.push({ name: "Not in force", slug: "not-in-force", members: others });
  const seen = new Map();
  for (const p of pages) {
    if (path.posix.basename(p.slug) === "index" || seen.has(p.slug)) throw new Failure(`The section "${p.name}" gives the page name ${p.slug}${config.ext}, which ${path.posix.basename(p.slug) === "index" ? "the index uses" : `the section "${seen.get(p.slug)}" uses too`}. Rename the section.`);
    seen.set(p.slug, p.name);
  }
  const route = (name, from = "index") => (config.mdx ? `${config.route}/${name}`.replace(/\/index$/, "") : path.posix.relative(path.posix.dirname(from), `${name}${config.ext}`));
  let at = "index";
  const fileLink = (rel) => (config.source ? `${config.source}${encodeURI(rel)}` : encodeURI(path.posix.relative(path.posix.join(config.to, path.posix.dirname(at)), rel)));
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
        if (i % 2 === 0) return here ? plain(part).replace(REQ_ID, (id) => (home.has(id) ? `[${id}](${home.get(id) === here ? "" : route(home.get(id).slug, here.slug)}#${id})` : id)) : plain(part);
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
  const counting = (n) => `${n} requirement record${n === 1 ? "" : "s"}`;
  const frontMatter = (name, members, description) => {
    const lines = [`title: ${yaml(name)}`, `description: ${yaml(description)}`];
    for (const [key, value] of Object.entries(config.front)) {
      if (typeof value === "string") lines.push(`${key}: ${yaml(value)}`);
      else lines.push(`${key}:`, ...value.flatMap((item) => (item === "{records}" ? members.map((r) => r.rel) : [item])).map((item) => `  - ${yaml(item)}`));
    }
    return `---\n${lines.join("\n")}\n---\n`;
  };
  const fence = (lines) => "`".repeat(Math.max(3, ...lines.map((line) => Math.max(0, ...(line.match(/`+/g) ?? []).map((run) => run.length + 1)))));
  const retired = retiredPaths(root);
  const sourceLink = (s) => s.url ?? `${fileLink(retired.has(s.rel) ? frozenCopy(s.rel) : s.rel)}#L${s.first}-L${s.last}`;
  const entry = (record, here) => {
    const decided = record.field("Decided by") ? `Decided by ${record.field("Decided by")}, ${record.field("Date")}` : `Dated ${record.field("Date")}`;
    const meta = [record.status, `Level: ${record.field("Level") ?? ""}`, `Type: ${record.field("Type") ?? ""}`, record.field("Origin"), `Verification: ${record.field("Verification")}`, `Author: ${record.author.join(", ")}`, decided].map(text).join(" · ");
    const parts = [`<a id="${record.id}"></a>`, `## ${record.id} ${text(record.title)}`, `${meta} · [record](${fileLink(record.rel)})`, ...(record.field("Flagged") ? [`> **Flagged:** ${text(record.field("Flagged"))}`] : []), markdown(record.sections.Statement ?? "", DIR, here)];
    if (record.sections.Explanation) parts.push("### Explanation", markdown(record.sections.Explanation, DIR, here));
    const sources = sourceText(record.sections["Source text"]).sources;
    if (sources.length) parts.push("### Source text", ...sources.map((s) => [`- [${text(s.citation)}](${sourceLink(s)})`, ...(s.quote.length ? [`${fence(s.quote)}text\n${s.quote.join("\n")}\n${fence(s.quote)}`] : [])].join("\n\n")));
    for (const name of ["Trace", "Notes", "Log"]) if (record.sections[name]) parts.push(`### ${name}`, markdown(record.sections[name], DIR, here));
    return parts.join("\n\n");
  };
  const stored = narratives(root);
  const files = new Map();
  const typeOf = new Map(pages.map((p) => [p, folders.find((f) => f.pages.includes(p))?.type]));
  for (const p of pages) {
    at = p.slug;
    const found = p.section ? stored.get(p.section) : undefined;
    const prose = found ? [...(found.hash === sectionHash(groups.get(p.section)) ? [] : ["> The records of this section changed after this text was written."]), markdown(found.prose, NARRATIVE, p)] : [];
    const type = typeOf.get(p);
    files.set(`${p.slug}${config.ext}`, `${frontMatter(p.name, p.members, `${counting(p.members.length)}${type ? ` of the type ${type}` : ""} in the ${p.name} section.`)}\n${[`# ${text(p.name)}`, ...prose, ...p.members.map((r) => entry(r, p))].join("\n\n")}\n`);
  }
  const listing = (list, from) => list.map((p) => `- [${text(p.name)}](${route(p.slug, from)}) (${p.members.length})`).join("\n");
  at = "index";
  for (const f of folders) {
    const sections = `${f.pages.length} section${f.pages.length === 1 ? "" : "s"}`;
    files.set(`${f.slug}${config.ext}`, `${frontMatter(f.name, f.members, `${counting(f.members.length)} of the type ${f.type} in ${sections}.`)}\n# ${text(f.name)}\n\n${text(f.about)}\n\n${counted(f.members)}\n\n${listing(f.pages, f.slug)}\n`);
  }
  const top = config.byType ? [...folders, ...pages.filter((p) => !typeOf.get(p))] : pages;
  const kinds = config.byType ? `${folders.length} type${folders.length === 1 ? "" : "s"}` : `${pages.length} section${pages.length === 1 ? "" : "s"}`;
  files.set(`index${config.ext}`, `${frontMatter(title, records, `${counting(records.length)} in ${kinds}.`)}\n# ${text(title)}\n\n${counted(records)}\n\n${listing(top, "index")}\n`);
  const json = pages.flatMap((p) =>
    p.members.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      origin: r.field("Origin"),
      level: r.field("Level") ?? "",
      type: r.field("Type") ?? "",
      section: r.section,
      date: r.field("Date"),
      author: r.author,
      decidedBy: r.field("Decided by") ?? "",
      verification: r.field("Verification"),
      flagged: r.field("Flagged") ?? "",
      statement: r.sections.Statement ?? "",
      explanation: r.sections.Explanation ?? "",
      sources: sourceText(r.sections["Source text"]).sources.map((s) => ({ citation: s.citation, link: sourceLink(s) })),
      trace: r.sections.Trace ?? "",
      log: r.sections.Log ?? "",
      notes: r.sections.Notes ?? "",
      page: route(p.slug),
      record: fileLink(r.rel),
    })),
  );
  files.set("requirements.json", `${JSON.stringify({ title, records: json }, null, 2)}\n`);
  const meta = (entries) => `export default {\n${entries.map(([key, name]) => `  ${yaml(key)}: ${yaml(name)}`).join(",\n")}\n};\n`;
  if (config.meta === "nextra") {
    files.set("_meta.js", meta([["index", title], ...top.map((p) => [p.type ?? p.slug, p.name])]));
    for (const f of folders) files.set(`${f.type}/_meta.js`, meta([["index", f.name], ...f.pages.map((p) => [path.posix.basename(p.slug), p.name])]));
  }
  return files;
}

function publish(root, options) {
  const config = publishConfig(root);
  const files = publication(root, config);
  const dir = path.join(root, config.to);
  const manifest = path.join(dir, MANIFEST);
  const shown = (name) => `${config.to}/${name}`;
  const last = new Set(existsSync(manifest) ? readFileSync(manifest, "utf8").split("\n").filter(Boolean) : []);
  const strange = [...last].filter((name) => !/^(?:[a-z]+\/)?[^/\\]+$/.test(name) || name.split("/").some((part) => part === "." || part === ".."));
  if (strange.length) throw new Failure(strange.map((name) => `${shown(MANIFEST)}: "${name}" is not a plain file name. Correct the file, or delete it and the files that it names.`).join("\n"));
  const listing = `${[...files.keys()].sort().join("\n")}\n`;
  const problems = [];
  for (const name of files.keys()) if (existsSync(path.join(dir, name)) && !last.has(name)) problems.push(`${shown(name)} exists and the last publish did not write it. Move it, or set "to" in ${PUBLISH} to a folder of its own.`);
  const left = [...last].filter((name) => !files.has(name) && existsSync(path.join(dir, name)));
  for (const folder of new Set([...files.keys()].filter((name) => name.includes("/")).map((name) => path.dirname(name)))) if (existsSync(path.join(dir, folder)) && !lstatSync(path.join(dir, folder)).isDirectory()) problems.push(`${shown(folder)} is a file, and the pages of the type ${folder} go in a folder of that name. Move the file.`);
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
  for (const [name, content] of files) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  for (const name of left) rmSync(path.join(dir, name));
  for (const folder of new Set(left.filter((name) => name.includes("/")).map((name) => path.join(dir, path.dirname(name))))) if (!readdirSync(folder).length) rmSync(folder, { recursive: true });
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

function baseRecords(root, base) {
  return git(root, ["ls-tree", "--name-only", base, "--", `${DIR}/`, `${DEPRECATED}/`]).split("\n").filter((rel) => rel && NAME.test(path.posix.basename(rel))).map((rel) => {
    const file = path.posix.basename(rel);
    return parse({ file, rel, id: `REQ-${file.slice(0, 4)}` }, git(root, ["show", `${base}:./${rel}`]));
  });
}

const fixedValue = (record, key) => {
  const value = key === "author" ? record.author.filter(Boolean) : record.data[key] === undefined ? "" : String(record.data[key]).trim();
  return value.length ? JSON.stringify(value) : undefined;
};

export function fixedChanges(before, after) {
  return FIXED.filter((key) => fixedValue(before, key) !== undefined && fixedValue(before, key) !== fixedValue(after, key));
}

export function parseRecord(rel, text) {
  const file = path.posix.basename(rel);
  return parse({ file, rel, id: `REQ-${file.slice(0, 4)}` }, text);
}

function pairWithBase(base, currents) {
  const counts = new Map();
  for (const old of base) counts.set(old.id, (counts.get(old.id) ?? 0) + 1);
  const slugOf = (file) => file.slice(5);
  return base.map((old) => {
    if (counts.get(old.id) === 1) return { old, now: currents.find((record) => record.id === old.id) };
    const now = currents.find((record) => record.rel === old.rel) ?? currents.find((record) => slugOf(record.file) === slugOf(old.file));
    return { old, now, renumbered: Boolean(now) && now.id !== old.id && !counts.has(now.id) };
  });
}

function takenNumber(baseRecs, now) {
  const held = baseRecs.filter((old) => old.id === now.id);
  const same = (old) => old.rel === now.rel || old.file.slice(5) === now.file.slice(5) || (old.data?.title !== undefined && old.data.title === now.data?.title);
  return held.length && !held.some(same) ? held : undefined;
}

function nextFree(root, baseRecs) {
  const numbers = [...entries(root), ...baseRecs].map((e) => Number(e.file.slice(0, 4)));
  return String(Math.max(0, ...numbers) + 1).padStart(4, "0");
}

const renumberedLines = (pairs, base) => pairs.filter((pair) => pair.renumbered).map(({ old, now }) => `${old.id} (${old.rel} at ${base}) renumbered to ${now.id}: ${now.rel}\n`).join("");

function fixedProblems(old, now, base, { renumbered = false } = {}) {
  if (!old.front.data || !now.front.data) return [];
  return fixedChanges(old, now).filter((key) => !(renumbered && key === "id")).map((key) => `${now.rel}: the ${key} changed since ${base}. The id, title, author and origin of a record never change after it is created: restore it. To change the requirement, deprecate the record and create a new one: ${SCRIPT} deprecate ${now.id} --reason "<why>" --decided-by "<name>" --by <REQ-NNNN>`);
}

function fixed(root, options) {
  const base = options.base;
  if (!base) throw new Usage("fixed needs --base <git ref>, for example: fixed --base HEAD");
  git(root, ["rev-parse", "--verify", `${base}^{commit}`]);
  const current = entries(root).filter((e) => NAME.test(e.file)).map(read);
  const pairs = pairWithBase(baseRecords(root, base), current).filter((pair) => pair.now);
  const problems = pairs.flatMap(({ old, now, renumbered }) => fixedProblems(old, now, base, { renumbered }));
  if (problems.length) throw new Failure(problems.join("\n"));
  return `${current.length} record${current.length === 1 ? "" : "s"}: no fixed field changed since ${base}\n${renumberedLines(pairs, base)}`;
}

function deprecate(root, id, options) {
  if (!/^REQ-\d{4}$/.test(id ?? "")) throw new Usage(`deprecate needs <REQ-NNNN> --reason "<why>" --decided-by "<name>", and --by <REQ-NNNN> when a newer record replaces it`);
  const reason = (options.reason ?? "").trim();
  if (!reason || /[\r\n]/.test(reason)) throw new Usage(`deprecate needs --reason "<why>" on one line`);
  const decider = (options["decided-by"] ?? "").trim();
  if (!decider) throw new Usage(`deprecate needs --decided-by "<name>": the human who decided to deprecate ${id}. An agent never decides it.`);
  const all = entries(root).filter((e) => NAME.test(e.file));
  const entry = all.find((e) => e.id === id);
  if (!entry) throw new Failure(`${id} is not a record in ${DIR}.`);
  if (entry.deprecated) throw new Failure(`${id} is already in ${DEPRECATED}: ${entry.rel}.`);
  let by;
  if (options.by !== undefined) {
    if (!/^REQ-\d{4}$/.test(options.by)) throw new Usage(`--by needs a record ID, such as REQ-0002 (got "${options.by}")`);
    by = all.find((e) => e.id === options.by && !e.deprecated);
    if (!by) throw new Failure(`${options.by} is not a record in ${DIR}. Create the replacement first with: ${SCRIPT} new "<title>" --author "<name>"`);
    if (by.id === id) throw new Failure(`${id} cannot replace itself. Give the newer record that replaces it.`);
    if (by.file < entry.file) throw new Failure(`${by.id} is older than ${id}. A replacement is a newer record: create it with: ${SCRIPT} new "<title>" --author "<name>"`);
  }
  const status = by ? `Superseded by ${by.file.slice(0, 4)}` : "Retired";
  const moved = { ...entry, rel: `${DEPRECATED}/${entry.file}`, full: path.join(root, DEPRECATED, entry.file), deprecated: true };
  const links = [];
  for (const other of all.filter((e) => e.rel !== entry.rel)) {
    const record = read(other);
    if (!record.data) continue;
    if (String(record.data.superseded_by ?? "") === entry.rel) links.push([other, "superseded_by", moved.rel]);
    const replaces = [record.data.supersedes ?? []].flat().map(String);
    const wanted = [...replaces.map((rel) => (rel === entry.rel ? moved.rel : rel)), ...(by && other.rel === by.rel && !replaces.includes(entry.rel) ? [moved.rel] : [])];
    if (wanted.join("\n") !== replaces.join("\n")) links.push([other, "supersedes", wanted]);
  }
  mkdirSync(path.join(root, DEPRECATED), { recursive: true });
  git(root, ["mv", "--", entry.rel, moved.rel]);
  setField(moved, "status", status);
  setField(moved, "decided_by", decider);
  if (by) setField(moved, "superseded_by", by.rel);
  appendLines(moved, "Log", [`- ${new Date().toISOString().slice(0, 10)}: Deprecated${by ? `, superseded by ${by.id}` : ""}: ${reason}`], { unique: false });
  for (const [other, key, value] of links) setField(other, key, value);
  git(root, ["add", "--", moved.rel]);
  return `${entry.rel} -> ${moved.rel}: ${status}\n${by ? `${by.rel}: supersedes ${moved.rel}\n` : ""}`;
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
  for (const record of current.values()) {
    if (!IN_FORCE.includes(record.status)) continue;
    if (traceLines(record).some((line) => TRACE_LINK.test(line)) || noLinkReason(record)) continue;
    problems.push(`${record.rel}: the Trace has no link to what implements the requirement or plans to implement it. Add the files with: ${SCRIPT} file ${record.id} <path or pattern>. Add the pull request with: ${SCRIPT} link ${record.id} <pull request link>. When nothing implements it yet, open an issue for it and add "- Issue: <issue link>". When nothing implements it and nothing will, it is not a requirement: reject or retire it. A non-functional requirement (nfr: true) with nothing to link gives the reason as "- None: <reason>".`);
  }
  const baseRecs = baseRecords(root, base);
  const taken = new Set();
  const records = named.map(read);
  for (const record of records) {
    const held = takenNumber(baseRecs, record);
    if (!held) continue;
    taken.add(record.rel);
    const free = nextFree(root, baseRecs);
    const target = `${path.posix.dirname(record.rel)}/${free}-${record.file.slice(5)}`;
    problems.push(`${record.rel}: ${record.id} is already held at ${base} by ${held.map((old) => old.rel).join(", ")}: another pull request took the number first. Numbers are never reused. Give this record the next free number: git mv ${record.rel} ${target}, set "id: REQ-${free}" in it, then run: ${SCRIPT} check`);
  }
  const pairs = pairWithBase(baseRecs, records);
  for (const { old, now, renumbered } of pairs) {
    if (now && taken.has(now.rel)) continue;
    if (!now) {
      problems.push(`${old.id} (${old.rel} at ${base}) is deleted. A record is never deleted: restore it, and deprecate it with: ${SCRIPT} deprecate ${old.id} --reason "<why>" --decided-by "<name>"`);
      continue;
    }
    problems.push(...fixedProblems(old, now, base, { renumbered }));
    const before = protectedParts(old);
    const after = protectedParts(now);
    const changed = PROTECTED.filter((name) => before[name] !== after[name]);
    const oldLog = logEntries(old);
    const nowLog = logEntries(now);
    const lost = oldLog.find((line, i) => nowLog[i] !== line);
    if (lost) problems.push(`${now.rel}: the Log entry "${lost}" of ${base} is changed or removed. The Log only grows: restore the entry, and add a new one with: ${SCRIPT} log ${now.id} "<what changed>"`);
    const tracked = [...["title", "status", "level", "type"].filter((key) => old.data[key] !== now.data[key]), ...changed];
    if (tracked.length && nowLog.length <= oldLog.length) problems.push(`${now.rel}: the ${tracked.join(" and the ")} changed since ${base}, and the Log has no new entry. Run: ${SCRIPT} log ${now.id} "<what changed>"`);
    if (!changed.length) continue;
    const agreed = now.field("Agreed")?.match(AGREED);
    if (agreed && agreed[3] === textHash(now)) continue;
    const parts = changed.map((name) => `the ${name}`).join(" and ");
    const why = agreed ? "the agreement is for other text: the text changed after the human agreed" : "no human agreed to the change";
    const diff = changed.map((name) => `  ${name}, old:\n${indented(old.sections[name])}\n  ${name}, new:\n${indented(now.sections[name])}`).join("\n");
    problems.push(`${now.rel}: ${parts} changed since ${base}, and ${why}.\n${diff}\n  Show the human the old and the new text. When they agree, they run: ${SCRIPT} agree ${now.id} --by "<name>". Otherwise, restore the old text.`);
  }
  if (problems.length) throw new Failure(problems.join("\n"));
  return `${current.size} record${current.size === 1 ? "" : "s"} guarded against ${base}: no protected text changed without agreement\n${renumberedLines(pairs, base)}`;
}

function agree(root, id, options) {
  if (!/^REQ-\d{4}$/.test(id ?? "") || !options.by?.trim()) throw new Usage(`agree needs <REQ-NNNN> --by "<name>", for example: agree REQ-0001 --by "Ann Smith"`);
  if (!process.stdin.isTTY) throw new Failure(`agree records the agreement of a human to a changed Statement or Source text, so only a human runs it, in a terminal. Show the human the old and the new text, and ask them to run: ${SCRIPT} agree ${id} --by "<name>"`);
  const entry = entries(root).find((e) => e.id === id && NAME.test(e.file));
  if (!entry) throw new Failure(`${id} is not a record in ${DIR}.`);
  const value = `${options.by.trim()}, ${new Date().toISOString().slice(0, 10)}, text ${textHash(read(entry))}`;
  setField(entry, "agreed", value);
  return `${entry.rel}: agreed: ${value}\n`;
}

function flag(root, [id, reason, ...extra], options) {
  const what = (reason ?? "").trim();
  if (!/^REQ-\d{4}$/.test(id ?? "") || extra.length || Boolean(options.clear) === Boolean(what) || /[\r\n]/.test(what)) throw new Usage(`flag needs <REQ-NNNN> "<why the record looks wrong>" on one line, in quotes, or <REQ-NNNN> --clear, for example: flag REQ-0001 "The Statement names a route that the code does not have."`);
  const entry = recordEntry(root, id);
  if (!options.clear) {
    setField(entry, "flagged", what);
    return `${entry.rel}: flagged: ${what}\n`;
  }
  return setField(entry, "flagged", undefined) ? `${entry.rel}: flag cleared\n` : `${entry.rel}: no flag to clear\n`;
}

function level(root, [id, value, ...extra]) {
  if (!/^REQ-\d{4}$/.test(id ?? "") || extra.length || !LEVELS.includes(value)) throw new Usage(`level needs <REQ-NNNN> soft|normal|hard, for example: level REQ-0001 hard`);
  const entry = recordEntry(root, id);
  const was = read(entry).field("Level");
  if (was === value) return `${entry.rel}: the level is already ${value}\n`;
  setField(entry, "level", value);
  appendLines(entry, "Log", [`- ${new Date().toISOString().slice(0, 10)}: ${LEVELS.includes(was) ? `Level changed from ${was} to ${value}.` : `Level set to ${value}.`}`], { unique: false });
  return `${entry.rel}: level: ${value}${was === undefined ? "" : ` (was ${was})`}\n`;
}

function type(root, [id, value, ...extra]) {
  if (!/^REQ-\d{4}$/.test(id ?? "") || extra.length || !TYPES.includes(value)) throw new Usage(`type needs <REQ-NNNN> <type>, where <type> is one of ${TYPE_LIST}, for example: type REQ-0001 product`);
  const entry = recordEntry(root, id);
  const was = read(entry).field("Type");
  if (was === value) return `${entry.rel}: the type is already ${value}\n`;
  setField(entry, "type", value);
  appendLines(entry, "Log", [`- ${new Date().toISOString().slice(0, 10)}: ${TYPES.includes(was) ? `Type changed from ${was} to ${value}.` : `Type set to ${value}.`}`], { unique: false });
  return `${entry.rel}: type: ${value}${was === undefined ? "" : ` (was ${was})`}\n`;
}

const logEntries = (record) => (record.sections.Log ?? "").split("\n").map((line) => line.trim()).filter(Boolean);

function log(root, id, text) {
  const what = (text ?? "").trim();
  if (!/^REQ-\d{4}$/.test(id ?? "") || !what || /[\r\n]/.test(what)) throw new Usage(`log needs <REQ-NNNN> "<what changed>" on one line, for example: log REQ-0001 "Retired, because the report was removed."`);
  const entry = recordEntry(root, id);
  const line = `- ${new Date().toISOString().slice(0, 10)}: ${what}`;
  appendLines(entry, "Log", [line], { unique: false });
  return `${entry.rel}: ${line}\n`;
}

function sourceField(record) {
  const cited = sourceText(record.sections["Source text"]).sources.map((source) => source.citation);
  return cited.length === 1 ? cited[0] : cited;
}

const sourceCurrent = (record) => JSON.stringify(record.data.source) === JSON.stringify(sourceField(record));

const urlNumber = (url) => Number(url.match(/\/(\d+)$/)[1]);
const numberList = (urls, form) => [...new Set([...urls].filter((url) => form.test(url)).map(urlNumber))].sort((a, b) => a - b);

function linkFields(record) {
  const { prs, issues } = traces(record);
  return { issues: numberList(issues, ISSUE_URL), prs: numberList(prs, PULL_URL) };
}

const numbersCurrent = (value, wanted) => Array.isArray(value) && value.length === wanted.length && value.every((item, i) => /^\d+$/.test(String(item)) && Number(item) === wanted[i]);
const synced = (record) => sourceCurrent(record) && numbersCurrent(record.data.issues, linkFields(record).issues) && numbersCurrent(record.data.prs, linkFields(record).prs);

function syncRecord(entry) {
  const record = read(entry);
  const value = sourceField(record);
  const { issues, prs } = linkFields(record);
  setField(entry, "source", value);
  setField(entry, "issues", issues);
  setField(entry, "prs", prs);
  const shown = (list) => list.join(", ") || "none";
  return `${entry.rel}: source: ${shown([value].flat())}; issues: ${shown(issues)}; prs: ${shown(prs)}\n`;
}

function sync(root, ids) {
  for (const id of ids) if (!/^REQ-\d{4}$/.test(id)) throw new Usage(`sync takes record ids, for example: sync REQ-0001. Got "${id}"`);
  if (ids.length) return ids.map((id) => syncRecord(recordEntry(root, id))).join("");
  const records = entries(root).filter((e) => NAME.test(e.file)).map(read);
  const broken = records.filter((record) => !record.front.data);
  if (broken.length) throw new Failure(broken.map((record) => `${record.rel} has no valid front matter, so nothing is written. Run: ${SCRIPT} check`).join("\n"));
  const stale = records.filter((record) => !synced(record));
  for (const record of stale) syncRecord(record);
  return `${stale.length} ${stale.length === 1 ? "record" : "records"} synced\n`;
}

function author(root, id, names) {
  const people = names.map((name) => name.trim());
  if (!/^REQ-\d{4}$/.test(id ?? "") || !people.length || people.some((name) => !name)) throw new Usage(`author needs <REQ-NNNN> and one or more names, for example: author REQ-0001 "Suriya Khan" "Carter Dillard"`);
  const comma = people.find((name) => name.includes(","));
  if (comma) throw new Usage(`"${comma}" has a comma. Give each name as its own argument, for example: author ${id} "Suriya Khan" "Carter Dillard"`);
  const entry = recordEntry(root, id);
  const tracked = spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { encoding: "utf8" }).status === 0;
  const base = tracked ? baseRecords(root, "HEAD").find((old) => old.id === id && old.front.data) : undefined;
  if (base && fixedValue(base, "author") !== undefined) throw new Failure(`${id} is committed with the author ${base.author.filter(Boolean).join(", ")}. The author of a record never changes after it is created. To change the requirement, deprecate the record and create a new one: ${SCRIPT} deprecate ${id} --reason "<why>" --decided-by "<name>" --by <REQ-NNNN>`);
  setField(entry, "author", people);
  return `${entry.rel}: author: ${people.join(", ")}\n`;
}

const modelEntries = (record) => [record.data.model ?? []].flat().map(String);
const modelFiles = (record) => [...new Set(modelEntries(record).map((model) => model.split("#")[0]))];
const modelRecords = (root) => entries(root).filter((e) => NAME.test(e.file)).map(read).map((r) => ({ id: r.id, status: r.status, inForce: IN_FORCE.includes(r.status), models: modelFiles(r) }));

function modelForm(root, model) {
  const match = model.match(MODEL_ENTRY);
  if (!match || outside(root, match[1])) return `"${model}" is not a Quint model. ${MODEL_FORM}`;
  const plain = path.posix.normalize(match[1]);
  if (plain !== match[1]) return `"${model}" is not in its plain form. Write "${model.replace(match[1], plain)}".`;
  return null;
}

function modelProblems(root, id, model) {
  const form = modelForm(root, model);
  if (form) return [`model ${form}`];
  const [, file, name] = model.match(MODEL_ENTRY);
  const full = path.join(root, file);
  if (!existsSync(full) || !lstatSync(full).isFile()) return [`model "${model}" does not exist. Write the model with the quint-modeling skill, or correct the path.`];
  const text = readFileSync(full, "utf8");
  const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const problems = [];
  if (!(text.match(REQ_ID) ?? []).includes(id)) problems.push(`model "${model}" does not cite ${id}. Add a comment that names ${id} at the part of the model that specifies it.`);
  if (name && !new RegExp(`(^|[\\s{;])(pure\\s+)?(val|def|action|temporal|run)\\s+${name}\\b`, "m").test(code)) problems.push(`model "${model}": ${file} declares no val, def, action, temporal or run named "${name}".`);
  return problems;
}

function model(root, id, list) {
  if (!/^REQ-\d{4}$/.test(id ?? "") || !list.length) throw new Usage(`model needs <REQ-NNNN> and one or more Quint models, for example: model REQ-0001 models/report.qnt "models/report.qnt#names"`);
  const form = list.map((entry) => modelForm(root, entry)).find(Boolean);
  if (form) throw new Usage(form);
  const twice = list.find((entry, i) => list.indexOf(entry) !== i);
  if (twice) throw new Usage(`"${twice}" is given twice. Give each model once.`);
  const entry = recordEntry(root, id);
  const problems = list.flatMap((m) => modelProblems(root, id, m));
  if (problems.length) throw new Failure(problems.map((problem) => `${id}: ${problem}`).join("\n"));
  const listed = modelEntries(read(entry));
  const added = list.filter((m) => !listed.includes(m));
  if (!added.length) return `${id} already lists ${list.join(", ")}\n`;
  const models = [...listed, ...added];
  setField(entry, "model", models);
  return `${entry.rel}: model: ${models.join(", ")}\n`;
}

function decisionKind(rel) {
  if (!filePattern(rel) || /[*?]/.test(rel) || rel.startsWith("/") || !/\.mdx?$/i.test(rel)) return undefined;
  const folders = rel.split("/").slice(0, -1);
  return Object.keys(DECISION_FOLDERS).find((kind) => folders.some((folder) => DECISION_FOLDERS[kind].test(folder)));
}

function decisionLinks(root, id, paths) {
  if (!/^REQ-\d{4}$/.test(id ?? "") || !paths.length) throw new Usage(`decision needs <REQ-NNNN> <path>..., for example: decision REQ-0001 docs/pdr/0001-keep-sources.md`);
  for (const rel of paths) if (!decisionKind(rel)) throw new Usage(`"${rel}" is not a Markdown file in a pdr, adr or decisions folder. Name a decision record by its path from the project root.`);
  const entry = recordEntry(root, id);
  const files = new Set(trackedFiles(root));
  const untracked = paths.filter((rel) => !files.has(rel));
  if (untracked.length) throw new Failure(untracked.map((rel) => `"${rel}" is not a tracked file. git add it first.`).join("\n"));
  const added = appendTrace(entry, paths.map((rel) => `- ${decisionKind(rel)}: ${rel}`));
  if (!added.length) return `${id} already lists ${paths.join(", ")}\n`;
  return `${entry.rel}: ${added.join(", ")}\n`;
}

function tier(rel) {
  const parts = rel.split("/");
  const stem = parts.at(-1).replace(/\.mdx?$/i, "");
  if (parts.slice(0, -1).some((p) => /^(requirements?|specs?|specifications?|pdrs?|adrs?|decisions)$/i.test(p)) || /^(north[_-]?star|requirements?|specs?|specifications?|prd)$/i.test(stem)) return 1;
  if (parts.some((p) => /^wiki$/i.test(p) || /\.wiki$/i.test(p))) return 2;
  if (/^readme$/i.test(stem)) return 3;
  return 4;
}

function documents(root) {
  const generated = publishedFolder(root);
  return git(root, ["ls-files", "-z", "--", "*.md", "*.mdx"]).split("\0").filter((rel) => rel && !recordPath(rel) && !(generated && rel.startsWith(`${generated}/`)) && existsSync(path.join(root, rel))).map((rel) => ({ rel, tier: tier(rel) })).sort((a, b) => a.tier - b.tier || (a.rel < b.rel ? -1 : 1));
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

function coverage(root, targets) {
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
  return { rows, problems, total, byRecord, byLedger };
}

const coverageSummary = (rows, total, targets) => {
  const normative = rows.filter((r) => r.normative).length;
  return `${rows.length} of ${total} prose lines in ${targets.length} file${targets.length === 1 ? "" : "s"} not accounted for${normative ? ` (${normative} normative)` : ""}. Write a record for each requirement, and a ledger entry for the other lines.`;
};
const coverageRows = (rows) => rows.map((r) => `${r.rel}:${r.number}  ${r.normative ? "normative  " : ""}${r.text}`);

function uncovered(root, paths) {
  const targets = paths.length ? paths : documents(root).filter((d) => d.tier === 1).map((d) => d.rel);
  if (!targets.length) throw new Failure(`No tier 1 document to read. Name the documents: ${SCRIPT} uncovered <path>...`);
  const { rows, problems, total, byRecord, byLedger } = coverage(root, targets);
  const files = `${targets.length} file${targets.length === 1 ? "" : "s"}`;
  if (!rows.length && !problems.length) return `${total} prose line${total === 1 ? "" : "s"} in ${files}: ${byRecord} cited by records, ${byLedger} in the ledger, 0 not accounted for\n`;
  process.stdout.write(coverageRows(rows).join("\n") + (rows.length ? "\n" : ""));
  throw new Failure([...problems, coverageSummary(rows, total, targets)].join("\n"));
}

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function publishedFolder(root) {
  if (!existsSync(path.join(root, PUBLISH))) return undefined;
  return publishConfig(root).to;
}

const namePattern = (rel) => new RegExp(`(?<![\\w-])(?<![\\w-][./])${escaped(rel)}(?![\\w/-]|\\.\\w)`);
const plainPath = (rel) => /^\S+$/.test(rel) && path.posix.normalize(rel) === rel && rel.split("/")[0] !== "..";
const DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/;

function referenceLines(root, rels, skip = []) {
  const named = rels.map(namePattern);
  const generated = publishedFolder(root);
  const left = (file) => rels.includes(file) || recordPath(file) || skip.includes(file) || (generated && file.startsWith(`${generated}/`));
  const found = [];
  for (const file of git(root, ["ls-files", "-z"]).split("\0").filter((f) => f && !left(f)).sort()) {
    const full = path.join(root, file);
    if (!existsSync(full) || !lstatSync(full).isFile()) continue;
    const text = readFileSync(full, "utf8");
    if (text.includes("\0")) continue;
    const markdown = /\.mdx?$/i.test(file);
    text.split("\n").forEach((line, i) => {
      const links = markdown ? [...line.matchAll(LINK)].map((m) => m[2]).concat(line.match(DEFINITION)?.[1] ?? []) : [];
      const target = (href) => {
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return undefined;
        const raw = href.split(/[#?]/)[0];
        let linked;
        try {
          linked = decodeURI(raw);
        } catch {
          linked = raw;
        }
        return linked.startsWith("/") ? linked.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(file), linked));
      };
      const linked = links.map(target);
      const matched = rels.filter((rel, j) => named[j].test(line) || linked.includes(rel));
      if (matched.length) found.push({ file, number: i + 1, text: line.trim(), rels: matched });
    });
  }
  return found;
}

const shownReference = (hit) => `${hit.file}:${hit.number}  ${hit.text}`;

function references(root, rel) {
  if (!rel) throw new Usage(`references needs <path>, for example: references docs/guide.md`);
  const found = referenceLines(root, [rel]);
  return found.length ? `${found.map(shownReference).join("\n")}\n` : `No tracked file references ${rel}\n`;
}

function retire(root, rels, options) {
  if (!rels.length || !options.pdr) throw new Usage(`retire needs <path>... --pdr <decision record> [--keep <file>,<file>], for example: retire docs/guide.md --pdr docs/pdr/0003-retire-the-guide.md --keep supabase/migrations/0001_init.sql`);
  const keep = [...new Set(options.keep === undefined ? [] : options.keep.split(","))].sort();
  for (const given of [...rels, options.pdr, ...keep]) if (!plainPath(given) || outside(root, given)) throw new Failure(`${given} is not a plain path: name the file by its path from the repository root, with no spaces, no "./" or "../" and no repeated "/".`);
  const already = retiredPaths(root);
  const problems = [];
  for (const rel of new Set(rels)) {
    if (already.has(rel)) problems.push(`${rel} is already retired (${RETIRED}).`);
    else if (!existsSync(path.join(root, rel))) problems.push(`${rel} does not exist.`);
    else if (existsSync(path.join(root, frozenCopy(rel)))) problems.push(`${frozenCopy(rel)} exists, and ${RETIRED} does not name ${rel}. Find out why the copy is there, and move or delete it.`);
  }
  if (problems.length) throw new Failure(problems.join("\n"));
  const targets = [...new Set(rels)];
  const pdr = path.join(root, options.pdr);
  if (!existsSync(pdr)) throw new Failure(`${options.pdr} does not exist. Write the decision record first.`);
  const decision = readFileSync(pdr, "utf8");
  const unnamed = targets.filter((rel) => !namePattern(rel).test(decision));
  if (unnamed.length) throw new Failure(unnamed.map((rel) => `${options.pdr} does not name ${rel}. The decision record names each document that it retires.`).join("\n"));
  const { rows, problems: stale, total } = coverage(root, targets);
  if (rows.length || stale.length) throw new Failure([...coverageRows(rows), ...stale, ...(rows.length ? [coverageSummary(rows, total, targets)] : []), `A document is retired only when each of its lines is accounted for.`].join("\n"));
  const referring = referenceLines(root, targets, [options.pdr]);
  const idle = keep.filter((file) => !referring.some((hit) => hit.file === file));
  if (idle.length) throw new Failure(idle.map((file) => `${file} is in --keep and does not reference ${targets.join(" or ")}. Remove it from --keep.`).join("\n"));
  const found = referring.filter((hit) => !keep.includes(hit.file));
  if (found.length) {
    const files = new Set(found.map((hit) => hit.file)).size;
    throw new Failure(`${found.map(shownReference).join("\n")}\n${found.length} line${found.length === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"} reference${found.length === 1 ? "s" : ""} ${targets.join(", ")}. Point each one at the records or the published pages, then retire. A file that is history and does not change, such as an applied migration, goes in --keep.`);
  }
  const lines = [];
  for (const rel of targets) {
    const text = readFileSync(path.join(root, rel), "utf8");
    const copy = path.join(root, frozenCopy(rel));
    mkdirSync(path.dirname(copy), { recursive: true });
    writeFileSync(copy, text);
    const kept = keep.filter((file) => referring.some((hit) => hit.file === file && hit.rels.includes(rel)));
    lines.push(`- ${rel} ${contentHash(text)} ${options.pdr}${kept.length ? ` keep ${kept.join(",")}` : ""}`);
  }
  const list = path.join(root, RETIRED);
  const head = existsSync(list) ? readFileSync(list, "utf8") : `# Retired documents\n\nDocuments whose lines the records and the ledger hold. Each has a frozen copy in ${FROZEN}. Retire a document with ${SCRIPT} retire.\n\n`;
  writeFileSync(list, `${head.replace(/\n*$/, "\n")}${head.includes("\n- ") ? "" : "\n"}${lines.join("\n")}\n`);
  for (const rel of targets) rmSync(path.join(root, rel));
  return targets.map((rel) => `${rel} retired: frozen copy ${frozenCopy(rel)}, decision ${options.pdr}\n`).join("");
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

const traceLines = (record) => (record.sections.Trace ?? "").split("\n").map((line) => line.trim());
const noLinkReason = (record) => record.data.nfr === "true" && traceLines(record).some((line) => line.match(TRACE_NONE)?.[1].trim());

function traces(record) {
  const prs = new Set();
  const issues = new Set();
  const files = new Set();
  for (const line of (record.sections.Trace ?? "").split("\n")) {
    const link = line.trim().match(TRACE_LINK);
    if (link) ({ PR: prs, Issue: issues, File: files })[link[1]].add(link[2].trim());
  }
  const linkedPrs = new Set(prs);
  for (const source of sourceText(record.sections["Source text"]).sources) {
    const pull = source.url?.match(PULL)?.[0];
    if (pull) prs.add(pull);
  }
  return { prs, linkedPrs, issues, files };
}

const linkedRecords = (root) => entries(root).filter((e) => NAME.test(e.file)).map((e) => read(e)).map((r) => ({ ...r, links: traces(r) }));

function pullProblems(prs, records, file) {
  const missing = [];
  const problems = [];
  for (const pr of prs) {
    const tracing = records.filter((r) => r.links.prs.has(pr.url));
    if (!tracing.length) missing.push(pr);
    for (const record of tracing) for (const issue of pr.issues) if (!record.links.issues.has(issue)) problems.push(`${record.id} traces ${pr.url}, which closes ${issue}, and does not link it. Run: ${SCRIPT} link ${record.id} ${pr.url} --prs ${file}`);
  }
  missing.sort((a, b) => a.number - b.number);
  if (missing.length) problems.push(`${missing.length} of ${prs.length} merged pull requests trace to no record. Link each to the records it implements with ${SCRIPT} link, or write a record with: ${SCRIPT} new "<title>" --origin PR`);
  return { missing, problems };
}

const listed = (missing) => process.stdout.write(missing.map((pr) => `#${pr.number}  ${pr.title}  ${pr.url}`).join("\n") + (missing.length ? "\n" : ""));

function untraced(root, options) {
  const prs = pullRequests(root, options.prs);
  const { missing, problems } = pullProblems(prs, linkedRecords(root), options.prs);
  if (!problems.length) return `${prs.length} merged pull request${prs.length === 1 ? "" : "s"}: each traces to a record, with the issues it closes\n`;
  listed(missing);
  throw new Failure(problems.join("\n"));
}

function link(root, id, url, options) {
  if (!/^REQ-\d{4}$/.test(id ?? "") || !PULL_URL.test(url ?? "") || (options.issue !== undefined && !ISSUE_URL.test(options.issue))) throw new Usage(`link needs <REQ-NNNN> <pull request link> [--prs <file>] [--issue <issue link>], for example: link REQ-0001 https://github.com/o/r/pull/12 --prs prs.json`);
  const entry = recordEntry(root, id);
  const issues = [];
  if (options.prs) {
    const pr = pullRequests(root, options.prs).find((p) => p.url === url);
    if (!pr) throw new Failure(`${url} is not in ${options.prs}. Make the file again with: ${GH_PRS} > ${options.prs}`);
    issues.push(...pr.issues);
  }
  if (options.issue) issues.push(options.issue);
  const added = appendTrace(entry, [`- PR: ${url}`, ...issues.map((issue) => `- Issue: ${issue}`)]);
  if (!added.length) return `${id} already links ${url}${issues.length ? " and the issues it closes" : ""}\n`;
  return `${entry.rel}: ${added.join(", ")}\n`;
}

const appendTrace = (entry, wanted) => appendLines(entry, "Trace", wanted, { unique: true });

function appendLines(entry, name, wanted, { unique }) {
  const record = read(entry);
  if (!record.front.data) throw new Failure(`${entry.rel} has no valid front matter, so the ${name} cannot change. Run: ${SCRIPT} check`);
  const held = (record.sections[name] ?? "").split("\n").map((line) => line.trim());
  const added = unique ? wanted.filter((line, i, all) => !held.includes(line) && all.indexOf(line) === i) : wanted;
  if (!added.length) return added;
  const eol = record.text.includes("\r\n") ? "\r\n" : "\n";
  const lines = record.text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${name}`);
  if (start < 0) throw new Failure(`${entry.rel} has no "## ${name}" section. Run: ${SCRIPT} check`);
  const after = lines.slice(start + 1).findIndex((line) => line.startsWith("## "));
  const end = after < 0 ? lines.length : start + 1 + after;
  const body = lines.slice(start + 1, end);
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body.at(-1).trim()) body.pop();
  const tail = lines.slice(end);
  writeFileSync(entry.full, [...lines.slice(0, start + 1), "", ...body, ...added, ...(tail.length ? ["", ...tail] : [""])].join(eol));
  if (name === "Trace") {
    const { issues, prs } = linkFields(read(entry));
    setField(entry, "issues", issues);
    setField(entry, "prs", prs);
  }
  return added;
}

function filePattern(raw) {
  const pattern = raw.startsWith("/") ? raw.slice(1) : raw;
  if (!pattern || pattern !== pattern.trim() || /[\t\r\n]/.test(pattern) || pattern.includes("\\")) return undefined;
  if (pattern.split("/").some((part) => !part || part === "." || part === "..")) return undefined;
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      const whole = (i === 0 || pattern[i - 1] === "/") && (i + 2 === pattern.length || pattern[i + 2] === "/");
      if (!whole) return undefined;
      source += i + 2 === pattern.length ? ".*" : "(?:.*/)?";
      i += 2;
    } else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else source += escaped(c);
  }
  return new RegExp(`^${source}$`);
}

function trackedFiles(root) {
  return git(root, ["ls-files", "-z"]).split("\0").filter((rel, i, all) => rel && all.indexOf(rel) === i && existsSync(path.join(root, rel)) && lstatSync(path.join(root, rel)).isFile()).sort();
}

function recordEntry(root, id) {
  const entry = entries(root).find((e) => e.id === id && NAME.test(e.file));
  if (!entry) throw new Failure(`${id} is not a record in ${DIR}.`);
  return entry;
}

function fileLinks(root, id, patterns) {
  if (!/^REQ-\d{4}$/.test(id ?? "") || !patterns.length) throw new Usage(`file needs <REQ-NNNN> <path or pattern>..., for example: file REQ-0001 src/report.ts "src/report/**"`);
  for (const pattern of patterns) if (!filePattern(pattern)) throw new Usage(`"${pattern}" is not a path or pattern inside the project. Use a path from the project root, with *, ** or ? where needed.`);
  const entry = recordEntry(root, id);
  const files = trackedFiles(root);
  const empty = patterns.filter((pattern) => !files.some((file) => filePattern(pattern).test(file)));
  if (empty.length) throw new Failure(empty.map((pattern) => `"${pattern}" matches no tracked file. Check the path, and git add a new file first.`).join("\n"));
  const added = appendTrace(entry, patterns.map((pattern) => `- File: ${pattern}`));
  if (!added.length) return `${id} already lists ${patterns.join(", ")}\n`;
  return `${entry.rel}: ${added.join(", ")}\n`;
}

function issueStates(root, file) {
  const full = path.resolve(root, file);
  if (!existsSync(full)) throw new Failure(`${file} does not exist. Make it with: ${GH_ISSUES} > ${file}`);
  let data;
  try {
    data = JSON.parse(readFileSync(full, "utf8"));
  } catch (error) {
    throw new Failure(`${file} is not JSON: ${error.message}. Make it with: ${GH_ISSUES} > ${file}`);
  }
  if (!Array.isArray(data)) throw new Failure(`${file} is not a list of issues. Make it with: ${GH_ISSUES} > ${file}`);
  return new Map(data.map((issue, i) => {
    if (!ISSUE_URL.test(issue?.url ?? "")) throw new Failure(`${file}: entry ${i + 1} has no issue url. Make the file with: ${GH_ISSUES} > ${file}`);
    if (typeof issue.state !== "string" || !issue.state) throw new Failure(`${file}: entry ${i + 1} has no state. Make the file with: ${GH_ISSUES} > ${file}`);
    return [issue.url, issue.state];
  }));
}

function citations(root, files, inputs) {
  const generated = publishedFolder(root);
  const skipped = inputs.map((input) => path.relative(root, path.resolve(root, input)).split(path.sep).join("/"));
  const found = [];
  for (const file of files) {
    if (recordPath(file) || (generated && file.startsWith(`${generated}/`)) || skipped.includes(file)) continue;
    const text = readFileSync(path.join(root, file), "utf8");
    if (text.includes("\0")) continue;
    text.split("\n").forEach((line, i) => {
      for (const id of new Set(line.match(REQ_ID) ?? [])) found.push({ file, number: i + 1, id });
    });
  }
  return found;
}

function traceAll(root, options) {
  if (!options.prs || !options.issues) throw new Usage(`trace needs --prs <file> and --issues <file>, made with: ${GH_PRS} and ${GH_ISSUES}`);
  const prs = pullRequests(root, options.prs);
  const issues = issueStates(root, options.issues);
  const records = linkedRecords(root);
  const files = trackedFiles(root);
  const { missing, problems } = pullProblems(prs, records, options.prs);
  const merged = new Set(prs.map((pr) => pr.url));
  const patterns = new Map();
  for (const record of records) {
    const inForce = IN_FORCE.includes(record.status);
    for (const url of record.links.linkedPrs) if (!merged.has(url)) problems.push(`${record.id} links ${url}, which is not a merged pull request in ${options.prs}.`);
    for (const url of record.links.issues) if (!issues.has(url)) problems.push(`${record.id} links ${url}, which is not in ${options.issues}.`);
    const planned = [...record.links.issues].some((url) => issues.get(url) === "OPEN") || noLinkReason(record);
    const compiled = [];
    for (const raw of record.links.files) {
      const regex = filePattern(raw);
      if (regex) compiled.push({ raw, regex });
      else problems.push(`${record.id}: "- File: ${raw}" is not a path or pattern inside the project. Correct it: a path from the project root, with *, ** or ? where needed.`);
    }
    patterns.set(record.id, compiled);
    if (record.status === "Accepted" && !compiled.length && !planned) problems.push(`${record.id} lists no file that implements it, and no open issue that plans it. Add each file or pattern with: ${SCRIPT} file ${record.id} <path or pattern>`);
    if (inForce) for (const { raw, regex } of compiled) if (!files.some((file) => regex.test(file))) problems.push(`${record.id}: "- File: ${raw}" matches no tracked file. Correct the path, or remove the line.`);
  }
  const byId = new Map(records.map((record) => [record.id, record]));
  const cited = citations(root, files, [options.prs, options.issues]);
  for (const { file, number, id } of cited) {
    const record = byId.get(id);
    const where = `${file}:${number} cites ${id}`;
    if (!record) problems.push(`${where}, which is not a record in ${DIR}.`);
    else if (!IN_FORCE.includes(record.status)) problems.push(`${where}, which is ${record.status}. Cite the record in force.`);
    else if (modelFiles(record).includes(file)) continue;
    else if (!patterns.get(id).some(({ regex }) => regex.test(file))) problems.push(file.endsWith(".qnt") ? `${where}, whose record does not list the model. Run: ${SCRIPT} model ${id} ${file}` : `${where}, whose record does not list the file. Run: ${SCRIPT} file ${id} ${file}`);
    else {
      const models = modelFiles(record);
      const text = models.length ? readFileSync(path.join(root, file), "utf8") : "";
      if (models.length && !models.some((m) => text.includes(m))) problems.push(models.length === 1 ? `${where}, whose model is ${models[0]}, and does not cite the model. Add "${models[0]}" next to ${id}, so that the reader finds the specification.` : `${where}, whose models are ${models.join(", ")}, and cites none of them. Add the one that specifies this code next to ${id}, so that the reader finds the specification.`);
    }
  }
  if (problems.length) {
    listed(missing);
    throw new Failure(problems.join("\n"));
  }
  const linkedIssues = new Set(records.flatMap((record) => [...record.links.issues])).size;
  const citing = new Set(cited.map((c) => c.file)).size;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  return `${plural(records.length, "record traces", "records trace")} both ways: ${plural(prs.length, "merged pull request", "merged pull requests")}, ${plural(linkedIssues, "issue", "issues")}, ${plural(citing, "file that cites a record", "files that cite a record")}\n`;
}

const GITHUB_LINK = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/(issues|pull)\/(\d+)$/;
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)|([\w.-]+\/[\w.-]+)?#(\d+))/gi;
const UNIMPLEMENTED = { not_planned: "closed as not planned", duplicate: "closed as a duplicate" };

const READS = new Map();
const STATES = new Map();
const BULK = 10;
let cachedAge;

function gh(root, repo, args) {
  const script = process.env.NDEV_REQUIREMENTS_GH || path.join(import.meta.dirname, "../github/gh.sh");
  const out = spawnSync("bash", [script, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, GH_REPO: repo, GH_CACHE_TTL: process.env.GH_CACHE_TTL ?? "600" } });
  const age = out.stderr?.match(/answered from a cache made (\d+)s ago/);
  if (age) cachedAge = Math.max(cachedAge ?? 0, Number(age[1]));
  if (out.status !== 0) return { error: `gh.sh ${args.join(" ")} in ${repo} exited ${out.status}: ${(out.stderr.trim() || out.stdout.trim() || "no output").slice(0, 300)}` };
  return { stdout: out.stdout };
}

function ghRead(root, repo, kind, number) {
  const command = kind === "pull" ? "pr-read" : "issue-read";
  const key = `${repo.toLowerCase()} ${command} ${number}`;
  if (READS.has(key)) return READS.get(key);
  const { stdout, error } = gh(root, repo, [command, number]);
  let result;
  if (error) result = { error };
  else {
    try {
      result = { item: JSON.parse(stdout) };
    } catch (parse) {
      result = { error: `gh.sh ${command} ${number} in ${repo} printed no JSON (${parse.message}): ${stdout.slice(0, 200)}` };
    }
  }
  READS.set(key, result);
  return result;
}

function ghStates(root, repo) {
  const key = repo.toLowerCase();
  if (STATES.has(key)) return STATES.get(key);
  const { stdout, error } = gh(root, repo, ["issue-states"]);
  if (error) throw new Failure(`The issues and pull requests of ${repo} could not be listed: ${error}. Repair GitHub access and run the command again.`);
  const states = new Map();
  for (const line of stdout.split("\n").filter(Boolean)) {
    let item;
    try {
      item = JSON.parse(line);
    } catch (parse) {
      throw new Failure(`gh.sh issue-states in ${repo} printed a line that is not JSON (${parse.message}): ${line.slice(0, 200)}`);
    }
    states.set(String(item.number), item);
  }
  STATES.set(key, states);
  return states;
}

const cacheNote = () => (cachedAge === undefined ? "" : `Some GitHub answers came from a cache up to ${cachedAge}s old. Run with GH_CACHE_TTL=0 to read them fresh.\n`);

function changedRecords(root, base) {
  const changed = git(root, ["diff", "--name-only", base, "--", DIR]).split("\n");
  const added = git(root, ["ls-files", "--others", "--exclude-standard", "--", DIR]).split("\n");
  const names = new Set([...changed, ...added].filter(Boolean).map((rel) => path.basename(rel)));
  return entries(root).filter((e) => NAME.test(e.file) && names.has(e.file));
}

function linkProblems(root, record, files) {
  const problems = [];
  const counts = { Issue: 0, PR: 0, File: 0 };
  const inForce = IN_FORCE.includes(record.status);
  const repair = `${SCRIPT} links ${record.id}`;
  for (const line of traceLines(record)) {
    const link = line.match(TRACE_LINK);
    if (!link) continue;
    counts[link[1]] += 1;
    const target = link[2].trim();
    const where = `${record.id}: "${line}"`;
    if (link[1] === "File") {
      const regex = filePattern(target);
      if (inForce && regex && !files().some((file) => regex.test(file))) problems.push(`${where} matches no tracked file. Correct the path, git add the file, or remove the line.`);
      continue;
    }
    const parts = target.match(GITHUB_LINK);
    if (!parts) {
      problems.push(`${where} is not a link of the form https://github.com/<owner>/<repo>/issues/<n> or https://github.com/<owner>/<repo>/pull/<n>, so links cannot read it. Correct the link.`);
      continue;
    }
    const listed = STATES.get(parts[1].toLowerCase())?.get(parts[3]);
    const { item, error } = listed?.kind === (parts[2] === "pull" ? "pull" : "issue") ? { item: listed } : ghRead(root, parts[1], parts[2], parts[3]);
    if (error) problems.push(`${where} could not be read: ${error}. If it does not exist, remove the line. Otherwise repair GitHub access and run: ${repair}`);
    else if (!inForce) continue;
    else if (link[1] === "Issue" && item.state === "closed" && UNIMPLEMENTED[item.state_reason]) problems.push(`${where} was ${UNIMPLEMENTED[item.state_reason]}, so it does not implement or plan the requirement. Remove the line, or link the issue or pull request that does.`);
    else if (link[1] === "PR" && item.state === "closed" && item.merged !== true) problems.push(`${where} was closed without a merge, so it does not implement the requirement. Remove the line, or link the pull request that does.`);
  }
  return { problems, counts };
}

function recordLinks(root, ids, options) {
  if (!ids.length && !options.base) throw new Usage(`links needs record IDs, or --base <ref> for the records that changed since that ref`);
  const chosen = options.base ? changedRecords(root, options.base) : ids.map((id) => recordEntry(root, id));
  if (!chosen.length) return `No record changed since ${options.base}\n`;
  let tracked;
  const files = () => (tracked ??= trackedFiles(root));
  const records = chosen.map(read);
  const links = new Map();
  for (const record of records)
    for (const line of traceLines(record)) {
      const parts = line.match(TRACE_LINK)?.[2].trim().match(GITHUB_LINK);
      if (parts) links.set(parts[1], (links.get(parts[1]) ?? new Set()).add(parts[3]));
    }
  for (const [repo, numbers] of links) if (numbers.size >= BULK) ghStates(root, repo);
  const problems = [];
  const lines = [];
  for (const record of records) {
    const result = linkProblems(root, record, files);
    problems.push(...result.problems);
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    lines.push(`${record.id}: ${plural(result.counts.Issue, "issue", "issues")}, ${plural(result.counts.PR, "pull request", "pull requests")} and ${plural(result.counts.File, "file line", "file lines")} link what exists`);
  }
  if (problems.length) throw new Failure(problems.join("\n") + (cacheNote() ? `\n${cacheNote()}` : ""));
  return lines.join("\n") + "\n" + cacheNote();
}

const words = (text) => (text ?? "").replace(/\s+/g, " ").trim();

function explanationProblems(record) {
  const explanation = record.sections.Explanation;
  if (explanation === undefined) return [`missing the section "## Explanation". Add it after the Statement: what the requirement entails, in simple English, with each glossary, technical or jargon term defined.`];
  if (!explanation && record.sections.Statement) return [`the section "## Explanation" is empty, and the Statement has text. Explain what the requirement entails, in simple English, and define each glossary, technical or jargon term.`];
  if (explanation && words(explanation) === words(record.sections.Statement)) return [`the Explanation repeats the Statement. Explain what the requirement entails, in simple English, and define each glossary, technical or jargon term.`];
  return [];
}

function levelProblems(record) {
  const level = record.field("Level");
  if (LEVELS.includes(level)) return [];
  return [`${level === undefined ? `no "level"` : `level "${level}" is not soft, normal or hard`}. Set it with: ${SCRIPT} level ${record.id} soft|normal|hard`];
}

function levels(root, ids, options) {
  if (!ids.length && !options.base) throw new Usage(`levels needs record IDs, or --base <ref> for the records that changed since that ref`);
  const chosen = options.base ? changedRecords(root, options.base) : ids.map((id) => recordEntry(root, id));
  if (!chosen.length) return `No record changed since ${options.base}\n`;
  const records = chosen.map((entry) => read(entry));
  const problems = records.flatMap((record) => levelProblems(record).map((problem) => `${record.id}: ${problem}`));
  if (problems.length) throw new Failure(problems.join("\n"));
  return records.map((record) => `${record.id}: level ${record.field("Level")}\n`).join("");
}

function typeProblems(record) {
  const value = record.field("Type");
  if (TYPES.includes(value)) return [];
  return [`${value === undefined ? `no "type"` : `type "${value}" is not ${TYPE_LIST}`}. Set it with: ${SCRIPT} type ${record.id} <type>, where <type> is one of ${TYPE_LIST}.`];
}

function types(root, ids, options) {
  if (!ids.length && !options.base) throw new Usage(`types needs record IDs, or --base <ref> for the records that changed since that ref`);
  const chosen = options.base ? changedRecords(root, options.base) : ids.map((id) => recordEntry(root, id));
  if (!chosen.length) return `No record changed since ${options.base}\n`;
  const records = chosen.map((entry) => read(entry));
  const problems = records.flatMap((record) => typeProblems(record).map((problem) => `${record.id}: ${problem}`));
  if (problems.length) throw new Failure(problems.join("\n"));
  return records.map((record) => `${record.id}: type ${record.field("Type")}\n`).join("");
}

function explained(root, ids, options) {
  if (!ids.length && !options.base) throw new Usage(`explained needs record IDs, or --base <ref> for the records that changed since that ref`);
  const chosen = options.base ? changedRecords(root, options.base) : ids.map((id) => recordEntry(root, id));
  if (!chosen.length) return `No record changed since ${options.base}\n`;
  const records = chosen.map((entry) => read(entry));
  const problems = records.flatMap((record) => explanationProblems(record).map((problem) => `${record.id}: ${problem}`));
  if (problems.length) throw new Failure(problems.join("\n"));
  return records.map((record) => `${record.id}: the Explanation is present\n`).join("");
}

function inForceCitations(root, text) {
  const records = new Map(entries(root).filter((e) => NAME.test(e.file)).map((e) => [e.id, e]));
  const good = [];
  const bad = [];
  for (const id of new Set(text.match(REQ_ID) ?? [])) {
    const entry = records.get(id);
    if (!entry) bad.push(`${id} is not a record in ${DIR}.`);
    else {
      const status = read(entry).status;
      if (IN_FORCE.includes(status)) good.push(id);
      else bad.push(`${id} is ${status}. Cite the record in force.`);
    }
  }
  return { good, bad };
}

function bodyCites(root, file, options) {
  if (!file) throw new Usage(`cites needs the body file: cites <file> --kind issue|pr`);
  const kind = options.kind;
  if (!["issue", "pr"].includes(kind)) throw new Usage(`cites needs --kind issue or --kind pr`);
  if (!existsSync(path.join(root, DIR))) return "";
  const name = kind === "pr" ? "pull request" : "issue";
  const text = readFileSync(file, "utf8");
  const { good, bad } = inForceCitations(root, text);
  if (good.length) return `The ${name} cites ${good.join(", ")}\n`;
  const notes = [...bad];
  if (kind === "pr") {
    for (const match of text.matchAll(CLOSING)) {
      const repo = match[1] ?? match[3] ?? process.env.GH_REPO;
      const number = match[2] ?? match[4];
      const label = match[1] || match[3] ? `${repo}#${number}` : `#${number}`;
      if (!repo) {
        notes.push(`${label} could not be read: GH_REPO is not set. Run from gh.sh, or set GH_REPO.`);
        continue;
      }
      const { item, error } = ghRead(root, repo, "issues", number);
      if (error) {
        notes.push(`${label} could not be read: ${error}.`);
        continue;
      }
      const closed = inForceCitations(root, item.body ?? "");
      if (closed.good.length) return `The pull request closes ${label}, which cites ${closed.good.join(", ")}\n`;
      notes.push(`${label} cites no record in force either.`, ...closed.bad);
    }
  }
  throw new Failure([`The body of this ${name} cites no requirement record in force (Proposed, Open or Accepted) in ${DIR}. Each issue and pull request traces to a requirement. Find the record with: ${SCRIPT} search <words>. If none fits, create a Proposed record with: ${SCRIPT} new "<title>" --author "<who asked for it>". Then cite its ID, such as REQ-0001, in the body.${kind === "pr" ? " A pull request also passes when it closes an issue whose body cites a record in force." : ""}`, ...notes].join("\n"));
}

const githubKey = (url) => {
  const parts = url.match(GITHUB_LINK);
  return parts ? `${parts[1].toLowerCase()}#${parts[3]}` : undefined;
};

function fileMatches(record, rel) {
  const lines = [];
  for (const line of (record.sections.Trace ?? "").split("\n").map((l) => l.trim())) {
    const link = line.match(TRACE_LINK);
    if (link?.[1] === "File" && filePattern(link[2].trim())?.test(rel)) lines.push(line);
    if (line.match(TRACE_DECISION)?.[2].trim() === rel) lines.push(line);
  }
  for (const source of sourceText(record.sections["Source text"]).sources) if (source.rel === rel) lines.push(`- ${source.citation}`);
  for (const model of modelEntries(record)) if (model.split("#")[0] === rel) lines.push(`model: ${model}`);
  return lines;
}

function linkMatches(record, key) {
  const lines = [];
  for (const line of (record.sections.Trace ?? "").split("\n").map((l) => l.trim())) {
    const link = line.match(TRACE_LINK);
    if (link && link[1] !== "File" && githubKey(link[2].trim()) === key) lines.push(line);
  }
  for (const source of sourceText(record.sections["Source text"]).sources) if (source.url && githubKey(source.url) === key) lines.push(`- ${source.citation}`);
  return lines;
}

function forTargets(root, targets, options) {
  if (options.all && options.status !== undefined) throw new Usage(`--all and --status cannot go together: --all gives each status`);
  if (options.status !== undefined && !STATUS_ORDER.includes(options.status)) throw new Usage(`Unknown status "${options.status}": use ${STATUS_ORDER.slice(0, -1).join(", ")} or ${STATUS_ORDER.at(-1)}`);
  if (!targets.length) throw new Usage(`for needs a file path, an issue or pull request link, or #N with --repo <owner>/<repo>, for example: for src/report.ts https://github.com/o/r/issues/1`);
  const kinds = targets.map((target) => {
    if (/^#\d+$/.test(target)) {
      if (!options.repo) throw new Usage(`"${target}" needs --repo <owner>/<repo>, or give the full GitHub link`);
      return { target, repo: options.repo, kind: "issues", number: target.slice(1) };
    }
    const parts = target.match(GITHUB_LINK);
    if (parts) return { target, repo: parts[1], kind: parts[2], number: parts[3] };
    return { target, rel: target.replace(/^\.\//, "") };
  });
  if (kinds.some((kind) => kind.rel)) {
    const files = new Set(trackedFiles(root));
    const unknown = kinds.filter((kind) => kind.rel && !files.has(kind.rel));
    if (unknown.length) throw new Failure(unknown.map((kind) => `"${kind.target}" is not a tracked file, an issue link or a pull request link. Give a path from the project root (git add a new file first), a GitHub issue or pull request link, or #N with --repo <owner>/<repo>.`).join("\n"));
  }
  const all = entries(root).filter((e) => NAME.test(e.file)).map(read);
  const wanted = (record) => options.all || (options.status === undefined ? IN_FORCE.includes(record.status) : (record.status ?? "").startsWith(options.status));
  const label = options.all ? "record" : options.status === undefined ? "record in force" : `${options.status} record`;
  const results = kinds.map((kind) => {
    const found = new Map();
    const notes = [];
    const add = (record, lines) => {
      if (!lines.length || !wanted(record)) return;
      found.set(record.id, [...new Set([...(found.get(record.id) ?? []), ...lines])]);
    };
    if (kind.rel) for (const record of all) add(record, fileMatches(record, kind.rel));
    else {
      const key = `${kind.repo.toLowerCase()}#${kind.number}`;
      for (const record of all) add(record, linkMatches(record, key));
      const { item, error } = ghRead(root, kind.repo, kind.kind, kind.number);
      if (error) throw new Failure(`${kind.target} could not be read: ${error}. Check the link, or repair GitHub access and run the command again.`);
      for (const id of new Set((item.body ?? "").match(REQ_ID) ?? [])) {
        const record = all.find((r) => r.id === id);
        if (record) add(record, [`cited in the body of ${kind.target}`]);
        else notes.push(`the body of ${kind.target} cites ${id}, which is not a record in ${DIR}`);
      }
    }
    const records = all.filter((record) => found.has(record.id)).map((record) => ({ id: record.id, status: record.status, level: record.field("Level"), type: record.field("Type"), title: record.title, statement: words(record.sections.Statement), path: record.rel, lines: found.get(record.id) }));
    return { target: kind.target, records, notes };
  });
  const text = results.map(({ target, records, notes }) => {
    const head = records.length ? `${target}\n` : `${target}: no ${label} relates to it (${all.length} record${all.length === 1 ? "" : "s"} searched)\n`;
    const width = Math.max(0, ...records.map((r) => (r.status ?? "NO STATUS").length));
    const body = records.map((r) => `  ${r.id}  ${(r.status ?? "NO STATUS").padEnd(width)}  ${r.title}\n${r.lines.map((line) => `    ${line}\n`).join("")}`).join("");
    return head + body + notes.map((note) => `  ${note}\n`).join("");
  }).join("");
  return { text, targets: results };
}

const project = {
  folders: [DIR, DEPRECATED],
  name: NAME,
  status: STATUS,
  gone: GONE,
  parse: parseRecord,
  inForce: (record) => IN_FORCE.includes(record.status),
  filePattern,
  filePatterns: (record) => [...traces(record).files].map((raw) => ({ raw, regex: filePattern(raw) })),
  modelEntries,
  modelRecords,
};

export function runRequirements(argv, { json } = {}) {
  try {
    const { positional, options, unread } = parseArguments(argv);
    const [command, ...rest] = positional;
    const root = () => findRoot(options);
    if (unread) {
      if (command === "verify" && options.report !== undefined) discardReport(root(), options.report);
      throw new Usage(unread);
    }
    const commands = {
      new: () => create(root(), rest[0], options),
      list: () => list(root(), options),
      search: () => search(root(), rest),
      quote: () => quote(root(), rest[0], rest[1], rest[2]),
      check: () => check(root()),
      render: () => render(root(), options),
      guard: () => guard(root(), options),
      agree: () => agree(root(), rest[0], options),
      flag: () => flag(root(), rest, options),
      level: () => level(root(), rest),
      type: () => type(root(), rest),
      author: () => author(root(), rest[0], rest.slice(1)),
      model: () => model(root(), rest[0], rest.slice(1)),
      sync: () => sync(root(), rest),
      log: () => log(root(), rest[0], rest[1]),
      sources: () => sources(root(), options),
      ledger: () => ledger(root(), rest[0], rest[1], rest[2], rest[3]),
      uncovered: () => uncovered(root(), rest),
      untraced: () => untraced(root(), options),
      link: () => link(root(), rest[0], rest[1], options),
      file: () => fileLinks(root(), rest[0], rest.slice(1)),
      decision: () => decisionLinks(root(), rest[0], rest.slice(1)),
      trace: () => traceAll(root(), options),
      links: () => recordLinks(root(), rest, options),
      explained: () => explained(root(), rest, options),
      levels: () => levels(root(), rest, options),
      types: () => types(root(), rest, options),
      cites: () => bodyCites(root(), rest[0], options),
      for: () => forTargets(root(), rest, options),
      narrate: () => narrate(root(), rest[0], options),
      narrative: () => narrative(root()),
      publish: () => publish(root(), options),
      references: () => references(root(), rest[0]),
      retire: () => retire(root(), rest, options),
      deprecate: () => deprecate(root(), rest[0], options),
      fixed: () => fixed(root(), options),
      "model-check": () => modelCheck(root(), rest, options, modelRecords),
      "model-pin": () => modelPin(root(), rest, options),
      "verify-brief": () => verifyBrief(root(), rest, options, project),
      "verify-judge": () => verifyJudge(root(), rest, options, project),
      verify: () => verify(root(), rest, options, project),
    };
    if (!commands[command]) throw new Usage(`Unknown requirements command "${command ?? ""}": use ${COMMANDS}`);
    const result = commands[command]();
    if (json) return typeof result === "string" ? { text: result } : result;
    process.stdout.write(typeof result === "string" ? result : result.text);
  } catch (error) {
    if (error instanceof Usage) throw new CliError(2, error.message);
    if (error instanceof Failure) throw new CliError(1, error.message);
    throw error;
  }
}
