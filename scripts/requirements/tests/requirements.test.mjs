import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DIR, EXPLANATION, GUIDE, GUIDE_SOURCE, NDEV, numbers, project, put, record, run, seeded, yamlList } from "./records.mjs";

const HTML = `${DIR}/generated/requirements.html`;

describe("new", () => {
  it("creates the first record as REQ-0001, Proposed and explicit, with the template sections", () => {
    const root = project();
    const out = run(root, "new", "The report names each source", "--author", "Alex Rivera, Jordan Lee", "--type", "product");
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(readdirSync(path.join(root, DIR)), ["0001-the-report-names-each-source.md"]);
    const text = readFileSync(path.join(root, DIR, "0001-the-report-names-each-source.md"), "utf8");
    assert.match(text, /^---\nid: REQ-0001\ntitle: The report names each source\nstatus: Proposed\norigin: explicit\nlevel: normal\ntype: product\nsection: ""\ndate: \d{4}-\d{2}-\d{2}\nsource: \[\]\nauthor:\n  - Alex Rivera\n  - Jordan Lee\ndecided_by: ""\nverification: unassigned\nissues: \[\]\nprs: \[\]\n---\n\n## Statement\n/);
    assert.doesNotMatch(text, /^# /m);
    for (const section of ["Statement", "Explanation", "Source text", "Trace", "Notes", "Log"]) assert.match(text, new RegExp(`^## ${section}$`, "m"));
    assert.match(text, /\n## Statement\n\n## Explanation\n\n## Source text\n/);
    assert.match(text, new RegExp(`## Notes\n\n## Log\n\n- ${new Date().toISOString().slice(0, 10)}: Created\\.\n$`));
    assert.ok(out.stdout.includes(path.join(root, DIR, "0001-the-report-names-each-source.md")));
  });

  it("takes the number after the highest one, with the origin and the section it is given", () => {
    const root = seeded({ "0007-the-report-names-each-source.md": record("0007") });
    const out = run(root, "new", "A retry keeps the first result", "--origin", "implied", "--section", "Pipeline: retries", "--author", "Neil Ellis", "--type", "product");
    assert.equal(out.status, 0, out.stderr);
    const text = readFileSync(path.join(root, DIR, "0008-a-retry-keeps-the-first-result.md"), "utf8");
    assert.match(text, /^id: REQ-0008$/m);
    assert.match(text, /^origin: implied$/m);
    assert.match(text, /^section: "Pipeline: retries"$/m);
    assert.equal(run(root, "check").status, 0);
  });

  it("creates a record whose origin is a pull request", () => {
    const root = project();
    const out = run(root, "new", "The export keeps the column order", "--origin", "PR", "--author", "Neil Ellis", "--type", "product");
    assert.equal(out.status, 0, out.stderr);
    assert.match(readFileSync(path.join(root, DIR, "0001-the-export-keeps-the-column-order.md"), "utf8"), /^origin: PR$/m);
  });

  it("refuses a record without an author", () => {
    const root = project();
    const out = run(root, "new", "A title");
    assert.equal(out.status, 2);
    assert.match(out.stderr, /new needs --author "<name>, <name>"/);
    assert.equal(existsSync(path.join(root, DIR)), false);
  });

  it("refuses an origin that is not explicit, implied or PR", () => {
    const root = project();
    const out = run(root, "new", "A title", "--origin", "guessed");
    assert.equal(out.status, 2);
    assert.match(out.stderr, /guessed/);
    assert.equal(existsSync(path.join(root, DIR)), false);
  });

  it("passes its own check as a Proposed record", () => {
    const root = project();
    run(root, "new", "The report names each source");
    const out = run(root, "check");
    assert.equal(out.status, 0, out.stderr);
  });
});

describe("quote", () => {
  it("prints the citation and the named lines as a quote", () => {
    const out = run(seeded({}), "quote", "docs/guide.md", "3", "4");
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, `${GUIDE_SOURCE}\n`);
  });

  it("keeps an empty line and the indent of a line in the quote", () => {
    const root = seeded({});
    put(root, "docs/code.txt", "if ready:\n\n    send()\n");
    const out = run(root, "quote", "docs/code.txt", "1", "3");
    assert.equal(out.stdout, "- docs/code.txt#L1-L3\n\n> if ready:\n>\n>     send()\n");
  });

  it("fails a file that does not exist, and names it", () => {
    const out = run(seeded({}), "quote", "docs/absent.md", "1", "2");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /docs\/absent\.md/);
  });

  it("fails a range past the end of the file, and says how long the file is", () => {
    const out = run(seeded({}), "quote", "docs/guide.md", "3", "40");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /docs\/guide\.md/);
    assert.match(out.stderr, /6 lines/);
  });
});

describe("check", () => {
  it("passes a complete accepted record whose source text is at the cited lines", () => {
    const out = run(seeded(), "check");
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /1 record checked/);
  });

  it("passes the output of quote as a source text, with its empty line and indent", () => {
    const root = seeded({});
    put(root, "docs/code.txt", "if ready:\n\n    send()\n");
    put(root, `${DIR}/0001-a.md`, record("0001", { sourceText: run(root, "quote", "docs/code.txt", "1", "3").stdout.trim() }));
    const out = run(root, "check");
    assert.equal(out.status, 0, out.stderr);
  });

  it("fails when the cited lines no longer hold the source text, and sends the change to a human", () => {
    const root = seeded();
    put(root, "docs/guide.md", GUIDE.replace("names each source", "names every source"));
    const out = run(root, "check");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /0001-the-report-names-each-source\.md/);
    assert.match(out.stderr, /docs\/guide\.md#L3-L4/);
    assert.match(out.stderr, /human/);
    assert.doesNotMatch(out.stderr, /now at/);
  });

  it("fails when the source text moved in its file, names the new lines, and passes when the line numbers are corrected", () => {
    const root = seeded();
    put(root, "docs/guide.md", GUIDE.replace("# Guide\n", "# Guide\n\nA new first paragraph.\n"));
    const moved = run(root, "check");
    assert.equal(moved.status, 1);
    assert.match(moved.stderr, /now at docs\/guide\.md#L5-L6/);
    put(root, `${DIR}/0001-the-report-names-each-source.md`, record("0001", { sourceText: GUIDE_SOURCE.replace("#L3-L4", "#L5-L6") }));
    assert.equal(run(root, "check").status, 0);
  });

  it("fails a source whose file is gone or whose lines are past its end", () => {
    const gone = run(seeded({ "0001-a.md": record("0001", { sourceText: "- docs/absent.md#L1-L2\n\n> Text." }) }), "check");
    assert.equal(gone.status, 1);
    assert.match(gone.stderr, /docs\/absent\.md/);
    const past = run(seeded({ "0001-a.md": record("0001", { sourceText: "- docs/guide.md#L3-L40\n\n> Text." }) }), "check");
    assert.equal(past.status, 1);
    assert.match(past.stderr, /6 lines/);
  });

  it("fails a citation that is not a path with lines or an https link, and one that leaves the project", () => {
    const loose = run(seeded({ "0001-a.md": record("0001", { sourceText: "- a message from the owner\n\n> Do it." }) }), "check");
    assert.equal(loose.status, 1);
    assert.match(loose.stderr, /a message from the owner/);
    const outside = run(seeded({ "0001-a.md": record("0001", { sourceText: "- ../elsewhere.md#L1-L1\n\n> Text." }) }), "check");
    assert.equal(outside.status, 1);
    assert.match(outside.stderr, /\.\.\/elsewhere\.md/);
  });

  it("fails a citation with no quote, and text that belongs to no citation", () => {
    const bare = run(seeded({ "0001-a.md": record("0001", { sourceText: "- docs/guide.md#L3-L4" }) }), "check");
    assert.equal(bare.status, 1);
    assert.match(bare.stderr, /docs\/guide\.md#L3-L4 has no quote/);
    const stray = run(seeded({ "0001-a.md": record("0001", { sourceText: `As the guide says.\n\n${GUIDE_SOURCE}` }) }), "check");
    assert.equal(stray.status, 1);
    assert.match(stray.stderr, /As the guide says\./);
  });

  it("fails a record of origin PR whose source text names no pull request, and passes one that does", () => {
    const pull = "- https://github.com/example/app/pull/12\n\n> Keep the column order in the export.";
    const without = run(seeded({ "0001-a.md": record("0001", { origin: "PR" }) }), "check");
    assert.equal(without.status, 1);
    assert.match(without.stderr, /pull request/);
    const withPull = run(seeded({ "0001-a.md": record("0001", { origin: "PR", sourceText: pull }) }), "check");
    assert.equal(withPull.status, 0, withPull.stderr);
  });

  it("accepts an https link with its quote as a source", () => {
    const out = run(seeded({ "0001-a.md": record("0001", { sourceText: "- https://example.com/issues/4#c1\n\n> The report names each source." }) }), "check");
    assert.equal(out.status, 0, out.stderr);
  });

  it("does not test the source text of a record that is no longer in force", () => {
    const root = seeded({ "../deprecated/0001-a.md": record("0001", { status: "Retired" }) });
    put(root, "docs/guide.md", "rewritten\n");
    assert.equal(run(root, "check").status, 0);
  });

  it("fails an identifier that does not match the file number", () => {
    const out = run(seeded({ "0002-a.md": record("0002", { id: "REQ-0003" }) }), "check");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /REQ-0003/);
    assert.match(out.stderr, /REQ-0002/);
  });

  it("fails a status, an origin and a verification value that are not in the lists", () => {
    const out = run(seeded({ "0001-a.md": record("0001", { status: "Done", origin: "guessed", verification: "test, hope" }) }), "check");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /status "Done"/);
    assert.match(out.stderr, /origin "guessed"/);
    assert.match(out.stderr, /verification "hope"/);
  });

  it("accepts several verification methods", () => {
    const out = run(seeded({ "0001-a.md": record("0001", { verification: ["test", "model"] }) }), "check");
    assert.equal(out.status, 0, out.stderr);
  });

  it("fails a bad file name and a duplicate number", () => {
    const out = run(seeded({ "0001-a.md": record("0001"), "0001-b.md": record("0001"), "Notes.md": "# Notes\n" }), "check");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /Notes\.md/);
    assert.match(out.stderr, /duplicate number 0001/);
  });

  it("fails an accepted record with no statement, source text, section or approver, and passes the same record as Proposed", () => {
    const empty = { statement: "", sourceText: "", section: "", decidedBy: "" };
    const accepted = run(seeded({ "0001-a.md": record("0001", empty) }), "check");
    assert.equal(accepted.status, 1);
    for (const name of ["## Statement", "## Source text", '"section"', '"decided_by"']) assert.ok(accepted.stderr.includes(name), `no "${name}" in:\n${accepted.stderr}`);
    const proposed = run(seeded({ "0001-a.md": record("0001", { ...empty, status: "Proposed" }) }), "check");
    assert.equal(proposed.status, 0, proposed.stderr);
  });

  it("fails a record with no Explanation section, an empty Explanation under a Statement, and an Explanation that repeats the Statement", () => {
    const missing = run(seeded({ "0001-a.md": record("0001").replace(`## Explanation\n\n${EXPLANATION}\n\n`, "") }), "check");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /0001-a\.md: missing the section "## Explanation"\. Add it after the Statement: what the requirement entails, in simple English, with each glossary, technical or jargon term defined\./);
    const empty = run(seeded({ "0001-a.md": record("0001", { explanation: "" }) }), "check");
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /the section "## Explanation" is empty, and the Statement has text\. Explain what the requirement entails/);
    const copy = run(seeded({ "0001-a.md": record("0001", { explanation: "The report  names each\nsource." }) }), "check");
    assert.equal(copy.status, 1);
    assert.match(copy.stderr, /the Explanation repeats the Statement\./);
  });

  it("names each status in the error for a status that is not in the list", () => {
    const out = run(seeded({ "0001-a.md": record("0001", { status: "Done" }) }), "check");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /status "Done" is not Proposed, Open, Accepted, Rejected, Retired or Superseded by NNNN\./);
  });

  it("passes an Open record that is as incomplete as a Proposed record may be", () => {
    const out = run(seeded({ "0001-a.md": record("0001", { status: "Open", statement: "", explanation: "", sourceText: "", section: "", decidedBy: "" }) }), "check");
    assert.equal(out.status, 0, out.stderr);
  });

  it("fails an Open record with a Statement and no Explanation", () => {
    const out = run(seeded({ "0001-a.md": record("0001", { status: "Open", explanation: "" }) }), "check");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /the section "## Explanation" is empty, and the Statement has text\./);
  });

  it("passes a Proposed record whose Statement and Explanation are both empty", () => {
    const out = run(seeded({ "0001-a.md": record("0001", { status: "Proposed", statement: "", explanation: "", section: "", decidedBy: "" }) }), "check");
    assert.equal(out.status, 0, out.stderr);
  });

  it("fails a record with no Statement section", () => {
    const out = run(seeded({ "0001-a.md": record("0001").replace("## Statement", "## Text") }), "check");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /## Statement/);
  });

  it("fails a Superseded by that names no record, itself or an older record", () => {
    const missing = run(seeded({ "0001-a.md": record("0001", { status: "Superseded by 0009" }) }), "check");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Superseded by 0009/);
    const itself = run(seeded({ "0001-a.md": record("0001", { status: "Superseded by 0001" }) }), "check");
    assert.equal(itself.status, 1);
    assert.match(itself.stderr, /names itself/);
    const older = run(seeded({ "0001-a.md": record("0001"), "0002-b.md": record("0002", { status: "Superseded by 0001" }) }), "check");
    assert.equal(older.status, 1);
    assert.match(older.stderr, /older/);
    const valid = run(seeded({ "../deprecated/0001-a.md": record("0001", { status: "Superseded by 0002" }), "0002-b.md": record("0002") }), "check");
    assert.equal(valid.status, 0, valid.stderr);
  });

  it("ignores README.md and the extra and generated folders", () => {
    const root = seeded();
    put(root, `${DIR}/README.md`, "# About\n");
    put(root, `${DIR}/extra/glossary.md`, "# Glossary\n");
    put(root, `${DIR}/generated/old.md`, "stale\n");
    const out = run(root, "check");
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /1 record checked/);
  });
});

describe("list and search", () => {
  const two = () => seeded({
    "0001-the-report-names-each-source.md": record("0001"),
    "0002-a-retry-keeps-the-first-result.md": record("0002", { title: "A retry keeps the first result", status: "Proposed", section: "Pipeline", statement: "A retry keeps the first result." }),
  });

  it("lists each record with its identifier, status and title", () => {
    const out = run(two(), "list");
    assert.equal(out.status, 0, out.stderr);
    const lines = out.stdout.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /REQ-0001\s+Accepted\s+The report names each source/);
    assert.match(lines[1], /REQ-0002\s+Proposed\s+A retry keeps the first result/);
  });

  it("filters the list by status and by section", () => {
    const root = two();
    assert.match(run(root, "list", "--status", "Proposed").stdout, /^REQ-0002.*\n$/);
    assert.match(run(root, "list", "--section", "Report").stdout, /^REQ-0001.*\n$/);
  });

  it("says that there are no records when the folder is empty", () => {
    const out = run(project(), "list");
    assert.equal(out.status, 0);
    assert.match(out.stdout, /No records in docs\/formal\/requirements/);
  });

  it("finds the records that hold every term, in any case", () => {
    const out = run(two(), "search", "RETRY", "result");
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /REQ-0002/);
    assert.doesNotMatch(out.stdout, /REQ-0001/);
    assert.match(out.stdout, /searched 2 records/);
  });

  it("says how many records it searched when none match", () => {
    const out = run(two(), "search", "bollard");
    assert.equal(out.status, 0);
    assert.match(out.stdout, /No record matches "bollard" \(searched 2 records\)/);
  });
});

describe("render", () => {
  it("writes one HTML file with an article for each record, its statement and a link to each source", () => {
    const root = seeded({ "0001-a.md": record("0001", { explanation: "A *source* is a document.", statement: "The report **names** each [source](extra/glossary.md#source).\n\n> A quoted rule.\n\n- one\n- two", sourceText: `${GUIDE_SOURCE}\n\n- https://example.com/issues/4\n\n> The owner asked for <each> source.` }) });
    const out = run(root, "render");
    assert.equal(out.status, 0, out.stderr);
    assert.ok(out.stdout.includes(path.join(root, HTML)));
    const html = readFileSync(path.join(root, HTML), "utf8");
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<article id="REQ-0001"/);
    assert.match(html, /<p class="meta">Accepted · Level: normal · Type: product · explicit · Verification: unassigned · Author: Neil Ellis · Decided by Neil Ellis, 2026-01-02 · /);
    assert.match(html, /<strong>names<\/strong>/);
    assert.match(html, /<a href="\.\.\/extra\/glossary\.md#source">source<\/a>/);
    assert.match(html, /<blockquote>\s*<p>A quoted rule\.<\/p>\s*<\/blockquote>/);
    assert.match(html, /<li>one<\/li>\s*<li>two<\/li>/);
    assert.match(html, /<\/div>\n<h4>Explanation<\/h4>\n<div class="explanation">\n<p>A <em>source<\/em> is a document\.<\/p>\n<\/div>\n<h4>Source text<\/h4>/);
    assert.match(html, /<a href="\.\.\/\.\.\/\.\.\/\.\.\/docs\/guide\.md#L3-L4">docs\/guide\.md#L3-L4<\/a>/);
    assert.match(html, /<blockquote class="source">The report names each source\.\nThe report refuses an unread source\.<\/blockquote>/);
    assert.match(html, /<a href="https:\/\/example\.com\/issues\/4">/);
    assert.match(html, /<blockquote class="source">The owner asked for &lt;each&gt; source\.<\/blockquote>/);
  });

  it("escapes markup in a record and makes no link from a script address", () => {
    const root = seeded({ "0001-a.md": record("0001", { title: "A <b>bold</b> title", statement: "Text <script>alert(1)</script> and [a trap](javascript:alert(1))." }) });
    assert.equal(run(root, "render").status, 0);
    const html = readFileSync(path.join(root, HTML), "utf8");
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /A &lt;b&gt;bold&lt;\/b&gt; title/);
    assert.doesNotMatch(html, /href="javascript:/);
  });

  it("shows an Open record in its section, marked as Open, and counts it", () => {
    const root = seeded({
      "0001-a.md": record("0001", { section: "Report" }),
      "0002-b.md": record("0002", { section: "Report", title: "The report has a date", status: "Open" }),
    });
    assert.equal(run(root, "render").status, 0);
    const html = readFileSync(path.join(root, HTML), "utf8");
    assert.match(html, /<article id="REQ-0002" class="status-open">/);
    assert.match(html, /\.status-open\{[^}]+\}/);
    assert.match(html, /2 records: 1 Accepted, 1 Open\./);
    assert.ok(html.indexOf('<section id="section-report"') < html.indexOf('<article id="REQ-0002"'));
    assert.equal(html.indexOf('<section id="not-in-force"'), -1);
    assert.match(run(root, "list", "--status", "Open").stdout, /^REQ-0002 {2}Open {2,}The report has a date {2}\S+\n$/);
  });

  it("groups the records in force by section and lists the others apart", () => {
    const root = seeded({
      "0001-a.md": record("0001", { section: "Report" }),
      "0002-b.md": record("0002", { section: "Pipeline", title: "A retry keeps the first result" }),
      "0003-c.md": record("0003", { section: "Report", title: "The report has a date", status: "Proposed" }),
      "0004-d.md": record("0004", { section: "Report", title: "The report has a logo", status: "Rejected" }),
    });
    assert.equal(run(root, "render").status, 0);
    const html = readFileSync(path.join(root, HTML), "utf8");
    const at = (text) => {
      const index = html.indexOf(text);
      assert.notEqual(index, -1, `"${text}" is not in the document`);
      return index;
    };
    assert.ok(at('<section id="section-report"') < at('<article id="REQ-0001"'));
    assert.ok(at('<article id="REQ-0001"') < at('<article id="REQ-0003"'));
    assert.ok(at('<article id="REQ-0003"') < at('<section id="section-pipeline"'));
    assert.ok(at('<section id="section-pipeline"') < at('<article id="REQ-0002"'));
    assert.ok(at('<article id="REQ-0002"') < at('<section id="not-in-force"'));
    assert.ok(at('<section id="not-in-force"') < at('<article id="REQ-0004"'));
  });

  it("writes the same bytes on each run", () => {
    const root = seeded();
    run(root, "render");
    const first = readFileSync(path.join(root, HTML), "utf8");
    run(root, "render");
    assert.equal(readFileSync(path.join(root, HTML), "utf8"), first);
  });

  it("checks that the file on disk is current: absent fails, fresh passes, a changed record fails", () => {
    const root = seeded();
    const absent = run(root, "render", "--check");
    assert.equal(absent.status, 1);
    assert.match(absent.stderr, /requirements\.html/);
    assert.match(absent.stderr, /ndev requirements render/);
    run(root, "render");
    assert.equal(run(root, "render", "--check").status, 0);
    put(root, `${DIR}/0001-the-report-names-each-source.md`, record("0001", { title: "The report names every source" }));
    const stale = run(root, "render", "--check");
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /not current/);
    assert.doesNotMatch(readFileSync(path.join(root, HTML), "utf8"), /every source/);
  });

  it("refuses to render records that fail the check", () => {
    const root = seeded({ "0001-a.md": record("0001", { status: "Done" }) });
    const out = run(root, "render");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /status "Done"/);
    assert.equal(existsSync(path.join(root, HTML)), false);
  });
});

const git = (root, ...args) => {
  const out = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(out.status, 0, `git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout;
};
const committed = (records) => {
  const root = seeded(records);
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "base");
  git(root, "tag", "base");
  return root;
};
const inTerminal = (root, ...args) => {
  const out = spawnSync("python3", ["-c", "import pty, sys; sys.exit(pty.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])) if hasattr(pty, 'waitstatus_to_exitcode') else __import__('os').waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))", NDEV, "requirements", ...args, "--root", root], { encoding: "utf8", input: "" });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
};
const FILE = "0001-the-report-names-each-source.md";
const edit = (root, change) => {
  const full = path.join(root, DIR, FILE);
  writeFileSync(full, change(readFileSync(full, "utf8")));
};

describe("guard", () => {
  it("passes a record that is new since the base", () => {
    const root = committed();
    put(root, `${DIR}/0002-a-new-record.md`, record("0002", { statement: "A new statement." }));
    const out = run(root, "guard", "--base", "base");
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /2 records guarded against base: no protected text changed without agreement/);
  });

  it("passes changes to the status, the trace and the notes, with a new Log entry", () => {
    const root = committed();
    edit(root, (text) => text.replace("status: Accepted", "status: Retired").replace("## Trace\n", "## Trace\n\n- scripts/report.mjs\n").replace("## Notes\n", "## Notes\n\nA note.\n").replace(/Created\.\n$/, "Created.\n- 2026-02-03: Retired, because the report was removed.\n"));
    const out = run(root, "guard", "--base", "base");
    assert.equal(out.status, 0, out.stderr);
  });

  it("passes a citation whose line numbers changed while its path and quote did not", () => {
    const root = committed();
    edit(root, (text) => text.replace("docs/guide.md#L3-L4", "docs/guide.md#L5-L6"));
    const out = run(root, "guard", "--base", "base");
    assert.equal(out.status, 0, out.stderr);
  });

  it("matches a record by its number when its file name changed", () => {
    const root = committed();
    git(root, "mv", `${DIR}/${FILE}`, `${DIR}/0001-the-report-names-every-source.md`);
    const out = run(root, "guard", "--base", "base");
    assert.equal(out.status, 0, out.stderr);
  });

  it("fails a changed Statement with no agreement, and shows the old and the new text", () => {
    const root = committed();
    edit(root, (text) => text.replace("The report names each source.\n\n## Explanation", "The report names every source.\n\n## Explanation"));
    const out = run(root, "guard", "--base", "base");
    assert.equal(out.status, 1);
    assert.match(out.stderr, new RegExp(`${DIR}/${FILE}: the Statement changed since base, and no human agreed`));
    assert.match(out.stderr, /old:\n {4}The report names each source\./);
    assert.match(out.stderr, /new:\n {4}The report names every source\./);
    assert.match(out.stderr, /ndev requirements agree REQ-0001 --by "<name>"/);
  });

  it("fails a changed quote in the Source text with no agreement", () => {
    const root = committed();
    edit(root, (text) => text.replace("> The report refuses an unread source.", "> The report refuses a source."));
    const out = run(root, "guard", "--base", "base");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /the Source text changed since base, and no human agreed/);
  });

  it("fails a changed citation path with no agreement", () => {
    const root = committed();
    edit(root, (text) => text.replaceAll("docs/guide.md#L3-L4", "docs/other.md#L3-L4"));
    const out = run(root, "guard", "--base", "base");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /the Source text changed/);
  });

  it("fails a record that was deleted", () => {
    const root = committed();
    git(root, "rm", "-q", `${DIR}/${FILE}`);
    const out = run(root, "guard", "--base", "base");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /REQ-0001 \(docs\/formal\/requirements\/0001-the-report-names-each-source\.md at base\) is deleted\. A record is never deleted/);
  });

  it("passes a change that a human agreed to, and fails it again when the text changes after the agreement", () => {
    const root = committed();
    edit(root, (text) => text.replace("The report names each source.\n\n## Explanation", "The report names every source.\n\n## Explanation"));
    assert.equal(run(root, "log", "REQ-0001", "The Statement says every source.").status, 0);
    const agreed = inTerminal(root, "agree", "REQ-0001", "--by", "Neil Ellis");
    assert.equal(agreed.status, 0, agreed.stdout);
    const text = readFileSync(path.join(root, DIR, FILE), "utf8");
    assert.match(text, /^agreed: "Neil Ellis, \d{4}-\d{2}-\d{2}, text [0-9a-f]{12}"\n---\n/m);
    assert.equal(run(root, "check").status, 0);
    assert.equal(run(root, "guard", "--base", "base").status, 0);
    edit(root, (t) => t.replace("The report names every source.", "The report names all sources."));
    const out = run(root, "guard", "--base", "base");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /the agreement is for other text/);
  });

  it("keeps an agreement valid when only the line numbers move afterwards", () => {
    const root = committed();
    edit(root, (text) => text.replace("The report names each source.\n\n## Explanation", "The report names every source.\n\n## Explanation"));
    assert.equal(run(root, "log", "REQ-0001", "The Statement says every source.").status, 0);
    assert.equal(inTerminal(root, "agree", "REQ-0001", "--by", "Neil Ellis").status, 0);
    edit(root, (text) => text.replace("docs/guide.md#L3-L4", "docs/guide.md#L5-L6"));
    assert.equal(run(root, "guard", "--base", "base").status, 0);
  });

  it("fails a duplicate number instead of comparing only one of the files", () => {
    const root = committed();
    edit(root, (text) => text.replace("The report names each source.\n\n## Explanation", "The report names every source.\n\n## Explanation"));
    put(root, `${DIR}/0001-zz-copy.md`, record("0001"));
    const out = run(root, "guard", "--base", "base");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /duplicate number 0001/);
  });

  it("fails a changed line anchor in a link, which is not a moved citation", () => {
    const root = committed({ [FILE]: record("0001", { sourceText: "- https://example.com/doc#L1-L5\n\n> The report names each source." }) });
    edit(root, (text) => text.replaceAll("doc#L1-L5", "doc#L9-L12"));
    const out = run(root, "guard", "--base", "base");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /the Source text changed/);
  });

  it("reads the base when the project is a folder inside the repository", () => {
    const outer = project();
    const root = path.join(outer, "app");
    put(root, "docs/guide.md", GUIDE);
    put(root, `${DIR}/${FILE}`, record("0001"));
    git(outer, "init", "-q");
    git(outer, "add", "-A");
    git(outer, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "base");
    const out = run(root, "guard", "--base", "HEAD");
    assert.equal(out.status, 0, out.stderr);
  });

  it("needs a base, and names a base that git cannot read", () => {
    const root = committed();
    const missing = run(root, "guard");
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /guard needs --base <git ref>/);
    const bad = run(root, "guard", "--base", "no-such-ref");
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /no-such-ref.*exited 128: fatal: /s);
  });
});

describe("front matter", () => {
  const BULLETS = "# The report names each source\n\n- ID: REQ-0001\n- Status: Accepted\n- Origin: explicit\n- Section: Report\n- Date: 2026-01-02\n- Decided by: Neil Ellis\n- Verification: unassigned\n\n## Statement\n\nThe report names each source.\n\n## Source text\n\n" + GUIDE_SOURCE + "\n\n## Trace\n\n## Notes\n\n";
  const failing = (text, pattern) => {
    const out = run(seeded({ [FILE]: text }), "check");
    assert.equal(out.status, 1, out.stdout);
    assert.match(out.stderr, pattern);
  };

  it("fails a record whose fields are a bullet list under the title", () => {
    failing(BULLETS, /0001-the-report-names-each-source\.md: the fields are a "- Name: value" list under the title\. Put them in YAML front matter at the top of the file/);
  });

  it("fails a record with no author, and names the command that sets it", () => {
    failing(record("0001", { author: [] }), /no "author"\. List the people who wrote the source text: ndev requirements author REQ-0001 "<name>"/);
    failing(record("0001", { author: [""] }), /no "author"/);
  });

  it("fails an unknown key, a repeated key, a missing title, a list where one value belongs and front matter that does not close", () => {
    failing(record("0001").replace("status: Accepted", "status: Accepted\nowner: Ann"), /"owner" is not a field of a record/);
    failing(record("0001").replace("status: Accepted", "status: Accepted\nstatus: Proposed"), /"status" is in the front matter more than once/);
    failing(record("0001").replace(/^title: .*\n/m, ""), /no "title" in the front matter/);
    failing(record("0001").replace(/^section: .*$/m, "section:\n  - Report"), /"section" is a list\. It takes one value/);
    failing(record("0001").replace("\n---\n\n## Statement", "\n\n## Statement"), /the front matter has no closing "---" line/);
    failing(record("0001").replace('title: "The report names each source"', 'title: "The report'), /front matter line "title: \\"The report" is not valid/);
    for (const line of ["author: [Ann, Bob]", "author: Ann # a comment", "author: |", "author: &x Ann", "author: *x", "author: {a: b}", "author: # Ann"]) failing(record("0001").replace(/^author:\n  - "Neil Ellis"$/m, line), new RegExp(`front matter line ${JSON.stringify(JSON.stringify(line)).slice(1, -1).replace(/[[\]{}|*]/g, "\\$&")} is not valid`));
    failing(record("0001", { author: ["Ann", "Bob"] }).replace('  - "Ann"\n', '  - "Ann"\n\n'), /front matter line "  - \\"Bob\\"" is not "key: value"/);
  });

  it("fails fields that are not in the order of the template, and names that order", () => {
    const text = record("0001");
    const id = text.match(/^id: .*\n/m)[0];
    failing(text.replace(id, "").replace(/^(title: .*\n)/m, `$1${id}`), /the fields are not in the order id, title, status, .*\. Put them in that order/);
  });

  it("reads quoted values, plain values and a single-quoted value", () => {
    const root = seeded({ [FILE]: record("0001", { title: 'A "quoted": title' }).replace('section: "Report"', "section: 'Report'") });
    assert.equal(run(root, "check").status, 0);
    assert.match(run(root, "list", "--section", "Report").stdout, /REQ-0001  Accepted  A "quoted": title  /);
  });
});

const MODEL = "models/report.qnt";
const QUINT = "module report {\n  // REQ-0001\n  var named: Set[str]\n  pure def names(s) = s\n  action step = named' = named\n  temporal everyNamed = always(true)\n}\n";
const modelled = (model, text = QUINT) => {
  const root = seeded({ [FILE]: record("0001", { model }) });
  put(root, MODEL, text);
  return root;
};

describe("model", () => {
  it("passes a record whose models exist, cite it and declare the named parts", () => {
    const out = run(modelled([MODEL, `${MODEL}#names`, `${MODEL}#step`, `${MODEL}#everyNamed`]), "check");
    assert.equal(out.status, 0, out.stderr);
  });

  it("fails a model that is not a .qnt path, does not exist, does not cite the record or does not declare the name", () => {
    const out = run(modelled(["models/report.tla", "models/missing.qnt", `${MODEL}#absent`]), "check");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /0001-the-report-names-each-source\.md: model "models\/report\.tla" is not a Quint model\. Give a \.qnt path from the project root, with #<name> after it for one part of the model\./);
    assert.match(out.stderr, /0001-the-report-names-each-source\.md: model "models\/missing\.qnt" does not exist\. Write the model with the quint-modeling skill, or correct the path\./);
    assert.match(out.stderr, /0001-the-report-names-each-source\.md: model "models\/report\.qnt#absent": models\/report\.qnt declares no val, def, action, temporal or run named "absent"\./);
    const uncited = run(modelled([MODEL], QUINT.replace("// REQ-0001", "// the report")), "check");
    assert.equal(uncited.status, 1);
    assert.match(uncited.stderr, /model "models\/report\.qnt" does not cite REQ-0001\. Add a comment that names REQ-0001 at the part of the model that specifies it\./);
  });

  it("fails a model path that is not in its plain form, and a name that only a comment declares", () => {
    const out = run(modelled([`./${MODEL}`, `models/../${MODEL}`, `${MODEL}#settle`, `${MODEL}#total`], QUINT.replace("// REQ-0001", "// REQ-0001 def settle\n  /* val total */")), "check");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /model "\.\/models\/report\.qnt" is not in its plain form\. Write "models\/report\.qnt"\./);
    assert.match(out.stderr, /model "models\/\.\.\/models\/report\.qnt" is not in its plain form\. Write "models\/report\.qnt"\./);
    assert.match(out.stderr, /declares no val, def, action, temporal or run named "settle"/);
    assert.match(out.stderr, /declares no val, def, action, temporal or run named "total"/);
  });

  it("puts model after verification", () => {
    const root = modelled([MODEL]);
    const rel = path.join(root, DIR, FILE);
    writeFileSync(rel, readFileSync(rel, "utf8").replace(/^(verification: .*\n)(model:\n  - .*\n)/m, "$2$1"));
    const out = run(root, "check");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /the fields are not in the order id, title, status, origin, level, type, section, date, source, author, supersedes, superseded_by, decided_by, verification, model, issues, prs, nfr, agreed/);
  });

  it("sets the models of a record with the model command", () => {
    const root = modelled([]);
    const out = run(root, "model", "REQ-0001", MODEL, `${MODEL}#names`);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, `${DIR}/${FILE}: model: ${MODEL}, ${MODEL}#names\n`);
    assert.equal(readFileSync(path.join(root, DIR, FILE), "utf8"), record("0001", { model: [MODEL, `${MODEL}#names`] }).replace(`  - "${MODEL}"\n  - "${MODEL}#names"`, `  - ${MODEL}\n  - ${MODEL}#names`));
    assert.equal(run(root, "check").status, 0);
  });

  it("adds models to the list of a record, and keeps the models it already lists", () => {
    const root = modelled([MODEL]);
    const out = run(root, "model", "REQ-0001", `${MODEL}#names`, MODEL);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, `${DIR}/${FILE}: model: ${MODEL}, ${MODEL}#names\n`);
    assert.match(readFileSync(path.join(root, DIR, FILE), "utf8"), new RegExp(`^model:\\n  - ${MODEL}\\n  - ${MODEL}#names\\nissues:`, "m"));
    const again = run(root, "model", "REQ-0001", `${MODEL}#names`);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, `REQ-0001 already lists ${MODEL}#names\n`);
    assert.equal(run(root, "check").status, 0);
  });

  it("refuses a model the check would fail, and needs a record and a model", () => {
    const root = modelled([]);
    assert.equal(run(root, "model", "REQ-0001").status, 2);
    const tla = run(root, "model", "REQ-0001", "models/report.tla");
    assert.equal(tla.status, 2);
    assert.match(tla.stderr, /"models\/report\.tla" is not a Quint model/);
    const absent = run(root, "model", "REQ-0001", `${MODEL}#absent`);
    assert.equal(absent.status, 1);
    assert.match(absent.stderr, /declares no val, def, action, temporal or run named "absent"/);
    assert.match(readFileSync(path.join(root, DIR, FILE), "utf8"), /^verification: unassigned\nissues: \[\]$/m);
    const twice = run(root, "model", "REQ-0001", MODEL, MODEL);
    assert.equal(twice.status, 2);
    assert.match(twice.stderr, /"models\/report\.qnt" is given twice/);
    const dotted = run(root, "model", "REQ-0001", `./${MODEL}`);
    assert.equal(dotted.status, 2);
    assert.match(dotted.stderr, /"\.\/models\/report\.qnt" is not in its plain form\. Write "models\/report\.qnt"/);
    const unknown = run(root, "model", "REQ-0009", MODEL);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /REQ-0009 is not a record/);
  });
});

describe("author", () => {
  it("sets the authors of a record, and keeps the other fields and the body", () => {
    const root = seeded();
    const out = run(root, "author", "REQ-0001", "Alex Rivera", "Jordan Lee");
    assert.equal(out.status, 0, out.stderr);
    assert.equal(readFileSync(path.join(root, DIR, FILE), "utf8"), record("0001", { author: ["Alex Rivera", "Jordan Lee"] }).replace('  - "Alex Rivera"\n  - "Jordan Lee"', "  - Alex Rivera\n  - Jordan Lee"));
    assert.match(out.stdout, /0001-the-report-names-each-source\.md: author: Alex Rivera, Jordan Lee/);
  });

  it("refuses a name with a comma, as new --author splits names at commas", () => {
    const out = run(seeded(), "author", "REQ-0001", "Alex Rivera, Jordan Lee");
    assert.equal(out.status, 2);
    assert.match(out.stderr, /"Alex Rivera, Jordan Lee" has a comma\. Give each name as its own argument/);
  });

  it("needs a known record and at least one name", () => {
    const root = seeded();
    assert.equal(run(root, "author", "REQ-0001").status, 2);
    const unknown = run(root, "author", "REQ-0009", "Ann");
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /REQ-0009 is not a record/);
    assert.equal(run(root, "author", "REQ-0001", " ").status, 2);
  });

  it("refuses to change the authors of a committed record, and sets them when the committed record has none", () => {
    const root = committed();
    const out = run(root, "author", "REQ-0001", "Ann Smith");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /REQ-0001 is committed with the author Neil Ellis\. The author of a record never changes after it is created\. To change the requirement, deprecate the record and create a new one: ndev requirements deprecate REQ-0001/);
    assert.match(readFileSync(path.join(root, DIR, FILE), "utf8"), /  - "Neil Ellis"/);
    const empty = committed({ [FILE]: record("0001", { author: [] }) });
    const set = run(empty, "author", "REQ-0001", "Ann Smith");
    assert.equal(set.status, 0, set.stderr);
    assert.equal(run(empty, "fixed", "--base", "base").status, 0, run(empty, "fixed", "--base", "base").stderr);
  });
});

describe("source and sync", () => {
  const TWO = `${GUIDE_SOURCE}\n\n- https://github.com/o/r/pull/12\n\n> Name each source.`;
  const checked = (text) => {
    const root = seeded({ [FILE]: text });
    return { root, out: run(root, "check") };
  };

  it("passes a record whose source is its one citation, or the list of its citations in order", () => {
    assert.equal(checked(record("0001")).out.status, 0, checked(record("0001")).out.stderr);
    const two = checked(record("0001", { sourceText: TWO }));
    assert.equal(two.out.status, 0, two.out.stderr);
  });

  it("fails a source that is not the citations of the source text, and names the command that sets it", () => {
    for (const source of [[], ["docs/guide.md#L3-L4"], ["https://github.com/o/r/pull/12", "docs/guide.md#L3-L4"]]) {
      const { out } = checked(record("0001", { sourceText: TWO, source }));
      assert.equal(out.status, 1);
      assert.match(out.stderr, /0001-the-report-names-each-source\.md: "source" is not the citations of the source text, in order \(docs\/guide\.md#L3-L4, https:\/\/github\.com\/o\/r\/pull\/12\): one value for one citation, a list for more\. Run: ndev requirements sync REQ-0001/);
    }
    assert.match(checked(record("0001").replace(/^source: .*\n/m, "")).out.stderr, /"source" is not the citations of the source text/);
  });

  it("fails a list for one citation, and an empty value for no citation", () => {
    assert.match(checked(record("0001").replace(/^source: .*$/m, "source:\n  - docs/guide.md#L3-L4")).out.stderr, /"source" is not the citations of the source text, in order \(docs\/guide\.md#L3-L4\)/);
    const none = checked(record("0001", { status: "Proposed", sourceText: "" }).replace("source: []", 'source: ""'));
    assert.equal(none.out.status, 1);
    assert.match(none.out.stderr, /"source" is not the citations of the source text, in order \(none\)/);
  });

  it("writes nothing when a record has no valid front matter", () => {
    const stale = record("0001", { source: [] });
    const root = seeded({ [FILE]: stale, "0002-a-second-rule.md": "# A second rule\n\n- ID: REQ-0002\n\n## Statement\n" });
    const out = run(root, "sync");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /0002-a-second-rule\.md has no valid front matter/);
    assert.equal(readFileSync(path.join(root, DIR, FILE), "utf8"), stale);
  });

  it("writes the citations of one record, a scalar for one and a list for more", () => {
    const root = seeded({ [FILE]: record("0001", { source: [] }), "0002-a-second-rule.md": record("0002", { title: "A second rule", sourceText: TWO, source: [] }) });
    const one = run(root, "sync", "REQ-0001");
    assert.equal(one.status, 0, one.stderr);
    assert.equal(readFileSync(path.join(root, DIR, FILE), "utf8"), record("0001").replace('source: "docs/guide.md#L3-L4"', "source: docs/guide.md#L3-L4"));
    assert.match(one.stdout, /0001-the-report-names-each-source\.md: source: docs\/guide\.md#L3-L4; issues: none; prs: none/);
    const all = run(root, "sync");
    assert.equal(all.status, 0, all.stderr);
    assert.match(readFileSync(path.join(root, DIR, "0002-a-second-rule.md"), "utf8"), /\nsource:\n  - docs\/guide\.md#L3-L4\n  - https:\/\/github\.com\/o\/r\/pull\/12\nauthor:/);
    assert.match(all.stdout, /^1 record synced/m);
    assert.equal(run(root, "check").status, 0);
    assert.match(run(root, "sync").stdout, /^0 records synced/m);
  });

  it("refuses an unknown record", () => {
    const out = run(seeded({ [FILE]: record("0001") }), "sync", "REQ-0009");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /REQ-0009 is not a record/);
  });
});

describe("guard across the move to front matter", () => {
  it("passes a record whose fields moved from a bullet list to front matter with the same text", () => {
    const root = committed({ [FILE]: "# The report names each source\n\n- ID: REQ-0001\n- Status: Accepted\n- Origin: explicit\n- Section: Report\n- Date: 2026-01-02\n- Decided by: Neil Ellis\n- Verification: unassigned\n\n## Statement\n\nThe report names each source.\n\n## Source text\n\n" + GUIDE_SOURCE + "\n\n## Trace\n\n\n\n## Notes\n\n\n" });
    put(root, `${DIR}/${FILE}`, record("0001"));
    const out = run(root, "guard", "--base", "base");
    assert.equal(out.status, 0, out.stderr);
  });

  it("passes a legacy record with CRLF line endings that moved to front matter with the same text", () => {
    const legacy = "# The report names each source\n\n- ID: REQ-0001\n- Status: Accepted\n- Origin: explicit\n- Section: Report\n- Date: 2026-01-02\n- Decided by: Neil Ellis\n- Verification: unassigned\n\n## Statement\n\nThe report names each source.\n\n## Source text\n\n" + GUIDE_SOURCE + "\n\n## Trace\n\n\n\n## Notes\n\n\n";
    const root = committed({ [FILE]: legacy.replace(/\n/g, "\r\n") });
    put(root, `${DIR}/${FILE}`, record("0001"));
    const out = run(root, "guard", "--base", "base");
    assert.equal(out.status, 0, out.stderr);
  });
});

describe("agree", () => {
  it("refuses to run when standard input is not a terminal", () => {
    const root = committed();
    const out = run(root, "agree", "REQ-0001", "--by", "Neil Ellis");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /agree records the agreement of a human/);
    assert.doesNotMatch(readFileSync(path.join(root, DIR, FILE), "utf8"), /agreed/);
  });

  it("needs a known record and a name", () => {
    const root = committed();
    assert.match(inTerminal(root, "agree", "REQ-0009", "--by", "Neil Ellis").stdout, /REQ-0009 is not a record/);
    assert.match(inTerminal(root, "agree", "REQ-0001").stdout, /agree needs <REQ-NNNN> --by "<name>"/);
  });

  it("replaces an earlier agreement, and keeps the other fields and the body", () => {
    const root = committed();
    assert.equal(inTerminal(root, "agree", "REQ-0001", "--by", "Ann").status, 0);
    assert.equal(inTerminal(root, "agree", "REQ-0001", "--by", "Bob").status, 0);
    const text = readFileSync(path.join(root, DIR, FILE), "utf8");
    assert.equal(text.match(/^agreed:/gm).length, 1);
    assert.match(text, /^agreed: "Bob, /m);
    assert.equal(text.replace(/^agreed: .*\n/m, ""), record("0001"));
  });

  it("writes a name that holds replacement patterns as it is", () => {
    const root = committed();
    assert.equal(inTerminal(root, "agree", "REQ-0001", "--by", "Ann").status, 0);
    assert.equal(inTerminal(root, "agree", "REQ-0001", "--by", "A$'B$&").status, 0);
    assert.match(readFileSync(path.join(root, DIR, FILE), "utf8"), /^agreed: "A\$'B\$&, \d{4}/m);
  });
});

describe("check of the agreement", () => {
  it("fails an agreed value that does not have the form", () => {
    const root = seeded({ [FILE]: record("0001").replace("verification: unassigned", "verification: unassigned\nagreed: yes") });
    const out = run(root, "check");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /"agreed: yes" does not have the form "agreed: <name>, YYYY-MM-DD, text <hash>"/);
  });
});

const LEDGER = `${DIR}/extra/ledger.md`;
const tracked = (files) => {
  const root = project();
  for (const [rel, text] of Object.entries(files)) put(root, rel, text);
  git(root, "init", "-q");
  git(root, "add", "-A");
  return root;
};

describe("sources", () => {
  it("lists the tracked documents by tier, and leaves out the records and untracked files", () => {
    const root = tracked({
      "docs/requirements/model.md": "x\n",
      "NORTH_STAR.md": "x\n",
      "wiki/Home.md": "x\n",
      "README.md": "x\n",
      "packages/api/README.md": "x\n",
      "docs/notes.md": "x\n",
      "src/app.ts": "x\n",
      [`${DIR}/${FILE}`]: record("0001"),
    });
    put(root, "docs/draft.md", "x\n");
    const out = run(root, "sources");
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, ["1  requirements  NORTH_STAR.md", "1  requirements  docs/requirements/model.md", "2  wiki          wiki/Home.md", "3  readme        README.md", "3  readme        packages/api/README.md", "4  other         docs/notes.md", ""].join("\n"));
  });

  it("leaves out the folder of the published pages", () => {
    const root = tracked({ "docs/requirements/model.md": "x\n", "site/requirements/report.md": "x\n", [PUBLISH]: JSON.stringify({ to: "site/requirements", format: "md" }) });
    assert.equal(run(root, "sources").stdout, "1  requirements  docs/requirements/model.md\n");
  });

  it("filters by tier", () => {
    const root = tracked({ "docs/spec.md": "x\n", "README.md": "x\n" });
    assert.equal(run(root, "sources", "--tier", "1").stdout, "1  requirements  docs/spec.md\n");
  });

  it("fails outside a git repository and shows the git error", () => {
    const out = run(project(), "sources");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /git ls-files .* exited 128/);
  });
});

describe("ledger", () => {
  it("records lines that are not a requirement, with a hash of the lines", () => {
    const root = seeded();
    const out = run(root, "ledger", "docs/guide.md", "6", "6", "background: the closing word");
    assert.equal(out.status, 0, out.stderr);
    const text = readFileSync(path.join(root, LEDGER), "utf8");
    assert.match(text, /^- docs\/guide\.md#L6-L6 [0-9a-f]{12}: background: the closing word$/m);
  });

  it("refuses a missing reason, lines outside the file and a range already in the ledger", () => {
    const root = seeded();
    assert.equal(run(root, "ledger", "docs/guide.md", "6", "6").status, 2);
    const past = run(root, "ledger", "docs/guide.md", "6", "9", "background");
    assert.equal(past.status, 1);
    assert.match(past.stderr, /has 6 lines/);
    run(root, "ledger", "docs/guide.md", "6", "6", "background");
    const again = run(root, "ledger", "docs/guide.md", "6", "6", "background");
    assert.equal(again.status, 1);
    assert.match(again.stderr, /docs\/guide\.md#L6-L6 is already in the ledger/);
  });
});

describe("uncovered", () => {
  it("lists each prose line that no record cites and no ledger entry holds, and fails", () => {
    const out = run(seeded(), "uncovered", "docs/guide.md");
    assert.equal(out.status, 1);
    assert.match(out.stdout, /^docs\/guide\.md:6 {2}End\.$/m);
    assert.doesNotMatch(out.stdout, /docs\/guide\.md:[1-5] /);
    assert.match(out.stderr, /1 of 3 prose lines in 1 file not accounted for/);
  });

  it("passes when the ledger holds the other lines, and gives the counts", () => {
    const root = seeded();
    run(root, "ledger", "docs/guide.md", "6", "6", "background");
    const out = run(root, "uncovered", "docs/guide.md");
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, "3 prose lines in 1 file: 2 cited by records, 1 in the ledger, 0 not accounted for\n");
  });

  it("marks a normative line", () => {
    const root = seeded();
    put(root, "docs/rules.md", "The tool must stop on a bad row.\nThe tool was written in 2024.\n");
    const out = run(root, "uncovered", "docs/rules.md");
    assert.match(out.stdout, /^docs\/rules\.md:1 {2}normative {2}The tool must stop on a bad row\.$/m);
    assert.match(out.stdout, /^docs\/rules\.md:2 {2}The tool was written in 2024\.$/m);
    assert.match(out.stderr, /2 of 2 prose lines in 1 file not accounted for \(1 normative\)/);
  });

  it("skips front matter, headings, code blocks, comments, rules and table separators", () => {
    const root = seeded();
    put(root, "docs/shape.md", "---\ntitle: Shape\n---\n# Heading\n\n```sh\nrun it\n```\n<!-- note -->\n---\n| A | B |\n|---|---|\n| 1 | 2 |\n");
    const out = run(root, "uncovered", "docs/shape.md");
    assert.deepEqual(out.stdout.trim().split("\n"), ["docs/shape.md:11  | A | B |", "docs/shape.md:13  | 1 | 2 |"]);
  });

  it("fails front matter that is not closed, instead of skipping the file", () => {
    const root = seeded();
    put(root, "docs/open.md", "---\nThe tool must stop.\n");
    const out = run(root, "uncovered", "docs/open.md");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /docs\/open\.md: the front matter that starts at line 1 has no closing "---"/);
  });

  it("counts a line that starts with two hyphens or with a hash and no space", () => {
    const root = seeded();
    put(root, "docs/marks.md", "--check must stop the run.\n#123 is the issue.\n");
    const out = run(root, "uncovered", "docs/marks.md");
    assert.match(out.stdout, /^docs\/marks\.md:1 /m);
    assert.match(out.stdout, /^docs\/marks\.md:2 /m);
  });

  it("skips the lines inside a comment and a heading with an underline", () => {
    const root = seeded();
    put(root, "docs/hidden.md", "<!--\nThe tool must hide.\n-->\nTitle\n=====\n\nThe tool must stop.\n");
    const out = run(root, "uncovered", "docs/hidden.md");
    assert.deepEqual(out.stdout.trim().split("\n"), ["docs/hidden.md:7  normative  The tool must stop."]);
  });

  it("fails a stale ledger entry for a file that is not in the run, and one whose file is gone", () => {
    const root = seeded();
    put(root, "docs/other.md", "Background.\n");
    put(root, "docs/gone.md", "History.\n");
    run(root, "ledger", "docs/guide.md", "6", "6", "background");
    run(root, "ledger", "docs/other.md", "1", "1", "background");
    run(root, "ledger", "docs/gone.md", "1", "1", "history");
    put(root, "docs/other.md", "The tool must stop.\n");
    rmSync(path.join(root, "docs/gone.md"));
    const out = run(root, "uncovered", "docs/guide.md");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /ledger entry docs\/other\.md#L1-L1: the lines changed/);
    assert.match(out.stderr, /ledger entry docs\/gone\.md#L1-L1: docs\/gone\.md does not exist/);
  });

  it("skips the import, export and component lines of an MDX file", () => {
    const root = seeded();
    put(root, "docs/page.mdx", 'import { Box } from "./box";\nexport const meta = {};\n<Box source="a.md" />\n<Box>\nThe tool must stop.\n</Box>\n');
    const out = run(root, "uncovered", "docs/page.mdx");
    assert.deepEqual(out.stdout.trim().split("\n"), ["docs/page.mdx:5  normative  The tool must stop."]);
  });

  it("counts a line that a rejected record cites as accounted for", () => {
    const root = seeded({ [FILE]: record("0001", { status: "Rejected" }) });
    run(root, "ledger", "docs/guide.md", "6", "6", "background");
    assert.equal(run(root, "uncovered", "docs/guide.md").status, 0);
  });

  it("fails a ledger entry whose lines changed, and asks for a new review", () => {
    const root = seeded();
    run(root, "ledger", "docs/guide.md", "6", "6", "background");
    put(root, "docs/guide.md", GUIDE.replace("End.", "The report must end."));
    const out = run(root, "uncovered", "docs/guide.md");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /ledger entry docs\/guide\.md#L6-L6: the lines changed after the entry was written/);
    assert.match(out.stdout, /^docs\/guide\.md:6 {2}normative {2}The report must end\.$/m);
  });

  it("reads the tier 1 sources when no path is given", () => {
    const root = tracked({ "docs/requirements/spec.md": "The tool must stop.\n", "README.md": "Hello.\n" });
    const out = run(root, "uncovered");
    assert.match(out.stdout, /^docs\/requirements\/spec\.md:1 /m);
    assert.doesNotMatch(out.stdout, /README/);
  });

  it("skips a tier 1 document that is tracked but deleted from the disk", () => {
    const root = tracked({ "docs/requirements/spec.md": "The tool must stop.\n", "docs/requirements/gone.md": "The tool must go.\n" });
    rmSync(path.join(root, "docs/requirements/gone.md"));
    const out = run(root, "uncovered");
    assert.equal(out.status, 1);
    assert.match(out.stdout, /^docs\/requirements\/spec\.md:1 /m);
    assert.doesNotMatch(out.stdout + out.stderr, /gone\.md/);
    assert.doesNotMatch(run(root, "sources").stdout, /gone\.md/);
  });

  it("fails a path that does not exist", () => {
    const out = run(seeded(), "uncovered", "docs/missing.md");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /docs\/missing\.md does not exist/);
  });
});

const PR12 = "https://github.com/o/r/pull/12";
const PR13 = "https://github.com/o/r/pull/13";
const ISSUE5 = "https://github.com/o/r/issues/5";
const PRS = [
  { number: 12, title: "Name each source", url: PR12, closingIssuesReferences: [{ number: 5, url: ISSUE5 }] },
  { number: 13, title: "Bump the parser", url: PR13, closingIssuesReferences: [] },
];
const withPrs = (records, prs = PRS) => {
  const root = seeded(records);
  put(root, "prs.json", JSON.stringify(prs));
  return root;
};
const PR13_SOURCE = `- ${PR13}\n\n> Bump the parser`;

describe("untraced", () => {
  it("lists each merged pull request that no record names, and fails", () => {
    const out = run(withPrs(), "untraced", "--prs", "prs.json");
    assert.equal(out.status, 1);
    assert.equal(out.stdout, `#12  Name each source  ${PR12}\n#13  Bump the parser  ${PR13}\n`);
    assert.match(out.stderr, /2 of 2 merged pull requests trace to no record/);
  });

  it("counts a pull request in a record's Trace, and one in the Source text of a record of origin PR", () => {
    const root = withPrs({
      [FILE]: record("0001", { trace: `- PR: ${PR12}\n- Issue: ${ISSUE5}` }),
      "0002-the-parser-reads-the-new-format.md": record("0002", { status: "Proposed", origin: "PR", decidedBy: "", sourceText: PR13_SOURCE }),
    });
    const out = run(root, "untraced", "--prs", "prs.json");
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, "2 merged pull requests: each traces to a record, with the issues it closes\n");
  });

  it("fails a traced pull request whose closing issue the record does not link", () => {
    const root = withPrs({ [FILE]: record("0001", { trace: `- PR: ${PR12}` }), "0002-the-parser-reads-the-new-format.md": record("0002", { status: "Proposed", origin: "PR", decidedBy: "", sourceText: PR13_SOURCE }) });
    const out = run(root, "untraced", "--prs", "prs.json");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /REQ-0001 traces https:\/\/github\.com\/o\/r\/pull\/12, which closes https:\/\/github\.com\/o\/r\/issues\/5, and does not link it\. Run: ndev requirements link REQ-0001 https:\/\/github\.com\/o\/r\/pull\/12 --prs prs\.json/);
  });

  it("needs --prs, and names a file that is not a list of pull requests", () => {
    const root = withPrs();
    assert.equal(run(root, "untraced").status, 2);
    put(root, "bad.json", "{");
    const bad = run(root, "untraced", "--prs", "bad.json");
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /bad\.json is not JSON/);
    put(root, "odd.json", JSON.stringify([{ number: 1 }]));
    const odd = run(root, "untraced", "--prs", "odd.json");
    assert.equal(odd.status, 1);
    assert.match(odd.stderr, /odd\.json: entry 1 has no pull request url.*gh pr list --state merged --limit 1000 --json number,title,url,closingIssuesReferences/);
  });

  it("fails a closing issue with no issue url, and a pull request with no list of closing issues", () => {
    const root = withPrs({ [FILE]: record("0001", { trace: `- PR: ${PR12}` }) }, [{ number: 12, title: "t", url: PR12, closingIssuesReferences: [{ number: 5 }] }]);
    const noUrl = run(root, "untraced", "--prs", "prs.json");
    assert.equal(noUrl.status, 1);
    assert.match(noUrl.stderr, /prs\.json: entry 1 \(https:\/\/github\.com\/o\/r\/pull\/12\) closing issue 1 has no issue url/);
    put(root, "bare.json", JSON.stringify([{ number: 12, title: "t", url: PR12 }]));
    const bare = run(root, "untraced", "--prs", "bare.json");
    assert.equal(bare.status, 1);
    assert.match(bare.stderr, /bare\.json: entry 1 \(https:\/\/github\.com\/o\/r\/pull\/12\) has no closingIssuesReferences list/);
  });

  it("lists the oldest pull request first, and matches a pull request number exactly", () => {
    const pr1 = "https://github.com/o/r/pull/1";
    const root = withPrs({ [FILE]: record("0001", { trace: `- PR: ${pr1}` }) }, [PRS[1], PRS[0], { number: 1, title: "First", url: pr1, closingIssuesReferences: [] }]);
    const out = run(root, "untraced", "--prs", "prs.json");
    assert.equal(out.stdout, `#12  Name each source  ${PR12}\n#13  Bump the parser  ${PR13}\n`);
  });
});

describe("link", () => {
  it("adds the pull request and the issues it closes to the Trace, once", () => {
    const root = withPrs({ [FILE]: record("0001", { trace: "" }) });
    const out = run(root, "link", "REQ-0001", PR12, "--prs", "prs.json");
    assert.equal(out.status, 0, out.stderr);
    const text = readFileSync(path.join(root, DIR, FILE), "utf8");
    assert.match(text, new RegExp(`## Trace\\n\\n- PR: ${PR12}\\n- Issue: ${ISSUE5}\\n\\n## Notes`));
    const again = run(root, "link", "REQ-0001", PR12, "--prs", "prs.json");
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /already links/);
    assert.equal(readFileSync(path.join(root, DIR, FILE), "utf8"), text);
    assert.equal(run(root, "check").status, 0);
  });

  it("keeps the lines that the Trace already holds, and adds an issue that is named", () => {
    const root = withPrs({ [FILE]: record("0001", { trace: "- Code: src/report.ts" }) });
    run(root, "link", "REQ-0001", PR13, "--issue", "https://github.com/o/r/issues/9");
    assert.match(readFileSync(path.join(root, DIR, FILE), "utf8"), new RegExp(`## Trace\\n\\n- Code: src/report.ts\\n- PR: ${PR13}\\n- Issue: https://github.com/o/r/issues/9\\n\\n## Notes`));
  });

  it("keeps the line endings of a CRLF record", () => {
    const root = withPrs({ [FILE]: record("0001", { trace: "- Code: src/report.ts" }).replace(/\n/g, "\r\n") });
    assert.equal(run(root, "link", "REQ-0001", PR12, "--prs", "prs.json").status, 0);
    const text = readFileSync(path.join(root, DIR, FILE), "utf8");
    assert.doesNotMatch(text.replace(/\r\n/g, ""), /\n/);
    assert.match(text, new RegExp(`## Trace\\r\\n\\r\\n- Code: src/report.ts\\r\\n- PR: ${PR12}\\r\\n- Issue: ${ISSUE5}\\r\\n\\r\\n## Notes`));
  });

  it("ends the file with one newline when the Trace is the last section", () => {
    const root = withPrs({ [FILE]: record("0001", { trace: "" }).replace(/\n## Notes\n\n\n\n## Log\n\n.*\n$/, "") });
    assert.equal(run(root, "link", "REQ-0001", PR13).status, 0);
    assert.match(readFileSync(path.join(root, DIR, FILE), "utf8"), new RegExp(`## Trace\\n\\n- PR: ${PR13}\\n$`));
  });

  it("refuses an unknown record, a link that is not a pull request, and a pull request that is not in the file", () => {
    const root = withPrs();
    assert.equal(run(root, "link", "REQ-0009", PR12).status, 1);
    assert.equal(run(root, "link", "REQ-0001", ISSUE5).status, 2);
    const missing = run(root, "link", "REQ-0001", "https://github.com/o/r/pull/99", "--prs", "prs.json");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /pull\/99 is not in prs\.json/);
  });
});

describe("issues and prs", () => {
  const LINKED = `- PR: ${PR13}\n- Issue: https://github.com/o/r/issues/9\n- PR: ${PR12}\n- Issue: ${ISSUE5}\n- File: docs/guide.md`;
  const WITH_PR = `${GUIDE_SOURCE}\n\n- https://github.com/o/r/pull/20\n\n> Name each source.`;

  it("passes lists of the numbers of the issues and pull requests in the Trace and the source text, in ascending order", () => {
    const text = record("0001", { trace: LINKED, sourceText: WITH_PR });
    assert.match(text, /\nissues:\n  - 5\n  - 9\nprs:\n  - 12\n  - 13\n  - 20\n---/);
    const out = run(seeded({ [FILE]: text }), "check");
    assert.equal(out.status, 0, out.stderr);
  });

  it("fails lists that are missing, out of order or not the links, and names the command that writes them", () => {
    const cases = [
      [record("0001", { trace: LINKED }).replace(/^issues:\n(  - .*\n)*/m, ""), /"issues" is not the numbers of the issues in the Trace \(5, 9\)\. Run: ndev requirements sync REQ-0001/],
      [record("0001", { trace: LINKED, prs: [13, 12] }), /"prs" is not the numbers of the pull requests in the Trace and the source text \(12, 13\)\. Run: ndev requirements sync REQ-0001/],
      [record("0001", { trace: LINKED, issues: [5] }), /"issues" is not the numbers of the issues in the Trace \(5, 9\)/],
      [record("0001", { prs: [12] }), /"prs" is not the numbers of the pull requests in the Trace and the source text \(none\)/],
      [record("0001").replace("issues: []", "issues: 5"), /"issues" is not the numbers of the issues in the Trace \(none\)/],
    ];
    for (const [text, message] of cases) {
      const out = run(seeded({ [FILE]: text }), "check");
      assert.equal(out.status, 1, text);
      assert.match(out.stderr, message);
    }
  });

  it("sync writes the numbers as plain lists, and keeps the rest of the file", () => {
    const good = record("0001", { trace: LINKED, sourceText: WITH_PR });
    const root = seeded({ [FILE]: record("0001", { trace: LINKED, sourceText: WITH_PR, issues: [], prs: [] }) });
    const out = run(root, "sync", "REQ-0001");
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /issues: 5, 9; prs: 12, 13, 20/);
    assert.equal(readFileSync(path.join(root, DIR, FILE), "utf8"), good.replace(/^source:\n  - "docs\/guide\.md#L3-L4"\n  - "https:\/\/github\.com\/o\/r\/pull\/20"$/m, "source:\n  - docs/guide.md#L3-L4\n  - https://github.com/o/r/pull/20"));
    assert.equal(run(root, "check").status, 0);
  });

  it("link writes the numbers of the pull request and the issues it closes", () => {
    const root = withPrs();
    assert.equal(run(root, "link", "REQ-0001", PR12, "--prs", "prs.json").status, 0);
    assert.match(readFileSync(path.join(root, DIR, FILE), "utf8"), /\nissues:\n  - 5\nprs:\n  - 12\n---/);
    const out = run(root, "check");
    assert.equal(out.status, 0, out.stderr);
  });
});

describe("log", () => {
  const CREATED = "- 2026-01-02: Created.";

  it("fails a record with no Log section, no entry, or a line that is not an entry", () => {
    const cases = [
      [record("0001").replace(/\n## Log\n\n.*\n$/, ""), /missing the section "## Log"/],
      [record("0001", { log: "" }), /the Log has no entry\. Each record starts with "- YYYY-MM-DD: Created\."/],
      [record("0001", { log: `${CREATED}\nChanged the title.` }), /Log line "Changed the title\." is not "- YYYY-MM-DD: <what changed>"\. Add an entry with: ndev requirements log REQ-0001 "<what changed>"/],
      [record("0001", { log: `${CREATED}\n- 2026-1-3: Changed.` }), /Log line "- 2026-1-3: Changed\." is not/],
    ];
    for (const [text, message] of cases) {
      const out = run(seeded({ [FILE]: text }), "check");
      assert.equal(out.status, 1, text);
      assert.match(out.stderr, message);
    }
  });

  it("log adds a dated entry at the end of the Log and keeps the rest of the file", () => {
    const root = seeded();
    const out = run(root, "log", "REQ-0001", "Retired, because the report was removed.");
    assert.equal(out.status, 0, out.stderr);
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(readFileSync(path.join(root, DIR, FILE), "utf8"), record("0001", { log: `${CREATED}\n- ${today}: Retired, because the report was removed.` }));
    assert.match(out.stdout, new RegExp(`0001-the-report-names-each-source\\.md: - ${today}: Retired, because the report was removed\\.`));
    assert.equal(run(root, "check").status, 0);
  });

  it("log refuses an unknown record, no text, and text over more than one line", () => {
    const root = seeded();
    assert.equal(run(root, "log", "REQ-0009", "Changed.").status, 1);
    assert.equal(run(root, "log", "REQ-0001").status, 2);
    assert.equal(run(root, "log", "REQ-0001", "  ").status, 2);
    assert.equal(run(root, "log", "REQ-0001", "One.\nTwo.").status, 2);
  });

  it("guard fails a change to the title, the status or the Statement with no new Log entry", () => {
    for (const change of [(t) => t.replace("status: Accepted", "status: Retired"), (t) => t.replace('title: "The report names each source"', 'title: "The report names every source"'), (t) => t.replace("level: normal", "level: hard"), (t) => t.replace("type: product", "type: design")]) {
      const root = committed();
      edit(root, change);
      const out = run(root, "guard", "--base", "base");
      assert.equal(out.status, 1);
      assert.match(out.stderr, new RegExp(`${DIR}/${FILE}: the (status|title|level|type) changed since base, and the Log has no new entry\\. Run: ndev requirements log REQ-0001 "<what changed>"`));
    }
    const root = committed();
    edit(root, (t) => t.replace("The report names each source.\n\n## Explanation", "The report names every source.\n\n## Explanation"));
    assert.match(run(root, "guard", "--base", "base").stderr, /the Statement changed since base, and the Log has no new entry/);
  });

  it("guard fails an edited or removed Log entry", () => {
    for (const change of [(t) => t.replace("Created.", "Made."), (t) => t.replace(/- 2026-01-02: Created\.\n$/, "- 2026-02-03: Retired.\n")]) {
      const root = committed();
      edit(root, change);
      const out = run(root, "guard", "--base", "base");
      assert.equal(out.status, 1);
      assert.match(out.stderr, /the Log entry "- 2026-01-02: Created\." of base is changed or removed\. The Log only grows: restore the entry/);
    }
  });
});

describe("check of the Trace links", () => {
  it("fails a PR line that is not a pull request and an Issue line that is not an issue", () => {
    const out = run(seeded({ [FILE]: record("0001", { trace: `- PR: ${ISSUE5}\n- Issue: ${PR12}` }) }), "check");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /trace line "- PR: https:\/\/github\.com\/o\/r\/issues\/5" is not a link to a pull request/);
    assert.match(out.stderr, /trace line "- Issue: https:\/\/github\.com\/o\/r\/pull\/12" is not a link to an issue/);
  });
});

describe("a Trace with no implementation or plan", () => {
  const nfr = (text, value = "true") => text.replace("\n---\n\n## Statement", `\nnfr: ${value}\n---\n\n## Statement`);
  const guarded = (text) => run(committed({ [FILE]: text }), "guard", "--base", "base");

  it("fails the guard for a Proposed, Open or Accepted record with no File, Issue or PR line, and names the repair", () => {
    for (const status of ["Proposed", "Open", "Accepted"]) {
      const out = guarded(record("0001", { status, trace: "" }));
      assert.equal(out.status, 1, out.stdout);
      assert.match(out.stderr, /0001-the-report-names-each-source\.md: the Trace has no link to what implements the requirement or plans to implement it\./);
      assert.match(out.stderr, /ndev requirements file REQ-0001 <path or pattern>/);
      assert.match(out.stderr, /ndev requirements link REQ-0001 <pull request link>/);
      assert.match(out.stderr, /open an issue/);
      assert.match(out.stderr, /not a requirement/);
    }
  });

  it("fails the guard for a File, Issue or PR line with no value", () => {
    for (const trace of ["- File: ", "- Issue: ", "- PR:  "]) {
      const out = guarded(record("0001", { trace }));
      assert.equal(out.status, 1, JSON.stringify(trace));
      assert.match(out.stderr, /the Trace has no link to what implements the requirement/);
    }
  });

  it("passes the guard with one File, Issue or PR line, and for a record that is not in force", () => {
    for (const trace of ["- File: docs/guide.md", `- Issue: ${ISSUE5}`, `- PR: ${PR12}`]) assert.equal(guarded(record("0001", { trace })).status, 0, trace);
    for (const status of ["Rejected", "Retired"]) assert.equal(guarded(record("0001", { status, trace: "" })).status, 0, status);
  });

  it("passes the guard for a non-functional requirement whose Trace gives the reason it has no link", () => {
    const text = nfr(record("0001", { trace: "- None: the limit applies to the hosting, not to the code." }));
    assert.equal(run(seeded({ [FILE]: text }), "check").status, 0);
    assert.equal(guarded(text).status, 0);
  });

  it("fails the guard for a non-functional requirement with an empty Trace", () => {
    const out = guarded(nfr(record("0001", { trace: "" })));
    assert.equal(out.status, 1);
    assert.match(out.stderr, /the Trace has no link to what implements the requirement/);
  });

  it("fails a None line in a record that is not non-functional, with no reason, or with a link", () => {
    const failing = (text, pattern) => {
      const out = run(seeded({ [FILE]: text }), "check");
      assert.equal(out.status, 1, out.stdout);
      assert.match(out.stderr, pattern);
    };
    failing(record("0001", { trace: "- None: nothing to link." }), /trace line "- None: nothing to link\." is only for a non-functional requirement \(nfr: true\)\. Link what implements the requirement, or the issue that plans it\./);
    failing(nfr(record("0001", { trace: "- None:" })), /trace line "- None:" gives no reason/);
    failing(nfr(record("0001", { trace: "- File: docs/guide.md\n- None: nothing to link." })), /trace line "- None: nothing to link\." is in a Trace that has a link\. Remove it/);
  });

  it("fails an nfr value other than true", () => {
    for (const value of ["false", "yes", '"no"']) {
      const out = run(seeded({ [FILE]: nfr(record("0001"), value) }), "check");
      assert.equal(out.status, 1, value);
      assert.match(out.stderr, /"nfr" takes the value true\. Leave it out for a functional requirement\./);
    }
  });
});

const NARRATIVE = `${DIR}/generated/narrative/report.md`;
const SOURCES_FILE = "0002-the-sources-list-names-each-file.md";
const twoSections = () => seeded({ [FILE]: record("0001"), [SOURCES_FILE]: record("0002", { title: "The sources list names each file", section: "Sources", statement: "The sources list names each file." }) });
const narrated = (prose = "This section is about the report. Each report must name its sources (REQ-0001).\n") => {
  const root = seeded();
  put(root, "prose.md", prose);
  return { root, out: run(root, "narrate", "Report", "--from", "prose.md") };
};

describe("narrate", () => {
  it("prints the records of a section and the state of its narrative", () => {
    const out = run(seeded(), "narrate", "Report");
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /^REQ-0001 Accepted: The report names each source\.$/m);
    assert.match(out.stdout, /^Narrative: missing$/m);
  });

  it("stores the prose with a hash of the records in force in the section", () => {
    const { root, out } = narrated();
    assert.equal(out.status, 0, out.stderr);
    const text = readFileSync(path.join(root, NARRATIVE), "utf8");
    assert.match(text, /^- Section: Report\n- Records: [0-9a-f]{12}\n\nThis section is about the report\. Each report must name its sources \(REQ-0001\)\.\n$/);
    assert.match(run(root, "narrate", "Report").stdout, /^Narrative: current$/m);
  });

  it("fails a normative sentence that cites no record, a record of another section, and a heading, and writes nothing", () => {
    const root = twoSections();
    put(root, "prose.md", "# Report\n\nThe report must name its sources. See REQ-0002 and REQ-0001.\n");
    const out = run(root, "narrate", "Report", "--from", "prose.md");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /prose\.md: "The report must name its sources\." has the normative word "must" and cites no REQ-NNNN/);
    assert.match(out.stderr, /prose\.md: REQ-0002 is not a record in force in the section "Report"/);
    assert.match(out.stderr, /prose\.md: line 1 is a heading/);
    assert.equal(existsSync(path.join(root, NARRATIVE)), false);
  });

  it("checks each list item alone, keeps a citation after the full stop, and counts no id in a code span", () => {
    const { out } = narrated("- Users must log in\n- Sessions end (REQ-0001)\n\nEach report must name its sources. (REQ-0001)\n\nThe word `REQ-0001` must not count.\n");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /"Users must log in" has the normative word "must"/);
    assert.doesNotMatch(out.stderr, /Each report must name its sources/);
    assert.match(out.stderr, /"The word `REQ-0001` must not count\." has the normative word "must"/);
  });

  it("reads a CRLF prose file and prints the number of records", () => {
    const { root, out } = narrated("Each report must name its sources (REQ-0001).\r\nIt is short.\r\n");
    assert.equal(out.status, 0, out.stderr);
    assert.doesNotMatch(readFileSync(path.join(root, NARRATIVE), "utf8"), /\r/);
    assert.match(run(root, "narrate", "Report").stdout, /^1 record in force in "Report"$/m);
  });

  it("fails two sections with the same file name, and a record in force with no section", () => {
    const root = seeded({ [FILE]: record("0001", { section: "Auth & Login" }), [SOURCES_FILE]: record("0002", { section: "Auth Login" }), "0003-a-proposal.md": record("0003", { status: "Proposed", section: "", decidedBy: "" }) });
    const out = run(root, "narrative");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /The sections "Auth & Login" and "Auth Login" have the same file name auth-login\.md\. Rename one section/);
    assert.match(out.stderr, /REQ-0003 has no section\. Set its Section/);
  });

  it("refuses a section with no record in force", () => {
    const out = run(seeded(), "narrate", "Nowhere");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /No record in force has the section "Nowhere"\. The sections are: Report/);
  });
});

describe("narrative", () => {
  it("passes when each section has a current narrative", () => {
    const { root } = narrated();
    const out = run(root, "narrative");
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, "Report  current\n1 section: each narrative is current\n");
  });

  it("fails a missing narrative, a stale one, and one for a section that does not exist", () => {
    const { root } = narrated();
    put(root, `${DIR}/${SOURCES_FILE}`, record("0002", { section: "Sources", statement: "The sources list names each file." }));
    put(root, `${DIR}/${FILE}`, record("0001", { statement: "The report names each source and its date." }));
    put(root, `${DIR}/generated/narrative/gone.md`, "- Section: Gone\n- Records: 000000000000\n\nOld.\n");
    const out = run(root, "narrative");
    assert.equal(out.status, 1);
    assert.match(out.stdout, /^Report  stale$/m);
    assert.match(out.stdout, /^Sources  missing$/m);
    assert.match(out.stderr, /Report: the records changed after the narrative was written\. Read them with: ndev requirements narrate "Report", then write it again with: ndev requirements narrate "Report" --from <file>/);
    assert.match(out.stderr, /Sources: no narrative\. Write it with: ndev requirements narrate "Sources" --from <file>/);
    assert.match(out.stderr, /docs\/formal\/requirements\/generated\/narrative\/gone\.md names the section "Gone", which no record in force has\. Delete the file/);
  });
});

describe("render with the outline and the narrative", () => {
  it("orders the sections as the outline does, and puts each narrative under its heading with links", () => {
    const root = twoSections();
    put(root, `${DIR}/extra/outline.md`, "# The Acme guide\n\n## Sources\n\n## Report\n");
    put(root, "prose.md", "Each report must name its sources (REQ-0001).\n");
    assert.equal(run(root, "narrate", "Report", "--from", "prose.md").status, 0);
    const out = run(root, "render");
    assert.equal(out.status, 0, out.stderr);
    const html = readFileSync(path.join(root, HTML), "utf8");
    assert.match(html, /<title>The Acme guide<\/title>/);
    assert.ok(html.indexOf('id="section-sources"') < html.indexOf('id="section-report"'));
    assert.match(html, /<h2>Report<\/h2>\n<div class="narrative">\n<p>Each report must name its sources \(<a href="#REQ-0001">REQ-0001<\/a>\)\.<\/p>\n<\/div>/);
  });

  it("links a bare id only, and leaves an id in a code span or a link alone", () => {
    const { root } = narrated("Each report must name its sources (REQ-0001). See [the record](#REQ-0001) and `REQ-0001`.\n");
    assert.equal(run(root, "render").status, 0);
    const html = readFileSync(path.join(root, HTML), "utf8");
    assert.match(html, /<p>Each report must name its sources \(<a href="#REQ-0001">REQ-0001<\/a>\)\. See <a href="#REQ-0001">the record<\/a> and <code>REQ-0001<\/code>\.<\/p>/);
    assert.equal(run(root, "render", "--check").status, 0);
    put(root, "prose.md", "Each report must name each source (REQ-0001).\n");
    run(root, "narrate", "Report", "--from", "prose.md");
    assert.equal(run(root, "render", "--check").status, 1);
  });

  it("keeps a narrative current when a record is accepted", () => {
    const root = seeded({ [FILE]: record("0001", { status: "Proposed", decidedBy: "" }) });
    put(root, "prose.md", "Each report must name its sources (REQ-0001).\n");
    run(root, "narrate", "Report", "--from", "prose.md");
    put(root, `${DIR}/${FILE}`, record("0001"));
    assert.equal(run(root, "narrative").status, 0);
  });

  it("fails a duplicate outline section and a second title", () => {
    const root = seeded();
    put(root, `${DIR}/extra/outline.md`, "# Guide\n\n# Other\n\n## Report\n\n## Report\n");
    const out = run(root, "render");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /outline\.md: line 3 is a second title/);
    assert.match(out.stderr, /outline\.md: line 7 names the section "Report" again/);
  });

  it("marks a stale narrative", () => {
    const { root } = narrated();
    put(root, `${DIR}/${FILE}`, record("0001", { statement: "The report names each source and its date." }));
    assert.equal(run(root, "render").status, 0);
    assert.match(readFileSync(path.join(root, HTML), "utf8"), /<div class="narrative stale">\n<p class="warning">The records of this section changed after this text was written\.<\/p>/);
  });

  it("fails a section that is not in the outline, an outline section with no record, and a line that is not a heading", () => {
    const root = twoSections();
    put(root, `${DIR}/extra/outline.md`, "# Guide\n\nSome words.\n\n## Report\n\n## Empty\n");
    const out = run(root, "render");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /REQ-0002 has the section "Sources", which is not in docs\/formal\/requirements\/extra\/outline\.md/);
    assert.match(out.stderr, /docs\/formal\/requirements\/extra\/outline\.md: the section "Empty" has no record in force/);
    assert.match(out.stderr, /docs\/formal\/requirements\/extra\/outline\.md: line 3 is not a heading/);
  });
});

const PUBLISH = `${DIR}/extra/publish.json`;
const OUT = "site/content/requirements";
const configured = (root, config = {}) => put(root, PUBLISH, JSON.stringify({ to: OUT, format: "md", ...config }));
const page = (root, file) => readFileSync(path.join(root, OUT, file), "utf8");

describe("publish", () => {
  it("fails without a publish.json, and names the file and its keys", () => {
    const out = run(seeded(), "publish");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /docs\/formal\/requirements\/extra\/publish\.json does not exist/);
    assert.match(out.stderr, /"to"/);
    assert.match(out.stderr, /"format"/);
  });

  it("fails an unknown key, a format that is not md or mdx, and a folder outside the project", () => {
    const root = seeded();
    put(root, PUBLISH, JSON.stringify({ to: "../elsewhere", format: "html", colour: "red" }));
    const out = run(root, "publish");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /unknown key "colour"/);
    assert.match(out.stderr, /"format" is "html"/);
    assert.match(out.stderr, /"to" is "\.\.\/elsewhere", which is not a folder inside the project/);
  });

  it("writes an index, one page for each section, the records as JSON and a manifest", () => {
    const root = twoSections();
    configured(root);
    const out = run(root, "publish");
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(readdirSync(path.join(root, OUT)).sort(), [".published", "index.md", "report.md", "requirements.json", "sources.md"]);
    assert.deepEqual(page(root, ".published").split("\n").filter(Boolean), ["index.md", "report.md", "requirements.json", "sources.md"]);
    const report = page(root, "report.md");
    assert.match(report, /^---\ntitle: "Report"\ndescription: "1 requirement record in the Report section\."\n---\n\n# Report\n/);
    assert.match(report, /\n<a id="REQ-0001"><\/a>\n\n## REQ-0001 The report names each source\n\nAccepted · Level: normal · Type: product · explicit · Verification: unassigned · Author: Neil Ellis · Decided by Neil Ellis, 2026-01-02 · \[record\]\(\.\.\/\.\.\/\.\.\/docs\/formal\/requirements\/0001-the-report-names-each-source\.md\)\n\nThe report names each source\.\n\n### Explanation\n\nThe report gives a list of each document that it uses\. A source is a document that the report reads\.\n\n### Source text/);
    assert.match(report, /### Source text\n\n- \[docs\/guide\.md#L3-L4\]\(\.\.\/\.\.\/\.\.\/docs\/guide\.md#L3-L4\)\n\n```text\nThe report names each source\.\nThe report refuses an unread source\.\n```\n/);
    const index = page(root, "index.md");
    assert.match(index, /^---\ntitle: "Requirements"\ndescription: "2 requirement records in 2 sections\."\n---\n\n# Requirements\n\n2 records: 2 Accepted\.\n/);
    assert.match(index, /- \[Report\]\(report\.md\) \(1\)\n- \[Sources\]\(sources\.md\) \(1\)/);
    const json = JSON.parse(page(root, "requirements.json"));
    assert.equal(json.title, "Requirements");
    assert.deepEqual(json.records.map((r) => [r.id, r.status, r.section, r.page]), [["REQ-0001", "Accepted", "Report", "report.md"], ["REQ-0002", "Accepted", "Sources", "sources.md"]]);
    assert.equal(json.records[0].statement, "The report names each source.");
    assert.equal(json.records[0].explanation, EXPLANATION);
    assert.deepEqual(json.records[0].author, ["Neil Ellis"]);
    assert.deepEqual(json.records[0].sources, [{ citation: "docs/guide.md#L3-L4", link: "../../../docs/guide.md#L3-L4" }]);
  });

  it("follows the outline for the title and the order of the sections", () => {
    const root = twoSections();
    put(root, `${DIR}/extra/outline.md`, "# The Acme guide\n\n## Sources\n\n## Report\n");
    configured(root);
    assert.equal(run(root, "publish").status, 0);
    const index = page(root, "index.md");
    assert.match(index, /^---\ntitle: "The Acme guide"\ndescription: "2 requirement records in 2 sections\."\n---\n\n# The Acme guide\n/);
    assert.ok(index.indexOf("[Sources]") < index.indexOf("[Report]"));
    assert.deepEqual(JSON.parse(page(root, "requirements.json")).records.map((r) => r.id), ["REQ-0002", "REQ-0001"]);
  });

  it("puts the narrative under the heading and links each bare id to its anchor, on this page or another", () => {
    const root = twoSections();
    put(root, `${DIR}/${FILE}`, record("0001", { notes: "Read with REQ-0002." }));
    put(root, "prose.md", "Each report must name its sources (REQ-0001). See `REQ-0001` and [the record](#REQ-0001).\n");
    assert.equal(run(root, "narrate", "Report", "--from", "prose.md").status, 0);
    configured(root);
    assert.equal(run(root, "publish").status, 0);
    const report = page(root, "report.md");
    assert.match(report, /# Report\n\nEach report must name its sources \(\[REQ-0001\]\(#REQ-0001\)\)\. See `REQ-0001` and \[the record\]\(#REQ-0001\)\.\n/);
    assert.match(report, /### Notes\n\nRead with \[REQ-0002\]\(sources\.md#REQ-0002\)\./);
  });

  it("marks a stale narrative", () => {
    const { root } = narrated();
    put(root, `${DIR}/${FILE}`, record("0001", { statement: "The report names each source and its date." }));
    configured(root);
    assert.equal(run(root, "publish").status, 0);
    assert.match(page(root, "report.md"), /# Report\n\n> The records of this section changed after this text was written\.\n\nThis section is about the report\./);
  });

  it("escapes MDX outside code spans, keeps a code span as it is, and links pages as routes", () => {
    const root = twoSections();
    put(root, `${DIR}/${FILE}`, record("0001", { statement: "The report keeps {braces} and <tags>, and `{code} <a>` as written. See REQ-0002." }));
    configured(root, { format: "mdx", route: "/req" });
    assert.equal(run(root, "publish").status, 0, run(root, "publish").stderr);
    assert.deepEqual(readdirSync(path.join(root, OUT)).sort(), [".published", "index.mdx", "report.mdx", "requirements.json", "sources.mdx"]);
    const report = page(root, "report.mdx");
    assert.match(report, /The report keeps \\\{braces\\\} and &lt;tags>, and `\{code\} <a>` as written\. See \[REQ-0002\]\(\/req\/sources#REQ-0002\)\./);
    assert.equal(JSON.parse(page(root, "requirements.json")).records[0].page, "/req/report");
  });

  it("links the pages under the route when one is given", () => {
    const root = twoSections();
    put(root, `${DIR}/${FILE}`, record("0001", { notes: "Read with REQ-0002." }));
    configured(root, { format: "mdx", route: "/requirements/formal/" });
    assert.equal(run(root, "publish").status, 0);
    assert.match(page(root, "index.mdx"), /- \[Report\]\(\/requirements\/formal\/report\) \(1\)/);
    assert.match(page(root, "report.mdx"), /Read with \[REQ-0002\]\(\/requirements\/formal\/sources#REQ-0002\)\./);
  });

  it("links records and cited lines under the source address when one is given", () => {
    const root = seeded();
    configured(root, { source: "https://github.com/o/r/blob/main/" });
    assert.equal(run(root, "publish").status, 0);
    const report = page(root, "report.md");
    assert.match(report, /\[record\]\(https:\/\/github\.com\/o\/r\/blob\/main\/docs\/formal\/requirements\/0001-the-report-names-each-source\.md\)/);
    assert.match(report, /- \[docs\/guide\.md#L3-L4\]\(https:\/\/github\.com\/o\/r\/blob\/main\/docs\/guide\.md#L3-L4\)/);
  });

  it("adds the front matter of the config, with {records} as the record files of the page", () => {
    const root = twoSections();
    configured(root, { frontMatter: { source: ["scripts/publish.mjs"], wiki: ["{records}"], hidden: "no" } });
    assert.equal(run(root, "publish").status, 0);
    assert.match(page(root, "report.md"), /^---\ntitle: "Report"\ndescription: "1 requirement record in the Report section."\nsource:\n  - "scripts\/publish\.mjs"\nwiki:\n  - "docs\/formal\/requirements\/0001-the-report-names-each-source\.md"\nhidden: "no"\n---\n/);
    assert.match(page(root, "index.md"), /^---\ntitle: "[^"\n]+"\ndescription: "2 requirement records in 2 sections\."\n/);
    assert.match(page(root, "sources.md"), /^---\ntitle: "Sources"\ndescription: "1 requirement record in the Sources section\."\n/);
    assert.match(page(root, "index.md"), /wiki:\n  - "docs\/formal\/requirements\/0001-the-report-names-each-source\.md"\n  - "docs\/formal\/requirements\/0002-the-sources-list-names-each-file\.md"\n/);
  });

  it("refuses a description in the config, because each page has its own", () => {
    const root = seeded();
    configured(root, { frontMatter: { description: "All pages" } });
    const out = run(root, "publish");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /"frontMatter"\."description" is not allowed\. Each page has its own description, made from its records\./);
  });

  it("quotes a section name in the description, and describes the page of the records not in force", () => {
    const root = seeded({ [FILE]: record("0001", { section: 'Auth "v2": a\\b' }), [SOURCES_FILE]: record("0002", { title: "The sources list names each file", status: "Rejected", statement: "The sources list names each file." }) });
    configured(root);
    const out = run(root, "publish");
    assert.equal(out.status, 0, out.stderr);
    const pages = readdirSync(path.join(root, OUT));
    const auth = pages.find((file) => file.startsWith("auth"));
    assert.ok(auth, `no page for the section in ${pages.join(", ")}`);
    assert.match(page(root, auth), /^---\ntitle: "Auth \\"v2\\": a\\\\b"\ndescription: "1 requirement record in the Auth \\"v2\\": a\\\\b section\."\n---\n/);
    assert.match(page(root, "not-in-force.md"), /^---\ntitle: "Not in force"\ndescription: "1 requirement record in the Not in force section\."\n---\n/);
  });

  it("fails a front matter value that is not text or a list of text", () => {
    const root = seeded();
    configured(root, { frontMatter: { order: 3 } });
    const out = run(root, "publish");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /"frontMatter"\."order" is not text or a list of text/);
  });

  it("puts records that are not in force on their own page", () => {
    const root = seeded({ [FILE]: record("0001"), [`../deprecated/${SOURCES_FILE}`]: record("0002", { status: "Retired", title: "The sources list names each file", statement: "The sources list names each file." }) });
    configured(root);
    assert.equal(run(root, "publish").status, 0);
    assert.match(page(root, "not-in-force.md"), /## REQ-0002 The sources list names each file\n\nRetired · /);
    assert.match(page(root, "index.md"), /- \[Not in force\]\(not-in-force\.md\) \(1\)/);
  });

  it("writes the order of the pages for Nextra when asked", () => {
    const root = twoSections();
    put(root, `${DIR}/extra/outline.md`, "# Guide\n\n## Sources\n\n## Report\n");
    configured(root, { format: "mdx", route: "/req", meta: "nextra" });
    assert.equal(run(root, "publish").status, 0);
    assert.equal(page(root, "_meta.js"), 'export default {\n  "index": "Guide",\n  "sources": "Sources",\n  "report": "Report"\n};\n');
    assert.ok(page(root, ".published").split("\n").includes("_meta.js"));
  });

  it("fails mdx with no route, a folder in .git, the records folder, and a manifest entry that is not a plain file name", () => {
    const root = seeded();
    configured(root, { format: "mdx" });
    assert.match(run(root, "publish").stderr, /"route" is needed with "format": "mdx"/);
    configured(root, { to: ".git/pages" });
    assert.match(run(root, "publish").stderr, /"to" is "\.git\/pages", which is not a folder inside the project/);
    configured(root, { to: DIR });
    assert.match(run(root, "publish").stderr, /"to" is "docs\/formal\/requirements", which is not a folder inside the project/);
    configured(root, { to: "..pages" });
    assert.equal(run(root, "publish").status, 0);
    configured(root);
    put(root, `${OUT}/.published`, "index.md\n../../../docs/guide.md\n");
    const out = run(root, "publish");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /site\/content\/requirements\/\.published: "\.\.\/\.\.\/\.\.\/docs\/guide\.md" is not a plain file name/);
    assert.equal(readFileSync(path.join(root, "docs/guide.md"), "utf8"), GUIDE);
  });

  it("keeps code in a fenced block, a code span in a title or a label, and a paragraph's stray backtick as written", () => {
    const root = twoSections();
    const notes = "Press ` to quote {x}.\n\nLater `.\n\n```js\nconst s = `{a}` < 1; // REQ-0002\n```\n\nSee [`a<b` and REQ-0002](https://x.test/REQ-0002/y) and https://x.test/REQ-0002/z.";
    put(root, `${DIR}/${FILE}`, record("0001", { title: "Use `{x}` in <b>", notes }));
    configured(root, { format: "mdx", route: "/req" });
    const out = run(root, "publish");
    assert.equal(out.status, 0, out.stderr);
    const report = page(root, "report.mdx");
    assert.match(report, /## REQ-0001 Use `\{x\}` in &lt;b>\n/);
    assert.match(report, /Press ` to quote \\\{x\\\}\.\n\nLater `\.\n\n```js\nconst s = `\{a\}` < 1; \/\/ REQ-0002\n```\n\nSee \[`a<b` and REQ-0002\]\(https:\/\/x\.test\/REQ-0002\/y\) and https:\/\/x\.test\/REQ-0002\/z\./);
  });

  it("does not link an id inside a link whose address has a space", () => {
    const root = twoSections();
    put(root, `${DIR}/${FILE}`, record("0001", { notes: "See [the note on REQ-0002](<a b.md>)." }));
    configured(root);
    assert.equal(run(root, "publish").status, 0);
    assert.match(page(root, "report.md"), /See \[the note on REQ-0002\]\(<a b\.md>\)\./);
  });

  it("fences a quote with a longer fence than any run of backticks in it", () => {
    const root = project();
    put(root, "docs/guide.md", "# Guide\n\nRun ```npm test``` first.\n");
    put(root, `${DIR}/${FILE}`, record("0001", { sourceText: "- docs/guide.md#L3-L3\n\n> Run ```npm test``` first." }));
    configured(root);
    assert.equal(run(root, "publish").status, 0, run(root, "publish").stderr);
    assert.match(page(root, "report.md"), /````text\nRun ```npm test``` first\.\n````\n/);
  });

  it("removes the pages of the last publish that it no longer writes", () => {
    const root = twoSections();
    configured(root);
    assert.equal(run(root, "publish").status, 0);
    rmSync(path.join(root, DIR, SOURCES_FILE));
    const out = run(root, "publish");
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(readdirSync(path.join(root, OUT)).sort(), [".published", "index.md", "report.md", "requirements.json"]);
  });

  it("groups the pages by type with groupBy type: a folder for each type, a page for each of its sections", () => {
    const root = seeded({ [FILE]: record("0001"), [SOURCES_FILE]: record("0002", { title: "The sources list names each file", section: "Sources", type: "ux", statement: "The sources list names each file.", notes: "Read with REQ-0001." }), ["0003-the-report-has-a-date.md"]: record("0003", { title: "The report has a date", type: "ux", statement: "The report has a date." }) });
    put(root, `${DIR}/extra/outline.md`, "# Guide\n\n## Sources\n\n## Report\n");
    configured(root, { groupBy: "type" });
    const out = run(root, "publish");
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(page(root, ".published").split("\n").filter(Boolean), ["index.md", "product/index.md", "product/report.md", "requirements.json", "ux/index.md", "ux/report.md", "ux/sources.md"]);
    const index = page(root, "index.md");
    assert.match(index, /^---\ntitle: "Guide"\ndescription: "3 requirement records in 2 types\."\n---\n/);
    assert.match(index, /- \[Product\]\(product\/index\.md\) \(1\)\n- \[UX\]\(ux\/index\.md\) \(2\)/);
    const ux = page(root, "ux/index.md");
    assert.match(ux, /^---\ntitle: "UX"\ndescription: "2 requirement records of the type ux in 2 sections\."\n---\n\n# UX\n\nA product requirement that is not a direct function/);
    assert.ok(ux.indexOf("- [Sources](sources.md) (1)") < ux.indexOf("- [Report](report.md) (1)"));
    const report = page(root, "ux/report.md");
    assert.match(report, /^---\ntitle: "Report"\ndescription: "1 requirement record of the type ux in the Report section\."\n---\n\n# Report\n/);
    assert.match(report, /## REQ-0003 The report has a date/);
    assert.doesNotMatch(report, /REQ-0001 The report names/);
    assert.match(report, /\[record\]\(\.\.\/\.\.\/\.\.\/\.\.\/docs\/formal\/requirements\/0003-the-report-has-a-date\.md\)/);
    assert.match(page(root, "ux/sources.md"), /Read with \[REQ-0001\]\(\.\.\/product\/report\.md#REQ-0001\)\./);
    assert.deepEqual(JSON.parse(page(root, "requirements.json")).records.map((r) => [r.id, r.page]), [["REQ-0001", "product/report.md"], ["REQ-0002", "ux/sources.md"], ["REQ-0003", "ux/report.md"]]);
  });

  it("with groupBy type, routes mdx pages under the type, writes a Nextra order in each folder, and keeps the section narrative current against the whole section", () => {
    const root = seeded({ [FILE]: record("0001"), [SOURCES_FILE]: record("0002", { title: "The sources list names each file", type: "ux", statement: "The sources list names each file." }) });
    put(root, "prose.md", "This section is about the report.\n");
    assert.equal(run(root, "narrate", "Report", "--from", "prose.md").status, 0);
    configured(root, { format: "mdx", route: "/req", meta: "nextra", groupBy: "type" });
    const out = run(root, "publish");
    assert.equal(out.status, 0, out.stderr);
    assert.match(page(root, "index.mdx"), /- \[Product\]\(\/req\/product\) \(1\)/);
    assert.equal(page(root, "_meta.js"), 'export default {\n  "index": "Requirements",\n  "product": "Product",\n  "ux": "UX"\n};\n');
    assert.equal(page(root, "ux/_meta.js"), 'export default {\n  "index": "UX",\n  "report": "Report"\n};\n');
    assert.match(page(root, "ux/index.mdx"), /- \[Report\]\(\/req\/ux\/report\) \(1\)/);
    assert.match(page(root, "product/report.mdx"), /# Report\n\nThis section is about the report\./);
    assert.doesNotMatch(page(root, "product/report.mdx"), /changed after this text was written/);
  });

  it("refuses an unknown groupBy, and a manifest entry that leaves the folder", () => {
    const root = seeded();
    configured(root, { groupBy: "colour" });
    assert.match(run(root, "publish").stderr, /"groupBy" is "colour"\. The only value is "type"\./);
    configured(root, { groupBy: "type" });
    put(root, `${OUT}/.published`, "index.md\nproduct/../../x.md\n");
    assert.match(run(root, "publish").stderr, /"product\/\.\.\/\.\.\/x\.md" is not a plain file name/);
  });

  it("orders the type folders as the Types table, and refuses a file where a type folder goes", () => {
    const root = seeded({ [FILE]: record("0001", { type: "implementation" }), [SOURCES_FILE]: record("0002", { title: "The sources list names each file", type: "architectural", statement: "The sources list names each file." }) });
    configured(root, { groupBy: "type" });
    put(root, `${OUT}/architectural`, "Written by hand.\n");
    const out = run(root, "publish");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /site\/content\/requirements\/architectural is a file, and the pages of the type architectural go in a folder of that name/);
    rmSync(path.join(root, OUT), { recursive: true });
    assert.equal(run(root, "publish").status, 0);
    const index = page(root, "index.md");
    assert.ok(index.indexOf("[Architectural]") < index.indexOf("[Implementation]"));
  });

  it("removes a type folder that the last publish wrote and this one does not", () => {
    const root = twoSections();
    configured(root, { groupBy: "type" });
    put(root, `${DIR}/${SOURCES_FILE}`, record("0002", { title: "The sources list names each file", section: "Sources", type: "ux", statement: "The sources list names each file." }));
    assert.equal(run(root, "publish").status, 0);
    rmSync(path.join(root, DIR, SOURCES_FILE));
    assert.equal(run(root, "publish").status, 0);
    assert.deepEqual(readdirSync(path.join(root, OUT)).sort(), [".published", "index.md", "product", "requirements.json"]);
  });

  it("refuses to overwrite a file that it did not write", () => {
    const root = seeded();
    configured(root);
    put(root, `${OUT}/report.md`, "Written by hand.\n");
    const out = run(root, "publish");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /site\/content\/requirements\/report\.md exists and the last publish did not write it/);
    assert.equal(page(root, "report.md"), "Written by hand.\n");
  });

  it("checks that the published files are current", () => {
    const root = twoSections();
    configured(root);
    const before = run(root, "publish", "--check");
    assert.equal(before.status, 1);
    assert.match(before.stderr, /site\/content\/requirements\/index\.md is missing/);
    assert.equal(run(root, "publish").status, 0);
    assert.equal(run(root, "publish", "--check").status, 0);
    put(root, `${DIR}/${FILE}`, record("0001", { statement: "The report names each source and its date." }));
    const changed = run(root, "publish", "--check");
    assert.equal(changed.status, 1);
    assert.match(changed.stderr, /site\/content\/requirements\/report\.md is not current/);
    assert.match(changed.stderr, /ndev requirements publish/);
    rmSync(path.join(root, DIR, SOURCES_FILE));
    assert.match(run(root, "publish", "--check").stderr, /site\/content\/requirements\/sources\.md is left from the last publish/);
    assert.equal(run(root, "publish").status, 0);
    put(root, `${OUT}/.published`, `${page(root, ".published")}missing.md\n`);
    assert.match(run(root, "publish", "--check").stderr, /site\/content\/requirements\/\.published is not current/);
  });
});

const RETIRED = `${DIR}/extra/retired.md`;
const COPY = `${DIR}/extra/sources/docs/guide.md`;
const PDR = "docs/pdr/0001-retire-the-guide.md";
const retirable = (files = {}) => {
  const root = tracked({ "docs/guide.md": GUIDE, [`${DIR}/${FILE}`]: record("0001"), [PDR]: "# Retire the guide\n\nThe records hold docs/guide.md now.\n", ...files });
  assert.equal(run(root, "ledger", "docs/guide.md", "6", "6", "background: the closing word").status, 0);
  git(root, "add", "-A");
  return root;
};
const retired = (files) => {
  const root = retirable(files);
  const out = run(root, "retire", "docs/guide.md", "--pdr", PDR);
  assert.equal(out.status, 0, out.stderr);
  return root;
};

describe("references", () => {
  it("lists each tracked line that names the document or links to it, and leaves out the records, the document and other paths", () => {
    const root = tracked({
      "docs/guide.md": "See docs/guide.md.\n",
      "README.md": "Read docs/guide.md for the rules.\nRead docs/guide.mdx too.\nRead lib/docs/guide.md too.\n",
      "docs/index.md": "Read [the guide](guide.md#top).\n[rules]: ./guide.md\n",
      "notes/plan.md": "[back](../docs/guide.md)\n[web](https://example.com/guide.md)\n",
      "src/load.ts": "load('docs/guide.md');\n",
      [`${DIR}/${FILE}`]: record("0001"),
    });
    put(root, "untracked.md", "docs/guide.md\n");
    const out = run(root, "references", "docs/guide.md");
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, ["README.md:1  Read docs/guide.md for the rules.", "docs/index.md:1  Read [the guide](guide.md#top).", "docs/index.md:2  [rules]: ./guide.md", "notes/plan.md:1  [back](../docs/guide.md)", "src/load.ts:1  load('docs/guide.md');", ""].join("\n"));
  });

  it("passes over a tracked entry that is not a file, and leaves out the published pages", () => {
    const root = tracked({ "docs/guide.md": GUIDE, "README.md": "Read docs/guide.md.\n", "site/content/requirements/report.md": "[s](../../../docs/guide.md#L3-L4)\n", [PUBLISH]: JSON.stringify({ to: "site/content/requirements", format: "md" }) });
    symlinkSync("docs", path.join(root, "linked"));
    git(root, "add", "-A");
    const out = run(root, "references", "docs/guide.md");
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, "README.md:1  Read docs/guide.md.\n");
  });

  it("says when no tracked file references the document", () => {
    const out = run(tracked({ "docs/guide.md": GUIDE }), "references", "docs/guide.md");
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, "No tracked file references docs/guide.md\n");
  });

  it("needs a path", () => {
    assert.equal(run(tracked({ "docs/guide.md": GUIDE }), "references").status, 2);
  });
});

describe("retire", () => {
  it("needs a path and --pdr", () => {
    const root = retirable();
    assert.equal(run(root, "retire", "docs/guide.md").status, 2);
    assert.equal(run(root, "retire", "--pdr", PDR).status, 2);
  });

  it("refuses a decision record that does not exist or does not name the document", () => {
    const root = retirable({ "docs/pdr/0002-other.md": "# Other\n\nNothing here.\n" });
    const missing = run(root, "retire", "docs/guide.md", "--pdr", "docs/pdr/0009-none.md");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /docs\/pdr\/0009-none\.md does not exist/);
    const silent = run(root, "retire", "docs/guide.md", "--pdr", "docs/pdr/0002-other.md");
    assert.equal(silent.status, 1);
    assert.match(silent.stderr, /docs\/pdr\/0002-other\.md does not name docs\/guide\.md/);
    assert.ok(existsSync(path.join(root, "docs/guide.md")));
  });

  it("refuses while a line of the document is not accounted for", () => {
    const root = tracked({ "docs/guide.md": GUIDE, [`${DIR}/${FILE}`]: record("0001"), [PDR]: "Retire docs/guide.md.\n" });
    const out = run(root, "retire", "docs/guide.md", "--pdr", PDR);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /docs\/guide\.md:6 {2}End\./);
    assert.match(out.stderr, /1 of 3 prose lines in 1 file not accounted for/);
    assert.ok(existsSync(path.join(root, "docs/guide.md")));
    assert.equal(existsSync(path.join(root, RETIRED)), false);
  });

  it("refuses while another tracked file references the document, and names the line", () => {
    const root = retirable({ "README.md": "Read docs/guide.md.\n" });
    const out = run(root, "retire", "docs/guide.md", "--pdr", PDR);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /README\.md:1 {2}Read docs\/guide\.md\./);
    assert.match(out.stderr, /1 line in 1 file references docs\/guide\.md/);
    assert.ok(existsSync(path.join(root, "docs/guide.md")));
  });

  it("keeps the references in the files named with --keep, and records them", () => {
    const root = retirable({ "README.md": "Read docs/guide.md.\n", "db/0001_init.sql": "-- from docs/guide.md\n", "CHANGELOG.md": "Wrote docs/guide.md.\n" });
    const partly = run(root, "retire", "docs/guide.md", "--pdr", PDR, "--keep", "db/0001_init.sql,CHANGELOG.md");
    assert.equal(partly.status, 1);
    assert.match(partly.stderr, /README\.md:1/);
    assert.doesNotMatch(partly.stderr, /CHANGELOG|0001_init/);
    put(root, "README.md", "Read the records.\n");
    const out = run(root, "retire", "docs/guide.md", "--pdr", PDR, "--keep", "db/0001_init.sql,CHANGELOG.md");
    assert.equal(out.status, 0, out.stderr);
    assert.match(readFileSync(path.join(root, RETIRED), "utf8"), /^- docs\/guide\.md [0-9a-f]{12} docs\/pdr\/0001-retire-the-guide\.md keep CHANGELOG\.md,db\/0001_init\.sql$/m);
    assert.equal(run(root, "check").status, 0);
  });

  it("refuses a kept file that does not reference the document", () => {
    const root = retirable({ "CHANGELOG.md": "Nothing.\n" });
    const out = run(root, "retire", "docs/guide.md", "--pdr", PDR, "--keep", "CHANGELOG.md");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /CHANGELOG\.md is in --keep and does not reference docs\/guide\.md/);
  });

  it("retires several documents together, and passes over the references between them", () => {
    const root = retirable({ "docs/notes.md": "See [the guide](guide.md).\n", [PDR]: "Retire docs/guide.md and docs/notes.md.\n" });
    assert.equal(run(root, "ledger", "docs/notes.md", "1", "1", "a pointer").status, 0);
    const alone = run(root, "retire", "docs/guide.md", "--pdr", PDR);
    assert.equal(alone.status, 1);
    assert.match(alone.stderr, /docs\/notes\.md:1/);
    const out = run(root, "retire", "docs/guide.md", "docs/notes.md", "--pdr", PDR);
    assert.equal(out.status, 0, out.stderr);
    for (const rel of ["docs/guide.md", "docs/notes.md"]) {
      assert.equal(existsSync(path.join(root, rel)), false);
      assert.ok(existsSync(path.join(root, DIR, "extra/sources", rel)));
    }
    assert.equal(readFileSync(path.join(root, RETIRED), "utf8").split("\n").filter((l) => l.startsWith("- ")).length, 2);
    assert.equal(run(root, "check").status, 0);
  });

  it("refuses the whole set when one document fails, and changes nothing", () => {
    const root = retirable({ "docs/notes.md": "Loose words.\n", [PDR]: "Retire docs/guide.md and docs/notes.md.\n" });
    const out = run(root, "retire", "docs/guide.md", "docs/notes.md", "--pdr", PDR);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /docs\/notes\.md:1 {2}Loose words\./);
    assert.ok(existsSync(path.join(root, "docs/guide.md")));
    assert.equal(existsSync(path.join(root, RETIRED)), false);
  });

  it("freezes a copy, deletes the document and records the retirement", () => {
    const root = retired();
    assert.equal(existsSync(path.join(root, "docs/guide.md")), false);
    assert.equal(readFileSync(path.join(root, COPY), "utf8"), GUIDE);
    assert.match(readFileSync(path.join(root, RETIRED), "utf8"), /^- docs\/guide\.md [0-9a-f]{12} docs\/pdr\/0001-retire-the-guide\.md$/m);
  });

  it("keeps the records and the ledger valid through the frozen copy", () => {
    const root = retired();
    assert.equal(run(root, "check").status, 0, run(root, "check").stderr);
    const covered = run(root, "uncovered", "docs/guide.md");
    assert.equal(covered.status, 0, covered.stderr);
    assert.equal(covered.stdout, "3 prose lines in 1 file: 2 cited by records, 1 in the ledger, 0 not accounted for\n");
    assert.equal(run(root, "quote", "docs/guide.md", "3", "3").status, 0);
  });

  it("links the sources of the rendered and the published pages to the frozen copy", () => {
    const root = retirable();
    configured(root);
    assert.equal(run(root, "publish").status, 0);
    git(root, "add", "-A");
    const out = run(root, "retire", "docs/guide.md", "--pdr", PDR);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(run(root, "render").status, 0);
    assert.match(readFileSync(path.join(root, HTML), "utf8"), /href="(\.\.\/){4}docs\/formal\/requirements\/extra\/sources\/docs\/guide\.md#L3-L4"/);
    assert.equal(run(root, "publish").status, 0);
    assert.ok(page(root, "report.md").includes("](../../../docs/formal/requirements/extra/sources/docs/guide.md#L3-L4)"));
  });

  it("refuses a path that is not in its plain form, before it writes anything", () => {
    const root = retirable({ "docs/my guide.md": GUIDE, "docs/pdr/0002-spaced.md": "Retire docs/my guide.md.\n" });
    for (const [rel, pdr] of [["./docs/guide.md", PDR], ["docs//guide.md", PDR], ["docs/my guide.md", "docs/pdr/0002-spaced.md"]]) {
      const out = run(root, "retire", rel, "--pdr", pdr);
      assert.equal(out.status, 1, `${rel}: ${out.stderr}`);
      assert.match(out.stderr, /is not a plain path/);
    }
    assert.ok(existsSync(path.join(root, "docs/guide.md")));
    assert.ok(existsSync(path.join(root, "docs/my guide.md")));
    assert.equal(existsSync(path.join(root, RETIRED)), false);
  });

  it("refuses a decision record that names only a longer path", () => {
    const root = retirable({ "docs/pdr/0002-other.md": "Retire old-docs/guide.md and docs/guide.md.bak.\n" });
    const out = run(root, "retire", "docs/guide.md", "--pdr", "docs/pdr/0002-other.md");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /does not name docs\/guide\.md/);
  });

  it("refuses when a frozen copy is already there, and changes nothing", () => {
    const root = retirable();
    put(root, COPY, "old copy\n");
    const out = run(root, "retire", "docs/guide.md", "--pdr", PDR);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /docs\/formal\/requirements\/extra\/sources\/docs\/guide\.md exists/);
    assert.equal(readFileSync(path.join(root, COPY), "utf8"), "old copy\n");
    assert.ok(existsSync(path.join(root, "docs/guide.md")));
    assert.equal(existsSync(path.join(root, RETIRED)), false);
  });

  it("refuses a document that is already retired", () => {
    const root = retired();
    const out = run(root, "retire", "docs/guide.md", "--pdr", PDR);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /docs\/guide\.md is already retired/);
  });
});

describe("check of the retired documents", () => {
  it("fails a frozen copy that changed or is missing", () => {
    const root = retired();
    put(root, COPY, GUIDE.replace("End.", "The end."));
    assert.match(run(root, "check").stderr, /docs\/formal\/requirements\/extra\/sources\/docs\/guide\.md, the frozen copy of docs\/guide\.md, changed/);
    rmSync(path.join(root, COPY));
    const out = run(root, "check");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /the frozen copy of docs\/guide\.md, is missing/);
  });

  it("fails a retired document that exists again, and a decision record that is missing", () => {
    const root = retired();
    put(root, "docs/guide.md", GUIDE);
    rmSync(path.join(root, PDR));
    const out = run(root, "check");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /docs\/guide\.md is retired and exists again/);
    assert.match(out.stderr, /docs\/pdr\/0001-retire-the-guide\.md, the decision record for docs\/guide\.md, does not exist/);
  });

  it("fails a line of retired.md that does not have the form", () => {
    const root = retired();
    put(root, RETIRED, `${readFileSync(path.join(root, RETIRED), "utf8")}- docs/other.md\n`);
    const out = run(root, "check");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /"- docs\/other\.md" does not have the form "- <path> <hash> <decision record>"/);
  });
});

describe("usage", () => {
  it("names the commands when the command is unknown", () => {
    const out = run(project(), "frobnicate");
    assert.equal(out.status, 2);
    assert.match(out.stderr, /Unknown requirements command "frobnicate"\. Repair: ndev requirements --help/);
  });
});

const ISSUES = [{ url: ISSUE5, state: "CLOSED" }];
const PARSER = "0002-the-parser-reads-the-new-format.md";
const parser = () => record("0002", { status: "Proposed", origin: "PR", decidedBy: "", sourceText: PR13_SOURCE });
const LINKED = `- PR: ${PR12}\n- Issue: ${ISSUE5}\n- File: src/**`;
const traced = ({ records = { [FILE]: record("0001", { trace: LINKED }), [PARSER]: parser() }, files = { "src/report.js": "export const cited = 'REQ-0001';\n", "src/util.js": "export const plain = 1;\n" }, prs = PRS, issues = ISSUES } = {}) => {
  const root = seeded(records);
  for (const [rel, text] of Object.entries(files)) put(root, rel, text);
  put(root, "prs.json", JSON.stringify(prs));
  put(root, "issues.json", JSON.stringify(issues));
  git(root, "init", "-q");
  git(root, "add", "-A");
  return root;
};
const trace = (root) => run(root, "trace", "--prs", "prs.json", "--issues", "issues.json");

describe("trace", () => {
  it("passes when records, pull requests, issues and files link both ways", () => {
    const out = trace(traced());
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, "2 records trace both ways: 2 merged pull requests, 1 issue, 1 file that cites a record\n");
  });

  it("needs --prs and --issues", () => {
    const root = traced();
    assert.equal(run(root, "trace", "--prs", "prs.json").status, 2);
    const out = run(root, "trace", "--issues", "issues.json");
    assert.equal(out.status, 2);
    assert.match(out.stderr, /trace needs --prs <file> and --issues <file>, made with: gh pr list .* and gh issue list --state all --limit 10000 --json url,state/);
  });

  it("fails an accepted record that lists no file, and passes a proposed one", () => {
    const out = trace(traced({ records: { [FILE]: record("0001", { trace: `- PR: ${PR12}\n- Issue: ${ISSUE5}` }), [PARSER]: parser() }, files: {} }));
    assert.equal(out.status, 1);
    assert.match(out.stderr, /^ndev: REQ-0001 lists no file that implements it, and no open issue that plans it\. Add each file or pattern with: ndev requirements file REQ-0001 <path or pattern>$/m);
    assert.doesNotMatch(out.stderr, /REQ-0002/);
  });

  it("passes an accepted record with no file when an open issue plans it, or when it is non-functional and gives the reason", () => {
    const planned = record("0001", { trace: `- Issue: ${ISSUE5}` });
    const nfr = record("0001", { trace: "- None: the limit applies to the hosting." }).replace("\n---\n\n## Statement", "\nnfr: true\n---\n\n## Statement");
    for (const text of [planned, nfr]) {
      const out = trace(traced({ records: { [FILE]: text, [PARSER]: parser() }, files: {}, issues: [{ url: ISSUE5, state: "OPEN" }] }));
      assert.doesNotMatch(out.stderr, /REQ-0001 lists no file/, text);
      assert.doesNotMatch(out.stderr, /issues\/5, which is/, text);
    }
    const out = trace(traced({ records: { [FILE]: planned, [PARSER]: parser() }, files: {} }));
    assert.match(out.stderr, /REQ-0001 lists no file that implements it, and no open issue that plans it\./);
  });

  it("fails a file pattern that matches no tracked file", () => {
    const out = trace(traced({ records: { [FILE]: record("0001", { trace: `${LINKED}\n- File: lib/**` }), [PARSER]: parser() } }));
    assert.equal(out.status, 1);
    assert.match(out.stderr, /REQ-0001: "- File: lib\/\*\*" matches no tracked file\./);
  });

  it("fails a file that cites an unknown record, a record not in force, or a record that does not list it", () => {
    const records = { [FILE]: record("0001", { trace: LINKED }), [PARSER]: parser(), "0003-the-old-rule.md": record("0003", { status: "Retired" }) };
    const files = { "src/report.js": "// REQ-0001\n", "src/unknown.js": "// REQ-0009\n", "src/old.js": "// REQ-0003\n", "lib/other.js": "\n// REQ-0001 and REQ-0002\n" };
    const out = trace(traced({ records, files }));
    assert.equal(out.status, 1);
    assert.match(out.stderr, /src\/unknown\.js:1 cites REQ-0009, which is not a record in docs\/formal\/requirements\./);
    assert.match(out.stderr, /src\/old\.js:1 cites REQ-0003, which is Retired\. Cite the record in force\./);
    assert.match(out.stderr, /lib\/other\.js:2 cites REQ-0001, whose record does not list the file\. Run: ndev requirements file REQ-0001 lib\/other\.js/);
    assert.match(out.stderr, /lib\/other\.js:2 cites REQ-0002, whose record does not list the file\. Run: ndev requirements file REQ-0002 lib\/other\.js/);
  });

  it("fails a linked pull request that is not merged, and a linked issue that is unknown", () => {
    const records = { [FILE]: record("0001", { trace: `${LINKED}\n- PR: https://github.com/o/r/pull/99\n- Issue: https://github.com/o/r/issues/7` }), [PARSER]: parser() };
    const out = trace(traced({ records, issues: [{ url: ISSUE5, state: "OPEN" }] }));
    assert.equal(out.status, 1);
    assert.match(out.stderr, /REQ-0001 links https:\/\/github\.com\/o\/r\/pull\/99, which is not a merged pull request in prs\.json\./);
    assert.doesNotMatch(out.stderr, /issues\/5/);
    assert.match(out.stderr, /REQ-0001 links https:\/\/github\.com\/o\/r\/issues\/7, which is not in issues\.json\./);
  });

  it("fails a merged pull request that traces to no record", () => {
    const out = trace(traced({ records: { [FILE]: record("0001", { trace: LINKED }) } }));
    assert.equal(out.status, 1);
    assert.equal(out.stdout, `#13  Bump the parser  ${PR13}\n`);
    assert.match(out.stderr, /1 of 2 merged pull requests trace to no record/);
  });

  it("fails a malformed File line, which does not count as a file", () => {
    const out = trace(traced({ records: { [FILE]: record("0001", { trace: `- PR: ${PR12}\n- Issue: ${ISSUE5}\n- File: src/**.js` }), [PARSER]: parser() }, files: {} }));
    assert.equal(out.status, 1);
    assert.match(out.stderr, /REQ-0001: "- File: src\/\*\*\.js" is not a path or pattern inside the project\./);
    assert.match(out.stderr, /REQ-0001 lists no file that implements it/);
  });

  it("checks only the Trace links against the pull requests, not a pull request quoted in the Source text", () => {
    const open = "https://github.com/o/r/pull/77";
    const records = { [FILE]: record("0001", { trace: LINKED }), [PARSER]: parser(), "0003-an-open-change.md": record("0003", { status: "Proposed", origin: "PR", decidedBy: "", sourceText: `- ${open}\n\n> An open change` }) };
    const out = trace(traced({ records }));
    assert.equal(out.status, 0, out.stderr);
  });

  it("does not scan the --prs and --issues files for citations", () => {
    const prs = [{ ...PRS[0], title: "Implements REQ-0002" }, PRS[1]];
    const out = trace(traced({ prs }));
    assert.equal(out.status, 0, out.stderr);
  });

  it("names an issues file that is not a list of issues", () => {
    const root = traced();
    put(root, "issues.json", JSON.stringify([{ url: ISSUE5 }]));
    const out = trace(root);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /issues\.json: entry 1 has no state\. Make the file with: gh issue list --state all --limit 10000 --json url,state > issues\.json/);
  });

  it("accepts a record cited in its own model, and a source file that cites the record and its model", () => {
    const records = { [FILE]: record("0001", { trace: LINKED, model: [MODEL] }), [PARSER]: parser() };
    const out = trace(traced({ records, files: { [MODEL]: QUINT, "src/report.js": `export const cited = 'REQ-0001 ${MODEL}';\n` } }));
    assert.equal(out.status, 0, out.stderr);
  });

  it("fails a source file that cites a record with a model, and not the model", () => {
    const records = { [FILE]: record("0001", { trace: LINKED, model: [`${MODEL}#names`] }), [PARSER]: parser() };
    const out = trace(traced({ records, files: { [MODEL]: QUINT, "src/report.js": "export const cited = 'REQ-0001';\n" } }));
    assert.equal(out.status, 1);
    assert.match(out.stderr, /^ndev: src\/report\.js:1 cites REQ-0001, whose model is models\/report\.qnt, and does not cite the model\. Add "models\/report\.qnt" next to REQ-0001, so that the reader finds the specification\.$/m);
  });

  it("fails a model that cites a record which does not list the model", () => {
    const out = trace(traced({ files: { [MODEL]: QUINT, "src/report.js": "export const cited = 'REQ-0001';\n" } }));
    assert.equal(out.status, 1);
    assert.match(out.stderr, /^ndev: models\/report\.qnt:2 cites REQ-0001, whose record does not list the model\. Run: ndev requirements model REQ-0001 models\/report\.qnt$/m);
  });
});

describe("file", () => {
  it("adds each pattern to the record's Trace once, and matches globs from the root", () => {
    const root = traced({ files: { "src/report.js": "// REQ-0001\n", "src/a/b.js": "x\n", "docs/notes.md": "n\n" } });
    const out = run(root, "file", "REQ-0001", "/docs/*.md", "src/a/**", "src/report.js");
    assert.equal(out.status, 0, out.stderr);
    assert.equal(run(root, "file", "REQ-0001", "src/report.js").stdout, "REQ-0001 already lists src/report.js\n");
    const text = readFileSync(path.join(root, DIR, FILE), "utf8");
    assert.match(text, /- File: src\/\*\*\n- File: \/docs\/\*\.md\n- File: src\/a\/\*\*\n- File: src\/report\.js\n/);
  });

  it("refuses a pattern that matches no tracked file, and a single star does not cross a folder", () => {
    const root = traced({ files: { "src/report.js": "// REQ-0001\n", "src/a/b.js": "x\n" } });
    const out = run(root, "file", "REQ-0001", "src/a/*.ts");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /"src\/a\/\*\.ts" matches no tracked file/);
    assert.equal(run(root, "file", "REQ-0001", "src/*.js").status, 0);
    assert.doesNotMatch(readFileSync(path.join(root, DIR, FILE), "utf8"), /lib/);
    assert.equal(run(root, "file", "REQ-0001", "*/b.js").status, 1);
  });

  it("lists a file whose name holds a space", () => {
    const root = traced({ files: { "src/report.js": "// REQ-0001\n", "docs/My Notes.md": "REQ-0001\n" } });
    assert.equal(run(root, "file", "REQ-0001", "docs/My Notes.md").status, 0);
    assert.equal(trace(root).status, 0);
  });

  it("refuses a path outside the project, and check fails such a File line", () => {
    const root = traced();
    const out = run(root, "file", "REQ-0001", "../x.js");
    assert.equal(out.status, 2);
    assert.match(out.stderr, /"\.\.\/x\.js" is not a path or pattern inside the project/);
    edit(root, (text) => text.replace("- File: src/**", "- File: ../x.js"));
    const checked = run(root, "check");
    assert.equal(checked.status, 1);
    assert.match(checked.stderr, /trace line "- File: \.\.\/x\.js" is not a path or pattern inside the project/);
  });
});

describe("decision records", () => {
  const decided = (trace, files = {}) => tracked({ "docs/guide.md": GUIDE, "docs/pdr/0001-keep-sources.md": "# Keep sources\n\nThe report names each source.\n", "docs/adr/0002-parse-once.md": "# Parse once\n", ...files, [`${DIR}/${FILE}`]: record("0001", { trace }) });

  it("check accepts PDR and ADR lines in the Trace", () => {
    const root = decided("- File: docs/guide.md\n- PDR: docs/pdr/0001-keep-sources.md\n- ADR: docs/adr/0002-parse-once.md");
    const out = run(root, "check");
    assert.equal(out.status, 0, out.stderr);
  });

  it("check fails a PDR line outside a pdr folder, an ADR line outside an adr or decisions folder, and a missing file", () => {
    const root = decided("- File: docs/guide.md\n- PDR: docs/adr/0002-parse-once.md\n- ADR: docs/guide.md\n- PDR: docs/pdr/0009-gone.md");
    const out = run(root, "check");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /trace line "- PDR: docs\/adr\/0002-parse-once\.md" is not a Markdown file in a pdr folder/);
    assert.match(out.stderr, /trace line "- ADR: docs\/guide\.md" is not a Markdown file in an adr or decisions folder/);
    assert.match(out.stderr, /trace line "- PDR: docs\/pdr\/0009-gone\.md" names a file that does not exist/);
  });

  it("a decision line is not an implementation or a plan for guard", () => {
    const root = decided("- PDR: docs/pdr/0001-keep-sources.md");
    git(root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "base");
    const out = run(root, "guard", "--base", "HEAD");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /the Trace has no link to what implements the requirement/);
  });

  it("decision adds PDR and ADR lines by folder, once each", () => {
    const root = decided("- File: docs/guide.md", { "doc/architecture/decisions/0003-cache.md": "# Cache\n" });
    const out = run(root, "decision", "REQ-0001", "docs/pdr/0001-keep-sources.md", "doc/architecture/decisions/0003-cache.md");
    assert.equal(out.status, 0, out.stderr);
    assert.equal(run(root, "decision", "REQ-0001", "docs/pdr/0001-keep-sources.md").stdout, "REQ-0001 already lists docs/pdr/0001-keep-sources.md\n");
    assert.match(readFileSync(path.join(root, DIR, FILE), "utf8"), /- File: docs\/guide\.md\n- PDR: docs\/pdr\/0001-keep-sources\.md\n- ADR: doc\/architecture\/decisions\/0003-cache\.md\n/);
    assert.equal(run(root, "check").status, 0);
  });

  it("decision refuses a file outside a decision folder and an untracked file", () => {
    const root = decided("- File: docs/guide.md");
    const outside = run(root, "decision", "REQ-0001", "docs/guide.md");
    assert.equal(outside.status, 2);
    assert.match(outside.stderr, /"docs\/guide\.md" is not a Markdown file in a pdr, adr or decisions folder/);
    put(root, "docs/pdr/0004-draft.md", "# Draft\n");
    const untracked = run(root, "decision", "REQ-0001", "docs/pdr/0004-draft.md");
    assert.equal(untracked.status, 1);
    assert.match(untracked.stderr, /"docs\/pdr\/0004-draft\.md" is not a tracked file\. git add it first\./);
  });

  it("sources puts PDRs and ADRs in tier 1, and a Source text can quote a PDR", () => {
    const sourceText = "- docs/pdr/0001-keep-sources.md#L3-L3\n\n> The report names each source.";
    const root = tracked({ "docs/guide.md": GUIDE, "docs/pdr/0001-keep-sources.md": "# Keep sources\n\nThe report names each source.\n", "docs/adr/0002-parse-once.md": "# Parse once\n", [`${DIR}/${FILE}`]: record("0001", { sourceText }) });
    assert.equal(run(root, "sources", "--tier", "1").stdout, "1  requirements  docs/adr/0002-parse-once.md\n1  requirements  docs/pdr/0001-keep-sources.md\n");
    const out = run(root, "check");
    assert.equal(out.status, 0, out.stderr);
  });
});

const fakeGh = (answers) => {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-gh-"));
  const log = path.join(dir, "calls.log");
  writeFileSync(path.join(dir, "answers.json"), JSON.stringify(answers));
  writeFileSync(path.join(dir, "gh.cjs"), `const fs = require("fs");
const [command, number] = process.argv.slice(2);
const key = process.env.GH_REPO + " " + command + (number === undefined ? "" : " " + number);
fs.appendFileSync(${JSON.stringify(log)}, key + "\\n");
fs.appendFileSync(${JSON.stringify(path.join(dir, "ttl.log"))}, String(process.env.GH_CACHE_TTL) + "\\n");
const answer = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, "answers.json"))}, "utf8"))[key];
if (!answer) { process.stderr.write("gh.sh: read " + key + ": HTTP 404: Not Found"); process.exit(1); }
if (answer.note) process.stderr.write(answer.note);
process.stdout.write(Array.isArray(answer.lines) ? answer.lines.map((l) => JSON.stringify(l) + "\\n").join("") : JSON.stringify(answer));
`);
  writeFileSync(path.join(dir, "gh.sh"), `#!/usr/bin/env bash\nexec node ${JSON.stringify(path.join(dir, "gh.cjs"))} "$@"\n`);
  const ttl = path.join(dir, "ttl.log");
  return { script: path.join(dir, "gh.sh"), calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []), ttls: () => (existsSync(ttl) ? readFileSync(ttl, "utf8").trim().split("\n").filter(Boolean) : []) };
};
const runWith = (gh, root, ...args) => {
  const out = spawnSync(NDEV, ["requirements", ...args, "--root", root], { encoding: "utf8", env: { ...process.env, NDEV_REQUIREMENTS_GH: gh.script } });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
};
const ISSUE = (n) => `https://github.com/o/r/issues/${n}`;
const PULL = (n) => `https://github.com/o/r/pull/${n}`;
const issueAnswer = (number, state, state_reason = null, body = "") => ({ number, title: "T", state, state_reason, body, url: ISSUE(number) });
const pullAnswer = (number, state, merged) => ({ number, state, merged, title: "T", body: "", url: PULL(number) });

describe("links", () => {
  const linked = (records, files = {}) => tracked({ "docs/guide.md": GUIDE, "src/report.js": "export {}\n", ...files, ...Object.fromEntries(Object.entries(records).map(([file, text]) => [`${DIR}/${file}`, text])) });
  const ANSWERS = {
    "o/r issue-read 1": issueAnswer(1, "open"),
    "o/r issue-read 2": issueAnswer(2, "closed", "completed"),
    "o/r issue-read 3": issueAnswer(3, "closed", "not_planned"),
    "o/r issue-read 4": issueAnswer(4, "closed", "duplicate"),
    "o/r pr-read 10": pullAnswer(10, "closed", true),
    "o/r pr-read 11": pullAnswer(11, "open", false),
    "o/r pr-read 12": pullAnswer(12, "closed", false),
  };

  it("passes a record whose issues, pull requests and files exist and are implemented or planned", () => {
    const gh = fakeGh(ANSWERS);
    const root = linked({ [FILE]: record("0001", { trace: `- File: src/*.js\n- Issue: ${ISSUE(1)}\n- Issue: ${ISSUE(2)}\n- PR: ${PULL(10)}\n- PR: ${PULL(11)}` }) });
    const out = runWith(gh, root, "links", "REQ-0001");
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, "REQ-0001: 2 issues, 2 pull requests and 1 file line link what exists\n");
    assert.deepEqual(gh.calls().sort(), ["o/r issue-read 1", "o/r issue-read 2", "o/r pr-read 10", "o/r pr-read 11"]);
  });

  it("fails a missing issue or pull request, an issue closed without implementation, a pull request closed without a merge, and a file line that matches nothing", () => {
    const gh = fakeGh(ANSWERS);
    const root = linked({ [FILE]: record("0001", { trace: `- File: docs/guide.md\n- File: src/gone.js\n- Issue: ${ISSUE(3)}\n- Issue: ${ISSUE(4)}\n- Issue: ${ISSUE(9)}\n- PR: ${PULL(12)}\n- PR: ${PULL(99)}` }) });
    const out = runWith(gh, root, "links", "REQ-0001");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /REQ-0001: "- Issue: https:\/\/github\.com\/o\/r\/issues\/3" was closed as not planned, so it does not implement or plan the requirement\. Remove the line, or link the issue or pull request that does\./);
    assert.match(out.stderr, /REQ-0001: "- Issue: https:\/\/github\.com\/o\/r\/issues\/4" was closed as a duplicate/);
    assert.match(out.stderr, /REQ-0001: "- Issue: https:\/\/github\.com\/o\/r\/issues\/9" could not be read: gh\.sh issue-read 9 in o\/r exited 1: gh\.sh: read o\/r issue-read 9: HTTP 404: Not Found\. If it does not exist, remove the line\. Otherwise repair GitHub access and run: ndev requirements links REQ-0001/);
    assert.match(out.stderr, /REQ-0001: "- PR: https:\/\/github\.com\/o\/r\/pull\/12" was closed without a merge/);
    assert.match(out.stderr, /REQ-0001: "- PR: https:\/\/github\.com\/o\/r\/pull\/99" could not be read/);
    assert.match(out.stderr, /REQ-0001: "- File: src\/gone\.js" matches no tracked file\. Correct the path, git add the file, or remove the line\./);
    assert.doesNotMatch(out.stderr, /docs\/guide\.md/);
  });

  it("lets a record that is not in force keep a closed link and a removed file, but not a missing link", () => {
    const gh = fakeGh(ANSWERS);
    const root = linked({ [FILE]: record("0001", { status: "Rejected", trace: `- File: src/gone.js\n- Issue: ${ISSUE(3)}\n- PR: ${PULL(12)}\n- PR: ${PULL(99)}` }) });
    const out = runWith(gh, root, "links", "REQ-0001");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /pull\/99" could not be read/);
    assert.doesNotMatch(out.stderr, /issues\/3|pull\/12"|gone\.js/);
  });

  it("with --base, checks only the records that changed since the base, including new ones", () => {
    const gh = fakeGh(ANSWERS);
    const SECOND = "0002-a-retry-keeps-the-first-result.md";
    const root = linked({ [FILE]: record("0001", { trace: `- File: src/gone.js` }), [SECOND]: record("0002", { trace: `- Issue: ${ISSUE(1)}` }) });
    git(root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "base");
    assert.equal(runWith(gh, root, "links", "--base", "HEAD").stdout, "No record changed since HEAD\n");
    put(root, `${DIR}/${SECOND}`, record("0002", { trace: `- Issue: ${ISSUE(1)}\n- PR: ${PULL(12)}` }));
    put(root, `${DIR}/0003-a-new-record.md`, record("0003", { trace: `- Issue: ${ISSUE(2)}` }));
    const out = runWith(gh, root, "links", "--base", "HEAD");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /REQ-0002: "- PR: https:\/\/github\.com\/o\/r\/pull\/12" was closed without a merge/);
    assert.doesNotMatch(out.stderr, /REQ-0001|REQ-0003/);
    assert.deepEqual(gh.calls().sort(), ["o/r issue-read 1", "o/r issue-read 2", "o/r pr-read 12"]);
  });

  it("reads a link once when several records cite it", () => {
    const gh = fakeGh(ANSWERS);
    const root = linked({ [FILE]: record("0001", { trace: `- Issue: ${ISSUE(1)}\n- PR: ${PULL(10)}` }), "0002-a-retry-keeps-the-first-result.md": record("0002", { trace: `- Issue: ${ISSUE(1)}\n- PR: ${PULL(10)}` }) });
    const out = runWith(gh, root, "links", "REQ-0001", "REQ-0002");
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(gh.calls().sort(), ["o/r issue-read 1", "o/r pr-read 10"]);
  });

  it("reads many links of one repository in one issue-states call, and a link missing from the list on its own", () => {
    const state = (number, kind, state, state_reason = null, merged = null) => ({ number, kind, state, state_reason, merged });
    const lines = [...Array.from({ length: 10 }, (_, i) => state(20 + i, "issue", "open")), state(3, "issue", "closed", "not_planned"), state(12, "pull", "closed", null, false)];
    const gh = fakeGh({ "o/r issue-states": { lines }, "o/r issue-read 40": issueAnswer(40, "open") });
    const trace = [...Array.from({ length: 10 }, (_, i) => `- Issue: ${ISSUE(20 + i)}`), `- Issue: ${ISSUE(3)}`, `- PR: ${PULL(12)}`, `- Issue: ${ISSUE(40)}`, `- PR: ${PULL(21)}`].join("\n");
    const root = linked({ [FILE]: record("0001", { trace }) });
    const out = runWith(gh, root, "links", "REQ-0001");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /issues\/3" was closed as not planned/);
    assert.match(out.stderr, /pull\/12" was closed without a merge/);
    assert.match(out.stderr, /pull\/21" could not be read: .*HTTP 404/);
    assert.doesNotMatch(out.stderr, /issues\/(2\d|40)"/);
    assert.deepEqual(gh.calls().sort(), ["o/r issue-read 40", "o/r issue-states", "o/r pr-read 21"]);
  });

  it("runs gh.sh with a 10-minute read cache unless GH_CACHE_TTL is set, and says when an answer came from the cache", () => {
    const gh = fakeGh({ ...ANSWERS, "o/r issue-read 1": { ...issueAnswer(1, "open"), note: "gh.sh: issue-read 1 of o/r answered from a cache made 42s ago. GH_CACHE_TTL=0 reads it fresh.\n" } });
    const root = linked({ [FILE]: record("0001", { trace: `- Issue: ${ISSUE(1)}\n- Issue: ${ISSUE(2)}` }) });
    const out = runWith(gh, root, "links", "REQ-0001");
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /Some GitHub answers came from a cache up to 42s old\. Run with GH_CACHE_TTL=0 to read them fresh\./);
    assert.deepEqual(gh.ttls(), ["600", "600"]);
    const fresh = spawnSync(NDEV, ["requirements", "links", "REQ-0001", "--root", root], { encoding: "utf8", env: { ...process.env, NDEV_REQUIREMENTS_GH: gh.script, GH_CACHE_TTL: "0" } });
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.deepEqual(gh.ttls().slice(2), ["0", "0"]);
  });

  it("refuses a call with no record and no base, and an unknown record", () => {
    const root = linked({ [FILE]: record("0001") });
    const none = run(root, "links");
    assert.equal(none.status, 2);
    assert.match(none.stderr, /links needs record IDs, or --base <ref> for the records that changed since that ref/);
    const unknown = run(root, "links", "REQ-0042");
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /REQ-0042 is not a record/);
  });
});

describe("explained", () => {
  const SECOND = "0002-a-retry-keeps-the-first-result.md";

  it("passes the named records that explain their Statement, and fails one that does not", () => {
    const root = seeded({ [FILE]: record("0001"), [SECOND]: record("0002", { explanation: "" }) });
    const good = run(root, "explained", "REQ-0001");
    assert.equal(good.status, 0, good.stderr);
    assert.equal(good.stdout, "REQ-0001: the Explanation is present\n");
    const bad = run(root, "explained", "REQ-0001", "REQ-0002");
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /REQ-0002: the section "## Explanation" is empty, and the Statement has text\./);
  });

  it("with --base, checks only the records that changed since the base, including new ones", () => {
    const root = tracked({ "docs/guide.md": GUIDE, [`${DIR}/${FILE}`]: record("0001", { explanation: "" }), [`${DIR}/${SECOND}`]: record("0002") });
    git(root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "base");
    assert.equal(run(root, "explained", "--base", "HEAD").stdout, "No record changed since HEAD\n");
    put(root, `${DIR}/${SECOND}`, record("0002", { explanation: "The report  names each source." }));
    put(root, `${DIR}/0003-a-new-record.md`, record("0003", { explanation: "" }).replace(`## Explanation\n\n\n\n`, ""));
    const out = run(root, "explained", "--base", "HEAD");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /REQ-0002: the Explanation repeats the Statement\./);
    assert.match(out.stderr, /REQ-0003: missing the section "## Explanation"/);
    assert.doesNotMatch(out.stderr, /REQ-0001/);
  });

  it("refuses a call with no record and no base", () => {
    const out = run(seeded(), "explained");
    assert.equal(out.status, 2);
    assert.match(out.stderr, /explained needs record IDs, or --base <ref> for the records that changed since that ref/);
  });
});

describe("cites", () => {
  const body = (root, text) => {
    const file = path.join(root, ".body.md");
    writeFileSync(file, text);
    return file;
  };
  const RECORDS = { [FILE]: record("0001"), "0002-a-retired-rule.md": record("0002", { status: "Retired" }) };

  it("passes any body in a project that has no records", () => {
    const root = project();
    const out = run(root, "cites", body(root, "No link here."), "--kind", "issue");
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, "");
  });

  it("passes an issue whose body cites an Open record", () => {
    const root = seeded({ ...RECORDS, "0003-an-open-rule.md": record("0003", { status: "Open" }) });
    const out = run(root, "cites", body(root, "Asks about REQ-0003."), "--kind", "issue");
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, "The issue cites REQ-0003\n");
  });

  it("passes an issue whose body cites a record in force", () => {
    const root = seeded(RECORDS);
    const out = run(root, "cites", body(root, "Implements REQ-0001."), "--kind", "issue");
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, "The issue cites REQ-0001\n");
  });

  it("fails a body that cites no record, and names how to find or create one", () => {
    const root = seeded(RECORDS);
    const out = run(root, "cites", body(root, "A new feature."), "--kind", "issue");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /The body of this issue cites no requirement record in force \(Proposed, Open or Accepted\) in docs\/formal\/requirements\. Each issue and pull request traces to a requirement\. Find the record with: ndev requirements search <words>\. If none fits, create a Proposed record with: ndev requirements new "<title>" --author "<who asked for it>"\. Then cite its ID, such as REQ-0001, in the body\./);
  });

  it("fails a body that cites only a record that does not exist or is not in force", () => {
    const root = seeded(RECORDS);
    const out = run(root, "cites", body(root, "See REQ-0002 and REQ-0042."), "--kind", "issue");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /REQ-0002 is Retired/);
    assert.match(out.stderr, /REQ-0042 is not a record/);
  });

  it("passes a pull request that closes an issue whose body cites a record in force, and fails one whose issue cites none", () => {
    const root = seeded(RECORDS);
    const gh = fakeGh({ "o/r issue-read 5": issueAnswer(5, "open", null, "Traces REQ-0001."), "o/r issue-read 6": issueAnswer(6, "open", null, "No record.") });
    const env = { ...process.env, NDEV_REQUIREMENTS_GH: gh.script, GH_REPO: "o/r" };
    const cites = (text) => spawnSync(NDEV, ["requirements", "cites", body(root, text), "--kind", "pr", "--root", root], { encoding: "utf8", env });
    const good = cites("Plan incoming.\n\nCloses #5\n");
    assert.equal(good.status, 0, good.stderr);
    assert.equal(good.stdout, "The pull request closes #5, which cites REQ-0001\n");
    const bad = cites("Plan incoming.\n\nCloses #6\n");
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /The body of this pull request cites no requirement record in force/);
    assert.match(bad.stderr, /#6 cites no record in force either/);
  });
});

const FLAG = "The Statement says /admin/, but the route is /app/.";
const flagged = (text, reason = FLAG) => text.replace("\n---\n\n## Statement", `\nflagged: ${JSON.stringify(reason)}\n---\n\n## Statement`);

describe("flag", () => {
  it("sets a flag that check passes, and replaces it", () => {
    const root = seeded();
    const out = run(root, "flag", "REQ-0001", FLAG);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /0001-the-report-names-each-source\.md: flagged: The Statement says/);
    const full = path.join(root, DIR, FILE);
    assert.match(readFileSync(full, "utf8"), /\nprs: \[\]\nflagged: "The Statement says \/admin\/, but the route is \/app\/\."\n---\n/);
    assert.equal(run(root, "check").status, 0, run(root, "check").stderr);
    assert.equal(run(root, "flag", "REQ-0001", "The route is wrong.").status, 0);
    const text = readFileSync(full, "utf8");
    assert.equal(text.match(/^flagged:/gm).length, 1);
    assert.match(text, /^flagged: The route is wrong\.$/m);
    assert.doesNotMatch(text, /## Log\n\n.*\n- /);
  });

  it("clears a flag with --clear", () => {
    const root = seeded({ [FILE]: flagged(record("0001")) });
    const out = run(root, "flag", "REQ-0001", "--clear");
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /0001-the-report-names-each-source\.md: flag cleared/);
    assert.doesNotMatch(readFileSync(path.join(root, DIR, FILE), "utf8"), /flagged/);
    assert.equal(run(root, "check").status, 0);
  });

  it("refuses a flag with no text or with text and --clear, and a record that does not exist", () => {
    const root = seeded();
    for (const args of [["REQ-0001"], ["REQ-0001", "  "], ["REQ-0001", "Two\nlines"], ["REQ-0001", FLAG, "--clear"], ["REQ-0001", "The", "route", "is", "wrong"]]) {
      const out = run(root, "flag", ...args);
      assert.equal(out.status, 2, args.join(" "));
      assert.match(out.stderr, /flag needs <REQ-NNNN> "<why the record looks wrong>" on one line, in quotes, or <REQ-NNNN> --clear/);
    }
    const missing = run(root, "flag", "REQ-0042", FLAG);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /REQ-0042/);
  });

  it("reads back flag text with special characters, and escapes it in the rendered page", () => {
    const root = seeded();
    const reason = `#1 says: "<b>x</b>" & - [] it's wrong:`;
    assert.equal(run(root, "flag", "REQ-0001", reason).status, 0);
    assert.equal(run(root, "check").status, 0);
    assert.equal(run(root, "list", "--flagged").stdout.split("\n")[1], `  Flagged: ${reason}`);
    assert.equal(run(root, "render").status, 0);
    assert.match(readFileSync(path.join(root, HTML), "utf8"), /<p class="flagged">Flagged: #1 says: &quot;&lt;b&gt;x&lt;\/b&gt;&quot; &amp; - \[\] it's wrong:<\/p>/);
  });

  it("clears a flag written as a list, with CRLF line ends, and says when there is no flag", () => {
    const root = seeded({ [FILE]: record("0001").replace("\n---\n\n## Statement", "\nflagged:\n  - a\n  - b\n---\n\n## Statement").replace(/\n/g, "\r\n") });
    assert.equal(run(root, "check").status, 1);
    assert.match(run(root, "flag", "REQ-0001", "--clear").stdout, /flag cleared/);
    const text = readFileSync(path.join(root, DIR, FILE), "utf8");
    assert.equal(text, record("0001").replace(/\n/g, "\r\n"));
    assert.match(run(root, "flag", "REQ-0001", "--clear").stdout, /no flag to clear/);
  });

  it("fails check on an empty flag", () => {
    const root = seeded({ [FILE]: flagged(record("0001"), "") });
    const out = run(root, "check");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /0001-the-report-names-each-source\.md: "flagged" has no text\. Give the reason the record looks wrong, or remove it with: ndev requirements flag REQ-0001 --clear/);
  });

  it("lists only the flagged records, each with its reason", () => {
    const root = seeded({
      "0001-a.md": record("0001"),
      "0002-b.md": flagged(record("0002", { title: "The report has a date", status: "Proposed" })),
    });
    const out = run(root, "list", "--flagged");
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /^REQ-0002 {2}Proposed {2}The report has a date {2}\S+\n {2}Flagged: The Statement says \/admin\/, but the route is \/app\/\.\n$/);
    assert.match(run(seeded(), "list", "--flagged").stdout, /^No record matches the filter/);
  });

  it("passes a change to the flag with no Log entry and no agreement in guard", () => {
    const root = committed();
    edit(root, (text) => flagged(text));
    const out = run(root, "guard", "--base", "base");
    assert.equal(out.status, 0, out.stderr);
  });

  it("shows the flag in the rendered page and counts the flagged records", () => {
    const root = seeded({
      "0001-a.md": record("0001"),
      "0002-b.md": flagged(record("0002", { title: "The report has a date" })),
    });
    assert.equal(run(root, "render").status, 0);
    const html = readFileSync(path.join(root, HTML), "utf8");
    assert.match(html, /<p class="meta">[^\n]*<\/p>\n<p class="flagged">Flagged: The Statement says \/admin\/, but the route is \/app\/\.<\/p>/);
    assert.match(html, /\.flagged\{[^}]+\}/);
    assert.match(html, /2 records: 2 Accepted\. 1 flagged\./);
    assert.equal(html.match(/class="flagged"/g).length, 1);
  });

  it("shows the flag in the published page, the index count and the JSON", () => {
    const root = seeded({ [FILE]: flagged(record("0001")) });
    configured(root);
    assert.equal(run(root, "publish").status, 0);
    assert.match(page(root, "report.md"), /\[record\]\([^)]+\)\n\n> \*\*Flagged:\*\* The Statement says \/admin\/, but the route is \/app\/\.\n\nThe report names each source\./);
    assert.match(page(root, "index.md"), /1 record: 1 Accepted\. 1 flagged\./);
    const json = JSON.parse(page(root, "requirements.json"));
    assert.equal(json.records[0].flagged, FLAG);
  });

  it("publishes an empty flag in the JSON of a record with no flag", () => {
    const root = seeded();
    configured(root);
    assert.equal(run(root, "publish").status, 0);
    assert.equal(JSON.parse(page(root, "requirements.json")).records[0].flagged, "");
    assert.doesNotMatch(page(root, "index.md"), /flagged/);
  });
});

describe("level", () => {
  const levelled = (level) => seeded({ [FILE]: record("0001", { level }) });

  it("writes level normal in a new record, and the level that --level gives", () => {
    const root = project();
    assert.equal(run(root, "new", "The report names each source", "--author", "Neil Ellis", "--type", "product").status, 0);
    assert.match(readFileSync(path.join(root, DIR, "0001-the-report-names-each-source.md"), "utf8"), /^origin: explicit\nlevel: normal\ntype: product\nsection: /m);
    const out = run(root, "new", "The report has a date", "--author", "Neil Ellis", "--type", "product", "--level", "soft");
    assert.equal(out.status, 0, out.stderr);
    assert.match(readFileSync(path.join(root, DIR, "0002-the-report-has-a-date.md"), "utf8"), /^level: soft$/m);
    const bad = run(root, "new", "A title", "--author", "Neil Ellis", "--type", "product", "--level", "urgent");
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /Unknown level "urgent": use soft, normal or hard/);
    assert.equal(readdirSync(path.join(root, DIR)).length, 2);
  });

  it("fails check on a record with no level, and on a level that is not in the list", () => {
    const missing = run(levelled(null), "check");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /0001-the-report-names-each-source\.md: no "level"\. Set it with: ndev requirements level REQ-0001 soft\|normal\|hard/);
    const wrong = run(levelled("urgent"), "check");
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /level "urgent" is not soft, normal or hard\. Set it with: ndev requirements level REQ-0001 soft\|normal\|hard/);
    for (const level of ["soft", "normal", "hard"]) assert.equal(run(levelled(level), "check").status, 0, level);
  });

  it("sets the level with the level command, logs the change, and passes check", () => {
    const root = seeded();
    const out = run(root, "level", "REQ-0001", "hard");
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /0001-the-report-names-each-source\.md: level: hard \(was normal\)/);
    const text = readFileSync(path.join(root, DIR, FILE), "utf8");
    assert.match(text, /^origin: explicit\nlevel: hard\ntype: product\nsection: /m);
    assert.equal(text.match(/^level:/gm).length, 1);
    assert.match(text, new RegExp(`## Log\\n\\n- 2026-01-02: Created\\.\\n- ${new Date().toISOString().slice(0, 10)}: Level changed from normal to hard\\.\\n$`));
    assert.equal(run(root, "check").status, 0, run(root, "check").stderr);
    const same = run(root, "level", "REQ-0001", "hard");
    assert.equal(same.status, 0);
    assert.match(same.stdout, /level is already hard/);
    assert.equal(readFileSync(path.join(root, DIR, FILE), "utf8"), text);
  });

  it("sets a level on a record that has none", () => {
    const root = levelled(null);
    assert.equal(run(root, "level", "REQ-0001", "soft").status, 0);
    const text = readFileSync(path.join(root, DIR, FILE), "utf8");
    assert.match(text, /^origin: explicit\nlevel: soft\ntype: product\nsection: /m);
    assert.match(text, /: Level set to soft\.\n$/);
    assert.equal(run(root, "check").status, 0);
  });

  it("refuses a level command with a wrong level or a wrong record", () => {
    const root = seeded();
    for (const args of [["REQ-0001"], ["REQ-0001", "urgent"], ["REQ-0001", "hard", "soft"], ["0001", "hard"]]) {
      const out = run(root, "level", ...args);
      assert.equal(out.status, 2, args.join(" "));
      assert.match(out.stderr, /level needs <REQ-NNNN> soft\|normal\|hard/);
    }
    const missing = run(root, "level", "REQ-0042", "hard");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /REQ-0042/);
  });

  it("levels passes the named records with a level, and fails one with none or a wrong one", () => {
    const root = seeded({ [FILE]: record("0001"), "0002-a.md": record("0002", { level: null }), "0003-b.md": record("0003", { level: "urgent" }) });
    const good = run(root, "levels", "REQ-0001");
    assert.equal(good.status, 0, good.stderr);
    assert.equal(good.stdout, "REQ-0001: level normal\n");
    const bad = run(root, "levels", "REQ-0001", "REQ-0002", "REQ-0003");
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /REQ-0002: no "level"\. Set it with: ndev requirements level REQ-0002 soft\|normal\|hard/);
    assert.match(bad.stderr, /REQ-0003: level "urgent" is not soft, normal or hard\. Set it with: ndev requirements level REQ-0003 soft\|normal\|hard/);
    assert.doesNotMatch(bad.stderr, /REQ-0001/);
  });

  it("levels with --base checks only the records that changed since the base, including new ones", () => {
    const root = tracked({ "docs/guide.md": GUIDE, [`${DIR}/${FILE}`]: record("0001", { level: null }), [`${DIR}/0002-a.md`]: record("0002") });
    git(root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "base");
    assert.equal(run(root, "levels", "--base", "HEAD").stdout, "No record changed since HEAD\n");
    put(root, `${DIR}/0002-a.md`, record("0002", { level: "urgent" }));
    put(root, `${DIR}/0003-b.md`, record("0003", { level: null }));
    const out = run(root, "levels", "--base", "HEAD");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /REQ-0002: level "urgent" is not soft, normal or hard/);
    assert.match(out.stderr, /REQ-0003: no "level"/);
    assert.doesNotMatch(out.stderr, /REQ-0001/);
    assert.equal(run(seeded(), "levels").status, 2);
  });

  it("lists the records of one level", () => {
    const root = seeded({ "0001-a.md": record("0001", { level: "hard" }), "0002-b.md": record("0002", { title: "The report has a date" }) });
    const out = run(root, "list", "--level", "hard");
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /^REQ-0001 {2}Accepted {2}The report names each source {2}\S+\n$/);
    assert.equal(run(root, "list", "--level", "urgent").status, 2);
  });

  it("shows the level in the rendered page, the published page and the JSON", () => {
    const root = seeded({ [FILE]: record("0001", { level: "hard" }) });
    assert.equal(run(root, "render").status, 0);
    assert.match(readFileSync(path.join(root, HTML), "utf8"), /<p class="meta">Accepted · Level: hard · Type: product · explicit · /);
    configured(root);
    assert.equal(run(root, "publish").status, 0);
    assert.match(page(root, "report.md"), /Accepted · Level: hard · Type: product · explicit · /);
    assert.equal(JSON.parse(page(root, "requirements.json")).records[0].level, "hard");
  });
});

describe("type", () => {
  const TYPES = "principle, product, ux, design, operational, implementation, architectural or process";
  const typed = (type) => seeded({ [FILE]: record("0001", { type }) });

  it("writes the type that --type gives in a new record, and refuses a new record with none or an unknown one", () => {
    const root = project();
    const out = run(root, "new", "The report names each source", "--author", "Neil Ellis", "--type", "ux");
    assert.equal(out.status, 0, out.stderr);
    assert.match(readFileSync(path.join(root, DIR, "0001-the-report-names-each-source.md"), "utf8"), /^origin: explicit\nlevel: normal\ntype: ux\nsection: /m);
    const none = run(root, "new", "The report has a date", "--author", "Neil Ellis");
    assert.equal(none.status, 2);
    assert.match(none.stderr, new RegExp(`new needs --type <type>: one of ${TYPES}`));
    const bad = run(root, "new", "The report has a date", "--author", "Neil Ellis", "--type", "feature");
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, new RegExp(`Unknown type "feature": use ${TYPES}`));
    assert.equal(readdirSync(path.join(root, DIR)).length, 1);
  });

  it("fails check on a record with no type, and on a type that is not in the list", () => {
    const missing = run(typed(null), "check");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /0001-the-report-names-each-source\.md: no "type"\. Set it with: ndev requirements type REQ-0001 <type>, where <type> is one of principle, product/);
    const wrong = run(typed("feature"), "check");
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, new RegExp(`type "feature" is not ${TYPES}\\. Set it with: ndev requirements type REQ-0001 <type>`));
    for (const type of ["principle", "product", "ux", "design", "operational", "implementation", "architectural", "process"]) assert.equal(run(typed(type), "check").status, 0, type);
  });

  it("sets the type with the type command, logs the change, and passes check", () => {
    const root = seeded();
    const out = run(root, "type", "REQ-0001", "architectural");
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /0001-the-report-names-each-source\.md: type: architectural \(was product\)/);
    const text = readFileSync(path.join(root, DIR, FILE), "utf8");
    assert.match(text, /^level: normal\ntype: architectural\nsection: /m);
    assert.equal(text.match(/^type:/gm).length, 1);
    assert.match(text, new RegExp(`## Log\\n\\n- 2026-01-02: Created\\.\\n- ${new Date().toISOString().slice(0, 10)}: Type changed from product to architectural\\.\\n$`));
    assert.equal(run(root, "check").status, 0, run(root, "check").stderr);
    const same = run(root, "type", "REQ-0001", "architectural");
    assert.equal(same.status, 0);
    assert.match(same.stdout, /type is already architectural/);
    assert.equal(readFileSync(path.join(root, DIR, FILE), "utf8"), text);
  });

  it("sets a type on a record that has none, after the level", () => {
    const root = typed(null);
    assert.equal(run(root, "type", "REQ-0001", "principle").status, 0);
    const text = readFileSync(path.join(root, DIR, FILE), "utf8");
    assert.match(text, /^level: normal\ntype: principle\nsection: /m);
    assert.match(text, /: Type set to principle\.\n$/);
    assert.equal(run(root, "check").status, 0);
  });

  it("refuses a type command with a wrong type or a wrong record", () => {
    const root = seeded();
    for (const args of [["REQ-0001"], ["REQ-0001", "feature"], ["REQ-0001", "ux", "design"], ["0001", "ux"]]) {
      const out = run(root, "type", ...args);
      assert.equal(out.status, 2, args.join(" "));
      assert.match(out.stderr, new RegExp(`type needs <REQ-NNNN> <type>, where <type> is one of ${TYPES}`));
    }
    const missing = run(root, "type", "REQ-0042", "ux");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /REQ-0042/);
  });

  it("types passes the named records with a type, and fails one with none or a wrong one", () => {
    const root = seeded({ [FILE]: record("0001"), "0002-a.md": record("0002", { type: null }), "0003-b.md": record("0003", { type: "feature" }) });
    const good = run(root, "types", "REQ-0001");
    assert.equal(good.status, 0, good.stderr);
    assert.equal(good.stdout, "REQ-0001: type product\n");
    const bad = run(root, "types", "REQ-0001", "REQ-0002", "REQ-0003");
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /REQ-0002: no "type"\. Set it with: ndev requirements type REQ-0002 <type>/);
    assert.match(bad.stderr, /REQ-0003: type "feature" is not principle/);
    assert.doesNotMatch(bad.stderr, /REQ-0001/);
  });

  it("types with --base checks only the records that changed since the base, including new ones", () => {
    const root = tracked({ "docs/guide.md": GUIDE, [`${DIR}/${FILE}`]: record("0001", { type: null }), [`${DIR}/0002-a.md`]: record("0002") });
    git(root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "base");
    assert.equal(run(root, "types", "--base", "HEAD").stdout, "No record changed since HEAD\n");
    put(root, `${DIR}/0002-a.md`, record("0002", { type: "feature" }));
    put(root, `${DIR}/0003-b.md`, record("0003", { type: null }));
    const out = run(root, "types", "--base", "HEAD");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /REQ-0002: type "feature" is not principle/);
    assert.match(out.stderr, /REQ-0003: no "type"/);
    assert.doesNotMatch(out.stderr, /REQ-0001/);
    assert.equal(run(seeded(), "types").status, 2);
  });

  it("lists the records of one type", () => {
    const root = seeded({ "0001-a.md": record("0001", { type: "design" }), "0002-b.md": record("0002", { title: "The report has a date" }) });
    const out = run(root, "list", "--type", "design");
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /^REQ-0001 {2}Accepted {2}The report names each source {2}\S+\n$/);
    assert.equal(run(root, "list", "--type", "feature").status, 2);
  });

  it("shows the type in the rendered page, the published page and the JSON", () => {
    const root = seeded({ [FILE]: record("0001", { type: "operational" }) });
    assert.equal(run(root, "render").status, 0);
    assert.match(readFileSync(path.join(root, HTML), "utf8"), /<p class="meta">Accepted · Level: normal · Type: operational · explicit · /);
    configured(root);
    assert.equal(run(root, "publish").status, 0);
    assert.match(page(root, "report.md"), /Accepted · Level: normal · Type: operational · explicit · /);
    assert.equal(JSON.parse(page(root, "requirements.json")).records[0].type, "operational");
  });
});

describe("for", () => {
  const MODEL = "specs/report.qnt";
  const DECISION = "docs/pdr/0001-keep-sources.md";
  const files = { "docs/guide.md": GUIDE, "src/report.js": "export {}\n", "src/other.js": "export {}\n", [MODEL]: "module report {}\n", [DECISION]: "# Keep sources\n" };
  const project4 = () => tracked({
    ...files,
    [`${DIR}/0001-the-report-names-each-source.md`]: record("0001", { trace: `- File: src/*.js\n- Issue: ${ISSUE(1)}` }),
    [`${DIR}/0002-the-report-is-modelled.md`]: record("0002", { title: "The report is modelled", model: [`${MODEL}#report`], trace: `- PDR: ${DECISION}\n- PR: ${PULL(10)}` }),
    [`${DIR}/0003-an-old-rule.md`]: record("0003", { title: "An old rule", status: "Retired", trace: "- File: src/report.js" }),
  });
  const ANSWERS = {
    "o/r issue-read 1": issueAnswer(1, "open", null, "Plan for REQ-0002."),
    "o/r issue-read 10": { ...issueAnswer(10, "closed", null, "Implements REQ-0003 and REQ-0009."), url: PULL(10) },
    "o/r pr-read 5": { ...pullAnswer(5, "open", false), body: "No citation." },
  };

  it("lists the records in force that relate to a file, by File pattern, Source text citation, model and decision line", () => {
    const root = project4();
    const out = run(root, "for", "src/report.js", "docs/guide.md", MODEL, DECISION);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, [
      "src/report.js",
      "  REQ-0001  Accepted  The report names each source",
      "    - File: src/*.js",
      "docs/guide.md",
      "  REQ-0001  Accepted  The report names each source",
      "    - docs/guide.md#L3-L4",
      "  REQ-0002  Accepted  The report is modelled",
      "    - docs/guide.md#L3-L4",
      `${MODEL}`,
      "  REQ-0002  Accepted  The report is modelled",
      `    model: ${MODEL}#report`,
      `${DECISION}`,
      "  REQ-0002  Accepted  The report is modelled",
      `    - PDR: ${DECISION}`,
      "",
    ].join("\n"));
  });

  it("includes other statuses with --all or --status, and says when no record relates to a target", () => {
    const root = project4();
    const all = run(root, "for", "--all", "src/report.js");
    assert.equal(all.status, 0, all.stderr);
    assert.match(all.stdout, /REQ-0001  Accepted  The report names each source\n    - File: src\/\*\.js\n  REQ-0003  Retired   An old rule\n    - File: src\/report\.js\n/);
    const retired = run(root, "for", "--status", "Retired", "src/report.js");
    assert.equal(retired.stdout, "src/report.js\n  REQ-0003  Retired  An old rule\n    - File: src/report.js\n");
    const none = run(root, "for", "src/other.js", "--status", "Rejected");
    assert.equal(none.status, 0, none.stderr);
    assert.equal(none.stdout, "src/other.js: no Rejected record relates to it (3 records searched)\n");
    const inForce = run(root, "for", MODEL.replace("report", "none"));
    assert.equal(inForce.status, 1);
  });

  it("lists the records that link an issue or a pull request, and the records that its body cites", () => {
    const gh = fakeGh(ANSWERS);
    const root = project4();
    const out = runWith(gh, root, "for", "--repo", "o/r", ISSUE(1), "#10", PULL(5));
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, [
      ISSUE(1),
      "  REQ-0001  Accepted  The report names each source",
      `    - Issue: ${ISSUE(1)}`,
      "  REQ-0002  Accepted  The report is modelled",
      `    cited in the body of ${ISSUE(1)}`,
      "#10",
      "  REQ-0002  Accepted  The report is modelled",
      `    - PR: ${PULL(10)}`,
      `  the body of #10 cites REQ-0009, which is not a record in ${DIR}`,
      `${PULL(5)}: no record in force relates to it (3 records searched)`,
      "",
    ].join("\n"));
  });

  it("gives the result as JSON", () => {
    const root = project4();
    const out = spawnSync(NDEV, ["requirements", "for", "src/report.js", "--root", root, "--json"], { encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
    const result = JSON.parse(out.stdout).result;
    assert.deepEqual(result.targets, [{ target: "src/report.js", records: [{ id: "REQ-0001", status: "Accepted", level: "normal", type: "product", title: "The report names each source", statement: "The report names each source.", path: `${DIR}/0001-the-report-names-each-source.md`, lines: ["- File: src/*.js"] }], notes: [] }]);
    assert.match(result.text, /^src\/report\.js\n  REQ-0001/);
  });

  it("fails a target that is not a tracked file, an issue link or a pull request link, and an issue it cannot read", () => {
    const gh = fakeGh(ANSWERS);
    const root = project4();
    put(root, "src/new.js", "export {}\n");
    const untracked = run(root, "for", "src/new.js", "src/missing.js");
    assert.equal(untracked.status, 1);
    assert.match(untracked.stderr, /"src\/new\.js" is not a tracked file, an issue link or a pull request link\. Give a path from the project root \(git add a new file first\), a GitHub issue or pull request link, or #N with --repo <owner>\/<repo>\./);
    assert.match(untracked.stderr, /"src\/missing\.js" is not a tracked file/);
    const noRepo = run(root, "for", "#10");
    assert.equal(noRepo.status, 2);
    assert.match(noRepo.stderr, /"#10" needs --repo <owner>\/<repo>/);
    const unread = runWith(gh, root, "for", ISSUE(9));
    assert.equal(unread.status, 1);
    assert.match(unread.stderr, /https:\/\/github\.com\/o\/r\/issues\/9 could not be read: gh\.sh issue-read 9 in o\/r exited 1/);
    assert.equal(run(root, "for").status, 2);
  });

  it("refuses an unknown status, and --status with --all", () => {
    const root = project4();
    const typo = run(root, "for", "--status", "Acepted", "src/report.js");
    assert.equal(typo.status, 2);
    assert.match(typo.stderr, /Unknown status "Acepted": use Accepted, Proposed, Open, Rejected, Retired or Superseded/);
    assert.equal(run(root, "for", "--status", "", "src/report.js").status, 2);
    const both = run(root, "for", "--all", "--status", "Retired", "src/report.js");
    assert.equal(both.status, 2);
    assert.match(both.stderr, /--all and --status cannot go together/);
  });

  it("gives a matching line once, when a record cites the same file twice", () => {
    const twice = `${GUIDE_SOURCE}\n- docs/guide.md#L3-L3\n\n> The report names each source.`;
    const root = tracked({ ...files, [`${DIR}/0001-the-report-names-each-source.md`]: record("0001", { sourceText: `${twice}\n- docs/guide.md#L3-L4\n\n> The report names each source.\n> The report refuses an unread source.` }) });
    const out = run(root, "for", "docs/guide.md");
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, "docs/guide.md\n  REQ-0001  Accepted  The report names each source\n    - File: docs/guide.md\n    - docs/guide.md#L3-L4\n    - docs/guide.md#L3-L3\n");
  });
});

describe("deprecated records", () => {
  const DEPRECATED = "docs/formal/deprecated";
  const OLD = "0001-the-report-names-each-source.md";
  const NEW = "0002-the-report-lists-each-source.md";
  const today = new Date().toISOString().slice(0, 10);
  const pair = () => committed({ [OLD]: record("0001"), [NEW]: record("0002", { title: "The report lists each source" }) });
  const text = (root, rel) => readFileSync(path.join(root, rel), "utf8");

  it("reads the deprecated folder: the numbers stay unique across both folders, and new takes the next number", () => {
    const root = seeded({ [OLD]: record("0001"), [`../deprecated/0003-an-old-rule.md`]: record("0003", { status: "Retired" }) });
    assert.equal(run(root, "check").status, 0, run(root, "check").stderr);
    assert.match(run(root, "check").stdout, /2 records checked/);
    assert.equal(run(root, "new", "A new rule", "--author", "Neil Ellis", "--type", "product").status, 0);
    assert.ok(existsSync(path.join(root, DIR, "0004-a-new-rule.md")));
    put(root, `${DEPRECATED}/0001-a-copy.md`, record("0001", { status: "Retired" }));
    const out = run(root, "check");
    assert.equal(out.status, 1);
    assert.match(out.stderr, new RegExp(`duplicate number 0001: ${DIR}/${OLD}, ${DEPRECATED}/0001-a-copy\\.md`));
  });

  it("fails a Retired or Superseded record outside the deprecated folder, and a record in the folder that is neither", () => {
    for (const status of ["Retired", "Superseded by 0002"]) {
      const out = run(seeded({ [OLD]: record("0001", { status }), [NEW]: record("0002") }), "check");
      assert.equal(out.status, 1, status);
      assert.match(out.stderr, new RegExp(`${DIR}/${OLD}: the status is ${status}, and the record is not in ${DEPRECATED}\\. Run: ndev requirements deprecate REQ-0001`));
    }
    const out = run(seeded({ [`../deprecated/${OLD}`]: record("0001", { status: "Accepted" }) }), "check");
    assert.equal(out.status, 1);
    assert.match(out.stderr, new RegExp(`${DEPRECATED}/${OLD}: the status is Accepted, and only a Retired or Superseded record is in ${DEPRECATED}\\.`));
  });

  it("fails a supersedes or superseded_by link that names no record, or that does not match the status", () => {
    const linked = (field, value, status = "Retired") => record("0001", { status }).replace("decided_by:", `${field}: ${value}\ndecided_by:`);
    const missing = run(seeded({ [`../deprecated/${OLD}`]: linked("superseded_by", `${DIR}/0009-gone.md`, "Superseded by 0002"), [NEW]: record("0002") }), "check");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, new RegExp(`"superseded_by: ${DIR}/0009-gone\\.md" names no record\\.`));
    const other = run(seeded({ [`../deprecated/${OLD}`]: linked("superseded_by", `${DIR}/${NEW}`), [NEW]: record("0002") }), "check");
    assert.equal(other.status, 1);
    assert.match(other.stderr, /"superseded_by" names REQ-0002, and the status is Retired\. The status of a replaced record is "Superseded by 0002"\./);
    const back = run(seeded({ [OLD]: record("0001"), [NEW]: record("0002").replace("decided_by:", `supersedes:\n  - ${DIR}/${OLD}\ndecided_by:`) }), "check");
    assert.equal(back.status, 1);
    assert.match(back.stderr, new RegExp(`"supersedes" names REQ-0001, whose status is Accepted\\. The status of a replaced record is "Superseded by 0002"\\.`));
  });

  it("deprecate moves the record, sets the status, the decision and the links, and logs the reason", () => {
    const root = pair();
    const out = run(root, "deprecate", "REQ-0001", "--reason", "The new record replaces it.", "--decided-by", "Ann Smith", "--by", "REQ-0002");
    assert.equal(out.status, 0, out.stderr);
    assert.equal(existsSync(path.join(root, DIR, OLD)), false);
    const old = text(root, `${DEPRECATED}/${OLD}`);
    assert.match(old, /^status: Superseded by 0002$/m);
    assert.match(old, /^decided_by: Ann Smith$/m);
    assert.match(old, new RegExp(`^superseded_by: ${DIR}/${NEW}$`, "m"));
    assert.match(old, new RegExp(`- ${today}: Deprecated, superseded by REQ-0002: The new record replaces it\\.\n$`));
    assert.match(text(root, `${DIR}/${NEW}`), new RegExp(`^supersedes:\n  - ${DEPRECATED}/${OLD}$`, "m"));
    assert.match(git(root, "status", "--porcelain"), new RegExp(`R  ${DIR}/${OLD} -> ${DEPRECATED}/${OLD}`));
    assert.match(out.stdout, new RegExp(`${DIR}/${OLD} -> ${DEPRECATED}/${OLD}: Superseded by 0002`));
    assert.equal(run(root, "check").status, 0, run(root, "check").stderr);
    assert.equal(run(root, "guard", "--base", "base").status, 0, run(root, "guard", "--base", "base").stderr);
  });

  it("deprecate with no replacement sets the status Retired", () => {
    const root = pair();
    const out = run(root, "deprecate", "REQ-0001", "--reason", "The report was removed.", "--decided-by", "Ann Smith");
    assert.equal(out.status, 0, out.stderr);
    const old = text(root, `${DEPRECATED}/${OLD}`);
    assert.match(old, /^status: Retired$/m);
    assert.doesNotMatch(old, /superseded_by/);
    assert.match(old, new RegExp(`- ${today}: Deprecated: The report was removed\\.\n$`));
    assert.equal(run(root, "check").status, 0);
  });

  it("deprecate keeps the links when the replacement is deprecated later", () => {
    const root = committed({ [OLD]: record("0001"), [NEW]: record("0002", { title: "The report lists each source" }), "0003-the-report-shows-each-source.md": record("0003", { title: "The report shows each source" }) });
    assert.equal(run(root, "deprecate", "REQ-0001", "--reason", "Replaced.", "--decided-by", "Ann Smith", "--by", "REQ-0002").status, 0);
    const out = run(root, "deprecate", "REQ-0002", "--reason", "Replaced.", "--decided-by", "Ann Smith", "--by", "REQ-0003");
    assert.equal(out.status, 0, out.stderr);
    assert.match(text(root, `${DEPRECATED}/${OLD}`), new RegExp(`^superseded_by: ${DEPRECATED}/${NEW}$`, "m"));
    assert.equal(run(root, "check").status, 0, run(root, "check").stderr);
  });

  it("deprecate refuses a call with no reason or no human decision, an unknown or deprecated record, and an unknown, older or deprecated replacement", () => {
    const root = pair();
    assert.match(run(root, "deprecate", "REQ-0001", "--decided-by", "Ann Smith").stderr, /deprecate needs --reason "<why>"/);
    assert.equal(run(root, "deprecate", "REQ-0001", "--reason", "Old.").status, 2);
    assert.match(run(root, "deprecate", "REQ-0001", "--reason", "Old.").stderr, /--decided-by "<name>": the human who decided/);
    const unknown = run(root, "deprecate", "REQ-0009", "--reason", "Old.", "--decided-by", "Ann Smith");
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /REQ-0009 is not a record in docs\/formal\/requirements/);
    const older = run(root, "deprecate", "REQ-0002", "--reason", "Old.", "--decided-by", "Ann Smith", "--by", "REQ-0001");
    assert.equal(older.status, 1);
    assert.match(older.stderr, /REQ-0001 is older than REQ-0002\. A replacement is a newer record: create it with: ndev requirements new/);
    assert.match(run(root, "deprecate", "REQ-0001", "--reason", "Old.", "--decided-by", "Ann Smith", "--by", "REQ-0009").stderr, /REQ-0009 is not a record in docs\/formal\/requirements/);
    assert.equal(run(root, "deprecate", "REQ-0001", "--reason", "Old.", "--decided-by", "Ann Smith").status, 0);
    const again = run(root, "deprecate", "REQ-0001", "--reason", "Old.", "--decided-by", "Ann Smith");
    assert.equal(again.status, 1);
    assert.match(again.stderr, new RegExp(`REQ-0001 is already in ${DEPRECATED}`));
    assert.equal(existsSync(path.join(root, DIR, NEW)), true);
    assert.doesNotMatch(text(root, `${DIR}/${NEW}`), /supersedes/);
  });
});

describe("fixed fields", () => {
  const changes = {
    title: (t) => t.replace('title: "The report names each source"', 'title: "The report names every source"'),
    origin: (t) => t.replace("origin: explicit", "origin: implied"),
    author: (t) => t.replace('  - "Neil Ellis"', '  - "Ann Smith"'),
  };

  it("guard and fixed fail a change to the title, the origin or the author, and pass the other fields", () => {
    for (const [name, change] of Object.entries(changes)) {
      const root = committed();
      edit(root, (t) => change(t).replace(/Created\.\n$/, "Created.\n- 2026-02-03: Changed.\n"));
      for (const command of ["guard", "fixed"]) {
        const out = run(root, command, "--base", "base");
        assert.equal(out.status, 1, `${command} ${name}`);
        assert.match(out.stderr, new RegExp(`${DIR}/${FILE}: the ${name} changed since base\\. The id, title, author and origin of a record never change after it is created: restore it\\. To change the requirement, deprecate the record and create a new one: ndev requirements deprecate REQ-0001`), `${command} ${name}`);
      }
    }
    const root = committed();
    edit(root, (t) => t.replace("level: normal", "level: hard").replace(/Created\.\n$/, "Created.\n- 2026-02-03: Changed.\n"));
    assert.equal(run(root, "fixed", "--base", "base").status, 0);
    assert.equal(run(root, "guard", "--base", "base").status, 0);
    put(root, `${DIR}/0002-a-new-record.md`, record("0002"));
    const out = run(root, "fixed", "--base", "base");
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /2 records: no fixed field changed since base/);
  });
});

describe("a number that the base holds twice", () => {
  const FIRST = "0001-the-report-names-each-source.md";
  const SECOND = "0001-the-checks-run-the-affected-tests-first.md";
  const RENUMBERED = "0003-the-checks-run-the-affected-tests-first.md";
  const duplicated = () => committed({
    [FIRST]: record("0001"),
    [SECOND]: record("0001", { title: "The checks run the affected tests first", statement: "The checks run the affected tests first.", author: ["Ann Smith"] }),
    "0002-a-third-record.md": record("0002", { title: "A third record", statement: "A third statement." }),
  });
  const renumber = (root, change = (t) => t) => {
    git(root, "mv", `${DIR}/${SECOND}`, `${DIR}/${RENUMBERED}`);
    const full = path.join(root, DIR, RENUMBERED);
    writeFileSync(full, change(readFileSync(full, "utf8").replace("id: REQ-0001", "id: REQ-0003")));
  };

  it("guard and fixed accept the renumber of one of the two records, and report it as renumbered", () => {
    const root = duplicated();
    renumber(root);
    for (const command of ["guard", "fixed"]) {
      const out = run(root, command, "--base", "base");
      assert.equal(out.status, 0, `${command}: ${out.stderr}`);
    }
    assert.equal(run(root, "check").status, 0, run(root, "check").stderr);
  });

  it("guard still refuses a change to the title, the author or the Statement of the renumbered record", () => {
    const root = duplicated();
    renumber(root, (t) => t.replace('title: "The checks run the affected tests first"', 'title: "The checks run the changed tests first"').replace('  - "Ann Smith"', '  - "Bob Jones"').replace("The checks run the affected tests first.\n\n## Explanation", "The checks run the changed tests first.\n\n## Explanation"));
    const out = run(root, "guard", "--base", "base");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /the title changed since base/);
    assert.match(out.stderr, /the author changed since base/);
    assert.match(out.stderr, /Statement changed since base/);
    assert.equal(run(root, "fixed", "--base", "base").status, 1);
  });

  it("guard refuses a record deleted from the pair, and names it by its path", () => {
    const root = duplicated();
    git(root, "rm", "-q", `${DIR}/${SECOND}`);
    const out = run(root, "guard", "--base", "base");
    assert.equal(out.status, 1);
    assert.match(out.stderr, new RegExp(`REQ-0001 \\(${DIR}/${SECOND} at base\\) is deleted`));
  });

  it("guard refuses a renumber to a number that the base already used", () => {
    const root = duplicated();
    git(root, "mv", `${DIR}/${SECOND}`, `${DIR}/0002-the-checks-run-the-affected-tests-first.md`);
    const full = path.join(root, DIR, "0002-the-checks-run-the-affected-tests-first.md");
    writeFileSync(full, readFileSync(full, "utf8").replace("id: REQ-0001", "id: REQ-0002"));
    const out = run(root, "guard", "--base", "base");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /duplicate number 0002/);
  });
});

describe("a number that the base took after the branch did", () => {
  const OTHER = "0002-the-other-pull-request.md";
  const MINE = "0002-this-pull-request.md";
  const other = () => record("0002", { title: "The other pull request", statement: "The other pull request statement.", author: ["Ann Smith"] });
  const mine = () => record("0002", { title: "This pull request", statement: "This pull request statement." });
  const raced = () => {
    const root = committed({ [FILE]: record("0001"), [OTHER]: other() });
    git(root, "rm", "-q", `${DIR}/${OTHER}`);
    put(root, `${DIR}/${MINE}`, mine());
    return root;
  };

  it("guard fails the record that takes a number the base holds for another record, and names both files and the repair", () => {
    const root = raced();
    const out = run(root, "guard", "--base", "base");
    assert.equal(out.status, 1);
    assert.match(out.stderr, new RegExp(`${DIR}/${MINE}: REQ-0002 is already held at base by ${DIR}/${OTHER}`));
    assert.match(out.stderr, new RegExp(`Give this record the next free number: git mv ${DIR}/${MINE} ${DIR}/0003-this-pull-request\\.md, set "id: REQ-0003" in it, then run: ndev requirements check`));
  });

  it("guard fails the same record after a rebase, when both files hold the number", () => {
    const root = raced();
    put(root, `${DIR}/${OTHER}`, other());
    const out = run(root, "guard", "--base", "base");
    assert.equal(out.status, 1);
    assert.match(out.stderr, new RegExp(`${DIR}/${MINE}: REQ-0002 is already held at base by ${DIR}/${OTHER}`));
  });

  it("new takes the number after the highest one at the base when it is given --base", () => {
    const root = committed({ [FILE]: record("0001"), [OTHER]: other() });
    git(root, "rm", "-q", `${DIR}/${OTHER}`);
    const without = run(root, "new", "A fresh requirement", "--author", "Ann Smith", "--type", "product");
    assert.match(without.stdout.trim(), /0002-a-fresh-requirement\.md$/);
    rmSync(without.stdout.trim());
    const out = run(root, "new", "A fresh requirement", "--author", "Ann Smith", "--type", "product", "--base", "base");
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout.trim(), /0003-a-fresh-requirement\.md$/);
    assert.equal(run(root, "new", "Another", "--author", "Ann Smith", "--type", "product", "--base", "no-such-ref").status, 1);
  });

  it("guard passes the record when the base holds that number for the same record", () => {
    const root = committed({ [FILE]: record("0001"), [OTHER]: other() });
    assert.equal(run(root, "guard", "--base", "base").status, 0);
  });

  it("guard passes the same record at the next free number", () => {
    const root = raced();
    rmSync(path.join(root, DIR, MINE));
    put(root, `${DIR}/0003-this-pull-request.md`, record("0003", { title: "This pull request", statement: "This pull request statement." }));
    put(root, `${DIR}/${OTHER}`, other());
    const out = run(root, "guard", "--base", "base");
    assert.equal(out.status, 0, out.stderr);
  });
});
