"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, ChevronRight, ExternalLink, Menu, X } from "lucide-react";
import type { NavSection } from "@/lib/docs";
import { SearchDialog } from "./SearchDialog";
import { ThemeToggle } from "./ThemeToggle";

function normalizePath(p: string): string {
  const clean = p.replace(/\/+$/, "");
  return clean === "" ? "/" : `${clean}/`;
}

export function Shell({
  nav,
  children,
}: {
  nav: NavSection[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const current = normalizePath(pathname || "/");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [kbExpanded, setKbExpanded] = useState(() => current.startsWith("/kb/"));

  return (
    <>
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-left">
          <button
            type="button"
            className="icon-btn menu-btn"
            onClick={() => setMobileOpen((v) => !v)}
            aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
            aria-expanded={mobileOpen}
          >
            {mobileOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
          <Link href="/" className="brand-link" onClick={() => setMobileOpen(false)}>
            <span className="brand-mark">nd</span>
            <span>ndev docs</span>
            <span className="brand-version">2.0</span>
          </Link>
          <nav className="topbar-nav" aria-label="Primary sections">
            <Link href="/guides/installation/">Guides</Link>
            <Link href="/guides/cli/">CLI</Link>
            <Link href="/architecture/formal-models/">Quint Models</Link>
            <Link href="/skills/">Skills</Link>
            <Link href="/kb/">Knowledge base</Link>
          </nav>
        </div>

        <div className="topbar-right">
          <SearchDialog />
          <ThemeToggle />
          <a
            href="https://github.com/neilellis/ndev"
            target="_blank"
            rel="noreferrer"
            className="icon-btn"
            aria-label="ndev on GitHub"
          >
            <span>GitHub</span>
            <ExternalLink size={14} />
          </a>
        </div>
      </header>

      <div className="shell">
        <div
          className={mobileOpen ? "mobile-backdrop open" : "mobile-backdrop"}
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
        <aside className={mobileOpen ? "sidebar open" : "sidebar"} aria-label="Documentation navigation">
          {nav.map((section) => {
            const isOpen = section.collapsible ? kbExpanded || current.startsWith("/kb/") : true;
            return (
              <div key={section.id} className="sidebar-section">
                {section.collapsible ? (
                  <button
                    type="button"
                    className="sidebar-section-btn"
                    onClick={() => setKbExpanded((v) => !v)}
                    aria-expanded={isOpen}
                  >
                    <span>{section.label}</span>
                    {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                ) : (
                  <div className="sidebar-section-title">{section.label}</div>
                )}
                {isOpen ? (
                  <ul>
                    {section.items.map((item) => {
                      const itemNorm = normalizePath(item.href);
                      const active = current === itemNorm;
                      return (
                        <li key={item.href}>
                          <Link
                            href={item.href}
                            className={active ? "sidebar-link active" : "sidebar-link"}
                            aria-current={active ? "page" : undefined}
                            onClick={() => setMobileOpen(false)}
                          >
                            <span>{item.label}</span>
                            {item.badge ? <span className="sidebar-badge">{item.badge}</span> : null}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </aside>

        <main id="content">{children}</main>
      </div>
    </>
  );
}
