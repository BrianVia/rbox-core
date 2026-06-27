# Design 05 — Encryption + Secrets (Milestone 5)

**Status:** draft → pending codex (crypto) review.
**Implements:** roadmap M5. **Decision:** D5 (at-rest default + opt-in E2EE; `.env` forced E2EE).
**Goal:** opt-in **end-to-end encryption** — the server stores only ciphertext, only devices holding the workspace key can read it — **while preserving content-addressed dedup**. Opt-in `.env`/secret sync is E2EE-only.

> At-rest encryption is already provided by R2 (server-side). The distinctive, valuable work here is **client-side E2EE** where the Worker never sees plaintext. High-stakes: lose the key → lose the data; get the construction wrong → a breach.

---

## 1. Crypto construction — convergent envelope encryption

- **KEK (key-encryption key):** one 256-bit symmetric key per workspace. Never leaves a device / never sent to the server. Lives in `~/.rbox/keys/<workspaceId>.key` (mode 600).
- **DEK (data-encryption key), convergent:** `DEK = HKDF-SHA256(ikm=KEK, salt="rbox-dek", info=plaintext_sha256)`. Deterministic from (KEK, plaintext) → **same plaintext yields the same DEK → same ciphertext → dedup survives E2EE** (the whole point). Because it's re-derivable from KEK + the manifest's `plaintext_sha256`, the DEK is **never stored** (no wrapped-DEK to manage — the manifest already carries `plaintext_sha256`).
- **Cipher:** AES-256-GCM. **Deterministic nonce** `= HKDF-SHA256(KEK, salt="rbox-nonce", info=plaintext_sha256)[:12]`. Safe despite a fixed nonce because distinct plaintext → distinct (DEK, nonce) pair (GCM's catastrophic-reuse rule is "same key+nonce, different plaintext" — impossible here). Same plaintext → identical (DEK, nonce, ciphertext) → dedup. This is the standard convergent-encryption construction; documented threat: it leaks plaintext *equality* (an attacker with the ciphertext can tell two blobs are identical) — acceptable for source/config, and the same property that enables dedup.
- **Ciphertext layout:** `gcm_ciphertext || tag` (nonce is derived, not stored). The GCM tag authenticates — tamper-evident.

## 2. Blob path under E2EE (entangles with M3)

The stored bytes are ciphertext, so the blob's R2 key must be its **ciphertext** sha (M3's R2-native `put({sha256})` verifies the bytes it receives = ciphertext):
- Manifest `FileEntry` gains `encSha?: string` (the ciphertext content-address) when the workspace is encrypted; `sha256` stays the **plaintext** identity (so dedup/reconcile/diff logic is unchanged — they key off plaintext sha).
- **Upload:** client derives DEK+nonce from (KEK, sha256), encrypts → ciphertext, `encSha = sha256(ciphertext)`, uploads ciphertext under `encSha` (single-PUT or multipart, R2-native verify on `encSha` — works). `missingBlobs` checks `encSha` for encrypted workspaces.
- **Download:** fetch `encSha` ciphertext, AES-GCM-decrypt with derived DEK+nonce (tag-authenticated), then **re-verify `sha256(plaintext) === entry.sha256`** before writing. Two integrity layers (GCM tag + plaintext sha).
- Dedup: convergent → identical plaintext → identical ciphertext → identical `encSha`. ✓

Plaintext workspaces are unchanged (no `encSha`; M3 path as-is). Encryption is a per-workspace flag (`encrypted: true`), set at `link`/`rbox encrypt`, recorded in the synced project config so all devices agree.

## 3. KEK management (the onboarding tax — surfaced honestly)

- **Create:** `rbox encrypt` on a workspace → generates a random 256-bit KEK, stores it locally, marks the workspace encrypted. **Prints a recovery phrase** (the KEK encoded, e.g. BIP39-style) with a loud warning: *lose this and the data is unrecoverable — the server cannot help.*
- **New device gets the KEK two ways:**
  1. **Passphrase escrow (optional):** KEK wrapped by a passphrase-derived key (Argon2id/scrypt) and stored server-side as an opaque blob; a new device with the passphrase unwraps it. Convenience vs a passphrase-strength trust tradeoff (documented).
  2. **Device-to-device (no server trust):** an authed device exports the KEK to a new device via the existing device-approval channel (out-of-band display / local transfer). Highest security, more friction.
- **`.env`/secrets:** opt-in sync (default off, per builtin ignore); when enabled, those paths are **forced E2EE** (refuse to sync a secret in a non-encrypted workspace).

## 4. Files touched
| File | Change |
|---|---|
| `src/engine/crypto.ts` | **new** — KEK gen, HKDF DEK/nonce derivation, AES-GCM encrypt/decrypt, recovery-phrase encode/decode |
| `src/engine/types.ts` | `FileEntry.encSha?`; project-config `encrypted` flag |
| `src/cli/keystore.ts` | **new** — `~/.rbox/keys/<ws>.key` (600) load/save |
| `src/cli/sync.ts` | encrypt-on-upload / decrypt-on-download when workspace encrypted; missing-check by `encSha` |
| `src/engine/apply.ts` | decrypt path on write (or via the blob store adapter) |
| `src/cli/auth-cmd.ts`/`crypto-cmd.ts` | `rbox encrypt`, `rbox key export/import`, passphrase escrow |
| `apps/api` | optional: store passphrase-wrapped KEK escrow blob (opaque); never the KEK |

## 5. Verification
- Unit: convergent determinism (same plaintext+KEK → identical ciphertext/encSha; different KEK → different); GCM round-trip; tamper (flip a ciphertext byte) → decrypt fails (tag); wrong KEK → fails; recovery-phrase round-trip; plaintext-sha re-verify catches a mismatch.
- Live/cross-machine: encrypted workspace; the SERVER blob bytes are ciphertext (assert R2 object ≠ plaintext); a 2nd device with the KEK decrypts byte-identically; a device WITHOUT the KEK cannot read (download → undecryptable). Dedup: two identical files → one stored blob. Forced-E2EE: syncing `.env` in a non-encrypted workspace is refused.

## 6. Open questions for review
1. Convergent encryption's plaintext-equality leak — acceptable default, or offer a non-convergent (random-nonce, no-dedup) mode for the truly paranoid per workspace?
2. Deterministic nonce via HKDF(KEK, plaintext_sha) — sound, or prefer nonce = a slice of the ciphertext-independent derivation? Any GCM pitfall I'm missing?
3. Passphrase escrow: Argon2id params; is storing a passphrase-wrapped KEK server-side an acceptable opt-in, or device-to-device only for M5?
4. Key rotation: out of scope for M5 (rotating KEK = re-encrypt everything)? Note as follow-up?
5. The `encSha` manifest addition vs a cleaner separate encryption-map — does adding `encSha` to FileEntry interact badly with M2 git bundles (which are also blobs — should `.git` artifacts be encrypted too when the workspace is encrypted)? (Likely yes: encrypt git bundle/index blobs the same way.)
