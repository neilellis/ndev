import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getKbPage, getKbPagesMeta } from "@/lib/docs";
import { DocArticle } from "@/app/components/DocArticle";

export function generateStaticParams() {
  return getKbPagesMeta().map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = getKbPage(slug);
  if (!page) return {};
  return { title: page.title, description: page.description };
}

export default async function KbDocPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const page = getKbPage(slug);
  if (!page) notFound();
  return <DocArticle page={page} />;
}
