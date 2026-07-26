# 209 — Normalize mtimeMs at the commit seam: kill the fat first-publish delta

Status: ALIGNED r3 (r1 wave pivoted the mechanism; serial gate confirmed the
pivot sound with test/contract-only residuals, folded — see REVIEW-209.md)
Fixes: #469. Field-proven by the mde attribution line shipped in #472.

## Level-set (phase 0)

Helped looks like: the first publish after a daemon boot or pinned rescan
emits `mde delta ops≈<real changes>` and ~KB bytes — baseline is
`ops=81120 bytes=7894911` (7.9MB, ~1.3s encode, chain inflation) for a
~5k-file real change, and 7.3MB for a ~0-file change. With r2's mechanism
this holds from the FIRST commit on the new binary, with no transitional
delta and regardless of peer versions.
Plausible-worse: masking a real change as advisory (the correctness failure
mode; the normalization precondition must make it mechanically impossible).

## Problem (field evidence + proven mechanism)

First publish after any full-workspace manifest replacement (boot seed scan,
FSEvents-overflow pinned rescan) emits a delta with ops over ~72% of the
workspace and zero blob uploads. Proof run against the real code (5 entries
differing only in `mtimeMs`):

```
diffManifests (push "what changed"): {"added":0,"changed":0,"deleted":0}
diffToOps    (delta encoder):        5 ops
```

Mechanism — a fleet-wide ping-pong of a per-machine value:

1. `mtimeMs` is documented advisory (`src/engine/types.ts:19-20`: "fast-path
   hint only — NOT part of content identity") and is deliberately absent
   from push/pull equality (`src/engine/diff.ts:20-28`, `:34`).
2. But `diffToOps`'s `fileEntryEqual` (`src/engine/manifest-delta.ts:267-275`)
   compares all eleven `FILE_ENTRY_KEYS` — including `mtimeMs`. It is the
   ONLY field-exact entry comparison in the tree (r1 review enumerated every
   cross-boundary comparison: drift audit, reconcile/apply `sameContent`,
   202 receipts `sameSemantic`, unsettled accounting — all mtime-blind).
3. Pull saves the REMOTE manifest verbatim as the base
   (`src/cli/sync/pull.ts:414` → `sync-state.ts:300`), so the base carries
   the PUBLISHER's machine-local mtimes; nothing restores them to disk (no
   `utimes` in production outside credential lock fencing) and
   `patchManifestFromPull` (`manifest-update.ts:84-126`) keeps the in-memory
   manifest agreeing with the base — so incremental publishes stay tiny.
4. `replaceManifestFromScan` (`daemon.ts:3015`; boot `:746`, overflow
   `:2023/:2042`, post-pull fallback `:2341`, safety `:2940`, deep `:2978`,
   adoption `:3337`) swaps in disk truth, flipping every foreign mtime to a
   local one at once. The next push encodes a `set` op (~97B compressed) per
   flipped entry. Each host's scan rewrites the whole manifest to its own
   mtimes; peers pull it; their next scan rewrites it back — no convergence.

Git sections contribute ~0 ops: identity-matched sections are carried
verbatim from the base (`sync-git/plan.ts:809-811`), so `deepEqual` holds;
zero blob uploads on the fat commits proves no recapture occurred.

## Correctness constraints (from r1 review, both reviewers)

- **Fold coherence:** `encodeDeltaEnvelope` stamps `resultHash =
  hash(target)` (`manifest-delta.ts:349`); `foldDelta` recomputes over
  base+ops and throws on mismatch (`:519`) and rejects no-op `set`s
  (`:501`). The op set and the committed manifest must agree — so the fix
  must normalize the manifest BEING COMMITTED, not the comparison.
- **Skew reality (r1 H1, the pivot):** stripping `mtimeMs` from the wire
  makes mixed fleets ALTERNATE full-workspace deltas on every commit in both
  directions (old side re-adds, new side re-strips) — strictly worse than
  today until the last old client upgrades. Rejected.
- **Retry-path purity (r1 codex H1):** whatever manifest shape the commit
  emits also becomes `localForRetry`/`state.local` on preflight-residue and
  422 recovery (`push.ts:183/:374/:749/:942`) and the daemon's in-memory
  truth (`daemon.ts:1917`). A projection that only some consumers expect is
  a footgun; r2's normalization produces a manifest every consumer already
  accepts.

## Mechanism: adopt the base's mtimeMs when identity is unchanged

One pure function at the single commit seam — inside
`stampManifestSchemaForCommit` (`src/cli/sync/push.ts:48`, applied at
`:747`, upstream of raw/snapshot/delta encode, the 204 base-integrity check,
and `state.lastSyncedManifest` persistence, and reached by every commit path
incl. `chain-repair.ts:77`, `ignore-cmd.ts:108`, `git/resolve-command.ts:817`
via `pushManifest`):

For each file entry in the outgoing manifest, with `base` =
`appliedBase.lastSyncedManifest` entry at the same path:

- If the base entry exists AND **all ten non-`mtimeMs` `FILE_ENTRY_KEYS` are
  `===`** AND both entries pass `fileEntryEqual`'s `known()` check (no
  unknown/future keys on either side — `manifest-delta.ts:272`): emit the
  entry with the BASE's `mtimeMs`.
- Otherwise: emit unchanged.

Properties:

- **Anti-masking is mechanical:** the precondition is literally "every field
  except `mtimeMs` is identical"; an entry with any real change is never
  normalized. Unknown future keys disable normalization for that entry, so a
  new schema field can never be silently frozen. `diffToOps` stays
  field-exact and untouched.
- **Unilateral:** ops for unchanged entries are zero regardless of what
  peers publish — no skew story, no transitional delta, first commit on the
  new binary is already `ops≈real changes`.
- **No wire, schema, or type change:** `mtimeMs` stays required in
  `FileEntry`; `validateManifest` untouched; old clients byte-compatible.
- **Every downstream consumer unaffected:** the normalized manifest carries
  a plausible mtime for every entry, so `classifyCacheHit`, retry paths,
  daemon install, and the 204 memo/base-integrity chain (`push.ts:786-799`,
  hash-anchored, entry-shape-blind — r1 verified both directions) behave
  identically.
- Precedent: `deferManifest` (`sync-recovery.ts:532`) already carries base
  entries forward at this seam.

Why `classifyCacheHit` can never see a normalized entry (record the REAL
argument, r1 M3): `baseEnc` is keyed by **sha256** (`sync-recovery.ts:158`),
so `toEncrypt` ⊆ entries whose content sha is absent from the base — and a
normalized entry has the base's sha by precondition. Any future re-keying of
`baseEnc` by path would break this invariant; the test below pins it.

Kill switch (default-on rule): `RBOX_MTIME_NORMALIZE=0` disables the
normalization (restores today's behavior exactly — safe per-machine, unlike
r1's flag). Single read site inside the seam helper.

In-memory note: after a push, the daemon installs the committed manifest
(`daemon.ts:1917`), so unchanged entries' in-memory mtimes become the
base's (possibly foreign) values until the next scan flips them back — a
purely local oscillation that never reaches the wire (the next commit
re-normalizes) and that no local comparison reads (all mtime-blind, r1 L8).

## Rejected alternatives (r1 rulings)

- **Strip `mtimeMs` from committed manifests** (r1's mechanism): zero-consumer
  claim held (sweep of apps/, web, rig, CLI commands all clean — rig oracle
  already drops mtimes, `scripts/rig/lib/manifest-check.ts:26`), fold
  coherence held, but the mixed-fleet alternating-fat-delta cost (H1) and
  the stripped-manifest leakage into retry/in-memory state (codex H1/M4)
  make it strictly worse operationally. Revisit only if a future consumer
  needs mtimeMs GONE rather than stable.
- Side-channel op: new wire surface for a value with zero consumers.
- Comparison-only exclusion: breaks foldDelta (resultHash/no-op-set guards).

## Non-goals

- No change to `fileEntryEqual`/`diffToOps`/fold semantics or wire shape.
- No mtime restoration on apply (`utimes`).
- No change to `GitSection.generatedAt` (moves only on real recapture).

## Tests

Existing pins that must stay green: `manifest-delta.test.ts` (fractional
mtime factory :29, canonical fuzz, ordering, fold), `e2ee-sync.test.ts`
delta cases, `manifest-stability.test.ts` (torn-write guard, untouched).

New:
1. Full-tree advisory rewrite: base/target differing only in `mtimeMs` →
   normalized commit equals base entry-for-entry; `diffToOps` = 0 ops.
2. **Anti-masking matrix**: perturb exactly one of the nine non-mtime,
   non-`path` `FILE_ENTRY_KEYS` on one entry → that entry is NOT normalized
   and yields exactly one `set` op (includes the cipher quad and
   `symlinkTarget`). Rename (`path` change) covered separately: emits
   `set + del`, neither side normalized.
3. Unknown-key guard: an entry carrying a future key on either side is not
   normalized (falls through verbatim).
4. Fold coherence: encode→decode→fold round-trip over a normalized commit;
   no `resultHash mismatch`, no `no-op set`; folded manifest equals the
   committed target byte-for-byte.
5. Sink assertion: commit whose target differs from base only by mtimes →
   push exits via the mtime-blind no-op path where applicable
   (`push.ts:652`), and a forced-commit variant (real 1-file change +
   full-tree mtime flip) emits `mde delta ops=1`.
6. **The boot repro end-to-end** (`daemon-mde-wiring.test.ts` style): seed a
   daemon from a base carrying foreign mtimes, full-workspace scan, change
   ONE file, push → assert `ops=1` on the FIRST commit (r2 has no
   transitional stage).
7. **classifyCacheHit invariant** (pins the M3 argument; normalization runs
   AFTER encryption classification, so assert provenance, not shape): paths
   that qualify for normalization in the committed manifest never reached
   `classifyCacheHit` during that push. Cases: mtime-only flip (normalized,
   never classified), rename and mode-only change (may reuse ciphertext by
   sha but cannot normalize), missing base cipher descriptor (forces
   classification/re-encrypt → descriptor inequality prevents
   normalization). Guards against a future path-keyed `baseEnc`.
8. Skew simulation with op-count assertions: old-shaped peer commits
   (foreign mtimes) alternating with new commits → new side's ops stay ≈0;
   numbers asserted, not prose.
9. Kill switch: `RBOX_MTIME_NORMALIZE=0` reproduces today's fat delta
   (asserted op count = entry count).

## Acceptance (field, per §Level-set)

Fleet dev build; restart a daemon; FIRST publish after boot shows
`mde delta ops≈0` (baseline 81120). Clone-burst rescan followed by a 1-file
change publishes `ops≈1`.

## Risks

- Normalization runs per-entry per-commit: O(n) `===` comparisons over ~113k
  entries — trivial next to the canonical-JSON encode already done there.
  Allocation-light form (serial gate): pass `state.lastSyncedManifest` (the
  applied base) directly to the seam helper, lazily clone the files array,
  and REUSE the qualifying base entry object per adopted entry.
- The wire keeps carrying a (now stable) per-machine value; a future
  field-exact consumer could regress — the anti-masking matrix and test 1
  are the tripwire.
- 204 memo/base-integrity: not a normalized-target sink — the check hashes
  the RECONSTRUCTED BASE against its own recorded hash (`push.ts:786-799`)
  and runs after normalization; verified coherent both directions in
  r1/r2 review.
