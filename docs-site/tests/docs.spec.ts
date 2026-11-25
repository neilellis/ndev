import { describe, expect, it } from "vitest";
import {
  ARCHITECTURE_PAGES,
  getAgents,
  getGuides,
  getKbPagesMeta,
  getNavigation,
  getQuintModels,
  getSkills,
  REPO_ROOT,
} from "../lib/docs";
import { renderMarkdown, rewriteMarkdownHref } from "../lib/markdown";
import { loadQuintModels } from "../lib/quint-to-mermaid";

describe("Quint -> Mermaid generator", () => {
  it("parses issue_workflow.qnt and epic_workflow.qnt with diagrams, invariants and witnesses", () => {
    const models = loadQuintModels(REPO_ROOT);
    const names = models.map((m) => m.moduleName);
    expect(names).toContain("issue_workflow");
    expect(names).toContain("epic_workflow");

    const issue = models.find((m) => m.moduleName === "issue_workflow")!;
    expect(issue.diagrams.length).toBeGreaterThanOrEqual(2);
    expect(issue.diagrams[0].mermaid).toContain("stateDiagram-v2");
    expect(issue.diagrams[0].mermaid).toContain("setup --> interviewing");
    expect(issue.diagrams[0].mermaid).toContain("finishing --> done");
    expect(issue.invariants.filter((i) => i.kind === "safety").length).toBeGreaterThanOrEqual(10);
    expect(issue.witnesses.length).toBeGreaterThanOrEqual(15);

    const epic = models.find((m) => m.moduleName === "epic_workflow")!;
    expect(epic.diagrams.length).toBe(2);
    expect(epic.diagrams[0].mermaid).toContain("framing --> researching");
    expect(epic.diagrams[0].mermaid).toContain("closing --> done");
    expect(epic.diagrams[1].mermaid).toContain("implementing --> reviewing");
    expect(epic.diagrams[1].mermaid).toContain("verified --> merged");
    expect(epic.invariants.filter((i) => i.kind === "safety").length).toBeGreaterThanOrEqual(8);
  });
});

describe("Docs content loaders", () => {
  it("loads all curated guides, skills, agents, KB pages, architecture pages and Quint models", () => {
    expect(getGuides().length).toBeGreaterThanOrEqual(7);
    expect(getSkills().length).toBeGreaterThanOrEqual(50);
    expect(getAgents().length).toBeGreaterThanOrEqual(5);
    expect(getKbPagesMeta().length).toBeGreaterThanOrEqual(20);
    expect(ARCHITECTURE_PAGES.length).toBe(6);
    expect(getQuintModels().length).toBe(2);

    const nav = getNavigation();
    expect(nav.length).toBe(4);
  });

  it("rewrites repository-relative markdown links into internal docs routes", () => {
    expect(rewriteMarkdownHref("core-beliefs.md#11-forget-history", "kb/writing.md")).toBe(
      "/kb/core-beliefs/#11-forget-history",
    );
    expect(rewriteMarkdownHref("../skills/adversarial-review/SKILL.md", "kb/writing.md")).toBe(
      "/skills/adversarial-review/",
    );
    expect(rewriteMarkdownHref("parity.md", "docs/ndev-2/spec.md")).toBe("/architecture/parity/");
    expect(rewriteMarkdownHref("work-light/SKILL.md", "skills/README.md")).toBe("/skills/work-light/");
    expect(rewriteMarkdownHref("../kb/workflow.md", "agents/README.md")).toBe("/kb/workflow/");
  });

  it("extracts headings and renders markdown tables cleanly", () => {
    const out = renderMarkdown("# Title\n\nIntro paragraph.\n\n## Section one\n\n| A | B |\n|---|---|\n| 1 | 2 |\n");
    expect(out.title).toBe("Title");
    expect(out.headings).toEqual([{ id: "section-one", text: "Section one", level: 2 }]);
    expect(out.html).toContain("<table>");
  });
});
