// Workflow tests: the Bash guard on raw git commits and pushes, read as the shell reads them. The shared harness is in tests/workflow-harness.ts.
import { expect, test } from 'claude-code/testing'
import { engine, start, tool } from './workflow-harness'

for (const command of [
  'git -C /helper-wt commit -m x',
  'git -C /helper-wt push -u origin helper',
  'cd /helper-wt && git add a.ts && git commit -m x',
  'cd "/helper-wt" && git commit -m x',
]) {
  test(`a commit or push in a helper's own worktree passes while a workflow runs: ${command}`, async ($, on) => {
    const w = engine(on, { wf: { state: 'reviewing' } })
    await start($, w)
    const r = await $.tool.call({ tool: 'Bash', command, agentId: 'helper-1' } as never) as { deny?: string }
    expect(r.deny).toBeUndefined()
  })
}

for (const command of [
  'git -C /main push',
  'cd /main && git commit -m x',
  'cd /helper-wt && git commit -m x && cd /proj && git push',
  '(cd /helper-wt && git commit -m x); git push',
  'cd ../elsewhere && git commit -m x',
  'cd /helper-wt && git -C /proj push',
]) {
  test(`this stays refused beside a helper's worktree: ${command}`, async ($, on) => {
    const w = engine(on, { wf: { state: 'reviewing' } })
    await start($, w)
    const r = await $.tool.call({ tool: 'Bash', command } as never) as { deny?: string }
    expect(r.deny).toContain('checkpoint')
  })
}

for (const command of [
  // Text that only looks like a quote hides no command.
  "ls # don't do this\ngit push\necho done # it's fine",
  "cat <<'EOF' | bash\ngit push\nEOF",
  // A cd that is only text, that ran in a child shell, or that may not have held.
  'echo "; cd /helper-wt "; git push',
  'ls # ; cd /helper-wt\ngit push',
  "bash <<'EOF'\ncd /helper-wt\nEOF\ngit push",
  "bash -c 'true; cd /helper-wt '; git push",
  'cd /helper-wt | true; git push',
  'cd /helper-wt & git push',
  'cd /helper-wt; git push',
  // A later change of folder that the last cd does not show.
  'cd /helper-wt && pushd /proj && git push',
  'cd /helper-wt && builtin cd /proj && git push origin',
  'cd /helper-wt && if true; then cd /proj; fi; git push origin',
  'cd /helper-wt && { cd /proj && git push origin; }',
  // Git's environment wins over the folder.
  'cd /helper-wt && GIT_DIR=/main/.git git push',
  // The forms that the first pattern did not read.
  'git push; echo done',
  'git push;',
  '(git push)',
  '{ git push; }',
  'git push|tee x',
  'if git push; then echo y; fi',
  'git commit;',
  'x=$(git push)',
  'echo `git push`',
  "bash -c 'git push'",
  'eval "git push"',
  '/usr/bin/git push',
  '\\git push',
  'git -p push',
  // A helper's worktree does not pass a push to the branches that the workflow guards.
  'git -C /helper-wt push origin HEAD:issue-7',
  'git -C /helper-wt push origin HEAD:main',
  'cd /helper-wt && git push origin issue-7',
  // A wait in the same command does not lift the guard.
  'git push origin HEAD && gh run watch',
  'git push # wait-for-run.sh',
  // More shapes that run.
  'git \\\n  push origin HEAD',
  'git \\\n  commit -m x',
  'git --git-dir /main/.git push',
  'git --work-tree /proj commit -m x',
  'git push>/dev/null 2>&1',
  'git -C /helper-wt commit -m "$(git -C /proj push origin HEAD)"',
  'echo "a && cd /helper-wt && b" && git push',
  'cat <<EOF\n$(git push)\nEOF',
  // More pushes from a helper's worktree that can reach the branches.
  'git -C /helper-wt push --all origin',
  'git -C /helper-wt push --mirror origin',
  "git -C /helper-wt push origin 'refs/heads/*:refs/heads/*'",
  'git -C /helper-wt push origin "HEAD:$B"',
  'git -C /helper-wt push origin \\\n  HEAD:main',
  'git -C /helper-wt push origin HEAD:heads/main',
]) {
  test(`this is refused, as it can reach the workflow: ${JSON.stringify(command)}`, async ($, on) => {
    const w = engine(on, { wf: { state: 'reviewing' } })
    await start($, w)
    const r = await $.tool.call({ tool: 'Bash', command } as never) as { deny?: string }
    expect(r.deny).toContain('checkpoint')
  })
}

for (const command of [
  'pushd /proj && git push',
  "bash -c 'cd /proj && git commit -m x'",
  'sh -c "cd /proj; git push origin"',
  'GIT_DIR=/main/.git git push',
  'git push origin HEAD:issue-7',
  'env -C /proj git push',
  'env --chdir=/proj git commit -m x',
]) {
  test(`a helper's own folder does not hide where this runs: ${JSON.stringify(command)}`, async ($, on) => {
    const w = engine(on, { wf: { state: 'reviewing' } })
    await start($, w)
    w.s.agentCwd = '/helper-wt/src'
    const r = await $.tool.call({ tool: 'Bash', command, agentId: 'helper-1' } as never) as { deny?: string }
    expect(r.deny).toContain('checkpoint')
  })
}

for (const command of [
  'git add a.ts && git commit -m x; git push -u origin helper',
  'git add a.ts\ngit commit -m x',
  'git commit -m x; cd /proj',
]) {
  test(`a helper in its own folder keeps its usual commands: ${JSON.stringify(command)}`, async ($, on) => {
    const w = engine(on, { wf: { state: 'reviewing' } })
    await start($, w)
    w.s.agentCwd = '/helper-wt/src'
    const r = await $.tool.call({ tool: 'Bash', command, agentId: 'helper-1' } as never) as { deny?: string }
    expect(r.deny).toBeUndefined()
  })
}

for (const command of [
  'grep -c "git commit" README.md',
  "rg -e 'git commit' hooks",
  "git -C /helper-wt add . && git -C /helper-wt commit -F - <<'EOF'\nnever git push\nEOF",
  "cd /helper-wt && git add . && git commit -F - <<'EOF'\nnever git push\nEOF",
  "cd /helper-wt && git add -A && git commit -m \"$(cat <<'EOF'\nfix \"x\", it's done\nEOF\n)\"",
  'git -C /helper-wt\\ two commit -m x',
]) {
  test(`this passes, as it reaches no guarded branch: ${JSON.stringify(command)}`, async ($, on) => {
    const w = engine(on, { wf: { state: 'reviewing' } })
    await start($, w)
    const r = await $.tool.call({ tool: 'Bash', command } as never) as { deny?: string }
    expect(r.deny).toBeUndefined()
  })
}

test('a helper whose own folder is its worktree commits with no -C and no cd', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' } })
  await start($, w)
  w.s.agentCwd = '/helper-wt/src'
  const r = await $.tool.call({ tool: 'Bash', command: 'git commit -m x', agentId: 'helper-1' } as never) as { deny?: string }
  expect(r.deny).toBeUndefined()
})

test('the main agent gets no pass from the folder of a helper', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' } })
  await start($, w)
  w.s.agentCwd = '/helper-wt/src'
  const r = await $.tool.call({ tool: 'Bash', command: 'git commit -m x' } as never) as { deny?: string }
  expect(r.deny).toContain('checkpoint')
})

for (const command of [
  "cat > a.test.ts <<'EOF'\nawait hookCall($, 'Bash', { command: 'git push' })\nEOF",
  'grep -n "git commit" README.md',
]) {
  test(`text that only names a commit or push is not refused: ${command.split('\n')[0]}`, async ($, on) => {
    const w = engine(on, { wf: { state: 'reviewing' } })
    await start($, w)
    const r = await $.tool.call({ tool: 'Bash', command } as never) as { deny?: string }
    expect(r.deny).toBeUndefined()
  })
}

test('a commit in a heredoc that a shell runs is still refused', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' } })
  await start($, w)
  const r = await $.tool.call({ tool: 'Bash', command: "bash <<'EOF'\ngit push\nEOF" } as never) as { deny?: string }
  expect(r.deny).toContain('checkpoint')
})

test('in review with nothing held, a checkpoint with no files still names finishedReview', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing', prs: [12] } })
  await start($, w)
  const out = await tool($, 'checkpoint', { issue: 7, message: 'x', files: [] })
  expect(out.text).toContain('finishedReview')
})

test('checkpoint with no files in review says that finishedReview pushes the held commit', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing', prs: [12] } })
  w.s.upstream = 'older'
  await start($, w)
  const r = await tool($, 'checkpoint', { message: 'm', files: [] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('finishedReview')
  expect(r.text).toContain('held')
})
