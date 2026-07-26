# SPEC 204-B — manifest delta commits default-on + evidence fast-pull

Authoritative spec: docs/design/204-delta-scoped-publish.md §4 + §6 tests
5-11 + 9b/9c + §7's non_delta cause log. Read it fully first.

## Changes
1. `mdeWritePolicy()` (§4.2): lattice inversion, exported, consumed at BOTH
   seams — replace mdeWriteCaps internals (src/cli/e2ee-remote.ts:84-87)
   and make push's deltaBase selection (src/cli/sync/push.ts:773-778)
   consume the same policy (no raw env reads at the push seam). Warn-once
   module-scope latch for the contradictory pair
   (mde_delta_ignored_snapshot_kill_switch).
2. Master kill covers repair (§4.2): with snapshot=false, ALL arms emit
   raw-v0; forceSnapshot means "no delta", never "override the master kill"
   (src/cli/e2ee-remote.ts:769-795 restructure).
3. Base-integrity precondition (§4.2): delta selection additionally
   requires canonicalManifestHashStreaming(reconstructedBase) ===
   manifestMeta.manifestHash (helper exists: src/engine/manifest-delta.ts:96;
   Promise facade :195). Mismatch ⇒ snapshot + fresh meta write. May
   memoize per push.
4. RBOX_MDE_FAST_PULL default-on (§4.3): flip the read at
   src/cli/sync/pull.ts:89-101 to !== "0".
5. Evidence-fold fallback (§4.3): any evidence-fold failure in
   decodeManifestAt's suffix path ⇒ retry the SAME operation without
   evidence (cold walk); only cold-walk failure raises ManifestChainError.
   Exact-head path unchanged; design 106 suffix-hit semantics unchanged.
6. Non-delta cause log (§7): every non-delta commit logs
   `mde non_delta cause=<policy|no-base|integrity|force|economic|chain-cap>`;
   push seam passes deltaBaseRejection?: "no-base"|"integrity" on
   CommitOptions; epoch mismatch = integrity; economic/chain-cap
   writer-local.

## Tests (§6): 5, 6 (full kill-switch matrix incl. no-deltaBase-constructed
assertion + repair-under-master-kill raw-v0 + warn-once), 7 (16 REAL
consecutive delta commits, 17th snapshots — end-to-end, not injected), 8
(real economic rejection), 9 (verify vs src/cli/e2ee-sync.test.ts:774-785,
extend only for the fail-closed evidence cases), 9b (two-part: pull
completes without surfacing ManifestChainError on corrupt persisted
manifest + valid meta + advanced head; daemon-seam repair spy proves repair
fires only on surfaced errors), 9c (raw-v0 meta synthesis; update the
inverted expectation at src/cli/e2ee-sync.test.ts:704), 10 (stale-meta
integrity mismatch ⇒ snapshot + meta rewrite, reader folds clean), 11.
Ambient hygiene: force-delete RBOX_MDE_DELTA / RBOX_MDE_SNAPSHOT /
RBOX_MDE_FAST_PULL in beforeEach of every touched suite (the 202/203
lesson — this recurred three times).

## Constraints
- No server changes. No Part A/C files (sync-recovery preflight logic,
  sync-git/plan.ts).
- Wire shapes unchanged; the WS doorbell stays content-free.

## Acceptance
- bun test src/cli/e2ee-sync.test.ts src/cli/sync (or bun run test:affected)
- bun run test:api (must stay green — no server change expected)
- bun run typecheck
