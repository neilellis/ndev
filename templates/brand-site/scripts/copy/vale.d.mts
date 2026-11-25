import type { Rules } from "./check-lib.mjs";
export const VALE_DIR: string;
export function buildVale(rules?: Rules): Record<string, Buffer>;
export function staleValeFiles(built?: Record<string, Buffer>): string[];
