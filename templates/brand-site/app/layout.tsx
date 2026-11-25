import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Sidebar } from "./components/Sidebar";

export const metadata: Metadata = {
  title: { default: "{{name}} brand guide", template: "%s · {{name}} brand guide" },
  description: "The {{name}} design system and brand guide, for the website, documents and film.",
  robots: { index: false, follow: false },
};

// <meta name="color-scheme" content="light dark">: the browser paints the canvas in the
// reader's scheme before the stylesheet loads. The tokens follow the same scheme.
export const viewport: Viewport = { colorScheme: "light dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <head>
        {/* The design system's own stylesheet styles this guide. */}
        <link rel="stylesheet" href="/ds/styles.css" />
      </head>
      <body>
        <a className="skip-link" href="#content">Skip to content</a>
        <div className="shell">
          <Sidebar />
          <main className="content" id="content">{children}</main>
        </div>
      </body>
    </html>
  );
}
