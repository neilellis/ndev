"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { SkillMeta } from "@/lib/docs";

export function SkillExplorer({ skills }: { skills: SkillMeta[] }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");

  const categories = useMemo(() => {
    const unique = Array.from(new Set(skills.map((s) => s.category)));
    return ["All", ...unique];
  }, [skills]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills.filter((skill) => {
      if (category !== "All" && skill.category !== category) return false;
      if (!q) return true;
      return (
        skill.name.toLowerCase().includes(q) ||
        skill.description.toLowerCase().includes(q) ||
        skill.category.toLowerCase().includes(q)
      );
    });
  }, [skills, query, category]);

  return (
    <section aria-label="Interactive skill catalogue">
      <div className="filter-bar">
        <input
          type="search"
          className="filter-input"
          placeholder={`Filter ${skills.length} skills by name or task...`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter skills"
        />
        <div className="pill-row">
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              className={cat === category ? "pill active" : "pill"}
              onClick={() => setCategory(cat)}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      <div className="card-grid">
        {filtered.map((skill) => (
          <Link key={skill.slug} href={skill.href} className="card">
            <span className="card-kicker">{skill.category}</span>
            <span className="card-title">ndev-{skill.name}</span>
            <span className="card-desc">{skill.description}</span>
          </Link>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p style={{ color: "var(--text-muted)" }}>No skills match &ldquo;{query}&rdquo;.</p>
      ) : null}
    </section>
  );
}
