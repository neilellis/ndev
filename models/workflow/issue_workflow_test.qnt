module light_test {
  import issue_workflow(INIT_MODE = "light", MODE_SWITCH = false, MAX_ROUNDS = 3, HUMAN_JUMPS = false).* from "./issue_workflow"

  run lightMergesAfterInterviewTest =
    initWith("poc", "interactive")
      .then(startedWith(false, false, false, false))
      .expect(wf.state == "interviewing" and pr.life == "planned")
      .then(askRound(false))
      .then(paneEndsWith("submitted", true, true))
      .then(leaveInterview)
      .expect(wf.state == "developing" and wf.baseChecked and iv.posted and iv.closed)
      .then(checkpointWith(true, false))
      .expect(pr.life == "open" and pr.draft and not(branch.unpushed))
      .then(finishedDevelopmentWith(false))
      .expect(wf.state == "reviewing")
      .then(finishedReview)
      .expect(wf.state == "ci" and not(pr.draft) and pr.checks == "pending")
      .then(ciEndsWith("green"))
      .then(finishedChecksWith(false))
      .expect(wf.state == "finishing" and wf.checksEv == "agent")
      .then(doneReady)
      .expect(wf.state == "done" and pr.life == "merged" and issue == "closed" and safety)

  run lightHeavyExitNeedsNoAnswerTest =
    initWith("small_project", "interactive")
      .then(startedWith(false, false, false, false))
      .then(leaveInterview)
      .expect(wf.state == "developing" and iv.answered == 0)

  action lightAutoStart =
    initWith("small_project", "auto")
      .then(startedWith(false, false, false, false))
      .expect(wf.state == "developing" and not(wf.baseChecked))

  run lightCodeWaitsForBaseCheckTest = lightAutoStart.then(checkpointWith(true, false).fail())

  run lightAutoSkipsInterviewTest =
    lightAutoStart
      .then(finishedInterview)
      .then(checkpointWith(true, false))
      .expect(pr.life == "open")

  run lightRedChecksBlockAtLimitTest =
    initWith("small_project", "auto")
      .then(startedWith(false, false, false, false))
      .then(finishedInterview)
      .then(checkpointWith(true, false))
      .then(finishedDevelopmentWith(false))
      .then(finishedReview)
      .then(ciEndsWith("red"))
      .then(finishedChecksWith(false))
      .then(checkpointWith(true, false))
      .then(ciEndsWith("red"))
      .then(finishedChecksWith(false))
      .then(checkpointWith(true, false))
      .then(ciEndsWith("red"))
      .then(finishedChecksWith(false))
      .expect(wf.state == "blocked" and wf.previous == "ci" and wf.attempts == 3)

  run lightRedAfterUnblockAtLimitBlocksAgainTest =
    lightRedChecksBlockAtLimitTest
      .then(humanUnblock)
      .expect(wf.state == "ci" and wf.attempts == 3)
      .then(checkpointWith(true, false))
      .then(ciEndsWith("red"))
      .then(finishedChecksWith(false))
      .expect(wf.state == "blocked" and wf.attempts == 4 and redPastLimitBlocks)

  action lightInCi =
    lightAutoStart
      .then(finishedInterview)
      .then(checkpointWith(true, false))
      .then(finishedDevelopmentWith(false))
      .then(finishedReview)
      .expect(wf.state == "ci" and pr.checks == "pending")

  run lightPendingChecksRefuseTest = lightInCi.then(finishedChecksWith(false).fail())

  action lightConflict =
    lightInCi
      .then(ciEndsWith("green"))
      .then(finishedChecksWith(false))
      .then(baseMovesTo("conflict"))

  run lightConflictRefusesDoneTest = lightConflict.then(doneReady.fail())

  action lightDoneAwaitingHuman =
    lightConflict
      .then(baseMovesTo("clean"))
      .then(doneReady)
      .expect(wf.state == "done" and pr.life == "open" and wDoneAwaitingHuman)
      .then(reviewerComments)
      .then(startedAfterDone)
      .expect(wf.state == "revising" and wRevisedAfterDone)

  run lightUnansweredFeedbackRefusesRevisionTest = lightDoneAwaitingHuman.then(finishedRevision.fail())

  run lightRevisesAfterDoneTest =
    lightDoneAwaitingHuman
      .then(answerFeedback)
      .then(finishedRevision)
      .expect(wf.state == "ci")

  run lightHeldCommitsBlockDoneAfterHumanMergeTest =
    initWith("small_project", "auto")
      .then(startedWith(false, false, false, false))
      .then(finishedInterview)
      .then(checkpointWith(true, false))
      .then(finishedDevelopmentWith(false))
      .then(finishedReview)
      .then(followUpThisAgent)
      .expect(wf.state == "developing")
      .then(finishedDevelopmentWith(true))
      .expect(wf.state == "reviewing" and branch.unpushed)
      .then(humanMergesPr)
      .then(doneAfterHumanMerge.fail())

  run lightReviewRefusesMergedPrTest =
    initWith("small_project", "auto")
      .then(startedWith(false, false, false, false))
      .then(finishedInterview)
      .then(checkpointWith(true, false))
      .then(finishedDevelopmentWith(false))
      .then(finishedReview)
      .then(followUpThisAgent)
      .then(finishedDevelopmentWith(true))
      .then(humanMergesPr)
      .expect(wf.state == "reviewing" and pr.life == "merged" and branch.unpushed)
      .then(finishedReview.fail())

  run lightDeadPrIsReplacedBeforeReviewTest =
    initWith("small_project", "auto")
      .then(startedWith(false, false, false, false))
      .then(finishedInterview)
      .then(checkpointWith(true, false))
      .then(finishedDevelopmentWith(false))
      .then(finishedReview)
      .then(followUpThisAgent)
      .then(humanMergesPr)
      .then(humanReopensIssue)
      .then(startedReplacesMergedPrWith(false))
      .expect(pr.life == "planned" and wPrReplaced)
}

module heavy_test {
  import issue_workflow(INIT_MODE = "heavy", MODE_SWITCH = false, MAX_ROUNDS = 3, HUMAN_JUMPS = false).* from "./issue_workflow"

  action heavyInterview =
    initWith("small_project", "interactive")
      .then(startedWith(false, false, false, false))

  run heavyEmptyInterviewRefusedTest = heavyInterview.then(leaveInterview.fail())

  run heavyReopenWithNoPlanPlansFirstTest =
    initWith("small_project", "interactive")
      .then(startedWith(false, false, false, true))
      .expect(wf.state == "interviewing" and pr.life == "open")
      .then(humanClosesPr)
      .then(humanClosesIssue)
      .then(doneNoChange)
      .expect(wf.state == "done")
      .then(humanReopensPr)
      .then(checkpointWith(true, false))
      .expect(wf.state == "ci")
      .then(followUpThisAgent)
      .expect(wf.state == "planning" and heavyPlansAfterReopen)

  run heavyNeedsAnAnswerToLeaveTest =
    heavyInterview
      .then(askRound(true))
      .then(chatAnswersWith(true))
      .then(leaveInterview)
      .expect(wf.state == "planning")

  run heavyFollowUpLeavesWithoutAnswerTest =
    initWith("small_project", "interactive")
      .then(startedWith(false, false, true, false))
      .then(leaveInterview)
      .expect(wf.state == "planning")

  run heavyPlanNeedsSignOffTest =
    initWith("small_project", "interactive")
      .then(startedWith(false, false, false, false))
      .then(askRound(true))
      .then(chatAnswersWith(true))
      .then(leaveInterview)
      .then(finishedPlan)
      .expect(wPlanSignOff)
      .then(humanUnblock)
      .expect(wf.state == "developing" and wf.baseChecked)

  run heavyReopenAfterSignedOffPlanDevelopsTest =
    initWith("small_project", "interactive")
      .then(startedWith(false, false, false, false))
      .then(askRound(true))
      .then(chatAnswersWith(true))
      .then(leaveInterview)
      .then(finishedPlan)
      .then(humanUnblock)
      .then(finishedDevelopmentWith(true))
      .then(finishedReview)
      .expect(wf.state == "ci")
      .then(followUpThisAgent)
      .expect(wf.state == "developing" and heavyPlansAfterReopen)

  run heavyFollowUpInPlanningIsNoPlanTest =
    initWith("small_project", "interactive")
      .then(startedWith(false, false, false, false))
      .then(askRound(true))
      .then(chatAnswersWith(true))
      .then(leaveInterview)
      .expect(wf.state == "planning")
      .then(followUpThisAgent)
      .expect(wf.state == "planning" and not(wf.planned))

  run heavyStrawManPlanSkipsSignOffTest =
    initWith("straw_man", "interactive")
      .then(startedWith(false, false, false, false))
      .then(askRound(true))
      .then(chatAnswersWith(true))
      .then(leaveInterview)
      .then(finishedPlan)
      .expect(wf.state == "developing")

  action heavyTrusted =
    heavyInterview
      .then(askRound(false))
      .then(paneEndsWith("trustMeBro", true, true))
      .expect(iv.trust)

  run heavyNoRoundAfterTrustTest = heavyTrusted.then(askRound(true).fail())

  run heavyTrustEndsTheRoundsTest =
    heavyTrusted
      .then(leaveInterview)
      .expect(wf.state == "planning")

  run heavyAutoDuringBlockLeavesInterviewTest =
    initWith("small_project", "interactive")
      .then(startedWith(false, true, false, false))
      .expect(wf.state == "blocked" and wf.previous == "interviewing")
      .then(setAuto)
      .expect(wf.state == "blocked" and wf.previous == "planning" and iv.closed)
      .then(humanUnblock)
      .expect(wf.state == "planning")
}

module hack_test {
  import issue_workflow(INIT_MODE = "hack", MODE_SWITCH = false, MAX_ROUNDS = 3, HUMAN_JUMPS = false).* from "./issue_workflow"

  action hackStart =
    initWith("small_project", "interactive")
      .then(startedWith(false, false, false, false))
      .expect(wf.state == "developing")

  run hackAsksNoRoundTest = hackStart.then(askRound(true).fail())

  run hackHardensAndSmokesTest =
    hackStart
      .then(checkpointWith(true, false))
      .expect(branch.unpushed and pr.life == "planned")
      .then(finishedHacking)
      .expect(wf.state == "hardening")
      .then(finishedDevelopmentWith(false))
      .then(finishedReview)
      .expect(wf.state == "ci" and pr.life == "open" and not(branch.unpushed))
      .then(ciEndsWith("green"))
      .then(finishedChecksWith(false))
      .expect(wf.state == "smoke")
      .then(finishedSmoke)
      .then(doneReady)
      .expect(wf.state == "done" and pr.life == "open")

  run hackRefusesAutoTest = hackStart.then(setAuto.fail())

  run hackHeldWorkBlocksNoChangeDoneAfterMergeTest =
    initWith("small_project", "interactive")
      .then(startedWith(false, false, false, false))
      .then(checkpointWith(true, false))
      .then(finishedHacking)
      .then(finishedDevelopmentWith(false))
      .then(finishedReview)
      .then(followUpThisAgent)
      .expect(wf.state == "hardening")
      .then(checkpointWith(true, false))
      .expect(branch.unpushed)
      .then(humanMergesPr)
      .then(doneNoChange.fail())
}

module steered_test {
  import issue_workflow(INIT_MODE = "light", MODE_SWITCH = true, MAX_ROUNDS = 3, HUMAN_JUMPS = true).* from "./issue_workflow"

  run checkpointAfterGotoRefusesMergedPrTest =
    initWith("small_project", "auto")
      .then(startedWith(false, false, false, false))
      .then(finishedInterview)
      .then(checkpointWith(true, false))
      .then(finishedDevelopmentWith(false))
      .then(finishedReview)
      .then(humanMergesPr)
      .then(humanGotoTo("finishing"))
      .expect(wf.state == "finishing" and pr.life == "merged" and not(branch.unpushed))
      .then(checkpointWith(true, false).fail())

  run checkpointInDevelopingRefusesMergedPrTest =
    initWith("small_project", "auto")
      .then(startedWith(false, false, false, false))
      .then(finishedInterview)
      .then(checkpointWith(true, false))
      .then(finishedDevelopmentWith(false))
      .then(finishedReview)
      .then(humanMergesPr)
      .then(humanGotoTo("developing"))
      .expect(wf.state == "developing" and pr.life == "merged")
      .then(checkpointWith(true, false).fail())

  run skipClosesTheChatRoundTest =
    initWith("small_project", "interactive")
      .then(startedWith(false, false, false, false))
      .then(askRound(true))
      .then(humanSkip)
      .expect(wf.state == "developing" and not(iv.chat) and iv.closed and noChatRoundOutsideInterview)

  run skipPostsUnpostedAnswersTest =
    initWith("small_project", "interactive")
      .then(startedWith(false, false, false, false))
      .then(askRound(false))
      .then(paneEndsWith("submitted", true, false))
      .then(humanSkip)
      .expect(wf.state == "developing" and iv.answered == 1 and iv.posted and answersReachGitHub)

  run doneNoChangeClosesTheInterviewTest =
    initWith("small_project", "interactive")
      .then(startedWith(false, false, false, false))
      .then(askRound(true))
      .then(humanClosesIssue)
      .then(doneNoChange)
      .expect(wf.state == "done" and not(iv.chat) and iv.closed and noChatRoundOutsideInterview)

  run leaveInterviewPostsFailedAnswersTest =
    initWith("small_project", "interactive")
      .then(startedWith(false, false, false, false))
      .then(askRound(false))
      .then(paneEndsWith("submitted", true, false))
      .then(leaveInterview)
      .expect(iv.posted and answersReachGitHub)

  run paneEndAfterSkipNotRecordedTest =
    initWith("small_project", "interactive")
      .then(startedWith(false, false, false, false))
      .then(askRound(false))
      .then(humanSkip)
      .then(paneEndsWith("submitted", true, true).fail())

  run paneAfterSkipIsAbandonedTest =
    initWith("small_project", "interactive")
      .then(startedWith(false, false, false, false))
      .then(askRound(false))
      .then(humanSkip)
      .then(paneAbandoned)
      .expect(wf.state == "developing" and iv.answered == 0 and not(iv.pane) and iv.closed)

  run paneEndAfterGotoBackNotRecordedTest =
    initWith("small_project", "interactive")
      .then(startedWith(false, false, false, false))
      .then(askRound(false))
      .then(humanGotoTo("developing"))
      .then(humanGotoTo("interviewing"))
      .then(paneEndsWith("submitted", true, true).fail())

  run paneAfterGotoBackIsAbandonedTest =
    initWith("small_project", "interactive")
      .then(startedWith(false, false, false, false))
      .then(askRound(false))
      .then(humanGotoTo("developing"))
      .then(humanGotoTo("interviewing"))
      .then(paneAbandoned)
      .expect(wf.state == "interviewing" and iv.answered == 0 and not(iv.pane) and not(iv.paneStale))

  run switchToHeavyFromInterviewPlansTest =
    initWith("small_project", "interactive")
      .then(startedWith(false, false, false, false))
      .then(humanSetsModeTo("heavy"))
      .then(askRound(true))
      .then(chatAnswersWith(true))
      .then(leaveInterview)
      .expect(wf.state == "planning")

  action steeredAutoStart =
    initWith("small_project", "auto")
      .then(startedWith(false, false, false, false))

  run gotoDoneRefusedWithPlannedPrTest = steeredAutoStart.then(humanGotoTo("done").fail())

  run gotoDoneNeedsPushedPrTest =
    steeredAutoStart
      .then(finishedInterview)
      .then(checkpointWith(true, false))
      .then(humanGotoTo("done"))
      .expect(wf.state == "done" and wf.checksEv == "human")
}
