import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const NDEV = path.join(import.meta.dirname, "..", "..", "..", "bin", "ndev");
export const DIR = "docs/formal/requirements";

export const project = () => mkdtempSync(path.join(tmpdir(), "requirements-test-"));
export const put = (root, rel, text) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
};
export const run = (root, ...args) => {
  const out = spawnSync(NDEV, ["requirements", ...args, "--root", root], { encoding: "utf8" });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
};
export const GUIDE = "# Guide\n\nThe report names each source.\nThe report refuses an unread source.\n\nEnd.\n";
export const GUIDE_SOURCE = "- docs/guide.md#L3-L4\n\n> The report names each source.\n> The report refuses an unread source.";
export const EXPLANATION = "The report gives a list of each document that it uses. A source is a document that the report reads.";
export const numbers = (text, pattern) => [...new Set([...text.matchAll(pattern)].map((m) => Number(m[1])))].sort((a, b) => a - b);
export const yamlList = (key, items) => (items.length ? `${key}:\n${items.map((item) => `  - ${JSON.stringify(item)}`).join("\n")}` : `${key}: []`);
export const record = (number, { title = "The report names each source", id = `REQ-${number}`, status = "Accepted", origin = "explicit", level = "normal", type = "product", section = "Report", date = "2026-01-02", author = ["Neil Ellis"], decidedBy = "Neil Ellis", verification = "unassigned", model = [], statement = "The report names each source.", explanation = EXPLANATION, sourceText = GUIDE_SOURCE, source = [...sourceText.matchAll(/^- (.+)$/gm)].map((m) => m[1]), trace = "- File: docs/guide.md", issues = numbers(trace, /^- Issue: https:\/\/\S+\/issues\/(\d+)$/gm), prs = numbers(`${trace}\n${sourceText}`, /^- (?:PR: )?https:\/\/\S+\/pull\/(\d+)$/gm), notes = "", log = `- ${date}: Created.` } = {}) =>
  `---\nid: ${id}\ntitle: ${JSON.stringify(title)}\nstatus: ${status}\norigin: ${origin}\n${level === null ? "" : `level: ${level}\n`}${type === null ? "" : `type: ${type}\n`}section: ${JSON.stringify(section)}\ndate: ${date}\n${source.length === 1 ? `source: ${JSON.stringify(source[0])}` : yamlList("source", source)}\n${yamlList("author", author)}\ndecided_by: ${JSON.stringify(decidedBy)}\n${Array.isArray(verification) ? yamlList("verification", verification) : `verification: ${verification}`}\n${model.length ? `${yamlList("model", model)}\n` : ""}${yamlList("issues", issues)}\n${yamlList("prs", prs)}\n---\n\n## Statement\n\n${statement}\n\n## Explanation\n\n${explanation}\n\n## Source text\n\n${sourceText}\n\n## Trace\n\n${trace}\n\n## Notes\n\n${notes}\n\n## Log\n\n${log}\n`;
export const seeded = (records = { "0001-the-report-names-each-source.md": record("0001") }) => {
  const root = project();
  put(root, "docs/guide.md", GUIDE);
  for (const [file, text] of Object.entries(records)) put(root, `${DIR}/${file}`, text);
  return root;
};
