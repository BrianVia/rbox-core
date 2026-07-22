Verdict: **CHANGES-REQUIRED**

The post-R2 broad-gate fixes introduced two review findings:

1. **HIGH — cache fingerprints were rebound to stale probes.** A late
   fingerprint-only “seal” overwrote a fully bracketed cache entry's
   fingerprint without recomputing its probe, identity, config summary, or
   kind. A semantic mutation in that interval could therefore become a trusted
   stale hit. The whole-common-directory refresh was also broader than D.5
   requires after internal refs, reflogs, and directory mtimes were excluded.
2. **MEDIUM — ordinary config absence still materialized `cfgShape`.** Clearing
   a `cfgSynced`-only lane called the shape invalidator first, turning it into a
   `cfgShape`-only lane instead of preserving the lane's preexisting fields.

The design-83 second-push fixture change was accepted: it converges the new
D.3 baseless PENDING state before deleting, filling, and trusting the cache, so
the D.5 zero-spawn assertion remains discriminating.

Review validation: 116 focused tests passed (2 skipped). No E live-transition
implementation or workstream A, B, C, or F scope creep was found.
