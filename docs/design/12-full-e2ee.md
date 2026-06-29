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
