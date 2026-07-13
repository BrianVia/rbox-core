# REVIEW-113 — adversarial review ledger for design 113 (codebase modularization plan)

Codex (gpt-5.6-sol) adversarial review of `docs/design/113-modularization.md`.
Attack surface: move-only feasibility (ES module semantics, import cycles),
wave disjointness against CI infrastructure, verification-gate sufficiency,
inventory accuracy.

## Round 1 — VERDICT: CHANGES-REQUIRED → revised in-place

### HIGH

1. **slot↔pool import cycle** — `CryptoWorkerSlot` stores and invokes
   `CryptoPool` (`crypto-pool.ts:265`, `:327–333`) while `CryptoPool`
   constructs slots (`:341`, `:899–903`); the proposed `slot.ts`/`pool.ts`
   split creates exactly the cycle §2's rules forbid.
   **ADOPTED** (field-verified). `slot.ts` dropped; slot merged into
   `pool.ts` (~740, §2.7 exception). Slot extraction re-classified as a
   phase-B interface refactor.
2. **Worker-resolver split not move-only** — resolver functions (`:188–227`)
   close over `embeddedWorkerPath`/`embeddedWorkerDir`/`cleanupRegistered`/
   `workerPathOverrideForTests` (`:72–75`), which `__cryptoPoolTestHooks`
   assigns (`:1024–1038`); ES imported bindings cannot be assigned
   cross-module. Same for `configuredWorkersCache` (read `:150–170`, reset
   `:1030`).
   **ADOPTED** (field-verified). State ownership assigned explicitly:
   `crypto-worker-files.ts` owns the embedded-worker state and exports
   `setWorkerPathOverrideForTests()`; `crypto-pool/config.ts` owns
   `configuredWorkersCache` and exports
   `resetConfiguredWorkersCacheForTests()`; hooks delegate. Rule 5 amended
   with a narrowly-scoped "permitted setters" exception, enumerated per
   module in §2 and enforced by gate 5.
3. **Waves not disjoint via `scripts/ci-shard-tests.ts`** — `SPLIT_FILES`
   hardcodes `src/cli/git-sync.test.ts` (`:33–40`), `HEAVY_WEIGHTS` keys
   tests moved by waves 2a/2b/3 (`:21–29`), and the guard runs in CI
   (`ci.yml:103–105`).
   **ADOPTED** (field-verified: 4 moved daemon tests + `sync.test.ts` in
   `HEAVY_WEIGHTS`, `git-sync.test.ts` in `SPLIT_FILES`). The file is
   declared a serialized resource: each moving wave updates its own keys;
   wave 2 merge order fixed (2a → 2b, 2b rebases); wave 3 runs after both.
4. **Missing money-gate** — no §5 gate ran the shard guard, so a moved test
   passes `bun test ./src/` locally while CI's registry points at a dead
   path.
   **ADOPTED.** Gate 3 added to every wave:
   `bun scripts/ci-shard-tests.ts guard --shard-count 6` (the exact ci.yml
   invocation), run locally before pushing.

### MEDIUM

5. `madge … || true` is non-enforcing. **ADOPTED** — gate 8 now requires exit
   0 / zero cycles (with a recorded pre-wave baseline if main is not clean).
6. `--find-renames --stat` cannot prove one-to-many carves. **ADOPTED** —
   gate 4 now uses `--find-copies-harder -C -C` plus a content-equivalence
   check (concatenated carves minus import/export/setter lines diff empty
   against the original regions).
7. sync-git §1 seam mislabeled: 71–345 is not one "config-lane" block; it
   mixes cross-lane policy (71–132), config-lane model (134–233), and
   capture/locking primitives shared by plan AND apply (235–345 —
   `chainLock`/`gitApplyMutationKey` used by apply at 2294/2324).
   **ADOPTED** (field-verified) — §1.2 re-tabled; new
   `sync-git/shared.ts` owns the cross-lane policy + primitives; `plan.ts`
   shrinks to ~740.
8. crypto-pool inventory omissions (`:19–27` runtime abstraction, `:51–54`
   status contract, `:56–65` queue records, `:81–83` `kekFingerprint`).
   **ADOPTED** — §1.5 re-tabled with placements; all land in `pool.ts`
   (each is slot/pool-coupled).
9. blob-batch `wire.ts` violated one-owner: 13–101 mixes wire constants,
   tuning defaults, downloader-only and uploader-only models.
   **ADOPTED** — §2.6 re-partitioned by owner: wire protocol → `wire.ts`;
   ALL tuning defaults/caps → `config.ts`; `BatchRequest`/`AttemptKind` →
   `downloader.ts`; `BatchPutWaiter`/`BatchPutGroup` → `uploader.ts`;
   `BatchPutResponseRecord` stays with its codec in `wire.ts`.
10. `blob-batch.test.ts` dynamic imports need explicit depth fixes:
    `await import("../sync-recovery.js")` (`:471`) and the query-suffixed
    `` import(`../../engine/apply.ts?batch-e2e=…`) `` (`:594`).
    **ADOPTED** (field-verified) — called out verbatim in §2.6 with the
    corrected specifiers and a `grep "import("` instruction.

### LOW (errata)

11. `sync.ts:165–171` is manifest-schema bookkeeping, not rendering.
    **ADOPTED** — §1.4 row split; `stampManifestSchemaForCommit` assigned to
    `sync/push.ts`, `format.ts` scoped to rendering only.
12. `pushManifest` starts at `:675` (contract at 668–673), not `:650`.
    **ADOPTED** — §1.4 corrected.
13. `daemon.ts:71–76` `RboxBarAmbientStatus` missing from §1.
    **ADOPTED** — §1.3 row added.
14. `ScanCoverage`/`OpenDriftAudit` are class-coupled inside the
    "standalone helpers" range. **ADOPTED** — §1.3 notes them; §2.2 pins
    them to `daemon/daemon.ts` with the class.
15. e2ee-remote "types" module was not pure contracts
    (`HISTORY_DECRYPT_CONCURRENCY`, `EMPTY_MANIFEST`, `mdeWriteCaps`,
    `blobRefsForManifest`, `SIDECAR_THRESHOLD` are policy/behavior).
    **ADOPTED** — §2.5 re-scoped: `e2ee-remote-types.ts` carries only the
    interfaces/DTOs that `remote/*` and the fake server import; policy and
    traversal helpers stay with the class.

### Rejected / not applicable

None — all 15 findings verified against source and adopted. (One inaccuracy
in the round-0 *codex inventory input* — a reversed `planGitSections` import
edge — had already been caught and corrected in the plan's §8 before this
round.)

**Round 1 outcome:** all findings folded into the plan; codex confirmed the
remaining line ranges (daemon class 246–1963, sync pull/push, crypto
resolver/pool/registry, E2EE class, blob decoder/downloader/uploader) as
sound. Plan considered ALIGNED pending founder review of the revision.
