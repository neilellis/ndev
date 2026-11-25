import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ARCHITECTURE_PAGES, getArchitecturePage } from "@/lib/docs";
import { DocArticle } from "@/app/components/DocArticle";

export function generateStaticParams() {
  return ARCHITECTURE_PAGES.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = getArchitecturePage(slug);
  if (!page) return {};
  return { title: page.title, description: page.description };
}

export default async function ArchitectureDocPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const page = getArchitecturePage(slug);
  if (!page) notFound();
  return <DocArticle page={page} />;
}
