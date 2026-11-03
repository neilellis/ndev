// Where a named secret is set. The answer gives the file and the line number, never the value, so
// the value does not reach the transcript.
export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export type SecretPlace = { path: string; line: number }

// The last assignment in a file wins, as it does in a shell. A comment or an empty value is not a secret.
export function findInText(name: string, text: string): number | undefined {
  const assignment = new RegExp(`^\\s*(?:export\\s+)?${name}=(.*)$`)
  let found: number | undefined
  text.split('\n').forEach((line, i) => {
    const value = assignment.exec(line)?.[1]?.trim()
    if (value && value !== '""' && value !== "''") found = i + 1
  })
  return found
}

export function secretFiles(top: string, main: string, home: string | undefined): string[] {
  const roots = top === main ? [top] : [top, main]
  return [
    ...roots.map(r => `${r}/.neil-dev.env`),
    ...roots.map(r => `${r}/.env`),
    ...(home ? [`${home}/.zshrc`, `${home}/.bashrc`] : []),
  ]
}
