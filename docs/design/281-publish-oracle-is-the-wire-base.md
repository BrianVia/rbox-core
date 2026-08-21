# 281 — The publish oracle is the wire base (issue #793)

Scope: `src/cli/sync-git/plan-accumulator.ts` (+ one exported equality helper in
`src/engine/manifest-delta.ts`) and one new regression test. No wire change, no
new state field, no new flag.

## 1. Field symptom (issue #793)

Every post-pull re-arm on a repo in a permanent carry publishes a literally
empty sequence:

```
pull apply complete ADOPTED sequence 3296
git-sync: captured 0 · carried 110 · skipped 1 · deferred 1 (Personal/rbox-core:
  git config over wire bounds — publication disabled; carrying base verbatim)
rbox: mde delta ops=0 bytes=400
push: published sequence 3297 (169130 files)
```

Counts: desktop 16+12+2 over 08-18/19/20, Mac 6+6. Reproduced live on desktop
(`~/.rbox/daemons/Development-a64d35fe/daemon-2026-08-20.log`, 20:02:56Z).

`ops=0` is exact: `diffToOps` (src/engine/manifest-delta.ts:293) covers BOTH the
file plane and `gitRepos`, so a zero-op delta means the committed manifest is
canonically identical to the manifest the remote already holds. The commit
carries no information for any consumer — only a burnt sequence number, a
notify fan-out, and a pull on every other device.

## 2. Root cause (evidence, not inference)

`GitPlanAccumulator.plan()` decides `changed` by comparing the outgoing sections
against a **state-derived reconstruction of the remote manifest**
(plan-accumulator.ts:274-291):

```
previous = { ...sanitize(state.lastSyncedManifest.gitRepos) }      // BASE
         overlaid with sanitize(record.advertised) per repo         // ADVERTISED
         overlaid with sanitize(state.gitPendingRemote)             // PENDING
```

`advertised` is written in exactly ONE place: `acknowledgePublishedGitTransitions`
(src/cli/sync/publisher-ack-transition.ts:188-205), i.e. only when THIS host's own
publication is acknowledged. **A pull never refreshes it.** (Verified: no other
non-test writer of the `advertised` record field exists in `src/`.)

So after a pull ADOPTS a remote git section:

* `lastSyncedManifest.gitRepos[rel]` = the remote's section (the wire truth),
* `record.advertised[rel]` = whatever THIS host last published (stale),
* the plan carries the adopted section verbatim (permanent carry: config over
  wire bounds, or SUPERSESSION_REFUSED carrying pending verbatim),
* `previous[rel]` = the stale advertised section ⇒ `sectionsDiffer === true`
  ⇒ `changed === true` ⇒ publish-candidate skips its no-op admission
  (src/cli/sync/publish-candidate.ts:327) and mints a sequence whose delta is
  empty, because the outgoing bytes are the remote's own bytes.

The publication then ACKs and rewrites `advertised` — which is why the state
looks consistent between cycles and why the loop is exactly one empty publish per
adopted git-section change, not a runaway ring. It is also why design 244's b2
detector stayed silent: b2 only logs when the plan is armed by
superseded/resolved/authoredCfg with NO section difference; here nothing is armed
and the (bogus) section difference is what arms `changed`.

**Field corroboration.** Across the desktop's 2026-08-18/19/20 daemon logs, ALL
35 `mde delta ops=0` publications land 9.9–94.1s (median 33s) after a
`pull apply complete ADOPTED sequence N` line — every empty publish follows an
adopted remote manifest, none occurs otherwise. The ACK then rewrites
`advertised`, which is why the drift is invisible between cycles and why the
symptom is exactly one empty publish per adopted git-section change rather than a
runaway ring.

The reconstruction is the accreted containment of the same bug class (2026-07-21
echo storm → #391 workstream D → design 244 b1 → this). The stronger primitive
now exists: since design 204 (MDE), state persists the wire base verbatim —
`GlobalManifestMeta.gitRepos`, "the described manifest's git layer, verbatim"
(src/cli/sync-state-model.ts:85-86) — the exact bytes `encodeDeltaEnvelope`
diffs against.

## 3. Fix — one predicate, at the same oracle the wire uses

In `GitPlanAccumulator.plan()`:

```ts
const wireBase = wireBaseGitSections(this.state); // meta.gitRepos when the meta is admissible
const previous = wireBase ?? reconstructedPrevious();   // existing base∪advertised∪pending path
const sectionsDiffer = gitSectionsDiffer(outgoing, previous);
```

where

* `wireBaseGitSections(state)` = `validManifestMeta(state.manifestMeta)?.gitRepos`
  (`validManifestMeta` already re-establishes shape + `validateGitRepos`).
  `undefined` ⇒ no admissible wire base ⇒ the existing reconstruction stands,
  unchanged, as today's behaviour (older/foreign state, pre-first-commit,
  MDE master kill). Deletion condition: when a valid manifest meta becomes an
  invariant of loaded state, the reconstruction branch and the
  `record.advertised` / `cfgSynced` special case in `plan()` are deleted.
* `gitSectionsDiffer(a, b)` is exported from `src/engine/manifest-delta.ts` and
  is the SAME canonical-JSON equality `diffToOps` uses for `git-set` ops — one
  owner for "does the wire name this section". It replaces the local
  `isDeepStrictEqual` comparison, which disagrees with the wire oracle on
  explicitly-undefined members and would leave the same class of ghost diff.

`changed = flagArmed || sectionsDiffer` is UNCHANGED in shape. Everything the
ACK lane arms (`supersededPending`, `resolvedPending`, `authoredCfgHashByRepo`)
still publishes even when the sections are byte-identical — design 244 §b2
explicitly protects those empty-delta publications (their durable effect is the
ACK), and this change does not touch them.

Nothing else in `plan()` changes: `normalizeOutgoing` still receives
`record.advertised` (design 130 tombstone authorship is genuinely about what THIS
publisher advertised, not about what the remote holds).

## 4. Invariants preserved

1. **Never suppress a real publication.** If any outgoing section's canonical
   bytes differ from the wire base's — including an added repo, a removed repo, a
   supersession, a resolution, a config authorship, a re-capture — `changed` is
   true. When the bytes are identical, the remote already holds them: no
   consumer can learn anything (least-information rule — consumers process only
   what the delta names; a delta that names nothing must not exist).
2. **ACK-bearing empty publishes survive** (244 b2 / designs 178 §B, 226): the
   `flagArmed` disjunct is untouched, so a supersession/resolution/authorship
   publish still commits and still settles its pending section. A pending section
   is therefore never stranded by this change.
3. **Pending carry still compares equal** (#391 workstream D): for a pending repo
   the wire base holds the remote's pending section and the plan carries it
   verbatim, so a steady carry is not a change — same verdict as the
   `Object.assign(previous, durablePending)` overlay it replaces, now without the
   sanitizer skew.
4. **The file plane is untouched.** `fileDiffNonEmpty` still gates on
   `diffManifests(appliedBase, candidate)`.
5. **No new state, flag, mode, or dedup layer.** The change is one comparison
   input plus one shared equality function; it removes an authority (the
   state-derived reconstruction) rather than adding one.

## 5. Risk analysis (stale/mismatched meta)

`state.manifestMeta` is written with `lastSyncedManifest` on every commit and on
every adopted pull. If it were stale, comparing against it could mislabel a
needed publish as unchanged. That is bounded and safe:

* mislabelling requires the outgoing bytes to equal a base the remote has since
  moved past — i.e. exactly the situation where a pull is pending and our carry is
  not authoritative anyway; the next pull refreshes the meta and the next plan
  publishes.
* push's own delta path already refuses a meta whose reconstructed base fails its
  canonical-hash integrity check (push.ts:757-780) and snapshots instead, so a
  corrupt meta cannot silently corrupt the wire either way.
* No admissible-meta case can make `changed` false while the wire delta would
  have been non-empty, because both sides now use the same base and the same
  equality.

## 6. Regression test (RED before the fix)

`src/cli/sync-git/plan-accumulator.test.ts` (new file, unit-level, the
`device-stamp.test.ts` `stateWith` pattern):

1. **`a carried section adopted from a pull is not a publish (no empty sequence)`**
   — state where `lastSyncedManifest.gitRepos["."]` and
   `manifestMeta.gitRepos["."]` are the ADOPTED remote section, while
   `repoRecords["."].advertised` is this host's older published section. The
   adopted section must keep the SAME `refs` and differ only in artifact/stamp
   bytes (`bundleSha`, `bundleEncSha`, `deviceId`, `generatedAt`) — a changed
   branch value would make design 130 author a tombstone, which is a real
   (ops≥1) publication. Carry the base section, then
   `expect(accumulator.plan().gitRepos?.["."]).toEqual(wire)` (proof the delta is
   empty) and `expect(accumulator.plan().changed).toBe(false)`.
   RED today: `changed === true` (stale advertised drives `sectionsDiffer`),
   which is the ops=0 publish.
2. **`a section that differs from the wire base still publishes`** — same state,
   carry a section with a different `head`/`refs` ⇒ `changed === true`.
3. **`an ACK-armed plan still publishes when the sections match the wire base`**
   — carry the wire section and add a `supersededPending` (and, separately, an
   `authoredCfgHashByRepo`) entry ⇒ `changed === true` (244 b2 protection).
4. **`without an admissible manifest meta the reconstruction still decides`** —
   drop `manifestMeta`; the pre-existing base∪advertised∪pending behaviour holds.

Run the file directly (wrap in a scratchpad script if the command guard refuses a
bare `bun test <path>`), plus the neighbouring suites that assert on
`plan().changed`: `src/cli/sync-git/device-stamp.test.ts`,
`src/cli/sync-git/sync-git-config-push.test.ts`, `src/cli/sync-git/follow.test.ts`.

## 7. Out of scope

* #702 (the desktop repo's over-bound config wedge) — unchanged; this slice only
  stops the wedge from minting empty sequences.
* The `status.ts` `pendingOnly` / daemon `pending-carry` re-arm suppression
  (design 244 b1) — untouched; it remains the first line of defence, and this fix
  is the second, at the publish oracle.
* Any change to `normalizeOutgoingGitSections` or tombstone authorship.
