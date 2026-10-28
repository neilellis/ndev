// A complete .walk-doc.json for the walk-doc tests: every required key, with project-neutral values.

export const FIXTURE = {
  devCommand: ['pnpm', '--dir', 'apps/docs', 'dev', '-p', '{port}'],
  contentRoot: 'apps/docs/content',
  deny: ['apps', 'docs', 'scripts', 'config'],
  finish: ['node scripts/check-docs.mjs'],
  media: 'Casts go in public/recordings.',
  issues: 'gh issue create --title <title> --body-file <file>',
}

export const REQUIRED_KEYS = ['devCommand', 'contentRoot', 'deny', 'finish', 'media', 'issues'] as const

// The fixture as file text, with keys changed or added.
export const fixture = (over: Record<string, unknown> = {}) => JSON.stringify({ ...FIXTURE, ...over })

// The fixture as file text, without one key.
export function fixtureWithout(key: string): string {
  const o: Record<string, unknown> = { ...FIXTURE }
  delete o[key]
  return JSON.stringify(o)
}

// The optional keys a project such as one with Linux install docs sets.
export const MACHINES = {
  guide: ['If the docs describe a Linux install, use a fresh VM: `vm create <name>`, then `vm run <name> <command>`.'],
  cleanup: 'vm list | grep "^{prefix}" | xargs -r vm delete',
}
