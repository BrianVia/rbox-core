# REVIEW-206 — ledger

Status: r2 folded, serial gate pending.

## Round 1 (parallel: codex gpt-5.6-sol medium ×1, opus medium ×1) — both CHANGES-REQUIRED

Synthesized rulings (C=codex, O=opus):

| # | Finding | Ruling |
|---|---|---|
| C1 HIGH | Watcher captures the matcher object at start (`daemon.ts:791`, `watcher.ts:364/431`); rebuild swaps `this.matcher` but the watcher keeps filtering with the old one — trusted can re-engage over events it missed. Pre-existing hole (ignore-rule-text rebuilds already hit it), widened by 206. | ACCEPT → §3 watcher facade. Verified `nativePruneGlobs(root)` is matcher-independent, so JS-layer delegation suffices. |
| O1 HIGH | Generation stamped at install time credits a mid-scan rebuild to a stale-matcher manifest (`replaceManifestFromScan` awaits `scanManifest` for seconds; hygiene timer runs un-pumped on pull-only). | ACCEPT → capture `matcherGeneration` at observation start, stamp that. |
| O5 MED | `observeDurableGitState` mirror would run a sync multi-second rebuild inside `pull()`/`pushManifest()` save callbacks and the hygiene timer. | ACCEPT-MODIFIED → mirror dropped; the site leaves provenance stale (P7 refuses, named) and the guarded rebuild fires at the next pump-owned `loadSyncBase`. Cost: ≤1 extra scan pull; safe direction. |
| C2 MED / O8 LOW | Skip-result refactor underspecified: `doPull` consumers, `DaemonInternals:104`, tests `:216/:284`, type home. | ACCEPT → §4: separate `initialSkip`/`trustedLocal` locals; `SkipCause` in `manifest-update.ts`; ripple sites named. |
| C3 MED / O2 MED-HIGH | "Additive-only / nothing greps the bare line" false — `daemon-trusted-pull.test.ts:424` asserts exact `"pull local=scan"`. | ACCEPT → claim retracted; test change named. |
| O3 MED | Mass-delete refusal still emits a bare causeless `pull local=scan`. | ACCEPT-MODIFIED → `skip=refused` token; details remain on the existing `refused=…` line. |
| O4 MED | "At worst the safety tick" wrong for pull-only daemons (`daemon.ts:997` routes them to hygiene; healing bound is the 30-min deep tick). | ACCEPT → bound restated + mitigation (F2 heals same-op for pull-arrived topology). |
| C4 MED vs O-verify | Conflict: does stale `knownGitRepos` affect trackedness? Resolved by orchestrator reading `ignore.ts:369/460/550-555`: the `known` FLAG is read only by `unevaluatedGitRepoForPath` (opus right), but trackedRepos MEMBERSHIP is seeded from `knownGitRepos` and a gone-from-disk entry loads unavailable → `isTracked` fails closed to "possibly tracked" (codex right in substance). | ACCEPT-MODIFIED → Risks corrected: membership-driven distortion, fail-closed direction bounds it. |
| C5 MED | Rebuild cost overstated (git work only under tracked evaluation). | ACCEPT → prose qualified. |
| C6/O6 LOW | Double rebuilds at `:2000/:2284/:3246` when text+key both change. | ACCEPT-AS-ACKNOWLEDGED → rare, harmless; noted in §1, no new API. |
| O7 MED-LOW | P7 near-inert when tracked evaluation off; simpler bypass exists. | OVERRULE bypass (second trust lattice for marginal gain); design now states why. |
| O9 LOW | Missing tests: guard-no-fire, mid-scan rebuild, refusal skip; push-side test needs state-level simulation (MiniRemote has no capture). | ACCEPT → tests 2 (note), 4, 6, 7. |
| C7/O10 LOW | Anchor drift (2296 not 2295; ignore.ts:539-547; 202's stale P7 anchor). | ACCEPT → fixed. |

Both reviewers confirmed: rebuild-in-mutex is deadlock-free (`rebuildMatcher` sync, no mutex), `installManifest` is the sole manifest assignment funnel with exactly one full-workspace stamper, funnel coverage (loadSyncBase/seedFromState/observeDurableGitState) is exhaustive, and 202's F2 realignment claim is false at 202:184.


## Round 2 — serial gate (codex): CHANGES-REQUIRED, folded into r3

| # | Finding | Ruling |
|---|---|---|
| S1 HIGH | Pull-only bound false: hygiene swaps `syncBase` directly, pump binding is `this.syncBase ?? loadSyncBase()` (`:1661`), deep scans can run under the stale matcher indefinitely (backstop configurable to 0). | ACCEPT → `ensureMatcherProvenance` runs at every pump-owned observation-op start as well as inside `loadSyncBase`. |
| S2 HIGH | Facade insufficient for BACKEND state: parcel native globs are rule-text-dependent at subscribe time (`nativePruneGlobs` subtracts negations, `ignore.ts:227`); chokidar bakes `prunes` into watch admission (`watcher.ts:423`). | ACCEPT → §3b: fingerprint (native globs + repo key set) across rebuild; on change, restart watcher via existing errorGen downgrade → clean-scan re-trust. Tests 8b (both directions) + chokidar case. |

Serial gate confirmed: capture-at-observation-start correct at all install
sites; skip-token restructuring coherent.

## Round 3 — focused re-check: see REVIEW-206-r3.md

## Round 3 — focused re-check (codex): CHANGES-REQUIRED on §3b

| # | Finding | Ruling |
|---|---|---|
| R1 HIGH | errorGen machinery not safely invocable for deliberate restart (error transition trapped in watcher callback :812; startLiveWatch startup-only :784; clean-scan predicate :2483 doesn't bind session recency → overlap re-trust hole; fuse pollution; RBOX_WATCHER_RETRUST=0 undefined). | ACCEPT — and per founder step-out rule, resolved by DELETING the mechanism: hot re-arm descoped to its own future design. §3b r4 = fail-safe permanent downgrade (no re-trust this daemon lifetime), named log line, skip=p1-watcher attribution. No new lifecycle machinery. |
| R2 HIGH | nativePruneGlobs+keys fingerprint insufficient for chokidar (full prunes admission inputs). | ACCEPT-MODIFIED → chokidar downgrades on ANY rebuild (legacy/small backend); parcel triggers on its exact subscription input (nativePruneGlobs output). |
| R3 | Boundary guard placement OK if before errorGenAtStart/audit/watcherScanMode. | ACCEPT → ordering pinned in §3b. |

Round 3 confirmed: capture-at-observation-start and skip tokens coherent
(from round 2); boundary guard concept correct.

## Round 4 — step-out ruling (founder directive mid-cycle)

The watcher-subscription staleness is a PRE-EXISTING hole (every
ignore-rule-text rebuild already leaves the backend stale today) that the
reviews surfaced adjacent to 206. Bolting a safe live-restart protocol onto
a latch fix was the wrong layer. r4 ships: latch fix (§1/§2) + facade (§3a)
+ fail-safe named downgrade (§3b) + skip causes (§4). Hot re-arm = follow-up
design (issue to file). The founder's field case triggers no downgrade and
heals fully. Final confirm round: REVIEW-206-r4.md.

## Round 4 confirm (codex, narrow): CHANGES-REQUIRED — three narrowing findings, folded into r5

| # | Finding | Ruling |
|---|---|---|
| F1 | Permanent P1-down: use the existing terminal `fused` state (re-trust only transitions from `suspect`); log via the transition path, guard double-log. | ACCEPT → §3b. |
| F2 | Parcel trigger false negative: `!node_modules/` re-include expands matcher coverage while `nativePruneGlobs` output is unchanged (`ALWAYS_NATIVE_PRUNE`). | ACCEPT → trigger also fires when the new matcher stops pruning an ALWAYS_NATIVE_PRUNE path; test 8b case added. |
| F3 | Chokidar any-rebuild-fuse contradicts tests 1/2 healing claims (`armed()` fixture is chokidar at :165). | ACCEPT → healing claims qualified to parcel-with-unchanged-native-coverage; tests 1/2/9 on parcel fixtures; separate chokidar fuse test. |

## ALIGNED r5 — self-certified

Round trajectory: structural (r1) → boundary/backends (r2) → protocol
(r3) → step-out descope (r4) → state-name/trigger-bit/fixture (this
round). Residuals are refinements of the fold with no new class; the core
latch fix has been confirmed by every reviewer since r1. Self-certifying
per the convergence rule; implementation review will re-touch all of it
with code in hand.
