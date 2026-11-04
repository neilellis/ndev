// The addresses the panes link to. Each is formed from a name and a number already held, so a link
// costs no GitHub call. A file link needs an absolute path.

export const fileUrl = (path: string): string => {
  if (!path.startsWith('/')) throw new Error(`A file link needs an absolute path, and this is ${JSON.stringify(path)}.`)
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`
}
export const pullUrl = (repo: string, number: number): string => `https://github.com/${repo}/pull/${number}`
export const issueUrl = (repo: string, number: number): string => `https://github.com/${repo}/issues/${number}`
export const repoUrl = (repo: string): string => `https://github.com/${repo}`
export const treeUrl = (repo: string, ref: string): string => `https://github.com/${repo}/tree/${ref.split('/').map(encodeURIComponent).join('/')}`
export const commitUrl = (repo: string, sha: string): string => `https://github.com/${repo}/commit/${sha}`
export const checksUrl = (repo: string, number: number): string => `${pullUrl(repo, number)}/checks`
