# REVIEW-209 — ledger

Status: ALIGNED r3.

## Round 1 (parallel: codex gpt-5.6-sol medium, opus medium) — both CHANGES-REQUIRED

r1 proposed stripping mtimeMs from committed manifests. The wave killed it:

| # | Finding | Ruling |
|---|---|---|
| O-H1 | Mixed-fleet cost is NOT "one transitional delta": old writers re-add mtimes every commit, new writers re-strip — alternating full-workspace deltas BOTH directions for the whole skew window; strictly worse than today. Inverts the r1 ranking. | ACCEPT → PIVOT to normalize-the-target (carry base mtimeMs when the ten identity fields are ===). Unilateral, no wire change, no transition, skew-proof. |
| C-H1 | Stripped `committed` leaks into retry paths (localForRetry/state.local via push.ts:183/:374/:749/:942) → classifyCacheHit永defers → publish stall. | MOOT via pivot (normalized manifest is shape-identical); constraint recorded in design §Correctness. |
| C-H2/O-H1 | Skew language/tests wrong. | ACCEPT → skew simulation test with asserted op counts (test 8). |
| C-H3 | Test 6 / acceptance mis-staged (first stripped commit IS the transitional N-op delta). | MOOT via pivot — r2 has no transitional stage; acceptance is first-commit ops≈0. |
| C-M4 | Daemon installs projected manifest wholesale (daemon.ts:1917) → in-memory mtime loss; falsified r1's "scan plane keeps mtimes" claim. | MOOT via pivot; residual local oscillation documented (never reaches wire). |
| O-H2 | RBOX_MANIFEST_MTIMES=1 flag = per-machine footgun re-enabling the ping-pong fleet-wide. | MOOT via pivot; r2's RBOX_MTIME_NORMALIZE=0 is safe per-machine (restores today exactly). |
| O-M3 | classifyCacheHit safety argument was wrong (in-memory manifest IS largely committed/pulled entries); the REAL guard is sha-keyed baseEnc (sync-recovery.ts:158). | ACCEPT → real argument written into design + invariant test 7 (guards future path-keyed baseEnc). |
| O-M4 | Optional mtimeMs deletes the compiler guard on classifyCacheHit (undefined === stat → silent defer stall). | MOOT via pivot (type stays required). |
| C-5/O-M5 | 204-memo risk language wrong (memo keys on committed hash — coherent); anchor drift (stampManifestSchemaForCommit at push.ts:48/:747; replaceManifestFromScan :3015 + two unlisted call sites). | ACCEPT → fixed in r2. |
| O-L6/C-verified | Zero-consumer sweep beyond src/ CLEAN (apps/api envelope-opaque, web none, rig oracle drops mtimes, CLI commands clean, no golden hashes). | Recorded; discharges r1's open risk. |
| O-L7/L8 | 204 base-integrity/fastFoldBase coherent both directions; ALL cross-boundary entry comparisons are mtime-blind (fileEntryEqual is the only field-exact one). | Recorded — load-bearing for the pivot's safety. |
| O-test-gaps | classifyCacheHit invariant test; skew test with numbers; commit-path coverage (chain-repair/ignore-cmd/resolve reach the seam via pushManifest). | ACCEPT → tests 7/8; seam placement inside stampManifestSchemaForCommit covers all callers. |

## Round 2 — serial gate (codex) on the PIVOTED design: see REVIEW-209-serial.md

## Round 2 — serial gate (codex): mechanism CONFIRMED, test/contract residuals only

| # | Finding | Ruling |
|---|---|---|
| S1 MED | Test 2 impossible for `path` (rename = set+del, not one set). | ACCEPT → matrix is nine fields; rename covered separately. |
| S2 MED | Test 7 mis-pinned (normalization runs AFTER classification) — assert provenance (normalized paths never reached classifyCacheHit), with mtime-only/rename/mode-only/missing-descriptor cases. | ACCEPT → test 7 rewritten. |
| S3 LOW | Pass state.lastSyncedManifest directly; lazily clone files array, reuse base entry objects. | ACCEPT → Risks. |
| S4 LOW | 204 integrity check is not a normalized-target sink (hashes reconstructed base) — wording. | ACCEPT → Risks corrected. |

Gate verified: adopted mtimes flow coherently into every sink; renames/
mode-only/descriptor-absence cannot normalize; unchanged normalized entry ==
base exactly so diffToOps emits nothing (no no-op-set hazard); kill switch
exact at the single seam.

## ALIGNED r3 — self-certified

Trajectory: r1 structural pivot → r2 mechanism confirmation with
test-contract residuals. Residuals folded; no new class two rounds running.
