# Design 293: batched no-drop ancestry

## Owner and protected contract

`src/cli/sync-git/reachability.ts` remains the sole owner of reachability evidence and no-drop classification. Callers still receive the existing `NoDropProof`; no wire, identity, ref-plane, pin, index, or fallback contract changes.

Protected behavior is the legacy oracle's exact result: shallow and failed shallow probes remain indeterminate; root/tip peel and integrity-walk failures retain missing-object/walk-error precedence; and tips and roots remain positional and ordered. Validation is global and precedes content decisions: resolve shallow evidence, validate roots in root order, validate every tip, and return the first indeterminate tip marker in protected-tip order. Only when none is indeterminate may the proof process owned/unowned tips in order and return the first `would-drop`. Content equivalence sees peeled commits and runs only for unowned tips, and its proven marker is emitted iff a probe was needed. `plannedRefs`, `heldRefs`, and `recoveryPins` remain the durable-root order.

## Algorithm and ownership

Keep one private batch observation inside `reachability.ts`: shallow evidence, positional peeled root/tip commit arrays, integrity verification, and ownership classification. Sets may accelerate commit membership only; they never represent positional inputs. The public `partitionOwnedByIncoming` projects its unchanged array result and unchanged exact legacy-partition fallback from that observation. `noDropProof` consumes the same successful observation plus its peeled durable commits, first folds all indeterminate tips in input order, then delegates only unowned commits to the existing content-equivalence probe. A batch anomaly is distinct from that public projection: production falls back to a private copy of the exact legacy no-drop algorithm so root-first global validation and marker precedence cannot be reconstructed incorrectly from per-tip partition fallbacks. The exported `legacyNoDropProofForTest` is only a test wrapper and is never called by production.

No new flag, mode, durable state, or cross-iteration cache is introduced. The ref-plane fixed-point loop at `ref-plane-observation.ts:227` continues calling `noDropProof` once per iteration; memoization across changing holds is out of scope.

## Gates and rollback

- Differential: compare the production result with an exported test-only copy of the prior body across owned/unowned, tags, duplicates, missing/corrupt/shallow graphs, empty inputs, content-equivalent histories, caps, and cache hits.
- Crash/failure: forced or real missing objects, corrupt ancestry walks, and unreadable/failed shallow evidence must fail closed with the legacy marker and precedence.
- Compatibility: run reachability, ref-plane, follow, and conflict-retention suites; public partition output and all existing expectations remain unchanged.
- Performance: assert constant production spawn count for 3 and 30 all-owned tips against five roots, compare it with the oracle, and check in 30/500-tip p50/p95 measurements over 20 samples after five warmups.
- Rig/type/lint: run the repository rig, typecheck, and affected lint.

Commit 1 is G5a evidence only: the test-only oracle, differential fixtures and spawn assertion, benchmark script/output, and design/review artifacts; it contains no production batching. Commit 2 is the G5b private observation and production `noDropProof` change. Final validation records the exact five-file acceptance test command, `bun run typecheck`, `bun run lint:affected`, and `bun run rig`; no existing expectation changes.

Rollback is a direct revert to `legacyNoDropProofForTest`'s body. Nothing is approved for deletion or retirement; the oracle remains test-only evidence, and partition fallback semantics remain protected.
