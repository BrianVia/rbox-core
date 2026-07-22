# Design 182 review round 1

Verdict: **CHANGES REQUIRED** (three independent reviewers)

## Findings and rulings

1. **BLOCKER — #331 note-only identities were not pinned.** Accepted. The
   recovered source report names six timing-contract families: shell prompt
   p99, native watcher observation, apply wall decomposition, dircache racy
   margins, crypto bounded/spill gates, and pack-GC wall ordering. Expiry and
   diagnostics observations are recorded separately as benign.
2. **BLOCKER — credential history started on July 20, not July 22.** Accepted.
   The registry records run 29753317433 and its same-SHA rerun plus the July 22
   recurrence run 29937523471, whose own rerun remains pending.
3. **HIGH — “four strikes” misrepresented four independent executions.**
   Accepted. The registry records first seen July 12, last seen July 21, and
   explains that the retained July 21 evidence is two executions duplicated in
   their job summaries.
4. **HIGH — original design-170 fix and current recurrence were conflated.**
   Accepted. The original four-test cluster remains FIXED at 5a49b752 /
   a1b10bca; the live committed-frame member cross-references the active
   recurrence.
5. **HIGH — refwatch semantics were incomplete.** Accepted. The registry pins
   cbcab7b9 / PR #389, bounded premise retries then INCONCLUSIVE+exit0, and
   immediate hard failure after established pressure or callback deadline.
6. **MAJOR — the audit could hide reviewed candidates in broad groups.**
   Accepted. The design requires exact test/file/pattern/disposition census,
   including false-positive, benign, protected/deferred, and acceptable
   condition-ceiling classifications. The registry gained exact live and
   additional same-file candidates; the census is completed during
   implementation inspection.
7. **BLOCKER — crypto bounded/spill tests were proposed as fixes despite being
   #331 note-onlys.** Accepted. Only the redundant post-reset sleep remains a
   fix; bounded queue and spill close are note-only.
8. **BLOCKER — upload-grant's proposed seam would touch protected
   `remote/context.ts`.** Accepted. That production seam is forbidden. Tests use
   mocked-fetch completion/condition polling only; cases that cannot be fixed
   test-only are deferred post-394.
9. **MAJOR — rig proof was optional.** Accepted. The design requires Docker rig
   doctor plus `two-device-live` and `git-config-sync`; environment failure is a
   blocker to resolve, not silent permission to omit.
10. **MEDIUM — cursor default equivalence was underspecified.** Accepted. The
    design pins global delegation at call time, one random read per cadence,
    unref for both handle kinds, opaque/undefined handle checks, creating-clock
    clears, and unchanged timeout calculation/error text.
11. **MEDIUM — the credential contention hook could deadlock under the fence.**
    Accepted. It announces and returns immediately; only the child quarantine
    hook waits for release.
12. **MEDIUM — config coordinator failure paths could hang.** Accepted. Marker
    waits race child exit with a generous ceiling, drain pipes concurrently,
    and surface stderr.
13. **MISSING CASES — websocket pong/backstop/disabled sleeps, credential
    heartbeat mtime, both daemon-safety waits, and exact daemon-activity waits.**
    Accepted and added to the deterministic-fix/census scope. Existing bounded
    daemon-activity polling remains note-only.
14. **PRECISION — the E2EE latch could deadlock on the sequential head read.**
    Accepted. The barrier counts only `manifestMeta.chain.length` parallel
    chain GETs.
15. **PROOF — durable results and protected-path intersection were not pinned.**
    Accepted. The final registry records 10-process walls/min/max, full gates,
    rig results, production-seam audit, deferrals, and a computed all-changed-
    path intersection with PR #394.
16. **COMMIT ORDER — acceptance says registry first.** Accepted. Registry,
    design, and this review ledger form the first commit; no fixes precede it.

Round 2 is required after these folds.
