# 84 — Commit envelope at O(change): manifest delta encoding

Status: Design draft 2026-07-08, revised same day after adversarial review
(codex gpt-5.5: 3 blockers, 4 majors — all addressed below) + cross-design seam
review. Full-stack (client wire/storage + a minimal server-validated root
field). Target: staged — instrumentation first, then fleet-wide read capability
before ANY write-side change (§6). Gated per host like designs 81–82.
Origin: post-v0.9.10 profiling. Design 82 made the encrypt/address side
O(change) and re-instrumented the push; with the quadratic gone, `commit` is
the largest phase on every **changed push** (git-plan owns the no-op tick and
scan owns the walk — other designs own those). This design attacks the commit
envelope.
Method lineage: design 79 compress-before-encrypt, design 43 manifest schema
gates, design 82 measure-first / phase-the-invisible-zone. In-repo precedent
for chain-with-recompaction sizing triggers: the git `packChain`
(design 43 §6.5 / 79) — with the caveat that packChain links are append-only
bundles, whereas a manifest delta is an op log over keyed paths, so this design
specifies its own canonical op-reduction rules (§3.2) rather than leaning on
the analogy for correctness.

All numbers are measured on 2026-07-08 on the founder's real workspace
(`ws_2b6e15da`, 116,879 files / 98 git repos, Mac WiFi + wired Linux) unless
marked inferred.

## 1. Problem and evidence

Measured = observed on the named 2026-07-08 workload. Inferred = follows from
those measurements but still needs the phase-0 measure step (§5) and the
per-host gate (§7). Design 82's lesson is load-bearing here: **priors get
falsified.** §5 exists to falsify this section's decomposition before any
delta code ships.

1. **`commit` is 13.2–17.5s on every changed push, independent of change size,
   measured.** A 44-byte one-file change measured a 54.3s push whose `commit`
   phase alone was 17.5s (design 82 §6.1 gate-1 dev run: `git-plan 24.2s,
   commit 17.5s, scan 7.3s, missing 4.1s`). The commit cost does not scale
   with the change — it scales with the workspace. Scope note: `commit` is the
   largest phase of a *changed push*; the no-op daemon tick is owned by
   git-plan (24–25.5s) and the walk by scan — both are other designs'
   non-goals here (§8).
2. **`latest` is 2.2–7s per pull, measured.** Every pull re-downloads and
   re-parses the full encrypted manifest blob.
3. **The manifest is ~47MB of uncompressed JSON, re-encoded/re-encrypted/
   re-uploaded whole per commit, measured.** `commit()` does
   `manifestJson: new TextEncoder().encode(JSON.stringify(manifest))`
   (`src/cli/e2ee-remote.ts:426`) over all 116k `FileEntry`s, AES-GCM-encrypts
   the result (`src/engine/e2ee/manifest-crypto.ts:32-47`), and uploads it as
   one content blob addressed by `encManifestSha`
   (`src/cli/e2ee-remote.ts:430`, `this.api.putBlobBytes`). Note design 79
   compressed the *file blob payloads*, NOT the manifest blob — the manifest
   is still raw JSON. The local `state.json` holding the equivalent folded
   manifest measured **45MB on disk**
   (`/Users/via/Development/.rbox/state.json`, `du -sh`).
4. **The server stores it as one opaque R2 blob per commit, measured.** The
   commit body carries only `encManifestSha` (a 64-hex string); the encrypted
   bytes are a normal content blob at `blobs/sha256/<aa>/<sha>`
   (`apps/api/src/util.ts:20`). `latest` returns the opaque `SignedCommit`;
   the client parses `encManifestSha` and does a separate `GET /v1/blobs/:sha`
   (`src/cli/e2ee-remote.ts:193`, `blobStore().get(body.encManifestSha)`),
   then decrypts + `JSON.parse`s + `validateManifest`s
   (`src/cli/e2ee-remote.ts:196-198`) — **with no envelope handling and no
   fallback**: any byte shape other than a raw JSON `Manifest` is a hard
   error on today's readers. This fact drives the §6 phasing. Server is
   zero-knowledge: **it cannot read, fold, or compact the manifest.** Any
   compaction is client-side, by construction.
5. **So steady-state is O(workspace) per commit AND per pull,
   measured/inferred.** Design 82 killed the O(N²) address path and the O(N)
   is now the floor: a fleet doing ~18 sequences in ~100 minutes (design 82
   §1.6) re-ships 47MB of manifest ~18 times an hour to encode a few bytes of
   real change each.
6. **This multiplies through 409 recovery, measured-adjacent.** A 409
   (parent-seq race, `apps/api/src/workspace-sync.ts:289`) forces pull-first +
   re-scan + re-commit — another full 47MB encode/encrypt/upload. Design 82
   shrank the window; the commit envelope is the largest single term left
   inside it on the changed-push path.

## 2. Root cause

The manifest is transmitted and stored as a **whole-object snapshot per
commit.** That was the right call at design 12 (simplicity, immutable
verifiable chain, zero-knowledge server) and it stays correct — but it makes
the per-commit cost proportional to workspace size, not change size, on three
axes that design 82 did not touch: JSON encode, AES-GCM encrypt, and R2 upload
of ~47MB; plus the symmetric download + parse on every pull.

Nothing about the *content* forces this. Between two adjacent sequences the
manifest changes by O(files touched) entries. The snapshot re-ships the other
116k unchanged entries every time. The fix is to transmit the change, not the
state.

## 3. Design — manifest delta encoding

### 3.1 Invariant summary (the contract the rest of §3 keeps)

- **I1 — envelope, not schema, discriminates.** The encrypted-manifest *blob*
  becomes a self-describing envelope: `snapshot` (full manifest, optionally
  zstd-compressed) XOR `delta` (ops against a named base). The decrypted
  plaintext still folds to a manifest that passes `validateManifest`
  unchanged. `manifestSchema` inside that folded manifest keeps its design-79
  meaning.
- **I2 — the server never reads the envelope.** Delta vs snapshot lives
  *inside* the AEAD ciphertext. The server continues to treat `encManifestSha`
  as an opaque blob. The ONLY server-visible addition is §3.5's
  `manifestChain` root list — ciphertext addresses, validated server-side, no
  content.
- **I3 — every chain terminates at a snapshot, and every link is GC-rooted.**
  A delta names its base by the base blob's `encSha` and by the base folded
  manifest's canonical hash. Folding a chain always bottoms out at a
  `snapshot` envelope, and `manifestChain` roots every link (§3.5). A missing
  link is therefore an **invariant violation**, surfaced loudly — never a
  silently-recovered case (§3.6).
- **I4 — deltas never cross a key/account epoch boundary.** The first commit
  after any rotation is a snapshot (§4.1).
- **I5 — folding is a pure, total, deterministic function.** `fold(base, ops,
  generatedAt)` reproduces the writer's folded manifest **byte-for-byte in
  canonical form**, including `generatedAt`: the delta envelope carries the
  folded manifest's `generatedAt` verbatim, and the canonical manifest hash
  (§3.2) covers it. `Manifest.generatedAt` is mandatory and stamped per scan
  (`src/engine/types.ts:106`, `src/engine/manifest.ts:53`), so ops alone
  cannot reproduce the writer's fold — carrying it in the envelope is what
  makes `resultHash` checkable with zero validator changes. (Alternative —
  hashing a canonical form with `generatedAt` normalized out — was rejected:
  it forks "manifest hash" into two definitions for no gain.)
- **I6 — canonical delta form (wire hygiene).** At most ONE final op per file
  path and per git-repo key; ops sorted deterministically (§3.2). Correctness
  does not depend on this — `resultHash` is computed over the folded result —
  but a non-canonical op set is rejected at decode as malformed, so the wire
  format has exactly one encoding of any given change.
- **I7 — trash/tombstone invariance.** The folded manifest is
  indistinguishable from a snapshot, so reconcile/trash (design 50) semantics
  are unchanged (§4.5).

### 3.2 Wire / storage format

The plaintext that gets AES-GCM-encrypted into the `encManifest` blob becomes
a tagged envelope (canonical JSON via the existing JCS canonicalizer,
`src/engine/e2ee/jcs.ts`; the AAD in `manifest-crypto.ts:21` already binds
`accountId`/`workspaceId`/`keyEpoch`, so the envelope inherits that binding):

```jsonc
// snapshot — today's manifest, wrapped; `comp` optional (zstd over the
// serialized manifest bytes, reusing design 79's zstd machinery)
{ "kind": "snapshot", "comp": "zstd"?, "manifest": <Manifest | zstd payload>,
  "manifestHash": "<canonical hash of the Manifest>" }

// delta
{
  "kind": "delta",
  "baseEncSha": "<encSha of the immediate base blob>",       // the blob to fetch next
  "baseManifestHash": "<canonical hash of the base FOLDED manifest>",
  "generatedAt": "<the folded manifest's generatedAt, carried verbatim>", // I5
  "ops": [ /* canonical op list, see below */ ],
  "resultHash": "<canonical hash of this commit's folded manifest>"
}
```

**Canonical manifest hash** = sha256 of the JCS canonical form of the full
`Manifest` object (`generatedAt`, `files`, `gitRepos`, `manifestSchema` — all
of it). One definition, used for `manifestHash`/`baseManifestHash`/
`resultHash` and persisted client-side (§3.4).

Op set (minimal — content addressing removes the need for a rename op):

- `{ "op": "set", "entry": <FileEntry> }` — add or modify a path (full entry;
  entries are small and self-validating via `validateManifest`'s per-entry
  rules; no field-level diffs).
- `{ "op": "del", "path": "<relPath>" }` — remove a path.
- `{ "op": "git-set", "repo": "<key>", "section": <GitSection> }` /
  `{ "op": "git-del", "repo": "<key>" }` — the `gitRepos` map, same shape.

**Canonical form and reduction rules (I6).** packChain is weak precedent here
— its links are append-only bundles; an op log over keyed paths has conflicts
to resolve. So, explicitly:

1. **Reduction:** the writer reduces the raw change stream to at most one
   final op per key. Key = `path` for file ops, `repo` for git ops (the two
   keyspaces are disjoint by `validateManifest`'s collision rule). Last write
   wins within a key: `set` then `del` → `del`; `del` then `set` → `set`;
   `set` then `set` → the last `set`. A key whose final state equals the base
   state emits NO op.
2. **Order:** ops sorted by (opFamily: file < git), then key ascending by
   code-point order — the same sort `scanManifest` uses for `files`
   (`manifest.ts:53`).
3. **Fold:** apply `set`/`del` onto the base's path-indexed map, apply
   `git-set`/`git-del` onto `gitRepos`, re-sort `files`, stamp the envelope's
   `generatedAt`, recompute `manifestSchema` stamping on the folded result,
   run `validateManifest` on the fold.
4. **Decode-side enforcement:** duplicate keys, unsorted ops, or a no-op
   (`set` identical to the base entry) are rejected as malformed — one
   encoding per change. `resultHash` remains the correctness authority
   regardless.

A **rename is `del old` + `set new`** — no dedicated op. The moved bytes are a
content-addressed blob already shared by `encSha`, so no blob re-ships.

`manifestSchema` and `gitRepos`-schema stamping (`manifest-validate.ts`,
`sync-git.ts:88`) are computed on the FOLDED manifest, not the delta, so
§43/§79 schema gates are untouched by the transport.

### 3.3 Who compacts, and when

The server cannot fold (I2/E2EE, §1.4). **The committing client is the only
actor that can compact**, and it does so by choosing to emit a `snapshot`
instead of a `delta` for a given commit. The choice is local and needs no
server coordination.

Snapshot (compaction) triggers — the committing client emits a `snapshot` when
ANY holds, else it emits a `delta` based on the current head:

1. **Genesis / no resolvable base** — the first commit, the first commit after
   upgrading to the §3.4 state fields, or the client's local base metadata
   doesn't match the head (e.g. right after a re-baseline, or after a §3.6
   chain-integrity failure with an intact local base). Can't delta without a
   verified base.
2. **Epoch boundary (I4)** — `keyEpoch`/`accountEpoch` differs from the base
   commit's. Rotations are rare; a snapshot per rotation is cheap insurance.
3. **Chain-length cap** — the fold chain would exceed
   `MAX_MANIFEST_DELTA_CHAIN` (open decision §10; propose 16 — manifest deltas
   are far cheaper to fetch than git packs, hence more headroom than
   `MAX_PACK_CHAIN=8`). Enforced server-side too (§3.5).
4. **Byte-bound recompaction** — cumulative delta bytes since the base ≥ base
   snapshot bytes: the `exceedsPackChainByteBound` heuristic
   (`src/cli/sync-git.ts:102-106`), which IS sound precedent for *sizing*
   (only the op semantics needed their own spec, §3.2). Once the deltas cost
   as much as a fresh snapshot, ship the snapshot and reset the chain.
5. **Retention guard (defense-in-depth for I3)** — never let a live chain's
   base fall below where a re-baselining peer could still fetch it. In
   practice subsumed by (3)/(4) at fleet scale, but stated so a future
   retention change can't silently strand a chain.

### 3.4 Client state: base metadata + pull-side reconstruction

The local folded-manifest cache **already exists**: `state.json`'s
`lastSyncedManifest` (`src/cli/config.ts:100`, measured 45MB). But today's
`SyncState` carries **no** `encManifestSha` and no folded-manifest hash
(`src/cli/config.ts:94-100`) — a delta writer can't prove its in-memory base
matches the head. So `SyncState` grows three optional fields (a
backward-tolerant addition: old state files load with them `undefined`, which
simply forces the first post-upgrade commit down the snapshot path — trigger
§3.3.1):

```ts
/** encManifestSha of the blob whose fold equals lastSyncedManifest. */
lastSyncedEncManifestSha?: string;
/** Canonical hash (§3.2) of lastSyncedManifest — the delta writer's
 *  baseManifestHash and the pull-side fast-path check. */
lastSyncedManifestHash?: string;
/** Chain position: the terminal snapshot + cumulative link count/bytes —
 *  the §3.3.3/4 trigger inputs. */
manifestChainPos?: { snapshotEncSha: string; links: number; bytes: number };
```

Maintenance is exactly the existing `saveState` sites:

- **Push commit** (`sync.ts:615`): store the just-built envelope's
  `encManifestSha`, the folded hash (= the `resultHash` the writer computed
  anyway), and the updated chain position (snapshot → reset; delta →
  increment links/bytes).
- **Pull apply** (`sync.ts:296`): store the head's `encManifestSha`, the
  verified fold's hash, and the chain position read off the fetched chain.
- **409 recovery**: recovery *is* a pull then a fresh commit attempt, so both
  paths above run in order — no third path exists (`pushManifest`'s
  pull-first action re-enters pull, then the retry re-enters push against the
  refreshed base).

Pull-side reconstruction:

- **Fast path (steady state):** `latest` returns the head commit; fetch +
  decrypt the head blob. If it's a `delta` whose `baseEncSha ===
  lastSyncedEncManifestSha` and `baseManifestHash ===
  lastSyncedManifestHash`, apply ops onto the in-memory `lastSyncedManifest`
  → O(change) pull, no 47MB parse. (This is Phase D; until then the client
  folds from the fetched chain.)
- **Chain fetch:** otherwise fetch each `baseEncSha` down the chain until a
  `snapshot` or a link matching the persisted base, then fold forward.
  Bounded by `MAX_MANIFEST_DELTA_CHAIN`.
- **Fold cache:** a tiny in-process LRU of `encManifestSha → folded Manifest`
  (the just-fetched base + new head) so `verifiedHead`/history re-folds don't
  re-parse. Persisted state stays exactly one folded manifest.

The `commitsSince` verification path (`e2ee-remote.ts:228`, hash-chain verify)
is untouched — it verifies opaque `SignedCommit`s and never needed the
manifest bytes. Only `decodeManifestAt` (`e2ee-remote.ts:190`) learns to fold.

### 3.5 Server storage, serving, and `manifestChain` validation

Storage: **unchanged.** A delta's `encManifest` is still one opaque content
blob at `blobs/sha256/<aa>/<sha>`, uploaded via the receipts path and
charged/present-flagged like any blob. `latest`/`commits?since`/`commitAt`
return opaque `SignedCommit`s verbatim — no change.

**The one server-readable addition: `manifestChain` in the signed commit
body.** GC roots today are parsed *from the commit body with no R2 fetch*: per
retained commit the reachable set is `{encManifestSha, ...encShas}`
(`apps/api/src/workspace-sync.ts:403,416-418`), and GC **condemns anything not
named** (§24.3 fail-closed). A delta's `encManifestSha` names only the delta
blob — its base blobs would be invisible to the mark phase and reclaimable out
from under a live chain. Fix: the delta commit body carries
`manifestChain: string[]` = the encShas of the terminal snapshot + every
intermediate delta blob needed to fold this commit, base-first. A snapshot
commit carries `manifestChain: []` or omits it — absent ≡ empty, which is
also the backward-compat reading of every pre-84 commit.

This must NOT be a free GC-pinning channel. Today's commit handler runs every
data ref through presence/entitlement/receipt accounting
(`apps/api/src/workspace-sync.ts:216-246` builds the existence set;
`apps/api/src/commit-accounting.ts:57` charges/grants and clears prune
markers), and `manifestChain` gets the same treatment, minus charging (each
named blob was already charged by the commit that created it):

1. **Shape gate (reject 400):** every entry 64-hex; length ≤
   `MAX_MANIFEST_DELTA_CHAIN` (server-enforced, so a hostile client can't ship
   a 10k-entry pin list); no duplicates. Body-size is a non-issue: 16 × 64
   hex ≈ 1KB inside the verified `MAX_COMMIT_BODY = 1MB`
   (`apps/api/src/commit-envelope.ts:15`).
2. **Presence/ownership gate (reject 422, same shape as unsatisfied_blobs):**
   every `manifestChain` entry must be a present, entitled blob in THIS
   workspace's account — it joins the same existence-set check the data refs
   already go through (`workspace-sync.ts:244` unions `encManifestSha` +
   sidecar + refs; the chain entries union in beside them). In the honest
   path each entry is a prior commit's `encManifestSha` in the same
   workspace, so this always passes; anything else is malformed or
   cross-tenant pinning and is refused.
3. **Prune-marker interaction:** naming a blob in `manifestChain` refreshes
   its liveness exactly like a data ref (clears any pending prune/condemn
   marker via the same `commit-accounting.ts` pass) — otherwise a chain link
   GC had marked between commits could be swept despite the new root.
4. **`roots()` union (one line):** the reachable set per retained commit
   becomes `{encManifestSha, ...manifestChain, ...encShas}`
   (`workspace-sync.ts:416-428`). No R2 fetch — preserving the existing
   no-fetch mark phase.

Accounting/entitlement note: `manifestChain` is a distinct axis (manifest
blobs) from `blobRefs`/`blobRefset` (file-content blobs); it is validated and
GC-rooted but never re-charged, so quota math is unperturbed.

### 3.6 Integrity and failure handling (I3) — fail closed, no fictional fallback

Every `delta` names its base twice: `baseEncSha` (which blob to fetch) and
`baseManifestHash` (what the base must fold to); `resultHash` self-checks the
fold. The AEAD open (`manifest-crypto.ts:56-63`) authenticates every blob
under the workspace manifest key + `keyEpoch` AAD before any of this runs, so
a server cannot substitute forged bytes; the hashes are integrity-of-chain on
top of authenticated plaintext.

**There is no "fold around a missing link."** The chain is linear and the
server is zero-knowledge: if an intermediate delta blob is missing or fails
its hash check, its ops are unrecoverable by anyone except a writer that
holds the folded state. The failure semantics are therefore:

1. **Reader hits an unresolvable chain** (missing link, `baseManifestHash` /
   `resultHash` mismatch, chain over cap, epoch discontinuity inside a
   chain): **fail closed** — the pull errors loudly, nothing is applied, and
   the error names the failing link. Because §3.5 GC-roots every link and
   validates presence at commit time, this state is an invariant violation
   (server data loss, or a buggy/hostile writer) — it must surface, not be
   papered over.
2. **Recovery is write-side or re-baseline, explicitly:**
   - (a) any **writer** device (one holding a valid folded base — in the
     2-device fleet, almost always the other machine, or this one after its
     own next scan) emits a **fresh snapshot commit**, which resets the chain
     for the whole fleet. The daemon does this automatically when its own
     pull fails with a chain-integrity error but its local base is intact
     (§3.3.1: treat the chain as unresolvable ⇒ snapshot on next push).
   - (b) a **reader** with no valid base re-baselines (§4.3), landing on the
     head; if the head itself is chain-broken, only (a) can repair, and the
     CLI says exactly that ("manifest chain integrity failure at <encSha>;
     push from another device to reset, or restore via versions/trash").
3. `rbox doctor` learns a chain check: walk the head's `manifestChain`,
   verify presence + hashes, report length/bytes vs the §3.3 triggers.
   Cheap, and turns the invariant into something monitorable.

## 4. Interplay to address explicitly

### 4.1 Key epochs / account epochs
A delta's base manifest was encrypted under the base commit's `keyEpoch`; the
manifest key is HKDF'd per epoch (`manifest-crypto.ts:18`) and the AAD binds
it. A rotation (new `account_epoch`) changes the derivation. **Invariant I4:
the first commit after any epoch change is a snapshot** — deltas never span
epochs. This lines up with the existing guard: the server rejects a commit
signed under a non-current epoch with `409 epoch_stale`
(`workspace-sync.ts:296`); the client's retry re-signs, and on that path it
also re-snapshots. Historical folds (`manifestAtSeq`, `pathHistory`) decrypt
each link under the link's own epoch via `openCommitHistorical` — and since no
chain spans an epoch, every link of one chain shares one KEK.

### 4.2 409 conflict recovery (the incident driver)
A 409 means our `parentSeq` lost the race; recovery pulls the new head, folds
it into `lastSyncedManifest` (updating §3.4's base metadata), re-scans, and
re-commits. Because the delta is **always computed against
`lastSyncedManifest` + `lastSyncedManifestHash` at commit time**, the
re-commit naturally re-bases onto the new head — no special rebase logic. And
it compounds the design-82 win: a delta commit is small, so the
encode/encrypt/upload inside the 409 window shrinks from ~47MB to ~KB, which
shrinks the window, which makes 409s rarer.

### 4.3 Re-baseline under delta chains (anti-rollback, explicit)
Today `commitsSince` 409s with `needs_rebaseline` when the span exceeds 5000
or a pruned gap breaks the chain (`workspace-sync.ts:470,476`) — and
`verifiedHead()`'s pull path does NOT handle it (`e2ee-remote.ts:228` lets
`NeedsRebaselineError` propagate; only the history helper catches it,
`e2ee-remote.ts:352`). Delta chains make re-baseline more consequential (a
long-offline device), so the trust transition is specified rather than
inherited:

1. Re-fetch + re-verify the account chains (`refreshAccount` — roster,
   key-state, account-level anti-rollback pins are unchanged).
2. Fetch `latest`; verify the head `SignedCommit`'s signature against the
   verified roster's device keys (same `verifyCommitSig` as chain verify).
3. **Anti-rollback floor:** the head's SIGNED `seq` must be `>` the locally
   pinned `commitSeq` — a re-baseline may skip history it can no longer
   verify link-by-link, but it must never move the pin backward or sideways
   (equal seq with a different hash = equivocation, refuse; the existing
   pinned-seq equivocation check at `e2ee-remote.ts:224` is the same rule).
4. Decode the head's manifest by folding its `manifestChain` from the
   terminal snapshot (every link rooted ⇒ present; if not, §3.6 fail-closed).
5. Only after the fold verifies (`resultHash`) does the client re-pin and
   apply. Pin + §3.4 base metadata update land in the same `saveState`.

What re-baseline gives up — signature-verified *continuity* between the old
pin and the new head — is exactly what it gives up today (`MAX_COMMIT_SPAN`
already forces it); the floor rule is what keeps it monotone. Delta encoding
adds only step 4's fold cost: one snapshot + ≤K small deltas, ≈ today's full
fetch.

### 4.4 Design-70 cache gateway
No interaction. `CachedReleases` serves only the public release path from the
releases bucket, unauthenticated; the default entrypoint (sync/blobs/commits)
has Workers Cache disabled and a `no-store` egress guard. Manifest blob
fetches (`GET /v1/blobs/:sha`) ride the authenticated path and are never
edge-cached. Delta serving changes no route and no cache key. Stated so a
future cache-config flip gets evaluated against this.

### 4.5 Trash / tombstone semantics (design 50)
A `del` op is exactly the disappearance the pull-side reconcile/trash path
already consumes when a path is absent from the newer manifest. Because the
folded manifest is byte-identical to a snapshot fold (I5/I7),
`diffManifests`/reconcile/the trash tier see the same add/modify/delete set
they see today — delta encoding is invisible below the fold. The design-50
stale-unlink and type-flip guards (`manifest.ts:80-140`) operate on the folded
manifest and are untouched. The fold-equals-scan property test (§7.4)
certifies this.

## 5. Instrumentation — phase-0, measure before building (design 82's lesson)

Design 82 falsified its own git-recapture prior with measurement; this design
must falsify its decomposition of `commit` before writing the delta engine.
The 17.5s could be dominated by any of encode / encrypt / upload, and the
right sequencing differs per case.

Phase-0 (= rollout Phase A, §6) adds sub-step decomposition and reads real
numbers on both hosts FIRST:

1. **Commit decomposition — via `recordDetails`, NOT new phases.** The
   `commit` phase timer already covers the interval; first-class child phases
   in `PhaseName`/`PHASE_ORDER` would double-count wall time and break design
   82's ≥85% coverage arithmetic. The details channel exists for exactly this
   (`src/engine/phase-report.ts:167`, `recordDetails(name, details,
   summary?)`): record `commit` details
   `{encodeMs, encryptMs, uploadMs, encBytes}`. `PhaseName`/`PHASE_ORDER`
   are untouched. (Shared convention with designs 83/85: sub-step
   decomposition rides `recordDetails` on the owning phase.)
2. Same for `latest`: details `{downloadMs, decryptMs, parseMs, encBytes}`.
3. Publish the measured split in §6's gate record before any write-side work
   starts, the way design 82 §6.1 recorded gate results.

**Decision rule, with the arithmetic stated (falsifiable priors up front).**
Compression (Phase C1) cuts upload bytes ~8x (47MB→~6MB, inferred from design
79's measured ratios) but leaves encode+encrypt O(N) and adds zstd CPU. For
compression ALONE to hit the §7 commit gate of ≤3s:

- at `commit` = 17.5s: need `rest + upload/8 ≤ 3` with `rest + upload = 17.5`
  ⇒ `upload ≥ 14.5/0.875 ≈ 16.6s` ⇒ upload must be **≈95%** of the phase;
- at `commit` = 13.2s: `upload ≥ 10.2/0.875 ≈ 11.7s` ⇒ **≈89%**;
- and both ignore zstd compress time, which only raises the bar.

So the prior is explicit: **compression is an early cheap win, not the
endgame.** The delta engine (C2/D) stays committed unless phase-0 measures
≥90% upload dominance on BOTH hosts AND the post-C1 re-measure passes the §7
gates on both hosts — in which case C2/D defer with the measurement on record
(demoted open decision §10.4).

## 6. Staged rollout (largest of the three envelope designs — phase it)

Hard rule, restated because the first draft violated it: **no write-side
change of any kind ships before fleet-wide read capability.** Today's readers
decrypt → `JSON.parse` as a raw `Manifest` → `validateManifest`, with no
envelope handling and no fallback (`src/cli/e2ee-remote.ts:190-198`,
`src/engine/manifest-validate.ts:48`) — a compressed snapshot is exactly as
unreadable to them as a delta.

**Phase A — instrumentation only, zero behavior change.** Ship §5's
`recordDetails` decomposition of `commit` and `latest`. Read the split on
both hosts. Nothing else.

**Phase B — read capability for the FULL envelope, fleet-wide.** All clients
learn to *read* everything §3.2 defines: `snapshot` (raw AND zstd), `delta`,
chain fetch, fold, canonical-hash checks, §3.6 fail-closed handling, §4.3
re-baseline. Clients still *write* raw snapshots only. Pure capability, zero
wire change. Ship to BOTH fleet hosts and confirm (daemon soak + a forced
pull) before anything in C. This is the compat contract: the fleet reads the
full envelope before any writer emits any of it.

**Phase C1 — write compressed snapshots.** The cheap win: `kind: "snapshot",
comp: "zstd"` (~47MB→~6MB upload, inferred). Also adds §3.4's state fields
(useful from here on). Re-measure against §5's decision rule.

**Phase C2 — write deltas.** The committing client emits deltas per §3.3;
the commit body carries `manifestChain`; the server validates it per §3.5 and
`roots()` unions it. Server change is additive and backward-compatible
(absent `manifestChain` ≡ `[]` — every pre-84 commit). Gated on B being
fleet-confirmed and on C1's measurements confirming the delta engine is still
needed (§5 decision rule).

**Phase D — pull-side O(change) fold from the local cache.** Optimize the
pull `latest` path to apply head deltas onto the in-memory
`lastSyncedManifest` via §3.4's fast path, closing the loop on the `latest`
phase cost.

Each phase is independently shippable and gated. B strictly precedes C1 and
C2; C1 precedes C2 (for the §5 measurement sequencing, not for safety).

## 7. Per-host acceptance gates

Same discipline as designs 81–82: compiled dev build vs the prior release,
A/B on both fleet hosts, serialized on the shared WAN. **Fleet rule (shared
with designs 83/85): only one design's A/B gate window runs on the shared WAN
at a time** — concurrent gate runs contend for the same uplink and
cross-contaminate both designs' numbers. Numbers below are targets pending
the Phase-A read (which may move them — say so, don't fake precision).

1. **Mac, one-file commit (C2).** `RBOX_METRICS=1 rbox push` with a 1-file
   touch, daemon stopped. Pass: `commit` phase ≤ **3s** (from 13.2–17.5s);
   commit details show `encBytes` ≤ **200KB** (from ~47MB raw / ~6MB
   compressed); design-82 phase coverage ≥85% preserved (no new phases, so
   this is a regression check on the `recordDetails` approach).
2. **Linux, one-file commit (C2).** Same, `commit` ≤ **4s** (weaker single
   core; encode/encrypt is CPU-bound).
3. **Pull `latest` (D).** A steady-state pull applying a small delta:
   `latest` ≤ **2s** (from 2.2–7s), details showing `parseMs` no longer
   O(47MB).
4. **Correctness property tests (block C2 merge):**
   - fold-equals-scan (I5): `fold(base, ops)` deep-equals an independent
     `scanManifest` of the same tree, over randomized
     add/modify/delete/rename op sets, including `generatedAt` carry and
     canonical-hash equality.
   - canonical form (I6): op reduction produces one op per key in sorted
     order; decode rejects duplicates/unsorted/no-op sets.
   - chain integrity (§3.6): a missing/corrupted intermediate link fails
     closed (nothing applied, loud error naming the link); a writer-side
     snapshot commit recovers the fleet; `resultHash`/`baseManifestHash`
     mismatches fail closed.
   - epoch boundary (I4): a simulated rotation forces a snapshot; decode
     rejects a chain spanning epochs.
   - re-baseline (§4.3): a client below the prune floor re-baselines with
     the anti-rollback floor enforced (head seq > pin;
     equal-seq-different-hash refused).
   - cross-host rename round-trips end-to-end through the delta path (the
     design-82 rename test, re-run).
   - trash/tombstone (I7): a `del` op drives the same reconcile+trash
     outcome as the same deletion via snapshot.
5. **Server validation tests (block C2 merge):** `manifestChain` over-cap /
   non-hex / duplicate / absent-blob / cross-workspace entries rejected
   (§3.5.1–2); prune-marker refresh on chain entries (§3.5.3); `roots()`
   names every live chain link after a prune below the base's sequence; a
   mark/sweep dry-run condemns nothing a live head folds through.
6. **Daemon soak (C2):** one natural churn cycle per host on the dev build;
   chain length/bytes observed within §3.3 triggers; zero chain-integrity
   errors in `daemon.log`.
7. **Full `bun test` green; typecheck green** (design 82's known-local
   json-output env failure excepted).

## 8. Non-goals

Owned by other designs / explicitly out:

1. **Git-plan subprocess cost** (design 82 §7.3; `git-plan` was 24.2s and
   owns the no-op tick). Not this design.
2. **Scan cost** (design 82 §7.1). Not this design.
3. **Chunked / block-level file sync (§40).** Deltas here are manifest-entry
   granular, not intra-file. A 1-byte change to a 1GB file still re-ships
   that blob; that's §40's problem.
4. **Blob-level dedup changes.** The blob store and convergent encryption are
   untouched; a rename still shares a blob by `encSha`.
5. **Changing the verifiable commit chain / signature model.** The
   `SignedCommit` hash-chain, Ed25519 sigs, and `commitsSince` verification
   are unchanged; deltas live in the manifest blob + a validated metadata
   root list, never in the trust model.
6. **RSS / memory.** Folding onto an in-memory 45MB manifest is the same
   order as today's parse; not a memory-reduction design.

## 9. Risks

1. **Phase-0 falsifies the split (mitigated by §5).** The decision rule and
   its arithmetic are pre-registered so the outcome is a measurement, not a
   negotiation.
2. **GC stranding a live chain (mitigated by §3.5 + §7.5).** The one
   genuinely dangerous coupling — a mark phase that can't see a delta's base,
   or a prune marker racing a new chain root. Fail-closed roots, server-side
   chain validation, prune-marker refresh, and a dedicated GC gate are the
   defense. Review this hardest.
3. **Fold correctness (mitigated by I5/I6 + §7.4).** A subtle fold bug
   silently corrupts a workspace. Fold-equals-scan property tests over
   randomized op sets, canonical-form rejection at decode, and `resultHash`
   verification on every fold catch it before apply.
4. **Chain-integrity failure is now a hard stop (accepted, by design).**
   §3.6 trades the first draft's fictional fallback for loud failure + writer
   snapshot recovery. In a 2-device fleet the other device is almost always a
   capable writer; with one device online, the CLI's recovery message and the
   `rbox doctor` chain check are the mitigation. Strictly better than
   applying a wrong manifest.
5. **Compat mis-sequencing (mitigated structurally by §6).** Any write-side
   emission before Phase B is fleet-confirmed bricks old readers' pulls
   (§1.4: no fallback exists — this killed the first draft's Phase A). B
   before any write is the hard gate; with 2 devices it's one coordinated
   release, but the contract must hold for N>2.
6. **Chain-length pathology.** Degenerate churn could grow chains; the
   byte-bound + length cap (client §3.3, server §3.5.1) bound it, and
   re-baseline (§4.3) is always available. Watch chain stats in the soak.

## 10. Open decisions (founder-level calls)

1. **Snapshot cadence constants.** `MAX_MANIFEST_DELTA_CHAIN` (propose 16)
   and whether byte-bound (§3.3.4) or length cap should be primary. Cheaper
   fetches argue for a longer chain than git's 8; the server cap (§3.5.1)
   must match the client constant.
2. **Compat window.** How long the fleet writes raw snapshots after Phase B
   before C1/C2 enable. With 2 devices this can be one release; the contract
   (B fleet-confirmed before any write change) is the invariant, the
   *duration* is the call.
3. ~~Ship read-side first?~~ **Resolved: yes, structurally** — the §6
   phasing makes read capability (B) a hard precondition of every write-side
   phase, per review. No longer a decision.
4. **(Demoted per review.)** ~~Is compression alone enough?~~ C1 is an early
   cheap win on the way to C2, not a candidate endpoint. The delta engine
   ships unless phase-0 measures ≥90% upload dominance on both hosts AND
   post-C1 re-measurement passes the §7 gates on both hosts (§5 arithmetic:
   ≤3s from 17.5s needs upload ≈95% of the phase before zstd CPU is even
   counted — an unlikely prior). If that unlikely branch hits, C2/D defer
   with the measurement on record.
5. **Delta op granularity.** File-entry granular only (proposed), or
   field-level diffs for large-entry churn? Proposed no — full-entry `set`
   keeps fold trivial and entries are small.
6. **Local fold-cache persistence.** Keep exactly one persisted folded
   manifest (`lastSyncedManifest` + §3.4 metadata, proposed) vs persist the
   last few by `encManifestSha` to speed `versions`/`pathHistory` re-folds.
   Proposed: one on disk, small in-process LRU; revisit if history commands
   become hot.

## 11. Lessons (to fill after the gate, per design 82 §8)

Reserved. Candidates going in: (a) the manifest was re-shipped whole for ~50
designs because "the server stores it as a blob" hid the O(N) where no phase
timer looked — design 82 §8's blind-spot class; (b) the first draft of this
design proposed a chain fallback that was information-theoretically impossible
(folding past a missing delta in a linear op chain) and a write-before-read
rollout — both caught by adversarial review, neither by self-review. Confirm
or correct after phase-0.
