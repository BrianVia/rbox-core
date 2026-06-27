# Design 06 — Version History, Trash, GC (Milestone 6)

**Status:** ✅ IMPLEMENTED & VERIFIED. Version history + restore (3/3) and reachability GC (9/9, incl. the cardinal assertion *reachable blob survives GC*) verified live. GC uses the barrier-free candidate-tagging design (§4-SAFE) per codex review: authoritative DO roots, fail-closed, never moves canonical keys, candidate-aware existence check resurrects on re-upload. Note: GC enumerates the `workspaces` registry (written on commit); blobs of unregistered/pre-registry workspaces are collectible — fine post-wipe, and it self-cleaned 207 leftover test orphans. Retention prune lives in the DO (authoritative, never prunes head). **Plan-gated retention is now wired** (`apps/api/src/retention.ts`, `POST /v1/admin/gc?phase=retention`): per workspace, the prune floor is computed from the owning account's `retentionDays` (free 0 = keep only head) via the D1 `manifests.created_at` cutoff, then GC mark/purge reclaims — operational order retention → mark → purge. Tier is read through `resolveAccountPlan()`, the **placeholder seam** that will reconcile against live Stripe subscription status once billing is linked. Cron scheduling of the retention→mark→purge sequence remains a follow-up.
**Implements:** roadmap M6. **Decisions:** D7 (conflict copies + version history), D10 (reachability GC).
**Goal:** browse and restore past versions; deletes are recoverable (soft, then purged); storage is reclaimed safely (a retained version's blob is NEVER deleted).

---

## 1. What already exists
- The DO stores `head` + `seq:<n> → manifestSha` for **every** commit (`workspace-sync.ts`); D1 `manifests` mirrors `(ws, proj, sequence, manifest_blob_sha, device_id, created_at)`. So full version history is already persisted — M6 exposes + retains + GCs it.
- Blobs are immutable + content-addressed; an old manifest referencing a now-deleted file still points at its (still-present) blob → restore is possible.

## 2. Version history (read APIs)
- `GET /v1/ws/:ws/proj/:proj/versions?limit=N` → `[{ sequence, manifestSha, deviceId, createdAt }]` (from D1, newest first). Authed.
- `GET /v1/ws/:ws/proj/:proj/manifests/:seq` → that sequence's manifest (DO reads `seq:<n>` → R2). Authed.
- CLI: `rbox versions [path]` — list workspace commits (seq, time, device); with a path, show the versions where that path's content changed (diff its sha across recent manifests). `rbox restore <path>@<seq>` — fetch the file's entry from manifest `seq`, download+decrypt its blob, write it locally (atomic, as a restore; does not rewrite history).

## 3. Retention (time-windowed)
- Per-workspace retention window `retentionDays` (default 30; **plan-gated in M7b** — Free 7 / Solo 30 / Pro 90). Stored in workspace/project config.
- A version (sequence) older than the window AND not the current head is **prunable**: its `seq:<n>` pointer + D1 row are removed. The head is always retained; recent history within the window is retained. (Pruning a pointer doesn't delete blobs — GC does, only if unreachable.)

## 4-SAFE. Reachability GC — barrier-free candidate-tagging (revised per review)

Codex review found 2 BLOCKERS: GC must mark from **authoritative DO roots** (the D1 mirror is best-effort), and grace+recheck alone can't close the **commit/dedup race** (an old unreferenced blob can be deduped-against by a new commit mid-sweep → if GC then deletes it, that commit references a missing blob). The safe, barrier-free design:

**Authoritative roots.** A D1 `workspaces(workspace_id, project_id)` registry is written (INSERT OR IGNORE) on every commit. GC enumerates the registry and, **per workspace, asks its DO for the authoritative retained roots** (head + in-retention `seq:<n>` → manifest shas). If any DO can't be read → **abort GC (fail closed)**, never sweep on partial knowledge.

**Mark (global).** Reachable set = union across ALL workspaces of: each retained manifest blob sha; for each `type=file` entry `encSha ?? sha256`; git `bundleSha`, `indexSha`, every `opState` value. (NOT symlink shas — no blob is stored for symlinks; NOT git refs/head/indexTree — not blobs.) Plus active `uploads.staging_key` (in-flight multipart).

**Candidate tagging (never touch canonical keys).** Sweep R2; any blob/manifest object **older than a grace age** and not in the reachable set → insert into `gc_candidates(sha, marked_at)`. **R2 objects are NOT moved or deleted in this phase** (moving the canonical key was the rejected BLOCKER).

**Dedup-race fix — candidate-aware existence checks.** The blob-existence check (`blobsCheck` AND the DO commit's `missingBlobs`) treats a sha present in `gc_candidates` as **MISSING**. So if a new commit would dedup against a dying blob, the client is told to re-upload it; the re-upload (`blobPut`/multipart complete) **deletes its `gc_candidates` row** (un-condemns it). A candidate can therefore never be referenced by a new commit without first being resurrected. This removes the need for a cross-DO write barrier.

**Purge (after grace).** For each candidate older than the grace window: **rebuild the global roots, re-check reachability, and confirm it's still a candidate** (not resurrected); only then delete the R2 object + its row. Invariant: **a canonical object is deleted only if the current authoritative global roots exclude it AND it has been a continuous candidate across the grace window** (any reference attempt in between resurrected it).

Retention prune (§3) runs in the DO from authoritative `head`/`seq:<n>` (abort if `seq:<head>` missing); D1 is browsing-only, never deletion authority. GC is an admin/cron route, off the hot path.

## 4. (original draft — superseded by 4-SAFE above)
**Never per-commit ref-counting (the v1 leak).** Mark-and-sweep over R2:
1. **Mark:** the reachable set = for every RETAINED manifest (head + all sequences within retention), every referenced blob sha: file `sha256` (plaintext blobs), `encSha` (ciphertext blobs), git artifact shas (bundle/index/op-state), and the manifest blob sha itself. Collect into a set (or a bloom/temp table for scale).
2. **Sweep:** list R2 objects under `blobs/` and `manifests/`; any object whose sha ∉ reachable set is **garbage**.
3. **Trash tier before purge (soft-delete):** move garbage to a `trash/<ts>/…` prefix (or tag with a delete-after timestamp) instead of deleting. Purge from trash only after a grace window (e.g. 7 days) — so a GC bug or a racing in-flight commit is recoverable.
4. **Race safety:** a commit in flight may reference a blob GC is about to sweep. Mitigations: (a) only sweep blobs older than a safety age (created_at > grace, so brand-new uploads are never swept); (b) re-check reachability at purge time (trash → purge only if still unreachable); (c) run GC as an explicit/admin or scheduled op, not on the commit hot path.
- GC is invoked via an admin/cron route (`POST /v1/admin/gc`, authed) for M6; Cloudflare Cron Triggers can schedule it later.

## 5. Trash for deletes
A propagated file deletion doesn't delete the blob (still referenced by prior retained manifests) → naturally recoverable via `rbox restore <path>@<seq>` until those manifests age out of retention and GC reclaims the blob. So "trash" for user deletes = version history within the retention window. The explicit trash tier (§4.3) is for GC'd blobs.

## 6. Files touched
| File | Change |
|---|---|
| `apps/api/src/versions.ts` | **new** — versions list, manifest-at-seq, retention prune, GC (mark/sweep/trash/purge) |
| `apps/api/src/worker.ts` | route versions/manifests-at-seq/admin gc |
| `apps/api/src/workspace-sync.ts` | DO: read arbitrary `seq:<n>`; prune old `seq:<n>` pointers |
| `apps/api/migrations/0005_retention.sql` | (maybe) `gc_runs`/trash bookkeeping; retention column |
| `src/cli/versions-cmd.ts` | **new** — `rbox versions`, `rbox restore` |
| `src/cli/index.ts` | wire commands |

## 7. Verification
- Unit: reachable-set includes file/encSha/git/manifest shas; sweep flags only unreachable; retention prune keeps head + in-window, drops older pointers.
- Live: commit several versions; `rbox versions` lists them; edit+restore an old version of a file (bytes match); delete a file then `restore` it from a prior seq. GC: upload an orphan blob (referenced by no manifest), run GC → it moves to trash (not purged); a blob referenced by a retained manifest is NEVER touched; purge after grace removes trash. **Critically: assert GC never removes a reachable blob** (post-GC, every retained manifest's blobs still GET 200).
- Encrypted workspace: GC reachability must use `encSha` (not plaintext sha) — verify encrypted blobs aren't wrongly swept.

## 8. Open questions for review
1. GC race: is "only sweep blobs older than grace + re-check at purge" sufficient against a concurrent commit, or do we need a generation/epoch marker or DO-coordinated quiescence?
2. Sweep cost: listing all R2 objects to diff against the reachable set — scale approach (R2 list pagination; per-workspace prefixes; incremental GC)?
3. Retention pruning of `seq:<n>` in DO storage vs D1 — keep both consistent; which is authoritative for "retained"? (DO is authoritative for head; D1 mirrors history — GC should mark from the authoritative set.)
4. Cross-workspace blob sharing: blobs are content-addressed globally (dedup across workspaces). A blob reachable from workspace B but orphaned in A must NOT be swept. So reachability is GLOBAL (all workspaces' retained manifests), not per-workspace. Confirm + implications for multi-tenant GC (M7).
