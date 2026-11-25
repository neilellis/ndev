import { shellCode } from '../shell-code.ts'

export const RAW_GIT = /(?:^|[;&|(\n`'"\s/\\])git((?:\s+-[cC]\s+(?:"[^"]*"|'[^']*'|(?:\\\s|\S)+)|\s+--(?:git-dir|work-tree|namespace|exec-path|config-env|super-prefix)\s+(?:"[^"]*"|'[^']*'|\S+)|\s+--\S+|\s+-[a-zA-Z])*)\s+(commit|push)(?=[\s;&|)`'"<>]|$)/g
const HEREDOC_TEXT = /"\$\(cat <<-?\s*(?:'[^']*'|"[^"]*"|\\?[\w.-]+)\s*\)"/g
export const gitCode = (command: string) => shellCode(command).replace(HEREDOC_TEXT, '""')
export const OWN_WAIT = /\bgh\s+run\s+watch\b|\bgh\s+pr\s+checks\b[^\n;&|]*--watch/
export const CHECKS_WAIT = /\bndev(?:\s+--?[\w-]+(?:=\S+|\s+#?\d+)?)*\s+wait(?:\s+--?[\w-]+(?:=\S+|\s+#?\d+)?)*\s+checks(?:\s+--?[\w-]+(?:=\S+|\s+#?\d+)?)*\s+#?(\d+)/
const GIT_ENV = /\bGIT_(?:DIR|WORK_TREE|COMMON_DIR)\b/
const FOLDER_WORDS = /(?:^|[\s;&|(`'"])(?:cd|pushd|popd|chdir|exec|eval|source|if|for|while|until|case|then|do)(?=[\s;&|)`'"]|$)|(?:^|[\s;&|(`'"/])(?:ba|z|da|k)?sh(?=[\s;&|)`'"]|$)|(?:^|[;&|(\n`]\s*)\.\s|(?:^|[\s;&|(])env\s[^;&|\n]*(?:-C\b|--chdir\b)/
const NOT_PLAIN = /[;|&()\n{}`<>]|\$\(/
const ONLY_CD = /^\s*cd\s+("[^"]*"|'[^']*'|(?:\\\s|\S)+)\s*$/
const unquoted = (code: string) => code.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, w => (w[0] === '"' && /\$\(|`/.test(w) ? w : '""'))
const chain = (code: string) => {
  const parts = ['']
  for (const [word] of code.matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'|&&|[^"'&]+|[\s\S]/g)) {
    if (word === '&&') parts.push('')
    else parts[parts.length - 1] += word
  }
  return parts
}

const plainPath = (word: string, home: string | undefined) =>
  word.replace(/^["']|["']$/g, '').replace(/\\(\s)/g, '$1').replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home ?? '$&')

export function gitFolder(code: string, before: string, options: string, helperCwd: string | undefined, home: string | undefined): string | undefined {
  if (GIT_ENV.test(code)) return undefined
  const parts = [...options.matchAll(/\s+(-C\s+|--\S+)("[^"]*"|'[^']*'|(?:\\\s|\S)+)?/g)]
  if (parts.length > 1 || parts[0]?.[1]?.startsWith('--')) return undefined
  const named = parts[0] ? plainPath(parts[0][2] ?? '', home) : undefined
  if (named !== undefined) return named.startsWith('/') ? named : undefined
  if (!FOLDER_WORDS.test(unquoted(code))) return helperCwd
  let folder: string | undefined
  for (const part of chain(before)) {
    const plain = unquoted(part)
    if (NOT_PLAIN.test(plain)) return undefined
    const cd = part.match(ONLY_CD)
    if (cd) folder = plainPath(cd[1] ?? '', home)
    else if (FOLDER_WORDS.test(plain)) return undefined
  }
  if (folder !== undefined) return folder.startsWith('/') ? folder : undefined
  return helperCwd
}

export const pushNames = (words: string, wf: { branch: string; base: string }) => {
  if (/(?:^|\s)--(?:all|mirror|branches)(?=\s|$)|[*$`]/.test(words)) return true
  const names = words.split(/[\s:'"+]+/).map(w => w.replace(/^(?:refs\/)?heads\//, ''))
  return names.includes(wf.branch) || names.includes(wf.base)
}

const REDIRECTION = /\s(?:\d*>>?&?|&>>?|<)\s*[^\s;&|)]+/g
export function pushesOnly(tail: string, branch: string): boolean {
  const words = (tail.replace(REDIRECTION, ' ').split(/[;&|\n)]/)[0] ?? '').trim().split(/\s+/).filter(Boolean)
  const [remote, ...refs] = words.filter(word => word !== '-u' && word !== '--set-upstream')
  if (remote !== undefined && remote !== 'origin') return false
  return refs.every(ref => [branch, 'HEAD', `HEAD:${branch}`, `HEAD:refs/heads/${branch}`, `${branch}:${branch}`].includes(ref))
}
