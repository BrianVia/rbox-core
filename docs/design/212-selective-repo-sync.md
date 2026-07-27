# 212 — Selective sync V1: pull-only scoped bindings

**Status:** ALIGNED r3 (2026-07-27) — r3's two residuals folded as further
fail-closed narrowings under the 3-round cap, self-certified; founder veto
window open. Implementation authority. Ledger: `REVIEW-212.md`.
**Charter:** Max Howell, 2026-07-24: *"one thing I was wondering can I sync a
repo from inside a workspace as I want just a few repo sync'd on my servers."*
Founder-approved workstream 2026-07-27.

## 1. Problem

The unit of sync is the whole workspace root, everywhere, by construction.
Max's `~/Development`-shaped workspace is tens of GB; his servers want one or
two repos out of it. Today the only answer ships the entire workspace to every
server (`key create-ci` → `RBOX_KEY=… setup --workspace … --pull-only`) —
full transfer + disk for a machine that needs 2% of it, through a flow the
founder calls "ugly af."

## 2. Scope decision (round-1 driven): V1 syncs a subset DOWN, never up

Round 1 (REVIEW-212, 15 findings, 8 critical) demolished the r0 thesis that
scoped *publishing* is nearly free. The recovery machinery re-encrypts source
bytes on 422 (`src/cli/sync-recovery.ts:298-400`) — bytes a scoped machine
deliberately lacks; enforce admission demands fresh receipts for prune-marked
carried refs (`apps/api/src/commit-delta.ts:67-78`,
`commit-accounting.ts:111-149`); the git planner classifies absent base repos
as removals and publishes that (`src/cli/sync-git/plan.ts:894-914`); and the
differ deletes every base path absent from the candidate
(`src/engine/diff.ts:39-53`). Each is solvable; together they are a campaign.

**V1 therefore restricts scope to PULL-ONLY bindings.** `--scope` without
`--pull-only` is refused at bind time ("scoped folders are one-way for now:
add --pull-only"). No publish ⇒ the entire publish-side finding class
(r1 findings 1, 4, 5, 6-push, 7, 10-push, 11-push, 13) is structurally
unreachable, not guarded against. This matches the charter use case: servers
consume repos; they push code through git origins, not through rbox.

What V1 keeps from r0:
- **E2EE verdict stands** (r1 concurred): paths are ciphertext server-side,
  so selective sync is client-side by necessity. No server changes, no wire
  changes, no epoch/key changes.
- The scope is a property of the **binding**, never the workspace; two
  machines may hold different scopes. Unscoped bindings are byte-identical
  to today; scope is pure opt-in.

What V1 drops from r0:
- **Single-prefix root flattening** (r1 findings 2, 3, 8: `FileEntry.path`
  is root-relative through scan/apply/git/receipts/caches — a local/workspace
  path codec would thread through everything). The scoped root mirrors
  workspace-relative paths: `~/srv/dev/Personal/repo-A/…`. One wart (nested
  parent dirs), zero codec. V2 may revisit mapping.
- Read-write scopes entirely (§7 ledger is V2's entry fee).

## 3. Design

### 3.1 Binding surface

```text
rbox init --workspace Development --root ~/srv/dev \
     --scope Personal/repo-A --pull-only --daemon
rbox scope                                  # show scope + per-prefix counts
rbox scope add <prefix> | remove <prefix>   # materialize / prune-to-trash
```

- Scope = a set of workspace-relative prefixes in the binding record
  (`.rbox/state` + the design-211 registry row). Never sent to the server.
- Bind-time validation table: prefixes normalized (no `..`, no trailing
  slash), deduplicated, non-nested, non-overlapping; empty scope refused;
  a prefix must not split a git repository (checked against the incoming
  manifest's repo layout); `--scope` requires `--pull-only`.

### 3.1b The seal (r2 finding 1 — the design's load-bearing wall)

Scope-presence in the binding record makes the binding **structurally
incapable of publishing**, enforced at three layers so no single forgotten
guard reopens it:

1. **Chokepoint:** `pushManifest` (`src/cli/sync/push.ts:277-315`) asserts
   fail-closed BEFORE receipt reconciliation, scan, git planning, upload, or
   repair: binding has a scope → refuse with the named condition
   `scoped-binding-cannot-publish`. This covers every indirect entrance:
   ignore purge, git `keep-mine`, recover's repair-publish, chain repair.
2. **Command admission:** `push` refuses before its scan; bare `sync` on a
   scoped binding means *scoped pull* (never a partial full-sync); the front
   door's Sync action derives the same; `recover` REFUSES ENTIRELY on a
   scoped binding, upfront, before touching any manifest (r3: its
   re-baseline half applies historical manifests, and refusing only at the
   late pushManifest seam would strand the tree mid-repair) — remedy copy
   points to running recovery from an unscoped binding.
3. **Daemon authority:** the child derives pull-only from the CANONICAL
   binding scope, not from `RBOX_DAEMON_PULL_ONLY` alone (r2 finding 2:
   env is transport, scope is truth); absent/corrupt desired-mode records on
   a scoped binding fail closed to pull-only (today's absent→read-write
   default is unreachable when a scope exists); the operation boundary
   revalidates scope+mode under the mutex each cycle. A pull-only daemon
   hitting `ManifestChainError` on a scoped binding HALTS with a named
   non-publishing condition instead of entering `repairChain`
   (`src/cli/daemon/daemon.ts:1900-1919` → `chain-repair.ts:51-78` calls
   `pushManifest`); doctor's remedy: repair from any unscoped binding.
4. **Witness integrity (r3 critical):** "unscoped" requires a POSITIVE
   reading of no-scope from an intact binding record. A missing/unreadable/
   nonce-mismatched binding record on a root with ANY scope evidence (the
   design-211 registry row is the redundant witness; both are written in the
   §3.3 transaction) halts the binding entirely — `binding-record-unreadable`
   refuses pull AND publish until repaired. Scope-witness loss can therefore
   never demote a scoped binding to unscoped semantics.
### 3.2 What the scope gates (pull direction only)

One **shared pre-probe scope projection** (r2 finding 4) is computed per
operation and consumed by reconcile/apply, blob fetch, git apply, status,
doctor, and deferral hygiene — filtering happens before key/candidate/
collision construction in every producer, never in rendered copy.

| plane | rule |
|---|---|
| topology classification | remote git topology is classified `IN` / `STRADDLE` / `OOS` BEFORE file reconcile, blob fetch, or apply (r2 finding 5) |
| manifest | full manifest/deltas synced + stored as today (lineage carrier; §3.5 cost note) |
| materialize/apply | only `IN` entries touch disk; `OOS` entries are bookkeeping carry; a `STRADDLE` repo's ENTIRE file subtree + git section are quarantined — prior file and git BASE retained, zero writes/fetches — while unrelated paths advance; surfaced as a named deferral ("a repository crosses your scope boundary") |
| blob fetch | only blobs referenced by `IN` entries are downloaded |
| mass-delete guard (pull) | reconcile/action planning runs scope-projected with the SCOPE's entry count as denominator, in BOTH the scan-backed and trusted-view arms (`src/cli/sync/pull.ts:297-318`) |
| git plane (apply) | `IN` repos: normal git apply. `OOS` repos: newest remote truth lives in a distinct SHADOW representation; **materialized BASE never advances** (r2 finding 3: otherwise `scope add` hits the base==remote shortcut at `sync-git/apply.ts:778-788` and skips materialization forever); removed/resolution/config/deferral/partial/attempt/index/origin lanes stay byte-for-byte untouched; `scope add` applies current remote BEFORE any BASE advance |
| status/doctor/hygiene | consume the same projection: repeated pull/status/doctor/hygiene on a scoped binding issue ZERO out-of-scope fs/git/config/journal probes; deferral hygiene can never age out an OOS repo's durable posture (`deferral-hygiene.ts:249-309` stable-gone proofs are scope-gated); copy is scope-sized and names the scope |
| ignore rules | workspace-root `.rboxignore`, root `.gitignore`, and scope-ancestor `.gitignore` layers (e.g. `Personal/.gitignore`) are metadata inputs: always materialized (tiny) and REMOTE-AUTHORITATIVE on a scoped binding — a local edit to a rule file is surfaced as a named status finding and does not alter the pull matcher (r2 finding 6: a local rule could otherwise silently suppress scoped updates forever, with no publish to reconcile it); `respectGitignore` evaluates over these same layers |
| versions / restore / export | `versions` stays full-history (read-only). `restore` of an out-of-scope path refuses BEFORE blob fetch, naming the scope; in-scope restore gets pull-only copy (no "now push it" hint — `versions-cmd.ts:119`). `export` is an explicit documented exception: full-recovery export stages OUTSIDE the binding and may fetch out-of-scope blobs (r2 finding 8) |
### 3.3 Scope edits — a journaled transaction (r2 finding 7)

`scope add`/`remove` runs as: persist INTENT in the binding record →
park the daemon acknowledgement-gated (not fire-and-forget) → bump the
**scope generation**, fencing every cached/trusted observation (trusted-view
pulls, watcher-fed authority, dircache) → materialize / prune-to-trash →
atomically commit the accepted scope + design-211 registry row → clear
intent → restart, rescan. Crash at any point resumes from intent; queued
watcher events from the old generation are discarded by the fence. Removing
the LAST prefix is refused ("use rbox untrack") — scoped-empty is not a
state. `scope add` of a prefix whose repo BASE was carried applies current
remote before BASE advance (§3.2 git row).
### 3.4 Max's loop after V1

```text
# host A (enrolled)
rbox pair                                   # or key create-ci for headless

# server
rbox connect <token>
rbox init --workspace Development --root ~/srv/dev \
     --scope Personal/repo-A --pull-only --daemon
```

Server edits flow back via `git push` to origins — which is how servers
already publish. rbox carries content TO the server; git carries work FROM it.

### 3.5 Honest cost note (r1 finding 15)

"KB-scale" was overstated for full commit transport: the blob-ref sidecar is
~40B/ref (`src/engine/refset.ts:45-48`) — ~15MB at 372k refs — and the state
JSON is O(workspace) until design 163. Neither blocks V1 (servers have disk;
sidecars are fetched, not re-uploaded, on pull-only), but the bandwidth
justification is "full manifest knowledge is affordable," not "free."

## 4. What this design refuses

- **Read-write scoped bindings** (V2 or never — §7).
- **Server-side path filtering** (E2EE; concurred by r1).
- **Sub-repo scopes** (`--scope repo-A/src` splits git history; refused;
  file-plane-only trees may scope at any prefix).
- **Root flattening / path mapping** (V2 may revisit with a codec design).
- **Quota changes** (scoped bindings change which machines hold bytes, not
  who owns them).
- **Keyed-setup redesign** — separate per the surface memo; the §6 polish
  is the only ergonomic change riding this workstream.

## 5. Acceptance

1. Rig scenario `scope-server`: host A publishes the fixture workspace; a
   scoped pull-only binding materializes exactly the scoped repo (tree +
   usable git history), stays CLEAN in status/doctor, follows ongoing file +
   git changes at normal latency.
2. **Publication matrix (the seal):** on a scoped binding, each of `push`,
   bare `sync`, `sync --allow-mass-delete`, front-door Sync, `recover`,
   `ignore --purge`, `git resolve keep-mine`, and a daemon holding a broken
   chain (`ManifestChainError`) produces ZERO git-plan/upload/commit calls
   (asserted at the pushManifest seam), each with its named refusal/halt;
   the broken-chain daemon halts and doctor names the unscoped-repair path.
3. Mode authority: missing desired record, corrupt desired record, and a
   forged `RBOX_DAEMON_PULL_ONLY=0` env each still start the scoped daemon
   pull-only (scope is truth); operation boundary re-checks per cycle.
3b. Witness integrity: deleting/corrupting the binding record while the
   registry row carries scope evidence halts the binding (no pull, no
   publish, named condition); restoring the record resumes; a genuinely
   unscoped binding is unaffected. `recover` on a scoped binding refuses
   upfront with zero manifest reads/writes.
4. Out-of-scope churn on host A: zero disk writes, zero blob fetches, zero
   status noise on the scoped binding — in BOTH scan-backed and trusted-view
   pull arms.
5. Scope-sized mass-delete guard trips against the scope denominator
   (both arms); consent applies it.
6. Scope transaction fault-injection: kill before/after intent persist,
   mid-materialize, mid-prune, before accepted-scope commit, before registry
   write, and restart with queued stale-generation watcher events — every
   case converges with no lost or phantom paths.
7. Straddle content test: host A creates a repo across the prefix boundary
   AND changes files inside it; scoped binding defers with the named reason,
   makes zero writes/fetches for the quarantined subtree, retains prior file
   + git BASE, other prefixes keep syncing; scope adjust converges
   exactly-once.
8. Git sidecar preservation: shrink then re-expand a prefix around a repo
   carrying pending/conflict/deferral/origin-lineage lanes — byte-for-byte
   preserved through the shrunk period, resumed after re-expansion; hygiene
   runs during the shrunk period age nothing out.
9. Ignore authority: root `.rboxignore`/`.gitignore` + ancestor `.gitignore`
   create/change/delete on host A propagate; a LOCAL edit on the scoped
   binding is surfaced as a finding and does not alter apply; no stale files,
   no silent suppression.
10. Restore/export: out-of-scope `restore` refuses before fetch; in-scope
    restores with pull-only copy; `export` full-recovery works and is
    documented as the exception.
11. Unscoped-binding byte-for-byte regression: with no scope present, every
    touched code path produces identical behavior to main (golden transcript
    + state diff).
12. Doctor on a scoped binding names the scope in every finding's copy.
13. Field validation ([[design-169-dev-build-first]]): dev-build scoped
    binding on flat-meadow against the founder workspace, burn-in alongside
    its full read-write binding.
## 6. Side quest (separate small PR): one-command server bind

`rbox pair --headless [--expires 1y]` prints a single paste-able line:
`rbox connect <token> --workspace Development --root <dir> --scope <prefix>
--pull-only --daemon`. Uses existing pairing/agent-key machinery; kills the
`RBOX_KEY` env-var dance for the common case. (`connect` grows the pass-through
flags; refusals identical to `init`'s.)

## 7. V2 ledger — what read-write scopes must pay (r1 evidence bank)

Kept verbatim in `REVIEW-212.md`; headline entries:

- Structural (not filtered) scope confinement for the differ
  (`src/engine/diff.ts:39-53`) + commit encoding's independent full-manifest
  diff (`src/engine/manifest-delta.ts:277-286`).
- 422 recovery for out-of-scope carried refs without source bytes:
  ciphertext relay or admission-policy change
  (`src/cli/sync-recovery.ts:298-400`, `apps/api/src/commit-delta.ts:67-78`).
- Git out-of-scope carry through the PUBLISH planner (removal
  classification, forced recapture, observed-marking:
  `src/cli/sync-git/plan.ts:306-335,894-914,1463-1473`).
- Rename-across-boundary semantics (independent del+set, no atomic move —
  `src/engine/manifest-delta.ts:277-286`).
- Workspace-ancestor ignore semantics for scoped scans
  (`src/engine/ignore.ts:355-380`).
- **The live alternative:** repo-as-workspace (cheap workspace splits on the
  211 registry + outer-workspace nesting rules) may beat all of the above at
  the V2 decision point. Founder fork, to be taken with V1 field data.

## 8. Implementation shape

- P1: binding-record scope + bind/start interlocks + `rbox scope` verbs +
  registry row.
- P2: scope-projected reconcile/apply + blob-fetch gating + scope-sized pull
  guard + git out-of-scope carry lane (apply/status/deferral-hygiene).
- P3: status/doctor copy, scope transitions, rig scenario, FM field burn-in;
  §6 side-quest PR.
- Center of mass: `src/cli/sync/pull.ts`, `sync/apply` path,
  `sync-git/apply.ts` + `status.ts` + `deferral-hygiene.ts`, binding/state
  records, CLI verbs. Zero `apps/api` changes.
