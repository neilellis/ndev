import type { Metadata } from "next";
import { getSkills, getSkillsIndexRendered } from "@/lib/docs";
import { SkillExplorer } from "@/app/components/SkillExplorer";

export const metadata: Metadata = {
  title: "Skills index",
  description: "Search and browse every skill installed by ndev as ndev-<name> across Claude Code, Codex and opencode.",
};

export default function SkillsIndexPage() {
  const skills = getSkills();
  const readme = getSkillsIndexRendered();

  return (
    <div className="doc-grid no-toc">
      <article className="doc-main">
        <div className="doc-eyebrow">
          <span>Skills · {skills.length} installable skills</span>
        </div>
        <h1 className="doc-title">Skills index</h1>
        <p className="doc-lead">
          Each folder under <code>skills/</code> installs as <code>ndev-&lt;name&gt;</code> in Claude Code (
          <code>/ndev-&lt;name&gt;</code>), Codex (<code>$ndev-&lt;name&gt;</code>) and opencode.
        </p>

        <SkillExplorer skills={skills} />

        <div className="prose" style={{ marginTop: 40 }}>
          <h2>Choosing between related skills</h2>
          <div dangerouslySetInnerHTML={{ __html: readme.html }} />
        </div>
      </article>
    </div>
  );
}
