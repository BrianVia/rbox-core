# Design 20 — CLI / CI API keys (headless `rbox sync`)

> **Implementation: 🟢 BUILT (v1 beta via design 87)** — server + CLI shipped
> 2026-07-08 as `RBOX_KEY` agent sync keys. Dashboard management remains future
> work. **Do not GA before E2EE epoch rotation ships** (a leaked key is
> MK-equivalent). Status index: [`README.md`](./README.md).

**Status:** v1 beta implemented by [design 87](./87-agent-sync-keys.md);
codex adversarial review: pass 1 FAIL (4 BLOCKER + 3 HIGH + 3
MEDIUM), pass 2 confirmed those resolved but caught 2 new self-contradictions (R11/R12);
all 12 resolved in §11 (normative, amends the body). The two BLOCKER-level architectural
calls (v1 = full E2EE device carrying MK; scoped MK-less key is future work) are
deliberate and stand; the rest are named tradeoffs + §10 questions for the human.
**Implements:** the "headless token" / CI use-case implied by M4 (device tokens), M10
(pairing), M11 (web/Clerk), and design 12 (full E2EE). Goal: a user creates a
long-lived **API key** (an "rbox PAT") so a CI pipeline or script can run `rbox sync`
**one-shot, non-interactively** — no device-code approval, no paste-the-pairing-token
round trip — driven by a secret in CI.

The hard problem is **not** the credential — `devices` + `authenticate()` already mint
and validate non-expiring bearer tokens. It is **E2EE enrollment**: under design 12 the
server is zero-knowledge and *every* principal that reads or writes data needs the
Master Key (MK) / workspace KEK, which a headless robot has no human and no secure
keystore to obtain. §6 is the heart of the doc, and its honest conclusion is blunt: **a
headless CI key that can run today's `rbox sync` is, in v1, a full account-wide E2EE
device that carries MK.** There is no server-blind, scoped, MK-less key against the
*current* transport — that is a future build (§6.5), not a config flag.

---

## 1. What "API key" means here (and what it is NOT)

- **Is:** a per-account, revocable, **non-interactive** credential that lets a CI job
  run `rbox sync` (pull and/or push) against the account's workspaces, configured from
  CI secrets. Think GitHub PAT — but, under E2EE, one that necessarily carries
  data-decryption authority.
- **Is NOT:** a second auth mechanism. The bearer flows through the **exact same**
  `Authorization: Bearer` → `authenticate()` → `Principal` path the CLI already uses
  (`remote.ts`, `credentials.ts`). We do not fork the auth lookup — that is where bugs
  live. (We *do* add a server-side **route allowlist** gate on top, §11 R2.)
- **Is NOT (v1):** a scoped, MK-less, server-blind read-only token. The built transport
  (`buildAuthedRemote` → `session.ts` → `E2eeRemote.refreshAccount`) **requires MK and
  refuses to sync unless this device is `active` in the account roster**
  (`e2ee-remote.ts:213`). A no-MK / not-roster-admitted key cannot run `rbox sync` at
  all today. Scoping is §6.5 future work that needs a new transport.
- **Is NOT (v1):** a browser-only artifact. The single most important finding (§6.1) is
  that under E2EE the **web app alone cannot mint a working API key** — the browser
  (Clerk session) holds no MK. The web dashboard **manages** keys (list / label / set
  expiry / revoke); it **never** sees or generates key material (§11 R8).

---

## 2. Grounding — the real system (so reviewers can check me)

- **`devices`** (`apps/api/migrations/0004_auth.sql`, `apps/api/src/auth.ts`):
  **`token_hash` (PK = `sha256(token)`)**, `device_id` (NOT NULL, **indexed, not
  unique**), `label`, `account_id`, `user_id`, `created_at`, `last_seen_at`,
  `expires_at` (NULL = non-expiring), `revoked`. `mintDevice()` mints **non-expiring**
  tokens; `createWebSession()` mints a short-TTL one. A long-lived labelled token is a
  solved problem. **Note the PK is `token_hash`, not `device_id`** — this corrects the
  sidecar key (§3, §11 R4). `revokeDevice()` revokes by `device_id`
  (`auth.ts:287`) → revokes **every** token sharing that `device_id` (broad; §11 R4).
- **`authenticate(req, env)`** hashes the bearer, looks up a non-revoked/unexpired
  `devices` row, LEFT JOINs `memberships` for the role (absent → least-privilege
  `viewer`), throttled `last_seen_at`, returns `Principal { deviceId, accountId,
  userId, role }`. **Format gate:** `TOKEN_RE = /^[0-9a-f]{64}$/` rejects non-32-byte-hex
  *before* hashing. A prefixed PAT means extending this recognizer (§4).
- **`authorizeWorkspace(env, p, ws, proj, write)`** (`authz.ts`): cross-account/unowned
  → 404 (no enumeration); same-account + `write && role==='viewer'` → 403. The existing
  write-gate hook.
- **Default-allow authed routes (`worker.ts`):** after `authenticate()` succeeds, the
  worker exposes — **with no PAT-specific denial** — `pair/create`, `billing/checkout|
  portal`, `device approve|list|revoke`, `account/usage`, `workspaces` (create), and the
  **entire `/v1/keys/*` family** (`bootstrap`, `account`, `device`, `roster`, `admit`,
  `keystate`, `workspace`). A PAT principal inherits all of these unless we add a gate
  (§11 R2). This is the scope-enforcement gap.
- **`GET /v1/keys/account`** (`keys.ts:83`) returns the **recovery wrap, full roster
  history, full key-state chain, and every device's MK wrap** for the account — all
  account-scoped. A device must call this to operate; there is no per-workspace variant
  (§11 R3). So an operational key inherently sees account-wide key metadata.
- **E2EE keystore** (`src/cli/e2ee-keystore.ts`): files mode 600 under
  `${RBOX_HOME||~}/.rbox/e2ee/<accountId>/` — `device.json` (sig+enc keypairs),
  `mk.key` (MK), optional `rk.key`, `ws/<workspaceId>.json` (cached unwrapped KEKs).
  **`RBOX_HOME` is already an override** (`e2ee-keystore.ts:24`) — the seam a headless
  job points at provisioned material.
- **`buildAuthedRemote(root)`** (`e2ee-client.ts:203`) loads cfg + creds + **device
  secrets incl. MK**; **no MK ⇒ fail closed** (design 12 §14.2/§14.5, D6). Every sync
  call site (`push`/`pull`/`sync`/`daemon`/`versions`/`restore`) goes through it.
  `E2eeRemote.refreshAccount` additionally **rejects any principal not `active` in the
  roster** (`e2ee-remote.ts:213`). `sync()` (`sync.ts:281`) **always pulls then pushes**
  — pushing requires a roster-active signing key.
- **`credentials.ts`** already prefers env over disk: `RBOX_TOKEN` set →
  `{ token, deviceId: RBOX_DEVICE_ID||"env", remoteUrl: RBOX_API||default,
  accountId: RBOX_ACCOUNT_ID }`, no disk read.
- **E2EE reality (design 12 §14.2):** the only MK-carrying joins are **pairing** and
  **recovery** — both need a human. Bare device-code carries **no MK** and fails closed.
  Every active roster device is a **full admin** (V4-3) — it can admit/revoke/rotate.
- **Rotation status (design 12 §13.12 C3, §14):** **`keyEpoch` is fixed at 0 in v1; no
  revocation-by-rotation is wired.** The only revocation primitive today is
  `devices.revoked = 1` (immediate, per-request). Real key revocation = epoch bump +
  re-wrap (R6′) is a **forthcoming rotation/revocation milestone** — there is no
  committed doc number yet (the brief's "doc 19" is a placeholder; open item §10).

---

## 3. Storage model — reuse `devices`, add a **token-hash-keyed** `api_keys` sidecar

**Decision: keep the bearer in `devices`; do NOT fork the auth lookup; add a sidecar
`api_keys` keyed by `token_hash` (the real PK) for the key-specific, *descriptive*
metadata. Enforcement state (revoked, expiry) stays solely on `devices` — never
mirrored (§11 R10).**

```sql
-- migration 00NN_api_keys.sql
ALTER TABLE devices ADD COLUMN kind TEXT;          -- 'device' | 'api_key' | 'web' (NULL = legacy)

CREATE TABLE IF NOT EXISTS api_keys (
  token_hash     TEXT PRIMARY KEY,                  -- = devices.token_hash (1:1 with the bearer row)
  account_id     TEXT NOT NULL,
  created_by     TEXT NOT NULL,                     -- user_id who issued it (audit)
  display_prefix TEXT NOT NULL,                     -- e.g. "rbox_pat_AB12…" (NOT the secret) for the UI
  enrolled       INTEGER NOT NULL DEFAULT 0,        -- 1 = roster-admitted E2EE device (can read+write)
  created_at     INTEGER NOT NULL
  -- NO expires_at / revoked here: those live on `devices` and are enforced by authenticate()
  -- NO workspace_id / read_only here in v1: not enforceable against today's transport (§6.5)
);
CREATE INDEX IF NOT EXISTS idx_api_keys_account ON api_keys (account_id);
```

- **Why `token_hash`, not `device_id`:** `devices.device_id` is not unique, so it is not
  a valid FK target and can't distinguish two PATs that happen to collide on a
  `device_id`. Keying by `token_hash` is 1:1 with the bearer and lets revoke target the
  exact key. **Each PAT gets its own unique `device_id`** at mint (random, like
  `mintDevice`), so `revokeDevice(device_id)` revokes exactly that one key (§11 R4).
- **Sidecar is purely descriptive.** `authenticate()` is unchanged for the hot path;
  expiry/revoke enforcement is already there (`devices`). The sidecar feeds the
  dashboard and a `kind='api_key'` flag that the route allowlist (§11 R2) reads.
- **No `workspace_id`/`read_only` columns in v1.** Per §6.5 they are unenforceable
  against the current transport and the account-scoped `/v1/keys/*` endpoints; promising
  them in the schema now would be a lie. They land with the scoped-key milestone.

---

## 4. Token format

GitHub-style, leak-detectable, compatible with hash-at-rest:

```
rbox_pat_<base64url(32 random bytes)><4-char checksum>
```

- **Entropy:** 32 bytes CSPRNG (same as device tokens / `TOKEN_BYTES`).
- **Prefix `rbox_pat_`:** lets secret-scanners (GitHub/GitLab, `git-secrets`) recognize a
  leak; lets a human eyeball it.
- **Checksum suffix:** short CRC over the secret → malformed paste rejected client-side;
  low-false-positive scanner signal.
- **Hash-at-rest:** store `sha256(<full presented string>)` in `devices.token_hash`.
  Hashing the whole string (prefix included) keeps PATs and 64-hex device tokens in
  disjoint hash spaces so a prefix can never be stripped to impersonate a device token.
- **Recognizer change:** extend `authenticate()`'s `TOKEN_RE` (mirroring how
  `redeemPairToken` added `PAIR_TOKEN_ID_RE`) to also accept
  `^rbox_pat_[A-Za-z0-9_-]{43,48}$`, validate the checksum, then hash the whole string.
  Malformed → constant-shape 401 before hashing, as today.
- **Show once:** the full `rbox_pat_…` is displayed **once** by the CLI at creation
  (§7), never re-derivable.

---

## 5. CLI consumption (the headless path)

### 5.1 The CI secret is **data-decryption authority, not just an auth token** (§11 R6)
Be explicit up front: because a working CI key carries MK (§6), the secret a user puts
in their CI store is **the ability to decrypt the account's data**, not a mere bearer.
Treat it accordingly — it is closer to an SSH private key / a cloud root credential than
to a typical API token.

### 5.2 One CI secret → keystore (single source of truth; env beats disk; never argv)
**There is exactly one CI secret: `RBOX_KEY`** — an opaque bundle (base64url of a small
JSON/tar) emitted by `rbox key create-ci`. It contains **everything** the job needs:
the bearer (`rbox_pat_…`), `accountId`, the key's unique `deviceId`, the device keypair,
`mk.key`, and the cached workspace KEK(s). Users do **not** wire up `RBOX_TOKEN`/
`RBOX_ACCOUNT_ID`/`RBOX_DEVICE_ID` by hand — those are **derived from `RBOX_KEY` by
`rbox key materialize`** (§5.3), which writes the keystore and exports the few vars the
existing `credentials.ts`/`RBOX_HOME` seam already reads:

| Var the CLI reads | Meaning | How it's set |
|---|---|---|
| `RBOX_TOKEN` | the bearer (`rbox_pat_…`) | exported by `materialize` from `RBOX_KEY` |
| `RBOX_ACCOUNT_ID`, `RBOX_DEVICE_ID` | account namespace + key's device id | exported by `materialize` from `RBOX_KEY` |
| `RBOX_HOME` | dir whose `.rbox/e2ee/<accountId>/` holds the unpacked keystore | exported by `materialize`, pointing at the dir it just wrote |
| `RBOX_API` | API base (already read) | optional, plain config |

`credentials.ts` already prefers `RBOX_TOKEN` over disk, so once `materialize` has run
the existing code path works unchanged. **No secret ever passes on argv** (M10 must-fix
#4, design 12 C11: shell-history / `ps` leak): the bearer is in `RBOX_KEY`/`RBOX_TOKEN`,
never `--token <secret>` (a `--token-file <path>` is acceptable).

### 5.3 `rbox key materialize` — containment rules (§11 R6, R11)
`RBOX_KEY` unavoidably **lives in the CI secret store and is exposed to the job as an env
var** — that is simply where CI secrets live, and it is **MK-equivalent** (the honest
blast radius, §6.4). We do not pretend otherwise. What `materialize` does is keep that
single MK-bearing secret from **spreading further** than it must:

1. **Unpack to a private dir, don't fan MK out into more surfaces.** `rbox key
   materialize --dir "$RUNNER_TEMP/rbox"` decodes `RBOX_KEY` and writes the keystore
   files (`device.json`, `mk.key`, KEK cache) with mode 700/600 to a `tmpfs`/`$RUNNER_TEMP`
   dir, then prints **only** `export RBOX_HOME=… RBOX_TOKEN=… RBOX_ACCOUNT_ID=…
   RBOX_DEVICE_ID=…`. The **raw MK bytes are never re-exported into their own env var or
   echoed** — only the bearer + ids are, and MK stays in the 700 file. (The bearer in
   `RBOX_TOKEN` is auth-only; MK authority stays in the file, not duplicated across env.)
   This replaces the earlier `eval "$(rbox key env)"` framing.
2. **Best-effort wipe + mandatory expiry.** The shim registers cleanup to `rm -rf` the
   keystore dir on job exit; the key itself carries a **mandatory** expiry (§7, §11 R7),
   so a leak is time-bounded even though `RBOX_KEY` is MK-equivalent at rest.

### 5.4 CI example (GitHub Actions)
```yaml
env:
  RBOX_KEY: ${{ secrets.RBOX_KEY }}     # the ONE bundle; MK-equivalent — treat as a cloud root credential
steps:
  - run: curl -fsSL --proto '=https' https://rbox.to/install.sh | sh   # TOFU, documented (design 14 U8)
  - run: source <(rbox key materialize --dir "$RUNNER_TEMP/rbox")      # unpacks keystore (700), exports RBOX_HOME/RBOX_TOKEN/RBOX_ACCOUNT_ID/RBOX_DEVICE_ID
  - run: rbox sync                       # full pull+push for a read-write key
  # read-mostly job: prefer `rbox pull` (sync always pushes — §11 R9)
```
`RBOX_KEY` is the only thing the user wires up; `materialize` derives the rest. It is in
the CI secret store and exposed to the job — and it is MK-equivalent (§5.3, §6.4).

`rbox sync` in CI runs **one-shot** (not the daemon): scan → encrypt → commit, or pull
→ decrypt → apply, then exit.

---

## 6. The E2EE decision (the heart)

### 6.1 The tension, precisely
`buildAuthedRemote` **fails closed** unless an E2EE write context with MK/KEK is present
(D6 deleted the plaintext branch). `E2eeRemote.refreshAccount` additionally rejects any
device **not `active` in the roster**. The two MK-carrying joins (pairing, recovery)
require a human. The **browser cannot help**: the Clerk web session mints a *device
token* but holds no MK, so a web-minted credential is the §14.2 dead-end — authenticates,
then `rbox sync` fails "not enrolled for encryption." **A key minted purely in the web
app is useless for E2EE data.**

### 6.2 Options (with the exact guarantee each breaks)

- **(a) API keys only on non-E2EE / plaintext workspaces.** *Rejected.* D6 deleted the
  plaintext sync branch; E2EE is the only mode. Reviving a plaintext class to serve CI
  re-introduces the footgun D6 removed. **Breaks:** the zero-knowledge default.

- **(b) Roster-admit the key with a server-stored wrapped MK.** If the unwrap secret is
  derivable server-side → **breaks zero-knowledge outright**. If the unwrap secret lives
  only in the CI secret (server stores only the opaque RSA-OAEP MK-wrap, like a paired
  device) → zero-knowledge holds against the server, but the **CI secret now contains
  MK = full-account plaintext** and (V4-3) the key is a roster **admin**.

- **(c) Ciphertext-only push/pull, CI holds a separate key.** Pure relay works **only
  for reads** where the consumer already holds the KEK out-of-band. It **cannot push a
  valid commit** (commits must be signed by a roster-`active` key, R1′/C1) — a "dumb
  pusher" produces commits every honest client rejects. **Breaks:** writes, silently.
  And against today's transport even the *read* path won't run (refreshAccount requires
  MK + roster membership), so (c) is not buildable in v1 without §6.5's new transport.

- **(d) Hybrid: bearer + a separately-provisioned, scope-minimized unwrap secret.** The
  *aspiration* — bearer authenticates (server stays blind), unwrap material scoped to
  the least the job needs (one workspace KEK for read-only; + a roster-active sig key
  for read-write; **not MK**). **Breaks:** only what the scope implies. **But (d) is not
  achievable against the current code** — see §6.5. It is the target architecture, not
  v1.

### 6.3 Recommendation for v1 — **(b): the CI key is a full, account-wide E2EE device that carries MK**, issued by an enrolled CLI device, gated by a server-side route allowlist

Because today's transport demands MK + roster membership for *any* sync (pull or push),
the only honest, buildable v1 is: **a headless CI key is a normal E2EE device whose
secret material (device keypair + MK + cached KEKs) is generated by an already-enrolled
device and bundled into one CI secret.** It is roster-admitted exactly like a paired
device (design 12 V4-1 admission grant). Consequences, stated without euphemism:

- It **carries MK** → it can read **every workspace** in the account. **Blast radius on
  leak = full account plaintext.** This is intrinsic to E2EE + headless: there is no
  human and no hardware keystore, so the decryption authority must live in the CI secret.
- It is **roster-`active` ⇒ a full admin** (V4-3) → it can admit/revoke devices and
  (once rotation ships) rotate keys. A leak is an **account takeover**, not just data
  read.
- Therefore v1 **must**: (i) make **expiry mandatory** (§7, §11 R7); (ii) gate the PAT
  principal behind a **server-side default-deny route allowlist** (§11 R2) so a leaked
  key cannot, e.g., open a billing portal or mint pairing tokens — it can only do the
  sync + key-sync endpoints it needs; (iii) be **loud** at creation that this secret is
  account-root-equivalent; (iv) **not GA before the rotation/revocation milestone**
  (§6.4, §11 R7).

This is option (b)/(d-account-wide). It does **not** weaken zero-knowledge *against the
server* (the server still only stores the opaque MK-wrap + the hashed bearer), but it
**relocates** the full decryption authority into the CI secret. That trade is the price
of headless under E2EE, and the doc names it plainly rather than dressing it as "scoped."

### 6.4 Blast radius & revocation (state it honestly)
- A leaked CI key exposes **the whole account's data and admin authority** until revoked.
- `devices.revoked=1` (immediate) stops **new API access**. It does **not** un-leak MK or
  the cached KEKs: **the leaked bundle still decrypts all existing ciphertext**. True
  containment = **account epoch rotation + re-wrap** (new MK′/KEK′, drop the revoked
  device), which is **not wired in v1** (`keyEpoch` fixed at 0).
- **Net:** in v1 a leaked CI key's exposure of already-synced data is **not fully
  revocable**. This makes the rotation/revocation milestone a **hard GA dependency** for
  CI keys, not a footnote (§11 R7).
- **Audit:** create/revoke write an `audit_log` row (`authz.ts:audit()`); add an audit
  row per push from an `api_key` principal; `devices.last_seen_at` + the dashboard
  surface staleness. Per-account cap on outstanding keys (mirror M10's `PAIR_ACTIVE_CAP`).
- **Rate-limiting:** per-key request limits need KV/DO (deferred consistently with 04
  §6 / 10 §5 / 11 §3).

### 6.5 The scoped, MK-less read-only key is **future work that needs a new transport**
The least-privilege key the brief wants (read one workspace, no MK, server stays blind,
leak = one workspace's data) is the right end-state, but it is **not** a keystore tweak —
it requires new code, because:
1. `buildAuthedRemote`/`session.ts` hard-require MK; `E2eeRemote.refreshAccount` requires
   roster membership. A read-only key has neither → a **dedicated read-only transport**
   that takes `{ accountId, workspaceId, KEK, public roster/key-state chain }` and
   verifies the commit chain using only **public** roster keys (verification never needs
   MK) is required.
2. `GET /v1/keys/account` dumps account-wide key material; a single-workspace key needs a
   **new per-workspace key-read endpoint** (`GET /v1/keys/workspace/:ws/public` +
   scoped KEK delivery) so it never sees other workspaces' wraps.
3. A read-only key still **cannot survive a future epoch rotation** without MK (it can't
   unwrap the new `workspace_keys` row) — so even the scoped key needs a re-provisioning
   story on rotation (§11 R7). This is a design constraint to solve in that milestone,
   not hand-wave.
4. The server PAT route allowlist (§11 R2) shrinks to read-only verbs
   (`GET keys/account-public`, `GET .../latest|commits`, `GET /v1/blobs/:sha`).

Until that ships, **read-only CI** is approximated by a full E2EE device used only for
`rbox pull` (it *can* read, it just also *could* write/admin) — the privilege is not
actually reduced, so it must carry the same warnings as a read-write key. Honest, not
comfortable.

---

## 7. Creation / rotation / revocation UX

- **Create (enrolled device only):** `rbox key create-ci [--expires <dur>]` mints the
  `devices` bearer + `api_keys` row, generates the device keypair + MK self-wrap, appends
  the **roster admission** (V4-1), and prints the **one-time bundle** + a copy-pasteable
  CI snippet. **`--expires` is required** in v1 (no non-expiring CI keys — §11 R7); the
  CLI refuses without it (suggest 30/90 days).
- **Web dashboard (manage only, never sees key material — §11 R8):** lists keys (label,
  created, last_seen, expiry, `enrolled`), supports **label + revoke**. It cannot create
  a working key (no MK in the browser) and **never displays a bundle**. A
  "create CI key" button produces instructions to run `rbox key create-ci` on an enrolled
  machine (the web-initiated device-completed handshake is a documented fast-follow,
  §10).
- **Rotate:** issue new, revoke old (show-once secrets can't be re-shown). For the
  KEK/MK-bearing reality, *real* rotation (old bundle stops decrypting) = the
  epoch-rotation milestone; bearer-revoke alone is **not** full rotation pre-milestone
  (§6.4).
- **Revoke:** dashboard or `rbox key revoke <id>` → `devices.revoked=1` (immediate,
  per-request), targeting the key's **unique `device_id`** so only that key dies.

---

## 8. Server / client changes (sketch, no code here)

| Area | Change |
|---|---|
| `apps/api/migrations/00NN_api_keys.sql` | `devices.kind`; `api_keys` sidecar keyed by `token_hash` (§3) |
| `apps/api/src/auth.ts` | extend recognizer for `rbox_pat_` (§4); `createApiKey` (enrolled-device-only) reuses `mintDevice` with a unique `device_id` + mandatory `expires_at`; `listApiKeys`; revoke reuses `revokeDevice` by that `device_id` |
| `apps/api/src/worker.ts` | **default-deny PAT route allowlist** (§11 R2): a `kind='api_key'` principal may reach only the sync + key-sync routes it needs; all other authed routes (billing, pair/create, device approve, workspaces-create) → 403 for PATs. New authed routes `POST /v1/keys/api`, `GET /v1/keys/api`, `POST /v1/keys/api/:id/revoke` |
| `apps/web/` | API-keys **management** view (list/label/revoke; no creation, no bundle) |
| `src/cli/key-cmd.ts` | `rbox key create-ci`, `rbox key materialize`, `rbox key revoke` |
| `src/cli/e2ee-keystore.ts` | already honors `RBOX_HOME`; `materialize` writes the bundle to a 700 dir (§5.3); cleanup hook |

---

## 9. Verification (how we'd prove it)

- **Unit (Bun):** recognizer accepts `rbox_pat_…` / rejects malformed + bad checksum;
  `create-ci` → `materialize` round-trip produces a working keystore in a 700 dir from the
  single `RBOX_KEY`, exporting `RBOX_TOKEN`/`RBOX_ACCOUNT_ID`/`RBOX_DEVICE_ID`/`RBOX_HOME`;
  assert the raw **MK bytes stay in the 700 file and are not re-exported into their own env
  var** (the bearer + ids are; MK is not duplicated across env).
- **Miniflare:** create-api-key is **enrolled-device-only**; mandatory expiry enforced;
  **PAT route allowlist** — a PAT bearer gets 403 on `billing/portal`, `pair/create`,
  `workspaces` create, `device/approve`, but 2xx on `keys/account`+sync; revoke is
  immediate and targets one `device_id`; per-account cap → 429.
- **Headless e2e (headline):** in a clean container with only `RBOX_KEY`, materialize →
  `rbox pull` byte-identical; `rbox push` works (it's a full device); an enrolled device
  verifies+decrypts the pushed commit. `grep` server R2+D1 for plaintext → zero hits
  (the key didn't weaken zero-knowledge **against the server**).
- **Negative:** a web-only credential (no bundle) → `rbox sync` fails closed with the
  §14.2 "not enrolled" message (a browser-minted key can't silently read E2EE data);
  a revoked key → 401 next request.

---

## 10. Open questions for the human

1. **Rotation is a GA gate, not a footnote (§6.4, §11 R7).** A leaked CI key is not fully
   revocable until epoch rotation ships, and it carries MK = account root. Do we
   (a) gate CI-keys GA on the rotation milestone, or (b) ship to a closed set of users who
   accept "treat this like a cloud root key, rotate the workspace if it leaks"? My lean:
   **(a)** — do not GA headless keys before rotation.
2. **Scoped, MK-less read-only key (§6.5)** is the genuinely safe shape but needs a new
   read-only transport + per-workspace key-read endpoints. Is that worth pulling forward
   into this milestone, or is "full device for CI now, scoped later" acceptable?
3. **Read-write = admin (V4-3).** Any roster-active key is an account admin until
   per-workspace/read-only roster roles exist. Pull those roster roles forward, or accept
   admin-grade CI keys with warnings?
4. **Doc numbering.** The brief references a "revocation doc 19" that does not exist (docs
   end at 15). Where does the rotation/revocation milestone live so this doc can link it?
5. **Web-initiated issuance.** Is CLI-issues / web-manages acceptable for v1, or is
   "create from the dashboard" a launch requirement (forcing the device-completed
   provisioning handshake)?
6. **Cap + expiry defaults.** Mirror M10's cap of 5 outstanding keys? Default/forced
   expiry window (30 vs 90 days)?

---

## 11. Codex adversarial review

Codex (gpt-5.5, xhigh) reviewed the draft against the live code and returned
**VERDICT: FAIL** with 4 BLOCKER + 3 HIGH + 3 MEDIUM findings. All were correct and
load-bearing; the central error was that the draft claimed a server-blind, MK-less,
roster-less *scoped read-only* default while the built transport requires MK + roster
membership for any sync. Resolutions (this section is normative and amends the body):

- **R1 [BLOCKER] The MK-less read-only path does not run today.** `buildAuthedRemote` +
  `session.ts` require `DeviceSecrets` with MK; `E2eeRemote.refreshAccount`
  (`e2ee-remote.ts:213`) rejects any non-roster-`active` device. **Resolution:** v1 is
  re-scoped — the CI key is a **full account-wide E2EE device carrying MK** (§6.3); the
  scoped MK-less read-only key is moved to explicit future work requiring a **new
  read-only transport** (§6.5). The draft no longer claims a no-MK default, and explicitly
  forbids the "write `mk.key` but pretend it isn't MK" shortcut.
- **R2 [BLOCKER] Scope enforcement was wildly incomplete.** After `authenticate()` the
  worker default-allows `pair/create`, billing, `device approve|list|revoke`, workspace
  create, and **all `/v1/keys/*`**. **Resolution:** add a **server-side default-deny route
  allowlist** for `kind='api_key'` principals (§8, §9) — a PAT may reach only the sync +
  key-sync routes; everything else → 403. Not "viewer role + workspace authz."
- **R3 [BLOCKER] E2EE key endpoints break least privilege.** `GET /v1/keys/account`
  (`keys.ts:83`) returns the recovery wrap, full roster/key-state history, and every
  device MK wrap; `admit`/`roster`/`keystate`/`workspace` are account-scoped.
  **Resolution:** acknowledged as a reason a single-workspace PAT is **not** achievable in
  v1; §6.5 specifies the new per-workspace key-read endpoint that the scoped-key milestone
  must add. v1's full device legitimately uses these account-scoped endpoints.
- **R4 [BLOCKER] `devices` schema/FK was wrong.** `devices` PK is `token_hash`;
  `device_id` is indexed, not unique → not a valid FK target, and `revokeDevice` by
  `device_id` is broad. **Resolution:** the sidecar is **keyed by `token_hash`** (§3); each
  PAT is minted with a **unique `device_id`** so revoke targets exactly one key.
- **R5 [HIGH] "read-write but no MK" isn't a workspace-scoped writer.** A roster-active
  key is an admin; a leak yields a signing key the roster accepts (destructive signed
  metadata / DoS / invalid roster publication). **Resolution:** v1 stops proposing a
  no-MK writer; the CI key is openly a full admin device (§6.3), and the route allowlist
  (R2) plus mandatory expiry bound the foothold; true scoping is §6.5/Q3.
- **R6 [HIGH] CI-secret story was too casual.** The secret is **MK = data-decryption
  authority**, not an auth token; `eval "$(rbox key env)"` is hostile to containment.
  **Resolution:** §5.1 states it is root-equivalent; §5.3 mandates materializing to a
  **700 in-memory dir** with the **MK never entering an env var**, plus exit-time wipe.
- **R7 [HIGH] Rotation is a launch blocker, not a footnote.** Leaked KEK/MK is not
  revocable until epoch rotation; and a KEK-only key can't survive a rotation without MK.
  **Resolution:** §6.4 elevates rotation to a **hard GA dependency** (Q1); expiry is
  **mandatory** in v1 (§7); §6.5 names the "re-provision on rotation" constraint.
- **R8 [MEDIUM] Web "manages but never sees keys" contradicted the device-shown bundle.**
  **Resolution:** the browser **never** sees key material; the bundle is shown **only** by
  the CLI on the enrolled device; the dashboard is list/label/revoke only (§7, §1).
- **R9 [MEDIUM] `rbox sync` always pushes** — wrong default for read-mostly CI.
  **Resolution:** §5.4 recommends `rbox pull` for read-mostly jobs; `sync` is for
  read-write keys. (A `--pull-only` flag is a reasonable add.)
- **R10 [MEDIUM] Duplicated expiry state would drift.** **Resolution:** the sidecar holds
  **no** `expires_at`/`revoked`; enforcement stays solely on `devices` (§3).

A second codex pass confirmed R1–R10 resolved but caught two **new** contradictions I
introduced when tightening the CI-secret story; both are fixed:

- **R11 [HIGH, 2nd pass] "MK never enters an env var" contradicted the `RBOX_KEY` env in
  the example.** The bundle *is* MK-equivalent and *does* live in the CI secret store /
  job env — that's where CI secrets live. **Resolution:** §5.3 drops the overreaching
  claim and states plainly that `RBOX_KEY` is MK-equivalent at rest; `materialize`'s job
  is only to stop MK from **spreading further** (unpack to a 700 dir; export the bearer +
  ids but not the raw MK bytes as their own var), bounded by mandatory expiry.
- **R12 [MEDIUM, 2nd pass] Bundle shape was inconsistent** (separate `RBOX_TOKEN`/
  `RBOX_ACCOUNT_ID`/`RBOX_DEVICE_ID` inputs vs. "only `RBOX_KEY`"). **Resolution:** §5.2
  makes `RBOX_KEY` the single source of truth — it contains bearer + ids + keystore, and
  `materialize` derives/exports the rest. The user wires up exactly one secret.

After all resolutions the design's posture is honest: v1 ships a **full E2EE device for
CI** (MK-equivalent secret, admin-grade, mandatory-expiry, route-allowlisted, gated on the
rotation milestone for safe revocation), driven by **one** `RBOX_KEY` secret; the **scoped
MK-less read-only key** is specified as the future end-state with its required new
transport. The four original BLOCKERs and the two second-pass contradictions are resolved
in the text above; the remaining items are the deliberate, named tradeoffs and the §10
open questions for the human (chiefly: do not GA before the rotation milestone).
