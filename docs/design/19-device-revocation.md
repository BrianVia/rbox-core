# Design 19 — Device Revocation (kill a lost/compromised machine)

**Status:** DESIGN, codex-reviewed over four rounds (R1: 3 CRITICAL + 6 MAJOR; R2: 2
residual CRITICAL + 3 MAJOR; R3: 1 CRITICAL + 2 MAJOR; R4: 1 concurrency race) — each
round's findings resolved in this revision (§12). Remaining items are documented residuals
/ open questions (§13), not unaddressed defects. Design-only; no code changes in this PR.

**Coordinates with:** design 12 (full E2EE — MK/roster/epoch, owned by a parallel
agent on `feat/full-e2ee`; **not assumed merged**), design 10 (pairing), design 11
(web auth), design 15 (web dashboard). Device **listing** UX lives with the web
dashboard / device-management work (the server `GET /v1/auth/devices` it consumes
already exists).

---

## 0. TL;DR + the headline finding (read this first)

The prompt's premise — "does `validateToken()` filter `WHERE revoked = 0`? if not,
setting `revoked=1` does nothing" — is **already handled**. Two corrections to the
brief, verified in source:

1. **The `revoked` column predates E2EE.** It was added in `0004_auth.sql:13` (M4,
   `revoked INTEGER NOT NULL DEFAULT 0`), **not** the E2EE migration 0011. 0011 only
   touched `pairing_tokens`.
2. **The auth path DOES enforce it.** The function is `authenticate()` (there is no
   `validateToken`), `apps/api/src/auth.ts:39`. Its token-lookup query (`auth.ts:47–49`):
   ```sql
   SELECT d.device_id, d.account_id, d.user_id, d.last_seen_at, m.role AS role
     FROM devices d LEFT JOIN memberships m ON m.account_id = d.account_id AND m.user_id = d.user_id
    WHERE d.token_hash = ? AND d.revoked = 0 AND (d.expires_at IS NULL OR d.expires_at > ?)
   ```
   `AND d.revoked = 0` is present. So **access revocation works today** for bearer
   tokens: set `revoked=1` → the next request with that token returns `null` → `401`.

This design is therefore **not** about making `revoked=1` mean something — it
already does for the CLI/device-token path. It is about everything *around* it that
is missing or unsafe:

- an **authz hole** in the existing revoke endpoint (any member, incl. `viewer`,
  can revoke any device — §3);
- **`rbox logout` does not revoke** — it only deletes the local credential
  (`auth-cmd.ts:87`); the durable CLI token (`expires_at = NULL`) stays valid forever
  server-side;
- **web revocation does not actually sign a browser out** — the SPA re-mints a fresh
  rbox token from the still-valid Clerk session on `401` (`apps/web/src/lib/api.ts:75`),
  so revoking the `web` device token is undone immediately (§6);
- **no audit trail** (`revokeDevice` never calls `audit()`);
- **`device_id` is not unique** in `devices` (only indexed — `0004_auth.sql:15`), yet
  revoke/self/last-device/audit all assume it identifies one row (§3.4);
- **the `device_auth` (device-code) cascade has a hole** — an approved code still
  mints a token even after the approver is revoked, and ignores expiry (§5.2);
- and most importantly: **cryptographic revocation is designed in doc 12 but not
  wired, and is not representable by the current schema.** `revoked=1` stops the
  *server* honoring the token; it does **nothing** to the MK/KEKs the revoked device
  already holds. Cutting a device off from **future** plaintext requires an **MK
  rotation + signed roster delta + re-wrap to survivors** (doc 12 R6′/V4-2). Doc 12
  §13.12 C3 ships v1 with `keyEpoch` pinned at 0 and "no revocation path wired yet."
  **This document designs that path — and shows the existing key tables cannot store
  a second-epoch MK wrap, so rotation needs new schema (§7).**

### Two layers, named once, used throughout

| Layer | Mechanism | What it stops | State today |
|---|---|---|---|
| **Access revocation** | server sets `devices.revoked = 1`; `authenticate()` rejects the token | the device talking to the rbox server (read, write, pull new ciphertext, mint pairing tokens) | **works for CLI tokens**; needs authz + audit + cascade + Clerk-session + uniqueness fixes |
| **Cryptographic revocation** | a survivor device (holding MK) rotates: new-epoch `accountKeyState`, roster delta marking the device `revoked`, MK′ re-wrapped to survivors, fresh recovery material, KEK′ per workspace | the revoked device decrypting **future** data even if it kept MK/KEK wraps or colludes with a malicious server | **designed (doc 12 R6′/V4-2), not wired, not yet storable (§7)** |

Access revocation is immediate and server-enforced. Cryptographic revocation is
client-authored, requires a device that holds MK, and — critically — **the account
must stop accepting new writes until rotation completes** (§6.3), or a survivor's
post-revoke commit leaks to the revoked party via a colluding server. Both layers
are required for a real "compromised machine" response.

---

## 1. Threat model — what each layer actually buys

**Scenario:** a laptop is lost/stolen. Its `~/.rbox` holds a durable device token,
device private keys, MK, and cached workspace KEKs (doc 12 §13.1 — mode-600 plaintext
files; OS-keychain storage is future hardening). The thief has full local disk.

- **Access revocation cuts the server off immediately** (next call `401`). The thief
  can no longer pull *new* commits, upload, list devices, or mint pairing tokens. If
  the server is honest, this alone denies any data the laptop hadn't already synced.
- **It does NOT protect already-synced plaintext** — that's on the stolen disk. No
  server flag claws it back; full-disk encryption on the lost machine is the only
  defense, out of scope.
- **Cryptographic revocation protects FUTURE data confidentiality** against a
  *malicious/colluding server* (or cached KEK wraps the device retained). Rotating MK
  → MK′ (re-wrapped only to survivors) + bumping `keyEpoch` → fresh per-workspace
  KEK′ means future commits use keys the revoked device can never derive. **Forward-
  only**: data under the old epoch stays readable by old-KEK holders (doc 12 R4/R6).
  Eager re-encryption of history is an offered option (§12-C3 / §11-Q4), not default.
- **Honest residual:** we cannot prove the stolen disk is offline. Crypto revocation
  assumes the worst (revoked device + colluding server) and still guarantees future-
  data confidentiality **provided no new data is written under the old epoch after
  the revoke** — hence the write-freeze in §6.3. It cannot retroactively protect what
  the device already read.

The **web dashboard never holds MK** (design 11/15 — the web session is a minted
device token, label `web`, short-lived; the browser is an account-identity + metadata
surface, not a key holder). So the web can do *access* revocation but **cannot**
author crypto rotation; it can only *request* it and surface "pending" (§6).

---

## 2. Current state (verified against source)

- **Schema:** `devices.revoked` (`0004_auth.sql:13`), `audit_log` (`0006_tenancy.sql:35`),
  `pairing_tokens` with `created_by` device (`0008_pairing.sql`), `device_auth` with no
  approver column (`0004`), `device_keys`/`account_keys`/`rosters`/`account_key_states`/
  `workspace_keys` (`0011_e2ee.sql`). `devices.device_id` is **non-unique** (index only).
- **`authenticate()`** (`auth.ts:39`) — enforces `revoked=0` + `expires_at`, hits **D1
  per request** (no in-memory token cache); throttled `last_seen` write only.
- **`revokeDevice(env, self, deviceId)`** (`auth.ts:288`):
  `UPDATE devices SET revoked=1 WHERE device_id=? AND account_id=?` — account-scoped,
  idempotent, **no role check, no audit, no cascade.** Routed `worker.ts:149–150`.
- **`listDevices`** (`auth.ts:279`), routed `worker.ts:148` (`GET /v1/auth/devices`).
- **CLI:** `rbox device revoke <id>` / `device list` (`index.ts` → `auth-cmd.ts:197/:106`);
  `rbox logout` (`auth-cmd.ts:87`) clears local creds only.
- **`audit()`** helper (`authz.ts:76`) — exists, **not** called by `revokeDevice`.
- **E2EE key inserts are all `INSERT OR IGNORE`** keyed by a single epoch-less PK
  (`keys.ts:72,119` device_keys PK=`device_id`; `keys.ts:62` account_keys single row).
  → **a survivor cannot be handed a replacement MK′ wrap** without new schema (§7).
- **Implicit pairing cascade already exists:** `redeemPairToken` (`auth.ts:174`)
  re-checks `created_by` is still `revoked=0` at redeem and fails closed. A pairing
  token minted by a since-revoked device is **already** rejected (§5.1).
- **Web re-mint on 401:** `apps/web/src/lib/api.ts:75` deletes the cached rbox token
  and re-exchanges the Clerk session for a new one — so revoking a `web` device token
  is silently undone unless the **Clerk session** is also killed (§6).

---

## 3. Server — endpoint + authorization (access layer)

Keep route `POST /v1/auth/devices/:deviceId/revoke` (already the requested
`POST /v1/devices/:id/revoke` shape, namespaced under `auth`). Harden `revokeDevice`.

### 3.1 Authorization matrix (the existing hole)

Today `revokeDevice` checks only account scope — **a `viewer` can revoke the owner's
device.** Privilege-escalation / griefing hole. New rule using `Principal.role`
(`authz.ts:5`, from `memberships`):

| Caller | Target | Result |
|---|---|---|
| any role | **their own** device (`target == self.deviceId`) | ✅ self-revoke |
| `owner` / `admin` | any device in the account | ✅ |
| `editor` / `viewer` | **another** device | ❌ `403` |
| any | a device in **another** account | ❌ `404` (uniform, no enumeration leak — mirrors `authorizeWorkspace`) |

```
# ONE atomic D1 batch — revoke + freeze commit together (no "access first, freeze later"
# gap, Codex-2 CRITICAL-B), and freeze ONLY when the target is an MK-bearing enrolled
# device (Codex-2 MAJOR-C — see below).
isMkBearing = EXISTS(SELECT 1 FROM device_keys WHERE device_id=? AND account_id=self.accountId)
batch([
  # 1. atomic authorized revoke (no SELECT-count race, §3.4 uniqueness makes it one row)
  UPDATE devices SET revoked=1
     WHERE device_id=? AND account_id=self.accountId AND revoked=0
       AND ( device_id = self.deviceId OR self.role IN ('owner','admin') ),
  # 2. set the freeze + BUMP the revocation generation IN THE SAME BATCH iff the revoke
  #    applied AND the target bore MK. revocation_seq is monotonic and bumps on EVERY
  #    crypto revoke (even while a freeze is already pending) — it is the snapshot token
  #    the rotate CAS binds to (§6.2/§7), closing the concurrent multi-revoke race.
  UPDATE account_keys
     SET rotation_pending_at = COALESCE(rotation_pending_at, ?now),
         revocation_seq = revocation_seq + 1
     WHERE account_id=self.accountId AND ?isMkBearing AND changes_of_stmt_1 == 1,
])
if stmt1.changes == 0:
    exists = SELECT 1 FROM devices WHERE device_id=? AND account_id=self.accountId AND revoked=0
    return 403 if exists else 404      # 403 = exists-but-unauthorized; 404 = absent/cross/already
audit(self, isSelf ? "device.revoke.self" : "device.revoke", target)   # §8
cascade(target)                                                         # §5 (idempotent, post-commit)
return { ok, revoked: 1, rotationRequired: isMkBearing }
```
(D1 batches run as one implicit transaction, so revoke and freeze commit or roll back
together — there is **no window** where the token is dead but writes are still flowing
under the old epoch. The `device_keys`-row check is an **optimization** to skip the
freeze for an obviously-non-crypto revoke — it is **not** the correctness predicate.
`putDeviceKeys` accepts any account `deviceId` (`keys.ts:111`; design 17 §294), so a
`device_keys` row does **not** prove the target is `active` in the signed roster.
Correctness comes from the **client-authoritative resolution** below: the freeze can
never wedge because the first MK-holder to sync **rotates-or-clears** it against the
**verified roster**, regardless of what the server guessed. So even setting the flag on
every revoke would be safe — the `device_keys` check only avoids a needless write-freeze
in the common `web` case.)

**Crypto layer vs. membership layer (reconciled honestly).** Doc 12 V4-3 makes
**every active E2EE device a full crypto-admin** — it holds MK ⇒ can sign roster /
keyState deltas, and the server (zero-knowledge) cannot inspect role intent on those
opaque appends. So the server role gate here does **not** prevent crypto-layer
griefing; it governs only (a) the *access* endpoint and (b) the only authority the
**web/no-MK** path has. We accept the V4-3 model: in E2EE v1 **anyone who can read
data holds MK and is a security-admin** (there is no read-without-MK role). If product
wants a true low-privilege role that *cannot* revoke/rotate, it must be gated at
**enrollment** (who is ever handed MK), not at the revoke endpoint — that is a future
milestone, called out, not built here. The server role gate remains as defense-in-
depth for the access layer.

### 3.2 Self-revoke and `logout`

Self-revoke is always allowed. `POST /v1/auth/devices/:self/revoke` is the primitive
behind a real `logout`: `rbox logout` should call it **then** clear local creds, so
the durable token dies server-side, not just locally (§9).

### 3.3 Propagation — no app cache, concrete D1 read path

`authenticate()` reads D1 **per request**; there is no token cache to invalidate, so
there is no staleness window from an app cache. Concretely: auth reads use the
**default D1 binding** (`env.rbox_dev_db.prepare(...)`), which targets the **primary**
and is read-your-writes consistent — we **do not** put `authenticate()` behind the D1
Sessions API read-replica path (replicas can lag). A request already *in flight* when
`revoked=1` commits completes (we revoke *future* requests; there are no long-lived
sockets — every call re-authenticates). The **web** path has a separate propagation
problem (browser re-mints from Clerk) handled in §6, not here.

### 3.4 `device_id` uniqueness (correctness precondition)

Revoke-by-`(device_id, account_id)`, self-checks, last-device counts, `approved_by`,
and audit targets all assume `device_id` identifies **one** row. The schema only has a
**non-unique index** (`0004_auth.sql:15`). IDs are random (`dev_<rand>`/`web_<rand>`),
so collisions are improbable but not prevented. **Add a UNIQUE constraint** (migration
`0013`, §10) — a unique index on `device_id` (globally unique; ids are high-entropy and
not reused). Until then, the atomic `UPDATE … WHERE device_id=? AND account_id=?` could
touch multiple rows; the unique constraint makes every assumption in this doc sound.

---

## 4. Edge cases

### 4.1 Last / only device — **never block the security action**

(Codex CRITICAL-flip.) Refusing to revoke the last device is **security-hostile**: the
entire point is to kill a *lost* durable token, and "I lost my only laptop but still
have web access" is the exact incident. So:

- **Always allow** revoking any device, including the last one. Do **not** add a
  server-side last-device block.
- The CLI/web **warns** ("this is your last signed-in device; after revoke you'll
  re-enter via `rbox login` + `rbox recover` using your recovery phrase") and requires
  an explicit confirm, but does not refuse.
- The atomic single-statement revoke (§3.1) is inherently race-safe — two concurrent
  revokes can each only flip a distinct row; there is no count-then-update window.
- **E2EE corollary:** the *crypto* revoke delta must be signed by a **surviving active
  device**. If you revoke to zero active devices, only **recovery** (RSK, doc 12 V4-1)
  can re-admit a fresh device — and recovery must itself **rotate MK** (§6.4). So
  "revoke my only device" = "I will recover-with-rotation on the replacement." Surfaced
  explicitly, never silently bricked.

### 4.2 Revoking the current device / web session

- Self-revoke prints "this machine is signed out; run `rbox login`" and clears the
  local credential.
- A web session revoking **itself** is only real if the **Clerk session** is also
  ended (§6) — otherwise the SPA re-mints. With the §6 fix, it bounces to Clerk
  re-auth. Web sessions are ~1h TTL regardless.

### 4.3 Double-revoke

Idempotent: the `WHERE … revoked=0` update yields `changes=0`; the 403/404 disambig in
§3.1 treats already-revoked as `404`. No error, no audit spam (only log `changes==1`).

---

## 5. Cascade — what else a revocation must invalidate

### 5.1 Pairing tokens it created — **already handled, keep it**

`pairing_tokens.created_by` records the minter. `redeemPairToken` (`auth.ts:174–183`)
already requires `created_by` be `revoked=0` at redeem → a token minted by a now-revoked
device **cannot mint a device.** No change required for correctness. Optional defense-
in-depth: eagerly `UPDATE pairing_tokens SET consumed_at=now WHERE created_by=? AND
consumed_at IS NULL` to free the per-account cap and make the kill auditable.

### 5.2 In-flight `device_auth` codes it approved — **a real, multi-part gap**

`device_auth` has **no approver column**, and `pollDeviceAuth` (`auth.ts:241`) on
`status='approved'` **mints with no expiry check and no live authority re-check** (it
only checks expiry while `pending`, `auth.ts:249`). So: A approves a code → A is revoked
→ pending device polls → **still gets a token.** Worse than the pairing path. Full fix:

- Add `device_auth.approved_by TEXT` (the approver `device_id`), set in
  `approveDeviceAuth`.
- In `pollDeviceAuth`, before minting on `approved`: **(a)** reject if expired
  (enforce `expires_at` for `approved`, not just `pending`); **(b)** re-check
  `approved_by` is still `revoked=0`; **(c)** re-check the approver's **membership
  still exists**; **(d)** keep the existing one-time conditional-UPDATE claim so
  check+claim+mint stay atomic (mirror `redeemPairToken`'s fail-closed live check). On
  any failure mark the code `denied` and return `denied`.
- Migration `0013`: `ALTER TABLE device_auth ADD COLUMN approved_by TEXT;`

### 5.3 What we do NOT cascade

- **Already-minted independent device tokens** the device once helped pair/approve stay
  valid — they are separate principals the user legitimately added. Revoking the lost
  laptop must not nuke the desktop it helped onboard. (User revokes those individually.)
- **Workspace ownership / data** — unaffected.

---

## 6. Cryptographic revocation — the core E2EE flow (coordinate with doc 12)

Access revocation (§3) is necessary but **not** sufficient against a revoked device
that retained MK/KEK wraps or colludes with the server. Real revocation = **rotation**
(doc 12 R6′, V4-2, V4-3). Specified here; authoritative wire formats remain doc 12's.

### 6.1 Who can do it

Only a device that **holds MK** and is **`active` in the current roster** — a CLI
device that bootstrapped/paired/recovered. **Never the web/browser** (no MK), **never
the server** (zero-knowledge). The §3.1 membership gate governs the *access endpoint*;
the rotation is gated by MK-possession + roster-active (V4-3).

### 6.2 The rotation sequence (authored client-side, stored opaquely)

A survivor device runs this when it next syncs while a revocation is pending (or runs
`rbox device revoke <id>` directly on a machine that holds MK):

1. **`refreshAccount`** — verify roster chain, keyState chain, authorized MK-wrap
   hashes (doc 12 C2/C7); assert this device is `active`. **Snapshot the revocation
   generation `G = revocation_seq`** alongside the server-revoked set — the rotate publish
   binds to `G` (step 6) so a revoke that lands mid-rotation forces a retry, not a stale
   clear (Codex-4).
2. **Roster delta vN+1 — revoke EVERY pending target, not just one** (Codex-3 MAJOR).
   Copy roster vN and set `status:"revoked"` on **all** devices that are `revoked=1` on
   the server **and** still `active` in the verified roster (the §6.5 reconciliation set),
   not only the device that triggered this sync. Sign with this device's `sigPrivKey`
   (active ⇒ admin, V4-3). **Hard invariant:** the freeze (§6.3) clears **only** when *no*
   server-revoked device remains roster-active — a survivor cannot rotate out A, clear the
   freeze, and leave B (also revoked) still trusted.
3. **Generate MK′** (fresh random 256-bit). Re-wrap MK′ **only to the devices still active
   after step 2** (RSA-OAEP, doc 12 V4-6/V4-8) — **never to any pending-revoked device** —
   **and to fresh recovery material** (new phrase/RK/RSK — a revoked device may have known
   the old phrase; R6′). Compute each `mkWrapHash` (doc 12 D5).
4. **New `accountKeyState` epoch E+1** (doc 12 V4-2): `prevStateHash` links the chain,
   `rosterVersion/rosterHash` pin the new roster, `keyEpoch++`, `mkWrapHashes` = the
   survivors' MK′ wraps, `revokedDeviceIds ∪= {all pending targets}`, signed by this
   device (admin active in epoch E). **A roster that marks any device `revoked` is valid
   only when paired with this epoch bump** (§6.6) — same-epoch revokes are rejected.
5. **Per-workspace KEK′** at the new `keyEpoch`: fresh KEK per workspace, wrap under MK′,
   CAS-publish (immutable per `(workspaceId, keyEpoch)`, doc 12 C3). **Lazy / rotation-
   on-write** per workspace.
6. **Publish atomically, bound to the snapshot generation `G`** via the new rotation
   endpoint (§7) — the server stores verbatim, cannot read it. The rotate batch is a
   **CAS on `revocation_seq == G`**: if any device was revoked since step 1 (`seq` now
   `> G`), the publish **fails `409`, the freeze stays set**, and the client re-runs from
   step 1 with the now-larger pending set — so MK′ is **never** wrapped to a device that
   was revoked mid-rotation, and the freeze clears only against the exact frontier the
   client rotated (Codex-4 race fix). **Self-verify the extended chains locally before
   posting** (doc 12 D4) so a bad rotation never wedges other clients.

After this, future commits sign at `accountEpoch=E+1` under KEK′. Doc 12 **C4** already
makes every honest client **reject** any commit whose signer is not `active` in the
current roster **OR** whose `accountEpoch` ≠ current — so even a commit the revoked
device somehow appended is rejected by every reader. That C4 disjunction is what makes
crypto revocation *enforced by readers*, not merely by the server.

### 6.3 Ordering + the write-freeze (Codex CRITICAL)

Naive "access first, rotate later" **leaks future data**: between `revoked=1` and the
rotation, an honest survivor that writes encrypts under the **old** MK/KEK, which a
colluding server can hand the revoked device. Fix — a server-enforced **account
write-freeze**, set **atomically with the revoke** and covering **every data-carrying
write**, while rotation is pending:

1. **Set `revoked=1` AND `account_keys.rotation_pending_at` in one D1 batch** (§3.1) —
   no gap between killing the token and freezing writes. The freeze is skipped for an
   obviously-non-crypto target (no `device_keys` row) as an optimization, but **even if
   the server over-sets it, the account cannot wedge** — see step 3 (rotate-or-clear).
2. **While `rotation_pending_at` is set, reject ALL old-epoch data-carrying writes for
   the account with `423 rotation_required`** — not just the commit. The push flow
   uploads encrypted **file blobs** and the **encrypted manifest** *before* the commit
   (doc 12 §13.4 / §684); a colluding server that sees old-epoch ciphertext + the commit
   body could still feed it to the revoked MK holder. Blobs are content-addressed and
   **not epoch-labeled on the wire**, so the server cannot tell old- from new-epoch
   uploads — therefore the freeze blocks **all** of: `PUT/POST /v1/blobs/*` (incl.
   multipart, `worker.ts:175+`), the encManifest upload, and the commit/`/manifests`
   append. **Reads (GET) are unaffected.** It also freezes `appendRoster`/`appendKeyState`
   so the **only** state transition allowed while pending is the atomic `/v1/keys/rotate`
   (§7, Codex-2 MAJOR-D).
3. **Resolution is client-authoritative — rotate-or-clear (the anti-wedge, Codex-3
   CRITICAL).** The first MK-holder to sync while `rotation_pending_at` is set reconciles
   against the **verified roster** (§6.5):
   - If **any** server-revoked device is still `active` in the verified roster → **rotate**
     (§6.2) for the full pending set; `/v1/keys/rotate` clears the freeze atomically (§7).
   - If **no** server-revoked device is roster-active (the server over-set the flag on a
     `web`/device-code credential that was never in the roster) → call `/v1/keys/rotate`
     with an **empty delta** (a no-op "clear-pending" that publishes no new epoch) **bound
     to the same generation `G`** to lift the freeze. If a real crypto revoke landed since
     `G`, the CAS fails and the client re-reconciles (now with something to rotate) instead
     of clearing. Honest clients take this branch only after verifying the roster shows
     nothing to revoke; a client that lies here is a legitimate MK-holder declining to
     rotate, which is outside the revoked-device threat model (documented residual).
   Either branch **always lifts the freeze on the next sync**, so the freeze can never
   become permanent regardless of the server's MK-bearing guess. A CLI revoke from an
   MK-holder takes the rotate branch immediately, so it **never encrypts or uploads
   old-epoch data after deciding to revoke** — it rotates first, then writes only under E+1.

So: **CLI-initiated revoke from an MK-holding device rotates before any old-epoch
upload** (clearing its own freeze in the rotate publish). **Web-initiated revoke
(access-only) freezes all account writes immediately**; the banner says "key rotation
pending — complete on a signed-in CLI device"; reads continue, writes are blocked until a
survivor rotates. This makes the future-data guarantee real, not aspirational. The freeze
costs write-availability — the correct trade for a security event; v1 bounds it with a
"rotate now" nudge on every survivor's client, and reconciliation (§6.5) guarantees the
next MK-holder to sync lifts it.

### 6.4 Recovery supersession (last-device case) — must rotate MK (Codex CRITICAL)

If there is **no surviving active device**, there is no signer for the revoke delta;
the path is **recovery on the replacement** (`rbox recover`). Recovery here is **not** a
plain re-wrap of the same MK — re-wrapping MK is **not revocation** (the lost device
still holds MK and could read future KEKs from a colluding server). Last-device recovery
**must perform a full rotation**: RSK (an active recovery principal, doc 12 V4-1) signs a
roster vN+1 that (a) admits the fresh device **and** (b) marks the lost device(s)
`revoked`; the client generates **MK′**, publishes a new `accountKeyState` epoch, rotates
**recovery material** (new phrase/RK/RSK), and creates fresh per-workspace **KEK′**.
Only then is the lost device cryptographically superseded. Documented as the intended
"lost my only device" flow.

### 6.5 Detecting "rotation needed" without breaking zero-knowledge

A survivor must learn a device was server-revoked. The server stays zero-knowledge; it
exposes only **metadata the account owner is already entitled to**: extend
`GET /v1/auth/devices` (or the keys/account payload) to return, **within the account**,
the set of `device_id`s with `revoked=1` plus the `rotation_pending_at` flag. A survivor
reconciles: the **reconciliation set** = every `device_id` that is `revoked=1` on the
server **and still `active` in the roster it independently verified**. Non-empty ⇒ rotate
the whole set (§6.2); empty (server over-set the flag on a credential never in the roster)
⇒ clear-pending (§6.3 step 3). Either way the next sync resolves it — **no permanent
wedge** even though `device_keys`-existence is not an authoritative MK-bearing predicate
(Codex-3 CRITICAL). `rotationRequired` from the revoke endpoint is therefore merely
advisory — a missed flag is repaired on the next sync. Leaks nothing cross-account.

### 6.6 Revocation MUST be paired with an epoch bump (seal the same-epoch bypass)

The server cannot parse the opaque roster to *detect* that a delta marks a device
`revoked` (zero-knowledge), so it cannot, by itself, force revokes through
`/v1/keys/rotate`. The bypass is sealed **client-side**, where it is authoritative
(Codex-3 MAJOR): **every honest client rejects a roster version that transitions any
device from `active`→`revoked` unless it is accompanied by a verified `accountKeyState`
epoch bump (E→E+1) whose `revokedDeviceIds` includes that device.** A revoke published
via a same-epoch `appendRoster` (no new keyState) therefore **fails `verifyAccount` on
every reader** and is inert — a malicious or buggy client cannot quietly drop a device
from the roster without the full rotation (new MK′ wraps, new epoch). This makes
`/v1/keys/rotate` the *effective* exclusive path for revocation even though the server
can't see intent: the additive endpoints can only ever produce roster deltas that
**add** a device at the current epoch; an `active`→`revoked` transition without an epoch
bump is a verification failure, not a valid state. (This rule lives in doc-12's
`verifyAccount`; stated here as the binding requirement.)

**Open coordination with doc-12's owner:** doc 12 §13.12 C3 hard-codes `keyEpoch=0`
("no revocation path wired yet"). This §6 + §7 *is* that follow-up. The two must agree
on (1) the `rotation_pending` write-freeze + rotate-or-clear semantics (§6.3/§6.5),
(2) the epoch-scoped key schema (§7), (3) reconciliation (§6.5), not the advisory flag,
as authoritative, and (4) the §6.6 `verifyAccount` rule that revocation requires an
epoch bump.

---

## 7. Schema gap — rotation is not storable today (Codex CRITICAL)

The current key tables **cannot represent a second-epoch MK wrap**, so §6 is
non-implementable as-is:

- `device_keys` PK = `device_id`; all inserts are `INSERT OR IGNORE` (`keys.ts:72,119,
  227`). A survivor already has a row → its MK′ wrap is silently dropped.
- `account_keys` is one row per account, recovery wrap `INSERT OR IGNORE` (`keys.ts:62`)
  — no second-epoch recovery wrap.
- `workspace_keys` is already epoch-scoped (PK `(workspace_id, key_epoch)`, CAS insert) —
  **this one is fine** and is the model to copy.

Required additions (migration `0013`, opaque blobs — server still never decrypts):

- **Epoch-scoped device MK wraps.** New table
  `device_mk_wraps(device_id, account_epoch, mk_wrap, mk_wrap_hash, created_at,
  PRIMARY KEY(device_id, account_epoch))`, CAS-insert (immutable per epoch). `getAccountKeys`
  returns wraps for the **current** epoch; `device_keys` keeps the long-lived
  sig/enc pubkeys (epoch-independent). (Alternatively widen `device_keys` PK to
  `(device_id, account_epoch)` — a new table is cleaner and avoids touching the v1 path.)
- **Epoch-scoped recovery wrap.** Move the recovery wrap to
  `account_recovery_wraps(account_id, account_epoch, recovery_wrap, recovery_wrap_id,
  PRIMARY KEY(account_id, account_epoch))`, CAS-insert.
- **Rotation-pending flag + generation + atomic rotation publish.** Add
  `account_keys.rotation_pending_at INTEGER` (NULL = none) and
  `account_keys.revocation_seq INTEGER NOT NULL DEFAULT 0` (monotone; bumped on every
  crypto revoke, §3.1). New endpoint `POST /v1/keys/rotate { expectedRevocationSeq: G, … }`
  = a single D1 `batch` **guarded by a CAS on `revocation_seq == G`**: append roster vN+1
  (monotone-version guard, like `appendRoster`/`keys.ts:138`), append `accountKeyState`
  epoch E+1 (guard), insert survivors' `device_mk_wraps` + `account_recovery_wraps` for
  E+1, **clear `rotation_pending_at`** — **all conditional on `revocation_seq` still equal
  to the `G` the client reconciled** (`WHERE revocation_seq = ?G`). If a revoke landed
  meanwhile (`seq > G`), every statement's guard fails → `409`, the freeze stays set, the
  client re-reconciles and retries (§6.2 step 6). The **empty/clear-pending** call (§6.3)
  is the same CAS with no new epoch — it clears the freeze only if `revocation_seq == G`
  and the verified roster shows nothing to revoke. All-or-nothing so a crash or a
  concurrent revoke can't half-rotate or stale-clear. The blob/manifest/commit paths read
  `rotation_pending_at` and reject writes with `423` while set (§6.3).
  `/v1/keys/rotate` accepts a delta signed by **either** a surviving active device **or**
  the **recovery principal (RSK)** (§6.4, doc 12 V4-1), so total-device-loss recovery can
  rotate. The **old** recovery wrap (`account_recovery_wraps` at epoch E) stays readable
  until the rotate batch commits, so a recovering device can still open MK to author E+1.

- **`/v1/keys/rotate` is the EXCLUSIVE path for rotation-critical transitions**
  (Codex-2 MAJOR-D). The existing additive endpoints — `appendRoster`, `appendKeyState`,
  `putDeviceKeys`, `admit` (`worker.ts:163–172`) — stay for **admission at the current
  epoch only** (add a device, no epoch bump, no `status:"revoked"`). They are themselves
  **frozen (`423`) while `rotation_pending_at` is set**, so the only state transition
  available during a pending rotation is the atomic rotate. The server cannot parse the
  opaque roster to *see* that a delta is a revoke/epoch-bump, so this is enforced
  structurally: epoch E+1 material can only be appended via `/v1/keys/rotate` (it is the
  sole writer of `device_mk_wraps`/`account_recovery_wraps` at a new epoch and the sole
  clearer of the freeze), and honest clients reject any roster whose `accountKeyState`
  epoch didn't arrive through a verified rotate chain (C2/C4).

`workspace_keys` (KEK′ at the new epoch) reuses the existing `putWorkspaceKey` CAS
(`keys.ts:186`) — unchanged. No *other* crypto endpoints change shape, but the additive
ones gain the pending-rotation freeze gate above.

---

## 8. Audit trail

`revokeDevice` must call `audit()` (`authz.ts:76` → `audit_log`) on success:
```
audit(env, self, isSelf ? "device.revoke.self" : "device.revoke", targetDeviceId)
```
- Log only when `changes==1` (no double-revoke spam).
- Distinguish self-revoke from admin-revoke-other so the trail shows who killed whom.
- Crypto rotation content is unauditable in plaintext (zero-knowledge), but the
  **append** of a new roster version / keyState epoch is observable (row inserted) — log
  `"account.rotate"` with the new `rosterVersion`/`accountEpoch` as target when
  `/v1/keys/rotate` runs, giving an account-level rotation history without breaking
  zero-knowledge. Also log `"web.session.revoke"` for §6 Clerk-session kills.
- `audit_log` (`account_id, actor_device, actor_user, action, target, at`) suffices; a
  future dashboard "security activity" view (design 15/17) reads it.

---

## 9. CLI surface

- **`rbox device list`** (exists) — the id source for revoke; flags `* ` self, prints
  `device_id  label  last-seen`. Add an `enrolled?`/`active-in-roster?` column so a
  key-holding device is distinguishable from a bare device-code credential.
- **`rbox device revoke <id>`** (exists) — surface `rotationRequired`; when this machine
  **holds MK**, **offer to rotate now** (run §6.2, clearing the write-freeze in the same
  publish) rather than leaving it pending. Non-MK callers print "access revoked; a
  signed-in machine with your encryption key will complete key rotation on its next
  sync (writes are paused until then)."
- **`rbox logout`** — change to **revoke-self server-side first**, then clear local
  creds (so the durable token actually dies). `--keep-remote`/`--local` preserves the
  old "forget locally, keep the token" behavior for same-machine re-login. If self is the
  **last device**, still clear locally but warn it leaves you reliant on `rbox login` +
  recovery to return (we no longer *block* it — §4.1).
- Document `rbox device revoke <lost-id>` from another machine as the canonical "I lost
  my laptop" response, followed by the rotation prompt.

---

## 10. Web dashboard surface (design 15/11) — and the Clerk-session problem

- A **Devices** view lists `GET /v1/auth/devices` with a **Revoke** per row (owner/admin
  only; API enforces §3.1, UI hides it for editor/viewer).
- **Revoking a `web` device token is not enough** — the SPA re-mints from the live Clerk
  session on `401` (`api.ts:75`). To actually sign a browser out, revocation of a `web`
  device **must also end the underlying Clerk session.** Two options (coordinate with
  design 11, which owns `/v1/web/session`):
  1. **Call Clerk's backend session-revoke API** for that session id (requires storing
     the Clerk `session_id` alongside the `web` device, e.g. in `clerk_users`/a
     `web_sessions` row) — clean, immediate, per-session.
  2. **Per-user web-session epoch:** store `users.web_sessions_valid_after`; bump it on
     "revoke all web sessions"; `/v1/web/session` refuses to mint when the **Clerk
     session's `iat`** predates it (the "sign out everywhere" hammer; per-user, no Clerk
     backend dependency). **Plumbing required (Codex-2 MAJOR-E):** the comparison must be
     against the **Clerk session's own `iat`/`sid`, NOT the rbox token mint time** — else a
     user re-mints a fresh rbox token after the bump and slips through. Today `clerk.ts:50`
     verification returns only `sub`; this option needs the verifier to also surface `sid`
     and `iat`, and the `web` device row to record the originating `sid` so a per-session
     revoke (option 1) and the epoch check (option 2) both have a stable handle.
  Recommendation: option 1 for per-session revoke; option 2 for "sign out everywhere."
  Either way, **without this the web "revoke" is theater** — call it out.
- Web revoke is **access-only** (browser has no MK). After it, show a "**Key rotation
  pending — complete on a signed-in CLI device; writes are paused**" banner; clear it
  once a survivor publishes epoch E+1 (poll §6.5).
- Revoking your **own** current web session, with the §6/option-1 fix, signs you out →
  Clerk re-auth (design 11). Harmless.

---

## 11. Schema / code deltas (summary, for the impl milestone)

No code in this PR. When built:
- `auth.ts:revokeDevice` — atomic role/self authz (§3.1), audit (§8), cascade (§5),
  freeze-pending-rotation (§6.3), `rotationRequired`.
- `auth.ts:pollDeviceAuth` / `approveDeviceAuth` — `approved_by`, expiry-on-approved,
  live approver+membership re-check, atomic claim (§5.2).
- `auth.ts:listDevices` (or keys/account) — expose in-account `revoked` ids +
  `rotation_pending` for survivor reconciliation (§6.5).
- `keys.ts` — `POST /v1/keys/rotate` atomic batch; `device_mk_wraps` /
  `account_recovery_wraps` reads keyed by current epoch (§7).
- DO commit path — reject writes with `423` while `rotation_pending_at` set (§6.3).
- Web (`/v1/web/session` + `api.ts`) — Clerk session revoke / web-session epoch (§10).
- New migration `0013_revocation.sql`: UNIQUE on `devices.device_id` (§3.4);
  `device_auth.approved_by`; `account_keys.rotation_pending_at`;
  `account_keys.revocation_seq` (generation CAS, §6.2/§7); `device_mk_wraps`;
  `account_recovery_wraps`.
- CLI `auth-cmd.ts`: `logout` server-revoke-self; `revoke` rotation prompt; `list`
  enrichment.
- E2EE engine/client (doc 12 territory): rotation authoring (§6.2/§6.4) — roster revoke
  delta, MK′ + re-wrap, keyState epoch bump + recovery rotation, KEK′ rotation-on-write.

---

## 12. Codex adversarial review

Reviewed by codex (gpt-5.5, xhigh) against the threat model and live source.
Returned **3 CRITICAL + 6 MAJOR**, all resolved in this revision:

**CRITICAL-1 — Future-data leak during "pending rotation."** "Access first, rotate
later" lets a survivor write under the old MK/KEK before rotation, readable by the
revoked device via a colluding server. **Resolved §6.3:** server-enforced **account
write-freeze** (`423 rotation_required`) until a survivor publishes epoch E+1;
CLI-initiated revoke rotates before any further write.

**CRITICAL-2 — MK′ rotation is not storable.** `device_keys` PK=`device_id` with
`INSERT OR IGNORE`, single-row `account_keys` — survivors can't receive replacement MK
wraps; "no new endpoints needed" was wrong. **Resolved §7:** epoch-scoped
`device_mk_wraps` + `account_recovery_wraps` (CAS) and an atomic `POST /v1/keys/rotate`.

**CRITICAL-3 — Recovery doesn't supersede a lost device by re-wrapping the same MK.**
**Resolved §6.4:** last-device recovery performs a **full rotation** (MK′, new keyState,
roster-revoke of lost entries, fresh recovery material, fresh KEKs), not a re-wrap.

**MAJOR — `revoked=1` enforced only for bearer tokens; web re-mints from Clerk.**
**Resolved §10:** revoking a `web` device must also end the Clerk session (backend
revoke or per-user web-session epoch); otherwise web revoke is theater.

**MAJOR — last-device guard is security-hostile + racy.** **Resolved §4.1:** never block
the security action; warn + confirm only; the revoke is a single atomic statement (no
count-then-update race).

**MAJOR — `device_auth` cascade incomplete.** **Resolved §5.2:** `approved_by` *plus*
expiry-on-approved, live approver-revoked + membership re-check, atomic claim+mint.

**MAJOR — server role authz doesn't stop crypto-layer griefing.** **Resolved §3.1:**
accept doc-12 V4-3 (every MK holder is a security-admin); the server gate is access-layer
+ web-path only; true low-privilege roles must gate *enrollment*, a future milestone.

**MAJOR — `device_id` not unique.** **Resolved §3.4:** add UNIQUE constraint in `0013`.

**MAJOR — propagation hand-wavy.** **Resolved §3.3:** auth uses the default D1 binding
(primary, read-your-writes); explicitly not the Sessions-API replica path; the web
re-mint folds into §10.

The reviewer affirmed the draft correctly (a) identified the existing revoke-other authz
hole and (b) that `authenticate()` enforces `revoked=0`. The CRITICALs were the E2EE
substance — addressed by the write-freeze (§6.3), epoch-scoped key schema (§7), and
rotating recovery (§6.4).

**Round 2** (re-review of the R1 fixes) found the write-freeze still incomplete; resolved:

- **R2-CRITICAL — freeze covered only commit, not the blobs/manifest uploaded first.**
  A survivor could upload old-epoch ciphertext, then 423 on commit; a colluding server
  already saw it. **Resolved §6.3:** the freeze rejects **all** data-carrying writes —
  `PUT/POST /v1/blobs/*` (incl. multipart), the encManifest upload, and the commit — plus
  `appendRoster`/`appendKeyState`; reads unaffected. Blobs aren't epoch-labeled, so the
  freeze is account-wide on all uploads until rotate.
- **R2-CRITICAL — revoke and freeze weren't one atomic transition.** **Resolved §3.1:**
  `revoked=1` and `rotation_pending_at` are set in **one D1 batch**, no gap.
- **R2-MAJOR — web/non-MK revoke would freeze (DoS) and wedge reconciliation.**
  **Resolved §3.1/§6.3/§6.5:** the freeze fires **only** when the target has a
  `device_keys` row (an MK-bearing enrolled device); a `web`/device-code revoke is
  access-only, never freezes, never sets a pending state nothing can clear.
- **R2-MAJOR — rotate must be the exclusive path for rotation-critical changes.**
  **Resolved §7:** `/v1/keys/rotate` is the sole writer of new-epoch wraps + freeze-clear;
  the additive endpoints are admission-only and themselves frozen while pending.
- **R2-MAJOR — Clerk option 2 underspecified; `clerk.ts` returns only `sub`.**
  **Resolved §10:** compare the **Clerk session `iat`/`sid`** (not the rbox token mint
  time); plumb `sid`+`iat` through the verifier and record `sid` on the `web` device row.
- R2 confirmed last-device recovery (§6.4) correctly rotates MK′ (not re-wrap), with the
  added note (§7) that `/v1/keys/rotate` accepts the recovery principal and keeps the old
  recovery wrap readable until the batch commits.

**Round 3** (re-review of the R2 fixes) confirmed A/B/E sound and found three more,
resolved:

- **R3-CRITICAL — `device_keys`-existence is not a sound MK-bearing predicate** (it
  accepts any account `deviceId`), so a stale/bogus row could freeze with no client able
  to clear. **Resolved §3.1/§6.3/§6.5:** the freeze predicate is only an optimization; the
  resolution is **client-authoritative rotate-or-clear** against the verified roster, so
  the freeze can never wedge no matter what the server guessed.
- **R3-MAJOR — multi-revoke under-specified** (rotate A, clear freeze, leave B trusted).
  **Resolved §6.2/§6.5:** the rotate must revoke the **entire** reconciliation set and may
  clear the freeze only when no server-revoked device remains roster-active; MK′ is never
  wrapped to a pending-revoked device.
- **R3-MAJOR — same-epoch revoke bypass via `appendRoster`.** **Resolved §6.6:** a
  binding `verifyAccount` rule — every client **rejects** an `active`→`revoked` roster
  transition not paired with a verified epoch bump — makes `/v1/keys/rotate` the effective
  exclusive revocation path even though the server can't see intent.

**Round 4** (re-review of the R3 fixes) confirmed the anti-wedge and same-epoch-bypass
fixes sound, and found one concurrency race:

- **R4 — concurrent multi-revoke TOCTOU.** A device B revoked *after* a survivor
  snapshots the pending set but *before* it publishes would get MK′ wrapped and the freeze
  cleared (B then has an MK′ wrap while server-revoked → future leak). **Resolved §3.1/
  §6.2/§7:** a monotone `account_keys.revocation_seq` bumped on every crypto revoke; the
  client snapshots `G` at reconcile; `/v1/keys/rotate` (and clear-pending) is a **CAS on
  `revocation_seq == G`** — a revoke landing mid-rotation makes the publish `409`, leaving
  the freeze set and forcing a re-reconcile that includes B. MK′ is never wrapped to a
  device revoked mid-rotation; the freeze clears only against the exact rotated frontier.

Residuals (accepted, documented): the freeze trades **write-availability** for security
during the rotation window (reconciliation §6.5 guarantees the next MK-holder lifts it);
the clear-pending branch (§6.3) trusts an MK-holder not to lie about the roster, which is
outside the revoked-device threat model; eager history re-encryption (§13-Q3) is optional
(forward-only protection by default, per doc 12 R4/R6). §6.6 + §7 require buy-in from
doc-12's `verifyAccount`/key-endpoint owner (§13-Q5).

---

## 13. Open questions for the human / doc-12 owner

1. **Write-freeze blast radius (§6.3):** freeze the **whole account** on pending rotation,
   or only the workspaces the revoked device could touch? Account-wide is simplest and
   safest; per-workspace is less disruptive but more state. Leaning account-wide for v1.
2. **Clerk-session revoke (§10):** Clerk backend session-revoke (per-session, needs us to
   persist `session_id`) vs. a per-user `web_sessions_valid_after` epoch (coarser, no
   Clerk dependency)? Owned by design 11.
3. **Eager re-encryption:** offer `rbox device revoke <id> --reencrypt-history` for full
   (not just forward) protection, or forward-only for v1? (Doc 12 R4/R6 leaves optional.)
4. **`logout` default (§9):** revoke server-side **by default** (my recommendation —
   "logout means logged out") or stay local-only with opt-in `--revoke`? Changes muscle
   memory.
5. **Rotation trigger authority (§6.5):** advisory `rotationRequired` + reconciliation, or
   a stronger signal? Reconciliation is robust to missed flags; confirm doc-12 buy-in
   since it couples access-revoke to crypto-rotate.
6. **Device-code MK (ties to §5.2 / doc 12 §14.2):** device-code joins carry no MK today;
   should the revocation milestone also let device-code carry MK (approver wraps under a
   code-derived key), or keep pairing/recovery as the only MK-bearing joins?
