# 84 — Commit envelope at O(change): manifest delta encoding

Status: Design draft v7, 2026-07-10 — round-5 revision (ledger in
REVIEW-84.md). v7 closes round 5: the bounded-422 contract is explicit on
both sides (server fronts all chain misses in `missing` — they always fit —
on every 422 producer incl. the fence-abort path; client conservatively
snapshots on ANY truncated response with a non-empty attempted chain), and
`validManifestMeta`'s chain/bytes consistency is bidirectional
(`chainBytes === 0 ⇔ chain.length === 0`). v6 closed round 4's minor: `validManifestMeta` is a normative
runtime validator gating every meta consumption point (base selection, epoch
trigger, fast-fold match, byte arithmetic) — any partial/malformed persisted
meta normalizes wholesale to `undefined` (fail-to-snapshot), so no JS
coercion can fail a trigger open. v5 closed round 3: `GlobalManifestMeta.snapshotBytes` makes
the byte-bound trigger implementable (encode-then-compare, threshold includes
the proposed head, observed lengths propagated across deltas); repo-only
packets clear a stale meta via a normative rule inside `applyStateSavePacket`
(atomic with the accepted transitions — the packet shape has no global member
to carry a clear); `MAX_MANIFEST_PLAINTEXT`/`MAX_ENVELOPE_HEADER` are
normative protocol constants (only post-soak retuning stays open). v3 was the full round-1 rework against current main (designs
91/92/93/95/96); v4 closes round 2: repair mode bypasses the no-op/defer
short-circuits (an unchanged tree still publishes the healing snapshot);
`manifestSchema` is carried verbatim in the delta header (both transition
directions encodable); `GlobalManifestMeta` persists the base's signed
epochs (I4 has a truthful input) and the base's EXACT verified chain (the
fast path performs the full I3b list match, not an aggregate check); meta is
suppressed whenever the design-93 repo-pending projection diverges from the
described manifest; the recover ceremony retains the prior pin until the
replacement head verifies (equal-seq/different-hash refused against the
retained pin); `MAX_MANIFEST_DELTA_CHAIN = 16` is normative and the vacuous
retention trigger is replaced by the rooting proof. Full-stack (client
wire/storage + signed-body field + server validation/roots). Target: staged —
Phase A is *analysis of already-shipped instrumentation* (§5), then fleet-wide
read capability before ANY write-side change (§6). Gated per host like designs
81–82.
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
those measurements but still needs the phase-A analysis (§5) and the per-host
gate (§7). Design 82's lesson is load-bearing here: **priors get falsified.**
§5 exists to falsify this section's decomposition before any delta code ships.

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
   `manifestJson = new TextEncoder().encode(JSON.stringify(manifest))`
   (`src/cli/e2ee-remote.ts:456-463`) over all 116k `FileEntry`s, AES-GCM-
   encrypts the result (`src/engine/e2ee/manifest-crypto.ts:34-48`), and
   uploads it as one content blob addressed by `encManifestSha`
   (`src/cli/e2ee-remote.ts:480-486`, `this.api.putBlobBytes`). Note design 79
   compressed the *file blob payloads*, NOT the manifest blob — the manifest
   is still raw JSON. The local `state.json` holding the equivalent folded
   manifest measured **45MB on disk**
   (`/Users/via/Development/.rbox/state.json`, `du -sh`).
4. **The server stores it as one opaque R2 blob per commit, measured.** The
   commit body carries only `encManifestSha` (a 64-hex string); the encrypted
   bytes are a normal content blob at `blobs/sha256/<aa>/<sha>`
   (`apps/api/src/util.ts:20`). `latest` returns the opaque `SignedCommit`;
   the client parses `encManifestSha` and does a separate blob fetch
   (`src/cli/e2ee-remote.ts:205`, `blobStore().get(body.encManifestSha)`),
   then decrypts + `JSON.parse`s + `validateManifest`s
   (`src/cli/e2ee-remote.ts:208-213`) — **with no envelope handling and no
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
   (parent-seq race, `apps/api/src/workspace-sync.ts:385-402`) forces
   pull-first + re-scan + re-commit (`src/cli/sync.ts:489-493`) — another full
   47MB encode/encrypt/upload. Design 82 shrank the window; the commit
   envelope is the largest single term left inside it on the changed-push path.
7. **The measurement channel already exists (shipped, PRs #161/#165).** Commit
   details `{refreshMs, sidecarMs, encodeMs, encryptMs, uploadMs, postMs,
   encBytes}` are recorded by `src/cli/e2ee-remote.ts:502` and surfaced by
   `src/cli/sync.ts:673-682` (formatter `:93-94`); `latest` details
   `{downloadMs, decryptMs, parseMs, encBytes}` by `e2ee-remote.ts:214` /
   `sync.ts:224-227` (formatter `:95`). Types at `src/cli/remote/commits.ts:
   29-44`. Phase A (§5) is therefore reading these fields on both hosts, not
   building them.

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

- **I1 — the envelope, not the manifest schema, discriminates.** The
  encrypted-manifest *blob*'s plaintext becomes a magic-framed envelope
  (§3.2): `snapshot` (full manifest, optionally zstd-compressed) XOR `delta`
  (ops against a named base). The decrypted/folded result is a manifest that
  passes `validateManifest` unchanged. `manifestSchema` inside that folded
  manifest keeps its design-79 meaning. Legacy raw-v0 blobs (every pre-84
  commit) remain readable forever.
- **I2 — the server never reads the envelope.** Delta vs snapshot lives
  *inside* the AEAD ciphertext. The server continues to treat `encManifestSha`
  as an opaque blob. The ONLY server-visible addition is §3.5's
  `manifestChain` field in the signed commit body — ciphertext addresses,
  syntactically/presence-validated server-side, content never.
- **I3 — chain completeness is a two-sided invariant, honestly split.**
  (a) *Server side (enforceable):* every address LISTED in a commit's
  `manifestChain` is present + entitled at commit acceptance and joins the GC
  roots of every retained sequence that lists it (§3.5). The server CANNOT
  verify that the list matches the encrypted chain — it is zero-knowledge.
  (b) *Reader side (the completeness check):* every honest reader folds a
  delta head by walking the decrypted linkage and MUST verify the walked
  address sequence equals the signed `manifestChain` exactly — order,
  terminal snapshot, every link, no extras (§3.6.1). A commit whose list ≠
  chain is therefore *unreadable by every honest reader at first pull* and
  triggers the §3.6.3 repair, inside GC's grace window. The composite
  invariant this buys: **any commit that is both accepted and readable has
  its full chain GC-rooted.** A buggy/hostile signer can still publish an
  accepted-but-unreadable head — that is exactly as severe as publishing a
  garbage manifest today, and it is detected and repaired the same way
  (loud fail-closed read + §3.6.3), not silently.
- **I4 — deltas never cross a key/account epoch boundary.** The first commit
  after any rotation is a snapshot (§4.1). Defense-in-depth: the manifest
  AEAD's AAD binds `keyEpoch` (`manifest-crypto.ts:21-23`), so a cross-epoch
  link fails to open even if a buggy writer violates this.
- **I5 — folding is a pure, total, deterministic function.** `fold(base, ops,
  header)` reproduces the writer's folded manifest **byte-for-byte in
  canonical form**. Manifest-level scalars the ops cannot derive —
  `generatedAt` (mandatory, stamped per scan: `src/engine/types.ts:109-111`,
  `src/engine/manifest.ts:86-91`) and `manifestSchema` (stamped per commit:
  `src/cli/sync.ts:99-106`) — are carried VERBATIM in the delta header and
  covered by `resultHash`/the canonical manifest hash (§3.2), which is what
  makes the fold checkable with zero validator changes and no second copy of
  any stamping rule. Pure also means **non-mutating**: fold never modifies
  its base input (§4.6).
- **I6 — canonical delta form (wire hygiene).** At most ONE final op per file
  path and per git-repo key; ops sorted deterministically (§3.2). Correctness
  does not depend on this — `resultHash` is computed over the folded result —
  but a non-canonical op set is rejected at decode as malformed, so the wire
  format has exactly one encoding of any given change.
- **I7 — trash/tombstone invariance.** The folded manifest is
  indistinguishable from a snapshot, so reconcile/trash (design 50) semantics
  are unchanged (§4.5).
- **I8 — base metadata is part of the design-93 CAS unit.** The delta writer's
  base identity (`encManifestSha` + folded-manifest hash + signed epochs +
  exact verified chain)
  lives INSIDE `StateSavePacket.global` and lands only when the packet's
  stream/nonce/global-sequence preconditions accept (§3.4). It NEVER updates
  on verify-only pin advancement, decode/fold failure, partial apply, a
  rejected packet, or a repo-pending projection — the same applied-base rule
  design 92 established for push decisions.

### 3.2 Wire / storage format

**Framing (versioned, unambiguous).** The plaintext that gets AES-GCM-
encrypted into the `encManifest` blob (AAD already binds `accountId` /
`workspaceId` / `keyEpoch`, `manifest-crypto.ts:21-23`) is one of:

- **raw-v0 (legacy, write-default until Phase C1):** the exact bytes of
  `JSON.stringify(manifest)` — today's format, byte-identical. Every pre-84
  commit is raw-v0 forever (the chain is immutable), so readers support it
  indefinitely.
- **envelope-v1:** `"rbox-mde1\n"` (10 ASCII magic bytes) + one line of
  strict JSON (the header, terminated by the first `\n` after the magic) +
  the body bytes (everything after that newline, raw binary — no base64).

Discrimination rule (normative, deterministic):

1. Plaintext starts with `rbox-mde1\n` → envelope-v1; parse per below.
2. Plaintext starts with `rbox-mde` but a different version suffix → **fail
   closed**: `"manifest envelope version not supported — upgrade rbox"`. This
   is the forward-compat seam: a future v2 bumps the magic and old readers
   fail loudly, exactly like `manifestSchema`'s known-schema gate (design 43
   §2).
3. Otherwise → raw-v0: `JSON.parse` the whole plaintext as a `Manifest`,
   `validateManifest` as today (`e2ee-remote.ts:208-213`). A raw-v0 document
   carrying a top-level `type` or any `rbox-mde` ambiguity cannot arise from
   any rbox writer (`scanManifest` emits only `generatedAt`/`files`/
   `gitRepos`/`manifestSchema`, `src/engine/types.ts:109-120`); readers
   nevertheless treat step 1–2 as taking precedence, so the dispatch has no
   heuristic.

**Header (strict schema — unknown keys, wrong types, or out-of-bounds values
are malformed → fail closed):**

```jsonc
// snapshot
{ "kind": "snapshot",
  "comp": "zstd",              // OPTIONAL; absent = body is raw manifest JSON
  "bodyBytes": 47185920,       // UNCOMPRESSED byte length of the manifest JSON
  "manifestHash": "<canonical hash (below) of the decoded Manifest>" }

// delta
{ "kind": "delta",
  "comp": "zstd",              // OPTIONAL; applies to the ops body
  "bodyBytes": 1834,           // UNCOMPRESSED byte length of the ops JSON
  "baseEncSha": "<encSha of the immediate base blob>",   // next blob to fetch
  "baseManifestHash": "<canonical hash of the base FOLDED manifest>",
  "generatedAt": "<the folded manifest's generatedAt, carried verbatim>", // I5
  "manifestSchema": 4,         // OPTIONAL — the FOLDED manifest's schema
                               // stamp, carried verbatim (same I5 rule as
                               // generatedAt); ABSENT ⇒ the folded manifest
                               // carries NO manifestSchema key (the schema-0
                               // strip, src/cli/sync.ts:101-104)
  "resultHash": "<canonical hash of this commit's folded manifest>" }
```

Bounds (all fail closed, checked before any body work):

- Header line ≤ `MAX_ENVELOPE_HEADER = 64 KiB` (no newline within the bound →
  malformed). **Normative protocol constant** (shared engine export, like
  `MAX_MANIFEST_DELTA_CHAIN`).
- `bodyBytes` ≤ `MAX_MANIFEST_PLAINTEXT = 512 MiB` (10× today's 47MB;
  `validateManifest`'s `MAX_ENTRIES = 200_000` bounds the decoded object,
  `src/engine/manifest-validate.ts:13`). **Normative protocol constant**;
  writers must refuse to EMIT past it too, so an honest envelope is readable
  by construction. Retuning either constant post-soak is a coordinated,
  read-side-first release (§10.8).
- `comp` absent → actual body length MUST equal `bodyBytes` exactly.
- `comp: "zstd"` → decompress via design 79's zstd machinery
  (`src/engine/crypto.ts:38-50`) with a **streaming output cap at
  `bodyBytes`**: one byte over the declared length aborts (the same
  compression-bomb posture as design 79's decompression size cap,
  `src/engine/crypto.ts:78-88`), and short output is equally malformed.
- Hash fields 64-hex; `generatedAt` a non-empty string (its content is
  covered by `resultHash`, not re-validated); `manifestSchema`, when present,
  a positive safe integer ≤ `KNOWN_MANIFEST_SCHEMA` (the existing
  newer-schema fail-closed gate applies at the header, before any fold work).

**Canonical manifest hash** = sha256 of the JCS canonical form
(`src/engine/e2ee/jcs.ts`) of the full `Manifest` object (`generatedAt`,
`files`, `gitRepos`, `manifestSchema` — all of it). One definition, used for
`manifestHash` / `baseManifestHash` / `resultHash` and persisted client-side
(§3.4). Cost honesty: verifying `resultHash` after a fold is an O(N)
canonicalize+hash over the ~45MB manifest — pure local CPU, no network/AEAD.
It replaces today's O(N) download+decrypt+`JSON.parse`, it does not vanish;
§5's phase-A numbers and the §7.3 gate measure whether the trade nets out
(the strong prior: hashing local memory beats downloading 47MB).

**Ops body** = JCS-canonical JSON array of ops (then optionally zstd):

- `{ "op": "set", "entry": <FileEntry> }` — add or modify a path (full entry;
  entries are small; per-entry shape is enforced by running `validateManifest`
  on the FOLDED result — see §4.6 for what shape-validation does NOT cover).
- `{ "op": "del", "path": "<relPath>" }` — remove a path.
- `{ "op": "git-set", "repo": "<key>", "section": <GitSection> }` /
  `{ "op": "git-del", "repo": "<key>" }` — the `gitRepos` map, same shape.

Content addressing removes the need for a rename op: **a rename is `del old`
+ `set new`**; the moved bytes are a content-addressed blob already shared by
`encSha`, so no blob re-ships.

**Canonical form and reduction rules (I6).** packChain is weak precedent here
— its links are append-only bundles; an op log over keyed paths has conflicts
to resolve. So, explicitly:

1. **Reduction:** the writer reduces the base→target diff to at most one
   final op per key. Key = `path` for file ops, `repo` for git ops (the two
   keyspaces are disjoint by `validateManifest`'s collision rule). Last write
   wins within a key: `set` then `del` → `del`; `del` then `set` → `set`;
   `set` then `set` → the last `set`. A key whose final state equals the base
   state emits NO op. (The writer's input is a manifest-pair diff, §4.6 —
   never a raw change stream — so reduction is definitional, not repair.)
2. **Order:** ops sorted by (opFamily: file < git), then key ascending by
   code-point order — the same sort `scanManifest` uses for `files`
   (`src/engine/manifest.ts:86-91`).
3. **Fold:** apply `set`/`del` onto the base's path-indexed map, apply
   `git-set`/`git-del` onto `gitRepos`, re-sort `files`, stamp the envelope's
   `generatedAt` verbatim, stamp the envelope's `manifestSchema` verbatim
   (present → set; absent → the folded manifest has no `manifestSchema` key —
   both transition directions are wire-encodable, including 3→4 on a first
   compressed entry and 4→absent on its removal), run `validateManifest` on
   the fold (which enforces schema sufficiency: ≥2 for `gitRepos`, ≥4 for
   compressed descriptors, `src/engine/manifest-validate.ts:117-149`,
   `:79-86`), verify `resultHash`. The writer computes the header's schema
   value with today's `stampManifestSchemaForCommit` (`src/cli/sync.ts:
   99-106`) on the TARGET manifest — the fold never re-derives it, exactly as
   it never re-derives `generatedAt` (I5: carried state, checkable via
   `resultHash`, no second copy of the stamping rule on the read side).
4. **Decode-side enforcement:** duplicate keys, unsorted ops, a no-op `set`
   (identical to the base entry), a `del`/`git-del` of an absent key, or a
   non-canonical ops serialization are rejected as malformed — one encoding
   per change. `resultHash` remains the correctness authority regardless.

`manifestSchema` and `gitRepos`-schema stamping (`manifest-validate.ts`,
`sync-git.ts`) are computed on FOLDED manifests, not deltas, so §43/§79
schema gates are untouched by the transport.

### 3.3 Who compacts, and when

The server cannot fold (I2/E2EE, §1.4). **The committing client is the only
actor that can compact**, and it does so by choosing to emit a `snapshot`
instead of a `delta` for a given commit. The choice is local and needs no
server coordination.

Snapshot (compaction) triggers — the committing client emits a `snapshot`
when ANY holds, else it emits a `delta` based on its applied base:

1. **Genesis / no resolvable base** — the first commit, the first commit
   after upgrading to the §3.4 state fields, or the persisted base metadata
   is absent/mismatched (e.g. right after `rbox recover`, a stream reset, or
   a legacy-fallback state write, §3.4). Can't delta without a proven base.
2. **Epoch boundary (I4)** — the current write context's `keyEpoch` or
   `accountEpoch` (`currentKek()`, `e2ee-remote.ts:164-174`) differs from the
   base commit's SIGNED epochs, which are persisted in
   `manifestMeta.keyEpoch`/`accountEpoch` (§3.4) precisely so this comparison
   has a truthful, applied-base input — the pin's `accountEpoch` describes
   the verified head, not necessarily the applied base, and carries no
   `keyEpoch` at all (`e2ee-remote.ts:122-129`). The check is LOCAL and runs
   on every delta-eligible commit (it does not depend on the server's
   `epoch_stale` 409, `workspace-sync.ts:396-399`, though that retry path —
   refresh write context + re-scan, `sync.ts:494-497` — also lands here).
3. **Chain-length cap** — the fold chain would exceed
   **`MAX_MANIFEST_DELTA_CHAIN = 16` (normative — one shared engine constant,
   imported by the client trigger, the decode bound, and the Worker shape
   gate, like `MAX_PACK_CHAIN`)**. Semantics pinned in §3.5: the constant
   bounds `manifestChain.length`, i.e. the number of blobs BELOW the head
   (terminal snapshot + intermediate deltas); fold depth =
   `manifestChain.length + 1`. Retuning it later is a §10.1 call; shipping
   C2 with an unpinned value is not an option (wire interop).
4. **Byte-bound recompaction** — the `exceedsPackChainByteBound` heuristic
   (`src/cli/sync-git.ts:241-244`), which IS sound precedent for *sizing*
   (only the op semantics needed their own spec, §3.2). Implementable form
   (round-3 finding 1): the writer first ENCODES + encrypts the candidate
   delta (cheap — it is O(change)), then fires the trigger when
   `meta.chainBytes + candidateDeltaCipherBytes ≥ meta.snapshotBytes` —
   i.e. the threshold INCLUDES the head being proposed; on fire the
   candidate delta is discarded and the commit re-emits as a snapshot. Both
   inputs are persisted in `GlobalManifestMeta` (§3.4): `chainBytes`
   accumulates per applied/emitted delta, and `snapshotBytes` is the
   terminal snapshot's ciphertext length, recorded once from an observed
   length (writer: its own upload; reader: the cold walk's authenticated
   fetch — content-addressed + AEAD, so observed lengths are trustworthy)
   and propagated unchanged across deltas — the steady-state fast path never
   fetches the snapshot to size it. Migration/restore need no special case:
   any state without a meta — including a partial/malformed one, which
   §3.4's `validManifestMeta` normalizes to `undefined` before this
   arithmetic can see it — has no base and snapshots anyway (§3.3.1).
5. **Impossible-link 422 (fail-safe compaction).** If a commit bounce lists
   any sha that is in this commit's `manifestChain` (a chain link the server
   reports unsatisfied — GC-marked, delete-fenced, or lost), the retry MUST
   be a snapshot: historical manifest links can never be re-uploaded (the
   client does not retain their ciphertext). §3.5.4 specifies the server
   side; this rule is what makes every such degradation self-healing.
6. **Chain-integrity repair (§3.6.3)** — a repair commit is always a
   snapshot.

There is deliberately NO retention-based trigger (the first draft had one):
chain-link availability is INDEPENDENT of the retention floor by
construction. A link is fetchable because it is a present blob rooted by the
signed `manifestChain` of the head (and of every retained sequence, §3.5.5)
— prune drops `seq:<n>` POINTERS (`workspace-sync.ts:698-714`), never listed
blobs, and a re-baselining peer fetches links by address from the head's
signed list, not by walking pruned commits. A trigger with no observable
input on the commit path would be dead policy; the real guarantees are
§3.5.5's roots and §3.3.5's snapshot fallback if a link is nevertheless
lost.

### 3.4 Client state: base metadata inside the design-93 packet

The local folded-manifest cache **already exists**: `state.json`'s
`lastSyncedManifest` (`src/cli/config.ts:94-129`, measured 45MB). But today's
`SyncState` carries **no** `encManifestSha` and no folded-manifest hash — a
delta writer can't prove its in-memory base matches the head. Post-design-93,
state publication is not "field updates at save sites": it is a whole
`StateSavePacket` applied under lock with stream/nonce/global-sequence/
repo-generation preconditions (`src/cli/config.ts:159-165, 303-352`) via
`saveStateSource` (`src/cli/sync-state.ts:143-176`). The base metadata is
correctness-critical (a stale or torn value silently forks the delta chain),
so it rides that exact mechanism:

```ts
// config.ts — the new global-truth shape inside the packet
export interface GlobalManifestMeta {
  /** encManifestSha of the blob whose fold equals the described manifest. */
  encManifestSha: string;
  /** Canonical hash (§3.2) of that folded manifest. */
  manifestHash: string;
  /** The base commit's SIGNED epochs (from its parsed body) — the §3.3.2 /
   *  I4 trigger inputs. Without these, a rotation between base and next
   *  commit is undetectable from persisted state and the writer would emit
   *  a cross-epoch delta (unreadable by construction). */
  accountEpoch: number;
  keyEpoch: number;
  /** The base's EXACT verified chain, base-first — the base blob's signed
   *  `manifestChain` as list-verified at apply time (§3.6.1). `chain[0]` is
   *  the terminal snapshot; a snapshot base ⇒ []. Bounded by
   *  MAX_MANIFEST_DELTA_CHAIN (≤ 16 × 64 hex ≈ 1KB — negligible beside the
   *  45MB manifest). `links` is chain.length; carrying the LIST (not a
   *  count) is what lets the Phase-D fast path do I3b's exact-match without
   *  refetching (§3.6.1). */
  chain: string[];
  /** Cumulative delta ciphertext bytes since chain[0] — §3.3.4's input. */
  chainBytes: number;
  /** The terminal snapshot's ciphertext byte length (chain[0]'s — or, for a
   *  snapshot base, this blob's own) — §3.3.4's threshold. Recorded from an
   *  OBSERVED length (the writer's own upload; the reader's authenticated
   *  fetch on a cold walk) and PROPAGATED UNCHANGED across deltas, so the
   *  steady-state fast path never refetches the snapshot just to size it. */
  snapshotBytes: number;
}
export interface StateSavePacket {
  // ...unchanged...
  global?: { manifest: FileOnlyManifest; manifestMeta?: GlobalManifestMeta };
}
// SyncState gains the persisted mirror:
//   manifestMeta?: GlobalManifestMeta;
```

Semantics (all inherited from the packet, stated to be testable):

- **Atomic with the base.** `manifestMeta` is a member of `packet.global`, so
  it lands iff the global manifest lands — same `sourceGlobalSeq` CAS
  (`applyStateSavePacket`, `config.ts:315-317, 329-341`). A packet rejected
  for stream/nonce/repo-generation/global-sequence/owner-lost leaves it
  untouched. `composeStateSavePacket`'s stale-global omission
  (`sync-state.ts:116-118`) drops the meta together with the stale manifest.
- **Never on verify-only.** `verifiedHead()` advances the anti-rollback pin
  (`e2ee-remote.ts:257`) with NO state write; a pull that verifies but fails
  decode/fold/apply never reaches `saveStateSource` (`sync.ts:343-364`), so
  the base metadata cannot describe an unapplied head — the design-92
  applied-base rule (`sync.ts:530-536`) extends to the delta base for free.
- **Suppressed whenever the projection diverges (the design-93 repo-pending
  rule).** `applyStateSavePacket` stores the FILE-ONLY global verbatim and
  reconstructs `lastSyncedManifest.gitRepos` from the per-repo generation
  records (`config.ts:329-345`) — so when any repo apply is pending/lagging,
  the persisted manifest is deliberately NOT the folded remote head. A meta
  certifying the head beside a projected manifest would poison both the delta
  writer (ops diffed from a base that isn't what `encManifestSha` folds to)
  and the fast fold. Rule: the packet writer includes `manifestMeta` **iff
  the post-application projection equals the described manifest** — and
  since the file layer is stored verbatim, the ONLY divergence channel is
  `gitRepos`, so the check is a deep-equal of the reconstructed `gitRepos`
  projection against the source manifest's `gitRepos` (≤ ~100 repos — cheap;
  concretely: no repo left `pending`, no repo transition retained by a newer
  `sourceSeq`, `sync-state.ts:84-98`). On divergence the packet carries
  `manifestMeta: undefined` — which CLEARS any prior meta (global writes
  replace the global member wholesale) — and the next commit takes the
  §3.3.1 snapshot path until a fully-applied pull re-establishes it.
  **Repo-only packets clear meta INSIDE the applier, not via the packet
  shape** (round-3 finding 2: `manifestMeta` lives only in `packet.global`,
  and a repo-only packet has no global member — omission cannot mean both
  "preserve" and "clear", and synthesizing a global would wrongly enter the
  global-sequence CAS). Normative rule in `applyStateSavePacket`: after the
  accepted repo transitions are folded (`config.ts:325-345`), if the packet
  carried no `global` and any accepted transition CHANGED a record's
  projected `base` (deep-unequal old vs new `base` for that relPath), the
  persisted `manifestMeta` is cleared in the SAME atomic state write. A
  rejected packet (stream/nonce/repo-generation/owner-lost) changes nothing,
  including meta; a retained newer-`sourceSeq` transition re-writes the
  current record (`sync-state.ts:84-98`) so its `base` is unchanged and meta
  is preserved. The legacy/`forceLegacy` writers already drop meta
  unconditionally (above), which subsumes this rule off the fenced path.
  Fail-to-snapshot, never fail-to-wrong-base.
- **Writers of the packet:**
  - *Pull apply* (`sync.ts:343-364`): meta = the pulled head's
    `encManifestSha`, the verified fold's hash (= the checked
    `manifestHash`/`resultHash`, no recompute), the head's signed
    `accountEpoch`/`keyEpoch` (from the `parseCommit`ed body `verifiedHead`
    already produced), the head's list-verified `manifestChain` + cumulative
    bytes (snapshot → `[]`/0), and `snapshotBytes` (fast path: propagated
    from the prior meta; cold walk: the terminal snapshot's fetched length;
    snapshot head: its own fetched length) — subject to the suppression rule
    above.
  - *Push commit* (`sync.ts:715-725`): meta = the just-built envelope's
    `encManifestSha`, the writer's `resultHash` (computed anyway), the
    epochs it signed under (the D1-checked write context,
    `e2ee-remote.ts:406-410`), and the chain it emitted (snapshot → `[]`/0
    with `snapshotBytes` = its own uploaded ciphertext length; delta →
    `base.chain + [base.encManifestSha]`, bytes incremented, `snapshotBytes`
    propagated) —
    same suppression rule (a commit that carried a pending repo's section
    keeps the OLD base in state, `gitBaseAfterCommit`, `sync.ts:708`, so the
    projection diverges and the meta is suppressed).
  - *409 recovery* is pull-then-retry (`sync.ts:489-493`) — both writers
    above run in order; no third path exists.
- **Degraded/legacy paths fail to SNAPSHOT, not to corruption.** The
  mutex-degraded `forceLegacy` fallback and the link()-unsupported legacy
  writer (`sync-state.ts:123-139, 149-153`) persist state without the lane
  fence; they persist `manifestMeta: undefined` (drop it), so the next commit
  takes the §3.3.1 snapshot path rather than trusting an unfenced value.
  `resetSyncState` (`config.ts:463-524`) wipes it with everything else.
- **Runtime validation — malformed meta normalizes to `undefined` (round-4
  finding).** State loading is an unchecked `JSON.parse` cast
  (`config.ts:191-200`), so "legacy shape ⇒ snapshot" must be enforced by a
  validator, not a TypeScript interface: a hand-edited, partial, or
  older-schema meta would otherwise flow into JS arithmetic and fail OPEN
  (e.g. a missing `snapshotBytes` makes `chainBytes + n >= undefined`
  evaluate `false` via `NaN` — the byte-bound trigger would never fire).
  Normative: `validManifestMeta(v)` gates EVERY consumption point
  (delta-base selection, the §3.3.2 epoch trigger, the fast-fold match, the
  §3.3.4 byte arithmetic) — `encManifestSha`/`manifestHash` 64-hex; `chain`
  an array of ≤ `MAX_MANIFEST_DELTA_CHAIN` unique 64-hex entries not
  containing `encManifestSha`; `accountEpoch`/`keyEpoch` non-negative safe
  integers; `snapshotBytes` a positive safe integer; `chainBytes` a
  non-negative safe integer with BIDIRECTIONAL chain consistency
  (`chainBytes === 0 ⇔ chain.length === 0` — a non-empty chain accumulated
  at least its first delta's positive ciphertext length, so zero bytes under
  a non-empty chain is impossible-by-construction state that would
  undercount the §3.3.4 trigger; round-5 finding 2). ANY missing/invalid
  field ⇒
  the WHOLE meta is treated as `undefined` (→ §3.3.1 snapshot path / cold
  walk) before any epoch check, list match, or byte arithmetic runs.
- **Migration:** old state files load with `manifestMeta` undefined — and
  partial/malformed persisted metas normalize to undefined per the validator
  above — → first post-upgrade commit is a snapshot (§3.3.1).
  Backward-tolerant, no migration step.

Pull-side reconstruction:

- **Fast path (steady state, Phase D):** `latest` returns the head commit;
  fetch + decrypt the head blob. If it's a `delta` whose
  `baseEncSha === meta.encManifestSha`,
  `baseManifestHash === meta.manifestHash`, AND whose signed `manifestChain`
  equals `meta.chain + [meta.encManifestSha]` element-for-element (the full
  I3b exact-match, §3.6.1 — the persisted list makes it checkable with no
  extra fetch), fold ops onto the in-memory `lastSyncedManifest` (pure — a
  new object; the base is not mutated, §4.6) → O(change) network, one O(N)
  local `resultHash` check. ANY mismatch — including a list that keeps the
  same snapshot/length/immediate base but substitutes or reorders an
  intermediate — falls back to the cold chain walk (whose §3.6.1 check then
  rules); it is never silently accepted. Until Phase D the client folds from
  the fetched chain.
- **Chain fetch:** otherwise the signed `manifestChain` (§3.5) IS the fetch
  plan: fetch all listed blobs **in parallel by address**, then verify the
  decrypted linkage against the list (§3.6.1) and fold forward from the
  terminal snapshot (or from the newest link matching the persisted base).
  Bounded by `MAX_MANIFEST_DELTA_CHAIN`.
- **Fold cache:** a small in-process LRU of `encManifestSha → folded
  Manifest` (≥2 entries: the applied base + the new head; each ~45MB, so the
  cap stays small — open decision §10.6). History commands reuse it (§4.7).

The `commitsSince` verification path (`e2ee-remote.ts:227-259`, hash-chain
verify) is behaviorally untouched — it verifies opaque `SignedCommit`s and
never needed the manifest bytes. (Type-level truth per review: adding
`manifestChain` to the signed body touches `CommitBody`/`buildSignedCommit`/
`parseCommit` — §3.5.0 — but chain verification logic does not change.)
Only the decode layer (`decodeManifestAt`, `e2ee-remote.ts:191-216`) learns
envelopes + folding.

### 3.5 Server: signed-body field, validation, accounting, GC/roots (v2)

Storage: **unchanged.** A delta's `encManifest` is still one opaque content
blob, uploaded via the receipts path and charged/present-flagged like any
blob. `latest`/`commits?since`/`commitAt` return opaque `SignedCommit`s
verbatim — no change.

#### 3.5.0 The signed-body change (engine + parsers — not "one line")

`manifestChain: string[]` joins the SIGNED commit body: the encShas of the
terminal snapshot + every intermediate delta blob needed to fold this commit,
base-first (terminal snapshot first, immediate base last), EXCLUDING the
commit's own `encManifestSha`. A snapshot commit omits it (absent ≡ `[]`,
which is also the backward-compat reading of every pre-84 commit). Touch
list, explicitly (review finding 9):

- `src/engine/e2ee/commit.ts`: `CommitBodyBase` gains optional
  `manifestChain?: string[]` (`:33-45`); `buildSignedCommit` includes it only
  when non-empty and validates entries (64-hex, no duplicates, length ≤
  `MAX_MANIFEST_DELTA_CHAIN`) (`:109-132`); `parseCommit` enforces the same
  on read (`:139-155`). Canonical JSON (JCS) means old clients' verify of NEW
  commits requires shipping this parser fleet-wide first — that is Phase B's
  job (§6): `parseCommit` runs inside `verifyCommitChain` on every pull, so a
  pre-B client MUST NOT see a chain-bearing commit. Note `parseCommit`
  tolerates unknown fields today only via type-cast, not by contract; Phase B
  makes the field known.
- `apps/api/src/commit-envelope.ts`: `CommitBodyView` gains
  `manifestChain?: unknown` (`:85-94`). `readRefMode` is untouched (the chain
  is not a ref carrier).
- Worker/DO commit handler, `roots()`, fold, gap: below.

This must NOT be a free GC-pinning channel, and it must survive the shipped
receipts/fence/accounting machinery. Per gate:

#### 3.5.1 Shape gate (reject 400)

Every entry 64-hex; no duplicates; length ≤ `MAX_MANIFEST_DELTA_CHAIN`
(server constant = client constant; a hostile client can't ship a 10k-entry
pin list). Body-size is a non-issue: 16 × 64 hex ≈ 1KB inside the verified
`MAX_COMMIT_BODY = 1MB` (`apps/api/src/commit-envelope.ts:15`).

#### 3.5.2 Presence/entitlement gate = join the existing `shas` union

The chain entries join the SAME accounted sha set the commit already builds —
no parallel pipeline:

- **Receipts path (the current CLI):** `shas = [...new Set([encManifestSha,
  (sidecarSha,) ...dataRefs, ...manifestChain])]` (`workspace-sync.ts:338,
  340`), which flows through `validateCommitRefs`
  (`apps/api/src/commit-accounting.ts:61-110`). Consequences, all desired:
  - An honest chain entry is a prior commit's `encManifestSha` in this
    account: entitled + present + unmarked → it lands in the `have` set
    (`:80-93`) → zero accounting work, zero charge. This is the precise
    mechanics behind "same treatment, minus charging": charging is idempotent
    by construction (`blob_refs` ON CONFLICT + charge-NOT-EXISTS,
    `:145-183`), so even a re-granted link charges 0.
  - A Phase-1-MARKED link (`blob_ref_candidates`, the §33 barrier folded into
    the validate query at `:83-86`) reads as unsatisfied. The client cannot
    mint a receipt for bytes it doesn't hold → 422 listing the link → the
    client's §3.3.5 rule fires: **retry as snapshot**. The commit that would
    have depended on a condemned link never publishes; the marked link is
    simply abandoned with its chain. (A marked link under a still-live chain
    can only arise from a roots race or operator error; degrading to a
    snapshot is the safe closure either way.)
  - A design-95 **delete-fence abort** (`commitAccounting` returns the whole
    super-batch as `needsUpload`, `commit-accounting.ts:190-192`; receipt
    minting itself fails closed under an open fence, `apps/api/src/blobs.ts:
    28-33, 51-80`) surfaces as the same 422. Client mapping: data refs →
    re-upload/re-receipt as today; any listed sha ∈ `manifestChain` →
    snapshot retry (§3.3.5). One client rule covers fence aborts, marks, and
    genuine loss; no path ever attempts to re-upload an immutable historical
    link.
- **Legacy inline path** (`workspace-sync.ts:364-374`): chain entries join
  the `missingBlobs` probe the same way. (Moot in practice — the C2 fleet is
  receipts-protocol — but specified so the legacy handler can't become a
  bypass.)

**Ref-count budget:** the accounted count becomes
`dataRefs + CARRIER_REFS + manifestChain.length` against `MAX_REFS_PER_COMMIT
= 250_000` (`commit-accounting.ts:43-44`; guards at `workspace-sync.ts:
325-327, 344-348`). ≤16 extra on 250k — update the budget expressions and the
budget tests, don't special-case.

#### 3.5.3 Prune-marker / liveness refresh — inherited, not new code

Because chain entries ride `validateCommitRefs` → `commitAccounting`, a
marked-but-still-satisfiable entry is impossible (marked ⇒ 422, above), and
an UNMARKED entry's liveness is refreshed by the roots union (§3.5.5) — GC
mark/purge consult roots, and every retained commit roots its chain. There is
no separate "clear the marker" step to forget: the §33 barrier
(`gc-phase1.ts:20-26`) plus the marker-clear inside `commitAccounting`
(`:177-182`) already implement the only two transitions.

#### 3.5.4 The 422 contract, bounded (both sides)

On `unsatisfied_blobs`, partition `missing`:
`missing ∩ manifestChain ≠ ∅` ⇒ the retry commit is a SNAPSHOT (drop the
chain; nothing to re-upload); the remaining data refs follow today's
re-upload/recapture recovery (`sync.ts:691-703`). This is the §3.3.5 trigger
and MUST be implemented in the same 422 classification that currently derives
`gitForceForMissingBlobs`.

**Truncation rule (round-5 finding 1).** `unsatisfiedBlobsBody` caps the
response at `MAX_MISSING_SHAS_RESPONSE = 10_000` entries with the full count
in `missingTotal` (`apps/api/src/commit-envelope.ts:27-36`) — a naive union
order could push an unsatisfied chain link past the bound, hiding it from
the intersection test and looping the client on data-ref re-uploads that can
never satisfy the invisible link. Two rules, either of which alone closes
it; both ship:

- **Server (ordering):** every 422 that lists a sha ∈ the commit's
  `manifestChain` places ALL such shas (≤ `MAX_MANIFEST_DELTA_CHAIN` = 16,
  so they always fit) at the FRONT of `missing`, before any data refs. This
  is a partition at the `unsatisfiedBlobsBody` call sites and applies to
  every 422 producer on the commit path: the `validateCommitRefs` miss, the
  delete-fence `commitAccounting` super-batch abort (`commit-accounting.ts:
  190-192` — filter the returned batch against the request's chain set), and
  the legacy `missingBlobs` probe.
- **Client (conservative floor):** if the response is truncated
  (`missingTotal > missing.length`) AND the attempted commit carried a
  non-empty `manifestChain`, retry as a SNAPSHOT regardless of the visible
  intersection — correct even against an old/other server that doesn't
  implement the ordering rule, at worst costing one unnecessary snapshot on
  a >10k-miss cold push (which is already a full-upload event).

§7.5 covers the truncation boundary on both server paths.

#### 3.5.5 Roots — design 96 v2 integration (the real one, not "one line")

Post-#200, `/roots` is a paginated dropped-set index: `dropped_index` +
`seq_roots` tables, an alarm-driven per-sequence fold, and a raw gap
(`workspace-sync.ts:28-33, 475-549, 628-693`), consumed by
`reachableFromWorkspaces` with `MAX_UNIQUE_ROOTS = 750_000` /
`PER_WORKSPACE_ROOTS_COST = 90` (`apps/api/src/versions.ts:25-30, 57-124`).
Chain refs enter the **per-sequence root set** — the design-96 invariant
`reachable = ⋃ ROOTS(s), F < s ≤ H` then covers them with no new algebra:

1. **Fold input:** `refSetAt(seq)` (`workspace-sync.ts:537-549`) unions the
   body's `manifestChain` into the returned `refs` set (data refs ∪ chain).
   The fold's diff algebra doesn't care what a sha means: when a chain
   resets (snapshot), the old links leave the per-seq set and enter
   `dropped_index` with `last_seq`, keeping them reachable exactly while any
   retained sequence still needs them for a historical fold (§4.7) — and
   collectible once the floor passes. `FOLD_MAX_REFS = 250_000` headroom:
   +≤16/seq, negligible; unique-chain cardinality over a retained window is
   ≈ one manifest blob per retained commit (~1 per seq), i.e. O(window), not
   O(refs).
2. **Gap entries:** the raw-gap loop (`workspace-sync.ts:672-686`) emits a
   new `chainRefs?: string[]` per entry (read from the already-parsed
   `CommitBodyView`; no extra fetch, preserving the no-R2 mark phase for
   inline and gap paths). Counted into `gapRefs` against
   `ROOTS_OUTER_MAX_REFS = 3_000_000` (`:687`).
3. **Caller:** `reachableFromWorkspaces` adds `gap.chainRefs` via the same
   capped `addRoot` (`versions.ts:48-55, 94-109`). `seq_roots` schema is
   UNCHANGED (chain refs ride the dropped/current streams, not the per-seq
   manifest/carrier columns).
4. **Caps math:** `MAX_UNIQUE_ROOTS` grows by ≈ retained-window size (~1k
   unique manifest-blob shas at the primary workspace) — noise against 750k.
   `PER_WORKSPACE_ROOTS_COST = 90` is unchanged (no new subrequests).
5. **Consumers unchanged:** `perAccountReachable` / `phase1Mark` /
   `phase1Purge` (`apps/api/src/gc-phase1.ts:36-42` ff.) and `gcMark`/
   `gcPurge` (`versions.ts:205-243, 443-491`) consume the reachable set as
   opaque shas.

Accounting/entitlement note: `manifestChain` is a distinct axis (manifest
blobs) from `blobRefs`/`blobRefset` (file-content blobs); it is validated,
GC-rooted, and idempotently re-grantable, but an honest chain never re-charges
(each link was charged by the commit that created it — §3.5.2 mechanics), so
quota math is unperturbed.

### 3.6 Integrity and failure handling — fail closed, then REPAIR (the design-91/92 reconciliation)

Every `delta` names its base twice: `baseEncSha` (which blob to fetch) and
`baseManifestHash` (what the base must fold to); `resultHash` self-checks the
fold. The AEAD open (`manifest-crypto.ts:52-64`) authenticates every blob
under the workspace manifest key + `keyEpoch` AAD before any of this runs.
The head blob additionally opens through the existing signed-address gates
(`openCommit` for the head / `openCommitHistorical` for a verified ancestor,
`src/engine/e2ee/session.ts:387-399`); base links open through a new bounded
primitive:

**`openManifestChainBlob({kek, accountId, workspaceId, keyEpoch,
expectedEncSha, bytes})`** — asserts `sha256(bytes) === expectedEncSha`, then
`decryptManifest` under the folding commit's OWN signed `keyEpoch`. The
expected address comes from the authenticated walk (the head's signed
`encManifestSha`, then each already-AEAD-authenticated envelope's
`baseEncSha`), so every link is address-authenticated even though
`openCommitHistorical` (which binds one blob to one commit) cannot be reused
for arbitrary base blobs. I4 (one epoch per chain) makes the single-KEK open
correct; a violating link fails the AAD and reports as a chain error naming
the link. Historical folds (`manifestAtSeq`, `pathHistory`) use the TARGET
commit's signed `keyEpoch` the same way.

#### 3.6.1 Reader-side exact-match against the signed `manifestChain` (I3b)

After walking and decrypting the chain, the reader MUST verify the walked
address list equals the commit's signed `manifestChain` exactly:

- same length, same order (base-first);
- element 0 decrypts to a `snapshot` envelope (or raw-v0); every other
  element to a `delta`;
- each delta's `baseEncSha` equals its predecessor in the list (the last
  delta's consumer being the head blob itself);
- no extras, no duplicates, and the head's own `encManifestSha` is NOT in the
  list.

The fast path (§3.4) walks only the head blob, so it performs the SAME
exact-match against persisted evidence rather than aggregates: the head's
signed `manifestChain` must equal `meta.chain + [meta.encManifestSha]`
element-for-element, and the envelope's `baseEncSha`/`baseManifestHash` must
match the meta. This is sound inductively — `meta.chain` is the base's OWN
list as verified when the base was applied (cold walks verify directly;
each fast-path apply extends verified evidence by exactly the one link it
authenticated) — and it is complete: an intermediate substitution/reorder
that preserves the snapshot, the length, and the immediate base still fails
the element-wise compare. A fast-path mismatch demotes to the cold walk; a
cold-walk mismatch — omitted, extra, reordered, or head-included link — is a
**chain-integrity failure**: a signer published a list that does not
describe its chain. Fail closed (§3.6.2), then repair (§3.6.3). This check
is what turns §3.5's syntactic server gate into I3's composite invariant: a
wrong list cannot survive a single honest pull.

#### 3.6.2 Failure semantics — fail closed, no fictional fallback

**There is no "fold around a missing link."** The chain is linear and the
server is zero-knowledge: if a link is missing, fails its hash/AEAD, or the
list mismatches (§3.6.1), its ops are unrecoverable by anyone except a writer
holding folded state. So:

1. All chain failures (missing link, `baseManifestHash`/`resultHash`
   mismatch, list mismatch, over-cap chain, epoch discontinuity, malformed
   envelope) throw a typed **`ManifestChainError`** carrying the failing
   link's encSha, the head `{seq, hash}`, and a reason — from inside the
   decode layer (`decodeManifestAt`), so `latest()`/`manifestAtSeq` fail
   loudly, **nothing is applied, and the base metadata is untouched (I8)**.
2. Because §3.5 roots every listed link and gates presence at commit time,
   reaching this state means server data loss, or a buggy/hostile signer —
   an invariant violation that must surface, never be papered over.

#### 3.6.3 The repair transaction (why "snapshot on next push" was impossible, and what replaces it)

The wedge anatomy on current main, verified: `verifiedHead()` advances the
anti-rollback pin after chain verify but BEFORE manifest decode
(`e2ee-remote.ts:257` vs `:182`). If decode/fold then fails,
`state.lastSyncedSequence` stays at the older applied sequence M while the
pin sits at head N. The next push calls `commit(parentSequence = M)`, which
the applied-lag guard rejects (`e2ee-remote.ts:413-420`) → `conflict` → the
retry loop pulls first (`sync.ts:489-493`) → the pull re-fails on the same
broken chain. `rbox recover` doesn't escape it: it clears the pin and pulls
the same undecodable head (`src/cli/recover-cmd.ts:59-73`). The first draft's
"a writer emits a fresh snapshot on its next push" was therefore impossible
post-91/92. The replacement is explicit:

**Parent authority.** The pin at N is, by construction, a chain-verified,
signature-verified, anti-rollback-monotone head (`verifiedHead` verified the
`SignedCommit` chain to it — only the MANIFEST is unreadable). A repair
commit is an ordinary signed commit with `parentSequence = pin.commitSeq` and
`parentCommitHash = pin.commitHash` — it satisfies the applied-lag guard
*as written* (parent == pin), satisfies the DO sequencer (design 91: child of
the authoritative head, seq = watermark+1), and needs NO pin clearing and NO
new remote-layer bypass. What changes is the ORCHESTRATION: `pushManifest`
gains a repair mode that selects the pin (not `lastSyncedSequence`) as the
parent and disables the pull-first 409 recovery in favor of re-running
`verifiedHead` (if a peer advanced the head meanwhile: re-verify; if the new
head folds, the peer repaired first — resume normal sync; else re-attempt
repair against the new pin).

**Base selection (recover maximal data before superseding).** Before
building the repair manifest, the client recovers the newest readable
ancestor: walk seqs from N−1 down to M+1, authenticate each via
`verifyHistorySegment` (`session.ts:349-374`), attempt its fold; the first
success is applied as a NORMAL pull (reconcile + mass-delete guard + state
save with `sourceGlobalSeq` = that seq). Only the truly unreadable suffix
(A, N] — unreadable to *every* device by definition — is superseded. The
repair manifest is then built by the standard push pipeline against the
recovered applied base (scan → git-plan → defer/carry → encrypt/upload →
`stampManifestSchemaForCommit`), emitted as a SNAPSHOT envelope with an empty
`manifestChain`.

**The commit is unconditional — repair mode bypasses every pre-commit
short-circuit.** The COMMON repair case is an unchanged local tree: the
break is in the remote envelope, so the repair manifest is content-identical
to the recovered base. On the normal path that hits the no-op short-circuit
(`filesUnchanged && gitUnchanged` returns before `commit()`,
`sync.ts:575-619`) or the everything-deferred short-circuit
(`sync.ts:652-658`) — either exit would return sequence A with broken head N
still authoritative and the fleet still wedged. Repair mode therefore skips
both exits and ALWAYS posts the snapshot child of the pinned head: the
commit's purpose is to replace the unreadable head, not to record a diff,
and a content-identical snapshot at seq N+1 is precisely the healing
artifact (readers fold it directly; the chain resets). The
unchanged-tree-repair case is a named §7.4 test. (Deferred paths, if any,
carry base entries exactly as in a normal push — deferral shrinks the
snapshot's content, never suppresses the commit.)

**Destructive-publication guards, in order:**

1. The push-side mass-delete guard applies unchanged (`sync.ts:665-671`).
2. **Daemon auto-repair only when nothing of a peer's is superseded:** the
   daemon performs the repair automatically iff every commit in the
   unreadable suffix (A, N] was signed by THIS device (`deviceId` from the
   `verifyHistorySegment`-authenticated bodies). Otherwise it halts loudly —
   the same posture as designs 44/50's consent gates — and directs to the
   explicit ceremony below. (Constant/policy in §10.7.)
3. **`rbox recover` learns the chain case:** when its pull raises
   `ManifestChainError`, it does NOT clear the pin (useless — decode still
   fails — and the pin is the repair parent). It prints the suffix it would
   supersede (seqs + devices + reason), asks for confirmation
   (`--yes`/`--repair-chain` for automation), runs best-ancestor recovery,
   then the repair push. Non-chain recover behavior is unchanged.
4. Retained history below the break stays fetchable (`manifestAtSeq` on any
   seq whose own chain folds), and design-50 trash holds pulled-over local
   state — the repair never deletes readable history.

**Convergence note (why the fleet can't stay wedged):** a peer whose chain
view still references a lost/condemned link gets 422-bounced into a snapshot
by §3.5.2 + §3.3.5; a peer that cannot pull uses this section. Every path
terminates in a snapshot child of the authoritative head.

3. `rbox doctor` learns a chain check: walk the head's `manifestChain`,
   verify presence + hashes + list-match (§3.6.1), report length/bytes vs
   the §3.3 triggers. Cheap, and turns the invariant into something
   monitorable before it wedges a pull.

## 4. Interplay to address explicitly

### 4.1 Key epochs / account epochs
A delta's base manifest was encrypted under the base commit's `keyEpoch`; the
manifest key is HKDF'd per epoch (`manifest-crypto.ts:17-19`) and the AAD
binds the epoch. **I4: the first commit after any epoch change is a
snapshot** — deltas never span epochs. Mechanism: the server rejects a commit
signed under a non-current epoch with `409 epoch_stale`
(`workspace-sync.ts:396-399`); the client's epoch-stale recovery refreshes
the write context + re-scans (`sync.ts:494-497`), and the refreshed epoch ≠
base epoch trips §3.3.2. Historical folds decrypt each chain under the target
commit's own epoch (§3.6's primitive); since no chain spans an epoch, every
link of one chain shares one KEK.

### 4.2 409 conflict recovery (the incident driver)
A 409 means our `parentSeq` lost the race; recovery pulls the new head, folds
it (updating `lastSyncedManifest` + `manifestMeta` atomically via the packet,
§3.4), re-scans, and re-commits. Because the delta is **always computed
against the applied base pair (`lastSyncedManifest`, `manifestMeta`) at
commit time** (§4.6), the re-commit naturally re-bases onto the new head — no
special rebase logic. And it compounds the design-82 win: a delta commit is
small, so the encode/encrypt/upload inside the 409 window shrinks from ~47MB
to ~KB, which shrinks the window, which makes 409s rarer.

### 4.3 Re-baseline under delta chains (explicit ceremony, design-91 aligned)

Current reality, stated precisely (review finding 4): `verifiedHead()` always
verifies the full forward chain from the pin to the exact `/latest` terminal
hash (`e2ee-remote.ts:227-259`) and does NOT catch `NeedsRebaselineError` —
a span >`MAX_COMMIT_SPAN` or a pruned gap (`workspace-sync.ts:732-747`) makes
sync FAIL LOUDLY. The only automatic catch is the retained-history helper,
which still anchors at the already-verified head (`e2ee-remote.ts:363-390`).
The only pin reset is `rbox recover`: an explicit, user-confirmed ceremony
with a server-head-≥-pin floor precheck (`recover-cmd.ts:59-66`).

**This design keeps that posture: no automatic continuity-skipping is
introduced.** A device that cannot verify link-by-link continuity stops and
tells the human to run `rbox recover`. What delta chains change is only the
DECODE step after the ceremony, plus one pre-existing gap the ceremony must
close because long-offline devices become more common at delta cadence:

1. `rbox recover` re-fetches + re-verifies the account chains
   (`refreshAccount` — roster, key-state, account anti-rollback pins:
   unchanged, `e2ee-remote.ts:540-562`).
2. **The old pin is RETAINED until the replacement head is verified — there
   is no cleared window.** (Fix over the current ceremony, which clears the
   pin after only a sequence-floor precheck, `recover-cmd.ts:59-67`; once
   cleared, the genesis-anchored re-verify has no old hash left to compare,
   so an equal-sequence different-hash chain — an equivocation — would pass.
   Round-2 finding 6.) The ceremony holds the prior pin as `priorPin`, and
   the replacement head it verifies below MUST satisfy the floor rule
   against it: `head.seq > priorPin.commitSeq`, OR `head.seq ===
   priorPin.commitSeq && head.commitHash === priorPin.commitHash`. An
   equal-sequence different-hash head is refused as equivocation — the
   comparison is against the RETAINED pin, not against post-clear state.
3. Verify the replacement chain. Unpruned workspace: `commitsSince(0)` from
   genesis — existing behavior. PRUNED workspace (the gap; today this 409s
   and recover fails): the ceremony catches `NeedsRebaselineError` and falls
   back to: fetch `latest`; verify the head's signature against the verified
   roster (`verifyCommitSig` via `assertSignedByOwnRoster`); verify the
   longest retained segment terminates at that head
   (`retainedSegmentEndingAtHead`'s existing binary search,
   `e2ee-remote.ts:363-390`). Continuity beyond retention is what the human
   explicitly consented to give up — precisely design 91's recover
   threat-model, now stated instead of implied.
4. Only after step 3 succeeds AND step 2's floor/equivocation rule passes is
   the pin OVERWRITTEN (one `pins.save`, never a `clear` followed by a
   window) with the verified replacement head.
5. Decode the head by folding its `manifestChain` (every link rooted ⇒
   present; else §3.6 fail-closed → §3.6.3 repair path, which uses the pin
   written in step 4 as its parent authority).
6. **Ordering:** the pin write (step 4) precedes decode — unchanged posture,
   and safe: the pin is anti-rollback only; I8 keeps applied state truthful.
   Base metadata + applied base land only in the post-apply packet.

### 4.4 Design-70 cache gateway
No interaction. `CachedReleases` serves only the public release path;
authenticated blob fetches are never edge-cached and delta serving changes no
route and no cache key. Stated so a future cache-config flip gets evaluated
against this.

### 4.5 Trash / tombstone semantics (design 50)
A `del` op folds to exactly the disappearance the pull-side reconcile/trash
path already consumes when a path is absent from the newer manifest. Because
the folded manifest is byte-identical to a snapshot fold (I5/I7),
`diffManifests`/reconcile/the trash tier see the same add/modify/delete set
they see today — delta encoding is invisible below the fold. The design-50
stale-unlink and type-flip guards operate on the folded manifest and are
untouched. The fold-equals-scan property test (§7.4) certifies this.

### 4.6 Design-92 producer/carry contract (what "self-validating" does NOT cover)

`validateManifest` checks shape (paths, tuple shapes, compression
descriptors, collisions, git sections — `src/engine/manifest-validate.ts:
48-100` ff.); it CANNOT check that a tuple describes real bytes. Design 92
closed that class at the producer: encryption authenticates the snapshot
against the scanned `(sha256, size)` (`src/cli/sync-recovery.ts:222-247,
286-315`, `expected:` tuples) and churn defers rather than mutating the
tuple; push then commits the stable subset built from the APPLIED base
(`deferManifest`, `sync.ts:639-645`). The delta layer must not create a
bypass:

- **Encoder input = the final committed pair.** The delta writer diffs
  `committed` (post-defer, post-carry, post-`stampManifestSchemaForCommit` —
  the exact manifest today's `commit()` serializes, `sync.ts:645, 681`)
  against the applied base `state.lastSyncedManifest` whose identity
  `manifestMeta` proves (§3.4). NEVER a scan or change stream. Deferred-carry
  entries therefore ride the delta exactly as they ride the snapshot: as
  base-equal keys that emit no op.
- **Seam:** the pair travels to the transport via `CommitOptions.deltaBase?:
  { manifest, meta }` (or an equivalent injected provider) — `E2eeRemote.
  commit()` encodes the envelope; `sync.ts` owns which base is legal, keeping
  the applied-base authority in one place (`sync.ts:530-536`).
- **Fold purity + apply ordering (reader):** fold produces a NEW manifest
  object (structural sharing of unchanged entries allowed; the cached base is
  never mutated). Order: fold → `resultHash` → `validateManifest` →
  reconcile/apply to the filesystem → state packet. A failure at any step
  leaves the cached base, the persisted base, and `manifestMeta` exactly as
  they were — a retry re-folds from unchanged inputs.
- **What still catches poisoned tuples:** a `set` entry whose tuple lies
  about its blob fails at apply exactly as it does via snapshot today
  (decompression size cap + plaintext-sha verify, design 92 §1) — the delta
  transport neither weakens nor is responsible for that gate; §7.4 pins it
  with an explicit parity test.

### 4.7 History commands share folds

`manifestAtSeq` and `pathHistory` currently fetch+decrypt one blob per
commit (`e2ee-remote.ts:298-343`). Under chains, naive per-seq folding
re-fetches shared links W times. Specified: history folds walk the retained
window ASCENDING, fold the terminal snapshot once, then apply each commit's
delta incrementally (each retained seq's chain is a prefix-extension of its
predecessor's except across snapshot resets), reusing the §3.4 LRU —
O(snapshot + total ops) per window instead of O(W × chain). Chain links of
retained seqs remain fetchable because they are in the per-seq root sets
(§3.5.5.1) until the floor passes them.

## 5. Phase A — analysis of the SHIPPED instrumentation (design 82's lesson)

Design 82 falsified its own git-recapture prior with measurement; this design
must falsify its decomposition of `commit` before writing the delta engine.
**The instrumentation already shipped** (§1.7; PRs #161/#165): the `commit`
phase details are `{refreshMs, sidecarMs, encodeMs, encryptMs, uploadMs,
postMs, encBytes}` — deliberately broader than encode/encrypt/upload, because
the phase timer also covers the C4 account refresh, the §24 refset sidecar
upload, and the commit POST (`e2ee-remote.ts:392-502`). `latest` details are
`{downloadMs, decryptMs, parseMs, encBytes}`. `PhaseName`/`PHASE_ORDER` are
untouched (details ride `recordDetails`, `src/engine/phase-report.ts:167` —
the shared convention with designs 83/85), so design 82's ≥85% coverage
arithmetic is preserved by construction.

Phase A is therefore a MEASUREMENT CAMPAIGN, not an implementation phase:

1. `RBOX_METRICS=1` changed-push + steady-pull runs on BOTH fleet hosts
   (v1.0.0+ builds), daemon stopped, serialized on the shared WAN (§7 fleet
   rule).
2. Record per host: the six commit sub-steps + `encBytes`, the residual
   (`commit`-phase wall time minus the six — unattributed time is a finding,
   not noise), and the `latest` split.
3. Publish the split in §6's gate record before any Phase-B code, the way
   design 82 §6.1 recorded gate results.

**Decision rule, restated over the shipped fields.** Compression (Phase C1)
cuts upload BYTES ~8x (47MB→~6MB, inferred from design 79's measured ratios)
but leaves `refreshMs + sidecarMs + encodeMs + encryptMs + postMs` untouched
and ADDS zstd CPU to the encode side. For C1 alone to hit the §7 commit gate
of ≤3s:

- `refresh + sidecar + encode + encrypt + post + residual + upload/8 +
  zstd ≤ 3s`;
- at `commit` = 17.5s that requires `upload ≥ (17.5 − 3) / (1 − 1/8) ≈
  16.6s` ⇒ upload ≈ **95%** of the phase; at 13.2s ⇒ ≈ **89%** — before
  counting zstd time.

So the prior is explicit: **compression is an early cheap win, not the
endgame.** The delta engine (C2/D) stays committed unless Phase A measures
≥90% upload share on BOTH hosts AND the post-C1 re-measure passes the §7
gates on both hosts — in which case C2/D defer with the measurement on record
(§10.4).

## 6. Staged rollout (largest of the three envelope designs — phase it)

Hard rule, restated because the first draft violated it: **no write-side
change of any kind ships before fleet-wide read capability.** Today's readers
decrypt → `JSON.parse` as a raw `Manifest` → `validateManifest`, with no
envelope handling and no fallback (`e2ee-remote.ts:208-213`) — a compressed
snapshot is exactly as unreadable to them as a delta. Additionally (§3.5.0):
`parseCommit` runs on every pull, so a chain-bearing SIGNED BODY is also
unreadable to pre-B clients — B covers both the blob format AND the body
field.

**Phase A — measurement + published gate record, zero code.** §5. Output: the
per-host split + the C1/C2 decision per the §5 rule.

**Phase B — read capability for the FULL envelope + body field, fleet-wide.**
All clients learn to *read* everything §3.2/§3.5.0 define: envelope-v1
(snapshot raw+zstd, delta), unknown-magic fail-closed, chain fetch + fold +
canonical-hash checks + §3.6.1 list-match, `ManifestChainError`
classification, the §3.6.3 repair transaction (daemon policy + `rbox
recover` chain case + doctor check), §4.3's recover-under-prune step, and
`manifestChain` in `parseCommit`. Clients still *write* raw-v0 snapshots
with chain-free bodies. Pure capability, zero wire change. Ship to BOTH
fleet hosts and confirm (daemon soak + a forced pull) before anything in C.

**Phase C1 — write compressed snapshots.** `kind: "snapshot", comp: "zstd"`
(~47MB→~6MB upload, inferred). Adds the §3.4 state machinery
(`GlobalManifestMeta` in the packet — useful from here on). No server change
(no chain on snapshots). Re-measure against §5's decision rule.

**Phase C2 — write deltas.** Client emits deltas per §3.3 with `manifestChain`
in the signed body; server ships §3.5 (shape gate, `shas` union, budget,
roots/fold/gap changes) — server change is additive and backward-compatible
(absent `manifestChain` ≡ `[]` — every pre-84 commit), and MUST deploy (dev →
prod, per DEPLOYMENTS.md dev-first) before any client writes a chain, or the
chain gets no roots. Gated on B fleet-confirmed, C1's measurements, and the
§7.5 server tests.

**Phase D — pull-side O(change) fold from the local cache.** The §3.4 fast
path on `latest`, closing the loop on the `latest` phase cost.

Each phase is independently shippable and gated. B strictly precedes C1 and
C2; C1 precedes C2 (measurement sequencing); the server side of C2 precedes
the client side of C2 (roots before chains).

## 7. Per-host acceptance gates

Same discipline as designs 81–82: compiled dev build vs the prior release,
A/B on both fleet hosts, serialized on the shared WAN. **Fleet rule (shared
with designs 83/85): only one design's A/B gate window runs on the shared WAN
at a time.** Numbers below are targets pending the Phase-A record (which may
move them — say so, don't fake precision).

1. **Mac, one-file commit (C2).** `RBOX_METRICS=1 rbox push` with a 1-file
   touch, daemon stopped. Pass: `commit` phase ≤ **3s** (from 13.2–17.5s);
   commit details show `encBytes` ≤ **200KB**; design-82 phase coverage ≥85%
   preserved.
2. **Linux, one-file commit (C2).** Same, `commit` ≤ **4s** (weaker single
   core; encode/encrypt is CPU-bound).
3. **Pull `latest` (D).** A steady-state pull applying a small delta:
   `latest` ≤ **2s** (from 2.2–7s), details showing `downloadMs`+`parseMs` no
   longer O(47MB) (the O(N) `resultHash` check is the accepted residual —
   record it).
4. **Correctness property tests (block C2 merge):**
   - fold-equals-scan (I5): `fold(base, ops)` deep-equals an independent
     `scanManifest` of the same tree, over randomized
     add/modify/delete/rename op sets, including `generatedAt` carry,
     `manifestSchema` transitions, and canonical-hash equality.
   - fold purity: the base object is bit-identical before/after a fold and
     after a fold that FAILS at each stage (resultHash, validate, apply).
   - canonical form (I6): reduction produces one op per key in sorted order;
     decode rejects duplicates/unsorted/no-op sets/absent-key dels and every
     §3.2 header/bounds violation (unknown magic version, over-cap header,
     bodyBytes mismatch, zstd over/under-run, `manifestSchema` above
     `KNOWN_MANIFEST_SCHEMA`); schema transitions fold in both directions
     (3→4 on a first compressed entry; 4→absent on removal).
   - chain integrity (§3.6.1/2): missing link, corrupted link, list-mismatch
     (omitted / extra / reordered / head-included), `resultHash` /
     `baseManifestHash` mismatch, over-cap chain, cross-epoch link — each
     fails closed as `ManifestChainError` with nothing applied and
     `manifestMeta` untouched. The list-mismatch cases run through BOTH the
     cold walk AND the Phase-D fast path (an intermediate substitution that
     preserves snapshot/length/immediate-base must fail the fast path's
     element-wise compare, §3.4/§3.6.1).
   - **repair transaction (§3.6.3):** a broken-chain head with applied < head
     → daemon auto-repair publishes a snapshot child of the pinned head when
     the suffix is self-authored; halts (loud) when a peer's commit is in the
     suffix; `rbox recover` chain-case supersedes with consent;
     best-ancestor recovery applies the newest foldable seq first; a peer
     racing the repair converges (409 → re-verify → resume or re-repair);
     **an UNCHANGED local tree still publishes the repair snapshot** (the
     no-op and everything-deferred short-circuits are bypassed in repair
     mode — the round-2 blocker case).
   - **422-partition (§3.5.4):** a bounce naming a chain link → snapshot
     retry (never a link re-upload); naming only data refs → today's
     recovery; a design-95 fence abort maps the same way. **Truncation
     floor:** a truncated response (`missingTotal > missing.length`) with a
     non-empty attempted chain → snapshot retry even when no chain sha is
     visible in `missing`.
   - state packet (I8/§3.4): `manifestMeta` lands only with an accepted
     global; rejected packets, verify-only pulls, decode failures, degraded/
     legacy writes, and `resetSyncState` leave/clear it per spec; undefined
     meta forces the snapshot path. **Repo-pending suppression:** a pull with
     one pending repo persists NO meta (and clears a prior one); the next
     push snapshots; the next fast-path pull is skipped (cold walk); a
     later fully-applied pull re-establishes the meta. **Repo-only clear:**
     an accepted repo-only packet that changes a projected `base` clears a
     present meta atomically; a repo-generation-rejected packet and a
     retained newer-`sourceSeq` transition both preserve it.
   - byte-bound trigger (§3.3.4): `chainBytes + candidateDeltaBytes ≥
     snapshotBytes` re-emits as snapshot (threshold includes the proposed
     head); `snapshotBytes` propagates unchanged across fast-path applies
     and is recorded from the fetched length on a cold walk.
   - meta validation (§3.4): absent, PARTIAL, and MALFORMED persisted metas
     (missing `snapshotBytes`, non-hex hash, over-cap/duplicate chain,
     head-sha-in-chain, negative/NaN counters, chain-vs-chainBytes
     inconsistency IN BOTH DIRECTIONS — empty chain with non-zero bytes AND
     non-empty chain with zero bytes) each normalize the whole meta to
     `undefined` and force
     the snapshot path / cold walk — asserted at every consumption point
     (base selection, epoch trigger, fast-fold match, byte arithmetic), so
     no trigger can silently no-op on a coerced value.
   - design-92 parity (§4.6): a poisoned `set` tuple fails at apply exactly
     as via snapshot; deferred carry emits no op; a verified-but-unapplied
     head never becomes a delta base; compressed-descriptor entry changes
     round-trip.
   - epoch boundary (I4): a simulated rotation forces a snapshot — including
     the round-2 case where the APPLIED base predates the rotation while the
     pin has already advanced (the trigger reads `manifestMeta`'s persisted
     signed epochs, not the pin); decode rejects a chain spanning epochs
     (AAD failure surfaces as a named chain error).
   - re-baseline (§4.3): recover on a pruned workspace verifies the retained
     segment + head signature under the ceremony; the floor/equivocation
     rule compares against the RETAINED prior pin (an equal-sequence
     different-hash replacement chain is refused; the pin is overwritten
     only after verification — no cleared window).
   - cross-host rename round-trips end-to-end through the delta path (the
     design-82 rename test, re-run).
   - trash/tombstone (I7): a `del` op drives the same reconcile+trash outcome
     as the same deletion via snapshot.
5. **Server validation tests (block C2 server merge):** `manifestChain`
   over-cap / non-hex / duplicate entries → 400; absent/marked/fenced-link
   entries → 422 listing the link (receipts AND legacy paths); **truncation
   boundary (§3.5.4): with >`MAX_MISSING_SHAS_RESPONSE` data misses plus one
   chain miss, the chain sha appears at the FRONT of `missing` — on both the
   `validateCommitRefs` path and the delete-fence `commitAccounting`
   super-batch path;** accounted
   ref-count budget includes the chain; chain refs enter `refSetAt`'s fold
   set, `dropped_index` on snapshot reset, and the gap's `chainRefs`;
   `reachableFromWorkspaces` unions them under `MAX_UNIQUE_ROOTS`; a
   mark/sweep dry-run condemns nothing a live head or retained seq folds
   through; a prune past a dropped chain makes its links collectible.
6. **Daemon soak (C2):** one natural churn cycle per host on the dev build;
   chain length/bytes within §3.3 triggers; zero chain-integrity errors in
   `daemon.log`.
7. **Full `bun test` green; typecheck green** (design 82's known-local
   json-output env failure excepted).

## 8. Non-goals

Owned by other designs / explicitly out:

1. **Git-plan subprocess cost** (design 82 §7.3). Not this design.
2. **Scan cost** (design 82 §7.1 / design 85). Not this design.
3. **Chunked / block-level file sync (§40).** Deltas here are manifest-entry
   granular, not intra-file.
4. **Blob-level dedup changes.** The blob store and convergent encryption are
   untouched; a rename still shares a blob by `encSha`.
5. **Changing the verifiable commit chain / signature model.** The
   `SignedCommit` hash-chain, Ed25519 sigs, and chain VERIFICATION are
   unchanged; the body grows one validated field (§3.5.0) and deltas live in
   the manifest blob — never in the trust model.
6. **RSS / memory.** Folding onto an in-memory 45MB manifest is the same
   order as today's parse; the fold LRU is capped small (§10.6). Not a
   memory-reduction design.

## 9. Risks

1. **Phase-A falsifies the split (mitigated by §5).** The decision rule and
   its arithmetic are pre-registered over the SHIPPED fields, so the outcome
   is a measurement, not a negotiation.
2. **GC stranding a live chain (mitigated by §3.5 + §7.5).** The one
   genuinely dangerous coupling. Defense stack: server presence gate at
   commit, per-seq roots via the design-96 fold/gap, the §33 candidate
   barrier turning a marked link into a 422, the §3.3.5 snapshot fallback
   turning that 422 into self-healing, and a dedicated GC gate. Review this
   hardest.
3. **Fold correctness (mitigated by I5/I6 + §4.6 + §7.4).** A subtle fold bug
   silently corrupts a workspace. Fold-equals-scan property tests, purity
   tests, canonical-form rejection, and `resultHash` on every fold catch it
   before apply.
4. **Chain-integrity failure is a hard stop with a specified exit (by
   design).** §3.6 trades the first draft's impossible fallback AND its
   impossible "next push" recovery for: loud failure + the §3.6.3 repair
   transaction, with consent gates on anything destructive. Strictly better
   than applying a wrong manifest or wedging the fleet.
5. **Compat mis-sequencing (mitigated structurally by §6).** Any write-side
   emission before Phase B is fleet-confirmed bricks old readers' pulls TWICE
   over (blob format + signed-body field). B before any write is the hard
   gate; the C2 server precedes the C2 client.
6. **Chain-length pathology.** Degenerate churn could grow chains; the
   byte-bound + length cap (client §3.3, server §3.5.1) bound it, and
   §3.3.5/§3.6.3 bound the failure modes. Watch chain stats in the soak.
7. **Repair misuse.** The repair transaction publishes state that supersedes
   unreadable history; the §3.6.3 guard ladder (mass-delete guard,
   self-authored-suffix rule for automation, explicit ceremony otherwise)
   bounds it, and the suffix is by definition unreadable to everyone.

## 10. Open decisions (founder-level calls)

1. **Snapshot cadence retuning.** `MAX_MANIFEST_DELTA_CHAIN = 16` is
   normative for C2 (§3.3.3 — one shared constant, wire interop). The open
   call is only whether to RETUNE it (and the byte-bound's primacy) after
   soak data; a change is a coordinated release, read-side first.
2. **Compat window.** How long the fleet writes raw-v0 after Phase B before
   C1/C2 enable. With 2 devices this can be one release; the contract (B
   fleet-confirmed before any write change) is the invariant, the *duration*
   is the call.
3. ~~Ship read-side first?~~ **Resolved: yes, structurally** (§6).
4. **(Demoted per review round 0.)** ~~Is compression alone enough?~~ C1 is
   an early cheap win on the way to C2 unless the §5 rule's unlikely branch
   (≥90% upload share on both hosts AND post-C1 gates pass) hits — then C2/D
   defer with the measurement on record.
5. **Delta op granularity.** File-entry granular only (proposed). Full-entry
   `set` keeps fold trivial and entries are small.
6. **Fold-cache size.** One persisted folded manifest (+ packet meta) on
   disk; in-process LRU of 2 (proposed — each entry ~45MB). Revisit if
   history commands become hot (§4.7 already amortizes the window).
7. **Daemon auto-repair policy (§3.6.3).** Proposed: automatic iff the
   unreadable suffix is entirely self-authored; otherwise halt + ceremony.
   Alternatives: never automatic (always ceremony), or a suffix-length bound.
8. **Retuning `MAX_MANIFEST_PLAINTEXT` (512 MiB) / `MAX_ENVELOPE_HEADER`
   (64 KiB).** Both are NORMATIVE for B/C (§3.2 — reader/writer interop and
   the compression-bomb posture depend on shared values); the open call is
   only post-soak retuning, read-side first.

## 11. Lessons (to fill after the gate, per design 82 §8)

Reserved. Candidates going in: (a) the manifest was re-shipped whole for ~50
designs because "the server stores it as a blob" hid the O(N) where no phase
timer looked — design 82 §8's blind-spot class; (b) the first draft proposed
a chain fallback that was information-theoretically impossible AND a recovery
("snapshot on next push") that the just-landed head-authority gates made
mechanically impossible — both caught by adversarial review, neither by
self-review; (c) three designs (91/92/93) landed between draft and review,
and every one of them invalidated a section written weeks earlier — designs
that touch the sync core must be re-based on main before review, not after.
Confirm or correct after Phase A.
