// iNeedA: the agent asks for guidance. Haiku answers from the plugin's lists, so that a project keeps to
// a small set of libraries and components. It is guidance: the agent can still choose something else.
import type { EngineInterface } from 'claude-code'

import type { LoadedConfig } from '../config'
import { Refuse, run, said } from './effects'

export const NEED_KINDS = ['react-component', 'library', 'brand-style', 'animation'] as const
const SOURCE_CHARS = 60_000
type Source = { name: string; text: string }

const RULES: Record<string, string> = {
  'react-component': 'Find the component type in the component map. Name the source and the registry item, with its install command. The project\'s own design system comes first.',
  library: 'Prefer a dependency that the project has already. Then prefer the approved list. Give the install command and the home page.',
  'brand-style': 'Quote the exact token, value or rule that answers the question, and name the file or page it comes from. If the brand does not decide this, say so, and name the closest token.',
  animation: 'First say the size of the animation that suits this use: a micro-interaction, a simple animation or a full showy animation. Then give the idea: the trigger, the movement, the duration and easing, the tool, and what reduced motion does.',
}

async function pluginFile($: EngineInterface, path: string): Promise<Source> {
  return { name: `${$.plugin.root}/${path}`, text: await $.fs.read(`${$.plugin.root}/${path}`) }
}

// Brand tokens from the local source of the brand site. No folder or no tokens gives an empty list.
async function brandFiles($: EngineInterface, project: LoadedConfig | undefined): Promise<Source[]> {
  const path = project?.config.branding?.path
  if (!project || !path) return []
  const folder = `${project.root}/${path}/public/ds`
  const found = await run($, ['find', folder, '-name', '*.css'], { cwd: project.root, timeoutMs: 20_000 })
  if (found.exitCode !== 0) return []
  const names = found.stdout.split('\n').filter(Boolean).slice(0, 20)
  const out: Source[] = []
  for (const name of names) out.push({ name, text: await $.fs.read(name) })
  return out
}

async function brandSources($: EngineInterface, project: LoadedConfig | undefined): Promise<Source[]> {
  const local = await brandFiles($, project)
  if (local.length) return local
  const url = project?.config.branding?.guide ?? project?.config.branding?.site
  if (!url) throw new Refuse('This project has no brand: .ndev.json has no "branding". Use the /brand create skill to make one, or choose with your own judgement.')
  const page = await run($, ['curl', '-sSL', '--fail', '--max-time', '20', url], { cwd: project?.root ?? $.plugin.root, timeoutMs: 30_000 })
  if (page.exitCode !== 0) throw new Refuse(`The brand page ${url} was not read: curl exited ${page.exitCode}: ${said(page)}. Set branding.path in .ndev.json to read a local copy.`)
  return [{ name: url, text: page.stdout }]
}

async function projectDependencies($: EngineInterface, project: LoadedConfig | undefined): Promise<Source[]> {
  if (!project) return []
  const out: Source[] = []
  for (const file of ['package.json', 'pyproject.toml']) {
    const path = `${project.root}/${file}`
    if (await $.fs.exists(path)) out.push({ name: path, text: await $.fs.read(path) })
  }
  return out
}

async function sourcesFor($: EngineInterface, kind: string, project: LoadedConfig | undefined): Promise<Source[]> {
  switch (kind) {
    case 'react-component': return [await pluginFile($, 'kb/ui-components.md')]
    case 'library': return [await pluginFile($, 'kb/libraries.md'), ...(await projectDependencies($, project))]
    case 'brand-style': return brandSources($, project)
    case 'animation': return [await pluginFile($, 'skills/motion/SKILL.md'), await pluginFile($, 'skills/motion/references/delight.md'), ...(await brandFiles($, project))]
    default: throw new Refuse(`Refused: "${kind}" is not a kind. The kinds are ${NEED_KINDS.join(', ')}.`)
  }
}

export async function iNeedA($: EngineInterface, kind: string, description: string, project: LoadedConfig | undefined): Promise<string> {
  const sources = await sourcesFor($, kind, project)
  const names = sources.map(s => s.name).join(', ')
  const result = await $.model.complete({
    model: 'haiku',
    maxTokens: 800,
    system: `You guide a coding agent that needs a ${kind}. Answer only from the sources you get. Give at most three suggestions, the best first, in short lines. For each, say what it is, where to get it and why it fits. ${RULES[kind]} If nothing in the sources fits, say that plainly. Do not invent a name, a URL or a value.`,
    prompt: `${sources.map(s => `<source name="${s.name}">\n${s.text.slice(0, SOURCE_CHARS)}\n</source>`).join('\n')}\n\nThe agent needs: ${description}`,
  })
  if (!result.isAnswered) {
    const why = result.reason === 'api-error' ? `api-error ${result.status ?? ''} ${result.error ?? ''}`.trim() : result.reason
    throw new Refuse(`iNeedA got no answer from the model (${why}). Read the sources yourself: ${names}`)
  }
  return `${result.text.trim()}\n\nFrom: ${names}\nThis is guidance, not a rule. If none of it fits, choose for yourself and say why in the PR.`
}
