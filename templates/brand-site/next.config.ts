import type { NextConfig } from "next";
import createMDX from "@next/mdx";

const nextConfig: NextConfig = {
  // A fully static site: every page is prerendered into out/.
  output: "export",
  pageExtensions: ["ts", "tsx", "md", "mdx"],
  images: { unoptimized: true },
  // Keep `next dev` from editing AGENTS.md; it must stay identical to CLAUDE.md.
  agentRules: false,
  turbopack: { root: import.meta.dirname },
};

// remark-gfm enables pipe tables, strikethrough and task lists in MDX. It is passed
// as a string so Turbopack can serialise it.
const withMDX = createMDX({
  options: { remarkPlugins: [["remark-gfm"]] },
});

export default withMDX(nextConfig);
