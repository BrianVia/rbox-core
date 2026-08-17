# 272 — rbox-minted conflict copies must not gate the git-plane oracle

Status: **DRAFT r2** (folds the r1 review whole: C1, C2, M3–M7, m8–m10).
Every file:line below re-verified against `main` @ `b9bb83d5d` on 2026-08-16.

Evidence: GH #659 (re-scoped 2026-08-16) — FM wedged 103 repos for 20+ hours
on 944 of rbox's OWN `.conflict.*` copies. Recon proved the oracle already
symmetric on ignores (the r1 title's premise was disproven) and located the
true hole. Parents: design 224 (ignore-plane ruling: silent un-syncing is
worse than over-syncing), 236 (litter classes get reclassified at the gate,
not instrumented), 244 (echo-publish + conflict-retry containment).

## 0. Concept ledger

Net new concepts: **one** — "rbox conflict artifact", a name-grammar
predicate. It is spent three ways and nowhere else:

| Added | Owner | Deletion condition |
|---|---|---|
| `isRboxConflictArtifact(basename)` grammar | `src/engine/conflict-name.ts` (new, alongside `conflictName`'s producer) | conflict copies stop being minted into the workspace |
| `comparable(rel, kind, eq)` — the ONE oracle-side predicate (M5) | `src/engine/apply-receipt.ts` | never: it *replaces* five copy-pasted triples |
| `counts.conflictCopies` visibility (M6) | `src/cli/status-contract.ts`, sibling of the existing `conflictSnapshots` | a future retention policy takes deletion ownership |

Removed: five hand-copied `!hardExcluded && !matcher.ignores` expressions
collapse into one call site each. Net expression count goes **down**.

## 1. Problem — the ring, and why pull-only hosts make it permanent

`conflictName()` (`src/engine/reconcile.ts:80-85`) mints recoverable sibling
copies during apply (`src/engine/apply.ts:192`, `:293`, `:307`, `:458`) and
during trash restore (`src/engine/trash.ts:252`). They are deliberately
user-visible and sync-eligible.

But a copy that lands inside a git repo's subtree is a working-tree path
ABSENT from the applied manifest. `ManifestOracle` counts it as an extra,
`classifyCheckout` adds `local-edits` with detail "working tree differs from
applied manifest" (`src/cli/sync-git/follow-classify.ts:134-138`), and the git
plane defers the repo. The only exit is publication — once the copy is in the
manifest it stops being an extra:

- on a **pull-only** host (FM) publication never happens, so receiver-minted
  copies are permanent extras and the repo defers forever;
- on read-write hosts the hold gates the very lanes that would settle it, and
  a fleet-wide minting wave wedges every host receiving copies faster than it
  publishes its own.

Field state at r1: FM `deferredRepos=103`, oldest 20.2h, new copies minting at
23:33Z; cleared only by a manual fleet sweep (mitigation, not a fix).

## 2. Mechanism

### 2.1 The grammar, exactly (C1)

`conflictName` is `${stem}.${device}.${ts}.conflict${ext}` where `ext` is
`path.posix.extname(p)` and `ts` is `YYYYMMDDHHMMSS`. `extname` returns `""`
for dotfiles (`.env` → stem `.env`, no ext) and `"."` for a trailing dot.

The r1 grammar was incomplete: it omitted the collision suffix.
`claimUnclobberedName` (`src/engine/fsutil.ts:253-268`, reached from
`moveAside` — see its comment at `src/engine/apply.ts:487-489`, and from
`trash.ts:258-264`) appends `~2`, `~3`… to the WHOLE relative name when a
same-second twin already exists, so `…conflict.ts~2` is a real on-disk name.

```
^(?<stem>.+)\.(?<token>[^./]+)\.(?<ts>[0-9]{14})\.conflict(?<ext>\.[^./]*)?(?<dup>~[0-9]+)?$
```

Matched against a single path COMPONENT (never a whole rel path — a `/` can
never appear inside a group). `stem` is greedy and MAY contain dots
(`settings.local` is a real stem), so `token` is precisely "the last dot-free
run before the timestamp", not "the second field".

Fixtures below were executed against this exact regex, not eyeballed.
Positives: `index.dev_ab12cd34.20260816041610.conflict.ts`;
`.env.dev_aaaa…2b8.20260813192500.conflict` (no ext — the real field shape);
`notes.local.20260816041610.conflict.md~3` (the `~N` tail);
`x.trash.20260816041610.conflict.` (`extname` returns `"."` for a trailing
dot); `settings.local.dev_aaaa…2b8.20260815033027.conflict.json` (dotted
stem — also a real field shape). Negatives: `my.conflict.ts` (no timestamp);
`a.b.2026081604161.conflict.ts` (13 digits); `a.20260816041610.conflict.ts`
(no device token); `a.b.20260816041610.conflicted.ts` (infix not exactly
`.conflict`); `a.b.20260816041610.conflict.ts.bak` (extension appended after
the fact); `conflict-retention.ts`.

### 2.2 The device-token decision (C2) — a namespace claim, stated plainly

Three producers write three shapes into the token position, all verified:

| Producer | Token |
|---|---|
| `apply.ts:90` (`opts.device ?? "local"`) | `local` |
| `trash.ts:252` | `trash` |
| `init-plan.ts:123` mint | `dev_<8 hex>` |
| enrolled / credential id (`init-plan.ts:126-130`) | `dev_<32 hex>` — **every one of the 15 artifacts on this host** |

**Decision: match the token position LOOSELY — any single dot-free,
slash-free component (`[^./]+`).** A strict `dev_[0-9a-f]+` would silently
miss the `local` and `trash` mints, which is the failure mode this design
exists to end.

The safety argument is *bounded*, not absolute: a false positive needs a
basename carrying a literal `.conflict` infix, preceded by exactly 14 digits,
preceded by exactly one dot-free token. That is unlikely, not impossible.

**So state it as what it is: a NAMESPACE CLAIM over user filenames.** rbox
reserves `*.<token>.<14 digits>.conflict*` in every synced tree. It is not
unforgeable and this design does not pretend otherwise; §3 prices the claim.

### 2.3 Ancestor-aware pruning (M3)

The predicate matches if ANY path component matches — a matching directory
means its whole subtree is never compared.

Motivator, verified: `src/engine/apply.ts:296-307`. When a directory squats on
an incoming file path and trash is **disabled**, the eviction is
`moveAside(destRoot, entry.path, conflictName(entry.path, device, now))` — a
whole conflict-named DIRECTORY. Component-only matching would exclude the
directory name and then treat every file beneath it as an extra, reproducing
the wedge at one level down. (This mirrors `hardExcluded`
(`src/engine/apply-receipt.ts:227-230`), which is already component-wise on
the manifest side and prune-wise on the walks.)

### 2.4 ONE predicate, five sites (M5)

Today the same exclusion logic is hand-copied at five places in
`src/engine/apply-receipt.ts` — re-verified:

| Line | Shape today |
|---|---|
| `:469` | manifest-side filter: `inProjection && !hardExcluded && !matcher.ignores` |
| `:616` | cached walk, child: `hardExcluded ⇒ continue`; dir ⇒ `prunes(dirForm) ?? ignores`; leaf ⇒ `!ignores` |
| `:636` | cached walk, scope is a leaf: `!hardExcluded && !matcher.ignores` |
| `:713` | fresh walk, child: same shape as `:616` |
| `:736` | fresh walk, scope is a leaf: `!hardExcluded && !matcher.ignores` |

Five hand-copies are five chances for the two sides to drift — that drift IS
the class of bug this design fixes. Replace all five with one predicate:

```ts
type ComparableKind = "leaf" | "dir";
/** The single answer to "does the oracle compare this path at all?", applied
 *  identically to manifest entries and to working-tree walk children. */
comparable(rel: string, kind: ComparableKind, eq: ReceiverEquivalence): boolean
```

`comparable` = `!hardExcluded(rel, eq)` and `!isRboxConflictArtifactPath(rel)`
(any component) and the matcher arm the kind already selects — `ignores(rel)`
for `"leaf"`, `prunes(rel + "/") ?? ignores(rel + "/")` for `"dir"`. The
kind is not a new concept: every call site already knows it statically.
Symmetry becomes mechanical rather than reviewed.

**Named out of scope, with their behavior stated:**

- `scanDeferred` (`:465`): if any deferred/unreadable path lies in the repo
  subtree the whole projection returns `indeterminate("scan deferred in repo
  subtree")` BEFORE the filter runs. A conflict copy on an unreadable path
  therefore still yields `unreadable`, not `local-edits`. Unchanged here —
  `indeterminate` is a fail-closed verdict, not the wedge class of #659.
- `touchedKeys` (`:477`): filtered by `inProjection` only, with no
  `hardExcluded`/`ignores`/conflict arm at all. It is a membership set
  consulted at `:524`, never a comparison population, so an extra key in it
  cannot manufacture a mismatch. Unchanged.

Explicitly NOT built: no GC/expiry of conflict copies; no publish-lane change;
no new ignore rules; no oracle asymmetry.

## 3. Protected contract — and the cost this actually charges (M4)

Preserved:

- **Oracle symmetry.** `comparable` is one function; both sides call it. Pinned
  the same way the matcher is (`apply-receipt.test.ts:201/:393` siblings).
- **Conflict copies stay FULLY sync-eligible.** Nothing is un-synced (224's
  ruling honored: this widens no ignore predicate; it narrows one COMPARISON,
  symmetrically). The `type-flip` rig's "+1 recoverable .conflict" assertions
  hold byte-identically.
- **`local-edits` for real user edits.** 241/270 held-skip semantics untouched;
  fewer holds is the only delta.

**Corrected from r1.** r1 §3 claimed a user file that merely contains
".conflict" "still compares, the grammar test is exact". That is only half
true, and the half it gets wrong matters: a user file that DOES match the full
grammar (§2.2 makes that easier than a `dev_`-anchored grammar would) stops
being compared, and therefore **loses its `local-edits` hold**. Concretely:

- refs and the applied manifest advance while that file has uncommitted user
  edits — the git plane no longer waits for it;
- `rbox git resolve --show` under-reports: the oracle's `mismatch.sample`
  (`apply-receipt.ts:99-101`) can no longer name it;
- **no byte loss.** The file is still scanned, hashed, and synced on the file
  plane; the git plane simply stops treating it as evidence. A checkout that
  would overwrite it still goes through apply's own conflict-copy path.

Demonstration of the real collision surface, measured on this host's workspace
(`/home/via/Development`, 2026-08-16): **15** paths match the grammar, of which
11 sit inside git-repo subtrees. All 15 are rbox mints; the device token is
`dev_<32 hex>` in every case; **zero** are user-authored, and zero carry a `~N`
tail (the suffix path is code-reachable but field-unobserved). The claim's
benefit today is 11 subtree extras removed; its cost today is zero. That ratio
is the argument — not an impossibility proof.

## 4. Visibility and deletion ownership (M6)

A silent exclusion is how litter becomes permanent, so a surface is IN scope.

`counts.conflictCopies: number` joins `StatusLocalCountsBase`
(`src/cli/status-contract.ts:121-131`) directly beside the existing
`conflictSnapshots: { total, prunable }` — which is the *git ref* namespace
(`src/cli/sync-git/conflict-retention.ts`, `refs/rbox-conflict/`, 90-day
retention). Different objects, adjacent surface; the rendering must not blur
them (`status-render.ts:270` renders "conflict snapshots"; the new line reads
"conflict copies").

Source: the local manifest the projection already holds —
`localManifest.files.filter(isRboxConflictArtifactPath)`
(`status-projection.ts:371` computes `trackedFiles` from exactly that array).
Zero new scan, and the **same predicate** as the oracle exclusion, so the
count can never disagree with what was excluded. The daemon-trusted path
(`status-projection.ts:310`, `activity.ts:159`) carries the number alongside
`trackedFiles`; that plumb is named scope.

Deviation from the review, deliberate: the review asked for a **per-repo**
count in `rbox status`. `rbox status` counts are workspace-level and the
per-repo projection (`GitDeferralRepoProjection`, `status-view.ts:346-361`)
exists only for repos that are *deferred* — precisely the repos this change
stops producing. So: the **total** lands in `rbox status`, and **`rbox doctor`
lists the matching paths with their owning repo**, which is where a list can
afford to live and where per-repo attribution is actually actionable.

Deletion ownership, recorded: **the user owns deletion.** No auto-GC, no
expiry, no sweep — a conflict copy is the only surviving record of a diverged
edit, and 224's ruling (silent un-syncing is worse than over-syncing) applies
to silent deleting a fortiori. The recovery flow (inspect, keep, `rm`) is a
papercut-documented manual procedure. If the `doctor` count ever grows past
tolerance, a retention policy becomes a separate design with its own owner —
this one refuses to smuggle one in.

## 5. Expected effect — corrected (M7)

r1 §5 claimed "fleet git-pull waves stop wedging receivers", which conflates
two things. Precisely:

- **Wedging stops.** A conflict copy can no longer hold the repo whose
  publication would settle it. FM's 103-repo class becomes unmintable;
  pull-only hosts stop accumulating permanent extras. #659 closes.
- **Minting is UNCHANGED.** This design touches no producer. Copies mint at
  exactly today's rate from `src/engine/reconcile.ts:70` — the three-way
  divergence arm (`sameContent(l, r)` at `:58` already suppresses the
  identical-content case, so every mint reflects genuine `l ≠ r ≠ base`
  divergence, amplified by the publish/retry churn 244 documents).

That mint rate is **not accepted silently**: it is booked as a named
follow-up slice under design 244 (echo-publish ring + conflict-retry
starvation, issue #683), whose §Problem already owns the churn that drives
these waves. Owner: the 244 workstream. Acceptance: fleet mint rate measured
before/after 244's landing, with `counts.conflictCopies` (§4) as the meter.
This design deliberately fixes the *consequence* first because the consequence
is the 20-hour outage; it does not claim the cause is fixed.

Residual after this lands: the Mac's deferral list shrinks to the
supersession/#702 set (tracked there).

## 6. Alternative recorded and REJECTED (m10)

**Mint conflict copies into `.rbox/conflicts/<repo>/…` instead of as workspace
siblings.** It would end the wedge with no oracle change at all, so the
primitives rule requires recording why it loses.

Rejected: `.rbox` is unconditionally ignored — `src/engine/ignore.ts:350`
(`p === ".rbox" || p.startsWith(".rbox/") || …` ⇒ ignored) and
`ALWAYS_NATIVE_PRUNE` at `:155`; `hardExcluded` (`apply-receipt.ts:228`) also
drops it. Relocating the mint therefore **un-syncs the copy**: it stops
propagating to other devices and stops being recoverable anywhere but the host
that minted it. That is design 224's exact prohibition — silent un-syncing is
worse than over-syncing — applied to the one artifact whose entire purpose is
to survive. Also rejected for the same reason: any variant that ignores the
copies in place (`*.conflict*` as an ignore rule) rather than narrowing the
comparison.

## 7. Validation (m9) — rescoped honestly

**Unit (the real gate).** Exact-grammar assertions against §2.1's positive and
negative fixture sets, in the new predicate's own test. Symmetric-drop twin of
the disproven-title pin: a matching path drops from BOTH the manifest side and
the walk side. Ancestor case: a conflict-named DIRECTORY prunes its subtree.
`comparable`'s five call sites pinned so a future edit cannot re-introduce a
sixth hand-copy. Note: the `type-flip` rig's existing conflict assertions use a
LOOSE glob (`'${FLIP}.*conflict*'` at `scripts/rig/scenarios/type-flip.ts:32`
and `/\.conflict/` at `:86`) — those are convergence assertions, deliberately
left loose, and are NOT the grammar gate.

**Rig — named as NEW work, not a fork of an existing fixture.** Two pieces
that do not exist today:

1. *Receiver-side in-repo conflict fixture.* No current scenario mints a
   conflict copy INSIDE a git repo subtree on the receiver and then asserts the
   repo does not enter "working tree differs" across N quiescent cycles. New
   scenario.
2. *Pull-only plumbing.* Verified absent: `startDaemons`
   (`scripts/rig/scenarios/preamble.ts:233-253`) calls
   `Device.daemonStart` (`scripts/rig/lib/device.ts:237-239`), which
   hard-codes `this.rbox(["start"])`. `rbox start --pull-only` exists
   (`src/cli/help-registry.ts:230-233`) but the rig cannot request it. Adding
   an argv passthrough plus a pull-only arm to the preamble is in scope for
   this design and is the only way to exercise the FM shape in CI.

**Field — sequenced, not opportunistic.** No wave on a live fleet host. After
the fleet drains, mint a deliberate wave in a **dedicated scratch workspace**
only; record `counts.conflictCopies` and `deferredRepos` before and after on
that workspace, and confirm the 609/day "working tree differs" lines stop.
Fleet close-out is observational: FM soaks clean, `deferredRepos` returns to
the known parked set. Both push and pull lanes measured per the perf rule.
