import type { EngineInterface } from 'claude-code'

export const EXPORT_HARNESSES = ['codex', 'opencode', 'opencode2', 'antigravity']
export const EXPORT_ARGUMENT_HINT = 'export <codex|opencode|opencode2|antigravity> [--out <dir>] [--dry-run]'
export const EXPORT_HELP = [
  '  /dev export <harness> [--out <dir>] [--dry-run]   generate skills, agents and the ndev-flow CLI for another agent harness (codex, opencode, antigravity), then adapt and verify them',
]

type Summary = {
  harness: string
  home: string
  skillsDir: string
  agentsDir?: string | null
  skills: number
  agents: number
  files: number
  removed: number
  version: string
  generatedAt: string
  dryRun?: boolean
  flow?: string
  verify?: string | null
  verifyExpect?: string | null
  notes?: string | null
  leftovers: { total: number; file?: string; byConstruct: Record<string, number> }
}

const tail = (text: string) => text.trim().split('\n').slice(-20).join('\n')

function brief(s: Summary, args: string[]): string {
  const constructs = Object.entries(s.leftovers.byConstruct).map(([name, n]) => `${name} (${n})`).join(', ')
  return [
    `/dev export ${args.join(' ')} wrote the ndev plugin for the harness ${s.harness}. Adapt and verify it now, then report to the human.`,
    `Files: skills in ${s.skillsDir}, agents in ${s.agentsDir ?? '(none for this harness)'}, the workflow CLI ${s.flow}, and the support files in ${s.home}. ${s.home}/manifest.json lists each file the export owns.`,
    `1. Adapt. ${s.leftovers.file} lists ${s.leftovers.total} Claude-only constructs by file and line: ${constructs || 'none'}. For each one, edit the generated file so that it works in ${s.harness}: a construct that ${s.harness} has gets its name and syntax, and one it does not have gets the nearest way to do the same, or a plain statement that the step needs the human. Keep the generated stamp in each file: it tells a reader that the file is generated and when. manifest.json, not the stamp, tells the next export which files are its own, so do not rename or move a file.`,
    'The next /dev export overwrites these edits. When an edit is the same for many files, or for every harness, change the export rules in scripts/export/export.mjs of the plugin instead, and export again.',
    `Do not touch a file that the manifest does not list. Never change the harness's own settings or credentials.${s.notes ? ` What is known of ${s.harness}: ${s.notes}` : ''}`,
    `2. Verify. Run ${s.flow} help: it must exit 0.${s.verify ? ` Then run ${s.verify} and check that its output holds "${s.verifyExpect}" for each exported skill. A skill whose frontmatter sets disable-model-invocation: true is for the human to start, and the harness can leave it out of that list. If ${s.skillsDir} is not the folder that ${s.harness} reads, run it with HOME set to a new temporary folder in which that folder links to ${s.skillsDir}, and copy only the credentials file that the harness needs into it.` : ` ${s.harness} has no known check command: find one in its documentation, or say that the install is not verified.`}`,
    '3. Report: the number of constructs you adapted and the number left, with why; the verify command, its exit code and what it showed; and each change to the export rules.',
  ].join('\n')
}

export async function exportCommand($: EngineInterface, args: string): Promise<{ text: string; context?: string[] }> {
  const argv = args.trim().split(/\s+/).filter(Boolean)
  if (!argv[0] || argv[0].startsWith('--')) {
    return { text: `/dev export needs a harness: ${EXPORT_HARNESSES.join(', ')}. Another harness needs --skills-dir <the folder it reads skills from>. Usage: /dev ${EXPORT_ARGUMENT_HINT}` }
  }
  const script = `${$.plugin.root}/scripts/export/export.mjs`
  const ran = await $.process.run(['node', script, ...argv], { timeoutMs: 300_000 })
  if (ran.exitCode !== 0) {
    return { text: `/dev export ${argv.join(' ')}: node ${script} exited ${ran.exitCode}.\n${ran.stderr.trim() || tail(ran.stdout) || 'It printed nothing.'}` }
  }
  let s: Summary
  try {
    s = JSON.parse(ran.stdout)
  } catch {
    return { text: `/dev export ${argv.join(' ')}: node ${script} exited 0 but printed no JSON summary:\n${tail(ran.stdout) || 'It printed nothing.'}` }
  }
  const what = `${s.skills} skills in ${s.skillsDir}, ${s.agents} agents in ${s.agentsDir ?? '(none)'}, and the ndev-flow CLI and support files in ${s.home}`
  if (s.dryRun) return { text: `Dry run of /dev export ${argv.join(' ')}: it would write ${s.files} files: ${what}. ${s.leftovers.total} Claude-only constructs would need the adapter. Nothing was written.` }
  return {
    text: `Exported ndev ${s.version} for ${s.harness} on ${s.generatedAt}: ${what}.${s.removed ? ` Removed ${s.removed} files of an older export.` : ''} ${s.leftovers.total} Claude-only constructs are left for the adapter (${s.leftovers.file}). This session adapts and verifies them now.`,
    context: [brief(s, argv)],
  }
}
