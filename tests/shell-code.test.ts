import { expect, test } from 'claude-code/testing'
import { isPush } from '../hooks/learn'
import { shellCode } from '../hooks/shell-code'

for (const command of [
  'git push',
  'git -C /a/b push origin HEAD',
  'git -C "/a dir" push',
  'cd /x && git push -u origin main',
  'scripts/push-checked.sh',
  "bash -c 'git push'",
  'eval "git push"',
  'x="$(git push)"',
  "bash <<'EOF'\ngit push\nEOF",
  "bash <<'A'\ncd /x\nsh <<'B'\ngit push\nB\nA",
  "cat <<'EOF'\nnever ended, so the shell may run git push",
  // An apostrophe in a comment, or an escaped quote, opens no quoted word.
  "ls # don't do this\ngit push\necho done # it's fine",
  "echo it\\'s; git push; echo \\'x\\'",
  'echo \\"; git push; echo "x"',
  // A heredoc that feeds a shell in another way than the command before it.
  "cat <<'EOF' | bash\ngit push\nEOF",
  "cat <<'EOF' | sh -s\ngit push\nEOF",
  "eval \"$(cat <<'EOF'\ngit push\nEOF\n)\"",
  "source /dev/stdin <<'EOF'\ngit push\nEOF",
  ". /dev/stdin <<'EOF'\ngit push\nEOF",
  "cat <<'EOF' |\ngit push\nEOF\nbash",
  // Text that looks like a heredoc, but is not one, hides no line.
  'ls # see <<EOF\ngit push\nEOF',
  'echo "<<X"\ngit push\nX',
  // A quoted word in the place of the command runs.
  '"$CLAUDE_PLUGIN_ROOT/scripts/github/push-checked.sh" --x',
  'bash "scripts/push-checked.sh"',
  "'./push.sh'",
  '"git" push',
  // A command substitution runs in a quoted word too.
  'echo "`git push`"',
  'echo "on $(git push)"',
  // More shapes that run.
  'cat <<EOF\n$(git push)\nEOF',
  'cat <<EOF\n`git push`\nEOF',
  "bash<<'EOF'\ngit push\nEOF",
  "bash <<< 'git push'",
  "echo 'git push' | sh",
  "bash -c -- 'git push'",
  'echo ${x%% #*}; git push',
  'echo a\\ #b; git push',
  'echo `echo hi # note`; git push',
  "echo $'a\\'b'; git push; echo 'c'",
  '((a=1<<2))\ngit push\n2',
  'git \\\n  push origin HEAD',
  'git push --dry-run && git push',
  'rsync --dry-run a b; git push',
  'x="$(case y in y) git push;; esac)"',
]) {
  test(`a real push counts: ${JSON.stringify(command)}`, () => {
    expect(isPush(command)).toBe(true)
  })
}

for (const command of [
  "python3 - <<'PY'\ns='git push origin HEAD'\nPY",
  "cat > a.test.ts <<'EOF'\nawait hookCall($, 'Bash', { command: 'git push' })\nEOF",
  "bash <<'A'\npython3 - <<'B'\nrun('git push')\nB\necho done\nA",
  "cat <<-EOF\n\tgit push\n\tEOF",
  'grep -n "git push" README.md',
  "git commit -m 'never git push by hand'",
  'echo "use git push here"',
  '# git push\nls',
  'git push --dry-run',
  "git commit -m \"$(cat <<'EOF'\nnever git push\nEOF\n)\"",
  'echo "see git push on $(date)"',
  'ls # git push',
  // A pattern or a file name, and a heredoc on a line that holds a plain dot.
  "cd /w && git add . && git commit -m \"$(cat <<'EOF'\nnever git push by hand\nEOF\n)\"",
  "sed -e 's/git push/x/' f",
  'grep -e "git push" README.md',
  'cat scripts/github/push-checked.sh',
  'git add scripts/push-checked.sh && git commit -m x',
]) {
  test(`text that only names a push does not count: ${JSON.stringify(command)}`, () => {
    expect(isPush(command)).toBe(false)
  })
}

test('a here-string is no heredoc, so the next line still runs', () => {
  expect(isPush('cat <<<x\ngit push')).toBe(true)
})

test('the code after a heredoc still counts', () => {
  expect(isPush("cat <<'EOF'\ntext\nEOF\ngit push")).toBe(true)
})

test('a quoted path that names no git stays for the guard to read', () => {
  expect(shellCode('git -C "/a dir" commit -m x')).toBe('git -C "/a dir" commit -m x')
})
