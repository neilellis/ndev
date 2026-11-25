"use client";

import { useEffect } from "react";

export function ProseEnhancers({ hasMermaid }: { hasMermaid?: boolean }) {
  useEffect(() => {
    // 1. Add copy buttons to standard code blocks
    const pres = document.querySelectorAll<HTMLPreElement>(".prose pre");
    for (const pre of pres) {
      if (pre.querySelector("code.language-mermaid")) continue;
      if (pre.querySelector(".copy-code-btn")) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "copy-code-btn";
      btn.textContent = "Copy";
      btn.addEventListener("click", async () => {
        const text = pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
        try {
          await navigator.clipboard.writeText(text);
          btn.textContent = "Copied";
          setTimeout(() => {
            btn.textContent = "Copy";
          }, 1600);
        } catch {
          btn.textContent = "Failed";
        }
      });
      pre.appendChild(btn);
    }

    // 2. Hydrate any fenced ```mermaid code blocks inside prose
    const mermaidCodes = document.querySelectorAll<HTMLElement>(".prose pre > code.language-mermaid");
    if (!hasMermaid && mermaidCodes.length === 0) return;

    let cancelled = false;

    async function renderAll() {
      const mermaidMod = await import("mermaid");
      const mermaid = mermaidMod.default;
      const isDark = document.documentElement.getAttribute("data-theme") === "dark";
      mermaid.initialize({
        startOnLoad: false,
        theme: isDark ? "dark" : "default",
        securityLevel: "loose",
      });

      const targets = document.querySelectorAll<HTMLElement>(".prose pre > code.language-mermaid, [data-mermaid-inline]");
      let idx = 0;
      for (const el of targets) {
        if (cancelled) return;
        const source = el.getAttribute("data-mermaid-source") ?? el.textContent ?? "";
        if (!source.trim()) continue;
        const host = el.closest(".mermaid-inline-wrap") ?? el.parentElement;
        if (!host) continue;

        let container: HTMLElement;
        if (host.classList.contains("mermaid-inline-wrap")) {
          container = host as HTMLElement;
        } else {
          container = document.createElement("div");
          container.className = "mermaid-inline-wrap";
          container.setAttribute("data-mermaid-inline", "true");
          container.setAttribute("data-mermaid-source", source);
          host.replaceWith(container);
        }

        try {
          const { svg } = await mermaid.render(`ndev-inline-mermaid-${Date.now()}-${idx++}`, source);
          if (!cancelled) container.innerHTML = svg;
        } catch {
          if (!cancelled) {
            container.innerHTML = `<pre><code>${source.replace(/</g, "&lt;")}</code></pre>`;
          }
        }
      }
    }

    void renderAll();

    const onThemeChange = () => {
      void renderAll();
    };
    window.addEventListener("ndev-theme-change", onThemeChange);
    return () => {
      cancelled = true;
      window.removeEventListener("ndev-theme-change", onThemeChange);
    };
  }, [hasMermaid]);

  return null;
}
