/** Resolves the colour tokens in colors.css to hex values, once for each colour scheme. */

export type Scheme = "light" | "dark";

/** A text token on a background token, as the brand uses it. */
export interface Pair {
  fg: string;
  bg: string;
  use: string;
  /** "text" needs 4.5:1 (AA). "large" needs 3:1: large text, decorative labels, rules. */
  level: "text" | "large";
}

/** Every text and background pairing the brand uses. The contrast table and tests read it. */
export const PAIRS: Pair[] = [
  { fg: "--text-heading", bg: "--canvas", use: "Headings, body ink", level: "text" },
  { fg: "--text-body", bg: "--canvas", use: "Body copy", level: "text" },
  { fg: "--text-body", bg: "--surface-card", use: "Body copy on cards", level: "text" },
  { fg: "--text-body", bg: "--surface-tint", use: "Body copy on tinted sections", level: "text" },
  { fg: "--text-muted", bg: "--canvas", use: "Notes and meta", level: "text" },
  { fg: "--text-muted", bg: "--surface-tint", use: "Notes on tinted sections", level: "text" },
  { fg: "--text-accent", bg: "--canvas", use: "Eyebrow numbers, emphasis", level: "text" },
  { fg: "--text-accent", bg: "--surface-card", use: "Accent on cards", level: "text" },
  { fg: "--text-accent", bg: "--surface-tint", use: "Accent on tinted sections", level: "text" },
  { fg: "--text-faint", bg: "--canvas", use: "Decorative labels only", level: "large" },
  { fg: "--text-on-inverse", bg: "--surface-inverse", use: "Headings on navy", level: "text" },
  { fg: "--text-on-inverse-body", bg: "--surface-inverse", use: "Body on navy", level: "text" },
  { fg: "--text-on-inverse-muted", bg: "--surface-inverse", use: "Notes on navy", level: "text" },
  { fg: "--text-accent-on-inverse", bg: "--surface-inverse", use: "Accent on navy", level: "text" },
  { fg: "--text-on-inverse-tab", bg: "--surface-inverse", use: "Unselected tabs on navy", level: "text" },
  { fg: "--text-on-action", bg: "--action", use: "Primary button", level: "text" },
  { fg: "--text-on-action", bg: "--action-hover", use: "Primary button, hover", level: "text" },
  { fg: "--text-on-action", bg: "--action-press", use: "Primary button, pressed", level: "text" },
  { fg: "--ring", bg: "--canvas", use: "Focus ring", level: "large" },
  { fg: "--family-organisation", bg: "--surface-card", use: "Organisation family", level: "text" },
  { fg: "--family-ai", bg: "--surface-card", use: "AI family", level: "text" },
  { fg: "--error", bg: "--surface-card", use: "Errors", level: "text" },
  { fg: "--error", bg: "--error-surface", use: "Error badge", level: "text" },
  { fg: "--success", bg: "--success-surface", use: "Success badge", level: "text" },
  { fg: "--warning", bg: "--warning-surface", use: "Warning badge", level: "text" },
];

type Decls = Record<string, string>;

/** Declarations of each `:root` rule, keyed by the at-rules around it ("" at top level). */
function rootBlocks(css: string): Map<string, Decls> {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = new Map<string, Decls>();
  const stack: string[] = [];
  let buf = "";
  const flush = () => {
    if (stack.at(-1) !== ":root") return;
    const key = stack.slice(0, -1).join(" ");
    const decls = blocks.get(key) ?? {};
    for (const m of buf.matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g)) decls[m[1]] = m[2].trim();
    blocks.set(key, decls);
  };
  for (const ch of src) {
    if (ch === "{") {
      stack.push(buf.trim().replace(/\s+/g, " "));
      buf = "";
    } else if (ch === "}") {
      flush();
      stack.pop();
      buf = "";
    } else {
      buf += ch;
    }
  }
  return blocks;
}

/** Splits `light-dark(a, b)` at its top-level comma. */
function lightDarkArms(value: string): [string, string] | null {
  const m = /^light-dark\(([\s\S]*)\)$/.exec(value);
  if (!m) return null;
  let depth = 0;
  for (let i = 0; i < m[1].length; i++) {
    const c = m[1][i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) return [m[1].slice(0, i).trim(), m[1].slice(i + 1).trim()];
  }
  throw new Error(`light-dark() needs two values: ${value}`);
}

function resolve(name: string, decls: Decls, scheme: Scheme, seen: string[] = []): string {
  if (seen.includes(name)) throw new Error(`Token cycle: ${[...seen, name].join(" -> ")}`);
  const raw = decls[name];
  if (raw === undefined) throw new Error(`Undefined colour token: ${name}`);
  const arms = lightDarkArms(raw);
  const value = arms ? arms[scheme === "light" ? 0 : 1] : raw;
  const ref = /^var\((--[A-Za-z0-9-]+)\)$/.exec(value);
  if (ref) return resolve(ref[1], decls, scheme, [...seen, name]);
  if (!/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(value)) throw new Error(`${name} is not a hex colour: ${value}`);
  return value.toLowerCase();
}

export interface SchemeColors {
  /** What light-dark() gives: the value most browsers use. */
  light: (token: string) => string;
  dark: (token: string) => string;
  /** What browsers without light-dark() use under prefers-color-scheme: dark. */
  fallbackDark: (token: string) => string;
  /** Tokens that light-dark() sets. */
  semantic: string[];
}

export function schemeColors(css: string): SchemeColors {
  const blocks = rootBlocks(css);
  const base = blocks.get("");
  if (!base) throw new Error("colors.css has no top-level :root rule");
  const mediaKey = [...blocks.keys()].find((k) => /^@media \(prefers-color-scheme: ?dark\)$/.test(k));
  const supportsKey = [...blocks.keys()].find((k) => /^@supports \(color: ?light-dark\(/.test(k));
  if (!mediaKey) throw new Error("colors.css has no @media (prefers-color-scheme: dark) :root rule");
  if (!supportsKey) throw new Error("colors.css has no @supports (color: light-dark(…)) :root rule");
  const modern = { ...base, ...blocks.get(supportsKey) };
  const fallback = { ...base, ...blocks.get(mediaKey) };
  return {
    light: (t) => resolve(t, modern, "light"),
    dark: (t) => resolve(t, modern, "dark"),
    fallbackDark: (t) => resolve(t, fallback, "dark"),
    semantic: Object.keys(blocks.get(supportsKey)!),
  };
}
