module issue_workflow {
  const INIT_MODE: str
  const MODE_SWITCH: bool
  const MAX_ROUNDS: int
  const HUMAN_JUMPS: bool

  type Workflow = {
    state: str,
    previous: str,
    mode: str,
    steering: str,
    level: str,
    baseChecked: bool,
    attempts: int,
    checksEv: str,
    smokeEv: str,
    smokeDue: bool,
    merged: bool,
    recorded: bool,
  }

  type Interview = {
    asked: int,
    answered: int,
    trust: bool,
    askedAfterTrust: bool,
    posted: bool,
    pane: bool,
    chat: bool,
    closed: bool,
    paneStale: bool,
    byFollowUp: bool,
    leftEmptyHeavy: bool,
  }

  type Pr = {
    life: str,
    draft: bool,
    checks: str,
    mergeable: str,
    feedback: bool,
    orphaned: bool,
  }

  type Branch = { change: bool, unpushed: bool }

  type Move = { ok: bool, state: str, previous: str }

  type Facts = {
    mode: str,
    steering: str,
    level: str,
    smoke: bool,
    feedback: bool,
    docsOnly: bool,
    noChange: bool,
    prMerged: bool,
    prOpen: bool,
  }

  pure val MODES = Set("light", "heavy", "hack")
  pure val LEVELS = Set("straw_man", "poc", "small_project", "formal_project")
  pure val HELD = Set("blocked", "wait")
  pure val PAST_DEVELOPMENT = Set("reviewing", "ci", "smoke", "finishing")
  pure val MERGEABLE_BEFORE_DONE = Set("reviewing", "ci", "smoke", "revising")
  pure val BEFORE_REVIEW = Set("interviewing", "planning", "developing", "hardening")
  pure val BEFORE_PR = Set("setup", "interviewing", "planning", "developing", "hardening")
  pure val GOTO = Set("setup", "interviewing", "planning", "developing", "hardening", "reviewing", "ci", "smoke", "finishing", "revising", "done")
  pure val ATTEMPT_LIMIT = 3

  pure val REFUSED: Move = { ok: false, state: "", previous: "" }
  pure def goTo(s: str): Move = { ok: true, state: s, previous: "" }
  pure def hold(s: str, previous: str): Move = { ok: true, state: s, previous: previous }

  pure def mayMerge(level: str): bool = level == "straw_man" or level == "poc"
  pure def needsPlanSignOff(steering: str, level: str): bool = steering == "interactive" and not(mayMerge(level))
  pure def interviews(mode: str): bool = mode != "hack"
  pure def afterInterview(mode: str): str = if (mode == "heavy") "planning" else "developing"
  pure def firstState(mode: str, steering: str): str =
    if (steering == "interactive" and interviews(mode)) "interviewing" else afterInterview(mode)
  pure def reopen(mode: str): str = if (mode == "hack") "hardening" else "developing"
  pure def hasBaseCheck(mode: str): bool = mode != "hack"
  pure def holdsLocally(state: str, mode: str): bool = state == "hardening" or (mode == "hack" and state == "developing")
  pure def holdsForReview(state: str): bool = state == "reviewing" or state == "developed"

  pure def leavePlan(f: Facts): Move =
    if (needsPlanSignOff(f.steering, f.level)) hold("blocked", "developing") else goTo("developing")

  pure def frontMove(state: str, tool: str, f: Facts): Move =
    if (state == "interviewing" and tool == "interview") goTo(afterInterview(f.mode))
    else if (state == "planning" and tool == "finishedPlan") leavePlan(f)
    else if (state == "developing" and tool == "finishedDevelopment" and f.mode != "hack") goTo("reviewing")
    else if (state == "developing" and tool == "finishedHacking" and f.mode == "hack") goTo("hardening")
    else if (state == "hardening" and tool == "finishedDevelopment") goTo("reviewing")
    else REFUSED

  pure def afterTool(state: str, previous: str, tool: str, f: Facts): Move =
    if (tool == "followUpIssue") hold(state, previous)
    else if (tool == "unblocked") (if (state == "blocked" and previous != "") goTo(previous) else REFUSED)
    else if (tool == "waitEnded") (if (state == "wait" and previous != "") goTo(previous) else REFUSED)
    else if (tool == "setAuto" and state == "blocked")
      hold(state, if (previous == "interviewing") afterInterview(f.mode) else previous)
    else if (HELD.contains(state)) REFUSED
    else if (tool == "blocked" or tool == "wait") (if (state == "done") REFUSED else hold(tool, state))
    else if (tool == "setAuto")
      (if (state == "done") REFUSED else goTo(if (state == "interviewing") afterInterview(f.mode) else state))
    else if (tool == "followUpOther") (if (state == "done") REFUSED else goTo(state))
    else if (tool == "followUpThisAgent")
      (if (state == "done" or state == "setup") REFUSED
       else goTo(if (PAST_DEVELOPMENT.contains(state)) reopen(f.mode) else state))
    else if (tool == "checkpoint")
      (if (state == "developed") goTo(reopen(f.mode))
       else if (Set("developing", "hardening", "reviewing", "revising", "ci").contains(state)) goTo(state)
       else if (state == "finishing" and f.docsOnly and f.smoke) goTo("smoke")
       else if (state == "smoke" or state == "finishing") goTo(if (f.docsOnly) state else "ci")
       else if (state == "done" and f.prOpen) goTo("ci")
       else REFUSED)
    else if (frontMove(state, tool, f).ok) frontMove(state, tool, f)
    else if (tool == "finishedReview" and state == "reviewing") goTo("ci")
    else if (tool == "finishedChecks" and (state == "ci" or state == "finishing")) goTo(if (f.smoke) "smoke" else "finishing")
    else if (tool == "finishedSmoke" and state == "smoke") goTo("finishing")
    else if (tool == "finishedRevision" and state == "revising") goTo("ci")
    else if (tool == "done" and f.noChange and BEFORE_REVIEW.contains(state)) goTo("done")
    else if (tool == "done" and f.prMerged and MERGEABLE_BEFORE_DONE.contains(state)) goTo("done")
    else if (tool == "done" and state == "finishing") goTo(if (f.feedback) "revising" else "done")
    else REFUSED

  pure def skipTarget(state: str, mode: str): str =
    if (state == "planning") "developing"
    else if (state == "developing") (if (mode == "hack") "hardening" else "reviewing")
    else if (state == "hardening") "reviewing"
    else if (state == "reviewing") "ci"
    else if (state == "ci") "finishing"
    else if (state == "smoke") "finishing"
    else if (state == "revising") "ci"
    else ""

  pure def afterSkip(state: str, mode: str, steering: str): Move =
    if (state == "setup") goTo(firstState(mode, steering))
    else if (state == "interviewing") goTo(afterInterview(mode))
    else if (skipTarget(state, mode) != "") goTo(skipTarget(state, mode))
    else REFUSED

  pure def factsOf(w: Workflow): Facts = {
    mode: w.mode, steering: w.steering, level: w.level,
    smoke: false, feedback: false, docsOnly: false, noChange: false, prMerged: false, prOpen: false,
  }

  pure def inInterview(w: Workflow): bool =
    w.state == "interviewing" or (HELD.contains(w.state) and w.previous == "interviewing")

  pure def canPost(i: Interview, p: Pr): bool = i.answered == 0 or i.posted or p.life != "none"

  pure def closeFile(i: Interview): Interview =
    { ...i, posted: i.posted or i.answered > 0, chat: false, closed: true, paneStale: i.pane }

  pure def exitProblem(w: Workflow, i: Interview): bool =
    w.mode == "heavy" and w.steering == "interactive" and i.answered == 0 and not(i.byFollowUp)

  pure def pushed(p: Pr): Pr =
    if (p.life == "planned") { ...p, life: "open", draft: true, checks: "pending", mergeable: "clean" }
    else if (p.life == "open") { ...p, checks: "pending" }
    else if (p.life == "merged" or p.life == "closed") { ...p, orphaned: true }
    else p

  pure def headIsPrHead(p: Pr, b: Branch): bool = not(b.unpushed) and not(p.orphaned)

  pure def doneProblems(w: Workflow, p: Pr, b: Branch): bool =
    b.unpushed
    or w.checksEv == "none"
    or (w.checksEv != "human" and p.checks != "green")
    or w.smokeEv == "stale"
    or p.life != "open"
    or p.draft
    or p.mergeable != "clean"
    or p.orphaned

  pure def delivered(w: Workflow, p: Pr, b: Branch, issue: str): bool =
    p.life == "merged"
    or (issue == "closed" and p.life != "open" and not(b.change))
    or (p.life == "open" and not(p.draft) and p.mergeable == "clean" and headIsPrHead(p, b)
        and w.checksEv != "none" and (w.checksEv == "human" or p.checks == "green"))

  var wf: Workflow
  var iv: Interview
  var pr: Pr
  var branch: Branch
  var issue: str
  var visited: Set[str]
  var last: str
  var humanMoved: bool

  action init = {
    nondet level = LEVELS.oneOf()
    nondet steering = Set("interactive", "auto").oneOf()
    initWith(level, steering)
  }

  action initWith(level: str, steering: str): bool = all {
    LEVELS.contains(level),
    steering == "interactive" or (steering == "auto" and INIT_MODE != "hack"),
    wf' = {
      state: "setup", previous: "", mode: INIT_MODE, steering: steering, level: level,
      baseChecked: false, attempts: 0, checksEv: "none", smokeEv: "none", smokeDue: INIT_MODE == "hack", merged: false, recorded: false,
    },
    iv' = {
      asked: 0, answered: 0, trust: false, askedAfterTrust: false, posted: false, pane: false, chat: false,
      closed: false, paneStale: false, byFollowUp: false, leftEmptyHeavy: false,
    },
    pr' = { life: "none", draft: false, checks: "none", mergeable: "clean", feedback: false, orphaned: false },
    branch' = { change: false, unpushed: false },
    issue' = "open",
    visited' = Set("setup"),
    last' = "init",
    humanMoved' = false,
  }

  action moved(w: Workflow, m: Move, tool: str): bool = all {
    m.ok,
    wf' = { ...w, state: m.state, previous: m.previous },
    visited' = visited.union(Set(m.state)),
    last' = tool,
  }

  action started = {
    nondet scriptsMissing = Set(true, false).oneOf()
    nondet blockerOpen = Set(true, false).oneOf()
    nondet byFollowUp = Set(true, false).oneOf()
    nondet opensPr = Set(true, false).oneOf()
    startedWith(scriptsMissing, blockerOpen, byFollowUp, opensPr)
  }

  pure def setUpPr(p: Pr, scriptsMissing: bool, opensPr: bool): Pr =
    if (scriptsMissing or p.life != "none") p
    else if (opensPr) { ...p, life: "open", draft: true, checks: "pending", mergeable: "clean" }
    else { ...p, life: "planned" }

  action startedWith(scriptsMissing: bool, blockerOpen: bool, byFollowUp: bool, opensPr: bool): bool = all {
    wf.state == "setup",
    issue == "open" or wf.recorded,
    val first = firstState(wf.mode, wf.steering)
    val m = if (scriptsMissing) goTo("setup") else if (blockerOpen) hold("blocked", first) else goTo(first)
    all {
      moved({ ...wf, recorded: true }, m, "started"),
      pr' = setUpPr(pr, scriptsMissing, opensPr),
      iv' = { ...iv, byFollowUp: byFollowUp },
      branch' = branch, issue' = issue, humanMoved' = humanMoved,
    }
  }

  action startedReplacesMergedPr = {
    nondet opensPr = Set(true, false).oneOf()
    startedReplacesMergedPrWith(opensPr)
  }

  action startedReplacesMergedPrWith(opensPr: bool): bool = all {
    val stage = if (HELD.contains(wf.state)) wf.previous else wf.state
    all {
      BEFORE_PR.contains(stage),
      not(wf.merged),
      issue == "open",
      pr.life == "merged",
      wf' = wf, visited' = visited, last' = "startedReplacesMergedPr",
      pr' = setUpPr({ life: "none", draft: false, checks: "none", mergeable: "clean", feedback: false, orphaned: false }, stage == "setup", opensPr),
      iv' = iv, branch' = branch, issue' = issue, humanMoved' = humanMoved,
    }
  }

  action startedAfterDone = all {
    wf.state == "done",
    pr.life == "open",
    pr.feedback or pr.mergeable == "conflict",
    moved(wf, goTo("revising"), "startedAfterDone"),
    iv' = iv, pr' = pr, branch' = branch, issue' = issue, humanMoved' = humanMoved,
  }

  action startedEndsWait = all {
    wf.state == "wait",
    moved(wf, goTo(if (wf.previous != "") wf.previous else firstState(wf.mode, wf.steering)), "startedEndsWait"),
    iv' = iv, pr' = pr, branch' = branch, issue' = issue, humanMoved' = humanMoved,
  }

  action askRound(inChat: bool): bool = all {
    afterTool(wf.state, wf.previous, "interview", factsOf(wf)).ok,
    wf.steering == "interactive",
    inChat or not(iv.pane),
    iv.asked < MAX_ROUNDS,
    not(iv.trust),
    val asked = { ...iv, asked: iv.asked + 1, askedAfterTrust: iv.askedAfterTrust or iv.trust }
    iv' = if (inChat) { ...asked, chat: true } else { ...asked, pane: true },
    wf' = wf, visited' = visited, last' = if (inChat) "askChat" else "askPane",
    pr' = pr, branch' = branch, issue' = issue, humanMoved' = humanMoved,
  }

  action paneEnds = {
    nondet outcome = Set("submitted", "dismissed", "trustMeBro").oneOf()
    nondet someAnswers = Set(true, false).oneOf()
    nondet postOk = Set(true, false).oneOf()
    paneEndsWith(outcome, someAnswers, postOk)
  }

  action paneEndsWith(outcome: str, someAnswers: bool, postOk: bool): bool = all {
    iv.pane,
    wf.state == "interviewing",
    not(iv.paneStale),
    val answers = outcome != "dismissed" or someAnswers
    all {
      iv' = {
        ...iv,
        pane: false,
        trust: iv.trust or outcome == "trustMeBro",
        answered: if (answers) iv.answered + 1 else iv.answered,
        posted: if (answers) postOk and pr.life != "none" else iv.posted,
      },
      wf' = wf, visited' = visited, last' = "paneEnds",
      pr' = pr, branch' = branch, issue' = issue, humanMoved' = humanMoved,
    }
  }

  action paneAbandoned = all {
    iv.pane,
    wf.state != "interviewing" or iv.paneStale,
    iv' = { ...iv, pane: false, paneStale: false },
    wf' = wf, visited' = visited, last' = "paneAbandoned",
    pr' = pr, branch' = branch, issue' = issue, humanMoved' = humanMoved,
  }

  action chatAnswers = {
    nondet postOk = Set(true, false).oneOf()
    chatAnswersWith(postOk)
  }

  action chatAnswersWith(postOk: bool): bool = all {
    iv.chat,
    afterTool(wf.state, wf.previous, "interview", factsOf(wf)).ok,
    iv' = { ...iv, chat: false, answered: iv.answered + 1, posted: postOk and pr.life != "none" },
    wf' = wf, visited' = visited, last' = "chatAnswers",
    pr' = pr, branch' = branch, issue' = issue, humanMoved' = humanMoved,
  }

  action leaveInterview = all {
    not(iv.pane),
    not(exitProblem(wf, iv)),
    canPost(iv, pr),
    val m = afterTool(wf.state, wf.previous, "interview", factsOf(wf))
    val w = if (m.state == "developing" and hasBaseCheck(wf.mode)) { ...wf, baseChecked: true } else wf
    all {
      moved(w, m, "leaveInterview"),
      iv' = { ...closeFile(iv), leftEmptyHeavy: iv.leftEmptyHeavy or exitProblem(wf, iv) },
      pr' = pr, branch' = branch, issue' = issue, humanMoved' = humanMoved,
    }
  }

  action setAuto = all {
    wf.mode != "hack",
    wf.steering == "interactive",
    not(inInterview(wf)) or canPost(iv, pr),
    val m = afterTool(wf.state, wf.previous, "setAuto", factsOf(wf))
    all {
      moved({ ...wf, steering: "auto" }, m, "setAuto"),
      iv' = if (inInterview(wf)) closeFile(iv) else iv,
      pr' = pr, branch' = branch, issue' = issue, humanMoved' = humanMoved,
    }
  }

  action finishedInterview = all {
    wf.state == "developing",
    not(wf.baseChecked),
    wf' = { ...wf, baseChecked: true }, visited' = visited, last' = "finishedInterview",
    iv' = iv, pr' = pr, branch' = branch, issue' = issue, humanMoved' = humanMoved,
  }

  action finishedPlan = all {
    pr.life != "none",
    moved({ ...wf, baseChecked: true }, afterTool(wf.state, wf.previous, "finishedPlan", factsOf(wf)), "finishedPlan"),
    iv' = iv, pr' = pr, branch' = branch, issue' = issue, humanMoved' = humanMoved,
  }

  action checkpoint(commits: bool): bool = {
    nondet docsOnly = Set(true, false).oneOf()
    checkpointWith(commits, docsOnly)
  }

  action checkpointWith(commits: bool, docsOnly: bool): bool = all {
    not(wf.state == "done") or pr.life == "open",
    not(MERGEABLE_BEFORE_DONE.contains(wf.state) and pr.life == "merged"),
    not(wf.state == "developing" and hasBaseCheck(wf.mode) and not(wf.baseChecked)),
    pr.life != "none",
    val local = holdsLocally(wf.state, wf.mode)
    val keep = holdsForReview(wf.state) or local
    all {
      commits or (branch.unpushed and not(keep)),
      val keepEvidence = not(commits) or docsOnly
      val checksEv = if (keepEvidence) wf.checksEv else "none"
      val smokeEv = if (keepEvidence or wf.smokeEv == "none") wf.smokeEv else "stale"
      val f = {
        ...factsOf(wf),
        prOpen: wf.state == "done" and pr.life == "open" and not(wf.merged),
        docsOnly: keepEvidence and checksEv != "none",
        smoke: wf.smokeDue and smokeEv != "head" and checksEv != "human",
      }
      val m = afterTool(wf.state, wf.previous, "checkpoint", f)
      all {
        moved({ ...wf, checksEv: checksEv, smokeEv: smokeEv }, m, if (commits) "checkpoint" else "pushHeld"),
        branch' = { change: branch.change or commits, unpushed: keep },
        pr' = if (keep) pr else { ...pushed(pr), feedback: if (wf.state == "revising") false else pr.feedback },
        iv' = iv, issue' = issue, humanMoved' = humanMoved,
      }
    }
  }

  action finishedHacking = all {
    moved(wf, afterTool(wf.state, wf.previous, "finishedHacking", factsOf(wf)), "finishedHacking"),
    branch' = { ...branch, change: true, unpushed: true },
    iv' = iv, pr' = pr, issue' = issue, humanMoved' = humanMoved,
  }

  action finishedDevelopment = {
    nondet commits = Set(true, false).oneOf()
    finishedDevelopmentWith(commits)
  }

  action finishedDevelopmentWith(commits: bool): bool = all {
    not(wf.state == "developing" and hasBaseCheck(wf.mode) and not(wf.baseChecked)),
    all {
      branch.change or commits,
      moved({ ...wf, checksEv: if (commits) "none" else wf.checksEv }, afterTool(wf.state, wf.previous, "finishedDevelopment", factsOf(wf)), "finishedDevelopment"),
      branch' = { change: true, unpushed: branch.unpushed or commits },
      iv' = iv, pr' = pr, issue' = issue, humanMoved' = humanMoved,
    }
  }

  action finishedReview = all {
    pr.life == "open" or pr.life == "planned",
    moved(wf, afterTool(wf.state, wf.previous, "finishedReview", factsOf(wf)), "finishedReview"),
    val p = pushed(pr)
    pr' = if (p.life == "open") { ...p, draft: false } else p,
    branch' = { ...branch, unpushed: false },
    iv' = iv, issue' = issue, humanMoved' = humanMoved,
  }

  action finishedChecks = {
    nondet smoke = Set(true, false).oneOf()
    finishedChecksWith(smoke)
  }

  action finishedChecksWith(needsSmoke: bool): bool = all {
    afterTool(wf.state, wf.previous, "finishedChecks", factsOf(wf)).ok,
    pr.life != "merged",
    headIsPrHead(pr, branch),
    pr.checks != "pending",
    if (pr.checks == "red") all {
      val attempts = wf.attempts + 1
      if (attempts >= ATTEMPT_LIMIT)
        moved({ ...wf, attempts: attempts }, hold("blocked", wf.state), "finishedChecksRedBlocked")
      else all { wf' = { ...wf, attempts: attempts }, visited' = visited, last' = "finishedChecksRed" },
    } else all {
      val smoke = needsSmoke or wf.smokeDue
      moved({ ...wf, attempts: 0, checksEv: "agent" }, afterTool(wf.state, wf.previous, "finishedChecks", { ...factsOf(wf), smoke: smoke }), "finishedChecks"),
    },
    iv' = iv, pr' = pr, branch' = branch, issue' = issue, humanMoved' = humanMoved,
  }

  action finishedSmoke = all {
    moved({ ...wf, smokeEv: "head" }, afterTool(wf.state, wf.previous, "finishedSmoke", factsOf(wf)), "finishedSmoke"),
    iv' = iv, pr' = pr, branch' = branch, issue' = issue, humanMoved' = humanMoved,
  }

  action answerFeedback = all {
    wf.state == "revising",
    pr.feedback,
    pr' = { ...pr, feedback: false },
    wf' = wf, visited' = visited, last' = "answerFeedback",
    iv' = iv, branch' = branch, issue' = issue, humanMoved' = humanMoved,
  }

  action finishedRevision = all {
    not(pr.feedback),
    moved(wf, afterTool(wf.state, wf.previous, "finishedRevision", factsOf(wf)), "finishedRevision"),
    iv' = iv, pr' = pr, branch' = branch, issue' = issue, humanMoved' = humanMoved,
  }

  action doneNoChange = all {
    BEFORE_REVIEW.contains(wf.state),
    issue == "closed",
    pr.life == "merged" or not(branch.change),
    pr.life != "open",
    wf.state != "interviewing" or canPost(iv, pr),
    moved({ ...wf, merged: pr.life == "merged" }, afterTool(wf.state, wf.previous, "done", { ...factsOf(wf), noChange: true }), "done"),
    iv' = if (wf.state == "interviewing") closeFile(iv) else iv, pr' = pr, branch' = branch, issue' = issue, humanMoved' = humanMoved,
  }

  action doneAfterHumanMerge = all {
    MERGEABLE_BEFORE_DONE.contains(wf.state) or wf.state == "finishing",
    pr.life == "merged",
    not(branch.unpushed),
    val f = { ...factsOf(wf), prMerged: MERGEABLE_BEFORE_DONE.contains(wf.state) }
    moved({ ...wf, merged: true }, afterTool(wf.state, wf.previous, "done", f), "done"),
    iv' = iv, pr' = pr, branch' = branch, issue' = issue, humanMoved' = humanMoved,
  }

  action doneWithFeedback = all {
    wf.state == "finishing",
    pr.life == "open",
    pr.feedback,
    moved(wf, afterTool(wf.state, wf.previous, "done", { ...factsOf(wf), feedback: true }), "doneWithFeedback"),
    iv' = iv, pr' = pr, branch' = branch, issue' = issue, humanMoved' = humanMoved,
  }

  action doneReady = all {
    wf.state == "finishing",
    pr.life != "merged",
    not(pr.feedback),
    not(doneProblems(wf, pr, branch)),
    val merges = mayMerge(wf.level)
    all {
      moved({ ...wf, merged: merges }, afterTool(wf.state, wf.previous, "done", factsOf(wf)), "done"),
      pr' = if (merges) { ...pr, life: "merged" } else pr,
      issue' = if (merges) "closed" else issue,
      iv' = iv, branch' = branch, humanMoved' = humanMoved,
    }
  }

  action agentHolds(tool: str): bool = all {
    moved(wf, afterTool(wf.state, wf.previous, tool, factsOf(wf)), tool),
    iv' = iv, pr' = pr, branch' = branch, issue' = issue, humanMoved' = humanMoved,
  }

  action followUpThisAgent = all {
    pr.life != "merged",
    pr.life != "closed",
    moved(wf, afterTool(wf.state, wf.previous, "followUpThisAgent", factsOf(wf)), "followUpThisAgent"),
    iv' = iv, pr' = if (pr.life == "planned") pushed(pr) else pr, branch' = branch, issue' = issue, humanMoved' = humanMoved,
  }

  action humanUnblock = all {
    moved(wf, afterTool(wf.state, wf.previous, "unblocked", factsOf(wf)), "humanUnblock"),
    iv' = iv, pr' = pr, branch' = branch, issue' = issue, humanMoved' = humanMoved,
  }

  action humanEndsWait = all {
    moved(wf, afterTool(wf.state, wf.previous, "waitEnded", factsOf(wf)), "humanEndsWait"),
    iv' = iv, pr' = pr, branch' = branch, issue' = issue, humanMoved' = humanMoved,
  }

  action humanMovesTo(verb: str, target: Move): bool = all {
    HUMAN_JUMPS,
    target.ok,
    val leaves = inInterview(wf) and target.state != "interviewing"
    all {
      not(leaves) or canPost(iv, pr),
      val from = wf.state
      val pastReview = from == "reviewing" and not(Set("developing", "planning", "reviewing").contains(target.state))
      val checksEv =
        if (from == "ci" and verb == "skip") "human"
        else if (verb == "goto" and Set("finishing", "smoke", "done").contains(target.state) and wf.checksEv == "none") "human"
        else wf.checksEv
      val smokeEv = if (from == "smoke" and verb == "skip") "head" else wf.smokeEv
      all {
        moved({ ...wf, checksEv: checksEv, smokeEv: smokeEv, attempts: 0 }, target, if (verb == "skip") "humanSkip" else "humanGoto"),
        pr' = if (pastReview and pr.life == "open") { ...pr, draft: false } else pr,
        humanMoved' = true,
        iv' = if (leaves) closeFile(iv) else iv,
        branch' = branch, issue' = issue,
      }
    }
  }

  action humanSkip = humanMovesTo("skip", afterSkip(wf.state, wf.mode, wf.steering))

  action humanGoto = {
    nondet target = GOTO.oneOf()
    humanGotoTo(target)
  }

  action humanGotoTo(target: str): bool = all {
    all {
      target != wf.state,
      target != "done" or (pr.life != "none" and pr.life != "planned" and not(branch.unpushed)),
      humanMovesTo("goto", goTo(target)),
    }
  }

  action humanSetsMode = {
    nondet mode = MODES.oneOf()
    humanSetsModeTo(mode)
  }

  action humanSetsModeTo(mode: str): bool = all {
    MODE_SWITCH,
    all {
      mode != wf.mode,
      mode != "hack" or wf.steering == "interactive",
      wf' = { ...wf, mode: mode, smokeDue: mode == "hack" },
      visited' = visited, last' = "humanSetsMode", humanMoved' = true,
      iv' = iv, pr' = pr, branch' = branch, issue' = issue,
    }
  }

  action humanSetsAuto = all {
    wf.steering == "interactive",
    wf.mode != "hack",
    wf' = { ...wf, steering: "auto" },
    visited' = visited, last' = "humanSetsAuto",
    iv' = iv, pr' = pr, branch' = branch, issue' = issue, humanMoved' = humanMoved,
  }

  action waitEnds = all {
    wf.state == "wait",
    moved(wf, goTo(if (wf.previous != "") wf.previous else "developing"), "waitEnds"),
    iv' = iv, pr' = pr, branch' = branch, issue' = issue, humanMoved' = humanMoved,
  }

  action watchdogBlocksClosedPr = all {
    pr.life == "merged" or pr.life == "closed",
    not(HELD.contains(wf.state)),
    wf.state != "done",
    moved(wf, hold("blocked", wf.state), "watchdogBlocksClosedPr"),
    iv' = iv, pr' = pr, branch' = branch, issue' = issue, humanMoved' = humanMoved,
  }

  action watchdogSeesMerge = all {
    wf.state == "done",
    pr.life == "merged",
    not(wf.merged),
    wf' = { ...wf, merged: true }, visited' = visited, last' = "watchdogSeesMerge",
    iv' = iv, pr' = pr, branch' = branch, issue' = issue, humanMoved' = humanMoved,
  }

  action watchdogBlocksStall = all {
    not(HELD.contains(wf.state)),
    wf.state != "done",
    wf.recorded,
    moved(wf, hold("blocked", wf.state), "watchdogBlocksStall"),
    iv' = iv, pr' = pr, branch' = branch, issue' = issue, humanMoved' = humanMoved,
  }

  action humanSetsInteractive = all {
    wf.steering == "auto",
    wf' = { ...wf, steering: "interactive" },
    visited' = visited, last' = "humanSetsInteractive",
    iv' = iv, pr' = pr, branch' = branch, issue' = issue, humanMoved' = humanMoved,
  }

  action github(event: str, p: Pr, i: str): bool = all {
    pr' = p, issue' = i,
    wf' = wf, visited' = visited, last' = event,
    iv' = iv, branch' = branch, humanMoved' = humanMoved,
  }

  action ciEnds = {
    nondet result = Set("green", "red").oneOf()
    ciEndsWith(result)
  }

  action ciEndsWith(result: str): bool = all {
    pr.life == "open", pr.checks == "pending",
    github("ciEnds", { ...pr, checks: result }, issue),
  }

  action baseMoves = {
    nondet m = Set("clean", "conflict", "unknown").oneOf()
    baseMovesTo(m)
  }

  action baseMovesTo(m: str): bool = all {
    pr.life == "open",
    all { m != pr.mergeable, github("baseMoves", { ...pr, mergeable: m }, issue) },
  }

  action reviewerComments = all {
    pr.life == "open", not(pr.feedback),
    github("reviewerComments", { ...pr, feedback: true }, issue),
  }

  action humanMergesPr = all {
    pr.life == "open", not(pr.draft), pr.mergeable == "clean",
    github("humanMergesPr", { ...pr, life: "merged" }, "closed"),
  }

  action humanClosesPr = all {
    pr.life == "open",
    github("humanClosesPr", { ...pr, life: "closed" }, issue),
  }

  action humanReopensPr = all {
    pr.life == "closed",
    github("humanReopensPr", { ...pr, life: "open", orphaned: false, mergeable: "unknown" }, issue),
  }

  action humanConvertsToDraft = all {
    pr.life == "open", not(pr.draft),
    github("humanConvertsToDraft", { ...pr, draft: true }, issue),
  }

  action humanClosesIssue = all {
    issue == "open",
    github("humanClosesIssue", pr, "closed"),
  }

  action humanReopensIssue = all {
    issue == "closed",
    github("humanReopensIssue", pr, "open"),
  }

  action agentStep = any {
    started, startedReplacesMergedPr, startedAfterDone, startedEndsWait,
    nondet inChat = Set(true, false).oneOf()
    askRound(inChat),
    chatAnswers, leaveInterview, setAuto, finishedInterview, finishedPlan,
    nondet commits = Set(true, false).oneOf()
    checkpoint(commits),
    finishedHacking, finishedDevelopment, finishedReview, finishedChecks, finishedSmoke,
    answerFeedback, finishedRevision,
    doneNoChange, doneAfterHumanMerge, doneWithFeedback, doneReady,
    nondet tool = Set("blocked", "wait").oneOf()
    agentHolds(tool),
    followUpThisAgent, waitEnds,
  }

  action humanStep = any {
    paneEnds, paneAbandoned,
    humanUnblock, humanEndsWait, humanSkip, humanGoto, humanSetsMode, humanSetsInteractive, humanSetsAuto,
  }

  action watchdogStep = any { watchdogBlocksClosedPr, watchdogSeesMerge, watchdogBlocksStall }

  action githubStep = any {
    ciEnds, baseMoves, reviewerComments, humanMergesPr, humanClosesPr, humanReopensPr,
    humanConvertsToDraft, humanClosesIssue, humanReopensIssue,
  }

  action step = any { agentStep, humanStep, githubStep, watchdogStep }

  val heldHasPrevious: bool =
    HELD.contains(wf.state) iff (wf.previous != "" and not(HELD.contains(wf.previous)))

  val noRoundAfterTrust: bool = not(iv.askedAfterTrust)

  val atMostOneRoundWithoutAnswers: bool = iv.answered <= iv.asked

  val agentAsksBeforeHeavyPlan: bool = not(iv.leftEmptyHeavy)

  val fixedMode: bool = not(MODE_SWITCH) and not(humanMoved)

  val lightNeverPlans: bool = (INIT_MODE == "light" and fixedMode) implies not(visited.contains("planning"))

  val heavyPlansBeforeCode: bool =
    (INIT_MODE == "heavy" and fixedMode and visited.contains("developing") and not(visited.contains("done"))) implies visited.contains("planning")

  val heavyPlansAfterReopen: bool =
    (INIT_MODE == "heavy" and fixedMode and visited.contains("developing")) implies visited.contains("planning")

  val hackHardensBeforeReview: bool =
    (INIT_MODE == "hack" and fixedMode and visited.contains("reviewing")) implies visited.contains("hardening")

  val hackNeverInterviews: bool =
    (INIT_MODE == "hack" and fixedMode) implies not(visited.contains("interviewing"))

  val checksBeforeFinishing: bool = wf.state == "finishing" implies wf.checksEv != "none"

  val redPastLimitBlocks: bool = last == "finishedChecksRed" implies wf.attempts < ATTEMPT_LIMIT

  val agentDoneDelivers: bool =
    (last == "done" and wf.state == "done") implies delivered(wf, pr, branch, issue)

  val prOpensOnlyAfterStart: bool = pr.life != "none" implies wf.recorded

  val answersReachGitHub: bool = (iv.answered > 0 and not(inInterview(wf))) implies iv.posted

  val noChatRoundOutsideInterview: bool = iv.chat implies inInterview(wf)

  val noWorkLeftBehind: bool = (last == "done" and wf.state == "done") implies (not(branch.unpushed) and not(pr.orphaned))

  val safety: bool = and {
    heldHasPrevious, noRoundAfterTrust, atMostOneRoundWithoutAnswers, agentAsksBeforeHeavyPlan,
    lightNeverPlans, heavyPlansBeforeCode, hackHardensBeforeReview, hackNeverInterviews,
    checksBeforeFinishing, redPastLimitBlocks, agentDoneDelivers, prOpensOnlyAfterStart,
    noChatRoundOutsideInterview, answersReachGitHub,
  }

  val findings: bool = and { heavyPlansAfterReopen, noWorkLeftBehind }

  val wInterviewing: bool = wf.state == "interviewing"
  val wPlanning: bool = wf.state == "planning"
  val wDeveloping: bool = wf.state == "developing"
  val wHardening: bool = wf.state == "hardening"
  val wReviewing: bool = wf.state == "reviewing"
  val wCi: bool = wf.state == "ci"
  val wSmoke: bool = wf.state == "smoke"
  val wFinishing: bool = wf.state == "finishing"
  val wRevising: bool = wf.state == "revising"
  val wBlocked: bool = wf.state == "blocked"
  val wWait: bool = wf.state == "wait"
  val wDone: bool = wf.state == "done"
  val wDoneMergedByAgent: bool = last == "done" and wf.state == "done" and wf.merged and visited.contains("finishing") and not(humanMoved)
  val wDoneAwaitingHuman: bool = last == "done" and wf.state == "done" and pr.life == "open"
  val wDoneNoChange: bool = last == "done" and wf.state == "done" and not(visited.contains("reviewing"))
  val wDoneAfterHumanMerge: bool = last == "done" and wf.merged and not(visited.contains("finishing"))
  val wPlanSignOff: bool = wf.state == "blocked" and wf.previous == "developing" and last == "finishedPlan"
  val wTrust: bool = iv.trust
  val wChatAnswered: bool = last == "chatAnswers"
  val wInterviewPosted: bool = iv.closed and iv.answered > 0 and iv.posted
  val wPrReplaced: bool = last == "startedReplacesMergedPr"
  val wChecksBlocked: bool = last == "finishedChecksRedBlocked"
  val wRevisedAfterDone: bool = last == "startedAfterDone"
  val wReopenedAfterReview: bool = last == "followUpThisAgent" and wf.state == reopen(wf.mode) and visited.contains("ci")
  val wPrReady: bool = pr.life == "open" and not(pr.draft)
}

module light {
  import issue_workflow(INIT_MODE = "light", MODE_SWITCH = false, MAX_ROUNDS = 3, HUMAN_JUMPS = false).*
}

module heavy {
  import issue_workflow(INIT_MODE = "heavy", MODE_SWITCH = false, MAX_ROUNDS = 3, HUMAN_JUMPS = false).*
}

module hack {
  import issue_workflow(INIT_MODE = "hack", MODE_SWITCH = false, MAX_ROUNDS = 3, HUMAN_JUMPS = false).*
}

module steered {
  import issue_workflow(INIT_MODE = "light", MODE_SWITCH = true, MAX_ROUNDS = 3, HUMAN_JUMPS = true).*
}
