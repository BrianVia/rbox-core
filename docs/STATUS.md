# rbox status — living state snapshot

> Cross-host memory for Brian + agents. Update this doc when a release ships or
> a workstream opens/closes. Deeper context: `docs/design/*` (numbered designs),
> PR history, and per-machine Claude session memory (does not travel — this doc
> is the carrier).

_Last updated: 2026-07-11 (evening) — design 103 IMPLEMENTED + ROLLED OUT (#218 code, #219 flags): missing preflight 2.8–4.0s → **0.1s measured on the live fleet**; both daemons on `1.0.0-dev+2cb1ac5` with `RBOX_PREFLIGHT_DELTA=1`; prod worker early-reject flag ON. Design-99 Phase-0: **GO — 86.8% encrypt cut [CI 84.1–87.7%]** (#220 merged; budget=96 MiB; determinism byte-identical; DOMINANT cost = concurrent streaming-zstd contention, not per-job overhead — Phase 1 gains a global fused-dispatch bound ~4–6; sync-zstd is 18× faster but address-breaking → parked as a separate founder decision). GC drain matures ~20:01Z._

## 2026-07-11 evening — design 103 built, validated, rolled out (same day as its design)

- **#218 (code, flag-gated default-off):** Part A server early stale-parent/
  epoch 409 (`RBOX_COMMIT_EARLY_REJECT`) + Part B client change-only preflight
  (`RBOX_PREFLIGHT_DELTA`), including the latent-bug fix (unsatisfiedBlobs now
  threaded through the reupload action; was dropped at sync.ts:464), the
  RECOVER_ACCUM_MAX=100k latch→chunked-full-audit, `RBOX_PREFLIGHT_FULL`
  escape hatch, and the design-102 coexistence regression pin. 4-round codex
  impl review to ALIGNED; /simplify + antislop clean; worker suite 420 pass
  both flag states; client suite 1242 pass (2 known host failures only).
  All implementation code written by codex (zero hand-written lines).
- **Real-workload validation (114k-file workspace, one-file pushes):**
  `missing` phase **2.8–4.0s → 0.1s**, `sent == introduced` exactly
  (`i/r/s/fa` counters in push lines), no fallback latches. Push wall
  19–22s → ~18s; the remaining wall is commit (~12s, design 102/84) + scan
  (~8s, design 85).
- **Rollout:** both fleet daemons rebuilt at `1.0.0-dev+2cb1ac5` and restarted
  with `RBOX_PREFLIGHT_DELTA=1` (env-var flag — a manual daemon restart
  without it reverts to full preflight, which is safe). #219 flips
  `RBOX_COMMIT_EARLY_REJECT=1` on dev+prod workers via wrangler vars
  (auto-deployed on merge; rollback = revert that line). Part A live
  verification pending a natural 409 (watch for `earlyReject: 1` in AE
  metrics / a fast conflict retry).
- **`/blobs/check` server-side cap deliberately NOT shipped** (client-first
  rollout per design §; ship only after fleet binaries are confirmed
  upgraded).
- **In flight:** design-99 Phase-0 A/B prototype (fused crypto measurement +
  budget selection per founder decision). Next queued: design 102
  implementation (shadow mode), design 84 C1/C2/D, 98/100/101 builds.

## 2026-07-11 — performance design day (all six audit-driven designs ALIGNED + merged)

- **Trigger:** codex sync-performance audit merged as #209
  (`docs/audits/2026-07-10-sync-performance-audit.md`, 15 findings). Founder
  framing that set priorities: **initial upload is THE conversion moment**
  (first-run experience), and passive-sync propagation matters equally.
- **Six designs drafted in parallel worktrees (opus agents, codex adversarial
  loops to ALIGNED), all merged:**
  - **98 first-publish pipeline** (#210, 6 rounds + 3 joint): encrypt→upload→
    receipt overlap; reservation-based disk backpressure; rolling
    server-satisfied check replaces the missingBlobs barrier; ReceiptDrainer
    redeems during upload. Attacks the 599s / 363s-encrypt first publish.
  - **99 fused crypto worker jobs** (#215, 6 rounds + 3 joint): byte-bounded
    multi-file jobs, in-memory ciphertext under a `CiphertextBudget`,
    ≥30%-encrypt-cut gate. **98↔99 seam reconciled in 3 joint codex rounds
    with both docs visible** — found consumer-spill + abort-bridge holes the
    single-doc loops could not see. Contract: 99 §10 normative
    (`CiphertextLease`, one charging authority, spill producer-only).
  - **100 fresh-join cold apply** (#211, 6 rounds): Git chain prefetch
    (gated on measured fetch stalls), directory-trie apply plan, size-aware
    lanes, base-exclusion model for case-collision entries. Attacks the 84s
    join / 34s Git phase.
  - **101 parallel multipart** (#212, 5 rounds, clean ALIGNED): pooled parts
    under a global byte budget; completion-reread characterized not weakened;
    found two pre-existing R2 orphan gaps (staging + row-less canonical) with
    lifecycle-rule fixes.
  - **103 steady-sync quick wins** (#214, 3 rounds): early stale-parent/epoch
    rejection (server) + change-only blob preflight (client). Found a latent
    bug: 422-recovery drops the unsatisfied SHA list (`sync.ts:464`) — must be
    threaded before any narrowed preflight ships.
  - **102 O(change) commit admission** (#216, 7 rounds, hardest design):
    server-computed parent→child refset delta (streaming two-pointer merge);
    carried-ref safety proven on the `blob_refs` durability invariant;
    off/shadow/enforce rollout with zero-harmful-divergence flip gate;
    fail-closed full-validation fallback.
- **First-ever measured prod commit decomposition** (#213, merged): #207's
  serverTimings were threaded but never rendered — 5-line formatter fix, live
  on the Ubuntu daemon. Zero-file push on ~114k blobs: POST p=7.9–8.6s →
  server 6.8–7.5s, of which **accountingMs 5.8–6.6s (~87%)** — audit Finding 1
  confirmed by direct measurement; design 102's motivation is now empirical.
  Also notable: **idle workspaces pay the full ~20s push cycle** publishing
  zero file changes (git-identity churn suspected — free win if spurious;
  flagged in #214 Q1).
- **Founder decisions recorded in-doc (#217):** 98 orphan entitlements
  ACCEPTED (lazy GC cleanup); 99 ciphertext budget prototype-decided; 100
  unrepresentable-entries indicator SHIPS in `rbox status` + dashboard; 101
  greenlit with synthetic multi-GiB rig validation.
- **Implementation queue (not started):** 103 (smallest, ships first —
  respect its 102-coexistence precondition), 102 shadow mode, 98/99 (Phase-0
  prototypes first per founder decisions), 100, 101. Design-84 C1/C2/D pairs
  with 102 for the ≤3–4s commit target.

- **Late-night additions (post-evening entry):**
  - **#206 GC drain hardening** — crash-robust lease release (3× backoff in
    finally), structured `gc_purge_failed` 500s, `retryAfterMs` on 409,
    paced `drain` mode in gc-drain.ts. Field-proven same hour: a mid-drain
    500 recovered on the next pass instead of a 50-min lease lockout.
  - **#207 design 97 (commit serverTimings)** — numbers-only per-segment
    breakdown (envelope/accounting/sidecar/commit/mirror/response) on every
    commit response + metric; clients nest it in commit phase details. This
    is the data feed for the design-84 commit-POST companion decision.
  - **#208 design 85 P0 instrumentation** — 4-round impl review; per-dir
    probe behind `RBOX_SCAN_PROBE=1`, deep-scan drift audit (settle-
    transaction evidence protocol, quiescence provenance, oldest-wins dedup
    cap 500, fail-soft path-free sidecar), scan-site stats, and
    **RBOX_METRICS default-ON** (opt-out `RBOX_METRICS=0`; measured worst-
    case scan overhead 0.4–3.1%).
  - **Drain end-state:** ALL 5,410 grace-eligible intents stamped (verified
    in D1; lease released clean). Deletes mature from 2026-07-11 ~20:01Z —
    run `bun scripts/gc-drain.ts drain` (secrets: prod-keys.local.secret),
    verify ~5,410 purged + bytes, then flip RBOX_GC_PURGE_DISABLED.
    Remaining ~64k candidates age past 7-day grace through ~07-15.
  - **Fleet soak LIVE:** both daemons on dev build `1.0.0-dev+16fea15`
    (backup at `~/.rbox/bin/rbox-1.0.0.bak` on each host; next release
    supersedes). Collecting P0.1 stats + P0.3 drift + design-97 timings
    passively. NOTE: the Mac's rbox-core checkout sits on old branch
    `Codex/perf-improvement-search` with a modified AGENTS.md (not touched;
    soak build came from a /tmp/rbox-soak-main worktree at origin/main —
    remove when convenient).

## Where we are

- **2026-07-10 evening sprint (5 PRs merged, all via subagent+codex tracks):**
  - **Design 84 v7 ALIGNED** (#201, 6 codex rounds, zero final findings) then
    **Phase A measured** (#204, gate record in doc §6.1): the 39.2MB
    O(workspace) manifest transfer is confirmed, BUT `postMs` (the commit
    POST — server-side full-refset pipeline) dominates at 8.4–8.6s of the
    ~14s commit (56–63%); upload is only ~4s. **C1-alone FAILS its gate;
    commit ≤3–4s targets unreachable without a server-side O(change)
    commit-POST companion design (unwritten; next step = OpSpan decomposition
    of a commit). Phase D (fast pulls, ≤2s) stands; C1 still pays for bytes
    (39.2→~5MB).** Fleet daemons now run `RBOX_METRICS=1` permanently.
  - **Design 85 v3 ALIGNED** (#202, 7 codex rounds; Layer B rebuilt around the
    design-93 mutex, dircache reuse keyed on directory ctime) and its two
    **prerequisite correctness ships MERGED** (#205): torn-scan stability
    predicate (`statsStableAcrossHash`: ino/dev/size/mtime/ctime/mode across
    the hash) + HashCache v2 `(mtime,size,ctime)` with versioned format.
    Deliverable 2 (P0 instrumentation) in flight; founder directive: flip
    RBOX_METRICS default-ON if measured overhead is negligible; all new
    instrumentation output must stay path-free/non-PII.
  - **CLI usability audit landed** (#203): audit doc at
    `docs/audits/2026-07-09-cli-usability-audit.md` + 4 fix batches —
    `restore` now trash-tier-backed (undoable), uninstall keystore warning,
    doctor/connect/recover/sync paper cuts, `friendlyHttpError`, help
    coverage, global unknown-flag detection. Ships to fleet at next `v*`.
    Deferred product calls listed in the final PR body (config-only settings
    CLI surfaces, env-var flag parity, account/pair/connect disambiguation).
- **GC drain (design 95/96) — Phase 1 LIVE in prod, deletes unlock 2026-07-11
  ~20:01Z.** Timeline 07-10: #200 deployed 19:19Z → DO index backfill done
  <40min → first-ever successful Phase 1 mark at the 20:23Z cron (38,313
  entitlement rows) → dry-run audit walked all 504 pages: 70,040 candidates
  (~61.3GB), wouldIntent 5,410 (7-day grace gates the rest; they age in
  through ~07-15), wouldDelete 0 → **1,400 delete intents stamped** via
  supervised `gc-drain.ts execute` passes. **Known bug found: an execute
  invocation that 500s (likely D1/subrequest exhaustion under rapid passes)
  opens its 200 intents but orphans its lease → 20min TTL + 30min takeover
  quiescence ≈ 50min lockout; recurs every few invocations.** Runbook
  2026-07-11: `wrangler tail` from the Mac during one execute to capture the
  exception → fix (incl. crash-robust lease release) → verify the 1,400
  delete after quiescence → stamp the rest → THEN flip
  `RBOX_GC_PURGE_DISABLED` for the daily cron. Secrets:
  `prod-keys.local.secret` at repo root (rbox-synced to both hosts) has
  `RBOX_PLATFORM_SECRET`; usage string in the script header. Pace executes
  ≥60s apart.

- **Version: v1.0.0 — the correctness milestone (2026-07-10).** No functional
  change over 0.9.18; the tag marks designs 91/92/93 field-proven. Release run
  went green first try (6m41s, no gate flake). Live on Mac + FM daemons.
  ~~Open: via-desktop-ubuntu daemon DOWN post-upgrade~~ **RESOLVED same day**:
  its credential was the agent PAT (`agent_7Z8R70…`) revoked in the 07-09
  roster cleanup (old daemon survived on a pre-revocation session). Re-enrolled
  via headless pairing — `rbox pair` on the Mac → `RBOX_PAIR_TOKEN=… rbox login`
  on Ubuntu (env-var redemption, `src/cli/auth-cmd.ts:184`) — now device
  `dev_fdca6ca3…`, daemon healthy on 1.0.0. Roster note: the host's previous
  device entry (`dev_df5d3b6c…`) is now orphaned; revoke at next cleanup.
- **CHANGELOG.md is now the full record** — backfilled v0.1.0 (2026-06-29)
  → v1.0.0, all 51 tags, first commit 2026-06-26. Keep it current per release.
- **Design 35 (client phase metrics) doc header was stale — it SHIPPED** in
  v0.4.3 (#17) + designs 83–85 phase-0 (#161/#165): `src/engine/phase-report.ts`,
  `src/cli/metrics.ts`. The measurement gate for designs 84/85 is already met.
- **Steady-state sync latency, measured end-to-end 2026-07-10:** a 103-byte
  file took ~42s Linux→Mac (24.6s write→publish + 17.1s publish→applied, WS
  connected the whole time — no fallback path involved; both legs are
  O(workspace) machinery). Design 84 (manifest delta encoding) is the marquee
  lever, targeting the 13–17.5s commit envelope + 2.2–7s pull `latest`;
  design 85 (scan) and 39/74 (pull apply) follow. Deliberately deferred past
  1.0 — perf is the 1.1 track.

- **Migration numbering hardened (#196, 2026-07-10):** the duplicate-number
  pairs (0014×2, 0016×2) are verified applied in prod + dev in lexicographic
  order — frozen forever (wrangler tracks by filename; never rename). New
  collisions now fail the test suite at config time; rules in
  `apps/api/migrations/README.md` + root CLAUDE.md pointer.
- **Host-env notes (via-desktop-ubuntu, 2026-07-10):** `GITHUB_TOKEN` in
  `~/.profile` was stale (shadowed valid gh keyring auth) — replaced with the
  keyring token. `node_modules` installed for the first time (was binary-only).
- **Version: v0.9.17** (live fleet-wide 2026-07-09: Mac + FM daemons in sync; via-desktop-ubuntu binary-only). First release run failed on a flaky retry-exhaustion test (#188 fixed: explicit 30s timeout; jittered 5-attempt backoff can exceed bun’s 5s default) — tag was moved to the fixed head. Fleet = Mac (`dev_932d7c…`, primary
  work machine) + flat-meadow/FM (`dev_de63e89a…`). Real workspace
  `ws_2b6e15da…` ≈ 128.5k files on `~/Development`.
- **The 2026-07-09 poisoned-manifest incident class is dead** (design 92,
  PR #184, v0.9.16): push verify-defer (`RBOX_SOURCE_CHANGED`), size-sensitive
  push equality (self-heals poisoned sizes), fail-closed carry, and
  stage-verify-before-displace on pull. Field-gated including a real reproduced
  poison. A heavier quarantine design was deliberately shelved at doc commit
  `5cee557` behind an evidence gate: build it ONLY if an unhealed poisoned head
  ever occurs in the field.
- **Download self-heal shipped** (PR #187, v0.9.17): transport-corrupt blob
  downloads (the Bun large-blob fault) now re-fetch up to 4× instead of
  aborting the join. Merge evidence: `GATE_EVIDENCE.md` on the PR /
  `bun run gate:dl-integrity` (main-equivalent aborts; fix heals 42/42
  injections across a 10k-file join; persistent corruption still fails loudly).
- **Menu bar app (RboxBar)** lives at `macos/RboxBar`, installed at
  `/Applications/RboxBar.app`, login item set, SwiftBar shim retired
  (preserved at `~/.rbox/swiftbar-disabled/`). v0.9.17 dropdown: severity-tiered
  states (degraded = dim line, critical = card + remedy), files-count primary,
  version footer + update-available row. Rebuild/install:
  `macos/RboxBar/scripts/bundle.sh` then copy to /Applications.
- **CLI hygiene** (PR #186, v0.9.17): `track --name` forwarded; `track` reuses
  the logged-in device identity (junk-roster root cause fixed); loud
  `⚠ RBOX_API override` stderr warning (`RBOX_API_QUIET=1` to silence).
- **Device roster is clean** (2026-07-09): junk stress-join device revoked via
  `rbox device revoke`; agents were already revoked; only Mac + FM + ephemeral
  web sessions remain. Note: auth revoke is access-only — cryptographic key
  eviction needs epoch rotation (design 22 §1.3, unbuilt).

- **Version: v0.9.18** (live fleet-wide 2026-07-10: Mac + FM daemons + Ubuntu
  binary). Ships design 93 (#192) + field-driven hardening: bounds 64→512
  keys (#193), reader-side config invalidity IGNORED never pull-fatal +
  bounds-in-fingerprint cache invalidation (#194), crypto-pool test
  isolation (#195, ledger item closed). Release-gate flake pattern repeated
  (tag moved to fixed head, same as v0.9.17).
- **savvy-core needs-resolution conflict: RESOLVED 2026-07-10 midday.**
  Root cause: overnight pulls deferred while BrianVia/arch-raw-error-records
  (PR #756, merged) was checked out in a linked worktree; the residual
  divergence had decayed to ONE missing deploy tag. Fix: tag-aligned local
  to head, removed the stale worktree + branch (local + GitHub). Marker
  cleared on the next cycle; savvy-core's config (74 keys) is at head —
  the lane's hold-then-self-heal behavior worked exactly as designed.
- **RboxBar** rebuilt from main and relaunched on the Mac: carries #190
  (workspace size display, from a parallel session) + #185 (dropdown UX).
  Reminder: the bar app ships by local rebuild (`macos/RboxBar/scripts/
  bundle.sh` → copy to /Applications), NOT via the CLI release.
- **Design 93 (git config sync) — SHIPPED v0.9.18.** The
  2026-07-10 deal-breaker (rbox-materialized repos have no remotes/tracking;
  ~90/host found on Ubuntu, 179 hand-healed) is closed permanently:
  allowlisted `remote.*`/`branch.*` keys travel in the encrypted git
  section, fill-only apply, self-healing presence rule. 11 adversarial
  design rounds (REVIEW-93.md in the d93 worktree); new infra: reusable
  lockfile primitive, transactional per-repo state CAS, workspace sync
  mutex (also retires the pre-existing daemon-vs-CLI sync race). Live rig
  gate PASS (materialize/heal/propagate/zero-echo; runs/20260710-071943).
  Post-merge, pre-release: GATES.md Lane 2 — RC scratch-join on
  via-desktop-ubuntu incl. a real-GitHub probe repo — then fleet upgrade.
  Rig now grants dev plans (design-86 fix) + validates container mounts.

## Recent history (compressed)

- v0.9.9–0.9.10 (07-08): perf designs 79–82 — compression, batch upload,
  worker-pool crypto, steady-state O(N²) kill. Publish 27.5→10min, Mac push
  204→54s.
- v0.9.14: design 91 head authority (push requires verified head).
- v0.9.15: watcher-degraded self-clear (generation-counted) + RboxBar native
  app + resource-bundle fix.
- v0.9.16: design 92 (above).
- Incidents 2026-07-09: two fleet write-deadlocks from one poisoned manifest
  entry (120MB then 5.3GB `p9-mirror-exec.log`). Full forensics in the design
  92 doc + `docs/design/*` lessons. **Brian: your live Dfinitiv migration log
  was moved to `~/p9-mirror-exec.log` on the Mac (writer fds survived the
  rename; still being written).** `~/Development/.rboxignore` now excludes
  `Dfinitiv/savvy-core/migration-state/*.log`.

- **Repo hygiene (2026-07-09):** 40 stale worktrees removed (43→2 + primary), 65
  shipped local branches deleted, remotes pruned. Dirty work was preserved on
  branches first: `heal-hotfix-poison-skip` (emergency skip patch, committed),
  `feat/dev-install` (unshipped feature), `web-dashboard-rebuild`,
  `release-v0.9.8`, `feat/front-door`. ~81 local branches remain
  (squash-shipped-but-unverified; optional deeper pass).

## Active: storage-quota & GC program (opened 2026-07-10, founder decisions locked)

Plan from the 2026-07-10 deep-dive (three subagent reports + live prod numbers:
145.4 GiB blobs stored vs 83.1 GiB referenced, ~62 GiB dead, 70k condemned
candidates never purged). **Founder decisions (2026-07-10):**

1. **Purge automation: REVERSES the design-33 standing decision** ("Phase 2
   stays off the cron", `worker.ts:106-110`). Approach = cron with narrowing
   gates per design 33 §3.3 — receipts-path candidate-aware validate (the
   real hole), R2 object-age gate re-read at delete, days-long grace —
   accepting the residual milliseconds-wide TOCTOU. The DO delete-barrier was
   considered and rejected (hot-path tax + new availability surface for a
   ~zero-probability, self-healing event).
2. **Cadence: daily purge, 7-day grace.**
3. **IA tiering: GO, history blobs >30d old** — explicit CopyObject class
   flips from the reachability job (R2 lifecycle rules are prefix-only and
   can't see reachability); never tier blobs due for retention-prune within
   30d (IA minimum billing). Verified 2026-07-10: IA $0.01 vs $0.015/GB-mo,
   retrieval synchronous, $0.01/GB fee.
4. **Design 89 params confirmed as drafted**: quota = live bytes, K=4
   stuffing bound (thin-don't-block), retention solo 30d / pro 365d / team
   90d, Team pooled-storage question deferred until Team ships.

Sequencing: design 95 (purge automation) → design 89 implementation (live
ledger + quota flip + surfaces) → IA tiering rider. Phase-0 copy fix (§7,
90→365) verified ALREADY LANDED (README/pricing.md/plans.ts all 365).
Design 89 §6 named ~07-15 as the purge review date — resolved early, above.

- **INCIDENT 2026-07-10 (afternoon): WorkspaceSync DO OOM on `/roots` —
  CONTAINED (#198, merged → prod).** Root cause: `/roots` materializes every
  retained sequence's full refset (~102k refs × 1,070 seqs ≈ 6.85 GiB JSON)
  in a 128MiB DO — deterministic OOM ~8-14 seqs in, every hourly GC tick;
  fleet WS connects died in the same isolate resets (this was the morning's
  WS-churn mystery). Design 24 predicted this and prescribed a never-built
  bound. Containment: fail-closed 503 `roots_too_large` (64 seqs / 500k refs
  caps) — GC stays unavailable-but-safe for the big workspace; WS stability
  restored. Full diagnosis: session scratchpad roots-oom-diagnosis.md.
  **Follow-ups (blocking the manual GC run + design 95): paginated
  snapshot-bounded `/roots` (fast functional fix), then a durable
  retained-root index (steady-state; replaying every retained commit is the
  wrong algorithm for 365d history).**
- **Design 94 (signin_method): SHIPPED** — ALIGNED after 7 codex rounds,
  implemented, merged (#197); prod migration 0023 auto-applied, dev applied.
  Founder row backfills on next dashboard login.
- **Design 95 (GC purge automation): MERGED (#199, 2026-07-10 evening),
  SHIPS DISABLED** (`RBOX_GC_PURGE_DISABLED=1` both env blocks; migration
  0024 auto-applied to prod incl. the fence triggers — those + validation
  steering are ACTIVE and wanted). 10 adversarial rounds; REVIEW-95.md is
  the ledger. Protocol: RAISE-ABORT publication fence + checkTime-anchored
  receipt authority (12h TTL < 24h intent quiescence — no authority spans
  a delete) + two-phase delete w/ verify-after-delete + lease-guarded
  fence drops. 371 API tests incl. the full race matrix;
  `scripts/gc-drain.ts` is the supervised drain tool.
- **Design 96: MERGED (#200, 2026-07-10 night)** — implemented same
  session (409 API tests first-run green incl. the index-vs-brute-force
  property test), post-merge CI green on main. Prod backfill starts via
  DO alarms once Workers Builds deploys (~1,241 seqs on the primary
  workspace, ~25 MiB/fold, 5× under FOLD_MAX_REFS). The §6.2 250k-scale
  rig gate is DEFERRED until any commit-admission cap change (field max
  102k). **REMAINING ROLLOUT (founder-supervised): watch index_state →
  ready (503 index_building until then; GC Phase 1 starts completing) →
  dry-run audit (expect ≈62 GiB / ≈70k) → scripts/gc-drain.ts → flip
  RBOX_GC_PURGE_DISABLED → design 89.** Then: designs 84/85 revision
  loops (founder-confirmed next after 96's merge; round-1 ledgers on
  their branches). Prod facts checked tonight: exactly ONE workspace row
  (ws_2b6e15da/root, 1,241 commits) — the founder IS the whale; the
  lingering old-workspace data is the unreferenced-blob layer (the drain
  target), not workspace rows.

- **Designs 84 + 85 staleness reviews (2026-07-10 evening): both REVISE,
  materially stale vs current main** (branches `design/84-review` /
  `design/85-review`, REVIEW-84/85.md). Design 84's headline: its recovery
  story is IMPOSSIBLE post-design-91 (head authority rejects the
  fresh-snapshot escape; a broken delta chain wedges every writer), its GC
  chain-rooting invariant is unenforceable as written, and its Phase-0
  plan describes building instrumentation that already shipped. Design
  85's headline: design 93's workspace mutex materially changes Layer B's
  daemon-delegation shape, and Layer A must not start before the P0
  measurements. **Both need full revision loops (fresh session — they are
  design-94/95-scale efforts) before the 1.1 perf track implements.**
- **D1 scaling posture (discussed 2026-07-10):** ship design 32's
  `dbFor(accountId)` seam at N=1 EARLY (behavior-preserving refactor,
  founder decision gating: split vs placement-constraint), define shard
  tripwires (D1 >2-3GB, recurring hot-path 429s, cron budget alarms),
  keep design 57 (PlanetScale) break-glass for >10TiB whale accounts.
  Ratio: metadata ≈ 1MB per GiB content ⇒ one D1 ≈ 10TiB content.
- **codex fast mode enabled on via-desktop-ubuntu** (`service_tier="fast"`
  + `[features].fast_mode`, ~2.5× credit rate; smoke-tested on
  gpt-5.6-sol).

## Backlog (ledgered, not urgent)

- Stripe annual prices for design 86 (paid-only + trial + annual, PR #159);
  design 87 agent keys (PR #160); GA4 ID blocks the A/B test — **needs Brian**.
- 5.2GB orphaned R2 blob from incident #2 (GC/retention will handle or manual
  sweep); junk `keepLocalAs` conflict copies (106-byte marker) on both hosts —
  harmless.
- Perf next poles (design 82 follow-ups): git-plan/subprocess floor,
  commit-envelope delta encoding, scan; then git cold lane, per-job crypto.
- Bun 1.3.14 release-runtime A/B; crypto-pool test isolation.
- Epoch rotation / true key eviction (design 22) — unbuilt, known ceiling.
- Surface the web login's auth provider (Google OAuth vs password) in
  `rbox account status` + dashboard: capture `external_accounts` from the
  Clerk user fetch (`apps/api/src/notify.ts:269` already makes the call) into
  `clerk_users`, return it from account status. Today D1 stores only the
  email; auth method is invisible outside the Clerk dashboard. Fleet account
  is `brian.via.dev@gmail.com` (`acct_b4e0b81…`) — the ONLY prod web account;
  a browser session on any other identity would silently create a fresh one.

## Standing rules (hard-won)

- Agents: always work in `.claude/worktrees/<slug>` off main, never the primary
  checkout; rebase before merging (design-number collisions happen).
- Prod D1/R2 mutations: always account-scoped, never blind — coworker
  onboarding is coming; versions must be non-breaking (read-before-write
  rollouts).
- Release flow: bump `package.json` + `CHECKED_IN_RBOX_VERSION`
  (`src/cli/version.ts`), commit `release: vX.Y.Z — …` on main, tag `v*` →
  release.yml → R2. Fleet upgrade: `curl -fsSL https://rbox.to/install.sh | sh`
  + `rbox stop && rbox start`. API deploys only on merges touching `apps/api/`.
- Poison-at-head emergency playbook: needs a skip-capable binary on ONE device
  (`RBOX_SKIP_POISONED=1` pattern, branch `heal-hotfix-poison-skip`); a
  forward-only `.rboxignore` FREEZES poison at head — delete-first, then ignore.
- Fresh-join stress loops are the highest-yield test lane (3 P0 finds in 2
  days). Poison repros must use compressible data (the size cap only fires in
  the zstd counter).
