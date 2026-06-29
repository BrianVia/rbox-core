# Design 12 — Full End-to-End Encryption (zero-knowledge server)

**Status:** v4 — IMPLEMENTATION SPEC, codex **PASS** (four crypto passes: design → v2, confirm → v3, pre-impl adversarial → v4, admission-binding confirm → PASS). v4 resolves the device-admission BLOCKER + 8 SHOULD-FIX and pins exact wire formats/algorithms so the build is unambiguous. **Read v4 first — it is the authoritative wire spec; v3/v2 blocks and the v1 body are context, superseded where they conflict.** Impl note (codex): clients MUST verify each MK-wrap blob hashes to the `deviceWrapHash`/`mkWrapHashes` signed in the roster/accountKeyState.

## v4 — Resolutions to codex pre-implementation review (AUTHORITATIVE wire spec)

These nine fixes make the design implementable without ambiguity. Where v4
pins a value (algorithm, encoding, preimage), that pin wins over any earlier prose.

### V4-1 [BLOCKER→resolved] — Device admission protocol (roster chicken-and-egg)
A freshly paired/recovered device is **not yet in the roster**, so its commit
signatures would be invalid — but R1′ says only an already-active device may sign
`roster vN+1`. The server must **not** be allowed to mutate the roster. Resolution
admits a new device with an **offline-verifiable admission grant**, never a server
mutation:

**Pairing / device-code admission.** The active creating device A pre-signs a
**single-use admission grant** at token-creation time. Critically, the grant binds
an **admission keypair derived from `tokenSecret`** so only the true token bearer
(never the server, which sees only `sha256(tokenSecret)` per R2) can author the
roster delta:
```
admissionSeed = HKDF(tokenSecret, salt="rbox/admission/v1", info="admission-key")  // A knows tokenSecret
(admissionPub, admissionSecret) = Ed25519-from-seed(admissionSeed)

admissionGrant = JCS({
  type: "rbox/admission-grant/v1",
  accountId, accountEpoch,
  tokenId,                       // binds the grant to exactly one pairing/device-code token
  grantId,                       // random 128-bit; recorded single-use (must be unseen in roster ancestry)
  admissionPubKey,               // = admissionPub (b64url); ties the grant to tokenSecret possession
  notAfter,                      // integer expiry (matches token TTL)
})
grantSig = Ed25519.sign(A.deviceSigKey, SHA256(admissionGrant))   // A is active+admin in rosterVersion
```
The new device B (after redeeming the token and unwrapping MK via the split
secret, R2) holds `tokenSecret` out-of-band, so it re-derives `admissionSecret`.
B generates its own Ed25519 sig keypair + RSA-OAEP enc keypair, self-wraps MK to
its RSA pubkey, builds `roster vN+1 = roster vN + {B's entry}`, and signs the
**exact delta** with the admission secret:
```
admissionSig = Ed25519.sign(admissionSecret, SHA256(JCS({
  type: "rbox/admission/v1",
  accountId, accountEpoch, grantId,
  parentRosterVersion, parentRosterHash,   // pins the precise predecessor roster
  addedDeviceEntry,                         // B's full roster entry (its sig+enc pubkeys, role, kind)
  deviceWrapHash,                           // SHA256 of B's MK-to-self RSA wrap blob
})))
```
Clients accept B's admission iff ALL hold: (a) `grantSig` verifies against a
device `active`+`admin` in `roster vN`; (b) `admissionSig` verifies against the
grant's `admissionPubKey` over the delta B actually applied; (c) `grantId` is
unseen in roster ancestry (single-use) and `accountEpoch`/`notAfter` are valid;
(d) the roster diff is **exactly one added device** — no other additions,
revocations, role changes, or mutations; (e) B's `sigPubKey` proves possession by
signing the roster (normal roster-sig rule). Because `admissionSecret` comes only
from `tokenSecret`, a malicious server cannot substitute its own device keys —
forging `admissionSig` would require `tokenSecret`, which it never receives. A
need not be online at redeem time.

**Recovery admission (all devices lost).** There is no active device to grant, so
**recovery material is itself a roster authority.** At bootstrap (and re-bound on
each epoch rotation) a **recovery signing key** `RSK` (Ed25519, derived from RK —
see V4-9) has its pubkey recorded in the roster as a principal with
`role:"admin", kind:"recovery"`. A recovery device holding RK derives RSK and
signs its own `roster vN+1` admitting the fresh device. Recovery admission thus
roots in MK/RK (held only by the user), never the server.

### V4-2 [SHOULD-FIX] — Epoch transition is one signed object (`accountKeyState`)
Rotation (V4 supersedes R6′) is bound atomically by a canonical signed object,
hash-chained across epochs:
```
accountKeyState_v{E} = JCS({
  type: "rbox/account-key-state/v1",
  accountId, accountEpoch: E,
  prevStateHash,                 // SHA256(accountKeyState_v{E-1}); genesis = 64×"0"
  rosterVersion, rosterHash,     // pins the roster valid at this epoch
  keyEpoch,                      // workspace KEK epoch selector (monotone)
  mkWrapHashes: sortedUnique([...]),   // hashes of the MK-wrap blobs valid this epoch (device + recovery)
  recoveryWrapId,                // id of the MK-under-RK wrap valid this epoch
  revokedDeviceIds: sortedUnique([...]),
})
stateHash = SHA256(accountKeyState_v{E}); stateSig = Ed25519.sign(adminActiveInPrevEpoch, stateHash)
```
Genesis (E=0) is signed by the bootstrap device. Clients **verify the epoch chain**
(`prevStateHash` links), require `rosterHash` to equal the roster they
independently verified, and **reject any new-epoch key material** (MK′/KEK′ wraps,
commits at `accountEpoch=E`) unless a valid `accountKeyState_v{E}` exists signed by
an admin **active in epoch E−1** (genesis: the bootstrap device). This kills
mix-and-match of stale wraps / roster-epoch mismatch.

### V4-3 [SHOULD-FIX] — Admin authority: every active E2EE device is a full admin (v1)
v1 is explicit: **every `active` device in the roster has `role:"admin"`** — it may
admit, revoke, and rotate. This is not a downgrade: any active device already holds
MK ⇒ already has total **read** access to all data; matching **write/sign**
authority is the natural pair. The honest residual: a compromised active device is
a full account takeover until revoked (revocation = rotation, V4-2). Non-admin /
read-only roles are reserved for a future milestone (roster carries `role` already,
so adding them later is a roster-schema extension, not a rework).

### V4-4 [SHOULD-FIX] — Exact `commitBody` preimage (consensus-critical)
This is the final, authoritative preimage (supersedes the R1/v3 snippets):
```
commitBody = JCS({
  type: "rbox/commit/v1",
  accountId, accountEpoch, workspaceId,
  seq, parentSeq, parentCommitHash,    // REQUIRE seq === parentSeq + 1
  rosterVersion, keyEpoch,
  deviceId,
  encManifestSha,                      // ^[0-9a-f]{64}$
  blobRefs: sortedUniqueByEncSha([{ encSha, size }]),   // see V4-7
})
commitHash = SHA256(utf8(commitBody))
sig        = Ed25519.sign(deviceSigKey, commitHash)
```
Genesis sentinel: `seq=1, parentSeq=0, parentCommitHash = 64×"0"`. `seq` is now
**inside** `commitHash`. The monotonic checkpoint signs
`JCS({type:"rbox/checkpoint/v1", accountId, workspaceId, accountEpoch, seq, commitHash, rosterVersion})`.

### V4-5 [SHOULD-FIX] — Blob crypto: constant AAD, epoch-scoped KEK
```
(blobKey, blobNonce) = HKDF-SHA256(ikm=KEK_{keyEpoch}, salt="rbox/blob/v1", info=plaintextSha)
                       → key=bytes[0:32], nonce=bytes[32:44]
blob AAD = ascii("rbox/blob/v1")     // CONSTANT — never path/seq/commit/epoch
```
The KEK is **per-(workspace, keyEpoch)**: a `keyEpoch` bump means a *fresh* KEK, so
a convergent `(key,nonce)` pair never recurs across epochs. Identical plaintext
within one (workspace,keyEpoch) → identical ciphertext = the intended dedup; this
is the *only* place a `(key,nonce)` repeats and it repeats with **identical AAD and
identical plaintext**, so it is not GCM nonce-reuse. **Forbidden:** putting
commit/path/seq/epoch into blob AAD (would break convergence into a real reuse
vuln). Manifests + wraps are non-convergent (V4-6).

### V4-6 [SHOULD-FIX] — Three explicit wrap wire formats, each context-bound
- **AES-GCM wrap** (KEK-under-MK, MK-under-RK):
  `{ v:1, kind:"aesgcm-wrap", alg:"A256GCM", nonce:<96-bit random b64url>, ct:<b64url>, aad:<canonical> }`
  where `aad = JCS({accountId, accountEpoch, keyEpoch?, wrappedKeyKind, recipientKeyHash, purpose})`.
- **RSA-OAEP device wrap** (MK-to-device): RSA-OAEP has **no GCM nonce** — bind
  context via the **OAEP label**:
  `{ v:1, kind:"rsa-oaep-wrap", alg:"RSA-OAEP-3072-SHA256", recipientKeyHash, ct:<b64url> }`,
  `label = SHA256(JCS({accountId, accountEpoch, recipientKeyHash, wrappedKeyKind:"MK", purpose:"rbox/mk-wrap/device/v1"}))`.
- **HPKE** — reserved/future.
"Random 96-bit nonce for all wraps" (v3 R3″) is corrected: it applies **only to
AES-GCM wraps**. Every wrap binds account, epoch, recipient-key hash, key kind, and
purpose; clients reject a wrap whose bound context ≠ expected.

### V4-7 [SHOULD-FIX] — JCS hardening (duplicate keys, safe integers, blobRefs)
- Canonical bytes are built from **objects we construct in memory** (never
  parse-then-reserialize untrusted input). To **verify** a received signed object,
  canonicalize with a routine that: rejects **duplicate property names** at parse,
  requires every numeric field be a **non-negative integer ≤ 2^53−1**
  (`Number.isSafeInteger`) else reject, and emits RFC 8785 form (sorted keys, UTF-8,
  no insignificant whitespace).
- `blobRefs` is **unique by `encSha`** (one entry per encSha; duplicate `encSha` →
  reject), sorted by `encSha`. `size` MUST equal the **actual stored R2 ciphertext
  byte length** (server re-checks on upload; client value is advisory for GC only).

### V4-8 [SHOULD-FIX] — Pinned algorithms + key encodings (no substitution)
v1 mandatory, single set (P-256 fallback **dropped** for v1 — client is Bun, which
has Ed25519; keeping one set removes the raw-vs-DER ambiguity):
- **Signatures:** Ed25519, signature = **raw 64 bytes** (b64url on the wire).
- **Device wrap:** RSA-OAEP, **3072-bit**, SHA-256.
- **Key encodings:** `sigPubKey` = Ed25519 raw 32-byte (b64url); `encPubKey` =
  RSA **SPKI DER** (b64url). `recipientKeyHash = SHA256(encPubKey-DER)` (hex).
- Each roster entry carries `sigAlg:"Ed25519"`, `encAlg:"RSA-OAEP-3072-SHA256"`;
  clients **reject unknown/substituted algorithms** before any verify.

### V4-9 [SHOULD-FIX] — Recovery: exact RK bytes, derive RSK, drop Argon2id
- Generate 256-bit entropy `E` (32 bytes, CSPRNG). Recovery phrase = **BIP39(E)**
  (24 words incl. checksum), shown once.
- **`RK` = the 32-byte BIP39 entropy `E`** (after checksum validation + NFKD
  normalization to recover `E` from the mnemonic) — **not** the BIP39 PBKDF2 seed,
  **not** the UTF-8 of the mnemonic.
- Derivations: `rkWrapKey = HKDF(RK, salt="rbox/recovery/v1", info="mk-wrap")`
  (wraps MK, AES-GCM per V4-6); `RSK = Ed25519-from-seed(HKDF(RK,
  salt="rbox/recovery/v1", info="recovery-sign"))` (the recovery admin signer,
  V4-1). MK is wrapped under `rkWrapKey`, **never** RK directly.
- **Argon2id is removed from this milestone** (it was only for a hypothetical
  user-chosen passphrase). §11 verification drops the Argon2id test.

**Residual wording (per codex):** R1″'s fresh-device-rollback gap also covers
**fork/equivocation** (server shows different valid heads to different devices) —
same transparency-log/witness residual, documented, deferred. R4's metadata
residuals stand (encrypted-manifest size + ciphertext-size multiset visible).

---

## v3 — Resolutions to codex confirm review (normative; amend R1/R3/R6)

### R6′ — Revocation rotates the ROOT, not just the KEK
A revoked device/phrase held **MK**, so re-wrapping a fresh KEK under the *same*
MK doesn't protect future data (a complicit server could hand the revoked party
the new KEK wrap). **Real revocation bumps an account epoch and rotates the
root:** generate **MK′**, wrap MK′ **only to the remaining trusted devices'
keypairs + fresh recovery material** (new phrase), then generate **KEK′** per
workspace, wrap KEK′ under MK′, and encrypt future commits under KEK′
(`keyEpoch++`). The revoked principal keeps whatever it already saw (old data
under old KEK stays exposed to it — only **forward** protection is achievable
without history re-encryption; offer eager re-encryption as an option). Account
epoch + `keyEpoch` appear in `commitBody` and the roster so clients select the
right keys and reject pre-rotation material from revoked signers.

### R1′ — Device roster is an explicit signed, versioned, hash-chained object
```
roster_v{N} = canonicalJSON({
  version: N, accountId, accountEpoch,
  prevRosterHash,                       // roster hash chain
  devices: [{ deviceId, sigPubKey, encPubKey, addedAt, status: "active"|"revoked" }],
})
rosterHash = SHA256(roster_v{N});  rosterSig = Ed25519.sign(adminDeviceSigKey, rosterHash)
```
- **Genesis trust:** roster v0 is created by the bootstrap device; its signing
  pubkey is bound to **MK** (stored in MK-authenticated account setup), so any
  device holding MK (via pairing/recovery) verifies the genesis signer — roster
  trust roots in MK, not the server.
- **Admission/revocation:** only a device whose `sigPubKey` is `active` in
  roster v{N} may sign roster v{N+1} (adding/revoking a device). Clients verify
  the roster chain from v0, each `rosterSig` against the then-active set.
- **Binding to commits:** `commitBody` carries `rosterVersion` (+ `accountEpoch`);
  a commit's `sig` is valid only if its signer is `active` in that roster
  version. Clients **pin the latest roster version** (like head pinning) and
  reject roster rollback for devices with local state.

### R1″ — Checkpoint honestly cannot stop fresh-device rollback
The HMAC checkpoint detects rollback **only for a device with prior local pinned
state** (head/roster). A **fresh recovery-only device** can still be served a
stale-but-validly-signed head/checkpoint/roster — this is **unresolved without
an external transparency log / witness or out-of-band head confirmation**, and
is documented as an accepted residual for now (transparency log = future work).

### R3′ — Canonicalization is pinned (consensus-critical for `commitHash`)
All signed objects (`commitBody`, `roster`) use **RFC 8785 JCS**: UTF-8,
lexicographically sorted object keys, no insignificant whitespace, **integer-only
numeric fields** (seq/size/epoch/version — no floats), no duplicate keys;
`blobRefs` sorted by `(encSha, size)`. Non-conforming input is rejected before
hashing/verifying.

### R3″ — Nonce policy (resolves the convergent-vs-random contradiction)
- **Blobs (convergent):** key **and** nonce are **deterministically derived** —
  `HKDF(KEK, plaintextSha, info="rbox/blob/v1")` → (key, 96-bit nonce). Same
  plaintext → identical (key,nonce,ciphertext) = the intended within-workspace
  dedup; this is **not** a GCM nonce-reuse vuln because the pair repeats *only*
  for identical plaintext (identical output, no new leakage). Distinct blobs «
  2³², far under GCM limits.
- **Manifests + all key wraps:** **fresh random 96-bit nonce** per encryption
  (non-convergent — must not correlate). Per-key message count stays « 2³²
  (manifests are per-commit); `keyEpoch` rotation occurs long before any limit.

---

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

> **Implementation status (v4 build).** The zero-knowledge engine is implemented
> and tested under `src/engine/e2ee/` (jcs, primitives, asym, recovery, keys,
> manifest-crypto, commit, roster, epoch, session — 73 passing tests incl. RFC
> 5869 / BIP39 / SHA-256 vectors). The headline two-machine + zero-knowledge proof
> (`e2ee-e2e.test.ts`) passes: device A bootstraps + commits an encrypted tree,
> device B pairs in (token-derived MK wrap + self-admission to the roster),
> verifies the signed commit against the roster, decrypts byte-identically, and a
> grep over **everything** a faithful server stores finds **zero** plaintext
> filenames/contents. Adversarial cases proven: server key-substitution on
> admission rejected, grant replay rejected, expired grant rejected, non-roster
> signer rejected, wrong-epoch/workspace/key manifest decrypt rejected. Argon2id
> is NOT used (V4-9).
>
> **Server (`apps/api/`) implemented + tested:** migration `0011_e2ee.sql`
> (`account_keys`, `device_keys`, `workspace_keys`, `rosters`,
> `account_key_states`, `commits`, pairing MK-wrap columns); `keys.ts` opaque
> key storage/serving (`/v1/keys/*`); `workspace-sync.ts` stores the signed
> commit ENVELOPE (no plaintext manifest, no server-side `validateManifest`);
> `versions.ts` GC reachability from `encManifestSha`+`encShas`. tsc clean, 36
> Miniflare tests pass (2 DO-sequencer tests skipped — `transactionSync`
> unavailable in the pinned vitest-pool-workers runtime, not a regression).
>
> **Remaining integration slice (next milestone):** CLI sync wiring
> (`sync.ts` push/pull over the session module, the E2EE keystore for MK/device
> keys, `rbox key` UX, split-secret pairing token in the CLI — the engine
> already keeps `tokenSecret` client-only; the token shown to the user must be
> `<redeemToken>.<tokenSecret>` so the secret never reaches the server —
> encryption-on-by-default in `init`), and a real-Workers two-VM e2e.

- Crypto unit tests: wrap/unwrap MK (device + recovery), KEK under MK, manifest
  encrypt/decrypt round-trip, convergent blob keys (M5, keep). (No Argon2id —
  recovery uses BIP39 entropy directly per V4-9.)
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

## 13. CLI integration plan (the remaining slice — codex **PASS**)

**Status:** plan reviewed by codex (NEEDS-PASS → all 8 BLOCKER + 4 SHOULD-FIX
resolved in §13.12, two confirm rounds → **PASS**). §13.12 is normative and
amends §13.1–13.11.

**Build status:** the transport + crypto glue are IMPLEMENTED + PROVEN.
- Engine pull-verify glue: `verifyAccount` (pinnable head facts + authorized
  MK-wrap-hash set), `verifyCommitChain` (C1 chain-descent/anti-rollback),
  `openCommit` disjunctive reject (C4), `assertMkWrapAuthorized` (C7). [tested]
- `src/cli/e2ee-keystore.ts`: device/MK/per-epoch-KEK store, opt-in recovery
  caching (C9), partial-state detection (C10), anti-rollback `HeadPin` (C2). [tested]
- `.rbox/` hard, non-overridable ignore (C8). [tested]
- Server deltas (C1/C3/C4/C5/C6) on `apps/api/`. [tested]
- `src/cli/e2ee-remote.ts` `E2eeRemote implements SyncRemote`: transparent
  encrypt/decrypt + signed-commit chain + KEK CAS (C3) + head pinning. PROVEN by
  `e2ee-sync.test.ts` through the REAL `sync.ts`: two machines (A push, B pair-in
  + pull byte-identical), bidirectional convergence, ZERO plaintext in everything
  the faithful server stores. `RboxApi` implements the production HTTP `E2eeApi`.

**Remaining (interactive UX + live verification):** the user-facing commands —
`login --bootstrap` (show recovery phrase + bootstrap keys), `init` (create
workspace + KEK, encryption default-on), `rbox pair` create/redeem (split-secret
token via stdin, C11), `recover`, `rbox key backup/status`; thread `accountId`
through the per-machine credential; construct `E2eeRemote` in `loadAuthedConfig`;
M5-upgrade detection (C12) — plus the real-Workers two-VM e2e (best driven
interactively / in CI). These are mechanical glue over the proven transport.

The engine (`src/engine/e2ee/`) and server (`apps/api/`) are built + tested. This
section plans wiring the **`rbox` CLI** to use them so encryption is the default,
end-to-end, over the network. It is **superseded by nothing above** — it consumes
the v4 wire spec. Goal: a user runs `rbox` exactly as today; under the hood every
workspace is E2EE and the server never sees plaintext.

### 13.1 Local key material (the E2EE keystore)
New `src/cli/e2ee-keystore.ts`, all files mode 600 under `~/.rbox/e2ee/<accountId>/`:
- `device.json` — `{ deviceId, sigPubKey, sigPrivPkcs8, encPubSpki, encPrivPkcs8 }`
  (b64url). The device's long-lived identity.
- `mk.key` — the Account Master Key (b64url), at rest like today's KEK file.
- `rk.key` — the recovery key (b64url), cached so `rbox key backup` can re-show
  the phrase (R6). As sensitive as MK; same at-rest model; deletable by the user.
- `ws/<workspaceId>.json` — `{ keyEpoch → kekB64 }` cache of unwrapped workspace
  KEKs (avoids re-fetch+unwrap each sync). Authoritative copy is the server's
  wrapped blob; this is a cache, re-derivable from MK.

Trust/at-rest note: MK/RK/KEK sit in plaintext files (mode 600) exactly as M5's
KEK does today. The zero-knowledge property is about the *server*, not local disk;
OS-keychain storage is a future hardening, called out, not done here.

### 13.2 `remote.ts` additions (client ↔ server API)
Extend `RboxApi`/`SyncRemote`:
- `bootstrapKeys(body)` → `POST /v1/keys/bootstrap`
- `getAccountKeys()` → `GET /v1/keys/account` (recoveryWrap, roster chain,
  keystate chain, device wraps)
- `putDeviceKeys(body)`, `appendRoster({version,signed})`,
  `appendKeyState({epoch,signed})`, `putWorkspaceKey(body)`,
  `getWorkspaceKeys(workspaceId)`
- **`commit` changes shape**: `commit(parentSequence, signedCommit)` →
  `POST .../manifests` with `{ parentSequence, commit }`. `latest()` returns
  `{ sequence, commit: SignedCommit | null }`.
- Blob upload/download unchanged (content-addressed by `encSha`); the encManifest
  is just another blob, uploaded by `encManifestSha` before the commit.

### 13.3 Account bootstrap & device join
- **New account** (`rbox login --bootstrap <secret>` / first device): after the
  device token is minted, call `session.bootstrapAccount(accountId, deviceId)` →
  generate MK + device keypairs + recovery phrase + genesis roster + genesis
  keyState; `bootstrapKeys(...)`; persist `device.json`/`mk.key`/`rk.key`; **print
  the recovery phrase with a forced "save this — no escrow" acknowledgement**.
- **Join existing account via pairing** (§13.5) or **recovery** (§13.6). After
  either, the device has MK + its own keypairs persisted, and is `active` in the
  roster it just appended.
- A device with a wiped keystore (lost `device.json`) is **not** the same
  principal anymore (its enc privkey is gone → can't open its old MK wrap) — it
  must re-join via pairing or recovery. Documented; `rbox` detects "no device.json
  for this account" and routes to the connect/recover menu.

### 13.4 Workspace create & the push/pull paths
- **Create** (`rbox init`/`createWorkspace`): generate KEK at the account's current
  `keyEpoch`, `aesGcmWrap` under MK, `putWorkspaceKey`. Encryption is mandatory —
  remove the `--encrypt` opt-in and `cfg.encrypted` (always on). `init` refuses if
  no account key material exists yet (prompts bootstrap/connect first).
- **Push** (`sync.ts`): scan → for each changed file, convergently encrypt under
  the **current-epoch** KEK (existing `crypto.ts`, V4-5) → upload missing file
  blobs by `encSha` → `encryptManifest` → `buildCommit` (signed envelope at
  `seq=parentSeq+1`, `parentCommitHash`=pinned head hash) → upload the encManifest
  blob → `commit(parentSeq, signedCommit)`.
  - **409 conflict**: `pull` (which re-pins the head), re-scan, rebuild the commit
    against the new parent (fresh manifest nonce, new `seq`/`parentCommitHash`,
    re-sign), retry — bounded, as today.
  - **422 unsatisfied**: re-upload named blobs (incl. encManifest), retry.
- **Pull** (`sync.ts`): `getAccountKeys` → `verifyAccount` (roster + keyState
  chains) → `latest()` → `openCommit` (verify signer ∈ active roster, verify sig,
  hash-link to pinned head, decrypt manifest under `commit.keyEpoch` KEK) →
  `validateManifest` **client-side** (path-safety/limits — now the sole authority)
  → reconcile → for each needed file, download by `encSha` + decrypt under
  `commit.keyEpoch` KEK (existing `decryptFileToPath`). Then update the pin.

### 13.5 Pairing (split-secret, the security-critical bit)
- **`rbox pair`** (device A, authed): generate a 32-byte `tokenSecret` **locally**;
  `session.buildPairing(secrets, {tokenId?, tokenSecret, notAfter})` → `{ mkWrap,
  admissionGrant }`; `POST /v1/auth/pair/create` with `{ mkWrap, admissionGrant }`
  → server returns its `redeemToken`. **Show the user
  `rbox-pair_<redeemToken>.<b64url(tokenSecret)>`.** `tokenSecret` is NEVER sent to
  the server.
- **Connect** (device B, `rbox login --pair <token>` / menu): split on the last
  `.` → `redeemToken` + `tokenSecret`; `POST /v1/auth/pair/redeem { token:
  redeemToken }` → `{ deviceToken, mkWrap, admissionGrant }`; persist the device
  token; `getAccountKeys()` for the current roster head; `session.redeemPairing({
  tokenSecret, material:{mkWrap,admissionGrant}, prevRoster })` → unwrap MK, gen
  device keypairs, build admission `roster vN+1`; `appendRoster` + `putDeviceKeys`;
  persist `device.json`/`mk.key`; `getWorkspaceKeys` per workspace as needed.
  - `appendRoster` **409** (someone else advanced the roster) → re-`getAccountKeys`,
    rebuild the admission delta against the new head, retry (bounded). The grant's
    `grantId` single-use still holds across the new parent.

### 13.6 Recovery (`rbox login --recover`)
Enter phrase → `phraseToRk` → `getAccountKeys` → `recoverMasterKey(recoveryWrap)`
→ gen device keypairs + self MK-wrap → build a **recovery-signed** admission
`roster vN+1` (RSK derived from RK, already a roster principal) → `appendRoster` +
`putDeviceKeys` + persist. Same 409-retry as pairing.

### 13.7 `rbox key` UX
- `rbox key backup` — re-show the recovery phrase from cached `rk.key` (re-auth /
  confirm). If `rk.key` absent (e.g. paired device that never held RK), say so and
  point to a device that has it.
- `rbox key status` — deviceId, accountId, roster version, whether MK is loaded,
  whether this device is `active` in the latest roster, current `keyEpoch`.

### 13.8 Local state / head pinning
Extend `.rbox/state.json` (`SyncState`) with `pinnedCommitHash`, `rosterVersion`,
`keyEpoch`. Pull rejects a `latest` whose chain doesn't descend from
`pinnedCommitHash` (rollback-evident, R1). A fresh device with no pin accepts the
current head and starts pinning (the documented fresh-device residual, R1″).

### 13.9 Greenfield migration
No real users → **wipe dev + prod D1 + R2** before launch (housekeeping). Remove
the M5 `~/.rbox/keys/<ws>.key` path and the `encrypted` opt-in; all workspaces are
E2EE. The server already rejects the old plaintext-manifest commit shape (the DO
commit path now requires `{parentSequence, commit}`).

### 13.10 Test plan
- Unit (Bun): keystore round-trips; `remote.ts` request shapes against a fake;
  sync push/pull against an in-memory faithful server (extend the existing
  `FakeRemote`/e2e harness to carry signed commits + key endpoints).
- **Real two-VM e2e** (the headline): `bun build --compile` the CLI, run two
  containers against the **dev Worker** — A bootstraps + `init` + writes files +
  syncs; A `rbox pair`; B connects with the pasted token; B syncs and gets A's
  tree byte-identically; B edits, A pulls; then `wrangler r2/d1` dump + `grep`
  for known plaintext → **zero hits**. Add to CI behind a flag (the backlog item).
- Conflict/concurrency: two devices commit against the same parent → one 409s,
  pulls, rebuilds the signed commit, converges.

### 13.11 Risks / open questions (for the adversarial review)
1. **Pinning store trust**: `pinnedCommitHash` lives in `.rbox/state.json`
   (plaintext, user-writable). A local attacker editing it defeats rollback
   detection — acceptable (local disk is already trusted), or should the pin live
   with the keystore?
2. **Conflict-retry re-signing**: rebuilding a commit on 409 re-encrypts the
   manifest (new nonce) and re-signs against the new parent — is there any window
   where a stale `parentCommitHash` or `keyEpoch` gets signed? (Plan: re-read both
   from the just-pulled head inside the retry.)
3. **keyEpoch selection on push vs pull**: push uses the current (highest) epoch;
   pull decrypts under `commit.keyEpoch`. After a rotation, in-flight blobs from a
   device that hasn't refreshed its roster/keyState — does it sign under a stale
   epoch and get rejected? (Plan: refresh account keys at the start of each sync.)
4. **Roster-append thundering herd**: N devices pairing/recovering concurrently
   each append `roster vN+1` → 409s; bounded retry rebuilds against the new head.
   Is the grant's single-use `grantId` still satisfiable after re-parenting? (It
   should: `grantId` uniqueness is over ancestry, not a fixed version.)
5. **encManifest never dedups** (random nonce) → one new blob per commit forever;
   GC must reclaim superseded encManifest blobs (it does — they fall out of the
   reachable set). Confirm no unbounded growth.
6. **Multi-workspace KEK fetch**: a newly joined device lazily `getWorkspaceKeys`
   per workspace on first touch — any ordering issue vs the roster/keyState it
   must verify first?
7. Anything that silently weakens to non-E2EE, locks a user out, or lets the
   server forge state a wired client would accept.

### 13.12 — Resolutions to codex CLI-plan review (NORMATIVE; amends §13.1–13.11)
Codex pre-implementation review of §13 returned NEEDS-PASS (8 BLOCKER + 4
SHOULD-FIX). These resolutions are authoritative for the build.

**C1 [BLOCKER] Verify the whole chain from the pin, not just `latest()`.** A commit
names only its immediate parent, so proving `latest` descends from
`pinnedCommitHash` needs the intervening history. Add server `GET
.../commits?since=<seq>` (returns the stored `SignedCommit`s for `seq+1..head`,
already in the DO). Pull fetches `commitsSince(pinnedSeq)`, verifies each
`parentCommitHash` links forward from the pinned hash to `latest`, each sig
against its `rosterVersion`'s active set, **before** applying. A gap/!link →
reject (fail closed).

**C2 [BLOCKER] Pin hashes, not versions.** `SyncState` pins
`{ commitSeq, commitHash, rosterVersion, rosterHash, accountEpoch, keyStateHash }`.
Fetched roster/key-state chains MUST extend those pinned hashes (a version number
alone doesn't identify a chain head). Rollback to an earlier hash at the same
version → reject.

**C3 [BLOCKER] keyEpoch correctness + rotation-on-write.** A commit's manifest and
all its file/git blobs are encrypted under the **same** `keyEpoch` KEK. On push
the client uses the workspace KEK for the account's **current** `keyEpoch` (from
the verified accountKeyState); if it can't find that KEK locally it MUST
`getWorkspaceKeys` and, if still absent, `createWorkspaceKey` for that epoch +
`putWorkspaceKey`. **`workspace_keys` rows are immutable** — `putWorkspaceKey` is a
CAS insert on `(workspaceId, keyEpoch)` (`INSERT … ON CONFLICT DO NOTHING`) that
**always returns the stored winning wrap** (the pre-existing one if this caller
lost the race). The client **adopts the returned wrap and discards its own**, so
two devices that independently generated a KEK for the same epoch converge on one.
A later write can never overwrite a published KEK. When `keyEpoch` advanced since
the last sync, unchanged blobs cannot
be carried forward under the old epoch — the client **re-encrypts all live file +
git blobs under the new-epoch KEK** before signing (lazy rotation-on-write). On
pull, decrypt strictly under `commit.keyEpoch`; a missing epoch KEK → fail closed,
never guess. **Scope note:** v1 of the CLI ships with `keyEpoch` fixed at 0 (no
revocation path wired yet); the rotation-on-write logic above is specified now so
the epoch field is handled correctly, but exercising a real epoch bump is its own
follow-up (revocation UX).

**C4 [BLOCKER] Close the stale-epoch signing window (authoritative = client).**
The **authoritative** guarantee is client-side and already follows from the
crypto: on pull, `openCommit` **rejects a commit if EITHER** its signer is **not
`active` in the current verified roster** (a rotated-out device is removed by the
rotation) **OR** its `accountEpoch` **≠ the account's current verified epoch** (the
conditions are **disjunctive** — either alone is fatal; an active signer presenting
a stale/future epoch is still rejected). So even if a stale/unknown-epoch commit
lands on the server, no trusted client applies it. To also keep it from landing (save a conflict round-trip), the server
adds a **best-effort precondition in the serialized append path**: the Worker
reads the current epoch (`MAX(account_key_states.account_epoch)`) and passes it to
the DO, which asserts `commitBody.accountEpoch == currentEpoch` **inside the
head-advance `transactionSync`** (reject `409`/`412` otherwise — `==`, so both
stale and unknown-future epochs are refused). The residual D1-read↔txn TOCTOU is
benign: its worst case is a one-epoch-off commit that the client-side roster/epoch
check rejects anyway. Client also: refresh + verify account keys **immediately
before signing**, assert this device is `active`, then sign.

**C5 [BLOCKER] Admission is atomic: device keys before/with the roster.** Publishing
`roster vN+1` that references a `deviceWrapHash` whose wrap isn't stored can wedge
admission on a crash. Add server `POST /v1/keys/admit` =
**`appendRosterWithDeviceKeys`** (one D1 `batch`: insert `device_keys` row + append
the roster row under the same monotone-version guard). Across 409 retries the
client **reuses the same generated device keypair + MK self-wrap**, rebuilding only
the roster parent/version/signature (so `deviceWrapHash` stays stable).

**C6 [BLOCKER] Client owns the tokenId so the grant binds the exact token.**
`buildPairing` needs the `tokenId` up front, so the **client generates both
`tokenId` (random) and `tokenSecret`**, builds the grant bound to `tokenId`, and
`POST /v1/auth/pair/create { tokenId, mkWrap, admissionGrant }` (the server stores
keyed by `tokenId`, validates uniqueness, no longer mints the token itself). The
user-facing token is `rbox-pair_<tokenId>.<tokenSecret>`; redeem sends only
`tokenId`. (Server change: `createPairToken` accepts a client `tokenId` instead of
generating one.)

**C7 [BLOCKER] Verify MK wraps against the signed hashes (v4 impl note).** After
`getAccountKeys` + `verifyAccount`, hash every fetched MK wrap (device + recovery)
and **fail closed** unless each matches a `deviceWrapHash`/`mkWrapHashes` value in
the verified signed roster / accountKeyState. This is what stops a malicious server
from substituting a wrap. Likewise verify a workspace `kekWrap` opens to a KEK only
via MK (the GCM tag + bound context already enforce this; no extra hash needed).

**C8 [BLOCKER] `.rbox/` is a hard, non-overridable exclusion.** `.rbox/` holds
`state.json` with the **decrypted** base manifest. The ignore engine MUST exclude
`.rbox/` unconditionally — a user `!.rbox` un-ignore rule cannot re-include it (and
neither can `--purge`). Enforce in `buildIgnoreMatcher` as a fixed pre-filter ahead
of all user rules. (Without this, plaintext metadata could be encrypted-and-synced,
but its *presence/structure* in a synced tree is itself a leak of the base state.)

**C9 [SHOULD-FIX] RK is not cached by default.** Drop `rk.key` from the default
keystore. The recovery phrase is shown **once** at bootstrap (RK in memory). `rbox
key backup` re-shows it only if the user opted into caching (`--cache-recovery` at
bootstrap, or a keychain-backed store); otherwise it says "enter your saved phrase
or use another device." Add `rbox key forget-recovery`. Document: RK compromise ⇒
must rotate (recovery is admin-capable).

**C10 [SHOULD-FIX] Fail-closed partial-keystore rules.** `device.json` present but
`mk.key` missing → re-derive MK from this device's own stored RSA wrap
(`getAccountKeys` → `openOwnMasterKey`), never sync without MK. `device.json`
missing → refuse to sign/sync; route to pairing/recovery only. Any inconsistency
(device not `active` in the latest roster) → refuse + explain.

**C11 [SHOULD-FIX] Keep the pairing secret out of argv/history.** Read the pasted
token via **prompt/stdin** (not `--pair <token>` in argv); validate `tokenSecret`
base64url-decodes to exactly 32 bytes before any network call. Printed-token
scrollback on device A stays a documented residual (short TTL + single-use).

**C12 [SHOULD-FIX] Handle the local M5 upgrade.** Detect old `cfg.encrypted`
workspaces and `~/.rbox/keys/<ws>.key` files; **fail with a re-init message**
(greenfield: re-`init` under E2EE), never auto-fall back to plaintext/v1.

Server deltas implied by the above (additions to the built `apps/api/`):
`GET .../commits?since=<seq>` returning the stored `SignedCommit`s (C1);
`putWorkspaceKey` = CAS insert returning the winning wrap (C3); DO commit asserts
`accountEpoch == currentEpoch` inside the head-advance txn, current epoch passed
from the Worker (C4); `POST /v1/keys/admit` atomic device-keys+roster in one D1
batch (C5); `createPairToken` accepts a client-supplied `tokenId` (C6).

## 14. CLI command flows (interactive UX — codex **PASS**)

**Status:** codex-reviewed (NEEDS-PASS → 6 BLOCKER + 5 SHOULD-FIX resolved in
§14.11 D1–D11 → confirm **PASS**). §14.11 is normative. Tracked for rotation
milestone: D1 needs an atomic commit-publish CAS (v1 has no rotation); D3 pending-
join uses mode-600 keystore semantics; D5 is an accepted pre-launch signed-format
change (`mkWrapHash` optional on `RosterEntry`).

Wires the proven transport (§13, E2eeRemote) into the user-facing commands.
Consumes §13.12 (normative). Encryption is the ONLY mode now.

### 14.1 accountId threading
The client must know its `accountId` to namespace the keystore (`~/.rbox/e2ee/<accountId>/`)
and to construct `E2eeRemote`. Add `accountId` to `Credentials`. The three auth
responses already/again carry it: `device/bootstrap` (has it), `device/poll`
(has it), `pair/redeem` (ADD it server-side — the row has `account_id`). `login`
+ `redeemPair` persist it.

### 14.2 The MK problem with device-code (decision)
Under E2EE-always, EVERY device needs MK to read anything. The two MK-carrying
joins are **pairing** (token-wrapped MK + admission grant) and **recovery**
(phrase → RK → MK). **Bare device-code (`approve a code`) does NOT carry MK** — it
yields a valid device credential but no key material. Decision for v1:
- The **primary "connect a machine" path is pairing** (the menu already leads with
  it). It carries MK and self-admits to the roster.
- A device that authenticated but has **no local MK** (device-code, or a wiped
  keystore) is detected and **fails closed on any sync** with a clear message:
  "this device isn't enrolled for encryption — run `rbox pair` on a signed-in
  machine and connect with the token, or `rbox recover`." Never sync plaintext.
- Device-code stays available for the credential, but enrollment (MK) requires
  pair/recover. (Carrying MK over device-code — approver wraps MK under a
  code-derived key — is a documented future option, not v1.)

### 14.3 Bootstrap (new account, first device)
After a **bootstrap login** that creates a NEW account (`device/bootstrap`),
if `GET /v1/keys/account` is 404 (no key material yet), run
`session.bootstrapAccount` → POST `/v1/keys/bootstrap`; persist
`device.json`/`mk.key`; **print the recovery phrase with a forced "save this — no
escrow" acknowledgement** (interactive: require typing `yes`; non-interactive:
print + a loud stderr warning, never silently discard). Idempotent: a second
bootstrap-login on an already-keyed account skips (the device already has keys, or
must pair/recover).

### 14.4 init / workspace KEK
`init` (and `link`) for a NEW workspace: after `createRemoteWorkspace`, the first
sync's `E2eeRemote` lazily creates + CAS-publishes the workspace KEK (C3) and sets
`cfg.kek` for blob encryption. Remove the `--encrypt` opt-in and the `cfg.encrypted`
flag's optionality — `encrypted` is implicitly always true; `init` refuses if the
device has no MK (→ 14.2 message). The "secrets stay ignored / E2EE coming" notice
is replaced with "this workspace is end-to-end encrypted."

### 14.5 E2eeRemote construction (the sync seam)
New `buildAuthedRemote(root): Promise<{ cfg, deps: SyncDeps }>` (CLI helper):
loads cfg + creds (incl. accountId) + device secrets (keystore); if no
secrets/MK → fail closed (14.2). Constructs `RboxApi` + `E2eeRemote`
(keystore-backed `PinStore`), sets `cfg.kek = await remote.currentKek()`, returns
`{ cfg, deps: { remote } }`. Every sync call site (`push`/`pull`/`sync`/`daemon`/
`versions`/`restore`) switches from `loadAuthedConfig(root)` →
`buildAuthedRemote(root)` and passes `deps`. (The daemon builds it once per loop.)

### 14.6 pair create / redeem (split-secret)
- `rbox pair`: load secrets; generate `tokenId` (16–64 url-safe) + 32-byte
  `tokenSecret`; `buildPairing(secrets, {tokenId, tokenSecret, notAfter})`;
  `POST /v1/auth/pair/create { tokenId, mkWrap, admissionGrant }`; print
  `rbox-pair_<tokenId>.<base64url(tokenSecret)>` (valid ~N min, single use).
- connect/redeem: read the token via **prompt/stdin** (never argv, C11); split on
  the LAST `.` → `rbox-pair_<tokenId>` + `tokenSecret`; validate `tokenSecret`
  decodes to exactly 32 bytes; `POST /v1/auth/pair/redeem { token:
  rbox-pair_<tokenId> }` → `{ token, deviceId, accountId, mkWrap, admissionGrant }`;
  persist credential (with accountId); `getAccountKeys` (verify chain, C2/C7);
  `redeemPairing` → secrets + admission roster + device; `POST /v1/keys/admit
  { device, roster }` (atomic, C5; 409 → refetch head, rebuild roster parent
  reusing the SAME keypair, retry); persist `device.json`/`mk.key`.

### 14.7 recover
`rbox recover` (or menu): prompt phrase (stdin) → `phraseToRk` → `getAccountKeys`
(verify chain) → `recoverMasterKey(recoveryWrap)` → gen device keypairs + self
MK-wrap → build a **recovery-signed** admission roster (RSK from RK, already a
roster principal — `session.buildRecoveryAdmission`) → `POST /v1/keys/admit` →
persist. Same 409-retry as pairing.

### 14.8 rbox key backup / status
- `key backup`: re-show the phrase from cached `rk.key` IF the user opted into
  caching at bootstrap (`--cache-recovery`); else print "not cached on this device
  — use the phrase you saved at setup, or another enrolled device." (C9)
- `key status`: deviceId, accountId, MK present?, this device `active` in the
  latest roster?, current rosterVersion + accountEpoch + keyEpoch.

### 14.9 M5 upgrade detection (C12)
On any sync/init, if the OLD M5 state is present (`cfg.encrypted` was a persisted
opt-in, or `~/.rbox/keys/<ws>.key` exists) **and** no new-world `device.json`,
fail with: "this workspace predates full E2EE — re-run `rbox init` to re-enroll
(greenfield; dev data is wiped)." Never auto-fall back to the M5 path.

### 14.10 Risks / open questions (for review)
1. **device-code → no-MK dead-end** (14.2): is failing closed + directing to
   pair/recover the right v1 call, or must device-code carry MK now?
2. **bootstrap idempotency**: bootstrap-login on an account already bootstrapped by
   another device — the second device has a credential but no MK; does 14.3's "skip
   + route to pair/recover" hold without a confusing half-state?
3. **buildAuthedRemote per daemon loop**: refreshing account keys every sync (C4)
   — acceptable overhead, or cache with invalidation?
4. **recover with no active device**: total-device-loss recovery appends a
   recovery-signed roster; if the recovery principal was itself rotated out, the
   user is locked out — is that the correct (documented) failure?
5. **first-sync ordering on a fresh join**: pair → admit roster → init --workspace
   → pull. Must the roster admission land BEFORE the first pull (so the device is
   active for commit verification)? (Yes — admit before sync.)
6. Anything that silently weakens to non-E2EE or strands a user without MK.

### 14.11 — Resolutions to codex §14 review (NORMATIVE; amends §14.1–14.10)
Review returned NEEDS-PASS (6 BLOCKER + 5 SHOULD-FIX). Resolutions D1–D11:

**D1 [BLOCKER §14.5] Frozen write context (no stale-KEK window).** One snapshot
drives BOTH blob encryption and commit signing. `E2eeRemote.beginWrite()` returns
a `WriteContext { accountEpoch, keyEpoch, kek }` captured after a fresh
`refreshAccount`. `cfg.kek` for blob encryption comes from that context; `commit()`
re-reads the current epoch at sign time and, if it differs from the context's
epoch, returns a `conflict`-style result so `sync.ts` re-scans + re-encrypts under
the new KEK (never signs a commit whose `keyEpoch` ≠ the blobs' epoch). (v1 has no
rotation, so the guard never fires, but it's specified + asserted.)

**D2 [BLOCKER §14.3] Crash-safe bootstrap.** Order: generate MK/RK/device keys →
**persist `device.json` + `mk.key` locally FIRST** (+ RK in a temp pending file) →
`POST /v1/keys/bootstrap` → show phrase + forced ack → drop the temp RK unless
`--cache-recovery`. A crash after the POST leaves local MK present ⇒ the account is
recoverable. An **incomplete server key chain is FATAL** (never "already keyed,
skip" — a missing genesis roster/key-state is a hard error, not a no-op).

**D3 [BLOCKER §14.6] Crash-safe admission (pair + recover).** Persist a **pending
join** (credential + generated device keypair + unwrapped MK) locally BEFORE
`POST /v1/keys/admit`. On restart, if the roster already lists this device →
finalize (promote pending → `device.json`/`mk.key`); else retry admit reusing the
SAME keypair. Never leave an active roster device whose private keys weren't saved.

**D4 [BLOCKER §14.6/14.7] Self-verify the candidate chain before posting.** After
`buildAdmissionRoster`/`buildRecoveryAdmission`, the client runs `verifyAccount`
over the EXTENDED roster/key-state chain (incl. C7 wrap-hash authorization) and
`verifyCommitChain` of its own delta locally; only on success does it
`POST /v1/keys/admit`. A chain that wouldn't verify is never published (can't wedge
other clients at `verifyAccount`).

**D5 [BLOCKER §14.7 + engine] Bind every device's MK-wrap hash in its signed
roster entry.** Add `mkWrapHash` to `RosterEntry` (hash of that device's MK
self-wrap). `bootstrapAccount`, `redeemPairing`, and the new
`session.buildRecoveryAdmission` all set it. `verifyAccount`'s
`authorizedMkWrapHashes` = `∪ keyStates.mkWrapHashes ∪ ∪ rosterEntries.mkWrapHash`
— so recovery- and bootstrap-admitted device wraps are authorized uniformly, not
only pairing's `admission.deviceWrapHash`. `buildRecoveryAdmission` produces an
admin-signed (by RSK, an active recovery principal) roster adding the device with
its `mkWrapHash`; C7 then authorizes the recovered wrap.

**D6 [BLOCKER §14.4/14.5] Delete the plaintext sync branch (fail closed).**
`sync.ts` MUST fail closed unless an E2EE write context is present: the
`pushManifest` `else { uploadBlobs(plaintext) }` branch is removed — a non-E2EE
config or a plain `RboxApi` reaching the core sync path throws
`"E2EE required"` BEFORE any blob upload. `cfg.encrypted` is no longer optional;
absence of an E2EE remote/context is a hard error.

**D7 [SHOULD-FIX §14.1/14.6] Trust only the SIGNED accountId.** Validate
`accountId` grammar, then cross-check the server-returned value against the
**signed** accountId in the verified roster/key-state (and, for pairing, the
A-signed admission grant). Persist the credential + choose the keystore namespace
only AFTER that match; use a staging dir until verified. A server returning a
mismatched accountId → abort.

**D8 [SHOULD-FIX §14.2] Partial keystore ≠ pair/recover.** `device.json` present
but `mk.key` missing → re-open this device's own authorized server MK wrap via
`openOwnMasterKey` (C7-checked) and save MK. Only a MISSING `device.json` routes to
pair/recover.

**D9 [SHOULD-FIX §14.6] Pair-create refreshes + binds epoch.** `rbox pair` first
`refreshAccount` + asserts the creator is `active` in the latest roster, and passes
the current `accountEpoch` into `buildPairing` (no stale grants).

**D10 [SHOULD-FIX §14.7] Recover needs an account credential first.** The E2EE key
endpoints are credential-gated, so `rbox recover` first obtains a device credential
via the normal account-identity path (web/Clerk session — M11 — or a device-code if
another device still exists), THEN uses RK only for MK + RSK + self-admission.
Honest residual: true total-device-loss recovery depends on the account-identity
(web) login to get that first credential; the phrase alone unlocks data, not
server auth.

**D11 [SHOULD-FIX §14.9 + completeness] Explicit E2EE marker; versions/restore.**
`workspace.json` carries `schema: "e2ee/v1"`; any workspace lacking it (old M5/
plaintext) → fail before any blob op with a re-init message. `versions` lists from
the verified commit chain (metadata only — seq/deviceId, no decrypt); `restore`
fetches the target commit, `openCommit`-decrypts under its `keyEpoch`, and applies;
both route through `E2eeRemote` or fail closed (never the old plaintext `manifestAt`).

## 12. Open questions for codex (crypto core — RESOLVED in v2–v4 above)
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
