import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DIR, NDEV, put, record, seeded } from "./records.mjs";

const INDEX = `${DIR}/generated/embeddings.json`;
const DEPRECATED = "docs/formal/deprecated";
const NOTE = "semantic index not built: run ndev requirements index";
const work = mkdtempSync(path.join(tmpdir(), "related-test-"));
const RULES = path.join(work, "rules.json");
const LOG = path.join(work, "requests.jsonl");
let fake;
let port;
let tags = 0;

before(async () => {
  writeFileSync(RULES, JSON.stringify({ "central finding": 0, "verdict ledger": 0, "column order": 5, caption: 7 }));
  writeFileSync(LOG, "");
  fake = spawn(process.execPath, [path.join(import.meta.dirname, "fake-embeddings.mjs"), RULES, LOG], { stdio: ["ignore", "pipe", "inherit"] });
  port = await new Promise((resolve, reject) => {
    fake.stdout.once("data", (data) => resolve(Number(String(data).trim())));
    fake.once("exit", (code) => reject(new Error(`the fake embeddings server exited ${code}`)));
  });
});

after(() => {
  fake.kill();
  rmSync(work, { recursive: true, force: true });
});

const newTag = () => `t${++tags}`;

function requirements(root, args, { key = true, tag = "unused" } = {}) {
  const env = { ...process.env, NDEV_EMBEDDINGS_URL: `http://127.0.0.1:${port}/${tag}/v1` };
  delete env.OPENROUTER_API_KEY;
  delete env.OPEN_ROUTER_API_KEY;
  if (key) env.OPENROUTER_API_KEY = "test-key";
  return spawnSync(NDEV, ["requirements", ...args, "--root", root], { encoding: "utf8", env });
}

const requests = (tag) => readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((request) => request.tag === tag);

function git(root, ...args) {
  const out = spawnSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout;
}

function repository(specs, files = {}) {
  const root = seeded({});
  for (const [number, { statement, trace = "- File: src/report.js", status = "Accepted", folder = DIR, ...rest }] of Object.entries(specs)) {
    put(root, `docs/quotes/${number}.md`, `${statement}\n`);
    put(root, `${folder}/${number}-record.md`, record(number, { title: `Record ${number}`, statement, status, trace, sourceText: `- docs/quotes/${number}.md#L1-L1\n\n> ${statement}`, ...rest }));
  }
  for (const [rel, text] of Object.entries({ "src/report.js": "export {}\n", ...files })) put(root, rel, text);
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "records");
  return root;
}

const Q = "0001-record.md";
const change = (root, from, to, file = Q) => {
  const full = path.join(root, DIR, file);
  const text = readFileSync(full, "utf8");
  assert.ok(text.includes(from), `${file} has no "${from}"`);
  writeFileSync(full, text.replace(from, to));
};

const acceptance = () =>
  repository(
    {
      "0001": { statement: "The report opens with the central finding." },
      "0002": { statement: "Each figure has a caption." },
      "0003": { statement: "Place the Verdict Ledger near the conclusion.", trace: "- File: src/ledger.js" },
      "0004": { statement: "The export keeps the column order.", trace: "- File: src/export.js" },
    },
    { "src/ledger.js": "export {}\n", "src/export.js": "export {}\n" },
  );

const indexed = (root, tag = newTag()) => {
  const out = requirements(root, ["index"], { tag });
  assert.equal(out.status, 0, out.stderr);
  return out;
};

describe("related records in check", () => {
  it("lists the record that shares a traced file and the near paraphrase, and not the unrelated record", () => {
    const root = acceptance();
    indexed(root);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "index");
    change(root, "## Notes\n\n", "## Notes\n\nThe opening was revised.\n");
    const out = requirements(root, ["check", "--base", "HEAD"]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /^4 records checked: no problems\n/);
    assert.match(out.stdout, /^Check REQ-0001 against REQ-0002 \(shares src\/report\.js \(Trace File here, Trace File in REQ-0002\)\), REQ-0003 \(statement similarity 0\.\d\d\)\.$/m);
    assert.doesNotMatch(out.stdout, /REQ-0004/);
    const json = JSON.parse(requirements(root, ["check", "--base", "HEAD", "--json"]).stdout).result;
    const [changed] = json.related.records;
    assert.equal(changed.id, "REQ-0001");
    assert.deepEqual(changed.candidates.map((c) => c.id), ["REQ-0002", "REQ-0003"]);
    assert.deepEqual(changed.candidates[0].reasons, [{ kind: "trace", shared: [{ item: "src/report.js", here: "Trace File", there: "Trace File" }] }]);
    assert.equal(changed.candidates[1].reasons[0].kind, "semantic");
    assert.equal(changed.candidates[1].reasons[0].field, "statement");
    assert.ok(changed.candidates[1].score > 0.9, JSON.stringify(changed.candidates[1]));
    assert.deepEqual(json.related.semantic, { available: true });
    assert.deepEqual(json.related.notes, []);
  });

  it("matches a Trace File of the changed record against a Source citation of another record", () => {
    const root = repository({
      "0001": { statement: "The report opens with the central finding.", trace: "- File: docs/quotes/*.md" },
      "0002": { statement: "Each figure has a caption.", trace: "- File: src/figure.js" },
    }, { "src/figure.js": "export {}\n" });
    const out = requirements(root, ["related", "REQ-0001"]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /Check REQ-0001 against REQ-0002 \(shares docs\/quotes\/0002\.md \(Trace File here, Source in REQ-0002\)\)/);
  });

  it("matches a shared issue link", () => {
    const issue = "https://github.com/o/r/issues/5";
    const root = repository({
      "0001": { statement: "The report opens with the central finding.", trace: `- Issue: ${issue}` },
      "0002": { statement: "Each figure has a caption.", trace: `- File: src/report.js\n- Issue: ${issue}` },
    });
    const out = requirements(root, ["related", "REQ-0001"]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /Check REQ-0001 against REQ-0002 \(shares https:\/\/github\.com\/o\/r\/issues\/5 \(Trace Issue here, Trace Issue in REQ-0002\)\)/);
  });

  it("is advice: check passes with candidates, and a broken record fails check with the reason the list is missing", () => {
    const root = acceptance();
    assert.equal(requirements(root, ["check", "REQ-0001"]).status, 0);
    change(root, 'title: "Record 0004"\n', "", "0004-record.md");
    const out = requirements(root, ["check", "REQ-0001"]);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /0004-record\.md: no "title"/);
    assert.match(out.stderr.trim(), /\nRelated records are listed when the records pass the check\.$/);
    const plain = requirements(root, ["check"]);
    assert.equal(plain.status, 1);
    assert.doesNotMatch(plain.stderr, /Related records/);
  });

  it("lists the trace overlap with no index, and says why the semantic search was skipped", () => {
    const root = acceptance();
    change(root, "## Notes\n\n", "## Notes\n\nThe opening was revised.\n");
    const out = requirements(root, ["check", "--base", "HEAD"]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /^Check REQ-0001 against REQ-0002 \(shares src\/report\.js \(Trace File here, Trace File in REQ-0002\)\)\.$/m);
    assert.match(out.stdout, new RegExp(`^${NOTE}$`, "m"));
    const json = JSON.parse(requirements(root, ["check", "--base", "HEAD", "--json"]).stdout).result;
    assert.deepEqual(json.related.semantic, { available: false, reason: NOTE });
    assert.deepEqual(json.related.notes, [NOTE]);
    const plain = requirements(root, ["check"]);
    assert.equal(plain.stdout, "4 records checked: no problems\n");
  });

  it("embeds a changed Statement for this run only, and names the record and the repair without a key", () => {
    const root = acceptance();
    indexed(root);
    const before = readFileSync(path.join(root, INDEX));
    change(root, "The report opens with the central finding.\n\n## Explanation", "The report opens with the central finding, in bold.\n\n## Explanation");
    change(root, "The export keeps the column order.\n\n## Explanation", "The export keeps the column order of the sheet.\n\n## Explanation", "0004-record.md");
    const tag = newTag();
    const out = requirements(root, ["related", "REQ-0001"], { tag });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /REQ-0003 \(statement similarity 0\.\d\d\)/);
    assert.match(out.stdout, /^1 record has no current vector in the semantic index: run ndev requirements index$/m);
    assert.deepEqual(requests(tag).map((r) => r.input), [["The report opens with the central finding, in bold."]]);
    assert.deepEqual(readFileSync(path.join(root, INDEX)), before);
    const keyless = requirements(root, ["related", "REQ-0001"], { key: false });
    assert.equal(keyless.status, 0, keyless.stderr);
    assert.match(keyless.stdout, /^Check REQ-0001 against REQ-0002 \(shares src\/report\.js/m);
    assert.doesNotMatch(keyless.stdout, /REQ-0003/);
    assert.match(keyless.stdout, /REQ-0001 has no current vector in the semantic index, and OPENROUTER_API_KEY is not set, so its semantic search was skipped\. Repair: .*neil-dev-env\.mjs run --need OPENROUTER_API_KEY -- ndev requirements index/);
  });

  it("refuses to index without a key or after an API error, and makes no request when the index is current", () => {
    const root = acceptance();
    const keyless = requirements(root, ["index"], { key: false });
    assert.equal(keyless.status, 1);
    assert.match(keyless.stderr, /OPENROUTER_API_KEY \(or OPEN_ROUTER_API_KEY\) is not set/);
    assert.match(keyless.stderr, /neil-dev-env\.mjs run --need OPENROUTER_API_KEY -- ndev requirements index/);
    const failed = requirements(root, ["index"], { tag: "fail500" });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /HTTP 500/);
    assert.match(failed.stderr, /failed on purpose/);
    assert.match(failed.stderr, /REQ-0001, REQ-0002, REQ-0003, REQ-0004/);
    const first = indexed(root);
    assert.match(first.stdout, /^8 embedded, 0 kept, 0 removed; \d+ tokens, \$\d+\.\d+/m);
    const lines = readFileSync(path.join(root, INDEX), "utf8").split("\n");
    assert.equal(lines[0], '{"model":"openai/text-embedding-3-small","dimensions":512,"encoding":"int8-base64","records":{');
    assert.match(lines[1], /^"REQ-0001":\{"statement":\["[0-9a-f]{16}","[A-Za-z0-9+/=]+"\],"source":\["[0-9a-f]{16}","[A-Za-z0-9+/=]+"\]\},$/);
    assert.deepEqual(lines.slice(5), ["}}", ""]);
    const stored = JSON.parse(lines.join("\n"));
    assert.equal(Buffer.from(stored.records["REQ-0001"].statement[1], "base64").length, 512);
    const tag = newTag();
    const again = requirements(root, ["index"], { tag });
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /The semantic index is current: 4 records/);
    assert.deepEqual(requests(tag), []);
  });

  it("never lists a Retired or Superseded record, and lists records in force before Rejected ones", () => {
    const root = repository(
      {
        "0001": { statement: "The report opens with the central finding.", trace: "- File: src/*.js" },
        "0002": { statement: "Each figure has a caption.", status: "Rejected", trace: "- File: src/report.js\n- File: src/a.js" },
        "0003": { statement: "Each table has a title.", trace: "- File: src/report.js" },
        "0004": { statement: "Each chart has a legend.", status: "Retired", folder: DEPRECATED },
        "0005": { statement: "Each map has a scale.", status: "Superseded by 0006", folder: DEPRECATED },
        "0006": { statement: "Each map has a north arrow.", trace: "- File: docs/guide.md" },
      },
      { "src/a.js": "export {}\n" },
    );
    const out = requirements(root, ["related", "REQ-0001", "--json"]);
    assert.equal(out.status, 0, out.stderr);
    const [changed] = JSON.parse(out.stdout).result.records;
    assert.deepEqual(changed.candidates.map((c) => [c.id, c.status]), [["REQ-0003", "Accepted"], ["REQ-0002", "Rejected"]]);
  });

  it("needs record ids or --base", () => {
    const out = requirements(acceptance(), ["related"]);
    assert.equal(out.status, 2);
    assert.match(out.stderr, /related needs record IDs, or --base <ref>/);
  });
});
