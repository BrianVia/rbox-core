# rbox status — living state snapshot

## 2026-09-18 — CI unblocked: Cloudflare runner pilot ENDED (public repo), shards on Namespace

- **Root cause of every red PR since ~09-16:** `biw/cloudflare-github-actions-runner` runs
  jobs for PRIVATE repositories only and `BrianVia/rbox-core` is now PUBLIC. The App posted a
  failed "Cloudflare runner eligibility" check (not a ci.yml job) and cancelled all 9
  `cloudflare-ubuntu-latest` jobs. This is NOT the old FLAKE-012 (30s runner-assignment
  window / HTTP 401), which is now moot along with the runner wizard — unless the repo goes
  private again. **#918 MERGED (`83854bf3e`)**: the test matrix runs on
  `nscloud-ubuntu-24.04-amd64-4x8` like every other Linux job; node20 shim dropped, the
  self-guarding git 2.55 user-space shim stays.
- **Found on the way (`4e1d98a92`):** design 166's adoption mount-point guard compared
  each child's `st_dev` to the root's. On overlayfs (Namespace rootfs `overlay …
  uuid=on`, any Docker container) a regular file reports a different `st_dev` than its
  own parent directory (probe: dir dev=32, file dev=33) with no mount between them, so the
  guard refused every fixture and would refuse a real `rbox adopt` inside a container.
  Fix: `/proc/self/mountinfo` is the authority when readable; `st_dev` stays as the
  fallback only. Adopt + binding-matrix tests green; shards 2/4 green on Namespace.
- **Still red on EVERY PR and on main, founder-only:** `compiled TUI · onboarding rig` and
  `ux · regress flows` need the repo secrets `RBOX_DEV_BOOTSTRAP` and
  `RBOX_DEV_PLATFORM_SECRET` (GitHub → Settings → Secrets; values in
  `dev-keys.local.secret`). Branch protection reports UNSTABLE but allows merge.
- Bot PRs #915/#916/#917 were updated from main (`gh pr update-branch`) so their CI
  reruns on Namespace. Notion task tracking: MCP disconnected this session — this work is
  NOT recorded in Notion.

## 2026-09-05 (afternoon) — #882 MERGED; roadmap 287 execution continues

- **2026-09-18 Night Shift — #879 PR open (`fix/879-journal-validation-caps`,
  not merged):** root cause was the checkout-journal validator's 256-entry
  caps on prepared-transaction locks / reserved refs (one lock per branch +
  two keep refs per witnessed branch) — the take-theirs writer produced a
  journal its own reader refused as "unreadable or corrupt". Caps → 16,384;
  deferral names the failing validator + sizes + journal dir; an
  unparseable/schema-invalid journal for a repo with no readable `.git`
  now retires to `git-journal-quarantine` (the manual fix that worked on FM)
  instead of blocking re-adoption forever. Not addressed: holding the daemon
  off during a CLI resolve (no evidence a restart was the trigger).
- **#882 MERGED (rebase, commits preserved)** onto main at `bc1e618bd`: deletion
  batching `39b7b5cec`, staged-object closure `f91a13f82`, portable private
  indexes `20b705009`, tracked-index cache freshness `3d2cbd1d0`, roadmap docs
  `ab7a55112`, Bun-1.4.2 fixture repair `f2b83aaee` (design 292), handoff
  `876b0e8cd`, Claude 292 review record `bc1e618bd`. Design 292 was reviewed
  directly in-repo by Claude (`docs/design/notes/292/review1-claude.md`): the
  helper wraps the existing `PushSpans.run` owner, one owner per test, no
  production change; 93/1/0 locally, exact-head CI fully green. The P/K cap
  timeout stays "suspected environmental" (one occurrence, later head green).
- **Fleet:** still on 2.0.2 (Mac) / `2.0.2-dev+e3881c3` (desktop, FM). The
  four #882 fixes are NOT yet in any fleet binary. No production promotion, no
  CLI release. Next release candidate = 2.0.3 (carries #880, #881, #882).
- **Roadmap 287 wave landed (evening):** #886 S3a fold live iterator
  (design 297, `15b448a75`); #884 G5a+G5b batched no-drop ancestry (design
  293; 68→4 spawns @30 tips, 1008→4 @500; a preceding refactor moved the
  content-equivalence probe to `sync-git/content-equivalence.ts` to stay
  under the 400-line module gate); #885 G2 NUL-safe worktree parsing (design
  295, `worktree list --porcelain -z`). #883 S1a maintenance re-arm (design 294,
  rebased over S3a) and #887 G3a SHA-256 admission + fingerprint schema 9→10
  (design 296) also MERGED. Every one of the five hit FLAKE-012 runner
  assignment at least once (5 parallel PRs starve the CF runner pool; rerun
  with `gh run rerun <id> --failed`; #883 needed four reruns). DEV API
  auto-deployed and answers `/version`.
- **Second wave MERGED (evening):** #888 G4a Git env allowlist (design 299,
  `cb37aabd3`), #889 B0b push-cost attribution lines `git-plan slowest:` /
  `state-save slow:` (design 298, `6cb988cba`), #890 S2a optional
  `plane_entries_entry` index (design 300, `d23c49558`; 200k/3k orphan
  collector >180s → ~65ms). Zero open PRs. All worktrees removed.
- **#891 MERGED (design 301, `ddc93f299`):** the attribution lines showed
  `state-save slow: apply=2.4s` for ANY packet (even 3 repo transitions, no
  global) — `translateCasResult` re-materialized all 198K entries after every
  accepted save. Fix: reuse only the untouched base file rows when the packet
  has no global section AND the CAS token is exactly one revision past the
  snapshot's; records/meta/git projections still read back (a whole-state
  projection was tried and withdrawn: `applyTransitions` recomposes bases).
  Copied-store profile 2.4s → 83ms — but on the desktop the guard refused
  (a push snapshot is usually one revision behind a pull), so **#892 MERGED
  (design 302, `7f867192e`)** re-homed the reuse in the design-277 memo,
  keyed by the store's own `active_base_generation` (only a global section
  advances it); `loadRawState` stays fresh so the 269 drift audit still sees
  corruption (that test caught an earlier draft). **Desktop now dogfoods
  `2.0.2-dev+7f86719`**: first empty push 9.0s → 7.0s, `state-save 0.1s`.
  Then **#893 MERGED (design 303, `a9b4909a9`)**: the elision audit's ~1s
  manifest rehash on every unchanged pull is memoized per files array (302
  hands the array back by identity; 277's immutability precondition makes
  identity = content). **#894 MERGED (design 304, `6a6dbfedc`)**: the
  `git-plan slowest:` line now ends with `stages start= pool= carried=
  discover=` to name the ~1.6s of capture wall not attributable to repos.
  **Desktop now dogfoods `2.0.2-dev+6a6dbfe`** (pid 1540523, ~20:05Z; the
  previous daemon did not stop in 60s and was SIGKILLed with no live
  critical-section witness — one-off during the post-restart safety scan,
  watch for recurrence). FM stays on `2.0.2-dev+e3881c3` (shadow), Mac on
  stable 2.0.2. **#895 MERGED (304b, `54bc690d0`)** fixed the unapplied
  print; desktop now on `2.0.2-dev+54bc690` (pid 1697393). First staged line:
  `Personal/rbox-core fp=miss cp=359 d=43 | stages start=1 pool=846
  carried=1963 discover=1000` on a 6.3s empty push (git-plan 3.7s,
  projection 0.7s, drain_wait 1.5s, state-save 0.1s). Root cause of
  `carried=1963`: `repoCtxFromDisk` spawns two `git rev-parse` per carried
  repo (≈250 spawns/push) plus `repoRecordsForState` recomputed per repo.
  **#897 MERGED (design 306, `fa5c507a8`)**: fingerprint-hit carries reuse
  the fingerprint probe's `diskCtx`, record fold hoisted, packed-refs stat
  KEPT (fingerprint token is content-based, baseline is mtime-based —
  skipping would weaken the regression refusal). **#896 MERGED (design 305,
  `ba2d22e12`)**: scratch pins in one `update-ref -z --stdin` `create`
  transaction (third owned raw site in the design-130 allowlist).
  Desktop on fa5c507 measured `carried=1963 → 1433` only: the slow classify
  path (config lane) still re-read contexts, so **#898 MERGED (306b,
  `c61f1aa59`)** threads the identity probe's `diskCtx` through the carry
  command. **Desktop now dogfoods `2.0.2-dev+c61f1aa`** (pid 1968148,
  ~21:15Z). **Design 307 written and ALIGNED (3 rounds)** on branch
  `docs/307-plan-topology-design` (`.claude/worktrees/design-307`): plan
  discovery from a continuity-owned plan-topology certificate with three
  invalidation hooks (pre-debounce candidate, raw rule/dir events, pull
  adoption); **#900 MERGED (design 307, `60dfaa713`)**: plan discovery reuses the
  daemon's certified topology (design + fault sink + certificate/hooks/
  wiring; three aligned rounds). Desktop on
  c61f1aa (306b) still read `carried≈1400ms`, so the loop's cost is NOT
  context reads; **#899 MERGED (304c, `f8a05b59d`)** adds `[ctx= packed=
  repos= freshCtx=]` sub-timers to the stages suffix. **#901 MERGED
  (`d08f73d37`)**: the P/K capacity test gets an explicit 60s budget after
  three CI failures at Bun's 15s default (0.7s locally, ~15s on the
  runner). **ROOT CAUSE of `carried≈1.4s` found (design 304c split:
  `carried=1412[ctx=0 packed=3 repos=125 freshCtx=4]`, confirmed in a quiet
  foreground push + CPU profile):** it was never the loop. `Personal/rbox-core`
  had 285 local branches purged this morning; every push captures it (edited
  constantly → fingerprint miss), runs the branch-deletion witness, and is
  refused on the first missing branch (`origin-mismatch+artifacts-standing`)
  — 456 times today — after paying ~1.5s of `for-each-ref` in
  `prepareFollowerBranchProtocol`. **#902 MERGED (design 308, `0a3d4565a`)**: decide the
  cheap per-branch refusals (scope, recorded origin) BEFORE the artifact
  scan — same verdict, ~0 cost; the witness now lives in
  `sync-git/branch-deletion-witness.ts` (plan.ts back under its ratchet).
  **307 PROVEN on the desktop:** after the watcher regained trust (~15 min
  post-restart, `pull local=trusted`), the next push read `discover=0`;
  empty push 6.3s → 5.4s (git-plan 3.6 → 2.7s). **Product finding for the founder:** that
  repo's BASE has 286 heads but only 9 recorded origins (pre-274 records),
  so the 285 deletions cannot be proven from this device and stay deferred
  ("finishing a branch deletion on checkout unavailable"); finishing them
  needed a product decision — **founder (2026-09-05 22:20Z): "let this
  device's capture count as delete"** → **#903 MERGED (design 309, `793171674`)**: an
  origin-less branch is deletable when the BASE section's design-274 author
  stamp is this device (the branch existed here at capture); foreign or
  unstamped sections still refuse. `rbox git resolve` has no verb for
  outgoing deferrals (noted as a gap). **Desktop now dogfoods
  `2.0.2-dev+7931716`** (pid 2406373, ~22:40Z); **Result:** the origin refusal is gone;
  the witness now refuses the same branch for `artifacts-standing`: this
  repo holds **206 standing CREATE-P receipts** (`refs/rbox-local/base-
  present/v2`, `priorOid:null`) = branches a peer created that this desktop
  never landed (design 286 manual-landing receipts), and I deleted the local
  namesakes this morning. That refusal is CORRECT (deleting my copy must not
  delete the peer's branch). Gaps: (1) `rbox git resolve` does not surface
  standing CREATE-P receipts ("no deferred incoming Git state"), so the user
  cannot land (take-theirs) or discard them; (2) with 309 the witness now
  pays the full artifact scan every push again (`carried≈1.4s`), so
  **#904 MERGED (design 311, `d234b58f3`)** remembers an
  `(artifacts-standing)` refusal per repo under a token of the
  `refs/rbox-local` plane + missing set and skips the scan while it is
  unchanged. **Desktop now dogfoods `2.0.2-dev+d234b58`** (pid 2478074,
  ~23:07Z); **PROVEN:** three pushes on the new daemon read
  `carried=19/12/13ms` (was ~1,400); `discover` stays ~950 until the watcher
  is trusted (~8–15 min post-restart), then 0 as measured earlier. Empty
  push now 5.2s = drain_wait 1.5–1.9s (watcher debounce, by design) +
  git-plan 2.3s (pool ≈0.86s: rbox-core recaptured each tick while edited
  + ~0.5s unattributed in the pool; discover ≈0.95 pre-trust / 0 trusted)
  + projection 0.6–0.9s + git-plan tail 0.6–0.9s. Day total: 9.0s → ~4s
  steady-state once trusted (vs 6.2s at the start of this evening). **CI runner degradation (evening):** every
  PR today hit FLAKE-012 at least once; #904's shard 2/6 failed three reruns
  in a row, twice with a new variant `The Worker returned HTTP 401 while
  waiting for GitHub's runner assignment`. Founder owes the runner wizard
  (`npx -y cloudflare-github-actions-runner@latest`). **Riddle answered with data (2026-09-06):** all 206
  receipts point at exactly the commit this device's own BASE records for
  that branch (206/206 same OID, 0 origins) — completed landings that were
  never settled because settlement needs the origin legacy landings never
  wrote. One bug, two symptoms; no verb. Founder: "go for it" → **#905 MERGED
  (design 310, `e24ef9235`)**: under 309's self-authored evidence, a CREATE-P
  (`priorOid === null`, per GPT review) whose `nextOid` equals the BASE OID is
  a completed landing — it stops counting as standing and its P/K refs
  retire inside the deletion's own atomic verification transaction.
  Mismatched/UPDATE-P/foreign/unstamped still refuse. **Desktop now dogfoods
  `2.0.2-dev+e24ef92`** (pid 2871833, ~00:10Z 09-06); **Overnight result: NOT retired** — the push at
  09-06 11:09Z still refuses `(artifacts-standing)`, 206 P/K remain. Cause
  (measured): the receipts carry lineageHash `67cf0a50…` while the current
  workspace lineage is `1e122d11…` (same repositoryIdentityHash `8a68bacf…`,
  i.e. same physical repo, different state nonce → a state reset/regenesis
  happened between). The artifact scan therefore classifies them as
  `active-foreign` (valid, not owning) — the design-273/286 guard for two
  workspaces sharing one repo dir — and 310 only settles OWNING receipts.
  No prior lineage is retained anywhere (single `state_lineage` row, no
  reset archives, `state.json` is the authority marker), so founder "Yes
  go" → **#906 MERGED (design 312, `a9baae0a4`)**: same-repository (identity hash) foreign
  CREATE-P receipts at the BASE OID settle like owning ones under 309's
  evidence — safe because a minting workspace's later settlement of an
  absent P is a defined no-op (`p-settlement.ts` → `absent`). Three GPT
  review rounds (`docs/design/notes/312/`): P-repair Q guard; a host
  claim guard that reads daemon rows + binding registry + folder catalog
  STRICTLY and fails closed (unavailable source, damaged catalog, relative
  root, key ≠ `workspaceKey(root)`, any non-ENOENT `realpath` failure).
  **PROVEN on the desktop (2026-09-06):** first push after restart retired
  all 206 CREATE-P receipts (206 → 139 → 0 in two pushes); the
  "finishing a branch deletion on checkout unavailable" deferral is gone
  from the logs; `refs/rbox-local/base-present/v2` is empty. Empty push
  on the desktop is now 4.1s. Then the other
  devices (Mac, FM) delete those branches on their next pull of a build
  that carries 309 — they are on older builds, so expect that only after a
  release or a dev-build rollout. Codex stalled at startup twice today (rmcp
  AuthRequired on the Cloudflare MCP); part 1 was done by hand. Remaining
  after 307: `discover=1000` (F3b topology reuse), `pool=846` (rbox-core
  captured every tick because I edit it; ~0.5s unattributed in the pool),
  `projection=0.7s` per push with zero changes (F2b/X1a), `drain_wait
  1.5s` (watcher debounce, by design).
- **#907 MERGED (design 313, `ef501bcad`) — change-proportional state saves:** every push
  that carried a real change paid a FULL 198K-row base-plane read-back after the CAS
  (`state-save slow: apply=2400–3400 repos=258 global=delta ops=1..12`) because design 302
  offered the memo's rows only for global-free packets. `memoizedDeltaFiles` now derives the
  post-delta rows from the memo's retained predecessor plus the sealed, store-normalized
  delta ops (same token discipline and kill switch as 302; three GPT review rounds under
  `docs/design/notes/313/`; caveats that are 302-equivalent are recorded, not widened).
  Copied store: 1-op delta apply 2382 → 187ms; real push shape 2779 → 336ms. **Desktop
  proven (`2.0.2-dev+ef501bc`, pid 3142943):** first changed push after restart logged
  `compose=62 apply=480 repos=258 global=delta ops=12` (was 2.7–3.4s). Remaining in that
  line: the 258 repo transitions (~0.3s) — every push observes every carried repo and
  writes its record even when unchanged, because only a pull receipt can elide a
  transition (267 §3.3); candidate next slice, needs a design.
- **Design 314 WITHDRAWN (#908, `e46ced0da`):** letting the elision audit accept the push's
  #816 base-hash attestation would have removed design 269's only drift detector (the
  attestation proves entry COUNT, not content). The ~0.85s first audit per new array stays;
  the doc is kept so the idea is not retried.
- **CI runner flake escalated (2026-09-06 afternoon):** EVERY run hit "The Worker returned
  HTTP 401 while waiting for GitHub's runner assignment" / "runner assignment was not
  observed within 30 seconds" on 1–4 shards; each PR needed 2–3 `gh run rerun --failed`
  cycles (a Monitor loop that reruns flake-only failures up to 3× worked). Founder still
  owes the runner wizard (`npx -y cloudflare-github-actions-runner@latest`). Main's run
  for the #906 merge was cancelled by the next main push; the run for `e46ced0da` is the
  one to watch.
- **#909 MERGED (design 315, `c56ee2c05`):** the #816 base-hash attestation was keyed by
  the accepted state OBJECT; every pull's elided save returns a shallow-copied wrapper, so
  every changed push paid `delta_base≈1.4s` (validate + canonical hash of 198K entries).
  Now keyed by the `lastSyncedManifest` + `manifestMeta` object identities (GPT round 1
  blocker: gitRepos is a hashed input, so the meta object must be part of the key).
  It still missed on the desktop, so **#910 (313b, `c690ed094`)** added `attest=<hit|miss>/
  <outcome>` to the push line and made a zero-op delta save hand back the retained files
  array by identity (a git-only push saves `global=delta ops=0`; the copy broke every
  identity-keyed memo — design 303's audit hash re-ran on every elided pull, compose≈950ms).
  `attest=miss/attested` on every push then showed the real culprit: an elided save's
  projection rebuilds BOTH the manifest wrapper and the meta object; only the files array
  survives. **#911 (315b, `984f5aa09`)** keys the attestation by the files array and
  compares the other hashed inputs (generatedAt, manifestSchema, hashes, canonical
  meta.gitRepos) by value. **PROVEN on the desktop (`2.0.2-dev+984f5aa`, pid 3615665):**
  ordinary changed pushes log `delta_base=0.0s attest=hit/attested`; wall 23s → 14.6–16.8s.
  The 303 audit memo now holds too (no `compose≈950` after the first elided save).
- **#912 MERGED (design 317, F6a, `faff65c53`):** finalize on a changed push (`fn≈2850–3200`)
  was the SEQUENTIAL upload of a capture's artifacts (bundle, index, one per op-state file
  per worktree), each waiting its own pack-fill window alone. They now flush through
  `engine/pool.ts` `poolMap` with bound `PACK_MIN_ACTIVATION_COUNT` (16, one owner in
  `engine/blob-pack.ts`), deduped by encSha, first failure latched so in-flight siblings
  drain before the plan's retained-ciphertext sweep (two GPT rounds, `notes/317/`; the
  design-226 tests now assert retry budget + fail-closed PER artifact). **Desktop
  (`2.0.2-dev+faff65c`, pid 3922384):** `fn1013` (1-blob) and `fn1942` (7-blob) on the
  first two changed pushes; git-plan 5.2–5.5s → 2.2–4.8s. A 1/2/4/8/16 sweep is the
  follow-up if `fn` stays above one fill window + one PUT.
- **Projection 0.7s on EVERY push (incl. empty) — analysed, blocked on F3b:** `projection_
  ignore_carry 0.1 + casefold 0.2 + sort 0.1 + diff 0.3` = `projectLocalManifest` +
  `diffManifests`, pure functions of (local files array, base files array, matcher,
  purgeIgnored). The local array is identity-stable between watch batches, the base array
  is (277/313b), but `matcherForState` → `buildIgnoreMatcher` builds a NEW matcher every
  push (`push.ts:521`) and no certification token exists yet (`grep certif` → nothing), so
  an identity memo cannot see ignore-rule changes. That certification is exactly roadmap
  **F3b** (certified matcher reuse + invalidation; prerequisites F1 ✓ + a freshness
  inventory over rule files / repo topology / private index). F3b unlocks both the pull's
  per-cycle matcher build (plan evidence: 1.7–2.0s warm on 100 repos) and this 0.7s/push
  memo. **Recommended next design: F3b**, with the projection memo as its first consumer.
  F2b was measured and parked: the per-watch-batch fixed cost is ~80ms at 198K entries
  (Map 55ms + sort 24ms), not worth a slice now.
- **Post-restart safety-scan pushes:** two per daemon restart (8 today, 1 yesterday in
  1,346 pushes), 108–140s each, `scan 82.4s` for 377,786 entries (`st48.6 obs36.3`) —
  while the daemon's own `safety scan:` line walks the SAME tree in `wall=1750ms`. The
  push-embedded scan path is ~47× slower than the daemon walker; restart cost only, but a
  cheap-looking candidate (F3-family) — not started.
- **SERVER: every changed push pays 4–7 s of commit accounting — root cause found, DECISION
  NEEDED (design 316, worktree `delta-marks`, `docs/design/316-*.md`).** Prod `commit.delta`
  analytics (Cloudflare Analytics Engine SQL, token in `~/.secret_env_vars`), 11:00–14:00Z:
  36 commits, `admitAccountMs` avg 3.9 s / p95 6.7 s, ~22 D1 batches each, refs added per
  commit avg 1.6, and `fallback marks_over_cap` on EVERY delta-eligible commit. The founder
  account holds **224,096 `blob_ref_candidates` marks** (D1 read-only; 185K older than the
  24 h grace; growing ~39K/day since 08-31; `blob_refs` 919,622 vs ~200K reachable), so the
  50K `FENCE_SET_MAX` mark probe is over cap and `shouldUseDeltaAdmission` forces full
  ~200K-ref admission. Design 102 §7.1 Q3 said an over-cap MARK probe must stay on the
  delta path, but commit `1cf847d7f` deliberately kept the enforce fallback ("never silently
  unfenced") and design 204 §3.1 made it a flip precondition: with the probe skipped, a
  prune-marked carried ref cannot be re-checked, and full validation is the only detector of
  that loss class. **Founder options:** A) keep (4 s/push on every device while marks > 50K);
  B) implement Q3 in enforce (~4 s saved per push, every device; the loss detector is
  inactive while marks > 50K; safety rests on Phase-1 reachability + grace). Recommendation
  B with a marks-count metric rider. Not decided by Claude — say "A" or "B".
- **GC observations from the same dig (prod, read-only `gc_state`):** the Phase-2 R2 purge
  last ran **2026-07-30** with outcome `roots_budget_exceeded` (purged 0, roots sample
  154,373 measured 07-20) and has not succeeded since; `gc_candidates` holds 511,527
  non-deleting rows (oldest 07-17). Phase-1 mark runs hourly (`gc_obs_mark` success
  2026-09-06 08:24, roots sample 266,496; cursor moving, capped 2,000 rows/tick); whether
  Phase-1 purge drains is unknown — the `phase1_account_outcome` logs need Workers
  Observability access (the token gets `Authentication error`; `wrangler tail --env
  production` saw nothing in a 5-minute window around the :23 tick). Founder-owed:
  Cloudflare MCP OAuth or a token with Workers Observability read.
- **#913 MERGED (design 316, founder decision B, `ed2c723f6` + rider `ff041983d`):** the
  over-cap MARK probe no longer forces full admission (design 102 Q3 as decided; 204 §3.1
  superseded for the mark probe only; `fence_over_cap` untouched); `marks{count}` emitted
  per delta commit; Phase-1 purge refuses a reachable snapshot older than grace/2. DEV
  auto-deployed (19:03Z). **PROMOTED TO PRODUCTION (founder "Promote", 20:43Z; deploy
  run 34058876355 success 20:47Z; production = `555c41f91`, ships 316 + rider + S1a +
  S3a, no migrations, no web).** PROVEN: the desktop's first changed push after the deploy
  (20:55Z) logged `commit 4.6s srv0.4 acct0.0` (was `srv4–7 acct3.4–6.7`); push wall 13.3s.
  Analytics Engine ingestion lags a few minutes; the pre-deploy commit at 20:40Z still
  showed `admitAccountMs 7621` + `fallback marks_over_cap`, the post-deploy one has delta
  rows only so far. #914 (attestation bench min-of-3, the day's other CI flake) merged
  after the promotion candidate; main = `54952f0e6`.
- **GC marks question ANSWERED (2026-09-08, token now has Workers Observability read;
  query: dataset `cloudflare-workers`, service `rbox-prod-api`, `$workers.eventType=scheduled`,
  structured `source.event=phase1_account_outcome`; founder accountKey `b8accb9276d0290b`):**
  Phase-1 runs every hour and SUCCEEDS for the founder account (reachable 124,845 of cap
  750,000) — but both mark and purge are capped at `PHASE1_MAX_ROWS = 2,000` rows per tick
  (`gc-phase1.ts`, design 102 "cap/33 batches per cron tick"). Per tick: marked ≈1,790–2,000,
  purged 2,000, condemned 2,000, released ≈10 MB. With ~800K unreachable `blob_refs`
  (919,622 total vs 124,845 reachable) the mark backlog refills the table as fast as purge
  drains it, so `blob_ref_candidates` sits at ~224K indefinitely and the account's
  `used_bytes` shrinks only ~240 MB/day. Since 316, marks no longer slow commits, so this is
  now a billing-accuracy/GC-hygiene item, not a perf one. **Candidate (needs a design +
  founder ok): raise `PHASE1_MAX_ROWS` (2,000 → ~10,000; ≈300 D1 batch subrequests per phase
  per tick, under the 1,000/invocation limit) or run Phase 1 more often than hourly.**
  Phase-2 R2 purge is a separate, older failure (`roots_budget_exceeded`, last 07-30).
- **REMINDER for 2026-09-07 — DONE 09-08 (token scope added by founder).** add "Workers
  Observability: Read" to the Cloudflare token in `~/.secret_env_vars` (or complete the
  Cloudflare MCP OAuth) so Claude can read the GC `phase1_account_outcome` logs and answer
  why 224K marks are not draining. Design 316 = founder decision **B** ("b it is"),
  implementation in flight (worktree `delta-marks`); after merge → DEV auto-deploys →
  verify via Analytics Engine (`admitAccountMs`, no `fallback`) → ask for the explicit
  production promotion.
- **Empty-push cost, remaining measured pieces (not fixed):** compose ≈0.95s
  on an elided save (`globalElisionAudit` rehashes the manifest; X1a);
  git-plan discover ≈1.1s (`discoverGitRepos` walks the tree; F3b);
  git-plan capture ≈1.6s unattributed (post-capture loop over all carried
  repos recomputes `repoRecordsForState` per repo + Git reads; plan.ts) and
  `Personal/rbox-core` fingerprint-misses every tick while being edited.
  The `state-save slow:` line lands in the pointer `daemon.log` (stderr),
  not the dated log `rbox logs` reads; `git-plan slowest:` is in the dated
  log. Copied desktop store for profiling lives in this session's scratchpad
  (`state-root/`, 1.1G; delete when done).
- **Roadmap 287 disposition so far:** DONE G2, G3a(+G3b discharged), G4a,
  G5a/G5b, F1, F2a, S1a, S2a, S3a, B0b(partial: push attribution). OPEN:
  G1 historical repair (founder decision, recommend defer), G4b/c
  cancellation, G5c/d pins+projections, F2b/c, F3b/c, F4b-d, F5, F6, S1b-d,
  S2b-d, S3b, S4, S5; G6/G7/F7/S6/X1-X4 are design/experiment gates.
- **Codex sandbox cannot write `.git/worktrees/*`** (index.lock EROFS): every
  Codex run leaves the diff uncommitted; commit from this session. Also:
  A root `SPEC.md` is gitignored (the #833 leftover moved to
  `docs/design/notes/misc/SPEC-286.md`); per-cycle specs never get committed.
- **Decision for founder — historical split-artifact repair:** both fleet
  hosts have 0 split-index repos; the only detector has a known hole
  (repos that turned split index off after a bad capture). Recommendation:
  DEFER as a measured no-go; note in scratch
  `NOTE-historical-split-repair.md`. Say "build it" to override.
- **Next bounded candidates (not started):** F3b certified matcher (unlocks the 0.7s/push
  projection memo + pull matcher build), design 316 (awaiting founder A/B), unchanged-repo
  transition elision on push (design needed; 0.3–0.48s/push), the push-embedded scan path
  (47× slower than the daemon walker; restart-only),
  G4a Git env inventory (allowlist routing vars), S2a extra-index
  compatibility fixture, G3b is discharged by the 296 schema bump.
- **Local hygiene:** all 46 stale worktrees and 285 local branches were purged
  this morning; backup bundle + dirty patches at
  `~/rbox-core-branch-backup-20260905/` (delete when confident).

## 2026-09-05 — Astra sync/Git handoff: four fixes implemented (historical; #882 now merged)

- **PR #882 OPEN, merge pending:** https://github.com/BrianVia/rbox-core/pull/882,
  branch `codex/astra-sync-git`. Four atomic commits: directory-deletion batching
  (`2e1cb6e49`), ordinary staged-object closure (`1d47b6755`), portable private
  split indexes (`09fbf6590`), tracked-index cache freshness (`3e7e6b169`).
  Audit/roadmap and the subsequent test-only compatibility repair are separate.
  Preserve feature commits with rebase merge; founder authorized merge after
  green checks and STATUS-only updates directly to main.
- **Checkpoint:** remote annotated `pre-astra-changes` points to
  `c4aa22bbb81c8754230735a73c5a58a28a64b4f7`. No production promotion or CLI
  release has occurred in this work. Broad worktree topology remains unfinished.
- **Validated locally:** final compiled Linux ARM64 DEV Git-entanglement passed
  111 assertions on two devices; synthetic account cleanup returned200. Capture
  tests32/32, held-skip16/16, ignore/manifest70/70, deletion/safety68/68; affected
  API15/15, typecheck/guards/lint pass. Designs289/290/291 reviews ALIGNED.
  Deletion fixture improves42–52× (~1.4s to27–33ms for124k entries/1k consecutive
  absent directories), not an end-to-end sync claim. Exact artifact/evidence:
  `docs/design/notes/287/integration-validation.md` on the PR branch.
- **CI repair awaiting final review/rerun:** initial run33976813037 failed three
  test shards; all other checks passed. CI moved from baseline Bun1.4.0 to1.4.2.
  The latter isolates beforeEach async context from test bodies. Design292's
  test-only callback scoping repair passes93 tests/15,307 assertions on both
  versions, with one unchanged skip and no production behavior change. The
  separate unchanged large-ref cap test timed out in CI and passed locally;
  it remains a suspected environmental timeout, not a waived check.
- **Review status:** GPT review of292 aligned; no Claude verdict exists.
  Automatic approval review twice rejected the previous agent sending the new
  packet to external Claude, interpreting prior permission as insufficient.
  The receiving Claude agent should inspect292 and its evidence directly and
  complete review plus exact-head CI before merge. See
  `docs/design/notes/292/runtime-comparison.md` and287's `CI-validation.md`.
- **Takeover:** fetch current remote state; if882 is still open, resume its
  branch in an isolated worktree, not a fresh implementation from main. Full
  copyable prompt: `docs/design/notes/287/claude-handoff.md` on that branch.
  Canonical25-package roadmap: `plans/sync-git-improvements/plan.mdx`; consult
  `docs/design/notes/288/baseline-reconciliation.md` to avoid redoing shipped
  F3/F4/G5 portions. Source-host path was
  `/Users/via/.codex/worktrees/a53f/rbox-core/.claude/worktrees/astra-sync-git`;
  session-local `/private/tmp` runtime/log paths are not portable setup.
- **Next:** finish882, update this status, then execute remaining approved
  packages through their gates. Early candidates: historical broken split-artifact
  repair, G5 ancestry batching, independent S1 scheduling recovery. Keep atomic
  commits, oxlint compliance, protected behavior, compiled validation and green
  CI. Gated protocol/rollout decisions still need their prescribed evidence;
  the four completed implementations do not finish the entire roadmap.

## 2026-09-02 (morning) — founder: "shadow it" + 2.0.2 authorized

- **Perf snapshot 2026-09-02 evening**: FM pull of 188K files/125 repos
  unchanged = ~3s, git-apply 0.1s, shadow cost invisible. Desktop churns:
  17 empty pushes/hour at ~7s each (git-plan 3s + state-save 2.4s for
  ZERO changes) + 2s safety scan/min; daemon ~70% of a core, RSS 3.6–4GB.
  Trigger: `Personal/home-dashboard/build.log` arrives from a peer every
  10 min. Proposed (awaiting founder yes): add `build.log` to
  home-dashboard's `.rboxignore`. Follow-up candidate: empty push should
  not cost 7s.
- **#881 MERGED (#832 shadow mode)**: read-only ff-only verdict beside the
  proof plane, default ON (`RBOX_GIT_SHADOW=0` kills), logs only
  disagreements, cross-tab in `.rbox/state/git-shadow.json` + one doctor
  line. Desktop (pid 3221728) and FM (pid 4000569, `~/rbox-dev-shadow`)
  dogfood `2.0.2-dev+e3881c3`; Mac stays stable 2.0.2. One week of data
  → §10 decision, then it rides 2.0.3.
- **v2.0.2 RELEASED + fleet on stable** (api.rbox.to/version = 2.0.2;
  desktop pid 3214381, flat-meadow pid 3993057, both `syncing normally`;
  FM 'No git repos are paused'; desktop shows the 3 known residual ghosts).
  Mac still owed `rbox upgrade` when online. Dev builds retired
  (`~/.local/bin/rbox-dev`, FM `~/rbox-dev-647` stopped).
- **v2.0.2 TAGGED on a8b47654a** (release run green after two FLAKE-012
  reruns; a docs push had cancelled the first run — lesson in memory: no
  main pushes while the release SHA is under test). Release workflow →
  fleet back to stable next. **#880 MERGED (#878)**: recovery-kit lock
  claimed atomically (temp+link) — the once-only 'two winners' was a real
  race, not a flake.
- v2.0.2 release commit a8b47654a (changelog: 'adopt the other
  machine's checkout without a fight' — rolls up #855 #856 #858 #859 #860
  #861 #864 #868 #869 #872 #873 #874 #877). Tag fires on exact-SHA main CI
  green; then fleet back to stable (desktop, FM, Mac if reachable).
- **#832 shadow-mode lane dispatched** (spec scratchpad/SPEC-832-shadow.md):
  ff-only verdict computed beside the plane per pull, default ON, kill switch
  RBOX_GIT_SHADOW=0 in the ledger, log only disagreements, counter file
  .rbox/state/git-shadow.json + one doctor line. Ships in the release AFTER
  its own week of fleet dogfood; the week's table decides #832.

## 2026-09-02 (early) — FM landing night: 3 of 4 repos converged, 3 fixes merged, the proof plane peeled six layers on one repo

- **Merged:** #869 (base-absent record is a first-BASE landing, not a
  protected-base change — the blanket "foreign BASE artifact" veto; "foreign"
  = THIS host's own superseded lineage, never a peer), #872 (base artifact
  capacity 256/512 → 2048/4096: one artifact per branch, rbox-core has 283),
  #873 (consent token no longer binds `repoGen` — take-theirs stopped
  self-invalidating; design 177 had already removed it from keep-mine).
- **Filed:** #870 (orphaned foreign artifacts never retire; 88 on FM), #871
  (a deletion without branchBaseOrigins provenance is refused forever and
  silences the WHOLE repo section — desktop rbox-core unpublished 9 days;
  "origin-mismatch" means provenance, not GitHub). #828 REOPENED (whole-tree
  ignore never reaches the retirement branch; agent on it).
- **FM landed at desktop tips** (founder: "desktop copies win — at least in
  this case", NOT a general rule): rbox-home-page 671bb5b, pegasus 4808a8da
  (fresh adoption), rbox-core add8a7e (fresh adoption ×2 after six sequential
  refusals: veto → missing-branch-proof → capacity → op-state breadcrumb →
  BASE pre-state → standing-P receipt; ledger on #837). savvy-core: desktop
  keep-mine PUBLISHED (seq 4798, needed `--force-discard-incoming`; FM's
  only-here commit "fix(studio): vendor-export scope counts" set aside); FM
  take-theirs confirm queued for the next quiet moment (token now stable).
- Both hosts on dev 2.0.1-dev+add8a7e (desktop + FM); Mac on stable 2.0.1.
- Recipes + traps in memory `git-plane-unwedge-recipes` (incl. keep-mine's
  flag re-print misread as rotation; never `pkill -f` a pattern that matches
  your own ssh command).
- **#874 MERGED (#828 for real):** retirement now folds over the KNOWN record
  set (the planned set never contained base-less/pending-less ghosts). Field:
  desktop `retired 131 paused repos` on the first push — 134 → 3. Desktop on
  dev 71fff25. **#875 filed:** fresh adoption of the 256-branch rbox-core on
  FM ran P-settlement silently 30+ min at 80% CPU while status claimed 'WAL
  replay' (it wasn't).
- **#647 root-caused with the forensics hook** (savvy-core FM take-theirs): after
  #873 the confirm reaches the locked boundary and refuses — `boundary-diff
  field reflogs … authored: []` = same refs/oids in a different SORT ORDER
  (identity code-point vs #836 normalizer localeCompare; differ on case →
  mixed-case branch names could never pass; also LANG-dependent hashing).
  Fix: one code-point comparator (PR pending). FM's rbox-core settlement took 45 min
  (artifacts 358 → 0), then FM pulled clean.
- **#877 MERGED (#647)**: the boundary's #836 normalizer sorted with
  localeCompare vs the identity's code-point sort — mixed-case branch names
  could never confirm. First confirm ever got through set-aside + publish,
  then failed at LANDING: `journal-recovery` → daemon deferred 'unreadable
  or corrupt journal' forever (journal parses fine; CAS/validation — **#879**,
  it also blocks fresh adoption until the entry is moved out of
  git-journal/). savvy-core on FM: journal moved aside, fresh adoption in
  flight (desktop HEAD 4452fc6a is the target). #878 filed (recovery-kit
  once-only claim produced two winners under starvation — atomicity, not
  flake). Both hosts on dev cf9afd0.
- **ALL FOUR FM repos converged on desktop tips** (savvy-core landed 06:27Z
  via fresh adoption after the stale landing journal was moved aside). FM
  daemon restarted once unnecessarily (I misjudged wall time — lesson in
  memory). #877 field-proven: the confirm crossed the boundary for the first
  time ever.
- Owed: #832 "shadow it" decision; runner-wizard rerun
  (FLAKE-012 hit 5× tonight); fleet back to stable when 2.0.2 ships.

## 2026-09-01 (night) — overnight lanes: #832 decision doc, #659 root-caused, bench truths

- **#866 MERGED — the #832/#837 decision doc** (docs/design/notes/2026-09-01-832-git-plane-evaluation.md).
  Verdict: field is PROOF-limited not divergence-limited (6 days of FM logs:
  ZERO true ref divergences vs 1,851–4,629 proof-plane deferral lines/day);
  proof machinery = 21 modules / 6,387 LOC; a 29-line ff-only rig makes #837's
  classes 1–7 unrepresentable; BUT ff-only was rejected IN CODE for a real
  reason (reachability.ts three-valued: shallow/missing-object must HOLD) and
  the naive candidate corrupts linked worktrees. **Recommendation: one-week
  SHADOW MODE** (ff-only verdict beside the existing one, log disagreement
  only, ~1 day) — founder decides after reading.
- **#864 MERGED (#863)**: ref cleanup batched to one `update-ref --stdin` per
  loop (3 loops incl. deleteScratchPins), 64→8 ms/41 refs; design-130
  allowlist updated honestly (fallback re-enters ownedUpdateRef).
- **#868 MERGED (#659 P1)**: theory refuted — not conflict copies. FM's 4 stuck
  repos are the 4 of 125 with `base_cjson NULL`; classifier compared a PRISTINE
  index against base(null)/incoming and screamed local-index for 6 days. Fix:
  pristine-read-tree probe before blaming the receiver. Fleet still needs one
  `rbox git resolve <repo>` per repo to establish BASE: rbox-home-page +
  pegasus → take-theirs (clean); rbox-core + savvy-core carry FM-authored
  commits → FOUNDER'S CALL (keep-mine/merge); rbox-core also has a .git/config
  parse error. Product decision filed **#867** (base-absent repos dragged
  into the follow pipeline; was legacyConflict pre-116).
- **FM bench (dev e2d1faf vs stable 2.0.1, prod, purged after):** #861 skip =
  −99.6% on ref-set-identical pushes (2.07 MB → 8.9 KB) but does NOT fire on
  git-commit pushes (§28 git blobs enter blobRefs → sidecar sha changes) —
  #820's value is exactly the commit case. **#857 hypothesis disproved:** pack
  lane engages (36 packs), upload goodput 97 Mbps > #504's 75–82; the "33
  Mbps" was a misread of `+=` lane counters (SUMS not walls — memory note
  lane-counters-are-sums). Real waste: **4.8 s upload→commit gap (23%)** →
  #857 retitled; packs close at half target (fill timers) → **#865**. #854
  warmth ≈ 0.33 s/push, Bun already reuses connections → P3.
- Fleet: Mac upgraded 2.0.1 tonight from the beach — folded the week's backlog,
  zero halts (third machine proving #848); 17,927 chromium copies in its trash
  (393 MB, harmless). Whole fleet on stable 2.0.1. Desktop = WiFi (not wired;
  memory corrected) — never a bench host.
- Owed: founder reads #866 → "shadow it" or close #832; founder's call on the
  two FM repos with local commits; runner-wizard rerun (FLAKE-012 hit 3 more
  times tonight); #823/#663 implementations after note skim.

## 2026-09-01 (afternoon, founder at the beach) — post-2.0.1 batch: 7 PRs, perf roadmap re-validated

- **Merged:** #855 (#828 ghost pause records retire when their path is ignored —
  the APPLY lane was the one stuck forever; no new verb), #856 (#810 proactive
  "one directory just exploded" status/doctor hint, self-clearing, no built-in
  ignore), #858 (RBOX_PUBLISH_PIPELINE in the defaults ledger, OFF verdict +
  deletion condition), #859 (#847 `rbox recover` REFUSES peer-authored
  supersede — rule lives inside repairChain, no override; founder ruling),
  #860 (#775 held-skip audit pinned: zero classes admittable; legacy attempt
  decoded once). **#861 (sidecar PUT skip, #820 interim: push bytes −85% at
  test size / ~99.5% fleet scale, entitlement proven server-side) merging on
  its last shard.**
- **Perf roadmap re-validated on main (opus read-only pass):** #508 CLOSED
  superseded (encrypt = 2% of push on FM; design 115 trigger missed ~48x) →
  successor #857 (uploader ~33 Mbps effective on 632 Mbps host); #670 invalid
  as written (no multi-binding scheduler exists; re-scope proposed); #823
  re-classed MEDIUM (sourceSeq stamping defeats per-record elision — note in
  flight); #663 MEDIUM (matcher memo; negation-rescue safety — note in
  flight); #775 re-scoped (fetch skip already works; classify+cleanup 13s on a
  real section change is the cost — note in flight); #821 trimmed (keys-GET
  shipped in #845; two claims overstated); #820/#821 stay LARGE design-cycle.
  Filed from the audit: #851 S4 debounce (parked), #852 Merkle manifest hash,
  #853 LAN peer transfer, #854 connection-warmth measurement.
- Bench junk from the #508 run purged from prod (ws_d163d05f…, 8 commits) via
  scripts/ws-purge.ts; FM bench-ws removed, rig kept at ~/code/bench508-rig.
- Perf close-out numbers recorded on #822/#818 (FM 2.0.0→2.0.1: no-op push
  2.8–5.7s → 2.3–2.8s; steady pull flat ~3.3s).
- Owed: Mac `rbox upgrade` on wake (founder tonight) + runner-wizard rerun
  (FLAKE-012); three MEDIUM design notes MERGED (#862: #823 sourceSeq split, #663 matcher memo key must include the gitignore flag, #775 = two working-tree proofs per follow + two per-ref git spawn loops → #863 filed SMALL); #857 follow-up
  measurement; held-skip.ts at 396/400 and help-registry.ts 8 bytes under
  ceiling — next toucher decomposes.

## 2026-09-01 — **v2.0.1 SHIPPED** (tag 87261788c) + cap → 1M

- **v2.0.1 released**: rolls up #839 #840 #841 #843 #844 #845 #846 #848 #850.
  Headline: growth-only 1M entry cap (was 200K; founder "1M is fine"),
  pre-upload refusal naming the directory + ignore hint, purge that purges,
  folds that never wedge, honest ⛔ halts, SQLite encrypt cache, pull perf
  plumbing, cli-audit seven-pack (NOTE: destructive commands need --yes
  headless now). Release pipeline green; api.rbox.to/version serves 2.0.1.
- **Fleet**: desktop + FM on stable 2.0.1, syncing normally. Mac still
  offline (~Aug 28); on wake: `rbox upgrade` then it folds the backlog fine
  (or shows the honest ⛔ + recover if it races the upgrade). External users
  get 2.0.1 via `rbox upgrade`.
- #849 watchdog flakers hardened on main (margins starvation can't erase) —
  they cost 5 reruns in 3 days and the release gate runs through main CI.
- Watch items: desktop's recurring "retrying after conflict" tick under live
  contention (benign so far, unexplained); FLAKE-012 still pending the
  founder's runner-wizard rerun (`npx -y cloudflare-github-actions-runner@latest`
  → upstream 1.0.10 tolerates transient assignment statuses); #847 recover
  supersede product decision; perf differential formal close-out owed.

## 2026-08-31/09-01 — #838 CLASS FIX SHIPPED (#848) + the week's story corrected

- **PR #848 merged** (3 opus lanes, integrated): (A) entry cap is GROWTH-only
  with one owner `entryCapTrips` (cli/sync/policy.ts) — readers/folds/decodes
  never size-refuse; (B) `rbox ignore --purge` root-cause: the purge matcher
  un-ignored every git-tracked path, so it could never remove a checked-out
  tree — explicit .rboxignore rules now win on purge (deliberate behavior
  change, test inverted with reasoning); (C) foldDelta validated its RESULT
  against the absolute cap — FM's 2-day CHAIN HALT loop; fixed + chain-repair
  halts render ⛔ naming `rbox recover`.
- **Field-proven on dev build 2.0.0-dev+4f7e49a** (desktop + FM): #840's
  breaker fired honestly (refused a 1.24M-file candidate pre-upload, named
  chromium/src, offered the ignore line); purge reported "5 ignored entries →
  seq 4527" truthfully; FM FOLDED the deltas clean (no recover); probe file
  roundtripped desktop→FM. Fleet: desktop+FM on dev build; Mac offline since
  ~Aug 28 — on wake it needs the dev build (or the fold halt shows the new ⛔).
- **Story corrections (important):** the workspace legitimately holds ~198K
  entries (savvy-core 101K) — Friday's "manifest 212K→25K purge" claim was
  wrong (it deleted 3 entries; chromium never fully landed). **We are at 99.2%
  of MAX_ENTRIES with legit files — cap raise (founder floated 1M) is now safe
  (growth-only, one owner) and URGENT-ish.** Also: FM's stale republish
  REVERTED the .rboxignore chromium line (ignore rules are synced files — a
  peer commit can undo an eviction; #847 evidence).
- Issues: #847 (recover supersedes peer commits — data-loss-shaped, P2),
  #849 (BlobBatchDownloader watchdog CI flake family — rerun policy).
- Earlier same day: #843 (Namespace regress ownership fix, un-pinned),
  #844 (encrypt cache → SQLite), #845 (perf plumbing), #846 (setup-cmd
  exitCode leak — Bun quirk: `process.exitCode = undefined` does NOT clear).
- Owed: cap-raise PR (needs founder yes on the number); perf differential
  close-out for #844/#845 (steady FM pulls ~3.4s observed, formal both-lane
  numbers owed); 2.0.1 release decision; Mac dev build on wake; desktop
  "retrying after conflict" tick recurs under live contention — watch.

## 2026-08-30 — three-lane subagent sweep: #839/#840/#841 merged (9 issues closed)

- **#839** (fixes #824): `rbox upgrade` — dead daemon records collapse to one
  summary line, never exit-1; copy no longer claims an install on no-op.
- **#840** (fixes #813+#810): manifest entry cap refuses at the shared
  pre-upload boundary (`preparePublishCandidate`), names the dominating dir +
  `rbox ignore` remedy, typed `too-many-entries` daemon halt (⛔ not spinner).
  Would have prevented the #838 wedge. Side effect: doctor-triage.ts
  decomposed (ratchet re-recorded tighter 473→435; new doctor-triage-halt.ts
  + doctor-finding.ts). #810's proactive no-trip hint deferred (math exported).
- **#841** (fixes #513 #514 #516 #517 #518 #519 #521): cli-audit seven-pack.
  NOTE behavior change: `trash empty`/`key revoke`/`device revoke` need
  `--yes` headless now; `untrack` needs `--force`. Scripts may need updating.
- Process note: harness pins agents to their own launch worktrees (EnterWorktree
  write-only, Bash refused) — agents commit on `worktree-agent-*` branches at
  the same base; coordinator ff-merges into the named branch. Worked 3/3.

## 2026-08-28/29 — #836 merged; desktop chromium wedge root-caused → #838 filed + purged

- **PR #836 MERGED** (squash, after rebase onto main + green CI; the shard-5
  #816 perf red was stale-branch flake). Includes the RBOX_DEBUG_BOUNDARY=1
  forensics hook for #837. Resolve-robustness series complete on main.
- **Desktop wedge root-caused (#838, NEW BUG)**: chromium checkout (#828
  ghosts) pushed the server manifest to 212,846 entries — over the client's
  MAX_ENTRIES 200K — after which every pull failed validation and
  `rbox ignore --purge` couldn't run either (purge pulls first). Surface
  symptom was the misleading "too many conflicts" halt (1,064 failures).
  Recovered via one-off 400K-cap build: `chromium/` added to
  ~/Development/.rboxignore, purge succeeded (→ sequence 4523, manifest back
  to ~25K), stock 2.0.0 daemon restored, throwaway build deleted.
- Desktop healthy again (backlog 1.04M → ~1). Residuals: 132 paused ghost
  repos under the now-ignored chromium tree (#828 state cleanup), 1 repo
  ">1 day stuck" flag, and a lingering "retrying after conflict" probe to
  re-check.
- Max (mxcl): telemetry says NOT recovered — his account's last contact
  Aug 3 on 1.11.4; no 2.0.0 device, no new workspace. Next step: his
  `rbox status` / `rbox doctor --upload`. (Prod devices readable via
  `devices.last_seen_version` in prod D1.)

## 2026-08-26 — **v2.0.0 SHIPPED** 🚀

- **Tagged v2.0.0** (SHA 4cc6cee19, green CI) after the founder's "tag it";
  stable release workflow GREEN on its first full exercise (binaries +
  RboxBar.zip through the signed manifest + changelog publish + GH Release
  + rbox.to rebuild). Fleet upgraded: Mac's single `rbox upgrade` moved
  CLI+daemon+RboxBar to 2.0.0 (the whole #801 design paying off); FM clean;
  desktop needed manual stop/start (#824 dead-record noise derailed the
  managed restart — the issue's own repro). All 3 daemons on v2.0.0.
- **The zero-wedge gate was MET first** (founder ruling drove a 36-hour
  campaign): six resolve-plane fixes merged (#830 #833 #834 #835 #836 ×2
  commits), the connectivity class root-caused to STALE COMMIT-GRAPH
  CACHES (proof now runs core.commitGraph=false), stale-P classes closed
  by receipts for both shapes, no-progress bound, boundary before+after
  normalization, honest named refusals + republish remedy copy. rbox-admin
  resolved; ~40 repos resolved fleet-wide; the final savvy pair landed via
  the step-out primitive: .git moved aside + fresh adoption (5 minutes,
  first try — the strongest #832/#837 evidence).
- **#837 (P1, post-tag)**: the eight-round wedge-night investigation —
  proof-plane cost accounting + fresh-adoption-as-fallback + the #832
  ff-only candidate. Founder-requested.
- **Version-bump time bombs** hit AGAIN at release (upgrade-cmd fixtures
  hardcoding 2.0.0 as future; fixed to 99.0.0 like the beta.5 doctor
  literal). Candidate lint rule: no future-version literals in fixtures.
- **Remaining post-ship items**: pegasus #775 (one live instance),
  desktop rbox-core stuck partial, 132 chromium ghost records (#828),
  Mac's 3 uncommitted-work pauses (founder's own work), Aug-27
  three-provider CI cost review, #824 upgrade noise, savvy .git backups
  (~/rbox-831-gitbackup-*/, delete after a clean week), FM/desktop back
  to dev builds when 2.x work resumes.

## 2026-08-25 — beta.5 shipped through the new pipeline; PROD PROMOTED; darwin sweep complete; CI on Namespace

- **v2.0.0-beta.5 tagged + released (next channel)** — first tag to carry
  RboxBar.zip through the signed manifest. Two release-SHA bugs found+fixed
  first: a doctor test hardcoding "2.0.0-beta.5" as a future version (now
  99.0.0), and regress wholesale-failing on Namespace runners (#827, job
  pinned back to ubuntu-latest; lesson: force-run input-gated jobs when
  moving runners).
- **PRODUCTION PROMOTED** (founder yes, 2026-08-25): main→production at
  77febd093 — 281 commits, prod D1 migrations + API deploy green, dashboard
  rebuilt. Prod API now serves the RboxBar zip routes. 2.0's server side is
  LIVE.
- **PR #801 darwin e2e sweep COMPLETE** — all 10 checks recorded on the PR
  (quarantine negative control both halves on the founder's Mac; live update
  0.1.0→beta.5 pid-swap against real prod; idempotence; non-running update;
  failure posture field-proven twice via the pre-promotion 404). Method
  documented in local skill `.claude/skills/mac-remote-verify/`.
- **CI runner topology finalized** (#825/#826): mac PR jobs + all Linux
  non-shard jobs → Namespace (pay-as-you-go; darwin smoke 2m22s→27s via
  their same-DC cache); CF keeps the 9 shard jobs; MacBook keeps e2e; GHA =
  release/deploy ceremony only. Budget job retired (founder; spot-check =
  `bun run tui-budget`). Mac mini purchase DEAD (docs/ci-macos-cost.md
  addendum). Est. total CI ~$65–90/mo at the real ~772 runs/30d; Aug-27
  three-provider dashboard check will replace estimates.
- **2.x perf roadmap filed** from the re-verified 10x-hunt audit: #818
  (quick wins: pull matcher reuse + dircache + parallel keys GET), #819
  (S1 WS commit-in-frame + gap detector), #820 (S2 refset delta,
  design-first), #821 (S3 one-RTT publish), #822 (EncryptAddressCache→
  SQLite), #823 (per-record elision). S4 parked. Triage stamp in the audit.
- **Changelog draft founder-approved** (my verification accepted as the
  review) + synced to post-draft reality (wire renames landed, RboxBar CLI
  install, fossils ON). Beta headings fold at assembly.
- **Loose ends**: #824 (`rbox upgrade` dead-daemon noise + false "installed"
  copy); desktop shows 132 chromium-ghost paused repos (stale records inside
  ignored paths — cleanup candidate) + rbox-core partial-sync 2d; FM ssh
  host-key changed (NOT auto-accepted — founder to confirm); founder ruling
  pending on two-speed CI (draft=fast lane) + CF 90s assignment window + CF
  perf-budget time headroom.
- **TAG RUNWAY (all that's left for 2.0.0)**: assemble changelog (fold
  betas, 2.0.0 heading) → #775 remedy copy → version bump both sites →
  regress → tag on green SHA (founder's fresh yes) → fleet upgrade.
  Friends' upgrade copy: "run `rbox upgrade` — that's it" (recorded in
  session 08-25).

## 2026-08-22/23 — fleet v2 crossover DONE; chromium stress week; toward the tag

- **All 3 machines crossed to the v2 store** (2026-08-21/22, playbook in
  docs/design/283-state-regenesis-resolution.md): desktop + Mac read-write,
  FM pull-only (read-write flip offered, founder deferred). Old v1 stores
  preserved in ~/rbox-v1-state/<ts>/ per machine — delete after a clean week.
  The 4 deferred wire renames are LIVE fleet-wide. Bonus: the desktop's #702
  field instance was CURED during crossover (pruned 49 dead branch.* config
  sections → 422 allowlisted keys < 512; remedy documented in the issue).
- **The chromium stress week (founder's browser fork in ~/Development):**
  34GB repo + a build that added ~1M artifact files. Findings all in #808
  (loop monopolization + heartbeat freeze + host-deference requirements,
  founder rulings verbatim) and #807 (RESET_NAMESPACE_BUSY crash-not-defer,
  fix in flight). The chromium BUILD memory-exhausted the host (hard lock,
  reboot 08-22 07:52); the v2 store took the hard reset mid-push and
  reopened CLEAN — incidental crash-durability proof on day one.
  Resolution: `chromium/src/out/` added to .rboxignore (Claude decision
  under founder's "do it without me" — regenerable artifacts; the repo
  itself still syncs), daemon restarted to apply (no hot re-arm: #473).
- **Issue hygiene sweep (2026-08-23)**: #667 closed (ruled), #664/#775/#660/
  #702/#808 updated to current truth, ship-with-note stamps on #672/#669/
  #659/#516/#518. Tracker now matches the checklist.
- **FLAKE-011/012 registered** (#660 acceptance w/ preload-guard net; the
  three CF-runner sensitivity classes).
- **Test cull PR #809** (founder rubric): 66 ceremony/existence/provider-
  shape/copy tests deleted across 31 files, 7 classifier flags overturned on
  adjudication; honest headline — the suite is ~99% contract-dense. Ledger
  in CULL-REPORT.md in the PR.
- Remaining to tag: #807 fix (agent), #809 merge, #664 24h completion (Mac
  sampler restart owed when reachable), #802 field acceptance + 30-attempt
  propagation bench (both once desktop settles post-ignore), rig FAST +
  regress on the candidate SHA, founder: RboxBar darwin e2e + changelog
  review + the tag yes.
- Standing note: the .claude/worktrees echo-clobber carve-out in
  ~/Development/.rboxignore cites a root cause that #803 has since fixed —
  candidate for removal after a quiet week, founder call.

## 2026-08-21 (overnight run) — all six ruled workstreams LANDED (#799-#804)

Six parallel opus-orchestrator agents (codex implementing per /arbitrage),
every PR carrying a mandatory "Guessed decisions" section; Fable reviewed
diffs and merged on green. All merged:

- **#799 (#515)**: central surplus-positional gate; 62 registry arity
  declarations; unexpected args now error naming the arg + usage.
- **#800 (next-channel)**: `resolveUpgradeChannel` single owner; persisted
  `next` + newer stable → adopts stable + clears selection; explicit
  `--channel next` wins; manifest now boundary-parsed AFTER signature
  verify (agent caught codex deleting a load-bearing guard).
- **#802 (#793)**: root cause was NOT the re-arm — `record.advertised` is
  only written on own-ACK, never refreshed by pull, so post-ADOPT plans
  compared against stale reconstruction and echoed the peer's bytes back
  (all 35 field ops=0 events correlate). Publish oracle is now the
  persisted wire base (one authority deleted). Post-merge acceptance:
  ops=0 count → 0 while ADOPTED lines continue — CHECK THIS after the
  next fleet roll.
- **#803 (#535)**: reframed with field proof — apply ALWAYS preserved
  bytes via conflict copies on the reported path; the copies were
  UNREPORTED (plan-derived reporters), which also wedged the git lane.
  Now: `onConflictCopy` outcome reporting (INVARIANTS.md entry), plus two
  REAL byte-loss edges fixed (rule-authority expectedLocal defeat on
  .rboxignore; post-hash TOCTOU). Size-ratchet trip resolved by a real
  seam: `engine/apply-target.ts` owns "what is at this path now".
  Residuals honestly named in the PR (typeFlipsSincePull contract).
- **#801 (RboxBar, design 282)**: zip rides the signed manifest (bespoke
  wrangler steps deleted); API serves both zip shapes (DEV verified:
  binary 200, zip 404-until-first-tag); `syncMenuBarApp` default ON +
  RBOX_NO_MENUBAR_APP=1; first install LAUNCHES (agent caught the draft
  violating the default-on ruling); install.sh = binary swap + one darwin
  line. **Darwin e2e owed on the MacBook — 10 named checks in the PR;
  load-bearing: the quarantine negative control.**
- **#804 (wire-renames)**: 9 of 12+ renamed w/ dual-accept + deletion
  conditions; 4 DEFERRED — state.db has no migration mechanism (DDL
  fingerprint hard-refusal); founder ruling owed: schema-v2 migration vs
  2.0 re-genesis (recommend re-genesis). BONUS: production
  `rbox doctor --upload` had been 400ing (TOP_KEYS missing
  leftoverWorktrees/repoResidue) — fixed.

CF-runner pilot night-1 health: 4-5 runs hit the pool's "runner
assignment not observed within 30s" fast-fail (reruns recovered every
time), one recovery-kit concurrency flake (passes 5/5 locally at 2 CPUs);
tally in docs/papercuts.md, feeds the Aug-27 verdict. The whole test
MATRIX (typecheck/workers-API/regress too, not just 6 shards) runs on CF
— the matrix shares one runs-on.

#664 sampler running on the Mac (~/rbox-664-footprint.log, 5-min
cadence): overnight ~491-566MB footprint, peak 1375MB — comfortably
under the 2GB bar so far.

Owed / founder queue: state.db ruling (above); darwin RboxBar e2e; #802
field acceptance check; changelog draft review
(docs/2.0-changelog-draft.md, NOTES FOR REVIEW at bottom); manifest-delta
24 pre-existing anti-slop warnings (deferred cleanup, named follow-up);
#664 24h collection completes ~2026-08-22 03:20Z.

## 2026-08-20 (evening) — CI on Cloudflare runners (#797) + design-156 flake ROOT-CAUSED (#798); Mac rolled

- **PR #797 MERGED: the 6 test shards run on `cloudflare-ubuntu-latest`**
  (ephemeral Firecracker containers via the private GitHub App pool from
  `biw/cloudflare-github-actions-runner`; setup wizard run by founder,
  Worker `cloudflare-github-actions-runner.brian-via.workers.dev`, R2
  dep cache). Motive: August month-to-date rbox-core burned 12,421
  GitHub-hosted Linux minutes ($67.60); Cloudflare bills actual seconds
  vs GitHub's per-job minute round-up. Stays on GitHub: docker rig (no
  DinD in the image), arm lane (amd64-only), macOS, release.yml. Two
  workflow shims, each with an upstream deletion condition
  (biw/cloudflare-github-actions-runner#2): node20 symlink (image pruned
  the runner's hashFiles() interpreter) and a user-space git 2.55
  install (image ships stock noble git 2.43, below rbox's own ≥2.46
  floor). Shard wall-time 117–201s on 2vCPU vs ~60–180s on GitHub's
  4vCPU — acceptable; bump to a 4vCPU custom label if it grates.
  **Value check owed ~1 week**: GitHub `settings/billing/usage` (needs
  `gh auth refresh -s user`) Linux line should collapse; compare against
  the new Cloudflare Containers charge; watch for queue stalls/OOMs
  (8GiB vs 16GB).
- **PR #798 MERGED: the design-156 quarantined flake is DEAD — root
  cause umask.** The CF runner's strict umask made the only tolerated
  flake in the design-123 registry fail deterministically (first time
  ever): local write lands 0o600 under umask 077 while
  FakeRemote.seedEntry hard-codes mode 0o644; `sameContent` counts mode
  as identity, so pull correctly minted a conflict — the combined
  assertion's 'conflict' channel. Verified BOTH directions on the
  MacBook itself (umask 022 pass / 077 fail): the month of macOS-only
  reds was codex-sandbox/nightly umask context. Skip deleted per its
  own contract; product behavior untouched. Bonus:
  `missingBlobsChunked` narrowed to `Pick<SyncRemote, "missingBlobs">`.
- **Mac ROLLED to 3c78a055a** (supersedes the owed 7555c8a): read-write,
  syncing normally, 280 headline copy live. Whole fleet now ≥7555c8a.
- Playbook: CF-runner job debugging = push a temp `cf-debug` forensics
  job (uname/statfs/clock-drift/umask + the failing test alone), delete
  before merge. The runner VM clock ran ~14s fast; nothing depended on
  it yet.

## 2026-08-20 (later) — design 280 SHIPPED + field-proven: stuck held repos escalate (#781/#792/#678 closed)

- **PRs #795 + #796 MERGED, fleet on 7555c8a (desktop+FM; Mac
  off-network, roll owed)**. FM headline now reads the designed split:
  "47 waiting on you" (protective sentence correctly scoped) + "**6
  repos have been stuck syncing for over a day — rbox needs your
  help**". The 4-day silent-spin era is over.
- **Design 280 (4 review rounds + 2 delta-confirms, ALIGNED r3.1)**:
  three-valued connectivity proof (transient exec failures no longer
  branded connectivity-unproven — #792), durable typed deferral `code`
  (#781's original ask, adopted on evidence), ONE actionability
  predicate (self-healing ∧ reasonSince>24h ∧ lastSeen<6h) across every
  surface. **Rig FALSIFIED the take-theirs remedy offer** (re-staging
  only re-fetches the incoming window; below-window damage never
  restores — clean refusal, no data movement) — offer withdrawn per the
  design's pre-agreed arm, guarded by a red-provable pin; remedy copy
  folds into #775. Rig: git-stuck-repair + FAST 9/9 green.
- **Field acceptance caught what the matrix couldn't (#796)**: TWO lossy
  row carriers (GitDivergenceStatus's 4-field lane projection feeding
  the headline; ambient snapshot rows) dropped the predicate's inputs —
  headline said 47+6-self-healing while counts/JSON said 53/6-stuck.
  Both carriers now carry reasonSince/lastSeen; ambient deferral
  contract decomposed to daemon/ambient-deferrals.ts (one owner, was
  ~130 lines apart — how the drift happened).
- **#794 MERGED**: 3 real cross-file env leakers fixed + the #678
  preload guard (env+cwd drift fails the shard naming the keys). #660
  re-scoped: original failure did NOT reproduce from state — residual
  is load-timing; the guard makes recurrence self-diagnosing. #678
  CLOSED.
- **Codex confirm debts cleared**: #786 CONFIRMED no findings; #782
  FINDINGS→#792 (fixed same day by 280 Slice A).
- **b2 CLOSED with evidence** (zero field instances, detector proven in
  binaries) but "last empty-sequence source" falsified → **#793** filed
  (~40 empty ops=0 publishes/48h from permanent-carry post-pull
  re-arms; desktop's carry is #702's field form).
- **Drafts awaiting founder**: changelog 2.0 (scratchpad; flags the
  fresh-start-vs-healing #774 discrepancy — checklist has the ruling
  ask), RboxBar upgrade-management design (scratchpad; 2 pipeline
  blockers found: app zip 404s via release route regex + zip outside
  signed manifest; quarantine finding makes CLI install dialog-free).
- **Process incident logged**: an agent's bare `git stash` in a shared
  worktree popped a foreign stash (recovered, verified byte-identical;
  rule: no bare git stash in shared worktrees).
- Owed: Mac roll to 7555c8a when reachable; #664 founder ruling;
  founder decision stack unchanged (#667, wire-renames, next-channel,
  sharp-edge triage incl. #793).

## 2026-08-20 — 2.0 final run OPEN: 664 evidence complete, rig healed (#787/#788), 6 lanes fanned out

- **Session renamed "2.0 release final run"** — founder driving toward the
  tag; docs/2.0-RELEASE-CHECKLIST.md is the gate list.
- **#664 evidence package COMPLETE, founder ruling requested on the
  issue**: (a) memory — the 8GB-rss bar measured wrong on darwin: at
  4.95GB `ps rss` the kernel phys_footprint was **524MB** (JSC MADV_FREE
  pages stay in rss); proposed bar "<2GB phys_footprint"; cross-host
  control desktop 1.8-2.9GB / FM 2.1-2.8GB / Mac working set ~0.5GB
  (best in fleet). PR #789 MERGED: summary line now `rss X heap Y`.
  (b) fuses — terminal-fuse era over: every fuse re-arms in ~2min
  (dozens field-proven); one 61min escalated-backoff exception named;
  boot-3 of the controlled cycles fused once (recovered 2m05s), so the
  literal 5-clean-boots gate keeps failing on a churned Mac — reframe
  requested (transient self-healing episode ≠ the terminal failure the
  gate guarded).
- **#787 + #788 CLOSED (PR #790 MERGED)**: git-entanglement's 2 failures
  + crashed step were ALL stale-rig-vs-shipped-behavior (#756 export
  move; design 273's ownership-hold record + pause-story status
  grammar). No product regression; no bisect needed. Scenario now 0
  failures; the design-176 grammar-freeze test caught the assertion
  change and its inventory row was updated intentionally. Flake note:
  #660 bit again (design 206 matcher, shard 5, run 32293614036, 3×
  green locally).
- **Litter sweep (founder ask)**: 196 rbox *.conflict.* copies deleted
  repo-wide (incl. two .env shadows with secrets), .depot/ removed,
  tracked REVIEW-1/2.md + stale .goals/43 deleted (4d2cd2041).
- **6 parallel lanes running**: codex confirm passes on #786 + #782
  (quota back); opus: b2 empty-sequence field verification, #660
  shard-leak class fix (worktree ci-shard-leak), RboxBar
  upgrade-management recon+draft, changelog 2.0 draft. Fable driving
  the held-repo doctor story (#775/#781) design next.
- Awaiting founder: #664 ruling, #667, wire-rename cutover pass,
  next-channel stranding, sharp-edge triage (#672/#669/#659/#535/#702,
  cli-audit #515/#516/#518).

## 2026-08-19 — design 279 SHIPPED same-day: FM steady pull 21-22s → 8.2s (#749 residual KILLED) + #785 half-persist fix

- **PR #786 MERGED (947622c), fleet on it, field-proven within minutes**:
  every steady zero-change FM pull was acquiring **1,882 CAS locks**
  (~12.5s fsync at the 268 hardware floor) to re-prove partial markers
  merely CARRIED in state — 53 held/deferred repos' appliedRefs summed to
  exactly the lock count; pegasus+savvy-core alone were half. Slice 1
  delta-scopes `planStateCasLocks` + `revalidateGitPartialApplies` to
  markers the pull AUTHORS (`markersThisCommitOwns`; `effectivePartial`
  deleted); kill switch RBOX_CAS_DELTA_LOCKS=0 (two clean fleet weeks);
  release path now timed into the cas span. **Field: FM steady pull
  8.2s, zero locks, no acquire span** (was 21-22s); desktop push
  1.5-1.9s, Mac pull 2.0s/push 2.8s — both lanes unregressed. Also
  defuses the MAX_V2_LOCKS=4096 hard-throw cliff FM was 46% toward.
- **#785 found by the review loop, fixed as Slice 0, CLOSED**: every
  CAS-window state withdrawal HALF-persisted — `savePulledState` captured
  values/repoProofs before the window; reassign-style drops
  (dropPartial, most carryUnreadableRefDatabase arms) never landed while
  the delete arms did. Worst arm: a BASE withdrawal with no prior base
  persisted BASE-deleted + pending-lost + no deferral. Fix: outcome
  members re-derived inside the save closure (`outcomeRepoValues`),
  probeKeys/receipt deliberately kept outside the held-lock window.
  Tests missed it because only production built the source outside the
  closure — production-shaped pins added.
- **Review shape**: 2 parallel opus lanes → fold → final serial opus
  review → delta-confirm ALIGNED r3 (codex quota out until 08-20 05:57;
  **owed: codex confirm passes on #786 AND #782**). 14 red-first pins;
  268's crash matrix re-pointed at an authoring pull (carried shape now
  appends 0 locks — vacuous; measured 140 on authoring).
- **Pre-merge rig gate: differential clean, two MAIN defects filed**:
  git-entanglement fails identically on clean main — #787 (rig
  state-view helper imports repoRecordsForState from its pre-#756 home;
  aged-visibility step crashes) and **#788 (regression vs #462: per-ref
  worktree ownership hold escalates to a repo-level apply deferral;
  window Aug 16-18** — the rig skipped 3 merge days; bisect recipe on
  the issue). Rig-every-few-PRs rule earned its keep the hard way.
- **docs/2.0-RELEASE-CHECKLIST.md refreshed against live issue state**
  (founder ask): #668/#649/#658/#683/#685/#688-via-#774 checked off;
  added the wire-rename cutover gate (window closes at external ship),
  held-repo doctor story (#775/#781), #702, #660; FM pull-lane target
  now MET. Top remaining hard gate: **#664 Mac field acceptance**
  (re-measure RSS post-#683/#685).
- Queue: #788 bisect (fresh, small), #787 (one-liner class),
  unreadable-journal class (#775), 274 PR-B, design 262 §2, #781.

- **CI bill sized from job durations** (billing API needs `user` scope):
  ~941 CI runs/30d × 21 jobs ≈ $500–550/mo of runner compute; macOS
  (darwin smoke + perf budget) is ~60% of it; per-job minute rounding
  ~30% of the Linux share.
- **#783 MERGED**: job-level `timeout-minutes` on every hosted job
  (default was 360 min — one hung test billed 6h), plus a
  `run_tui` gate: PRs confined to docs/, apps/, or macos/ skip the
  compiled-TUI family (cross-build, 3 smokes, darwin perf budget,
  regress flows, onboarding rig — both always-on macOS jobs included).
  Main pushes still run everything (release gate). One heap flake on
  the way in (cas-operations "does not scale heap", run 32150872804,
  3× green locally).
- **Depot runners PARKED (#784 closed, branch kept on origin)**:
  Depot's Actions runners refuse personal-account installs — the repo
  must live in a GitHub org. Founder keeping today's savings and
  re-evaluating. If the repo ever moves to an org: reopen #784 (label
  swaps only), expect ~$540→~$235/mo; org move also requires
  reconnecting both Cloudflare git integrations + Team plan for
  private-repo branch protection. Cloudflare's Workflows-based CI was
  evaluated and rejected for now (private beta, Linux-only, full
  TS rewrite). Depot CLI installed + logged in (org "Via Labs");
  $20/mo Developer plan is the entry point if revived.

## 2026-08-18 (day) — 277 soaked + design 278 SHIPPED same-day (FM pulls 44→20.5s)

- **277 soaked numbers (overnight, n=733/547/158/116)**: desktop push
  median **1.5s** (was 7.4), Mac **2.7s** (was 6.6), desktop pull 2.0s,
  FM pull 44.3s. #661 CLOSED at target-met. Fleet re-rolled onto the
  post-deletion build; desktop watcher re-armed clean on restart
  (first arm raced a codex worktree teardown — papercut logged).
- **Design 278 (connectivity-defer skip, #782 MERGED, field-proven
  same-day)**: the #775 recon convicted a fetch-before-defer livelock —
  5 FM repos (AutoGPT, bird, savvy-demo, savvy-core-v1,
  claude-containers) re-fetched+decrypted bundles (12.5–17.3s + 1–5s×4)
  every pull, failed the same connectivity proof, deferred, forever.
  Fix extends design 270's held-skip: typed `connectivity-unproven`
  code at the one proof site (regex deleted), gated attempt store at
  the checkout-defer exit, one allowlist disjunct
  (provenance+code), kill switch RBOX_GIT_CONNECTIVITY_SKIP=0. NO new
  durable state — r1's objectDbDigest dropped after coverage review
  proved a stale skip is ≤1h slow, never unsafe (full input-coverage
  table + no-consumer proof in the design doc). 4 review rounds, all
  opus (codex quota out — flagged in PR; optional codex confirm pass
  owed). **Field acceptance exact**: skippedHeld 43→48, deferred 9→4,
  git-apply 28.3→4.0s, fetchDecrypt max 98ms, zero proof-failure lines
  post-roll, FM pull **44.3 → 20.5–21.0s**. Fleet on d29e5e7.
- **FM's remaining poles, ranked**: cas acquire 11.3s/pull (#749
  residual — now the biggest), unreadable-journal repos pegasus +
  savvy-core (#775 stays open), #781 (structural escalation for
  >32h-broken repos; artifact stories are needsYou:false so doctor
  never escalates past info today — known, deliberate).
- Flake sighting recorded: daemon-trusted-pull.test.ts:620 ("deep-scan
  audit opened after the pre-pull drain") failed CI shard 5 on #782,
  attempt-1 evidence preserved in the run log (run 32144245570), 9
  consecutive local passes, diff-unrelated; rerun-proven green.
- e2e picture vs the ≤10s target: sender 1.5–2.7s everywhere;
  desktop→Mac in range; desktop→FM needs the #749 lock slice next.
- Queue: #749 residual (recommended next), unreadable-journal class,
  274 PR-B (stamp baking since last night), design 262 §2, codex
  confirm pass on #782.

## 2026-08-18 (overnight) — perf cycle 277 SHIPPED + architecture loop COMPLETE (12/12, map deleted)

- **Design 277 shipped both slices** (ALIGNED r4 after 2 parallel reviews +
  final serial per slice, plus a founder-ordered /step-out-a-layer pass that
  replaced three invented mechanisms with existing primitives — both
  implementation-review blockers dissolved instead of patched):
  - **PR #776 (Slice B, #477 CLOSED)**: pull-only daemons start the live
    watcher; "pull-only" collapsed to publish-suppression only (design-178
    fullScan-drop + hygiene-tick split deleted); watch-queue overflow = a
    synthetic transient drop episode through watcherTrust (no latch
    protocol); pull-side event drain moved above the P-chain (latent
    read-write inversion fixed). FM's FIRST-EVER trusted pulls at 03:14Z.
  - **PR #778 (Slice A, #661 build half)**: memoized `loadState` at the one
    adapter choke point (state-memo.ts, 82 lines, zero call-site changes) —
    the steady push cycle did FIVE full O(N) state materializations (the
    design counted 4; a boundary binding-fence load was the fifth), now 1
    cold / 0 warm. Four-column freshness probe {authority, lineage, nonce,
    revision, telemetry_binding_id}; aliasing precondition proven by a true
    recursive deep-freeze over the full suite (RBOX_STATE_FREEZE=1 guard
    ships); per-column stale-token witnesses; allowlisted mutator audit;
    RBOX_STATE_LOAD_CACHE=0 kill switch (deletion: two clean fleet weeks).
- **First fleet numbers (fleet on 9fb37fb, ~15min samples; overnight soak
  running)**: desktop zero-change push **7.4s → 1.6s**; Mac **6.6 → 2.6-3.4s**
  (git-plan 2.2-2.9s is now the whole push); FM pull **51-63s → 38-48s**
  with the 10-17s scan leg at 0.0 (`local=trusted`). Content push 17→12.2s
  (commit 4.6s = next lever). Remaining FM poles filed as **#775**
  (deferred-repo bundle refetch 12-17s/pull + 11-12s cas acquire).
- **Architecture loop DONE 12/12**: founder signed off #42 + map deletion
  ("we're trying to make our code so simple it doesn't need a map").
  **PR #779**: migration tree retired — 56 files, **−19,108 lines**, 3 CLI
  commands gone (`rbox migrate`, doctor retry/abort), 5 live modules rehomed
  (move-fidelity audited), anti-slop 1,777→1,585. Doctor's `migration`
  check renamed `genesis` (v2-beta window). Legacy JSON authority KEPT
  (design 262 §2 refusal gate = queued separate slice). **PR #780**:
  docs/CODEMAP.md DELETED — 346 entries judged: 168 constraints moved into
  their modules as `Never:` headers, 158 navigation lines died, 20 already
  present; AGENTS.md law inverted (constraint lives in the module).
  Gates caught 3 real defects en route (streamless-legacy crash from an
  anti-slop typeof removal — fixed by honest typing; Bun exit-0-on-fail
  quirk re-confirmed; #778 mutator-audit staleness across branches).
- **Fleet**: all 3 hosts on 2.0.0-beta.4-dev+9fb37fb, all 3 with LIVE
  watchers (desktop needed a second restart — its first watcher arm raced a
  codex worktree teardown and degraded wholesale on ENOENT; papercut filed
  32c0c34c9). FM overnight soak running; morning owes: soaked perf
  differential (both lanes, 3 hosts), fleet re-roll onto the post-deletion
  build, #661 close decision (target: push op 4-5s — met at 1.6-3.4s).
- Open next: #775 (FM refetch, biggest remaining e2e pole), design 262 §2,
  Mac git-plan slimming (measured decision), 274 PR-B (visible device
  names) once the stamp bakes.

## 2026-08-17 (evening) — must-ship arc: 274 PR-A + 276 both halves SHIPPED

- **Design 276 (upgrade safety) shipped both halves same-day** (doc r1→r2.1
  ALIGNED, adversarial review + REVISE folds + diff-scoped /simplify passes
  per the founder's discipline reminder): PR #774 (F1/#688 CLOSED — 1.x→2.0
  upgrades no longer take sync down; admission checked per-workspace BEFORE
  the stop, real remedy surfaced, absent-catalog auto-init at one owner
  healing upgrade+bootResume+track+adopt+init; design 266 R4 retired via
  dated amendment; respectGitignore round-trip hole closed at the mutation;
  initializeFolderCatalogAfterFirstBinding deleted as a proven strict
  subset) and PR #773 (F2/#765 CLOSED — W1 is a typed variant not a halt,
  classifier consults the in-process owned-writer registry, 6×5s bounded
  backoff before the fail-closed hour, status halts from classifier ∪
  live-ambient resetLifecycle with the health-halt.json poison-pill read
  DELETED, three-way ready line). **Field-proven on FM**: the exact
  sqlite3-ro replay of the morning incident → syncing normally in 90s
  (morning cost: 19min outage).
- **Design 274 PR-A merged (#771)**: GitSection.deviceId stamped at capture,
  identity-excluded by construction with regression locks, churn refuted by
  measurement; baking on the fleet. PR-B (the visible "take via-desktop's
  version" copy + label cache) dispatches after bake; founder rulings r3:
  trust-the-fleet stamping, label→id→generic-only-for-unstamped ladder.
- **Fleet**: all three hosts on 2.0.0-beta.4-dev+505738e, syncing normally.
- **Issues**: #688 #765 closed; filed #769 (file-size gate unreliable under
  full runs), #770 (manifest-validate zero headroom), #772 (ambient-status
  34B headroom + status-render at exactly 400); #757 got a fresh evidence
  pair. Papercuts: CLI suite leaks tmpfs fixture dirs (~17G/54k dirs — brick
  class), dry-run mutex contention on busy pull-only hosts.
- **Open founder decisions**: F1's product question (should a leftover
  daemon runtime dir veto catalog initialization like real user config?);
  telemetry needs-you split (273 challenged requirement); #667 fossil
  disposal at tag time.
- **Process learnings memoried**: cwd resets cross-contaminate worktrees
  (absolute paths only in multi-worktree briefs; 3 incidents); never open a
  live fleet state.db even read-only (db-copy pattern); one full suite at a
  time per host (tmpfs); diff-scoped /simplify as an explicit pre-merge
  gate.
- **Queue**: #517 recovery-phrase fix (next slot), #535 echo data-safety
  design (heavyweight), #661 sender lane, 274 PR-B, design 275
  restore-backup, /antislop + /improve-codebase-architecture sweeps in the
  next soak window.

## 2026-08-17 (day) — design 273 SHIPPED end-to-end: git-lane legibility (#764)

- **Design 273 ran the full cycle in one day** (founder-driven copy session →
  doc r1→r3.1 ALIGNED across 4 review rounds → three PRs, each with parallel
  review wave + fix round + final serial review): PR #766 (PR-A: status-view
  6-way + resolve-command 7-way decompositions, both ratchet pins DELETED,
  move-fidelity audit PASS byte-exact), PR #767 (PR-B: 13-story plain-English
  vocabulary with founder-set "you have uncommitted work here", ownership
  holds keep their record at all THREE clear sites, one population + per-row
  quiet flag, one `resolvable` predicate across four surfaces, held-skip
  write amplification eliminated 6→1 with zero-writes proof), PR #768 (PR-C:
  refs/rbox-pending pins with convergent per-pull sweep, two-sided evidence()
  via git plumbing reads, single-repo view, --dry-run with honest
  unknown-vs-zero copy, batch keep-mine via --under with frozen-count consent
  + --expect-repos; batch take-theirs refuses until design 275). Fleet live
  on 9707d31 (all 3 hosts); field acceptance verified on FM's real 52-repo
  state (headline==listing, evidence clauses, single-repo file lists) and a
  real Mac dry-run (honest 2-saved/19-not-copied counts).
- **Splits queued from review discipline:** design 274 (sender device naming
  — Max's ask, copy says "another computer" until then), design 275
  (restore-backup; batch take-theirs gates on it). Also queued:
  doctor-triage.ts decomposition (~7 bytes ratchet headroom), telemetry
  needs-you count split (challenged requirement in 273 — needs founder
  product call: server validator + D1 migration + alert predicate,
  API-before-CLI), batch --json shape, single-state-reader consolidation for
  resolve (whole-state bound 53→56 comes back down), mechanical lint-debt
  pass on status-render/resolve JSON builders (named trade in all 3 PRs).
- **GH #765 filed (operator-induced incident, 3 product defects):** read-only
  sqlite opens on FM/desktop live state.db left WAL sidecars → W1 halt;
  1-hour retry for a self-clearing condition; health-halt.json poison pill
  (status says halted while doctor reset-journal says none); boot heal races
  its own bootstrap. FM lost ~19min, desktop ~15min; both healed. RULE
  (memoried): never open a live fleet state.db — copy state.db* aside and
  query the copy.
- **Field-state fixtures shipped** (src/cli/fixtures/field-states/): real FM
  52-record + Mac 3-record captures drive the PR-B replay suite; the night's
  "103 vs 52" headline mystery resolved as transient/stale (post-restart the
  same population renders 52; noted on #764).
- **Papercuts:** resolve --dry-run loses the sync mutex race on busy
  pull-only hosts (FM, 2 attempts) — bounded-wait idea logged.
- **Fleet:** all hosts 2.0.0-beta.4-dev+9707d31, syncing normally; FM
  pull-only, 46 needs-you + 6 self-healing standing (untouched by founder
  choice); Mac 3; desktop clean. Conflict-copy litter from worktree doc
  syncing (*.conflict.ts/md in src/ + docs/) present on all hosts —
  cleanup candidate, do NOT commit them.

## 2026-08-17 (night 2) — 271+272 SHIPPED: P-settlement landing + conflict-copy oracle

- **Merged to main and live on all 3 hosts (812202e):** PR #760 (design 271,
  5 design rounds + 3 review passes) — first-BASE landing via observed-landing
  authority, typed base-absent hold (create-shaped P only), resolve legibility
  (2 error classes, 3 typed refusal codes, GitDeferral.detail + 4 carriers,
  refusal copy never claims "nothing changed" post-commit). PR #763 (design
  272, NINE design rounds — see step-out lesson below) — conflict grammar
  gets one owner (isRboxConflictArtifact + conflictName co-located),
  comparableFor replaces 7 hand-copied exclusions, empty-population guard
  (grammar-emptied match → indeterminate), new `conflict-copies` deferral
  reason with plain copy, top-level conflictCopies status count (counts
  minted OBJECTS). apply-receipt.ts decomposed (receiver-paths.ts) to BELOW
  its original ratchet pin. Rig git-rebuild-settlement flipped green.
- **Field state:** count line live on all hosts (desktop 11, Mac 11, FM 24
  objects); 271's detail companion rendering on Mac. Probe propagation
  desktop→Mac ~41-46s, desktop→FM ~51s (1 file; sender lane #661 still the
  pole; git-apply within-pull 0.6-0.8s/107 repos). Standing wedges did NOT
  self-heal: held-skip (270) correctly skips unchanged-incoming holds, so
  Mac's 6 + FM's 52 deferrals need explicit resolve or fresh incoming.
  FOUNDER RULING: no sweep — the decision surfaced product gaps instead
  (#764: status legibility + reason-vocabulary English + resolve dry-run/
  batch; the session transcript is the requirements doc). #659 stays OPEN
  (oracle fixed; field-close evidence = a future resolve wave or organic
  incoming draining the standing set).
- **Deployment gate:** prod API must learn `conflict-copies`
  (SERVER_GIT_DEFERRAL_REASONS) before fleet CLI emits it at scale.
  FOUNDER CHOSE fleet-now-promote-later: fleet devices in the new hold get
  sync-state telemetry dropped by prod ingest until the next production
  promotion (production is 198 commits behind main — promotion is its own
  deliberate session). External users unaffected (stable builds never emit
  the reason).
- Issues: CLOSED #752 (via #760). FILED #761 (reset repair lock inversion,
  pre-existing), #762 (quarantine pointer on artifact refusal + last raw
  reasons ride the resolve-command split), #764 (git-lane legibility,
  founder-hit). Flake registered: issue-501 write-amplification shard pin
  (green-on-rerun eligible, attempt-1 evidence).
- **Process lessons (memory-saved):** long review loop (≥4-5 rounds) =
  step-out trigger — 272 bundled five mechanisms and paid nine rounds;
  split designs instead. Builders widening a safety gate must pause and
  report (271's widened arming hid the projection-vs-record P0; the
  parallel wave caught it). Founder permission-loops answered with
  legibility complaints = extract product requirements, stop re-asking.
  Convergence bar: the merged artifact must read as designed-once ("the
  version you'd write by the end") — enforced as an explicit pre-merge pass.
- **Queued next (founder-ranked):** #661 sender lane (P1, soak doubles as
  baseline), #660 CI shard leaks (parallel), #664 evidence pass (passive),
  #535 echo-clobber (data-safety sleeper), full /improve-codebase-architecture
  + /antislop-codebase sweeps (opus fan-outs, fold into #671 roadmap) during
  the soak, 2.0 decision trio for founder (#688/#667/#702). resolve-command.ts
  sits ~10 bytes under its ratchet — next touch = the split (#762's vehicle).
- Mac RBOX_TRACE_HELD=1 still armed (disarm at next routine restart).

## 2026-08-16 (night) — PERF ARC COMPLETE: 6 PRs, v2.0.0-beta.3 to next

- **Shipped + field-verified on the fleet (cbca36c):** #750 delta-scoped
  no-op saves (zero-change pull 13.3s→3.6s); #751 CAS-lock amortization
  (FM acquire 50.3s→16.4s @ N=2,292, `locks<N>` attribution live); #756
  delta-staged content saves (one-changed 2.8s→~60ms bench; Mac 1-blob
  receive 20.4s→9.0s, content save 5.9s→1.2s); #758 held-skip composer
  eligibility (trio 3.5s→53ms/repo — 65×; Mac git-apply 7.4-8s→4.4s).
  Also #753 (rig key for 3 parked defects) + #754 (#699 shard weights
  restored+guarded, replay 65-150s→97-101s; #677 rig commit column).
- **Release v2.0.0-beta.3** tagged to the `next` channel (this section's
  four kill switches: RBOX_SAVE_NOOP_ELIDE, RBOX_SAVE_DELTA,
  RBOX_GIT_HELD_SKIP_COMPOSER + 268's journal v2; all default ON,
  defaults-ledger registered).
- Issues: CLOSED #748 #749 #699 #677; #752-A fixed (B = p-settlement
  asymmetry + resolve-UX slice, rig-keyed, still open); FILED #755
  (9 pre-existing darwin state-plane failures — the darwin CI lane's
  work list), #757 (cas-operations heap guard red on clean main,
  host-dependent, mis-calibrated; green-on-rerun SUSPENDED for it).
- **Remaining long poles (evidence-ranked):** desktop zero-change PUSH
  6.7-6.8s (#661: state-load 1.7s + gaps — sender is now the ≤10s
  frontier); Mac residual git-apply 3.6s = #752-B wedge; content-save
  floor = read-back + darwin fullfsync (ledgered follow-up); state-load
  cross-cycle cache (267 §5).
- Founder queue: #659 (P1 correctness, next cycle), #664 evidence pass,
  #660 shard leaks, 2.0 tag-gate trio (#688 guard unbuilt / #667 / #702).
- New standing rules (memory): efficient-frontier routing for big work;
  codex quota-benched → opus lanes; design artifacts in
  docs/design/notes/<n>/ never repo root; staggered fleet git-pulls
  (reset-repair recipe); TMPDIR needs mkdir -p; test:parallel for full
  gates; continuous antislop (named types, ≤1-line comments, net fewer
  concepts/slice).
- Mac daemon left with RBOX_TRACE_HELD=1 armed (cheap; disarm at next
  routine restart).


## 2026-08-16 (final) — #749 ALSO KILLED: CAS-lock amortization SHIPPED (#751, design 268)

- **PR #751 merged** (design 268): append-structured journal v2 (O(N²)→O(N)
  bytes, 1 fsync/lock), per-directory batched fsyncs, single-use release
  handle (one owner per physical effect — double-release unrepresentable).
  4-round design + 2-lane impl review + fold + final serial confirm; the
  wave caught 3 CRITICAL-class defects pre-merge (double-release authority
  deletion, journal-cap wedge at FM scale, un-canonicalized identities).
  Trail in docs/design/notes/268/. #749 CLOSED.
- **Field-verified within minutes**: FM's post-deploy catch-up pull was the
  pathological shape at N=2,292 locks — acquire 50.3s → **16.4s**
  (~33ms → **7.2ms/lock**, at the measured 2-fsync provenance floor;
  FM NVMe 2.92ms/fsync, desktop 1.06ms). New span attribution
  `locks<N> blocked<M>` makes O(N)-work vs real contention self-diagnosing.
- **Rig FAST 9/9 PASS** on merged 13bbcb8 (incl. git-entanglement — the
  lock machinery's own scenario — and json-upgrade-path with 267's elision
  live on both backends). Fleet uniform on 13bbcb8, all 3 hosts.
- Founder-ledger rows (below-floor levers, decisions pending): K-batched
  provenance appends; per-repo lock granularity (the deep N-reduction);
  consumed-name provenance (needs native binding + threat-model ruling).
- **Next long poles (evidence-ranked)**: M4 delta-stage save (Mac content
  pull still 5.9s full save — earned by measurement); Mac git-apply
  re-prove churn 7.4-8s/cycle (parked-deferral class); state-load 1.7-2s
  cross-cycle cache; codex quota LOW — new work routes to opus until reset.
- Papercuts: fleet git-pulls must be staggered + desktop-first (synced
  checkouts turn concurrent pulls into conflict-copy waves — bit 3x today;
  FM repair = fetch + reset --hard origin/main); full-suite gates should
  use `bun run test:parallel` (145s) not serial `bun test` (550s).

## 2026-08-16 (later) — #748 KILLED: delta-scoped state save SHIPPED (#750, design 267)

- **PR #750 merged** (design 267, 235-Phase-B): provably-no-op pulls compose
  a minimal save packet — lock/fence/revision/housekeeping preserved, O(N)
  staging skipped. Proof = canonical manifest hash over `manifestFromMeta`
  + whole-meta identity + `{nonce, stateRevision}` CAS predicate
  (single-attempt receipts, structural binding). Kill switch
  `RBOX_SAVE_NOOP_ELIDE` (ON). 4-round design review + 2-round impl review
  (codex+opus), all findings folded; review trail in
  `docs/design/notes/267/`.
- **Field-verified BOTH hosts**: desktop zero-change pull 13.3s → **3.6s**
  (state-save 9.8s → **0.8s**), push unchanged ~6.8s. Mac zero-change
  state-save **1.6s** (darwin fullfsync floor). Founder-accepted trade
  (§3.4.1): elided cycles keep prior BASE generation — reader audit +
  fixture prove no freshness consumers. Desktop+Mac daemons on `2be999a`.
- **Mac's next long pole is NOT the save**: git-apply re-proving 7.4s +
  settle 2.5s per cycle (parked-deferral churn) — pre-existing bucket,
  separate from #748/#749.
- **#749 re-diagnosed** (evidence on issue): the "50s mutex stall" is NOT a
  lock wait — it is the git state-CAS lock publication loop's own
  durability ceremony (O(N²) journal rewrites + ~4 fsyncs/lock ×
  1-2k locks). Measured: FM NVMe (970 EVO Plus/LVM/ext4) 2.92ms/fsync,
  desktop NVMe 1.06ms — the ceremony hurts every real fs at first-pull
  lock counts. **Design 268 ALIGNED r4** (append-journal v2 + batched dir
  fsyncs; per-lock provenance proven to be the threat-model floor across
  3 refuted schemes — trail in the cas-lock-amortize worktree); codex
  implementing. Expected ~50.3s → ~9s; below-floor levers (K-batched
  appends, per-repo lock granularity, consumed-name provenance) are
  founder-ledger items in the doc.
- New standing rules (memory): continuous antislop+architecture per cycle
  (maintainability IS the goal); agents use `bun run test:affected` per
  iteration, full suite once (papercut logged).
- CI cost triage (parked by founder): ~1,078 runs/4wk × ~20 jobs; option A
  (merge sub-minute jobs, dedupe main re-run via tree-hash, fix #699
  weights) sketched; post-merge main run is release-gate-required (design
  150) — do NOT cut it.
- Sweep note: 15 `.conflict.ts` sync-litter files removed from the
  rbox-core checkout (device dev_aaaa337, 04:16-06:34Z timestamps).

## 2026-08-16 — SP-3 CLOSE-OUT: fleet soak CLEAN on da28ddc

- Post-cutover propagation bench (5 rounds, 602-byte change, desktop→Mac,
  da28ddc): publish→applied median ~11.7s; Mac pull wall 18.3–18.7s for a
  1-blob 0-wire change; desktop zero-change push ~7s. Receiver alone exceeds
  the ≤10s yardstick — evidence on GH #748 (P1, whole-state save) and #749
  (P2, 50s mutex-acquire stall, no holder attribution). Delta-scoped apply
  (task #17) is the lever. JSON-era differential NOT run (round-6 records are
  the baseline if wanted).

- Darwin trilogy fixed + field-validated (#745 PERSIST_WAL, #746 sealed
  DELETE-mode, #747 containment keeps private names — Apple's system SQLite
  cannot read unlinked databases, probe matrix in PR). Soak: desktop + Mac
  "syncing normally", Mac sealed-stage errors ZERO post-fix (was ~6/min),
  FM pull-only with zero publishes ever. Mac git deferrals down to the ~6
  known parked ones. CI has NO darwin runtime lane — three field bugs say
  build one (queued).
- Status false-halt flap: read-only W1 classifier races a live writer and
  intermittently reports "sync halted" while the daemon is healthy — folded
  into task #50 (W1 takeover-not-halt + halt retry).
- FM read-write flip awaits explicit founder yes (266 §9.4).
- SP-4 eligibility: all §9.4 criteria met except soak duration is founder's
  call; backups + cutover records retained.
- New host reality: desktop runs a LIVE fleet daemon — local crash-rig/io-halt
  suites now fail on this host from co-residence/tmpfs pressure; CI or rig
  containers are the arbiter for those suites (papercut class).

## 2026-08-15/16 — SQLITE FLEET CUTOVER COMPLETE (SP-3 shipped + live)

- SP-3 merged (#743, design 266 ALIGNED v4 + fold R4): genesis default at every
  entry, lock-capability probe (EPERM-indeterminate, ephemeral refusal, "Your
  files are safe" copy), upgrade-window CALL removed (module stub retained for
  SP-4 per the fold R4 ruling — design self-contradiction resolved in doc).
- Also merged: #741 SP-2.5 rig dimension, #742 identity-race retry (the shard-1
  "flakes" were ONE product bug: unlocked state.json hash vs atomic-rename
  writers), #744 fence hash cap (512 KiB refused any real-sized state.json —
  73 MiB desktop state couldn't migrate), #745 PERSIST_WAL (Apple's system
  SQLite keeps -wal/-shm after close BY DEFAULT; S0 could never hold on darwin;
  affects released darwin binaries too — no darwin runtime CI lane exists).
- FLEET: desktop MIGRATED (58-byte Q, 263 MB at-rest db, read-write, dev+75b7cec);
  Mac MIGRATED (same, read-write, RboxBar relaunched — RboxBar must be quit
  during migrate or its connection blocks at-rest); FM REJOINED via
  `rbox pair`→`rbox connect` (new device dev_9da82ec7…), fresh track produced
  IMMEDIATE SQLite genesis (Q before track returned — the SP-3 e2e proof),
  daemon pull-only per 266 §9.4. Read-write flip needs explicit founder yes.
- Soak: 30-min fleet check running; FM zero-echo + convergence to verify.
  Desktop backup ~/Development/.rbox.pre-sqlite-backup + per-host cutover
  records in ~/rbox-cutover-records/ retained until SP-4.
- SP-4 (deletion) may start only after fleet soak + all 266 §9.4 criteria.
- Queued: #49 lint-clean SP-3-touched files + init-cmd decomposition; darwin
  runtime CI lane; FLAKE-010 pump-quiescence; Mac's 6 parked git deferrals.

> Cross-host memory for Brian + agents. Update this doc when a release ships or
> a workstream opens/closes. Deeper context: `docs/design/*` (numbered designs),
> PR history, and per-machine Claude session memory (does not travel — this doc
> is the carrier).

_MORNING CAP (2026-08-15): **STATE-PLANE FORK DECIDED — FINISH SQLITE.**
262's round-1 reviews (4 blockers) proved the SQLite plane UNFINISHED (JSON
still owns degraded sync writes, reset/rebind, telemetry binding; genesis
unreachable from the selector; post-Q crash would strand after deletion).
Founder chose finish-first: 262 v2 is now the parent plan for a 4-slice
"finish the state plane" loop (SP-1 genesis admission → SP-2 port the three
JSON-owned behaviors → SP-3 default flip + fleet cutover incl. FM rejoin →
SP-4 the deletion, closes arch-#42). Tasks #43-46. SP-1/SP-2/SP-2b MERGED (#736/#737/#740); SP-2.5 rig dimension at PR #741 (flake reruns); SP-3 design 266 ALIGNED v4. FLEET: desktop clean/canonical;
Mac converged to 6 residual git deferrals whose take-theirs batch REFUSES
("could not complete safely" ×4, "local commits changed while confirming",
2nd "P settlement BASE disappeared" sighting) — parked as a named defect
needing a two-device-rebuild rig scenario (papercuts logged); FM parked
until SP-3. Sync echo-clobbered the desktop checkout TWICE during the
rebuild (restored from main both times; conflict-copy litter deleted; the
2nd wave self-corrected). Wire-rename candidates doc now has 5 entries._

_LATE-NIGHT CAP 2 (2026-08-15, same session, PRs #703-#732 = 30 merged):
**Slop 3,421 → 2,216 (−35%)**; waves 5-6 + first two shape-names lanes
merged (#725-#732; shape campaign is CODE-SYMBOL-ONLY by founder ruling —
wire candidates parked in docs/wire-rename-candidates.md, 5 entries).
**#42 IN FLIGHT with founder sign-off ("just delete it" / "start fresh")**
— but field checks falsified the premise: the JSON→SQLite migration NEVER
ran on any fleet host AND fresh joins still create legacy JSON (SQLite
plane fully dormant; only rbox migrate / upgrade-window reach it). Design
262 (worktree arch-42) therefore ships two PRs: PR-A = genesis-default
flip (fresh joins → SQLite) then fleet cutover; PR-B = delete migration
tree (44 files/13.7k lines) + legacy-json-store + refusal gate. Round-1
reviews in arch-42/CODEX-262-{A,B}.md, both CHANGES-REQUIRED — fold next.
**LIVE INCIDENT (desktop): start-fresh rebuild left ~/Development wedged**
— state was rebuilt via rename-aside (.rbox.pre-sqlite-backup kept) +
track --workspace + daemon; files safe and synced content intact, but the
re-baseline push conflict-loops ("too many conflicts") EVEN WITH Mac+FM
daemons paused (so not a race), and 103 git repos sit in keep-mine
deferrals (daemon captured 99 but they carry pending, never settle).
Mac+FM restarted read-write on 540e224 and healthy; desktop daemon left
retrying. NEXT SESSION: state-surgery triage on the desktop publication
refusal (grep daemon log for the per-attempt refusal; suspect carried-
pending admission), then bulk keep-mine (list at scratchpad
deferred-repos.txt, resolve refuses while daemon syncing — stop first),
then fold 262 reviews. Telemetry recipe for device versions is in the
262 evidence section (D1 devices table; 5 external 1.x hosts, one on
1.6.6)._

_NIGHT CAP (2026-08-14→15, arch-loop session, PRs #703-#727 = 25 merged):
**ARCHITECTURE LOOP 11/12 DONE** (docs/ARCHITECTURE-LOOP.md is the ledger).
Big cuts: #40 RefPlaneTransaction (follow.ts 1,210→247, PR #710), #41
engine/git GONE (24 modules folded into sync-git, lockfile+git-spawn
promoted, pin tightened, PR #717), capstone #39 Publication (PR #724,
design 261 — the 3-round review loop killed the big-module rewrite and
shipped the honest version: domain term + one consolidated retry-contract
file + audited-cohesion verdict replacing the false "pending split"
marker + daemon seal dedup; net −113 lines). **Type-slop campaign: 14
opus lanes merged (#711-716, #718-723, #725-727)** — every fix traced to
the producer's true type, zero fakes/suppressions; burn-down **3,421 →
2,390 (−30%)**; four type rules now 559 total (from ~1,673). Remaining
mass: runtime-typeof 852 (parse-at-boundary campaign), spread 555,
shape-names 424 (needs rename decision). Flake: daemon-activity "pr8
remint" sighted + rerun-proven (registry entry added). Fleet: all three
hosts restarted onto 41061f47b mid-session; ANOTHER fleet update due for
the #39/#41-late merges (main at #727+). AWAITING FOUNDER: #42
migration-tree retirement support-window sign-off (~6,415 lines, ~90
warnings, ~35 CODEMAP entries); e2ee-client.ts flagged as next
decomposition candidate. apps/api/test/** still in no tsconfig program
(ticket-worthy)._

_EVENING CAP (2026-08-14, fleet on **1940cfc**, session PRs #684-#701 = 18):
**#700 MERGED** — apply.ts decomposed at the held-decision seam (1,559→1,249
nonblank, ratchet re-pinned DOWN below the original; held-decision.ts +
apply-metrics.ts own their planes; move-fidelity audited; rig 136 PASS).
**#701 MERGED + field-verified: cp 2,500-2,700ms → 10-11ms** (beats the
pre-#696 ~400ms baseline; push walls 6.7/6.9s < 7.0s) — real mechanism was
NOT held-ref iteration: the supersession pre-probe admitted on presence,
#696's apply progress flipped it to maybe, every push force-captured the
wedged repo (68-ref witness + encryption) then provePendingSupersession
deterministically refused (config over the 512-key wire bound) and
reverted; fix = memoized refusal in the divergence cache, fail-closed,
red-proven both legs. **#702 filed**: rbox-core's config is STRUCTURALLY
over the wire bound — carries pending forever; product options listed.
NEW FOUNDER RULES (memory + enforced): sync-plane PRs close out with
BEFORE/AFTER on BOTH lanes; touched files get ALL warnings fixed;
size-ratchet trips get decomposition, never re-pins (both re-pins this
session were reversed by real splits — shared.ts→chain-timings.ts,
apply.ts→two deep modules). ARCHITECTURE REVIEW COMPLETE (explorer report
in session records; presented as 12 ranked deepening candidates): CODEMAP
= symptom of SHALLOW modules (356 entries, effects declared 4x in daemon
satellites, flakes cluster exactly where no module exists — WS channel;
55-file trace for one push; 29-module dead migration tree = ~35 map
entries; 10-term CONTEXT.md glossary + design-number table proposed).
FOUNDER PICK PENDING: default 7+8+12 (barrels/timing-table/CONTEXT.md)
then 1→2 (daemon satellite inversion → RemoteWakeupChannel). Housekeeping:
worktrees 61→35 (clean ones removed, refs kept; 33 dirty for triage),
branches ~300→244, grammar-freeze census re-pinned STRONGER (emitter
template frozen, re-proven red twice). Watches: #664 RSS, Mac
ignore-counter divergence (no purge from Mac), trusted-pull flake family
(2nd sighting class)._

_AFTERNOON CAP (2026-08-14, fleet on **e5c1f3f**, session PRs #684-#696):
**Desktop git-apply 45.3s → 1.3s FIELD-VERIFIED** (#696/#573 fix 1: typed
checkout blockers — receiver-only branch publications failing BASE pre-state
were `other` via cross-contaminated ??= vars, one untyped blocker killed
held-skip; skippedHeld=1 live). **Mac slice-1 window FULLY named** (#694
spans): 2.8s = matcher construction 1.7s + projection 1.0s (ignore-carry
0.9) — the old "matcher=1.8ms" read was the _ms-renders-seconds deception
(#692 finding 4); matcher was never exonerated. Both cacheable/delta-able.
DESIGN 247 (trusted-view push) REJECTED round-1 by BOTH reviewers (premise
false: daemon push already consumes local.manifest; view would publish
deletions per deferred path) — kill reasons in the doc; replacement shipped
(#694) + standing safety finding: publish path has NO trust gate (recorded
deliberate). Also merged: #693 (telemetry write cap 326→29/sample, #691
finding 1 — #691 CLOSED), #695 (FLAKE-008 credentials fence-timeout: CPU
starvation not neighbor-lock, deterministic seam, prod 80×25ms untouched).
#668 CLOSED (installer live). PROCESS NOTE: #695 merged while shard 3 red —
merge tooling doesn't refuse; new rule: verify rollup==0 before merge (done
for #696). New SUSPECTED: design-202 conflict-copy test (trusted-pull
family, 2nd sighting class; registry). IN FLIGHT: #666 --trace flag PR,
#573 fix 3 residual accounting. NEXT BUILDS (all convicted): matcher cache
+ delta ignore-carry (Mac 2.7s), git-plan cy/f/cp, noDropProof batching
(#573 fix 2, design-219 template). Mac RSS 15.0GB (#664)._

_MIDDAY CAP (2026-08-14, fleet on **e63c116**): #692 merged (thermo #691
findings 2-5: divergenceNeedsPush one-owner routing — pending-carry can no
longer reach doPush via recovery; candidate_projection_ms DELETED;
truthful span labels; last anti-slop line fixed). FINAL SLICE MAP posted
on #661, every number field-measured: desktop content push 7.0s; Mac
no-op cycle 7.8s = scan gap 2.9s (CONVICTED by elimination) + git-plan
4.6s (cy/f/cp). drain_wait 0.1s fleet-wide. Mac RSS 12.4GB fresh boot
(was 21.1 pre-restart). BUILD ORDER to ≤10s: (1) trusted-view push,
(2) post-publish pull git-apply 42s/ownership 33s (#573/#670 — largest
number left), (3) git-plan slimming many-repo hosts, (4) commit leg only
after the 101/110-114 corpus read. Open follow-ups: #691 finding 1
(telemetry write amplification), #28 credentials flake (2 sightings),
#664 RSS bar, Mac ignore-counter divergence (no purge from Mac)._

_MORNING: TAIL KILLED (2026-08-14, #690 merged, desktop on 674a2cf): push
wall **58.5s → 7.0s** field-verified (drain_wait_ms 50.8→0.1). Root cause
was NOT a timer: settlement waited at queue-empty behind the 47s pull the
push itself provoked; fix = settle at each operation boundary
(settleOperationBoundary, red→green proven, codex ALIGNED 0 findings,
design 246 amended). THERMO SWEEP RAN (task #15 → #691, 5 new findings):
telemetry write amplification (High, own slice), pending-carry still
reaches doPush via recovery probes (High — catch on our own #685!), false
candidate_projection_ms bucket (delete), _ms labels render seconds, one
real anti-slop line; findings 2-5 cleanup PR in flight (codex). rbox-home
#14 MERGED — next/install.sh serves the real installer again (verified
200 text/x-shellscript). RboxBar signing DEFERRED (no Apple dev account).
Commit-leg guard pinned on task #17: designs 101/110/111/112/114/103
already own payload/parallelism — corpus read required before any new
investigation there. Next sender slices: trusted-view push, git-plan
cy/f/cp, post-publish pull git-apply 42s/ownership 33s (#573/#670)._

_TAIL CONVICTED (2026-08-14 ~06:40Z, #689 merged, desktop on 65e6f60): the
constant ~51s push tail is **drain_wait_ms=50.8** — report/metrics settlement
queued until the NEXT PUMP TICK (≈60s scan floor − op work); ack_ms=0.0 and
publish_transition_ms=0.1 innocent. NOT user-visible propagation: server
published 2350 at 06:36:04, FM adopted +3s, report printed +51s — the bench's
64s sender hop was mostly this artifact (real probe e2e ~15s). Still real:
settlement serializes the lane under sustained writes (bench 10→20→32s
degradation). NEXT SESSION FIRST ITEM: wake the settle path on lane drain
(scheduler-owned, small), re-run 30-attempt bench — expect sender hop ~7-8s;
then trusted-view push + git-plan cy/f/cp. ALSO: credentials fence-timeout
flake hit AGAIN (#689 shard 3, 2nd sighting in 24h, registry says recurrence
bar cleared — owes shard-ordering repro + fix/quarantine)._

_POST-MIDNIGHT BENCH VERDICT (2026-08-14 ~05:30Z, fleet on 26a4de7 + RBOX_TRACE_PROPAGATION=1 restarts; Mac = #664 boot 5): 30-attempt
traced propagation run — **receiver + scheduling SOLVED** (write→settle
491ms, settle→push-begin 200ms, WS→dequeue ≤170ms, apply 3.3s FM / 9.3s
Mac), **sender push op is the whole remaining cost**: 64s on the closing
attempt, FM 11/26 attempts ≤10s, Mac 0/18. Named suspect: a ~40-60s
POST-STATE-SAVE TAIL inside content-carrying push ops (`state-save→end
44.3s` seen solo) that no ms[] bucket attributes — instrument the push
epilogue FIRST, then trusted-view push (kills Mac 2.7-5.2s rescan gap —
spans exonerated lineage/matcher), then git-plan cy/f/cp on many-repo hosts.
Detail + ranking on #661. ALSO SETTLED TONIGHT (short-circuited, no
overnight wait): echo-ring proof COMPLETE (idle FM publishes only real
content post-fix, zero ops=0, b2 never fired — config-authorship suspect
UNCONFIRMED by direct state probe, no fix built); #686 merged (join-ahead
was design-231-correct behavior, scenario now enrolls a 2nd device + pins
the refusal — rig FAST whole, first since Jul 31); #687 merged (RboxBar
ships with every tag — universal, tag-versioned, fail-closed; signing/
upgrade-integration = founder decisions); #688 filed then DE-SCOPED by
founder decision: external users START FRESH on 2.0 (upgrade note deleted;
residual = cheap up-front refusal guard); rbox-home PR #14 open awaiting
founder (next/install.sh served the SPA — one-line redirect); FM churn:
Personal/home-dashboard/build.log rewrites every 10min and wakes the fleet
(ignore-rule candidate, founder's project); Mac RSS 15→19GB across the
evening (#664 watch, now loop-free baseline); Mac ignore-counter 35,723 vs
0 elsewhere — matcher divergence suspicion, do NOT purge from the Mac._

_NIGHT CAP (2026-08-13, fleet now on **26a4de7**, 17 PRs total): **#683 echo
ring + conflict loop FIXED (#685, design 244)** — root cause was NOT the
hypothesized zero-backoff: the desktop published EMPTY sequences forever
(pending git section → divergence "indeterminate" → post-pull re-arm on
`!== "none"` → publish ops=0 → pull own sequence → repeat), and the Mac lost
every 409 race against that churn while each losing push op burned 6 full
git-plans+pulls (MAX_ATTEMPTS off-by-one) with ≤3s sleeps; "next probe in 0s"
was a starved-probe display. Fix: status.ts splits pending-carry (permanent,
suppressed) from transient indeterminacy (still re-arms — review M2
PRESERVED); recovery episode survives a committed-but-unresolved push;
sync-owned 120s elapsed surrender on the internal 409 loop, checked
top-of-loop; b2 instrumentation names any flag-armed empty plan (suspect:
un-ACKed config authorship, `shouldPublishGitConfig` compares base not
advertised — follow-up fix site). Process: 2-lane root-cause (opus +
codex, both refuted my initial theories), codex CHANGES-REQUIRED round
folded, serial confirm ALIGNED zero findings. FIELD: last ops=0 publish was
pre-fix; Mac `syncing normally`, pending drained, first publish in hours
(seq 2227), RSS ~15GB (unmasked from the loop — #664 watch continues,
boot 4). Overnight idle window = final ring proof; b2 line not yet fired.
**#684 merged** (#659 partial): mismatch deferrals now name the differing
paths. **docs/2.0-RELEASE-CHECKLIST.md started** (founder ask): RboxBar
bundling (NOT in release.yml today), #668 next-installer SPA bug, #667
fossil decision, Max/Ryan skew note, rig+regress+RSS gates. Mac ignore
counter 88,888→35,723 post-purge-adoption, not yet zero — re-check after
catch-up settles._

_LATE-EVENING ADDENDUM (2026-08-13, fleet was on **e71eda7**, 15 PRs total):
**savvy-core fleet convergence CLOSED** — final wedge was 3 stale worktree
node_modules SYMLINKS on FM (synced Jul 28, pre-design-224; deletion never
propagated; oracle counted them as extras forever). Removed → carried 103,
savvy out of the deferral list first time ever (evidence on #659; only
Personal/blog remains, the commit-graph issue). Root-caused via out-of-band
oracle probe because follow-classify.ts:138 DISCARDS the mismatch sample
(papercut logged — cheap fix queued on #659). **#681 merged**: bare
`node_modules` builtin matches every entry type at any depth (.git
precedent). **Ignore purge executed** (founder-authorized, full scope):
53,165 grandfathered ignored-but-synced paths deleted from the plane, seq
2209, manifest 120k→67k; zero dir-named stragglers remain plane-wide; FM
adopted in ~15min. **#682 merged** (design 243 r3): git-plan cost
instrumentation — 12 exclusive buckets + state_lineage_ms/matcher_ms spans;
r1's whole-plan reuse gate REFUTED by 2-reviewer wave (plan loop is impure:
crash recovery, 90-day hygiene, cache maintenance) and recorded as rejected
in the design doc. Also: candidate_projection_ms renders SECONDS and spans
the whole candidate transition — prior "projection exonerated" read was
wrong. NEW FIELD BUG (evidence on #661): Mac daemon spent 45+min at 120%
CPU / RSS 22.7GB in a zero-backoff push conflict-retry loop ("next probe in
0s") after the purge advanced the sequence under its 93 pending uploads;
op lane starved, backstop pulls never ran; 3s sample = 1826/1826 frames one
JS stack (/tmp/rbox-hotloop-sample.txt on Mac). Restarted onto e71eda7 =
fuse-acceptance boot 3. Flake sighting logged (credentials fence-timeout,
3rd distinct test in that file). Desktop's synced-conflict litter (38
.conflict.* files) swept from rbox-core checkout._

_MARATHON DAY CLOSED (2026-08-13 evening): **11 PRs merged** (#643-#657
range), fleet fully deployed on d44e267. SHIPPED: fossil-litter class dead
(#650, field-verified); Darwin bulk scan default-on (#651); Linux walk 5.25x
+ watchman-hijack pin (#652); attribution differential canonicalized (#653);
daemon pump-join REAL bug fixed (#654 — awaited pumps resumed before queued
pulls ran; found chasing a "flake"); #641 held-skip convergence regression
fixed ISOLATED, 8ms skip preserved (#656, design 241, bisected via rig
oracle in 6 probes); watcher fuse fix BOTH slices (#657, design 237: episode
coalescing 11/11 historical fuses prevented in replay + supervised re-arm
with 9-condition witness gate; 5 design rounds + 3 impl rounds).
ACCEPTANCE CLOCKS RUNNING: Mac boot-fuse watch (5 boots, target 0 fuses;
boot 1 = the 19:0xZ deploy restart); Mac RSS <8GB/24h; FM pending lanes
(savvy-core/blog) did NOT self-clear in 8min post-#656 — carry shape may
need a publish jolt or is a sibling bug (task #22 watches; quiet-moment
take-theirs is the fallback). OPEN: task #25 git-join-ahead rig regression
(binding ambiguity, PASS Jul-31 → FAIL now, bisect recipe in scratchpad
pattern); shard state-leak fix in flight (worktree shard-leak, codex,
founder-ordered proper fix); rig 6/7 green (join-ahead only). OPS NOTES:
mass branch deletion (281→14, recovery map ~/rbox-branch-cleanup-recovery-
20260813.txt) starved GitHub event delivery — fuse-episodes branch never got
CI, re-minted as fuse-episodes-ci (papercut). Sender pipeline (~10s push)
remains task #17's last mile to ≤10s e2e._

_E2E RE-MEASURED POST-FIXES (2026-08-13 13:00Z, 3 serial trials desktop→fleet):
median **13.1s** (was ~32s round-6; FM 11.8s, Mac 14.4s). Receiver is no longer
the bottleneck: publish→file-visible 1.6-1.7s FM / 4.2-4.3s Mac. Slowest hop =
sender push ~10s on an 89-byte change (commit 3.3s, git-plan 1.3s, upload 1.0s,
state-save 0.8s) — task #17's remaining half. Reverse Mac→fleet was 50s because
a 33s git-apply-heavy pull held the push lane (Mac watcher fused AGAIN within
2h of restart, RSS 10.5GB — task #22). Also: desktop daemon lost
RBOX_TRACE_PROPAGATION on its 11:34 self-restart, so scripts/bench/propagate.ts
correlation is INVALID until a restart with the env set. Savvy-core converged
fleet-wide (first-ever successful keep-mine, seq 2065); FM has a benign stale
pending lane to take-theirs in a quiet moment (same signature as blog's).
Task #21 verified IN SOURCE: parcel-watcher checkpoint-resume is real journal
replay on macOS (GO with fail-closed harness), disguised full scan on Linux
(NO-GO); Darwin bulk-walk ALREADY BUILT (design 107, 42% faster, now default-on
when supported); watcher passes only globs so
FSEvents gets zero kernel-level exclusions (free fix, helps live watcher)._

_RECEIVER SOLVED + SAVVY-CORE UNWEDGED (2026-08-13 overnight). LATEST
NUMBERS (FM, traced): pull wall **8.4s** (was 14-24s; round-6 apply span was
22s), cas acquire **0.1s** (was 7.7s), state-save 0.9s, unattributed ~0.3s —
every receiver second is now named by the merged timer stack (#643 phase
timers → #646 automatic gap accounting → #648 CAS step timers). Remaining to
the founder ≤10s e2e: the SENDER (~10s push op; Mac pushes also show a
state-load→git-plan ~3.3s gap — same gap instrument works there).
ROOT-CAUSE CHAIN (all evidence in docs/papercuts.md + issue #647 + task #22):
FM's savvy-core carried a 411-491-ref partial that was RE-AUTHORED every pull
from the remote section (local surgery of partial/pending insufficient by
design), costing 501 state-CAS locks × full-journal-rewrite+fsync each =
7.5s/pull. Unwedge sequence that finally worked: state surgery via the
store's own APIs (loadRawState + applyStateSavePacket, script pattern in
[[state-surgery-over-front-doors]] memory) marking the repo repoAbsent +
parking FM's .git OUTSIDE the workspace (~/savvy-core-git-final-20260813) →
fresh-join semantics → tax dead. FM savvy-core is currently GIT-LESS (files
sync fine); re-adopt it via the planned `rbox git reset` command, NOT by hand.
MUST-DO QUEUE (tasks #20/#22 + issue #647 hold the detail):
1. `rbox git reset <repo>` — productize tonight's surgery (founder: "we
   can't expect others to do this"). Task #22.
2. #647: take-theirs self-invalidates at the locked boundary (token echo
   proof in the issue) + resolve must quiesce the daemon itself.
3. DONE 2026-08-13: #650 (design 236) — concluded-op fossils never defer
   (REBASE_HEAD reclassified, waiver widened at 3 sites, epoch bump
   converges wedged repos, deferrals name worktree/file). FOUNDER DECISION
   SCOPE: fossil disposal approved for the DEV FLEET via merge-to-main
   only; shipping it to external users is decided at the next stable
   release tag (which needs its own fresh yes anyway). Pre-existing
   presence-vs-value hole documented in 236 §3.2c, filed to the
   git-resolve rig-suite candidate. `rbox git reset` DEFERRED by founder
   step-out ruling — prevention first; revisit only if wedges persist.
4. Carried-unchanged partial must not re-prove/re-lock per pull (held-skip
   semantic-key pattern) + batch the per-lock journal fsyncs — kills this
   tax class even while a repo IS wedged.
5. Full-bundle fallback for connectivity-failed receivers + commit-graph
   poisoning self-heal (both hit tonight; detail now surfaces in refusals
   via #648).
6. Mac: fuse-loop (4x/night, RSS 8-10GB, un-timestamped crash line) — task
   #22; case-folded branch dirs (brianvia vs BrianVia) broke BASE pre-state
   proofs on linux FM — design-234 rig fixture.
Cross-refs: design 235 (Phase B constraints §5), memory
state-surgery-over-front-doors + git-resolve-needs-real-rig-suite, PR #648
(step timers + refusal detail), #649 MERGED (auto GitHub Releases)._

_STATE-PLANE REGRESSION FOUND + HALF-FIXED (2026-08-12 evening): the "~10s
reconcile/oracle" receiver mystery decomposed. Designs 202/203/204 had receive
at ~4.5s in July; the 2.0 SQLite state plane regressed it (~22x slower save
than legacy JSON: 5.8s vs 0.26s at 119k, measured). #644 (MERGED) recovered
half by constant factors (insert-time digesting — digest values unchanged,
RBOX_STATE_VERIFY_STAGE=1 restores forensics — batched inserts, faster codec):
steady save 5.4s→2.3s, load 1.3s→0.37s; field-verified on FM (state-save
0.9s). #643 (design 235 Phase A, ALIGNED r4) MERGED: per-stage pull timers +
phase_ms on apply_complete + report table. FIRST FIELD TABLES: validate 0.3s /
reconcile 0.2s are INNOCENT; ~6s/pull residual (unwrapped code between
phases) is the top bucket, and FM services multiple folder BINDINGS serially
per cycle (12s each → the 22s round-6 apply spans). #645 (open): #643's
snapshot ran inside the adoption callback's try/catch — a failure silently
suppressed onPullAdopted (carrier credit = behavior); fix degrades to bare +
warningSink, field-verified on FM. Design 235 doc: mechanisms NOT ratified
(232 knife); §5 holds 9 binding constraints for Phase B; next evidence step =
wrap the residual + weigh binding serialization. Bench:
scripts/bench/state-plane.ts. CI was an infra-flake day (see papercuts).
Fleet on dc8419e dev builds; Mac BACK ONLINE (SSH PATH fixed via ~/.zshenv);
FM has transient ResetMemoryAdmission refusals (papercut)._

_SHIPPED v2.0.0-beta.2 to next channel (2026-08-12): #641 held-skip stack —
four field-tested layers (semantic key excl. transport identity; RBOX_TRACE_HELD
diagnostic; skip decision hoisted BEFORE fetch/classify; legacy-attempt upgrade
+ blocker-plane retention). FIELD PROOF: savvy-core 9,381ms → 8ms per pull.
LESSON (cost 3 dud fixes): green tests lied because the harness bypassed the
real applyPulledManifest disk path — red-first against live-shaped fixtures is
now the rule for this plane. GitHub Releases panel now gets an entry per tag
(beta.2 + backfilled beta.1); automating that in release.yml is a follow-up.
Fleet: FM on the stack (c870922 dev), desktop updated post-release; echo-loop
dead; trust healthy. REMAINING to ≤10s: sender push op ~9-10s (commit 3.3s +
pipeline), receiver reconcile-over-119k (~10s) = task 17's fast-path; then
30-attempt acceptance. Also queued: thermo sweep (15), Mac reinstall when
reachable, GH-release automation._

_ROUND-6 VERDICTS (2026-08-12, 9 exact samples, founder called shape early):
e2e median ~32s (31.0-35.5 band, one 93s tail from a single heavy push
cycle). Hops: sender WAIT ~0.3s (dead — was 93s); push op median ~9.9s
(pipeline: git-plan 1.1 + upload 1.0 + commit 3.3 + state-save 0.8 + ~3s
inter-phase); FM apply flat ~22.4s regardless of delta (scan 0.0s — trusted
view perfect; git-apply 9.6s DESPITE queue-gating — find why repos still
enter; ~10s unaccounted = reconcile/oracle over 119k, dissect from full pull
line). GATED-MECHANISM RULINGS per the knife: notify fast-lane DEAD; sender
priority DEAD; res fix deprioritized (trusted scans are 0); drop-attribution
stays telemetry-only; DELTA-SCOPED APPLY (reconcile fast-path) EARNED —
receiver budget is founder-set: cost scales with delta size, never workspace.
BUILD NEXT: (1) dissect FM's 22s from the full pull phase line → reconcile
fast-path PR + git-apply queue-entry cause; (2) sender pipeline trim (commit
3.3s + overhead) — target push op ~4-5s; together ≈ e2e under 10s for small
deltas. Then thermo sweep (task 15) + Mac when reachable._

_POST-FIX AFTERMATH (12:40Z): trust SELF-HEALED fleet-wide once the loop
died (local=trusted both linux hosts) — every scan-heavy measurement was the
loop's shadow. Fresh n=1: **e2e ~33s** (write 12:37:34.7 → FM adopted
sequence 1786 at 12:38:08.1), sender 10.4s (push op 9.3s), FM pull 24s
(reconcile still indexes full 119k manifests even trusted + git-apply queue
over ~100 unchanged repos). LESSON: measure after every fix — 127s was stale
within hours. BUILD ORDER (founder mantra applied): (1) fingerprint-gated
git-plan queue FIRST (small, hits both sides); (2) re-measure; (3) minimal
reconcile fast-path only if demanded (denominator = full base.files.length,
O(1) — satisfies R1 mass-delete requirement cheaply; oracle threading is the
deep part, build last or never); res fix deprioritized (untrusted/boot only).
Bench collector still misses joins sometimes (cosmetic; logs authoritative).
Task 17 carries the full plan._

_ECHO LOOP FIXED + FIELD-VERIFIED (2026-08-12): #638 merged — owned-ref
boundary suppresses the daemon's own packed-refs.lock click during scratch
pins; reconcile-on-exit keeps design-175 latency for real changes; regression
pair + design note 233. Deployed desktop+FM (2.0.0-beta.1-dev+7617c03);
verified: push rate ~100/5min → 4-6/5min. POST-FIX BENCH (n=1, exact
sequence join WORKS): end-to-end 127s = settle→push-begin 93s (push queued
behind ambient scans — sender-side priority is the new named target) + push
op 10.6s (was 125s in loop era) + WS 1.1s + FM apply 22s (res buckets on FM
log will name it). Clock-skew gate needs slack (250ms too tight for real
hosts). NEXT: 30-attempt authoritative run, hop attributions, THEN gated-
mechanism verdicts. Mac still off-network._

_BUSY-LOOP HUNT STATE (09:30Z, evidence-complete, cause one step away):
Desktop loop STOPS when session commits stop (windows track my activity); FM
loops INDEFINITELY with zero user activity — the clean specimen. FM trace:
git_armed:0 git_fired:~740ms EVERY cycle — the cycle's own work trips the
linux git-ref fs.watch channel, arming the next cycle. inotifywait on
savvy-core/.git during a live window: ZERO events — the writer is NOT the
deferred repo's .git. NEXT MOVE (fresh context): wide inotifywait across all
FM watched ref roots + the git-ref-watch floor/continuity files
(git-discovery-continuity.ts, linux-only) for ONE cycle; the path that fires
names the fix. Note: Mac (darwin, no fs.watch channel) does NOT loop —
channel-specific. HOLDING ACTION: none taken — loop is CPU/log burn only,
data safe, both daemons otherwise healthy; do NOT leave FM like this longer
than a day._

_REGRESSION FOUND (2026-08-12 ~09:30Z, PRIORITY FOR NEXT STINT): **no-op
push busy-loop on BOTH linux daemons since the 231-activation build went
live.** Evidence: desktop daemon-2026-08-11.log has 12 pushes total (all
post-upgrade ~23:40Z); daemon-2026-08-12.log has 7,003; FM 8,039. Cycle every
~3-4s, files=0 blobs=0, each ~2-3s of git-plan work. Signature: sp1/sp2
(sections pending) on every line; each host carries exactly one deferred repo
"carrying pending verbatim" (desktop: Personal/rbox-core; FM:
Dfinitiv/savvy-core). HYPOTHESIS: activation-era code re-arms push while a
pending git section exists; push cannot supersede the deferred section; loop.
Repro likely: any workspace with a standing git deferral on the post-#632
build. Suspect surface: push completion → requestPush re-arm interaction with
carried-pending sections (sync-git plan/publisher), NOT the trace (loop
predates today's #637 by a full night). COST: CPU/battery/log spam on 2 hosts
+ defeats bench correlation. Mitigation candidates for next stint: bound
re-arm when plan is no-op with unchanged pending fingerprint; or resolve the
two standing deferrals to starve it (but the bug remains for any future
deferral). Fix properly, add to design-234 fixtures._

_ROUND-6 THREAD STATE (09:25Z): sender cycle-join fix landed (0424ad12f)
but n=1 rerun shows write@09:20 never matched a publish; desktop
propagation_trace shows the daemon pumping every ~3-4s (cycle 1083+ in 78min)
REPUBLISHING sequence 1754 as no-op pushes — either session-churn-fed or a
real busy-loop; ALSO possible K5 join over-strictness when sequences repeat.
NEXT STINT: (1) read the 09:20-09:25 trace window + push logs to split
busy-loop vs churn and find where the bench write's commit went; (2) loosen
join if needed; (3) 30-attempt Monitor run; (4) Mac still unreachable —
post-#637 traced build pending there._

_ROUND-6 FIRST LIGHT (2026-08-12 ~08:12Z, desktop→FM, post-#637 traced
daemons): END-TO-END 109s. Hops: settle→push-begin 44.7s; push op itself
125.6s (git-plan sweep over ~100 repos — the real-fleet cost containers never
see); WS receipt→dequeue 253ms (spine is PERFECT); dequeue→apply 23.6s.
VERDICT SHAPE: budget is eaten INSIDE ops (sender push duration + receiver
apply), not scheduling/notify — res/git-plan per-repo cost is where ≤10s
lives; notify fast-lane heading for deletion per the knife. Remaining: sender
cycle-join exactness fix (matched a neighbor cycle's settle), 30-attempt
authoritative run, Mac (unreachable ~08:00Z, needs post-#637 build + traced
restart when back). Bench sender-await fix committed on main._

_SESSION 2026-08-12 (kernel): **232 KERNEL MERGED (#637).** Residual-bucket
scan accounting (warm zero-hash overhead <3% amended gate, authoritative
off-CI only — CI runs structure-only scaled fixture), watcherTrust ambient
visibility, RBOX_TRACE_PROPAGATION seams, rig per-hop sequence-joined
propagation verdict (report-only until n>=30), fleet SSH bench
(scripts/bench/propagate.ts). Serial opus review DO-NOT-SHIP round folded:
per-file hash/stat interleave RESTORED (batching had widened the mid-write
window — the kernel's one behavioral sin, reverted), apply-complete emits on
SEQUENCE ADOPTION (ref-only pulls correlate), suspect no longer escalates the
brief headline, stale trace cycles reset. Rig: repeated zero-FAIL; full suite
5,208/0. IN-CONTAINER propagation already ≤10s on all stimuli. NEXT: (1)
thermo-nuclear sweep (founder-queued, task 15); (2) ROUND-6 fleet bench —
dev-install the post-#637 build on all 3 hosts, then
`bun scripts/bench/propagate.ts LOCAL:~/Development dfinitiv-macbook-pro:~/Development flat-meadow-prod-main-01:~/Development --attempts 30`
— its per-hop numbers decide which gated 232 mechanisms get built (anything
not demanded gets DELETED from the design). Background-task killer still at
large: long codex/bun background runs die; workaround = foreground
micro-dispatches <10min._

_SESSION 2026-08-12 (cont): DESIGN 232 MERGED (#635, ALIGNED r3 —
instruments-first kernel, all mechanisms evidence-gated on round-6 bench).
Docs truth sweep MERGED (#633); four stale docs deleted; help copy tweak
merged (#636; #634 was accidentally closed by premature branch deletion — cleanup now waits for API-confirmed MERGED). Desktop cleanup: 21/22 stale agent worktrees swept (2 dirty
skipped: agent-ad2a9aee, ~/agent-work/526-republish). rbox git resolve
keep-mine REFUSED on the live repo — "incoming-versus-local comparison could
not complete; retry after Git state settles" while a session actively commits;
guidance text loops back to preview. Recorded as the motivating fixture for
design 234 (git-resolve rig). The config-step pause (git config parse-error,
latched since 07-29) still stands — same 234/parse-error hunt. Next session:
implement 232 kernel slice 1 (bench + tracing), then round-6 numbers._

_DECISIONS 2026-08-12 (founder): (1) RBOX_KEY posture — non-issue; keep the
feature as-is, existing README caveat suffices, NO rotation requirement now
(founder: don't overcomplicate). (2) Four
wholly-stale docs DELETED (rbox-architecture.md v1 draft, roadmap.md,
go-live-todo.md, apps/web/README.md) — go-live-todo's live finding (the
RBOX_KEY gate) is captured here. (3) Desktop rbox-core cleanup approved:
sweep 22 stale agent worktrees + run git resolve + chase config-txn
parse-error. (4) #632 help copy approved with one tweak (bound→existing
synced folder)._

_SESSION 2026-08-12: **v2.0.0-beta.1 LIVE on the next channel** (tag on
af2168020 after fixing upgrade-test fixtures that choked on a prerelease
checked-in version — parseSemver, not split-map). Propagation benchmarked on
the blog repo (5 rounds): FM 32-115s; Mac 266s→171s after finding the Mac
daemon in TERMINAL `trustState=fused` (FSEvents overflow storm during the 231
upgrade blew design-104's one-way retrust fuse; restart resets; slow-Mac
triage = check trustState FIRST). FOUNDER YARDSTICK SET: ≤10s end-to-end
propagation, fully reactive (watch→push→DO→WS→trusted pull). Round-5 hop
forensics: real work ~5s; waste = sender 60s pump pacing, notify queued behind
108s in-flight pull (notify_latency_ms=94145), applying pulls still run ~60s
scan/res over 31k files despite watcher trust, savvy-core AUTO_MERGE deferral
taxes 37s git-apply per pull. QUEUED as one propagation/Mac-plane dev cycle:
push-on-quiesce, delta-scoped pull apply, notify preemption, supervised
watcher retrust (amends 104), FSEvents boot journal, savvy-core resolve +
founder-requested git-resolve rig suite (two-VM astray-commit scenarios).
Also: Mac daemon RSS 9.9GB flag; desktop rbox-core git deferral cleanup still
pending founder go._

_SESSION 2026-08-11 (later): **DESIGN 231 ACTIVATED — #632 merged; config.json
is the live folder authority. Workstation upgraded and verified.** One atomic
PR (7 staged commits, codex implemented / Fable folded): single-file authority
(absent|authoritative|damaged, no marker), inventory union, write-side +
runtime switch (one pinned admission per op; v0.9.2 reload shape kept), rbox
config/add/regenerate/repair commands. Review: 2 opus lenses + codex (12 ruled
findings folded) + final serial opus review (DO-NOT-SHIP → 6 more fixes: halt
precedence N1, tolerant union reads N2, repair lock order N3, recycle backoff,
corrupt-binding add, policy-stamped caches) → shipped. Validation: 5,197/0
full suite, regress 11/11, docker rig e2e, all on final tree. FLEET TRIAL:
via-desktop DONE (snapshot ~/rbox-pre-231-snapshot-20260811-194119.tar.gz;
regenerate clean, ghost /tmp row skipped by name, sync + daemon green on
1.11.4-dev+59c2552). FLEET TRIAL COMPLETE same evening: MacBook + flat-meadow also upgraded,
regenerated, and syncing (FM cleared a 17k-file backlog; its old daemon had
crashed under a canary-bun self-build — papercut logged, shipped the
desktop's stable-bun binary instead). Snapshots on all three hosts. Release: founder
chose next-channel v2.0.0-beta.1 for 2.0-dev distribution (tag needs fresh
explicit yes). OPEN for founder: help copy at FOUNDER-SIGN-OFF comments;
ruling that `git resolve show-me` requires admission; release note re one-time
hashcache discard on upgrade. Deferred: generation-vs-recordFolder/untrack
race fixtures. FOLLOW-UPS from post-upgrade fleet watch: (1) desktop rbox-core
git-sync chronically deferred — 22 stale agent-* worktrees in the primary
checkout (one holds adopt-journal-batching, clean, 1 unmerged superseded
commit); sweep + rbox git resolve WITH founder go; (2) `config disabled:
parse-error` latch in engine/git/config-txn.ts survives daemon restart on the
same repo — likely real validator bug, hunt separately; (3) FM local bun is
canary (crashed its self-built daemon) — pin to stable or guard dev-install. NOTE: long-running background tasks (codex + bun) were being
externally killed all evening on this host — cause unfound, worked around
with short dispatches + foreground runs._

_SESSION 2026-08-11: **Design 231 (folder config authority) rewritten for
the pre-2.0 breaking posture and two slices shipped.** Founder decision
(standing, general posture): pre-2.0, breaking changes beat legacy migrations —
3 external users, all manually fixable; recorded in AGENTS/CLAUDE "Simple
primitives, less code" section (`74f8faff1`; ask "simplest off-the-shelf?" +
"remove dumb requirements?"; SQLite for internal state, JSON only for
human-edited records). MERGED: #629 slice-1 catalog foundation (size-gate
split into folder-config + folder-config-codec), #630 FolderInventory
read-only wrapper (opus review caught a CRITICAL: malformed workspace.json
emptied machine triage; fixed + regression test; also fixed pre-existing HOME
env leak in login-device-fsm.test.ts — 4 more leaker files logged in
papercuts), #631 full in-place doc rewrite (3 codex rounds to ALIGNED,
REVIEW-231-R4..R6): no marker file, no compatibility projection, states
absent|authoritative|damaged, fresh machine generates silently, machine with
bindings errors toward explicit destructive `rbox config regenerate`.
DISCARDED unmerged: slice-2 projection interface (existed only for downgrade
compat). IN FLIGHT: opus file-level plan for §11 slice 3 — ONE atomic
activation PR (delete dormant marker/candidate code, full inventory union,
generation, runtime switch, move/copy repair; all §12 gates incl. rigs
pre-merge). THEN founder-authorized fleet trial: rig → workstation → MacBook →
flat-meadow last, pre-upgrade snapshot (tar ~/.rbox + per-folder .rbox) each.
Earlier same session: #628 folder-first review, #627 nits, FLAKE-007 Bun
canary forensics._

_SESSION 2026-08-03 (later): **2.0 MERGED INTO MAIN (#623, squash `098d00643`)
— the U3 line now ships from the integration branch.** Branch tip preserved as
tag `archive/2.0` (repo forbids merge commits); `origin/2.0` can be deleted
(classifier blocked the agent; run `git push origin --delete 2.0`). Conflict
port (opus lane): main's #620 ORIG_HEAD waiver moved into `follow-classify.ts`,
#617 copy kept in the consolidated help registry, fairuse #603/#618 taken
as-is; #606's growth of `engine/git/capture.ts` (402 lines) tripped 2.0's new
size gate → allowlisted + ratchet-pinned. Full CI green on the merged tree.
Also **docs reorg (#624)**: 96 loose `REVIEW-*.md` → `docs/design/reviews/`,
root SPEC/CODEX strays → `docs/design/notes/<N>/`; repo root is down to
AGENTS/CHANGELOG/CLAUDE/README. OPEN: product-model discussion (Max's
feedback) — leaning "one folder, workspaces demoted to internal"; no design
doc yet._

_SESSION 2026-08-03: **PR #621 (codex 60-file CLI/daemon runtime-primitives
refactor on 2.0) reviewed, remediated, MERGED — plus #619 (rules port) and
#622 (file-size ratchet).** 5-lane adversarial review (deletion evidence /
receive path / concurrency / test integrity / doc honesty) + independent codex
pass. Receive path + mutex PROVEN preserved (old assertions re-run against new
code; 11 mutations red; daemon.ts/sync-mutex.ts byte-identical). 4 real
regressions found in the OBSERVATION layer, all fixed on the branch before
merge: daemon-startup blind window (binding deleted at spawn, rewritten only
after HashCache.load — doctor silenced a real halt; fixed both halves),
doctor rebind race (revalidation used captured workspace id; could leak prior
workspace's sidecars into --diagnostics), status lost version+upgrade-nudge in
5 states (test had been RELAXED to match), multi-site RBOX_ALLOW_MASS_DELETE
consent untested (env reads deletable, 492 green). Docs: 226 §12–13 rewritten
as literal runs (its baselines didn't reproduce — a pre-#615 8-failure
baseline re-asserted as current); REVIEW-226-R1/R2/R3 self-ratification files
deleted from corpus. Rig onboard-smoke PASS on the branch (2 devices, 101
files byte-identical). **Bun Rust-rewrite drift LANDED**: canary 54bbd5dd9
finalizes outstanding statements at close() (older canaries deferred);
sqlite-contract re-pinned to the shared subset — statements.ts unaffected
(explicit finalize, #615). CI canary shards are the deliberate early-warning
lane; the 1.3.14 floor job is the pin — do NOT try to pin canary (tag is
overwritten, not addressable). #622: allowlisted files now ratchet — >10%
growth past recorded size fails the build. 2.0 tip: bc25d930f. Flake registry:
design-206 trusted-pull SIGHTING (shard fail, rerun green, no local repro).
Standing: parallel-wave review verdicts get ONE serial pass before ruling;
codex self-review docs never land in docs/design/.**_

_SESSION 2026-07-31: **The quota arc CLOSED. Billing flip shipped to PROD
(#618, design 228, migration 0036): rbox bills/shows/cap-gates on ACTIVE bytes
— founder billed 4.16 GB (was 158 GiB), Max 0.13 GB (was 186 GiB). R2 reclaim
COMPLETE: 1,138,143 objects deleted of 1,180,875, zero errors, 6h54m (42,732
deliberate skips: 40,727 pack members, 2,005 no-candidate). v1.11.4 released:
a concluded merge's MERGE_MSG/AUTO_MERGE fossil no longer blocks `rbox git
resolve` (Max's 7-day supabase-cli wedge; classification now matches git's
wt_status; REBASE_HEAD deliberately stays in-progress per design 126 gate).**_

_**#618 mechanics (do not re-litigate):** billable = MAX(0, used_bytes −
history_overhang_bytes), overhang forgiven ONLY on paid plans (locked 1-byte
fence stays airtight); single writer = fairuse completeScan 2-stmt batch
(lease-guarded) writing bytes + measured_at together; 0036 backfills both from
each account's latest completed scan; advisory checks and the D1 cap-guard
trigger evaluate the identical expression. Admission STAYS on the live
used_bytes counter (commit-time active_bytes settled unsound). Known accepted
gaps (design §7): cross-workspace double-count understates overhang
(revenue-safe); >64-workspace accounts never scan; plan cap no longer bounds
physical R2 (365d retention is the only bound — founder-accepted). Dev-verified
with real trigger writes before promotion; 2-lane review (codex+opus, 4
defects folded) + final serial._

_**v1.11.4 (#620):** rig FAST 7/7 + new `git-stale-opstate` scenario (2-device,
22 steps: fossil wedge → keep-mine publishes → converge; real MERGE_HEAD still
refuses). Fossil-only repos self-heal in the follow lane; index-divergent
repos still take ONE explicit keep-mine (founder decision). QUEUED next:
**auto-resolve-with-recovery-shelf design cycle** (grace period + other-side
idle + loud both-machine surfacing + one-command undo — design doc to founder
before code). Max's remaining steps relayed: `rbox upgrade` → `keep-mine` on
isotopes/supabase-cli → optional `rbox ignore --purge` for 33,168
carried-forward ignored files (his 3-4 GB/h churn was Electron/AppImage build
outputs; it stopped 07-30 ~17:00 UTC). Papercuts logged: resolve's 0.8s mutex
wait (unconfirmed pass should get the 60s deadline), silent 7-day wedge._

_SESSION 2026-07-30: **v1.11.2 released and promoted; Phase 2 GC unwedged
(#616, purge OFF); the 349 GB R2 reclaim ~30%+ done; the mint-after-delete ABA
closed; two fleet incidents (flat-meadow OOM-refusal, a 46k mass-delete halt)
resolved.** Continuation of the 07-29 quota arc._

_**RELEASED + PROMOTED.** `v1.11.2` (84a045ab) tagged after rig 7/7 + regress
all-PASS; published to stable; fleet rebuilt to `1.11.2-dev+*`. Production
promoted TWICE with founder yes: 84a045ab (ships #602/#603 server-side;
migration 0035 applied; verified via /version + pragma) and 3820a63f (#616).
Max nudged to upgrade (was still 1.11.1 with a 172h `local-index` deferral —
watcher armed for his version flip)._

_**#616 (design 227) — Phase 2 GC unwedge, the premise-collapse story.** GC
was dead since ~07-20: `GC_BUDGET_SAFE=800` sized for Cloudflare's OLD 1,000
subrequest ceiling; paid plan has been 10,000 for months (design 112 already
recorded it). An earlier 227 deleted the reachability belts to fit the phantom
ceiling; 3 review lanes attacked it and codex falsified the premise instead.
Shipped inversion: KEEP every belt, one exported budget owner (maxW 8→88),
D1-transaction-evaluated time guards everywhere the delete-fence argument
needs a clock (a Worker can stall between any two awaits — JS-side checks
cannot guard later durable writes; closes a PRE-EXISTING mint-after-delete
ABA), account-delete purges DOs before dropping refs, gc-health workspace warn
deleted. **Purge ships DISABLED** (`RBOX_GC_PURGE_DISABLED="1"` — it was "0"
and armed!). Re-enable = §4 sequence: drain done → audit dry-run → supervised
execute → 48h soak → founder yes. Settled (do not re-litigate): no kind filter
on openIntents; zero new time constants; time checks are D1-evaluated._

_**R2 reclaim (founder-authorized).** Batched node worker (S3 creds DERIVED
from the CF token — key=token id, secret=sha256(token); founder rule: run
own-infra ops directly, see memory) deleting 1,180,875 aged candidates at
~60-113/s after a 131M-row-read fix (blob_refs has NO sha256-only index — a
correlated subquery per sha = full scan; rewrite to chunk-materialized
non-correlated form = 900x. Future cheap migration: index on
blob_refs(sha256)). All four safety proofs zero before start; live per-chunk
D1 recheck; audit TSV. Pre-reboot runs deleted ~28k (NOT ~2.1k as first
recorded). Excluded by policy: 151k too-young (Phase 2's own 8d gates), 40k
packed. Monitor posts 50k milestones._

_**Fleet incidents.** (1) flat-meadow dark 9h: crash-loop on
`ResetMemoryAdmissionError` — 80MB state × 52 needs 4.2GB vs budget
totalmem/4 minus own RSS; recurrence of the 07-19 class. Band-aid:
`RBOX_RESET_PARSE_BUDGET_BYTES=6442450944` in ~/.profile + restart. Structural
fix (budget shrinks as own heap grows) queued as design item. (2) Desktop
`attention: halt`: founder's interactive `rm -rf` of 13 retired Dfinitiv
worktrees = 46,735 deletes; push breaker refused correctly; founder chose
propagate; released via `rbox sync --allow-mass-delete`; stale halt banner
needed a daemon restart + one cycle to clear. Papercut logged: intentional
deletions need a visible propagate-or-not surface (NOT a feature request —
founder explicit). (3) Mac 3,949s "client-apply": ONE outlier sample, host CPU
starvation (load 28/12 cores, runaway cmux+logd, rbox nice+10) — not an rbox
bug; recovered alone. Dashboard note: p95 over 11 samples = max; and
`residualMs` swallowed 19min inside one repo's git-apply (observability gap,
queued)._

_**rbox-admin #12 MERGED (founder: "do whatever you want in rbox-admin"):**
accounts now show billed (`used_bytes`, still gates) AND "Active data" (latest
completed fairuse scan) with "Pending first scan" fallback. Prod's first
active-only scan watcher armed — expect founder ≈3.9GB vs 159GB billed.
Billing-flip design is the remaining piece (precondition met once scans
complete; admission stays on the live counter, display/cap comparisons move
to active)._

_**#617 OPEN — resolve copy names machines, never "theirs"** (Max, verbatim:
"who is they? I am me. I am also me on the other computer."). Local hostname
named; remote side directional ("your other computer") because the publisher
deviceId is verified then DISCARDED in latest() — wire follow-up recorded.
Hostname kept OUT of --json and the shareable brief (privacy guards)._

_**Queued, in order:** billing flip (one design cycle) → GC supervised
re-enable (founder yes) → `rbox git resolve` cycle (both machines hold
CLI-unresolvable deferrals; `refusalMessage("local-commits")` LIES — it is a
reason-keyed refusal, not a detected change; Mac/FM rbox-core git plane pinned
at 3b685d5 by the desktop's 2.9d `local-index` deferral + config parse-error
lane over the 512-key wire bound) → flat-meadow memory-admission structural
fix → blob_refs(sha256) index → git-apply residualMs observability._

_**Host notes:** desktop linuxbrew `node` BROKEN (GLIBCXX/GCC mismatch) — use
`/home/via/n/bin/node`; already bit wrangler and typecheck. tmpfs /tmp hit
ENOSPC once during parallel sorts (31G, transient). Reboots wipe /tmp
scratchpads — reclaim tooling regenerates from D1 truth by design._

_SESSION 2026-07-30: **U3 WAVE 5B IS OPEN — `rbox migrate` EXISTS AND THE
MACHINE IS DRIVABLE BY A HUMAN.** Branch `u3/u3-5b-operator` off `origin/2.0`
(`c19189c8`). Three commands landed on 222 §3.2/§7.3: foreground `rbox migrate`,
`rbox doctor --retry-state-migration`, `rbox doctor --abort-state-migration`,
plus doctor's own read-only `migration` check. The §7.9 "exactly two entry call
sites" gate now ASSERTS TWO (`state-plane-cmd.ts`, `upgrade-state-window.ts`)
with three conjuncts — file set, one call per file, one construction site per
`EntryPoint` literal — because the file-list-only form it replaced would have
passed for one site with the list edited in the same commit._

_**THE ACCEPTANCE RUN: `rbox migrate` CONVERTED THIS HOST'S REAL 81 MB
WORKSPACE THROUGH THE SHIPPED COMMAND.** `scripts/snapshot-replay` now drives
`migrateCmd` rather than mirroring what an entry site would do. On a sandboxed
copy of `/home/via/Development` (81,122,599 bytes, 145,913 entries, 101 repos):
exit 0, 8 phases, 38 s; all 11 fidelity verdicts pass (integrity_check,
foreign_key_check, source sha256, semantic digest store↔legacy and
store↔completion, entry/repo counts, source bytes, store authority id); strace
isolation clean. **A SECOND `rbox migrate` on the result exits 0 with "already
in rbox's new format"** — which is the re-entry debt closed, see below._

_**222 §3.2's ANNOTATED POST-`Q` DEBT IS CLOSED, NOT DEFERRED — it was never
separable.** `inspectInventory` raised `StateFormatTooNewError` on an authority
marker, so **no lock bundle was obtainable on a migrated workspace at all**:
`rbox migrate` could not report success on its own work, and
`durability-indeterminate`/`cleanup-deferred` — the only two halts expressible
after the flip — were unreachable by the `--retry-state-migration` that exists
for them. Fix is derivation, not a second inventory: the read goes through the
selecting whole-state seam (`loadRawState`), which answers both formats with one
signature._

_**COPY DEBTS PAID (222 §6 amended with evidence).** `reserved-path`'s
"rbox found an unexpected file" was **factually inverted** for 163's
authority-matrix row 17 (no file at all) and for every corruption verdict routed
through that code — it is the taxonomy's catch-all, and its `command` was
`rbox doctor`, the surface printing the message. `measured()` rendered
`source-oversize` **backwards** (the record's `required` is the document size and
`available` is the 512 MiB cap) and leaked the literal word "unknown" into user
text. `underlyingCode`'s stable tokens from #610 (`completion-tuple`,
`semantic-digest`, `integrity-check`, …) are now rendered in plain English —
`verification` alone covers seven distinct refusals and printed one sentence for
all of them. `nothing-to-abort` renders distinctly instead of telling a pristine
workspace its records were migrated. `retirement.ts`'s halted-retirement detail
named `rbox doctor` where 163:3461 makes `--retry-state-migration` the only thing
that clears a halt. New `source-unreadable` message: 163's malformed-JSON row was
escaping the commands as a raw `ResetCorruptionError` naming a JSON parser._

_**163 §C4's `format-too-new` DEFECT IS FIXED — the 2C review's pre-tag
blocker.** `classifyStateFormat` returns `authority-marker` only for the marker
THIS binary writes (a future one is `foreign`), so a healthy migrated workspace
was reaching doctor's "written by a newer version of rbox / run `rbox upgrade`"
copy — telling a user to upgrade the newest binary there is. Doctor's `state`
check now reads through the selecting seam; a marker with no records behind it
gets 222 §6.4's re-adoption procedure spelled out under a new `authority-corrupt`
status. `docs/design/163`'s own test fixture had been encoding the wrong verdict._

_**Verification:** typecheck clean; `bun test src/cli/` **3997 pass / 0 fail**;
`src/engine/` + `scripts/` 9 fails, all pre-existing environmental (crypto
prototype, dircache bench, corpus seeds, e2e scenario, storage-truth — the
broken-linuxbrew-node set). **One real defect caught by the new tests and by the
full-suite run:** a top-level `process.env.RBOX_HOME` override copied from
`admission.test.ts` turned 56 tests red in `credentials.test.ts` /
`auth-cmd.test.ts` while both passed in isolation — the existing in-tree copies of
that pattern are latent versions of the same bug (papercut filed)._

_SESSION 2026-07-29 (day): **the quota investigation — two PRs merged (#602,
#603), a live upload leak root-caused, and Phase 2 GC found dead since
~07-20.** Triggered by the founder's dashboard showing 87.9 GB billed against a
5.1 GB workspace. Accounting itself is CORRECT (`used_bytes` == `SUM` over
`blob_refs ⋈ blobs`, exactly, every account) — every charged byte is a real
entitled blob. What was wrong was WHICH blobs got entitled._

_**FOUNDER RULING: bill on ACTIVE bytes only; history is never charged.**
Storing history is acceptable (cost math penciled). That retires the
`bound_bytes` 5× fair-use bound and the prune as requirements — see
`bill-active-bytes-never-history` in session memory. Prod shape for the founder
account: **120.96 GB charged vs 3.91 GB of live head content**; of 80,904 refs,
51,262 are head, ~2,700 are real version history (3%), and **24,389 (30%) were
charged but never appeared in any manifest** — upload orphans, not history.
Version history was never the problem._

_**MERGED: #603 (design 225) — active bytes at head, no root walk.** The
fair-use scan had NEVER completed for the founder account (12 aborted, 0
complete): it aborted on any head advance AND, independently, walked every
retained sequence at one root per page (~1,400 h for one of four workspaces,
growing faster than it could be walked). Now computed from each workspace's
head at parity with `refSetAt` — `refs(head) ∪ chainRefs ∪ {encManifestSha} ∪
{sidecarSha}` ∩ `blob_refs` — via a new read-only `/roots-inspect?head=1` DO
mode. `fairuse.ts` 1152 → 836. Migration **0035**. `history_computed` defaults
to **1** so pre-migration completions keep reporting real history. **The
billing flip is NOT in it** and has an unsolved piece: `active_bytes` is
epoch-lagged up to an hour, so it cannot be a synchronous admission gate
alone. Inline mode was the trap — below `SIDECAR_THRESHOLD` there is no
sidecar, and a sidecar-only reading returns ZERO for every small workspace._

_**MERGED: #602 (design 224) — an index-less git repo defeated every ignore
rule.** A repo with `.git/` but no `.git/index` (`git init`, nothing committed)
made `loadTrackedRepoSet` report `available: false`, which made every path
"possibly tracked", which UN-IGNORED the whole subtree. Field: 6 of 328
subtrees on the Mac had that exact shape and held **31,828 stranded entries**;
the other 319 held zero. `node_modules`, `venv`, `__pycache__` and 2 real
`.env` files went up — the secrets patterns `BUILTIN_IGNORE` exists to enforce.
Fix = taxonomy split: `indexAbsent` (rev-parse ok + stat ENOENT + **unborn
HEAD**) → `available: true, paths: ∅`; everything else keeps fail-open. The
third signal is load-bearing — a repo WITH commits that lost its index also
yields an empty tracked set, and misclassifying it would let `ignore --purge`
delete committed files fleet-wide. Also: a symlink is now ignored iff a
same-named directory is (the trailing-slash builtins are directory-only in
gitignore semantics), and `rbox status` surfaces the stranded count. **Recovers
zero bytes** — stops accumulation, makes the strand visible and purgeable._

_**OPEN — design 226: a deferred git repo uploads ~3 blobs per push tick and
discards them.** Measured on the desktop: **9,982 push ticks → 9,983 receipts**
in 13.5 h, one-to-one, none ever referenced. Chain: a stuck pending section
forces `processRepoSlowPath(..., {forceCapture:true})` every tick
(`plan.ts:891-903`) → capture UPLOADS before any decision
(`engine/git/shared.ts:755-782`) → `provePendingSupersession` fails →
`revertCapture` discards the section and the log prints `captured 0`, HIDING
the upload → `push.ts:665-668` short-circuits on `no-op` so the receipt is
never redeemed OR discarded → receipts accrete for the daemon's lifetime
(`remote/context.ts:35`) → the next real commit drains and charges the lot.
`store.has()` can NEVER hit for these (a receipts PUT writes the canonical key
with no D1 row, `present=0`), so even byte-identical recapture re-uploads. Fix
= move the upload AFTER the decision (encrypt/flush split; encryption is
convergent so the ref is computable offline). Two review rounds done, both
CHANGES-REQUIRED, round 3 pending. Reclamation is `gcMark` on the canonical
prefix, NOT staging GC (which only lists `staging/`). Receipts expire server-
side at 12 h (`receipts.ts:10`)._

_**PHASE 2 GC HAS BEEN DEAD SINCE ~2026-07-20 — `roots_budget_exceeded`, and
it is a SCALING WALL, not a tuning knob.** `maxW = floor((800-10-5-3-1)/90) =
8` (`gc-policy.ts`, used `gc-purge.ts:223`) and prod has **12 workspaces**, so
`workspaceSnapshot` returns null and `gcPurge` exits before the lease. Result:
**1,337,881 condemned blobs / 375.8 GB of R2 unreclaimable and growing
hourly**, 835 delete-intents frozen since 07-08. Raising the budget cannot
work: 12 × 90 = 1,080 subrequests against Cloudflare's hard 1,000 ceiling. It
also cannot shard workspaces across ticks, because Phase 2 needs the COMPLETE
reachable set to delete safely — which is why design 151 chose to fail closed.
**PARKED at founder instruction** (do not touch without a fresh ask). One probe
worth running first: deletion is already gated on zero-refs, and 0 of 1.34M
condemned blobs are referenced — so the global reachability re-check may be a
redundant second belt that happens to cost the platform limit. Phase 1 is
healthy and DOES reclaim `used_bytes`; only R2 deletion is blocked._

_**NO DATA LOSS — the purge/re-grant hypothesis was KILLED with evidence.**
Reconstructed the exact reachable set read-only (roots-inspect + head sidecar +
refset codec): 0 of 51,262 head refs missing from `blob_refs`, 0 of 1,645
marked candidates reachable, 0 of 1.34M `gc_candidates` referenced anywhere.
Founder account sat bit-for-bit flat across 20 minutes of 2-min sampling.
Reachability fails closed on every path — no truncating branch exists._

_**Commit-time `active_bytes` was probed and KILLED (UNSOUND) — do not
re-propose.** Three independent kills: prod runs delta admission
(`RBOX_COMMIT_DELTA_ADMISSION: "enforce"`, `wrangler.jsonc:194`) so the commit
path never sees the full ref set and `commitAccounting` only ever sees
`newRefs`; head advances and accounting are not 1:1 in either direction
(`repair` moves head with zero ref inspection); and cross-project dedup is
unobtainable at commit time because a commit is scoped to one `(ws, proj)`.
A scan self-heals from current state; an accumulator drifts silently forever._

_**Fleet actions taken.** Deleted 6 empty `.git` skeletons on the Mac
(`transaction-analyzer`, `dev-server-menubar-monitor`, `faceswap-video-api`,
`LLM-brain`, `twitter-list-adder`, `proof-of-concepts`) — all had `index:
MISSING` + no HEAD + `node_modules` on disk; projects untouched. Desktop and
flat-meadow swept clean (`respectGitignore: false`, zero index-less repos).
Desktop `main` fast-forwarded to origin._

_**THIRD CYCLE NEEDED: `rbox git resolve` cannot resolve its own deferral
states, and one message actively misleads.** Desktop `Personal/rbox-core`
(`local-index`, since 07-27 19:08 — the rejoin) — `keep-mine` refuses BY DESIGN
because the staging-area and operation-state lanes stay strict (1.7.18), and
`take-theirs` points at the wrong host. Mac `Personal/home-dashboard`
(`local-commits`, detached, since 07-27 15:19) has **ZERO local-only commits**
and `take-theirs` STILL refuses with "local commits changed while the checkout
was being confirmed" — which is `refusalMessage("local-commits")`
(`git/resolve-presentation.ts:118`), a reason-keyed refusal, NOT a detected
change. The token was identical across attempts. Both remain deferred; the
1.9.1 worktree fixes (per-branch holds, squash-merge recognition, branch-
deletion sync) are shipped and are NOT what these are hitting._

_**HOST: linuxbrew `node` is BROKEN on the desktop.** `which node` →
linuxbrew 26.5.0, which cannot load its own gcc libs (`GCC_13.0.0`,
`GLIBCXX_3.4.31/32` missing). `/home/via/n/bin/node` v24.18.0 works. Blocks
`bun run typecheck` and will bite wrangler and `apps/web`'s `npm ci`._

_SESSION 2026-07-28→29 (overnight): **U3 waves 1A/1B/1C + 2B are merged on
`2.0`; 222's read-only-preflight premise is FALSIFIED and the ownership rule
(#589, 163 v13) AWAITS FOUNDER RATIFICATION — it blocks lanes 3A/5B/5C; two CI
flakes fixed on main; no release.** The prior-session block below is still the
state of the program that led here._

_**THE 2.0 BRANCH: U3 WAVE 1 COMPLETE, 2B IN.** `origin/2.0` was cut from main
at **5535cc1e** and now sits at **132781dd**. Merge order: **#581** 1B (store
adoption seam + SQLite save adapter) → **#583** 1A (migration control record +
sole publisher) → **#588** 1C (genesis: the intent, the seven steps, the
finishing conjunction) → **#590** never open a database rbox does not own →
**#591** the duplicate-symbol CI gate → **#587** 2B (migration admission, the
five M0 conditions as an ordered table, `withStatePlaneLocks`). Combined tree
verified at **f80c35b3** (pre-#587): typecheck clean, `bun test src/cli/`
**3572 pass / 0 fail**. **#586 Wave 2A** (classifier + PhaseReceipt) is OPEN,
20/20 checks green, its review folded, awaiting a confirmation review.
Six-wave plan lives in 222; routing stays bulk → codex, fail-closed seams →
opus._

_**THE READ-ONLY-PREFLIGHT PREMISE IS EMPIRICALLY FALSE — #589 (163 v13 + 222
r6) NEEDS FOUNDER RATIFICATION, MARKED NOT-FOR-MERGE.** Proven by four
independent lanes (bun 1.4.0 / Linux / ext4): a read-only SQLite open creates
nothing, but the **first read** — a bare `PRAGMA` suffices — creates `-wal` and
`-shm`, and a read-only `close()` cannot remove them while a read-write close
can. It is **WAL-only** (a `journal_mode=delete` DB is inert) and
environment-dependent: in a `0555` parent the first read throws instead.
`immutable=1` is not an escape — it silently ignores uncheckpointed WAL
content, returning a confidently wrong verdict on a healthy database. This
matters because 163 declares a stray sidecar an unremovable corruption
signature, so a read-only refusal path **manufactures one on data rbox does not
own**. Proposed normative rule: **never open a file you do not own** —
ownership = *this code created the inode or is its sole durable authority*,
never *this code holds the workspace locked*. Unowned files are decided from
file-level facts; owned files may be opened and must `wal_checkpoint(TRUNCATE)`
and close. The code half already shipped as **#590** (header-only identity gate
read with `readSync`, no preflight open; that PR's first-revision
`PRAGMA query_only` enforcement claim was false and is withdrawn — a pragma the
caller can turn off was never enforcement). Consequences the unbuilt lanes must
carry: **3A** — 163:3187-3193's M4 verification is unimplementable as written
and must verify through the owning connection (blocker); **5B** — doctor
becomes observation-only on files it does not own; **§M-3** splits
frozen-window (physical `{bytes,sha256}` + a `bun:sqlite` import ban) from
live-window (`store_meta.authority_id` + the `migration_completion` singleton,
read through the owned connection). Branch:
`docs/readonly-open-ownership-rule`._

_**MAIN SINCE THE LAST RIDER — two flake fixes, no release.** **#584**: the
design-178 B timer-coalescing test polled wall clock for ~200ms on a shard that
stretched 5s of work to 236s; fixed by awaiting `scheduler.pumpRun`, a signal
production already publishes — the poll loop is deleted, production untouched,
red→green proven both ways. **#585**: the Workers-API fair-use scan test failed
on cross-test leakage — the suite runs single-worker with no isolation, so
every file in a shard shares one D1, and a leftover `acct-*` id (`-` < `_`) won
`ORDER BY next_run_at,account_id` and stole the invocation; fixed by
tombstoning leftover accounts in the file's own `beforeEach`. Both are in
`docs/flaky-tests.md`. The generalizable half, worth knowing before writing any
Workers test: **the API suite shares one D1 across every file in a shard
(`maxWorkers: 1, isolate: false`), so a test whose subject reads a table
globally must neutralize rows it did not create, not merely clean up its own**._

_PRIOR SESSION 2026-07-28 (day + all-nighter): **v1.11.0 AND v1.11.1 SHIPPED; the
163 backend track is DONE through U2 (B0, U0, U1a/U1b, U2 all merged); design
163 is RATIFIED AT v12 and the U3 implementation design (222) reached GO; the
2.0 branch is OPEN and U3 is under construction.** Everything below is the
current state of that program — the per-PR narrative is compressed out._

_**RELEASES.** **v1.11.0** (899c3568) = `rbox include` (the `rbox scope`
rename + `rbox track --include`, #548) + the **B0 state-plane barrier** (#539,
honesty pass #541, reserve-path fix #551) + `rbox git republish` (#536).
**v1.11.1** (ee627099) = the **macOS ownership-spawn perf fix** (#570) + the
**prerelease `next` channel** (#563 — `rbox upgrade --channel next`, prerelease
tags publish beside `latest` and never over it; the review caught that
dev-build semver precedence would have locked the whole fleet out of the first
beta). NOTE for the next rider: the scheduler/memory fixes were v1.10.2, not
1.11.0._

_**#570 — the macOS ownership-spawn fix (issue #569, design 219), the biggest
field win of the session.** Root cause: the follow classifier proved every tip
with one `git` subprocess **per ownership root** — savvy-core's 447 roots ≈
3,270 spawns per follow, and a macOS spawn costs 20.3ms vs 1.78ms on Linux.
The fix delegates to the pre-existing batched `partitionOwnedByIncoming`: **3
subprocesses**. Field-validated on all three hosts: Mac savvy-core git-apply
**106.8s → 3.0s, then 0.6s steady**, `ownershipMs` **69454 → ~258**; desktop
20.6s → 6.5s; flat-meadow 13.0s → 4.7s. Residual filed as **#573** — steady
state is ~1.7s and the 22s sample was one heavy pull, so it is much less
urgent than first flagged._

_**163 BACKEND TRACK — B0/U0/U1/U2 COMPLETE AND MERGED.** **U0** entry
interning (#554, 5 codex rounds → ALIGNED) + its readonly-conversion tail
(#561). **U1** in three slices: bun:sqlite contract suite + corpus-112k
fixture (#549), store substrate U1a (#564), write seam U1b (#567 —
**copy-while-hashing containment is the settled mechanism**, adopted after a
step-out). **U2** reset/quarantine on DB artifacts (#566): migration compiles
behind the `withMigrationImporter` capability, the crash rig drives production
writers, and the legacy JSON reset is pinned **byte-identical to main**.
Supporting merges: state-plane vertical (#553), API GC/version-history split
(#547), roadmap docs (#546, #575)._

_**THERMO SWEEP #4 (#571) — the deliberate pre-U3 gate — returned NO-GO, and
all four Tier 0 fixes are merged.** T0.2–T0.4 (#572: typed wrong-stream
refusal, scripts typecheck owner, TUI waiver) and **T0.1 (#574, seven review
rounds — the base-proof authority arc)**: ordinary writes now name their own
BASE authority and can no longer launder migration authority; observed-landing
authority with a per-ref hold; `readAllRefsStrict` defers on unreadable.
Tier 1 prep all merged: **T1.1** compat boundary — paths, legacy-JSON facade,
lock→CAS-token bridge (#579); **T1.2** schema/genesis split (#577); **T1.4**
git-section codec + the complete authority-row corruption taxonomy (#578);
**T1.5** doctor descriptor split (#576). (Sweep #3 landed earlier the same day:
#550.)_

_**DESIGN 163 IS NOW v12 — FOUNDER-RATIFIED — AND 222 IS THE U3 IMPLEMENTATION
DESIGN AT GO (both merged as #580).** 222 ran the full dev cycle: draft → 4
adversarial rounds → **a step-out that pulled GENESIS out of the M0–M7 machine
entirely** (genesis has no source document, so every phase invariant about
retiring a source is vacuous) → independent security validation → founder
ratification → final GO. The **v12 amendment** fixes two 163 M0 rows that were
individually correct and **jointly unimplementable** (one authorizes genesis
via "staged DB + Q"; the other halts on the only intermediate state genesis can
produce). Mechanism: a durable **genesis intent** (`.rbox/state/genesis-v1.json`)
binding fenced evidence + authority id + lineage id + the staged DB's
`{dev,ino}`, published before SQLite opens it and retired last, with two new
matrix rows keyed on it. The ambiguous/manual-damage row and "DB presence never
elects authority" are **byte-unchanged**. An `origin_kind`-keyed draft was
**WITHDRAWN** (a DB copied from another workspace would satisfy it). Validation
caught a **dev/ino REUSE hazard** — a recycled inode could let a migrated DB
holding real user data be finished as genesis leftovers, i.e. permanent
corruption — closed by a conjunction over values already written by the merged
`installGenesisLineage` from intent-published inputs._

_**OTHER FIXES MERGED THIS SESSION:** #558 (closes #542 — barrier read
classifies from one O_NOFOLLOW descriptor); **#559 FLAKE-006** — the real root
cause was **filesystem inode reuse, not timing** (tmpfs never reuses: 200/200
pass; ext4 always does: 200/200 fail), fixed as "a fence released mid-inspection
is a retry, not a lost writer"; #557 AST structural gates + #568 the sweep retry
runner and the #557×#558 interaction; #560 rig dual-binary plumbing for the U3
differential gate (+ CI follow-up #565); #562 autostart-cmd facade split; #555
(a scope edit can no longer durably switch background sync off); #552 (republish
sidecar mutations require the workspace mutex)._

_**FLEET CALIBRATION — daemon RSS is NOT a leak.** All three hosts sit at
**4.3–4.7GB steady** on a 140k-file / 101-repo workspace: same band everywhere,
sawtooth rather than monotonic, no leaked git children. This is exactly the
whole-state materialization cost that **163/U4 exists to retire** (U5 kill
criterion: RSS ≤1.5GB). Record it as the calibration data point, not a bug._

_**OPEN / OWED.** Founder-owed, top of the list: **ratify #589 (163 v13) — U3
lanes 3A/5B/5C are blocked on it**. Then the **frozen machine profile** (blocks
U5's bake only); the **v2.0.0-beta.1 tag** when U3 lands; the **adoption drain** (1 user
on 1.6, two on 1.9.x — watch rbox-admin's version view). Issues: **#573** macOS
git-apply residual (low urgency, see above); **#556** a writer-less FIFO at the
state path blocks the O_NOFOLLOW single-descriptor state reads in all three
sidecar modules; **#535** echo-apply (the `.claude/worktrees` carve-out on the
desktop stays until it lands); the FLAKE registry. Design 213 (pull-only live
watch, #532) is still DRAFT/NOT ALIGNED with a 2nd codex round owed, and low
urgency now the whole fleet is read-write. Parked founder question from the 200
arc: should git publication fail closed on a degraded-unlocked workspace
(class C) — no urgency, the state is absent from the fleet. Disk cleanup still
owed on the fleet: `~/Development.pre-rejoin` + `~/Development.pre-rejoin-worktrees`
(desktop), `~/Development.pre-rebind-2026-07-26` (FM),
`~/rbox-recovery/savvy-core.git-stub-20260728` (FM), and the stray worktrees at
`~/agent-work/526-republish` and `/home/via/rbox-worktrees/212-v1`._

_**INFRA/OPS NOTE:** Codex/ChatGPT had an intermittent outage tonight (3 killed
runs); founder confirmed it temporary. Policy: **retry codex per lane, reroute
to opus on death, never silently downgrade the cross-model check.**_

_**STANDING RULES (current, carried forward + new this session).**
(1) **Worktrees**: always `git -C <primary-absolute-path> worktree add <absolute-path>` —
a stale shell cwd nested worktrees inside worktrees three times this session.
(2) **One writer per worktree**: review codex runs are `--sandbox read-only`;
verify committed bytes with `git show HEAD:`, never by the review log.
(3) **A design-doc review round is the cheapest place to step out a layer** —
it deleted a whole subsystem from U3 (genesis out of the M0–M7 machine) for the
price of rewriting prose. Round-3 non-alignment escalates: step out, founder
tie-break, or kill switch — never round 4.
(4) **MacBook problem areas (founder, 2026-07-24)**: rbox-core +
Dfinitiv/conductor-workspaces/* on the MacBook have the highest worktree/branch/
squash/agent turnover and are where wedges appear first. No git-sync fix is
"done" at merge — it is done when it is deployed there and the specific error is
gone from the daemon log. ~8 prior "this unwedges the machine" claims were
declared at merge and were wrong; narrow, field-verified claims only.
(5) **Prod promotions and release tags need a fresh per-action founder yes.**
(6) **The fleet runs dev builds** (`~/.rbox/bin/rbox` → `rbox-dev` on all three
hosts; `install.sh` reverses it). Rig FAST suite every ~3-4 merged sync-plane
PRs and before any tag. Every PR closes with "did it help / did we make anything
worse".
(7) **Every perf flag's default is pinned in the defaults-ledger test** — that
is the fix for the shipped-dark class.
(8) **Duplicate declarations across parallel lanes merge cleanly — gate them.**
Six found on `2.0` in one night; `git merge-tree` reported no conflict on any of
them, and an `interface` duplicated across modules is invisible to `tsc`
entirely (compatible shapes merge silently, and the owning lane's brand then
does not apply to the private copy). #591's line-anchored gate
(`src/cli/state-plane/duplicate-declarations.test.ts`, ~190ms, no AST) catches
it and pins the exact allowlisted site *count*, not just the name. Its sweep
found five further pre-existing duplicates, allowlisted "REAL DUPLICATE,
pending removal": `HeadPin`, `DeferralDiscoveryAuthority`, `ResetConsentKind`,
`PhysicalProof` (declared twice **in one file**), and `doctorCmd`
(`hydrate-cmd.ts` exports an unrelated hydrate routine under the doctor
command's name). Separately: the SQLite sidecar suffix list is duplicated
**seven** times under three names plus four inline literals — that wants one
shared exported constant, not a gate.
(9) **Parallel agents collide on a shared scratchpad.** Agents told to run
tests via a scratchpad script all chose the same path; one lane's runner
overwrote another's and silently reported a different worktree's numbers.
Runners must assert worktree path **and** branch before executing. The tell is
a test count *larger* than the lane's own scope.
(10) **"Green that measured the wrong thing" is a class, not a coincidence.**
Three this session: a stale `.cache/tsbuildinfo`; a `git grep` gate that
self-matched and whose local green depended on `git grep` skipping untracked
files; and (9)'s scratchpad collision. One mitigation for all three — pin what
you are measuring before believing it.
(11) **No gate covers test-file types.** `tsconfig.json` excludes
`**/*.test.ts`, so nothing typechecks tests at all; typechecking them against a
temporary config found real errors a review would not have. Owner unassigned._

_**BUN 1.4.0-canary POSTURE (2026-07-27, founder call — still current).**
Canary is the MAIN bun on all three hosts (`bun upgrade --canary`); dev builds
are canary-compiled; revert per host with `bun upgrade --stable` (1.3.14). CI
and deploy-api run `bun-version: "canary"` **EXCEPT** the cross-compile legs:
canary publishes NO cross-target compile blobs ("Target platform
'bun-darwin-aarch64-v1.4.0' is not available for download"), so ci.yml's
cross-build job and all three release.yml pins stay `"1.3.14"` (inline-
commented), and the startup/size budget job is pinned stable because budgets
measure the SHIPPED binary. **WATCH-ITEM for 1.4-going-stable**: canary-compiled
`status-json` RSS is 48.6MB vs the 42.55MB budget (+14%) — repinning to a stable
1.4 needs either a slimmer bun or a founder-approved budget re-baseline._

_**REORG CAMPAIGN (closed 2026-07-27): 20 merges, 19/21 roadmap cycles**
(#478-#496, #499). Every schedulable cycle is done. **Wave 6**
(RecoverStateAuthorityAtDaemonBoundary + PublishDaemonRuntimeObservation,
~380-490 daemon.ts lines) stays PARKED on the design-163 store port BY ROADMAP
DESIGN — it opens with the 163 track, not before. Hotspots after: status-cmd
922→103, push.ts 1144→946, apply.ts 2291→1502, daemon.ts 3790→3330 (→~2,300-2,450
once wave 6 lands). Next-biggest agent-confusion surfaces, founder undecided:
follow.ts 1784, plan.ts 1474._

_**FLEET/PLATFORM STATE (as of 2026-07-28).** Three hosts — Mac, desktop
(via-desktop-ubuntu), flat-meadow — **all read-write**, all on canary-compiled
dev builds carrying #570. Git-sync has been clean on all three since the #526
republish lever landed (first time since early July). The desktop's
`.claude/worktrees` is carved out of sync via `.rboxignore` pending the #535
echo-clobber fix. The `#501` adopt journal O(n²) defect has a batching stopgap
in 1.10.0; the real fix belongs to the 163 SQLite store._

_**MEMORY-INCIDENT MITIGATIONS (2026-07-27, still live).** The 21.3GiB OOM was
a subagent's `bun test` hitting a retired-halt recoveryProbe spin (~21GiB in
≤48s); no released build ever had it, and the structural fix shipped as #530 in
v1.10.2. Live mitigations: desktop swap 2→32GiB + user-slice MemoryMax=32GiB,
and a PreToolUse hook wrapping every agent `bun test` in a systemd 12G-capped
scope (`~/.claude/hooks/`). Forensic method that cracked it, worth reusing:
Claude session transcripts (`~/.claude/projects/…` + `subagents/`) survive
reboots and tmpfs and reconstruct exact commands AND exact code versions from
Write/Edit payloads._

_**RELEASE LEDGER (compressed).** v1.11.1 (2026-07-28) macOS ownership-spawn
fix + `next` channel · v1.11.0 (07-28) `rbox include` + B0 barrier + git
republish · v1.10.2 (07-27) scheduler spin guard · v1.10.1 (07-27) a calmer
help screen · v1.10.0 (07-27) plain-English doctor, machine-wide status,
packs + fused crypto default-on, adopt at scale · v1.9.1 (07-25) design 200
deletion-as-ordinary-transition, field-validated · v1.9.0 (07-24) design 189
web-approved pairing, promoted to prod. Designs 200/202/203/204/206/208/209/211/
212 all shipped and field-proven; their round-by-round history is in
`docs/design/` and the REVIEW-*.md ledgers, not here._

_Previous: 2026-07-24 (**189 SHIPPED — v1.9.0 released + promoted to prod;
validated end-to-end on two real machines**). Design 189 (web-approved pairing)
is LIVE: implemented across apps/api + daemon + CLI + web, merged (#414), and
released as **v1.9.0** — prod API promoted (migrations 0033/0034 applied) and
CLI binaries published (api.rbox.to/version = 1.9.0). Approve a new machine in
the dashboard → an online enrolled admin auto-delivers keys; the new machine
enrolls with no token/phrase. VALIDATED two ways: `bun run rig run web-pairing`
(headless 2-container, dev-only `approve-dev` hook) AND a real two-machine SSH
run (Mac = admin, flat-meadow = new device) through the deployed dev dashboard
`main.rbox-app.pages.dev` with a real Clerk step-up + key-consent approve →
byte-identical file convergence. Bugs caught + FIXED en route: (1) delivery
expiry not clamped to the device-code TTL → enroll failed 100% (rig-caught,
#415); (2) first-device web approve 409'd "encryption isn't set up" → now
downgrades to a device-auth sign-in (#417); (3) the deployed dashboard origin
was missing from the dev `CLERK_ALLOWED_ORIGINS` (CORS + `azp`) → added to the
dev secret (prod `app.rbox.to` already allowlisted, so NOT a prod bug).
Papercuts logged (docs/papercuts.md). Test HARNESSES preserved on origin:
branch `189-e2e-full` (composed real-approve E2E — rig containers + Playwright/
Clerk browser approve) + `design/189-browser-e2e` (Turnstile-under-CSP + `#fp`
survival gates) — the first scenarios for the live smoke suite (docs/design/
193-live-smoke-suite.md stub). Persistent dev dashboard: `main.rbox-app.pages.dev`
(Pages preview env vars → dev API + dev Clerk). Repo hygiene: root scratch `.md`
relocated to docs/design/notes/ (#416); worktrees + merged branches pruned. NEXT
(optional): build the 193 live smoke suite (dev-gated `provisionAccount` endpoint
+ a `smoke` runner over the rig + browser scenarios, wired as a pre-promotion
gate); fix the first-device web button LABEL (still reads "send keys"); delete
the throwaway dev test account._

_189 rulings still live (2026-07-23): epoch rotation is NOT a prerequisite —
a revoked device keeps already-synced plaintext plus a ~5-min download-grant
window (grants bypass bearer auth, `grants.ts:22`); honest revoke copy is
required and rotation is filed as design **191** (stub). Design **190**
(passkey escrow) stays DECOUPLED — browser-unwraps-RK violates the
key-material law._

_Telemetry read (minor, 2026-07-23): first 3 days of `client.sync_phase`
AE data (since 07-21 midday) — **server plane is not the sync bottleneck;
the tail is client-side `git-apply` on backlogged repos.** Bias-corrected
(emitter stores 1-in-8 normal + every outlier, so raw p95/p99 skew high):
pull p50 ~2.6s / p95 ~185s / p99 ~250s; push p50 ~0.5s / p95 ~13s / p99
~26s. Slow pulls (>60s) are ~87% `git-apply`, ~0 download — confirmed by
the live `account_op_latency` D1 table (every route sub-second mean; 4
accts / 15 devices). One-off: device `agent_inN2` (acct_63de3fd) failing
100% of telemetry + fleet/sync-state POSTs = a stale daemon, whole fleet's
error count. Data point for the parked 163/SQLite decision (needs a month
of evidence). rbox-admin p99 added to the sync-phase panel (PR #10, live)._

_Previous: 2026-07-23 (~18:30 UTC — **v1.8.0 "setup feels brand new"
RELEASED + FLEET-LIVE — DESIGN 185 (TUI framework) COMPLETE**): tag at
9b7744ef, release run green INCLUDING the new compiled-TUI smoke gates'
first real release (all 3 targets), api.rbox.to/version = 1.8.0. Fleet:
Mac 1.8.0 (healthy; litter noise again; NOTE Mac now shows 2 git repos
needing attention — savvy-core deferral + one new, founder's call), FM
1.8.0 pull-only witness-verified, desktop binary 1.8.0. **The 410 arc**:
two-reviewer wave (Fable + opus) found 2 blockers (stdin-mutex crash in
browser-login genesis; truncated action SHAs incl. release.yml = every
future release dead); the compiled gates then caught 3 REAL input bugs on
their first executions (pty keystroke coalescing eating Enter/Ctrl-C —
fixed with a stdin-wrapper key splitter; pre-attach Ctrl-C signal death —
now synchronous SIGINT exit 130; single-key confirm leaking Enter into
the next prompt — Inquirer parity restored). GH Linux runners misreport
Ctrl-C death statuses: ONLY the numeric status comparison is advisory
there (RBOX_TUI_SMOKE_STATUS_ADVISORY); budget gates on median. Then
FOUR founder field-review UX rounds via the new `bun run demo` loop
(scripts/dev-demo.ts — builds current tree, fresh throwaway dev account,
isolated HOME; HOME override is LOAD-BEARING, credentials resolve via
$HOME/.rbox): block wordmark banner (once/process at every interactive
front door), genesis = one clear task ("Protect your files", trimmed
copy, options renamed, path printed after save, disclosures at action
time), step headers lose the ── rules, `✓ logged in`, PR #411 workspace
copy cherry-picked (+flow specs updated; #411 closed). **PENDING: PR
#409 (Stripe coupon Slack ping fix) touched apps/api — on main + DEV,
needs main→production promotion to reach prod.** Founder must still add
the compiled-TUI checks to the branch-protection required list. NEXT:
design 188 — unified state-aware home screen (logo → Login / save
recovery / main menu by account state; founder-sketched; suggestion
heuristics must be dev-shaped, never junk drawers). Standing rule: demo
props must never model Downloads-style dirs as sync candidates._

_Previous: 2026-07-23 (~11:30 UTC — **v1.7.26 "name clashes can't
stop sync, your phrase saves anywhere" RELEASED** — designs 186 + 187):
tag at 67109ea3, release run success, api.rbox.to/version = 1.7.26
(all three artifacts). Regress 11/11 (via sg docker). **FLEET-LIVE
(~11:45 UTC)**: Mac 1.7.26 via `rbox upgrade` — graceful stop drained an
in-flight git-commit critical phase before restart (178 machinery
field-verified), Development-f1903d6b healthy/syncing; non-zero exit was
the test-litter papercut only — **32 dead rbox-daemon-activity-* dirs now
on the MAC too** (0 live pids, verified; papercut recurs, fix the test
writing to real RBOX_HOME). FM 1.7.26 pull-only PRESERVED
(witness-verified: daemonVersion 1.7.26, mode pull-only). Desktop binary
1.7.26 (no bound workspace). Mac's savvy-core local-commits deferral
still open (founder's call). Release details below._

_Same day (~11:00 UTC — **DESIGN 187 COMPLETE ON MAIN —
multi-select recovery phrase backups**): PR #408 merged (squash ebb58578):
first-run genesis now offers a checkbox flow saving the recovery phrase to
any combination of 1Password (new shell-free bounded CLI adapter,
stdin-only phrase transport, exact readback verify), macOS Keychain,
plaintext file, and clipboard — with durable destination plans,
append-only progress events, witnessed plan replacement, kit.json v3
(1Password locators recorded-not-verified), and non-technical lead-in
copy. Addresses the 2026-07-22 onboarding-feedback audit. **Review
lesson (BIG one for the playbook)**: six GPT design rounds ended PASS,
but the post-implementation two-reviewer wave (Fable + opus) found the
flagship 1Password path 100% broken on a real clock — every
destination-set test pinned `now: () => 1_900_000_000_000` (year 2030),
which clamped `eventAt()` to a constant and neutralized the
timestamp-equality invariant it was supposed to exercise. Opus reproduced
by re-running the PR's own test on `Date.now()`. Fix round a0ecfc7f
(opus): removed the manufactured `completedAt === at` parser equality
(founder call — no integrity value, only a manufactured failure mode),
idempotent 1Password artifact re-record (crash-window resume), retry
dead-end copy steered to "Change incomplete choices", clipboard cleared
on declined confirm, real invalidation reasons, orphan-item warning,
real-clock regression tests now permanent. REVIEW-187 round 7 records
it. **Standing rule from the lesson: injected test clocks must ADVANCE —
a pinned far-future `now` can silently disable timestamp invariants.**
CI 13/13 green pre-merge. No `apps/api` changes. NOT yet in a CLI
release — 186 + 187 both ride the next release train (fleet on
v1.7.25). rbox is NOT a Windows target (founder, 2026-07-23)._

_Previous: 2026-07-23 (~03:45 UTC — **DESIGN 186 COMPLETE ON MAIN —
case-only collisions no longer block sync**): PR #407 merged (squash
1c461388): case-fold collision groups are excluded from publication as a
complete group (never a single member — the data-loss case), prior-synced
spelling preserved, bounded symlink-safe warning sidecar, `rbox status`
surfaces the warning (human + JSON `pathWarnings`, workspace stays
healthy), daemon watcher rescan picks up resolution passively; two-device
rig verified safe-sibling progress + passive survivor pickup. This CLOSES
the queued beta feedback item 3 (initial-sync filename collision).
Review: adversarial opus review (verdict MERGEABLE, core invariants
traced clean incl. no partial-member publish across 409/422/deferral
paths and no client-skew — validation byte-identical); its 4 minor
findings all fixed on-branch (207e48a3: writePathWarnings symlink guard +
test, design §8 reconciled to as-built live-scan status, NFC/NFD
normalization gap disclosed in §2 — pre-existing wire-contract limit, a
macOS peer can still receive an unmaterializable NFC/NFD pair inbound;
intentional foreground-deferral sidecar gap commented). CI 13/13 green.
No `apps/api` changes — nothing new to verify on dev API for promotion.
NOT yet in a CLI release — rides the next release train (fleet is on
v1.7.25 without it)._

_Previous: 2026-07-23 (~03:30 UTC — **v1.7.25 "stops are safe, pairing
is one command" RELEASED + FLEET-LIVE — DESIGN 178 COMPLETE**): tag
e093ffce, release run success. Carries: 178 t3 (#404 — crash-safe lock
lifecycle w/ L1-L7 invariants + legacy-v1.7.24 journal recovery, graceful
stop incl. bounded old-daemon escalation, E-live, pr8 ghost fix; 5 codex
fix rounds + birthtime inode-evidence + journalMs timing leaf after CI
caught real gaps), 184 one-shot pairing (#405, codex-authored, opus
ALIGNED, rig onboard-smoke PASS end-to-end — beta-tester friction point
2), #402 key-status fix, #403 flake determinism. Fleet: Mac 1.7.25
healthy; FM 1.7.25 pull-only PRESERVED via rbox upgrade (FM daemon id is
Development-a64d35fe); desktop = binary-only — **this host has NO bound
workspace anymore** (old memory stale) and its 132 test-litter daemon
dirs were swept (papercut recurs until the test-hygiene fix). NOTE:
design-number collision — 184-front-door-look (uncommitted, other agent's
worktree) must renumber to 185. Queued: 182 ship order (E1 copy → A0
capture bracket → A1), beta feedback item 3 (initial-sync filename
collision — likely new papercut), regress pairing flow fixed for #405
copy. Time to tell Max — AND the new beta tester._

_User base (2026-07-23): **four external users** — Max, Ryan (Brian's
coworker, the engineer/paying customer), plus **two newer less-technical
users** (one is the 2026-07-22 onboarding-feedback tester). The two
less-technical users are the best onboarding-feedback source we have —
treat their friction reports as first-class input (the audits/ pattern:
capture verbatim, file per-item, fix the sharpest edge per release).
Non-developer users raise the stakes on copy, error messages, and the
front-door/setup flow; the compat rule (client skew story for breaking
changes) now covers four machines we don't control._ founder's real-Mac
`rbox key save` SUCCEEDED on v1.7.24 after four real-security(1) field
fixes (bare `login-keychain`; indented-output trim; visible prompt by
founder directive; readFileSync(0) for compiled-Bun stdin) — PR #398. The
`key status` false-negative root-caused and fixed (#402, on main,
unreleased): probe demanded one stdout line but real find-generic-password
prints a ~20-line attribute dump; exit code is now the verdict. Bar
Degraded-vs-Syncing papercut FIXED (#401) and deployed to the founder's
/Applications same evening — deferrals never escalate the headline tier.
Both registered daemon-activity flakes converted to injected clocks (#403,
SafetyCadenceClock seam) and marked resolved in the registry. **Design 182
(agent-churn sync latency) is ALIGNED v8** after an eight-round codex loop
(19/5 → 0; key outcomes: A0 = generalize 177's capture-stability hardening
to ordinary pushes as the gate for everything; A1 lock-event micro-gap
capture Linux-first with a governed attempt budget; B demand-driven flush
demoted to its own phase-2 design with a hard requirement set; E2 agent
stop-verdict with an always-live criticalPhase witness + reservation entry
protocol — both named interface requirements ON 178 t3). **178 t3**
(workstream A locks + graceful stop + E-live + pr8 ghost): codex
implementation COMPLETE in `.claude/worktrees/178-t3` (23 files, ~1350
insertions; survived a codex credits outage mid-run — 14MB retry-spam log
was the tell). Gates independently re-verified green (1,143 tests) — and
then the three-reviewer wave (codex lock-lens, codex stop-lens, Fable
structural) found it NOT mergeable: **all seven L1–L7 invariants FAIL**
(5 blockers; one L2 violation REPRODUCED — recovery unlinked a replaced
foreign inode that merely contained a copied marker), post-CAS settlement
runs outside the gate (the exact kill-inside-mutation class the tranche
closes), the new `rbox stop` hangs FOREVER against pre-t3 daemons (=
every host's upgrade path — fleet-critical), and ordinary pulls would
fsync-rewrite status ~3× per applied file. Root pattern: journal
authority persisted at the wrong moments. GOOD news from the wave: t3's
gate/witness shape extends cleanly to 182's E2/A0 interface requirements
— no wire rework. All findings consolidated in the worktree's
FIX-ROUND-2.md (items A–K, binding acceptance incl. re-verifying the
reproduced deletion); codex fix round 2 IN FLIGHT → then re-review of
fixed areas → one final serial review before merge. **Pending founder
call (default: wait)**: #402 key-status fix is on main unreleased — cut
v1.7.25 now or let it ride the t3 train. Then: tell Max._ the 180 client + 179 Keychain feature shipped
(tag f6e945e9, release run success, api.rbox.to = 1.7.23). Founder waived the
dev-build Keychain pre-validation (his call — testing with the released CLI on
his real account; NOTE his Mac has no cached rk.key, so `rbox key save` will
ask for his real phrase ONCE — same for Max). Fleet: Mac RW 1.7.23 (daemon
resumed via the generation fence after upgrade's stop — benign), FM
pull-only 1.7.23 (witness-verified), desktop binary 1.7.23. Desktop
daemons-dir test litter RECURRED (fresh rbox-daemon-activity-* from today's
test runs — the filed papercut reproduces; fix the test writing to real
RBOX_HOME). AWAITING: founder's real-Mac `rbox key save` result — the first
real-security(1) execution ever; if it misbehaves, the flow fails closed
(phrase validation precedes any write). Then: tell Max. Next work: 178 t3,
design 182 loop, bar papercut._

_Previous: 2026-07-22 (~21:00 UTC — **THE 180/179 PROGRAM IS COMPLETE ON
MAIN**): PR #397 (design 179 recovery kit + macOS Keychain, v18) MERGED at
09070ed9 after: security review ALIGNED (zero substantive findings — stdin-only
phrase transport, unwrap-validated re-save, fallback-never-harder), phase-1
fix batch (10 items incl. seam strengthening), phase-2 integration onto the
real 180 modules (rebase-conflict resolution = seam swap), final serial review
(3 findings hand-fixed: declined genesis offer continues until journal
resolution; RK wipe on the phrase-input path; cross-account kits are
`unrecognized` = at-risk, plus the json-output expectation the pipe-exit-code
lie briefly hid — bitten AGAIN, check conclusion explicitly). Flake program
also merged (#396, c563b6c3): docs/flaky-tests.md registry + deterministic
fixes for all three live flakes + 17-file sweep; CursorClock injectable seam.
Changelog staged under [Unreleased] for both 179 and the 180 client.
**RELEASE GATE (deliberate)**: the Keychain flow has never run on a REAL Mac
(all CI/local validation used injected security(1) runners — the 179 residual
risk). Per the dev-build-first rule, stage a dev build on the founder's Mac
and run `rbox key save` + a Keychain restore ONCE interactively before
tagging v1.7.23. Prod server already runs 180 (ordering contract satisfied).
QUEUED after release: 178 t3 (graceful stop + lock journal + pr8 ghost),
design 182 agent-churn latency loop, bar Degraded-vs-Syncing papercut,
RboxBar signed-app someday (iCloud Keychain)._

_Previous: 2026-07-22 (~19:30 UTC — **design 180 LIVE IN PROD**): the
atomic-genesis implementation (ALIGNED v14 after field amendments) is on main
(9aec0906..0e7397bc — landed via direct push after a cwd mishap, content =
the fully-reviewed PR #394 branch, gates green on the exact tree; PR closed
with paper trail; new rule: git -C everywhere in background chains), main CI
green, DEV validated with 10/10 regress flows (new client + new server), and
**production promoted 500fc5a3→0e7397bc** (founder-authorized; test-gated
workflow applied migration 0031 + deployed + versions green). Field-verified:
Mac 1.7.22 old client syncs normally against the new prod server. The
enrollment crash-wedge defect class is CLOSED in production. Round-3 field
amendments: local enrollment witness (enrolled users never fetch the
observation — no per-invocation network coupling, offline-safe, skew-immune)
+ typed legacy-server terminal error + explicit deployment-ordering contract
(server before any CLI carrying 180 — NO CLI release until prod has it: DONE).
ux regress CI step made genuinely report-only (#395). IN FLIGHT: 179 phase-2
integration (rebase-conflict resolution = seam swap, codex); flake sweep
(registry + deterministic fixes, codex). QUEUED: 179 review wave + merge,
release train for 180+179 client, 178 t3, design 182 (agent-churn latency —
founder problem statement committed). Founder's Mac has a fresh
agent-workspace local-commits deferral (conductor-workspaces/savvy-core-v1)
— normal 182-paradigm operation, his call when he cares._

_Previous: 2026-07-22 (~13:15 UTC — **v1.7.22 fleet-live**): founder
follow-up "make sure rbox upgrade swaps the daemon fully" → design 181 +
PR #393 (merged 637bebd6): `restartDaemonsAfterUpgrade` gains `staleOnly`
(reads the daemonVersion witness AFTER binding validation; absent/malformed/
versionless = stale), both "already up to date" exits now restart stale
daemons, `--check` untouched. Released **v1.7.22 "upgrade finishes the job"**
(e69caf04, CI green first try, release run success). Fleet via pure
`rbox upgrade` — its own field test: Mac 1.7.21→1.7.22 both daemons
restarted; FM "restarted (pull-only)", witness `pull-only 1.7.22`; desktop
exposed NEW papercut — 36 dead `rbox-daemon-activity-*` test-litter dirs in
the real ~/.rbox/daemons, one unreadable record → non-zero exit (litter
removed after verifying 0 live pids; papercut filed: fix the test writing to
real RBOX_HOME + treat dead-pid unreadable records as debris). Fleet:
Mac RW 1.7.22, FM pull-only 1.7.22, desktop binary 1.7.22 (unbound)._

_Previous: 2026-07-22 (~12:15 UTC — **v1.7.21 fleet-live + prod
promoted**): founder authorized merge/release/prod. Sequence: promoted
`main → production` at 500fc5a3 (deploy-api run green: tests → prod D1
migrations → deploy — prod API accepts `stale-unattributed` BEFORE any client
emits it), then released **v1.7.21 "transient hiccups heal themselves"**
(release commit 0a885435; main CI flaked once on
daemon-ws-reliability.test.ts "live committed frames reset the cursor
cadence" — flake proven: green rerun same SHA + green in isolation, add to
registry; tag → release run success → api.rbox.to/version = 1.7.21). Fleet:
Mac read-write v1.7.21 (needed manual stop/start — `rbox upgrade` said
"already up to date" and left the 1.7.20 daemon running, papercut logged),
flat-meadow v1.7.21 with witness-verified `mode: pull-only` across a BARE
restart, desktop binary 1.7.21 (workspace intentionally unbound). Field
check: the pr8 ghost ("git busy", checkout unavailable, 14h) SURVIVES t2
hygiene — gone-directory probes fail closed by contract, so the incident's
disappeared-repo case still can't clear; ruled follow-up filed in papercuts
for 178 t3 (absent-from-discovery + N gone observations → clear busy-class
lanes). savvy-core itself shows a genuine `local commits` deferral (founder
decision: keep-mine or take-theirs when he cares)._

_Previous: 2026-07-22 (~11:30 UTC — 178 t2 merged, 180 ALIGNED): **178
tranche 2 is on main** (PR #392, squash 07b87872): C deferral-hygiene
reconciler (re-probes every git-busy lane incl. repos gone from discovery,
exact-lane CAS clears, categorical `stale-unattributed` after two stable
≥30s observations with display-time detail, autonomous pull-only cadence,
per-pass time budget) + B halt recovery (first-class `recoveryProbe`
pull→reconcile→conditional-push, full-jitter ≤2min, K=8 dequeued-op fairness,
want restored not consumed, immediate clear only on PROVEN no-delta —
indeterminate/busy never clears, dormant push episodes survive pull-only in a
dedicated slot, safety refusals keep ⛔ regardless of fingerprint). Review:
3 parallel reviewers → fix batch → final serial review → 13/13 CI.
Changelog under [Unreleased]. **CLI release intentionally HELD: promote
`main → production` first (founder: `git push origin main:production`) so the
prod API telemetry allowlist precedes clients emitting `stale-unattributed`;
DEV already auto-deployed.** Then the normal release train ships t2.
**Design 180 (atomic genesis enrollment) is ALIGNED v13 after THIRTEEN
rounds** (commit 9df99af7; rounds+rulings in `.claude/review-180-r*`): the
r4 wrong-layer pivot replaced the permit/witness/expiry repair fence with
TOMBSTONE-CLAIM repair (claim row always exists — orphan/tombstone/real —
single-row observation kills the split-read race; no expiry; capable
bootstrap atomically replaces the exact tombstone). Load-bearing pieces:
staged-RK pre-POST foothold + completion hold (fixes the phrase-loss
BLOCKER), deletion-ledger NOT-EXISTS guards on EVERY account-linked mutation
(bootstrap/repair/workspace-creation incl. its audit row — no post-purge
resurrection), shared manifest-first quarantine primitive with completed
marker, global→account pairing lock handoff, RETARGET transition witness +
absence-only reselection, 423 as the only repair-fencing status, scrub-on-
purge audits (design-37 compatible). 179 carried along to v18 (seam: 180
owns rk.key.staged + completion intent; 179 layers keychain/cache on top).
**Next: implement 180 (it gates 179's implementation), then 178 tranche 3
(A lock journal/graceful stop + E-live).** Prior block: v1.7.20 night._

_Previous: 2026-07-22 (~02:45 UTC — v1.7.20 fleet-live): **v1.7.20 "resolutions land when you confirm them"** shipped and fleet-live (Mac + flat-meadow): design-177 synchronous keep-mine + **178 tranche 1** (PR #391 — echo-loop kill via PENDING-final precedence, universal sanitizer, ACK-composer supersession proof, capture idempotence; durable daemon modes with boot-bound witness + pendingModeIntent semantics after TWO field-failure fix rounds on flat-meadow). Field-validated on the incident host: storm conditions = 1 publish per 3.5min (was 1/36s); bare restart on the SIGNED release preserves pull-only (verified post-upgrade: mode witness pull-only). 178 doc now ALIGNED v5; tranches 2-3 (C+B deferral-hygiene/halt-recovery, then A graceful-stop/lock-journal + E-live) queued. **Design 179 (recovery kit → macOS Keychain + re-save + restore, Max's #6) ALIGNED v7 after 5 review rounds + a wrong-layer split**; **design 180 (atomic genesis enrollment) v1 DRAFT owns the pre-existing bootstrap-wedge production defect — its r1 (REVIEW-180-R1.md, 9 findings incl. an ordinary-bootstrap phrase-loss BLOCKER) is the NEXT CYCLE'S first fold**. 179A appendix: iCloud Keychain sync verified infeasible for the standalone CLI (probe data; signed-app/RboxBar route someday — founder ack'd). Release-train lesson banked: never push to main between a release commit and its tag (concurrency group cancelled the exact-SHA run; rerun recovered). Prior block below (the robustness night) has the incident + design-178 details._

_Previous: 2026-07-22 (post-midnight — the robustness night): after v1.7.19 shipped, a second incident unfolded LIVE and became the best forensic material rbox has ever produced. Chain: my scripted `rbox stop` at 21:33 UTC → 60s SIGKILL escalation landed inside the UNJOURNALED state-CAS witness-lock bracket (apply.ts:1737) → ~140 orphaned refs/**/*.lock → existence-only busy probe deferred the 10-repo savvy-core family 2h → stale base lost every push CAS race → halt latched (only a same-op success clears it; the failed want is consumed, retries ambient-only, pull-priority starved them) → SEPARATELY my fleet upgrade's bare stop/start dropped flat-meadow's --pull-only flag, and the advertised-over-pending comparison bug (plan.ts:226) turned its carried pendings into 280 echo publications in 2h50m that kept the remote moving. Manual heal: deleted stale locks, stopped FM, Mac pushed seq 427, restarted FM `--pull-only`. Fleet HEALTHY (Mac active, FM pull-only, loop dead). **Five codex forensic reports** (archived .claude/forensics-0721/ with raw logs) root-caused every link; **design 178 "transient hiccups heal themselves" is ALIGNED at v4 after 3 review rounds** — six workstreams: A crash-safe lock lifecycle (ownership journal, classify+reap, graceful stop, never clock-SIGKILL a critical section), B halt-as-reproducing-condition (composite recoveryProbe scheduler op, K=8 bounded service, pull-only dormancy), C deferral hygiene reconciler (shared classifier→action table, categorical stale-unattributed), D pending state machine (PENDING-final precedence over advertised, universal pure sanitizer, ACK-composer dry-run deep-equality for supersession), E mode durability (tri-state intent, bootId-bound mode witness in daemon.status.json, stop preserves mode), F sync-state reporter retry. **Ship order: tranche 1 = D + E-resume (kills the echo-loop class), then C+B, then A + E-live.** Also merged tonight: PR #390 design-177 synchronous keep-mine (7-round ALIGNED, rig-validated twice, on main for v1.7.20). Operator rules banked to memory: FM is pull-only BY CONFIG — bare stop/start DROPS the flag, use `rbox upgrade` or explicit `--pull-only`; never stop a daemon that may be mid-apply._

_Previous update: 2026-07-21 (late night — v1.7.18 + the wedge's actual last gasp): the savvy-core wedge RE-FORMED twice more (stale backlog echoes + the worktree-studio-assistant branch: recreated on the Mac but never deleted on flat-meadow, whose sections kept republishing it — deleted on BOTH hosts now, propagated clean) and exposed a REAL 176 defect: the keep-mine final gate refused `indeterminate` lanes unconditionally, and a pending branch whose oid exists nowhere (squash-merge + deleted worktree + deleted origin branch) is PERMANENTLY unprovable — no path forward even with --force-discard-incoming. **v1.7.18 "keep-mine works even when history is gone"** (PR #387, codex-reviewed with the MAJOR tightening: indeterminate passes only for branch:refs/heads/* lanes in authorizedLanes — index/op-state indeterminacy loses oid enumeration so preservation completeness can't be shown) is fleet-live (Mac + flat-meadow; desktop's rbox binding is GONE — likely account-consolidation casualty, rebind when wanted). Post-heal steady state: conflict snapshots 1710, 0 prunable (two generations, 2026-07-09 + 07-13, self-prune ~Oct 7-11 at 64/push); the flickering "deferred 0m local commits" line is the behind-echo cosmetic (peer echoes supersede on next push — 14+ supersedes logged). **Also merged tonight:** PR #388 status UX (daemon persists daemonVersion + plain-English skew warning — the dev-binary skew tonight was invisible without it; transient deferrals <10min suppressed from human output; conflict-snapshots line only when prunable>0) and PR #389 refwatch premise-vs-contract (the Parcel starvation flake cost THREE legs today: typed premise failures, escalating retries, INCONCLUSIVE+exit-0 on pure starvation — contract violations under real pressure still hard-fail). **Design 177** (keep-mine execution reliability: intent survives ambient churn; authorization + hard fences stream/stateNonce/incomingKey/repositoryIdentity/repoKind + presence-aware remote-lineage rule centralized in state composition; pin-time stability endpoint with ABA argument; take-theirs stale-intent bug found by r2) ALIGNED at v7 after an architectural pivot (deferred-intent model deleted; confirm executes synchronously) — IMPLEMENTED and merged as PR #390 same night: rig git-held-livelock FULL PASS twice, impl review round fixed 8 findings, v1.7.20 candidate sits on main. Operator lessons banked: rbox push vs daemon lock hard-fails (papercut filed + keep-mine preview buries its confirm command under per-tag lines); grep-pipe exit codes lie (gh run watch | tail reported success on a FAILED run — check conclusion explicitly)._

_Previous update: 2026-07-21 (night — "the wedge is dead") — **THREE releases in one day (v1.7.15/16/17, all fleet-live) and the founder's savvy-core HEALED after 27h**: the live keep-mine session succeeded (results=unchanged=101, deferral gone, pulls 57s→24s and falling as the 707-ref conflict drain proceeds; heal consumed via the sanctioned validated-candidate no-op transition — 1.7.17 follow-up: log a superseded line there too). v1.7.17 ("leftovers don't block you") = the two live-found breadcrumb fixes (preview + confirm doors counted ORIG_HEAD/REBASE_HEAD as in-progress; existing test had fs.rm'd ORIG_HEAD as a workaround — review tell). **Filed follow-up queue (tomorrow):** §11 concurrent-saves flake determinism (FOUR strikes today — it solo-blocked two release trains) + 170 cursor-test recurrence; refusal lists ALL blocking branches with oids + paste-ready restores; intent-binding resilience (founder's `git pull` mid-flow voided tokens — verify vs daemon-scratch hypothesis before designing); fleet-alerts stale-row aging (design 127 — maliwan.local = MAX's 2nd Mac, daemon stopped since Friday per investigation: install.sh's silent restart requirement bit a real user — tell Max `rbox upgrade`); no-op-consumption logging. **Process banked:** test:affected is the pre-push FLOOR (a file-only push shipped a red PR; founder called it), fixtures written deterministically never via git side effects, watcher identity verified per-run (two wrong-run reads today). Prod telemetry pipeline end-to-end since midday (promotion gap fixed; first sync_phase rows showed the wedge signature at pull p50 56.7s — the before-chart is in the can). Max timings: no outlier rows = healthy; clustering with a full day's data pending. 163 SQLite: parked pending a month of sync_phase evidence (founder-answered).**_

_Last updated: 2026-07-21 (evening — "your repo explains itself") — **v1.7.16 RELEASED + FLEET-LIVE same day as 1.7.15: design 176 (keep-mine + legible deferrals + held-skip fix).** Full cycle in ~6h: design (3 base rounds + 2 rig-forced amendments: v5 allowlist admits local-index [structural to the wedge — ahead writer's clean index ≠ stale base ≠ stale incoming], r5 classification bracket) → codex impl scrutiny-CLEAN (0C/0M, 2nd in a row via inviolables-in-spec) → plain-English copy pass (refusals + discard preview; tests now pin the HUMAN copy) → rig git-held-livelock FULL PASS runs 4-11 (fixture + fix co-hardened: settle file plane, kill-switch isolation, silent-skip-proves-hold, RBOX_DEBUG for summary token) → PR #385 (one stale-copy assertion fix) → merged (founder green light) → v1.7.16 tagged after a bun-refwatch-contract Parcel-pressure FLAKE (rerun green; PR run = isolation witness; registry-worthy if it repeats) → fleet-live. **keep-mine**: token-bound RESOLUTION-INTENT executed by the next push; clears only in accepted ACK; plain-English refusals; CLI-only (prod API delta EMPTY — verified per the new release-checklist rule). **ALSO TODAY (this block):** prod promotion gap FOUND+FIXED — 1.7.15's sync_phase/git_capture ingest was never promoted; prod dropped every sample as unknown_kind (197+, found by the Max-timings investigation agent); founder ran `git push origin main:production` (classifier blocks agent); deploy green; FIRST sync_phase rows in prod AE (pull p50 56.7s = the wedge signature growing, push p50 9.9s; Max rows still accumulating — his silence w.r.t. the >20s outlier wire is itself evidence he's fine). Codex invocation OVERHAULED from the official docs (founder link): zombies were OUR setsid/nohup orphaning; new pattern = harness-background-task foreground + --output-last-message + medium default; /arbitrage + playbook updated. **NEXT: founder runs the guided savvy-core keep-mine (preview pending post-restart settle) → pulls 44s(→57s creeping)→~13s + conflict-ref drain (2417/707) unblocks. Then: Max sync_phase clustering with a full day's data; 174B forensics (livelock seed) still open; 163 SQLite re-eval queued.**_

_Last updated: 2026-07-21 (midday — "stuck repos heal themselves") — **DESIGN 174 SHIPPED END-TO-END: v1.7.15 released + fleet-live (Mac + flat-meadow).** One-day arc: field forensics reframed "APFS git-apply ~32s" into a ONE-WRITER GIT-PLANE LIVELOCK (savvy-core re-followed 123×/day at 30s: apply held "local-commits" while push carried the stale pending section and SUPPRESSED capture — plan.ts pending-carry assumed pending is newer than local). Design ALIGNED v6 through 4 base rounds (r1 3-PARALLEL: codex xhigh 10B/6M + opus broad 1B/3M + opus narrow 1B/1M → fold → r2 serial → r3 confirm) PLUS a rig-forced amendment: the maiden `git-held-livelock` run proved the r1 index-lane rule (exact indexIdentityV2 equality) VACUOUS for the healing case → focused r4 round → clean-and-plain-against-own-head rule. **Shipped**: B pending supersession (capture-then-PROVE-then-swap; P + sidecars byte-intact until accepted ACK; tombstone chains + generation retained; GIT_NO_REPLACE_OBJECTS on proofs), A held-skip (merged typed blocker union, fingerprint+reflog bracket, 1h floor + canary), C follow sub-timers + **C2 `sync_phase` fleet telemetry** (N=8 + outlier always-emit — phase timings finally leave the device), D conflict-ref retention (founder-ratified supersession+90d+status count; Mac: 2417 snapshots/707 prunable draining 64/push), F push-tail sub-timing. E scan-skip DELETED in review (watcher is latency-only authority per 172/175 — correct). Scrutiny CLEAN (0C/0M — first codex safety impl needing NO fix round; inviolables-in-spec). Quality pass: 21 fixes from /simplify×4 + antislop. Rig scenario green 9/9 — **autonomous heal in 5.5s**. **Field truth (Mac)**: savvy-core wedge is COMPOUND — pending holds side branches at PRE-REWRITE tips (daily amend/rebase); the non-FF lane correctly refuses, so its pulls stay ~44s until a manual resolve. **Founder calls**: local fix acceptable, the REAL gap is LEGIBILITY ("git language isn't grokkable") → **174B = wedge-UX** (plain-English deferral surfacing + guided resolve + log-language pass), NOT algorithm redesign; "ship the visibility" → **cockpit sync_phase chart is next** so fleet data shows where we're slow. Livelock SEED remains an open forensic question (schema-bump narrative RETRACTED in review). Ops lessons banked: commit checkpoints between codex passes (a quota cutoff on an uncommitted tree cost an audit); codex quota can exhaust mid-flight (watchers grep "usage limit"; founder can reset); sol HIGH default, xhigh only for the most important (over-engineers); guards pin dedicated tests BY NAME (rename ⇒ sync ci-shard-tests.ts + guards.test.ts); cut codex by MODE at the box (writing new code = run on; polishing = done). **NEXT**: (1) rbox-admin sync_phase chart; (2) 174B wedge-UX + guided savvy-core unwedge WITH founder (dry-runs the UX); (3) pull-scan/push-tail perf from telemetry data. PARKED unchanged: 167, 168, 169, 171, 173 (now feeds 174B)._

_Last updated: 2026-07-21 (late night, part 2 — "175 merged same session") — **DESIGN 175 (172B) MERGED (#383): repos added mid-session now get event-driven commit sync — 3.5-6.4s vs 33-39s scan-bound.** Full /dev-cycle in one session on top of the 172 release: design v1 → r1 PARALLEL wave (codex xhigh 4B+10M + opus 4M) → v2 → r2 serial (2B+5M — both blockers were v2-fold artifacts: reftable layout-detection wrong for real reftable [sentinel refs/heads FILE], floor/pointer contradiction) → v3 → r3 ALIGNED (editorial self-cert) → codex sol implemented U1-U6 in ~35min → **post-impl SCRUTINY audit found 7 real drifts** (2 HIGH: reftable fail-open on config-probe error; Chokidar floor never fed by plan discovery) all adversarially reproduced → fix round with regression tests → /simplify 2-reviewer fold (12 items; headline: registry no-change reconcile short-circuit — was N git-config spawns + ref walks per plan/scan at steady state) → rig 86/0 ×3 runs → PR #383 → one maiden-CI fix (contract job needed release-legs' `--os=* --cpu=*` install for the probe's self-compile literal parcel requires) → merged by founder. **Mechanism**: Linux-only Bun fs.watch ref side-channel registry (git-ref-watch.ts) — Parcel's live dir-add path never enumerates existing children (source-pinned); Bun's does (probe-proven under ≥4600-event Parcel pressure, source + compiled). New REQUIRED CI job `bun-refwatch-contract` = the Bun-upgrade gate (**founder intel: Bun rewriting Zig→Rust imminently — the contract test, not zig source, is the dependency anchor**). Also shipped inside 175: reftable config-authority refusal + GIT_FINGERPRINT_SCHEMA_VERSION 4→5 (closed a PRE-EXISTING silent-staleness hole: reftable repos could carry stale trusted fingerprints forever), packed-refs.lock in gitBusy+fingerprint, `git_capture` cross-surface telemetry {signal,candidate,scan} for the latency-cliff chart (client+API+AE+drift test+documented admin query). **Process rules added (founder)**: time-box codex dispatches (impl ~90min) + glance output every 15min, never >30min blind; cut codex when confident. **v1.7.14 RELEASED + FLEET-LIVE (Mac + flat-meadow), field-verified**: post-daemon new repo on the Mac → empty commit captured event-driven in 7.2s, flat-meadow apply at 27s e2e (first noisy sample of 49s was in-flight-push queuing post-restart, resolved by a settled re-run — macOS-unchanged invariant holds in the field). **SESSION CLOSE (founder: "Great work!"):** probe repo cleaned from the workspace; both 172-era worktrees removed; main synced everywhere. Session totals: TWO releases shipped+fleet-live+field-verified (v1.7.13 design 172, v1.7.14 design 175), commit propagation 31–88s scan-bound → 3.5–7.2s event-driven across every repo shape, PRs #382/#383 merged, reftable staleness hole closed, git_capture chart telemetry live end-to-end, Bun Zig→Rust contract gate armed, rig scenario `git-commit-propagation` guarding it all (86/0, explicit manual gate). **NEXT (founder-sequenced): design 174 apply-side dev-cycle starts now** — three workstreams from banked measurements: notify-pull scan-skip (4.4s of EXT4's 10.8s pull is a full scan per pull), APFS-vs-pipeline split (Mac git-apply measured ~32s vs EXT4 1.7s), push-tail (missing 7.8s / commit 4.5s on 112k files). 1.7.14 timing = founder's call (175 + anything from 174 that lands)._


_Last updated: 2026-07-21 (late night — "commits sync in seconds") — **DESIGN 172 SHIPPED END-TO-END: v1.7.13 released + fleet-live + field-proven.** Perf decomposition of A→B commit propagation (~52s) showed ~31s was send-side detection: `.git` is native-pruned from the watcher, so a commit fires ZERO events and waits for the ~60s safety scan. **Design 172** (5 adversarial rounds → ALIGNED v5; every Parcel claim source-verified): watcher admits the git REF SURFACE (HEAD/packed-refs/refs/heads|tags/stash) as a SIGNAL-ONLY channel — classifier ahead of the shared matcher, separate SignalDebouncer, ref events never touch pendingEvents/manifest (receiver repos stay fsck-clean); conservative native prune (`**/.git/{objects,logs}{,/**}`); Linux safety floor pinned at 60s while ref-watching (Parcel silently swallows IN_Q_OVERFLOW + live add-watch failures — bounded degrade, not detection). **Shipped**: PR #382 (impl + two-host rig scenario `git-commit-propagation`, 83/0 green; /simplify folded — dead chokidar debouncer, derived floor pin, hot-path fast bail, concurrent discovery walk) → v1.7.13 tagged (regress 8/8, exact-SHA CI green) → fleet (Mac + flat-meadow; desktop is NOT currently a bound member — no daemon state). **Field proof (production workspace, 112k files/101 repos)**: empty commit Mac→flat-meadow = capture event-driven in 7.4s (was 31–88s scan-bound), notify 257ms, END-TO-END 35s (was ~52–102s); residual ~28s is push/apply pipeline = design 174's target. **KNOWN LIMITATION (Linux, deliberate, bounded)**: repos created AFTER daemon start never get their ref surface watched (rig-diagnosed as GENERAL — 3-file git init same as 125MB opencode clone; NOT burst/overflow) — their pure-.git commits stay scan-bound ≤60s floor; heals on daemon restart; macOS FSEvents does NOT have this gap (field-verified: settled-daemon empty commit event-driven; the one 88s miss was the designed startup-window signal drop). **172B (the fix) is design-ready**: codex xhigh RECOMMENDATION.md in worktree 172-git-detect — root cause pinned to Parcel's live dir-add path never enumerating existing children (InotifyBackend.cc:151-183 vs initial-crawl :66-79); recommended fix = Linux-only bounded ref side-channel on Bun's fs.watch (path_watcher.zig walks descendants of new dirs :663-670, own inotify fd :454-466 — ALL FOUR load-bearing Bun claims independently source-verified at the bun-v1.3.14 tag, incl. bonus: Bun's dup-suppression is broader than its own doc comment claims, strengthening lock-as-pre-signal); ~300-450 LoC + contract test. **⚠ Bun intel (founder, not in training data): Bun is rewriting Zig→Rust imminently — 172B MUST anchor on the compiled behavior-contract test gating Bun upgrades, never zig source structure.** Estimated 172B: 1-2 sessions (design fold → 2-3 review rounds → impl → rig round flips green). **Rig scenario intel**: shallow clones are deliberately refused by git-sync (preflight, design 43 §14 — peer gets files but no HEAD; papercut logged, polish only). **Telemetry gap for the chart Brian wants**: ws_health/propagation are receive-side only — send-side commit→capture latency isn't sampled; fold a tiny `git_capture {trigger: signal|scan}` sample into 172B to make the 172 drop fleet-visible. **PENDING**: Max update (morning, founder) — his 4-min issue = 1.7.12's cursor fix, 1.7.13 stacks commit speed on top; codex Bun contract probe (scripts/probe) was in flight at session close. **PARKED (unchanged)**: 167 keychain scope Q, 168, 169, 171 Slack-alert cron, 173 two-writer, 174 apply-side (now the top perf lever), 3 /simplify extractions from 170._


_Last updated: 2026-07-20 (evening — "faster sync recovery") — **DESIGN 170 SHIPPED END-TO-END: v1.7.12 released + prod promoted + admin panel live.** Field report (Max): a small commit took ~4 min to propagate machine→machine. Root cause (code-proven): the Cloudflare edge auto-answers the client keepalive `ping` with `pong` WITHOUT waking the DO (`workspace-sync.ts` setWebSocketAutoResponse), so a socket stays "alive" even when it silently missed a `committed` broadcast — the only recovery was the 5-min backstop poll (4 min = one backstop cycle). Half-open detection can't fire because the auto-pong keeps re-arming the deadline. **Two-part design 170** (5 codex adversarial rounds → ALIGNED, self-cert after r4): **Phase 2 (the fix)** = a WS "cursor check" — every ~45s of notification silence the client sends a `cursor` frame, the DO's `webSocketMessage` handler answers `{head}`, and the client pulls if behind; jittered, one-in-flight, epoch+generation fenced, abort-on-stop, no socket cycling, degrade-not-worse. **Phase 1 (telemetry)** = fleet-only `ws_health` AE metric (carrier attribution notify>cursor>backstop>none, applied-pull counts, reconnect/half-open/backstop/notify-latency; opt-out RBOX_TELEMETRY=0) — the observability that confirms the mode + tunes cadence. Founder call: ship the fix now on smell-test confidence (robust to the exact trigger), not gated on logs. **Rollout**: #378 (impl) + #379 (v1.7.12 bump) + #380 (test determinism) merged to main; rbox-admin #6 (Sync-delivery-health panel) merged; prod promoted (main→production, 0 D1 migrations, apps/api delta was just the 170 server changes); tag v1.7.12 → binaries live (`api.rbox.to/version` = 1.7.12, all platforms signed). Prod API already serving cursor handler + ws_health ingest. **Also merged**: rbox-admin #4 (JWKS 3s timeout fixing the cockpit 524 + Sign-out) + #5 (cockpit split: fast D1 core + async /api/metrics). **Cost lesson (release dragged)**: codex-written Phase-2 cursor tests were SYSTEMICALLY flaky (3 tests, fixed-sleep-then-assert-exact vs jittered timers, ~1-in-6) — slipped #378/#379 CI, tripped only on the release-SHA main CI, forcing extra fix→CI cycles. Fixed ALL (waitUntil + suppression-by-domination + robust ranges; production code UNCHANGED; 25/25 clean). New memories: run codex test suites Nx in isolation BEFORE merging; watch codex by OUTPUT not process-exit (it zombies); keep long-lived branches rebased on main (this worktree was 38 behind). **Fast-follow (noted, not blocking)**: 3 architectural extractions from /simplify altitude review (WsHealthTracker collaborator, unify cursor+backstop poll scheduler, accumulator dual-reversal) — green-guarded refactor PR. **PENDING**: Max upgrades (install.sh + stop/start) → end-to-end fix; ws_health data flows → admin panel lights up → design 171 (scheduled-worker Slack alert cron via existing `apps/api/src/ns.js` pingns fleet_alert, ideated by founder). **PARKED**: 167 keychain (PR #365, v4 CHANGES-REQUIRED — residual data-loss all in the arbitrary --kit-path file target; scope Q: account-derived fixed path?); 168 start-outside-workspace / "open from anywhere" (PR #366, tabled, wrong-layer cross-version lock races); 169 encryption-reset (tabled)._

_Last updated: 2026-07-19 (day — "the state-plane reckoning") — **TWO RELEASES (v1.7.5 + v1.7.6, both live + field-verified) + DESIGN 161 SHIPPED + DESIGN 163 PROGRAM LAUNCHED + CI FLAKE CLASS KILLED (3 rounds).** Founder's fresh-install validation found the day's arc: (1) **reset-budget crash-loop** (59 MB state × 52 multiplier vs fixed 4 GiB budget minus warm RSS → daemon dead on a 96 GB Mac) → 161 fast-fix SAME DAY in v1.7.5 (machine-scaled budget max(4GiB,min(totalmem/4,32GiB)) + Linux cgroup caps + teachable error; 52× multiplier deliberately kept per adversarial review — state-shaped multipliers violate 138's fail-closed contract). (2) **12.2s rbox status** → root-caused to the unsettled-daemon fallback (steady-state 0.84s; 162's ambient-first draft DEMOLISHED by review — trusted path already skips scans, dircache already existed behind RBOX_SCAN_PRUNE — parked). (3) **daemon RSS ratchet 2.95→6.6 GB** + **59 MB state rewrite every 30s in steady state** → root-caused to an undefined-vs-{} guard bug (#349) + per-cycle full-blob serialize; BOTH fixed in v1.7.6 (Layer A scan cache default-on with watcher-gated pruning + Darwin bulk recording #348; steady-state write elision #349). Post-upgrade Mac field proof: dc:hit walked=0, no-op cycles save NOTHING, RSS restart 2.63 GB. **DESIGN 163 (state plane → bun:sqlite) is now the flagship program** (founder: park nothing, "full boar", modularized verticals): r1 review = 13 findings/5 CRITICAL (transactions cannot cover 138's multi-artifact choreography; hidden full-manifest materializations negate the memory win; migration/downgrade holes; integrity_check ≠ state witness). v2 KEYSTONE RULING committed (branch 163-v2): file-swap kept at ALL 138 boundaries with a candidate .db (byte-hash witness survives at-rest), WAL transactions only between commit points, WAL-sidecar-present = new crash-window rows, VACUUM INTO for quarantine. RESEARCH-138-BOUNDARIES.md (401-line extraction) on the branch; next: full row table → engine cursor architecture → migration state machine → schema mapping, each through adversarial review. **CI hardening trilogy**: #346 anti-affinity units, #352 suite-wide 3x sweep, then the model correction — subprocess-storm tests get 120s CEILINGS because starved runners inflate 30-60x regardless of local runtime (papercut: size ceilings for the worst runner). Regress-in-CI is LIVE (RBOX_DEV_BOOTSTRAP secret set; maiden run green; report-only, src-filtered, ~5min — founder may demote to nightly). **158 U1 (mint-account) BUILT** (real first-login path; Clerk key journey: quotes → rotated key → working; dev-worker __absent-azp__ sentinel shipped #351): awaits ONE founder dashboard edit (append ,__absent-azp__ to dev worker CLERK_ALLOWED_ORIGINS) then live mint→burn proof. Fleet: Mac on 1.7.6 (only host with the new identity; desktop+FM still bare by founder intent). Pending founder: dashboard edit; regress cadence call; 163 v2 continues next session._

_Last updated: 2026-07-19 (pre-dawn wrap) — **EVERYTHING MERGED: #336 picker + #339 CI papercuts + #340 front-door v2 all on main; next-release candidate complete.** Founder's bedtime findings same-night fixed (#340): (25) "plan unavailable" on fresh pro device = cache-only brief identity — front door now does ONE bounded 2s best-effort fetchAccountSummary on a cold cache (seeds the shared profile cache; the parked identity-cache self-heal is UNPARKED and shipped for the front door); (26) founder menu order — [Sync now + Start background syncing | Pause syncing] → Set up a new workspace → Pair another device → View usage → View logs → Exit; orchestrator restored Start-background-syncing (codex cut dropped it; founder ratified keeping Pause). #339: `bun run guards` (CI guards runnable locally — fixture-tested) + path-filtered `web · check + build` PR job (merge-base git diff detection, npm 10.9.2). #336 needed one branch-update after runner-starvation timeouts (release build contention) — second CI clean. Session velocity data (founder asked): 15 PRs merged + 1 CLI release + 1 prod promotion + 2 designs drafted→ALIGNED (159: 8 rounds ~3h; 160: 4 rounds <1h) + 159 implemented/merged same night; 54 commits on main in 26h; ZERO codex correctness re-dispatches across ~10 implementation dispatches (self-run tests = biggest cycle saver); auto-merge is attention-saving not wall-clock-saving (watchers were already fast, but killed-watcher failure class is gone); `bun run test:affected` went UNUSED tonight (adopt next session — ~3min × ~8 full gate runs left on the table). Morning queue for Brian: v1.7.4 fresh-install validation, then call the next release (picker + front door + guards ride it)._

_Last updated: 2026-07-19 (early AM) — **v1.7.4 RELEASED ("a first sync you can watch") + BRANCH RULESET LIVE (PRs required on main, native auto-merge) + 159 IMPLEMENTED (PR #336, rides the NEXT release).** v1.7.4 = the validation-audit CLI batch: byte progress with MB/s + stability-gated ETA (#329), seven onboarding polish items (#328), set-up-another-machine after setup (#332), RBOX_DEBUG telemetry gating (#333), honest gitignore copy + !.env secrets teaching (#335, founder-decided relabel path). Tag a638f2e; release workflow green; manifest live (3 artifacts). Founder-sequenced: #336 (typeahead picker, design 159 implemented + full-scrutiny reviewed, ALL gates green incl. regress 11/11 with the picker driving flows; one red CI round from the @inquirer single-import guard — widget moved into prompt.ts, pure logic stays in directory-picker.ts) was DELIBERATELY held out of 1.7.4, auto-merge re-armed post-tag. **Process changes: `main` requires PRs now (even docs — owner bypass removed by founder); the nine required checks exclude Cloudflare Pages (false-fails); `gh pr merge --auto --squash` at PR-open replaces hand-rolled merge watchers.** Design 160 (gitignore preview) ALIGNED + PARKED with founder's future-evolution idea recorded (suggest `.rboxignore` inverses from secret-shaped NAMES, existence-only). No prod promotion needed (zero apps/ delta since 1d68d35). Fleet note: hosts still wiped from validation; `~/rbox-dev` staged binaries now superseded by the real 1.7.4 installer. Founder pendings: fresh-install validation pass on 1.7.4 (`curl -fsSL https://rbox.to/install.sh | sh`), #22/#3 unchanged, 155 + 158 parked._

_Last updated: 2026-07-19 (overnight — founder-authorized dispatch run) — **DESIGNS 159 + 160 BOTH ALIGNED (implementation NOT dispatched — founder's call) + PR #334 papercut fixes MERGED.** **159 typeahead directory picker** (validation #8): ALIGNED at v8 after EIGHT codex adversarial rounds (12→5→4→1→1→1→3→0 findings) — final shape: custom `@inquirer/core` prompt (stock search widget provably can't express it), single state tuple (raw string + highlight) with a staged lexical→expanded→resolved projection, pinned `use "<input>"` row preserving the type-nonexistent-path→create-confirm contract, Enter/Tab split (highlight resets to use-input row on edit; Tab completes best-ranked child), blocking readdirSync (no async source = no race class), lifetime-memoized listings. Two of the eight rounds were self-inflicted: silent no-op `str.replace` folds left stale contradictory text the reviewer attacked (papercut logged; fix = whole-section replacement + grep-verify). **160 gitignore sync preview** (validation #9): ALIGNED at v5 after 4 rounds — preview is an ACTION row that re-prompts (never a third policy), decisions come from the production resolver via a new `readOnly` + budgeted discriminated-result build mode, four-set truth-table model including the INVERSE set B′ (tracked root-ignored files sync under "skip gitignored" but NOT under "sync everything" — tracked protection + legacy layering), per-policy ancestor-prune walker, fail-closed on budget cap. **⚠ FOUNDER DECISIONS OPEN: (1) design-160 surfaced that the shipped option-2 label "Sync gitignored files too" overpromises TODAY (root .gitignore respected in both modes; relabel vs engine change — design assumes relabel); (2) implement/park order for 159 (M-L) and 160 (M); (3) branch-protection ruleset (exact recipe in session transcript) to enable native auto-merge.** **PR #334 MERGED (papercuts):** `release.ts --dev` (honest `<ver>-dev+<sha>` stamp, no changelog/signing gate, version.ts restored in finally), bun-vs-vitest wrong-harness guard (instant clear error), rig image-hash cache moved to /tmp (regress no longer dirties the checkout). `docs/papercuts.md` live and founder-mandated: append EVERY friction finding as it happens. Carry-overs: founder dev-binary validation pass (staged `~/rbox-dev` ×3 hosts, RBOX_API=dev one-liner), CLI release after it, Stripe "90-day history" copy (#3), 155 fold + 158 e2e-loop still parked._

 — **ALL 24 VALIDATION-AUDIT ITEMS RESOLVED OR FOUNDER-PARKED + PROD PROMOTED (1d68d35).** The founder's from-scratch validation list (`docs/validation-2026-07-18-new-user-flow.md`) is fully drained: PRs #326–#333 merged same-day — #326 gc-phase1 cursor-flake fix (batched seeding), #327 Stripe checkout prefills the sign-in email (reuses notify.ts ownerEmail, soft-fail), #328 seven CLI polish items (authorize menu browser-first + "Approve a code" REMOVED (duplicate of the browser device-code path), c-copies-auth-URL, workspace definition in setup, 10s slow-notes, calm git-history line, no-reboot start-sync copy, workspace-name+hostname final screen), #329 byte-based progress (scan shows bytes, upload gets 5s-window MB/s + stability-gated ETA via pure sample-fed estimator `transfer-rate.ts`, ALL transfer percents byte-derived, decimal units), #330+#331 flake hardening (watcher-retrust ±1ms clock race + codex sweep of 10 more test files: sleeps→handshakes, wall-clock→logical clocks; 6 deliberate note-onlys where timing IS the contract), #332 post-setup "Set up another machine" one-shot (reuses pairCreate; note: "run \`rbox pair\` on an already-paired machine"), #333 dev telemetry (phase-report summary + multipart instrumentation) gated behind existing RBOX_DEBUG at the print boundary. Also: CSP `font-src 'self' data:` (#24) on main; billing_interval backfilled for the founder's prod row ($200/year renders); **prod promoted with founder pre-authorization** (deploy-api + Pages green); **dev binaries staged on all 3 fleet hosts as `~/rbox-dev`** (built from main, version-string says 1.7.3 due to the changelog gate — content is main-tip) for the founder's `RBOX_API=https://rbox-dev-api.brian-via.workers.dev ~/rbox-dev setup` validation pass. **Design 158 (e2e validation loop) committed + PARKED**: U1 disposable dev-Clerk account mint/burn script, U2 dev-backed rig scenario (mint→setup A→pair B→sync→burn), U3 fleet dev-build staging helper — founder: "soon but not atm". REMAINING from the audit: #8 typeahead dir picker + #9 gitignore preview + #22 renewal emails (founder-excluded; #22 until real users), #3 Stripe dashboard "90-day history" copy (founder's edit + retention decision). New standing rules (in agent memory): flaky shard → parallel codex fix + rerun-watcher (check startedAt vs completedAt — 40min "in_progress" was runner-queue starvation, executed in 61s); review effort proportional to task complexity. Ops: session background tasks kept getting externally killed — `setsid` detach + sentinel files (CODEX-DONE) + persistent Monitors is the resilient dispatch pattern; codex sandbox can't run the Docker regress gate (rerun locally via `sg docker` every time). CLI release for #328/#329/#332/#333 PENDING founder validation via the staged dev binaries._

 — **DESIGN 155 SHIPPED to branch `claude/affected-only-test-loop-a7ssby` (PR pending): `bun run test:affected`** — reverse import-graph selection (src/+scripts/+apps/api incl. `?raw` assets and repo-path string literals) from the merge-base(origin/main)→working-tree diff; runs only affected bun test files + affected api vitest files with provenance per selection ("← changed file"); conservative fallbacks (toolchain/config → full bun suite; anything reaching apps/api/src, wrangler.jsonc, migrations, or vitest.config → full `vitest run` since api tests exercise the composed Worker over SELF in one workerd); changed-but-untested files reported, never dropped; ~150ms selector overhead; measured: leaf CLI edit 190s→~1s, single api test 60s→1.5s. Local accelerator ONLY — CI shards stay the merge gate. **Metadata-heal flake QUARANTINED locally** (`test.skipIf(!CI && !RBOX_RUN_QUARANTINED)`): root cause NOT established — passes isolated AND full-suite on Linux under bun 1.3.11/1.3.14 (15+ attempts in the remote sandbox); every known failure is a macOS dev machine (nightly runs + codex sandboxes). CI keeps running it; assertion restructured to a combined {committed, deferred, encryptCalls} tuple so the NEXT opted-in failure self-attributes (scan/churn defer vs re-encrypt vs conflict) — capture that output on the Mac (`RBOX_RUN_QUARANTINED=1 bun test src/cli/sync/sync.test.ts` won't do it alone if the trigger is full-suite context; use `RBOX_RUN_QUARANTINED=1 bun test src/cli`), then root-cause and delete the skip. Registry note: "green means green" restored for `bun test src/cli` on dev machines._

_Last updated: 2026-07-17 (day session — "quota fixes/git improvements") — **DESIGN 138 MERGED (#306) + 142 PHASE-0 MERGED (#305, +143/144 fixes #307) + v1.6.9 FLEET-LIVE + STORAGE INCIDENT ARC CLOSED.** **138 reset-path hardening MERGED**: 9 adversarial rounds (convergence 10→9→8→5→4→2→1), NORMATIVE crash-window row table (codex-derived, ratified), unforgeable consent witness threading 137's wizard seam, repository-order lock fence, daemon halt/heal, crash-resumable quarantine + `rbox doctor reset-journal`; scrutiny's 4 safety hunts CLEAN, 2 composition MAJORs found+fixed (quarantine→rebind dead-end; observation-error poisoning); the derivation also found 2 power-loss fsync bugs. UNRELEASED — rides the next CLI release (v1.7.0 candidate; Max-window rule applies). **STORAGE ARC**: founder acct hit 250/250GiB ⛔ → +100GiB bump (350 cap), fleet-wide respect-gitignore flip, 95,324 legacy paths purged (desktop) + 12 (Mac second pass) — the scary 32k "resurrection" was the Mac's design-44 changed-file guard correctly deferring deletions mid-build, self-drained; usage ~253GiB is now RETAINED HISTORY (365d) + unknown leak share — **142 Phase-0 storage-truth runner MERGED** (read-only decomposition: partition + Phase-1 health probe + R2 reconciliation; scrutiny 8 findings → SHIP; wrangler remote-bindings hang → REST adapter #307; timestamp-gaps degradation for the best-effort commits mirror) — **live founder measurement IN FLIGHT** (route promoted to prod ×2 today). Path down: measure → reclaim stranded/drift via existing GC (or cap fix if probe says fail-closed) → 142 Phase 2 active-state quota (founder-ruled: quota = active files, history tiered/fair-use 5×, pricing unchanged, accelerated pruning TABLED, site copy after ship). **141 git-shapes**: ALIGNED v3 (13→6→annex; 637-line code-derived outcomes annex normative), implemented, FOUR live rig runs (fails 29→5): confirmed engine gap `bisect-invisible` (sidecar-recorded, follow-up design owed), partial-clone "hydration" was an observation artifact (retracted); final 5-fail fix round in flight (s5-rebase convergence may be a 2nd genuine gap). **Also**: RboxBar Raycast bug fixed (candidate list omitted ~/.rbox/bin — the installer's own path; uncommitted, PR pending), hourly founder-update cron live, stale cross-session shells audited/killed. Queue: 141 finish → PR; bar-fix PR; STATUS/artifact refresh; structural cycle (apply.ts split + 15 unproven invariants) next after 141; git-shapes Tier-2 + native-mac backend + bisect-gap + s4-hydration follow-ups named; 139 plain-words pass queued. Founder pendings: v1.7.0 timing; 253GiB decision after measurement (Phase-2 vs retention-trim)._

_Last updated: 2026-07-17 (overnight autonomous run) — **v1.6.8 FLEET-LIVE + DESIGNS 137/140 MERGED + AI-UX VALIDATION LOOP OPERATIONAL.** **v1.6.8 released + fleet×3** ("zombie branches rest in peace"): 130 branch hygiene + 134 second-device clarity (Ryan's feedback, same-day); production promoted (dashboard live); changelog pipeline FIXED end-to-end (RBOX_HOME_DEPLOY_HOOK minted via CF API → repo+release-env secrets; release run green attempt 3). **The new loop**: designs 135/136 built a containerized TUI-walkthrough harness (fresh-machine + tmux driver, ux=1 containers, dev-only) → 20 developer-persona flows found 3 P0s (tilde literal-dir; typo'd path mints a phantom workspace; wizard exits where engineers expect re-prompt) + 8-flow "stupidly simple" clarity audit (scorecard 12/21/36; copy backlog = future 139 plain-words pass) → **design 137 wizard resilience MERGED (#303)** (4 review rounds, v5; Rule 0: retry only local pre-network validation; mutex-before-mint; shared token parser by construction; scrutiny spec-neutering audit CLEAN) → **design 140 deterministic regression gate MERGED (#304)**: `bun scripts/ux/regress.ts` (now in the release checklist) — 11 flows, ALL PASS live incl. the six 137-detectors that PENDING-FAILed pre-merge and XPASSed post-merge. **INVARIANTS.md MERGED (#302)**: 138 engine promises in plain English, 15 with NO test proof (feeds the queued structural cycle: apply.ts split owed since 113 + >800-line hot files). Dev noise muted: new-account pings (#300) + fleet alerts (#301) silent on dev deployments (rig/UX traffic isn't customers). **INCIDENT (resolved, productive)**: harness smoke with HOME-isolation-but-not-cwd let a dev-pointed rbox plant a foreign reset journal in the desktop's PROD workspace (daemon pump errored until quarantined) → exposed 2 engine bugs: stream-mismatch auto-reset without consent + the 64MB reset-read cap that ALL THREE fleet state.json files (~77MB) exceed — recovery is currently impossible fleet-wide → **design 138 reset-path hardening IN REVIEW** (worktree reset-hardening; round 3 done, 8 findings; v4 fold = next task; convergence 10→9→8; this is 130-grade machinery — consent capability on the destructive primitive, read-only crash-state classifier, sync-halt on journal uncertainty, crash-resumable quarantine). **QUEUED (founder-sequenced)**: 138 v4→ALIGNED→implement; git-shapes burn-in design (Tier 1 greenlit: submodules, LFS, NFD/case-insensitivity, shallow/partial clones, in-progress-op matrix — ONE design, parallel fixtures, starts when CLI rework settles); structural cycle; 139 plain-words. **FOUNDER DECISION PENDING: tag v1.6.9 (137's onboarding fixes) before Max's window or hold.** Release gate for it: regress.ts green (it is). Reports for Brian: scratchpad UX-REPORT.md + CLARITY-REPORT.md (sent). Standing overnight authority honored: merge-on-green+scrutiny yes, tags no, prod promotion his._

_Last updated: 2026-07-16 (night) — **v1.6.7 FLEET-LIVE + DESIGN 130 MERGED (soaking, unreleased) + PRODUCTION-BRANCH PIPELINE VALIDATED + MAX-ONBOARDING PREP.** **130 follower branch hygiene MERGED (#297)** after the deepest cycle ever: 11 design rounds (v6 single-invariant rebuild: BASE-absent only-by-CAS + A(R) artifact; v9 clean-room consolidation), high-reasoning implementation, a safety scrutiny that caught a FEATURE-NEUTERING provenance bug (origins stripped on every uneventful pull — green design rounds + green suites would have shipped a silent no-op; the missing follower e2e was the vector) + a dropped crash gate, retrofit-surface regression triage, live Docker-rig validation (failure set == pre-130 known-races EXACTLY after 2 scenario assertions learned designed behaviors), and a 3×-CI-red mystery that was an absolute-path import in a copied repro test. **RELEASE-GATED: soaks on the fleet via dev builds; ships in v1.6.8 after rebase-churn evidence.** **v1.6.7 RELEASED + fleet-live** ("a first sync you can predict"): design 133 onboarding polish — founder flipped the wizard default to RESPECT .gitignore (sync-everything stays as the honestly-worded E2EE opt-in, !re-include + mode-toggle escape hatches taught in-flow), honest ignore --list, truthful README/docs, browser-first signup; from a fresh-eyes onboarding audit (remaining: macOS notarization candidate, bare-rbox docs). **PIPELINE REBUILT + VALIDATED**: `production` branch is the only deploy source — resurrected test-gated deploy-api.yml (tests → prod D1 migrations → deploy → versions; founder disconnected prod Workers Builds; DEV Workers Builds on main kept — every main merge auto-validates on dev); first promotion (04c2aff) green end-to-end. Publish's changelog step needs repo secret RBOX_HOME_DEPLOY_HOOK (founder; binaries published fine — not a tag-move case). **MAX HOWELL (Homebrew) MAY ONBOARD ≤24H**: no releases in his window unless fixing something HE hits; he gets v1.6.7; .rboxignore field-validated end-to-end (ignored path never left the machine; control synced ~30s round-trip). **RYAN FEEDBACK (second-device flow) IN PROGRESS**: pairing-token provenance unexplained, post-link dead-end (no attach-existing-workspace guidance), "code" vs "pairing token" are TWO credentials reading as synonyms, dashboard→docs link missing — recon done→fix bundle next (Max hits this seam day 2). Parallel-session collision: #296 claimed design №132 mid-flight (mine → 133); rig test-device alerts (6×, orphaned dev accounts) → #293 rider. Flake registry+: §11 concurrent-saves E2E re-confirmed (docs-only branch + green rerun; 07-13 determinism fix still owed). Backlog+: orphaned device_sync_state rows invisible to admin purge; `rbox ignore --review` picker (founder idea); notarization; ~190 stale merged branches enumerated for deletion. Prior header below._

_Prior header (2026-07-16 evening): 2026-07-16 (evening) — **DEPLOY PIPELINE SPLIT: `main` is integration-only; verified green candidates are explicitly promoted to deployed `production`, where web deploys and prod D1 migrations run**. **v1.6.6 FLEET-LIVE + FLEET FULLY CONVERGED — "do 2 then 1 then 3" arc complete (designs 127/128/126/129, PRs #288/#289/#290/#291, all merged same-day) + two designs in review-flight (130/131)**. **127 fleet push alerts LIVE ON PROD**: hourly cron evaluates D1-only conditions (drift >24h per binding with positive-evidence-only resolution; reporting_stopped per device, latched, 2.5h onset) → #rbox-alerts via a new fleet_alert SlackPipes event; claim-fenced sends (conditional state write whose WHERE re-asserts the source condition — concurrent crons can't dupe, stale snapshots can't claim; NO failure reversion, at-most-once per window), incident model (2h continuation debounce, one ⚠️/✅ pair per incident via resolve_notified_at, "still:" dailies, 7d silence, 30d prune), migration 0028 alert_state, lifecycle deletes + evaluator deletes zero-row stopped incidents outright; 5-round design review. **128 show-me batched proofs**: thousands of serial subprocesses → ≤5 (batch-check with ^{commit} peel + positional parse, fail-closed rev-list --quiet integrity walk — review's reproduced CRITICAL: batch-check alone misclassifies missing-parent commits as owned — streamed roots-closure ownership O(candidates) memory, batched subjects), presentation-only 50-cap (protectedOids/JSON exhaustive), show-me-only stderr progress; **field-proven: 2.5s on the repo class that ran 30 minutes** (542 candidates ~25s on Mac rbox-core). **126 ORIG_HEAD breadcrumb waiver (7-round review at high reasoning)**: exhaustive OP_STATE_CLASSIFICATION (ORIG_HEAD sole breadcrumb), presence-gated sole-blocker waiver finalized only after the journal published flip, preservation-before-adoption (refs/rbox-recovery capped 8/worktree + capture --exclude=refs/rbox-* closing an internal-ref bundle-leak class + quarantine arm), journal-owned ORIG_HEAD.lock (journal.id sidecar ownership); **scrutiny pass caught 3 implementation safety regressions post-design-alignment** (2 new journal crash-window strands, 1 boundary preservation bypass) — the layered process worked. **129 org tidy** (founder ask): CODEMAP apps/api section + sanctioned protocol-module policy + telemetry/ mapped; watcher/ambient-status/drift-audit → cli/daemon/, git-deferral-json → sync-git/, release-verify helpers homed, readBodyCapped/packKey → api util, 88 dead engine barrel exports pruned; watcher SCALE test RSS gate → delta-based (order-fragile absolute). Audit verdicts: apply.ts +112% over its 113 plan (NEEDS ITS OWN SPLIT CYCLE — recommend next), daemon.ts +30% over exception budget; apps/api featurization deferred (~fine at 41 files). **FIELD ARC — the day validated its own designs**: today's release churn reproduced the ORIG_HEAD strand on Mac (BOTH repos) exactly as predicted; investigation revealed the waiver was correctly VETOED by heldRefs — root cause: **squash-merge workflow strands every merged-deleted branch as a permanent per-ref hold on followers** (Mac rbox-core: 83 local-only commits across dozens of dead branches; rbox-admin: an amended local-dev-prod). Remediated fleet-wide with take-theirs (Mac+FM, both repos, quarantine bundles preserved) — **fleet fully converged on v1.6.6**. Diagnostic gap noted: waiver veto logs nothing (rider in 130). **DESIGN 130 (follower branch hygiene, ref-deletion tombstones) v5 — 4 review rounds done (16→8→5→2 findings), ROUND 5 PENDING — worktree feat/branch-hygiene pushed; NEXT SESSION: run round 5 → ALIGNED → implement (advertised-value tombstone chains, LIVE+BASE+consumed-marker provenance, expected-absent-CAS retirement with generation fencing, keep-pin preservation with aging tombstone origin, single outbound normalization boundary with pending exemption, §126 veto-logging rider)**. **DESIGN 131 (rig runtime backends: Apple container + Docker/Linux — shortens Claude's validation loop to localhost) v2 — round 2 in flight, worktree feat/rig-portability; RunnerBackend seam in lib/container.ts (single choke point, verified), canonical StatsSample contract, container-label recreation enforcement, daemon-info doctor + transient probe, acceptance = full Docker FAST_SUITE on via-desktop vs rbox-dev-api**. Ops: wrangler token at ~/.secret_env_vars (memory updated; dev-first unblocked), fleet-SSH permission rules added by founder (autonomous rollouts now), PREMATURE-MERGE lesson recorded (#290: gh pr checks --watch exited 0 with pending checks; gate on run conclusion — the failure was a proven fixture flake, rerun green). Backlog+: apply.ts split cycle; chaos-restart on Docker (Apple-wedge exclusion may not apply); alert_state veto-gate observability rider (in 130); squash-merge residue on any NEW follower joining before 130 ships (take-theirs playbook applies). Prior arcs below._

_Prior header: 2026-07-16 — **v1.6.5 SHIPPED — the fleet phones home (design 120 telemetry ingest + cockpit, PR #287 + rbox-admin panels, same session unpark→prod)**. Design 120 (drafted by the cockpit session, parked) was unparked on founder go-ahead: 4 open decisions resolved (D1 was ALREADY SHIPPED as `devices.last_seen_version`/0026 — recon caught the doc stale; D2 single route + declarative hard validator; D3 per-family client retention + `RL_TELEMETRY` namespace **2006** per-device limiter, no stateful server state; D4 separate `POST /v1/fleet/sync-state` **aggregated per device×workspace×project×binding_id** — server has NO repo concept, per-repo would be a path-id leak; drill-down stays on-device via 124) through a **5-round codex adversarial review to ALIGNED** (27 findings; keepers: random per-root `binding_id` kills the multi-root alert-flap, **ages-not-timestamps on the wire** (unsynced clocks), server derives corpusBucket/mbps (client-derivable = contradiction surface), dispatchReason UNREPRESENTABLE per-push → family is per-push×transport, revocation cleanup guard must live IN the DELETE statement for retry-safety). Server: `POST /v1/telemetry` (schema-table validator via `satisfies`, normalized-positional-only AE writer, canonical-value blob reconstruction, hostile-mbps guards, per-reason drop counters incl. bad_state/unauthorized), migration **0027 `device_sync_state`**, lifecycle deletes (ws-purge inventory + account-delete device-id prefetch BEFORE directory delete + plane-clean revocation), rider fix: invalid `x-rbox-version` can no longer NULL a stored version. Client: `TelemetryQueue` (safety events coalesced/never-evicted, capability latest-slot, per-family rings, 120s unref'd flush, 429 backoff, permanent-4xx discard, `RBOX_TELEMETRY=0` kill switch, post-drain 1.5s shutdown flush), push-scoped ALS lane accumulator (settled-HTTP-requests only, batch/pack/single), `SyncStateReporter` reusing 124's `projectGitDeferralRepos` (cockpit and device can NEVER disagree) + fingerprint gating + hourly heartbeat. Process: /simplify 4-angle (9 applied — incl. telemetry rides RboxApi's ONE RemoteContext) + /antislop scrutiny (8 applied — **FIX-NOW caught: `ensureTelemetryBindingId` could clobber a legacy/mismatched sync baseline; now throws instead of manufacturing state**). PR #287 CI green → founder "merge it" (dev-first verification WAIVED this once: wrangler auth unavailable on desktop — routes have zero existing callers, migration additive-only). Prod verified live (both routes 401 at auth gate), **v1.6.5 released**, desktop upgraded + **positive end-to-end proof: bindingId `61259a7bdf468076` persisted + zero failure lines = prod D1 row exists**. **rbox-admin cockpit: 7 panels shipped to main (`8b34e8d`)** — propagation p50/p95 (labeled delivery→apply, honestly), first-publish funnel by corpus bucket, fleet version+capability (the #270 pool-silently-dead alarm), upload-lane Mbps by transport, **fleet drift table (24h alert = `oldest_deferral_age_ms + (now−reported_at)`, 2.5h staleness dimming)** — the panel that would have caught the Mac's 4-day ORIG_HEAD strand from a dashboard — client safety ticker, ingest-drops health. AE queries `_sample_interval`-weighted. **PENDING: Mac + FM upgrades to 1.6.5** (SSH fleet writes need founder approval outside auto mode — two commands: `ssh dfinitiv-macbook-pro 'cd ~/Development && ~/.rbox/bin/rbox upgrade'`, same for flat-meadow-prod-main-01; until then those daemons emit nothing). Wrangler auth on desktop still absent (dev deploys blocked; `npx wrangler login`). Watch items carry: ORIG_HEAD/126, git-entanglement scenario hardening, resolve show-me perf, upgrade stale-runtime-dir UX, json-output DI._

_Prior header: 2026-07-16 (past midnight) — **v1.6.4 FLEET-LIVE — logs that rotate, deferrals you can see and fix (designs 124+125, PRs #285/#286, founder-ask → fleet same evening)**. Born from the founder's RboxBar screenshot ("2 repos deferred · 1h — what do we do here?"): **124** menu-bar deferral drilldown (≤5 repos, plain-language reason + both ages, provenance labels, +N more) + **Copy Git fix brief** (self-contained human/LLM-pasteable doc: per-repo diagnosis, transient-vs-decision honesty, POSIX-quoted cd-anchored commands, `-- end of brief · N repo(s)` terminator; unknown/forged reasons can NEVER render resolve commands — capability gate shares the resolver's own predicate) + `rbox git deferrals [--brief|--json]`; ambient status carries a bounded sanitized deferral array (schema v1 additive, per-item drop, version-skew safe both directions); RboxBar gained a capture-with-timeout subprocess API (deadline-bounded post-kill drains — descendant-held pipes can't hang the bar) + generation-tokened clipboard state machine; 62/62 swift on the Mac; **field-proven within the hour on REAL deferrals** (brief output verbatim-correct). **125** daemon log rotation: daily `daemon-YYYY-MM-DD.log` (sync O_APPEND, one-Date records, multi-process-safe protocol), 14-day filename-date retention (`RBOX_LOG_RETENTION_DAYS`), `daemon.log` demoted to guarded crash sink (5MB boot guard + pointer records), `rbox logs` merges streams chronologically + follow survives rollover/restarts, ALL direct readers migrated (starvation probe, doctor, rig, swiftbar — helper renamed `daemonCrashLogPath`), operational console bypasses routed through the injected sink, `repoMs=` capped at 8 exemplars + queue/wall/chain p50/p95/max (designs 74/83/100 signals preserved; full line under RBOX_DEBUG) — context: Mac daemon.log was 44MB/8 days, 75% of it ONE v1.6.2-era line already killed by 118's backoff. Fleet upgraded via managed `rbox upgrade` (dogfooded; works — but lists stale benchmark runtime dirs as scary ✗ failures: UX finding below), dated files live on all hosts, RboxBar rebuilt+reinstalled. **TEST RIG REPAIRED + field-validating again** (was fully rotted): login lost `--no-interactive` in v1.6.1; image git 2.43 < the 2.46 symref floor (git-core PPA → 2.54); **PID-1 `sleep infinity` never reaps → dead daemons persist as ZOMBIES that still pass pid-liveness lock probes and wedge every later sync** (image + create calls now run tini; Apple `container` IGNORES Dockerfile ENTRYPOINT — pass init in create args; `rig down` before `up` when image/create-args change). two-device-live green on 125 code; git-entanglement has its own pre-existing scaffolding races (update-ref 128 on fresh containers, edit-lane follow timing) — needs a scenario-hardening pass. **MORNING REMEDIATION (same session): Mac "Degraded" panel root-caused** — (a) FSEvents drops from desktop-churn applies → periodic-scan fallback working as designed, cleared by restart; (b) **ORIG_HEAD op-state three-way mismatch NEVER self-clears** (follow.ts:368 defers unless live matches base OR incoming; a follower that misses the window while the publisher rebases is stranded forever) — Mac's rbox-core sat on a 4-DAY-old HEAD; fixed by writing the publisher's `.git/ORIG_HEAD` value on the follower → git-sync followed clean in one cycle; **REPRODUCED AGAIN same evening** by the 124/125 rebases (Mac+FM re-aligned). WATCH ITEM (founder call: monitor, don't build yet) = **design 126 sketch: classify op-state files — in-progress markers (MERGE_HEAD, rebase dirs) keep deferring; breadcrumbs (ORIG_HEAD) get waived+adopted when every real-work guard passes**. Also found: `rbox git resolve` show-me ran 30 MINUTES with zero output on the 150k-file repo (serial git subprocess walk — needs progress + perf); `rbox-admin` "local commits" deferral was manifest-lag misclassification (Mac was a pure follower all along). Backlog+: rig portability (Apple container + Docker/Linux — founder ask); `rbox upgrade` stale-runtime-dir UX; json-output.test reads the real signed-in account cache (fails on dev machines, passes CI — needs DI); worktree deletions leave rboxignored husks fleet-wide; Bun quirk recorded: `process.exitCode = undefined` cannot clear a set code. Prior parked/backlog items carry (identity-cache self-heal unpark candidate, RboxBar 100%-label, build.log churn, open-source pre-flight)._

_Prior header: 2026-07-15 (evening) — **v1.6.3 FLEET-LIVE — the lock-hardening release (designs 118/119/121/122/123, PRs #279-#284, all merged same-day)**. Born from one founder question ("any problems in the logs?") → fleet sweep found: Mac starved 26h (macOS kern.uuid is PER-BOOT → own stale lock read as foreign → 341,824 spin lines), `rbox git resolve` field-broken (marker leak + swallowed errors), FM's git 2.43 lacking symref-update, and a case-colliding branch wedging savvy-core on APFS. All remediated live (fleet deferral-free) AND productized: **118** stable darwin identity + boot-alias ledger + locality-gated probe (unknown-hostId markers on a proven-local fs = identity drift → normal dead-probe reaping; fail-closed via the kernel's own MNT_LOCAL flag after field validation caught `stat -f %T` returning file-type — locality was inert on macOS until the real-adapter test pinned it), break-path exact-ownership cleanup incl .reap fence, >15min starvation surfaced in status/doctor + counts-only lockStarved metric, abortable 250ms→30s pump backoff, typed resolve errors (sync-busy), doctor git-capability probe, `rbox upgrade` stop-and-WAITS + restarts all daemons + status version-skew line (field-verified verbatim). **119** per-device last-seen CLI version (x-rbox-version header; 60s change-floor vs mixed-version ping-pong). **121** RboxBar once-per-version update notification + one-click managed upgrade (39/39 swift on the Mac; app rebuilt+reinstalled). **122** slackpipes via waitUntil + 5s/retry + #rbox-alerts self-report with URL derivation — root cause of the missed customer-signup pings was the 700ms inline timeout (prod-log receipts), NOT missing config; both channels field-verified 202. **123** the 'shellStateOf host flake' WAS NEVER A FLAKE — a stale hardcoded cliVersion literal in a full-DTO fixture; blocked the first v1.6.3 build twice; registry corrected: same-SHA metadata heal is the ONLY tolerated flake. **BUSINESS: rbox has a real paying customer** (coworker, pro, since 07-11, engineer) — standing rule recorded: deploy main freely, mind breaking changes (client-skew story per protocol change; see memory prod-customer-compat). PARKED→UNPARK CANDIDATE: identity-cache self-heal (customer machines show acct-id fallback). Backlog+: RboxBar progress label sits at '100%/syncing' during apply phase (cosmetic); home-dashboard build.log syncs every 10min (rboxignore candidate)._

_Prior header: 2026-07-14 (evening) — **v1.6.2 FLEET-LIVE (identity banners, design 117)**: untracked-dir menu / setup skip-notice / `rbox account status` / status ACCOUNT section show "Signed in as email (method)" from a new non-secret local cache (`~/.rbox/account-profile.json`, 0600, terminal-injection-sanitized, accountId-keyed, logout-cleared; fills on any successful account fetch, banners stay network-free; acct-id fallback for cold cache / CLI-only accounts). Server: `/v1/account/status` returns the design-16 cached email + REAL GAP FIXED — provisioning now seeds the email cache at FIRST login (was NULL until 2nd web login; also helps new-device alert recipients); `email_updated_at` stays NULL at seed so the returning-login refresh throttle is untouched (contract documented at clerk.ts write + notify.ts read). PR #278; dev-first deploy verified; prod field-proven (endpoint returns founder's email; banner renders it end-to-end; signInMethod null until next web login — renders without parens). NOTE for founder: your `signin_method` fills on your next app.rbox.to login. PARKED (founder call, single-user): identity-cache self-heal on cold banner render — fresh machines show the acct-id fallback until the first `rbox status`-class command fills the cache; revisit at onboarding polish / first external users (spec was drafted, cycle stopped, worktree removed)._

_Prior header: 2026-07-14 (afternoon) — **v1.6.1 FLEET-LIVE (bare-rbox front door)**: enrolled bare `rbox` in an untracked dir now shows a menu (Track this directory / Sync existing / Nothing) instead of jumping mid-wizard to "Step 2 of 3"; setup step numbers count only steps that run; daemon-aware Pause/Start in the front door; 4 audit-backlog copy fixes rode along (pair finish path, bootstrap-secret prompt, first-run error → setup). PR #277 (opus UX design pass → codex impl → /simplify 7 refactors → /antislop), all 3 hosts verified 1.6.1 + menu live-rendered. **SITE DRIFT AUDIT**: 13 verified findings vs v1.6.0 CLI in `../rbox-home-page/docs/cli-drift-2026-07-14.md` (highs: `rbox recover` documented as phrase re-enrollment — wrong since 0.9.14; extra-storage $3/100GB advertised but unpurchasable — checkout/webhook single line-item only); founder had codex apply. **OPEN-SOURCE READINESS (CLI + API)**: full-history scan (1,191 commits, all refs) found ZERO credential-grade secrets and no obscurity-dependent server code (auth fail-closed, ctEqual, 404-on-cross-account, no bypasses) — E2EE architecture is open-source-safe by design. Pre-flight before any public flip: (1) hash the hardcoded admin-allowlist email in `apps/api/src/admin.ts:28` (keep the not-env-weakenable property), (2) exclude/redact STATUS.md + design/93 + perf-improvements.md (fleet topology, device/workspace ids, personal emails), (3) publish as FRESH-HISTORY mirror (b6e3550b sweep + Stripe Projects ids + personal data are permanent in history; filter-repo across ~260 branches not worth it). License decision pending: FSL/BSL (no competing hosted service) vs AGPL server + MIT CLI; marketing verdict: net-positive for an E2EE dev tool (trust, curl|sh credibility, solo-founder continuity answer), self-host cannibalization low (CF-native stack = real friction), self-hosting to be declared unsupported._

_Prior header: 2026-07-14 — **DESIGN 116 SHIPPED + FIELD-PROVEN: v1.6.0 fleet-live; live round-trip test PASSED — desktop branch switch at 02:37:07, Mac FOLLOWED at 02:38:18 (71s) with uncommitted work intact, and followed back. PR #276 (67 files, 2 review rounds: 8 BLOCKERs fixed, 48-case matrix); CI identity-less env caught a real fresh-machine fatal (fixed: synthetic ident fallback). Per-ref holds + OID-equality live (Mac freeze class dead). rbox git resolve: show-me + take-theirs (keep-mine next cycle). THE ENGINE PROGRAM IS COMPLETE — remaining: one hygiene cycle (§11 flake, grant-overlap un-skip, sweep grep, rollback-floor id), evidence-gated parks (packing cold-join, 115 crypto, 110, 98), then product surface (admin cockpit, landing page — codex briefs synced to other machines)._

_Last updated: 2026-07-13 (evening) — **FLEET v1.5.3. 114 PACKING: built+merged (#271, 8 commits, fence suite 32 tests), server accept+GC shadow ON (#272), field validation VERDICT: DO NOT PROMOTE (mechanics perfect — 20,408→45 R2 PUTs, zero errors — but ~16%% slower: premise expired post-pool/fill-v2/admission wins + pack receipts redeem at 2x; writer stays RBOX_BLOB_PACK opt-in; 91 packs soaking shadow GC). NEW TOP LEVER: redeem/commit tail (14-40s both arms) + 111 DRAIN FIELD GAP (redeemOverlap=0 despite default-on — RC cycle running). 116 CHECKOUT-FOLLOWS-SYNC: designed (765 ln), reviewed ALIGNED 8 rounds/34 findings (#273), Phase-0 CONFIRMED+REPRODUCED root cause (#274): design-68 §3.2 worktreeCollision defers WHOLE git section on ANY linked-worktree branch match, no OID compare — Mac frozen since 07-10 by stale d93 worktree at IDENTICAL OID; swept 3 stale Mac worktrees → git plane self-healed to near-tip in <1min. Amendments enumerated (per-ref holds, OID-equality rule, worktree-shaped tests). RECOMMEND: .rboxignore .claude/worktrees (delete-first-then-ignore) — founder to call. Releases v1.5.0-1.5.3 (1.5.0/1/2 gates failed: grant-suite teardown hang + a cwd-slip tag; §11 flake now 3 CI strikes — determinism fix queued with grant-overlap un-skip). Junk ws pending purge: ws_332ae0cca4534c07a239eb524f9da484, ws_50e1b93a0e3e4a4a8a3ca6ce80b20b59, ws_b24e5046b4bf4db0957d6000c4475395, ws_d632dd086dbd4aa5af4337aac6ea63d1.** **v1.4.2 FLEET-LIVE (Bun compile bug #270): crypto pool RESTORED in release binaries — every prior release silently ran inline crypto (Bun 1.3.5 ignored text import attributes under --compile; 0-byte worker extract + the ref'd handle behind the init exit-hang). Fleet smoke: 16/10/14 workers active (desktop/Mac/FM), workerExecutions>0 first time ever; Bun pinned 1.3.14 + engines caret; compiled-exit regression test guards the class. Re-baseline encrypt walls next bench. Designs: 114 packing ALIGNED+merged (impl cycle running), 109 grants LIVE (#269, bearer-always), 115 crypto shelf (+bandwidth-knee addendum). Junk ws purge pending (~9 ids in ledger).** **GOAL COMPLETE: fleet on v1.4.1 (all defaults live: files-first, fill-v2/32, upload-time draining, enforce admission). FINAL BENCHMARK (FM, shipped defaults, no env): greenfield 9.7G/118k files → files usable at 226.7s / full publish 336s (Mac sprint-start baseline 578s); redeem tail 37.4→22.3s; admission 6,653→281ms (n=716/169); propagation publish→apply 17s (manual baseline 41.5s). Sweep verdicts applied in v1.4.1 (fill-v2 kept −14.1%, 64-records rejected −7%). NEW: 109 grants IMPLEMENTING (hygiene reframe, bearer-always constraint), 114 blob packing DRAFTED+IN REVIEW (the 200Mbps small-file lever — R2 object-ops bound, ~733ms/req settle). FOLLOW-UPS: post-setup exit lag >60s on 1.4.1 init (possible #246 partial regression, benchmark unaffected); junk ws to purge: ws_aede5f5f775c4a1ea89a22a8c67a2d1c, ws_6d4da814e4bf43bcaf99d204348d4883 + older short-ids; 110 Phase-0: commit p=23.9s at genesis (real, not no-op — revisit after 114).** **IMPLEMENTATION PHASE COMPLETE: 112 merged (#264 fill-v2+telemetry+latch, #265 server cap 64 dark, #266 sweep axes w/ prod-refusal + effective-remote assertion), 111 merged (#267 upload-time draining + bounded redeem cap + Phase-0 receipt/server instrumentation, defaults off). ZERO open PRs. IN FLIGHT: FM 112 evaluation sweep (6 matched cells / 2 repeats, ~2h; its v1/32 baseline cells double as 110 Phase-0 attribution — 110 expected to close as measured no-op). NEXT: sweep gates → 110 verdict → v1.4.0 + fleet → FINAL BENCHMARK presentation.** **DESIGN 113 MODULARIZATION COMPLETE: all 8 PRs merged (#253 plan, #256-#263 waves 1a-5). Six giants (sync, sync-git, daemon, crypto-pool, e2ee-remote, blob-batch; 8,700 lines) → ~24 owner-responsibility modules + docs/CODEMAP.md (115 module lines, cited by AGENTS.md); behavior-identical proven per wave (rename/content-equivalence, single-instance state, 3-cycle baseline, compiled crypto smoke, token-stream-identical comment sweep) + cumulative codex final pass ALIGNED zero findings. Review archaeology moved to ledgers (90 clusters), constraints kept. NEXT: implementation phase per binding order — 112 batch-fill cycle (fill-v1 instrumentation → fill-v2 → coordinated wire-cap raise w/ skew latch), then 111, then 110 conditional; v1.4.0 + fleet + final benchmark after.** **INSTRUMENTATION MERGED (#255: 111 overlap repair + 110 finalDrainMs + arm-generation guard, flags-off, 1452 tests) → 113 MODULARIZATION WAVE 1 LAUNCHED (3 parallel move-only agents: blob-batch, crypto-pool w/ mandatory compiled smoke, e2ee contracts; plan + REVIEW-113 merged via #253 after a codex round fixed 4 HIGHs incl. the CI shard-registry money-gate). Designs 110/111/112 all reviewed-to-ALIGNED and merged (#252/#250/#254); seam ledger carries the binding order + 112 addendum.** **DESIGN PHASE 109-111 CLOSED: all three reviewed to ALIGNED and merged (#251, #252, #250), joint seam round ALIGNED (REVIEW-109-111-seam.md carries the BINDING implementation order). 109 GATE 0 EVALUATED and PARKED: pre-handler auth is only ~89ms/request (~9s of the storm); the real lever is BATCH FILL — avg 17.3/32 records and 148KB of the 8MiB body cap per batch (~733ms server settle paid 2,360 times). Option D (batch fill / coordinated wire-cap raise) is the successor — design 112 draft dispatched. Binding-order next steps: flags-off instrumentation for 110+111, then the shared fixed-corpus baseline.** **102 ENFORCE LIVE ON PROD (#249): admitAccountMs 5,956ms avg → 213ms measured on first enforce commits (~5.7s off every push); 0 divergence/errors post-flip; kill switch = var back to shadow.** Design reviews: 109 ALIGNED (PR #251 — honest win re-sized to ~low tens of s, gate-0 AE decomposition before any impl; 2 BLOCKERs fixed: false quota claim, unobservable authn) and 111 ALIGNED (PR #250 — Phase-0 metrics repair first: redeemOverlap accounting unsound + uploadActive leak; upload-time draining survived all rounds). 110 loop still running; joint seam round after; neither design PR merges before it. **v1.3.0 RELEASED + fleet upgraded (all THREE hosts verified on 1.3.0, daemons healthy)** — files-first default-on, init fixes, purge route, knobs now fleet-live. Review cycles for designs 109/110/111 running (3 parallel agents, codex loops to ALIGNED; joint seam round after). Prior header below._

_Prior header: 2026-07-13 (late night) — **ALL FOUR PRs MERGED (#245 knobs+sweep rig, #246 init identity/exit fixes, #247 files-first, #248 workspace purge) and `RBOX_FILES_FIRST` now DEFAULTS ON (`f2403834` — founder call; genesis-only so inert for existing workspaces; `=0` kill switch; suite pins legacy via `scripts/test-preload.ts` + bunfig.toml, dedicated test asserts default-on).** **CI moved to GitHub-hosted ONLY** (founder: "not worth it") — self-hosted home box CPU-starved heavyweight tests into endless random timeouts (3 rerun rounds, 2 timeout bumps, 4×8-CPU reshape all failed to stabilize); both PRs greened FIRST TRY on GH-hosted; local runner containers torn down; Brian must remove his own crontab entry (`crontab -l | grep -v gh-runners | crontab -`) and repo secret RUNNER_ADMIN_PAT is now unused. **Workspace purge is LIVE on prod and field-proven**: dry-run → purge → verified-404 on the three sweep junk workspaces (blobs → GC). Older junk ws (short ids ws_79529b0d, ws_67eb29f6 + wired-bench) need full-id resolution via admin overview before purging. **FM files-first A/B RAN (stopped early per protocol, n=1/arm): mechanics ALL CORRECT** — two-phase publish (files seq 1 @ 225.5s → git attach seq 2 @ +104.4s), `fp filesSynced` KPI rendered, flag-off byte-identity clean in the field, **#246 field-verified (init self-exited + reused machine identity — both bugs gone)**. Gate 2 PASS (332.5s ON vs 342.4s OFF total). Gate 1 "FAIL" (225s vs ≤120s) is a WRONG-PREMISE fail: ~/code's file plane is **2.85GB wire (118,757 files / 49,382 blobs), not the assumed 0.4GiB** — ≥36s is line-rate-minimum; re-baseline the target before rerunning. **Real discovery: flag-independent critical-path levers — 2,426 auth calls (107.7s!), commit 46.1s (41.7s in `p`), redeem 37.4s; effective upload ~200Mbps.** Files-synced still beat full-publish wall by 107s on a file-heavy corpus; on the real 84%-git workspace shape the win is far larger. FM artifacts: logs /tmp/rbox-ff/logs, build /tmp/rbox-108-build. Junk ws to purge (with the older ones): ws_83dcdcf9d5b048269fbabcee188cc5e1, ws_4d87c0cf4abc4384bbe9608452cf4279. NEXT: v1.3.0 release (files-first-on + init fixes to fleet); designs 109 (auth storm) / 110 (commit tail) / 111 (redeem tail) DRAFTED by codex from FM evidence (839b776d, no review yet) — arbitrage review loops first; 102 enforce soak samples (accelerator stopped since incident #3); design 98 scheduling fix owed._

_Prior header: 2026-07-13 (night) — **four parallel dev cycles delivered: #246 MERGED (init device-identity clobber + never-exits — enrolled-identity precedence via `resolveWorkspaceDeviceId`, `shutdownCryptoPool()` on CLI exit, new doctor device check); #245 open (upload/download slot knobs + sweep rig); #247 open (design 108 files-first impl, `RBOX_FILES_FIRST` default-off, 2 codex MAJORs fixed: flag-off byte-identity + timing-singleton void-on-overlap; FM A/B validation next); #248 open (admin workspace purge — `DELETE /v1/admin/workspace/:id` + `scripts/ws-purge.ts` dry-run drain; NO workspace deletion existed server-side at all).** **SWEEP VERDICT (redirects the perf plan): the ~35Mbps uploader ceiling is NOT slot-bound — knee at 48 slots (+9%, noise), ≥64 slots COLLAPSES 3x via per-batch RTT inflation (0.9s→3s, zero retries/503s), server-side variance dominates (same config: 60 then 23Mbps plaintext), wire never past ~5% of FM's pipe. KEEP defaults 24/48; honest levers are server-side batch settle latency + the 32-record wire cap (coordinated change). The upload lane alone does ~60Mbps plaintext; the wall gap is encrypt+commit.** CI: shared-runner contention flaked 3 PR runs (pure timeouts in unrelated tests) → shard runner now passes `--timeout 15000` (700cb0ff); root fix owed = daily 5:15am container recreate cron (line written, crontab install permission-blocked — Brian pastes it; each ephemeral job leaks ~13GB/day/container, filled 760GB once). INCIDENT #4 (contained): init-bugs agent worked in the PRIMARY checkout (rbox-synced!) — WIP stashed/restored to its worktree, primary back on clean main, playbook rule recorded. Junk ws for #248 drain (after dev-trial + merge): ws_6c4621f6fa9e4f7cbf1c9019f016b1d1, ws_02e5d624636143568e5f8ad5ef739ca2, ws_f9b3ab9419194820a7fe4964ba68aea0 (~160k blobs) + the older 3 below. Stray branch `worktree-agent-ae0cca7dc6de5f88e` on origin needs manual delete._

_Prior header: 2026-07-13 (early) — **FM benchmark pair (gigabit host, clean corpus ~/code): serialized 315s; RBOX_PUBLISH_PIPELINE 540s (+71% — design 98 gate FAILED in the field**, suspect: multiparts serialized one-at-a-time on the pipeline's disk axis vs 4 giant git packs; flag stays off, result to REVIEW-98). **Bigger finding: the uploader caps ~35Mbps on EVERY host (30/37/35 on 155/­~40/630Mbps pipes) — a software slot×latency ceiling (~364 blobs/s ⇒ ~2s per 32-blob batch at 24 slots), i.e. a TUNABLE.** Next session first: slot/batch sweep on flat-meadow vs ~/code (telemetry = #230). Also filed tonight: init bugs (device-identity clobber + never-exits headlessly — blocks scripted onboarding); design 108 MERGED (#244, two-commit files-first; founder sign-off pending on publisher-loss git semantics); fleet = THREE hosts (flat-meadow was on v1.0.0 all week — now v1.2.0 + flags); ~/code testbeds cut on desktop + FM (founder rule: bench there, never live workspaces); 4-5 bench workspaces need server-side deletion._

_Prior header: 2026-07-12 (late night) — **fleet on `1.2.0-dev+868ed2c`**: scan fault isolation + mass-delete circuit breaker + dev-install hygiene MERGED (#243 — incident #2's full armor; unreadable-file faults DEFER, never delete; breaker trips at max(20%,1000) deletes, daemon can never self-override) + WS reliability (#242) live. **Wired greenfield control: 367s / 1.3GiB ≈ 30Mbps — same throughput ceiling as the Mac ⇒ the ISP uplink is the greenfield floor; design 108 (files-first, cycle running) is the lever.** Ubuntu device identity verified restored (dev_df5d3b6c — the old 'orphaned' STATUS note was stale; it's this host's live ID). Cleanup owed: 3 bench workspaces server-side (ws_79529b0d, ws_67eb29f6, + tonight's wired-bench ws)._

_Prior header: 2026-07-12 (night) — **v1.2.0 RELEASED + fleet upgraded** ("the Mac gets fast"): APFS bulk scans (−43%, stat=0 live), fold evidence fleet-wide (0.4–1.5s reads), 104 field-confirmed, 85 Layer A, GC Phase-1 fixed + 229k marks drained (35.3GB released), soak endpoint + propagation analyzer (p50 16.7s publish→apply, 0 staleness). Then: greenfield benchmark 578s (84% of bytes = git history) → design 108; WS reliability #242 live; init device-identity bug found+contained (INCIDENT #3 below)._

_Prior header: 2026-07-12 (late night) — **v1.0.1 RELEASED + fleet upgraded** (installer binaries, flags `RBOX_PREFLIGHT_DELTA=1 RBOX_CRYPTO_FUSE=1` on both daemons); wave-2/3 merges #221–#226 (102 shadow SOAKING on prod, 99 fused Phase 1, 98 Tier-1 pipeline dark, 100/98 instrumentation); GC drained 1,600/5,410 (~3.34GB) with the final sweep timer armed; telemetry sweep ALL CLEAR; **Mac watcher root-caused → design 104 placeholder** (FSEvents transient drops permanently un-trust the watcher ⇒ ~11% I/O duty cycle; fix = first dev-cycle item next session, pairs with v1.1.0 + design 84 which is still building)._

## Older sessions (2026-07-11 → 2026-07-12)

Compressed into “Recent history” below; full detail lives in git history of this file.

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

- **Seam fakes encode OBSERVED contracts, never imagined ones**
  (2026-07-22, cost two release trains): the 179 Keychain feature shipped
  with four bugs because test fakes encoded an imagined `security(1)` —
  real macOS: bare `login-keychain` (the `-d user` form exits 1), output
  is indented `    "path"\n`, exit-0 find-generic-password prints a
  ~20-line attribute dump (probe demanded one line → every present item
  read "unavailable", #402). Before shipping any subprocess integration,
  capture the real tool's output shape on real hardware and encode THAT
  in the fake.
- **Test-green ≠ invariant-holding for safety machinery** (2026-07-22,
  178 t3): 1,143 tests passed while all seven lock-lifecycle invariants
  failed — the suite covered the classification tables, not the
  intermediate journal shapes, replacement races, and gate-crossing
  windows. Reviews of crash-safety code must attack intermediate durable
  states and adversarial substitutions, not re-run the matrix the
  implementation was written against. (Same session: reviewer REPRODUCED
  an L2 violation the tests missed.)
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
- **Fleet network speeds (measured 2026-07-13, raw R2 curl probes — know these
  before blaming rbox for throughput):**
  - **via-desktop-ubuntu**: Ethernet to a MESH NODE (wireless backhaul), NOT
    wired-to-WAN — caps **~155 Mbps up** (single stream ~158, 4-parallel ~155
    aggregate; parallelism buys nothing, the backhaul is the cap). Never use it
    for bandwidth benchmarks.
  - **flat-meadow-prod-main-01**: wired ~gigabit — single stream ~300 Mbps,
    **4-parallel 632 Mbps aggregate**. THE bandwidth/perf benchmark host
    (16T/32GB).
  - **Mac (dfinitiv-macbook-pro)**: uplink only ~40 Mbps — network-bound for
    uploads; fine for scan/watcher/propagation tests, useless for upload
    ceilings.
  - Rules: benchmarks run SERIAL, one host at a time (don't split one host's
    pipe across concurrent runs); bench against `~/code` snapshot clones
    (desktop + FM), never live workspaces; run a raw curl/R2 probe first so
    network ceiling vs software ceiling is settled before interpreting rbox
    numbers (that's how the universal ~35 Mbps uploader ceiling was isolated
    as software, not ISP).
- Cloudflare Flagship (blog.cloudflare.com/flagship) — founder-flagged for future exploration, NOT current work.
