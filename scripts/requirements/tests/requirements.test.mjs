import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dirname, "..", "requirements.mjs");
const DIR = "docs/formal/requirements";
const HTML = `${DIR}/generated/requirements.html`;

const project = () => mkdtempSync(path.join(tmpdir(), "requirements-test-"));
const put = (root, rel, text) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
};
const run = (root, ...args) => {
  const out = spawnSync(process.execPath, [CLI, "--root", root, ...args], { encoding: "utf8" });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
};
const GUIDE = "# Guide\n\nThe report names each source.\nThe report refuses an unread source.\n\nEnd.\n";
const GUIDE_SOURCE = "- docs/guide.md#L3-L4\n\n> The report names each source.\n> The report refuses an unread source.";
const record = (number, { title = "The report names each source", id = `REQ-${number}`, status = "Accepted", origin = "explicit", section = "Report", date = "2026-01-02", decidedBy = "Neil Ellis", verification = "unassigned", statement = "The report names each source.", sourceText = GUIDE_SOURCE, trace = "", notes = "" } = {}) =>
  `# ${title}\n\n- ID: ${id}\n- Status: ${status}\n- Origin: ${origin}\n- Section: ${section}\n- Date: ${date}\n- Decided by: ${decidedBy}\n- Verification: ${verification}\n\n## Statement\n\n${statement}\n\n## Source text\n\n${sourceText}\n\n## Trace\n\n${trace}\n\n## Notes\n\n${notes}\n`;
const seeded = (records = { "0001-the-report-names-each-source.md": record("0001") }) => {
  const root = project();
  put(root, "docs/guide.md", GUIDE);
  for (const [file, text] of Object.entries(records)) put(root, `${DIR}/${file}`, text);
  return root;
};

describe("new", () => {
  it("creates the first record as REQ-0001, Proposed and explicit, with the template sections", () => {
    const root = project();
    const out = run(root, "new", "The report names each source");
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(readdirSync(path.join(root, DIR)), ["0001-the-report-names-each-source.md"]);
    const text = readFileSync(path.join(root, DIR, "0001-the-report-names-each-source.md"), "utf8");
    assert.match(text, /^# The report names each source\n/);
    for (const line of ["- ID: REQ-0001", "- Status: Proposed", "- Origin: explicit", "- Section:", "- Decided by:", "- Verification: unassigned"]) assert.ok(text.split("\n").includes(line), `missing line "${line}" in:\n${text}`);
    assert.match(text, /^- Date: \d{4}-\d{2}-\d{2}$/m);
    for (const section of ["Statement", "Source text", "Trace", "Notes"]) assert.match(text, new RegExp(`^## ${section}$`, "m"));
    assert.ok(out.stdout.includes(path.join(root, DIR, "0001-the-report-names-each-source.md")));
  });

  it("takes the number after the highest one, with the origin and the section it is given", () => {
    const root = seeded({ "0007-the-report-names-each-source.md": record("0007") });
    const out = run(root, "new", "A retry keeps the first result", "--origin", "implied", "--section", "Pipeline");
    assert.equal(out.status, 0, out.stderr);
    const text = readFileSync(path.join(root, DIR, "0008-a-retry-keeps-the-first-result.md"), "utf8");
    assert.match(text, /^- ID: REQ-0008$/m);
    assert.match(text, /^- Origin: implied$/m);
    assert.match(text, /^- Section: Pipeline$/m);
  });

  it("creates a record whose origin is a pull request", () => {
    const root = project();
    const out = run(root, "new", "The export keeps the column order", "--origin", "PR");
    assert.equal(out.status, 0, out.stderr);
    assert.match(readFileSync(path.join(root, DIR, "0001-the-export-keeps-the-column-order.md"), "utf8"), /^- Origin: PR$/m);
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
    const root = seeded({ "0001-a.md": record("0001", { status: "Retired" }) });
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
    const out = run(seeded({ "0001-a.md": record("0001", { verification: "test, model" }) }), "check");
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
    for (const name of ["## Statement", "## Source text", "- Section:", "- Decided by:"]) assert.ok(accepted.stderr.includes(name), `no "${name}" in:\n${accepted.stderr}`);
    const proposed = run(seeded({ "0001-a.md": record("0001", { ...empty, status: "Proposed" }) }), "check");
    assert.equal(proposed.status, 0, proposed.stderr);
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
    const valid = run(seeded({ "0001-a.md": record("0001", { status: "Superseded by 0002" }), "0002-b.md": record("0002") }), "check");
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
    const root = seeded({ "0001-a.md": record("0001", { statement: "The report **names** each [source](extra/glossary.md#source).\n\n> A quoted rule.\n\n- one\n- two", sourceText: `${GUIDE_SOURCE}\n\n- https://example.com/issues/4\n\n> The owner asked for <each> source.` }) });
    const out = run(root, "render");
    assert.equal(out.status, 0, out.stderr);
    assert.ok(out.stdout.includes(path.join(root, HTML)));
    const html = readFileSync(path.join(root, HTML), "utf8");
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<article id="REQ-0001"/);
    assert.match(html, /<strong>names<\/strong>/);
    assert.match(html, /<a href="\.\.\/extra\/glossary\.md#source">source<\/a>/);
    assert.match(html, /<blockquote>\s*<p>A quoted rule\.<\/p>\s*<\/blockquote>/);
    assert.match(html, /<li>one<\/li>\s*<li>two<\/li>/);
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
    assert.match(absent.stderr, /requirements\.mjs render/);
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
  const out = spawnSync("python3", ["-c", "import pty, sys; sys.exit(pty.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])) if hasattr(pty, 'waitstatus_to_exitcode') else __import__('os').waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))", process.execPath, CLI, "--root", root, ...args], { encoding: "utf8", input: "" });
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

  it("passes changes to the status, the trace and the notes", () => {
    const root = committed();
    edit(root, (text) => text.replace("- Status: Accepted", "- Status: Retired").replace("## Trace\n", "## Trace\n\n- scripts/report.mjs\n").replace("## Notes\n", "## Notes\n\nA note.\n"));
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
    edit(root, (text) => text.replace("The report names each source.\n\n## Source", "The report names every source.\n\n## Source"));
    const out = run(root, "guard", "--base", "base");
    assert.equal(out.status, 1);
    assert.match(out.stderr, new RegExp(`${DIR}/${FILE}: the Statement changed since base, and no human agreed`));
    assert.match(out.stderr, /old:\n {4}The report names each source\./);
    assert.match(out.stderr, /new:\n {4}The report names every source\./);
    assert.match(out.stderr, /requirements\.mjs agree REQ-0001 --by "<name>"/);
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
    edit(root, (text) => text.replace("docs/guide.md#L3-L4", "docs/other.md#L3-L4"));
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
    edit(root, (text) => text.replace("The report names each source.\n\n## Source", "The report names every source.\n\n## Source"));
    const agreed = inTerminal(root, "agree", "REQ-0001", "--by", "Neil Ellis");
    assert.equal(agreed.status, 0, agreed.stdout);
    const text = readFileSync(path.join(root, DIR, FILE), "utf8");
    assert.match(text, /^- Agreed: Neil Ellis, \d{4}-\d{2}-\d{2}, text [0-9a-f]{12}$/m);
    assert.equal(run(root, "check").status, 0);
    assert.equal(run(root, "guard", "--base", "base").status, 0);
    edit(root, (t) => t.replace("The report names every source.", "The report names all sources."));
    const out = run(root, "guard", "--base", "base");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /the Agreed line is for other text/);
  });

  it("keeps an agreement valid when only the line numbers move afterwards", () => {
    const root = committed();
    edit(root, (text) => text.replace("The report names each source.\n\n## Source", "The report names every source.\n\n## Source"));
    assert.equal(inTerminal(root, "agree", "REQ-0001", "--by", "Neil Ellis").status, 0);
    edit(root, (text) => text.replace("docs/guide.md#L3-L4", "docs/guide.md#L5-L6"));
    assert.equal(run(root, "guard", "--base", "base").status, 0);
  });

  it("fails a duplicate number instead of comparing only one of the files", () => {
    const root = committed();
    edit(root, (text) => text.replace("The report names each source.\n\n## Source", "The report names every source.\n\n## Source"));
    put(root, `${DIR}/0001-zz-copy.md`, record("0001"));
    const out = run(root, "guard", "--base", "base");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /duplicate number 0001/);
  });

  it("fails a changed line anchor in a link, which is not a moved citation", () => {
    const root = committed({ [FILE]: record("0001", { sourceText: "- https://example.com/doc#L1-L5\n\n> The report names each source." }) });
    edit(root, (text) => text.replace("doc#L1-L5", "doc#L9-L12"));
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

describe("agree", () => {
  it("refuses to run when standard input is not a terminal", () => {
    const root = committed();
    const out = run(root, "agree", "REQ-0001", "--by", "Neil Ellis");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /agree records the agreement of a human/);
    assert.doesNotMatch(readFileSync(path.join(root, DIR, FILE), "utf8"), /Agreed/);
  });

  it("needs a known record and a name", () => {
    const root = committed();
    assert.match(inTerminal(root, "agree", "REQ-0009", "--by", "Neil Ellis").stdout, /REQ-0009 is not a record/);
    assert.match(inTerminal(root, "agree", "REQ-0001").stdout, /agree needs <REQ-NNNN> --by "<name>"/);
  });

  it("replaces an earlier Agreed line", () => {
    const root = committed();
    assert.equal(inTerminal(root, "agree", "REQ-0001", "--by", "Ann").status, 0);
    assert.equal(inTerminal(root, "agree", "REQ-0001", "--by", "Bob").status, 0);
    const text = readFileSync(path.join(root, DIR, FILE), "utf8");
    assert.equal(text.match(/^- Agreed:/gm).length, 1);
    assert.match(text, /^- Agreed: Bob, /m);
  });

  it("writes a name that holds replacement patterns as it is", () => {
    const root = committed();
    assert.equal(inTerminal(root, "agree", "REQ-0001", "--by", "Ann").status, 0);
    assert.equal(inTerminal(root, "agree", "REQ-0001", "--by", "A$'B$&").status, 0);
    assert.match(readFileSync(path.join(root, DIR, FILE), "utf8"), /^- Agreed: A\$'B\$&, \d{4}/m);
  });
});

describe("check of the Agreed line", () => {
  it("fails an Agreed line that does not have the form", () => {
    const root = seeded({ [FILE]: record("0001").replace("- Verification: unassigned", "- Verification: unassigned\n- Agreed: yes") });
    const out = run(root, "check");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /"- Agreed: yes" does not have the form "- Agreed: <name>, YYYY-MM-DD, text <hash>"/);
  });
});

describe("usage", () => {
  it("names the commands when the command is unknown", () => {
    const out = run(project(), "frobnicate");
    assert.equal(out.status, 2);
    assert.match(out.stderr, /new, list, search, quote, check, render, guard, agree/);
  });
});
