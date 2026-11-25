import type { Metadata } from "next";
import Link from "next/link";
import { getAgents, getAgentsIndexRendered } from "@/lib/docs";

export const metadata: Metadata = {
  title: "Agents",
  description: "Subagent definitions for Ready-board and issue workflows.",
};

export default function AgentsIndexPage() {
  const agents = getAgents();
  const readme = getAgentsIndexRendered();

  return (
    <div className="doc-grid no-toc">
      <article className="doc-main">
        <div className="doc-eyebrow">
          <span>Agents · {agents.length} subagent roles</span>
        </div>
        <h1 className="doc-title">Agents</h1>
        <p className="doc-lead">
          Skills define the method; agents configure the model, tools, isolation and preloaded skills for one role.
        </p>

        <div className="card-grid">
          {agents.map((agent) => (
            <Link key={agent.slug} href={agent.href} className="card">
              <span className="card-kicker">{agent.model ? `Model: ${agent.model}` : "Subagent"}</span>
              <span className="card-title">{agent.name}</span>
              <span className="card-desc">{agent.description}</span>
            </Link>
          ))}
        </div>

        <div className="prose" dangerouslySetInnerHTML={{ __html: readme.html }} />
      </article>
    </div>
  );
}
