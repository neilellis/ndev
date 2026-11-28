import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { renderMarkdown, type RenderedMarkdown } from "./markdown";
import { loadQuintModels, type QuintModelDoc } from "./quint-to-mermaid";

export const SITE_ROOT = path.resolve(process.cwd());
export const REPO_ROOT = path.resolve(SITE_ROOT, "..");

export interface NavItem {
  label: string;
  href: string;
  badge?: string;
}

export interface NavSection {
  id: string;
  label: string;
  items: NavItem[];
  collapsible?: boolean;
}

export interface DocPage {
  slug: string;
  href: string;
  section: string;
  title: string;
  description: string;
  sourcePath: string;
  rendered: RenderedMarkdown;
  prev?: NavItem;
  next?: NavItem;
}

export interface SkillMeta {
  slug: string;
  name: string;
  description: string;
  category: string;
  href: string;
  sourcePath: string;
}

export interface AgentMeta {
  slug: string;
  name: string;
  description: string;
  model?: string;
  tools?: string;
  href: string;
  sourcePath: string;
}

export interface GuideMeta {
  slug: string;
  title: string;
  description: string;
  href: string;
  sourcePath: string;
}

export interface KbMeta {
  slug: string[];
  slugKey: string;
  title: string;
  description: string;
  href: string;
  sourcePath: string;
}

export interface ArchitectureMeta {
  slug: string;
  title: string;
  description: string;
  href: string;
  sourcePath: string;
}

export const GUIDE_ORDER = [
  "installation",
  "project-setup",
  "proof",
  "workflows",
  "cli",
  "hooks-and-guards",
  "orca",
  "harnesses",
] as const;

export const ARCHITECTURE_PAGES: ArchitectureMeta[] = [
  {
    slug: "spec",
    title: "ndev 2.0 specification",
    description: "CLI tree, state files, hooks, watcher, Orca panels and install layout.",
    href: "/architecture/spec/",
    sourcePath: "docs/ndev-2/spec.md",
  },
  {
    slug: "parity",
    title: "Plugin parity list",
    description: "Maps each 0.x Claude Code plugin feature to its ndev 2.0 command and test.",
    href: "/architecture/parity/",
    sourcePath: "docs/ndev-2/parity.md",
  },
  {
    slug: "orca-worker-safety",
    title: "Orca worker safety",
    description: "Exit and release verification, retry guards and host load limits for Orca workers.",
    href: "/architecture/orca-worker-safety/",
    sourcePath: "docs/ndev-2/orca-worker-safety.md",
  },
  {
    slug: "orca-plugin",
    title: "Orca panel plugin",
    description: "How the neilellis.ndev Orca plugin renders worktree files, resources and workflow panels.",
    href: "/architecture/orca-plugin/",
    sourcePath: "orca-plugin/ndev/README.md",
  },
  {
    slug: "scripts",
    title: "Shared scripts reference",
    description: "Shared helpers called by two or more skills, agents or hooks.",
    href: "/architecture/scripts/",
    sourcePath: "scripts/README.md",
  },
  {
    slug: "contributing",
    title: "Contributing to ndev",
    description: "Test suites, SDK runtime, plugin version guard and prose rules.",
    href: "/architecture/contributing/",
    sourcePath: "CONTRIBUTING.md",
  },
];

const KB_PREFERRED_ORDER = [
  "core-beliefs",
  "agent-collaboration",
  "failure-handling",
  "testing",
  "guards",
  "verification-policy",
  "precheck-and-push",
  "git-and-worktrees",
  "ci",
  "writing",
  "workflow",
  "north-star",
  "libraries",
  "logging",
  "type-safety",
  "comments",
  "architecture",
  "local-dev",
  "deployment",
  "issue-tracking",
  "llm-wiki",
  "docs-screenshots",
  "adr",
  "pdr",
  "requirements",
  "ui-components",
  "hooks",
];

function safeParseFrontmatter(raw: string): { data: Record<string, unknown>; content: string } {
  try {
    const parsed = matter(raw);
    return { data: parsed.data as Record<string, unknown>, content: parsed.content };
  } catch {
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
    if (!m) return { data: {}, content: raw };
    const data: Record<string, unknown> = {};
    for (const line of m[1].split("\n")) {
      const kv = /^([a-zA-Z0-9_-]+):\s*(.+)$/.exec(line.trim());
      if (kv) data[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
    }
    return { data, content: m[2] };
  }
}


function extractMetaFromMarkdown(raw: string, fallbackTitle: string): { title: string; description: string } {
  const { data, content } = safeParseFrontmatter(raw);
  const lines = content.split(/\r?\n/);
  let title = typeof data.title === "string" && data.title.trim() ? data.title.trim() : "";
  if (!title) {
    for (const line of lines) {
      const m = /^#\s+(.+)$/.exec(line.trim());
      if (m) {
        title = m[1].replace(/`([^`]+)`/g, "$1").trim();
        break;
      }
    }
  }
  if (!title) title = fallbackTitle;

  let description = typeof data.description === "string" && data.description.trim() ? data.description.trim() : "";
  if (!description) {
    let inFence = false;
    const para: string[] = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.startsWith("```")) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      if (!line) {
        if (para.length > 0) break;
        continue;
      }
      if (line.startsWith("#") || line.startsWith(">") || line.startsWith("|") || line.startsWith("- ") || line.startsWith("* ")) {
        if (para.length > 0) break;
        continue;
      }
      para.push(line);
    }
    description = para
      .join(" ")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 220);
  }
  return { title, description };
}

let guidesCache: GuideMeta[] | null = null;
let skillsCache: SkillMeta[] | null = null;
let agentsCache: AgentMeta[] | null = null;
let kbMetaCache: KbMeta[] | null = null;
let quintCache: QuintModelDoc[] | null = null;
let navCache: NavSection[] | null = null;

function titleFromSlug(slug: string): string {
  return slug
    .split(/[-/]/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
    .join(" ");
}

function attachPrevNext(pages: DocPage[]): DocPage[] {
  return pages.map((page, index) => ({
    ...page,
    prev: index > 0 ? { label: pages[index - 1].title, href: pages[index - 1].href } : undefined,
    next:
      index + 1 < pages.length
        ? { label: pages[index + 1].title, href: pages[index + 1].href }
        : undefined,
  }));
}

export function getGuides(): GuideMeta[] {
  if (guidesCache) return guidesCache;
  const dir = path.join(SITE_ROOT, "content", "guides");
  if (!fs.existsSync(dir)) return [];

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));

  const ordered = [
    ...GUIDE_ORDER.filter((s) => files.includes(s)),
    ...files.filter((s) => !(GUIDE_ORDER as readonly string[]).includes(s)).sort(),
  ];

  guidesCache = ordered.map((slug) => {
    const abs = path.join(dir, `${slug}.md`);
    const raw = fs.readFileSync(abs, "utf8");
    const meta = extractMetaFromMarkdown(raw, titleFromSlug(slug));
    return {
      slug,
      title: meta.title,
      description: meta.description,
      href: `/guides/${slug}/`,
      sourcePath: `docs-site/content/guides/${slug}.md`,
    };
  });
  return guidesCache;
}

export function getGuidePage(slug: string): DocPage | null {
  const guides = getGuides();
  const idx = guides.findIndex((g) => g.slug === slug);
  if (idx === -1) return null;
  const meta = guides[idx];
  const raw = fs.readFileSync(path.join(SITE_ROOT, "content", "guides", `${slug}.md`), "utf8");
  const rendered = renderMarkdown(raw, {
    fallbackTitle: meta.title,
    fallbackDescription: meta.description,
  });
  return {
    slug,
    href: meta.href,
    section: "Guides",
    title: meta.title,
    description: meta.description,
    sourcePath: meta.sourcePath,
    rendered,
    prev: idx > 0 ? { label: guides[idx - 1].title, href: guides[idx - 1].href } : undefined,
    next:
      idx + 1 < guides.length
        ? { label: guides[idx + 1].title, href: guides[idx + 1].href }
        : { label: "Formal models (Quint)", href: "/architecture/formal-models/" },
  };
}

function parseSkillCategories(): Map<string, string> {
  const map = new Map<string, string>();
  const readmePath = path.join(REPO_ROOT, "skills", "README.md");
  if (!fs.existsSync(readmePath)) return map;
  const lines = fs.readFileSync(readmePath, "utf8").split("\n");
  let currentCategory = "Other";
  for (const line of lines) {
    const h2 = /^##\s+(.+)$/.exec(line.trim());
    if (h2) {
      currentCategory = h2[1].trim();
      continue;
    }
    const item = /^-\s+\[([^\]]+)\]\(([^/]+)\/SKILL\.md\)/.exec(line.trim());
    if (item) {
      map.set(item[2], currentCategory);
    }
  }
  return map;
}

export function getSkills(): SkillMeta[] {
  if (skillsCache) return skillsCache;
  const skillsDir = path.join(REPO_ROOT, "skills");
  if (!fs.existsSync(skillsDir)) return [];
  const categories = parseSkillCategories();

  const entries = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(skillsDir, d.name, "SKILL.md")))
    .map((d) => d.name)
    .sort();

  skillsCache = entries.map((slug) => {
    const abs = path.join(skillsDir, slug, "SKILL.md");
    const raw = fs.readFileSync(abs, "utf8");
    const { data } = safeParseFrontmatter(raw);
    const name = typeof data.name === "string" ? data.name : slug;
    const description =
      typeof data.description === "string"
        ? data.description
        : extractMetaFromMarkdown(raw, slug).description;

    return {
      slug,
      name,
      description,
      category: categories.get(slug) ?? "Other",
      href: `/skills/${slug}/`,
      sourcePath: `skills/${slug}/SKILL.md`,
    };
  });
  return skillsCache;
}

export function getSkillsIndexRendered(): RenderedMarkdown {
  const readmePath = path.join(REPO_ROOT, "skills", "README.md");
  const raw = fs.readFileSync(readmePath, "utf8");
  return renderMarkdown(raw, {
    sourceRepoRelPath: "skills/README.md",
    fallbackTitle: "Skills index",
  });
}

export function getSkillPage(slug: string): DocPage | null {
  const skills = getSkills();
  const idx = skills.findIndex((s) => s.slug === slug);
  if (idx === -1) return null;
  const meta = skills[idx];
  const raw = fs.readFileSync(path.join(REPO_ROOT, "skills", slug, "SKILL.md"), "utf8");
  const rendered = renderMarkdown(raw, {
    sourceRepoRelPath: meta.sourcePath,
    fallbackTitle: `ndev-${meta.name}`,
    fallbackDescription: meta.description,
  });
  return {
    slug,
    href: meta.href,
    section: `Skills · ${meta.category}`,
    title: `ndev-${meta.name}`,
    description: meta.description,
    sourcePath: meta.sourcePath,
    rendered,
    prev: idx > 0 ? { label: `ndev-${skills[idx - 1].name}`, href: skills[idx - 1].href } : undefined,
    next:
      idx + 1 < skills.length
        ? { label: `ndev-${skills[idx + 1].name}`, href: skills[idx + 1].href }
        : undefined,
  };
}

export function getAgents(): AgentMeta[] {
  if (agentsCache) return agentsCache;
  const agentsDir = path.join(REPO_ROOT, "agents");
  if (!fs.existsSync(agentsDir)) return [];

  const files = fs
    .readdirSync(agentsDir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort();

  agentsCache = files.map((file) => {
    const slug = file.replace(/\.md$/, "");
    const raw = fs.readFileSync(path.join(agentsDir, file), "utf8");
    const { data } = safeParseFrontmatter(raw);
    const name = typeof data.name === "string" ? data.name : slug;
    const description =
      typeof data.description === "string"
        ? data.description
        : extractMetaFromMarkdown(raw, name).description;

    return {
      slug,
      name,
      description,
      model: typeof data.model === "string" ? data.model : undefined,
      tools: Array.isArray(data.tools)
        ? data.tools.join(", ")
        : typeof data.tools === "string"
          ? data.tools
          : undefined,
      href: `/agents/${slug}/`,
      sourcePath: `agents/${file}`,
    };
  });
  return agentsCache;
}

export function getAgentsIndexRendered(): RenderedMarkdown {
  const readmePath = path.join(REPO_ROOT, "agents", "README.md");
  const raw = fs.readFileSync(readmePath, "utf8");
  return renderMarkdown(raw, {
    sourceRepoRelPath: "agents/README.md",
    fallbackTitle: "Agents",
  });
}

export function getAgentPage(slug: string): DocPage | null {
  const agents = getAgents();
  const idx = agents.findIndex((a) => a.slug === slug);
  if (idx === -1) return null;
  const meta = agents[idx];
  const raw = fs.readFileSync(path.join(REPO_ROOT, meta.sourcePath), "utf8");
  const rendered = renderMarkdown(raw, {
    sourceRepoRelPath: meta.sourcePath,
    fallbackTitle: meta.name,
    fallbackDescription: meta.description,
  });
  return {
    slug,
    href: meta.href,
    section: "Agents",
    title: meta.name,
    description: meta.description,
    sourcePath: meta.sourcePath,
    rendered,
    prev: idx > 0 ? { label: agents[idx - 1].name, href: agents[idx - 1].href } : undefined,
    next: idx + 1 < agents.length ? { label: agents[idx + 1].name, href: agents[idx + 1].href } : undefined,
  };
}

export function getKbPagesMeta(): KbMeta[] {
  if (kbMetaCache) return kbMetaCache;
  const kbDir = path.join(REPO_ROOT, "kb");
  if (!fs.existsSync(kbDir)) return [];

  const found: { slug: string[]; slugKey: string; abs: string; rel: string }[] = [];

  for (const entry of fs.readdirSync(kbDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md") {
      const s = entry.name.replace(/\.md$/, "");
      found.push({
        slug: [s],
        slugKey: s,
        abs: path.join(kbDir, entry.name),
        rel: `kb/${entry.name}`,
      });
    } else if (entry.isDirectory()) {
      const subReadme = path.join(kbDir, entry.name, "README.md");
      if (fs.existsSync(subReadme)) {
        found.push({
          slug: [entry.name],
          slugKey: entry.name,
          abs: subReadme,
          rel: `kb/${entry.name}/README.md`,
        });
      }
    }
  }

  found.sort((a, b) => {
    const ai = KB_PREFERRED_ORDER.indexOf(a.slugKey);
    const bi = KB_PREFERRED_ORDER.indexOf(b.slugKey);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.slugKey.localeCompare(b.slugKey);
  });

  kbMetaCache = found.map((item) => {
    const raw = fs.readFileSync(item.abs, "utf8");
    const meta = extractMetaFromMarkdown(raw, titleFromSlug(item.slugKey));
    return {
      slug: item.slug,
      slugKey: item.slugKey,
      title: meta.title,
      description: meta.description,
      href: `/kb/${item.slug.join("/")}/`,
      sourcePath: item.rel,
    };
  });
  return kbMetaCache;
}

export function getKbIndexRendered(): RenderedMarkdown {
  const raw = fs.readFileSync(path.join(REPO_ROOT, "kb", "README.md"), "utf8");
  return renderMarkdown(raw, {
    sourceRepoRelPath: "kb/README.md",
    fallbackTitle: "Knowledge base",
  });
}

export function getKbPage(slugParts: string[]): DocPage | null {
  const pages = getKbPagesMeta();
  const key = slugParts.join("/");
  const idx = pages.findIndex((p) => p.slugKey === key);
  if (idx === -1) return null;
  const meta = pages[idx];
  const raw = fs.readFileSync(path.join(REPO_ROOT, meta.sourcePath), "utf8");
  const rendered = renderMarkdown(raw, {
    sourceRepoRelPath: meta.sourcePath,
    fallbackTitle: meta.title,
    fallbackDescription: meta.description,
  });
  return {
    slug: meta.slugKey,
    href: meta.href,
    section: "Knowledge base",
    title: meta.title,
    description: meta.description,
    sourcePath: meta.sourcePath,
    rendered,
    prev: idx > 0 ? { label: pages[idx - 1].title, href: pages[idx - 1].href } : { label: "Knowledge base", href: "/kb/" },
    next: idx + 1 < pages.length ? { label: pages[idx + 1].title, href: pages[idx + 1].href } : undefined,
  };
}

export function getArchitecturePage(slug: string): DocPage | null {
  const idx = ARCHITECTURE_PAGES.findIndex((p) => p.slug === slug);
  if (idx === -1) return null;
  const meta = ARCHITECTURE_PAGES[idx];
  const abs = path.join(REPO_ROOT, meta.sourcePath);
  if (!fs.existsSync(abs)) return null;
  const raw = fs.readFileSync(abs, "utf8");
  const rendered = renderMarkdown(raw, {
    sourceRepoRelPath: meta.sourcePath,
    fallbackTitle: meta.title,
    fallbackDescription: meta.description,
  });
  return {
    slug,
    href: meta.href,
    section: "Architecture & specs",
    title: meta.title,
    description: meta.description,
    sourcePath: meta.sourcePath,
    rendered,
    prev:
      idx > 0
        ? { label: ARCHITECTURE_PAGES[idx - 1].title, href: ARCHITECTURE_PAGES[idx - 1].href }
        : { label: "Formal models (Quint)", href: "/architecture/formal-models/" },
    next:
      idx + 1 < ARCHITECTURE_PAGES.length
        ? { label: ARCHITECTURE_PAGES[idx + 1].title, href: ARCHITECTURE_PAGES[idx + 1].href }
        : undefined,
  };
}

export function getQuintModels(): QuintModelDoc[] {
  if (!quintCache) quintCache = loadQuintModels(REPO_ROOT);
  return quintCache;
}

export function getNavigation(): NavSection[] {
  if (navCache) return navCache;
  const guides = getGuides();
  const kbPages = getKbPagesMeta();
  const skills = getSkills();
  const agents = getAgents();

  navCache = [
    {
      id: "start",
      label: "Getting started",
      items: [
        { label: "Overview", href: "/" },
        ...guides.map((g) => ({ label: g.title, href: g.href })),
      ],
    },
    {
      id: "architecture",
      label: "Architecture & specs",
      items: [
        { label: "Formal models (Quint)", href: "/architecture/formal-models/", badge: "Live" },
        ...ARCHITECTURE_PAGES.map((a) => ({ label: a.title, href: a.href })),
      ],
    },
    {
      id: "catalogs",
      label: "Skills & agents",
      items: [
        { label: "Skills index", href: "/skills/", badge: String(skills.length) },
        { label: "Agents index", href: "/agents/", badge: String(agents.length) },
      ],
    },
    {
      id: "kb",
      label: "Knowledge base",
      collapsible: true,
      items: [
        { label: "Read order & index", href: "/kb/" },
        ...kbPages.map((p) => ({ label: p.title, href: p.href })),
      ],
    },
  ];
  return navCache;
}

export { attachPrevNext };
