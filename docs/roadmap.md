# rbox Roadmap

Status as of the initial commit (v1). What's working, what's stubbed, and what's next — in priority order. Design rationale lives in [`rbox-architecture-v2.md`](./rbox-architecture-v2.md) (decisions referenced as **D1–D11**); storage prior art in [`prior-art-files-sdk.md`](./prior-art-files-sdk.md); plans in [`pricing.md`](./pricing.md).

> **rbox is a SaaS**, not a personal tool. That shapes priorities: multi-tenant isolation, per-account quota accounting, plan-gated limits, version-retention windows, and billing are product-critical, not afterthoughts. Plan limits (storage, project/workspace counts, retention days, team roles) come straight from `pricing.md` and must be enforced server-side.

## ✅ Done & verified

- **Sync engine** (`src/engine/`) — content-addressed manifests, three-way `reconcile`, atomic apply, conflict copies, dev-aware ignore. 6/6 unit tests; mtime-isn't-identity proven.
- **Control plane** (`apps/api/`) — deployed Worker (`rbox-dev-api`), D1 `rbox-dev-db`, R2 `rbox-dev-blobs`. Manifest-as-blob (**D4**), batched missing-blob check, optimistic-concurrency 409 (**the conflict check v1 only described**), top-level error boundary. 11/11 live API tests.
- **Client** (`src/cli/`) — `link`/`push`/`pull`/`sync`/`status`, per-device root mapping. Verified locally and **cross-machine (Mac ↔ prod host)**, bidirectional + cross-machine conflict.

---

## 🔜 Next milestones (priority order)

### 1. Daemon + watcher + live push — *the headline feature* ✅ DONE & VERIFIED
Turns manual `push`/`pull` into passive "edit here, appears there" sync. Design: [`design/01-daemon.md`](./design/01-daemon.md) (3 correctness review rounds + 2 perf rounds with codex). Verified cross-machine (Mac ↔ `flat-meadow-prod-main-01`): 6/6 cross-machine + 7/7 local-2-dir + 11/11 live control-plane + 16/16 unit.
- [x] File watcher (chokidar, swappable) with adaptive coalescing debounce; **event-driven incremental manifest patch (O(changed), not O(repo))**.
- [x] `WorkspaceSync` Durable Object (**D2**) as authoritative commit sequencer (atomic `transactionSync`, fixes the old `MAX(seq)+1` race) + hibernating WebSocket broadcaster; **WS authed via `Authorization` header**.
- [x] Daemon holds a WS to the DO; on `committed` broadcast → auto-pull. Single-flight pump, jittered safety-net + deep reconcile tiers, reconnect w/ backoff.
- [x] `rbox daemon {start|stop|status|logs}`; detached process, PID-reuse-safe.
- [x] Incremental hashing: `(mtime,size)` cache skips re-hash (fast-path only); stat→hash→stat consistency.
- **Performance (user directive):** ignore-first watching (`npm ci` → zero events, verified), low process priority, bounded-concurrency uploads, three-tier scan (incremental / stat-only safety / cache-bypassing deep).
- **Hardened beyond original scope:** precondition-checked non-destructive apply (no lost edits), shared manifest path-traversal validation (server+client), blob-existence 422, atomic local state (missing-vs-corrupt), realpath-within-root guard.
- Deferred to later: systemd/launchd service install; parallel hashing + `@parcel/watcher` for monorepo scale (M9).

### 2. Git state sync (**D6**) — ✅ DONE & VERIFIED (git-native, opt-in)
Pivoted from file-mirroring `.git` (never atomic on a live repo) to **git-native** capture: history via `git bundle`, index/HEAD/op-state via atomic single-file snapshots, stored as a manifest `git` section (not materialized in the tree). Design: [`design/02-git-mirroring.md`](./design/02-git-mirroring.md). Verified 8/8 cross-machine.
- [x] Opt-in `syncGit` (default off; `.git/hooks/` never synced — code-exec vector); preflight rejects worktree/bare/alternates/toplevel-mismatch.
- [x] Bundle capture (incl. stash + `stash create` for index blobs); stable `write-tree` identity (no echo); content-addressed artifacts ride M3.
- [x] Receiver: non-destructive object import → ref publish → temp-rename index/HEAD/op-state, transactional with **rollback on fsck failure**; fail-closed quarantine.
- [x] Whole-repo conflict preserved (remote into `refs/rbox-conflict/*` + bundle, local never clobbered); base advances only on successful apply.
- [ ] Incremental bundles (basis chain) + stash reflog fidelity — follow-ups; current full-bundle-on-change is correct.
- [ ] Quiescence detection (no `.git` writes + no `*.lock` for a debounce window).
- [ ] Snapshot `.git` as one transactional unit; assemble in temp dir, swap in atomically.
- [ ] Integrity check (HEAD/refs/index consistency) before committing a `.git` update; skip+retry if torn.
- [ ] Whole-repo-state conflict handling (never per-object).
- ⚠️ Flagged risk: quiescence is heuristic — prototype early.

### 3. Production blob path (**D3**) — ✅ DONE & VERIFIED (pulled ahead of M2)
Lifted the 25MB cap and OOM risk; unblocks M2 (large git packs). Design: [`design/03-blob-path.md`](./design/03-blob-path.md). Verified live: 50MiB single-PUT, 120MiB multipart, resume, concurrent same-sha, wrong-sha rejection, 40MB cross-machine.
- [x] Streaming single-PUT with **R2-native sha256 verification** (≤90MiB; server-side integrity, no buffering).
- [x] **R2 multipart** for large files (staging key → publish-to-canonical on R2-verify).
- [x] **Serializable resumable-upload token** in `.rbox/state/uploads/` (server-authoritative `upload_parts`); killed daemon resumes, expiry-safe.
- [x] Streamed download into apply (no whole-file buffering on either side); bounded-concurrency uploads.
- [ ] **Presigned direct-to-R2** (Worker out of the byte path) — additive SaaS cost optimization; **needs an R2 S3 API token (provisioning)**; transparent streaming fallback already in place, so this is deferred, not blocking.
- [ ] Queue-based lazy verification for multi-GB blobs — current post-publish R2 verify covers typical sizes.

### 3b. Configurable ignore patterns — ✅ DONE
`.rboxignore` is a synced, shared ignore file (read by the matcher, syncs as a normal file). `rbox ignore <glob>` / `rbox ignore --list`; precedence builtin→.gitignore→.rboxignore (negations last-win, except pruned dirs). **Forward-only**: ignoring an already-synced file stops its sync but does NOT delete copies elsewhere (delete-then-ignore to purge). Daemon rebuilds its matcher + full-rescans when `.rboxignore`/`.gitignore` changes. Verified 5/5 e2e. Design: [`design/03b-ignore.md`](./design/03b-ignore.md). (Below was the original plan.)
Today ignore rules come from `BUILTIN_IGNORE` + `.gitignore` + `.rboxignore` only (`src/engine/ignore.ts`). `buildIgnoreMatcher(root, extra)` already accepts an `extra: string[]` — the matcher plumbing exists, it's just not fed from config.
- [ ] Add an `ignore: string[]` (gitignore-syntax globs) to the **synced** project config (`rbox.yml`, **D11**) so every machine agrees on what's in-scope — ignore rules are part of the project definition, not a per-device preference.
- [ ] Wire it through: `rbox.yml.ignore` → `buildIgnoreMatcher(root, extra)` → `scanManifest`. Per-device `.rboxignore` still layers on top as a local override.
- [ ] Precedence + negation order documented (builtin → `rbox.yml` → `.gitignore` → `.rboxignore`), since `!`-unignore depends on order.
- [ ] `rbox ignore <glob>` / `rbox ignore --list` convenience commands (optional sugar over editing `rbox.yml`).
- ⚠️ Changing the ignore set changes the manifest — newly-ignored files become deletes on other machines, newly-included files become adds. Surface that as a diff preview before commit, don't silently propagate mass deletions.

### 4. Real auth — ✅ DONE & VERIFIED (self-hosted device tokens)
Per-device revocable tokens (sha256-hashed in D1) via a device-authorization flow; cleartext shared token removed (now inert server-side). Design: [`design/04-auth.md`](./design/04-auth.md). Verified 15/15 auth-flow + 7/7 daemon e2e.
- [x] Device authorization flow (**D8**): `rbox login` (bootstrap secret or device-to-device `rbox device approve <code>`); token minted on first poll (one-time claim).
- [x] Removed cleartext `RBOX_DEV_TOKEN` from `wrangler.jsonc`; `RBOX_BOOTSTRAP_SECRET` is a Wrangler secret; client token in `~/.rbox/credentials.json` (600).
- [x] `rbox device list/revoke`; immediate per-request revocation; constant-time bootstrap compare; throttled last-seen.
- [ ] External identity / user layer (**deferred**): prefer **Cloudflare Zero Trust/Access + BetterAuth** over Clerk (user pref); federates *who the human is* onto these device tokens; ties into M7. Live-WS revocation also deferred to M7 (WS is notification-only).

### 5. Encryption (**D5**) + secrets — ✅ DONE (blob-content E2EE; full-E2EE follow-up)
Opt-in client-side encryption: server stores only ciphertext for blob bodies. Design: [`design/05-encryption.md`](./design/05-encryption.md). Verified 8/8 e2e (server blob is ciphertext, keyed device decrypts, keyless locked out, dedup survives).
- [x] Convergent envelope encryption: per-blob AES-256-GCM key+nonce = HKDF(KEK, plaintext_sha) — deterministic, so dedup survives; KEK never leaves the device; DEK re-derived (never stored).
- [x] `rbox encrypt` (recovery phrase), `rbox key export/import` (device-to-device); KEK in `~/.rbox/keys/<ws>.key` (600); encryption self-describing from the manifest (`encSha`).
- [x] Fresh-hash key derivation, encrypt-to-temp→upload-by-encSha, GCM-tag + plaintext-sha verify on download.
- [ ] **Full E2EE follow-up** (chosen scope: content-only now): encrypt the MANIFEST too (currently metadata — paths/sizes/plaintext-hashes — is visible to the server); encrypt git artifact blobs (currently `syncGit`+encryption is refused together); passphrase escrow; key rotation. Opt-in `.env` sync rides on this (forced-E2EE).

### 6. Version history, trash, GC (**D7, D10**) — ✅ DONE & VERIFIED
Design: [`design/06-versions-gc.md`](./design/06-versions-gc.md). Verified 3/3 (versions/restore) + 9/9 (GC, incl. reachable-blob-survives).
- [x] `rbox versions [path]` / `rbox restore <path>@<seq>` (restores deleted files from history; decrypts encrypted blobs).
- [x] **Reachability GC**: barrier-free candidate-tagging — authoritative DO roots, GLOBAL cross-workspace reachability (file `encSha??sha256` + git + manifest shas), **never moves canonical keys**, candidate-aware existence check (re-upload resurrects, closing the dedup/GC race), fail-closed. **No per-commit ref counting.** Admin route `POST /v1/admin/gc?phase=mark|purge`.
- [x] Soft-delete: deletes recoverable from version history; GC trash = candidate-tagging + grace window before purge.
- [x] Retention prune in the DO (authoritative; never prunes head).
- [ ] Plan-gated retention windows (7/30/90d) + Cron-scheduled GC — wire with M7b plans.

### 7. Multi-tenancy & security — ✅ DONE & VERIFIED
Real accounts with enforced isolation. Design: [`design/07-multitenancy.md`](./design/07-multitenancy.md). Verified 16/16 cross-tenant isolation + 5/5 happy-path. 3 security-review rounds.
- [x] Schema: accounts/users/memberships/devices(+user_id)/workspaces(+account_id)/blob_refs/audit_log (migration 0006).
- [x] **Isolation**: per-account blob entitlement (`blob_refs`, created ONLY by hash-verified upload → no entitlement-by-reference); every workspace+blob route gated by account (cross-account → 404); account-scoped multipart + device list.
- [x] Ownership at workspace **creation** (`POST /v1/workspaces`, high-entropy id), not first-commit; `rbox link` creates/joins.
- [x] Roles (owner/admin/editor/viewer) via device→user→membership; viewer can't write (403); audit log from the authenticated principal.
- [x] Platform vs tenant: GC/admin require a platform secret (not a device token); roots/prune internal-only.
- [ ] Team cross-account sharing + pooled storage + audit UI — within-account roles done; cross-account invites are a follow-up. KEK isolation rides M5 (per-workspace keys already isolated).

### 7b. Billing, plans & metering — ✅ AUTONOMOUS CORE DONE (Stripe needs user keys)
Design: [`design/07b-billing.md`](./design/07b-billing.md). Verified 12/12 quota/accounting.
- [x] **Per-account storage accounting** — atomic `used_bytes` counter; deduped; decremented by GC purge.
- [x] **Plan-gated limits server-side** — storage cap (atomic race-safe reserve → 402), workspace count (Free=1 → 402); plan→retention/manifest-cap/feature map (`plans.ts` from pricing.md).
- [x] Usage endpoint `GET /v1/account/usage`; admin set-plan (platform secret) as the interim plan control.
- [ ] **Stripe (NEEDS USER PROVISIONING):** Stripe account + secret/webhook keys + product/price IDs → `STRIPE_SECRET`/`STRIPE_WEBHOOK_SECRET` Wrangler secrets; then `/v1/billing/checkout`, `/portal`, `/stripe/webhook` (flips `accounts.plan`/`extra_storage_bytes`). Endpoints stubbed/gated until then. Per-seat Team + `$3/100GB` add-on plumb through `extra_storage_bytes`.
- [ ] `rbox status` usage display + soft/hard signals (usage endpoint exists; CLI surfacing is a small follow-up).

### 7c. Onboarding TUI / terminal UX
First-time setup is the highest-leverage UX moment — it's where a dev decides rbox is "easy" or "another sync tool to fight." Today onboarding is bare `console.log`. Two complementary directions (want one or both):
- [ ] **chalk** ([chalk/chalk](https://github.com/chalk/chalk)) — low-cost polish on the *existing* command output: colorize `status`, conflict warnings, the post-`link` "link another machine" hint, spinners on push/pull. No flow change, just legibility. Do this first; it's nearly free.
- [ ] **OpenTUI** ([opentui.com](https://opentui.com/)) — a real interactive wizard for `rbox init` / first `link`: pick or create a workspace, choose the sync root, toggle `.env`/secrets sync (defaulting off, **D5**), approve the device (ties into device-code auth, milestone 4), and watch the first sync stream live. This is the bigger lift — an actual TUI runtime (React/Solid-style) — so gate it on auth + link being stable.
- ⚠️ Keep every TUI flow scriptable: a `--no-interactive` / flag-driven path must stay first-class so headless/Docker onboarding (the Host B story) and CI never depend on a TTY. The TUI is a layer over the flags, never the only way in.

### 8. Hydration brain (the dev-aware wedge)
- [ ] Project detection (package.json, Cargo.toml, go.mod, …) + package-manager inference.
- [ ] `rbox hydrate` (npm ci / pnpm i / cargo fetch / …) — synced `rbox.yml` commands treated as untrusted (**Security rule 7**).
- [ ] `rbox doctor` — host vs project readiness.

### 9. Hardening & scale
- [ ] Monorepo scale: per-subtree manifests, incremental scan; measure cold-scan cost on a real `~/Development`.
- [ ] Conflict-rate metrics in dogfooding (continuous sync amplifies conflicts).
- [ ] Tests for the client/sync layer (push/pull/conflict-retry) — engine is covered, client is not yet.
- [ ] `files-sdk` buy-vs-build decision for the R2 blob layer (workerd-verified; bundling caveat in prior-art §7).

---

## 🧹 Housekeeping / known debt
- Dev D1/R2 hold leftover test data (`wsTEST`, `ws_local_*`, `ws_xm_*`) — wipe before any real use.
- ~~Dev bearer token cleartext in `wrangler.jsonc`~~ — ✅ RESOLVED in M4: removed from config, replaced by per-device tokens + a Wrangler bootstrap secret; the old token is now rejected (401) server-side (history copy is inert).
- `apps/api` has no automated test (covered only by the curl smoke script); add Vitest + Miniflare.
