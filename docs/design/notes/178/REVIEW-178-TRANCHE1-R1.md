Verdict: **CHANGES-REQUIRED**

Scope reviewed: design 178 ALIGNED v4, tranche 1 only — workstream D and
workstream E's stopped-daemon-resume half.

Workstream E was aligned. Workstream D had four blocking review findings:

1. **HIGH — absent-index capture was not idempotent.** `git stash create`
   fell back to the live index when `.git/index` was absent, creating it and
   making the captured and post-capture live identity keys differ.
2. **HIGH — baseless supersession was categorically refused.** The ACK-composer
   dry run returned false before composing from an empty BASE, even when the
   exact publisher composer would converge to the candidate.
3. **MEDIUM — sanitation was not universal.** Whole-state compatibility and
   telemetry-binding rewrites could persist raw BASE/PENDING config fields.
4. **MEDIUM — required regressions were incomplete.** Missing discriminating
   cases included absent-index capture, baseless composition, outer exception
   persistence, scoped valid-config sanitation, persisted invalid-input no-echo,
   and assertions over the actual logged section identity keys.

Validation before re-dispatch: 93 focused D tests passed (2 skipped), and the
real supersession convergence case passed. The passing tests did not invalidate
the findings above.
