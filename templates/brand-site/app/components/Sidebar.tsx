"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV } from "@/lib/nav";
import { Wordmark } from "./Wordmark";

export function Sidebar() {
  const pathname = usePathname();
  const current = pathname.replace(/\/$/, "") || "/";
  return (
    <nav className="sidebar" aria-label="Brand guide">
      <Link href="/" className="sidebar-brand" aria-label="{{name}} brand guide home">
        <Wordmark />
        <span>Brand guide</span>
      </Link>
      {NAV.map((section, i) => (
        <div key={i} className="sidebar-section">
          {section.label ? <div className="sidebar-h">{section.label}</div> : null}
          <ul>
            {section.items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={current === item.href ? "sidebar-link active" : "sidebar-link"}
                  aria-current={current === item.href ? "page" : undefined}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
