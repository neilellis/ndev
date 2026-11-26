module epic_workflow {
  const SUBS: Set[int]
  const DEPS: int -> Set[int]
  const PARALLEL: int
  const ROUND_LIMIT: int
  const MAX_DEBT: int
  const HUMAN_JUMPS: bool

  val PHASES = List("framing", "researching", "specifying", "deciding", "spec-review", "slicing", "coordinating", "closing", "done")
  val IN_FLIGHT = Set("implementing", "reviewing", "fixing", "verified", "external")
  val PUSHED = Set("reviewing", "fixing", "verified")
  val MAIN = -1

  type Sub = {
    state: str,
    previous: str,
    rounds: int,
    stackedOn: int,
    startBase: int,
    reviewed: bool,
    verifiedBase: int,
    headVerified: bool,
    briefed: bool,
  }

  type Pr = {
    life: str,
    draft: bool,
    base: int,
    checks: str,
    mergeable: str,
    ridesOn: int,
    landed: bool,
    lost: bool,
    afterBrief: bool,
  }

  type Debts = { open: int, ruled: int, override: bool }

  var phase: str
  var sliced: bool
  var subs: int -> Sub
  var prs: int -> Pr
  var issues: int -> str
  var debts: Debts
  var last: str
  var closedBy: str

  pure def nextPhase(p: str): str =
    val i = PHASES.indices().filter(k => PHASES[k] == p).fold(0, (a, k) => k)
    if (i + 1 < PHASES.length()) PHASES[i + 1] else p

  val UNSLICED: Sub = { state: "unsliced", previous: "", rounds: 0, stackedOn: MAIN, startBase: MAIN, reviewed: false, verifiedBase: MAIN, headVerified: false, briefed: false }
  val NO_PR: Pr = { life: "none", draft: true, base: MAIN, checks: "none", mergeable: "unknown", ridesOn: MAIN, landed: false, lost: false, afterBrief: false }

  def merged(j: int): bool = subs.get(j).state == "merged"
  def openBlockers(i: int): Set[int] = DEPS.get(i).filter(j => not(merged(j)))
  def inFlight: Set[int] = SUBS.filter(j => IN_FLIGHT.contains(subs.get(j).state))

  def below(t: int): Set[int] =
    val a = subs.get(t).stackedOn
    val b = if (a == MAIN) MAIN else subs.get(a).stackedOn
    val c = if (b == MAIN) MAIN else subs.get(b).stackedOn
    Set(a, b, c).exclude(Set(MAIN))

  def stackRefused(i: int): bool =
    val open = openBlockers(i)
    open.exists(b => not(PUSHED.contains(subs.get(b).state))) or
      (open != Set() and not(open.exists(t => open.forall(o => o == t or below(t).contains(o)))))

  def stackTop(i: int): int =
    val open = openBlockers(i)
    open.filter(t => open.forall(o => o == t or below(t).contains(o))).fold(MAIN, (a, t) => t)

  def debtUp(d: Debts, n: int, override: bool): Debts = { ...d, open: d.open + n, override: d.override or override }

  def landAbove(ps: int -> Pr, t: int): int -> Pr =
    ps.keys().fold(ps, (acc, k) =>
      if (acc.get(k).ridesOn == t and acc.get(k).life == "merged") acc.set(k, { ...acc.get(k), landed: true }) else acc)

  def landFrom(ps: int -> Pr, t: int): int -> Pr =
    val one = landAbove(ps, t)
    val two = SUBS.fold(one, (acc, k) => if (acc.get(k).ridesOn == t) landAbove(acc, k) else acc)
    SUBS.fold(two, (acc, k) =>
      if (acc.get(k).ridesOn != MAIN and acc.get(acc.get(k).ridesOn).ridesOn == t) landAbove(acc, k) else acc)

  action init = all {
    phase' = "framing",
    sliced' = false,
    subs' = SUBS.mapBy(_ => UNSLICED),
    prs' = SUBS.mapBy(_ => NO_PR),
    issues' = SUBS.mapBy(_ => "open"),
    debts' = { open: 0, ruled: 0, override: false },
    last' = "init",
    closedBy' = "",
  }

  action setSub(i: int, s: Sub, name: str): bool = all {
    subs' = subs.set(i, s),
    prs' = prs, issues' = issues, phase' = phase, sliced' = sliced, debts' = debts,
    last' = name, closedBy' = closedBy,
  }

  def sliceSub(i: int, ext: Set[int]): Sub =
    if (subs.get(i).state != "unsliced") subs.get(i)
    else if (ext.contains(i)) { ...UNSLICED, state: "external" }
    else { ...UNSLICED, state: "waiting" }

  def slicePr(i: int, ext: Set[int]): Pr =
    if (ext.contains(i) and subs.get(i).state == "unsliced") { ...NO_PR, life: "open", checks: "pending", mergeable: "clean" }
    else prs.get(i)

  action finishSlicing(ext: Set[int]): bool = all {
    phase == "slicing",
    SUBS.forall(i => issues.get(i) == "open"),
    ext.forall(i => subs.get(i).state == "unsliced" and prs.get(i).life == "none"),
    phase' = nextPhase(phase),
    sliced' = true,
    subs' = SUBS.mapBy(i => sliceSub(i, ext)),
    prs' = SUBS.mapBy(i => slicePr(i, ext)),
    issues' = issues, debts' = debts,
    last' = phase,
    closedBy' = closedBy,
  }

  action finishPhase = all {
    phase != "done",
    phase != "slicing" or SUBS.forall(i => issues.get(i) == "open"),
    phase != "coordinating" or SUBS.forall(i => merged(i)),
    phase != "closing" or (debts.open == 0 and SUBS.forall(i => merged(i))),
    phase' = nextPhase(phase),
    sliced' = (sliced or phase == "slicing"),
    subs' = if (phase == "slicing") SUBS.mapBy(i => if (subs.get(i).state == "unsliced") { ...UNSLICED, state: "waiting" } else subs.get(i)) else subs,
    prs' = prs, issues' = issues, debts' = debts,
    last' = phase,
    closedBy' = if (phase == "closing") "closing" else closedBy,
  }

  action humanMove(target: str): bool = all {
    HUMAN_JUMPS,
    phase != "done",
    target != "done",
    debts.open < MAX_DEBT,
    phase' = target,
    debts' = debtUp(debts, 1, true),
    sliced' = sliced, subs' = subs, prs' = prs, issues' = issues,
    last' = "human", closedBy' = closedBy,
  }

  action humanSkip = humanMove(nextPhase(phase))
  action humanGoto = nondet target = PHASES.indices().map(k => PHASES[k]).oneOf()
    humanMove(target)

  action ruleDebt = all {
    debts.open > 0,
    debts' = { ...debts, open: debts.open - 1, ruled: debts.ruled + 1 },
    phase' = phase, sliced' = sliced, subs' = subs, prs' = prs, issues' = issues,
    last' = "rule", closedBy' = closedBy,
  }

  action recordDebt = all {
    phase != "done",
    debts.open < MAX_DEBT,
    debts' = debtUp(debts, 1, false),
    phase' = phase, sliced' = sliced, subs' = subs, prs' = prs, issues' = issues,
    last' = "debt", closedBy' = closedBy,
  }

  action brief(i: int): bool =
    val s = subs.get(i)
    all {
      phase == "coordinating",
      s.state == "waiting",
      prs.get(i).life != "open",
      not(stackRefused(i)),
      val t = stackTop(i)
      all {
        t == MAIN or prs.get(t).life == "open",
        subs' = subs.set(i, { ...s, stackedOn: t, briefed: true }),
        prs' = prs.set(i, { ...prs.get(i), afterBrief: false }),
        issues' = issues, phase' = phase, sliced' = sliced, debts' = debts,
        last' = "brief", closedBy' = closedBy,
      },
    }

  action start(i: int): bool =
    val s = subs.get(i)
    all {
      phase == "coordinating",
      s.state == "waiting",
      not(stackRefused(i)),
      stackTop(i) == MAIN or s.stackedOn == stackTop(i),
      inFlight.size() < PARALLEL,
      prs.get(i).life == "open" implies prs.get(i).afterBrief,
      setSub(i, { ...s, state: "implementing", startBase: s.stackedOn, briefed: false }, "start"),
    }

  action toReviewing(i: int): bool =
    val s = subs.get(i)
    all {
      phase == "coordinating",
      s.state == "implementing",
      prs.get(i).life != "none",
      setSub(i, { ...s, state: "reviewing" }, "reviewing"),
    }

  action toFixing(i: int): bool =
    val s = subs.get(i)
    all {
      phase == "coordinating",
      s.state == "reviewing",
      setSub(i, { ...s, state: "fixing", rounds: s.rounds + 1, reviewed: true }, "fixing"),
    }

  action fixedToReviewing(i: int): bool =
    val s = subs.get(i)
    all {
      phase == "coordinating",
      s.state == "fixing",
      setSub(i, { ...s, state: "reviewing" }, "reviewing"),
    }

  action verify(i: int): bool =
    val s = subs.get(i)
    val p = prs.get(i)
    all {
      phase == "coordinating",
      s.state == "reviewing",
      p.life == "open",
      not(p.draft),
      p.base == MAIN,
      p.mergeable == "clean",
      Set("green", "skipped").contains(p.checks),
      s.stackedOn == MAIN or merged(s.stackedOn),
      p.checks == "green" or debts.open < MAX_DEBT,
      subs' = subs.set(i, { ...s, state: "verified", stackedOn: MAIN, verifiedBase: p.base, reviewed: true, headVerified: true }),
      debts' = if (p.checks == "skipped") debtUp(debts, 1, false) else debts,
      prs' = prs, issues' = issues, phase' = phase, sliced' = sliced,
      last' = "verify", closedBy' = closedBy,
    }

  action recordMerged(i: int): bool =
    val s = subs.get(i)
    val early = s.state != "verified" or not(s.headVerified)
    val override = not(Set("reviewing", "fixing", "verified", "external").contains(s.state))
    val owed = (if (s.reviewed) 0 else 1) + (if (early) 1 else 0) + (if (override) 1 else 0)
    all {
      phase == "coordinating",
      s.state != "merged",
      prs.get(i).life == "merged",
      prs.get(i).landed,
      debts.open + owed <= MAX_DEBT,
      subs' = subs.set(i, { ...s, state: "merged" }),
      debts' = debtUp(debts, owed, override),
      prs' = prs, issues' = issues, phase' = phase, sliced' = sliced,
      last' = "merged", closedBy' = closedBy,
    }

  action reimport(i: int): bool =
    val s = subs.get(i)
    val p = prs.get(i)
    all {
      phase == "coordinating",
      if (s.state == "external") all {
        p.life == "closed",
        subs' = subs.set(i, { ...s, state: "waiting", briefed: false }),
        prs' = prs.set(i, NO_PR),
        issues' = issues, phase' = phase, sliced' = sliced, debts' = debts,
        last' = "reimport", closedBy' = closedBy,
      } else all {
        s.state == "waiting",
        p.life != "merged",
        subs' = subs.set(i, { ...s, state: "external", stackedOn: MAIN, briefed: false }),
        prs' = prs.set(i, if (p.life == "open") { ...p, afterBrief: false } else { ...NO_PR, life: "open", checks: "pending", mergeable: "clean" }),
        issues' = issues, phase' = phase, sliced' = sliced, debts' = debts,
        last' = "reimport", closedBy' = closedBy,
      },
    }

  action reimportStillWaiting(i: int): bool = all {
    phase == "coordinating",
    subs.get(i).state == "waiting",
    Set("none", "closed").contains(prs.get(i).life),
    subs' = subs.set(i, { ...subs.get(i), briefed: false }),
    prs' = prs.set(i, { ...prs.get(i), afterBrief: false }),
    issues' = issues, phase' = phase, sliced' = sliced, debts' = debts,
    last' = "reimport", closedBy' = closedBy,
  }

  def lostNow(i: int): bool =
    val p = prs.get(i)
    p.life == "merged" and not(p.landed) and (p.lost or prs.get(p.ridesOn).life == "closed")

  action recordLost(i: int): bool =
    val s = subs.get(i)
    all {
      phase == "coordinating",
      s.state != "merged",
      s.state != "blocked",
      lostNow(i),
      setSub(i, { ...s, state: "blocked", previous: s.state }, "lost"),
    }

  action block(i: int): bool =
    val s = subs.get(i)
    all {
      phase == "coordinating",
      s.state != "blocked",
      s.state != "merged",
      s.state != "unsliced",
      s.state != "external",
      setSub(i, { ...s, state: "blocked", previous: s.state }, "block"),
    }

  action unblock(i: int): bool =
    val s = subs.get(i)
    all {
      phase == "coordinating",
      s.state == "blocked",
      IN_FLIGHT.contains(s.previous) implies inFlight.size() < PARALLEL,
      setSub(i, { ...s, state: s.previous, previous: "" }, "unblock"),
    }

  action setPr(i: int, p: Pr, name: str): bool = all {
    prs' = prs.set(i, p),
    subs' = subs, issues' = issues, phase' = phase, sliced' = sliced, debts' = debts,
    last' = name, closedBy' = closedBy,
  }

  action workerOpensPr(i: int): bool =
    val s = subs.get(i)
    all {
      s.state == "implementing" or (s.state == "waiting" and s.briefed),
      Set("none", "closed").contains(prs.get(i).life),
      setPr(i, { ...NO_PR, life: "open", base: if (s.state == "waiting") s.stackedOn else s.startBase, checks: "pending", mergeable: "clean", afterBrief: true }, "openPr"),
    }

  action otherOwnerOpensPr(i: int, after: bool): bool = all {
    phase == "coordinating",
    subs.get(i).state == "waiting",
    prs.get(i).life == "none",
    setPr(i, { ...NO_PR, life: "open", checks: "pending", mergeable: "clean", afterBrief: subs.get(i).briefed and after }, "otherOpensPr"),
  }

  action reverify(i: int): bool =
    val s = subs.get(i)
    all {
      phase == "coordinating",
      s.state == "verified",
      not(s.headVerified),
      prs.get(i).life == "open",
      setSub(i, { ...s, state: "reviewing" }, "reverify"),
    }

  action workerPushes(i: int): bool = all {
    Set("implementing", "fixing", "verified", "blocked").contains(subs.get(i).state),
    prs.get(i).life == "open",
    subs' = subs.set(i, { ...subs.get(i), headVerified: false }),
    prs' = prs.set(i, { ...prs.get(i), checks: "pending" }),
    issues' = issues, phase' = phase, sliced' = sliced, debts' = debts,
    last' = "push", closedBy' = closedBy,
  }

  action workerMarksReady(i: int): bool = all {
    prs.get(i).life == "open",
    prs.get(i).draft,
    subs.get(i).state != "waiting",
    setPr(i, { ...prs.get(i), draft: false }, "ready"),
  }

  action retarget(i: int): bool =
    val p = prs.get(i)
    all {
      p.life == "open",
      p.base != MAIN,
      prs.get(p.base).life == "merged",
      setPr(i, { ...p, base: MAIN }, "retarget"),
    }

  action ciEndsWith(i: int, r: str): bool = all {
    prs.get(i).life == "open",
    prs.get(i).checks == "pending",
    setPr(i, { ...prs.get(i), checks: r }, "ci"),
  }

  action ciEnds(i: int): bool = nondet r = Set("green", "red", "skipped").oneOf()
    ciEndsWith(i, r)

  action baseMovesTo(i: int, m: str): bool = all {
    prs.get(i).life == "open",
    setPr(i, { ...prs.get(i), mergeable: m }, "base"),
  }

  action baseMoves(i: int): bool = nondet m = Set("clean", "conflict").oneOf()
    baseMovesTo(i, m)

  action humanMergesPr(i: int): bool =
    val p = prs.get(i)
    all {
      p.life == "open",
      p.mergeable == "clean",
      if (p.base == MAIN) all {
        prs' = landFrom(prs.set(i, { ...p, life: "merged", landed: true }), i),
        issues' = issues.set(i, "closed"),
      } else all {
        prs' = prs.set(i, { ...p, life: "merged", ridesOn: p.base, lost: prs.get(p.base).life != "open" }),
        issues' = issues,
      },
      subs' = subs, phase' = phase, sliced' = sliced, debts' = debts,
      last' = "humanMerge", closedBy' = closedBy,
    }

  action humanClosesPr(i: int): bool = all {
    prs.get(i).life == "open",
    setPr(i, if (prs.get(i).afterBrief or subs.get(i).state == "external") { ...prs.get(i), life: "closed" } else NO_PR, "closePr"),
  }

  action humanReopensPr(i: int): bool = all {
    prs.get(i).life == "closed",
    setPr(i, { ...prs.get(i), life: "open", checks: "pending" }, "reopenPr"),
  }

  action coordinatorStep = any {
    finishPhase,
    nondet ext = SUBS.powerset().oneOf()
    finishSlicing(ext),
    ruleDebt,
    recordDebt,
    nondet i = SUBS.oneOf()
    any { brief(i), start(i), toReviewing(i), toFixing(i), fixedToReviewing(i), verify(i), reverify(i), recordMerged(i), recordLost(i), block(i), unblock(i), reimport(i), reimportStillWaiting(i) },
  }

  action workerStep = nondet i = SUBS.oneOf()
    any { workerOpensPr(i), workerPushes(i), workerMarksReady(i), retarget(i) }

  action githubStep = nondet i = SUBS.oneOf()
    any { ciEnds(i), baseMoves(i), humanMergesPr(i), humanClosesPr(i), humanReopensPr(i), nondet after = Set(true, false).oneOf() otherOwnerOpensPr(i, after) }

  action humanStep = any { humanSkip, humanGoto }

  action step = any { coordinatorStep, workerStep, githubStep, humanStep }

  val blockedHasPrevious = SUBS.forall(i => subs.get(i).state == "blocked" implies subs.get(i).previous != "")
  val subsMoveOnlyAfterSlicing = not(sliced) implies SUBS.forall(i => subs.get(i).state == "unsliced")
  val mergedRecordMeansPrMerged = SUBS.forall(i => merged(i) implies prs.get(i).life == "merged")
  val verifiedOnMain = SUBS.forall(i => subs.get(i).state == "verified" implies (prs.get(i).base == MAIN and subs.get(i).stackedOn == MAIN))
  val doneOnlyByClosing = phase == "done" implies closedBy == "closing"
  val doneHasNoOpenDebt = phase == "done" implies debts.open == 0
  val doneMergesAll = phase == "done" implies SUBS.forall(i => merged(i))
  val startedRespectsBlockers = SUBS.forall(i =>
    (subs.get(i).state == "implementing" and last == "start") implies
      (openBlockers(i) == Set() or (not(stackRefused(i)) and subs.get(i).startBase == stackTop(i))))
  val stackedOnPushedBlocker = SUBS.forall(i =>
    (subs.get(i).state == "implementing" and last == "start" and subs.get(i).startBase != MAIN) implies
      PUSHED.union(Set("merged")).contains(subs.get(subs.get(i).startBase).state))

  val safety = and {
    blockedHasPrevious,
    subsMoveOnlyAfterSlicing,
    mergedRecordMeansPrMerged,
    verifiedOnMain,
    doneOnlyByClosing,
    doneHasNoOpenDebt,
    doneMergesAll,
    startedRespectsBlockers,
    stackedOnPushedBlocker,
    parallelRespected,
    mainStartsOnLandedBlockers,
    mergedWorkIsNotLost,
    aPrAfterTheBriefKeepsTheBrief,
    coordinatorWorksOnlyOnPrsAfterTheBrief,
  }

  val parallelRespected =
    inFlight.filter(j => subs.get(j).state != "external").size() <= PARALLEL and
      (Set("start", "unblock").contains(last) implies inFlight.size() <= PARALLEL)
  val mainStartsOnLandedBlockers = SUBS.forall(i =>
    (IN_FLIGHT.contains(subs.get(i).state) and subs.get(i).state != "external" and subs.get(i).startBase == MAIN) implies
      DEPS.get(i).forall(j => prs.get(j).landed))
  val mergedWorkIsNotLost = SUBS.forall(i => merged(i) implies not(prs.get(i).lost))
  val aPrAfterTheBriefKeepsTheBrief = SUBS.forall(i =>
    (subs.get(i).state == "waiting" and prs.get(i).life == "open" and prs.get(i).afterBrief) implies subs.get(i).briefed)
  val coordinatorWorksOnlyOnPrsAfterTheBrief = SUBS.forall(i =>
    (Set("implementing", "reviewing", "fixing", "verified").contains(subs.get(i).state) and prs.get(i).life == "open") implies prs.get(i).afterBrief)

  val wSliced = phase == "coordinating"
  val wStarted = SUBS.exists(i => subs.get(i).state == "implementing")
  val wStacked = SUBS.exists(i => subs.get(i).state == "implementing" and subs.get(i).startBase != MAIN)
  val wReviewing = SUBS.exists(i => subs.get(i).state == "reviewing")
  val wFixing = SUBS.exists(i => subs.get(i).state == "fixing")
  val wRoundLimit = SUBS.exists(i => subs.get(i).rounds >= ROUND_LIMIT)
  val wVerified = SUBS.exists(i => subs.get(i).state == "verified")
  val wReverified = last == "reverify"
  val wPushedAfterVerify = SUBS.exists(i => subs.get(i).state == "verified" and not(subs.get(i).headVerified))
  val wVerifiedAfterStack = SUBS.exists(i => subs.get(i).state == "verified" and subs.get(i).startBase != MAIN)
  val wMerged = SUBS.exists(i => merged(i))
  val wRetargeted = SUBS.exists(i => subs.get(i).startBase != MAIN and prs.get(i).base == MAIN)
  val wRiding = SUBS.exists(i => prs.get(i).ridesOn != MAIN and prs.get(i).landed)
  val wPrAfterBriefBeforeStart = SUBS.exists(i => subs.get(i).state == "waiting" and prs.get(i).life == "open" and prs.get(i).afterBrief)
  val wStartedOnOwnPr = last == "start" and SUBS.exists(i => subs.get(i).state == "implementing" and prs.get(i).life == "open")
  val wPrBeforeBriefOnWaiting = SUBS.exists(i => subs.get(i).state == "waiting" and subs.get(i).briefed and prs.get(i).life == "open" and not(prs.get(i).afterBrief))
  val wExternal = SUBS.exists(i => subs.get(i).state == "external")
  val wBlocked = SUBS.exists(i => subs.get(i).state == "blocked")
  val wAllMerged = SUBS.forall(i => merged(i))
  val wClosing = phase == "closing"
  val wDone = phase == "done"
  val wDoneByOverride = phase == "done" and debts.override
}

module chain {
  import epic_workflow(SUBS = Set(0, 1, 2), DEPS = Map(0 -> Set(), 1 -> Set(0), 2 -> Set(1)), PARALLEL = 2, ROUND_LIMIT = 3, MAX_DEBT = 4, HUMAN_JUMPS = false).*
}

module diamond {
  import epic_workflow(SUBS = Set(0, 1, 2), DEPS = Map(0 -> Set(), 1 -> Set(), 2 -> Set(0, 1)), PARALLEL = 2, ROUND_LIMIT = 3, MAX_DEBT = 4, HUMAN_JUMPS = false).*
}

module steered {
  import epic_workflow(SUBS = Set(0, 1, 2), DEPS = Map(0 -> Set(), 1 -> Set(0), 2 -> Set(1)), PARALLEL = 2, ROUND_LIMIT = 3, MAX_DEBT = 4, HUMAN_JUMPS = true).*
}
