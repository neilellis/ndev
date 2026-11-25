import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getGuidePage, getGuides, getQuintModels } from "@/lib/docs";
import { DocArticle } from "@/app/components/DocArticle";
import { MermaidBlock } from "@/app/components/MermaidBlock";

export function generateStaticParams() {
  return getGuides().map((g) => ({ slug: g.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = getGuidePage(slug);
  if (!page) return {};
  return { title: page.title, description: page.description };
}

export default async function GuidePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = getGuidePage(slug);
  if (!page) notFound();

  const quintModels = slug === "workflows" || slug === "orca" ? getQuintModels() : [];
  const featuredDiagram =
    slug === "workflows"
      ? quintModels.find((m) => m.moduleName === "issue_workflow")?.diagrams[0]
      : slug === "orca"
        ? quintModels.find((m) => m.moduleName === "epic_workflow")?.diagrams[0]
        : undefined;

  return (
    <>
      <DocArticle page={page} />
      {featuredDiagram ? (
        <div className="doc-grid no-toc" style={{ paddingTop: 0 }}>
          <MermaidBlock
            title={`${featuredDiagram.title} (generated from Quint)`}
            description={featuredDiagram.description}
            mermaidSource={featuredDiagram.mermaid}
            meta={`${featuredDiagram.states.length} states · ${featuredDiagram.transitions.length} transitions`}
          />
        </div>
      ) : null}
    </>
  );
}
