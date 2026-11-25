import Link from "next/link";
import { ArrowRight, BookOpen, Cpu, GitBranch, Layers, Terminal, Workflow } from "lucide-react";
import { ARCHITECTURE_PAGES, getAgents, getGuides, getKbPagesMeta, getQuintModels, getSkills } from "@/lib/docs";

export default function HomePage() {
  const guides = getGuides();
  const skills = getSkills();
  const agents = getAgents();
  const kbPages = getKbPagesMeta();
  const quintModels = getQuintModels();
  const totalDiagrams = quintModels.reduce((acc, m) => acc + m.diagrams.length, 0);

  return (
    <div className="home-wrap">
      <section className="hero">
        <div className="hero-eyebrow">
          <Terminal size={15} />
          <span>ndev 2.0 documentation</span>
        </div>
        <h1>Structured workflows for terminals, agent harnesses and Orca.</h1>
        <p>
          <code>ndev</code> runs repeatable development workflows across Claude Code, Codex and opencode. It uses Orca
          for isolated worktrees, workers, browser captures and panels, and GitHub for issues, pull requests and checks.
        </p>
        <div className="hero-actions">
          <Link href="/guides/installation/" className="btn-primary">
            <span>Install ndev</span>
            <ArrowRight size={16} />
          </Link>
          <Link href="/guides/cli/" className="btn-secondary">
            <span>CLI reference</span>
          </Link>
          <Link href="/architecture/formal-models/" className="btn-secondary">
            <span>Quint workflow diagrams</span>
          </Link>
        </div>

        <pre className="quick-install">
          <code>{`bin/ndev install all --dry-run\nbin/ndev install all\nndev install verify all`}</code>
        </pre>
      </section>

      <section className="stat-row" aria-label="Documentation summary">
        <div className="stat-box">
          <div className="stat-num">15</div>
          <div className="stat-label">CLI command groups</div>
        </div>
        <div className="stat-box">
          <div className="stat-num">{skills.length}</div>
          <div className="stat-label">Installable skills</div>
        </div>
        <div className="stat-box">
          <div className="stat-num">{agents.length}</div>
          <div className="stat-label">Subagent definitions</div>
        </div>
        <div className="stat-box">
          <div className="stat-num">{kbPages.length}</div>
          <div className="stat-label">Knowledge base guides</div>
        </div>
        <div className="stat-box">
          <div className="stat-num">{totalDiagrams}</div>
          <div className="stat-label">Quint-derived diagrams</div>
        </div>
      </section>

      <h2 style={{ margin: "0 0 8px", color: "var(--text-heading)", fontSize: "1.35rem" }}>Start with the guides</h2>
      <p style={{ margin: "0 0 18px", color: "var(--text-muted)" }}>
        Every command and flag is verified against the repository&apos;s CLI and specification.
      </p>
      <div className="card-grid">
        {guides.map((guide) => (
          <Link key={guide.slug} href={guide.href} className="card">
            <span className="card-kicker">Guide</span>
            <span className="card-title">{guide.title}</span>
            <span className="card-desc">{guide.description}</span>
          </Link>
        ))}
      </div>

      <h2 style={{ margin: "32px 0 8px", color: "var(--text-heading)", fontSize: "1.35rem" }}>
        Reference and living repository docs
      </h2>
      <p style={{ margin: "0 0 18px", color: "var(--text-muted)" }}>
        Generated directly from <code>models/</code>, <code>skills/</code>, <code>agents/</code>, <code>kb/</code> and{" "}
        <code>docs/ndev-2/</code> on every build so documentation stays in sync with code.
      </p>
      <div className="card-grid">
        <Link href="/architecture/formal-models/" className="card">
          <span className="card-kicker" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Workflow size={13} /> Quint → Mermaid
          </span>
          <span className="card-title">Formal workflow models</span>
          <span className="card-desc">
            Interactive Mermaid state diagrams and safety invariants generated straight from{" "}
            <code>models/workflow/*.qnt</code>.
          </span>
        </Link>
        <Link href="/skills/" className="card">
          <span className="card-kicker" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Layers size={13} /> {skills.length} skills
          </span>
          <span className="card-title">Skills index</span>
          <span className="card-desc">
            Filterable catalogue of every skill installed as <code>ndev-&lt;name&gt;</code> in Claude Code, Codex and
            opencode.
          </span>
        </Link>
        <Link href="/agents/" className="card">
          <span className="card-kicker" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Cpu size={13} /> {agents.length} agents
          </span>
          <span className="card-title">Agents index</span>
          <span className="card-desc">
            Subagent roles, models, tool boundaries and worktree isolation rules.
          </span>
        </Link>
        <Link href="/kb/" className="card">
          <span className="card-kicker" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <BookOpen size={13} /> {kbPages.length} guides
          </span>
          <span className="card-title">Knowledge base</span>
          <span className="card-desc">
            Project-neutral engineering rules covering core beliefs, testing, guards, CI, Git worktrees and writing
            style.
          </span>
        </Link>
        {ARCHITECTURE_PAGES.slice(0, 2).map((arch) => (
          <Link key={arch.slug} href={arch.href} className="card">
            <span className="card-kicker" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <GitBranch size={13} /> Architecture
            </span>
            <span className="card-title">{arch.title}</span>
            <span className="card-desc">{arch.description}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
