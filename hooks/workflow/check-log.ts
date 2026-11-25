// The log of a check script. $.process.run keeps the first 4 MiB of each stream, and $.fs.write takes
// at most 4 MiB, so a loud script fills the log past the limit unless the log is bounded here.
type Output = { stdout: string; stderr: string; isStdoutTruncated?: boolean; isStderrTruncated?: boolean }

// A UTF-16 unit is at most 3 bytes of UTF-8, so two streams of this length and their notes fit one write.
const KEEP = 650_000
const lastPart = (text: string) => (text.length <= KEEP ? text : `[cut: the first ${text.length - KEEP} characters of this stream are not in this log]\n${text.slice(-KEEP)}`)

export function outputCut(r: Output, path: string): string | undefined {
  if (!r.isStdoutTruncated && !r.isStderrTruncated) return undefined
  return `${path} printed more than 4 MiB on ${r.isStdoutTruncated ? 'stdout' : 'stderr'}, and the engine keeps only the first 4 MiB, so the lines here are not its last lines. Repair: make the script quieter, or run bash ${path} in a terminal and read its end.`
}

export function checkLog(r: Output, path: string): string {
  const cut = outputCut(r, path)
  return `${lastPart(r.stdout)}\n--- stderr\n${lastPart(r.stderr)}\n${cut ? `--- cut\n${cut}\n` : ''}`
}
