Verdict: **CHANGES-REQUIRED**

The pivoted mechanism is sound and opens no new runtime correctness class. The blockers are in the test/spec contract:

1. **Medium — Test 2 is impossible for `path`.** A path change emits `set + del`, not exactly one `set`. Split rename coverage from the other nine non-mtime fields.

2. **Medium — Test 7 does not pin the SHA-keyed invariant.** Normalization happens after encryption classification. Instead, assert that paths which eventually qualify for normalization never reached `classifyCacheHit`. Explicitly cover mtime-only, rename, mode-only, and missing-base-descriptor cases.

3. **Low — Base naming/allocation need clarification.** `appliedBase` already is `state.lastSyncedManifest`; pass it directly to the seam helper. For allocation-light purity, lazily clone the files array and reuse qualifying base entry objects.

4. **Low — The 204 integrity check is not a normalized-target sink.** It runs after normalization but hashes the reconstructed base. This is safe; the design wording is merely imprecise.

Verified:

- Base-adopted mtimes flow into raw/snapshot/delta encoding, result hashing, retry candidates, persisted state, and daemon installation.
- Renames and mode-only changes may reuse ciphertext by SHA but cannot normalize.
- Descriptor absence can force classification/re-encryption, after which descriptor inequality prevents normalization.
- An unchanged normalized entry equals its base exactly, so `diffToOps` emits no operation and `foldDelta` never encounters a no-op `set`.
- The O(n) cost claim is sound with the allocation strategy above.
- `RBOX_MTIME_NORMALIZE=0` can restore current behavior exactly at the single seam.
- Tests 1, 3–6, 8, and 9 are adequate once tests 2 and 7 are corrected.

Full gate record: [REVIEW-209-serial.md](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/REVIEW-209-serial.md)