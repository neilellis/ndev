// Presentational specimens for the foundations pages. Each renders a design value
// through its live token, so a page shows the value rather than describing it.
// Registered globally in mdx-components.tsx.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ReactNode } from "react";
import { contrastRatio, rate } from "@/lib/contrast";
import { PAIRS, schemeColors } from "@/lib/colors";
import { TOKENS_DIR } from "@/lib/ds";

/** A labelled colour swatch filled by a colour token. */
export function Swatch({ token, hex, label }: { token: string; hex: string; label: string }) {
  return (
    <figure className="spec-swatch-card">
      <span className="spec-swatch-fill" style={{ background: `var(${token})` }} aria-hidden />
      <figcaption>
        <strong>{label}</strong>
        <code>{token}</code>
        <code>{hex}</code>
      </figcaption>
    </figure>
  );
}

export function SwatchGrid({ children }: { children: ReactNode }) {
  return <div className="spec-swatch-grid">{children}</div>;
}

/** A gradient tile filled by a gradient token. */
export function GradientTile({ token, label }: { token: string; label: string }) {
  return (
    <figure className="spec-gradient">
      <span style={{ background: `var(${token})` }} aria-hidden />
      <figcaption><strong>{label}</strong> <code>{token}</code></figcaption>
    </figure>
  );
}

const TYPE_SCALE = [
  { label: "Display", fs: "--fs-display", note: "4.375–6.5625rem (70–105px) · tracking −0.057em", serif: false, track: "--tracking-display" },
  { label: "Page title", fs: "--fs-page", note: "2.75–4.75rem (44–76px) · tracking −0.045em", serif: false, track: "--tracking-section" },
  { label: "Section", fs: "--fs-section", note: "2.5–4.0625rem (40–65px) · tracking −0.045em", serif: false, track: "--tracking-section" },
  { label: "Title", fs: "--fs-h3", note: "1.8125rem (29px) · tracking −0.025em", serif: false, track: "--tracking-title" },
  { label: "Article", fs: "--fs-h3", note: "1.875rem (30px) serif", serif: true, track: "--tracking-title" },
  { label: "Lead", fs: "--fs-lead", note: "1.375rem (22px)", serif: false },
  { label: "Body", fs: "--fs-body", note: "1.125rem (18px) / 1.6", serif: false },
  { label: "Small", fs: "--fs-sm", note: "1rem (16px) · nav, buttons", serif: false },
  { label: "Meta", fs: "--fs-xs", note: "0.875rem (14px)", serif: false },
];

/** The live type ladder, each level at its real size. */
export function TypeScale() {
  return (
    <div className="spec-typescale ds">
      {TYPE_SCALE.map((t) => (
        <div className="spec-typescale-row" key={t.label}>
          <div className="spec-meta"><strong>{t.label}</strong><br />{t.note}</div>
          <span
            style={{
              fontSize: `var(${t.fs})`,
              fontFamily: t.serif ? "var(--font-serif)" : "var(--font-sans)",
              letterSpacing: t.track ? `var(${t.track})` : undefined,
              lineHeight: "var(--lh-heading)",
            }}
          >
            Clear strategy. <em style={{ color: "var(--text-accent)" }}>Practical results.</em>
          </span>
        </div>
      ))}
    </div>
  );
}

const SPACE_SCALE = ["--space-1", "--space-2", "--space-3", "--space-4", "--space-5", "--space-6", "--space-7", "--space-8", "--space-9"];
const SPACE_PX = [4, 8, 12, 16, 24, 35, 45, 58, 90];

/** The spacing ramp as bars of their real width. */
export function SpacingScale() {
  return (
    <div className="spec-spacing">
      {SPACE_SCALE.map((s, i) => (
        <div className="spec-spacing-row" key={s}>
          <code className="spec-meta">{s} · {SPACE_PX[i]}</code>
          <span className="spec-spacing-bar" style={{ width: `var(${s})` }} aria-hidden />
        </div>
      ))}
    </div>
  );
}

export function RadiusBox({ token }: { token: string }) {
  return (
    <figure className="spec-inline">
      <span className="spec-radius" style={{ borderRadius: `var(${token})` }} aria-hidden />
      <figcaption><code>{token}</code></figcaption>
    </figure>
  );
}

export function ElevationCard({ token }: { token: string }) {
  return (
    <figure className="spec-inline">
      <span className="spec-elevation" style={{ boxShadow: `var(${token})` }} aria-hidden />
      <figcaption><code>{token}</code></figcaption>
    </figure>
  );
}

/** WCAG contrast for every text pairing the brand uses, in each colour scheme,
    computed from colors.css at build time. */
export async function ContrastTable() {
  const colors = schemeColors(await readFile(path.join(TOKENS_DIR, "colors.css"), "utf8"));
  const rows = PAIRS.flatMap((p) =>
    (["light", "dark"] as const).map((scheme) => {
      const fg = colors[scheme](p.fg);
      const bg = colors[scheme](p.bg);
      return { ...p, scheme, fgHex: fg, bgHex: bg, ratio: contrastRatio(fg, bg) };
    }),
  );
  return (
    <div className="table-scroll">
      <table className="contrast-table">
        <thead>
          <tr><th>Sample</th><th>Scheme</th><th>Text on background</th><th>Ratio</th><th>WCAG</th><th>Use</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const rating = rate(r.ratio);
            return (
              <tr key={`${r.fg} ${r.bg} ${r.scheme}`}>
                <td><span className="contrast-sample" style={{ color: r.fgHex, background: r.bgHex }}>Aa</span></td>
                <td>{r.scheme}</td>
                <td><code>{r.fg}</code> <code>{r.fgHex}</code> on <code>{r.bg}</code> <code>{r.bgHex}</code></td>
                <td>{r.ratio.toFixed(2)}:1</td>
                <td><span className={`rating rating-${rating.replace(" ", "-").toLowerCase()}`}>{rating}</span></td>
                <td>{r.use}{r.level === "large" ? " (3:1 minimum)" : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
