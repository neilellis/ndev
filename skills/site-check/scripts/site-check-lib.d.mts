// Types for site-check-lib.mjs.
export type PageEvent = { kind: "pageerror" | "console" | "requestfailed" | "response"; text: string; status?: number };

export const SPIDER_PAGE_LIMIT: number;
export const BOT_BLOCK_CODES: number[];
export const PACKAGES: Record<"linkinator" | "@crawlee/puppeteer" | "puppeteer-core", string>;
export function installCommand(names: string[]): string;
export function loadFromProject(name: string, projectDir: string): any;
export function liveAddressPattern(liveUrl: string): RegExp;
export function seedFromBranch(branch: string): number;
export function seededRandom(seed: number): () => number;
export function shuffle<T>(items: T[], random: () => number): T[];
export function walkableLinks(hrefs: string[], origin: string): string[];
export function sitemapPages(xml: string, origin: string, livePattern?: RegExp): string[];
export function bypassHeaders(env: Record<string, string | undefined>): Record<string, string>;
export function isPageProblem(event: PageEvent): boolean;
export function summary(input: { tool: string; base: string; checked: string; problems: string[]; warnings: string[] }): string;
export function findChrome(env?: Record<string, string | undefined>): string | null;
