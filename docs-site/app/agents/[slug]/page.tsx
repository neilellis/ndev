import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAgentPage, getAgents } from "@/lib/docs";
import { DocArticle } from "@/app/components/DocArticle";

export function generateStaticParams() {
  return getAgents().map((a) => ({ slug: a.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = getAgentPage(slug);
  if (!page) return {};
  return { title: page.title, description: page.description };
}

export default async function AgentPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = getAgentPage(slug);
  if (!page) notFound();
  return <DocArticle page={page} />;
}
