import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dirname, "..", "records.mjs");

const project = () => mkdtempSync(path.join(tmpdir(), "records-test-"));
const put = (root, rel, text) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
};
const record = (title, { status = "Accepted", last = "Requirement changed: none: scope only", sections = {} } = {}) => {
  const body = { Context: "What forced it.", Decision: "What was decided.", "Considered options": "- An option, and why not.", Consequences: "What changes.", ...sections };
  const headed = Object.entries(body).filter(([, text]) => text !== null).map(([name, text]) => `## ${name}\n\n${text}\n`).join("\n");
  return `# ${title}\n\n- Status: ${status}\n- Date: 2026-01-02\n- Decided by: Neil Ellis\n- Source: https://example.com/issues/1#c1\n- Issue: https://example.com/issues/1\n- ${last}\n\n${headed}`;
};
const run = (root, ...args) => {
  const out = spawnSync(process.execPath, [CLI, "--root", root, ...args], { encoding: "utf8" });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
};

describe("new", () => {
  it("creates the first ADR as 0001 with a slug of the sentence, a Proposed status and the template sections", () => {
    const root = project();
    const out = run(root, "new", "adr", "Sessions live in Redis", "--issue", "https://example.com/issues/12");
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(readdirSync(path.join(root, "docs/adr")), ["0001-sessions-live-in-redis.md"]);
    const text = readFileSync(path.join(root, "docs/adr/0001-sessions-live-in-redis.md"), "utf8");
    assert.match(text, /^# Sessions live in Redis\n/);
    assert.match(text, /^- Status: Proposed$/m);
    assert.match(text, /^- Date: \d{4}-\d{2}-\d{2}$/m);
    assert.match(text, /^- Issue: https:\/\/example\.com\/issues\/12$/m);
    assert.match(text, /^- Related PDR: none$/m);
    for (const section of ["Context", "Decision", "Considered options", "Consequences"]) assert.match(text, new RegExp(`^## ${section}$`, "m"));
    assert.ok(out.stdout.includes(path.join(root, "docs/adr/0001-sessions-live-in-redis.md")));
  });

  it("numbers after the highest record and never reuses a number", () => {
    const root = project();
    put(root, "docs/pdr/0001-first.md", record("First"));
    put(root, "docs/pdr/0004-fourth.md", record("Fourth"));
    const out = run(root, "new", "pdr", "Exports include archived rows");
    assert.equal(out.status, 0, out.stderr);
    assert.ok(readdirSync(path.join(root, "docs/pdr")).includes("0005-exports-include-archived-rows.md"));
  });

  it("puts the requirement line in a PDR", () => {
    const root = project();
    run(root, "new", "pdr", "Exports include archived rows");
    const text = readFileSync(path.join(root, "docs/pdr/0001-exports-include-archived-rows.md"), "utf8");
    assert.match(text, /^- Requirement changed:/m);
    assert.doesNotMatch(text, /Related PDR/);
  });

  it("refuses an unknown kind and an empty sentence, naming the repair", () => {
    const root = project();
    const kind = run(root, "new", "rfc", "Something");
    assert.equal(kind.status, 2);
    assert.match(kind.stderr, /adr or pdr/);
    const empty = run(root, "new", "adr", "  ");
    assert.equal(empty.status, 2);
    assert.match(empty.stderr, /sentence/);
  });

  it("refuses when the folder holds a file it cannot number", () => {
    const root = project();
    put(root, "docs/adr/notes.md", "x");
    const out = run(root, "new", "adr", "Something");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /docs\/adr\/notes\.md/);
  });
});

describe("list", () => {
  it("prints each record with its status and title", () => {
    const root = project();
    put(root, "docs/adr/0001-old.md", record("Old", { status: "Superseded by 0002", last: "Related PDR: none" }));
    put(root, "docs/adr/0002-new.md", record("New", { last: "Related PDR: none" }));
    put(root, "docs/pdr/0001-req.md", record("Req", { status: "Proposed" }));
    const all = run(root, "list");
    assert.equal(all.status, 0, all.stderr);
    assert.match(all.stdout, /docs\/adr\/0001-old\.md\s+Superseded by 0002\s+Old/);
    assert.match(all.stdout, /docs\/adr\/0002-new\.md\s+Accepted\s+New/);
    assert.match(all.stdout, /docs\/pdr\/0001-req\.md\s+Proposed\s+Req/);
    assert.doesNotMatch(run(root, "list", "pdr").stdout, /docs\/adr/);
  });

  it("says that nothing was found, and where it looked", () => {
    const out = run(project(), "list");
    assert.equal(out.status, 0);
    assert.match(out.stdout, /No records in docs\/adr or docs\/pdr/);
  });
});

describe("search", () => {
  it("finds records that hold every term, case-insensitively, in the body and the name", () => {
    const root = project();
    put(root, "docs/adr/0001-sessions-live-in-redis.md", record("Sessions live in Redis", { sections: { "Considered options": "- Cookies: rejected." } }));
    put(root, "docs/adr/0002-queue-is-sqs.md", record("Queue is SQS", { sections: { Context: "Redis was rejected here." } }));
    put(root, "docs/pdr/0001-retention.md", record("Retention is 30 days"));
    const both = run(root, "search", "REDIS", "cookies");
    assert.equal(both.status, 0, both.stderr);
    assert.match(both.stdout, /0001-sessions-live-in-redis\.md/);
    assert.doesNotMatch(both.stdout, /0002-queue-is-sqs/);
    assert.match(run(root, "search", "redis").stdout, /0002-queue-is-sqs/);
  });

  it("restricts to one kind", () => {
    const root = project();
    put(root, "docs/adr/0001-a.md", record("Retention in the store"));
    put(root, "docs/pdr/0001-b.md", record("Retention is 30 days"));
    const out = run(root, "search", "retention", "--kind", "pdr");
    assert.match(out.stdout, /docs\/pdr\/0001-b\.md/);
    assert.doesNotMatch(out.stdout, /docs\/adr/);
  });

  it("reports an empty result with the number of records searched", () => {
    const root = project();
    put(root, "docs/adr/0001-a.md", record("A"));
    const out = run(root, "search", "zebra");
    assert.equal(out.status, 0);
    assert.match(out.stdout, /No record matches "zebra" \(searched 1 record\)/);
  });

  it("needs a term", () => {
    assert.equal(run(project(), "search").status, 2);
  });
});

describe("check", () => {
  it("passes a consistent set", () => {
    const root = project();
    put(root, "docs/adr/0001-old.md", record("Old", { status: "Superseded by 0002", last: "Related PDR: none" }));
    put(root, "docs/adr/0002-new.md", record("New", { last: "Related PDR: none" }));
    put(root, "docs/pdr/0001-req.md", record("Req"));
    const out = run(root, "check");
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /3 records checked/);
  });

  it("passes a freshly created record, because Proposed may leave its fields and sections empty", () => {
    const root = project();
    run(root, "new", "adr", "Sessions live in Redis");
    assert.equal(run(root, "check").status, 0);
  });

  it("fails on a bad file name, a duplicate number and a bad status", () => {
    const root = project();
    put(root, "docs/adr/notes.md", "x");
    put(root, "docs/adr/0001-a.md", record("A", { last: "Related PDR: none" }));
    put(root, "docs/adr/0001-b.md", record("B", { last: "Related PDR: none" }));
    put(root, "docs/pdr/0001-d.md", record("D", { status: "Maybe" }));
    const out = run(root, "check");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /docs\/adr\/notes\.md: .*NNNN-/);
    assert.match(out.stderr, /duplicate number 0001: docs\/adr\/0001-a\.md, docs\/adr\/0001-b\.md/);
    assert.match(out.stderr, /docs\/pdr\/0001-d\.md: status "Maybe"/);
  });

  it("fails when a status names a record that does not exist", () => {
    const root = project();
    put(root, "docs/adr/0001-old.md", record("Old", { status: "Superseded by 0007", last: "Related PDR: none" }));
    const out = run(root, "check");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /docs\/adr\/0001-old\.md: Superseded by 0007, which does not exist/);
  });

  it("fails an Accepted record that lacks Considered options, a field value or a section body", () => {
    const root = project();
    put(root, "docs/pdr/0001-a.md", record("A", { sections: { "Considered options": null } }));
    put(root, "docs/pdr/0002-b.md", record("B", { sections: { Consequences: "" } }));
    put(root, "docs/pdr/0003-c.md", record("C").replace(/^- Decided by: .*$/m, "- Decided by:"));
    const out = run(root, "check");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /docs\/pdr\/0001-a\.md: missing the section "## Considered options"/);
    assert.match(out.stderr, /docs\/pdr\/0002-b\.md: the section "## Consequences" is empty/);
    assert.match(out.stderr, /docs\/pdr\/0003-c\.md: "- Decided by:" has no value/);
  });

  it("fails a record with no status line", () => {
    const root = project();
    put(root, "docs/pdr/0001-a.md", "# A\n\nNo status.\n");
    const out = run(root, "check");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /docs\/pdr\/0001-a\.md: no "- Status:" line/);
  });

  it("tells the author to migrate a record in the old format", () => {
    const root = project();
    put(root, "docs/adr/0001-old.md", "# 0001 — Old\n\n**Status:** accepted, 2026-01-02 · **Issue:** #1\n\n## The decision\nX\n");
    const out = run(root, "check");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /docs\/adr\/0001-old\.md: old format.*kb\/adr\.md/);
  });

  it("fails a record that supersedes itself or is superseded by an older record", () => {
    const root = project();
    put(root, "docs/adr/0001-a.md", record("A", { status: "Superseded by 0001", last: "Related PDR: none" }));
    put(root, "docs/adr/0002-b.md", record("B", { status: "Superseded by 0001", last: "Related PDR: none" }));
    const out = run(root, "check");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /docs\/adr\/0001-a\.md: Superseded by 0001 names itself/);
    assert.match(out.stderr, /docs\/adr\/0002-b\.md: Superseded by 0001, which is older/);
  });

  it("ignores dotfiles, directories and files that are not markdown", () => {
    const root = project();
    put(root, "docs/adr/.gitkeep", "");
    put(root, "docs/adr/images/diagram.png", "x");
    put(root, "docs/adr/0001-a.md", record("A", { last: "Related PDR: none" }));
    const out = run(root, "check");
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /1 records checked/);
    assert.equal(run(root, "new", "adr", "B").status, 0);
  });

  it("passes a project with no records and says so", () => {
    const out = run(project(), "check");
    assert.equal(out.status, 0);
    assert.match(out.stdout, /0 records checked/);
  });
});

describe("usage", () => {
  it("rejects an unknown command", () => {
    const out = run(project(), "frobnicate");
    assert.equal(out.status, 2);
    assert.match(out.stderr, /list, search, new, check/);
  });
});
