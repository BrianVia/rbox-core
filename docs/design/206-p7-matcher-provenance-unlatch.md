# 206 — Unlatch P7: matcher provenance must follow the base, and scan-skips must be named

Status: ALIGNED r5 (r4 confirm findings folded: fused-state downgrade, ALWAYS_NATIVE_PRUNE trigger bit, parcel-qualified healing claims + test fixtures — see REVIEW-206.md)
Fixes: #464. Corrects a design-202 error (§Fallback F2 claimed provenance
realignment that the code never performed).

## Problem (field evidence)

Mac burn-in, 1.9.1-dev+514d689, 2026-07-26 (issue #464): after a repo
clone→publish→delete→publish sequence, every pull logged bare
`pull local=scan` for 35+ minutes until daemon restart, despite the watcher
re-trusting after a clean full-tree scan and a deep scan reporting
`trustState=trusted`. The design-202 win (0.0s trusted pulls) silently
degrades to per-pull scans (~5s on the Mac) after any git-topology churn.

Three symptoms, one file:

1. **Permanent latch.** P7 (`daemon.ts:2151`) requires
   `matcherGitReposKey === gitReposMatcherKey(base)`. `matcherGitReposKey` is
   written only by `rebuildMatcher` (`daemon.ts:3170-3176`), whose call sites
   are exactly: boot seed (1203), ignore-rule watch events (2000),
   pull-wrote-rules (2284), adoption boundary (3217), workspace-config reload
   (3246). **No site fires when the base's `gitRepos` key set moves** —
   neither push commit (`daemon.ts:1896`/`1932`) nor the F2 git-topology pull
   path (`daemon.ts:2289`, `2308`). Once the base gains or loses a repo key
   without a coincident ignore-rule watch event, P7 is false until restart.
   The safety scan, deep scan, and watcher re-trust all heal P1/P2/P5 and
   none touch P7.
2. **Bare `local=scan` carries no cause.** `fallback=` is computed only when
   a trusted view exists (`daemon.ts:2298-2302`, leading ternary); the eight
   P-clause rejections in `buildTrustedPullView` (`daemon.ts:2145-2163`) all
   return bare `undefined`. Additionally, a `TrustedViewRefusalError`
   (mass-delete guard, `daemon.ts:2258-2263`) nulls `trustedLocal` after the
   view was built, producing the same bare line on the one path where the
   operator most wants attribution.
3. **`local=trusted fallback=git-topology` reads contradictory.** It is
   intentional (two orthogonal facts: which local view the main line read;
   why the post-pull O(applied) refresh gave way to a scan) — but one key
   name serves two questions and no key serves the common one.

Design-202 error being corrected: §Fallback F2 (202:185-196) claims the
fallback scan "realigns matcher provenance (P7)". It does not:
`replaceManifestFromScan` (`daemon.ts:2969+`) scans with the existing
`this.matcher` (`:2984`) and never rebuilds it. The comment at
`daemon.ts:2296` repeats the same false belief. (202's P7 row also cites a
stale anchor, `daemon.ts:3006-3011` → now `:3170-3176`; fix while editing.)

## Mechanism

### 1. Re-baseline provenance at pump-owned boundaries (guarded)

One private helper, called from two kinds of sites:

```ts
private ensureMatcherProvenance(base: SyncState): void {
  if (this.matcherGitReposKey !== gitReposMatcherKey(base)) this.rebuildMatcher(base);
}
```

- Inside `loadSyncBase` (`daemon.ts:1194-1198`) — covers push completion
  (`:1932`), post-pull reload (`:2289`), failure recovery (`:1755`), boot.
- At the start of every pump-owned observation op — in practice the deep
  scan and safety scan entry points — against `this.syncBase`. This is the
  serial-gate fix: hygiene installs `syncBase` directly
  (`daemon.ts:2343`) and the pump binding is
  `this.syncBase ?? loadSyncBase()` (`daemon.ts:1661`), so without the
  op-boundary check a pull-only daemon whose hygiene CAS reload returned a
  concurrent winner with a changed `gitRepos` set could deep-scan under the
  stale matcher indefinitely (backstop pulls are configurable to zero).
  With it, every full-workspace observation is preceded by the guard, so
  the healing bound for pull-only daemons is genuinely the next deep tick.

The key-equality guard is **load-bearing**: when tracked evaluation is
enabled (`respectGitignore`/`forceTrackedEvaluation`/`protectTrackedPaths`,
`src/engine/ignore.ts:370`), `buildIgnoreMatcher` may run
`discoverGitReposSync` plus per-repo `git ls-files` on tracked-cache misses
(`ignore.ts:550-555`, `:681`); without tracked evaluation a rebuild is only a
handful of `readFileSync`s. Guarded, it fires only on genuine topology
change (rare).

`observeDurableGitState` (`daemon.ts:2343-2350`) also installs a base
directly — but it runs inside `pull()`/`pushManifest()` save callbacks
(`daemon.ts:1862`, `:2211`) and the un-pumped deferral-hygiene timer
(`daemon.ts:997`), where a synchronous multi-second rebuild would stall the
event loop mid-network-op. It therefore does **NOT** rebuild inline: it
leaves `matcherGitReposKey` stale, P7 correctly refuses (named `skip=`), and
the guarded rebuild fires at the next pump-owned `loadSyncBase` (post-pull
reload `:2289`, push completion `:1932`). Cost: at most one extra scan pull
after a hygiene-driven key change — safe direction.

Known redundancy, accepted: the three sites shaped
`rebuildMatcher(await loadSyncBase())` (`:2000`, `:2284`, `:3246`) can
rebuild twice when an event changes both rule text and the key set — rare
and harmless (the outer unconditional rebuild is needed for text-only
changes, which the key guard cannot see).

### 2. Trusted requires a manifest observed UNDER the current matcher

Re-stamping the key alone would re-engage the trusted path over an in-memory
manifest whose inclusion/exclusion decisions predate the matcher change —
the wrong-fix class. Invariant P7 must actually enforce:

> The in-memory manifest was produced by a full-workspace observation
> **started** under the currently installed matcher, AND the matcher's
> `knownGitRepos` provenance equals the pre-op base's `gitRepos` key set.

Implementation: a monotonically increasing `matcherGeneration`, bumped in
`rebuildMatcher`. **The generation is captured immediately before the
observation begins** — `const observedUnder = this.matcherGeneration;`
before the `scanManifest` await in `replaceManifestFromScan`
(`daemon.ts:2984`) — and threaded to `installManifest`
(`daemon.ts:3193-3208`), which stamps
`manifestMatcherGeneration = observedUnder` on `full-workspace` installs.
Stamping at install time instead would credit a manifest observed under the
old matcher whenever a rebuild lands during the (seconds-long) walk; capture
at start makes a mid-scan rebuild leave the stamp stale so trusted correctly
stays off until the next clean observation. P7 becomes:

```ts
if (this.matcherGitReposKey !== gitReposMatcherKey(base)) return { skip: "p7-matcher" };
if (this.manifestMatcherGeneration !== this.matcherGeneration) return { skip: "p7-matcher-observation" };
```

Healing bound after a topology change: the matcher rebuilds at the next
pump-owned boundary (base load or observation-op start, §1); the trusted
path re-engages at the next full-workspace install under the new matcher —
on the F2 pull path, the fallback scan in the very same op
(`daemon.ts:2308`, which now also runs under a *current* matcher instead of
the stale one). Read-write daemons otherwise heal at the 60s safety scan;
pull-only daemons (`daemon.ts:997` routes their safety tick to hygiene) at
the next backstop pull or 30-minute deep tick — both of which now run the
§1 boundary guard first, so the bound holds even for hygiene-driven key
changes.

### 3. The watcher must follow the current matcher (pre-existing hole, closed here)

The watcher captures the matcher **object** at start
(`daemon.ts:791-793` passes `this.matcher` into `startWatcherFn`;
`watcher.ts:364`/`:377` and the chokidar `ignored` callback `:431-434`
filter through that captured reference). `rebuildMatcher` swaps
`this.matcher`, so after ANY rebuild — including today's ignore-rule-text
sites, this is not new with 206 — the live watcher filters with the old
matcher and can drop events for paths the new matcher observes, while
P1/P2/P5/P7 and the generation all pass.

Fix, two layers (serial-gate correction: the facade alone is NOT
sufficient, because backend subscription state also bakes in
matcher-derived decisions):

**(a) Stable facade** for the JS filtering layer: the watcher receives an
object whose methods (`ignores`/`prunes`/`prunesForGitDiscovery`/`tracked`/
`unevaluatedGitRepoForPath`) delegate to the daemon's current matcher. This
covers every rebuild whose effects are JS-evaluable, switching atomically
with the assignment in `rebuildMatcher`.

**(b) Fail-safe downgrade when backend subscription inputs changed** —
NO hot re-arm in this design (r4 step-out; see REVIEW-206.md round 3/4).
The backend's subscription bakes in matcher-derived state the facade cannot
retro-fix: parcel's native globs are computed once at subscribe time from
workspace rule-file negations (`nativePruneGlobs`, `ignore.ts:227`,
`watcher.ts:382`); chokidar bakes the full `matcher.prunes` result into
recursive watch admission (`watcher.ts:423`). Designing a safe live
restart (serialized close/re-subscribe, re-trust gated on a scan started
after the new session, fuse exemptions) is a watcher-lifecycle design of
its own — deliberately deferred, not smuggled into a latch fix.

Instead, `rebuildMatcher` detects when backend-relevant inputs changed —
**parcel**: `nativePruneGlobs(root)` output differs (cheap: two sync
rule-file reads) OR the new matcher no longer prunes a path that
`ALWAYS_NATIVE_PRUNE` keeps natively excluded (the `!node_modules/`
re-include case: matcher coverage expands while the glob output is
unchanged — r4 finding); **chokidar**: any rebuild — and then fuses
watcher trust via the EXISTING terminal `fused` state (r4 finding:
`watcherTrustedForPull()` requires `trusted`, clean-scan re-trust only
transitions from `suspect`, so `fused` is permanent by construction and
transient-error recovery is untouched). The fuse is set through the normal
transition path so it logs once: `watcher downgraded: ignore-rule change
alters native watch coverage — pulls scan until restart` (guarded if
already fused). P1 stays false, every pull takes the (correct, pre-202)
scan path, `skip=p1-watcher` attributes it.

Why this is sound and sufficient here: those triggers are exactly the
cases where today's code silently delivers a blind watcher (the hole
predates 202/206 — every ignore-rule-text rebuild already leaves the
backend stale); the latch even masked some of them by accident, forcing
scans forever after topology churn. This design makes the same safe
outcome deliberate, named, and NARROW — the founder's field case (repo
clone/delete; no workspace rule-file change; parcel) changes no backend
input, triggers no downgrade, and heals fully via §1/§2. The §1 boundary
guard runs before `errorGenAtStart` capture, audit creation, and
`watcherScanMode()` selection.

Healing-claim qualification (r4 finding): §1/§2's "returns to
`local=trusted`" story holds for parcel with unchanged native coverage —
the fleet's default backend and the field case. On chokidar, ANY rebuild
fuses, so a topology change on that backend trades trusted pulls for scans
until daemon restart — acceptable for the legacy/small-workspace backend
where scans are cheap, and strictly no worse than today's latched
behavior. Tests 1/2/9 must therefore run on parcel fixtures (note:
`armed()` at `daemon-trusted-pull.test.ts:165` currently installs a
chokidar watcher — those fixtures switch to parcel or a fake with
parcel semantics), with a separate chokidar fuse test.

### 4. Name the skip cause

`buildTrustedPullView` returns a discriminated result:
`{ view: TrustedLocalView } | { skip: SkipCause }` with
`SkipCause = "kill-switch" | "p1-watcher" | "p2-observation" | "p3-pending" |
"p5-seed" | "p6-reset" | "p7-matcher" | "p7-matcher-observation"`.
The type lives in `manifest-update.ts` next to the other pull-trust
policy pieces. The post-drain P1/P2 re-check maps to its underlying clause.

`doPull` keeps **two separate locals**: `initialSkip` (from the build
result) and `trustedLocal` (the view, nulled on `TrustedViewRefusalError` at
`:2262` with a third token `"refused"`). Log line at `:2312`:

```
pull local=scan skip=p7-matcher
pull local=scan skip=refused        (mass-delete refusal; details stay on the
                                     existing `refused=…` line at :2261)
pull local=trusted
pull local=trusted fallback=git-topology
```

`skip=` (why the main line had no trusted view) and `fallback=` (why the
post-pull refresh scanned) are distinct keys for distinct questions; the
`fallback=` vocabulary and its tests are untouched. NOT purely additive:
`daemon-trusted-pull.test.ts:424` asserts the exact bare string
`"pull local=scan"` (kill-switch case) and must change to
`"pull local=scan skip=kill-switch"`; the direct view consumers at `:216`
and `:284` unwrap `.view`; the `DaemonInternals` surface at `:104` changes
accordingly.

### 5. Doc + comment corrections

- 202 §F2: replace the "realigns matcher provenance" sentence with a pointer
  to the guarded rebuild in `loadSyncBase` (this design); fix 202's stale
  P7 anchor.
- 202 §Telemetry: add `skip=` to the log contract.
- `daemon.ts:2296` comment: same correction.

## Non-goals

- `rulesChangedSinceDeepScan` is a red herring — it feeds only the deep-scan
  drift audit (`daemon.ts:2918`/`2938`/`3153`) and never gates the pull path.
  It stays out of P. (Known adjacent nit, deliberately untouched: cleared
  after the deep scan completes, so mid-scan ignore-rule events drop from the
  next audit — diagnostics-only.)
- No P7 bypass when tracked evaluation is off. When `respectGitignore` is
  disabled, stale `knownGitRepos` is nearly inert and P7 protects little —
  but branching P on matcher mode adds a second trust lattice for marginal
  gain, and the guarded rebuild already makes the latch transient everywhere.
  Uniform P7 stays.
- No change to F-clause semantics, `pull()`'s signature (`pull()` builds its
  own matcher via `matcherForState`, `pull.ts:237` — a mid-op rebuild cannot
  corrupt an in-flight pull), or the `installPullPatch` path.
- No AE/wire changes.

## Tests (`src/cli/daemon/daemon-trusted-pull.test.ts`; `armed()` at :158)

1. **The field regression:** armed → pull changing base `gitRepos` → assert
   existing `fallback=git-topology`, then a **second** pull in the same
   daemon returns to `local=trusted` (after the same-op fallback scan). This
   single assertion is the whole of #464 and is absent today.
2. **Push-side latch:** armed → base `gitRepos` key change via the push path
   → pulls must not be permanently `local=scan`; after one full-workspace
   scan, `local=trusted` again. (Harness note: `MiniRemote` has no git
   capture; simulate the key change at the state level rather than driving a
   real capture.)
3. **Anti-re-trust invariant:** immediately after a matcher rebuild but
   before any full-workspace install, pull is
   `local=scan skip=p7-matcher-observation`.
4. **Mid-scan rebuild:** a rebuild landing between scan start and install
   leaves the manifest stamped stale — next pull still skips (pins the
   observation-start capture semantics).
5. **Skip-cause matrix:** extend the P-matrix (:181-207) to assert the
   returned discriminant per clause; end-to-end log-token assertions ride the
   existing pull-line tests (the matrix calls `buildTrustedPullView`
   directly and cannot see log output).
6. **Refusal skip:** mass-delete refusal emits
   `pull local=scan skip=refused` plus the existing `refused=…` line.
7. **Guard-does-not-fire:** `loadSyncBase` on an unchanged key set performs
   no rebuild (pins the Risks §hot-path guarantee).
8. **Watcher facade:** after `rebuildMatcher`, events for a path only the
   NEW matcher observes are delivered (pins §3a; unit-level with a fake
   watcher capturing the facade).
8b. **Backend downgrade (parcel fixture):** a rebuild that changes the `nativePruneGlobs`
   output (e.g. a new `!…` negation under a hard-pruned dir) marks watcher
   trust down for the daemon lifetime — subsequent pulls are
   `local=scan skip=p1-watcher` and no clean scan re-trusts; an unchanged
   output does NOT downgrade (pins §3b both ways). Chokidar backend: any
   rebuild downgrades.
8c. **Boundary guard on observation ops:** with `syncBase` swapped by
   hygiene to a changed key set and no intervening pull, the next deep
   scan rebuilds first and its install stamps current (pins §1's
   serial-gate fix).
9. **Founder's literal sequence:** clone → publish → delete → publish; P7
   realigned at each step.
10. **Matcher currency at the healing scan:** the F2-path
    `replaceManifestFromScan` runs with `knownGitRepos` matching the
    post-pull base.
11. **Red-herring guard:** `rulesChangedSinceDeepScan` never gates
    `buildTrustedPullView`.

## Risks

- **Stale-matcher blast radius (corrected in r2):** `knownGitRepos` seeds
  trackedRepos *membership* (`ignore.ts:369`, `:550-555`); a stale entry
  whose repo is gone from disk loads as unavailable and makes `isTracked`
  fail closed to "possibly tracked" (`ignore.ts:460-470`) for paths under
  it, distorting trackedness/pruning — not just diagnostics. The `known`
  flag itself is read only by `unevaluatedGitRepoForPath`
  (`ignore.ts:539-547`). Fail-closed direction bounds it (over-inclusion,
  never silent exclusion), but this strengthens the case for §3's watcher
  facade and the observation-start stamp.
- **P3 drain becomes reachable on previously latched hosts:** once P7 stops
  rejecting, `applyPendingWatchEvents` runs on pulls where it previously
  short-circuited; the drift-audit accounting test
  (`daemon-trusted-pull.test.ts:396`) becomes newly load-bearing.
- **Hot path:** the key guard in `loadSyncBase` must survive review
  "simplification" — dropping it converts every base reload into sync fs
  work (and git subprocess work under tracked evaluation). Pinned by test 7.
