# Orca worker safety

Triage keeps a worker's outcome separate from proof that its process exited. A failed Orca state with live, missing or unverifiable liveness keeps the group's running slot and marks it for inspection. This applies to start receipts and later refreshes. It does not start a replacement.

Before a retry, triage reads every page of `orca orchestration worker-list` for the Run, including remote observations. It follows `page.hasMore` and `page.nextCursor`. A queued retry repeats this check immediately before a new start, including after a wait for host capacity. An uncertain request replays its existing Orca request ID instead of starting a new attempt. Every retained attempt for the Task must have liveness `exited` and terminal state `released`. Missing evidence, an incomplete listing or an unknown release blocks the retry. The error names the Dispatch and its inspection command. Another coordinator can still race this client check. Orca must enforce an atomic runtime guard.

Inspect the exact Dispatch with `orca orchestration worker-show --dispatch <dispatch_id> --full --json`. Follow the receipt's recovery after you establish ownership and permission for the action. A failed state or `stop_unknown` does not prove exit. A stopped process does not prove terminal release. Preserve an unknown or user-owned terminal. Triage does not stop, release, abandon or close workers automatically to make retries possible.

Triage starts one worker at a time by default. For local execution on macOS or Linux, it holds new starts when the one-minute load average exceeds the CPU core count. A held group stays queued. The panel gives the measured load and core count. Run `ndev triage launch` after capacity returns, or let the watcher refresh the queued run. An explicit local batch still obeys the load gate at each start.

For Windows, paired or remote execution, the CLI cannot read a comparable execution-host load average. Triage admits one worker per Run, even with a larger requested batch. This limits its own fan-out. It does not measure total remote-host load or reserve capacity against other Runs. Execution-host load admission remains an upstream limitation.

## Upstream reports

[ndev issue #37](https://github.com/neilellis/ndev/issues/37) records four symptoms on Orca 1.4.257. The original incident has no retained Dispatch receipts. The reports below distinguish those historical observations from read-only checks on 1.4.266. No real worker was restarted or stopped to reproduce them.

| Symptom | Report and evidence |
|---|---|
| A worker shown as failed while it still works | [Related readiness failure report](https://github.com/stablyai/orca/issues/21512#issuecomment-7054503610). The report includes a failed receipt whose setup remains running. |
| A retry starts without proof the old worker ended | [Concurrent Task dispatch report](https://github.com/stablyai/orca/issues/27302#issuecomment-7054503890). The report includes two accepted Dispatches for one Task. |
| No admission cap for host load | [Load gate proposal](https://github.com/stablyai/orca/issues/24058#issuecomment-7054504209) and [implementation PR](https://github.com/stablyai/orca/pull/24059). The current CLI help has no load flag. A local probe on 2026-11-21 gave load 16.925 on 10 cores. |
| A failed worker cannot be stopped or released | [Failed resource settlement report](https://github.com/stablyai/orca/issues/23386#issuecomment-7054504593). It includes `alreadySettled` and `release_unknown` outputs. The current inspected historical worker has positive exit and release evidence. That one is settled. |

The public CLI tests are in `tests/ndev-triage.test.mjs`. They use real stored triage state and mock only GitHub, Orca and operating-system metrics.
