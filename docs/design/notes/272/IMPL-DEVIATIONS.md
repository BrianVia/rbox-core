# 272 — implementation deviations from the r9 contract

Every place the shipped code differs from `docs/design/272-conflict-copy-oracle.md`
(r9) or `notes/272/SPEC-272-IMPL.md`, with the reason and, where the deviation is
temporary, its deletion condition. Ratified during the review fold; the design doc
is NOT rewritten — this file is its erratum.

## Structural

### `receiver-paths.ts` exists (the design assumed one module)

The receiver-addressing predicates (`normalizeRel`, `receiverEquivalentPath`,
`inProjection`, `hardExcluded`, `matchesConflictGrammarBelow`, the equivalence
probe) moved out of `apply-receipt.ts` into `src/engine/receiver-paths.ts`.
`apply-receipt.ts:23-31` re-exports the public half so no importer changed.

- **Deletion condition for the facade:** when `apply-receipt.ts`'s own
  allowlisted split lands, the 10 files that import these symbols through
  `apply-receipt.js` move to `receiver-paths.js` and the re-export block goes.
- **Consequence:** `matchesConflictGrammarBelow` is EXPORTED, where the design
  called it module-private (§0). That "module-private" predates the split — the
  predicate is now cross-module by construction. It is exported from
  `receiver-paths.ts` only, never re-exported through `engine/index.ts`, so its
  blast radius is still one directory.
- `equivalentPart` was un-exported (zero consumers outside `receiver-paths.ts`).

### `whyFromScanError` no longer exists

The design cites `whyFromScanError` (`apply-receipt.ts:266-272`, `:268`) as the
anchor for the scan-failure vocabulary and for the `unsupported entry type in
repo subtree` pin. The shipped owner is the `SCAN_FAILURE_WHY` table plus the
`ScanFailed` error class (`apply-receipt.ts:225-235`), which carries the same
three strings. Every design reference to `whyFromScanError` should be read as
`SCAN_FAILURE_WHY`/`ScanFailed`. The class keeps its typed `ScanFailure`
constructor parameter; the unread `readonly failure` member was dropped, since
`error.message` is the only thing any handler reads.

### `countConflictCopies` is a THIRD exported symbol

§0 counts two new exported symbols. `countConflictCopies`
(`src/engine/conflict-name.ts`) is a third: `rbox status`'s count needs a
producer, and both producers (`status-projection.ts:366`,
`daemon/daemon.ts:2269`) reach it through `engine/index.ts`.
`isRboxConflictArtifact` is deliberately NOT re-exported from `engine/index.ts`
— its only consumers (`receiver-paths.ts`, the grammar test) import it from
`conflict-name.js` directly.

### The downgrade routes through `settle()` on an identity conditional

Rather than a dedicated third downgrade site, both prove paths compute
`downgradeIfEmptied(...)` and compare it by IDENTITY against the undowngraded
verdict:

```ts
const downgraded = downgradeIfEmptied(semantic, projected.armed, projected.expected.length);
if (downgraded !== semantic) return this.settle(rel, downgraded);
```

`downgradeIfEmptied` returns the SAME object when it does not fire, so the
conditional is exact. The consequence is the one §7's credential pin needs and
gets for free: a downgraded prove stores a `settle()`-shaped record
(`{ verdict }` only — no `receiptHash`, no `tokens`), computed before any
`records.set` that could mint a credential, so the hold survives the next
boundary instead of evaporating.

### The JSON count is a direct property

`renderStatusJson` emits `conflictCopies: projection.conflictCopies` directly
(`status-render.ts:152`) rather than through the conditional spread the
neighbouring optional fields use. `undefined` drops at serialization anyway, and
a direct property is what the anti-slop rule asks for.

### `breadcrumbGateForReason` gains a tenth `reason-other` surface

`conflict-copies` joins `conflict`/`ignored-target`/`config`/`other` on
`reason-other` (`breadcrumb-veto.ts:77`). RATIFIED: the veto-gate vocabulary is
deliberately coarser than the deferral vocabulary, and a hold that means "there
is nothing left to compare" has no distinct waiver semantics.

### The §7 label pin is asserted over a seam, not a literal

`doctor-cmd.test.ts` reads the label through
`gitDeferralReasonPresentation("conflict-copies").label` instead of the
hand-written string §7 shows. Same reason the `why` half is asserted over the
exported constant: a literal stays green when the presentation drifts.

## Semantics and copy

### `countConflictCopies` counts MINTED OBJECTS (F3 ruling)

The first implementation counted descendant FILES: a moved-aside `node_modules`
with N files reported N, and a repo living under a conflict-named ancestor
reported every file in it. RULING: the number the user sees is the number of
things they have to act on. For each path the SHALLOWEST grammar-matching
component names one minted object; the count is the size of that set.

- a moved-aside directory → 1, however many files it holds
- each individually minted file → 1
- a whole repo under a conflict-named ancestor → 1 (the ancestor)
- a path with no matching component → 0

`status-view.ts`'s copy ("N conflict copies rbox saved are still here") still
reads correctly: N is now objects, which is what "copies" meant to a user all
along.

**Amends §4's symmetry sentence.** The count and the oracle are NOT "never in
disagreement" — they are on different planes and always were. The count answers
"how many things did rbox mint that you must deal with", workspace-wide, over
the raw scan. The oracle answers "is this repo subtree's comparable population
empty", per repo subtree, over addressed paths. A moved-aside directory is one
object for the count and an arbitrary number of excluded entries for the oracle.
Expect them to differ; neither is evidence about the other.

### `CONFLICT_COPY_POPULATION_WHY` was reworded (F4)

Was: `"repo population emptied by conflict-copies exclusion"` — engineer prose
that reaches users verbatim through 271's git-deferral detail companion, with no
terminal period, so it ran into the following repair sentence.

Now: `"only conflict-copies remain here, so the comparison was skipped."`

The three constraints the wording had to keep, all re-verified:

1. `gitReasonOf`'s normalization (`doctor-cmd.ts:214`, `toLowerCase()` then
   `[ _]+` → `-`) yields
   `only-conflict-copies-remain-here,-so-the-comparison-was-skipped.`, which
   contains `conflict-copies` and none of the six `GIT_DEFERRAL_REASONS`
   members declared before it. Pinned by `doctor-cmd.test.ts`'s `why`-half
   assertion, which consumes the exported constant.
2. It ends with a period.
3. It is plain language; the hyphenated `conflict-copies` token is the one
   piece of vocabulary the string cannot lose.

`follow-classify.ts:141` still discriminates by string EQUALITY against the
exported constant, so no consumer parses the new prose.

## Defects found and fixed during the fold

### Arming order (F1)

`comparableFor` evaluated the grammar arm BEFORE the ignore matcher, so an entry
the matcher had already excluded armed the sink purely because of its name. A
user ignore rule as ordinary as `*.conflict*` therefore turned every repo it
emptied into a PERMANENT indeterminate — a new failure class, fleet-wide. The
grammar arm now runs LAST and arms only when the entry would otherwise have been
comparable. The returned boolean is unchanged (the same conjunction of
negations); only the arming attribution moved.

### `preScan` armed the sink (F2)

`project()` filtered the `preScan` population with the arming predicate.
`preScan` is a stat/hash fast-path SOURCE, never a comparison population — the
same reasoning §2.5 applies to `touchedKeys`. The observable defect: the pull
that deletes the LAST conflict copy deferred for a cycle, telling the user to
delete files that pull had just removed. `preScan` is now filtered with a
non-arming predicate (`comparableFor` with the sink omitted).

Both are pinned by red-then-green fixtures in `apply-receipt.test.ts`.

## Validation

### §7's pull-only rig arm is wired, not yet run

`Device.daemonStart` takes an argv passthrough and `startDaemons` takes a
per-device `pullOnly` selector; the consumer is the new
`pull-only-conflict-copies` scenario
(`scripts/rig/scenarios/pull-only-conflict-copies.ts`), which mints a conflict
copy on a receiver whose daemon has never pushed and asserts §4's
non-negotiable: `rbox status --json` still reports `conflictCopies`, sourced
from the live daemon, with `strandedIgnored` absent.

It is registered in `SCENARIOS` but deliberately EXCLUDED from `FAST_SUITE`: it
has not yet run against a live container fleet, and an unmeasured scenario does
not belong in the every-PR gate. **Acceptance owner:** the next docker rig
invocation. Promote it into `FAST_SUITE` once a real run is on record.

## Lint dispositions (touched-files rule)

Cleaned in this fold: the rig corpus-name symbols (`ProvisionOpts.seedShape` →
`corpus`, `Device.seedCorpus`'s parameter → `corpusName`), the conditional
empty-object spreads in `follow-classify.ts` and `status-view.ts`, the two
open-dictionary annotations in `resolve-presentation.ts` (a module-level `Map`
for the fixed lane labels, `satisfies` for the total refusal-message record),
and the union-narrowing `typeof` in `doctor-cmd.test.ts`'s fetch recorder.

Deliberately NOT changed, each with its reason:

- **`status-render.ts` (17 warnings) — EXEMPT.** The file sits at 398 nonblank
  lines against the 400-nonblank hard gate (SPEC §"budget"), i.e. two lines of
  headroom, and every one of the 17 fixes converts a spread into statements and
  GROWS the file. Its owner is the queued decomposition, not this PR — a
  re-pin is not on the table (`docs/` no-ratchet-re-pins rule).
- **`sync-state-model.ts:126,282,320` and `doctor-cmd.test.ts:146,371`
  (`shape`).** Durable/serialized keys, already catalogued in
  `docs/wire-rename-candidates.md` (`cfgShape`, `ConfigStoreIdentity.shape`,
  `GitResolutionBinding["config"].shape`, `DiagnosticsBundle.workspaceShape`).
  The 2026-08-15 ruling renames code symbols only.
- **`scripts/rig/scenarios/index.ts` (`gitShapes`).** The symbol matches the
  user-typed rig scenario id `git-shapes`; splitting them would make the
  registry lie. Catalogued in `docs/wire-rename-candidates.md`.
- **`no-runtime-typeof` at `preamble.ts:219`, `device.ts:351`,
  `resolve-presentation.ts:125,127`.** Each is already AT the boundary the rule
  asks the parse to move to: two are `JSON.parse` results being checked for a
  string field, two are the recursive redactor walking a genuinely `unknown`
  value. There is no earlier point to parse at, and the alternative is a
  suppression, which the rule forbids.
