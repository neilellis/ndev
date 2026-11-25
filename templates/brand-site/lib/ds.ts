import path from "node:path";

/** The design system lives in this repo, under public/ds, and is served at /ds. */
export const DS_DIR = path.join(process.cwd(), "public", "ds");
export const TOKENS_DIR = path.join(DS_DIR, "tokens");
