import path from "node:path";
import matter from "gray-matter";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeStringify from "rehype-stringify";

export interface HeadingItem {
  id: string;
  text: string;
  level: number;
}

export interface RenderedMarkdown {
  html: string;
  headings: HeadingItem[];
  title: string;
  description: string;
  plainText: string;
  hasMermaid: boolean;
}

export const GITHUB_REPO_BLOB = "https://github.com/neilellis/ndev/blob/main";

export function getBasePath(): string {
  const raw = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  return raw.replace(/\/+$/, "");
}

export function withBasePath(route: string): string {
  const bp = getBasePath();
  if (!route.startsWith("/")) return route;
  if (!bp) return route;
  if (route === bp || route.startsWith(`${bp}/`)) return route;
  return `${bp}${route}`;
}

export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function mapRepoRelativePathToRoute(repoRelPath: string): string | null {
  const normalized = repoRelPath.replace(/^\/+/, "");
  if (normalized === "README.md") return "/";
  if (normalized === "CONTRIBUTING.md") return "/architecture/contributing/";
  if (normalized === "scripts/README.md") return "/architecture/scripts/";
  if (normalized === "orca-plugin/ndev/README.md") return "/architecture/orca-plugin/";

  if (normalized === "docs/ndev-2/spec.md") return "/architecture/spec/";
  if (normalized === "docs/ndev-2/parity.md") return "/architecture/parity/";
  if (normalized === "docs/ndev-2/orca-worker-safety.md") return "/architecture/orca-worker-safety/";

  if (normalized === "kb/README.md") return "/kb/";
  if (normalized === "kb/hooks/README.md") return "/kb/hooks/";
  if (normalized.startsWith("kb/") && normalized.endsWith(".md")) {
    const inner = normalized.slice("kb/".length, -".md".length);
    return `/kb/${inner}/`;
  }

  if (normalized === "skills/README.md") return "/skills/";
  const skillMatch = /^skills\/([^/]+)\/SKILL\.md$/.exec(normalized);
  if (skillMatch) return `/skills/${skillMatch[1]}/`;

  if (normalized === "agents/README.md") return "/agents/";
  const agentMatch = /^agents\/([^/]+)\.md$/.exec(normalized);
  if (agentMatch) return `/agents/${agentMatch[1]}/`;

  return null;
}

export function rewriteMarkdownHref(href: string, sourceRepoRelPath?: string): string {
  if (!href) return href;
  if (
    href.startsWith("http://") ||
    href.startsWith("https://") ||
    href.startsWith("mailto:") ||
    href.startsWith("#")
  ) {
    return href;
  }

  if (href.startsWith("/")) {
    const [rawPath, hash] = href.split("#");
    const cleanPath = rawPath.endsWith("/") ? rawPath : `${rawPath}/`;
    const prefixed = withBasePath(cleanPath);
    return hash ? `${prefixed}#${hash}` : prefixed;
  }

  if (!sourceRepoRelPath) return href;

  const [rawTarget, hash] = href.split("#");
  const baseDir = path.posix.dirname(sourceRepoRelPath);
  const resolved = path.posix.normalize(path.posix.join(baseDir, rawTarget));

  if (resolved.startsWith("..")) {
    return href;
  }

  const mapped = mapRepoRelativePathToRoute(resolved);
  if (mapped) {
    const prefixed = withBasePath(mapped);
    return hash ? `${prefixed}#${hash}` : prefixed;
  }

  const ghUrl = `${GITHUB_REPO_BLOB}/${resolved}`;
  return hash ? `${ghUrl}#${hash}` : ghUrl;
}

function stripLeadingH1(markdown: string): { title: string | null; body: string } {
  const lines = markdown.split("\n");
  for (let i = 0; i < Math.min(lines.length, 8); i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    // Skip breadcrumb line like "[kb](README.md) › workflow"
    if (/^\[[^\]]+\]\([^)]+\)\s*[›>]/.test(line)) {
      lines[i] = "";
      continue;
    }
    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1) {
      lines.splice(i, 1);
      return { title: h1[1].trim(), body: lines.join("\n").trimStart() };
    }
    break;
  }
  return { title: null, body: markdown };
}

function extractFirstParagraph(markdown: string): string {
  const blocks = markdown
    .replace(/```[\s\S]*?```/g, "")
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b && !b.startsWith("#") && !b.startsWith("|") && !b.startsWith(">") && !b.startsWith("- "));

  if (!blocks.length) return "";
  return blocks[0]
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function toPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_|~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function renderMarkdown(
  rawSource: string,
  options: {
    sourceRepoRelPath?: string;
    fallbackTitle?: string;
    fallbackDescription?: string;
    stripH1?: boolean;
  } = {},
): RenderedMarkdown {
  let content = rawSource;
  let fmTitle = "";
  let fmDescription = "";

  try {
    const parsed = matter(rawSource);
    content = parsed.content;
    if (typeof parsed.data.title === "string") fmTitle = parsed.data.title;
    if (typeof parsed.data.description === "string") fmDescription = parsed.data.description;
  } catch {
    // Fallback for files whose frontmatter contains unquoted colons or special syntax
    const fmMatch = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(rawSource);
    if (fmMatch) {
      const fmBlock = fmMatch[1];
      content = fmMatch[2];
      const nameMatch = /^name:\s*(.+)$/m.exec(fmBlock);
      const descMatch = /^description:\s*"?(.+?)"?$/m.exec(fmBlock);
      if (nameMatch) fmTitle = nameMatch[1].trim().replace(/^["']|["']$/g, "");
      if (descMatch) fmDescription = descMatch[1].trim().replace(/^["']|["']$/g, "");
    }
  }

  let extractedTitle: string | null = null;
  if (options.stripH1 !== false) {
    const stripped = stripLeadingH1(content);
    extractedTitle = stripped.title;
    content = stripped.body;
  }

  const title = fmTitle || extractedTitle || options.fallbackTitle || "ndev documentation";
  const description = fmDescription || options.fallbackDescription || extractFirstParagraph(content);
  const hasMermaid = /```mermaid\b/.test(content);

  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeSlug)
    .use(rehypeAutolinkHeadings, {
      behavior: "append",
      properties: { className: ["heading-anchor"], ariaLabel: "Link to section" },
      content: { type: "text", value: "#" },
    })
    .use(rehypeStringify);

  const rawHtml = String(processor.processSync(content));

  // Rewrite all hrefs cleanly
  const html = rawHtml.replace(/href="([^"]+)"/g, (_match, href: string) => {
    const rewritten = rewriteMarkdownHref(href, options.sourceRepoRelPath);
    return `href="${rewritten}"`;
  });

  // Extract h2 and h3 headings with their generated ids
  const headings: HeadingItem[] = [];
  const headingRe = /<h([23])\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g;
  let hm: RegExpExecArray | null;
  while ((hm = headingRe.exec(html)) !== null) {
    const level = Number(hm[1]);
    const id = hm[2];
    const text = hm[3]
      .replace(/<a[^>]*class="heading-anchor"[^>]*>[\s\S]*?<\/a>/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .trim();
    if (text) headings.push({ id, text, level });
  }

  return {
    html,
    headings,
    title,
    description,
    plainText: toPlainText(content),
    hasMermaid,
  };
}
