// What a Bash call runs, without the text that it only passes on. A hook that looks for `git push`
// reads this, so the words in a test, a commit message or a grep do not count as a push.
// This reads the command as the shell does: quotes, escapes, comments, heredocs and command
// substitutions. A pattern over the raw text cannot, as an apostrophe in a comment would hide the next line.

const OPENER = /<<(-?)\s*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([\w.-]+))/y
const NAMES_GIT = /\bgit\b|\bpush[\w-]*\.sh\b|wait-for-(?:pr-change|run)\.sh|\bgh\s+(?:run\s+watch|pr\s+checks)\b/
const SHELL = '(?:ba|z|da|k)?sh'
// The word after these runs. For other programs, a word after -c or -e is a count or a pattern.
const RUNS_NEXT = new RegExp(`(?:^|[\\s;&|(/\`])(?:(?:${SHELL}|python[\\d.]*|node|bun|deno|perl|ruby)(?:\\s+-[a-zA-Z-]+)*\\s+-[a-zA-Z]*[ce](?:\\s+--)?|eval|${SHELL}\\s*<<<)\\s*$`)
// The word after these is a folder, which the guard reads.
const FOLDER_NEXT = /(?:\s-C|(?:^|[\s;&|(])cd)\s+$/
// A word here is the command, or the script that a shell runs.
const COMMAND_PLACE = new RegExp(`(?:^\\s*|[;&|(\\n\`]\\s*|(?:^|\\s)(?:${SHELL}|source|\\.)\\s+)$`)
// A shell reads what this line prints.
const PIPES_TO_SHELL = new RegExp(`\\|(?:[^|;&\\n]*[\\s/])?\\s*(?:${SHELL}|source)(?=[\\s;&|)]|$)`)
// A shell can read the heredoc of this line: it is named on the line, or the line ends in a pipe to the next command.
// A plain dot is a source only as the command, as `git add .` holds one too.
const FEEDS_SHELL = new RegExp(`(?:^|[\\s;&|("/])(?:${SHELL}|eval|source)(?=[\\s;&|)<]|$)|(?:^|[;&|(]\\s*)\\.\\s|\\|\\s*$`)

type Heredoc = { tag: string; tabs: boolean; quoted: boolean; line: string }

const quotedWord = (prior: string, raw: string, inner: string, substitutions: string[], line: string) => {
  if (RUNS_NEXT.test(prior) || FOLDER_NEXT.test(prior) || PIPES_TO_SHELL.test(line)) return raw
  if (substitutions.length) return `"${substitutions.join(' ')}"`
  if (!NAMES_GIT.test(raw)) return raw
  return COMMAND_PLACE.test(prior) ? inner : '""'
}

const moreCasesThanEnds = (text: string) => (text.match(/\bcase\b/g)?.length ?? 0) > (text.match(/\besac\b/g)?.length ?? 0)

export const shellCode = (command: string): string => {
  const src = command
  let at = 0

  const lineAt = (from: number) => {
    const end = src.indexOf('\n', from)
    return src.slice(src.lastIndexOf('\n', from - 1) + 1, end < 0 ? src.length : end)
  }

  // The body of a heredoc starts at `at`. With no end line, the shell may read on, so nothing is dropped.
  const heredocBody = (doc: Heredoc): string => {
    let start = at
    while (start < src.length) {
      const next = src.indexOf('\n', start)
      const stop = next < 0 ? src.length : next
      const text = src.slice(start, stop)
      if ((doc.tabs ? text.replace(/^\t+/, '') : text) === doc.tag) {
        const body = src.slice(at, start)
        at = next < 0 ? src.length : next + 1
        if (FEEDS_SHELL.test(doc.line)) return `${shellCode(body)}\n`
        // With no quotes on the tag, the shell runs the substitutions in the body.
        if (doc.quoted || !/\$\(|`/.test(body)) return ''
        return `${shellCode(`: "${body.replace(/\\?"/g, '\\"')}"`)}\n`
      }
      start = stop + 1
    }
    return ''
  }

  const run = (closer?: ')' | '`'): string => {
    let out = ''
    let depth = 0
    let pending: Heredoc[] = []
    let escapedTo = -1
    while (at < src.length) {
      const c = src[at]
      if (src.startsWith('\\\n', at)) {
        // The shell joins the lines.
        at += 2
      } else if (c === '\\') {
        out += src.slice(at, at + 2)
        at += 2
        escapedTo = at
      } else if (closer === '`' && c === '`') {
        at++
        return out
      } else if (closer === ')' && c === ')' && depth === 0 && !moreCasesThanEnds(out)) {
        at++
        return out
      } else if (src.startsWith("$'", at)) {
        // A $'..' word has escapes, so \\' does not end it.
        let end = at + 2
        while (end < src.length && src[end] !== "'") end += src[end] === '\\' ? 2 : 1
        if (end >= src.length) {
          const rest = src.slice(at)
          at = src.length
          return out + rest
        }
        out += quotedWord(out, src.slice(at, end + 1), src.slice(at + 2, end), [], lineAt(at))
        at = end + 1
      } else if (src.startsWith('${', at)) {
        // A # or a quote in here is no comment and no word. All of it stays.
        out += '${'
        at += 2
        for (let open = 1; at < src.length && open > 0; ) {
          if (src[at] === '\\') {
            out += src.slice(at, at + 2)
            at += 2
          } else if (src.startsWith('$(', at)) {
            at += 2
            out += `$(${run(')')})`
          } else if (src[at] === '`') {
            at++
            out += `\`${run('`')}\``
          } else {
            if (src[at] === '{') open++
            if (src[at] === '}') open--
            out += src[at]
            at++
          }
        }
      } else if (c === "'") {
        const end = src.indexOf("'", at + 1)
        // An open quote: the shell's reading is not known, so the rest stays.
        if (end < 0) {
          const rest = src.slice(at)
          at = src.length
          return out + rest
        }
        out += quotedWord(out, src.slice(at, end + 1), src.slice(at + 1, end), [], lineAt(at))
        at = end + 1
      } else if (c === '"') {
        const start = at++
        const substitutions: string[] = []
        while (at < src.length && src[at] !== '"') {
          if (src[at] === '\\') at += 2
          else if (src.startsWith('$(', at)) {
            at += 2
            substitutions.push(`$(${run(')')})`)
          } else if (src[at] === '`') {
            at++
            substitutions.push(`\`${run('`')}\``)
          } else at++
        }
        if (at >= src.length) return out + src.slice(start)
        at++
        const raw = src.slice(start, at)
        out += quotedWord(out, raw, raw.slice(1, -1), substitutions, lineAt(start))
      } else if (c === '`') {
        at++
        out += `\`${run('`')}\``
      } else if (src.startsWith('$(', at)) {
        at += 2
        out += `$(${run(')')})`
      } else if (c === '#' && at !== escapedTo && (at === 0 || /[\s;&|(]/.test(src[at - 1] ?? ''))) {
        const line = src.indexOf('\n', at)
        // A backtick ends the substitution, and the comment in it.
        const tick = closer === '`' ? src.indexOf('`', at) : -1
        const end = line < 0 ? tick : tick < 0 ? line : Math.min(line, tick)
        at = end < 0 ? src.length : end
      } else if (src.startsWith('<<<', at)) {
        out += '<<<'
        at += 3
      } else if (src.startsWith('<<', at)) {
        OPENER.lastIndex = at
        const opener = OPENER.exec(src)
        // A number is a shift, as in ((a=1<<2)).
        if (opener && !/^\d+$/.test(opener[4] ?? '')) {
          pending.push({ tag: opener[2] ?? opener[3] ?? opener[4] ?? '', tabs: !!opener[1], quoted: opener[4] === undefined || opener[0].includes('\\'), line: lineAt(at) })
          out += opener[0]
          at += opener[0].length
        } else {
          out += '<<'
          at += 2
        }
      } else if (c === '\n') {
        out += c
        at++
        for (const doc of pending) out += heredocBody(doc)
        pending = []
      } else {
        if (c === '(') depth++
        if (c === ')') depth--
        out += c
        at++
      }
    }
    return out
  }

  return run()
}
