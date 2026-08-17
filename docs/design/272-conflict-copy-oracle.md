# 272 — rbox-minted conflict copies must not gate the git-plane oracle

Status: **DRAFT r5** (folds the r4 delta-confirm: blockers B-r4-1 — the B1 pin
asserts a positive verdict — B-r4-2 — the FIFO fixture gets both belts — B-r4-3
— the guard is a downgrade of a FINAL `match`, not a first-alignment veto —
B-r4-4 — `conflictCopies` is top-level, not a `counts` field — and B-r4-5 — one
named population on both status branches; plus corrections 1–5 and the three
nits. r3's D1/D2, r2's B1/R1–R5/m1–m3 and r1's C1/C2/M3–M7/m8–m10 held).
Every file:line below re-verified against `main` on 2026-08-16.

Evidence: GH #659 (re-scoped 2026-08-16) — FM wedged 103 repos for 20+ hours
on 944 of rbox's OWN `.conflict.*` copies. Recon proved the oracle already
symmetric on ignores (the r1 title's premise was disproven) and located the
true hole. Parents: design 224 (ignore-plane ruling: silent un-syncing is
worse than over-syncing), 236 (litter classes get reclassified at the gate,
not instrumented), 244 (echo-publish + conflict-retry containment).

## 0. Concept ledger (m2, corrected in r4)

**ONE exported symbol**, one new concept ("rbox conflict artifact"):

| Symbol | Home | Deletion condition |
|---|---|---|
| `isRboxConflictArtifact(component: string): boolean` — the name grammar, on ONE path component | `src/engine/conflict-name.ts` (new; sits with `conflictName`'s grammar, re-exported from `reconcile.ts`) | conflict copies stop being minted into the workspace |

Two **module-private** mechanisms inside `src/engine/apply-receipt.ts`, neither
exported and neither pinned by a direct call in a test:

| Mechanism | Why it exists | Deletion condition |
|---|---|---|
| `comparable(rel, kind, root, eq): boolean` — the oracle's single "is this path compared at all?" answer | *replaces* five hand-copied exclusion expressions | never, while the oracle has two sides |
| the per-prove **empty-population guard** (§2.4) — one boolean recording that the conflict grammar emptied a comparison population | a zero-pair alignment is otherwise a vacuous `match` (D2) | the grammar stops being an exclusion reason |

`comparable` is deliberately NOT exported: every consumer is inside
`apply-receipt.ts`, and §7 pins it behaviorally through the two oracles rather
than by calling it. Same for the guard boolean.

**All four spends of `isRboxConflictArtifact`** — and nowhere else:

1. inside `comparable()` (§2.5), the only oracle-side consumer;
2. `conflictCopies` in `rbox status` (§4), over the local manifest;
3. the papercut-documented recovery recipe (§4) — user-facing, no code;
4. its own unit fixtures (§7).

Net expression count goes **down**: five hand-copied exclusion expressions in
`apply-receipt.ts` collapse to **seven `comparable()` call sites** (five table
rows in §2.5; two of those rows carry a dir arm and a leaf arm), and the eighth
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

**It is reachable, not theoretical.** Two producers create conflict-named
DIRECTORY names: `apply.ts:296-307` (trash disabled ⇒ a squatting directory is
`moveAside`d whole under a conflict name) and `trash.ts:250-252` (restore onto
an occupied target diverts to `conflictName`, and the restored entry may be a
directory — `claimUnclobberedName` takes `st.isDirectory()` explicitly). And
`discoverGitRepos` descends every non-ignored directory — `walkDir`
(`src/engine/git-discover.ts:46`), descent loop `:58-62`, pruned only by
`prunesForGitDiscovery`/`ignores` at `:61` — so conflict-named directories are
not ignored, a repo underneath one IS discovered and IS proved.

**Adopted fix — option 1.** `comparable()` takes the normalized projection
root and tests only components **at or below** it:

```ts
/** Components strictly above `root` are the caller's addressing, not content:
 *  a repo that merely LIVES under a conflict-named directory must compare
 *  exactly as it does today. */
comparable(rel: string, kind: ComparableKind, root: string, eq: ReceiverEquivalence): boolean
```

For `root = "."` this is every component, as before. For `root = "a.dev_x.
<ts>.conflict/repo"` the ancestor `a.dev_x.<ts>.conflict` is skipped and the
repo compares normally; a conflict-named directory *inside* that repo still
prunes its subtree. This keeps §2.3's whole point (a conflict-named directory
is one excluded object, not N extras) and removes the ANCESTOR instance of the
vacuous match — a repo is no longer misclassified by a name that belongs to its
caller's addressing rather than to its content.

**No threading is required for `root`.** `project()` is the only caller of
`normalizeRel` and always runs before either walk, so every call site already
holds the normalized root and can pass it unchanged. Recorded here because the
signature's cheapness depends on that ordering: a future caller that walks
without projecting first would have to normalize itself.

**Claim, narrowed (r4).** Root-scoping is **correct addressing**, not the
safety property. A repo whose entire comparable population sits under a single
conflict-named directory **at or below its own root** still lands on the same
empty-both-sides chain — same `apply.ts:307` whole-directory eviction, applied
to the repo's one content directory. §2.4 is what makes that class safe.

**But addressing here IS availability (r5).** With §2.4's guard shipping,
dropping §2.3 does not merely mis-address such a repo: every repo living under
a conflict-named ancestor has both populations emptied BY THE GRAMMAR, arms the
guard, and becomes **permanently `indeterminate`** — the FM wedge in a different
color, reached by a different door. That is an availability property, not an
addressing nicety, and it is why §2.3 stays required even though §2.4 owns
safety.

**Pin (§7): a repo whose root or ancestor matches the grammar, with a working
tree diverged from the applied manifest, must return the POSITIVE verdict
(`mismatch`/`local-edits`) — not `match`, and not `indeterminate`.** Asserting
only "not `match`" would stay green with §2.3 deleted, because the guard's
`indeterminate` also satisfies it (B-r4-1).

### 2.4 The empty-population guard (D2) — a zero-pair prove is not a match

The deeper primitive behind B1: **a prove that compared zero entries because
the conflict grammar removed them is `indeterminate`, not `match`.** Root
scoping (§2.3) removes one instance; this removes the class — ancestor, self,
and at-or-below alike.

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

**Recorded dependency: the manifest side is projection-scoped BEFORE the
grammar arm can fire (correction 1).** `project()`'s filter
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
| `match` | zero | **set** | `indeterminate("repo population emptied by conflict-copy exclusion")` |
| `match` | zero | unset | `match` — exactly today's behavior, unchanged |
| `match` | ≥ one | either | `match`, unchanged |
| anything else | either | either | unchanged |

**Its two sites, named.** Every `match` a fresh prove can return exits through
one of exactly two `records.set` calls: `apply-receipt.ts:541` (the tail of
`proveFresh`) and `:669` (the tail of `scanAndCompareProjected`). `settle()`
(`:413-415`) is not a third site — it records a verdict with no `receiptHash`
and no `tokens`, and every one of its call sites passes an `indeterminate`. The
cached path needs no site either: `reproveRepo` re-affirms `MATCH` at `:388`
only when `prior.verdict.kind === "match"` (`:383`), and a downgraded prove
stores `indeterminate`, so it re-enters `proveFresh`.

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

**Cost, stated — including the one it re-defers (correction 4).** One boolean,
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

### 2.5 ONE predicate, five sites / seven calls (M5, m3, D1)

Today the same exclusion logic is hand-copied five times in
`src/engine/apply-receipt.ts` — re-verified:

| Line | Shape today | `kind` at the call |
|---|---|---|
| `:469` | manifest filter: `inProjection && !hardExcluded && !matcher.ignores` | `"leaf"` |
| `:616` | cached walk, child: `hardExcluded ⇒ continue`; dir ⇒ `prunes(dirForm) ?? ignores`; leaf ⇒ `!ignores` | `"dir"` / `"leaf"` |
| `:636` | cached walk, scope is a leaf | `"leaf"` |
| `:713` | fresh walk, child (same shape as `:616`) | `"dir"` / `"leaf"` |
| `:736` | fresh walk, scope is a leaf | `"leaf"` |

Five hand-copies are five chances for the two sides to drift — that drift IS
the bug class this design fixes. `comparable` =
`!hardExcluded(rel, eq)` and `!matchesConflictGrammarAtOrBelow(rel, root)`
and the matcher arm the `kind` already selects (`ignores(rel)` for `"leaf"`,
`prunes(rel + "/") ?? ignores(rel + "/")` for `"dir"`). `kind` is not a new
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
shape. The snippet below **replaces `:718-722` only**; `scopedScan`'s directory
arm (`:714-717`, `child.isDirectory()` ⇒ prune-or-recurse) stays exactly where
it is, above this `else`. Read without that scoping the snippet would route
every directory into the `"other"` throw, since this `type` computation — unlike
`inventory`'s at `:610-611` — has no `"dir"` value:

```ts
// ... :714-717 (child.isDirectory() arm) unchanged, then:
} else {
  const type: DirCacheChild["type"] = child.isSymbolicLink() ? "symlink" : child.isFile() ? "file" : "other";
  if (type === "other") { if (!this.matcher.ignores(childRel)) throw new Error("unsupported-entry"); }
  else if (comparable(childRel, "leaf", root, eq)) await scanLeaf(childRel, type);
}
```

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
  `indeterminate` is a fail-closed verdict, not #659's wedge class.
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

## 4. Visibility and deletion ownership (M6, R3, R4)

A silent exclusion is how litter becomes permanent, so a surface is IN scope.

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
(`daemon.ts:2407-2421`) writes `activity.local` on every activity write with no
pull-only condition, and `localSnapshot` (`daemon.ts:2259-2275`) derives it from
`this.local.manifest`. So on a live FM the computed branch is not reached, and
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
case-fold collisions (`:56-83`). The scope projection is applied to the base
only — `scopedBaseManifest = statusScope.projectFiles(state.lastSyncedManifest)`
at `status-projection.ts:288-291` — and the daemon holds no scope projection
whatsoever (`scopeProjectionFor` has exactly two callers, `status-projection.ts:288`
and `workspace-observation.ts:83`). So neither branch's LOCAL manifest is
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
population. Noted and deliberately not propagated: `trackedFiles` already
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
perf-differential rule (correction 5).** The daemon-branch count adds an
O(files) pass (path-component split plus one regex per component) to
`localSnapshot`, which `enqueueActivityWrite`
(`src/cli/daemon/daemon.ts:2407-2421`, calling `localSnapshot` at `:2419`) runs
on **every** activity write. It rides a function that is already O(files) on
that path — `diffManifests(base.lastSyncedManifest, this.local.manifest)` at
`:2262`, plus the `files.length` and `files.reduce` walks at `:2267`/`:2299` —
so this is a constant-factor increase on an existing per-write linear pass, not
a new order of growth. The computed branch's pass rides the status scan it
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

## 6. Alternatives recorded, REJECTED or DEMOTED (m10, r4, r5)

Three r5 ledger entries first, then r4's three, then the standing rejection:

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

- **Root-scoping (§2.3) as the safety property — DEMOTED, not removed.** r3
  claimed it made "the vacuous-match shape unreachable". It removes the ancestor
  instance only; the at-or-below instance survives it. Kept, and r5 restates why
  in stronger terms: with the guard shipping, dropping §2.3 makes every repo
  under a conflict-named ancestor **permanently `indeterminate`** — an
  availability regression, not an addressing nicety (§2.3). The safety claim
  belongs to §2.4's guard; the availability claim is §2.3's own. Deletion
  condition unchanged: it goes when conflict copies stop being minted.
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
- Ancestor: a conflict-named directory **inside** a repo prunes its subtree.
- **B1 pin (blocking, restated in r5):** a repo whose ROOT — and, separately, a
  repo whose ANCESTOR — matches the grammar, with a working tree diverged from
  the applied manifest, must return the POSITIVE verdict
  (`mismatch`/`local-edits`). Asserting "not `match`" is insufficient: with
  §2.4's guard shipping, deleting §2.3 makes both sides empty by the grammar,
  arms the guard, and yields `indeterminate` — which satisfies "not `match`" and
  leaves the pin green over a deleted §2.3. The red state this must fail from is
  therefore the availability one: without root scoping the repo is permanently
  `indeterminate`.
- **Empty-population guard, both fixtures (D2 — blocking):**
  1. a repo whose only content directory is conflict-named (so every comparable
     entry on both sides is excluded by the grammar, with the repo root itself
     NOT matching) returns `indeterminate` with the population-emptied reason,
     never `match`. Without §2.4's guard this returns `match` — the red state.
  2. a genuinely empty repo (`git init`, no files, empty applied manifest) still
     returns `match`. This is the discrimination the guard exists to keep; a
     guard written as "population is empty" turns this fixture red, which is
     precisely how the pair is worth having.
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
