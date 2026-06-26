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

### 2. `.git` atomic mirroring (**D6**) — ⛔ BLOCKED on M3, reordered after it
Currently `.git` is excluded entirely. **Codex review found M2 hard-depends on M3** (git packs exceed the 25MB blob cap) plus 5 more blockers; building M3 first. Narrowed M2 scope + blocker list in [`design/02-git-mirroring.md`](./design/02-git-mirroring.md) §10.
- [ ] Quiescence detection (no `.git` writes + no `*.lock` for a debounce window).
- [ ] Snapshot `.git` as one transactional unit; assemble in temp dir, swap in atomically.
- [ ] Integrity check (HEAD/refs/index consistency) before committing a `.git` update; skip+retry if torn.
- [ ] Whole-repo-state conflict handling (never per-object).
- ⚠️ Flagged risk: quiescence is heuristic — prototype early.

### 3. Production blob path (**D3**) — replace the dev shortcut — 🔄 ACTIVE (pulled ahead of M2)
Today: Worker-mediated PUT, 25MB cap. Unblocks M2 (large git packs) and removes the OOM risk of buffering whole files.
- [ ] Presigned direct-to-R2 upload (`/v1/blobs/upload-url` → `commit`); Worker out of the byte path.
- [ ] R2 multipart for large files.
- [ ] Serializable resumable-upload token persisted in `.rbox/state/uploads/` (prior-art §5) so a killed daemon resumes.
- [ ] Lazy streaming plaintext-hash verification in a Queue consumer.

### 3b. Configurable ignore patterns in config
Today ignore rules come from `BUILTIN_IGNORE` + `.gitignore` + `.rboxignore` only (`src/engine/ignore.ts`). `buildIgnoreMatcher(root, extra)` already accepts an `extra: string[]` — the matcher plumbing exists, it's just not fed from config.
- [ ] Add an `ignore: string[]` (gitignore-syntax globs) to the **synced** project config (`rbox.yml`, **D11**) so every machine agrees on what's in-scope — ignore rules are part of the project definition, not a per-device preference.
- [ ] Wire it through: `rbox.yml.ignore` → `buildIgnoreMatcher(root, extra)` → `scanManifest`. Per-device `.rboxignore` still layers on top as a local override.
- [ ] Precedence + negation order documented (builtin → `rbox.yml` → `.gitignore` → `.rboxignore`), since `!`-unignore depends on order.
- [ ] `rbox ignore <glob>` / `rbox ignore --list` convenience commands (optional sugar over editing `rbox.yml`).
- ⚠️ Changing the ignore set changes the manifest — newly-ignored files become deletes on other machines, newly-included files become adds. Surface that as a diff preview before commit, don't silently propagate mass deletions.

### 4. Real auth — replace the shared token
- [ ] Device authorization flow (**D8**): `rbox login` prints a code, browser approves, device token issued.
- [ ] External identity (Clerk/Auth0/WorkOS) → map JWT `sub` → `users.id`.
- [ ] Remove the cleartext dev token from `apps/api/wrangler.jsonc`; use a Wrangler secret.

### 5. Encryption (**D5**) + secrets
- [ ] Envelope encryption (per-blob DEK wrapped by per-workspace KEK; prior-art §1).
- [ ] Convergent DEK (`HKDF(KEK, plaintext_sha256)`) so dedup survives E2EE.
- [ ] Opt-in `.env`/secrets sync, **always E2EE** when enabled.
- [ ] KEK onboarding UX (passphrase / device-to-device approval) — surface the E2EE onboarding tax honestly.

### 6. Version history, trash, GC (**D7, D10**)
- [ ] **Time-windowed retention per plan** (Free 7d / Solo 30d / Pro 90d) — prune versions past the account's window, not just "last N".
- [ ] `rbox versions <path>` / `rbox restore <path>@<n>`.
- [ ] Soft-delete trash tier before purge (prior-art §4) — recoverable propagated deletes.
- [ ] Reachability-based GC (walk live manifests + retained versions), trash → purge after grace. **No per-commit ref counting** (the v1 leak).

### 7. Multi-tenancy & security
- [ ] Full D1 schema: accounts, users, devices, memberships, workspaces, projects.
- [ ] `account_id` on every row; membership checks on every route.
- [ ] **Team tier**: shared workspaces, roles (owner/editor/viewer), pooled per-user storage.
- [ ] Audit log (workspace/device/manifest/member/blob lifecycle) — a paid Team feature per `pricing.md`.
- [ ] Per-workspace KEK isolation (prior-art §1 threat note).

### 7b. Billing, plans & metering (SaaS)
- [ ] **Per-account storage accounting** (sum of live blob sizes) — billing-critical; reuses reachability GC (milestone 6). Must be accurate enough to bill against.
- [ ] **Plan-gated limits enforced server-side**: storage caps, workspace/project counts (Free: 1 ws / 5 projects), manifest size — reject or 402 over quota.
- [ ] Stripe integration: subscriptions (Free/Solo/Pro/Team), per-seat for Team, $3/100GB add-on.
- [ ] Usage metering + soft/hard quota signals surfaced in `rbox status` and the dashboard.
- [ ] Plan → capability mapping (retention window, advanced hydration/ignore on Pro).

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
- Dev bearer token is cleartext in `wrangler.jsonc` — must not outlive the dev harness (see milestone 4).
- `apps/api` has no automated test (covered only by the curl smoke script); add Vitest + Miniflare.
