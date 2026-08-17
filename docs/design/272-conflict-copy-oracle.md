# 272 — rbox-minted conflict copies must not gate the git-plane oracle

Status: **DRAFT r7** (folds the r6 delta-confirm. One blocker, B-r6-1: the
scoped predicate must test components **strictly below** the projection root,
not "at or below" — the repo's own name component is the caller's addressing
exactly as an ancestor's is, so a root-named repo is now addressable and BOTH
B1 pin arms assert `mismatch` (§2.3, §2.4, §6, §7). Plus C-r6-1 (§4's
scope-projection claim narrowed to the STATUS path — `pull-scope.ts:58-59`
projects local and remote on the pull path), C-r6-2 (the generic
proof-indeterminate resolve refusal accepted as a priced residual, with a named
follow-up), C-r6-3 (the declaration-order invariant behind the `doctor-cmd`
ordering fix, now pinned by its own test), and four nits. r6's own product
decision — a guard-armed hold gets its OWN deferral reason, `conflict-copies`
(§2.7) — and r5's B-r5-1/B-r5-2, r4's B-r4-1…B-r4-5, r3's D1/D2, r2's
B1/R1–R5/m1–m3 and r1's C1/C2/M3–M7/m8–m10 all held.)
Every file:line below re-verified against `main` on 2026-08-16.

Evidence: GH #659 (re-scoped 2026-08-16) — FM wedged 103 repos for 20+ hours
on 944 of rbox's OWN `.conflict.*` copies. Recon proved the oracle already
symmetric on ignores (the r1 title's premise was disproven) and located the
true hole. Parents: design 224 (ignore-plane ruling: silent un-syncing is
worse than over-syncing), 236 (litter classes get reclassified at the gate,
not instrumented), 244 (echo-publish + conflict-retry containment).

## 0. Concept ledger (m2, corrected in r4, r6, r7)

**ONE new concept** ("rbox conflict artifact"), carried by **two exported
symbols** — one predicate and one string constant:

| Symbol | Home | Deletion condition |
|---|---|---|
| `isRboxConflictArtifact(component: string): boolean` — the name grammar, on ONE path component | `src/engine/conflict-name.ts` (new; sits with `conflictName`'s grammar, re-exported from `reconcile.ts`) | conflict copies stop being minted into the workspace |
| `CONFLICT_COPY_POPULATION_WHY` — the exact `why` string the §2.4 guard emits, so the git plane can discriminate it from every other `indeterminate` (§2.7) | `src/engine/apply-receipt.ts`, beside `whyFromScanError`'s vocabulary (`:266-272`) | the `conflict-copies` deferral reason goes away |

The constant is a shared *literal*, not a mechanism: it exists only because
`OracleVerdict`'s `indeterminate` carries a free-form `why` and
`follow-classify.ts:139` needs one exact-match test rather than a substring
sniff. Concept count is unchanged.

Two **module-private** mechanisms inside `src/engine/apply-receipt.ts`, neither
exported and neither pinned by a direct call in a test:

| Mechanism | Why it exists | Deletion condition |
|---|---|---|
| `comparableFor(root, eq, armed)` — a factory returning the per-prove bound closure `comparable(rel, kind): boolean`, the oracle's single "is this path compared at all?" answer; the grammar arm tests components **strictly below** `root` (§2.3) | *replaces* five hand-copied exclusion expressions, and gives the guard one place to arm from | never, while the oracle has two sides |
| the per-prove **empty-population guard** (§2.4) — the `armed` sink the closure sets when the conflict grammar (and only the conflict grammar) drops an entry | a zero-pair alignment is otherwise a vacuous `match` (D2) | the grammar stops being an exclusion reason |

`comparable` is deliberately NOT exported: every consumer is inside
`apply-receipt.ts`, and §7 pins it behaviorally through the two oracles rather
than by calling it. Same for the `armed` sink.

**All four spends of `isRboxConflictArtifact`** — and nowhere else:

1. inside the bound `comparable()` (§2.5), the only oracle-side consumer;
2. `conflictCopies` in `rbox status` (§4), over the local manifest;
3. the papercut-documented recovery recipe (§4) — user-facing, no code;
4. its own unit fixtures (§7).

Net expression count goes **down**: five hand-copied exclusion expressions in
`apply-receipt.ts` collapse to **seven calls to the bound `comparable()`** (five
table rows in §2.5; two of those rows carry a dir arm and a leaf arm — and per
B-r5-1 the dir arms convert too), and the eighth
and ninth possible drift sites (the two `"other"` arms, `:622` and `:720`,
§2.6) are decided explicitly rather than left implicit. Five rows, seven calls
— the two counts measure different things and §2.5 owns both.

## 1. Problem — the ring, and why pull-only hosts make it permanent

`conflictName()` (`src/engine/reconcile.ts:80-85`) mints recoverable sibling
copies during apply (`src/engine/apply.ts:192`, `:293`, `:307`, `:458`) and
during trash restore (`src/engine/trash.ts:250-252`). They are deliberately
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

### 2.1 The grammar, exactly (C1, m1)

`conflictName` is `${stem}.${device}.${ts}.conflict${ext}` where `ext` is
`path.posix.extname(p)` and `ts` is `YYYYMMDDHHMMSS`. `extname` returns `""`
for dotfiles (`.env` → stem `.env`, no ext) and `"."` for a trailing dot.

`claimUnclobberedName` (`src/engine/fsutil.ts:253-268`, reached from
`moveAside` — see its comment at `src/engine/apply.ts:487-489` — and from
`trash.ts:258-264`) appends `~2`, `~3`… to the WHOLE relative name when a
same-second twin exists. The loop starts at `i = 2` and interpolates a number,
so the producer emits `~2`…`~9`, `~10`… and **never** `~`, `~0`, `~1`, or a
leading-zero form. The predicate pins exactly that range:

```
^(?<stem>.+)\.(?<token>[^./]+)\.(?<ts>[0-9]{14})\.conflict(?<ext>\.[^./]*)?(?<dup>~(?:[2-9]|[1-9][0-9]+))?$
```

Applied to a single path COMPONENT (a `/` can never appear inside a group).
`stem` is greedy and MAY contain dots (`settings.local` is a real stem), so
`token` is precisely "the last dot-free run before the timestamp", not "the
second field".

**Honest note on `~N` (r2 m1).** The `dup` group only fires on names with NO
extension (`.env.dev_x.<ts>.conflict~2`). On an extension-bearing name the
`ext` class `[^./]*` legitimately swallows the tail — `notes.local.<ts>.
conflict.md~3` parses as `ext = ".md~3"`, `dup` empty. Both parses give the
same verdict, which is all a predicate owes. `ext` is deliberately NOT
narrowed to `[^./~]`: `conflictName` on a real emacs backup `foo.ts~` produces
`foo.dev_x.<ts>.conflict.ts~`, and excluding `~` from `ext` would reject that
genuine mint.

Fixtures below were **executed** against this exact regex (17/17 agree), not
eyeballed. Positives: `index.dev_ab12cd34.<ts>.conflict.ts`;
`.env.dev_aaaa…2b8.20260813192500.conflict` (no ext — real field shape);
`node_modules.dev_3225c31.20260729231035.conflict` (real field shape, §5);
`settings.local.dev_aaaa.<ts>.conflict.json` (dotted stem — real field shape);
`.env.dev_x.<ts>.conflict~2` and `~10` (`dup` fires); `notes.local.<ts>.
conflict.md~3` (via `ext`); `x.trash.<ts>.conflict.` (trailing-dot `extname`).
Negatives: `my.conflict.ts` (no timestamp); `a.b.2026081604161.conflict.ts`
(13 digits); `a.<ts>.conflict.ts` (no device token); `a.b.<ts>.conflicted.ts`
(infix not exactly `.conflict`); `a.b.<ts>.conflict.ts.bak` (extension
appended after the fact); `conflict-retention.ts`; and the three
non-producer tails `…conflict~`, `…conflict~02`, `…conflict~1`.

### 2.2 The device-token decision (C2) — a namespace claim, stated plainly

Four producers write into the token position, all verified:

| Producer | Token |
|---|---|
| `apply.ts:90` (`opts.device ?? "local"`) | `local` |
| `trash.ts:252` | `trash` |
| `init-plan.ts:123` mint | `dev_<8 hex>` |
| enrolled / credential id (`init-plan.ts:126-130`) | `dev_<32 hex>` — **every artifact in the §5 census** |

**Decision: match the token position LOOSELY — any single dot-free,
slash-free component (`[^./]+`).** A strict `dev_[0-9a-f]+` would silently
miss the `local` and `trash` mints, which is the failure mode this design
exists to end.

The safety argument is *bounded*, not absolute: a false positive needs a
basename carrying a literal `.conflict` infix, preceded by exactly 14 digits,
preceded by exactly one dot-free token. Unlikely; not impossible.

**So state it as what it is: a NAMESPACE CLAIM over user filenames.** rbox
reserves `*.<token>.<14 digits>.conflict*` in every synced tree. It is not
unforgeable and this design does not pretend otherwise; §3 and §5 price it.

### 2.3 Ancestor matching, SCOPED to the projection root (B1) — correct addressing

r2 identified an inversion in r1's unscoped ancestor rule, confirmed here.
r3's delta-confirm then showed this scoping kills one *instance* of the
vacuous-match shape, not the shape; §2.4 owns the safety property, and this
subsection is now scoped to what it actually buys: correct addressing.

**The failure.** `project(rel, eq)` filters the manifest by the same predicate
the walk uses. If the repo's own root — or any ancestor of it — matched, then
`expected = []` (every manifest entry under the repo carries the matching
component) AND `scopedScan` returns `[]` (the scope leaf is excluded at
`:636`/`:736`; a scope directory's children all carry the component). Both
sides empty reaches `compareEntries` (`apply-receipt.ts:306-311`), whose
`alignPaths` yields zero pairs, `samples.length === 0`, and returns the
`MATCH` singleton. **A vacuous MATCH, forever**: the repo never defers, and
`rbox git resolve --show` reports it clean while its working tree is
arbitrary. That is a fail-open inversion of the entire design's goal — strictly
worse than the wedge it replaces.

**r7 note on that narrative's second half.** The `:636`/`:736` scope-leaf
exclusion it names is exactly what the adopted predicate removes: with the test
restricted to components strictly below `root`, the scope leaf IS `root`, so it
can never be dropped by the grammar, on either walk. The remaining way to empty
`scopedScan` is conflict-named content strictly *inside* the repo — §2.4's
class, not this one.

**It is reachable, not theoretical.** Two producers create conflict-named
DIRECTORY names: `apply.ts:296-307` (trash disabled ⇒ a squatting directory is
`moveAside`d whole under a conflict name) and `trash.ts:250-252` (restore onto
an occupied target diverts to `conflictName`, and the restored entry may be a
directory — `claimUnclobberedName` takes `st.isDirectory()` explicitly). And
`discoverGitRepos` descends every non-ignored directory — `walkDir`
(`src/engine/git-discover.ts:46`), descent loop `:58-62`, pruned only by
`prunesForGitDiscovery`/`ignores` at `:61` — so conflict-named directories are
not ignored, a repo underneath one IS discovered and IS proved.

**Adopted fix — option 1, corrected in r7 (B-r6-1).** The closure is bound to
the normalized projection root and tests only components **strictly below** it:

```ts
/** Components AT OR ABOVE `root` are the caller's addressing, not content:
 *  `proveRepo(rel)` addresses this repo BY that path, so neither an ancestor's
 *  name nor the repo's OWN name component is evidence about what the repo
 *  contains. Only components strictly below `root` are content. */
comparableFor(root: string, eq: ReceiverEquivalence, armed: { hit: boolean }):
  (rel: string, kind: ComparableKind) => boolean
```

For `root = "."` this is every component of every `rel`, as before — the
workspace root is not itself a component. For `root = "a.dev_x.<ts>.conflict/
repo"` the ancestor `a.dev_x.<ts>.conflict` is skipped and the repo compares
normally; for `root = "a/b.dev_x.<ts>.conflict"` — the repo's OWN directory
carrying the grammar — the same holds, because `proveRepo(rel)` addresses that
repo BY that path and the name is not content. In both, a conflict-named
directory *inside* the repo still prunes its subtree.

**Why the root component goes with the ancestors (B-r6-1, r7).** r6 wrote the
test as "at or below `root`", which left the repo's own name component in the
content population — so a repo that a `moveAside` had renamed under the grammar
emptied both populations and was misclassified by its own address. The caller
already committed to that path when it asked for a proof of it; the repo's name
component is the caller's addressing exactly as an ancestor's is. Testing
strictly below `root` is the whole correction. It keeps §2.3's original point (a
conflict-named directory is one excluded object, not N extras) and removes BOTH
addressing instances of the vacuous match — ancestor-named and root-named — so
neither is misclassified by a name that belongs to its caller's addressing
rather than to its content.

**`root` is bound once, not threaded.** `project()`
(`apply-receipt.ts:460-483`) is the only caller of `normalizeRel` (`:463`) and
always runs before either walk, so it is the natural — and only — place the
closure can be built. §2.4 spells out the binding site and how the closure
reaches the walks. Recorded here because the shape's cheapness depends on that
ordering: a future caller that walks without projecting first would have no
closure to call.

**Claim, narrowed (r4, re-stated for the r7 predicate).** Root-scoping is
**correct addressing**, not the safety property. A repo whose entire comparable
population sits under a single conflict-named directory **strictly below its own
root** — i.e. inside the repo — still lands on the same empty-both-sides chain:
same `apply.ts:307` whole-directory eviction, applied to the repo's one content
directory. §2.4 is what makes that class safe.

**But addressing here IS availability (r5).** With §2.4's guard shipping,
dropping §2.3 does not merely mis-address such a repo: every repo whose root or
ancestor carries the grammar has both populations emptied BY THE GRAMMAR, arms
the guard, and becomes **permanently `indeterminate`** — the FM wedge in a
different color, reached by a different door. That is an availability property,
not an addressing nicety, and it is why §2.3 stays required even though §2.4
owns safety.

**Pin (§7), BOTH arms: a repo whose root matches the grammar, and — separately —
a repo whose ancestor matches it, each with a working tree diverged from the
applied manifest, must return `verdict.kind === "mismatch"` — not `match`, and
not `indeterminate`.** The two arms are now the same rule (both names are
addressing), which is exactly why both must be asserted: an implementation that
regresses to "at or below" leaves the ancestor arm green and fails only the root
arm. Asserting merely "not `match`" would stay green with §2.3 deleted, because
the guard's `indeterminate` also satisfies it (B-r4-1).

### 2.4 The empty-population guard (D2) — a zero-pair prove is not a match

The deeper primitive behind B1: **a prove that compared zero entries because
the conflict grammar removed them is `indeterminate`, not `match`.** Root
scoping (§2.3) removes the two ADDRESSING instances — an ancestor's name and the
repo's own name, neither of which is content; this removes the class that
remains, a population emptied by conflict-named content strictly BELOW the root.

**Where the vacuous match comes from.** With both populations empty,
`compareEntries` (`apply-receipt.ts:306-311`) calls `alignPaths` (`:274-304`),
which over an empty key set builds zero `pairs` and zero `samples` and returns
`{ kind: "match", pairs: [] }` at `:303`; `compareEntries` then filters zero
pairs, finds `samples.length === 0`, and returns the `MATCH` singleton at
`:311`. Nothing on that path can distinguish "nothing to compare" from
"everything agreed".

**The mechanism, in its smallest form.** One boolean per prove, owned by the
oracle instance's in-flight proof:

- It is set **exactly when `comparable()` returns `false` for an entry because
  of the conflict grammar** — the grammar arm, not `hardExcluded` and not the
  matcher — **during THIS walk of THIS prove**. It is not a workspace-level or
  cached fact: a copy excluded on a previous prove of another repo leaves it
  unset here.
- Both walks (`inventory`, `scopedScan`) and the manifest-side filter in
  `project()` feed the same boolean, so a grammar exclusion on either side
  arms it. That preserves §3's symmetry contract: the two sides cannot disagree
  about whether the grammar was in play.

**The arming seam, named (r5 correction 6).** "The same boolean" needs a physical
owner, and the code already hands one over: **`project()` runs exactly once per
prove, always before either walk, and its result is threaded to every consumer.**
So the sink is born there and rides the projection:

- `project()` (`:460`) allocates `const armed = { hit: false }` and builds
  `const comparable = comparableFor(normalized, eq, armed)` immediately after
  `normalizeRel` (`:463`) and before the `filter` at `:468-469`. Both live on
  the returned `Projected` struct alongside `expected`/`oracle`/`preScan`/
  `touchedKeys` (`:473-482`).
- `inventory` (called at `:500`) and `scopedScan` (called at `:659`) take the
  bound closure as a parameter. Both call sites are inside scopes that already
  hold `projected`, so nothing new is plumbed through the class.
- The two downgrade sites read `projected.armed.hit`: `proveFresh` holds
  `projected` at `:541`, and `scanAndCompareProjected` receives it as its third
  parameter (`:658`) and holds it at `:669`.

**Verified: one `project()` per prove**, which is what makes "per-prove" true
rather than aspirational. `this.project(...)` has exactly two call sites.
`proveFresh` projects at `:489` and hands the SAME struct to
`scanAndCompareProjected` at `:493`, `:510` and `:530`; `scanAndCompare`
(`:650-656`, reached from `reproveRepo`'s token-mismatch path at `:386`)
projects once at `:651` and hands it on at `:655`. There is no path that
projects twice or that walks without a projection, so there is exactly one sink
per prove and both sides write to it.

*Variant considered and rejected:* an instance field on the oracle reset at the
top of each prove. It is smaller to write and wrong under `serial()`
(`:405-412`), which de-duplicates in-flight proofs per `rel` but does not
serialize proofs of DIFFERENT repos — two concurrent repo proofs would share one
field. The projection-scoped sink has no such coupling.

**Recorded dependency: the manifest side is projection-scoped BEFORE the
grammar arm can fire (r4 correction 1).** `project()`'s filter
(`apply-receipt.ts:468-469`) walks the ENTIRE prepared manifest, not the repo's
slice, so a grammar-matching entry anywhere in the workspace would arm the
boolean for every repo — and the empty-`git init` discrimination below would
collapse. It survives only because the filter's conjunction short-circuits:
`inProjection(entry.path, normalized, eq)` is tested first, so out-of-projection
entries never reach the `comparable()` arm at all. Recorded here for the same
reason as the `normalizeRel` ordering dependency above: the mechanism's
correctness rests on an evaluation order a future edit could reorder silently.

**The verdict rule — a DOWNGRADE OF A FINAL `match`, never a veto on an
intermediate alignment (B-r4-3).** A prove reads two alignments before it
concludes — `compareEntries` over expected×oracle at `apply-receipt.ts:495` and
`alignPaths` over expected×`inventory.entries` at `:505` — and firing the guard
on the first of those is actively harmful: a repo whose manifest projection is
emptied by the grammar while the walk still finds real files today falls
through `:509` into `scanAndCompareProjected` and lands on
`mismatch`/`local-edits`; a guard at `:495` would return `indeterminate` and
defer it permanently. The rule therefore attaches to the **final verdict**:

| Final verdict | Compared pairs | Guard boolean | Result |
|---|---|---|---|
| `match` | zero | **set** | `indeterminate(CONFLICT_COPY_POPULATION_WHY)` — "repo population emptied by conflict-copy exclusion" |
| `match` | zero | unset | `match` — exactly today's behavior, unchanged |
| `match` | ≥ one | either | `match`, unchanged |
| anything else | either | either | unchanged |

**Its two sites, and the population each one counts (r5 correction 1).** Every
`match` a fresh prove can return exits through one of exactly two `records.set`
calls, and "zero compared pairs" names a DIFFERENT comparison at each:

| Site | Verdict being stored | The population whose pairs must be zero |
|---|---|---|
| `apply-receipt.ts:541` (tail of `proveFresh`) | `semantic`, from `compareEntries(projected.expected, projected.oracle, …)` at `:495` | **manifest × manifest** — the prepared expected set against the oracle set, both filtered by `project()` |
| `:669` (tail of `scanAndCompareProjected`) | `verdict`, from `compareEntries(scanned.files, projected.oracle, …)` at `:664` | **disk × manifest** — `scopedScan`'s walked files against the projected oracle set |

Both are `compareEntries` calls, so both reach the same vacuous-`MATCH` chain
(`:306-311` over `alignPaths` at `:274-304`); the guard asks each one about its
own two inputs. Writing the rule as "the verdict being stored is `match` and the
`compareEntries` that produced it saw zero pairs" is what makes one sentence
cover both.

`settle()` (`:413-415`) is not a third site — it records a verdict with no
`receiptHash` and no `tokens`. **Verified across all eleven of its call sites**
(`:391`, `:487`, `:491`, `:497`, `:503`, `:507`, `:516`, `:532`, `:653`,
`:662`, `:666`): every one passes an `indeterminate`, either an
`indeterminate(...)` constructed on the line above or a value already
narrowed to `kind === "indeterminate"` by the guard immediately preceding it.
No `settle()` call can carry a `match`, so the guard has nothing to do there.

The cached path needs no site either: `reproveRepo` re-affirms `MATCH` at `:388`
only when `prior.verdict.kind === "match"` (`:383`), and a downgraded prove
stores `indeterminate`, so it re-enters `proveFresh`.

**The downgrade is computed BEFORE `records.set`, so the record is consistent
with it (r5 correction 2).** Both sites today compute `receiptHash` and then
store `{ verdict, receiptHash, tokens: verdict.kind === "match" ? … : undefined }`
in one expression (`:540-541`, `:668-669`). The guard therefore applies to the
verdict *variable* the store reads, not to the return value:

```ts
const verdict = downgradeIfEmptied(semantic, projected.armed, /* pairs */ …);
this.records.set(rel, verdict.kind === "match"
  ? { verdict, receiptHash: this.receipt(…), tokens: <that site's tokens> }
  : { verdict });
return verdict;
```

**A downgraded record stores NEITHER `tokens` NOR a `receiptHash`.** The tokens
half falls out for free once the ternary sees the downgraded verdict. The
`receiptHash` half is the deliberate, conservative choice: `receiptHash` is the
fast-path reprove credential and the `oracleReceipt` identity field
(`src/cli/sync-git/resolution-intent.ts:115`, `… ?? null`), and a receipt minted
from a population the grammar emptied would let a later boundary re-prove or a
`--confirm` treat the emptied comparison as proven. `settle()`'s existing shape
(`{ verdict }` only) is exactly this rule, so a downgraded store is
byte-for-byte a `settle()`-shaped record; `receiptHash(rel)` already returns
`string | undefined` (`:371-373`) and every consumer already tolerates the
absence.

The named reason is a fail-closed verdict, which the git plane already knows
how to carry (`whyFromScanError`'s peers at `:266-272` all land the same way,
and §2.5's `scanDeferred` note describes the identical class). It defers the
repo instead of blessing it — the safe direction, and the direction B1 showed
matters.

**The empty-`git init` discrimination.** A genuinely empty repo (`git init`,
no files, nothing in the applied manifest) must still settle `match`, or every
freshly created repo on the fleet becomes permanently indeterminate. It does:
its zero pairs come with **no grammar exclusion observed**, so the boolean is
unset and the table's second row applies. The guard is "the conflict grammar is
why the population is empty", never "the population is empty" — that
distinction is the whole mechanism, and §7 fixtures both sides of it.

**Cost, stated — including the one it re-defers (r4 correction 4).** One boolean,
one branch, one new verdict reason. It buys the deletion of the entire
vacuous-match class, and it makes §2.3 optional as a *safety* argument while
remaining required as an *addressing* (and, per §2.3, *availability*) one. The
honest cost: a repo whose ENTIRE comparable population is conflict copies now
returns `indeterminate` where it returns `match` today — it is re-deferred, not
blessed. That is the safe direction but it is still a hold, so state its bound:
zero in the field today, because all 14 §5 census mints sit in repos that also
carry ordinary content, so none of them empties a population. The bound is
measured, not argued; if a future census finds a conflict-copy-only repo, this
guard holds it until the user clears the copy.

**Second cost, on the SAME zero-in-field bound: the downgraded repo loses its
fast path (r5 correction 3).** Because a downgraded record stores no usable
`tokens` (above), `reproveRepo`'s first test — `if (!prior?.tokens ||
prior.verdict.kind !== "match") return this.proveFresh(rel)` (`:382-383`) —
fails on BOTH clauses, so **every boundary re-prove of that repo falls to
`proveFresh`** instead of the token-comparison fast path at `:384-389`. On the
state oracle `proveFresh` goes straight to `scanAndCompareProjected` (`:493`)
and thus to a full `scopedScan` (`:673`): a re-`lstat` of every entry in the
subtree, plus a re-hash of every file the hash cache misses (`cache.lookup` at
`:698` still absorbs the unchanged ones, so this is a re-stat of the subtree and
a re-hash of its churn, not an unconditional re-hash of every byte). This
repeats on every boundary until the user clears the copy.

The bound is the same one: **zero repos in the field today**, because no census
mint empties a population. It is recorded because it is the cost that scales
with repo size rather than with repo count — a conflict-copy-only repo that is
also large would pay it on every boundary, and that is the trigger to revisit
rather than to absorb.

### 2.5 ONE predicate, five sites / seven calls (M5, m3, D1)

Today the same exclusion logic is hand-copied five times in
`src/engine/apply-receipt.ts` — re-verified:

| Line | Shape today | `kind` at the call |
|---|---|---|
| `:469` | manifest filter: `inProjection && !hardExcluded && !matcher.ignores` | `"leaf"` |
| `:616` | cached walk, child: `hardExcluded ⇒ continue`; dir ⇒ `prunes?.(dirForm) ?? ignores`; leaf ⇒ `!ignores` | `"dir"` / `"leaf"` |
| `:636` | cached walk, scope is a leaf | `"leaf"` |
| `:713` | fresh walk, child (same shape as `:616`) | `"dir"` / `"leaf"` |
| `:736` | fresh walk, scope is a leaf | `"leaf"` |

Five hand-copies are five chances for the two sides to drift — that drift IS
the bug class this design fixes. `comparable` =
`!hardExcluded(rel, eq)` and `!matchesConflictGrammarBelow(rel, root)` (§2.3:
components strictly below `root`) and the matcher arm the `kind` already selects
(`ignores(rel)` for `"leaf"`, `prunes?.(rel + "/") ?? ignores(rel + "/")` for
`"dir"` — `prunes` is OPTIONAL on `IgnoreMatcher` (`src/engine/ignore.ts:302`),
so the folded call must keep the `?.`; a non-optional call throws on a matcher
that does not implement it). `kind` is not a new
concept: every call site already knows it statically.

**Call-site count after the change (m3): seven** — `:469`, `:636`, `:736`,
the dir and leaf arms of `:616`, and the dir and leaf arms of `:713`. The
`"other"` arms deliberately do NOT call it; §2.6 says why.

**Required restructure of `scopedScan`'s child loop (D1 — blocker).** The two
walks do not have the same shape today, and a literal substitution flips
`scopedScan` fail-open. `inventory` (`:614-625`) makes the `"other"` arm a
SIBLING of the leaf arm (`:621`), so swapping `:619`/`:623` for `comparable()`
leaves `:622` genuinely untouched. `scopedScan` (`:711-722`) NESTS its
`"other"` throw *inside* the leaf guard — `:718` is the guard, `:719` computes
the type, `:720` throws. Replace `:718` with `comparable(childRel, "leaf",
root, eq)` as written and a conflict-grammar FIFO fails the guard and is
**silently skipped**: `:720` is never reached. The line above — "the `"other"`
arms deliberately do NOT call it" — is true textually and false behaviorally:
the routing decision for `:720` is made one level up at `:718`.

So the change to `scopedScan` is not a substitution, it is a restructure: hoist
the type computation above the guard so the child loop takes `inventory`'s
shape. The snippet below shows **the whole child body, `:714-722`**, because
the dir arm converts too (B-r5-1) and showing only the `else` would leave the
reader to guess at the arm above it — the guess that produced r5's incorrect
"stays exactly where it is" claim. Note that this `type` computation — unlike
`inventory`'s at `:610-611` — has no `"dir"` value, which is exactly why the
directory decision has to be made before it:

```ts
// scopedScan's child loop, replacing :714-722 (after :713's hardExcluded continue):
if (child.isDirectory()) {
  if (!comparable(childRel, "dir")) continue;   // was: prunes?.(dirForm) ?? ignores(dirForm)
  await walk(childRel);
} else {
  const type: DirCacheChild["type"] = child.isSymbolicLink() ? "symlink" : child.isFile() ? "file" : "other";
  if (type === "other") { if (!this.matcher.ignores(childRel)) throw new Error("unsupported-entry"); }
  else if (comparable(childRel, "leaf")) await scanLeaf(childRel, type);
}
```

Two things to read off it. First, the `"dir"` kind carries the `dirForm`
(`childRel + "/"`) construction and the `prunes?. ?? ignores` fallback INSIDE
`comparable`, which is why `:715-716`'s two lines collapse to one call — the
`dirForm` string never appears at a call site again, and neither does the
optional call or the `??`. The optional call is not cosmetic: `prunes` is an
optional member of `IgnoreMatcher` (`src/engine/ignore.ts:302`), and both walks
write it as `this.matcher.prunes?.(dirForm) ?? this.matcher.ignores(dirForm)`
today (`:619`, `:716`) — the fold must carry the `?.` verbatim or a matcher
without `prunes` throws where it used to fall back.
Second, `inventory`'s directory arm (`:617-620`) converts by literal
substitution of the same call: its `"other"` arm is already a sibling
(`:621-622`), so it needs no restructure, only the two swaps. That is the
`:616` row's dir arm and the `:713` row's dir arm — two of m3's seven.

The `"other"` check precedes `comparable()` on both walks, which is the point:
without it, one prove could reach `inventory` (`:500`) and fall through to
`scopedScan` (`:530`) and get `indeterminate` on one path and a silent skip on
the other — **oracle asymmetry inside a single prove**, satisfying §3's first
protected contract in form while breaking it in behavior. m3's count is
unaffected: still seven `comparable()` call sites.

**Named out of scope, with their behavior stated:**

- `scanDeferred` (`:465`): if any deferred/unreadable path lies in the repo
  subtree the whole projection returns `indeterminate("scan deferred in repo
  subtree")` BEFORE the filter runs. A conflict copy on an unreadable path
  therefore still yields `unreadable`, not `local-edits`. Unchanged —
  `indeterminate` is a fail-closed verdict, not #659's wedge class. It stays
  `unreadable` and not §2.7's `conflict-copies`, correctly: the `why` is
  "scan deferred in repo subtree" (`:466`), the path genuinely could not be
  read, and §2.7's discrimination is exact-match on one constant.
- `touchedKeys` (`:477`): filtered by `inProjection` only, with no
  `hardExcluded`/`ignores`/conflict arm at all. It is a membership set
  consulted at `:524`, never a comparison population, so an extra key cannot
  manufacture a mismatch. Unchanged.

Explicitly NOT built: no GC/expiry of conflict copies; no publish-lane change;
no new ignore rules; no oracle asymmetry.

### 2.6 The `"other"` arm stays fail-closed (R1, restructured by D1)

`apply-receipt.ts:622` and `:720` today throw `unsupported-entry` for a
special file (FIFO, socket, device) unless the matcher ignores it; the throw
becomes `indeterminate` via `whyFromScanError`. `apply-receipt.test.ts:393-400`
pins exactly the ignored case ("ignored special entries are removed
symmetrically", `mkfifo` ⇒ `match`).

**Decision: do NOT route the `"other"` arm through `comparable()`, on either
walk.** Doing so would turn a conflict-grammar FIFO from a fail-closed
`indeterminate` into a silent symmetric skip — a fail-closed → fail-open flip,
on the exact axis B1 just showed is the dangerous direction. `conflictName`
never produces a special file (`moveAside` renames whatever was there, and only
a user could `mkfifo` a grammar-matching name), so the case is
adversarial-only.

"Does not call `comparable()`" is a claim about **routing**, not about text:
`inventory:622` already satisfies it, and `scopedScan:720` satisfies it only
after §2.5's restructure lifts it out from under the leaf guard. Both arms keep
their own `!ignores` test, which is why the existing pin stays green.

Consequence, stated: a grammar-matching special file yields
`indeterminate`/`unreadable` for its repo, not `local-edits` and not `match`.
`apply-receipt.test.ts:393` is **unchanged and must stay green** — it exercises
the *matcher*-ignored path, which this design does not touch, and it asserts
through `pullOracle(...).proveRepo(...)`, i.e. the `inventory` side only. A new
sibling pins the conflict-grammar FIFO at `indeterminate` on **both** oracles
(§7).

### 2.7 The guard-armed hold names itself: `conflict-copies` (r5 correction 4 — product decision)

**The problem the guard leaves behind.** §2.4's downgrade produces an
`indeterminate`, and `classifyCheckout` maps EVERY oracle `indeterminate` to one
reason: `follow-classify.ts:139` — `else if (oracle.kind === "indeterminate") {
reasons.add("unreadable"); details.push(oracle.why); }`. So a repo held because
rbox's own conflict copies emptied its comparison would tell the user
"**unreadable repository** — Git metadata could not be read completely. Restore
repository readability and permissions, then let sync retry."
(`status-view.ts:302`). Every word of that is false, and the repair instruction
sends a non-developer to check filesystem permissions on a repo whose real fix
is deleting a file rbox itself created. Against the non-developer copy bar, that
is not a papercut; it is a wrong answer.

**Ratified: a NEW named reason, `conflict-copies`.** Not a `detail` string on
`unreadable` — the reason id is what drives the label, the repair text, the
precedence ranking, and the telemetry bucket, and all four want to be different
here.

**Discrimination — by the exact `why`, not by a sniff.** §2.4's downgrade is the
only producer of `CONFLICT_COPY_POPULATION_WHY` (§0), so `follow-classify.ts:139`
splits on string equality against that exported constant:

```ts
else if (oracle.kind === "indeterminate") {
  reasons.add(oracle.why === CONFLICT_COPY_POPULATION_WHY ? "conflict-copies" : "unreadable");
  details.push(oracle.why);
}
```

Exact equality, deliberately: `whyFromScanError`'s vocabulary (`:266-272`) and
the dozen inline `indeterminate("…")` literals are free-form prose, and a
`includes("conflict")` test would capture the `conflict` reason's own details.
The `detail` push is unchanged, so design 271's parallel `GitDeferral.detail`
work is unaffected — this decision changes which reason id is added, never how
details are carried.

**The full surface set.** `GitDeferralReason` is a closed enum with several
compile-time totality proofs, so "add a reason" has an exact, discoverable
footprint. Every site, anchored:

| Surface | Anchor | What the new member needs |
|---|---|---|
| Enum declaration | `src/cli/sync-state-model.ts:130-134` (`GIT_DEFERRAL_REASONS`) | add `"conflict-copies"` |
| Precedence ranking | `sync-state-model.ts:149-153` (`GIT_DEFERRAL_REASON_PRECEDENCE`) | rank it **immediately after `conflict`** and before `worktree-ownership` — it is a durable structural condition the user must clear, not an environmental one. `:156-158`'s `UnrankedGitDeferralReason` alias is a compile error until it is ranked; `:165-167` is the load-time check, which compares the precedence SET's size against `GIT_DEFERRAL_REASONS.length` and so also catches a member ranked but never declared |
| Wire/telemetry restatement | `src/cli/telemetry/contract.ts:158-165` | the deliberately duplicated list (`state-plane/duplicate-declarations.test.ts:59` licenses the two sites); `:163-165`'s exhaustiveness alias fails until it is added |
| Telemetry length pin | `src/cli/telemetry/contract.test.ts:48` (`toHaveLength(18)`) | becomes `19` |
| Status-view copy | `status-view.ts:289-307` (`DEFERRAL_REASON_PRESENTATION`, `satisfies Record<GitDeferralReason, …>` at `:308`) | the four fields below |
| Resolve refusal copy | `src/cli/git/resolve-presentation.ts:125-146` (`refusalMessage`'s `Record<GitDeferralReason, string>`) | one sentence; the `Record` type makes omission a compile error |
| Coverage test | `status-view.test.ts:163-169` | iterates `GIT_DEFERRAL_REASONS` asserting non-empty label/text/repair — it covers the new member automatically, and fails if the presentation entry is missing. Its second half (`:170-174`) pins the unknown-reason FALLBACK (`"future-reason"` ⇒ "unrecognized Git issue", `transient: false`) and is untouched by adding a member |
| Precedence test | `src/cli/sync-git/deferral-precedence.test.ts:11-19` | set-equality of enum vs precedence vs rank — covers it automatically |
| Doctor reason inference | `src/cli/doctor-cmd.ts:43`, `:213-217` (`gitReasonOf`) | **see the ordering hazard below** |

**The one non-mechanical site: `doctor-cmd.ts`'s `gitReasonOf` (`:213-217`).**
It infers a reason from a free-text detail by iterating
`GIT_DEFERRAL_REASON_SET` and returning the first member the normalized detail
`includes(...)`. Set iteration follows declaration order, and `"conflict"`
precedes any appended member — so a detail containing "conflict-copies" would
be classified `conflict`, silently. Fix: place `"conflict-copies"` **before**
`"conflict"` in the `GIT_DEFERRAL_REASONS` declaration (`sync-state-model.ts:130`).
Declaration order is explicitly "an enumeration, not a ranking"
(`sync-state-model.ts:145-147`), so moving a member within it is free — the
ranking lives in `GIT_DEFERRAL_REASON_PRECEDENCE` and is set independently
above. Recorded because it is the one place where enum ORDER is load-bearing,
and nothing type-checks it.

**The general invariant behind that fix (C-r6-3).** `"conflict-copies"` before
`"conflict"` is one instance of a rule the vocabulary now has to keep:
**any `GIT_DEFERRAL_REASONS` member that is a superstring of another member must
precede that member in the declaration.** `gitReasonOf` returns the FIRST
`includes()` hit while iterating `GIT_DEFERRAL_REASON_SET`
(`doctor-cmd.ts:213-217`), and that set is built from the declaration in order
(`:43`), so a shorter member declared earlier permanently shadows every longer
member containing it. Today `local-edits`/`local-index`/`local-operation`/
`local-commits`/`local-stash` share only a prefix and collide with nothing, so
the vocabulary satisfies the rule by luck rather than by construction. §7 adds a
unit test that pins the invariant itself — for every ordered pair `(a, b)` with
`a !== b` and `a.includes(b)`, `index(a) < index(b)` — because nothing types it
and the next superstring member will be added by someone who has not read this
paragraph.

**Enforcement split of the nine rows above, so the cost is not overstated.**
One row is the declaration itself. Of the eight that follow it: **four are
compile-time** (precedence ranking, telemetry restatement, status-view copy,
resolve refusal copy — each fails `tsc` until the member is handled), **three
are carried automatically by existing tests** (the telemetry length pin, which
is a one-digit edit; the status-view coverage test; the precedence test), and
**one — `doctor-cmd`'s `gitReasonOf` — is unenforced by anything**, which is
precisely why decision C-r6-3 above adds a test for it. Adding a member is
mechanical everywhere except that last row.

**Priced residual: the ordinary resolve refusal keeps its generic copy
(C-r6-2).** `refusalMessage`'s new sentence reaches the user only on the
locked-boundary refusal path (`resolve-command.ts:1070`, which emits
`refusalMessage(follow.reason)` for the follow-up reason). The ORDINARY resolve
refusal for a guard-downgraded repo never gets there: `proofIndeterminate` is
set at `:269` the moment the oracle returns `indeterminate`, and the command
short-circuits at `:686-687` (`keep-mine`) and `:892-893` with the canned
`code: "proof-indeterminate"` text — "retry after Git state settles" — which is
transient-flavoured copy for a hold whose `transient` is deliberately `false`.
Accepted as a residual, not fixed here, because: the deferral surfaces
(`rbox status`, `rbox doctor`, the deferral listing) are the primary visibility
for this hold and they DO carry the new reason's copy; the generic refusal is
shared across every indeterminate cause, so changing it means threading a cause
into a message that today has none; and `resolve-command.ts` is at design 271's
concurrent ratchet ceiling, which makes this the wrong PR to widen it in.
**Ledgered follow-up (§6):** when `resolve-command.ts` is next split per its
ratchet, the proof-indeterminate refusal gains reason-aware copy.

**The copy, written for a non-developer** (matching the surrounding voice —
`local-edits`'s "Working files changed here." register, not a paragraph):

```ts
"conflict-copies": {
  label: "conflict copies",
  text: "Backup copies rbox made of conflicting files are the only thing left to compare here.",
  repair: "Remove the conflict-copy files (or resolve them), then let sync retry.",
  transient: false,
},
```

`transient: false` is deliberate and load-bearing: the hold does not clear on
its own, and `transient` feeds `remediationClass` at `status-view.ts:404-412`.
A `true` there would render this as self-healing and tell the user to wait
forever. With `false` the projection falls through to the existing lane-based
classification with no new branch — `projectGitDeferralRepos` (`:378-436`)
needs **no change at all**, which is the point of adding a reason rather than a
special case. `refusalMessage`'s line: `"rbox-made conflict copies are the only
files left to compare in this repository"`.

**Ledgered alternative — accept the `unreadable` mismatch and file a papercut.**
Zero code, and it was the r5 posture by omission. Rejected: `unreadable`'s
repair text actively misdirects (permissions, not files), the condition is
permanent rather than transient so the user sees it until they act, and the
one user population that hits it — a receiver whose repo is all conflict copies
— is precisely the population this design exists to unwedge. Trading a correct
answer for the nine rows above — one declaration, four the compiler demands
anyway, three existing tests carry for free, and one (`doctor-cmd`) that needs
thought and now gets a test — is the wrong side of the primitives rule: this
adds one member to an existing closed vocabulary, not a new mechanism.

## 3. Protected contract, and the complete consumer list (M4, R2)

Preserved:

- **Oracle symmetry.** `comparable` is one function; both sides call it. Pinned
  the same way the matcher is (`apply-receipt.test.ts:201`/`:393` siblings).
- **Conflict copies stay FULLY sync-eligible.** Nothing is un-synced (224's
  ruling honored: this widens no ignore predicate; it narrows one COMPARISON,
  symmetrically). The `type-flip` rig's "+1 recoverable .conflict" assertions
  hold byte-identically.
- **`local-edits` for real user edits.** 241/270 held-skip semantics untouched.

**Corrected from r1.** r1 §3 claimed a user file containing ".conflict" "still
compares, the grammar test is exact". Half true, and the wrong half matters.
Every consumer whose observable behavior changes:

1. **`local-edits` holds.** A user file matching the FULL grammar stops being
   compared and loses its hold: refs and the applied manifest advance while it
   has uncommitted edits. **No byte loss** — it is still scanned, hashed, and
   synced on the file plane, and a checkout that would overwrite it still goes
   through apply's own conflict-copy path.
2. **`rbox git resolve --show`.** A repo whose only divergence is conflict
   copies flips **dirty → clean**. Intended (it is the fix), named here so the
   output change is not a surprise. The mismatch sample
   (`apply-receipt.ts:99-101`) can no longer name such a path.
3. **Waived / keep-mine flows** lose a `local-edits` reason they previously
   saw. Same intent, same note.
4. **The `oracleReceipt` hash (re-anchored in r4).** `resolution-intent.ts:115`
   puts `oracle.receiptHash(rel)` into the snapshot identity as the
   `oracleReceipt` field — `sync-state-model.ts:270` is that field's TYPE
   declaration, not a persistence site. The binding is never written to disk;
   it escapes the process only as the confirmation snapshot id, so "durable" was
   wrong and is dropped. The cross-version gate is that id:
   `snapshotId(identity)` (`resolve-command.ts:144`, called at `:293`) becomes
   `snapshot.public.snapshot`, printed for the user at `:352`
   (`keepMineConfirmCommand`); a later `rbox git resolve --confirm <snapshot>`
   recomputes the identity and compares — `:761`, `:797`, `:896` — emitting
   `snapshot-mismatch` on any difference. Because `oracleReceipt` is a field of
   that identity, a receipt-population change across the upgrade changes the id
   and the confirm refuses. So *client skew across the upgrade fails closed*: a
   `--show` snapshot taken by one version and confirmed by the other asks for a
   fresh `--show` rather than applying a stale intent.
   (`resolve-command.ts:1046-1051` is a separate, IN-PROCESS boundary re-prove
   against `confirmedIdentity` (`:1019`) that sets `boundaryMismatch`; same
   binary on both sides, so it cannot exhibit version skew and is not the gate
   cited here.)
5. **Repo-scope addressing (B1).** A repo at or under a conflict-named
   component compares exactly as today — §2.3's scoping is what buys that.
6. **A new deferral-reason vocabulary member, `conflict-copies` (§2.7).** The
   git plane gains one reason id; no existing reason changes meaning, and the
   only reclassification is guard-armed holds that would otherwise have been
   `unreadable`. **Client skew is graceful and fail-closed**: an older CLI
   reading a newer state file's `conflict-copies` falls through
   `isKnownGitDeferralReason` (`status-view.ts:314-316`) to
   `UNKNOWN_GIT_DEFERRAL_PRESENTATION` (`:282-287`) — "unrecognized Git issue",
   `transient: false`, and `knownReason === false` forces `canResolve` and
   `canKeepMine` to `false` (`:402-403`) and `remediationClass` to
   `"apply-unavailable"` (`:404-405`). The old binary shows a vague hold and
   offers no action; it never mis-offers one. `status-view.test.ts:169-173`
   already pins that fallback.

## 4. Visibility and deletion ownership (M6, R3, R4)

A silent exclusion is how litter becomes permanent, so a surface is IN scope.
This section owns the **count** (`rbox status`, workspace-wide). The **hold**
has its own surface — the `conflict-copies` deferral reason — and §2.7 owns it.

**`conflictCopies` is a TOP-LEVEL projection field (B-r4-4)**, not a member of
`StatusLocalCountsBase` (`src/cli/status-contract.ts:121-131`). r4 put it in
`counts` while citing the top-level carriers, which cannot both be true: the
JSON renderer gates the whole `local` block on `counts.source === "daemon"`
(`status-render.ts:151-162`), so a `counts` member is invisible on the computed
branch — the branch a daemonless host reads. It therefore rides exactly the
`strandedIgnored` carriers the 224 precedent uses, and that precedent's comments
apply verbatim: `status-contract.ts:218-222` ("Deliberately top-level rather
than inside `counts`, which is entangled with `counts.source`") and
`status-render.ts:148-150` ("deliberately OUTSIDE the `local` block, which is
emitted only for a daemon snapshot"). Projection declaration:
`conflictCopies?: number` beside `strandedIgnored` at `status-contract.ts:222`
(the daemon's activity-wire field is a separate declaration — see "Wire shape"
below); emission at `status-render.ts:150` (JSON) and `:318` (view).

It sits on the same surface as the existing `counts.conflictSnapshots:
{ total, prunable }` — which is the *git ref* namespace
(`src/cli/sync-git/conflict-retention.ts`, `refs/rbox-conflict/`, 90-day
prune). Different objects, adjacent surface; the rendering must not blur them
(`status-render.ts:270-271` prints "conflict snapshots"; the new line reads
"conflict copies").

Source: a local manifest that is already in hand on whichever branch runs. Zero
new filesystem scan (see the CPU cost below), and the **same predicate** as the
oracle exclusion, so the count can never disagree with what was excluded.

**The `strandedIgnored` precedent, taken for its WIRE shape only (R3, corrected
by r4).** Design 224 §2.3 solved the same *surface* problem, and its full chain
is `local-file-projection.ts:39` (`strandedIgnored = ignoredBase.length`,
produced) → `push.ts:647` (`deps.onStrandedIgnoredObserved?.(…)`) →
`daemon.ts:1864` (the hook stores it) → `daemon.ts:370` (the daemon field) →
`daemon.ts:2272` (emitted into the activity snapshot) → `activity.ts:77`
(optional field) → `status-projection.ts:302`/`:361` → `status-contract.ts:222`
and the JSON/human surfaces at `status-render.ts:150`, `:318`, `:273`.

**Its value rides the PUSH lane.** `strandedIgnored` is only ever observed
inside `push.ts:647`, which is why `activity.ts:74-76` documents the field as
absent for "a daemon … that has not pushed since start". Copying that source
verbatim would leave `conflictCopies` **permanently undefined on FM** —
the pull-only host whose 103-repo wedge this design exists to fix. Unacceptable.

**Verified: the computed branch does not rescue it either.** `rbox status` picks
its branch at `status-projection.ts:258-260`/`:295`: whenever
`trustedLocalSnapshot` (`:74-93`) succeeds — daemon running, owning the
workspace, with a fresh, settled, matching-base `activity.local` — status reads
the **daemon** branch and never runs the computed scan at `:344-379`. A
pull-only daemon does satisfy that: `enqueueActivityWrite`
(`daemon.ts:2407-2445`) writes `activity.local` at `:2419-2421` on every
activity write with no pull-only condition, and `localSnapshot`
(`daemon.ts:2259-2275`) derives it from `this.local.manifest`. So on a live FM the computed branch is not reached, and
"pull-only hosts read the computed branch" would be false.

**Decision: source the count off the local manifest on BOTH branches,
independent of the push lane.**

- **Daemon branch:** computed inside `localSnapshot`
  (`src/cli/daemon/daemon.ts:2259-2275`) from `this.local.manifest.files`,
  exactly beside `trackedFiles` at `:2267`. That manifest is maintained by scans
  and pull-applied patches (`daemon.ts:1926`, `:2015`, `:2575`) with no push
  involvement, so the count is present on a pull-only host. No new daemon field,
  no new hook, no new lane.
- **Computed branch:** filter over `rawLocalManifest.files`
  (`status-projection.ts:352-354`, the `port.scanManifest` result), read where
  `cacheHint` already reads it at `:358`.
- **Populate branch** (`:319-343`) has no local manifest and reports
  `undefined`, which renders as nothing — see below.

**The population, named — and the r4 premise it corrects (B-r4-5).**
`conflictCopies` means **entries of THIS device's locally observed manifest
whose path carries a grammar-matching component** — the same disk observation on
both branches, and deliberately not a diff against any base.

The r4 review read the computed branch's `localManifest`
(`status-projection.ts:360`) as *scope-projected* and the daemon's
`this.local.manifest` as *workspace-wide*, making this the `deleted` hazard
again. Verified in code, that premise does not hold. `projectLocalManifest`
(`src/cli/local-file-projection.ts:26-84`) applies **no scope projection at
all**: it carries matcher-ignored BASE entries forward (`:38-45`) and resolves
case-fold collisions (`:56-83`).

**What the scope plane actually projects (B-r5-2, restated to the true claim).**
r5 said "`scopeProjectionFor` has exactly two callers", which understates the
count and, more importantly, describes the wrong property. Verified:
`scopeProjectionFor` (`src/cli/scope/projection.ts:116`) has **four** callers —
`status-projection.ts:288`, `workspace-observation.ts:83`, `sync-git/status.ts:89`,
and `sync-git/deferral-hygiene.ts:219` (the daemon-plane one, imported at
`daemon.ts:156`). Three of the four use the projection to scope **git REPO
RECORDS**, via `scope.classifyRepo(repo) === "in"` over repo keys —
`workspace-observation.ts:86`, `sync-git/status.ts:90`/`:108`, and
`deferral-hygiene.ts:221`. Those touch no file manifest at all.

**On the STATUS path, the only `projectFiles` call projects the BASE (C-r6-1,
narrowed in r7).** `status-projection.ts:289-291` —
`scopedBaseManifest = statusScope.projectFiles(state.lastSyncedManifest)` — is
the only `projectFiles` call on the status path, and its argument is the applied
base, never a local observation. (The same caller's other spend,
`statusScope.probeKeys(statusRepoKeys)` at `:322`, is repo keys again.)

r6 stated this workspace-wide ("no caller applies a scope projection to a file
manifest except one"), which is false off the status path: `scopedPull`
(`src/cli/scope/pull-scope.ts:58-59`) projects the LOCAL and REMOTE manifests as
well as the base. That is the pull path, which builds `reconcileBase`/`local`/
`remote` for the reconciler and never feeds this count. The conclusion is
unchanged and is what §4 actually needs: **nothing on the status path
scope-projects a local manifest**, so neither branch's `conflictCopies` source is
scope-projected.

So neither branch's LOCAL manifest is
scope-projected; both are the device's own disk observation, and the `deleted`
carve-out at `:306-309` does not transfer — that hazard belongs to the *diff*
`deleted` takes against a whole-workspace base, and this count takes no diff.

**Preference (b) of the fold decision therefore applies: workspace-wide (i.e.
locally observed) on both branches, because the computed branch can reach the
unprojected manifest.** `rawLocalManifest` at `:352-354` is that manifest, one
line before the carry. The one real divergence is the carry itself: reading
`:360`'s post-carry `localManifest` would add matcher-ignored base entries that
are NOT on this disk, which the daemon's head never contains (the daemon calls
`projectLocalManifest` nowhere; publish does, at `sync/publish-candidate.ts:228`).
Sourcing from `rawLocalManifest` makes the two branches count the identical
population.

**A second post-`:360` divergence, same shape, same remedy (r5 nit).** The
ignored-base carry is not `projectLocalManifest`'s only edit to the manifest:
its case-fold arm drops every entry in an ambiguous fold and then **adopts the
BASE's entry for that fold** (`local-file-projection.ts:68-74` — filter at
`:68`, base adoption at `:72-73`, with the comment at `:69-71` stating why the
base spelling is authoritative). On a case-fold collision the post-carry
`localManifest` at `status-projection.ts:360` therefore contains a base-spelled
path that may not be the one on this disk — a second way `:360` stops being a
disk observation. `rawLocalManifest` (`:352-354`) precedes both edits, so the
single sourcing decision above already covers both; recorded so a future reader
who audits only the ignored carry does not conclude `:360` is otherwise safe. Noted and deliberately not propagated: `trackedFiles` already
differs across the branches on exactly this carry (`:371` post-carry vs
`daemon.ts:2267`'s head); `conflictCopies` does not inherit that skew.

**Wire shape, copied verbatim from the precedent:**

- `activity.ts`: `conflictCopies?: number` declared **optional** beside
  `strandedIgnored` at `:77`, with `sourceVersion` staying **`1`** (an older
  daemon simply omits the field; the version is not a feature flag).
- `activity.ts:152`: guard clause extended to
  `(local.conflictCopies === undefined || uint(local.conflictCopies))`.
- `activity.ts:166`: conditional copy —
  `if (local.conflictCopies !== undefined) decoded.conflictCopies = …`.
- `status-projection.ts:302` reads it from `trusted.local` on the daemon
  branch (beside `strandedIgnored`); the computed branch assigns it from the raw
  scan alongside `:361`; `:455`'s pattern
  (`if (x !== undefined) detail.x = x`) carries it top-level, and
  `status-render.ts:150`/`:318` emit it on both branches the way
  `strandedIgnored`'s comment at `:148-149` already prescribes.
- **When a v1 daemon omits it**, the value is `undefined` and the renderer
  prints **nothing** — exactly `strandedIgnoredLine`'s contract
  (`status-view.ts:927-933`: `if (!count || count <= 0) return undefined`).
  Absent and zero render identically; the line is only worth printing when
  there is something to act on. No "unknown" state is invented.

**"Zero new scan" is true of the FILESYSTEM only — the CPU cost, stated per the
perf-differential rule (r4 correction 5).** The daemon-branch count adds an
O(files) pass (path-component split plus one regex per component) to
`localSnapshot`, which `enqueueActivityWrite`
(`src/cli/daemon/daemon.ts:2407-2445`, calling `localSnapshot` at `:2419`) runs
on **every** activity write. It rides a body that is already O(files) on
that path — `diffManifests(base.lastSyncedManifest, this.local.manifest)` at
`:2262`, the `this.local.manifest.files.length` read at `:2267`, and the
`this.local.manifest.files.reduce` at `:2299` that the same `enqueueActivityWrite` reaches through
`ambientStatusFrom` at `:2430` — so this is a constant-factor increase on an
existing per-write linear pass, not a new order of growth. The computed branch's pass rides the status scan it
already performed. Both lanes are measured before/after per §7.

**Doctor listing: priced, and CUT (R4).** `collectRepoResidue`
(`doctor-cmd.ts:567-643`) reads sync state (`loadState`) and does
`pathPresent` stats; it **never reads the local manifest**. A per-repo listing
would therefore cost a new collector, a new renderer, a new
`LocalOnly…`/`Diagnostics…` section pair, and a manifest read doctor does not
perform today — for information the `rbox status` total already flags. Per the
primitives rule, that is mechanism bought too cheaply. **Doctor is out of
scope.** Per-path recovery moves to the papercut-documented flow: the status
line names the count, and the papercut entry carries the one-liner
(`find <root> -regextype posix-extended -regex '.*\.[^/.]+\.[0-9]{14}\.conflict.*'`)
plus inspect/keep/`rm` guidance. If the count ever grows past tolerance, a
doctor section becomes its own design with its own owner.

**Deletion ownership: the user owns deletion.** No auto-GC, no expiry, no
sweep — a conflict copy is the only surviving record of a diverged edit, and
224's ruling (silent un-syncing is worse than over-syncing) applies to silent
deleting a fortiori.

## 5. Field measurement — method, numbers, and BOTH conclusions (R5)

**Method.** On `/home/via/Development` (the bound workspace root),
2026-08-16: `find . -regextype posix-extended -regex '<the §2.1 grammar>'
-not -path '*/node_modules/*' -not -path './.rbox/*' -printf '%y %Y %p\n'`.
`%y` is the entry's own type, `%Y` the dereferenced type — the distinction
turns out to matter. A 15th hit sits under `.rbox/trash/…` and is excluded:
`.rbox` is hard-excluded from the oracle anyway (`apply-receipt.ts:228`).

**Numbers — 14 paths:**

| `%y` / `%Y` | Count | What they are |
|---|---|---|
| `f` / `f` | 6 | regular files: **three** `.env` copies (`Dfinitiv/savvy-core/studio/frontend`, `Personal/mach-email`, `Personal/rbox-core`) and **three** `163-…conflict.md` design-doc copies under `Personal/rbox-core/.claude/worktrees` |
| `l` / `d` | 8 | **symlinks whose targets are directories** — all eight are `node_modules.dev_<32hex>.<ts>.conflict` under `Dfinitiv/savvy-core/.claude/worktrees/*` |

**Correction (r4).** r3's breakdown read "two `.env` … one
`settings.local…conflict.json`", double-booking the `.rbox/trash` 15th hit that
the same paragraph excludes: the `settings.local…conflict.json` is that trash
hit and is NOT one of the 14. The re-executed census confirms 3 + 3.

Two distinct `dev_<32 hex>` tokens; **zero** `local`/`trash` tokens; **zero**
`~N` tails; **zero** user-authored files; and **zero true directories**
(`find -type d` over the same grammar returns nothing).

**Conclusion A — benefit.** 14 rbox mints, and `git rev-parse` puts **all 14**
inside a git repo — not 12 as r3 stated. The membership: `savvy-core` ×1, its
three `.claude/worktrees` repos ×8, `mach-email` ×1, `rbox-core` ×1, its two
`.claude/worktrees` repos ×3. Each is an extra that holds its repo
`local-edits` today. That is the wedge, measured.

**Conclusion B — cost, and a correction to the r2 framing.** r2 read the 8 as
"directories" and drew *subtree-scale* benefit from them. They are **symlinks**
(`%y = l`), and neither walk descends a symlink: `apply-receipt.ts:714` tests
`child.isDirectory()` and `:617` tests `child.type === "dir"`, both false for a
symlink, and `git-discover.ts` states outright that symlinks are never
followed. So each of the 8 is **one leaf entry, not a subtree**, and the field
evidence supports 14 single-entry extras — nothing subtree-scale.

Subtree scale is therefore a **code-derived** argument on both sides, not a
field-observed one, and it is honest to say so: `apply.ts:307` and
`trash.ts:250-252` *can* mint a true conflict-named directory (that is §2.3's
motivation), and the vacuous match *is* the same scale in the wrong direction
(that is §2.3's scoping and, for the class D2 found, §2.4's guard). Neither has
been observed in the field yet. The
measured benefit today is 14 single-entry extras removed; the measured
false-positive cost today is zero.

## 6. Alternatives recorded, REJECTED or DEMOTED (m10, r4, r5, r6, r7)

Five groups, in the order they were decided: **two r7 entries**, then **two r6
entries**, then **the three r5 entries** (which resolved r4's blockers
B-r4-3/4/5), then **the three standing entries** carried since r3 (the §2.3
demotion, D1's literal substitution, and decision 6's export), then the one
standing rejection of mint relocation. r5's header said "then r4's three" and
mislabeled that third group — those entries predate r4.

**r7:**

- **Testing components "at or below" the projection root — REJECTED (B-r6-1).**
  It was r6's written rule and it leaves the repo's OWN name component in the
  content population, so a repo that a `moveAside` renamed under the grammar
  empties both populations and is misclassified by its own address —
  `indeterminate` once §2.4 ships, `match` without it. Superseded by strictly
  below the root (§2.3): `proveRepo(rel)` addresses the repo BY that path, so
  its name is the caller's addressing exactly as an ancestor's is. Both B1 pin
  arms now assert `mismatch`.
- **Threading the `conflict-copies` cause into `resolve-command`'s
  proof-indeterminate refusal — DEFERRED, ledgered (C-r6-2).** The ordinary
  resolve refusal short-circuits at `resolve-command.ts:269` and emits the
  generic "retry after Git state settles" copy at `:686-687`/`:892-893` —
  transient-flavoured for a hold that is `transient: false`. Accepted as a
  priced residual: the deferral surfaces are this hold's primary visibility and
  they carry the correct copy, the generic refusal is shared across all
  indeterminate causes, and `resolve-command.ts` sits at design 271's concurrent
  ratchet ceiling. **Follow-up condition:** when `resolve-command.ts` is next
  split per that ratchet, the proof-indeterminate refusal gains reason-aware
  copy. Reasoning in §2.7.

**r6:**

- **Let a guard-armed hold ride `unreadable` and file a papercut — REJECTED
  (correction 4, product decision).** Zero code, and it was r5's posture by
  omission. `unreadable`'s repair copy (`status-view.ts:302`) sends the user to
  check repository permissions for a condition whose fix is deleting a file rbox
  minted; the hold is permanent, not transient, so the wrong instruction is what
  the user stares at until they guess. §2.7's new reason costs one member of an
  existing closed vocabulary — four of its eight follow-on surfaces are
  compiler-demanded and three are carried by existing tests (§2.7's enforcement
  split) — and it needs no new branch in `projectGitDeferralRepos`. Full
  reasoning and the surface list are in §2.7.
- **A prove-scoped `armed` flag as an instance field on the oracle — REJECTED
  (correction 6).** Smaller to write, and wrong: `serial()`
  (`apply-receipt.ts:405-412`) de-duplicates in-flight proofs per `rel` but does
  not serialize proofs of different repos, so one field would be shared across
  concurrent repo proofs. The sink is allocated in `project()` and rides the
  `Projected` struct instead — verified to be exactly one per prove (§2.4).

**r5 (resolving r4's blockers):**

- **The guard as a check on the first zero-pair alignment — REJECTED (B-r4-3).**
  The obvious site (`apply-receipt.ts:495`, `compareEntries` over
  expected×oracle) fires before the walk has spoken and would convert a repo
  that today reaches `mismatch`/`local-edits` via `:509` into a permanent
  `indeterminate`. The guard is a downgrade applied to a final `match` only,
  at `:541` and `:669`.
- **`conflictCopies` as a `StatusLocalCountsBase` member — REJECTED (B-r4-4).**
  `status-render.ts:151-162` emits the `local` block only when
  `counts.source === "daemon"`, so a `counts` member is silently absent on the
  computed branch. Top-level, per the 224 precedent's stated reason
  (`status-contract.ts:218-222`).
- **Scope-projecting `conflictCopies` (preference (a)) and copying the `deleted`
  divergence (preference (c)) — both DROPPED as unnecessary (B-r4-5).** Neither
  branch's local manifest is scope-projected today (§4), so there is no
  divergence to reconcile or to document; adding a projection would introduce
  one. Preference (b) is what the code already supports. This entry exists so a
  future reader does not re-derive the `deleted` hazard here: it belongs to a
  diff against a whole-workspace base, and this count takes no diff.

**Standing since r3:**

- **Root-scoping (§2.3) as the safety property — DEMOTED, not removed.** r3
  claimed it made "the vacuous-match shape unreachable". It removes the two
  ADDRESSING instances — a conflict-named ancestor AND the repo's own
  conflict-named root component (r7/B-r6-1: both are the caller's addressing,
  neither is content) — while the BELOW-root instance, conflict-named content
  inside the repo, survives it. Kept, and r5 restates why in stronger terms:
  with the guard shipping, dropping §2.3 makes every repo whose root or ancestor
  carries the grammar **permanently `indeterminate`** — an availability
  regression, not an addressing nicety (§2.3). The safety claim belongs to
  §2.4's guard; the availability claim is §2.3's own. Deletion condition
  unchanged: it goes when conflict copies stop being minted.
- **Literal substitution of `comparable()` at `scopedScan:718` — REJECTED
  (D1).** It reads as the smallest possible change and is a fail-closed →
  fail-open flip for grammar-matching special files. §2.5's restructure is the
  smallest change that is actually behavior-preserving on the `"other"` axis.
- **Exporting `comparable()` and pinning it directly — REJECTED (decision 6).**
  Every consumer lives in `apply-receipt.ts`; exporting it would add a public
  symbol whose only client would be a test. §7 pins it through the two oracles
  instead, which is also the only way to catch the `scopedScan`/`inventory`
  asymmetry D1 found.

**Mint relocation, the standing rejection:**

**Mint conflict copies into `.rbox/conflicts/<repo>/…` instead of as workspace
siblings.** It would end the wedge with no oracle change at all, so the
primitives rule requires recording why it loses.

Rejected: `.rbox` is unconditionally ignored — `src/engine/ignore.ts:350`
(`p === ".rbox" || p.startsWith(".rbox/") || …` ⇒ ignored) and
`ALWAYS_NATIVE_PRUNE` at `:155`; `hardExcluded` (`apply-receipt.ts:228`) drops
it too. Relocating the mint therefore **un-syncs the copy**: it stops
propagating to other devices and stops being recoverable anywhere but the host
that minted it. That is design 224's exact prohibition — silent un-syncing is
worse than over-syncing — applied to the one artifact whose entire purpose is
to survive. Rejected for the same reason: any variant that ignores the copies
in place (`*.conflict*` as an ignore rule) rather than narrowing the
comparison.

## 7. Validation — rescoped honestly (m9), plus the B1 pin

**Unit (the real gate).**

- §2.1's executed positive/negative fixture sets, including the three
  non-producer `~` tails and the "`ext` swallows the tail" case.
- Symmetric-drop twin of the disproven-title pin: a matching path drops from
  BOTH the manifest side and the walk side.
- Below-root (the fixture r6 labelled "ancestor"): a conflict-named directory
  **inside** a repo prunes its subtree. Kept exactly as written — it is the one
  position the predicate still tests, and the r7 correction narrows only what
  lies at or above the root.
- **B1 pin (blocking, restated in r5 correction 5, both arms now positive per
  B-r6-1):** a repo whose ROOT — and, separately, a repo whose ANCESTOR —
  matches the grammar, with a working tree diverged from the applied manifest,
  must return the POSITIVE verdict. Under the r7 predicate both arms are the
  same rule, and both are asserted: a regression to "at or below" leaves the
  ancestor arm green and fails only the root arm.
  **The assertion is made at the ORACLE layer and is
  `expect(verdict.kind).toBe("mismatch")`** — the diverged-tree verdict —
  on both `pullOracle(...).proveRepo(...)` and
  `oracleFromState({...}).proveRepo(...)`. It may additionally assert the
  `local-edits` reason downstream, but the oracle-layer `kind` is the pin.
  **`expectNotMatch` (`apply-receipt.test.ts:70`,
  `expect(verdict.kind).not.toBe("match")`) is explicitly barred here**, and so
  is any hand-rolled equivalent: with §2.4's guard shipping, deleting §2.3 makes
  both sides empty by the grammar, arms the guard, and yields `indeterminate` —
  which satisfies "not `match`" and would leave the pin green over a deleted
  §2.3. The red state this must fail from is therefore the availability one:
  without root scoping the repo is permanently `indeterminate`, and only an
  assertion that names `"mismatch"` positively can see the difference.
- **Empty-population guard, both fixtures (D2 — blocking):**
  1. a repo whose only content directory is conflict-named (so every comparable
     entry on both sides is excluded by the grammar, with the repo root itself
     NOT matching) returns `indeterminate` with the population-emptied reason,
     never `match`. Without §2.4's guard this returns `match` — the red state.
  2. a genuinely empty repo (`git init`, no files, empty applied manifest) still
     returns `match`. This is the discrimination the guard exists to keep; a
     guard written as "population is empty" turns this fixture red, which is
     precisely how the pair is worth having.
  3. **both downgrade sites, separately** (r5 correction 1): fixture 1 run
     through the pull oracle exercises `:541`'s manifest×manifest population;
     the same shape run through `oracleFromState({...})` takes `:493` straight
     to `scanAndCompareProjected` and exercises `:669`'s disk×manifest
     population. One fixture reaching only one site would leave the other
     minting vacuous matches.
  4. **the downgraded record carries no credential** (r5 correction 2): after a
     downgraded prove, `oracle.receiptHash(rel)` is `undefined`, and an
     immediately following `reproveRepo(rel)` re-enters `proveFresh` rather
     than re-affirming `MATCH` — assert it still returns `indeterminate` with
     the same why after a no-op boundary. Without the "compute the verdict
     before `records.set`" ordering, the stored `tokens` make the next boundary
     return `MATCH` and the hold silently evaporates.
- **The `conflict-copies` deferral reason (§2.7):**
  1. `classifyCheckout` over a guard-downgraded oracle adds `conflict-copies`,
     NOT `unreadable` (`follow-classify.ts:139`); and an oracle
     `indeterminate` with any other `why` still adds `unreadable` — the
     negative half, without which an over-broad match test passes.
  2. `gitReasonOf` (`doctor-cmd.ts:213`) over a detail containing
     "conflict-copies" returns `conflict-copies`, not `conflict`. This is the
     enum-ORDER dependency §2.7 names, and it is the one site no type checks.
  3. **the ORDER INVARIANT itself, not just this instance (C-r6-3):** over
     `GIT_DEFERRAL_REASONS`, for every pair `(a, b)` with `a !== b` and
     `a.includes(b)`, assert `indexOf(a) < indexOf(b)`. Today
     `("conflict-copies", "conflict")` is the only such pair; the test is worth
     having because the declaration order is documented as "an enumeration, not
     a ranking" (`sync-state-model.ts:145-147`) and nothing else stops the next
     superstring member from being appended after the member it shadows.
  4. the existing vocabulary tests carry the rest automatically —
     `status-view.test.ts:163-169` (non-empty label/text/repair) and
     `deferral-precedence.test.ts:11-19` (enum ≡ precedence ≡ rank).
     `telemetry/contract.test.ts:48`'s `toHaveLength(18)` becomes `19`; it is a
     deliberate tripwire, not an obstacle.
- **`"other"` arm (R1, D1), with BOTH belts (B-r4-2):**
  `apply-receipt.test.ts:393-400` stays green unchanged; a new sibling pins a
  conflict-grammar FIFO at `indeterminate`, not `match`, on **both** oracles —
  `pullOracle(...).proveRepo(...)` for the `inventory` path (which `:398`
  already exercises alone) and `oracleFromState({...}).proveRepo(...)` for the
  `scopedScan` path. The state-oracle half is the one that fails without §2.5's
  restructure. Two belts, because `indeterminate` alone is satisfiable by the
  wrong mechanism — under the rejected literal substitution the FIFO is silently
  skipped, and if it were the only comparable entry the guard would arm and
  return `indeterminate` anyway, passing a broken build:
  1. the fixture carries **≥ 1 surviving non-conflict comparable pair**, so the
     population is never empty and the guard cannot fire; AND
  2. the assertion names the **specific why** —
     `"unsupported entry type in repo subtree"` (`whyFromScanError`,
     `apply-receipt.ts:268`, over the `unsupported-entry` throw at `:622`/`:720`)
     — never the population-emptied reason.
- `comparable`'s seven call sites pinned **behaviorally, through the two
  oracles** (it is module-private, §0), so a future edit cannot reintroduce an
  eighth hand-copy or resurrect the two walks' shape difference.
- Note: the `type-flip` rig's conflict assertions use a LOOSE glob
  (`'${FLIP}.*conflict*'` at `scripts/rig/scenarios/type-flip.ts:32`,
  `/\.conflict/` at `:86`). Those are convergence assertions, deliberately
  loose, and are NOT the grammar gate.

**Rig — NEW work, not a fork of an existing fixture.** Two pieces that do not
exist today:

1. *Receiver-side in-repo conflict fixture.* No current scenario mints a
   conflict copy INSIDE a git repo subtree on the receiver and then asserts the
   repo does not enter "working tree differs" across N quiescent cycles.
2. *Pull-only plumbing.* Verified absent: `startDaemons`
   (`scripts/rig/scenarios/preamble.ts:233-253`) calls `Device.daemonStart`
   (`scripts/rig/lib/device.ts:237-239`), which hard-codes
   `this.rbox(["start"])`. `rbox start --pull-only` exists
   (`src/cli/help-registry.ts:230-233`) but the rig cannot request it. An argv
   passthrough plus a pull-only preamble arm is in scope here and is the only
   way to exercise the FM shape in CI. That arm carries §4's non-negotiable:
   with a pull-only daemon live and never having pushed, `rbox status` must
   still report `conflictCopies` — the assertion that the count did not
   inherit `strandedIgnored`'s push-lane dependency.

**Field — sequenced, not opportunistic.** No wave on a live fleet host. After
the fleet drains, mint a deliberate wave in a **dedicated scratch workspace**
only; record `conflictCopies` and `deferredRepos` before and after on
that workspace, and confirm the 609/day "working tree differs" lines stop.
Fleet close-out is observational: FM soaks clean, `deferredRepos` returns to
the known parked set. Both push and pull lanes measured per the perf rule.

## 8. Expected effect — corrected (M7)

r1 §5 claimed "fleet git-pull waves stop wedging receivers", conflating two
things. Precisely:

- **Wedging stops.** A conflict copy can no longer hold the repo whose
  publication would settle it. FM's 103-repo class becomes unmintable;
  pull-only hosts stop accumulating permanent extras. #659 closes.
- **Minting is UNCHANGED.** This design touches no producer. Copies mint at
  exactly today's rate from `src/engine/reconcile.ts:70` — the three-way
  divergence arm (`sameContent(l, r)` at `:58` already suppresses the
  identical-content case, so every mint reflects genuine `l ≠ r ≠ base`
  divergence, amplified by the publish/retry churn 244 documents).

That mint rate is **not accepted silently**: it is booked as a named follow-up
slice under design 244 (echo-publish ring + conflict-retry starvation, issue
#683), whose §Problem already owns the churn driving these waves. Owner: the
244 workstream. Acceptance: fleet mint rate measured before/after 244's
landing, with `conflictCopies` (§4) as the meter. This design fixes the
*consequence* first because the consequence is the 20-hour outage; it does not
claim the cause is fixed.

Residual after this lands: the Mac's deferral list shrinks to the
supersession/#702 set (tracked there).
