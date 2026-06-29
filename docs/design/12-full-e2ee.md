# Design 12 — Full End-to-End Encryption (zero-knowledge server)

**Status:** v2 — revised after codex adversarial crypto review (NEEDS-PASS → resolved below). v1 body kept for context; §§ marked **[v2]** supersede it.

## v2 — Resolutions to codex review (these are normative)

### R1 [v2] — Authenticated commit chain (replaces the cross-check-only envelope)
The envelope was unauthenticated → a malicious server could roll back, fork,
relabel old manifests as new, or lie about head/seq. **Fix: a signed, hash-
chained commit object.** The client builds:
```
commitBody = canonicalJSON({
  version: 2, accountId, workspaceId,
  parentSeq, parentCommitHash,         // hash chain → rollback/splice-evident
  deviceId, keyEpoch,
  encManifestSha,
  blobRefs: sortedUnique([{ encSha, size }]),
})
commitHash = SHA256(commitBody)
sig        = Ed25519.sign(deviceSigningKey, commitHash)   // P-256 ECDSA fallback (WebCrypto)
```
The server stores `commitBody + sig + commitHash` (still can't decrypt) and
returns the chain. **Clients verify from genesis**: each `parentCommitHash`
links to the prior `commitHash`; each `sig` verifies against a **device signing
pubkey** in the workspace's **device roster** (itself authenticated under
MK/KEK — see R3); and the client **pins the latest accepted `commitHash`
locally** per workspace (reject any head that isn't a descendant of the pin).
The decrypted-manifest `blobRefs` cross-check stays as an internal consistency
check, not the auth mechanism.
**Honest residual:** a hash chain is rollback-*evident*, not rollback-*proof* —
it's caught only by a client with a pinned head, or when two devices compare
heads. A *fresh recovery-only device* can still be served an old valid prefix.
Mitigation: a signed monotonic **checkpoint** (highest `seq`+`commitHash`,
HMAC'd under `HKDF(KEK,"checkpoint/v1")`, refreshed on each commit) that any
device re-derives and compares; true defense (transparency log / external
witness) is noted as future.

### R2 [v2] — Pairing: split lookup from secret (raw secret never reaches server)
v1 reused M10's token, but M10 redeem sends the **raw token** to the server
(`auth.ts:126`) — fatal if that token also derives the MK-wrap key. **Fix:**
token = `tokenId.tokenSecret`.
- Server stores `{ tokenId → sha256(tokenSecret), pairing_mk_wrap }` and, on
  redeem, receives **`tokenId` + `sha256(tokenSecret)`** (the lookup/auth proof),
  never `tokenSecret`. Constant-time compare to the stored hash.
- The client derives the MK-wrap key from `tokenSecret` **locally**
  (`HKDF(tokenSecret, "rbox/mk-wrap/v1")`) → unwraps MK. The server, lacking
  `tokenSecret`, cannot derive it.
- `pairing_mk_wrap` is **single-use** (deleted on successful redeem) + short TTL,
  bounding exposure.
**Residual (documented):** no forward secrecy — if `tokenSecret` later leaks
(scrollback) within the (now-deleted-on-use) window, MK could be unwrapped.
Stronger option (future): token-authenticated ephemeral HPKE instead of a stored
MK wrap. The device-code path (M4) gets the same split-secret treatment.

### R3 [v2] — Exact crypto parameters (no hand-rolled primitives)
- **Key separation via HKDF-SHA256 with versioned domains**, never reuse a key
  across purposes: `rbox/blob/v1`, `rbox/manifest/v1`, `rbox/commit-auth/v1`,
  `rbox/checkpoint/v1`, `rbox/mk-wrap/v1`, `rbox/kek-wrap/v1`. MK is **never used
  directly** as an AES key — only as HKDF input material.
- **AEAD:** AES-256-GCM, **fresh random 96-bit nonce per encryption**, with
  **AAD binding** `{ accountId, workspaceId|deviceId, keyEpoch, alg:"A256GCM", purpose }`.
- **Device MK-wrap:** RSA-OAEP-SHA256 (≥3072-bit) for portability across
  WebCrypto/Workers/Bun (or audited **HPKE** if X25519 available). Device key is
  encryption-only.
- **Signing:** separate **Ed25519** (P-256 ECDSA via WebCrypto where Ed25519
  isn't available). Never reuse the encryption keypair for signing.
- **Recovery KDF:** the recovery phrase is a **generated high-entropy** 24-word
  BIP39 string = 256-bit recovery key RK (full entropy → used directly; Argon2id
  only if we ever allow a user-chosen passphrase, params m=256MiB,t=3,p=1). MK is
  wrapped under RK.
- **Manifest key** = `HKDF(KEK,"rbox/manifest/v1")`, distinct from blob keys,
  **random nonce per commit** (not convergent — manifests must not be
  dedup-correlatable).

### R4 [v2] — Honest zero-knowledge claims (supersede §0's overclaim)
The server **does** learn, even fully E2EE: blob **count** per commit, the
**ciphertext-size multiset**, **encrypted-manifest size**, **commit cadence**,
**per-device cadence**, **same-workspace ciphertext equality** (a within-
workspace "does blob X exist" confirmation oracle, from convergent encryption),
and **churn over time**. It does **not** learn names/paths/contents/structure/
git refs, and **cross-account `encSha` correlation is gone** (random per-
workspace KEK). "Hides tree structure / per-file sizes" in §0 is **downgraded**:
per-file *plaintext* sizes are hidden, but ciphertext sizes (≈plaintext +tag)
and their distribution are visible. Size-bucketing/padding + cover traffic are
future hardening, not claimed now.

### R5 [v2] — Server keeps resource limits (despite opaque manifests)
Dropping `validateManifest` is fine for *path-safety* (client validates post-
decrypt) ONLY if the server still hard-caps, per commit: envelope JSON size,
`blobRefs` **count**, `encManifest` blob size, `encSha` format (`^[0-9a-f]{64}$`),
total per-commit bytes, and GC scan cost. **Quota bills the actual stored R2
ciphertext size**, never the client-supplied `size` (the client value is advisory
for GC math only and is re-checked against R2 on upload).

### R6 [v2] — Fail-closed recovery, downgrade, and real rotation
- **Recovery phrase**: generated high-entropy (R3), shown once at setup with a
  forced "no escrow — save this" ack. `rbox key backup` re-shows it only from the
  locally-cached RK (encrypted under the device key); if not cached, it can't be
  re-derived (use an existing phrase/device).
- **Fail closed**: clients reject v1/plaintext-manifest commits, reject missing/
  unknown keys, reject changed KDF/alg metadata, **never** "repair" by uploading
  plaintext, **never** accept a server-driven downgrade to non-E2EE.
- **Real revocation = rotation**, not just dropping a wrap: revoking a
  device/phrase requires a **new `keyEpoch`** — generate a fresh KEK, re-wrap MK/
  KEK, and re-encrypt (lazily on next write, or eagerly) under the new epoch.
  Data written under the old epoch stays readable by anyone who held the old KEK,
  so rotation protects **future** data; full protection needs re-encryption of
  history. `keyEpoch` is in `commitBody` so clients select the right KEK.

---
(Original v1 spec follows; superseded where it conflicts with R1–R6 above.)

**Status (v1):** DRAFT for codex adversarial (cryptography/security) review.

**Implements:** the deferred "full E2EE" milestone flagged in M5. Goal: the rbox
server (Workers + D1 + R2) becomes a **dumb encrypted-blob store + commit
sequencer** that cannot read file **contents, names, sizes-beyond-ciphertext,
tree structure, or git refs**. Encryption becomes the **default** (not opt-in).
Best done now — pre-launch, before real user data lands (greenfield: no
plaintext→E2EE migration; wipe the dev/test data).

## 0. What's hidden vs. what isn't (threat model — state it honestly)

**Hidden from the server/operator (the goal):** file contents; file names &
paths; the directory tree/structure; per-file sizes, modes, mtimes; symlink
targets; git refs/branch names/commit messages; the manifest entirely.

**NOT hidden (documented residual metadata):** that an account/workspace exists;
the **number** of encrypted blobs per commit and each **ciphertext size**
(≈ plaintext size; mitigation: optional padding — future); **commit
sequence/timing/frequency**; which **device id** committed (pseudonymous random
id, not a name); total stored bytes (billing needs it). True traffic-analysis
resistance (hiding counts/sizes/timing) is out of scope; documented as a future
hardening (size bucketing, cover traffic).

**Trust model:** security rests on the **workspace KEK never reaching the
server**. A malicious/compromised server can deny service, reorder/withhold
commits, or serve stale ciphertext, but **cannot decrypt**. It also cannot forge
a commit a client will accept (the client validates the decrypted manifest +
the envelope is authenticated — see §5).

## 1. Key hierarchy

```
recovery phrase ──Argon2id──┐
device keypair (per device) ─┤ both wrap →  Account Master Key (MK, random 256-bit)
                             │                     │  wraps (AES-256-GCM)
                             │                     ▼
                             │            Workspace KEK (random 256-bit, per workspace)
                             │                     │  HKDF(KEK, plaintextSha) →
                             │                     ▼
                             │            per-blob key + nonce (convergent, AES-256-GCM)  [M5 primitive, reused]
                             ▼
                   (MK also encrypts the manifest via a manifest subkey: HKDF(KEK,"manifest"))
```

- **Account Master Key (MK):** random 256-bit, generated client-side at bootstrap. The root of trust. Never sent to the server in cleartext.
- **Workspace KEK:** random 256-bit per workspace, **wrapped under MK** and stored server-side as an opaque blob (`AES-256-GCM(MK, KEK)`). A device with MK unwraps all its workspace KEKs.
- **Blob keys:** convergent — `HKDF(KEK, plaintextSha256, info="blob")` → key+nonce; ciphertext addressed by `encSha = sha256(ciphertext‖tag)` (the verified M5 primitive). Dedup holds **within a workspace** (same KEK), not across (different KEK) — an accepted E2EE tradeoff + a privacy win (no cross-account correlation).
- **Manifest key:** `HKDF(KEK, info="manifest:v1")` → a per-workspace manifest encryption key (distinct from blob keys). The manifest is encrypted with AES-256-GCM under this key (random nonce per commit, not convergent — manifests change every commit and must not be dedup-correlatable).

Rationale for MK between the phrase/device and the KEKs: it lets us add/revoke
devices and rotate the recovery phrase **without re-wrapping every workspace
KEK** — only MK is re-wrapped to the new device/phrase.

## 2. Key storage (all server-side material is opaque)

New D1/R2 (the server stores, never reads):
- `account_keys(account_id, mk_wrap_recovery BLOB, recovery_salt BLOB, recovery_kdf TEXT)` — MK wrapped under the Argon2id(recovery-phrase) key.
- `device_keys(device_id, account_id, pubkey BLOB, mk_wrap_device BLOB)` — each device's public key + MK wrapped to that device's pubkey (so the device can unwrap MK with its private key). Private keys never leave the device (stored in the OS keychain / `~/.rbox`, mode 600).
- `workspace_keys(workspace_id, account_id, kek_wrap_mk BLOB)` — workspace KEK wrapped under MK.

All `*_wrap_*` columns are ciphertext the server cannot open. The server's role
is storage + handing the right wrapped blob to an authenticated device.

## 3. Key distribution to a new device (the crux)

Two paths, both zero-knowledge:

**A. Pairing-carried (reuses M10 `rbox pair`).** The pairing token is a
high-entropy secret transferred out-of-band (the user copies it). Bind key
transfer to it:
1. Creating device A (`rbox pair`): wraps **MK** under a key derived from the
   pairing token (`HKDF(token, info="mk-wrap")`), uploads the wrapped-MK to the
   server keyed by the token hash (server stores opaque `pairing_mk_wrap`).
2. New device B redeems the token (M10 flow → rbox device credential) AND
   receives the `pairing_mk_wrap`; B derives the same key from the token →
   unwraps MK. B then generates its own device keypair and uploads
   `device_keys` (pubkey + MK wrapped to its own pubkey) for future unwrapping.
   The server never sees the token (only its hash) nor MK.

**B. Recovery phrase.** At bootstrap the user is shown a recovery phrase (BIP39-
style, from MK or wrapping MK). A brand-new device with no peer can recover:
enter phrase → `Argon2id` → unwrap `mk_wrap_recovery` → MK → workspace KEKs.
This is the escrow-to-self; without it (and with all devices lost) data is
**unrecoverable** (true E2EE — must be surfaced loudly at setup).

Device-code flow (M4) gets the same treatment as pairing (approver wraps MK
under a code-derived key). CLI key UX: `rbox key backup` (show phrase),
`rbox key status`.

## 4. Encrypted manifest + plaintext envelope

Today the manifest (plaintext JSON: paths/sizes/shas/git) is stored in R2 and the
DO reads it for blob-existence + GC. Under E2EE the manifest is **ciphertext**;
the server gets only a minimal **envelope** it needs to sequence + GC + bill.

**Client encrypts** the serialized manifest with the manifest key (§1) →
`encManifest` (ciphertext); `encManifestSha = sha256(encManifest)`; uploads it as
a blob (opaque). Then commits the **envelope**:

```
Envelope (plaintext, the only thing the server parses):
{
  version: 2,
  parentSequence: number,        // optimistic-concurrency (unchanged)
  deviceId: string,              // pseudonymous
  encManifestSha: string,        // address of the encrypted-manifest blob
  blobRefs: [ { encSha, size } ] // ciphertext addresses + ciphertext sizes the
                                 // manifest references — for existence/GC/quota
}
```

- `blobRefs` lets the server do **blob-existence validation** (refuse to advance
  head past a commit referencing encShas it doesn't have → 422) and **GC
  reachability** (union of `blobRefs` over retained envelopes) and **quota**
  (Σ ciphertext sizes) — all **without decrypting** anything. encShas are
  ciphertext hashes (random-looking, per-workspace-keyed) → leak only blob count
  + sizes (the documented residual).
- The envelope is **authenticated**: it's signed by the committing device, OR
  (simpler) bound by including `encManifestSha` AND having the client verify on
  pull that the envelope's `blobRefs` exactly equal the decrypted manifest's
  referenced encShas (mismatch → reject; a tampering server can't get a client
  to act on a forged envelope). Prefer the client-side cross-check (no PKI on the
  commit path) + document that the server can withhold/reorder but not forge
  accepted state.

## 5. Server changes (it stops understanding manifests)

- **Commit (DO):** validates envelope shape + `parentSequence` (409) + every
  `blobRefs.encSha` exists for the account (422) + quota (Σ size). Stores the
  `encManifest` blob + records the envelope (seq → encManifestSha + blobRefs).
  **Drops** `validateManifest` (it can't see paths) — manifest validation moves
  client-side (see below).
- **latest / manifestAt:** returns the envelope + the `encManifest` blob; the
  client decrypts.
- **GC:** reachability = union of `blobRefs` across retained roots (from
  envelopes), instead of parsing manifests. The `encManifest` blobs themselves
  are also reachable roots. Otherwise unchanged (candidate-tagging, fail-closed).
- **Entitlement/quota:** unchanged in shape (blob_refs per account on verified
  upload; used_bytes = ciphertext bytes).
- **Validation that moves CLIENT-side:** path-safety, dedup, size caps, manifest
  schema — the pulling client already "never trusts the network" and validates
  the manifest after decrypt; it now also enforces path-safety/limits there
  (reject a malicious decrypted manifest before touching disk). The server can no
  longer enforce these, so the client is the sole authority — acceptable because
  a client only ever applies manifests it can decrypt (authored by a holder of
  the workspace KEK = the user themselves).

## 6. Client changes

- Encryption is **on by default**: `init`/`createWorkspace` generates a KEK,
  wraps it under MK, uploads `workspace_keys`. No `--encrypt` flag; remove the
  opt-in path. (`cfg.encrypted` becomes always-true; keep a hidden escape hatch?
  No — default-on, no plaintext mode, to avoid footguns.)
- Push: encrypt blobs (existing M5 path) + encrypt the manifest + send the
  envelope. Pull: fetch envelope + encManifest → decrypt → **validate**
  (path-safety/limits/dedup) → reconcile/apply (existing engine).
- Key bootstrap/unwrap on `login`/`pair`/`init` (§3). Private device key in
  `~/.rbox` (600) or OS keychain.
- Git state blobs (bundle/index/op-state) encrypted under the KEK too (M5 noted).

## 7. Dedup, quota, performance

- **Dedup:** within-workspace only (convergent under one KEK). Cross-account
  dedup is gone → higher storage, but it's a privacy requirement (cross-user
  dedup is a known confirmation/correlation oracle). Quota bills ciphertext
  bytes (slightly > plaintext: GCM tag + any padding).
- **Performance:** manifest encrypt/decrypt is one AES-GCM op per commit/pull
  over the (small) manifest JSON — negligible. Blob crypto unchanged from M5.

## 8. Recovery & UX

- At bootstrap: generate MK, show the **recovery phrase**, force an
  acknowledgement ("rbox is zero-knowledge — without this phrase or another
  signed-in device, your data is unrecoverable. Save it."). `rbox key backup`
  re-shows it (re-auth required).
- Losing all devices + phrase ⇒ unrecoverable. No server escrow (would defeat
  zero-knowledge). Optionally offer an explicit, clearly-labeled opt-in escrow
  later — not in this milestone.

## 9. Migration

Greenfield: make E2EE the default for all NEW workspaces; **wipe existing
dev/test D1+R2** (no real users yet — the housekeeping item). No
plaintext→ciphertext migration path is built. Bump envelope `version` to 2;
the server rejects v1 (plaintext-manifest) commits.

## 10. Files (sketch)
| Area | Change |
|---|---|
| `apps/api/migrations/0011_e2ee.sql` | `account_keys`, `device_keys`, `workspace_keys`; envelopes table (seq → encManifestSha + blobRefs json); drop reliance on plaintext manifests |
| `apps/api/src/workspace-sync.ts` | commit/latest/GC operate on the envelope; no `validateManifest`; store opaque encManifest |
| `apps/api/src/versions.ts` | GC reachability from envelope `blobRefs` |
| `apps/api/src/keys.ts` | **new** — store/serve wrapped MK/KEK/device-key blobs (opaque) |
| `src/engine/crypto.ts` | manifest encrypt/decrypt; MK/KEK generation + wrap/unwrap; Argon2id recovery; device keypair |
| `src/cli/sync.ts` | encrypt manifest + send envelope; decrypt + **validate client-side** on pull |
| `src/cli/keystore.ts`, `auth-cmd.ts`, `menu-cmd.ts` | KEK/MK unwrap on login/pair; recovery-phrase UX; `rbox key backup` |
| client `init` | encryption default; no `--encrypt` |

## 11. Verification
- Crypto unit tests: wrap/unwrap MK (device + recovery), KEK under MK, manifest
  encrypt/decrypt round-trip, convergent blob keys (M5, keep), Argon2id KDF.
- Worker (Miniflare): commit with envelope (409/422/quota on encShas), GC
  reachability from envelopes, `validateManifest` no longer server-side.
- Client: pull rejects a decrypted manifest with a path-traversal entry (client
  is now the sole validator); envelope/manifest blobRef cross-check rejects a
  tampered envelope.
- **Zero-knowledge assertion (the headline test):** commit a workspace, then dump
  the raw R2 objects + D1 rows and `grep` for known plaintext filenames/content →
  **zero hits**. Automate this.
- E2EE key transfer e2e: device A pairs B; B unwraps MK via the token; B pulls +
  decrypts. Recovery: fresh device + phrase → MK → decrypt.

## 12. Open questions for codex
1. **Key hierarchy:** MK (random) wrapped by both device-keypair and
   Argon2id(recovery-phrase), wrapping per-workspace KEKs — sound? Better than a
   purely passphrase-derived MK? Device keypair algorithm (X25519 ECIES vs
   RSA-OAEP in WebCrypto/Workers/Bun)?
2. **Pairing-carried MK wrap:** deriving the MK-wrap key from the pairing token
   secret and storing the wrapped MK server-side keyed by token hash — does this
   weaken M10, or leak via the token? Is single-use + short-TTL enough?
3. **Envelope authenticity:** is the client-side `blobRefs == decrypted
   manifest's refs` cross-check sufficient (vs per-commit device signatures), or
   can a malicious server cause harmful client behavior (e.g. roll back to an old
   envelope, mix blobRefs)? Do we need a signed commit chain / hash chain
   (`prevEnvelopeHash`) to prevent rollback/splice?
4. **Client-only manifest validation:** safe to drop server-side
   `validateManifest`? Any cross-account/DoS risk from unvalidated envelopes
   (e.g. huge blobRefs lists, encManifest size caps)?
5. **Convergent within-workspace** still allows a same-workspace confirmation
   oracle (does blob X exist?) — acceptable, or use random per-blob keys (losing
   dedup)?
6. **Residual metadata** (blob counts/sizes/timing/deviceId) — anything there
   that's worse than I think for a dev-files product? Worth size-padding now?
7. **Manifest key separate from blob keys** + random nonce per commit — correct
   to avoid manifest dedup correlation?
8. Anything that makes this NOT actually zero-knowledge, or a key-management
   footgun that locks users out / silently weakens to non-E2EE.
