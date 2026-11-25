import type { Metadata } from "next";
import Link from "next/link";
import { getKbIndexRendered, getKbPagesMeta } from "@/lib/docs";

export const metadata: Metadata = {
  title: "Knowledge base",
  description: "Project-neutral engineering rules applied by ndev skills, agents and hooks.",
};

export default function KbIndexPage() {
  const pages = getKbPagesMeta();
  const readme = getKbIndexRendered();

  return (
    <div className="doc-grid no-toc">
      <article className="doc-main">
        <div className="doc-eyebrow">
          <span>Knowledge base · {pages.length} guides</span>
        </div>
        <h1 className="doc-title">Knowledge base</h1>
        <p className="doc-lead">
          The development method applied by ndev skills and agents. Every page is rendered directly from{" "}
          <code>kb/</code>.
        </p>

        <div className="prose" dangerouslySetInnerHTML={{ __html: readme.html }} />

        <h2 style={{ margin: "36px 0 12px", color: "var(--text-heading)", fontSize: "1.3rem" }}>All pages</h2>
        <div className="card-grid">
          {pages.map((p) => (
            <Link key={p.slugKey} href={p.href} className="card">
              <span className="card-kicker">{p.sourcePath}</span>
              <span className="card-title">{p.title}</span>
              <span className="card-desc">{p.description}</span>
            </Link>
          ))}
        </div>
      </article>
    </div>
  );
}
