import type { ReactNode } from "react";

type Surface = "paper" | "white" | "mist" | "navy";

/** A framed live example rendered with the real component classes inside .ds. */
export function Demo({ surface = "paper", label, children }: { surface?: Surface; label?: string; children: ReactNode }) {
  return (
    <figure className="demo-figure">
      {label ? <figcaption className="demo-label">{label}</figcaption> : null}
      <div className={`demo-frame ds surface-${surface}${surface === "navy" ? " on-inverse" : ""}`}>{children}</div>
    </figure>
  );
}

/** Two side-by-side cards: what to do and what to avoid. */
export function DoDont({ good, bad }: { good: ReactNode; bad: ReactNode }) {
  return (
    <div className="dodont">
      <div className="dodont-do"><strong>Do</strong>{good}</div>
      <div className="dodont-dont"><strong>Avoid</strong>{bad}</div>
    </div>
  );
}

/** A captioned image from the design-system assets. */
export function Still({ src, alt, caption, wide }: { src: string; alt: string; caption?: ReactNode; wide?: boolean }) {
  return (
    <figure className={wide ? "still still-wide" : "still"}>
      <img src={src} alt={alt} loading="lazy" />
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

export function StillGrid({ children }: { children: ReactNode }) {
  return <div className="still-grid">{children}</div>;
}

/** A plain-English rule box, for the rules an agent must not break. */
export function Rule({ children }: { children: ReactNode }) {
  return <aside className="provenance">{children}</aside>;
}
