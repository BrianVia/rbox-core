# 163 v5 ratification review — lens: migration, rollout, operational risk (opus, 2026-07-27)

## Verdict: RATIFY-WITH-EDITS — staged

The correctness core (138 re-derivation, M0–M7 authority machine, decoder freeze, U0 terminal semantics) has survived five rounds and is exceptional. **The rollout section has not been reviewed by anyone.** It is 20 lines out of 2,851, and two of its load-bearing assumptions are false against the current repo. Recommended gate:

- **U0 and U1 may start immediately on `2.0`** — internal, unshippable, zero fleet exposure. Nothing below blocks them.
- **U2 exit and everything from U3 onward is blocked** until edits B1–B4 land in the doc.

## Blocker-class (rollout is not executable as written)

**B1 — The 2.0 prerelease channel does not exist. Verified, not inferred.**
`scripts/release.ts:112-134` is single-channel: any `v*` tag rewrites `releases/version.json`, the latest aliases, and `install.sh`. The only guard is `semverGt(before, version)` — an anti-rollback check. `src/cli/semver.ts` parses prereleases and ranks `2.0.0-rc.1` **above** `1.10.1`. So tagging a 2.0 prerelease publishes it to `install.sh` and every `rbox upgrade`, including the paying user. The doc's "2.0 prerelease", "barrier-compatible bake release", and "U5 fleet bake" all assume a distribution concept that isn't built and isn't in U0–U5. The fleet's `rbox-dev` symlink covers founder hosts, but not the 1.7.x bake release, which must reach external users. Name both channels and make the prerelease-vs-latest split a gated deliverable.

**B2 — The 1.7.x barrier release is a hard prerequisite and is not a slice.**
Referenced three times (recognize `Q` before every read/write → `StateFormatTooNewError`; the pinning inventory test; the 1 MiB M1 reserve consumed by migration) with no slice, no owner, no ordering gate. It must ship on `main` **and be adopted by all 4 external users and all 3 fleet hosts** before any 2.0 binary migrates a workspace. Add it as an explicit pre-U0 unit with an adoption gate, not a footnote inside U-slices.

**B3 — No abort runbook, and the artifact that looks like a downgrade is an unguarded footgun.**
Declining an automatic downgrade is defensible (163:1654-1656). Leaving the operator with nothing is not. The doc creates `.rbox/state.json.pre-163.bak` — a permanent, fixed-path, full copy of the pre-migration state, at exactly the path an operator will restore when a fleet host wedges. Doing so destroys `Q` and silently re-elects a stale JSON BASE on 1.x: `SyncState` (`src/cli/sync-state-model.ts:25-68`) has **no version field**, `loadRawState` is an unchecked cast, and the only guards are `stream`/`stateNonce` CAS — all of which a `.bak` satisfies. No halt, no warning, stale `lastSyncedSequence` against an advanced server. Specify the supported abort procedure and either make it safe or structurally refuse it. "Recovery evidence, never authority" is a property the filesystem does not enforce.

**B4 — Mixed-fleet skew is analyzed only for local state format, not for the wire.**
The `Q` barrier is per-host; two hosts sharing a workspace never see each other's `state.json`. The real skew risk is that U2 rewrites ignore-rule evaluation (`IgnoreRuleIndexPort`), tracked-path membership (`TrackedPathIndexPort`, new `TrackedIndexUnavailable`/`IgnoreRulesUnavailable` fail-closed verdicts), deferral/carry, and mass-delete decisioning — all wire-visible. "84 unchanged" covers the protocol, not the semantics fed into it. No differential test is named anywhere: same corpus → 1.x manifest vs 2.0 manifest, plus a two-host rig scenario (2.0 host + 1.x host, one workspace). Make that U2's exit criterion.

## High (change the plan)

**H1 — U2 is not a slice; it is ~70% of the project.** Scan/reconcile/apply/push ports, generation-CAS, `cache-v2.db` with six sub-ports, tracked-path index, ignore-rule index, receipt/oracle port, both outcome ports, the materialization budget. No falsifiable checkpoint inside it. Decompose into U2a–U2f with per-unit exit criteria.

**H2 — The first falsifiable fleet checkpoint is unnamed, and it is not after U0.** U0/U1 produce nothing fleet-observable. The first real signal is a 2.0 dev build on a **throwaway workspace via the genesis path** (M0 absent/absent/absent) after U2 — before migration exists. Name it; make genesis-path validation an explicit U2 deliverable.

**H3 — 2.0 merge process has no owner, no cadence, no conflict policy.** Measured on main: 1,019 commits in 60 days, 93 touching the state/engine seam; `daemon.ts` churned 6,222 lines, `sync.ts` 5,178, `sync-git/apply.ts` 4,460 in that window — precisely the files U2 rewrites. Needs: a named owner, a CI-driven main→2.0 merge at at-worst-weekly cadence with a conflict report, and a **port-forward ledger** for main fixes landing in files 2.0 deletes (re-implementations, not merges).

**H4 — No named kill criterion.** `<200 ms` is explicitly a target whose miss is "not permission to broaden the claim." So 2.0 can ship delivering no user-visible improvement while carrying migration risk, permanent disk increase, and ~15 new halt classes. Define the U5 ship/no-ship threshold now (trusted status ≤ X ms AND daemon RSS ≤ Y on the 112k corpus), with re-scope or revert as the named alternative.

## Medium

**M1 — No migration duration budget or progress UX.** M3 imports 112k files in one transaction; M4 runs full `integrity_check` plus a second semantic digest; all under the workspace mutex with `synchronous=FULL`. First 2.0 boot on the 59 MB Mac plausibly stalls minutes with no user-visible signal. Add a measured target and a progress/status state.

**M2 — No steady-state disk budget.** New permanent residents: `state.db`, WAL (backpressure only at 256 MiB), `cache-v2.db`, `.pre-163.bak` (~59 MB, never deleted), `legacy-json/<sha>.json` (~59 MB, immutable, never deleted), plus stage/plan/spool DBs. Plausibly 5–10× today's `.rbox`. Add a disk budget and retention policy for `legacy-json/`.

**M3 — No `bun:sqlite` contract suite, no Bun version floor.** Zero production `bun:sqlite` in the repo today (only `scripts/storage-truth*.ts`). Add a U1 CI suite asserting exactly what the design depends on (WAL/`synchronous` readback, `busy_timeout`, `wal_checkpoint(TRUNCATE)` busy-result shape, error-code surfacing, statement finalization, transaction-callback semantics, `temp_store=FILE`) plus a pinned Bun floor. Survives the Bun Zig→Rust rewrite by construction.

**M4 — `PRAGMA fullfsync` never pinned.** On Darwin plain `fsync()` does not guarantee platter durability, yet the power-cut rig models "discard non-fsynced writes". Pin `fullfsync`/`checkpoint_fullfsync` on Darwin or record the accepted risk.

**M5 — New halt surface has no user-facing copy.** ~15 new fail-closed halt types, each stopping sync. Two external users are non-technical. Require every new halt reason to ship with a plain-English doctor entry + non-interactive twin, as a U3/U4 deliverable.

## Verified clear

- **`.rbox/` WAL/sidecar churn is a non-issue.** Exclusion is prefix-based across three non-overridable layers: `isHardExcluded` (`src/engine/ignore.ts:316-322`), `BUILTIN_IGNORE`, and native watcher prune via `ALWAYS_NATIVE_PRUNE` (`src/engine/ignore.ts:150` → `src/cli/daemon/watcher.ts:384`). SQLite sidecar churn generates zero watcher events. Worth one citing sentence in the doc.
- **The `Q`-at-the-legacy-path barrier is well-reasoned**: `parseResetJsonBytes` (`src/cli/reset-io.ts:292-302`) throws on non-JSON so a 1.x binary halts on the sentinel; and it defends the genuinely dangerous `loadState` `if (!loaded) return fresh` genesis path (`src/cli/sync-state-store.ts:312`). But it is a single mechanism with no version field behind it — the pinning inventory test must ship in the B2 bake release.
- Migration fencing is sound: JSON stays authoritative through every failure up to one atomic rename; backups additive, never deleted on failure.

**Bottom line:** ratify the mechanism, start U0/U1. Do not let U2 close or U3 begin until B1–B4 fold.
