# Ground-truth integration map (recon, 2026-07-10) — binding input for implementation

## 1. Per-repo git BASE record
- NO separate store: base = `SyncState.lastSyncedManifest.gitRepos` (config.ts:90-117; Manifest.gitRepos types.ts:115). File `<root>/.rbox/state.json` (config.ts:121,125). `saveState` whole-blob (config.ts:227-230); `loadState` stream-stamp guard (216-223).
- Local-only sidecars on the same SyncState (config.ts:88-116, "never leave this machine"): gitReposRemoved, gitNeedsResolution, gitPendingRemote — lane fields (cfgSynced/cfgApplied/cfgToken/cfgShape) follow this exact pattern.
- WRITE sites (all saveState, sync.ts): pull-apply 329-336; commit-ACK 667-674 (base = gitBaseAfterCommit, helper sync-git.ts:743-755, pending keeps old entry); push no-op bookkeeping 566-573. resetSyncState deletes (config.ts:239-252).
- READ sites: sync.ts:500 (fresh per push attempt), 195, 361; daemon.ts:372, 1299; status-cmd 214/240; doctor 223; ignore-cmd 55.
- gitPendingRemote: SET sync-git.ts:1552,1614,1660,1737; CLEARED 1570,1639,1653,1706; planner-carried 529-537; opt-out clear 335.
- Cross-process locking: NONE. Atomic per-file only. The v5 state lock + revisioned CAS merge is NEW infra at saveState level.

## 2. Fingerprint/divergence cache
- File `<root>/.rbox/state/git-divergence.json`; FILE version const =3 (sync-git.ts:771-772); fingerprint version hashed in (=4, 774). Entry schema 794-800 ({fingerprint, writtenAtMs, identityKey, kind?, probe?}); probe 785-792. NO per-entry version → cachedLocalCfg lands via FILE version bump (cache discarded once, self-heals).
- isCacheEntry 856-867; trust gate trustedGitFingerprintHit 1100-1102; consulted 1276-1293; fast carry 570-583; baseless-pointer pre-skip 593-613.
- Whole-entry set sites (thread cachedLocalCfg through BOTH): 1313-1319, 1350-1356. Load/save 896-918 (writeFileAtomic, skip if !dirty). All saves swallowed (715, 1826, slow-path catches 402-479) — best-effort by design; lane CORRECTNESS must never live only here.

## 3. Cross-process reality
- Concurrent writers: daemon pump (single-flight IN-PROCESS only, daemon.ts:385-439) + `rbox push` (main-dispatch 226-249) + `rbox pull` (250-269) + `rbox sync` (270-274) + `rbox status` (WRITES the divergence cache, 1826). isDaemonRunning is NOT consulted by push/pull/sync. daemon.pid/activity.json/binding = identity+status, not mutexes.
- Only O_EXCL precedent in tree: e2ee genesis.lock (e2ee-keystore.ts:100-103).

## 4. GitPushPlan
- Type sync-git.ts:227-242; has captured[]/carried[] already. Flow: planGitSections → sync.ts:531; local composed 538; api.commit 639; POST-ACK save 663-674 (gitPlan in scope — natural home for the authored-config stamp). The no-op save (566-573) and pull save (329-336) do NOT see gitPlan — lane plumbing needed there.

## 5. Atomic helpers
- writeFileAtomic fsutil.ts:16-43 (sibling tmp `.rbox-tmp-*`, fsync, beforeRename gate, rename) — per-file atomicity ONLY, no ordering. assertWithinRoot 49-69. No flock/lockfile helper exists.
