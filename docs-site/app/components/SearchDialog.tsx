"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";

interface SearchEntry {
  title: string;
  section: string;
  href: string;
  description: string;
  headings: string[];
  text: string;
}

const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "");

export function SearchDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<SearchEntry[] | null>(null);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (
        e.key === "/" &&
        !open &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        setOpen(true);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setTimeout(() => inputRef.current?.focus(), 20);
    if (entries !== null) return;
    fetch(`${BASE_PATH}/search-index.json`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: SearchEntry[]) => setEntries(Array.isArray(data) ? data : []))
      .catch(() => setEntries([]));
  }, [open, entries]);

  const results = useMemo(() => {
    if (!entries) return [];
    const q = query.trim().toLowerCase();
    if (!q) return entries.slice(0, 12);
    const terms = q.split(/\s+/).filter(Boolean);

    const scored = entries
      .map((entry) => {
        const titleL = entry.title.toLowerCase();
        const descL = entry.description.toLowerCase();
        const sectionL = entry.section.toLowerCase();
        const headingsL = entry.headings.join(" ").toLowerCase();
        const textL = entry.text.toLowerCase();

        let score = 0;
        for (const term of terms) {
          if (titleL.includes(term)) score += 10;
          if (headingsL.includes(term)) score += 5;
          if (sectionL.includes(term)) score += 3;
          if (descL.includes(term)) score += 3;
          if (textL.includes(term)) score += 1;
        }
        return { entry, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((item) => item.entry);

    return scored;
  }, [entries, query]);

  useEffect(() => {
    setSelected(0);
  }, [query, open]);

  function navigateTo(href: string) {
    setOpen(false);
    setQuery("");
    router.push(href);
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, Math.max(0, results.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter" && results[selected]) {
      e.preventDefault();
      navigateTo(results[selected].href);
    }
  }

  return (
    <>
      <button
        type="button"
        className="icon-btn search-trigger"
        onClick={() => setOpen(true)}
        aria-label="Search documentation"
      >
        <span className="search-trigger-left">
          <Search size={15} />
          <span className="search-trigger-label">Search docs...</span>
        </span>
        <span className="kbd">⌘K</span>
      </button>

      {open ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Search documentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="modal-panel">
            <div className="modal-input-row">
              <Search size={18} />
              <input
                ref={inputRef}
                className="modal-input"
                type="search"
                placeholder="Search guides, CLI commands, skills, Quint models, KB..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onInputKeyDown}
              />
              <button
                type="button"
                className="icon-btn"
                onClick={() => setOpen(false)}
                aria-label="Close search"
              >
                <X size={16} />
              </button>
            </div>
            <div className="modal-results">
              {entries === null ? (
                <div className="search-empty">Loading search index...</div>
              ) : results.length === 0 ? (
                <div className="search-empty">No pages matched &ldquo;{query}&rdquo;.</div>
              ) : (
                results.map((item, idx) => (
                  <a
                    key={item.href}
                    href={`${BASE_PATH}${item.href}`}
                    className={idx === selected ? "search-item selected" : "search-item"}
                    onClick={(e) => {
                      e.preventDefault();
                      navigateTo(item.href);
                    }}
                    onMouseEnter={() => setSelected(idx)}
                  >
                    <div className="search-item-top">
                      <span className="search-item-title">{item.title}</span>
                      <span className="sidebar-badge">{item.section}</span>
                    </div>
                    {item.description ? <div className="search-item-desc">{item.description}</div> : null}
                  </a>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
