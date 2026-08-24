# rbox Architecture (v2)

> **Status:** corrected design, supersedes `rbox-architecture.md` (the "CodeSync" draft).
> This version reflects decisions made after an adversarial review. See the **Decision Log** below.
>
> **PARTLY SUPERSEDED (2026-08-11).** The frame below is still right — daemon +
> watcher, a DO commit sequencer, manifest-as-blob, content-addressed R2,
> conflict copies plus version history, device-code onboarding, account-scoped
> quota. Three of its decisions were later reversed in the shipped system and
> are marked **REVERSED** in the Decision Log: **D3** (presigned direct-to-R2),
> **D5** (two encryption tiers), and the `rbox.yml` half of **D11**. It also
> predates the local `~/.rbox/config.json` folder authority (design 231), which
> is now the sole authority for which folders a machine syncs and their
> options. For module-level truth read the module's `Never:` header; for
> user-facing file semantics read `docs/usage.md`.

rbox is a developer-aware, continuously-syncing "Dropbox for devs." It keeps your *working directory* mirrored across machines — including uncommitted git state — while treating dependencies, build output, and machine-local junk as regenerable local state rather than bytes to ship.

The name nods to rsync/rclone, but the architecture is **Dropbox-model** (centralized control plane, accounts, continuous passive sync), not rsync-model (stateless, serverless). That's deliberate and matches the product goal.

---

## Decision Log (what changed from v1)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Continuous daemon + file watcher is the product**, not manual `push`/`pull`. | The desired UX is "edit on A, it's already on B." That requires a long-running agent, not imperative commands. |
| D2 | **Durable Object per workspace is core** (the commit sequencer), not an optional Phase 4 add-on. | Continuous sync needs a single point that serializes commits, assigns sequence, and detects conflicts. |
| D3 | ~~**Blobs upload directly to R2 via presigned URLs**; the Worker is never in the byte path.~~ **REVERSED — never shipped.** Bytes stream *through* the Worker: `PUT /v1/blobs/:sha` (`apps/api/src/routes/blobs.ts`), which R2 verifies against the sha on write, plus Worker-mediated multipart over the 90 MiB `SINGLE_PUT_MAX`. There is no presigning anywhere in `apps/api`. The OOM concern was answered by *streaming* rather than by presigning. | A Worker can't `arrayBuffer()` a 500MB (or even 50MB-at-concurrency) file — 128MB memory ceiling. |
| D4 | **Manifests are stored as content-addressed blobs in R2**, with a thin pointer row in D1. | Storing full file lists as D1 rows per commit explodes row count and blows batch limits. |
| D5 | ~~**Encryption: server-side at-rest by default, opt-in E2EE per workspace, `.env`/secrets forced to E2EE when synced.**~~ **REVERSED — full E2EE is the only mode** (design 12). There are no tiers, no server-readable path, and no per-workspace choice; a binding without `schema: "e2ee/v1"` fails closed (`src/cli/workspace-config.ts`). Keys are an account master key with per-device asymmetric wraps, signed rosters and epochs (`src/engine/e2ee/`), not a per-workspace passphrase KEK. Everything below tagged "Tier 0" / "Tier 1" is dead. | At-rest is free (R2 default). E2EE is the meaningful control but taxes onboarding + dedup, so it's opt-in. |
| D6 | **`.git` is mirrored as an atomic, all-or-nothing snapshot** taken when git is quiescent; never synced file-by-file. | File-by-file `.git` sync is a classic repo-corruption generator. |
| D7 | **Conflicts → conflict copies + free version history.** Never lose data; retain last N versions via old blobs. | Content-addressing makes version history nearly free; conflict copies are the safe default for passive sync. |
| D8 | **Headless onboarding via device authorization flow** (OAuth device code). | "Fire up a Docker container and sign in easily" = `gh auth login`-style code approval. |
| D9 | **Single R2 bucket, tenant isolation enforced in D1/Worker authz**, not bucket-per-user. | R2 caps buckets in the low thousands; per-user buckets break dedup, ops, and don't improve the security boundary. |
| D10 | **GC computes reachability from live manifests**; no per-commit ref-count increment. | v1's `blob_refs.ref_count` only ever incremented — it leaked forever and GC could never run. |
| D11 | Global rename `codesync`/`.codesync` → `rbox`/`.rbox` (**shipped**); ~~project config file is **`rbox.yml`**~~ (**REVERSED — never built**; `rbox.yml` appears nowhere in the codebase. Ignore rules come from the builtin list, `.gitignore` behind `respectGitignore`, `.rboxignore`, and machine-local `ignorePaths`; user options live in `~/.rbox/config.json` per design 231). | — |

---

## Product Thesis (unchanged, refined)

Other tools sync *bytes*. rbox understands a dev project has two file classes:

1. **Portable source-of-truth** — source, lockfiles, configs, docs, scripts, project metadata. → **sync**
2. **Machine-local / regenerable** — `node_modules`, `.venv`, `target`, `dist`, `.next`, `.cache`, native builds, local DBs, OS/editor junk, secrets. → **ignore + regenerate (hydrate) per machine**

The wedge isn't sync. It's *knowing what not to sync, and how to rebuild the rest.*

---

## System Shape

```
                       ┌─────────────────────────────────────────┐
                       │            Cloudflare                    │
                       │                                          │
  ┌──────────┐  WS +   │   ┌─────────┐   ┌──────────────────┐     │
  │ Daemon A │◄───────►│   │ Worker  │──►│ WorkspaceSync DO  │     │
  │ (watcher)│  HTTPS  │   │  (API)  │   │  (sequencer +     │     │
  └──────────┘         │   └────┬────┘   │   live broadcast) │     │
                       │        │        └──────────────────┘     │
  ┌──────────┐         │   ┌────┴────┐   ┌──────────┐  ┌───────┐  │
  │ Daemon B │◄───────►│   │   D1    │   │    R2    │  │ Queue │  │
  │ (docker) │         │   │(control)│   │ (blobs + │  │(GC,   │  │
  └──────────┘         │   └─────────┘   │ manifests)│ │verify)│  │
                       │                 └──────────┘  └───────┘  │
                       └─────────────────────────────────────────┘
```

- **Daemon** — long-running on each machine. Watches the workspace, debounces, diffs against last-synced manifest, uploads new blobs, commits manifests, and holds a WebSocket to the DO for live change events.
- **Worker** — thin HTTP API: auth, validation, authz, manifest pointer writes, enqueue jobs. **Correction (2026-08-11):** it *does* handle blob bytes — it streams them to R2 (see D3). No presigned-URL minting exists.
- **WorkspaceSync DO** — single-threaded per **(workspace, project)** pair, not per workspace (`apps/api/src/routes/sync.ts`): assigns monotonic sequence, enforces the parent-manifest conflict check, broadcasts commits to connected daemons.
- **D1** — control plane (accounts, devices, manifest pointers, blob index, quota, audit).
- **R2** — content-addressed blob bytes **and** serialized manifest snapshots.
- **Queues** — async: lazy hash verification, GC, quota recompute, notifications.

---

## Tenancy & Storage Layout (D9)

One bucket. Isolation is logical, enforced on every access in the control plane.

```
blobs/sha256/<ab>/<full-sha256>          # content (cipher or plain bytes)
manifests/sha256/<ab>/<full-sha256>      # serialized manifest snapshots (also content-addressed)
tmp/uploads/{accountId}/{uploadId}       # NEVER BUILT — see D3; the real staging prefix is
                                         # staging/<sha>/<uuid>, reclaimed by apps/api/src/staging-gc.ts
packs/v1/<packId>                        # server-side small-blob packs (design 114), missing above
```

Rules:
- A client **never** reads by raw key. It resolves `manifest → file entry → blob_sha256`, and the Worker authorizes that the requesting user has access to the manifest's workspace before minting a read URL.
- `account_id` is on every D1 row (even when derivable) for authz + cleanup safety.
- Dedup/quota accounting is **account-scoped**. Content-addressing across accounts is an internal implementation detail; do not expose global-dedup semantics.

---

## Encryption Model (D5)

> **REVERSED (2026-08-11).** Full E2EE is the only mode (design 12). The Tier 0 /
> Tier 1 split below never shipped: there is no server-readable tier, no
> per-workspace opt-in, no Argon2 passphrase KEK, and no queue consumer that
> re-hashes plaintext (the server never sees plaintext). Real model: an account
> master key with per-device asymmetric wraps, signed rosters, key epochs
> (`src/engine/e2ee/`), and a BIP39 recovery phrase. The `.env`/secrets
> default-exclude list below is still accurate.

Two tiers. Pick per workspace.

### Tier 0 — Server-side at rest (default)
R2 encrypts all objects at rest automatically. Free. The server *can* read blobs, which enables future features (web preview, server-side search, lazy hash verification). Good enough for ordinary source code.

### Tier 1 — End-to-end encryption (opt-in per workspace; forced for secrets)
Client encrypts blob bytes **before** upload; the server only ever sees ciphertext.

- **Envelope encryption (KEK/DEK)** — adopted from files-sdk prior art (see `prior-art-files-sdk.md` §1). Each blob is encrypted by a per-blob **DEK** (AES-256-GCM); a per-workspace **KEK** wraps the DEK; the wrapped DEK + IVs ride in the blob's metadata. Benefits: KEK rotation re-wraps small DEKs without re-encrypting bodies; a leaked DEK exposes one blob, not the workspace. GCM authenticates body + wrapped DEK + IV.
- **Dedup under E2EE → convergent DEK:** to keep content-addressed dedup, the DEK is **derived**, not random: `DEK = HKDF(workspace_KEK, plaintext_sha256)`. Identical plaintext → identical ciphertext → dedup still works *within the workspace*, but the server can't decrypt (it never has the KEK). The equality-leak this creates is workspace-scoped only; document it. (If we ever decide dedup isn't worth the leak, switch to a random DEK and dedup on plaintext hash only — same envelope structure either way.)
- **Manifest identity stays the plaintext `sha256`** so two machines independently agree a file is "the same." The blob *object* is the ciphertext; we also record `cipher_sha256` for R2 integrity.
- **KEK material:** the workspace KEK is derived from a user passphrase (Argon2id) or generated once and wrapped per-device. It lives only on devices, never on the server. **Isolate tenants with separate KEKs** (per files-sdk's own threat-model note) so cross-tenant ciphertext splicing is impossible.

### `.env` / secrets (point 1)
- **Default: not synced at all.** `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa`, `id_ed25519` are excluded.
- **Opt-in sync is always Tier 1 (E2EE)**, regardless of the workspace's default tier. Secrets never sit server-readable. The opt-in is explicit and per-pattern.

### The onboarding tradeoff (be honest about it)
- **Tier 0 workspace:** new machine just needs a device token (device-code flow below). Files appear. Easy.
- **Tier 1 workspace:** new machine needs *key material*, not just a login. Onboarding requires the passphrase (or device-to-device key approval). This is the inherent E2EE tax — surface it clearly in the UX, don't paper over it.

---

## Blob Upload Protocol (D3 — the corrected flow)

> **REVERSED (2026-08-11).** No presigning shipped. Real flow: `POST /v1/blobs/check`
> (entitlement-scoped to the caller's account via `blob_refs`, not a global blob
> lookup), then `PUT /v1/blobs/:sha` streamed through the Worker with R2
> verifying the sha on write; over `SINGLE_PUT_MAX` (90 MiB, not ~100MB) it is
> Worker-mediated multipart (`POST /v1/blobs/:sha/multipart`, `PUT …/part/:n`,
> `POST …/complete`). Staging is `staging/<sha>/<uuid>` reclaimed by a dedicated
> reclaimer, not `tmp/uploads/`. Small blobs are additionally batched
> (`/v1/blob-batch/put|get`, design 112) and packed server-side (`packs/v1/`,
> design 114). The resumable-session-token bullet is still accurate.

The Worker mints URLs and verifies metadata; **bytes go straight to R2.**

```
Client                          Worker                         R2
  │  compute plaintext_sha256                                   │
  │  (Tier1: encrypt → cipher bytes + cipher_sha256)            │
  │                                                             │
  │ POST /v1/blobs/upload-url ───►│                             │
  │   {plaintext_sha256, size,    │ exists for account?         │
  │    encrypted, cipher_sha256?} │  ├─ yes → {exists:true} ────┤ (client skips upload)
  │                               │  └─ no  → presign PUT to     │
  │ ◄─── {uploadUrl, uploadId} ───│         tmp/uploads/...      │
  │                                                             │
  │ PUT bytes ─────────────────────────────────────────────────►│  (direct; Worker untouched)
  │                                                             │
  │ POST /v1/blobs/commit ───────►│ HEAD tmp object             │
  │   {uploadId, sha256, size,    │ verify size + R2 checksum   │
  │    cipher_sha256?}            │ move tmp → blobs/sha256/...  │
  │                               │ INSERT blobs row            │
  │ ◄─── {ok} ────────────────────│ enqueue verify (lazy)       │
```

- **Large files:** use R2 **multipart** with presigned part URLs. MVP threshold ~100MB → multipart. The daemon persists a **serializable resumable session token** (files-sdk §5) to `.rbox/state/uploads/` so a killed daemon / restarted container resumes an upload instead of re-hashing and re-sending from zero. For S3/R2 the token pins the part size.
- **Integrity (Tier 0):** server can't re-hash plaintext in the request path (OOM). It relies on R2's checksum on PUT, then a **Queue consumer streams the R2 object and verifies `plaintext_sha256` out-of-band** (Workers stream R2 bodies without buffering). Mismatches are quarantined + audited.
- **Integrity (Tier 1):** server verifies `cipher_sha256` only; plaintext hash is unverifiable by design.
- `tmp/uploads/*` older than N hours are swept by GC (abandoned uploads).

---

## Manifest Model (D4 — fix the D1 explosion)

A manifest is a point-in-time snapshot of a project's syncable files. **It is itself a content-addressed blob**, not a pile of D1 rows.

```
manifest snapshot (JSON, gzipped) stored at manifests/sha256/<ab>/<sha>
  {
    projectId, sequence, parentManifestSha, generatedAt, deviceId,
    files: [ { path, sha256, size, mode, mtimeMs, fileType, symlinkTarget?, enc? } ],
    git?: { ... see .git section ... }
  }
```

D1 keeps only a **pointer row** per committed version:

```sql
CREATE TABLE manifests (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL,
  workspace_id       TEXT NOT NULL,
  project_id         TEXT NOT NULL,
  device_id          TEXT NOT NULL,
  parent_manifest_id TEXT,
  manifest_blob_sha  TEXT NOT NULL,   -- the snapshot in R2
  sequence           INTEGER NOT NULL,
  created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (project_id, sequence)
);
```

- `manifest_files` (the per-file row table from v1) is **removed**. File lists live in the snapshot blob.
- **Missing-blob check** is one batched query, not N round-trips: client sends the blob hash set; server runs `SELECT sha256 FROM blobs WHERE sha256 IN (?, ?, …)` in chunks of ~100. Client uploads the difference.
- **Diffing** is client-side: each daemon caches its last-synced manifest locally (**stale (2026-08-11):** not a per-project JSON file — local sync state is the SQLite state plane, `.rbox/state/state.db` plus the `.rbox/state.json` authority marker, `src/cli/state-plane/`) and diffs the new scan against it to compute changed/added/deleted paths.

---

## Per-Device Root Mapping (local-only — never synced)

A workspace's **local root differs per machine** and is purely client-local state — the same machine-local class as `node_modules` presence. Host A may bind workspace `ws_abc` to `~/Development`; Host B binds the *same* `ws_abc` to `~/code`. The server is **root-agnostic**: the manifest only ever carries root-relative POSIX paths (`project-a/src/index.ts`), and each device joins that onto its own `rootPath`.

```bash
# Host A
rbox link ~/Development                    # creates workspace, prints ws id
# Host B
rbox link ~/code --workspace ws_abc123     # same workspace, different local root
```

- `rootPath` is stored **resolved + per-device** in `.rbox/workspace.json`, alongside the shared `remoteWorkspaceId`. It is never put in the manifest, blob keys, or any server record — doing so would reintroduce the path-coupling the security rules explicitly forbid (absolute paths / `..` rejected).
- The Worker must never know that A calls it `~/Development` and B calls it `~/code`.
- **Engine already supports this:** every filesystem op goes through `path.join(rootPath, relativePath)`, and `scanManifest(root)` / `applyActions(destRoot, …)` take the root as an argument — remapping roots is free, just a different base path per machine. (Verified by the Phase-1 conflict test, which syncs two trees at different paths through one store.)

---

## The Sync Loop (client daemon — the hard 20% v1 skipped)

```
loop:
  1. watch filesystem (**`@parcel/watcher`**, not chokidar — native prune plus an authoritative JS matcher), debounce ~500ms of quiet
  2. scan changed subtree → apply ignore rules (built-in + .gitignore behind `respectGitignore` + .rboxignore + machine-local `ignorePaths`; **no rbox.yml — see D11**)
  3. for the project(s) touched: build candidate manifest (hash changed files only;
     reuse cached hashes where mtime+size unchanged)
  4. diff candidate vs last-synced manifest → {addedOrChanged blobs, deleted paths}
  5. ask server which blobs are missing (batched) → upload missing (direct-to-R2)
  6. commit manifest THROUGH the DO with parentManifestId = last-synced id
        ├─ DO accepts  → new sequence assigned, becomes head, broadcast to peers
        └─ DO rejects  → conflict (head moved): pull head, reconcile (see Conflicts), retry
  7. cache new manifest as last-synced
```

Inbound (live) path:
```
on DO broadcast {manifestId, sequence}:
  if sequence > local last-synced:
    fetch manifest snapshot
    diff vs local working tree
    download missing blobs (authorized read URLs) → decrypt if Tier1
    apply: ATOMIC writes (write temp → fsync → rename), apply deletes, never touch ignored paths
    update last-synced
```

**Atomicity is non-negotiable:** every applied file is written to a temp path and `rename()`d into place so a crash mid-sync never leaves a half-written file. Deletes are applied last.

---

## `.git` Atomic Mirroring (D6)

> **SUPERSEDED (2026-08-11).** Git state does not sync as a hashed snapshot of
> `.git` files swapped in from a temp directory. It syncs as `git bundle` /
> incremental pack chains per repository (`src/cli/sync-git/pins.ts`,
> `src/cli/sync-git/`), applied through a fetch/transition pipeline with
> deferrals, divergence handling and quarantine. There is no
> `snapshotConsistent` field. The *goal* below — never ship a torn `.git` — is
> what the bundle mechanism delivers.

`.git` is mirrored so machine B is a true clone (branch, HEAD, uncommitted, stashes) — but it is **never synced file-by-file**.

- The watcher treats `.git/**` as a **single logical unit**. Loose-object churn during a commit/rebase does *not* trigger per-file syncs.
- When git goes **quiescent** (no `.git` writes for a debounce window, and no lock files like `.git/index.lock` / `.git/*.lock` present), the daemon takes a **consistent snapshot** of `.git`, hashes its files, and ships them as one transactional manifest update tagged `git: { snapshotConsistent: true, head, branch }`.
- On the receiving side, the new `.git` is assembled in a **temp directory and swapped in atomically** — never partially overlaid onto a live `.git`.
- **Conflicts on `.git` are resolved at the whole-repo-state level**, never per-object. If two machines diverged git state simultaneously (rare), rbox makes a conflict *copy of the working directory state* and surfaces it — it does not attempt to merge `.git`.

> Why not exclude `.git` and rebuild from origin? Because the goal is a true mirror including *uncommitted* work and local branches, which origin doesn't have. Atomic snapshotting buys the mirror without the corruption risk.

---

## Conflicts + Version History (D7)

**Commit-time detection (optimistic concurrency, now actually implemented):** the DO holds the current head manifest id per project. A commit must carry `parentManifestId == head`. If not, the DO rejects with `{error:"conflict", head}` and the client reconciles.

**Reconciliation:**
- **Non-overlapping changes** (different files changed on each side): auto-merge — union the two manifests, no user friction.
- **Same file changed on both sides:** keep both. The losing side is written as `name.<device>.<YYYYMMDDHHMM>.conflict.ext`, both are committed, and `rbox status` surfaces it. **Nothing is lost.**

**Version history (nearly free):** because blobs are content-addressed and immutable, prior versions already exist in R2. rbox retains the last **N versions** of every file path (configurable; default e.g. 10) by keeping their blobs reachable from a per-project history pointer. `rbox versions <path>` lists them; `rbox restore <path>@<n>` rolls back. GC only collects blobs unreachable from *any* live manifest or retained history entry.

---

## Auth & Headless Onboarding (D8)

External auth for identity (Clerk/Auth0/Supabase/WorkOS) → Worker verifies JWT → maps `sub` to `users.id`. On top of that, **devices** authenticate with long-lived scoped device tokens obtained via the **device authorization flow**:

```
Docker container (headless)            Worker                 User's browser
  │ POST /v1/device/code ──────────────►│                          │
  │ ◄─ {device_code, user_code,         │                          │
  │     verification_uri, interval} ────│                          │
  │                                     │                          │
  │  print:  "Go to rbox.to/activate    │                          │
  │           and enter  WXYZ-1234"      │ ───── user visits ──────►│
  │                                     │ ◄──── approves WXYZ-1234 ─│
  │ POST /v1/device/token (poll) ──────►│  pending… pending… ok     │
  │ ◄─ {deviceToken,                    │                          │
  │     (Tier1: wrappedWorkspaceKey?)} ─│                          │
  │  start daemon, begin sync                                       │
```

- For **Tier 0** workspaces, the device token is sufficient — sync starts immediately.
- For **Tier 1** workspaces, the container additionally needs key material: either the user supplies the passphrase to the container, or an already-trusted device approves and hands over the wrapped workspace key. Surface this as an explicit step.

---

## WorkspaceSync Durable Object (D2 — elevated to core)

One DO instance per workspace. Single-threaded execution = no race on sequence assignment, which kills v1's `MAX(sequence)+1` data race.

Responsibilities:
- Hold current head manifest id per project.
- **Commit path:** validate `parentManifestId == head`; if ok, assign `sequence = head.sequence + 1`, persist the pointer, set new head, broadcast `{projectId, manifestId, sequence}` to all connected daemons. If not, reject with `{conflict, head}`.
- **Live fanout:** authenticated WebSocket sessions (auth the upgrade — the `/connect` handler must validate the device token; v1 accepted any socket).
- **Presence:** "MacBook is online," last-seen.

Do **not** use the DO as the primary database. It's a coordinator over D1, used surgically.

---

## Error Boundary (v1 bug, fixed)

v1's `requireAuth` / `assertWorkspaceAccess` *threw* `Response` objects, but `worker.ts` had no try/catch — so every auth failure became a 500. v2 wraps the router in a top-level boundary (this is also why we use a small framework like Hono):

```ts
export default {
  async fetch(req, env, ctx) {
    try {
      return await route(req, env, ctx);
    } catch (e) {
      if (e instanceof Response) return e;          // thrown 401/403/404
      if (e instanceof ZodError) return badRequest(e.message);
      console.error("unhandled", e);
      return json({ error: "internal" }, { status: 500 });
    }
  }
}
```

---

## Garbage Collection & Quota (D10 — fix the leak)

> **PARTLY SUPERSEDED (2026-08-11).** Reachability-based GC shipped, but there is
> no `.trash/` R2 soft-delete tier: server GC is mark → `deleting_at` intent
> under a lease → direct R2 + D1 deletion (`apps/api/src/gc-*.ts`). The trash
> tier that exists is local-only (`rbox trash`, design 50). There is also no
> free plan — rbox is paid-only (design 86); real limits are in
> `apps/api/src/plans.ts`.

v1 only ever *incremented* `blob_refs.ref_count`, so it grew forever and nothing could be collected. v2 drops per-commit ref counting in favor of **reachability**:

- A blob is **live** if it's referenced by any current head manifest OR any retained history/version entry, for that account.
- A periodic Queue job computes the reachable set per account (walk head manifests + retained versions). Unreachable blobs are **moved to a `.trash/` tier first** (soft-delete, from files-sdk §4), and only purged after a grace period — so a propagated delete or a GC bug is recoverable, not catastrophic. Abandoned `tmp/uploads/*` are swept by age.
- **Quota** = sum of live blob sizes per account, recomputed by the same job (or incrementally maintained, but reachability is the source of truth).

---

## Security Rules (kept + added)

1. **Every row has `account_id`.** (kept)
2. **Never trust client paths.** Reject absolute paths, `..`, null bytes; normalize to POSIX relative. (kept)
3. **R2 keys are content hashes, never user paths.** (kept)
4. **Secrets excluded by default; opt-in sync is E2EE-only.** (D5)
5. **Hard limits early:** ~~free → 50MB/blob, 2GB/workspace, 100k files/manifest; pro → 500MB/blob~~ — **stale (2026-08-11): there is no free plan** (paid-only, design 86). Real limits are in `apps/api/src/plans.ts`: `none` (locked), Solo 50 GiB / 10 devices / 30d, Pro 250 GiB / 25 devices / 365d, Team 150 GiB / 100 devices / 90d. The per-manifest bound is a byte cap (`manifestBytes`), not a file count, and blob size is bounded by the 90 MiB single-PUT/multipart split rather than a plan tier. Manifest commits chunk D1 writes; never one mega-batch. (refined)
6. **Audit log:** workspace/device/manifest/member/blob lifecycle events. (kept)
7. **MOOT (2026-08-11) — `rbox.yml` and the whole hydrate/deps surface were never built (design 51).** ~~Synced `rbox.yml` runs no arbitrary shell by default.~~ `hydrate.commands` from a *synced* config are treated as untrusted: shown, never auto-run under a blanket `--yes` (esp. in CI). Detected commands (npm ci, etc.) are the trusted path. (new — matters once workspaces are shared)
8. **Auth the WebSocket upgrade** on the DO. (new)

---

## Build Plan (re-ordered around the real product)

> **DONE (2026-08-11).** All five phases shipped; the product is at 2.0.0-beta.1.
> E2EE was not a Phase 5 add-on — it is mandatory and shipped earlier. The
> files-sdk buy-vs-build question is closed: the blob layer is hand-rolled
> (`apps/api/src/blobs.ts`, `blob-pack.ts`).

**Phase 1 — Sync engine, locally testable.**
Build the manifest/diff/blob/atomic-apply engine so it can sync **two local paths** (or loopback) on one machine. No cloud yet — fast feedback loop on the genuinely hard part (diff, conflict copies, atomic writes, `.git` snapshotting). This is *not* a shipped local product; it's the testable core.

**Phase 2 — Control plane.**
Workers + D1 + R2 + DO with the corrected protocols: device-code auth, presigned direct-to-R2 upload, manifest-as-blob, DO sequencer, error boundary, batched missing-blob check.
*Buy-vs-build decision here:* evaluate `haydenbleasel/files-sdk` as the R2 blob layer (it already does dedup, envelope encryption, versioning, soft-delete, resumable, retries) vs. hand-rolling R2 calls. Verify `workerd` compat first. The manifest layer, DO sequencer, conflict engine, and `.git` snapshotting stay ours regardless. See `prior-art-files-sdk.md` §7.

**Phase 3 — Daemon + continuous sync.**
Wire the engine to the control plane. Watcher → debounce → commit-through-DO → live WebSocket inbound. The killer demo: edit on A, watch it land on B (a Docker container) within seconds, validate via `rbox status`.

**Phase 4 — Dev-awareness layer.**
Project detection, ignore rules, `hydrate`, `doctor`. The "make my env runnable, not just present" wedge.

**Phase 5 — E2EE + secrets, version history UX, teams.**
Tier-1 workspaces, `.env` opt-in, `rbox versions/restore`, workspace invites, roles, quota/billing.

---

## CLI Surface (rbox)

> **SUPERSEDED (2026-08-11).** `rbox link` and `rbox daemon …` are hidden
> deprecated aliases that forward to `rbox track` and `rbox start|stop|logs`
> (`src/cli/help-registry.ts:744-771`). `rbox hydrate` and `rbox detect` do not
> exist — the whole deps group is commented out (design 51). The real command
> set is `src/cli/main-dispatch.ts`; add at least `rbox config`, `rbox setup`,
> `rbox adopt`, `rbox pair`/`connect`/`recover`, `rbox versions`/`restore`,
> `rbox trash`, `rbox key`, `rbox git`, `rbox export`, `rbox usage`.

```bash
rbox login                 # device-code flow
rbox link ~/Development    # register this path as a workspace + start daemon
rbox status                # what's synced, conflicts, missing local state
rbox doctor                # host + project readiness
rbox hydrate [project]     # regenerate local state (deps, etc.)
rbox versions <path>       # list retained versions
rbox restore <path>@<n>    # roll a file back
rbox daemon {start|stop|logs}
```

CLI presentation can use a small color lib (chalk/picocolors) — keep it readable, not noisy.

---

## Open Problems / Risks (be honest)

- **`.git` quiescence detection** is heuristic (lock files + debounce). A fast scripted git workflow could still race the snapshot. Mitigation: snapshot integrity check (verify HEAD/refs/index consistency) before committing a `.git` update; skip + retry if inconsistent.
- **Convergent encryption** leaks equality of files within an account. Acceptable (account-scoped) but document it.
- **Large monorepos** (100k+ files) stress the scan/hash loop and manifest size. Need incremental hashing (mtime+size cache) and possibly per-subtree manifests. Watch this in Phase 1.
- **E2EE onboarding friction** is real and inherent. Don't pretend otherwise in the UX.
- **Continuous sync amplifies conflicts** vs. manual push/pull. The DO parent-check + conflict copies are the safety net; measure conflict rate in dogfooding.
