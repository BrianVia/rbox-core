# 163 v5 ratification review — lens: correctness of code claims (opus, 2026-07-27)

## Verdict: NOT-READY

Five blockers, all falsified against `src/`. The doc is exceptionally strong on the reset-journal/migration protocol (~25 constants and grammar rules verified, nearly all exact), but the C4 "complete inventory" claim does not survive independent enumeration, and the v5 status line misdescribes its own relationship to v4.

## Blockers

### B1 — C4 inventory incomplete: live safety-relevant consumer of `lineages/` unnamed; 163 silently breaks it
`src/cli/sync-state-store.ts:68-83` — `hasResetLineageArchive(root)` matches `lineages/<hex32>/<hex64>.json`. Called from `loadState` (`:322-324`) whenever `lastSyncedSequence === 0`, marking the state into `streamMismatchFreshStates` → `stateWasStreamMismatch` → `allowLegacyStreamReplacement` at `src/cli/sync/pull.ts:445`, `src/cli/sync/push.ts:539,579,623`. This is an authorization input, not diagnostics.

Three failures vs the v5 text: (1) v5 declares legacy-exact archives "always inert / permanently inert under SQLite" — their presence is a semantic predicate on every load; (2) the inventory's consumer list omits `sync-state-store.ts`, and the module ownership tree assigns this function no owner; (3) **post-163 regression**: reset archives become `lineages/<nonce>/<sha>.db`; the `.json`-only regex then returns false, so rebind-vs-genesis provenance marking silently stops, changing `allowLegacyStreamReplacement` on seq-0 states. Nothing in 2,851 lines assigns this predicate a SQLite-era definition.

### B2 — Z-entry ordering is `localeCompare`, not "lexical order"
`src/cli/reset-journal.ts:170,:557` sort Z by `localeCompare`; doc lines 296/527 say "lexical order". Contrast `:404` (`sort()`, code-unit order) for the `Ag` group axis, which the doc gets right. A decoder implementing "lexical" with `<` rejects legitimate legacy-v2 journals with non-ASCII refs; the SQLite branch emits a Z order a 1.7.x reader disagrees with. The doc is elsewhere scrupulous about exactly this distinction (256-cap fold, `path_order` UTF-16BE), so this is an oversight, not style.

### B3 — `resolutionIntent` missing from the "field-complete" RepoRecord mapping
`src/cli/sync-state-model.ts:355-371` (`stripObsoleteResolutionIntents`) + `:402-404`: ≤1.7.18 persisted `resolutionIntent`, which every state reader deliberately strips. Zero hits in the doc. Collides with two v4 normatives at once: `extras_cjson` "preserves currently tolerated unknown object members across migration" (line 2527) and M4's `source digest == SQL round-trip digest`. Either import preserves it (resurrecting a contractually-deleted member) or strips it (breaking the round-trip gate). f7 exhaustiveness not met.

### B4 — Design 130 cap wrong by 2×
Doc line 171 says "8/ref". `src/engine/manifest-validate.ts:23-24`: `MAX_REF_TOMBSTONES_PER_REF = 16`, `MAX_REF_TOMBSTONES_PER_REPO = 512`. (Expiry 90d checks out.)

### B5 — "strictly additive / every v4 closure remains normative" is false
v5 overrides two v4 normatives: line 2063 retracts v4 1907-1908 (replacement-pair creation now forbidden; revalidate-and-reuse required), and lines 2049-2061 declare the `promotedHalt` delegation the narrow specialization overriding the crash-table row (2189) and halt-clearing contract (2247-2249) — under v5 the rename IS the clear. Substance coherent; provenance statement false. Ratifying a doc whose own status line is wrong invites implementers to honor superseded v4 text.

## RATIFY-WITH-EDITS items (fix alongside blockers)

6. Line 439 claims `reset-quarantine.ts` imports the journal module for raw bytes — it parses no journal bytes today. Actual raw-byte consumers: `reset-io.ts`, `reset-journal.ts`, `reset-journal-doctor.ts`, `reset-state.ts:300,43`, `sync-state-store.ts`. Two live consumers unnamed.
7. Module ownership tree (2756-2803) omits `src/cli/reset-journal-classifier.ts` (owns the P/R/I/Z row union today; must gain J0/W1/W2/W3) and `src/cli/reset-halt-inspection.ts`.
8. Line 1516 names `RBOX_PROCESS_BUDGET_BYTES` default 4 GiB — env var is `RBOX_RESET_PARSE_BUDGET_BYTES` (`reset-io.ts:275`), default machine-scaled (totalmem/4, floor 4 GiB, ceiling 32 GiB, cgroup-lower-wins). Name a genuinely new var or describe 161's correctly.
9. Line 1479 "removes the daemon's retained `this.manifest`" — post-decomposition it is `this.local.manifest` (`daemon.ts:2626`, owned by `LocalAuthority` `:331`).
10. `apply-receipt.ts:715-763` past EOF (file is 756 lines); `:157-162` is `normalizeRel`, `canonicalReceipt` at `:152`. Other four cited ranges verified exact.
11. Reset namespace scope (313-318): quarantine bundles (`reset-quarantine.ts:67-86`) are a fourth durable reset tree; excluding them from inventory scope is fine but must be said.
12. Line 1601 understates: `MAX_MANIFEST_BYTES` is enforced at ZERO call sites (definition + re-export only).
13. v5 `b..b+4` runway (2011-2015): caught ENOSPC anywhere in b..b+4 publishes no alternate control → `durableHalt=false` — a deliberate bounded forfeiture of f6's every-write-handles-ENOSPC promise. Name it as a scoped exception.
14. v4 line 1876 ("after its intent is durable at revision r … renders two siblings") never retracted; under v5 intent is durable at b=r-4. Amend v4's paragraph in place.

## Verified accurate (no action)
52× multiplier, 512 MiB materialized cap, 2 GiB stream cap, 4/32 GiB budget + cgroup-lower-wins, MAX_GIT_REPOS=256, MAX_MANIFEST_PLAINTEXT=512 MiB, MAX_Z=256, MAX_TEXT=4096, MAX_JOURNAL_BYTES=524288, HEX32/40/64 lowercase-only (legacy grammar exact incl. `reset-candidates/<id>.json`, `lineages/<nonce>/<sha>.json` at `reset-journal.ts:131-132`), legacy v1/v2 key sets exact, 256-entry deferral/partial caps via localeCompare, 50k/5k address caps, 50 MiB ls-files maxBuffer, TrackedRepoSet shape, EncryptAddressCache.pathOwner, applyCipherDescriptor in-place, sameContent ignores mtimeMs, design 85 Layer A default-on w/ RBOX_SCAN_PRUNE=0, #349 = 9bfb2528, bun:sqlite present (Bun 1.4.0/SQLite 3.53.2), arithmetic all exact (0x52424F58=1380077400, Q=58 bytes, base64(262144)=349528, token sums 7996/8008 ≤ 8192).

## Recommendation
Fix B1–B5 and items 6–14, then re-sweep for other `.rbox/state/**` readers whose file extensions 163 changes (`adopt-cache.ts`, `reset-health.ts`, `drift-audit.ts`, `path-warnings.ts` were outside the C4 fold's scope statement). The rest of the corpus is ratification-grade.
