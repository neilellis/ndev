export interface Finding { line: number; level: "ban" | "flag"; term: string; match: string; instead: string; group: string }
export interface Rules { words: { term: string }[]; constructions: unknown[]; groups: unknown[]; sources: Record<string, string> }
export const RULES_PATH: string;
export type Register = "internal" | "marketing" | "documentation" | "technical-documentation" | "agent";
export const REGISTERS: Register[];
export const PROSE_EXTENSIONS: string[];
export function loadRules(file?: string): Rules;
export function proseOf(text: string): string;
export function checkText(text: string, options?: { register?: Register; rules?: Rules }): Finding[];
export function validateRules(rules: Rules): string[];
