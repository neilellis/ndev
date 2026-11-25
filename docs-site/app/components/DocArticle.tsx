import Link from "next/link";
import { ExternalLink } from "lucide-react";
import type { DocPage } from "@/lib/docs";
import { GITHUB_REPO_BLOB } from "@/lib/markdown";
import { ProseEnhancers } from "./ProseEnhancers";
import { Toc } from "./Toc";

export function DocArticle({ page }: { page: DocPage }) {
  const showToc = page.rendered.headings.length > 0;
  return (
    <div className={showToc ? "doc-grid" : "doc-grid no-toc"}>
      <article className="doc-main">
        <div className="doc-eyebrow">
          <span>{page.section}</span>
          <a
            href={`${GITHUB_REPO_BLOB}/${page.sourcePath}`}
            target="_blank"
            rel="noreferrer"
            className="doc-source-link"
          >
            <span>{page.sourcePath}</span>
            <ExternalLink size={12} />
          </a>
        </div>
        <h1 className="doc-title">{page.title}</h1>
        {page.description ? <p className="doc-lead">{page.description}</p> : null}

        <div className="prose" dangerouslySetInnerHTML={{ __html: page.rendered.html }} />
        <ProseEnhancers hasMermaid={page.rendered.hasMermaid} />

        {page.prev || page.next ? (
          <nav className="pager" aria-label="Pagination">
            {page.prev ? (
              <Link href={page.prev.href} className="pager-link prev">
                <span className="pager-dir">Previous</span>
                <span className="pager-label">{page.prev.label}</span>
              </Link>
            ) : null}
            {page.next ? (
              <Link href={page.next.href} className="pager-link next">
                <span className="pager-dir">Next</span>
                <span className="pager-label">{page.next.label}</span>
              </Link>
            ) : null}
          </nav>
        ) : null}
      </article>

      {showToc ? <Toc headings={page.rendered.headings} /> : null}
    </div>
  );
}
