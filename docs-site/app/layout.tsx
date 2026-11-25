import type { Metadata, Viewport } from "next";
import "./globals.css";
import { getNavigation } from "@/lib/docs";
import { Shell } from "./components/Shell";

export const metadata: Metadata = {
  title: {
    default: "ndev documentation",
    template: "%s · ndev docs",
  },
  description:
    "Documentation for ndev 2.0: the CLI, harness installer, Orca integration, formal Quint models, skills, agents and development knowledge base.",
};

export const viewport: Viewport = {
  colorScheme: "light dark",
};

const THEME_INIT_SCRIPT = `(function(){try{var s=localStorage.getItem('ndev-docs-theme');var d=(s==='dark'||s==='light')?s:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',d);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const nav = getNavigation();
  return (
    <html lang="en-GB" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <Shell nav={nav}>{children}</Shell>
      </body>
    </html>
  );
}
