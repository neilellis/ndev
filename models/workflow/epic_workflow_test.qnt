module chain_test {
  import epic_workflow(SUBS = Set(0, 1, 2), DEPS = Map(0 -> Set(), 1 -> Set(0), 2 -> Set(1)), PARALLEL = 2, ROUND_LIMIT = 3, MAX_DEBT = 4, HUMAN_JUMPS = false).* from "./epic_workflow"

  action coordinating =
    init
      .then(finishPhase).then(finishPhase).then(finishPhase)
      .then(finishPhase).then(finishPhase).then(finishPhase)
      .expect(phase == "coordinating" and SUBS.forall(i => subs.get(i).state == "waiting"))

  action firstInReview =
    coordinating
      .then(brief(0))
      .then(start(0))
      .then(workerOpensPr(0))
      .then(toReviewing(0))
      .expect(subs.get(0).state == "reviewing" and prs.get(0).base == MAIN)

  run blockedSubCannotStartTest = coordinating.then(start(1).fail())

  run briefedWorkerPrBeforeStartIsTakenTest =
    coordinating
      .then(brief(0))
      .then(workerOpensPr(0))
      .then(start(0))
      .then(toReviewing(0))
      .expect(subs.get(0).state == "reviewing" and prs.get(0).afterBrief and safety)

  run unbriefedWorkerOpensNoPrTest = coordinating.then(workerOpensPr(0).fail())

  run prBeforeTheBriefRefusesBriefTest = coordinating.then(otherOwnerOpensPr(0, false)).then(brief(0).fail())

  run prBeforeTheBriefRefusesStartTest = coordinating.then(otherOwnerOpensPr(0, false)).then(start(0).fail())

  run oldPrReopenedAfterTheBriefRefusesStartTest =
    coordinating
      .then(brief(0))
      .then(otherOwnerOpensPr(0, false))
      .expect(not(prs.get(0).afterBrief))
      .then(start(0).fail())

  run secondBriefMovesTheBriefTimeTest =
    coordinating
      .then(brief(0))
      .then(workerOpensPr(0))
      .then(humanClosesPr(0))
      .then(brief(0))
      .then(humanReopensPr(0))
      .expect(not(prs.get(0).afterBrief))
      .then(start(0).fail())

  run importOfAWaitingSubClearsTheBriefTest =
    coordinating
      .then(brief(0))
      .then(reimportStillWaiting(0))
      .then(otherOwnerOpensPr(0, true))
      .expect(subs.get(0).state == "waiting" and not(prs.get(0).afterBrief))
      .then(start(0).fail())

  run closedPrReopenedAfterAnImportRefusesStartTest =
    coordinating
      .then(brief(0))
      .then(workerOpensPr(0))
      .then(humanClosesPr(0))
      .then(reimportStillWaiting(0))
      .then(humanReopensPr(0))
      .expect(subs.get(0).state == "waiting" and not(prs.get(0).afterBrief) and aPrAfterTheBriefKeepsTheBrief)
      .then(start(0).fail())

  run importOfAWaitingSubLeavesItsMergedPrTest =
    coordinating
      .then(brief(0))
      .then(workerOpensPr(0))
      .then(humanMergesPr(0))
      .expect(subs.get(0).state == "waiting" and prs.get(0).life == "merged" and prs.get(0).landed)
      .then(reimport(0).fail())

  run importStillWaitingLeavesAMergedPrTest =
    coordinating
      .then(brief(0))
      .then(workerOpensPr(0))
      .then(humanMergesPr(0))
      .then(reimportStillWaiting(0).fail())

  run startClearsTheBriefTest =
    coordinating
      .then(brief(0))
      .then(start(0))
      .then(workerOpensPr(0))
      .expect(not(subs.get(0).briefed) and prs.get(0).afterBrief and safety)

  run importClearsTheBriefTest =
    coordinating
      .then(brief(0))
      .then(workerOpensPr(0))
      .then(reimport(0))
      .expect(subs.get(0).state == "external" and not(subs.get(0).briefed) and not(prs.get(0).afterBrief))
      .then(humanClosesPr(0))
      .then(reimport(0))
      .then(otherOwnerOpensPr(0, true))
      .expect(subs.get(0).state == "waiting" and not(prs.get(0).afterBrief) and safety)
      .then(start(0).fail())

  run stackedStartNeedsTheBriefTest = firstInReview.then(start(1).fail())

  action secondStacked =
    firstInReview
      .then(brief(1))
      .expect(subs.get(1).stackedOn == 0)
      .then(start(1))
      .then(workerOpensPr(1))
      .expect(prs.get(1).base == 0 and wStacked)

  run stackOnUnpushedBlockerRefusedTest =
    coordinating
      .then(brief(0))
      .then(start(0))
      .then(brief(1).fail())

  action secondInReview =
    secondStacked
      .then(toReviewing(1))
      .then(workerMarksReady(1))
      .then(ciEndsWith(1, "green"))

  run stackedPrIsNotVerifiedTest = secondInReview.then(verify(1).fail())

  action firstMerged =
    secondInReview
      .then(workerMarksReady(0))
      .then(ciEndsWith(0, "green"))
      .then(verify(0))
      .then(humanMergesPr(0))
      .then(recordMerged(0))
      .expect(merged(0) and prs.get(0).landed and issues.get(0) == "closed" and debts.open == 0)

  run stackStillOnBlockerBranchTest = firstMerged.then(verify(1).fail())

  run retargetedStackIsVerifiedTest =
    firstMerged
      .then(retarget(1))
      .then(verify(1))
      .expect(subs.get(1).stackedOn == MAIN and wVerifiedAfterStack and safety)

  run conflictRefusesVerifyTest =
    firstInReview
      .then(workerMarksReady(0))
      .then(ciEndsWith(0, "green"))
      .then(baseMovesTo(0, "conflict"))
      .then(verify(0).fail())

  run unmergedPrCannotBeRecordedMergedTest = firstInReview.then(recordMerged(0).fail())

  run stackedMergeLandsWithItsBaseTest =
    secondStacked
      .then(humanMergesPr(1))
      .expect(prs.get(1).ridesOn == 0 and not(prs.get(1).landed) and issues.get(1) == "open")
      .then(humanMergesPr(0))
      .expect(prs.get(1).landed and wRiding)
      .then(toReviewing(1))
      .then(recordMerged(1))
      .expect(merged(1) and safety)

  run earlyMergeOwesDebtTest =
    firstInReview
      .then(humanMergesPr(0))
      .then(recordMerged(0))
      .expect(debts.open == 2)

  action firstVerified =
    firstInReview
      .then(workerMarksReady(0))
      .then(ciEndsWith(0, "green"))
      .then(verify(0))

  run verifiedMergeOwesNoDebtTest =
    firstVerified
      .then(humanMergesPr(0))
      .then(recordMerged(0))
      .expect(merged(0) and debts.open == 0)

  run pushAfterVerifyOwesVerificationDebtOnlyTest =
    firstVerified
      .then(workerPushes(0))
      .expect(subs.get(0).state == "verified" and prs.get(0).checks == "pending")
      .then(humanMergesPr(0))
      .then(recordMerged(0))
      .expect(merged(0) and debts.open == 1 and not(debts.override) and safety)

  run pushWhileBlockedAfterVerifyOwesVerificationDebtTest =
    firstVerified.then(block(0)).then(workerPushes(0)).then(unblock(0))
      .expect(subs.get(0).state == "verified" and not(subs.get(0).headVerified))
      .then(humanMergesPr(0)).then(recordMerged(0))
      .expect(merged(0) and debts.open == 1 and not(debts.override))
  run reverifyAfterPushOwesNoDebtTest =
    firstVerified.then(workerPushes(0)).then(reverify(0))
      .expect(subs.get(0).state == "reviewing" and not(subs.get(0).headVerified))
      .then(ciEndsWith(0, "green")).then(verify(0))
      .expect(subs.get(0).headVerified)
      .then(humanMergesPr(0)).then(recordMerged(0))
      .expect(merged(0) and debts.open == 0 and safety)

  run reverifyOfAVerifiedHeadIsRefusedTest = firstVerified.then(reverify(0).fail())

  run pushAfterVerifyIsNotMergedTest =
    firstVerified
      .then(workerPushes(0))
      .then(recordMerged(0).fail())

  run roundsPassTheLimitWithAWarningTest =
    firstInReview
      .then(toFixing(0)).then(fixedToReviewing(0))
      .then(toFixing(0)).then(fixedToReviewing(0))
      .then(toFixing(0)).then(fixedToReviewing(0))
      .then(toFixing(0))
      .expect(subs.get(0).rounds == 4 and wRoundLimit)

  run coordinatingWaitsForAllMergedTest = firstMerged.then(finishPhase.fail())

  action ridingOnOpenBase =
    secondStacked
      .then(humanMergesPr(1))
      .then(toReviewing(1))
      .expect(not(prs.get(1).landed) and not(lostNow(1)))

  run humanMergeIntoStackDoesNotLandTest = ridingOnOpenBase.then(recordMerged(1).fail())

  run ridingOnOpenBaseIsNotLostTest = ridingOnOpenBase.then(recordLost(1).fail())

  action mergedAfterBase =
    secondStacked
      .then(humanMergesPr(0))
      .then(recordMerged(0))
      .then(humanMergesPr(1))
      .then(toReviewing(1))
      .expect(prs.get(1).lost)

  run humanMergeAfterBaseMergedIsNotRecordedTest = mergedAfterBase.then(recordMerged(1).fail())

  run humanMergeAfterBaseMergedBlocksTest =
    mergedAfterBase
      .then(recordLost(1))
      .expect(subs.get(1).state == "blocked" and subs.get(1).previous == "reviewing" and safety)
}

module wide_test {
  import epic_workflow(SUBS = Set(0, 1, 2), DEPS = Map(0 -> Set(), 1 -> Set(), 2 -> Set()), PARALLEL = 2, ROUND_LIMIT = 3, MAX_DEBT = 4, HUMAN_JUMPS = false).* from "./epic_workflow"

  action twoInFlight =
    init
      .then(finishPhase).then(finishPhase).then(finishPhase)
      .then(finishPhase).then(finishPhase).then(finishPhase)
      .then(start(0))
      .then(start(1))

  run parallelLimitRefusesStartTest = twoInFlight.then(start(2).fail())

  action placeRetaken = twoInFlight.then(block(0)).then(start(2))

  run unblockRefusedWhilePlacesAreTakenTest = placeRetaken.then(unblock(0).fail())

  run unblockWaitsForAPlaceTest =
    placeRetaken
      .then(block(2))
      .then(unblock(0))
      .expect(inFlight.size() == 2 and subs.get(0).state == "implementing")

  action oneExternal =
    init
      .then(finishPhase).then(finishPhase).then(finishPhase)
      .then(finishPhase).then(finishPhase)
      .then(finishSlicing(Set(0)))
      .expect(subs.get(0).state == "external" and prs.get(0).life == "open" and subs.get(1).state == "waiting")

  run externalWorkTakesAPlaceTest = oneExternal.then(start(1)).then(start(2).fail())

  run externalWorkCannotStartTest = oneExternal.then(start(0).fail())

  run externalWorkGetsNoBriefTest = oneExternal.then(brief(0).fail())

  run externalWorkCannotBeBlockedTest = oneExternal.then(block(0).fail())

  run mergedExternalWorkFreesItsPlaceTest =
    oneExternal
      .then(start(1))
      .then(humanMergesPr(0))
      .then(recordMerged(0))
      .then(start(2))
      .expect(merged(0) and inFlight.size() == 2 and debts.open == 2 and not(debts.override) and safety)

  run closedExternalPrHoldsItsPlaceUntilReimportTest =
    oneExternal
      .then(start(1))
      .then(humanClosesPr(0))
      .then(start(2).fail())

  run reimportedClosedExternalWorkWaitsTest =
    oneExternal
      .then(start(1))
      .then(humanClosesPr(0))
      .then(reimport(0))
      .expect(subs.get(0).state == "waiting" and inFlight.size() == 1 and safety)
      .then(start(2))
      .expect(inFlight.size() == 2 and safety)

  run reimportFindsANewExternalPrTest =
    init
      .then(finishPhase).then(finishPhase).then(finishPhase)
      .then(finishPhase).then(finishPhase).then(finishPhase)
      .then(start(0))
      .then(reimport(1))
      .expect(subs.get(1).state == "external" and prs.get(1).life == "open" and inFlight.size() == 2 and safety)
      .then(start(2).fail())

  run startedWorkIsNotReimportedTest = oneExternal.then(start(1)).then(reimport(1).fail())

  run externalWorkBeyondThePlacesTest =
    init
      .then(finishPhase).then(finishPhase).then(finishPhase)
      .then(finishPhase).then(finishPhase)
      .then(finishSlicing(Set(0, 1, 2)))
      .expect(inFlight.size() == 3 and safety)
      .then(humanMergesPr(0))
      .then(recordMerged(0))
      .then(humanMergesPr(1))
      .then(recordMerged(1))
      .expect(inFlight.size() == 1 and safety)
}

module steered_test {
  import epic_workflow(SUBS = Set(0, 1, 2), DEPS = Map(0 -> Set(), 1 -> Set(0), 2 -> Set(1)), PARALLEL = 2, ROUND_LIMIT = 3, MAX_DEBT = 4, HUMAN_JUMPS = true).* from "./epic_workflow"

  action coordinating =
    init
      .then(finishPhase).then(finishPhase).then(finishPhase)
      .then(finishPhase).then(finishPhase).then(finishPhase)

  run humanCannotGotoDoneTest = coordinating.then(humanMove("done").fail())

  action skipped =
    coordinating
      .then(humanSkip)
      .expect(phase == "closing" and debts.open == 1 and debts.override)

  run closingNeedsRuledDebtTest = skipped.then(finishPhase.fail())

  run closingRefusesUnmergedSubsTest =
    skipped
      .then(ruleDebt)
      .then(finishPhase.fail())

  action earlyMerge(i: int): bool =
    brief(i)
      .then(start(i))
      .then(workerOpensPr(i))
      .then(toReviewing(i))
      .then(humanMergesPr(i))
      .then(recordMerged(i))
      .then(ruleDebt)
      .then(ruleDebt)

  run closingAfterRuledOverrideTest =
    coordinating
      .then(earlyMerge(0))
      .then(earlyMerge(1))
      .then(earlyMerge(2))
      .then(humanSkip)
      .then(ruleDebt)
      .then(finishPhase)
      .expect(phase == "done" and wDoneByOverride and safety)

  run closingRefusesOpenDebtTest =
    coordinating
      .then(earlyMerge(0))
      .then(earlyMerge(1))
      .then(earlyMerge(2))
      .then(humanSkip)
      .expect(phase == "closing" and debts.open == 1)
      .then(finishPhase.fail())

  run skippedChecksOweDebtAtVerifyTest =
    coordinating
      .then(brief(0))
      .then(start(0))
      .then(workerOpensPr(0))
      .then(toReviewing(0))
      .then(workerMarksReady(0))
      .then(ciEndsWith(0, "skipped"))
      .then(verify(0))
      .expect(subs.get(0).state == "verified" and debts.open == 1)

  run humanCannotSkipClosingTest = skipped.then(humanSkip.fail())

  run reslicingKeepsAnOpenPrTest =
    coordinating
      .then(brief(0))
      .then(start(0))
      .then(workerOpensPr(0))
      .then(humanMove("slicing"))
      .then(finishPhase)
      .expect(subs.get(0).state == "implementing" and prs.get(0).life == "open" and subs.get(1).state == "waiting" and aPrAfterTheBriefKeepsTheBrief)

  run slicingAgainKeepsABriefedStartedSubTest =
    coordinating
      .then(brief(0))
      .then(start(0))
      .then(workerOpensPr(0))
      .then(humanMove("slicing"))
      .then(finishSlicing(Set()))
      .expect(subs.get(0).state == "implementing" and prs.get(0).afterBrief and aPrAfterTheBriefKeepsTheBrief and safety)

  run reslicingKeepsAClosedPrOwnedTest =
    coordinating
      .then(brief(0))
      .then(start(0))
      .then(workerOpensPr(0))
      .then(humanClosesPr(0))
      .then(humanMove("slicing"))
      .then(finishPhase)
      .then(humanReopensPr(0))
      .expect(subs.get(0).state == "implementing" and prs.get(0).life == "open" and aPrAfterTheBriefKeepsTheBrief)

  run reslicingRefusedAfterAMergeTest =
    coordinating
      .then(brief(0))
      .then(start(0))
      .then(workerOpensPr(0))
      .then(humanMergesPr(0))
      .then(humanMove("slicing"))
      .then(finishPhase.fail())
}
