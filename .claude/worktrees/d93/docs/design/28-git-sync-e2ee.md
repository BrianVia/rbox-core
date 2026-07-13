# §28 — git-sync under E2EE (encrypt git artifact blobs)

> Status: **IMPLEMENTED & VERIFIED** (2026-06-30). Lifts the M5 refusal (`sync.ts:86`) so git-native sync works under the
> E2EE-only mode, and makes it the default. Basis: design 02 (git-mirroring), design 05 §6
> (the deferred "encrypt git bundle/index/op-state blobs" follow-up), design 12 (full-E2EE).

## Problem
Git-native sync (M2) ships a repo's history as a `git bundle` blob plus the `.git/index` and
op-state files (MERGE_HEAD, rebase dirs, …), with refs/HEAD recorded in the manifest's
`GitSection`. Today `captureGitState` uploads those artifact blobs **in plaintext**
(`store.put(plaintextSha, bytes)`), so a bundle would put the entire commit history — messages,
file contents, author identities — on the server in the clear. Because rbox is now E2EE-only
(`index.ts:89`), `encryptAndUpload` hard-refuses any workspace with `syncGit` on
(`sync.ts:86`): *"encryption + git-state sync aren't supported together yet."* Net effect:
**git-sync cannot be enabled in any current rbox workspace.** design 05 §6 anticipated this and
deferred it ("lifted in the full-E2EE pass, which encrypts git artifact blobs too"); the full-E2EE
milestone shipped the encrypted manifest but never did the git half.

## Target
Git artifacts become normal E2EE blobs — convergent-encrypted under the workspace KEK, stored by
`encSha` (sha of ciphertext), referenced by `encSha` from the (already-encrypted) manifest's
`GitSection`, and charged/granted/GC-rooted through the §23/§24 commit path exactly like file
blobs. The server stores only ciphertext + encShas; refs/HEAD/commit-shas live inside the
encrypted manifest. Then `syncGit` defaults **on**. Zero-knowledge property is preserved: a grep
over everything the server stores finds no git plaintext (refs, object shas, messages, file bytes).

## Design

### 1. Encrypt the artifacts (reuse the file-blob primitive)
`captureGitState` already stages each artifact as a temp file (bundle, index, op-state copies).
For each, run the SAME convergent encryptor the file path uses —
`encryptFileToTemp(stagedPath, kek)` → `{ plaintextSha, encSha, ciphertextPath }` — and upload the
**ciphertext** by `encSha`. No new crypto; identical AEAD, key derivation, and AAD as file blobs.

### 2. `GitSection` carries (encSha, plaintextSha) pairs
`decryptFileToPath(ct, kek, plaintextSha, dest)` needs the plaintext sha to verify the decrypted
bytes (GCM gives integrity; the sha is the content identity + an extra guard), so — exactly like
`FileEntry { sha256, encSha }` — each artifact reference becomes a pair. Concretely the
`GitSection` blob-address fields gain an enc counterpart:
```
bundle:   bundleSha (plaintext, for decrypt-verify) + bundleEncSha (ciphertext address)
index:    indexSha?                                  + indexEncSha?
opState:  rel → { sha (plaintext), encSha }          (was rel → sha)
```
`refs`, `head`, `indexTree`, `bundleSize`, `generatedAt`, and `gitIdentityKey` are unchanged (refs/
head/indexTree are the stable identity; they ride the encrypted manifest and are never blob keys).
Old (pre-§28) inline-sha sections never existed under E2EE (git-sync was refused), so there is NO
backward-compat mode to carry — the field shape simply changes.

### 3. Charge/grant/GC the git encShas through the commit path
File-blob encShas enter the commit's `blobRefs` from `manifest.files`; git-artifact encShas are in
`manifest.git`, NOT `manifest.files`. So `e2ee-remote.ts commit()` must add the git section's
encShas (`bundleEncSha`, `indexEncSha`, each `opState[*].encSha`) to the `blobRefs` set it builds —
otherwise they're uploaded but never granted/charged, the commit's blob-existence gate won't
require them, and GC could condemn them. With §24 a large repo's refs ride the sidecar; the git
encShas join that same set. (At savvy-core scale the git artifacts are a handful of extra refs.)

### 4. Encrypting seam in capture/apply
`captureGitState(root, store, kek)` and `applyGitState`/`preserveGitConflict(root, section, store,
kek)` gain a `kek`. Internally, `putBlobFromFile` encrypts-then-puts and returns the encSha;
`getBlobToFile`/`getBlobAtomic`/`restoreOpState` fetch by encSha then `decryptFileToPath`. Since
E2EE is the only mode, the kek is always present (injected by `buildAuthedRemote`, like the file
path); no dual plaintext/cipher path.

### 5. Lift the refusal + default on
Remove the `sync.ts:86` throw. `captureGitForPush` already no-ops when `!cfg.syncGit`; flip the
default so `syncGit` is on unless `--git false`. `init` records it; the push/pull git branches
(`sync.ts:196`, `:274`) already exist and just need the kek threaded.

## Zero-knowledge verification (the acceptance test)
Two machines, a real git repo (non-trivial history). A pushes; grep EVERYTHING the server stores —
every R2 object's bytes + every D1 column — for: a known commit sha, a known ref name, a commit
message substring, and a tracked file's plaintext. **All must be absent.** B clones and gets a
byte-identical working tree AND an identical `git log`/`git status` (refs, HEAD, index, op-state).

## Key risks
- **Bundle determinism / dedup.** `git bundle` + `git stash create` mint fresh bytes each capture
  (already noted in git-state.ts), so bundles don't dedup — fine; identity is keyed off refs/head/
  indexTree, not bundle bytes. Convergent encryption doesn't change that.
- **The git encShas MUST be charged/GC-rooted** (step 3) or GC reclaims a live bundle → broken
  clone. This is the load-bearing correctness point; test that GC retains git encShas.
- **Quota.** A 17 MB `.git` (savvy-core) is real bytes against the cap, charged at commit like any
  blob. Default-on means every git workspace pays it. Acceptable + intended (git-native sync).
- **Apply atomicity** is unchanged (quarantine bundle + fsck + rollback already exist); decryption
  is inserted before `bundle verify`, so a decrypt failure aborts before touching the local repo.

## Plan
design → codex review (crypto + the charge/GC correctness) → implement (crypto seam in
git-state.ts; GitSection type; blobRefs inclusion in e2ee-remote.ts; lift refusal + default) →
deploy dev → two-machine zero-knowledge + byte-identical e2e on a real repo → benchmark push/clone
WITH `.git` → /simplify → atomic commit.

---

## v2 — codex review resolutions (2026-06-30)

Codex review → NEEDS-WORK, but **"no BLOCKER on the core crypto idea"** (encrypting artifacts +
referencing only encShas preserves git zero-knowledge; charge/GC via blobRefs is sufficient if done
before sidecar construction; crypto reuse is sound — server swaps are caught by ciphertext-hash +
GCM + plaintext-sha + `git bundle verify`). Resolutions folded into the plan:

- **M1 — precise leakage model (no overclaim).** The server still sees per-object CIPHERTEXT SIZES,
  the COUNT of git blobs, ref-set count/totalBytes, and upload timing. It does NOT see refs, object
  shas, commit messages, author identities, or file bytes (all inside encrypted blobs/manifest).
  The acceptance test asserts the latter set is absent — it does NOT claim size/count hiding (same
  accepted leakage as file blobs; padding/bucketing is out of scope).
- **M2 — ciphertext sizes in blobRefs, never plaintext.** `blobRefs`/sidecar entries are
  `{encSha,size}` and the `size` is ADVISORY (server bills the measured R2 size). For git artifacts
  use the CIPHERTEXT size (`encryptFileToTemp` → ciphertext file size), which the server already
  sees as the R2 object size — so no plaintext git size (≈ repo size) ever enters a server-visible
  ref. `GitSection` carries `*CipherSize` for bundle/index/op-state alongside the (encrypted-
  manifest-only) plaintext `bundleSize`.
- **M3 — 422 recovery covers git artifacts.** On a commit `unsatisfiedBlobs`, the retry must
  re-supply missing git encShas, not just file blobs. Keep the captured git ciphertexts (or
  recapture) until commit succeeds; the upload preflight covers file + git refs.
- **M4 — decrypt-before-mutate (apply atomicity).** In `applyGitState`/`preserveGitConflict`,
  download+decrypt+verify ALL git artifacts (bundle, index, op-state) into temp files BEFORE any
  semantic `.git` mutation; a decrypt/fetch failure returns `{applied:false, reason}` (never aborts
  `pull` mid-mutation). Index/op-state decrypt to temp siblings, then atomic rename. This preserves
  the existing quarantine/fsck/rollback guarantees with decryption inserted ahead of them.
- **M5 — `opState` pair shape ripples to identity + validation.** `opState` becomes
  `rel → {sha, encSha}`. `gitIdentityKey` must extract the plaintext `sha` (else values stringify to
  `[object Object]` and every push re-bundles); `validateGitSection` must validate the pair.
  `restoreOpState` fetches by `encSha` + decrypts + verifies `sha`. Add small helpers for "iterate
  git artifact refs" and "plaintext identity extraction."
- **m6 (MINOR) — accounting headroom.** Default-on git adds ~3–5 refs (bundle/index/op-state) to the
  §24 6002 cap. Negligible for normal repos; document the cap as "file refs + git artifacts" and
  surface a clear error at the boundary.

**Status after v2:** core design PASS; the above are implementation requirements. Implement →
codex-review the IMPLEMENTATION (crypto seam + 422/apply atomicity) → two-machine zero-knowledge
e2e → benchmark with `.git`.

---

## Prior art — git-remote-gcrypt (examined 2026-06-30)

[git-remote-gcrypt](https://github.com/spwhitton/git-remote-gcrypt) is the canonical "encrypt a
git repo as an opaque remote" tool. Its format **validates §28's core model**:
- It content-addresses packfiles by their **ciphertext** hash (`Hi = Hash(Encrypt(Ki,P))`) — exactly
  rbox's `encSha = sha256(ciphertext)`.
- Refs live only inside an **encrypted + signed manifest** (`EncSign(B ‖ L ‖ R)`, where `B` = branch
  list) — exactly rbox's refs-inside-the-E2EE-manifest + signed commit envelope. Nothing
  git-identifying is plaintext on the host.
- It signs the manifest for authenticity — rbox's signed commit chain is the analog.

**Two divergences, both deliberate:**
1. **Per-file random key vs convergent.** gcrypt encrypts each pack with a fresh random key `Ki`
   (no dedup, no equality leak). rbox uses convergent encryption (dedups identical blobs across the
   workspace; leaks only equality, not plaintext — an accepted rbox-wide tradeoff). For the git
   bundle specifically there's no dedup either way (`git stash create` mints fresh bytes each
   capture), so the choice is moot there.
2. **Incremental packs vs full bundle (the scaling lesson).** gcrypt appends packfiles (the `L:`
   list grows), uploading only new objects. §28 uploads a full `git bundle --all` whenever git
   state changes — so a single new commit re-uploads the ENTIRE history. gcrypt's README warns this
   exact model "becomes slower over time… can easily get to the point that continued usage is
   impractical" for large/long-lived repos. **§28 v1 accepts this** (simple, correct, fine for
   typical dev repos; the `gitIdentityKey` skip means an unchanged repo re-uploads nothing). The
   documented future optimization is gcrypt-style **incremental encrypted packs**: track the pushed
   object set, bundle only `--not` the already-uploaded refs, and keep an (encrypted) pack list in
   the GitSection — turning push cost from O(history) into O(delta). Deferred until a measurement
   shows full-bundle re-upload is a real cost at our scale.
