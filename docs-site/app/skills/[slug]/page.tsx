import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSkillPage, getSkills } from "@/lib/docs";
import { DocArticle } from "@/app/components/DocArticle";

export function generateStaticParams() {
  return getSkills().map((s) => ({ slug: s.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = getSkillPage(slug);
  if (!page) return {};
  return { title: page.title, description: page.description };
}

export default async function SkillPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = getSkillPage(slug);
  if (!page) notFound();
  return <DocArticle page={page} />;
}
