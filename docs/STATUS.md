# rbox status — living state snapshot

> Cross-host memory for Brian + agents. Update this doc when a release ships or
> a workstream opens/closes. Deeper context: `docs/design/*` (numbered designs),
> PR history, and per-machine Claude session memory (does not travel — this doc
> is the carrier).

_DAY SESSION 2026-07-27 (afternoon, "re-evaluating life"): **desktop
REJOINED the fleet + two features shipped + prod promoted.**
(1) via-desktop-ubuntu is a fleet member again: the in-place `--adopt` of
the stale ~/Development replica was KILLED mid-overlay after proving an
O(n²) journal defect (120MB journal fully rewritten per file event, 55GB+
written in 18min, ~6-day projection — **#501**, real fix belongs in the
163 SQLite store; 20-line batching stopgap optional). Rejoin went
rename-aside (`~/Development.pre-rejoin`, KEEP until soak confirms) +
empty-dir join + pull-only materialize; 15 linked worktrees parked at
`~/Development.pre-rejoin-worktrees/` (git worktree move, all functional).
Git plane had proven ~identical pre-kill (210/212 branches equal). Daemon
pull-only; read-write flip pending founder + .rboxignore for agent scratch.
Fresh-join hazard found: tracked `.env` files deleted by materialize
(apps/web/.env.* restored from git — needs an issue).
(2) **rbox doctor triage SHIPPED (#503**, closes #498): plain-English
ordered findings (what's wrong / is data safe / one paste-safe scoped
command), all-workspaces machine view outside any workspace, `--json` twin.
3 review rounds under the NEW HARD CAP (AGENTS.md + dev-cycle skill:
max 3 rounds, one must execute code; round-3 residue → step out a layer /
founder tie-break / kill switch — never round 4). Review killed 14+4+1
real defects incl. offline-misdiagnosed-as-signed-out, blanket
--allow-mass-delete remedy, and two PRE-EXISTING prod bugs: doctor crashed
on malformed state.json; daemonProcessMatches matched roots by SUBSTRING
(prefix-sibling `/w/work-old` owned `/w/work`) — fixed to exact-argument
match, shared by start/stop/status liveness.
(3) **Design-204 false alarm corrected**: the morning corpus review called
the delta flips "shipped dark" — WRONG, 204 shipped 7/26 (PR #458) and the
fleet runs it; stale DRAFT header + stale README index caused it (papercut
+ rule: verify "never shipped" claims via `git log -S`). Fleet env rollout
of those flags was a NO-OP and was stopped.
(4) **Blob-pack (114) validation**: prod acceptance was already live;
writer canaried on dev — correctness PASS (123 packs, zero fallbacks,
byte-identical read-back on a paired device), wall-time FAIL (~26% slower;
**#504**). Blocker 1 (13-row blob_locations chunking → 385 stmts/5k-commit)
FIXED via json_each single-JSON-param batches (**#506**, 850 API tests,
independent opus review ALIGNED — also fixed a latent cross-chunk
pack-fence bug on main, red/green pinned). Dev re-measure: redeem 1.92x →
**1.07x** parity. Blocker 2 (7.5MiB fill starves encrypt→upload pipelining;
worsens when producer slows) OPEN — RBOX_PACK_TARGET_BYTES sweep running on
dev; FM fast-pipe originator test after. Fleet burn-in: RBOX_BLOB_PACK=1
env on all 3 daemons (default still OFF in code; flip gated on blocker 2 +
FM numbers). **#505**: RBOX_HOME does NOT isolate credentials (prod
credential leaks into scratch envs) — real footgun, open.
(5) **PROD PROMOTED** (explicit founder yes, 767b97c8→5720f852):
API-worker delta was exactly #458+#506, no migrations, no web; deploy
workflow green; prod health ok; fleet redeems at parity now.
(6) **Fleet build #9**: 1.9.1-dev+5720f85 on all 3 hosts (canary-compiled),
modes preserved, burn-in env preserved. Doctor field-validated on FM's
day-old savvy-core deferral + desktop outside-workspace view.
(7) Founder-facing: CLI surface review artifact
(https://claude.ai/code/artifact/036e2673-884a-4005-9cdd-0759c8abf736 +
gist 80fbf0fee5745f50b9ebdf2fe6b466ce) — 51 commands, plain-English blurbs,
nested subcommands, notes exportable; annotation pass pending. Strategy
session verdict logged: ~60/40 odds on passive-dropbox-for-devs; levers =
doctor(done)/CLI shrink/selective-repo-sync design(NOT STARTED, Max's ask,
zero docs exist)/deferral metric/adopt milestone (166+#501). desktop
.zshrc SSH auto-tmux fix (failed attach no longer closes the connection)._

_REORG CAMPAIGN COMPLETE (2026-07-27 ~09:30 local): **20 reorg merges,
19/21 roadmap cycles** (#478-#496, #499). Every schedulable cycle is done;
wave 6 (RecoverStateAuthorityAtDaemonBoundary +
PublishDaemonRuntimeObservation, ~380-490 daemon.ts lines) stays PARKED on
the design-163 store port BY ROADMAP DESIGN — it opens with the 163 track,
not before. Final cycle w8c2 #499 (squash ce2d5320):
DaemonOperationScheduler solely owns queue/wants, recovery episode, mutex
backoff + durable starvation, active op, single-flight/drain; daemon keeps
boundary admission + op bodies + halt records behind a typed executor;
16-test contract file. Review caught TWO defects in the archived draft
(never executed): refused-boundary exit re-entry hot-looped forever (now
parks until next wakeup — provably equivalent to old daemon exit), and a
tick-sensitive single-flight assertion. Field-validated same hour: fleet
build 1.9.1-dev+ce2d532 on Mac+FM, Mac→FM smoke round-trip clean, trusted
pulls + push normal, zero pump errors. Hotspots final: status-cmd 922→103,
push.ts 1144→946, apply.ts 2291→1502, daemon.ts 3790→3330 (→~2,300-2,450
after wave 6 lands on the 163 track). Next-biggest agent-confusion
surfaces (encore candidates for the next thermo-nuclear sweep, founder
undecided): follow.ts 1784, plan.ts 1474._

_Bun 1.4.0-canary validation (2026-07-27, founder-requested): canary
1.4.0-canary.1 (the Rust-era major bump) installed SIDE-BY-SIDE in the
session scratchpad (system bun stays 1.3.14 — `bun upgrade --canary`
in-place would flip every session on the host). Full 6-shard suite GREEN
under canary at wall parity (176s vs 172s stable); canary-compiled binary +
compiled crypto-pool exit test sane (#270 class clear). ONE real finding →
**#500 MERGED** (ebc6b7b6): canary treats GC-collected FileHandles as run
errors and exposed a genuine fd leak — secureMoveNoReplace stranded the
source parent handle whenever the destination O_NOFOLLOW walk refused
(escape tests / hostile workspace); one fd per failed adoption move on
stable. remote-repository-deletion.ts audited clean. POSTURE (founder call,
same day, superseding the initial stable-until-release stance): **canary is
now the MAIN bun on all three hosts** (`bun upgrade --canary`; desktop +
Mac + FM all 1.4.0-canary) — future dev builds are canary-compiled; revert
per-host with `bun upgrade --stable` (1.3.14) if a canary regression bites.
Daemons were NOT rebuilt/restarted for this — they pick up canary-compiled
binaries at the next normal fleet build. CI/deploy-api workflows run
`bun-version: "canary"` EXCEPT the cross-compile legs: the first canary main
run proved **canary publishes NO cross-target compile blobs** ("Target
platform 'bun-darwin-aarch64-v1.4.0' is not available for download"), so
ci.yml's cross-build job + all three release.yml pins stay `"1.3.14"`
(inline-commented). The startup/size budget job is ALSO pinned stable —
budgets measure the SHIPPED binary and releases build on stable. WATCH-ITEM
for 1.4-goes-stable: canary-compiled `status-json` RSS is 48.6MB vs the
42.55MB budget (+14% runtime baseline) — when repinning to a stable 1.4,
either bun has slimmed down or the budgets need a founder-approved
re-baseline. A separate transient workerd tarball-extract failure on
attempt 1 was NOT reproducible locally or on rerun. Native per-target
compiled-TUI matrix jobs are fine on canary._

_Day-session riders (2026-07-27 morning): **#497 killed the three registered
CI flakes** — root causes proven from CI attempt-1 logs (pull failed
attempts via `gh api .../runs/<id>/attempts/1/jobs` BEFORE reruns overwrite
them): git-state x2 + follow safety-linearization were detached git
auto-maintenance (gc.pid tripping gitBusy / repack racing connectivity
proofs) → suite-wide GIT_CONFIG env injection in scripts/test-preload.ts
(repo config can't cover product-inited repos; cleanGitEnv spreads
process.env); daemon-activity 178-B ran real ~5ms recovery timers →
injected advancing now + ManualRecoveryClock. NEW follow.test.ts flake
(174-C hung-subprocess timeout, #499 CI) recorded with proof — SECOND
follow incident today; a third earns an investigation cycle. Rig FAST
7/7 at the #494-497 checkpoint. Founder asks filed: #498 (`rbox status`
anywhere → cumulative all-workspaces summary) + wants GitHub issues to
become the public todo list. Ops note: worktree removal leaves the shell
cwd dangling — one papercuts commit landed on the w8c2 branch and
conflicted; use `git -C` absolute paths after removing a worktree._ Extracted owners: status-maintenance/
projection/render/contract/read-port; git-capture-observation,
publish-candidate, manifest-commit-executor, publisher-ack-transition;
git-discovery-continuity, local-workspace-observer,
local-observation-transition (LocalAuthority); remote-repository-deletion,
received-git-config, clean-materialization, standing-branch-proof,
follow-repo-transition, received-git-transition (w5c3), publish-local
transition reducer (w7c3). Fleet: build #5 (110917d) both hosts, 5 blog
smoke round-trips green (commit ~13-60s, branch switch 17s, branch delete
21s Mac→FM); 2 merges since — next dev build due with the next merge. Rig
7/7 twice. **Flakes ROOT-CAUSED (2026-07-27 day session), fix PR in flight
(worktree flake-fixes):** (1) git-state.test.ts + a NEW third site
(follow.test.ts:2086 "planned graph connectivity proof failed", main run
30232946666 shard 1/6) share one cause — product-spawned git detaches
auto-gc/maintenance whose gc.pid/repack races gitBusy + connectivity proofs
under shard contention (evidence: PR #491 attempt-1 shard-5 log shows
applied:false at git-state:482; gitBusy checks gc.pid); fix = suite-wide
GIT_CONFIG_COUNT env injection (maintenance.auto=false, gc.auto=0) in
scripts/test-preload.ts — reaches product-spawned git via cleanGitEnv's
process.env spread (repo-level config can't cover product-inited repos).
(2) daemon-activity 178-B sibling: test daemon ran REAL ~5ms recovery
timers (PR #492 attempt-1 log: internal timer-pump consumed the probe
before the test cleared the error; halt re-armed with original
at/firstFailureAt) — converted to injected advancing now +
ManualRecoveryClock per #403. NOTE: failed CI attempts get OVERWRITTEN by
in-place reruns — pull flake evidence via
`gh api .../runs/<id>/attempts/1/jobs` before it ages out. Process fixes
last night: pull-before-rig unconditional; merges verdict-gated in a
separate step (my gh identity BYPASSES branch protection, so watcher
discipline is the real gate). Rig join-ahead fixture made idempotent
(#483)._

_OVERNIGHT CHARTER (2026-07-27, founder-authorized ~00:00): run the 21-cycle
reorg roadmap on all fronts; MERGE TO MAIN WHEN CONFIDENT (campaign-scoped
grant); every ~3 merged PRs push a dev build to the fleet (Mac + FM, both
read-write now) and watch logs for issues; rig run all every ~3-4 merges;
target nearly-all cycles done by ~09:00 local. Protocol per cycle: agent
implements from the roadmap contract (opus for fail-closed git seams, codex
ok for read-only lanes), contract test red-first, MY gates re-run
(typecheck+test:parallel), PR, merge on green. Parallel lanes allowed when
file-disjoint (status lane ∥ push spine). Don't get bogged down: a cycle
whose review finds deep problems parks as an unmerged PR; move on. Reorg
PRs skip CHANGELOG (internal refactors — kills the merge-train conflicts).
Cycles merged so far: w1c1 #478, w1c2 #479 (status-cmd 922→462). NO 1.10.0
tag regardless._

_Session addendum (2026-07-27, small hours): **FM IS NOW A FULL SYNCER**
(founder decision): explicit `rbox start --read-write` — live watcher started
(inotify raised to 1048576 first), FIRST-EVER FM trusted pull 23:33 UTC,
echo-watched clean (2 publishes, no loop; the 07-21 echo bug class is fixed
in 1.9.x). Correction: FM never had watcher exhaustion under current code —
PULL-ONLY daemons never START a watcher (daemon.ts:772-777); #477 filed for
pull-only deployments generally (no fleet host runs pull-only now). Mode
intent verified sticky (bare start preserves pull-only — the post-07-21
protection works). **Reorg campaign cycle 1 MERGED (PR #478)**:
RefreshStatusDeferralAssertions — status's hidden hygiene write behind
StatusMaintenancePort+receipt, contract test red-first; honest close-out:
~24 lines moved, status-cmd.ts 922→945 (shrink comes from the next two
status cycles), safe-change context 4 files → 71-line seam. One flake
recorded (git-state detached-pointer, proof complete, docs/flaky-tests.md).
Wave 1 continues: ProjectWorkspaceStatusDetail → RenderWorkspaceStatusSurface.
FM sudo password was shared in-session — founder should rotate it._

_Session addendum (2026-07-26, late night): **#469 SHIPPED and field-confirmed
(PR #476, design 209 ALIGNED r3): first post-boot publish went ops=81120/7.9MB
→ ops=1/603B on the Mac.** Mechanism pivoted mid-review (strip-from-wire was
proven WORSE than the bug during fleet skew) to commit-seam mtime
normalization — adopt the base entry when all ten identity fields ===;
RBOX_MTIME_NORMALIZE=0 kills. Fleet on 1.9.1-dev+777fd48, both hosts. Full
rig suite 7/7 PASS at c64a6110 (an earlier 7-failure scare was a STALE
PRIMARY CHECKOUT running pre-#466 scenario code — papercut filed: rig must
print tree provenance). NEW FOUNDER RULES (in dev-cycle skill + memory):
phase-0 level-set + per-PR "did it help / did we make anything worse"
close-out; rig FAST suite every ~3-4 sync-plane PRs and before any tag;
git revert is a first-class option for net-unhelpful merges; ≤500-line file
target + comments only for inexpressible constraints. NEXT CAMPAIGN (founder
directive): wrap 476 ✓ → CLI surface reorganization — decompose around the
#447 semantic-transition audit, agent-ergonomics objective; codex roadmap
sweep dispatched (output → .claude/roadmap-2026-07-26-structural.md);
docs/design/notes/2026-07-25-cli-surface-review.md committed for founder
annotation. Design 163 (SQLite state plane) ruled VIABLE by founder — parked,
sequenced after the reorg. git-plan perf design folds INTO the git-plane
reorg cycle. NO 1.10.0 tag — fresh explicit go required._

_Session addendum (2026-07-26, night): **BURN-IN BUG SWEEP SHIPPED — 4 PRs
merged (#471 #472 #474 #475), fleet on 1.9.1-dev+b374f1e, all fixes
field-verified live.** Parallel root-cause wave over #459/#460/#464/#465,
then design→adversarial-review→implement per lane. (1) **#464 → design 206
(ALIGNED r5, 5-round ledger REVIEW-206.md, PR #475)**: P7 latch — no
push/pull that moved the base gitRepos key set ever rebuilt the matcher
(202's F2 "realigns provenance" claim was FALSE); shipped
ensureMatcherProvenance at pump boundaries + matcher-generation stamped at
observation START + watcher facade + fail-safe fused downgrade when a
rebuild moves backend watch inputs (hot re-arm descoped → #473) + named
skip= causes on every scan pull. FIELD-CONFIRMED: clone churn healed to
`pull local=trusted` in ~4 min unattended (was: latched forever, restart
required). (2) **#460 → design 208 (renumbered from 207 — Alchemy eval
claimed 207 concurrently; ALIGNED r3, REVIEW-208.md, PR #474)**: reviews
KILLED r1's whole-dir trash retirement (self-referential identity predicate)
and bundle retention (recovery-state, → #470); shipped anchored rmdir-only
skeleton sweep + journal key clearing + doctor `repo residue` section.
FIELD-CONFIRMED: post-delete residue now just .git+.rbox (was 30M skeleton),
doctor names it with the manual command. (3) **#465 → PR #471**: real root
cause was semver rejecting `+build` — dev builds corrupted the ENTIRE
ambient status record (witness, status version, mode promotion, and rbox
stop's graceful drain = 60s SIGKILL on every fleet host); plus ps -ww
truncation hardening; start now prints pid/version/mode and self-polls the
witness (no more "re-run"). (4) **#459 CLOSED not-a-bug** (the 7.3MB
"snapshots" were deltas; sink wiring proven live) → spun out #469 (fat
deltas after boot/rescan — advisory churn in field-exact diffToOps; TOP
next-cycle candidate, ~7.9MB+1.3s per boot/rescan) and PR #472 (mde
delta/non_delta attribution on every commit + daemon wiring lock test +
one-shot stderr sink). #472's line PROVED #469 live on its first benchmark
commit (`mde delta ops=81120 bytes=7894911` after daemon restart).
Benchmarks on b374f1e: clone→FM-applied ~50s wall (publish 21.2s, FM apply
15.7s incl 2.0s git import); rm→published 23s (33.4KB delta, 4290 del ops);
FM pull lines now self-attribute `skip=p1-watcher` (its inotify watcher is
still dead — sysctl fix still pending, needs sudo). Issues filed: #469
(fat delta), #470 (quarantine bundle lifecycle — unbounded growth, needs
pinning design), #473 (watcher hot re-arm). Worktrees fix-459/460/464/465
removed (all MERGED); raw review reports preserved in `.claude/`
(review-206-r1..r4, review-207-r1..r3, spec-465). NO 1.10.0 tag — bake
continues; fresh explicit founder go required (standing rule)._

_Session addendum (2026-07-26, evening): **DESIGN 204 SHIPPED to main (PR
#458, squash 514d6899) and burn-in STARTED on both hosts
(1.9.1-dev+514d689).** Design `docs/design/204-delta-scoped-publish.md`
ALIGNED r3 (2 codex + opus parallel wave → synthesis → codex serial gate →
focused re-check; ledger `docs/design/REVIEW-204.md`). Parts: (A) preflight
delta default-on — REVIEW-103 freeze DISCHARGED by a new enforce-mode server
regression, green vs unmodified server; (B) manifest delta commits +
RBOX_MDE_FAST_PULL default-on, mdeWritePolicy() both-seam lattice,
base-integrity hash binding, evidence-fold→cold-walk fallback; (C) reduced
lazy git-plan (journal-pair gating, scoped memos, C5 sub-phase buckets) —
delta discovery + cross-repo fingerprint memo DEFERRED with banked evidence
(REVIEW-204 §5.5 seed for the successor). Kill switches:
RBOX_PREFLIGHT_DELTA/RBOX_MDE_DELTA/RBOX_MDE_SNAPSHOT(master)/
RBOX_MDE_FAST_PULL/RBOX_GIT_PLAN_LAZY (=0 each). **Field results (warm):
missing 4.1s→0.1s (77B up), commit 4.4s/12.5MB→2.7s/614B delta, FM pull
manifest 0B (fold=evidence), FM pull wall 1.8s, Mac publish 15.6→11.3s,
end-to-end Mac→FM 19.6→15.3s.** Dedup-shape regression check: fresh
savvy-core clone (118M+36M git) Mac→FM files-usable 21.4s, git-complete
25.7s; economic guard field-fired correctly (662KB delta chosen over 7.3MB
snapshot on the 5k-file update). NEW top levers from C5 buckets: git-plan
~2.5-3.1s (discover walk ~1-1.4s + other ~0.8s + fingerprint ~0.6s; journal
preloop now 19ms) and ~4s unaccounted push wall (redeem/flush tails).
Anomalies filed/open: #459 (mde non_delta cause= line — and seemingly ALL
warningSink output — never reaches daemon.log; diagnostics-only), Mac `sp7`
(7 repos re-spawn slow-path EVERY push — fingerprint never re-trusts;
investigate during soak), two pre-existing main test failures
(scripts/e2e/dev-backed-scenario.test.ts parsePairToken vs current `rbox
pair` output — reproduced at 77329d9d). Soak sweep DONE same evening: rig
FAST suite vs dev on the 204 build = 6/7 PASS (onboard 11.3s, two-device
25.3s, mass-delete-guard 13.7s, type-flip 15.0s, idle-cpu 193.8s, join-ahead
32.3s); git-entanglement's 7 failures bisected to PRE-EXISTING main drift
(identical at f0bfb456) — #462 (ownership-hold/deferral-aging assertions,
same rot class as #dev-backed parsePairToken). Deletion propagation ~4s via
38.7KB delta BUT left 30M checkout residue on FM invisible to doctor — #460.
`bun run test:parallel` SHIPPED (#461): local 6-shard suite ~126s vs 364s
serial (8 shards WORSE at 141s, 16 faster-but-flaky at 100s — 6 is the
sweet spot; zero flakes across three 6-shard runs so far). Late-evening
additions: #466 merged (git-entanglement rewritten to the design-200
deferral contract + aged-visibility step via 11-min state backdate —
grammar-freeze marker preserved; rig FAST suite now fully green on the 204
build); #468 merged (status shows email+plan via per-field account-profile
fallback — field-verified on FM, fixes #467); fleet now runs DEV builds by
standing founder rule (~/.rbox/bin/rbox → symlink to rbox-dev on all 3
hosts, release parked as rbox-release; both daemons on 1.9.1-dev+bb419b6);
FM parked pre-rebind daemon record removed (status noise). New issues from
burn-in: #463 (RboxBar real transfer progress), #464 (202 trusted-pull
stuck in scan after ignore-rules churn — top candidate for next cycle with
the git-plan successor), #465 (rbox start over running daemon says
'started/not witnessed' instead of 'already running'). NO 1.10.0 tag —
bake first, fresh explicit go required._

_Prior addendum (2026-07-26, later): burn-in DONE on both hosts; #457 merged
(refwatch crash fix — Linux fs.watch nameless-filename TypeError crash-looped
FM's daemon; found because FM had never run a live watcher until its re-bind).
FM re-bound as a FULL device (fresh credential — the 403-telemetry mystery
device was FM; now zero 403s; old tree parked at
~/Development.pre-rebind-2026-07-26; inotify raised via
/etc/sysctl.d/60-rbox-inotify.conf). Measured after 202+203: Mac steady pull
~5s (scan 0.0s, git-apply 0.2s/101 repos); FM notify→disk ~4.5s (trusted);
end-to-end Mac→FM 19.6s (was ~29s). **Remaining bottleneck = Mac PUBLISH
15.6s for a 40-byte change — the design-204 target**: (a) `missing` 4.1s =
presence check for ALL 108,537 blobs (7.2MB hashes upstream) instead of
delta-vs-proven-watermark; (b) `commit` 4.4s = full 12.5MB manifest snapshot
upload (commit.delta AE family suggests delta machinery partially exists —
find why snapshot path taken); (c) `git-plan` 2.7s = plan walk not yet
203-treated. Open FM items: savvy-core git deferral ("artifact on checkout
unavailable" — likely needs Mac-side ref movement to republish artifacts);
watch for `git-ref-watch event error (degraded to dirty)` lines (would mean
nameless events occur in practice). Issue #456: init --adopt displaces 90k
files BEFORE validating workspace (adopt abort restored perfectly). NO 1.10.0
tag yet — bake first, fresh explicit go required._

_Last updated: 2026-07-26 (**pull fast path merged — designs 202+203, targets
v1.10.0 after fleet burn-in**). Origin: AE telemetry showed every pull paying
O(workspace) fixed cost (fleet pull p50 64.5s; ~20s flat on the Mac's 108k-file
workspace: scan 8-9.5s + git-apply ~7s + a telemetry-invisible post-pull scan).
PR #455 (f393ef0e): design 202 (pull consumes the watcher-maintained manifest
under trust predicate P1-P7, `unsettledPaths`, O(applied) post-pull patch,
refuse-and-rescan-once mass-delete, `ManifestUpdate` partial/full-workspace
provenance, kill switch RBOX_PULL_TRUST_WATCHER) + design 203 (lazy git-apply
probes: zero steady-state git spawns, busy-eager-spawn-free, memoized identity,
kill switch RBOX_GIT_APPLY_LAZY). Review: 2 codex(medium) + opus parallel wave
→ synthesis → codex serial gate → focused re-check; /simplify 4-lane pass
closed a push-path design-108 gap (installManifest seam) and made the patch
truly O(applied). **Burn-in (in progress): Mac on 1.9.1-dev+f393ef0 — pull
local=trusted, scan 0.0s, git-apply 0.2s/101 repos (was ~15s combined).**
Blockers found on flat-meadow (both pre-existing): (1) watcher dead from
inotify exhaustion (65536 watches < 77k files) → trusted path correctly
refuses; fix = sysctl 60-rbox-inotify.conf + pull-only restart (needs Brian's
sudo); (2) FM is the 403-telemetry device from the fleet digest (~60 rejected
samples/hr; sync-state report failing) — needs device re-auth, restart does
not clear it. Mac→FM propagation still ~29s until FM's watcher lives. NO tag
until burn-in green + fresh explicit go.

Prior update (2026-07-25): (**v1.9.1 SHIPPED — design 200 implemented, field-validated,
released fleet-wide in one day**). The whole arc: step 0 (#449 `deletion-pending`
vocabulary, promoted to prod) → P2 (#450 ownership held-skip + no whole-repo
escalation + doctor leftover-worktrees) → P3 (#451 content-equivalence cascade
reduction) → P1+P1b (#452 witness → verify-only lock → exact-OID tombstone →
ACK-only BASE retirement, + `ref-read-unreadable` vocabulary, promoted to prod)
→ #453 witness-clause diagnostics → release `v1.9.1` (fd52389e), fleet upgraded
(Mac, flat-meadow pull-only preserved, desktop). Implementation: codex
(gpt-5.6-sol medium) from self-contained specs per worktree; review: 3 parallel
opus adversarial lanes + codex serial merge gate — the wave found and fixed 3
genuine blockers the full test suite missed (fail-open step-D guard, hidden-anchor
suppression of new repos at removed paths with two acceptance tests codex had
inverted to mask it, and §3.3b's packed-refs inode premise **falsified by
measurement** — every packed-refs mutation is lock+rename ⇒ new inode; rebuilt
as monotonic mtime-only baseline, design v13.3/v13.4 record both corrections).
Rig `worktree-squash-lifecycle`: 10 red → 0 red (phase-1 carried-pending
assertion relaxed per §9.6; design 201 reverses it). **Field validation on the
Mac:** the machinery itself unwedged `savvy-core-v1` (witness passed, seq 483,
BASE retired, flat-meadow pruned) after a one-time lineage-stale-receipt
recovery (resurrect at remembered OID → no-op commit-tree advance → ACK
re-stamps → delete; ACK origins only re-stamp when a ref MOVES), and a FRESH
full agent lifecycle (worktree → commit through live hold → squash → teardown)
ran clean end-to-end with zero recovery steps. `Personal/rbox-core` deferral
cleared; its queued deletion completes when the founder's other agent's live
worktree ends (designed per-ref hold). **24h zero-deferral soak started at the
15:3x UTC release restart — the final "Mac unwedged" claim waits for it.**
Standing-rule additions this session: prod promotions/release tags need a fresh
per-action yes (one autonomous promotion got called out); cap arbitrage loops
at 2-4 rounds; keep each dispatched agent's context small + self-contained
(founder: "simplicity is key"); codex quota <10% until 07-29 → implementation
routes to opus-5 medium subagents till then. NEXT: soak verification, then the
parked queue (thermo-nuclear sweep of the git-sync subsystem post-landing,
design 201 parked, SQLite 2.0 track, class-C degraded-workspace question, #447
triage — the founder's other agent's PR). Previous update (2026-07-24
refactor day — two ownership decompositions MERGED): #419 split `daemon-control.ts` (869 lines) into
`daemon/runtime-state` + `daemon/process-control` + `daemon/log-reader` behind
a 55-line explicit facade; #420 split `auth-cmd.ts` (2,171 lines) into ten
`src/cli/auth/` workflow owners + `remote/auth-command-wire` (exact legacy
wire) behind a 50-line barrel. Both reviewed here as move-fidelity audits
(line-multiset + per-function body diffs against main — every body
byte-identical modulo named-helper extraction; export surfaces locked by exact
facade/surface tests). #420 needed fixes before merge: (1) design-number
collision with #419 — both claimed 194; auth renumbered to
**195-auth-command-decomposition.md** + REVIEW-195; (2) a latent CI landmine —
`prompt-lazy.test.ts` asserted the Ink sentinel **in-process**, but CI shards
run all files in ONE bun process, so any test-file addition can recolocate it
with `prompt-ink.test.ts` and fail it deterministically (this PR did); fixed
by running the whole assertion in a spawned child (codex, per spec).
**Playbook lesson: an in-process global-state assertion is
shard-partition-dependent — isolate such tests in a subprocess from day one.**
Afternoon: **#421 MERGED** (design **196** sudo-upgrade home isolation —
exe-scoped lock/release sidecars via the fenced lockfile primitive,
pending/committed anti-rollback floor written around the rename, elevated
runs never touch ~/.rbox; reviewed here, 3 nits fixed via codex: sudo hint
on EACCES, honest pending-floor copy, no swallowed release warning) and
**#418 MERGED** (design **197** privacy-safe onboarding funnel telemetry —
ALIGNED after an opus round folded in the survivorship-bias fix:
`firstFailure` now rides `onboarding_flow` so never-recovered initial-sync
failures reach the funnel; REVIEW-197 logs the round). Evening: the codex `/thermo-nuclear-code-quality-review` roadmap (Mac
session) drove two more decompositions — **#422 MERGED** (design **198**
config.ts → workspace-config / sync-state-model / sync-state-store /
reset-state; NOT pure-move: 3 helper renames + new fail-closed preconditions
on the extracted `installGenesisResetStateUnderHeldLock`, all audited) and
**#423 MERGED** (design **199** git-cmd → git/deferrals-command +
git/resolve-command + git/resolve-presentation; opus-implemented, twice
inventory-gated by the closed allowlist tests in base-composer-structure +
reset-consent — those gates WORK). Design numbers: 194 daemon-control,
195 auth-cmd, 196 sudo-upgrade, 197 onboarding-funnel, 198 config,
199 git-cmd. **Standing flow change (AGENTS.md/CLAUDE.md/dev-cycle skill):**
`/simplify` stays per-cycle; periodic codex thermo-nuclear review refreshes
the ranked refactor roadmap and SUPERSEDES `/antislop-codebase`. Remaining
roadmap (risk-ordered): key-delivery-fulfill (bake first), setup-cmd (couple
to 197 impl), daemon.ts WS-subsystem-only, then apply/follow/push behind
characterization harnesses. Telemetry read: Mac ws_e4abbfc6 (110 repos,
2 deferrals ~24h) is single-handedly the 8-min pull p50 in client sync-phase
— founder resolve pending; gc pipeline degraded (0 B purged 24h). Night:
**8-reviewer thermo-nuclear sweep** → ranked roadmap at
docs/design/notes/2026-07-24-thermo-nuclear-sweep.md (~40 verified findings,
4 tiers, ~15 cleared-with-reasons; WS-extraction seam pinned for the
daemon.ts cycle). Quick batch SHIPPED same night: **#424** (dead `heals`
scaffolding), **#425** (canonical GIT_DEFERRAL_REASONS tuple + adopt
emitJson + doctor preview dedupe), **#426** (auth-wire fetches now
deadline-bounded — closed an unbounded-hang class on the pre-enrollment
login path — + dead pairCreate lane deleted). CORRECTION folded into the
roadmap: the journal.ts v1.7.24 legacy-recovery delete is gated on fleet
adoption past 1.7.24 (Jethro still ON 1.7.24), not on a sweep.
D1-D4 RULED (all as recommended) →
**#427 MERGED** (shared executeOp between pump and recovery probe; recovery
scans now clear watcher-degraded, recovery fullScan arms the quota probe,
recovery pulls consume+record notify latency — the halt-inflated
notify-latency telemetry corruption is FIXED; 8 characterization tests).
**FLEET UPGRADED to 1.9.0** (all 3 hosts via managed rbox upgrade; FM
pull-only preserved+witness-verified; Mac daemon skew 1.7.22→1.9.0 closed —
its upgrade declined the restart "desired state changed" but autostart
reconciled it back unaided). **Mac cleaned**: empty "test sync 2" workspace
untracked (server-side ws_2f43377f still exists — dashboard delete is the
founder's), 32 activity-litter dirs swept; the auth-failing agent_inN2
daemon is NOT on the Mac — hunt it on another host via /observe-fleet.
Desktop's 44 litter dirs unswept (permission classifier blocked the rm).
**TIER 2 COMPLETE — #428-#431 all MERGED** (4 parallel batches, codex×3 +
opus×1, each audited here): #428 API (platformSecretMatches + lease-liveness
SQL fragment, bind orders preserved), #429 engine (fsutil errno predicates +
canonical moveNoClobber with hook-threaded counters + device-secrets
packaging), #430 remote+cmd (errorCode() + confirmDestructive with per-site
policy fidelity; doctor deliberately unmigrated; one structural source-scan
anchor updated in sync-mutex.test), #431 sync-git trio (present-witness in
base-composer, throwing gitCommitAncestry with both fail-closed mappings
preserved, default-partial hoist). Recurring codex tic: it minted an
unrequested "design 200" doc in three separate batches — dropped each time;
number 200 remains FREE. **LATE NIGHT — SWEEP #2 (8 opus reviewers, post-Tier-2)
→ docs/design/notes/2026-07-24-thermo-nuclear-sweep-2.md.** Each lane got sweep
#1's roadmap as an EXCLUSION list and was told to produce an executable plan or
challenge the framing — so its value is 6 real defects + 4 corrected premises,
not more cleanup ideas. **ALL 10 TIER-A ITEMS SHIPPED, #432-#438 MERGED**
(7 parallel worktree opus agents, every fix proven red→green with the fix
stashed, each diff audited here, main CI 18/18 green on the combined shard
partition): **#432** viewer gate on workspace-KEK publish + stripe requeue into
its batch + account-delete guard parity; **#436** multipart `retry_later` 503 no
longer destroys the resume state (every file >90 MiB needed a full re-upload) +
the first `staging/` R2 reclaimer; **#433** checkout lock probe fails CLOSED
(an unreadable index.lock read as "no lock" → journal deleted while its lock
lived → permanently stale-unattributed, doctor+human to recover); **#438**
shutdown mutation gate no longer swallowed (a stop mid-pull was destroying
held-attempt state for repos that never failed) + deferral precedence covered
12/16 reasons with a fail-OPEN safe verdict, now compile-enforced; **#435**
long-flag arity resolved per command (`rbox status --git <path>` silently ate
both flag and path); **#434** `confirmDestructive` honours the interaction
policy in all four modes (stderr-redirected runs threw instead of proceeding —
and today's own test PINNED the bug); **#437** 14 command-layer fetches
deadlined + a `bare-fetch` guard so the class cannot reopen. **Agent findings
that beat the spec** (all verified here): `poolMap`'s docstring is WRONG — a
throwing task stops only its own worker while siblings keep pulling, so the
specified bare re-throw would have left ungated disk work racing the stop
deadline (latch-and-drain instead); a strict per-command arity map would have
broken `track --no-interactive` via HIDDEN_FLAGS (union base + per-command
overlay instead); preserving multipart state alone turns the 404 into a 500
(tolerate `NoSuchUpload` only when the prior staging object survives).
**TWO OF MY OWN CLAIMS WERE WRONG:** notify.ts's idempotency_key is NOT dead
weight — design 16 §4.4 says CF Email exposes no client idempotency key and the
column is stored deliberately for a future one (correctly refused, not patched);
and the confirmDestructive trigger is stderr-not-a-TTY, not `--no-interactive`
(no call-site command even accepts that flag). **NEXT (Tier B, founder calls):**
6 dark opt-in flags with zero setters — flip or delete, incl. RBOX_PUBLISH_PIPELINE
(961 non-test lines whose field gate FAILED 2026-07-13) and RBOX_WATCHER_RETRUST
(the Mac I/O duty-cycle fix, default-off against the default-on rule); delete the
dead pre-E2EE plaintext transport still wired as the DEFAULT fallback. **Tier C
roadmap corrections:** INVARIANTS.md has ZERO mechanical coupling (nothing reads
it; every git-lane anchor stale) — tag+structure-test it BEFORE any queued split;
daemon needs StatusSurfaceWriter + DriftAuditor on top of the queued four (155
fields / 14 concerns); state-plane Tier 3 prescribes the wrong cut (the write
funnel already exists — delete the double-compose, don't extract it); versions.ts
is one of TWENTY unowned API modules (43% of the API is outside CODEMAP, so the
CODEMAP amendment gates every API split) and roots/rootsInspect is a two-copy
reachability oracle feeding GC deletion AND fair-use billing. Tier D: `src/wire/`
shared contract (the CLI has two parsers for one 409; one mis-reads epoch_stale
as `{head: undefined}`) — the only finding with external-user exposure.
**LATE NIGHT PART 2 — codex adversarially reviewed the 8 merged commits and found
2 SHIPPING REGRESSIONS we introduced; both fixed and merged.** (a) **#442** — #435's
per-command flag arity broke the deprecated `link` alias: it declares no flags of
its own, so `rbox link --git false <path>` fell to the union fallback (colliding
names pinned valueless), tracked `./false`, ignored the real path and turned git
sync ON. Fixed with one canonical `resolveCommandAlias` consulted by
`longFlagArityFor`; found a 2nd alias (`daemon`→`start`) and pinned both in the
registry guard. (b) **#441** — #432's requeue-inside-batch was correct but became
UNCONDITIONAL, so a late `customer.subscription.deleted` for a deleted account
inserted a `fairuse_account_queue` row with no FK; the scheduler (one account per
invocation) acquired the ghost, failed `account_missing`, and requeued it +1h
forever, permanently consuming capacity. Fixed by conditioning the insert in SQL
on a live account matching `id` AND `stripe_customer_id` (the sibling UPDATE nulls
`stripe_subscription_id` but not the customer id), plus draining on
`account_missing` instead of requeuing — which also clears ghosts already in prod.
Codex CLEARED #436 (tolerated `mpu.complete()` cannot publish partial bytes — the
canonical `put` verifies full SHA-256) and independently re-verified #433's
six no-op call sites. It also caught that #437's black-hole test **passes before
the fix** (`fetchAccountSummary` already had a timeout) — that agent claimed
red→green and was wrong. **PROD PROMOTED** (founder `main:production`, 20 commits,
NO new migrations, dev-verified first): the >90 MiB multipart data-loss fix, viewer
gate, account-delete guard, ghost fix, Tier 2 API refactor all live; deploy green,
prod worker 401/200. **RETRUST FLIPPED DEFAULT-ON (#443).** Design 104's named
bake condition was never run — nobody had executed that code against a real
FSEvents stream (every test drives an injected seam). Soaked on the Mac and PASSED
on the first real drop: classifier matched the REAL kernel string, `window=1/6
wouldFuse=n`, re-trust in 70s, `confirmed=0` AND `unattributable=0` on both deep
scans, and Layer A pruning restored (37 `dc:hit` vs 1 `dc:unpruned`). Kill switch
is now `RBOX_WATCHER_RETRUST=0`; suite pins legacy via test-preload
(`RBOX_FILES_FIRST` precedent) and the 3 OFF-path tests now spell OFF as `"0"`
(under a kill switch `delete` means ON — `watcher-retrust.test.ts:154` would have
hard-broken). **MAC**: `/usr/local/bin/rbox` (a Max-Howell-style experiment, 1.7.22,
resurrected every boot by the launchd plist and un-upgradable) REMOVED, back on
`~/.rbox/bin` + PATH; both artifacts archived in `~/Downloads`. Running
`1.9.0-dev+4a96f0d`; revert at `~/.rbox/bin/rbox-1.9.0-release.bak`.
**DESIGN 200 (PR #440) — worktree lifecycle resilience**, from two live wedges on
the Mac: a spent worktree defers the whole repo (`sync-git/apply.ts:1447-1450`
escalates ANY held ref, contradicting design 116 invariant #4) and squash-merge
makes it unrecognizable (there is **no `--merged`, no patch-id, no cherry anywhere
in `src/`**); and a published-then-deleted branch leaves BASE positive forever
(`base-composer.ts:357` publisher-ack cannot remove a BASE member — by design)
with no manual exit (`resolve-command.ts:658-665` refuses that shape by name).
Founder RULED: publish the deletion fleet-wide; breaker defers at max(25, 25%);
no pin CONDITIONAL on recoverability; double-proof not a settling window; **P4
per-ref pending lane IN SCOPE** (overruled the doc's follow-up rec); doctor gains a
worktree section, no absolute paths yet. v2 revision found the Q3 premise is true
only via a SECOND constant (`TOMBSTONE_PIN_RETENTION_MS` keep-pins made by
FOLLOWERS when they prune, not the tombstone itself) — and **FALSE for
single-device workspaces**, kept open as **Q3a (needs a founder call)**. Also:
`expireTombstoneKeepPins` has no production caller. Corrections logged: the
breaker precedent is design **108** (`max(20%,1000)` push-side), not 44
(`≥100 ∧ ≥50%` pull-side); `redactGitLogLines` is a grammar allowlist, NOT a path
scrubber, with 2 holes. P4 stages default-OFF under the named-bake exception —
not for cost but because a bad merged section publishes fleet-wide and
`gitIncomingKey` moves, so revert is not free. Codex `/arbitrage` round running.
Bonus find: the sync path still uses the UNBATCHED per-tip ownership proof
(`reachability.ts:106-126`) while design 128's batched version is wired only to
`rbox git resolve` — likely where much of the 9s (and 867s wedged) `ownershipMs`
lives; follow-up to design 174.
**STANDING RULE (founder, 2026-07-24): rbox-core + Dfinitiv/conductor-workspaces/*
on the MacBook are the designated problem areas** — highest worktree/branch/
squash/agent turnover, where wedges appear first. No git-sync fix is "done" at
merge; it is done when deployed to the MacBook and the specific error is gone
from the daemon log, and design 200's implementation gate is a full agent
lifecycle (worktree → branch → squash-merge → delete) in those repos with ZERO
surviving deferrals over 24h. ~8 prior "this unwedges the machine" claims were
declared at merge time and were wrong — narrow, field-verified claims only.
**DESIGN 200 ALIGNED AND MERGED (2026-07-25, #440 → f7845e8b) after 12 codex
adversarial rounds / 13 revisions — the full /dev-cycle loop, and it earned it.**
Final shape: deletion is an ORDINARY captured transition (witness → verify-only
locked proof → exact-OID tombstone at capture → BASE retires only at the
publisher-ACK, one-sentence design-130 amendment with fencing that survived
review); the window is a per-ref hold; recovery is the per-ref keep-pin proven
atomic with the delete. Killed en route, each with recorded evidence (11
REVIEW-200-R*.md files on main): breaker math (founder: "some math is just not
gonna prevent it"), pins (file-history contract), P4 (parked as design 201
placeholder with landmines + AC), early BASE retirement (the primitive behind 5
failed rounds — step-out-a-layer call), the C3 field (4 rounds of churn, then
WITHDRAWN under founder principles; residual property-quantified instead).
Accepted residual, stated at true width: lost-ACK + same-OID re-creation within
one cycle consumes own tombstones once per window, per-ref keep-pinned;
family-(ii) (degraded-unlocked overwrite) FLEET-MEASURED ABSENT (zero degraded
workspaces; all hosts link()-capable) and the post-rename durability half FIXED
IN CODE — **#448 merged**: state.json's parent was NEVER fsynced and the marker
unlink was flushed first (one crash window could lose new state AND fallback
baseline); + 3 more unpublished state.json renames fixed; pre-merge codex review
zero blockers. CLASS-C QUESTION parked for founder (no urgency, state absent
from fleet): should git publication fail closed on a degraded-unlocked
workspace instead of accepting the widened residual? Loop mechanics lesson:
harness kills orphaned codex mid-run twice (pipe-block zombies) → detached
setsid + file-redirected output + Monitor on the verdict file is the reliable
shape; codex resume of multi-agent v2 sub-agent sessions is NOT possible
(-32600) — relaunch fresh instead.
NEXT: implement 200 in landing order P2→P3→P1+P1b (each phase gated on
`sg docker -c 'bun run rig run worktree-squash-lifecycle'` progress toward
green — the merged expected-RED scenario is the acceptance gate) then the 24h
zero-deferral MacBook soak per the standing rule before ANY "unwedged" claim;
197; the 193 live smoke suite; sweep Tier 3. NEXT: Q3a founder call; implement 200 in landing order P2→P3→P1+P1b→P4; 197;
the 193 live smoke suite; sweep Tier 3. Mac's 2 repo deferrals persist by design
until 200 lands (rbox-core = the phantom `fix/coupon-slack-notification`, a real
squash-merged-then-deleted branch; savvy-core-v1 = `prepared Git child incarnation
unavailable`, `checkout-txn.ts:420` — three-state probe crammed into two, the
mirror of #433). Unfixed from codex's review: #438's latch can lose the shutdown
exception if a progress callback throws (its test forces concurrency=1 so does not
prove multi-worker drain), and #439 can surface absolute paths in LOCAL logs._

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

_Superseded — 189 core-aligned, pre-implementation (2026-07-23): **DESIGN 189 core-ALIGNED; PR #412
shipped to prod; day = 3 releases + 5 PRs**): Design 189 (web-approved
pairing — web approval -> an enrolled daemon auto-delivers keys so a new
machine enrolls without pasting a token/phrase) driven from rough draft to
v7 core-ALIGNED through 2 parallel codex rounds + 3 serial gates (all in
worktree .claude/worktrees/189-web-pairing, branch
design/189-web-approved-pairing, NOT merged). Mechanism (verified): the
fulfilling daemon is a live admin — buildAdminRoster (roster.ts:124) signs
a roster admitting the new device's exact pubkeys, wraps MK to the device
enc pubkey ONCE under the persisted device context, commits that wrap's
hash, and PUBLISHES the roster server-side atomically; the new CLI fetches
+ verifies the full chain (signer authority) and stores the wrap as-is.
Founder RULINGS: (Q1) epoch rotation NOT a prerequisite — accepted that a
revoked device keeps already-synced plaintext + a ~5-min download-grant
window (grants bypass bearer auth, grants.ts:22 / worker.test.ts:172);
honest revoke copy required; rotation filed as design 191 (stub). Zero
typed codes (fragment auto-binding; manual = device-auth only). 190
(passkey escrow) DECOUPLED — browser-unwraps-RK violates the key-material
law; needs its own redesign. **JUDGMENT CALL (mine, surfaced): stopped the
design loop at core-aligned — the last 2 gates converged on ONE theme
(handoff crash-recovery idempotency), now specified via the existing
crash-safe-reuse discipline + an implementation crash-injection acceptance
gate (189 §14), per the anti-treadmill rule. NOT a gate green-light.**
NEXT: implement 189 (big multi-surface: apps/api device_auth+pubkeys +
key_delivery table + migration 0033 + nudge + escrow; daemon fulfillment
flight; CLI login FSM + staging journal; web approval step-up + fragment
compare + route CSP; #412's fragment-preservation gap in cli-login/+page.ts
still open). Decide: merge the 189 doc to main + start implementation, or
one more confirmation gate on v7's §14 framing. **PR #412 (Clerk
redirect_url fix) MERGED + PROMOTED TO PRODUCTION** (a36dbe2c; web-only,
no apps/api/D1 change; app.rbox.to 200) — CLI-login deep links now survive
the sign-in bounce. Founder memory: minimize-user-typing law recorded.
Session totals below._

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
