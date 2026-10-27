// Presentational specimens for the foundations pages. Each renders a design value
// through its live token, so a page shows the value rather than describing it.
// Registered globally in mdx-components.tsx.
import type { ReactNode } from "react";
import { contrastRatio, rate } from "@/lib/contrast";

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
  { label: "Display", fs: "--fs-display", note: "70–105px · tracking −0.057em", serif: false, track: "--tracking-display" },
  { label: "Page title", fs: "--fs-page", note: "44–76px · tracking −0.045em", serif: false, track: "--tracking-section" },
  { label: "Section", fs: "--fs-section", note: "40–65px · tracking −0.045em", serif: false, track: "--tracking-section" },
  { label: "Title", fs: "--fs-h3", note: "29px · tracking −0.025em", serif: false, track: "--tracking-title" },
  { label: "Article", fs: "--fs-h3", note: "30px serif", serif: true, track: "--tracking-title" },
  { label: "Lead", fs: "--fs-lead", note: "22px", serif: false },
  { label: "Body", fs: "--fs-body", note: "18px / 1.6", serif: false },
  { label: "Small", fs: "--fs-sm", note: "16px · nav, buttons", serif: false },
  { label: "Meta", fs: "--fs-xs", note: "14px", serif: false },
];

/** The live type ladder, each level at its real size. */
export function TypeScale() {
  return (
    <div className="spec-typescale nv">
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
            Strategic insight. <em style={{ color: "var(--text-accent)" }}>Lasting impact.</em>
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

const PAIRS: { fg: string; bg: string; fgName: string; bgName: string; use: string }[] = [
  { fg: "#102846", bg: "#f6f8fa", fgName: "ink", bgName: "paper", use: "Headings, body ink" },
  { fg: "#3f536a", bg: "#f6f8fa", fgName: "body", bgName: "paper", use: "Body copy" },
  { fg: "#586b80", bg: "#f6f8fa", fgName: "muted", bgName: "paper", use: "Notes and meta" },
  { fg: "#586b80", bg: "#e8eff5", fgName: "muted", bgName: "mist", use: "Notes on tinted sections" },
  { fg: "#2166ac", bg: "#f6f8fa", fgName: "blue", bgName: "paper", use: "Eyebrow numbers, emphasis" },
  { fg: "#2166ac", bg: "#ffffff", fgName: "blue", bgName: "white", use: "Accent on cards" },
  { fg: "#6b8095", bg: "#f6f8fa", fgName: "faint", bgName: "paper", use: "Decorative labels only" },
  { fg: "#ffffff", bg: "#102b4a", fgName: "white", bgName: "navy", use: "Headings on navy" },
  { fg: "#c4d5e6", bg: "#102b4a", fgName: "navy text", bgName: "navy", use: "Body on navy" },
  { fg: "#a7d8ff", bg: "#102b4a", fgName: "sky", bgName: "navy", use: "Accent on navy" },
  { fg: "#b8cde3", bg: "#102b4a", fgName: "tab text", bgName: "navy", use: "Unselected tabs on navy" },
  { fg: "#ffffff", bg: "#2166ac", fgName: "white", bgName: "blue", use: "Text on blue" },
  { fg: "#173f35", bg: "#ffffff", fgName: "forest", bgName: "white", use: "Organisation family" },
  { fg: "#a94f24", bg: "#ffffff", fgName: "rust", bgName: "white", use: "AI family" },
  { fg: "#a42b24", bg: "#ffffff", fgName: "red", bgName: "white", use: "Errors" },
];

/** WCAG contrast for every text pairing the brand uses, computed at build time. */
export function ContrastTable() {
  return (
    <div className="table-scroll">
      <table className="contrast-table">
        <thead>
          <tr><th>Sample</th><th>Text on background</th><th>Ratio</th><th>WCAG</th><th>Use</th></tr>
        </thead>
        <tbody>
          {PAIRS.map((p) => {
            const r = contrastRatio(p.fg, p.bg);
            const rating = rate(r);
            return (
              <tr key={p.fg + p.bg}>
                <td><span className="contrast-sample" style={{ color: p.fg, background: p.bg }}>Aa</span></td>
                <td>{p.fgName} <code>{p.fg}</code> on {p.bgName} <code>{p.bg}</code></td>
                <td>{r.toFixed(2)}:1</td>
                <td><span className={`rating rating-${rating.replace(" ", "-").toLowerCase()}`}>{rating}</span></td>
                <td>{p.use}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
