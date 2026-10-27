import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export type TokenKind = "color" | "gradient" | "spacing" | "radius" | "shadow" | "motion" | "font" | "other";

export interface Token {
  name: string;
  value: string;
  kind: TokenKind;
  file: string;
}

export interface TokenGroup {
  file: string;
  kind: TokenKind;
  tokens: Token[];
}

const KIND_BY_FILE: Record<string, TokenKind> = {
  "colors.css": "color",
  "gradients.css": "gradient",
  "spacing.css": "spacing",
  "elevation.css": "shadow",
  "typography.css": "font",
};

const TOKEN_RE = /(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g;

function kindOf(name: string, fileKind: TokenKind): TokenKind {
  if (/radius/.test(name)) return "radius";
  if (/^--(dur|ease)/.test(name)) return "motion";
  if (name === "--caption-plate") return "color";
  return fileKind;
}

export async function parseTokens(tokensDir: string): Promise<TokenGroup[]> {
  const files = (await readdir(tokensDir)).filter((f) => f.endsWith(".css")).sort();
  const groups: TokenGroup[] = [];

  for (const file of files) {
    const css = (await readFile(path.join(tokensDir, file), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
    const fileKind = KIND_BY_FILE[file] ?? "other";
    const tokens: Token[] = [];

    for (const m of css.matchAll(TOKEN_RE)) {
      const name = m[1];
      const value = m[2].trim().replace(/\s+/g, " ");
      tokens.push({ name, value, kind: kindOf(name, fileKind), file });
    }

    if (tokens.length) groups.push({ file, kind: fileKind, tokens });
  }

  return groups;
}

/** Every token name defined across the token files. */
export async function tokenNames(tokensDir: string): Promise<Set<string>> {
  const groups = await parseTokens(tokensDir);
  return new Set(groups.flatMap((g) => g.tokens.map((t) => t.name)));
}
