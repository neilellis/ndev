import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliError } from "../ndev/common.mjs";

const MODEL = "openai/text-embedding-3-small";
const DIMENSIONS = 512;
const ENCODING = "int8-base64";
const INDEX = "docs/formal/requirements/generated/embeddings.json";
const KEY = "OPENROUTER_API_KEY";
const ALIAS = "OPEN_ROUTER_API_KEY";
const EMBED = path.join(import.meta.dirname, "embed.mjs");
const CREDENTIALS = path.join(import.meta.dirname, "../env/neil-dev-env.mjs");
const BUILD = "ndev requirements index";
const NOT_BUILT = `semantic index not built: run ${BUILD}`;
const MIN_SCORE = 0.25;
const TOP_K = 5;
const TRACE_SHOWN = 5;
const SHARED_SHOWN = 3;
const IN_FORCE = ["Proposed", "Open", "Accepted"];
const GONE = /^(Retired|Superseded by \d{4})$/;
const FIELDS = ["statement", "source"];
const REQ_ID = /\bREQ-\d{4}\b/g;

const failure = (message) => new CliError(1, message);
const words = (text) => (text ?? "").replace(/\s+/g, " ").trim();
const apiKey = () => process.env[KEY] || process.env[ALIAS];
const keyRepair = `Repair: add ${KEY}=<value> to the project's .neil-dev.env (never in chat), then run: node ${CREDENTIALS} run --need ${KEY} -- ${BUILD}`;
const hashOf = (text) => createHash("sha256").update(`${MODEL}\n${DIMENSIONS}\n${text}`).digest("hex").slice(0, 16);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const live = (record) => !GONE.test(record.status ?? "");

function texts(record, sourceText) {
  const statement = words(record.sections.Statement);
  const source = words(sourceText(record.sections["Source text"]).sources.flatMap((s) => s.quote).join("\n"));
  return Object.fromEntries([["statement", statement], ["source", source]].filter(([, text]) => text));
}

function decoded(entry, hash) {
  if (!Array.isArray(entry) || entry[0] !== hash || typeof entry[1] !== "string") return undefined;
  const bytes = Buffer.from(entry[1], "base64");
  return bytes.length === DIMENSIONS ? new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length) : undefined;
}

function quantised(vector) {
  const top = vector.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
  const q = Int8Array.from(vector, (v) => (top ? Math.round((127 * v) / top) : 0));
  return Buffer.from(q.buffer).toString("base64");
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function embed(inputs, labels, timeout) {
  const ran = spawnSync(process.execPath, [EMBED], { input: JSON.stringify({ model: MODEL, dimensions: DIMENSIONS, inputs, labels }), encoding: "utf8", timeout, maxBuffer: 1024 * 1024 * 1024 });
  if (ran.error) return { error: `${EMBED} failed with ${ran.error.code ?? "an error"}${ran.error.code === "ETIMEDOUT" ? ` after ${timeout / 1000}s` : ""}: ${ran.error.message}` };
  const ended = ran.signal ? `was killed by ${ran.signal}` : `exited ${ran.status}`;
  if (ran.status !== 0) return { error: `${ran.stderr.trim() || ran.stdout.trim() || "no output"} (${EMBED} ${ended})` };
  try {
    const answer = JSON.parse(ran.stdout);
    if (!Array.isArray(answer.vectors) || answer.vectors.length !== inputs.length) throw new Error(`${answer.vectors?.length} vectors for ${inputs.length} inputs`);
    return answer;
  } catch (error) {
    return { error: `${EMBED} printed no answer of the form {vectors, tokens, cost} (${error.message}): ${ran.stdout.slice(0, 300)}` };
  }
}

function readIndex(root) {
  const full = path.join(root, INDEX);
  if (!existsSync(full)) return { missing: true };
  const text = readFileSync(full, "utf8");
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { error: `${INDEX} is not valid JSON (${error.message})` };
  }
  if (data?.encoding !== ENCODING || !data.records || typeof data.records !== "object" || Array.isArray(data.records)) return { error: `${INDEX} is not a semantic index: it needs "encoding": "${ENCODING}" and a "records" object` };
  return { data, text };
}

function serialised(records) {
  const ids = Object.keys(records).sort();
  const lines = ids.map((id, i) => `${JSON.stringify(id)}:${JSON.stringify(Object.fromEntries(FIELDS.filter((f) => records[id][f]).map((f) => [f, records[id][f]])))}${i < ids.length - 1 ? "," : ""}\n`);
  return `{"model":${JSON.stringify(MODEL)},"dimensions":${DIMENSIONS},"encoding":"${ENCODING}","records":{\n${lines.join("")}}}\n`;
}

export function buildIndex(root, records, sourceText) {
  const found = readIndex(root);
  if (found.error) throw failure(`${found.error}. Repair: delete ${INDEX} and run: ${BUILD}`);
  const same = found.data?.model === MODEL && found.data?.dimensions === DIMENSIONS;
  const old = same ? found.data.records : {};
  const seen = new Map();
  const next = {};
  const wanted = [];
  let kept = 0;
  for (const record of records.filter(live)) {
    if (seen.has(record.id)) throw failure(`${record.id} is in both ${seen.get(record.id)} and ${record.rel}, so the index cannot tell them apart. Repair: renumber the newer record, then run: ndev requirements check`);
    seen.set(record.id, record.rel);
    for (const [field, text] of Object.entries(texts(record, sourceText))) {
      const hash = hashOf(text);
      next[record.id] ??= {};
      if (decoded(old[record.id]?.[field], hash)) {
        next[record.id][field] = old[record.id][field];
        kept++;
      } else wanted.push({ id: record.id, field, text, hash });
    }
  }
  const removed = Object.keys(found.data?.records ?? {}).filter((id) => !next[id]).length;
  if (!wanted.length && found.text === serialised(next)) return `The semantic index is current: ${plural(Object.keys(next).length, "record")} (${INDEX})\n`;
  let tokens = 0;
  let cost = 0;
  if (wanted.length) {
    if (!apiKey()) throw failure(`${KEY} (or ${ALIAS}) is not set, so ${plural(wanted.length, "text")} of ${plural(new Set(wanted.map((w) => w.id)).size, "record")} cannot be embedded and ${INDEX} was not written. ${keyRepair}`);
    const answer = embed(wanted.map((w) => w.text), wanted.map((w) => w.id), 600_000);
    if (answer.error) throw failure(`${INDEX} was not written: ${answer.error}. Repair: correct the cause (the key, the service or the network), then run: ${BUILD}`);
    wanted.forEach((w, i) => {
      next[w.id][w.field] = [w.hash, quantised(answer.vectors[i])];
    });
    tokens = answer.tokens;
    cost = answer.cost;
  }
  const full = path.join(root, INDEX);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, serialised(next));
  const spent = typeof cost === "number" ? `$${cost.toFixed(6)}` : "cost not reported";
  return `${wanted.length} embedded, ${kept} kept, ${removed} removed; ${tokens} tokens, ${spent}. Wrote ${INDEX}\n`;
}

function semanticIndex(root) {
  const found = readIndex(root);
  if (found.missing) return { available: false, reason: NOT_BUILT };
  if (found.error) return { available: false, reason: `${found.error}: delete it and run ${BUILD}` };
  if (found.data.model !== MODEL || found.data.dimensions !== DIMENSIONS) return { available: false, reason: `the semantic index was built with ${found.data.model} at ${found.data.dimensions} dimensions, and ndev uses ${MODEL} at ${DIMENSIONS}: run ${BUILD}` };
  return { available: true, records: found.data.records };
}

function fileSet(matchers, tracked) {
  const items = new Map();
  const add = (key, item, match, field) => {
    const entry = items.get(key) ?? { item, match, here: [] };
    if (!entry.here.includes(field)) entry.here.push(field);
    items.set(key, entry);
  };
  for (const m of matchers.files) {
    if (m.field === "model") continue;
    const hits = m.field === "Trace File" ? tracked().filter((file) => m.test(file)) : [m.raw];
    if (hits.length) for (const file of hits) add(`file ${file}`, file, (other) => other.files.filter((o) => o.test(file)), m.field);
    else add(`pattern ${m.raw}`, m.raw, (other) => other.files.filter((o) => o.raw === m.raw), m.field);
  }
  for (const m of matchers.links) add(`link ${m.key}`, items.get(`link ${m.key}`)?.item ?? m.url, (other) => other.links.filter((o) => o.key === m.key), m.field);
  return [...items].map(([key, entry]) => ({ key, ...entry }));
}

function overlap(set, matchers, rarity) {
  return set
    .map(({ key, item, match, here }) => ({ item, here: here.join(" and "), there: [...new Set(match(matchers).map((o) => o.field))].join(" and "), records: rarity(key, match) }))
    .filter((shared) => shared.there)
    .sort((a, b) => a.records - b.records || a.item.localeCompare(b.item));
}

function sharedText(shared, id) {
  const shown = shared.slice(0, SHARED_SHOWN).map((s) => `${s.item} (${s.here} here, ${s.there} in ${id}; ${s.records} records trace it)`);
  const more = shared.length - shown.length;
  return `shares ${shown.join(", ")}${more ? ` and ${more} more` : ""}`;
}

const sectionList = (sections) => sections.join(" and ");

function reasonText(reason, id, query) {
  if (reason.kind === "cited") return reason.direction === "here" ? `cited in this record's ${sectionList(reason.sections)}` : `cites ${query} in its ${sectionList(reason.sections)}`;
  if (reason.kind === "trace") return sharedText(reason.shared, id);
  return `${reason.field === "statement" ? "statement" : "Source text"} similarity ${reason.score.toFixed(2)}`;
}

function citedParts(record) {
  const front = record.front?.data ? record.text.slice(0, record.text.length - record.front.body.length) : "";
  return [["front matter", front], ...Object.entries(record.sections).filter(([name]) => name !== "Log")];
}

function citations(record) {
  const named = new Map();
  for (const [part, text] of citedParts(record))
    for (const id of (text ?? "").match(REQ_ID) ?? []) {
      if (id === record.id) continue;
      if (!named.has(id)) named.set(id, []);
      if (!named.get(id).includes(part)) named.get(id).push(part);
    }
  return named;
}

const channel = (c) => (c.reasons.some((r) => r.kind === "cited") ? 0 : c.reasons.some((r) => r.kind === "trace") ? 1 : 2);
const weightOf = (c) => c.reasons.find((r) => r.kind === "trace")?.weight ?? 0;
const KIND_ORDER = ["cited", "trace", "semantic"];

function ordered(candidates) {
  const group = (c) => (IN_FORCE.includes(c.status) ? 0 : 1);
  for (const c of candidates) c.reasons.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  return candidates.sort((a, b) => channel(a) - channel(b) || group(a) - group(b) || weightOf(b) - weightOf(a) || (b.score ?? -2) - (a.score ?? -2) || a.id.localeCompare(b.id));
}

function listing(id, listed) {
  if (!listed.length) return [`${id}: no related record found`];
  const line = (c) => `  ${c.id} (${c.reasons.map((r) => reasonText(r, c.id, id)).join("; ")})`;
  const semantic = (c) => c.reasons.some((r) => r.kind === "semantic");
  const traced = listed.filter((c) => channel(c) === 1);
  const shown = traced.slice(0, TRACE_SHOWN);
  const below = traced.slice(TRACE_SHOWN);
  const more = below.filter((c) => !semantic(c)).length;
  const close = [...below.filter(semantic), ...listed.filter((c) => channel(c) === 2)].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return [
    `Check ${id} against:`,
    ...listed.filter((c) => channel(c) === 0).map(line),
    ...shown.map(line),
    ...(more > 0 ? [`  and ${more} more by shared trace: ndev requirements related ${id} --json`] : []),
    ...close.map(line),
  ];
}

export function relatedRecords(root, chosen, all, { base, matchers, tracked, sourceText }) {
  const semantic = semanticIndex(root);
  const summary = semantic.available ? { available: true } : { available: false, reason: semantic.reason };
  if (!chosen.length) return { text: `No record changed since ${base}\n`, records: [], semantic: summary, notes: [] };
  const notes = semantic.available ? [] : [semantic.reason];
  const candidates = all.filter(live);
  const matcherOf = new Map(candidates.map((record) => [record.rel, matchers(record)]));
  const changed = new Set(chosen.map((record) => record.id));
  const vectors = new Map();
  const queries = new Map();
  if (semantic.available) {
    let stale = 0;
    for (const record of candidates) {
      const current = {};
      let missing = false;
      for (const [field, text] of Object.entries(texts(record, sourceText))) {
        const vector = decoded(semantic.records[record.id]?.[field], hashOf(text));
        if (vector) current[field] = vector;
        else missing = true;
      }
      vectors.set(record.id, current);
      if (missing && !changed.has(record.id)) stale++;
    }
    if (stale) notes.push(`${plural(stale, "record has", "records have")} no current vector in the semantic index: run ${BUILD}`);
    const pending = [];
    for (const record of chosen) {
      const statement = texts(record, sourceText).statement;
      const vector = statement && decoded(semantic.records[record.id]?.statement, hashOf(statement));
      if (!statement) notes.push(`${record.id} has no Statement, so its semantic search was skipped.`);
      else if (vector) queries.set(record.id, vector);
      else pending.push({ id: record.id, statement });
    }
    if (pending.length && !apiKey()) for (const { id } of pending) notes.push(`${id} has no current vector in the semantic index, and ${KEY} is not set, so its semantic search was skipped. ${keyRepair}`);
    else if (pending.length) {
      const answer = embed(pending.map((p) => p.statement), pending.map((p) => p.id), 60_000);
      if (answer.error) notes.push(`The semantic search of ${pending.map((p) => p.id).join(", ")} was skipped: ${answer.error}`);
      else
        pending.forEach((p, i) => {
          queries.set(p.id, answer.vectors[i]);
          if (vectors.has(p.id)) vectors.get(p.id).statement = answer.vectors[i];
        });
    }
  }
  const known = new Set(all.map((record) => record.id));
  const liveIds = new Map(candidates.map((record) => [record.id, record]));
  const citedBy = new Map(candidates.map((record) => [record.id, citations(record)]));
  const rarityCache = new Map();
  const rarity = (key, match) => {
    if (!rarityCache.has(key)) rarityCache.set(key, candidates.filter((c) => match(matcherOf.get(c.rel)).length).length);
    return rarityCache.get(key);
  };
  const records = chosen.map((record) => {
    const found = new Map();
    const entry = (c) => {
      if (!found.has(c.id)) found.set(c.id, { id: c.id, title: c.title, status: c.status ?? "", reasons: [] });
      return found.get(c.id);
    };
    for (const [id, sections] of citations(record)) {
      if (!known.has(id)) notes.push(`${record.id} names ${id}, which is not a record`);
      else if (liveIds.has(id)) entry(liveIds.get(id)).reasons.push({ kind: "cited", direction: "here", sections });
    }
    for (const c of candidates) {
      const sections = c.id !== record.id && citedBy.get(c.id).get(record.id);
      if (sections) entry(c).reasons.push({ kind: "cited", direction: "there", sections });
    }
    const set = fileSet(matchers(record), tracked);
    for (const c of candidates) {
      if (c.id === record.id) continue;
      const shared = overlap(set, matcherOf.get(c.rel), rarity);
      if (shared.length) entry(c).reasons.push({ kind: "trace", weight: Math.round(shared.reduce((sum, s) => sum + 1 / s.records, 0) * 1000) / 1000, shared });
    }
    const query = queries.get(record.id);
    if (query) {
      const scored = [];
      for (const c of candidates) {
        if (c.id === record.id) continue;
        const v = vectors.get(c.id) ?? {};
        const statement = v.statement ? cosine(query, v.statement) : -2;
        const source = v.source ? cosine(query, v.source) : -2;
        const [field, score] = source > statement ? ["source", source] : ["statement", statement];
        if (score >= MIN_SCORE) scored.push({ c, field, score: Math.round(score * 1000) / 1000 });
      }
      scored.sort((a, b) => b.score - a.score || a.c.id.localeCompare(b.c.id));
      for (const { c, field, score } of scored.slice(0, TOP_K)) {
        const e = entry(c);
        e.score = score;
        e.reasons.push({ kind: "semantic", field, score });
      }
    }
    return { id: record.id, title: record.title, candidates: ordered([...found.values()]) };
  });
  const lines = records.flatMap(({ id, candidates: listed }) => listing(id, listed));
  return { text: `${[...lines, ...notes].join("\n")}\n`, records, semantic: summary, notes };
}
