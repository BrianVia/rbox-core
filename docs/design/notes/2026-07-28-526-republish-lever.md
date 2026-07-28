# 526 — `rbox git republish <repo>`: the chain-restart lever

Status: implemented. Spec for the operator lever half of #526; the structural
half (receiver import-failure feedback → automatic compaction) is explicitly out
of scope. One codex adversarial round was run against the first draft; its
findings and dispositions are recorded at the end.

## Problem

A published git section carries a **pack chain**: `packChain[]` (historical
BASIS bundles) plus the newest bundle
(`gitSectionPackLinks`, `src/engine/git/shared.ts:527`). Each incremental
capture bundles only `refs… ^basisTip…`
(`src/engine/git/capture.ts:304-308`), so link *i* is only importable by a
receiver that already holds links `0..i-1`'s objects.

Receivers import the chain sequentially and fail closed on the first bundle
whose prerequisites are unsatisfied
(`importGitPackChain`, `src/engine/git/shared.ts:562-598`; the throw at
`:571`). If any link's prerequisites are not derivable from its predecessors —
savvy-core's link 4, scar tissue from the July stash/conflict-ref episodes —
every *from-scratch* receiver is stranded permanently:

    git-sync deferred Dfinitiv/savvy-core: … bundle verify failed for git pack link 4

The publisher never notices. It holds every object locally, so it keeps
appending links to a chain nobody else can replay, and receiver verify failures
produce no wire signal. Two fleet hosts have looped on this daily since 7/25.

## Mechanism

**A chain restart is not a new wire concept.** It is exactly the shape the
publisher already emits on a genesis push, or when the basis-bundle build
fails: a section whose bundle is a *full* bundle and whose `packChain` is
absent. `capturePlannedGitSection` (`src/cli/sync-git/shared.ts:243-289`)
already produces it whenever `incrementalCapturePlan` returns `undefined`, and
that function's first line already accepts a `forced` flag:

```ts
if (cfg.git?.incremental === false || !baseSec || forced) return undefined;
```

So the lever does one thing: get `forced = true` to the next capture of one
named repo, across a process boundary (the operator runs the CLI; the daemon
runs the push).

### Request store

`<root>/.rbox/state/git-republish.json`, written atomically (`writeFileAtomic`,
mode 0600):

```json
{ "v": 1, "stream": "<syncStreamId>", "requests": [
  { "relPath": "Dfinitiv/savvy-core",
    "requestedAt": "2026-07-28T…Z",
    "baseBundleSha": "…", "baseGeneratedAt": "…" } ] }
```

Local-only bookkeeping — never synced, never on the wire, and removed by
`reset-state.ts`'s sidecar cleanup. It is stamped with the workspace `stream`,
so a store left behind by a previous binding reads as `foreign` and can neither
force nor settle anything. Entries are sorted by `relPath`; a request beyond
`REPUBLISH_REQUESTS_MAX` (256) is **refused**, never evicted — a command that
returned success must not have its intent silently revoked.

The store distinguishes `absent` from `corrupt`. A read-only planner fails open
on `corrupt` (with a log line naming the file) because a local file must never
fail a push; the *writer* refuses, so operator intent that may still be
recoverable from the bytes is never overwritten.

### Publisher side

`planGitSections` (`src/cli/sync-git/plan.ts`) reads the request set once at
entry. A requested repo:

1. **skips the carry fast-paths** — the §3.3 fingerprint fast-path, the
   baseless-pointer skip, the §7 carry matrix, and the linked-worktree pointer
   skip. A republish must re-bundle even though nothing about the repo changed;
   that is the whole point.
2. **captures with `forced = true`** → no basis, no `packChain`, a fresh full
   bundle from current state.

These are the same four predicates the existing 422 `force` set touches, plus
the `forced` argument, so the change is a `mustCapture(rel)` union at five
sites.

`republish` deliberately does **not** inherit `force`'s drop-on-failure
semantics. A 422 force drops the section because its BASE references blobs the
server has lost; a republish's BASE is still valid server-side — it is only
unreplayable by fresh receivers. A failed republish capture therefore takes the
ordinary defer-with-base-carry path and the request stays pending.

`mustCapture` is *not* a bypass of the planner's earlier returns. Removal
memory, needs-resolution, protected pending, and publisher-absence dispositions
all return before the carry predicates, and each encodes a safety invariant
(protected pending is authoritative until ACK; needs-resolution must not
publish conflicted state; removal memory must not resurrect). Rather than
punching through them, the **command refuses at admission** when the repo is in
one of those states, so the operator gets the reason immediately instead of an
intent that never settles.

### Settlement (idempotency)

After a manifest is proven landed — an ACCEPTED ordinary commit, or a keep-mine
`resolution-transition` whose kind is `published` — each pending request is
cleared iff the landed section proves it satisfied:

```
section = landed.gitRepos[relPath] exists
&& (section.packChain?.length ?? 0) === 0
&& (section.bundleSha !== request.baseBundleSha
    || section.generatedAt !== request.baseGeneratedAt)
```

The second clause is **causal, not chronological**: it compares the landed
section against the exact BASE the request superseded, not against any clock.
A deferred repo carries that BASE forward byte-for-byte, so it can never settle
its own request; a genuine recapture differs in both fields. No clock skew or
rollback can settle a request early or strand one forever.

Requests are **never** cleared on the absence of a section. Files-first genesis
publishes a commit with no `gitRepos` at all; clearing on absence would swallow
every pending request on that path.

Idempotency properties:

- `rbox git republish X` twice before a push → one pending request
  (`already-pending`, exit 0), keeping the original `requestedAt` and BASE.
- Request pending across N failed/deferred pushes → still pending, retried.
- Request satisfied → cleared; later pushes resume ordinary incremental capture
  from the new chain root.
- Settlement failure (disk error) can never fail an already-durable commit; it
  is caught and reported, and the worst case is one extra full bundle.

The store is advisory and **unlocked**. The recorder is an interactive operator
command and the settler runs inside the push, so a lost race costs at most one
rerun of the command or one extra full bundle — never correctness. The recorder
narrows the window by re-reading after its write and reporting
`run this command again` if a concurrent settle replaced the file; the settler
re-reads before writing and removes only the exact `(relPath, requestedAt)`
pairs it proved satisfied. A real interprocess lock is the right fix if this
ever becomes more than an operator lever.

## Why receivers accept it safely — no receiver change

A from-scratch receiver runs `gitSectionPackLinks` over the new section and
gets a **one-element** list: the full bundle. `hasHistoricalLinks` is false, so
the presence-skip is bypassed and link 0 is imported directly
(`shared.ts:585-596`). `git bundle verify` on a bundle created without any
`^tip` exclusion has **no prerequisites**, so verification passes on an empty
repo by construction — the same path every genesis publish already takes.
`republish-chain.contract.test.ts` proves both halves against real git: the
discontinuous shape throws `bundle verify failed for git pack link 0` on a
fresh repo, and the restarted section imports clean into one.

A receiver **mid-chain** is equally safe, in either of two ways. A *stranded or
pending* receiver fetches the one full bundle and imports a strict superset of
what it held; bundle import is additive, so there is no pruning, rewrite, or ref
regression. An *already-converged* receiver may instead advance BASE without
importing at all — apply admission compares the semantic projected key, not the
bundle identity — and that is also safe, because the publisher's next
incremental is based on tips such a receiver already holds; the restart link
then rides in `packChain` and is presence-skipped. The third contract test
pins exactly that: after a restart, the next incremental imports with
`{ imported: 1, skipped: 1 }`.

Supersession is therefore not a new authority: a chain-restarted section is an
ordinary newer section that happens to be self-contained, indistinguishable to
a receiver from a first-ever publish of that repo.

`MAX_PACK_CHAIN` and `exceedsPackChainByteBound` are unaffected — the restart
resets the chain to length 1, strictly better for both bounds.

Cost: one full bundle upload for that repo (savvy-core class: tens of MB;
receiver materialization benchmarked at ~30-60s from publish).

### Known limitation (pre-existing, not introduced here)

An ordinary full capture pins the index tree and raw-index object ids only
under `opts.resolution` (`capture.ts:284`), and suppresses `git stash create`
failure (`capture.ts:275`). A repo with an unmerged index and no usable stash
can therefore publish an index artifact referencing objects the bundle omits,
which a fresh receiver imports and then rolls back at fsck. That is true of
every full capture, including genesis, and is not changed by this lever — but
it is the thing to check if a republish does not clear the wedge.

## CLI surface

```
rbox git republish <repo> [--json]
```

Added to the existing `git` family in `src/cli/help-registry.ts` (family usage
becomes `rbox git <deferrals | resolve | republish>`); root help is untouched.

- `<repo>` is a path, resolved exactly as `rbox git resolve` resolves it:
  relative to cwd, normalized to a workspace-relative key, refused if outside
  the workspace.
- Admission requires `syncGit: true`, a published BASE section, and no
  `repoAbsent` / `removedKey` / `resolutionKey` / `pending` disposition. Each
  refusal names the state and the command that clears it.
- **No prompts, ever.** The command records an intent; it does not capture,
  upload, or mutate the repository.

Exit codes (the non-interactive twin is the *only* mode):

| code | meaning |
|---|---|
| 0 | request recorded, or already pending (`status: "recorded" \| "already-pending"`) |
| 1 | usage error, repo outside the workspace, inadmissible repo, corrupt store, capacity, or a write that lost a race |

`--json` prints
`{ "schemaVersion": 1, "repo": …, "status": …, "requestedAt": …, "pending": N }`
on success and `{ "schemaVersion": 1, "error": … }` on failure, so a rig or
agent can assert the outcome without parsing prose.

## Codex round — findings and dispositions

| # | Finding | Disposition |
|---|---|---|
| 1 | Full capture may publish an index artifact referencing unbundled objects (unmerged index / suppressed stash failure), so a fresh receiver can still fsck-rollback | **Out of scope, documented.** Pre-existing for every full capture including genesis; the lever does not make it worse. Recorded as the known limitation above. |
| 2 | `mustCapture` does not reach repos that return early (removal memory, needs-resolution, protected pending, empty, absent), and bypassing those would break their invariants | **Folded.** No bypass; the command refuses at admission with the specific reason. |
| 3 | Timestamp settlement is not causal — clock rollback strands or clears wrongly | **Folded.** Settlement now compares the landed section against the recorded BASE identity (`bundleSha` + `generatedAt`); no clock is consulted. |
| 4 | Read-modify-write on the store is not serialized | **Accepted, bounded, documented.** Worst case is one rerun or one extra bundle; the recorder verifies its write survived and says so. A lock is the fix if this outgrows an operator lever. |
| 5 | `already-pending` contradicted the in-flight-reissue argument | **Folded.** With causal settlement the contradiction disappears: `already-pending` keeps the original request, and only a genuinely new bundle settles it. |
| 6 | Successful keep-mine publications bypass settlement | **Folded.** Settlement is a shared helper called on both the ACCEPTED commit and the `published` resolution transition — never on aborted, authentication-failed, or uncertain outcomes. |
| 7 | "Base section or repo record" admits unconsumable requests | **Folded.** Admission requires `syncGit`, a BASE, and no suppressing disposition. |
| 8 | Base-carry on failure is not universal (structural preflight / missing dir drop instead) | **Folded (wording + admission).** The spec no longer claims universal carry; those states are refused up front. |
| 9 | Corrupt store silently overwritten, promised diagnostic never emitted | **Folded.** `absent` / `foreign` / `corrupt` / `valid` are distinct; planner fails open *with* the log line, writer refuses. |
| 10 | Cap evicts a live request | **Folded.** Refuse at capacity instead. |
| 11 | Requests not bound to workspace lineage; reset cleanup omits the file | **Folded.** Store stamped with `stream`; mismatch reads as `foreign`; added to `reset-state.ts` cleanup. |
| 12 | Mid-chain acceptance proof was wrong (apply compares projected key, not incoming key) | **Folded.** Proof rewritten to cover stranded/pending vs already-converged receivers, plus a test that the next incremental still imports after a skipped restart. |

## Out of scope

Automatic detection. Until receiver import failures reach the publisher (#526
direction 2), this lever is operator-driven, and the operator's signal is
`rbox git deferrals` on the stranded host.

## Post-merge

Field-validate on the real savvy-core wedge from the fleet: run
`rbox git republish Dfinitiv/savvy-core` on the owning host, sync, and confirm
FM and via-desktop materialize instead of deferring at link 4.
