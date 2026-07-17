# Design 149 adversarial review — round 1

Target: `docs/design/149-storage-economics.md`

## Findings

1. **BLOCKER — `last_seen_version` is observability, not a sound reader-capability floor.** The authentication row does record a validated version, but a headerless request refreshes `last_seen_at` while deliberately preserving the old stored version (`apps/api/src/auth/authenticate.ts:56-75`; the behavior is pinned by `apps/api/test/auth-version.test.ts:78-86`). A device that once reported a new binary can therefore return with a pre-header/pre-Phase-B binary and still look new. The 60-second mixed-process dampener creates the same false-positive window for an old daemon sharing a device row with a new CLI (`authenticate.ts:61-68`; `auth-version.test.ts:59-65`). The update is also best-effort and authentication succeeds if it fails (`authenticate.ts:69-77`). Treating this field as an admission capability can publish an envelope to a currently active incompatible reader. Unit A needs fail-closed, request-current capability evidence (and a policy for mixed processes/headerless requests), not an unchanged reuse of `last_seen_version`.

2. **BLOCKER — a `minReaderVersion` first returned by the commit response cannot gate the commit already encoded and uploaded.** The client chooses raw/snapshot/delta at `src/cli/e2ee-remote.ts:755-788`, uploads the chosen encrypted manifest at `:789-796`, and only then calls `commitSigned` at `:798-806`. The successful server response currently contains only sequence/hash/timings (`apps/api/src/workspace-sync.ts:731-733`), and the transport consumes it after the POST (`src/cli/remote/commits.ts:311-340`). A post-commit value can at most advise the next write. A pre-encoding handshake/pinned capability generation or an atomic server admission token is required; otherwise a stale device can authenticate after the writer reads the minimum but before its commit publishes. This is particularly exposed by direct `push`, which does not first pull (`src/cli/sync/push.ts:48-64`), unlike full `sync` (`src/cli/sync/sync.ts:8-19`).

3. **MAJOR — the Phase-B release floor and the claimed 30-day contract are historically false.** Phase B shipped in **v1.1.0**, not v1.6.5: the release entry explicitly includes chain-verified envelope reads (`CHANGELOG.md:446-458`), and tag inspection shows v1.0.1 lacks `src/engine/manifest-delta.ts` while v1.1.0 contains it. Per-device version reporting arrived later (the design-119 release record is in `docs/STATUS.md:20`), which is a different capability. Design 84 also requires fleet-wide read capability before any write and leaves open only how long raw-v0 continues *after fleet confirmation* (`docs/design/84-manifest-delta-encoding.md:1061-1096,1433-1436`); it does not authorize excluding unconfirmed devices after 30 days. A 30-day exclusion may be a new product ruling, but it must be stated as a deliberate weakening of design 84, with the real capability floor justified.

4. **MAJOR — the day-31 behavior is neither safe nor the promised UX.** The friendly unknown-envelope error exists only in Phase-B readers (`src/engine/manifest-delta.ts:451-455`). A pre-B reader decrypts and directly parses the envelope as JSON; design 84 records that old readers have no envelope handling (`docs/design/84-manifest-delta-encoding.md:1063-1076`). Thus the device the recency rule intentionally excludes gets a generic parse/validation failure, not “upgrade rbox.” On pull/full sync it records auth evidence and then fails on the already-published head. On direct push it can upload a raw-v0 manifest before a 409 forces the pull path (`src/cli/e2ee-remote.ts:783-806`; `src/cli/sync/push.ts:275-287`), or, if no envelope landed yet, win a raw commit and re-enter the recent set. The design needs explicit day-31 push, pull, conflict, and orphan-upload semantics plus an actual compatible error surface.

5. **MAJOR — Unit A leaves the minimum population and default/override mechanics undefined.** Device rows include `device`, `web`, and `api_key` principals (`apps/api/src/authz.ts:6-15`); a literal recent-device minimum can either include fresh null-version web rows and remain permanently off, or omit an enrolled API key that can sync. Device/version evidence is account-wide, not workspace-specific. The design must define `revoked`/expiry/kind filters, null and invalid versions, semantic-version comparison, and membership scope. It must also update both current flag seams: `mdeWriteCaps()` is exact-`"1"` and default-off (`src/cli/e2ee-remote.ts:73-80`), while push separately selects a delta base only for exact `RBOX_MDE_DELTA === "1"` (`src/cli/sync/push.ts:629-636`). A tri-state default plus server gate is not “no new mechanism,” and tests must cover both seams.

6. **BLOCKER — Unit B conflates the uploaded carrier hash with the reconstructed full-refset hash.** Today the client serializes the full canonical set, hashes those exact bytes, uploads them under that hash, and signs the descriptor (`src/cli/e2ee-remote.ts:703-720`; `src/engine/e2ee/commit.ts:123-145`). The server verifies object bytes against that address (`apps/api/src/sidecar.ts:32-43`). For `rbox-rsd1\n + header + delta body`, `sha256(deltaEnvelopeBytes)` cannot also equal `sha256(reconstructedCanonicalFullSet)`. The proposed envelope defines no separate result identity, yet requires the reconstructed full set to hash to “the sidecar identity the signed commit pins” (`docs/design/149-storage-economics.md:96-107`). Specify distinct carrier/object SHA and reconstructed-result SHA, and authenticate both (for example, a result hash in a strict header transitively pinned by the signed carrier plus an explicit signed-chain contract).

7. **BLOCKER — sidecars are not opaque to the server; correctness-critical server folding is missing.** The Worker enforces full-refset length/hash/canonical encoding (`apps/api/src/sidecar.ts:32-75`), expands it into every data SHA before commit accounting (`apps/api/src/workspace-sync.ts:556-580`), and parses it again for GC roots (`apps/api/src/versions.ts:95-109`). The existing server-side commit-delta admission path also assumes both parent and child are full fixed-layout refsets (`apps/api/src/workspace-sync.ts:287-337`; `apps/api/src/commit-delta.ts:40-94`). A wire delta therefore requires bounded folding in admission, roots/gap/index rebuild, storage-truth inspection, and the existing admission optimization. The design must say whether the latter consumes reconstructed buffers, is replaced, or is disabled during rollout. “Opaque as today — no route or schema change” (`149:108-112`) is mechanically false even if the public URL can remain unchanged.

8. **BLOCKER — retained delta sidecars lose their parents when the retention floor advances.** The current roots index stores only a sequence's own `carrier_sha` (`apps/api/src/workspace-sync.ts:772-820`), `/roots` returns only that carrier (`:982-1009`), and the collector roots only returned carriers (`apps/api/src/versions.ts:90-108`). Once a parent sequence falls below the floor, its sidecar can be collected although a retained child delta still needs it. Publication-time fallback handles a parent missing *then*; it cannot repair an already-retained child after later eviction. The ≤16 cap bounds work, not liveness. Design 84 solved the same problem with a signed exact `manifestChain` and per-retained-sequence roots (`docs/design/84-manifest-delta-encoding.md:562-641`). Unit B needs the equivalent signed/rooted sidecar chain (including presence/entitlement admission) or server materialization.

9. **MAJOR — the reconstructed-identity argument is incomplete even after adding a result hash.** A trustworthy fold must hash-check every fetched carrier against the parent address, reject cycles/duplicates/over-depth walks, validate strict canonical add/remove encoding and disjointness, verify linkage order, and match reconstructed count and total bytes to the signed descriptor. It must entitlement-gate every parent before R2 access; current anti-cross-account ordering gates only the one signed carrier (`apps/api/src/sidecar.ts:100-137`). Design 84 verifies the walked list and linkage against the signed chain (`docs/design/84-manifest-delta-encoding.md:725-767`). A final full-set hash gives result integrity, but it does not prove bounded availability, chain completeness, or safe cross-account reads.

10. **MAJOR — the Unit-B rollout gates the wrong reader and omits writer base state.** Pulling clients fetch/decode `encManifestSha` and `manifestChain`, not refset sidecars (`src/cli/e2ee-remote.ts:125-180,205-230`). The Worker is the sidecar reader; an old Worker rejects a new envelope by fixed length/magic and returns `bad_sidecar` (`apps/api/src/sidecar.ts:32-43`; `apps/api/src/workspace-sync.ts:568-576`). Server-reader deployment must therefore precede writers; per-device reader minima do not protect this seam. Separately, current crash-safe metadata and `CommitOptions.deltaBase` are manifest-specific (`src/cli/remote/commits.ts:57-64`), while the commit path knows only the anti-rollback pin before building the sidecar (`src/cli/e2ee-remote.ts:680-721`). A restarted/second device needs atomically persisted, verified parent carrier/result/depth/chain state. Threshold crossings (`<4000` inline versus `>=4000` sidecar) must force/reset anchors explicitly.

11. **BLOCKER — Unit C does not define a Worker-feasible computation for the target corpus.** Design 142 deliberately runs this partition in a disk-backed local process rather than a Worker (`docs/design/142-storage-truth-and-tiers.md:144-176`); the implementation uses a Bun SQLite spool, pinned root triples, restart-on-generation-change, and per-entitlement indexed membership (`scripts/storage-truth.ts:1-12,353-468`). Current Phase 1 is not incrementally materialized reachability: it first builds one complete in-memory set and only then scans one 2,000-row entitlement page (`apps/api/src/gc-phase1.ts:50-95,287-304`). That set fails closed at 750,000 unique roots, about 75 MiB by the accepted design (`apps/api/src/versions.ts:25-55`; `docs/design/96-roots-index.md:231-240`). The asserted 940,446 entitlement rows are 471 pages at the shipped 2,000-row limit. A cursor alone cannot safely accumulate head/history totals across changing `{head, pruneFloor,indexGeneration}` snapshots. Specify durable schema/tables, scan epochs and pins, transactional cursor+aggregate updates, restart semantics, a per-tick CPU/query/subrequest budget, and a no-prune-until-complete rule.

12. **BLOCKER — “whichever prunes more wins” violates downgrade grace.** Unit C applies to every account and independently moves floors (`docs/design/149-storage-economics.md:131-140`), but the locked-account contract preserves *all* history while live grace exists (`apps/api/migrations/0012_billing_grace.sql:1-4`; `apps/api/test/worker.test.ts:535-545`). Fixing `retentionPrune` does not automatically gate the new fair-use pass. An over-5× locked account would be pruned immediately unless Unit C itself resolves the plan and skips the whole account when `resolvedPlan === "none" && now < grace_until`. The proposed test wording implies that outcome, but the mechanism and “whichever” rule contradict it.

13. **MAJOR — the advertised 5× invariant contradicts `PLAN_FLOOR_BYTES`.** Scope and acceptance require `historyBytes <= 5 * activeBytes` (`docs/design/149-storage-economics.md:50-52,166-167`), while enforcement permits `historyBytes <= 5 * max(activeBytes, 1 GiB)` (`:131-136`). At 100 MiB active, the actual allowance is 5 GiB, or 51.2×; at zero active the advertised ratio is undefined. Rename the invariant and acceptance to the floor-adjusted formula. Also clarify whether the 1-GiB allowance is account-global (as the formula says) or per workspace (as “near-empty workspaces” says); global oldest-first can spend all allowance in one workspace.

14. **MAJOR — account-global “oldest first” lacks an authoritative total order.** DO sequences are authoritative only within a workspace. Cross-workspace timestamps come from the best-effort D1 commit mirror, whose failure is swallowed after publication (`apps/api/src/workspace-sync.ts:720-729`). The inspection API explicitly represents a missing mirror timestamp as unavailable (`apps/api/src/routes/admin.ts:43-46,74-120`), and design 142 refuses to guess (`docs/design/142-storage-truth-and-tiers.md:203-211`). Retention can safely under-prune one workspace when its mirror row is absent (`apps/api/src/retention.ts:60-71`); account-global fair-use cannot honestly choose the oldest candidate across workspaces. Define an authoritative ordering key, tie-breaker, and fail-closed behavior for missing evidence, or store server time with the DO sequence.

15. **MAJOR — convergence/mutation is unbounded and unfenced.** `/prune` monotonically caps at `head - 1`, but synchronously deletes every sequence through the target and can return `409 prune_deferred` until its roots index catches up (`apps/api/src/workspace-sync.ts:1125-1143`). Unit C specifies no batch cardinality, per-invocation page/prune-call ceiling, lease, checkpoint, or recovery when a crash occurs after floor movement but before aggregate state commits. Two overlapping cron/manual runs can act on the same stale totals. “Recompute after each batch” over a 471-page entitlement scan cannot be assumed to converge in a bounded test. Specify lease/CAS ownership, mutation epochs, authoritative restart from current floors, `prune_deferred` handling, and maximum work per invocation.

16. **MAJOR — the grace bug is real, but clearing grace on only `adminSetPlan` is the wrong companion fix.** The comment says grace applies only when locked, but the code checks it before resolving the plan (`apps/api/src/retention.ts:51-59`), so paid accounts with a live stale stamp are indeed skipped. Moving the check after resolution and conditioning it on `plan === "none"` fixes that safely under today's resolver (`retention.ts:22-25`). Clearing a stamp on admin upgrade is unnecessary and conflicts with the existing once-per-window anti-extension rule: Stripe deliberately retains it so a subscribe/cancel loop cannot mint a fresh 30 days (`apps/api/src/stripe.ts:175-182,203-218`), while admin downgrade uses the same non-extension predicate (`apps/api/src/billing.ts:149-160`). Selectively clearing at `billing.ts:160` makes admin and Stripe state machines diverge and permits a later admin downgrade to restamp a fresh window. Keep the stamp and qualify reads, or redesign both upgrade paths and test downgrade -> upgrade -> downgrade.

17. **MINOR — the proposed status line has no durable source or lifecycle.** `GET /v1/account/usage` currently returns plan, aggregate usage/caps, retention, grace, and read-only only (`apps/api/src/billing.ts:125-142`). “Fair-use pruning is active” needs persisted account scan/prune state, a definition of active versus historically trimmed, and clear/reset rules. No new route may be necessary, but durable schema/state is.

18. **MAJOR — rollout coupling is wrong across all three units.** Unit B cannot use Unit A's device-reader gate because its reader is the server (finding 10). Unit C's aggressive floor advancement directly exercises Unit B's missing parent-root invariant (finding 8), so shipping C first does not “protect” an incompletely rooted sidecar format; it makes the future failure mode routine. A stale device authenticating during an A write also races the proposed gate (findings 1-2), so the A1/A2 one-release cadence does not close compatibility by itself. Define independent capability dimensions and hard ordering: server sidecar codec/fold/root support before any B writer; signed sidecar-chain admission/rooting before C can prune B sequences; and an atomic pre-write/admission capability contract for A.

19. **MINOR — several evidence and line anchors are stale or absent.** The random nonce claim is true at `src/engine/e2ee/manifest-crypto.ts:42`, not `:34`; refset size is defined at `src/engine/refset.ts:25-27,47-49`; the sidecar upload is at `src/cli/e2ee-remote.ts:703-720`, not `:692`. `src/engine/git/capture.ts:242` does not establish the <=8 chain bound; the actual bound is `src/engine/manifest-validate.ts:19,318-325` and writer decision `src/cli/sync-git/shared.ts:136-137`. The convergent encryption anchor at `src/engine/crypto.ts:141-143`, MDE flag anchor at `src/cli/e2ee-remote.ts:73-80`, and grace anchors at `apps/api/src/retention.ts:54-59` / `apps/api/src/billing.ts:160` are substantively correct. The cited `scratchpad/codex-explore-bundle-retention.log` does not exist in this worktree, and no checked-in storage-truth report independently substantiates the exact 940,446-row, 4,780-commit, 4,344/5,320-band-count, 181-GiB, 193.3-GiB, or 56.6-GiB figures (nor the observed ~500-commit/day rate). The 39-41 MB and 24x claims are supported by `CHANGELOG.md:446-455`, and the stated ~20 GB/day arithmetic follows from the asserted inputs; the production inputs themselves need an attached report/digest if they are to be reviewable evidence.

## Verified mechanisms

- Modern clients send `x-rbox-version`, and auth stores a validated per-device `last_seen_version` (`src/cli/remote/context.ts:51-53`; `apps/api/src/auth/authenticate.ts:38-75`). That is useful telemetry, but finding 1 prevents using it unchanged as a safety gate.
- Current manifest envelope writes are default-off; snapshot/delta implication and the <=16 writer re-anchor are implemented (`src/cli/e2ee-remote.ts:73-80,761-787`; `src/engine/manifest-chain.ts:1-10`).
- At >=4,000 unique refs, the client uploads the complete canonical sidecar before every commit; the encoding is exactly `18 + 40 * count`, sorted and duplicate-free (`src/cli/e2ee-remote.ts:703-720`; `src/engine/refset.ts:25-27,47-49,94-111`).
- Today's signed commit genuinely pins the full sidecar carrier SHA, and server validation fails closed on length, object hash, encoding, count, and total bytes (`src/engine/e2ee/commit.ts:123-145`; `apps/api/src/sidecar.ts:32-43,100-137`).
- Design-142's active/history classification exists and gives head reachability precedence (`scripts/storage-truth.ts:97-114,448-468`), but it is a local spooled computation, not a reusable Worker pass.
- The retention grace bug exists exactly as described. The safe narrow correction is “resolve plan first; consult live grace only when resolved plan is `none`.” `/prune` still guarantees the head survives (`apps/api/src/workspace-sync.ts:1129-1143`).

## Verdict

**CHANGES-REQUIRED.** Unit A lacks a sound and timely capability gate; Unit B lacks a coherent two-identity wire contract, server fold, and retained-chain rooting; Unit C lacks a bounded Worker execution/state model and presently violates downgrade grace. The rollout order depends on all three unresolved seams.

## Round 1 rulings (orchestrator)

- F1, F2 (A-gate unsound/untimely): ACCEPT. Unit A v2 replaces last_seen_version
  reuse with a pre-write capability contract: the server issues a workspace
  capability generation at key/head fetch (the client already round-trips
  before encoding), commits carry the generation, and admission rejects a
  commit whose generation predates a capability change. Headerless/mixed-
  process requests count as INCAPABLE (fail closed).
- F3: ACCEPT. Phase-B floor corrected to v1.1.0. The stale-device exclusion
  window is written up as an explicit product ruling amending design 84's
  open compat question — founder sign-off required at review exit.
- F4: ACCEPT. v2 specifies day-31 semantics per surface (push, pull,
  conflict, orphan upload) and drops the false "friendly error" claim for
  pre-B readers.
- F5: ACCEPT. v2 defines the gate population (kind=device, unrevoked,
  unexpired; null/invalid version ⇒ incapable), semver comparison, and both
  flag seams incl. push.ts deltaBase.
- F6–F10 (Unit B): ACCEPT ALL. "Opaque to the server" was wrong — the Worker
  parses sidecars for admission accounting and GC roots. v2 rewrites Unit B
  with: distinct carrier-SHA vs result-SHA identities (result hash in the
  strict header, transitively signed); a signed sidecar chain with
  per-retained-sequence rooting mirroring design 84's manifestChain
  (closes the parent-eviction liveness hole); server-side bounded fold in
  admission/roots/commit-delta with explicit entitlement gating per parent;
  server codec deploys BEFORE any writer; persisted writer base state and
  threshold-crossing anchor resets.
- F11–F15 (Unit C): ACCEPT ALL. v2 specifies a durable scan ledger (D1
  tables, scan epochs pinned to {head, pruneFloor, indexGeneration} triples,
  transactional cursor+aggregate commits, lease/CAS ownership, bounded
  per-tick work, prune_deferred handling, no-prune-until-complete);
  grace-qualified skip (resolved plan none + live grace ⇒ untouched);
  invariant renamed to the floor-adjusted formula with the 1 GiB allowance
  scoped account-global; per-workspace oldest-first with fail-closed skip
  when the mirror timestamp is absent (no cross-workspace guessing).
- F16: ACCEPT-MODIFIED. Keep the grace stamp; fix reads only (resolve plan
  first, consult grace only when resolved plan is none). The clear-on-
  upgrade companion is DROPPED — it would fork admin vs Stripe state
  machines and reopen the anti-extension rule.
- F17: ACCEPT (durable fair-use scan state feeds the status line).
- F18: ACCEPT. Rollout reordered: (1) grace read fix + Unit C scan ledger
  (no pruning of B-format sequences until B rooting ships), (2) server
  sidecar codec/fold/roots, (3) B writers, (4) A capability contract, each
  independently gated.
- F19: ACCEPT. Anchors corrected in v2; measurement digest (spool queries,
  band counts, sequence count) attached as an evidence appendix.

Interim note: the v1.7.1 snapshot default-flip (PR #309) intentionally uses
the manual device-inventory + kill-switch path and is NOT gated on Unit A;
findings 1–2 are about the durable mechanism that replaces that manual check.

## Round 2

1. **BLOCKER — F1 is still unresolved: A1 still derives safety from the telemetry row and cannot represent mixed processes.** V2 says the DO recomputes from recent device rows and treats only a NULL/unparseable `last_seen_version` as incapable (`docs/design/149-storage-economics.md:69-77`). A headerless request, however, refreshes `last_seen_at` while preserving a previously capable version; a different version is suppressed for 60 seconds; and the update is best-effort (`apps/api/src/auth/authenticate.ts:56-75`; the exact headerless/mixed behavior is pinned at `apps/api/test/auth-version.test.ts:59-65,78-86`). One device row cannot express the minimum of a new CLI and an old daemon that remain live concurrently. Nor does the Worker currently forward a request-current device/kind/capability fact to the DO: reads pass the request through and writes add only account/epoch (`apps/api/src/routes/sync.ts:28-45`). Consequently an incapable headerless process can still look capable, and A4's claim that its contact necessarily lowers floors is false (`149:118-122`). This needs request-current evidence plus sticky/per-process incapable state (and fail-closed failure semantics), not another recomputation of `last_seen_version`.

2. **BLOCKER — F2's pre-encoding pin does not exist on direct push.** V2 says the client already shares a key/head DO round trip on both paths (`docs/design/149-storage-economics.md:81-93`), but direct `push` does not pull (`src/cli/sync/push.ts:48-64`). Its write setup calls `currentKek`, which reads account keys and the workspace KEK (`src/cli/e2ee-remote.ts:111-120,886-929`) through D1 key routes, not WorkspaceSync (`apps/api/src/routes/keys.ts:12-25`). Immediately before encoding, `commit` refreshes those keys and reads the local pin (`src/cli/e2ee-remote.ts:661-690`); it uploads the sidecar and encrypted manifest before its first DO contact, the commit POST (`:703-720,789-806`). Full sync happens to call `/latest` through pull (`src/cli/sync/sync.ts:17-18`), direct push does not. A real pre-encode DO handshake, or a capability response spliced into a route every write attempt actually calls, is required.

3. **BLOCKER — the DO cannot enforce A2 because the signed body does not declare the manifest encoding.** A2 adds `capabilityGen` but asks admission to inspect “the commit's encoding class,” while A3 also permits a force-on override (`docs/design/149-storage-economics.md:81-103`). Raw-v0 and snapshots are both chain-free encrypted manifest blobs (`src/cli/e2ee-remote.ts:783-787`). The signed commit exposes an encrypted manifest SHA and optional `manifestChain`, but no raw/snapshot/delta class or override (`src/engine/e2ee/commit.ts:35-60,123-145`); the Worker sees only those fields and opaque ciphertext and never verifies the signature (`apps/api/src/commit-envelope.ts:4-10,45-64`). Because legacy raw must “always admit” (`149:89-90`), admitting the indistinguishable class also admits a stale snapshot. This is already a rollout problem, not only a future schema problem: the v1.7.1 change makes snapshot writing default-on but sends neither the generation nor an encoding declaration (`git show b3259f7:src/cli/e2ee-remote.ts:78-86,790-803`). The new server must either admit that indistinguishable snapshot after a floor drops, or reject a released client that cannot re-pin/re-encode and treats 409 as ordinary conflict. Add a signed, canonical encoding declaration, a validated override policy, an explicit legacy-absence rule, and a legacy-writer transition.

4. **MAJOR — F5 is only partial, and A1 has no bounded query contract.** The population is stated as `kind = 'device'` and then says `api_key` counts as a device (`docs/design/149-storage-economics.md:69-75`), but API keys are stored as `kind='api_key'` and are full E2EE sync principals (`apps/api/src/auth/api-keys.ts:45-55`; `apps/api/src/worker.ts:421-439`). No minimum version is given for any of `mdeSnapshot`, `mdeDelta`, or `refsetDelta`, so strict semver comparison alone cannot compute the three floors. Finally, credentials live on the directory plane while the DO belongs to the account-data plane (`apps/api/src/db.ts:13-25`), and the available device index is `(account_id, expires_at, created_at)`, not the proposed kind/revoked/last-seen predicate (`apps/api/migrations/0015_device_management.sql:3-13`). V2 must define `kind IN ('device','api_key')`, the three version constants, the Worker-to-DO forwarding/failure contract, and an indexed bounded recomputation (or materialized account capability) before the every-contact budget claim is credible.

5. **BLOCKER — F6's two identities are conceptually separated, but B1 is not a canonical wire contract.** `carrierSha` depends on exact envelope bytes, yet `magic + strict-JSON header + body` defines neither a header length/delimiter nor exact binary encodings for added `(sha,size)` records and removed SHAs; it is also unclear whether `chain` includes the current carrier (`docs/design/149-storage-economics.md:133-145`). The current format is byte-exact down to magic, u32 count, 40-byte records, and no trailing bytes (`src/engine/refset.ts:1-17,25-27,45-60`). V2 also duplicates `resultSha` between header and signed descriptor without requiring equality, and moves `count`/`totalBytes` into the header without saying whether they remain signed and cross-checked (today all three descriptor fields are signed and validated at `src/engine/e2ee/commit.ts:24-33,90-99`). Specify framing, canonical full/delta bodies, exact chain membership/order, every cross-field equality, and golden vectors.

6. **BLOCKER — F8 remains a claimed invariant; B3 does not integrate with the roots index or its pagination.** The shipped `seq_roots` table has one `carrier_sha` per sequence, both fold paths write one value, and sweep deletes by sequence (`apps/api/src/workspace-sync.ts:200-203,772-820,844-847`). `/roots` and `/roots-inspect` likewise emit one carrier (`:982-988,1075-1088`), and the collector roots only that value (`apps/api/src/versions.ts:90-109`). B3 merely says “stores ... FULL sidecar chain” (`docs/design/149-storage-economics.md:163-171`) without a schema migration/backfill, normalized rows versus bounded JSON choice, atomic fold/subcursor rules, raw-gap representation, sweep/cascade rules, or consumer changes. A naive 16-carrier expansion under the existing 20,000-sequence page limit (`workspace-sync.ts:31`) can produce over 20 MB of hashes before JSON overhead. Until storage and composite pagination are specified, advancing a floor can still strand an ancestor.

7. **MAJOR — F9's per-parent entitlement check omits the publication/GC fence and recovery semantics.** The existing prefetch gate proves only entitled + present before R2 access (`apps/api/src/sidecar.ts:100-137`). Safe publication additionally runs every referenced address through `validateCommitRefs`, which excludes per-account prune candidates and active delete intents so accounting re-grants/unmarks them (`apps/api/src/commit-accounting.ts:91-145,204-218`). B2 says each parent is entitlement-gated but never adds every parent carrier to that accounting union (`docs/design/149-storage-economics.md:149-160`; the current union is at `apps/api/src/workspace-sync.ts:578-580`). It also maps any fold failure to `bad_sidecar`, losing today's 422 missing/unentitled versus 400 corrupt distinction (`apps/api/src/sidecar.ts:124-137`) and gives the writer no “parent vanished, re-anchor full” response. Parent carriers need the full candidate/delete fence and typed recovery path.

8. **MAJOR — F7/F10's bounded fold and restart/second-device base state are incomplete.** B2 asserts at most `16 × 6MB` (`docs/design/149-storage-economics.md:149-156`), but admission permits 250,000 refs and the current full encoding is `18 + 40*count`, about 10 MB (`apps/api/src/commit-accounting.ts:43-48`; `src/engine/refset.ts:45-49`). The half-full rule can still require roughly a 10 MB anchor plus fifteen ~5 MB deltas, with no object-size preallocation gate, streaming algorithm, cumulative-chain byte cap, CPU/subrequest budget, or roots-gap budget. B4 says to persist parent/depth/chain beside manifest metadata (`149:173-181`), but normal clients do not fetch refset sidecars, the signed descriptor does not expose depth/chain, and the existing verified persisted slot contains only manifest evidence (`src/cli/config.ts:177-220`). V2 never explains how a pulling second device obtains, authenticates, and atomically saves sidecar base evidence. “Missing → full” is safe, but does not fulfill the accepted verified second-device/restart mechanism.

9. **BLOCKER — F11 is not resolved: the proposed ledger cannot perform resumable active/history classification.** C2 claims the existing DO endpoints serve per-root indexed head membership (`docs/design/149-storage-economics.md:201-217`), but `/roots-inspect` only pages `dropped_index`, per-sequence manifest/current-carrier rows, and a raw head gap; it accepts no SHA membership query (`apps/api/src/workspace-sync.ts:1068-1122`). The shipped runner obtains membership by durably materializing `workspace_scans`, `stream_state`, and a `roots` relation, atomically checkpointing each stream (`scripts/storage-truth.ts:251-263,389-439`), then querying that relation for every entitlement (`:448-468`). `fairuse_scans(... pins_json, cursor, active_bytes, history_bytes ...)` has neither per-workspace/per-stream cursors nor a root-membership table (`149:203-205`), and therefore cannot resume the roots × entitlement join or delete the right partial materialization after pin churn. “Same caps as Phase 1” names only an entitlement-page analogy, not a root/workspace-page, D1-statement, CPU, or subrequest budget; even capturing every workspace pin needs a checkpointed phase. A single cursor plus aggregates is not sufficient schema.

10. **BLOCKER — completion is not fenced to mutation; the lease and per-invocation bound are labels rather than mechanics.** C2 allows pruning from any completed epoch (`docs/design/149-storage-economics.md:216-217`) but C3 never revalidates its saved triples before each floor move, while `/prune` accepts only a floor and checks no scan epoch/pins (`apps/api/src/workspace-sync.ts:1128-1143`). A commit or index/floor change immediately after scan completion therefore leaves enforcement acting on stale classification. The lease declaration has no primary key/unique constraint, conditional acquire/takeover SQL, renewal, fencing token, or owner/expiry guard around ledger writes and `/prune` (`149:203-205,219-241`); compare the shipped GC lease's value-CAS takeover, renewal, and mutation guard (`apps/api/src/versions.ts:247-289,308-336`). Finally, eight calls do not bound DO work: “bounded step” has no numeric maximum, and one current call synchronously loops across every sequence to the target (`workspace-sync.ts:1139-1142`). F15 remains unresolved; specify a max floor delta and holder+epoch CAS on every state transition and prune.

11. **MAJOR — F18's no-prune-before-B3 rule is still rollout convention, not structural ordering.** V2 says fair-use “never prunes” an uncovered format because B3 ships first, then enables enforcement before writers (`docs/design/149-storage-economics.md:242-244,279-288`). Neither the scan/lease schema nor `/prune` carries a roots schema version, per-sequence coverage marker, minimum safe floor, or enforcement kill switch; `/prune` is format-blind (`apps/api/src/workspace-sync.ts:1128-1143`). Thus partial deployment, rollback, incomplete backfill, or an independently invoked retention prune can violate the invariant. Gate floor movement on an authoritative roots-format/coverage generation inside the DO. The broad deployment direction—server codec/rooting before writers—is otherwise sound.

12. **MINOR — F17 still lacks a durable status lifecycle.** The promised API exposes `lastCompletedEpochAt` and `pruningActive` (`docs/design/149-storage-economics.md:253-257`), but `fairuse_scans` has `started_at` and generic `state`, no completion timestamp or defined active/clear transition (`:203-205`). Define which epoch supplies displayed totals, when pruning becomes active, and when it clears after convergence, grace, plan change, aborted pins, or an enforcement kill switch.

### Verified round-1 resolutions

- F3's historical floor is corrected to v1.1.0 and the 30-day exclusion is explicitly a product ruling, although the required founder sign-off is still external to this review (`docs/design/149-storage-economics.md:105-117`). F4's pull/push/orphan outcomes are substantially present; the existing 409 path is only implicit (commit maps it to conflict and push pulls at `src/cli/remote/commits.ts:316-320`; `src/cli/sync/push.ts:278-287`).
- F12, F13, F14, and F16 are resolved in prose: fair-use skips locked accounts during live grace, the floor-adjusted account-global formula is consistent, missing mirror timestamps fail closed, and the grace stamp is retained while reads are qualified (`docs/design/149-storage-economics.md:194-199,223-251`). F19's cited code anchors and measurement digest are present (`:9-36,299-309`).
- F1/F2/F5 remain unresolved or partial (findings 1-4); F6-F10 remain partial/unresolved (findings 5-8); F11/F15/F17/F18 remain unresolved or partial (findings 9-12). The resolved grace/formula/order prose does not compensate for the missing executable scan and fencing model.

**VERDICT: CHANGES-REQUIRED.**

## Round 2 rulings (orchestrator)

ALL 12 ACCEPTED — every finding verified against code; none overruled.
Direction for v3 (executable-level completeness):

1. A1 evidence: Worker forwards a request-current capability fact
   {kind, version|absent} to the DO on every authenticated contact; the DO
   keeps sticky per-principal incapable state (headerless/mixed process ⇒
   incapable until a versioned contact from that principal); forwarding
   failure ⇒ treat contact as incapable (fail closed).
2. Pre-encode pin: capability {gen, floors} is spliced into the keys route
   response (the one round-trip every write path provably makes) AND
   /latest; commit admission requires a gen. No new client round-trip.
3. Signed encoding declaration: commit body gains a canonical `encoding`
   field (raw|snapshot|delta|sidecar-delta) + optional `override:true`;
   absence ⇒ legacy rule = admit as raw-or-snapshot (v1.7.1 fleet) until a
   floor-off event, after which legacy-absent commits still admit but log;
   the gate can therefore never brick a released client. Founder fleets
   using force-on set override, which admits regardless of floors.
4. Population `kind IN ('device','api_key')`; three version-floor
   constants pinned (mdeSnapshot=1.1.0, mdeDelta=1.1.0, refsetDelta=first
   release shipping B readers); directory-plane query served by a new
   covering index (append-only migration) + Worker-side capability
   summary forwarded to the DO (account-plane never queries directory).
5. B1 framing: exact byte layout (magic, u32 header length, canonical
   JSON header, fixed-width binary body records), chain excludes current
   carrier, header resultSha/count/totalBytes MUST equal signed
   descriptor fields (cross-checked both places), golden vectors table.
6. B3 schema: new normalized `seq_root_chains(seq, ord, carrier_sha)`
   rows + migration/backfill; sweep deletes by seq; /roots pagination
   emits (seq, chain) pages under a byte budget; collector roots the
   union. No JSON blobs.
7. Parent carriers join the validateCommitRefs accounting union
   (candidate/delete fence identical to data refs); fold failures keep
   the 422 missing/unentitled vs 400 corrupt split; new typed
   `sidecar_parent_gone` 422 ⇒ writer re-anchors full.
8. Budgets: cumulative chain-byte cap (32 MiB), per-fold subrequest and
   CPU budget stated; writer base evidence: second device reconstructs
   from the signed descriptor chain on first sidecar-bearing pull and
   persists it in the same verified slot schema as manifest evidence
   (schema extension specified).
9. C2 ledger: adopt the 142 runner's shape in D1 — per-workspace stream
   cursors table + materialized root-membership table + scan-epoch
   checkpoint rows; explicit per-tick budgets (pages, statements,
   subrequests); pin capture is itself a checkpointed phase.
10. Fencing: fairuse_leases gets PK + value-CAS acquire/renew/takeover
    (mirror versions.ts GC lease); /prune gains optional {scanEpoch,
    pins, maxDelta} body — DO validates pins at prune time and rejects
    stale epochs; max floor delta per call = 500 sequences.
11. Structural ordering: DO stores a roots-format coverage generation;
    floor movement (fair-use AND retention) refuses to cross a sequence
    whose chain rows predate the required generation unless coverage
    backfill for it is complete; enforcement kill switch env on the
    Worker.
12. Ledger lifecycle: completed_at column; displayed totals = latest
    completed epoch; pruningActive set on first floor move of an epoch,
    cleared on convergence, grace entry, plan change, or kill switch.

v3 drafting of the mechanical sections (DDL, framing, vectors, budgets)
is delegated; rulings above are the spec for that derivation. Round 3
goes to a fresh reviewer against v3.
