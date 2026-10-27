export interface NavItem {
  label: string;
  href: string;
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  {
    label: "",
    items: [
      { label: "Core principles", href: "/core-principles" },
      { label: "Overview", href: "/" },
      { label: "Tokens", href: "/tokens" },
    ],
  },
  {
    label: "Foundations",
    items: [
      { label: "Colour", href: "/foundations/colour" },
      { label: "Typography", href: "/foundations/typography" },
      { label: "Space & layout", href: "/foundations/layout" },
      { label: "Depth & motion", href: "/foundations/depth-motion" },
      { label: "Photography", href: "/foundations/photography" },
      { label: "Logo", href: "/foundations/logo" },
    ],
  },
  {
    label: "System",
    items: [
      { label: "Diagrams & motifs", href: "/diagrams" },
      { label: "Iconography", href: "/iconography" },
      { label: "Patterns", href: "/patterns" },
      { label: "Infographics", href: "/infographics" },
      { label: "Components", href: "/components" },
      { label: "Page sections", href: "/sections" },
      { label: "UI kit", href: "/ui-kit" },
      { label: "Accessibility", href: "/accessibility" },
      { label: "Governance", href: "/governance" },
    ],
  },
  {
    label: "UX principles",
    items: [
      { label: "Heuristics & laws", href: "/ux/heuristics" },
      { label: "Visual hierarchy", href: "/ux/visual-hierarchy" },
      { label: "Progressive disclosure", href: "/ux/progressive-disclosure" },
      { label: "Navigation", href: "/ux/navigation" },
      { label: "Input & touch", href: "/ux/input-and-touch" },
      { label: "Feedback & performance", href: "/ux/feedback-and-performance" },
    ],
  },
  {
    label: "Animation",
    items: [
      { label: "Principles", href: "/animation/principles" },
      { label: "Patterns", href: "/animation/patterns" },
    ],
  },
  {
    label: "Responsive & mobile",
    items: [
      { label: "Responsive design", href: "/responsive" },
      { label: "Breakpoints", href: "/responsive/breakpoints" },
      { label: "Mobile", href: "/mobile" },
    ],
  },
  {
    label: "Copy",
    items: [
      { label: "Writing rules", href: "/copy" },
      { label: "Voice", href: "/voice" },
      { label: "Documentation & agents", href: "/copy/simple-english" },
      { label: "Banned words", href: "/copy/banned" },
      { label: "Copy checklist", href: "/copy/checklist" },
      { label: "Vale rules", href: "/copy/vale" },
    ],
  },
  {
    label: "Video",
    items: [
      { label: "Film overview", href: "/video" },
      { label: "Structure & pacing", href: "/video/structure" },
      { label: "Scenes & look", href: "/video/scenes" },
      { label: "On-screen type & captions", href: "/video/captions" },
      { label: "Narration", href: "/video/narration" },
      { label: "Motion", href: "/video/motion" },
      { label: "Footage & credits", href: "/video/footage" },
      { label: "Generation prompts", href: "/video/prompts" },
      { label: "Review checklist", href: "/video/review" },
    ],
  },
];
