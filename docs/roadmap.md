# rbox Roadmap

Status as of the initial commit (v1). What's working, what's stubbed, and what's next — in priority order. Design rationale lives in [`rbox-architecture-v2.md`](./rbox-architecture-v2.md) (decisions referenced as **D1–D11**); storage prior art in [`prior-art-files-sdk.md`](./prior-art-files-sdk.md); plans in [`pricing.md`](./pricing.md).

> **rbox is a SaaS**, not a personal tool. That shapes priorities: multi-tenant isolation, per-account quota accounting, plan-gated limits, version-retention windows, and billing are product-critical, not afterthoughts. Plan limits (storage, project/workspace counts, retention days, team roles) come straight from `pricing.md` and must be enforced server-side.

## ✅ Done & verified

- **Sync engine** (`src/engine/`) — content-addressed manifests, three-way `reconcile`, atomic apply, conflict copies, dev-aware ignore. 6/6 unit tests; mtime-isn't-identity proven.
- **Control plane** (`apps/api/`) — deployed Worker (`rbox-dev-api`), D1 `rbox-dev-db`, R2 `rbox-dev-blobs`. Manifest-as-blob (**D4**), batched missing-blob check, optimistic-concurrency 409 (**the conflict check v1 only described**), top-level error boundary. 11/11 live API tests.
- **Client** (`src/cli/`) — `link`/`push`/`pull`/`sync`/`status`, per-device root mapping. Verified locally and **cross-machine (Mac ↔ prod host)**, bidirectional + cross-machine conflict.

---

## 🔜 Next milestones (priority order)

### 1. Daemon + watcher + live push — *the headline feature*
Turns manual `push`/`pull` into passive "edit here, appears there" sync.
- [ ] File watcher (chokidar/native) with debounce; scan only changed subtrees.
- [ ] `WorkspaceSync` Durable Object (**D2**) as commit sequencer + WebSocket broadcaster; **auth the WS upgrade**.
- [ ] Daemon holds a WS to the DO; on broadcast `{sequence}` newer than local → auto-pull.
- [ ] `rbox daemon {start|stop|logs}`; run as a service on the host.
- [ ] Incremental hashing: reuse cached hash when `(mtime, size)` unchanged (mtime as fast-path only).

### 2. `.git` atomic mirroring (**D6**)
Currently `.git` is excluded entirely.
- [ ] Quiescence detection (no `.git` writes + no `*.lock` for a debounce window).
- [ ] Snapshot `.git` as one transactional unit; assemble in temp dir, swap in atomically.
- [ ] Integrity check (HEAD/refs/index consistency) before committing a `.git` update; skip+retry if torn.
- [ ] Whole-repo-state conflict handling (never per-object).
- ⚠️ Flagged risk: quiescence is heuristic — prototype early.

### 3. Production blob path (**D3**) — replace the dev shortcut
Today: Worker-mediated PUT, 25MB cap.
- [ ] Presigned direct-to-R2 upload (`/v1/blobs/upload-url` → `commit`); Worker out of the byte path.
- [ ] R2 multipart for large files.
- [ ] Serializable resumable-upload token persisted in `.rbox/state/uploads/` (prior-art §5) so a killed daemon resumes.
- [ ] Lazy streaming plaintext-hash verification in a Queue consumer.

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
