"use client";

import { useEffect, useId, useState } from "react";

interface MermaidBlockProps {
  title: string;
  description: string;
  mermaidSource: string;
  meta?: string;
}

let renderQueue: Promise<unknown> = Promise.resolve();

function enqueueMermaidRender(id: string, source: string, isDark: boolean): Promise<string> {
  const task = renderQueue.then(async () => {
    const mermaidMod = await import("mermaid");
    const mermaid = mermaidMod.default;
    mermaid.initialize({
      startOnLoad: false,
      theme: isDark ? "dark" : "default",
      securityLevel: "loose",
    });
    const rendered = await mermaid.render(id, source);
    return rendered.svg;
  });
  renderQueue = task.catch(() => undefined);
  return task;
}

export function MermaidBlock({ title, description, mermaidSource, meta }: MermaidBlockProps) {
  const reactId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [themeTick, setThemeTick] = useState(0);

  useEffect(() => {
    const onTheme = () => setThemeTick((t) => t + 1);
    window.addEventListener("ndev-theme-change", onTheme);
    return () => window.removeEventListener("ndev-theme-change", onTheme);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    enqueueMermaidRender(`quint-mermaid-${reactId}-${themeTick}`, mermaidSource, isDark)
      .then((renderedSvg) => {
        if (!cancelled) {
          setSvg(renderedSvg);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to render Mermaid diagram.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [mermaidSource, reactId, themeTick]);

  return (
    <section className="mermaid-card">
      <div className="mermaid-card-head">
        <div>
          <h3 className="mermaid-card-title">{title}</h3>
          <p className="mermaid-card-desc">{description}</p>
        </div>
        {meta ? <span className="sidebar-badge">{meta}</span> : null}
      </div>
      <div className="mermaid-canvas">
        {svg ? (
          <div dangerouslySetInnerHTML={{ __html: svg }} />
        ) : error ? (
          <pre className="mermaid-error" data-mermaid-error={error}>
            <code>{mermaidSource}</code>
          </pre>
        ) : (
          <div style={{ color: "var(--text-muted)", fontSize: "0.88rem" }}>Rendering diagram...</div>
        )}
      </div>
      <details className="mermaid-source-details">
        <summary>View generated Mermaid source</summary>
        <pre style={{ marginTop: 12 }}>
          <code>{mermaidSource}</code>
        </pre>
      </details>
    </section>
  );
}
