# 301 — Empty push: project the accepted state instead of reading it back

Status: slice A shipped in #891 and then re-homed by design 302 (the `stateRevision + 1` caller-claim binding failed in the daemon because a push snapshot is usually one revision behind a pull). B, C, D measured and deferred to their owners.

## Measured problem (design 298 lines, via-desktop, 188K files / 125 repos, zero changes)

```
rbox push files=0 ... 9.0s | git-plan 3.8s ms[... d1109 ... cp2290 ...] state-save 2.5s
state-save slow: compose=949 apply=2351 repos=1   global=elided ops=0
state-save slow: compose=2   apply=2477 repos=3   global=none   ops=0
git-plan slowest: Personal/rbox-core fp=miss cp=601 d=40; ...
```

Profiling a `sqlite3 .backup` copy of that store (never the live one) with an empty packet
reproduced `apply ≈ 2.4s`; the CPU profile put all of it under
`translateCasResult → loadRawStateFromStore → materializeManifest` (198,544 entries decoded and
admitted after every accepted save). See `notes/301/profile.md`.

## Owner and change

`src/cli/state-plane/adapters/cas-translation.ts: translateCasResult` (design 267 §4) projected
the accepted state only for a *fully* elided packet and read the whole store back for every
other shape. Every real push carries at least one repo transition, so the fast path never fired.

A projection of the repo records is NOT trustworthy: `store/cas-steps.ts: applyTransitions`
recomposes each transition's base against the previously stored provenance
(`recomposeBase`), so the stored record can legitimately differ from `newRecord`. The one thing
a global-free packet provably does not touch is the base plane's **file rows**. So:

- `read-only.ts: loadRawStateFromStore(store, reuse?)` accepts `{ baseFiles }` and skips only
  the file-row cursor; repo records, manifest meta, git projections and every lineage token
  still come from the store, and `finishProjection()` still asserts the token.
- `translateCasResult` passes the snapshot's files only when the packet has no global section
  AND the CAS token's `stateRevision` is exactly `snapshot.stateRevision + 1` (every accepted
  CAS bumps it by one, `write-packet.ts`), which proves no other save landed between the
  snapshot read and this CAS. Otherwise it reads everything back.
- `saveStateSource` (`src/cli/sync-state.ts`) offers the snapshot for every global-free packet
  (previously only fully elided ones). Fully elided packets keep the 267 projection.
- Global-carrying saves and rejections are unchanged.

## Validation

- `state-memo.test.ts`: repo-only save reuses exactly the snapshot's files and `toEqual`s a
  fresh `loadRawState`; a snapshot made stale by a foreign revision bump gets no reuse; a
  global-carrying save reads everything back. Existing adapter/sync-state suites green.
- Copied-store profile (`notes/301/profile.md`): empty apply 2,519 / 2,338 / 2,366 ms →
  ~85 ms (records, meta and git projections still read back).

## Deferred (measured, not fixed here)

- **B** compose ≈ 0.95s on an elided save: `globalElisionAudit` rehashes the whole manifest to
  confirm the receipt. Reusing already-verified base-hash evidence is X1a's call.
- **C** git-plan discover ≈ 1.1s: `discoverGitRepos` walks the tree every push (F3b: reuse
  the daemon's trusted topology).
- **D** git-plan capture ≈ 1.6s not attributable to repos: the post-capture loop over all
  carried repos recomputes `repoRecordsForState` per repo and runs Git observations;
  `Personal/rbox-core` misses the fingerprint every tick because it is being edited.

Rollback: revert; no durable, wire, or schema change.
