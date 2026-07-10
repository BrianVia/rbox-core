# Design 93 — Git config sync (remotes + branch tracking travel with the repo)

Status: draft v10 (2026-07-10). Rounds 1–9 in REVIEW-93.md. Round 7 verified
the persistence CAS (both landing orders, value-ABA, no-op isolation,
single rebind race, snapshot parsing, dispositions). v8 adds: the workspace
sync mutex (brings filesystem mutation inside the interprocess fence — also
retiring a PRE-EXISTING daemon-vs-CLI race for git state generally),
bidirectional source atomicity, a persisted reset nonce, the live-owner
exact-token reap exception (as the WIP lock module implements), over-bounds
carry-not-strip (kills the oscillation), and the clean-materialization
rollback disposition. Founder-chosen FULL scope; key surface = remotes +
tracking only. Founder-classified **deal-breaker**.

## 1. Problem

rbox's git-sync (§28/§43) ships each repo's state as an encrypted bundle:
refs, objects, HEAD, index, op-state. `.git/config` never travels, and the
pull side materializes `.git` cleanly from the bundle. Result: **every
rbox-materialized repo is born with a `git init`-grade config.** `git pull`
fails on every repo on every fresh host.

Field event 2026-07-10: Brian joined ws_2b6e15da on via-desktop-ubuntu and
found ~90 repos with no remotes (FM identical). A one-off heal grafted
`remote.*`/`branch.*` from the Mac (add-only, 179 repos, 2 hosts). This
design makes that permanent, automatic, and self-healing.

## 2. What syncs (strict allowlist)

Captured per repo from the COMMON `.git/config` only (`--no-includes`;
includes are machine-local):

| keys | why |
|---|---|
| `remote.<name>.url`, `remote.<name>.fetch` | where the repo pulls from |
| `branch.<name>.remote`, `branch.<name>.merge`, `branch.<name>.rebase` | upstream tracking |

**`remote.<name>.pushurl` is EXCLUDED in v1.** Also excluded: `core.*`,
`user.*`, `credential.*`, `http.*`, `url.*.insteadOf`, signing/gpg,
`hooksPath`, `submodule.*`, worktree config, includes. One allowlist table
in code, shared by capture and validation. (Steps 1–2 are implemented:
`src/engine/git/config-sync.ts` + wire validation, commits 70962d5/2cc69b5.)

## 3. Credential hygiene (capture-side, fail-closed)

A `remote.<n>.url` is skipped at capture (loud once-per-repo log) unless it
passes the §8 grammar — any userinfo in http(s) URLs rejected (URL-parsed).
SCP-form ssh and `ssh://user@host/` pass. Residual, documented: tokens in
URL path/query are not generally detectable.

## 4. Transport, canonical form, and read discipline

```ts
config?: Record<string, string[]>;   // on GitSection; §9 ownership rules
```

Canonical wire form ENFORCED at `validateGitSection` (implemented): sorted
keys, non-empty arrays, no duplicate values, C0/DEL rejected. Bounds:
≤ 64 keys; key ≤ 200 B (`<name>` ≤ 120 B); value ≤ 1 KiB; total ≤ 16 KiB.
**Over WIRE bounds ⇒ publish-disabled for that repo (rounds 7–8):** the
section CARRIES the base config verbatim (never strips, never ships an
omitted config as if authored), the edit/presence rules are suspended for
the repo, a loud surfaced status names it, and NO authorship entry exists.
Fills from head still apply. This removes the two-host oscillation.
**Capture-API requirement (round-8 F5):** the canonicalizer must return a
DISTINGUISHABLE over-bounds outcome for ANY per-key/name/value/total
overflow — silent per-entry filtering is forbidden, since a partial `ok`
config would strip keys and defeat carry-base. (The step-1 implementation
currently filters silently — it must be changed to an explicit
`{overBounds}` result before step 5 consumes it.)

**Read discipline (every config read: capture, B1, locked B2, status):**
`lstat` no-follow; regular file required; bounded file-handle read of
1 MiB + 1. **Parsing always runs on the snapshot, never the live file**
(round-6 F7): the bounded bytes are written to a same-directory temp and
parsed via `git config --file <snapshot> --no-includes --get-regexp -z`
through the RAW exec helper (implemented), then the temp is removed. Exit
codes pinned (no-match = 1; empty value = success + empty string).

**Dispositions (round-6 F8, split):**
- PERMANENT (lane DISABLED for the repo + surfaced status): config is a
  symlink or non-regular file; stable size > cap; EACCES; `link()`
  unsupported on the filesystem.
- TRANSIENT (bounded retry ×3 ⇒ defer to next cycle): bytes changed
  (B2 ≠ B1), size grew past cap mid-transaction, file vanished (ENOENT at
  B2), lock busy, stat-bracket instability.
Every open/stat/read error is classified into exactly one bucket in code.

## 5. Schema & rollout

Verified on v0.9.17: unknown GitSection fields tolerated
(manifest-validate.ts:237-273; wire decode returns validated object,
e2ee-remote.ts:205-215) — now PINNED by a regression test (implemented).
`config` ships additively — no schema bump. Old readers ignore it; old
writers strip on real recapture — healed by the marker-free PRESENCE rule.

## 6. The config lane

Config stays INVISIBLE to `GitIdentity`; the lane is orthogonal, with the
state algorithm now specified as one transactional unit.

### The state store and its problem (ground truth)

Per-repo base = `SyncState.lastSyncedManifest.gitRepos` +
local-only sidecars (`gitPendingRemote`/`gitNeedsResolution`/
`gitReposRemoved`) in `.rbox/state.json`; whole-file atomic writes from
three sites (pull-apply sync.ts:329-336, ACK 667-674, no-op bookkeeping
566-573); ZERO cross-process coordination; reset/rebind deletes the file
un-locked (config.ts:239-251 from track-cmd.ts:77-85 / init-cmd.ts:166-175).

### The transactional unit (round-6 F1–F5)

New persisted per-repo structure (versioned `RepoRecord`):

```ts
{ repoGen: number,          // monotonic per-repo generation, +1 on every
                            // accepted transition — THE CAS gate (no ABA)
  sourceSeq: number,        // global sequence of the source that produced
                            // the current base/pending (ordering provenance)
  base?: GitSection,        // the entry in lastSyncedManifest.gitRepos
  pending?: GitSection,     // gitPendingRemote value (full value, not presence)
  removedKey?: string,      // gitReposRemoved value (exact string)
  resolutionKey?: string,   // gitNeedsResolution value (exact string)
  cfgSynced?, cfgApplied?, cfgToken?, cfgShape? }
```

Storage layout may keep today's physical maps; `repoGen`/`sourceSeq`/lane
fields ride a parallel local-only map keyed by relPath. Equality is never
hashed or deep-compared: **acceptance = generation equality** (round-6 F4 —
a counter, not a value comparison, so canonicalization questions vanish).

Every state writer composes a **save packet**:

```ts
{ expectedStream: string,          // SyncState stream stamp — exact match
                                   //   or the WHOLE save is rejected (F3)
  expectedNonce: string,           // stateNonce loaded with this packet's
                                   //   snapshot, or the sentinel "legacy"
                                   //   (matches only a nonce-less state)
  sourceGlobalSeq: number,
  global?: { files, metadata },    // FILE-ONLY manifest candidate — never
                                   //   carries gitRepos (F5)
  repos: Array<{ relPath, expectedRepoGen, newRecord }> }
```

**The workspace sync mutex (rounds 7–8).** One interprocess lock
(`.rbox/state/sync.lock`, the §7 primitive) is held for the operation's
duration — spanning decision → filesystem mutation → state transition — by
every TOP-LEVEL state-mutating entry point, enumerated (round-8 F4):

- each daemon pump iteration (push, pull, and combined ticks),
- CLI `rbox push` / `rbox pull` / `rbox sync`,
- `rbox recover`,
- **`rbox ignore --purge`** — owner is the COMMAND (`ignore-cmd.ts`), not
  its inner `pushManifest`: the final deletion set is computed (or
  recomputed after user confirmation) while HOLDING the mutex; a stale
  pre-lock preview is never committed (pinned by test),
- **init/setup first-sync** (`init-cmd.ts` first `pull`/push/sync branches,
  round-10): the command owns the whole first-sync
  decision→mutation→state-save interval, in addition to its reset/rebind
  ownership,
- **reset/rebind** (`resetSyncState` callers in track/untrack/init/setup —
  round-8 F1), which also regenerates `stateNonce` under the mutex.

**Completeness rule (round-9 F1):** the implementation must audit every
direct caller of `pushManifest`/`pull` in the tree; each is either wrapped
by a named top-level mutex owner above its DECISION boundary or explicitly
exempted here with a private-target justification. A new caller without one
of the two is a review-blocking defect, pinned by a static test that
enumerates callers. Current complete disposition: daemon ticks, push/pull/
sync commands, recover, ignore --purge, init/setup first-sync, reset/rebind
= named owners; **`export-cmd.ts` staging pull = EXEMPT** (unique ephemeral
process-private staging root; touches no workspace state or working tree).

Acquisition happens ONCE at the top level; nested internal operations (the
push path's 409-recovery pull, retries) run WITHIN the held mutex by
passing the handle — never re-acquired, never released mid-operation.
Contention: CLI waits briefly then exits loudly ("another sync is in
progress (pid …)"); the DAEMON re-queues the tick with backoff instead of
consuming the wakeup (round-8 F3 — a long CLI operation can never leave the
daemon permanently behind). The daemon also revalidates its binding —
stream + `stateNonce` — at the start of every pump iteration under the
mutex; a rebind that happened while it idled is detected and the daemon
exits/rebinds loudly rather than mutating under a stale binding (round-8
F1). `rbox status` and other readers take no lock. Crash recovery: the §7
liveness rules (same-host different-boot = dead) guarantee a reboot never
wedges the mutex. Save packets are serialized by construction; the CAS
below remains as defense-in-depth (crash windows, the legacy fallback
path, and any future lock-free writer).

Under the workspace state lock (§7 primitive at `<state>.lock`, held ms):

1. Raw-load current state; `expectedStream` OR `stateNonce` mismatch ⇒
   reject whole save (nonce below).
2. For each repo transition: accepted iff `expectedRepoGen ==
   stored.repoGen`; install `newRecord` with `repoGen+1`.
3. **Source atomicity — bidirectional (round-7 F2):** if ANY repo
   transition is rejected, OR the global candidate is stale
   (`sourceGlobalSeq <` stored sequence), the ENTIRE packet is rejected —
   nothing from it lands, including repo transitions whose generations
   happened to match (the unseen-path absence trace dies here). The writer
   then, still within the same operation: reload, recompute against fresh
   records (using `sourceSeq` ordering), retry ≤3, then the operation
   reports failure. Transitions are emitted for every repo the source
   OBSERVED (including absence/equal outcomes), not only value changes.
4. Global candidate (when present and fresh) installed;
   `lastSyncedManifest` RECONSTRUCTED: candidate's files + metadata,
   `gitRepos` rebuilt solely from post-merge accepted/retained
   `RepoRecord.base` values.
5. `stateRevision` +1, atomic write, release.

**State incarnation (rounds 7–8):** the state carries a persisted random
`stateNonce` (128-bit), regenerated by `resetSyncState` (under the sync
mutex + state lock) and generated at the first locked save when absent.
Exact init contract (round-8 F6): a packet built from a nonce-less load
carries the sentinel `legacy`; `legacy` matches ONLY a still-nonce-less
state (the first locked save then installs a real nonce, so any later
delayed `legacy` packet rejects). A→B→A rebinds and same-binding resets
yield fresh nonces, so a delayed pre-reset packet always rejects.
The `link()`-unsupported legacy fallback forfeits these fences BY DESIGN:
on such filesystems the config lane is disabled entirely, no lane state
exists to protect, and git-state behavior remains exactly today's status
quo.

The no-op bookkeeping site (sync.ts:554-573) emits per-repo transitions for
exactly the repos whose sidecar/lane values it changed, with NO global
candidate — an equal-sequence stale snapshot can no longer restore another
repo's base. **Reset/rebind** (`resetSyncState` + its callers) acquires the
same state lock and bumps the stream — a delayed cross-stream writer then
fails the stream precondition (F3).

State-lock failure scope (round-6 F8): `<state>.lock` unacquirable ⇒ the
SAVE (whole operation) defers — surfaced as a workspace-level "state busy"
log/status, never per-repo. `link()` unsupported at the state path ⇒ config
lane disabled WORKSPACE-WIDE, surfaced once (git sync itself continues
exactly as today — the legacy unlocked whole-file save path remains for
non-lane state until the lane is enabled, preserving today's behavior as
the fallback).

### Sync-point rule (rounds 3–6; both pinned traces + unrelated-ACK PASS)

Apply-decision hashes (`C_pre`, `C_post`, post token) computed under the §7
transaction lock; `C_base_pre` = base section config the apply started from.

- `C_pre == cfgSynced` **or** `C_pre == C_base_pre` ⇒ `cfgSynced := C_post`.
- Otherwise unchanged, unless `C_post == C_in` exactly ⇒ `:= C_post`.
- `cfgApplied`/`cfgToken` update on every COMPLETED apply run.

**ACK authorship:** `GitPushPlan.authoredCfgHashByRepo` — an entry ONLY when
the plan authors local config (presence/edit publication, or a real owned
recapture WHOSE CONFIG WAS ACTUALLY EMBEDDED on the wire — an over-bounds
omission gets no entry, round-6 F9). Carried/deferred/pending/non-owned/
dropped: no entry. ACK stamps `cfgSynced` from this map alone; 409 persists
nothing.

### Publish predicate (push side, owned repos only)

1. **Presence rule:** `C_base` ABSENT ∧ `C_local` non-empty ⇒ publish.
2. **Edit rule:** `C_base` present ∧ `C_local ≠ C_base` ∧ `C_local ≠
   cfgSynced` (UNSET ≠ anything) ⇒ publish.
3. Otherwise carry base config unchanged (no authorship entry).

Publishing = the CARRIED section with only `config` replaced; real
recaptures embed fresh `C_local`. Convergence: ≤ 1 flip per host, then zero
sequences.

### Cached local config for fast paths

`cachedLocalCfg = {hash, nonEmpty}` computed in the fingerprint slow path's
bracketed read, bound to the exact after-fingerprint, FILE-level cache
version bump (cache discarded once, self-heals; legacy absence forces one
slow pass), threaded through BOTH whole-entry set sites (sync-git.ts:
1313-1319, 1350-1356). Fast carry evaluates presence via `base absent ∧
cachedLocalCfg.nonEmpty`, edit rule via the hash; local edits invalidate the
fast path by construction (fingerprint covers the config file). Cache writes
stay best-effort — correctness never depends on them.

**Status mirror:** same predicate from cache when trusted; otherwise its own
bracketed bounded snapshot read. Unstabilizable/failed ⇒ explicit
**indeterminate** ("config: checking"), counted conservatively as divergent
— never zero. (Status model gains this state; status-cmd.ts is in scope —
round-6 F6.)

### Path coverage (complete; verified rows unchanged from v6)

slow carry = full predicate (bracketed read) · trusted fast carry =
cachedLocalCfg predicate · busy/transient-preflight defer = carry base
unchanged · structural drop & forced-422 = section drops, PRESENCE rule is
the recovery · pending/needs-resolution = lane does not run, old base kept ·
empty repo = carries existing base VERBATIM · undiscoverable/ignored/
linked-pointer = non-owned, carry verbatim · capture failure = carry base
incl. config · real capture = embeds fresh `C_local` (+ authorship entry iff
embedded).

Pull side: apply predicate `hash(section.config) ≠ cfgApplied OR config stat
token ≠ cfgToken` runs BEFORE both unchanged shortcuts (1622-1628,
1631-1641); base may not advance and pending may not clear until a due
config transaction completes. Config-only failure ⇒ pending + old base +
markers untouched. Conflict checkpoint: config waits; post-resolution apply
runs the same predicate.

**Combined git+config ordering (rounds 6–7):** within `applyGitState`'s
boundary, the config transaction runs LAST, after all git mutations succeed;
its atomic rename is the commit point. Failure before the rename ⇒ repo
apply fails with no config installed. The ROLLBACK disposition follows the
row's existing git-failure semantics (round-7 F3): on ordinary rows the
`LocalSnapshot` restore applies; on CLEAN-MATERIALIZATION rows the
destructive hook (`opts.beforeMutate`, apply.ts:264-269) runs before the
snapshot (apply.ts:293-294), so "restore the user's pre-apply state" is not
available — a config failure there lands the repo in PENDING exactly as a
git failure at the same point does today (the wipe is the row's intended
baseline, retried next cycle). Post-rename cleanup errors (lock unlink, dir
fsync) are non-fatal-logged (the lock becomes stale-ours, §7 exception);
every other fallible `applyGitState` cleanup after the config rename
(apply.ts:348-355) must likewise be completed before the commit point or
made non-fatal.

## 7. The lockfile primitive and the config transaction

### Support boundary (round-5/6 verified)

Single-host local filesystem. Marker = `rbox-93 <host-id> <boot-id> <pid>
<start-time> <token>` (macOS `kern.uuid`/`kern.bootsessionuuid`/
`sysctl kern.proc.pid`; Linux `/etc/machine-id`//proc boot_id/
`/proc/<pid>/stat` field 22; 128-bit token). Liveness classification
(round-8 F2 — the cross-boot wedge fix):

- **DEAD (reapable):** same host-id ∧ different boot-id — a process cannot
  survive a reboot; a power loss while ANY lock (incl. the long-held sync
  mutex) was held is recovered on the next run. Also same host+boot ∧
  (ESRCH ∨ start-time mismatch).
- **LIVE:** same host+boot ∧ probe confirms (or probe fails — uncertain ⇒
  treat as live, defer).
- **FOREIGN (never reaped, defer + surface):** different host-id,
  unparseable/non-rbox content, or symlink.

### The primitive (reusable: config.lock, state lock)

- Atomic create-with-content: unique SAME-DIR temp (`O_EXCL` 0600, fully
  written, fsynced, closed) then `link(tmp, lockPath)`; EEXIST = held;
  unlink tmp. Never empty/partial across power loss. `link()` unsupported ⇒
  fail closed (§4/§6 dispositions).
- No-follow discipline on every marker read/recheck/release (`lstat`/
  `O_NOFOLLOW`); a symlink lock is FOREIGN; busy checks use lstat.
- Owner-checked release; owner re-check immediately before the critical
  effect (candidate rename; state save).

### Recovery (reaper fence — verified round 6)

Only rbox markers with a provably dead same-host incarnation are reaped:
acquire `<lockPath>.reap`; re-read no-follow; still the same dead marker ⇒
unlink; release. Occupancy argument scoped to git + cooperative no-replace
creators (forced rename-over is out of scope, as for git itself). Dead
`.reap` unlinked directly (single level; racers ENOENT then race `O_EXCL`
fairly).

**Live-owner exact-token exception (round-7 F4):** when a process's own
post-rename lock RELEASE fails, it records the exact marker token
in-memory (`staleOwnedMarkers`); on a later cycle THE SAME PROCESS may
fence-reap a lock bearing exactly that recorded token despite its own
incarnation being live — it is provably this process's abandoned lock, not
a concurrent holder's. This is the ONLY exception to dead-incarnation-only
reaping; it applies identically to the state lock; the token never leaves
process memory, so no other process can invoke it. (The WIP lock module
implements exactly this — lockfile.ts staleOwnedMarkers.)

### The transaction (optimistic build, short lock)

0. **Gate 0:** no-follow regular-file check + bounded read (§4 read
   discipline + dispositions).
1. `B1` bounded read; compute fill set (key absent ⇒ add all values in
   order; present ⇒ untouched; never delete).
2. Build candidate UNLOCKED: unique
   `config.<host>-<pid>-<start>-<token>.rbox93` (`O_EXCL` 0600); write
   `B1`; `git config --file <candidate> --add` per value; re-open FINAL
   candidate path; fsync.
3. Acquire `config.lock`. Re-run gate 0 under the lock; bounded-read `B2`.
4. `B2 == B1` (literal bytes) ⇒ owner re-check ⇒ atomic rename
   candidate→config ⇒ fsync parent ⇒ owner-checked unlink ⇒ fsync parent.
5. Transient failure ⇒ release, delete candidate (+ `.lock`), retry ≤3 ⇒
   defer. Permanent ⇒ lane disabled + surfaced (§4 buckets).

`C_post`/post-token from the installed bytes while locked. Orphan sweep:
dead-same-host-incarnation `*.rbox93` (+ `.lock`); unparseable names only
with age > 24 h. FRESH materialization: plain `git config --local --add`
(private dir), failure ⇒ fresh-target cleanup. Capture stability:
stat/read/stat bracket over the SNAPSHOT parse (§4), `config.lock` in the
capture busy predicate via lstat; persistent instability ⇒ carry base
config, never `{}`.

## 8. Value grammar (implemented; review-resolved)

`refComponentOk` + per-key validators + credential rejection in
`src/engine/git/config-sync.ts` with boundary-table tests. Residual
(review-accepted): fresh-materialization / no-url-remote URL choice by a
workspace writer, with push falling back to url — file-content trust
rationale; existing urls never overwritten; refspecs namespace-confined;
pushurl cannot be introduced; no server change.

## 9. Ownership = RECEIVER shape (review-resolved)

`ownedForConfig(repo) := dir repo (gitDir == commonDir) ∧ commonDir inside
workspace containment`, re-derived locally for capture, patch, apply; the
pinned cross-shape path skips config (once-per-repo log); scoped wire
sections with config rejected at validation. Lane state bound to
`cfgShape` = shape + commonDir identity {realpath, dev:string, ino:string,
birthtime-or-0}; invalidation persisted (via a repo transition) before any
ownership early-return; btime-unavailable inode reuse = documented residual.

## 10. Non-goals

Hooks, includes, worktree config, `pushurl`, other keys; merging divergent
same-key values; symlinked/non-regular config (lane-disabled, surfaced);
shared-filesystem workspaces (cross-host owners are foreign); server-side
anything.

## 11. Tests & gates

Unit — grammar/wire (implemented, 136 green incl. tolerance pin);
dispositions table (permanent vs transient per §4, incl. growth past cap
between B1 and B2 ⇒ transient-defer; symlink at B2 ⇒ permanent-disable);
sync-point truth table (round-3 trace; round-4 trace; round-5 unrelated-ACK
extension; over-bounds ⇒ publish-disabled + carry-base + no authorship,
incl. the round-7 two-host oscillation trace converging); **state
transactional unit: BOTH pending-regression landing orders;
pending-after-newer-success both orders; ABA (repoGen); the round-7
UNSEEN-PATH ABSENCE trace (stale global ⇒ whole packet rejected,
bidirectional); equal-sequence no-op isolation; stream-mismatch and
STATE-NONCE mismatch (A→B→A and same-binding reset) reject whole save;
source-atomicity both directions; the round-7 TWO-PROCESS APPLY trace
(daemon + CLI pulls serialized by the sync mutex — deterministic
interleaving test with the mutex removed proving the trace, then with it
proving exclusion); sync-mutex CLI contender exits loudly while the DAEMON
re-queues its tick (wakeup never consumed); rebind under the mutex + daemon
per-iteration nonce revalidation (rebind while daemon idle ⇒ detected, no
stale-binding mutation); cross-boot lock recovery (same-host different-boot
marker reaped — power-loss-while-held sim); nested 409-recovery pull runs
within the held mutex (no re-acquire); legacy nonce sentinel matches only
nonce-less state; canonicalizer over-bounds outcome (silent filtering
forbidden — any overflow yields {overBounds}, never partial ok); live-owner
exact-token reap (own failed release only; other-process token refused)**;
marker invalidation
persisted on shape mismatch; legacy cache entry forces slow pass; three-host
old-writer strip self-heal; edit-back-to-historical republishes.

Lock/transaction — never-empty locks (power-loss sim); two-reaper fence;
occupied-path interleaving; foreign classes (cross-host, symlink lock,
git-authored, malformed, unknown-liveness) never removed; pid-reuse;
symlinked config at gate 0 AND locked B2; B2≠B1 retry⇒defer; snapshot-file
parsing (git never opens the live file during capture — assert via strace/
dtruss-style harness or injected wrapper); dead-incarnation candidate sweep
spares live and cross-host; final-path re-open fsync; post-rename unlink
failure ⇒ success + stale-ours reap next cycle; user edit after release
detected via `cfgToken`; owner re-check aborts on stolen lock.

E2E (two-root real sync loop): fresh materialization ⇒ working `git pull`
against a local bare remote; config-only edit propagates with no git state
change; manual delete re-heals; present-different two-daemon convergence
≤ 1 flip then two idle cycles ZERO sequences; old-writer strip → presence
republish; structural-drop → later presence republish; config-only failure
⇒ pending held through BOTH unchanged shortcuts; combined git+config
failure rolls back git with config uninstalled; pointer/cross-shape/nested
rows; status indeterminate on unstabilizable read; concurrent daemon +
CLI-push state saves (source atomicity under real processes).

Rig scenario + field gates: unchanged (GATES.md Lanes 1/2/2b — rig
`git-config-sync` scenario; post-merge RC scratch-join on via-desktop-ubuntu
incl. the real-GitHub probe repo `BrianVia/d93-config-probe`; URL-edit
propagation Mac→FM; two idle cycles zero sequences).

## 12. Implementation file scope (round-6 F6)

Steps 3–8 may touch: `src/engine/git/*` (new lockfile/transaction/config
modules, shared.ts), `src/engine/types.ts`, `src/engine/manifest-validate.ts`,
`src/cli/sync-git.ts`, `src/cli/sync.ts`, **`src/cli/config.ts`** (SyncState
fields, locked save path, resetSyncState + stateNonce), **`src/cli/
status-cmd.ts`** (indeterminate state), **`src/cli/track-cmd.ts` /
`src/cli/init-cmd.ts`** (reset callers take the state lock),
**`src/cli/daemon.ts` + `src/cli/sync-cmd.ts` + `src/cli/ignore-cmd.ts` +
`src/cli/init-cmd.ts` first-sync + entry glue** (sync-mutex acquisition;
`src/cli/export-cmd.ts` only for the exemption comment + static-test
mapping), `src/cli/e2ee-remote.ts` (wire glue only),
`scripts/rig/scenarios/*`, tests. NO server changes.
