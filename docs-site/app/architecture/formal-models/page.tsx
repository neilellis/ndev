import type { Metadata } from "next";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { getQuintModels } from "@/lib/docs";
import { GITHUB_REPO_BLOB } from "@/lib/markdown";
import { MermaidBlock } from "@/app/components/MermaidBlock";
import { Toc } from "@/app/components/Toc";

export const metadata: Metadata = {
  title: "Formal workflow models (Quint)",
  description:
    "Live Mermaid state diagrams, safety invariants and reachability witnesses extracted directly from models/workflow/*.qnt.",
};

export default function FormalModelsPage() {
  const models = getQuintModels();
  const headings = models.flatMap((m) => [
    { id: m.slug, text: m.moduleName, level: 2 },
    ...m.diagrams.map((d) => ({ id: d.id, text: d.title, level: 3 })),
    { id: `${m.slug}-invariants`, text: `${m.moduleName} invariants`, level: 3 },
  ]);

  return (
    <div className="doc-grid">
      <article className="doc-main">
        <div className="doc-eyebrow">
          <span>Architecture &amp; specs · Quint → Mermaid</span>
          <a
            href={`${GITHUB_REPO_BLOB}/models/workflow`}
            target="_blank"
            rel="noreferrer"
            className="doc-source-link"
          >
            <span>models/workflow/*.qnt</span>
            <ExternalLink size={12} />
          </a>
        </div>
        <h1 className="doc-title">Formal workflow models (Quint)</h1>
        <p className="doc-lead">
          The <code>ndev</code> issue and epic state machines are formally specified in{" "}
          <a href="https://quint-lang.org" target="_blank" rel="noreferrer">
            Quint
          </a>{" "}
          and checked in CI by <code>scripts/ci/formal-check.sh</code>. Every diagram, invariant and witness table on
          this page is generated directly from <code>models/workflow/*.qnt</code> at build time.
        </p>

        <div className="prose">
          <p>
            To print the generated Mermaid source from a terminal, run <code>npm run quint:mermaid</code> inside{" "}
            <code>docs-site/</code>. To typecheck and run all Quint simulation tests from the repository root, run{" "}
            <code>scripts/ci/formal-check.sh</code>.
          </p>
        </div>

        {models.map((model) => (
          <section key={model.slug} style={{ marginTop: 40 }}>
            <div className="prose">
              <h2 id={model.slug}>
                <code>{model.moduleName}</code>
              </h2>
              <p>
                Source:{" "}
                <a href={`${GITHUB_REPO_BLOB}/${model.sourcePath}`} target="_blank" rel="noreferrer">
                  <code>{model.sourcePath}</code>
                </a>
                . Verified instances:{" "}
                {model.instances.map((inst, i) => (
                  <span key={inst.name}>
                    {i > 0 ? ", " : ""}
                    <code>{inst.name}</code>
                  </span>
                ))}
                .
              </p>
            </div>

            {model.diagrams.map((diagram) => (
              <div key={diagram.id} id={diagram.id}>
                <MermaidBlock
                  title={diagram.title}
                  description={diagram.description}
                  mermaidSource={diagram.mermaid}
                  meta={`${diagram.states.length} states · ${diagram.transitions.length} edges`}
                />
              </div>
            ))}

            <div className="prose">
              <h3 id={`${model.slug}-invariants`}>Safety invariants and findings</h3>
              <p>
                Extracted from <code>val safety</code> and <code>val findings</code> in{" "}
                <code>{model.sourcePath}</code>.
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Invariant</th>
                    <th>Group</th>
                    <th>Quint predicate</th>
                  </tr>
                </thead>
                <tbody>
                  {model.invariants.map((inv) => (
                    <tr key={`${model.slug}-${inv.name}`}>
                      <td>
                        <code>{inv.name}</code>
                      </td>
                      <td>{inv.kind}</td>
                      <td>
                        <code>{inv.expression}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {model.instances.length > 0 ? (
                <>
                  <h3>Model configurations</h3>
                  <table>
                    <thead>
                      <tr>
                        <th>Module</th>
                        <th>Parameters</th>
                      </tr>
                    </thead>
                    <tbody>
                      {model.instances.map((inst) => (
                        <tr key={inst.name}>
                          <td>
                            <code>{inst.name}</code>
                          </td>
                          <td>
                            <code>{inst.params}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              ) : null}

              {model.witnesses.length > 0 ? (
                <>
                  <h3>Reachability witnesses ({model.witnesses.length})</h3>
                  <p>
                    {model.witnesses.map((w, i) => (
                      <span key={w}>
                        {i > 0 ? " · " : ""}
                        <code>{w}</code>
                      </span>
                    ))}
                  </p>
                </>
              ) : null}
            </div>
          </section>
        ))}

        <nav className="pager" aria-label="Pagination">
          <Link href="/guides/harnesses/" className="pager-link prev">
            <span className="pager-dir">Previous</span>
            <span className="pager-label">Claude Code, Codex and opencode</span>
          </Link>
          <Link href="/architecture/spec/" className="pager-link next">
            <span className="pager-dir">Next</span>
            <span className="pager-label">ndev 2.0 specification</span>
          </Link>
        </nav>
      </article>

      <Toc headings={headings} />
    </div>
  );
}
