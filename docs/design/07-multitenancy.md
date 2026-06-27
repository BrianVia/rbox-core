# Design 07 — Multi-Tenancy & Security (Milestone 7)

**Status:** v2 — revised after codex security review (v1 NEEDS-PASS, 4 Criticals). The entitlement primitive is kept but made non-bypassable; ownership moves to workspace-creation time; every workspace/blob route is gated; auth becomes role-aware. Pending review #2.

## v2 RESOLUTIONS (the load-bearing security fixes)
1. **Entitlement is created ONLY by hash-verified upload — never by commit [Critical-1].** `blobPut`/`multipartComplete`, after R2 verifies the bytes hash to the sha, INSERT `blob_refs(account, sha)`. **Commit's blob-existence check is ACCOUNT-SCOPED** against `blob_refs` (not global `blobs`): a manifest referencing a sha the account isn't entitled to → 422 `unsatisfied_blobs` → the client must upload it → upload requires possessing the actual bytes. So B can never gain access to A's content by referencing its sha; B must already have the bytes (in which case there's no secret to leak). Dedup-at-rest still happens (one physical blob) but access is per-account.
2. **Ownership at CREATION, not first-commit [Critical-3].** Workspaces are created via `POST /v1/workspaces` (authed) → server assigns a **high-entropy** `workspace_id` and records `(workspace_id, account_id)` immutably in D1. `rbox link` calls this (or joins an existing ws the account is a member of). The first commit verifies the workspace is owned by the caller's account; an unowned/foreign ws → 404. No first-arbitrary-commit hijack.
3. **DO loads immutable owner from D1 [Critical-3].** The DO is NOT an authz boundary by name; on bootstrap it loads the workspace's owner account from D1 and **rejects any caller whose account ≠ owner** (or lacks membership), re-checked per request. The Worker also gates before forwarding.
4. **Gate EVERY workspace+blob route [Critical-2/4].** `authenticate()` now returns the full principal `{deviceId, accountId, userId, role}` and the router threads it. Gated (404 on cross-account): blobs check/GET/PUT/multipart-*, ws latest/manifests(POST)/manifests/:seq/versions/connect. `roots`/`prune` internal-only (GC). `/v1/admin/gc` platform-internal only. `auth/devices` + revoke scoped to the caller's account.
5. **404 cross-account, 403 same-account role fail [High-5].** Cross-account = indistinguishable 404/missing, entitlement checked BEFORE any R2 lookup (no timing/existence oracle). 403 only for an authenticated same-account role failure (viewer attempting commit, non-admin audit).
6. **Roles via device→user→membership [High-6].** `devices` gains `user_id`; bootstrap creates account+user+owner-membership+device; authenticate joins `memberships` → role. Commit uses the AUTHENTICATED device/user (ignore any body `deviceId` for audit/identity). Audit rows written from the authenticated principal after success (+ notable denials).

---
_v1 draft below (superseded by the resolutions above)._

**Status (v1):** draft → pending codex (security) review.
**Implements:** roadmap M7. **Decision:** D9 (single bucket, logical isolation).
**Goal:** real accounts with enforced isolation — a device can only touch workspaces its account is a member of; one tenant can never read another's data. Team roles + audit log.

> Today everything is one implicit `account = 'default'`. The dangerous gap: **blobs are content-addressed GLOBALLY** (cross-account dedup), so without isolation, account A could fetch account B's plaintext blob if it learns/guesses the sha. This milestone closes that.

---

## 1. Schema (D1) — migration 0006
- `accounts(id, name, plan, created_at)`
- `users(id, account_id, email, created_at)` — identity comes later (M4-IdP follow-up); for now a user is created with its account.
- `devices` — add `account_id` (already defaults `'default'`; backfill/repurpose).
- `memberships(account_id, user_id, role)` — role ∈ owner|admin|editor|viewer.
- `workspaces(id, account_id, project_id, name, created_at, encrypted)` — extend the M6 registry with `account_id` (the owning account).
- `blob_refs(account_id, sha256)` — **which accounts are entitled to a blob** (the isolation key, §3).
- `audit_log(id, account_id, actor_device, action, target, at)` — Team feature.

## 2. Authorization — every workspace route checks membership
`authenticate()` already yields the device's `account_id`. Add `authorizeWorkspace(device, ws, proj)`: the workspace's `account_id` must equal the device's account (or a membership row grants access for Team shared workspaces). Applied to **commit, latest, connect, versions, manifests/:seq, prune, roots** and the blob routes (§3). A mismatch → 403 (not 404 — but see §6 enumeration note). The DO also re-checks (defense in depth): the WS `idFromName(ws/proj)` is unguessable-ish but not an authz boundary, so the DO validates the caller's account against the workspace's owning account (passed/looked up).

## 3. Blob isolation (the security crux) — entitlement, not global fetch
Content-addressed dedup is global (one ciphertext/byte-stream stored once), but **access must be per-account**. Approach: an **entitlement table** `blob_refs(account_id, sha256)`.
- On upload/commit, the account is recorded as entitled to each referenced sha (`INSERT OR IGNORE blob_refs(account, sha)`).
- **Blob GET / existence-check are gated by entitlement:** `GET /v1/blobs/:sha` returns 404 unless `blob_refs(callerAccount, sha)` exists. `blobsCheck` only reports a sha "present" if the caller is entitled (else "missing" → caller uploads it, which entitles them — and dedups at rest if the bytes already exist).
- So the physical blob is stored once (dedup preserved), but an account can only read a sha it has demonstrably possessed (uploaded or committed). Account B cannot fetch account A's blob by guessing the sha — no entitlement → 404. **This is the isolation boundary.**
- Caveat (documented): a dedup-existence check still leaks a one-bit "does the platform already have this exact content" signal across accounts via timing/has — mitigated because `blobsCheck` reports present only for entitled shas (an unentitled caller is always told "missing" and must upload). So even the existence oracle is per-account.
- GC reachability + `blob_refs`: a blob is reclaimable only when no retained manifest (any account) references it AND no `blob_refs` entitlements remain → fold entitlement into the reachable set / drop entitlements when an account's referencing manifests age out.

## 4. Team roles
- owner/admin: manage members, workspaces, billing; editor: read/write workspaces; viewer: read-only (pull, not commit).
- Enforced in `authorizeWorkspace` (role gates commit vs latest/pull). Shared workspaces: a workspace's `account_id` is the owning account; memberships of OTHER users in that account grant access by role. (Cross-account sharing is a later feature; M7 = within-account roles.)

## 5. Audit log
Append `audit_log` rows on: device bootstrap/approve/revoke, commit, member add/remove, workspace create, blob purge. Exposed via `GET /v1/audit` (admin role). Paid Team feature (gate later with M7b plans).

## 6. Files touched
| File | Change |
|---|---|
| `apps/api/migrations/0006_tenancy.sql` | accounts/users/memberships, account_id on devices/workspaces, blob_refs, audit_log |
| `apps/api/src/authz.ts` | **new** — `authorizeWorkspace`, role checks, entitlement helpers, audit append |
| `apps/api/src/worker.ts` | authorize every workspace + blob route; audit hooks |
| `apps/api/src/workspace-sync.ts` | record workspace `account_id` on first commit; DO-side account check |
| `apps/api/src/blobs.ts` | entitlement-gated GET + check; record entitlement on upload |
| `apps/api/src/auth.ts` | bootstrap/approve create account+membership; device carries real account_id |
| `apps/api/src/versions.ts` | GC respects entitlements |

## 7. Verification
- Two accounts (bootstrap A, bootstrap B with a 2nd secret OR an admin-create-account path). Account B **cannot**: GET a blob only A uploaded (404), see A's versions (403), commit to A's workspace (403), connect to A's DO (403/closed). Account A's own ops all succeed. Dedup still works WITHIN an account. Viewer role can pull but not commit. Audit log records the lifecycle events. GC across accounts never deletes a blob still entitled/referenced by either.

## 8. Open questions for review
1. Entitlement model: is `blob_refs(account, sha)` the right isolation primitive, or does cross-account dedup-at-rest still leak too much (e.g. an attacker who uploads a guessed blob becomes entitled and learns nothing new — correct?)? Is the "always tell unentitled callers it's missing" oracle truly closed?
2. 403 vs 404 for cross-account access — which avoids enumeration leaks (workspace existence, blob existence)? Probably 404 everywhere for unauthorized.
3. Multi-account bootstrap for M7 (single dev): how do we create a 2nd account to test isolation — a second bootstrap secret, or an admin `create-account`? Keep it minimal but real.
4. DO account check: the DO must know its workspace's owning account to reject foreign callers. Store account_id in DO storage on first commit; reject mismatches. Race on first commit (account not yet set)?
5. KEK isolation (prior-art §1): with M5 E2EE, cross-account dedup is safe even without blob_refs (B can't decrypt). Should multi-tenant REQUIRE encryption, or is blob_refs sufficient for plaintext workspaces? Recommend blob_refs always + encryption optional.
