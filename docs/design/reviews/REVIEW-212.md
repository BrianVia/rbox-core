# REVIEW-212 ledger

## Round 1 (2026-07-27, codex gpt-5.6-sol high) — verdict CHANGES-REQUIRED, folded by re-scoping to pull-only V1

1. **CRITICAL — delete safety is not “impossible by construction” yet.** `diffManifests` has no scope boundary: it indexes every entry and deletes every base path absent from the candidate (`src/engine/diff.ts:39-53`). Push scans only the local root (`src/cli/sync/push.ts:121-124`); its existing projection carries ignored base entries, not out-of-scope entries (`src/cli/local-file-projection.ts:19-27`), then diffs the complete applied base against that candidate (`src/cli/sync/publish-candidate.ts:230-249`). Filtering the resulting deletes would violate the stated invariant. Merging OOS entries verbatim before the diff is safe, but means they do enter the differ unchanged. The design needs one mandatory constructor that overlays the workspace-mapped scoped scan onto the full base, plus separately scope-projected manifests for admission/mass-delete decisions. Commit encoding independently diffs the full manifests and emits every absent path as `del`, so the full candidate must already be safe (`src/engine/manifest-delta.ts:277-286`, `:338-347`; `src/cli/e2ee-remote.ts:844-852`).

2. **CRITICAL — single-prefix root mapping is incompatible with current path semantics.** `FileEntry.path` is defined relative to the sync root (`src/engine/types.ts:10-12`); scan emits paths relative to the supplied local root (`src/engine/manifest.ts:99-134`, `:566-568`), while apply writes workspace paths directly under that root (`src/engine/apply.ts:258-268`). Thus workspace entry `Personal/repo-A/x` would land at `~/srv/repo-A/Personal/repo-A/x`, while a local scan reports it as `x`. Git has the same mismatch through `repoDirOf(root, rel)` (`src/cli/sync-git/shared.ts:95`). The design needs an explicit bidirectional local/workspace path codec threaded through scan/watch, reconcile/apply, trash/conflicts, caches/dircache, receipts/oracles, encryption, and Git—not just apply/push. Raw workspace action paths currently also drive cache invalidation and receipt verification (`src/cli/sync/pull.ts:371-379`; `src/engine/apply-receipt.ts:707-747`).

3. **HIGH — changing scope cardinality is an unmentioned full-tree relocation.** One prefix flattens `Personal/repo-A/x` to local `x`; adding a second prefix changes the required location to `Personal/repo-A/x`. Removing it reverses the move. Since file and Git identity are keyed directly by relative path (`src/engine/manifest.ts:566-568`; `src/cli/sync-git/shared.ts:95`), this requires a crash-safe remap transaction, watcher suppression, cache/oracle migration, and repository relocation. “Scope add materializes; remove prunes” is insufficient. Prefer a stable mapping or specify/test the 1↔N transition.

4. **CRITICAL — enforce admission can require possession of an out-of-scope carried blob.** Healthy unmarked carried refs are skipped, but prune-marked carried refs are explicitly collected (`apps/api/src/commit-delta.ts:67-78`) and included in admission (`apps/api/src/workspace-sync.ts:341-354`, `:638-645`). Validation excludes prune candidates from its satisfied set and demands a fresh upload receipt (`apps/api/src/commit-accounting.ts:111-149`). Existing coverage confirms a marked carried ref without a receipt returns 422 (`apps/api/test/commit-delta-shadow.test.ts:123-131`). Inline commits and all delta fallbacks additionally run full-ref admission (`apps/api/src/workspace-sync.ts:610-659`); active GC intent forces such a fallback (`:341-356`). Therefore §2.2 is only true on the eligible, healthy sidecar-delta path.

5. **CRITICAL — current 422 recovery cannot restore an out-of-scope carried file.** Push accumulates the missing address and retries the same candidate (`src/cli/sync/push.ts:406-409`, `:860-866`). Recovery maps it back to a manifest entry and re-encrypts `path.join(root, f.path)` (`src/cli/sync-recovery.ts:298-318`, `:356-400`; `src/cli/publish-pipeline/pipeline.ts:226-229`, `:263-302`, `:455-460`). Those source bytes intentionally do not exist on a scoped binding. If the address is left unmapped, the pipeline checks but cannot upload it, as explicitly tested (`src/cli/publish-pipeline/pipeline.test.ts:247-265`). Full-audit sweeps all manifest addresses and has the same problem (`src/cli/sync-recovery.ts:304-308`). §5.2’s “no new class” is false; this needs ciphertext relay/recovery or a different admission policy.

6. **CRITICAL — Git repo skipping is not trivial and currently publishes removals.** Push discovers local repos but visits `discovered ∪ base ∪ pending` (`src/cli/sync-git/plan.ts:417-433`). A base repo absent from local discovery/disk becomes `removed`/`repoAbsent` (`:894-914`), and the outbound/base mismatch becomes a publication (`:306-335`). Pull likewise visits every remote/base/pending repo and maps each logical key to disk (`src/cli/sync-git/apply.ts:323-359`, `:496-506`). A first-class OOS bookkeeping/carry lane must run before journal recovery, fingerprinting, config, hygiene, removal classification, and pull apply.

7. **CRITICAL — missing out-of-scope Git artifacts make the previous problem destructive.** A 422 forces recapture of every Git section referencing the missing artifact (`src/cli/sync/push.ts:860-866`; `src/cli/sync-git/plan.ts:1463-1473`). A scoped client cannot recapture that repo. Forced repos cannot take the normal policy carry (`src/cli/sync-git/plan.ts:1029-1030`), and failed forced recovery may drop the base section (`:624-646`). The required rule is abort/defer the entire scoped publication without changing that section, or recover through another materialized binding/ciphertext source.

8. **CRITICAL — one repo-path string cannot serve both workspace identity and local discovery.** A repo at the blessed scoped root is discovered as `"."`, because discovery paths are local-root-relative (`src/engine/git-discover.ts:8-11`, `:46-54`). Planner state is workspace-keyed, but fingerprints and probes use `root/rel` (`src/cli/sync-git/plan.ts:422-433`, `:657-667`). Translating `"."` to `Personal/repo-A` makes physical probing target the wrong directory; leaving it `"."` disconnects it from the base. The same discovery array feeds `onGitReposDiscovered` (`src/cli/sync-git/plan.ts:421`), while the ref watcher treats those values as physical local paths (`src/cli/daemon/git-ref-watch.ts:556-565`). Deferral hygiene compares them with logical record keys and can eventually classify the real repo as stably gone (`src/cli/sync-git/deferral-hygiene.ts:249-284`). Git needs distinct logical and physical paths.

9. **MEDIUM — rename-across-boundary language implies semantics the file plane does not have.** A rename is encoded as independent `del old` plus `set new` (`src/engine/manifest-delta.ts:277-286`; asserted in `src/cli/sync/sync.test.ts:150-185`). Reconcile decides each path independently (`src/engine/reconcile.ts:41-75`). Therefore OUT→IN is an ordinary add and may conflict with an existing destination; IN→OUT is an ordinary delete only when the source is locally clean. A modified source is retained and may be republished. There is no atomic move, pairing, or blob-reuse guarantee. §5.1 needs clean/divergent source and destination cases.

10. **HIGH — scope-sized mass-delete safety is not wired into either guard.** Pull reconciles the complete base/local/remote manifests, counts deletes before matcher filtering, and uses the full workspace base as denominator (`src/cli/sync/pull.ts:297-318`). Push similarly uses the full base count (`src/cli/sync/publish-candidate.ts:345-355`). The design must require scope-projected reconcile/action planning and scope-sized denominators before any apply/upload, including trusted-view fallback.

11. **HIGH — the failure-mode menu is missing scope-transition atomicity.** The daemon consumes pending watcher events immediately before every push (`src/cli/daemon/daemon.ts:1662-1669`). Narrowing after disk prune can publish watcher deletes; widening before complete materialization can publish local absence. Add both orderings, crash/restart windows, queued-event reclassification, and a mutex/sealed-authority contract. This also covers the 1↔N remap from finding 3.

12. **HIGH — set-time repo-straddle validation is not durable.** Another client can later create a Git repo at an ancestor of an existing scope, instantly splitting it. Incoming Git topology is dynamic and currently processed across all remote keys (`src/cli/sync-git/apply.ts:323-359`). Add remote repo creation/move across the boundary and define a durable halt before disk or state mutation.

13. **HIGH — scoped Git bookkeeping/status cases are absent.** Pending Git sections enter mandatory pre-probe/supersession logic (`src/cli/sync-git/plan.ts:851-890`); every base/pending key is marked observed (`:513-518`), potentially clearing deferrals. Scope shrink/re-expand must preserve pending, conflict, deferral, removal, packed-ref, and origin-lineage lanes without probing them. Status also unions discovery/base/pending and counts an absent base repo as a pending removal (`src/cli/sync-git/status.ts:89-124`, `:184-201`), so a steady scoped binding currently looks dirty.

14. **HIGH — flattened roots lose workspace-ancestor ignore semantics.** The matcher reads root `.rboxignore` and root/nested `.gitignore` files from the supplied local root (`src/engine/ignore.ts:355-380`). For a scope rooted at `Personal/repo-A`, workspace-root `.rboxignore`, workspace-root `.gitignore`, and `Personal/.gitignore` are absent, while §3.2 downloads only in-scope blobs. The design must either fetch and interpret these rule files as metadata exceptions through the mapper, or explicitly establish a new ignore boundary. Otherwise scoped and full bindings can publish different file sets.

15. **MEDIUM — “KB-scale per change” is false for the complete commit transport.** Manifest content can be delta-encoded, but every commit still constructs the full unique blob-ref set (`src/cli/e2ee-remote.ts:766-789`) and uploads a new full sidecar whenever that set changes (`:787-794`). The sidecar costs 40 bytes per ref (`src/engine/refset.ts:45-48`): 372k refs are roughly 14.9 MB, not KB-scale. This does not prevent selective materialization, but §2.1 cannot carry the bandwidth justification as written.

The E2EE/path-opacity claim itself holds: path-aware server filtering is neither available nor necessary. The necessary recovery and mapping work can remain client-side, but it is materially larger than the proposed audit-only seams.

Validation executed: 58 targeted CLI tests passed, 41 API admission tests passed, and the focused rename representation test passed. Wrangler emitted only a non-fatal read-only log-file warning.

CHANGES-REQUIRED

## Round 2 (2026-07-27, codex gpt-5.6-sol high) — verdict CHANGES-REQUIRED

The re-scope is the right layer: mirrored paths genuinely remove the path-codec
campaign, and a *sealed* pull-only binding would remove the publish-side
campaign. The seal and several pull-side state semantics are not yet in the
design, however.

### Round-1 disposition audit

- Findings 2, 3, and 8 are genuinely mooted by mirrored workspace paths:
  scan/apply/Git identity remain in the same relative-path namespace. Finding 9
  is also mooted as a scoped-publish promise: V1 no longer promises atomic
  cross-boundary renames or republishes a retained source. Finding 15 is
  correctly repaired by §3.5's honest cost note.
- Findings 1, 4, 5, 6-push, 7, 10-push, 11-push, and the publish half of 13
  would be mooted by pull-only, but are **not mooted yet** because finding 1
  below shows foreground, indirect, and daemon-recovery publication entrances.
- Finding 10-pull is carried textually by scope-projected reconcile plus a
  scope-sized denominator (`docs/design/212-selective-repo-sync.md:81`), but
  acceptance does not cover the separate trusted-view refusal/rescan arm.
- Findings 6-pull and 13 are carried only as a headline. Findings 3 and 4 below
  show that the proposed Git carry lane has no durable BASE/pending semantics
  and that status/doctor/hygiene still need a pre-probe scope projection.
- Finding 12 is carried only as a late Git-section defer. Finding 5 shows why
  topology must be classified before file reconcile/fetch/apply and why the
  affected file BASE cannot advance.
- Finding 14 is **not carried**. Dropping flattening creates the ancestor
  directories, not the root/ancestor `.gitignore` files that the matcher reads.
  §7 incorrectly banks this V1 pull/status requirement as V2.
- The pull-only part of finding 11 remains live. The workspace mutex removes
  concurrent sync mutation, but it does not by itself define watcher parking,
  scope-generation invalidation, or the crash transaction (finding 7).

### Findings

1. **CRITICAL — the binding is not structurally pull-only: manual, indirect, and daemon-repair publication paths remain reachable.** The design names only bind-time refusal and `start --read-write`, with the mode record as its enforcement point (`docs/design/212-selective-repo-sync.md:64-72`). Today `rbox push` unconditionally calls `push` (`src/cli/main-dispatch.ts:312-326`); bare `rbox sync` derives pull-only from that invocation's flag, not the binding (`src/cli/main-dispatch.ts:364-370`), and `sync` always pulls then pushes (`src/cli/sync/sync.ts:8-19`). The interactive front door likewise calls `runSyncCommand(root)` without pull-only (`src/cli/front-door.ts:121-133`), whose default branch runs full sync (`src/cli/sync-cmd.ts:74-95`). `recover` promises and performs a push and may repair-publish (`src/cli/recover-cmd.ts:41-46,64-81,90-121`); ignore purge and Git `keep-mine` call `pushManifest` directly (`src/cli/ignore-cmd.ts:72-108`; `src/cli/git/resolve-command.ts:802-817`). Most importantly, even an ordinary pull-only daemon catches `ManifestChainError` and unconditionally enters `repairChain` (`src/cli/daemon/daemon.ts:1900-1919`), which scans and calls `pushManifest` (`src/cli/chain-repair.ts:51-78`). Normal daemon scheduling really does suppress pushes (`src/cli/daemon/daemon.ts:729-730,1073-1077,1265-1272`), but that does not cover this pull-side recovery entrance. Require binding-derived UX admission for every command, plus a fail-closed assertion at the shared `pushManifest` boundary *before* resolution-receipt reconciliation, scan, Git planning, upload, or repair (`src/cli/sync/push.ts:277-315`); `push` should also refuse before its scan. Bare `sync` must either mean scoped pull or refuse before doing a partial operation; repair-publishing pull/recover must halt with a named non-publishing condition. Without this, a partial tree reaches the exact full-manifest differ, missing-blob recovery, and Git-removal paths from R1 findings 1/4/5/6/7/10/11/13. That is remote data-loss exposure, hence CRITICAL.

2. **HIGH — daemon mode authority is not anchored to the scoped binding and fails open after desired-record loss/corruption.** The proposed design relies on the existing mode witness (`docs/design/212-selective-repo-sync.md:69-72`), but an invalid desired record parses as absent (`src/cli/autostart-cmd.ts:150-170`) and absent/legacy state defaults to read-write (`src/cli/autostart-cmd.ts:206-241`). Startup transports that result through `RBOX_DAEMON_PULL_ONLY` (`src/cli/autostart-cmd.ts:372-388`; `src/cli/daemon/process-control.ts:381-389`), and the hidden child treats the environment bit as truth (`src/cli/daemon/daemon.ts:3296-3317`). Its operation-boundary revalidation checks stream/state nonce, not scope or mode (`src/cli/daemon/daemon.ts:1473-1490`). Bare start, autostart, upgrade, and direct hidden-daemon startup must derive pull-only from the canonical binding scope or fail closed; the child must revalidate that scope/mode under the mutex on every operation. This is HIGH rather than CRITICAL only if finding 1's independent core publish barrier also lands.

3. **HIGH — “out-of-scope bookkeeping-only carry” has no durable Git meaning, and the obvious implementation can make `scope add` permanently skip materialization.** Git truth is deliberately removed from the global state manifest (`fileOnlyManifest`, `src/cli/sync-state.ts:123-125`); pull saves file-global truth and per-repo outcomes separately (`src/cli/sync/pull.ts:414-443`). If the OOS lane returns the newest remote section in `gitOutcome.gitRepos`, state composition treats it as candidate BASE (`src/cli/sync-state.ts:221-277`); default migration authority allows branch additions/updates to become terminal BASE (`src/cli/sync-git/base-composer.ts:349-356,540-560`). On later expansion, an absent local repo whose BASE already equals remote takes the unchanged shortcut without checking/materializing disk (`src/cli/sync-git/apply.ts:778-788`). Specify the invariant explicitly: an OOS repo never advances *materialized BASE*; its exact prior BASE, removed/resolution/config/deferral/partial/attempt/index/origin lanes remain untouched; newest remote truth lives in a distinct shadow/pending representation (including remote absence); and `scope add` must apply current remote before BASE advance. Classify each Git key before collision analysis, metrics, pools, or per-repo work using segment-aware `IN` / `STRADDLE` / `OOS` relations. Today receiver-equivalent collision analysis occurs over the full union (`src/cli/sync-git/apply.ts:358-367`), then per-repo processing immediately constructs the disk path, reads `.git`/config, and enters journal recovery (`src/cli/sync-git/apply.ts:496-578`). An OOS alias can otherwise defer an in-scope repo. This is HIGH because a core advertised operation can report CLEAN while never materializing the requested repo, though pull-only bounds the damage to the receiver.

4. **HIGH — apply, status, doctor, and deferral hygiene need one shared pre-probe scope projection; copy-level filtering cannot preserve R1 finding 13's sidecars.** Status emits every record's deferrals before filtering (`src/cli/sync-git/status.ts:74-88`), unions BASE/pending into probe keys, probes conflict refs, lstat's absent BASE repos as removals, and may read config (`src/cli/sync-git/status.ts:137-201`). Populate status independently sends every BASE/pending/record key to conflict probing (`src/cli/status-projection.ts:305-324`), and doctor reads every durable deferral (`src/cli/doctor-evidence.ts:109-124`). Hygiene selects deferrals from all records, resolves every repo path, and can clear an absent repo after its stable-gone proof (`src/cli/sync-git/deferral-hygiene.ts:211-220,249-309,380-427`). Scope filtering must happen before candidate/key/collision construction in every producer, not after probes or only in rendered copy. Repeated pull/status/doctor/hygiene while shrunk must issue zero OOS fs/Git/config/journal probes and preserve BASE, pending, removed, resolution, config, all deferral lanes, partial, attempt, index projection, origin lineage, and checkout journals byte-for-byte; re-expansion must resume them. This is HIGH because current hygiene can erase durable conflict/recovery posture, even though pull-only prevents upstream publication.

5. **HIGH — straddle detection must quarantine the file subtree before reconcile and retain its prior file BASE, not merely defer a Git section.** Section-level deferral is specified at `docs/design/212-selective-repo-sync.md:96-99`, but current pull reconciles and applies files first (`src/cli/sync/pull.ts:297-350`), enters Git apply afterward (`src/cli/sync/pull.ts:394-409`), then saves the complete remote file-global manifest (`src/cli/sync/pull.ts:414-443`). Discovering a new ancestor repo in Git apply is too late: its working files may already have changed while its Git state did not. Filtering actions alone is also insufficient; once remote becomes BASE, `remote == base` makes the retained local file “local ahead” and produces no later action (`src/engine/reconcile.ts:58-66`). Remote topology must be classified before file reconcile, blob fetch, or apply; a `STRADDLE` repo's entire file subtree and Git section must retain prior BASE/pending truth while unrelated paths advance. Acceptance 5 must change files inside the new straddling repo, assert zero affected writes/fetches/BASE advance while another scope continues, then adjust scope and prove exactly-once convergence. The current named-reason-only test would pass a permanently split/poisoned checkout.

6. **HIGH — R1 finding 14 remains in V1, and the always-in-scope root `.rboxignore` introduces a second rule-authority trap.** Mirrored layout does not materialize root `.gitignore` or scope-ancestor files such as `Personal/.gitignore`; the matcher reads root `.gitignore`/`.rboxignore` and physical nested `.gitignore` layers from disk (`src/engine/ignore.ts:355-380,489-536`). §3.2 exempts only root `.rboxignore` (`docs/design/212-selective-repo-sync.md:78-80`) while §7 banks ancestor semantics for V2 (`docs/design/212-selective-repo-sync.md:178-181`). Require root and scope-ancestor `.gitignore` as metadata inputs/exceptions, including `respectGitignore` behavior. Separately, a local edit to the scoped binding's root `.rboxignore` can control the two-phase pull matcher: rule actions land, the matcher rebuilds from local disk, and remaining actions are filtered (`src/cli/sync/pull.ts:291-349`) even though the complete remote file BASE is then saved (`src/cli/sync/pull.ts:414-443`). On a pull-only binding that local rule can silently suppress later scoped updates forever—there is no publish to reconcile the local rule—and status uses the same disk matcher before scan/diff (`src/cli/status-projection.ts:328-353`). Define remote authority/local-edit behavior for this metadata file so a local rule cannot poison apply while status claims CLEAN. Acceptance needs root `.rboxignore` create/change/delete and local-divergence cases plus root/ancestor `.gitignore` cases, with no stale files or status noise. This is HIGH because it silently violates the core “follows ongoing changes” promise.

7. **HIGH — “workspace mutex + daemon parked + intent” is not yet a crash-safe scope transaction.** The design does not define what “parked” acknowledges, the intent/accepted-scope ordering, scope generation, cache/trusted-view invalidation, or the two binding-record write order (`docs/design/212-selective-repo-sync.md:64-65,86-95`). Watcher callbacks can enqueue while operations are mutex-serialized, and a later operation applies those events into the in-memory authority (`src/cli/daemon/daemon.ts:1776-1803`); trusted pull drains and consumes that view (`src/cli/daemon/daemon.ts:1850-1868`). On boot, local authority is seeded from stored BASE, explicitly not disk truth (`src/cli/daemon/daemon.ts:1149-1156`). Specify a journaled transaction: persist intent before mutation; stop or acknowledgement-gate daemon/watcher; fence every cached/trusted observation by scope generation; materialize/prune; atomically commit accepted scope (including registry reconciliation); clear intent; restart and rescan. Define last-prefix removal as either refused or a distinct scoped-empty state—never encode it as absent/unscoped. Acceptance 4's one unspecified “mid-transition kill” is insufficient; fault-inject before/after intent, partial materialize/prune, accepted-scope commit, registry update, and restart with queued watcher events. This is HIGH because stale authority can rematerialize a removed prefix, omit an added one, or misreport convergence.

8. **HIGH — historical restore is an unscoped materialization escape, while versions/export semantics are unstated.** `restore` accepts any safe workspace-relative path, finds it in the full historical manifest, fetches its blob, and writes directly under the binding root without a scope check (`src/cli/versions-cmd.ts:82-115`); it then tells the user to run the forbidden push/sync path (`src/cli/versions-cmd.ts:119`). Refuse an OOS restore before blob fetch (or refuse restore entirely on scoped V1), and give in-scope restore pull-only copy. `versions` is read-only and can explicitly remain full-history (`src/cli/versions-cmd.ts:35-79`). `export` currently enumerates account workspaces and creates a separate synthetic unscoped staging binding for a full pull (`src/cli/export-cmd.ts:204-222,299-322,360-384`); full recovery export is defensible because it writes outside the binding, but it must be an explicit exception to §3.2's blob-fetch promise or must propagate scope. Acceptance must pin all three behaviors, including zero fetch/write on refused OOS restore. This is HIGH because the current command directly defeats the binding's disk/bandwidth boundary.

9. **MEDIUM — §5 is insufficient to catch the remaining failure modes.** In addition to the test deltas named above, it lacks: the complete bind validation table (normalization, overlap/nesting, repo split, empty scope); a foreground/indirect publication matrix (`push`, bare and flagged `sync`, front-door Sync, recover/repair, ignore purge, Git keep-mine, direct `pushManifest`) with zero Git-plan/upload/commit assertions; broken-chain pull-only daemon behavior; missing/corrupt desired-mode and forged `RBOX_DAEMON_PULL_ONLY=0` startup; OOS Git sidecar/journal preservation through shrink/re-expand; and an unscoped byte-for-byte regression. Acceptance 3 must also exercise both scan-backed and trusted-view scope projection: the latter has a distinct refusal/rescan branch today (`src/cli/sync/pull.ts:297-318`). The seven current cases (`docs/design/212-selective-repo-sync.md:136-155`) can all pass while findings 1-8 remain.

Validation executed: 131 targeted daemon/mode, deferral-hygiene,
versions/restore, and export tests passed; 51 focused Git base-composer,
lazy-apply, and hygiene tests passed. An executable `composeRepoBase` probe
also confirmed that default migration authority installs a changed candidate
branch as terminal BASE, which is the failure mode in finding 3.

CHANGES-REQUIRED

## Round 3 (2026-07-27, codex gpt-5.6-sol high) — FINAL round (hard cap)

### Round-2 closure audit

- **Finding 1 — PARTIAL.** The `pushManifest` fail-closed chokepoint is now
  placed before its receipt reconciliation and scan
  (`src/cli/sync/push.ts:277-315`), command admission covers the ordinary and
  indirect publication entrances, and the daemon explicitly halts before
  chain repair. The seal still lacks a fail-closed discriminator when its scope
  witnesses disagree or disappear, and broken-chain `recover` remains open to
  pre-publication mutation, as the findings below detail.
- **Finding 2 — CLOSED for the mode-record threat.** Scope, not the environment
  bit or desired-mode default, is daemon authority once scope is resolved;
  missing/corrupt desired records and a forged environment value fail closed,
  with per-operation revalidation under the mutex. The separate unresolved
  scope-witness problem is finding 1 below.
- **Finding 3 — CLOSED.** OOS Git remote truth has a distinct SHADOW,
  materialized BASE cannot advance, the durable sidecar lanes are preserved,
  and expansion must apply current remote before advancing BASE. This directly
  closes the unchanged shortcut at `src/cli/sync-git/apply.ts:778-788`.
- **Finding 4 — CLOSED.** One pre-probe projection is required across pull,
  Git apply, status, doctor, and hygiene before key/candidate/collision
  construction, with zero OOS filesystem/Git/config/journal probes and
  byte-preserving shrink/re-expand acceptance.
- **Finding 5 — CLOSED.** `IN`/`STRADDLE`/`OOS` topology classification now
  precedes file reconcile/fetch/apply; a STRADDLE quarantine retains both file
  and Git BASE while unrelated paths advance, and acceptance proves later
  exactly-once convergence.
- **Finding 6 — CLOSED.** Root and ancestor ignore layers are explicit metadata
  exceptions, remote-authoritative on scoped bindings, and local divergence
  cannot influence the pull matcher. Create/change/delete and local-poisoning
  cases are accepted.
- **Finding 7 — CLOSED.** Scope edits now have durable intent, acknowledged
  daemon parking, generation fencing of trusted/cached authority, resumable
  materialize/prune, accepted-scope plus registry commit, last-prefix refusal,
  and fault injection across the stated crash windows.
- **Finding 8 — CLOSED.** `versions`, `restore`, and `export` each have an
  explicit disposition; OOS restore refuses before fetch and full export is a
  documented outside-binding exception.
- **Finding 9 — PARTIAL only as a consequence of the findings below.** The
  thirteen acceptance items cover the seal matrix, mode forgery, both pull
  arms, transaction faults, straddle BASE retention, sidecar preservation,
  ignore authority, restore/export, and unscoped byte identity. They do not
  exercise a scoped `recover` receiving `ManifestChainError` and prove refusal
  before historical apply, or loss/disagreement of the scope witnesses
  themselves.

The cited anchors match the dangerous ordering: `pushManifest` reaches receipt
reconciliation at `src/cli/sync/push.ts:305`; the pull guard's two arms are at
`src/cli/sync/pull.ts:297-318`; the Git unchanged shortcut is at
`src/cli/sync-git/apply.ts:778-788`; daemon chain repair begins at
`src/cli/daemon/daemon.ts:1900-1919`; stable-gone probing is at
`src/cli/sync-git/deferral-hygiene.ts:249-309`; ignore layers are disk-derived
at `src/engine/ignore.ts:355-380`; and restore currently fetches/writes at
`src/cli/versions-cmd.ts:82-115`.

### Findings

1. **CRITICAL — the seal has no durable, fail-closed discriminator when the
   two scope witnesses disagree or one disappears.** Section 3.1 stores scope
   in both `.rbox/state` and the design-211 registry row, while §3.1b says the
   *canonical* binding scope controls the chokepoint and daemon. It never names
   which record is canonical or defines mismatch, missing-field, missing-row,
   or one-record-corrupt behavior. The only explicit absent/corrupt rule is for
   the desired-mode record *after scope is already known*. This omission is
   dangerous because legacy/unscoped compatibility requires absence of scope
   to remain a valid state, while the current state loader can reconstruct a
   fresh valid state after the active state disappears
   (`src/cli/sync-state-store.ts:87-102,306-313`). An implementer can therefore
   treat a lost/omitted scope in the selected witness as legacy-unscoped; both
   `pushManifest` and daemon authority then fail open together, allowing the
   partial local tree into the full-manifest differ and publishing OOS
   deletions. The scope-edit intent handles transaction crashes, not
   post-commit witness loss or disagreement. Define a durable
   scoped-vs-unscoped seal discriminator bound to the binding incarnation,
   define the authoritative reconciliation of state and registry, and make any
   disagreement or missing/corrupt scoped counterpart refuse publication and
   read-write daemon startup. Acceptance must delete/corrupt/omit each scope
   witness independently and create disagreement, proving refusal before scan,
   Git planning, upload, or commit while preserving byte-identical behavior
   for genuinely legacy unscoped bindings.

2. **HIGH — scoped `recover` can mutate the tree through chain repair before
   the publication seal fires.** Section 3.1b says scoped `recover` runs its
   pull/re-baseline half and treats only the publish half as N/A; unlike the
   daemon rule, it does not say that `ManifestChainError` halts before
   `repairChain`. The current command catches that error and calls
   `repairChain` (`src/cli/recover-cmd.ts:90-105`). `repairChain` then walks
   backward and applies a historical manifest to disk
   (`src/cli/chain-repair.ts:51-60`) *before* it scans and calls
   `pushManifest` (`:71-78`). Consequently, an implementer following v3 can
   preserve this ordering: clean scoped files are rolled back/trash-mutated,
   then `scoped-binding-cannot-publish` refuses the superseding repair, leaving
   the user on a deliberately historical local state with no way for that
   binding to complete the operation. The chokepoint correctly prevents remote
   publication but is too late to prevent this receiver-side stranding.
   Require scoped `recover` to halt on `ManifestChainError` before entering
   `repairChain`, with the same named non-publishing condition and unscoped
   repair remedy as the daemon. Add the broken-chain recover case to the
   publication matrix and assert zero historical apply/write as well as zero
   Git-plan/upload/commit calls.

No other severity-qualified defect was found in the v3 changes.

CHANGES-REQUIRED
Final round-3 review recorded in [REVIEW-212.md](/home/via/Development/Personal/rbox-core/docs/design/REVIEW-212.md:102).

Two severity-qualified defects remain:

## Round 3 (2026-07-27) — verdict CHANGES-REQUIRED, both residuals folded as fail-closed narrowings (witness-integrity seal layer 4; recover refuses upfront); self-certified ALIGNED per 3-round cap

- CRITICAL: scope-witness loss or disagreement can make a scoped binding appear unscoped, reopening publication of OOS deletions.
- HIGH: scoped `recover` can apply historical manifests before the late `pushManifest` refusal, stranding the local tree mid-repair.

Round-2 findings 2–8 are otherwise closed at design level. No additional qualifying defects found.

CHANGES-REQUIRED