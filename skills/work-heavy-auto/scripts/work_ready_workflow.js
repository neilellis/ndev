export const meta = {
  name: 'work-heavy-auto',
  description: 'PR-only board pipeline: scan the board + open claude/issue-* PRs, then ONE self-contained agent per startable work unit — a single issue or a BATCH of small related siblings landing in one PR (parallel; two dependent Ready cards batch into one PR; every PR is based on the base branch (default main), and an agent opens no second PR). Agents never wait on humans — they persist continuation state to GitHub and drop out; the next pass resumes from it.',
  phases: [
    { title: 'Scan', detail: 'deterministic feedback/state scan (pr_feedback.sh) of In progress / In review cards + survey of Ready cards into startable vs blocked (sub-issue order, same-pass dependencies batched into one PR, other dependencies recorded as blocks, per-issue sizing, batching of small related siblings into one PR)' },
    { title: 'Issues', detail: 'one agent per startable item — start: plan → park/confirm or worktree+PR, TDD implement, artifact gates, E2E under the shared lock, CI green; revise: action human feedback + ack; resume: continue from the state comment; close-out: merged/closed → Done + parent completion check', model: 'dynamic' },
  ],
}

// ---------------------------------------------------------------------------
// Inputs (the SKILL.md body fills these in when it invokes the Workflow tool).
// All git / gh / board.sh / test work happens INSIDE agents — a workflow script
// has no filesystem or shell, it only orchestrates agents.
// ---------------------------------------------------------------------------
// Defensive: args can arrive JSON-stringified, depending on how the Workflow tool
// was invoked. A silent parse failure once dropped --issue, so a bad string throws.
let A = args || {}
if (typeof A === 'string') {
  try { A = JSON.parse(A) } catch (e) {
    throw new Error('work-heavy-auto: args is a string that is not valid JSON (' + e.message + '). Pass args as an object.')
  }
}
// Required inputs. Fail at the first missing one, with the way to supply it.
const need = (key, how) => {
  const v = A[key]
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new Error('work-heavy-auto: args.' + key + ' is missing. ' + how)
  }
  return String(v).trim()
}
const REPO = need('repoDir', 'Pass the absolute path of the shared checkout (git rev-parse --show-toplevel).')
const SKILL_DIR = need('skillDir', 'Pass the absolute path of the work-heavy-auto skill folder (the folder that holds SKILL.md).')
const REPO_SLUG = need('repoSlug', 'Pass OWNER/REPO from: gh repo view --json nameWithOwner -q .nameWithOwner')
const CLA = need('commitTrailer', 'Pass the commit trailer line that this repository or session requires on every commit.')
const BASE_BRANCH = (A.baseBranch && String(A.baseBranch).trim()) || 'main'
// The project's test / typecheck / lint commands, from its CLAUDE.md. When absent,
// agents read CLAUDE.md / AGENTS.md and refuse if those name no commands.
const CHECK_COMMANDS = Array.isArray(A.checkCommands)
  ? A.checkCommands.map(String).filter((c) => c.trim())
  : (A.checkCommands ? [String(A.checkCommands)] : [])
// Optional E2E suite: the command and the config file whose presence enables it.
const E2E_COMMAND = A.e2eCommand ? String(A.e2eCommand) : ''
const E2E_CONFIG = A.e2eConfigPath ? String(A.e2eConfigPath) : ''
// Optional preview deployment: free text naming the check that publishes it.
// When absent, the preview and browser-smoke steps are skipped and the result says so.
const PREVIEW_CHECK = A.previewCheck ? String(A.previewCheck) : ''
// Optional knowledge wiki folder (relative to the repo root).
const WIKI_DIR = A.wikiDir ? String(A.wikiDir) : ''
const DRY_RUN = !!A.dryRun
const ONLY_ISSUE = A.onlyIssue ? Number(A.onlyIssue) : null
// onlyIssues: an ALLOWLIST scoping the whole pass — survey AND feedback relay —
// to this set. Use it to confine a pass to one epic + its children ("work on
// #N and its sub-issues only"). This is the safe primitive for that ask;
// excludeIssues is NOT, because the feedback relay also sweeps OPEN PRs, so any
// in-flight PR you forgot to name still gets an agent dispatched at it. A pass
// scoped to an epic by exclude-list once dispatched agents onto issues whose
// original agents were still alive and mid-edit in the same worktrees.
// Unlike onlyIssue (singular), this does NOT starve child-PR revise/resume/close-out:
// name the epic AND its children and every one of them stays serviceable.
const ONLY_ISSUES = Array.isArray(A.onlyIssues)
  ? A.onlyIssues.map(Number).filter((x) => !Number.isNaN(x))
  : []
const ALLOWED = ONLY_ISSUES.length ? new Set(ONLY_ISSUES) : null
// excludeIssues: issues handled OUTSIDE this pipeline — never scanned by the
// feedback phase (so no revision/close/move can fire on them) and dropped from
// the survey. For a card being worked elsewhere that must be left alone.
const EXCLUDE_ISSUES = Array.isArray(A.excludeIssues)
  ? A.excludeIssues.map(Number).filter((x) => !Number.isNaN(x))
  : []
const EXCLUDED = new Set(EXCLUDE_ISSUES)
// One gate both phases go through. Allowlist wins; exclude still subtracts.
const inScope = (n) => (!ALLOWED || ALLOWED.has(n)) && !EXCLUDED.has(n)
const SEQUENTIAL = !!A.sequential      // --sequential: one per-issue agent at a time
const NO_CONFIRM = !!A.noConfirm       // --no-confirm: skip the plan sign-off gate (hands-off /loop runs)
// Plan-confirmation gate: non-trivial plans park in Awaiting Feedback for human
// sign-off before implementation. --no-confirm disables it explicitly.
const GATE = !NO_CONFIRM
// The plugin's shared scripts folder: <plugin root>/scripts, two levels above the skill folder.
const SCRIPTS = SKILL_DIR + '/../../scripts'
// Board reads and moves. A shim to scripts/github/gh.sh.
const BOARD = A.boardScript || (SCRIPTS + '/board/board.sh')
// The github helper for issues, sub-issues and blocked-by relations.
const GH_SH = A.ghScript || (SCRIPTS + '/github/gh.sh')
// The canonical development method that every per-issue agent follows.
const WORK_SKILL = SKILL_DIR + '/../work-heavy/SKILL.md'
// Deterministic artifact gates (plan / unit test / e2e test) — a SCRIPT decides,
// agents only run it and relay the verdict.
const GATES_SH = A.gatesScript || (SCRIPTS + '/work/gates.sh')
// Deterministic PR/issue feedback + continuation-state scan — the SCRIPT decides
// what is new vs handled (four comment surfaces, ack markers) and surfaces the
// latest work-heavy-auto:state comment; agents only relay.
const FEEDBACK_SH = A.feedbackScript || (SCRIPTS + '/work/pr_feedback.sh')
// Claims a worktree without destroying anyone's work. It replaces a block that ran
// `worktree remove --force`, `branch -D` and `worktree add -B` unconditionally and
// so discarded unpushed commits that belonged to a live session.
const CLAIM_SH = A.claimScript || (SCRIPTS + '/work/worktree_claim.sh')
// Answers whether another live session is already working an issue's worktree.
// worktree_claim.sh reads tree state only, so a live session that has committed and
// pushed leaves a clean worktree and the claim guard hands it to a second agent.
// Without this, an operator had to exclude live issues by hand, from memory.
const PEER_SH = A.peerActivityScript || (SCRIPTS + '/work/peer_activity.sh')
// Auth note shared by every prompt that calls gh directly.
const [REPO_OWNER, REPO_NAME] = REPO_SLUG.split('/')
if (!REPO_OWNER || !REPO_NAME) {
  throw new Error('work-heavy-auto: args.repoSlug "' + REPO_SLUG + '" is not OWNER/REPO. Pass the output of: gh repo view --json nameWithOwner -q .nameWithOwner')
}
const BASE_REF = 'origin/' + BASE_BRANCH
const GH_AUTH = 'When the ambient GITHUB_TOKEN lacks project/actions scope, prefix raw gh calls with '
  + '`env -u GITHUB_TOKEN` (the helpers do this when GH_USE_KEYRING=1 is set).'
// A resume chain that keeps failing stops burning passes after this many attempts;
// the PR then waits for a human comment (which re-enters it through revise).
const MAX_ATTEMPTS = 3

// ---------------------------------------------------------------------------
// Model/effort tiering: the survey sizes each start agent; revise/resume run at
// opus/xhigh (a human-facing conversation or a stuck pipeline — think properly).
// Values are bounded by schema enums; validate anyway and fall back SAFE-HIGH.
// ---------------------------------------------------------------------------
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const pickTier = (model, effort, allowedModels, defModel, defEffort) => {
  // An out-of-enum model means the sizing can't be trusted — take BOTH defaults.
  if (!allowedModels.includes(model)) return { model: defModel, effort: defEffort }
  return { model, effort: EFFORTS.includes(effort) ? effort : defEffort }
}

// The shared trivial-vs-not rubric (single source for survey + start prompts).
const RUBRIC = [
  'Sizing rubric: an issue is TRIVIAL only when it is cosmetic / copy / config / docs-only,',
  'adds no new logic, touches no schema/API/auth/migration, and needs a small localized diff.',
  'Everything else is NON-TRIVIAL. When uncertain, size UP (non-trivial, bigger model).',
].join('\n')

// ---------------------------------------------------------------------------
// Structured-output schemas
// ---------------------------------------------------------------------------
// The survey: a FLAT list of Ready work items (sub-issue chains pre-expanded),
// each marked startable or blocked. Scheduling is a predicate, never a wait.
const SURVEY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    empty: { type: 'boolean' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          number: { type: 'integer' },
          title: { type: 'string' },
          itemId: { type: 'string', description: 'project item id PVTI_… for board moves (the child\'s own card if it has one, else the parent\'s)' },
          url: { type: 'string' },
          parent: { type: ['integer', 'null'], description: 'parent issue number when this item is a sub-issue' },
          dependsOn: { type: 'array', items: { type: 'integer' }, description: 'every OTHER ISSUE that must close before this one can start and is not batched with it this pass (it has an open PR that is not ours, or it cannot be worked this pass) — recorded on GitHub as a blocked-by relationship after the survey' },
          startable: { type: 'boolean' },
          blockedReason: { type: ['string', 'null'], description: 'why it cannot start (a dependency this pass cannot work, child parked in Awaiting Feedback, batched into #<lead>, …)' },
          batch: { type: ['array', 'null'], items: { type: 'integer' }, description: 'set on a batch LEAD only: ordered issue numbers (lead first) that land together in the lead\'s single PR; each folded member appears as its own item with startable:false + blockedReason "batched into #<lead>"' },
          issueModel: { type: 'string', enum: ['sonnet', 'opus'], description: 'model for this issue\'s per-issue agent' },
          issueEffort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
        },
        required: ['number', 'title', 'itemId', 'startable', 'issueModel', 'issueEffort'],
      },
    },
  },
  required: ['empty', 'items'],
}

// The Ready ROSTER: a dumb, cheap relay that lists the Ready column and nothing
// else. It exists to CHECK the survey. A survey agent once emitted items for only
// about half of the Ready cards and reported no error, so the rest were silently
// never worked — and every subsequent pass repeated it,
// because nothing compared the survey against the board. Reading the column is a
// separate, near-unfailable job from reasoning about it; splitting them lets the
// script diff the two and re-survey the gap.
const READY_LIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    numbers: { type: 'array', items: { type: 'integer' } },
  },
  required: ['numbers'],
}

// The peer-activity relay: peer_activity.sh's verdict per issue. The SCRIPT decides;
// the relay agent runs it and reports the exit code and the evidence line verbatim.
// A workflow script has no shell of its own, so every measurement reaches it this way.
const PEER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          number: { type: 'integer' },
          exitCode: { type: 'integer', description: '0 clear, 2 cannot measure, 5 peer active' },
          evidence: { type: 'string', description: 'the script\'s output line, verbatim' },
        },
        required: ['number', 'exitCode'],
      },
    },
  },
  required: ['items'],
}

// The feedback/state scan relay: pr_feedback.sh's exact output shape. The SCRIPT
// decides what is new vs handled and extracts the latest continuation state; the
// relay agent runs it and returns its JSON verbatim.
const FEEDBACK_SCAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          number: { type: 'integer', description: 'issue number' },
          title: { type: 'string' },
          itemId: { type: 'string', description: 'project item id PVTI_… for board moves' },
          cardStatus: { type: 'string' },
          pr: {
            type: 'object',
            additionalProperties: false,
            properties: {
              number: { type: 'integer' },
              url: { type: 'string' },
              state: { type: 'string', description: 'OPEN | MERGED | CLOSED | NONE (no PR yet)' },
              isDraft: { type: 'boolean' },
              branch: { type: 'string' },
              createdAt: { type: 'string' },
              lastCommit: { type: 'string' },
            },
            required: ['state'],
          },
          state: {
            type: ['object', 'null'],
            description: 'latest <!-- work-heavy-auto:state --> comment on the open PR, or null',
            additionalProperties: false,
            properties: {
              createdAt: { type: 'string' },
              attempts: { type: 'integer' },
              next: { type: 'string', description: 'waiting-human | resume' },
              nextDetail: { type: 'string' },
            },
          },
          smoke: {
            type: ['object', 'null'],
            description: 'the newest "**Smoke tested" review, and whether the branch moved since',
            additionalProperties: false,
            properties: {
              reviewedAt: { type: ['string', 'null'] },
              stale: { type: 'boolean', description: 'true => the current head has NOT been opened in a browser' },
            },
          },
          checks: {
            type: ['object', 'null'],
            description: 'CI status at the PR head; FAILING re-enters the PR as resume whatever its state comment claims',
            additionalProperties: false,
            properties: {
              state: { type: 'string', description: 'FAILING | PENDING | PASSING | NONE' },
              failing: { type: 'array', items: { type: 'string' }, description: 'names of the failing checks' },
            },
          },
          newFeedback: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer', description: 'comment id — MUST be acked in the revision reply' },
                surface: { type: 'string', description: 'issue | pr | review | inline' },
                author: { type: 'string' },
                createdAt: { type: 'string' },
                path: { type: ['string', 'null'], description: 'file path for inline comments' },
                body: { type: 'string' },
              },
              required: ['id', 'surface', 'body'],
            },
          },
        },
        required: ['number', 'itemId', 'pr', 'newFeedback'],
      },
    },
    error: { type: 'string', description: 'set ONLY if the script itself failed to run' },
  },
  required: ['items'],
}

// Every per-issue agent (start / revise / resume) exits through this contract.
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    number: { type: 'integer' },
    status: {
      type: 'string',
      enum: ['ci-green', 'needs-feedback', 'awaiting-confirm', 'replied', 'blocked', 'failed'],
      description: 'ci-green: PR ready + checks green (+ preview up when one is configured); needs-feedback / awaiting-confirm: parked in Awaiting Feedback; replied: feedback answered, no code change; blocked: the worktree claim refused (another session owns it); failed: could not finish this pass (state comment says how to resume)',
    },
    branch: { type: 'string' },
    prUrl: { type: 'string' },
    previewUrl: { type: 'string', description: 'preview deployment URL, when the project has one' },
    title: { type: 'string' },
    notes: { type: 'string', description: 'one line for the run report' },
    questions: { type: 'array', items: { type: 'string' }, description: 'set when status is needs-feedback' },
  },
  required: ['number', 'status'],
}

// ---------------------------------------------------------------------------
// Deterministic classifier: scan facts → per-item action. In code, not a model.
// ---------------------------------------------------------------------------
const toActions = (scan) => {
  const items = (scan && Array.isArray(scan.items)) ? scan.items : []
  return items.map((it) => {
    const pr = it.pr || {}
    const base = {
      number: it.number, itemId: it.itemId || '', title: it.title || '',
      branch: pr.branch || ('claude/issue-' + it.number), prUrl: pr.url || '',
      attempts: (it.state && it.state.attempts) || 0,
      nextDetail: (it.state && it.state.nextDetail) || '',
    }
    if (!pr.state || pr.state === 'NONE') {
      // Card is In progress / In review but no claude/issue-<n> PR exists. The v2
      // start agent opens its draft PR BEFORE moving the card, so this can never
      // be a crashed v2 agent — it is human-owned or manually-moved work. Report
      // it, touch nothing (an earlier classifier tried to adopt human-owned cards).
      return { ...base, action: 'untracked' }
    }
    if (pr.state === 'MERGED') return { ...base, action: 'close-out', merged: true }
    if (pr.state === 'CLOSED') return { ...base, action: 'close-out', merged: false }
    const fb = Array.isArray(it.newFeedback) ? it.newFeedback : []
    if (fb.length) {
      const digest = fb.map((f) =>
        '- [' + f.surface + ' comment ' + f.id + (f.path ? ' on ' + f.path : '')
        + (f.author ? ' by ' + f.author : '') + (f.createdAt ? ' at ' + f.createdAt : '') + ']\n'
        + '  ' + String(f.body || '').split('\n').join('\n  ')).join('\n')
      return { ...base, action: 'revise', feedback: digest, feedbackIds: fb.map((f) => f.id) }
    }
    // RED CI beats any claim the state comment makes. When nothing here read check
    // status, a PR that went red AFTER its agent parked with
    // "- next: waiting-human" sat in the green-and-awaiting-review bucket forever.
    // Human feedback still wins (handled above) — a human asking for a change knows
    // more than the checks do. Cancelled runs are not failures (pr_feedback.sh).
    const ck = it.checks || null
    if (ck && ck.state === 'FAILING') {
      if (base.attempts >= MAX_ATTEMPTS) return { ...base, action: 'stuck' }
      const names = (ck.failing || []).join(', ') || 'unnamed check'
      return { ...base, action: 'resume',
        nextDetail: 'CI is RED at the current head (' + names + ') — read the failing run\'s log '
          + '(gh run view <id> --log-failed), find the root cause, fix it test-first, push, re-watch checks' }
    }
    if (!it.state) {
      // Open PR, quiet, and no state comment: the agent that made it never got to
      // drop out cleanly (crash / pre-v2 PR). Resume and finish the pipeline.
      return { ...base, action: 'resume', nextDetail: 'no state comment — inspect the PR/branch and finish the pipeline (gates, suites, E2E, CI green)' }
    }
    if (it.state.next === 'resume') {
      if (base.attempts >= MAX_ATTEMPTS) return { ...base, action: 'stuck' }
      return { ...base, action: 'resume' }
    }
    // The PR is green and sitting with the reviewer — but is the thing the reviewer
    // would open actually the code on the branch? A smoke review is pinned to the commit
    // it opened. An agent that pushes a fix and drops out minutes later can park long before
    // its preview exists (push -> CI -> preview can take hours on a busy runner),
    // so the browser check never happens and the stale review + label say it did. That is
    // an overclaim, and it is worse than no check because it retires suspicion unearned.
    // No preview deployment configured: there is nothing to open, so no smoke action.
    if (PREVIEW_CHECK && it.smoke && it.smoke.stale && !pr.isDraft) {
      return { ...base, action: 'smoke', smokedAt: it.smoke.reviewedAt || null }
    }
    return { ...base, action: 'waiting' } // next: waiting-human — the PR sits with the reviewer
  }).filter(Boolean)
}

// ---------------------------------------------------------------------------
// Prompt builders. Each is self-contained — agents start fresh with no context.
// Commands are written plainly (no markdown fences) to keep quoting simple.
// ---------------------------------------------------------------------------
const CONVENTIONS = [
  'Repo: ' + REPO_SLUG + '. The shared checkout is ' + REPO + ' — never work in it directly;',
  'implementation happens in your own worktree (instructions below).',
  'METHODOLOGY (mandatory first step before any implementation work): Read',
  WORK_SKILL + ' — the canonical development methodology (golden rules +',
  'fragments F0-F7: worktree/draft-PR, plan, TDD, verify loop, wiki ingest, markers, questions).',
  'The blocks below instantiate those fragments with this pipeline\'s exact commands and paths;',
  'where they are specific, they win — otherwise the work-heavy skill governs.',
  'Board access: use ' + BOARD + ' for all board reads/moves. ' + GH_AUTH,
  'PROJECT RULES: read CLAUDE.md and AGENTS.md in the repo root before you change anything. They name',
  'the test, typecheck and lint commands, the test layout and any domain rules; they win over the',
  'generic text here where the two differ.',
  'PR-ONLY, NO EXCEPTIONS: never commit or push to ' + BASE_BRANCH + ', never merge a PR. All work lands on a',
  'claude/issue-<n> branch as a PR for human review.',
  'NEVER WAIT ON A HUMAN: at any point where only a human can move things forward, persist your',
  'state to GitHub (the comment formats below) and EXIT. A later pass resumes from it.',
  'Every comment you post on an issue or PR must start with "<!-- work-heavy-auto" or "**work-heavy-auto" —',
  'that is how the deterministic scanner tells pipeline comments from human feedback.',
  'Commit trailer required on every commit: ' + CLA,
  'ONE PR, NEVER A SECOND: you own exactly one PR this pass. You open no other PR, whatever you',
  'find, unless a human message tells you to. The work-heavy skill\'s "New work found while you work"',
  '(' + SKILL_DIR + '/../work-heavy/references/prs.md) is the rule; in short:',
  'NEW WORK YOU FIND ON THE WAY, RELATED TO YOUR ISSUE, AT ANY SIZE: (1) open it as a sub-issue of',
  'the issue you are working (' + GH_SH + ' subissues link <your-issue>',
  '<new-issue>); (2) comment "Carried by #<your-pr>" on it and move its card to In progress',
  '(a survey then skips it); (3) add "Closes #<new-issue>" to YOUR PR body, one line per sub-issue,',
  'with its own section and Test entry point; (4) give it to a TEAMMATE (subagent) on YOUR branch,',
  'in YOUR worktree, test-first with its own review. Size does not change this: a schema change',
  'or a two-day refactor is still a sub-issue in your PR. A one-line fix stays in your diff.',
  'NEW WORK UNRELATED TO YOUR ISSUE: open a plain issue on the board with the evidence, name it in',
  'your state comment, and carry on. No PR, no worktree, no link under your issue.',
].join('\n')

// The continuation: what a per-issue agent leaves on its OPEN PR whenever it
// exits with work in flight. attempts/next are machine-read (pr_feedback.sh);
// everything else is prose for the next agent and the human.
function stateCommentBlock(n) {
  return [
    'STATE COMMENT (the continuation — MANDATORY whenever you exit and the PR is open):',
    'post a PR conversation comment (gh pr comment <prUrl> --body-file <tmp>)',
    'with EXACTLY this shape — marker first line, then the five dash-lines:',
    '<!-- work-heavy-auto:state -->',
    '**work-heavy-auto state — issue #' + n + '**',
    '- done: <what is complete so far, terse but specific — file paths, decisions>',
    '- pending: <what remains | none>',
    '- assumptions: <assumptions made this pass | none>',
    '- acked: <feedback comment ids actioned this pass | none>',
    '- attempts: <k>',
    '- next: waiting-human    (exactly that when the PR is green and waiting on review)',
    '- next: resume: <one line telling the NEXT agent exactly where to pick up>   (otherwise)',
    'Keep "- attempts:" and "- next:" machine-parseable exactly as shown (the scanner greps them).',
  ].join('\n')
}

// An E2E suite usually holds a shared local resource (a database stack, an app port,
// a browser profile), so at most one E2E run may go at a time on this machine.
const E2E_LOCK = REPO + '/.claude/e2e-run.lock'
function e2eBlock() {
  if (!E2E_COMMAND) {
    return [
      'E2E: this pass has no e2eCommand. Read CLAUDE.md / AGENTS.md for the end-to-end command. If they',
      'name one, run it under the lock below. If they name none, note "E2E not run: no command named"',
      'in the PR body and in your result notes. Never report E2E as passed when it did not run.',
      'Lock (take it first, ALWAYS release it, even on failure):',
      '  until mkdir "' + E2E_LOCK + '" 2>/dev/null; do find "' + E2E_LOCK + '" -maxdepth 0 -mmin +90 -exec rm -rf {} + ; sleep 60; done',
      '  <the e2e command> ; rc=$?',
      '  rm -rf "' + E2E_LOCK + '"',
    ].join('\n')
  }
  return [
    'E2E. ' + (E2E_CONFIG
      ? 'SKIP-GUARD: if ' + E2E_CONFIG + ' does not exist on your branch, note "no E2E suite" and move on. Otherwise'
      : 'The') + ' the suite shares local resources machine-wide, so take the global lock first and ALWAYS',
    'release it (even on failure — use a trap or an explicit rm after capturing the exit code):',
    '  until mkdir "' + E2E_LOCK + '" 2>/dev/null; do find "' + E2E_LOCK + '" -maxdepth 0 -mmin +90 -exec rm -rf {} + ; sleep 60; done',
    '  ' + E2E_COMMAND + ' ; rc=$?',
    '  rm -rf "' + E2E_LOCK + '"',
    '(The find line removes a stale lock that a crashed run left, after 90 min.) A cold run can take',
    'several minutes. Failures: debug per mattpocock-skills:diagnosing-bugs (root cause first, prefer',
    'fixing the app; adjust a spec only when the plan intentionally changed behaviour).',
  ].join('\n')
}

function worktreeBlock(n, baseRef) {
  return [
    'WORKTREE (all work happens here, never in the shared checkout). Claim it with the guard —',
    'it is the ONLY approved way to get a worktree:',
    '  cd ' + REPO,
    '  ' + CLAIM_SH + ' ' + REPO + ' ' + n + ' ' + baseRef,
    '  # exit 0 → it prints the worktree path on the last stdout line; cd there and work.',
    '  cd .claude/worktrees/issue-' + n,
    '',
    'A NON-ZERO EXIT IS NOT A PROBLEM TO SOLVE. It means the worktree is not yours:',
    '  exit 3 — it holds uncommitted work.  exit 4 — the branch holds unpushed commits.',
    '  exit 2 — git could not answer, which is never a pass.',
    'In every one of those cases: STOP. Touch nothing. Do not remove, reset, checkout or clean',
    'anything, and do not retry with a different command. Return immediately with',
    'status "blocked" and notes naming the exit code and that a live session most likely owns it.',
    '',
    'NEVER run any of these, for any reason, however harmless the situation looks:',
    '  git worktree remove --force …    (it deletes somebody\'s working directory)',
    '  git branch -D claude/issue-' + n + '   (it deletes their branch)',
    '  git worktree add … -B …          (it RESETS the branch, discarding unpushed commits)',
    'That sequence has discarded the unpushed commits of a live session and deleted its working',
    'directory. The loss is silent: `worktree add -B` reports it as the routine phrase',
    '`was at <sha>`, so nothing in the output reads as damage. Assume a worktree that already',
    'exists belongs to somebody until the guard says otherwise.',
    '',
    'Before you exit (any path): leave the worktree in place. Do NOT remove it — it may hold work',
    'that is not yours, and the guard reuses a clean one on the next pass.',
  ].filter(Boolean).join('\n')
}

// The project's own check commands, or the instruction to find them.
function checksText() {
  if (CHECK_COMMANDS.length) return CHECK_COMMANDS.map((c) => '  - ' + c).join('\n')
  return [
    '  - the test, typecheck and lint commands that CLAUDE.md / AGENTS.md name. If they name none,',
    '    STOP: post the state comment with "- next: waiting-human" and a question asking which',
    '    commands verify this repo, and return status "needs-feedback". Never guess a command.',
  ].join('\n')
}

// Every non-trivial issue lands with tests PINNED to it — named for the issue,
// in an issues/ subdir of the owning suite — so acceptance criteria stay
// traceable and regressions point straight back at the issue.
function issueTests(n) {
  return [
    '   ISSUE-PINNED TESTS (mandatory when non-trivial): land at least one UNIT test AND one',
    '   END-TO-END test pinned to this issue, in the owning suite, following the test layout that',
    '   CLAUDE.md / AGENTS.md describe:',
    '   - unit: a file named issue_' + n + '_<desc>.* or test_issue_' + n + '_<desc>.* (use the test_',
    '     prefix where the runner discovers files by it), for example in an issues/ subdirectory.',
    '   - end-to-end: the same naming, under an e2e/ or integration/ directory. "End-to-end" means',
    '     the top of whichever stack changed: a browser for a web app, the CLI for a command-line',
    '     tool, a request for an HTTP service.',
    '   These are regression pins encoding the issue\'s acceptance criteria; they run in the normal',
    '   suites, on top of (not instead of) the TDD tests the tasks themselves add.',
    '   (Trivial issue: pinned tests and the plan-of-record may be skipped when there is genuinely',
    '   nothing to test.)',
  ].join('\n')
}

function disciplineBlock(n) {
  return [
    'Implement following the discipline below (invoke each named skill via the Skill tool if',
    'available; the',
    'discipline is summarized here so it holds even if the tool is not reachable):',
    '- Dispatch a FRESH implementer sub-agent per plan task,',
    '  and after each task run a spec+quality task-review; fix Critical/Important findings before moving on.',
    '- testing skill — follow the 3-tier taxonomy: unit tests check pure algorithms in memory only (<50ms; no DB/S3/network/filesystem); integration tests verify boundaries with conservative resource use; keep E2E tests to a minimum. Mutation-prove guards in both directions.',
    '- mattpocock-skills:tdd — NO production code without a failing test first: for each',
    '  unit, write the test, run it, watch it fail, then write minimal code to pass. Cover unit AND',
    '  integration per the repo conventions in CLAUDE.md / AGENTS.md.',
    issueTests(n),
    '- If the issue changes a user-facing auth/membership/billing flow, ALSO extend the E2E',
    '  suite to cover the changed flow.',
    '- On any test/build failure: mattpocock-skills:diagnosing-bugs — root cause before any fix.',
    '  Re-run the FULL relevant suites until green:',
    checksText(),
    '- Before finishing, the TWO-AXIS REVIEW (work-heavy skill F3c): dispatch TWO read-only diff-reviewer',
    '  sub-agents IN ONE MESSAGE over git diff ' + BASE_REF + '...HEAD — one asking "where does this break',
    '  a rule this repo has written down?", the other asking "what did the issue ask for that is',
    '  missing, and what is here that nobody asked for?". Keep the two reports apart; do not rerank',
    '  across them. Resolve every Critical + Important finding on both.',
    '- Re-run the full suites FRESH, 0 failures, before',
    '  any "tests pass" / "green" claim. No claim without evidence you just read.',
    '- DEAD CODE SWEEP (work-heavy skill F3d) — every issue, trivial included; docs-only diffs are the one',
    '  exemption. Before your final push, run the `deadcode` skill\'s sweep in your worktree, if that',
    '  skill is installed. If it is not, write "dead-code sweep not run: deadcode skill not installed"',
    '  in the PR body. Exit 0 is clean, 1 is findings, 2 is could-not-measure — 2 is never a pass.',
    '  Triage every finding against the false-positive causes the deadcode skill lists: a static',
    '  sweep cannot see a decorator registration, a getattr, a string-keyed call, or a name another',
    '  package imports. NEVER run an automatic --fix: it can delete side-effect imports and attribute',
    '  writes that the code needs. A wrongly deleted name costs far more than a missed one — when',
    '  you cannot SHOW a name is dead, keep it.',
    '  Delete the true positives, re-run the sweep until it exits 0',
    '  (removing one function exposes the helper only it called), then re-run the typecheck',
    '  AND the test suites — a string-keyed call site is invisible to the sweep and to the type',
    '  checker, and only a test catches it. A red test means the name was not dead: restore it.',
    '  ALWAYS invoke the forget skill for what you delete, and treat it as the MORE IMPORTANT half:',
    '  a dead function is inert, but a doc page still describing it is read by the next agent and',
    '  acted on, so it rebuilds what you removed.',
    '  PUT THE REPORT IN TWO PLACES: the PR body (so a reviewer sees it) and the deletion commit',
    '  message (so git log names what went). A CLEAN sweep still gets its line in the PR body —',
    '  a silent sweep cannot be told apart from one nobody ran.',
    '- ARTIFACT GATES (deterministic, non-trivial issues): before the PR may go ready, run',
    '  ' + GATES_SH + ' ' + n + ' HEAD <your PR number>   in your worktree — it checks that your PR',
    '  BODY holds the plan of record and names its Test entry point:, plus the pinned unit + e2e',
    '  tests, and prints a JSON verdict. Exit 2 means it could NOT measure — never read that as a pass.',
    '  Loop (produce what is missing, push, re-run) until it prints pass:true.',
    (WIKI_DIR
      ? '- WIKI: ingest the work into ' + WIKI_DIR + ' (follow the conventions file in that folder, if any):\n'
        + '  update the page(s) and any index or log the folder keeps. Skip only for purely cosmetic changes.'
      : '- DOCS: if the repo keeps a knowledge wiki or developer docs (CLAUDE.md names it), update the\n'
        + '  page(s) this work changes. Skip only for purely cosmetic changes.'),
    '  A doc page states CURRENT STATE, so an ingest that only ADDS is half an ingest: where your',
    '  change superseded what a page says, ERASE the old claim (the `forget` skill) rather than',
    '  leaving it beside the new one. It is not context — it is false, and it will be acted on.',
  ].join('\n')
}

// The preview deployment step, or the note that this pass has none.
function previewText() {
  if (!PREVIEW_CHECK) {
    return '4. This pass names no preview deployment (no previewCheck). Skip the preview; write\n'
      + '   "preview not checked: none configured" in your result notes.'
  }
  return '4. Confirm the preview deployment is up for the CURRENT head: ' + PREVIEW_CHECK + '.\n'
    + '   Capture the PREVIEW URL. A green commit status alone is not proof of a preview; read the\n'
    + '   deployment\'s own state and URL.'
}

function ciBlock(n) {
  return [
    'VERIFY (CI is a machine — you DO wait for it; only humans trigger drop-out). gh pr commands',
    'take the BRANCH (the PR number differs from the issue number):',
    '0. **RECORD WHAT YOU LEARNED — BEFORE the PR leaves draft.** Invoke the `remember` skill (Skill tool,',
    '   name "r"; if it is not installed, write the facts into the docs CLAUDE.md names yourself).',
    '   Harvest the durable, non-obvious facts this work taught you, route each to its ONE home',
    '   (the wiki or docs, a skill, CLAUDE.md, or memory), and COMMIT THE REPO ONES ON THIS BRANCH —',
    '   you already have a worktree and a PR, so never open a second PR for them (that costs',
    '   another full CI run). Skills and memory go to their own homes.',
    '   Do it NOW, not after: this is the last moment the knowledge exists. The root cause you',
    '   chased, the tool that lied to you, the measurement that killed a plausible theory — all of',
    '   it is discarded with your context the moment you drop out, and the diff records only what',
    '   changed, never what you now know. "Nothing durable was learned" is a legitimate answer for',
    '   cosmetic work; say it rather than padding the docs.',
    '   This subsumes the F5 docs ingest — do not do both.',
    '0b. **AND REMOVE WHAT THIS WORK MADE FALSE.** If you deleted, renamed or deprecated anything,',
    '   or hit a doc/memory note the code contradicts, invoke the `forget` skill (Skill tool, name',
    '   "forget") on this same branch. `r` only ADDS: it leaves the superseded description sitting',
    '   in the docs, the plans, CLAUDE.md, the code comments and memory, where the next agent reads',
    '   it and REBUILDS what you removed. ERASE it — replace it with present-tense prose about what',
    '   is true now. Do NOT leave a note explaining what used to be there: the most you may leave,',
    '   and only where someone would otherwise rebuild the thing, is a bare "Removed in #<n>." The',
    '   issue already holds the detail, and a note repeating it re-teaches what you came to delete.',
    '1. Push your branch, then: gh pr ready claude/issue-' + n,
    '2. gh pr checks claude/issue-' + n + ' --watch   (one blocking wait; never poll by hand)',
    '3. gh pr view claude/issue-' + n + ' --json mergeable,mergeStateStatus,statusCheckRollup',
    previewText(),
    '5. On failure: mattpocock-skills:diagnosing-bugs (gh run view <run-id> --log-failed; the',
    '   deployment build log via the check\'s URL), fix, commit, push, re-watch. Bounded to 3 fix',
    '   rounds this pass — still red after that: post the state comment with "- next: resume: <what',
    '   is broken>" and exit with status "failed" (the next pass, or a human comment, picks it up).',
    'Report status "ci-green" only on fresh evidence: every check SUCCESS' + (PREVIEW_CHECK ? ' and the preview' : '') + '',
    (PREVIEW_CHECK ? 'up, ' : '') + 'read in a call you just made. Do NOT run a browser smoke (the orchestrator does',
    'that), do NOT merge, do NOT move the card past In progress.',
  ].join('\n')
}

function readyListPrompt() {
  return [
    'You are the READY-ROSTER RELAY for the work-heavy-auto pipeline. One job, no judgement.',
    '',
    'Run exactly:',
    '  ' + BOARD + ' ready',
    'It prints one JSON object per line, each with a "number" field.',
    '',
    'Return {"numbers": [...]} containing the "number" of EVERY line it printed, in order.',
    'Do NOT filter, deduplicate, prioritise, skip, or truncate — not for blocked issues, not for',
    'issues that look done, not for a long list. The count you return MUST equal the number of lines',
    'the command printed. Verify that before returning (pipe through `wc -l` if it helps).',
    'If the command fails, return {"numbers": []}.',
  ].join('\n')
}

function peerActivityPrompt(numbers) {
  return [
    'You are the PEER-ACTIVITY RELAY for the work-heavy-auto pipeline. One job, no judgement.',
    '',
    'For EACH of these issue numbers, run the command and record its exit code and its output:',
    '  ' + numbers.join(', '),
    '',
    'The command, once per number:',
    '  ' + PEER_SH + ' ' + REPO + ' <n>',
    '',
    'Capture the exit code with `echo $?` immediately after each run. The exit codes are',
    '0 (no peer), 2 (cannot measure) and 5 (a peer is working that worktree).',
    'Return {"items": [{"number": n, "exitCode": c, "evidence": "<the output line, verbatim>"}]}',
    'with one entry per number you were given, in order.',
    '',
    'Do NOT interpret the result, do NOT re-run a command to get a different answer, and do NOT',
    'omit a number. If the command itself cannot be run at all, report exitCode 2 for that number',
    'with the reason as the evidence. Never report 0 for a number you did not measure.',
  ].join('\n')
}

function surveyPrompt(surfaceChildren, restrictTo) {
  const gap = Array.isArray(restrictTo) && restrictTo.length ? restrictTo : null
  return [
    'You are the SURVEY agent for the work-heavy-auto pipeline. READ ONLY except for the ONE board move in',
    'step 2b (surfacing an EPIC\'s children to Ready) — otherwise do NOT move cards, branch, comment,',
    'or implement. Return only the JSON.',
    gap
      ? '\nGAP SURVEY. A previous survey agent in this same pass DROPPED these Ready cards without\n'
        + 'reporting them: #' + gap.join(', #') + '.\n'
        + 'Survey EXACTLY those issues and no others. You MUST return one item for every one of the '
        + gap.length + ' numbers listed\n'
        + '(an item marked startable:false with a blockedReason is a fine answer — omitting it is not).'
      : '',
    CONVENTIONS,
    '',
    '1. List Ready cards: run ' + BOARD + ' ready   (JSON lines {number,title,itemId,url}).',
    '   COMPLETENESS IS THE POINT OF THIS STEP: you must emit an item for EVERY Ready card, however',
    '   long the list. Count the lines first and carry that count as your target — a card you judge',
    '   blocked, stale, duplicated or already-handled still gets an item (startable:false +',
    '   blockedReason). Dropping a card silently means nobody ever works it, so an over-long list is',
    '   never a reason to stop early; work through it to the end.',
    ONLY_ISSUE ? '   Restrict to issue #' + ONLY_ISSUE + ' ONLY; ignore every other Ready card.' : '',
    gap ? '   Then narrow to the gap list above: survey ONLY #' + gap.join(', #') + '.' : '',
    '   If there are no Ready cards, return {"empty": true, "items": []}.',
    '   Also run ' + BOARD + ' items once — you need other cards\' columns + itemIds below.',
    '2. EXPAND SUB-ISSUES (EPICs). For each Ready card, check for sub-issues:',
    '   gh api repos/' + REPO_SLUG + '/issues/<n>/sub_issues',
    '   (an error or empty array = none). An issue WITH sub-issues is an EPIC / CONTAINER — it never',
    '   gets its own work item. Replace it with its children, IN THE API\'s ORDER, as candidate items',
    '   (parent = the container\'s number). An EPIC IN READY AUTHORIZES ALL ITS CHILDREN AS READY WORK',
    '   — a child does NOT need its own Ready card. Each child\'s itemId is its own card\'s if it is on',
    '   the board, else the parent\'s.',
    surfaceChildren
      ? '2b. SURFACE EPIC CHILDREN TO READY. For each expanded child that HAS its own board card '
        + 'currently in Backlog / no-status (per ' + BOARD + ' items), move it onto Ready so the board '
        + 'reflects the real work units: ' + BOARD + ' move <childOwnItemId> ready. NEVER pull a child '
        + 'back from In progress / In review / Done / Awaiting Feedback, and NEVER move the EPIC\'s own '
        + 'container card. This is the ONLY board write you may perform.'
      : '2b. DRY RUN — do NOT move any cards. Just note (for the report) which EPIC children WOULD be '
        + 'surfaced to Ready.',
    '3. ACTIONABILITY. **A READY CARD IS ACTIONABLE. The human put it there, and that is the whole',
    '   instruction.** The ONLY reasons you may mark one blocked are the MECHANICAL ones listed',
    '   below. Each is a fact you can check with a command.',
    '   **You may NEVER block a Ready card on a human**: not "awaiting a decision", not "parked with',
    '   options and no reply", not "needs sign-off", not "the plan was never approved". Silence is',
    '   not a signal here — approval is normally a silent drag of the card, with no comment ever',
    '   written. Without this rule, cards sat marked blocked-on-a-human in Ready, so no agent was',
    '   ever dispatched at them and no human was ever actually waiting.',
    '   If an issue really cannot proceed without an answer, the AGENT decides that after reading the',
    '   thread and parks it in Awaiting Feedback (start step 2a) — the survey never pre-empts that.',
    '   (dependency handling lives here too, as a predicate — never an in-run wait):',
    '   - A DEPENDENCY IS A COMMIT ORDER INSIDE ONE PR, OR A BLOCK. Every PR is based on ' + BASE_BRANCH + '.',
    '     There is no third answer (the work-heavy skill\'s "Dependent work", references/prs.md).',
    '   - a Ready card that depends on ANOTHER READY CARD IN THIS PASS is BATCHED into that card\'s',
    '     PR (step 5): the prerequisite leads, the dependent is a later member, and commit order',
    '     satisfies the dependency. Emit the dependent as its own item with startable:false +',
    '     blockedReason "batched into #<lead>".',
    '   - a sub-issue chain works the same way: consecutive open children batch into one PR, in',
    '     the API\'s order, led by the first. A child parked in Awaiting Feedback blocks the rest of',
    '     the chain ("child #<s> awaiting feedback") and is itself not startable.',
    '   - "depends on #A" / "blocked by #A" (in body or comments, or an obvious semantic dependency',
    '     like "add tests for #A") where #A is NOT in this pass — #A has an OPEN PR (gh pr',
    '     list --head claude/issue-<A> --state open), is In progress, or cannot be',
    '     worked this pass — is a BLOCK: startable:false, blockedReason "waiting on #A",',
    '     dependsOn=[<A>]. A later step records it with gh.sh blocked-by add. Never start the card.',
    '   - skip entirely (do not emit) any issue already In progress / In review (the scan phase owns',
    '     those) or in Awaiting Feedback (the human\'s court).',
    '   - skip entirely (do not emit) a sub-issue whose PARENT is In progress or has an open PR',
    '     (gh pr list --head claude/issue-<parent> --state open): the parent\'s',
    '     PR carries it.',
    '   - skip entirely (do not emit) any issue with a comment starting "Carried by #": an open PR',
    '     already carries it and closes it.',
    '   - read the blocks GitHub already records:',
    '     ' + GH_SH + ' blocked-by list <n>. A recorded blocker that is a Ready',
    '     card in this pass is a batch lead (above); any other open blocker blocks.',
    '   - put every OTHER ISSUE that must close first AND is not batched with this one in dependsOn,',
    '     and nothing else — a batch fold, a resource and a pending decision go in blockedReason as',
    '     prose. A later step records dependsOn on GitHub, so a guess there becomes a wrong block the',
    '     maintainer has to undo.',
    '4. Read each candidate issue (gh issue view <n> --comments) and SIZE its',
    '   per-issue agent. ' + RUBRIC,
    '   Trivial → issueModel "sonnet" / issueEffort "medium". Standard contained feature work →',
    '   "opus" / "high". Cross-cutting, schema/auth/migration, or architecturally open work →',
    '   "opus" / "xhigh".',
    '5. BATCH INTO ONE PR — THE DEFAULT, NOT THE EXCEPTION. PR count, not PR size, is the scarce',
    '   resource: every extra PR costs a full CI pass, a preview build, an E2E run, a smoke and a',
    '   human review, and CI capacity is usually limited. A pass that emits one PR per issue is a',
    '   FAILURE MODE — it converts a morning of work into a day of queueing. Budget about 3-6 PRs',
    '   for the whole pass and fit the startable issues into them.',
    '   Start from "these go together" and only split when a rule below forces it.',
    '   Group by SHARED BLAST RADIUS — the strongest signal is the same area of the codebase, since',
    '   those changes are reviewed, tested and reverted together: fixes to one page or component;',
    '   data fixes; one service or package; e2e/test-harness fixes; ops/CLI fixes; docs/copy. An',
    '   EPIC\'s consecutive open siblings and tightly-coupled issues that only make sense shipped',
    '   together always batch. Two issues that are the SAME BUG (or one is a duplicate of the other)',
    '   are one work item, never two PRs.',
    '   Prefer a batch of about 2-5 issues, led by the first member. NEVER batch: issues from',
    '   unrelated areas; a risky member (schema/auth/migration or',
    '   architecturally open — it stands alone); an issue already mid-flight in an open PR; or past',
    '   one-sitting reviewability. Within a batch the sibling order is satisfied by commit order (the',
    '   members land atomically in one merge), so later members do NOT need earlier ones IN THE SAME',
    '   BATCH closed first; a dependency OUTSIDE the batch is a block per step 3. On the LEAD',
    '   item set batch:[<lead>,<m2>,…] (ordered, lead first) and size it for the WHOLE batch (a batch',
    '   is non-trivial unless every member is trivial); emit each folded member as its own item with',
    '   startable:false + blockedReason "batched into #<lead>".',
    '',
    'Return {"empty": false, "items": [...]} — startable AND blocked items (blocked ones with',
    'blockedReason set) so the run report shows the whole queue.',
  ].filter(Boolean).join('\n')
}

function feedbackRelayPrompt(only, exclude) {
  const flags = (only ? ' --issue ' + only : '')
    + (exclude && exclude.length ? ' --exclude ' + exclude.join(',') : '')
  return [
    'You are the FEEDBACK-SCAN RELAY for the work-heavy-auto pipeline. Feedback + continuation-state',
    'detection is DETERMINISTIC — a script decides; you only run it and relay its output. READ ONLY:',
    'do NOT comment, move cards, or touch code, and do NOT second-guess the script\'s verdict.',
    '',
    'Run exactly:',
    '  ' + FEEDBACK_SH + flags,
    'It prints ONE JSON object: {"items":[{number,title,itemId,cardStatus,pr,state,smoke,newFeedback},…]}.',
    'Return that object VERBATIM as your structured output — it already matches the schema.',
    'If the script itself errors, return {"items":[],"error":"<one-line reason + stderr tail>"}.',
  ].join('\n')
}

// start: the whole pipeline for one fresh Ready work unit (an issue, or a batch
// of small related issues landing in the lead's single PR), in one agent.
function startPrompt(item) {
  const n = item.number
  const batch = (Array.isArray(item.batch) && item.batch.length > 1) ? item.batch : null
  // Every PR is based on the base branch. A dependency is a commit order inside one PR.
  const baseBranch = BASE_BRANCH
  const baseRef = BASE_REF
  return [
    (batch
      ? 'You own the BATCH of GitHub issues #' + batch.join(', #') + ' — lead #' + n + ' "' + item.title + '" —\n'
        + 'END TO END for this pass: ONE branch, ONE PR whose body closes ALL of them (the work-heavy skill\'s\n'
        + 'PR-batching section governs). Work the members IN THE LISTED ORDER; each member gets its own\n'
        + 'plan file, its own TDD tasks + issue-pinned tests and its own commits, while the EXPENSIVE\n'
        + 'gates (E2E, CI watch, preview, smoke) run ONCE for the whole batch — never per member.'
      : 'You own GitHub issue #' + n + ' "' + item.title + '" END TO END for this pass.') + ' Spawn your own',
    'sub-agents as needed. You are one of several per-issue agents running in parallel — stay inside',
    'your own worktree and lock the shared E2E stack as instructed below.',
    CONVENTIONS,
    '',
    'STEP 0 — READ THE THREAD (re-queue awareness; this may not be a first visit):',
    'gh issue view ' + n + ' --comments',
    batch ? '(batch: run the same read over EVERY member issue: #' + batch.join(', #') + ')' : null,
    '**THE CARD IS IN READY. THAT IS THE INSTRUCTION TO DO THE WORK — the ONLY one you need.**',
    'Whatever you find in the thread below, you are implementing this issue in this pass. A card',
    'the human put in Ready is never re-parked, and never re-asked.',
    '',
    '- A prior "<!-- work-heavy-auto:questions -->" or "<!-- work-heavy-auto:plan-confirm -->" comment means',
    '  this issue was parked once and the human has since MOVED IT BACK TO READY. That move is the',
    '  answer and the approval. Proceed — do not post those questions again, and do not re-park.',
    '- Human replies after such a comment are authoritative; fold them in, never re-ask what they',
    '  settle (their call wins, however terse).',
    '- **NO REPLY MEANS NOTHING. INFER NOTHING FROM SILENCE.** An unanswered question on a card that',
    '  sits in Ready is still approved work: most sign-offs here are a silent drag of the card, not a',
    '  comment. Treating "no reply" as "still waiting" made issues sit untouched for a whole day',
    '  while every pass reported the board as healthy. Where a question is',
    '  genuinely unanswered, take the most reasonable option, RECORD IT under the plan\'s',
    '  "Assumptions" heading, say so in your PR body, and keep going.',
    '',
    'READABILITY GATE (applies to EVERY comment, plan, PR body and doc page you write below —',
    'the work-heavy skill F2b/F2c; a human has to read these and has repeatedly found them cryptic):',
    '- THE READER SKIMS ~100 OF THESE A DAY and has read NOTHING else — not the issue, not your',
    '  earlier comments, not the plan, not the spec, not the page you linked. Every comment must',
    '  stand completely alone. Restate the one line of context it needs, even if you wrote it.',
    '- Lead with the answer. A sign-off request opens with what is wrong / what you will do / what',
    '  you need from the reader, in three lines, BEFORE any evidence.',
    '- Never write "the <something> trap/gap/problem" for a thing you have not just defined. "The"',
    '  claims the reader already knows which one you mean. Say the thing itself.',
    '- No noun stacks: "a corpus-wide role-accuracy figure" is not English. Unstack it with verbs.',
    '- Decisions get NUMBERED, LABELLED options so the reader can reply "2". Mark your recommendation.',
    '- Reference issues + PRs by BARE NUMBER (#1000). NEVER paste the title — it buries the sentence.',
    '- No coined jargon: no invented compounds or verbed nouns ("de-flake", "smoke it", "the ask"),',
    '  no status colour as a countable noun ("6 reds", "the red rate" -> "6 failures"), no internal',
    '  shorthand you have not defined in plain words on first use.',
    '- One idea per sentence. A semicolon or "and" joining two ideas means it is two sentences.',
    '- Never compress an argument into abstract noun phrases — write the reasoning steps out.',
    '- Rates not raw counts when denominators differ. Numbers carry their scope ("62 of 391").',
    '- MECHANICAL CHECK, mandatory: write the body to a file (you need --body-file anyway) and run',
    '  the plugin\'s readability.sh <file>  (' + SCRIPTS + '/docs/readability.sh).',
    '  Fix every error, then post. Exit 2 means vale is missing (brew install vale), and a missing',
    '  script means the plugin copy is incomplete — say so in your result rather than skipping the gate.',
    '- COLD READER, mandatory for a plan or a sign-off request: dispatch a fresh haiku sub-agent with',
    '  ONLY the text (no issue, no diff, no reasoning) and the F2c prompt — what is being asked? what',
    '  would change? quote every sentence you had to read twice; every unexplained term. If it cannot',
    '  state what is being asked, or quotes a re-read sentence, REWRITE and re-run. Do not argue.',
    '- RATCHET: anything the cold reader catches that readability.sh missed is a MISSING RULE. Name',
    '  the class of the miss (not the one instance) in your result notes, so a maintainer can add it',
    '  to the plugin\'s vale styles (' + SCRIPTS + '/docs/vale/). Do not edit them from this branch.',
    '',
    'STEP 1 — PLAN per the work-heavy skill fragment F2: map files to',
    'create/modify + responsibilities; bite-sized TDD-shaped tasks (failing test → watch it fail →',
    'minimal code → run → commit) naming the unit + integration tests each adds; goal, approach,',
    'risks. Classify the issue with the rubric and note it in the plan:',
    RUBRIC,
    '',
    'STEP 2 — GATE CHECK, one of three paths.',
    'Both parking paths are CLOSED to any issue that has been parked before (step 0): it is in Ready',
    'because the human put it there, and parking it again would loop it back to the same place it',
    'just came from. Park only work that has NEVER been parked.',
    '(a) You genuinely need a NEW human decision the thread does not settle — one that was NOT asked',
    '    in an earlier questions comment (ambiguous scope, a',
    '    product call, equally valid designs): post the questions on the issue — a comment starting',
    '    "<!-- work-heavy-auto:questions -->" then "**work-heavy-auto needs your input before starting this',
    '    issue.**", the numbered questions, and "_Answer in a reply, then drag this card from',
    '    **Awaiting Feedback** back to **Ready** to re-queue it._" (use --body-file; post it even if',
    '    an identical older one exists). Then ' + BOARD + ' move ' + item.itemId + ' awaiting',
    '    and EXIT: {number: ' + n + ', status: "needs-feedback", questions: [...]}. No branch, no PR.',
    (GATE
      ? '(b) The issue is NON-TRIVIAL, and step 0 found NO earlier questions or plan-confirm comment\n'
        + '    (a first visit — anything parked before is already approved and goes to (c)): post the\n'
        + '    FULL plan on the issue —\n'
        + '    a comment starting "<!-- work-heavy-auto:plan-confirm -->" then "**work-heavy-auto has planned this\n'
        + '    issue and wants your sign-off before implementing.**", the plan markdown, and "_Reply with\n'
        + '    any changes (they will be folded in), then drag this card from **Awaiting Feedback** back\n'
        + '    to **Ready** to approve the plan and start implementation._". Then\n'
        + '    ' + BOARD + ' move ' + item.itemId + ' awaiting\n'
        + '    and EXIT: {number: ' + n + ', status: "awaiting-confirm"}. No branch, no PR.'
      : '(b) [plan sign-off gate DISABLED this run (--no-confirm): skip straight to (c).]'),
    '(c) Otherwise — trivial, OR parked once already and now back in Ready (the common case)'
      + (GATE ? '' : ', or gate disabled') + ': proceed and implement.',
    '',
    'STEP 3 — WORKTREE + BRANCH + DRAFT PR:',
    worktreeBlock(n, baseRef),
    'git commit --allow-empty -m "chore: start #' + n + ' ' + item.title + '" -m "' + CLA + '"',
    'git push -u origin claude/issue-' + n,
    'gh pr create --draft --base ' + baseBranch + ' --head claude/issue-' + n,
    '  --title "<conventional-commits title> (#' + n + ')" --body-file <tmp with: the full plan, then '
      + (batch ? 'one "Closes #<k>" line for EACH of #' + batch.join(', #') + ' — the merge must close every member' : '"Closes #' + n + '"') + '>',
    'This is the ONE PR you open this pass. Base ' + baseBranch + ', and no second PR (see ONE PR, NEVER A SECOND above).',
    BOARD + ' move ' + item.itemId + ' progress'
      + (batch ? '   (and move each member\'s own card too — ' + BOARD + ' items to find their itemIds; a member with no card is fine)' : ''),
    batch
      ? 'Write the plan of record into the PR BODY — one section per member, for EACH of #' + batch.join(', #') + ', each naming its Test entry point:. There is no plan file to commit.'
      : 'Write the plan of record into the PR BODY, naming its Test entry point: (work-heavy skill F2/F2a). There is no plan file to commit.',
    '',
    'STEP 4 — IMPLEMENT:',
    disciplineBlock(n),
    batch
      ? 'BATCH: apply the discipline above PER MEMBER, in order — issue-pinned tests named for each\n'
        + 'member (issue_<k>_*), and the artifact gates run per member: ' + GATES_SH + ' <k> HEAD must\n'
        + 'print pass:true for EVERY one of #' + batch.join(', #') + ', not just the lead. The unit/lint/tsc\n'
        + 'suites run as you go; the E2E suite and CI watch below run ONCE, after the last member.'
      : null,
    '',
    'STEP 5 — ' + 'E2E:',
    e2eBlock(),
    '',
    'STEP 6 — ' + ciBlock(n),
    '',
    'STEP 7 — DROP OUT:',
    stateCommentBlock(n),
    batch ? '(batch: the state-comment body must name every member — #' + batch.join(', #') + ' — and where each stands.)' : null,
    'For this first pass "- attempts: 1". Green → "- next: waiting-human"; anything unfinished →',
    '"- next: resume: <exact pickup point>". Clean up the worktree (step 3 note) and return',
    '{number, status ("ci-green" or "failed"), branch, prUrl, previewUrl, title, notes}.',
  ].filter((l) => l !== null).join('\n')
}

// revise: a human left feedback on the open PR (or its issue) — action it.
function revisePrompt(item) {
  const n = item.number
  return [
    'You are the REVISION agent for the PR of GitHub issue #' + n + ' "' + item.title + '"',
    'on branch ' + item.branch + ' (' + item.prUrl + '). A human reviewed the work and left feedback;',
    'address ALL of it. Spawn your own sub-agents as needed.',
    CONVENTIONS,
    '',
    'FEEDBACK (deterministic scan — the comments quoted below are the asks; the live thread wins on',
    'wording):',
    item.feedback || '(digest missing — read the issue + PR threads yourself)',
    '',
    '1. REHYDRATE — read the full context before touching anything:',
    '   - the issue thread: gh issue view ' + n + ' --comments',
    '   - the PR thread (conversation, reviews, inline): gh pr view ' + item.prUrl + ' --comments,',
    '     plus gh api repos/' + REPO_SLUG + '/pulls/<prNumber>/reviews and .../comments',
    '   - the latest "<!-- work-heavy-auto:state -->" comment (what the last agent finished/assumed),',
    '   - the plan of record in the PR body, and the branch diff vs ' + BASE_REF + '.',
    '2. WORKTREE on the EXISTING branch:',
    worktreeBlock(n, 'origin/claude/issue-' + n),
    '3. The human\'s feedback is AUTHORITATIVE — treat each ask as a decision, even if you would have',
    '   chosen differently. Implement test-first with the same discipline as the original pass',
    '   (mattpocock-skills:tdd; mattpocock-skills:diagnosing-bugs on failures;',
    '   mattpocock-skills:code-review over the new diff, resolve Critical+Important; full relevant',
    '   suites re-run FRESH and green). When feedback changes behaviour, update the issue-pinned',
    '   issue_' + n + '_* tests so they still encode the accepted behaviour. Commit (with the trailer), push.',
    '4. ' + 'E2E:',
    e2eBlock(),
    '5. CI: gh pr checks claude/issue-' + n + ' --watch — green before you reply',
    '   (the PR is already ready; if it is somehow a draft, gh pr ready it).'
      + (PREVIEW_CHECK ? ' Capture the fresh preview URL (' + PREVIEW_CHECK + ').' : ''),
    '6. REPLY on the PR closing the loop — a comment whose FIRST line is exactly',
    '   "<!-- work-heavy-auto:revision ack:' + (item.feedbackIds || []).join(',') + ' -->"',
    '   (those ids are the feedback comments you are answering — the ack is how the scanner knows',
    '   they are handled; omit it and the SAME feedback re-fires every pass). Then a point-by-point',
    '   account: what each ask changed (file refs), answers to questions, honest pushback where an',
    '   ask conflicts with something (explain, never silently skip). Use --body-file.',
    '7. DROP OUT:',
    stateCommentBlock(n),
    '   "- acked: ' + (item.feedbackIds || []).join(',') + '", "- attempts: 1" (a revision resets the',
    '   resume counter), "- next: waiting-human" when green.',
    '   Clean up the worktree. If the feedback needed NO code change (pure questions /',
    '   already-addressed), reply (step 6, ack included) + state comment, and return status "replied".',
    '   Do NOT merge or close the PR; do NOT move the board card.',
    'Return {number, status ("ci-green", "replied" or "failed"), branch, prUrl, previewUrl, title, notes}.',
  ].join('\n')
}

// resume: an open PR whose last agent dropped out mid-pipeline (or crashed).
function resumePrompt(item) {
  const n = item.number
  return [
    'You are the RESUME agent for the PR of GitHub issue #' + n + ' "' + item.title + '"',
    'on branch ' + item.branch + (item.prUrl ? ' (' + item.prUrl + ')' : '') + '. A previous per-issue',
    'agent dropped out before finishing; continue from its continuation state — do NOT redo finished',
    'work. Spawn your own sub-agents as needed.',
    CONVENTIONS,
    '',
    'PICKUP POINT (from the last state comment; verify against reality before trusting it):',
    '  ' + (item.nextDetail || 'unknown — reconstruct from the thread'),
    '',
    '1. REHYDRATE: the issue thread (gh issue view ' + n + ' --comments), the PR thread, the latest',
    '   "<!-- work-heavy-auto:state -->" comment, the plan of record in the PR body',
    '   (if the body is still the placeholder, write the plan from the thread before coding), and the branch diff vs',
    '   ' + BASE_REF + '. If no PR exists at all, run the FULL start pipeline instead (worktree, draft PR,',
    '   card to In progress, plan of record) — the issue thread already holds any answers/sign-off.',
    '2. WORKTREE on the existing branch (or a fresh one off ' + BASE_REF + ' if no PR existed):',
    worktreeBlock(n, item.prUrl ? 'origin/claude/issue-' + n : BASE_REF),
    '3. FINISH THE PIPELINE from the pickup point, with the full discipline:',
    disciplineBlock(n),
    '4. ' + 'E2E:',
    e2eBlock(),
    '5. ' + ciBlock(n),
    '6. DROP OUT:',
    stateCommentBlock(n),
    '   Set "- attempts: ' + ((item.attempts || 0) + 1) + '" (one more than the previous state',
    '   comment). Green → "- next: waiting-human"; still unfinished → "- next: resume: <pickup>".',
    '   Clean up the worktree.',
    'Return {number, status ("ci-green" or "failed"), branch, prUrl, previewUrl, title, notes}.',
  ].join('\n')
}

function smokePrompt(item) {
  const n = item.number
  return [
    'PR ' + item.prUrl + ' (issue #' + n + ' "' + item.title + '") is open, green, and waiting on a human —',
    'but its current head has NOT been opened in a browser.',
    item.smokedAt
      ? 'The last smoke review was posted at ' + item.smokedAt + ', BEFORE the newest commit, so it is a'
      : 'There is no smoke review at all, so nothing has been checked.',
    item.smokedAt ? 'claim about code that is no longer on the branch.' : '',
    CONVENTIONS,
    '',
    'THIS IS A READ-ONLY CHECK. Do not write code, do not push, do not open a worktree, and do not',
    'reopen the work. If the preview is broken, say so in the review and stop — a human decides.',
    '',
    '1. Find the preview for the CURRENT head: ' + PREVIEW_CHECK + '.',
    '     gh pr view ' + n + ' --json headRefOid,statusCheckRollup',
    '   A GREEN commit status is NOT proof of a preview: a host can post "success" for a build it',
    '   skipped or cancelled. Read the deployment\'s own state, description and URL.',
    '   Confirm the deployment belongs to the',
    '   head sha; if it does not, or there is no preview yet, STOP and report status "awaiting-review"',
    '   with a note saying the preview has not arrived — do NOT smoke an older commit and call it done.',
    '2. Open it in Orca\'s built-in browser (orca tab create --url <url> --json; the orca-cli skill has',
    '   the commands). Visit the pages this PR touches plus a couple of core pages, and read the console.',
    '   For animation or motion work, TRIGGER the surface at a mobile viewport and verify it fires —',
    '   a static screenshot false-cleans an inert animation. Browser unavailable => fall back to an',
    '   HTTP 200 check and SAY SO in the review; never let it imply more than you did.',
    '3. Post the result as a REVIEW (not a bare comment) and re-add the label:',
    '     gh pr review ' + n + ' --comment --body "**Smoke tested** ..."',
    '     gh pr edit ' + n + ' --add-label smoke-tested',
    '   Use --comment, never --approve: GitHub refuses to let you approve your own PR.',
    '   NAME THE COMMIT SHA you opened in the first line — that is what makes the next scan able to',
    '   tell a fresh check from an expired one. State the preview url, the pages visited and the',
    '   console result. The label is dropped again automatically on the next push.',
    'Return one line: "#' + n + ' smoke: <ok|broken|no-preview> <url>".',
  ].filter(Boolean).join('\n')
}

function closeOutPrompt(item) {
  return [
    'PR ' + item.prUrl + ' for issue #' + item.number + ' is '
      + (item.merged ? 'MERGED' : 'CLOSED (not merged)') + ' — the work-heavy-auto loop for this issue is over.',
    CONVENTIONS,
    '',
    '1. Move the board card to Done: ' + BOARD + ' move ' + item.itemId + ' done',
    '1b. BATCHED PR check: read the PR body (gh pr view ' + item.prUrl + ' --json body).',
    '   If it closes OTHER issues besides #' + item.number + ' (one "Closes #<k>" line per member — a batched',
    '   PR per the work-heavy skill\'s PR-batching section), move each of those members\' own cards to Done',
    '   too (' + BOARD + ' items to find their itemIds; a member with no card needs nothing).',
    item.merged
      ? '2. The merge auto-closes the issue ("Closes #' + item.number + '" in the PR body).'
      : '2. The PR was closed WITHOUT merging (the human rejected or superseded it). Leave the issue as',
    item.merged ? '' : '   the human left it — do not reopen, comment, or delete anything.',
    '3. PARENT COMPLETION CHECK (sub-issue chains): find this issue\'s parent, if any:',
    '   gh api graphql -f query=\'{repository(owner:"' + REPO_OWNER + '",name:"' + REPO_NAME + '"){issue(number:' + item.number + '){parent{number title state}}}}\'',
    '   If there is a parent AND every one of its sub-issues is now closed',
    '   (gh api repos/' + REPO_SLUG + '/issues/<parent>/sub_issues — all',
    '   state "closed"): post a completion summary comment on the PARENT issue (first line',
    '   "**work-heavy-auto** — all sub-issues complete:", then one line per child: number, title, PR url),',
    '   and move the PARENT\'s card to In review (' + BOARD + ' items to find its itemId, then',
    '   ' + BOARD + ' move <parentItemId> review) — a human closes the parent. If the parent has open',
    '   sub-issues left, or there is no parent, do nothing here.',
    '',
    'Return a one-line confirmation (mention the parent action if you took one).',
  ].filter(Boolean).join('\n')
}

// ---------------------------------------------------------------------------
// Orchestration: Scan (feedback relay ∥ survey) → classify → fan out → report.
// ---------------------------------------------------------------------------
phase('Scan')
const fbScanP = agent(feedbackRelayPrompt(ONLY_ISSUE, EXCLUDE_ISSUES),
  { label: 'feedback-scan', phase: 'Scan', schema: FEEDBACK_SCAN_SCHEMA, model: 'haiku', effort: 'low' })
const surveyP = agent(surveyPrompt(!DRY_RUN),
  { label: 'survey', phase: 'Scan', schema: SURVEY_SCHEMA, model: 'sonnet', effort: 'high' })
// The roster runs alongside the survey purely so the script can CHECK it (below).
const rosterP = agent(readyListPrompt(),
  { label: 'ready-roster', phase: 'Scan', schema: READY_LIST_SCHEMA, model: 'haiku', effort: 'low' })
const [fbScan, survey, roster] = await parallel([() => fbScanP, () => surveyP, () => rosterP])

if (fbScan && fbScan.error) log('feedback scan failed: ' + fbScan.error)
const prActionsRaw = toActions(fbScan).filter((f) => inScope(f.number))
  .filter((f) => !ONLY_ISSUE || f.number === ONLY_ISSUE)
// A batched PR (one PR whose body closes several issues) surfaces once per member
// card in the scan, all pointing at the same PR. Conversation-level actions
// (revise / resume / stuck / waiting) must run ONCE per PR — keep the lead (the
// item whose issue number the branch carries, else the lowest number). close-out
// stays per-card so every member's card reaches Done; untracked has no PR at all.
const CONVO = new Set(['revise', 'resume', 'stuck', 'waiting'])
const leadFor = new Map()
for (const a of prActionsRaw) {
  if (!CONVO.has(a.action) || !a.prUrl) continue
  const cur = leadFor.get(a.prUrl)
  const isLead = a.branch === 'claude/issue-' + a.number
  const curIsLead = cur && cur.branch === 'claude/issue-' + cur.number
  if (!cur || (isLead && !curIsLead) || (isLead === curIsLead && a.number < cur.number)) leadFor.set(a.prUrl, a)
}
let prActions = prActionsRaw.filter((a) => !CONVO.has(a.action) || !a.prUrl || leadFor.get(a.prUrl) === a)
let surveyItems = ((survey && !survey.empty && Array.isArray(survey.items)) ? survey.items : [])
  .filter((i) => inScope(i.number))

// ---------------------------------------------------------------------------
// COMPLETENESS GATE — the survey must account for every Ready card.
// A dropped card is invisible by construction: the survey reports success, the
// pass looks healthy, and the issue is simply never worked (and every later pass
// repeats the loss). So diff the survey against the roster and
// re-survey the gap. A card covered by its EPIC's children counts as accounted
// for — expansion legitimately replaces the container with its children.
// ---------------------------------------------------------------------------
const results = []
const covered = (items) => {
  const s = new Set()
  for (const i of items) { s.add(i.number); if (i.parent) s.add(i.parent) }
  return s
}
const rosterNumbers = (roster && Array.isArray(roster.numbers) ? roster.numbers : [])
  .filter((n) => inScope(n))
  .filter((n) => !ONLY_ISSUE || n === ONLY_ISSUE)
if (rosterNumbers.length) {
  let seen = covered(surveyItems)
  let missing = rosterNumbers.filter((n) => !seen.has(n))
  if (missing.length) {
    log('survey dropped ' + missing.length + ' of ' + rosterNumbers.length
      + ' Ready cards (#' + missing.join(', #') + ') — re-surveying the gap')
    const gap = await agent(surveyPrompt(!DRY_RUN, missing),
      { label: 'survey-gap', phase: 'Scan', schema: SURVEY_SCHEMA, model: 'sonnet', effort: 'high' })
    const gapItems = ((gap && Array.isArray(gap.items)) ? gap.items : [])
      .filter((i) => inScope(i.number))
      .filter((i) => !seen.has(i.number))
    surveyItems = surveyItems.concat(gapItems)
    seen = covered(surveyItems)
    missing = rosterNumbers.filter((n) => !seen.has(n))
  }
  // Never let a drop pass silently a SECOND time: surface what is still unaccounted
  // for in the run report so the operator sees it instead of an apparently-clean pass.
  for (const n of missing) {
    results.push({ number: n, itemId: '', title: '(unsurveyed Ready card)', status: 'failed',
      notes: 'Ready card #' + n + ' was dropped by BOTH the survey and the gap re-survey — no agent '
        + 'was dispatched at it. Run: /work-heavy-auto --issue ' + n })
  }
  if (missing.length) log('STILL unsurveyed after gap pass: #' + missing.join(', #'))
}

let startable = surveyItems.filter((i) => i.startable)
const blocked = surveyItems.filter((i) => !i.startable)

for (const b of blocked) {
  results.push({ number: b.number, itemId: b.itemId, title: b.title, status: 'blocked', notes: b.blockedReason || 'blocked' })
}

// ---------------------------------------------------------------------------
// PEER-ACTIVITY GATE — never dispatch an agent at a worktree a live session holds.
// excludeIssues stays the deliberate human carve-out. This is the automatic net
// beneath it, for the collisions nobody remembered to name. A flagged issue is
// REPORTED as peer-owned with its evidence, never silently dropped.
// Fail closed: exit 2 means the check could not measure, which is not a pass.
// ---------------------------------------------------------------------------
// --- BEGIN peerVerdicts ---
// Turn the peer-activity relay's report into the set of issues no agent may touch.
// Extracted under these markers, and tested through them, because the workflow
// runtime evaluates this file as one script: a duplicate copy in a test file would
// drift and leave the suite green while the shipped code fails open.
//
// Every path that is not a measured 0 lands in the map. A missing verdict, a
// non-numeric exit code and a dead relay agent all mean the same thing — nobody
// measured this issue — and reading any of them as "clear" is exactly the silent
// pass this gate exists to remove.
function peerVerdicts(peer, candidates) {
  const owned = new Map()
  const wanted = new Set(candidates)
  const measured = new Set()
  for (const r of ((peer && Array.isArray(peer.items)) ? peer.items : [])) {
    if (!r || !wanted.has(r.number)) continue
    measured.add(r.number)
    if (r.exitCode === 0) continue
    if (r.exitCode === 5) {
      owned.set(r.number, r.evidence || 'peer_activity.sh reported an active peer')
    } else {
      owned.set(r.number, 'peer_activity.sh could not measure (exit ' + r.exitCode + '): '
        + (r.evidence || 'no reason given'))
    }
  }
  for (const n of wanted) {
    if (!measured.has(n)) {
      owned.set(n, 'the peer-activity check returned no verdict for #' + n
        + ' — treated as owned rather than guessed')
    }
  }
  return owned
}
// --- END peerVerdicts ---

// --- BEGIN peerCandidateNumbers ---
// EVERY In progress / In review card is measured, not only the ones this pass
// means to dispatch an agent at. prActions already holds one entry per such card,
// whatever the classifier made of it, so the whole list goes in.
//
// The four dispatch actions were the obvious candidates and they are not the whole
// risk. A session working outside this pipeline moves its card to In progress and
// opens no `claude/issue-<n>` PR, so the classifier calls it `untracked` and the
// pass used to report it as "not pipeline-owned, left alone" without ever asking
// whether somebody was live in it. `awaiting-review` hides the same thing. The
// check is cheap and reporting a held card is the point, so measure them all.
function peerCandidateNumbers(prActions, startable) {
  return [...new Set([
    ...prActions.map((f) => f.number),
    ...startable.map((i) => i.number),
  ])]
}
// --- END peerCandidateNumbers ---
const peerCandidates = peerCandidateNumbers(prActions, startable)
const peerOwned = new Map()
if (peerCandidates.length) {
  const peer = await agent(peerActivityPrompt([...new Set(peerCandidates)]),
    { label: 'peer-activity', phase: 'Scan', schema: PEER_SCHEMA, model: 'haiku', effort: 'low' })
  for (const [n, why] of peerVerdicts(peer, peerCandidates)) peerOwned.set(n, why)
}
if (peerOwned.size) {
  log('peer-owned this pass: #' + [...peerOwned.keys()].join(', #'))
  for (const [n, why] of peerOwned) {
    const it = prActions.find((f) => f.number === n) || startable.find((i) => i.number === n) || {}
    results.push({ number: n, itemId: it.itemId || '', prUrl: it.prUrl || '', title: it.title || ('#' + n),
      status: 'peer-owned',
      notes: 'another live session is working this issue, so no agent was dispatched — ' + why
        + '. Add it to excludeIssues if that session owns it for a while.' })
  }
}
const notPeer = (n) => !peerOwned.has(n)
// A peer-owned card is dropped from prActions whatever its action, so it reports
// once, as peer-owned. Filtering only the dispatch actions left an untracked or
// awaiting-review card reporting twice: peer-owned AND left-alone.
prActions = prActions.filter((f) => notPeer(f.number))
startable = startable.filter((i) => notPeer(i.number))

const describe = () => [
  ...prActions.map((f) => 'PR #' + f.number + ' [' + f.action + (f.action === 'close-out' ? (f.merged ? ', merged' : ', closed') : '') + ']'),
  ...startable.map((i) => 'start #' + i.number + ' [' + i.issueModel + '/' + i.issueEffort + (i.parent ? ', sub-issue of #' + i.parent : '') + (Array.isArray(i.batch) && i.batch.length > 1 ? ', batch closing #' + i.batch.join(' #') : '') + ']'),
  ...blocked.map((i) => 'blocked #' + i.number + ' (' + (i.blockedReason || '?') + ')'),
]

if (DRY_RUN) {
  log('Dry run — plan of attack:\n' + (describe().join('\n') || '(nothing to do)'))
  return { dryRun: true, actions: prActions, startable, blocked }
}

// Record every issue-to-issue dependency on GitHub. A block that lives only in a
// survey is one the maintainer cannot see, and the next pass pays to work it out
// again. GitHub clears the block itself when the blocker closes.
const deps = surveyItems.filter((i) => Array.isArray(i.dependsOn) && i.dependsOn.length)
if (deps.length) {
  log('recording ' + deps.length + ' issue dependencies on GitHub')
  await agent(
    'Record issue dependencies on GitHub for ' + REPO_SLUG + ', then report what you did.\n\n'
    + 'For each pair below, read what GitHub already holds and add only what is missing:\n'
    + '  ' + GH_SH + ' blocked-by list <n>\n'
    + '  ' + GH_SH + ' blocked-by add <n> <blocker#>\n\n'
    + 'Pairs (issue -> the issues that must close first):\n'
    + deps.map((i) => '#' + i.number + ' -> #' + i.dependsOn.join(', #')).join('\n')
    + '\n\nAdd nothing else. A blocker must be another ISSUE: skip a pair whose blocker is a pull '
    + 'request number, a batch fold, a resource or a pending decision. Change nothing else on any '
    + 'issue — no labels, no comments, no card moves.',
    { label: 'record-blocks', phase: 'Scan', model: 'sonnet', effort: 'low' },
  )
}
if (!prActions.length && !startable.length) {
  log('Ready empty (or all blocked) and no open work-heavy-auto PRs need attention.')
  return { empty: true, results }
}
log('This pass: ' + describe().join(', '))

// ---------------------------------------------------------------------------
// Fan out — ONE agent per startable item, all concurrent (the workflow caps
// slots; the E2E lock + per-issue worktrees keep them from colliding).
// --sequential runs them one at a time instead.
// ---------------------------------------------------------------------------
phase('Issues')

// --- BEGIN dedupeDispatch (extracted and executed by test_dispatch_dedupe.mjs) ---
// One agent per issue, per pass. Nothing else enforces this.
//
// prActions (revise/resume/smoke/close-out) and startable (Ready cards) are built by
// different code paths from different sources and share no key, so an issue with BOTH
// an open PR and a Ready card is dispatched at twice. The two agents then claim one
// worktree and one branch, and each recreates the other's.
//
// That is also why releasing an agent achieved nothing: its twin was already
// dispatched, so a fresh agent arrived minutes after each handover was agreed. prActions win, because an open PR is evidence that
// work already exists and starting fresh would branch over the top of it.
function dedupeDispatch(prActions = [], startable = [], exclude = []) {
  const claimed = new Set()
  const excluded = new Set(exclude)
  const rejected = []
  const take = (item, list) => {
    const n = item.number
    if (excluded.has(n)) { rejected.push({ number: n, reason: 'excluded' }); return }
    if (claimed.has(n)) { rejected.push({ number: n, reason: 'already claimed this pass' }); return }
    // A batch closes several issues in one PR, so it claims all of them; otherwise a
    // batch member also gets its own agent and the two fight over one branch.
    claimed.add(n)
    for (const m of item.batch || []) claimed.add(m)
    list.push(item)
  }
  const keptPr = []
  for (const f of prActions) take(f, keptPr)
  const keptStart = []
  for (const i of startable) take(i, keptStart)
  return { prActions: keptPr, startable: keptStart, rejected }
}
// --- END dedupeDispatch ---

const _dd = dedupeDispatch(prActions, startable, EXCLUDE_ISSUES)
for (const r of _dd.rejected) {
  log('skipped #' + r.number + ' — ' + r.reason)
  results.push({ number: r.number, title: '#' + r.number, status: 'blocked',
    notes: 'not dispatched: ' + r.reason + ' (one agent per issue per pass)' })
}
const prActionsD = _dd.prActions
const startableD = _dd.startable

const thunks = []

console.info('Queueing work for ' + prActionsD.length + ' open PRs')
for (const f of prActionsD) {
  if (f.action === 'untracked') {
    results.push({ number: f.number, itemId: f.itemId, title: f.title, status: 'untracked', notes: 'card is In progress / In review with no claude/issue-' + f.number + ' PR — not pipeline-owned, left alone (drag to Ready if work-heavy-auto should take it)' })
  } else if (f.action === 'waiting') {
    results.push({ number: f.number, itemId: f.itemId, prUrl: f.prUrl, title: f.title, status: 'awaiting-review', notes: 'PR open + green, no new feedback — waiting on the human' })
  } else if (f.action === 'smoke') {
    thunks.push(() => agent(smokePrompt(f), { label: 'smoke #' + f.number, phase: 'Issues', model: 'sonnet', effort: 'medium' })
      .then(() => results.push({
        number: f.number, itemId: f.itemId, prUrl: f.prUrl, title: f.title,
        status: 'awaiting-review',
        notes: 'PR open + green; re-checked the current head in a browser'
          + (f.smokedAt ? ' (previous check was pinned to ' + f.smokedAt + ')' : ' (never checked before)')
          + ' — waiting on the human',
      })))
  } else if (f.action === 'stuck') {
    results.push({ number: f.number, itemId: f.itemId, prUrl: f.prUrl, title: f.title, status: 'failed', notes: 'gave up after ' + f.attempts + ' resume attempts — needs a human comment (which re-enters it as feedback) or a close' })
  } else if (f.action === 'close-out') {
    thunks.push(() => agent(closeOutPrompt(f), { label: 'close #' + f.number, phase: 'Issues', model: 'haiku', effort: 'low' })
      .then(() => results.push({
        number: f.number, itemId: f.itemId, prUrl: f.prUrl, title: f.title,
        status: f.merged ? 'merged' : 'pr-closed',
        notes: (f.merged ? 'PR merged' : 'PR closed without merge') + ' — card moved to Done',
      })))
  } else { // revise | resume — a human conversation or a stuck pipeline: think properly
    const prompt = f.action === 'revise' ? revisePrompt(f) : resumePrompt(f)
    // agentType: the curated per-issue agent (this plugin's agents/issue-implementer.md) — its
    // body + preloaded discipline skills (work, TDD, github, docs) reinforce the
    // inline prompt; model/effort below still override its opus/high defaults per tier.
    thunks.push(() => agent(prompt, { label: f.action + ' #' + f.number, phase: 'Issues', agentType: 'issue-implementer', schema: RESULT_SCHEMA, model: 'opus', effort: 'xhigh' })
      .then((r) => results.push(r
        ? { itemId: f.itemId, title: f.title, prUrl: f.prUrl, ...r }
        : { number: f.number, itemId: f.itemId, prUrl: f.prUrl, title: f.title, status: 'failed', notes: f.action + ' agent died' })))
  }
}

// Every startable item is independent: a same-pass dependency was batched into
// one PR by the survey, and every other dependency is a block. No item waits.
console.info('Queueing a per-issue agent for ' + startableD.length + ' startable issues')
for (const i of startableD) {
  thunks.push(() => {
    const t = pickTier(i.issueModel, i.issueEffort, ['sonnet', 'opus'], 'opus', 'xhigh')
    console.debug('Starting #' + i.number + ' on ' + t.model + '/' + t.effort)
    // agentType: the curated per-issue agent (see revise/resume above); the survey's
    // per-issue sizing (t.model/t.effort) still overrides its defaults.
    return agent(startPrompt(i), { label: 'start #' + i.number, phase: 'Issues', agentType: 'issue-implementer', schema: RESULT_SCHEMA, model: t.model, effort: t.effort })
      .then((r) => results.push(r
        ? { itemId: i.itemId, title: i.title, ...r }
        : { number: i.number, itemId: i.itemId, title: i.title, status: 'failed', notes: 'per-issue agent died' }))
  })
}

if (SEQUENTIAL) {
  for (const t of thunks) await t()
} else {
  await parallel(thunks)
}

// ---------------------------------------------------------------------------
// Report. ci-green PRs are left in In progress — the ORCHESTRATOR (main thread)
// smokes each preview in Orca's browser and promotes the card to In review.
// ---------------------------------------------------------------------------
const count = (s) => results.filter((r) => r.status === s).length
log('Done: ' + count('ci-green') + ' CI-green (ready for main-thread smoke), '
  + (count('merged') + count('pr-closed')) + ' PRs closed out, '
  + (count('awaiting-review') + count('replied')) + ' with the reviewer, '
  + count('needs-feedback') + ' parked on questions, '
  + count('awaiting-confirm') + ' awaiting plan sign-off, '
  + count('blocked') + ' blocked (dependency this pass cannot work), '
  + count('untracked') + ' untracked (no pipeline PR — left alone), '
  + count('peer-owned') + ' peer-owned (a live session holds the worktree — left alone), '
  + count('failed') + ' failed.')

return { results }
