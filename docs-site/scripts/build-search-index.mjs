#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(SITE_ROOT, "..");

function stripFrontmatter(raw) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!m) return { fm: {}, body: raw };
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([a-zA-Z0-9_-]+):\s*(.+)$/.exec(line.trim());
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { fm, body: m[2] };
}

function extractTitle(fm, body, fallback) {
  if (fm.title) return fm.title;
  const h1 = /^#\s+(.+)$/m.exec(body);
  if (h1) return h1[1].trim();
  if (fm.name) return fm.name;
  return fallback;
}

function extractDescription(fm, body) {
  if (fm.description) return fm.description;
  const cleaned = body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^#.*$/gm, "")
    .replace(/^\[[^\]]+\]\([^)]+\)\s*[›>].*$/gm, "");
  const para = cleaned
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith("|") && !p.startsWith("-") && !p.startsWith(">"));
  if (!para) return "";
  return para
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

function extractHeadings(body) {
  const headings = [];
  const re = /^##{1,2}\s+(.+)$/gm;
  let m;
  while ((m = re.exec(body)) !== null) {
    headings.push(m[1].replace(/[`*_]/g, "").trim());
  }
  return headings;
}

function extractText(body) {
  return body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_|~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

const entries = [];

// 1. Guides
const guidesDir = path.join(SITE_ROOT, "content", "guides");
if (fs.existsSync(guidesDir)) {
  for (const file of fs.readdirSync(guidesDir).filter((f) => f.endsWith(".md")).sort()) {
    const slug = file.replace(/\.md$/, "");
    const { fm, body } = stripFrontmatter(fs.readFileSync(path.join(guidesDir, file), "utf8"));
    entries.push({
      title: extractTitle(fm, body, slug),
      section: "Guides",
      href: `/guides/${slug}/`,
      description: extractDescription(fm, body),
      headings: extractHeadings(body),
      text: extractText(body),
    });
  }
}

// 2. Formal Quint models page
entries.push({
  title: "Formal workflow models (Quint)",
  section: "Architecture & specs",
  href: "/architecture/formal-models/",
  description:
    "Live Mermaid state diagrams, safety invariants and reachability witnesses extracted directly from models/workflow/*.qnt.",
  headings: [
    "issue_workflow",
    "Issue workflow state machine",
    "epic_workflow",
    "Epic phase progression",
    "Epic sub-issue lifecycle",
    "Safety invariants and findings",
  ],
  text: "Quint formal verification Mermaid stateDiagram-v2 issue_workflow epic_workflow safety invariants findings witnesses formal-check.sh",
});

// 3. Architecture pages
const archFiles = [
  ["spec", "docs/ndev-2/spec.md", "ndev 2.0 specification"],
  ["parity", "docs/ndev-2/parity.md", "Plugin parity list"],
  ["orca-worker-safety", "docs/ndev-2/orca-worker-safety.md", "Orca worker safety"],
  ["orca-plugin", "orca-plugin/ndev/README.md", "Orca panel plugin"],
  ["scripts", "scripts/README.md", "Shared scripts reference"],
  ["contributing", "CONTRIBUTING.md", "Contributing to ndev"],
];
for (const [slug, rel, fallback] of archFiles) {
  const abs = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const { fm, body } = stripFrontmatter(fs.readFileSync(abs, "utf8"));
  entries.push({
    title: extractTitle(fm, body, fallback),
    section: "Architecture & specs",
    href: `/architecture/${slug}/`,
    description: extractDescription(fm, body),
    headings: extractHeadings(body),
    text: extractText(body),
  });
}

// 4. Knowledge base
const kbDir = path.join(REPO_ROOT, "kb");
if (fs.existsSync(kbDir)) {
  for (const entry of fs.readdirSync(kbDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const slug = entry.name === "README.md" ? "" : entry.name.replace(/\.md$/, "");
      const { fm, body } = stripFrontmatter(fs.readFileSync(path.join(kbDir, entry.name), "utf8"));
      entries.push({
        title: extractTitle(fm, body, slug || "Knowledge base"),
        section: "Knowledge base",
        href: slug ? `/kb/${slug}/` : "/kb/",
        description: extractDescription(fm, body),
        headings: extractHeadings(body),
        text: extractText(body),
      });
    } else if (entry.isDirectory()) {
      const sub = path.join(kbDir, entry.name, "README.md");
      if (fs.existsSync(sub)) {
        const { fm, body } = stripFrontmatter(fs.readFileSync(sub, "utf8"));
        entries.push({
          title: extractTitle(fm, body, entry.name),
          section: "Knowledge base",
          href: `/kb/${entry.name}/`,
          description: extractDescription(fm, body),
          headings: extractHeadings(body),
          text: extractText(body),
        });
      }
    }
  }
}

// 5. Skills
const skillsDir = path.join(REPO_ROOT, "skills");
if (fs.existsSync(skillsDir)) {
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillMd)) continue;
    const { fm, body } = stripFrontmatter(fs.readFileSync(skillMd, "utf8"));
    entries.push({
      title: `ndev-${fm.name || entry.name}`,
      section: "Skills",
      href: `/skills/${entry.name}/`,
      description: extractDescription(fm, body),
      headings: extractHeadings(body),
      text: extractText(body),
    });
  }
}

// 6. Agents
const agentsDir = path.join(REPO_ROOT, "agents");
if (fs.existsSync(agentsDir)) {
  for (const file of fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md") && f !== "README.md").sort()) {
    const slug = file.replace(/\.md$/, "");
    const { fm, body } = stripFrontmatter(fs.readFileSync(path.join(agentsDir, file), "utf8"));
    entries.push({
      title: fm.name || slug,
      section: "Agents",
      href: `/agents/${slug}/`,
      description: extractDescription(fm, body),
      headings: extractHeadings(body),
      text: extractText(body),
    });
  }
}

const outPath = path.join(SITE_ROOT, "public", "search-index.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(entries, null, 2)}\n`);
console.log(`Built search index with ${entries.length} pages -> public/search-index.json`);
