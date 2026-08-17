# 272 — rbox-minted conflict copies must not gate the git-plane oracle

Status: **DRAFT r3** (folds the r2 confirm: blocker B1, corrections R1–R5,
minors m1–m3; r1's C1/C2/M3–M7/m8–m10 held).
Every file:line below re-verified against `main` @ `b9bb83d5d` on 2026-08-16.

Evidence: GH #659 (re-scoped 2026-08-16) — FM wedged 103 repos for 20+ hours
on 944 of rbox's OWN `.conflict.*` copies. Recon proved the oracle already
symmetric on ignores (the r1 title's premise was disproven) and located the
true hole. Parents: design 224 (ignore-plane ruling: silent un-syncing is
worse than over-syncing), 236 (litter classes get reclassified at the gate,
not instrumented), 244 (echo-publish + conflict-retry containment).

## 0. Concept ledger (m2)

**Two exported symbols**, one new concept ("rbox conflict artifact"):

| Symbol | Home | Deletion condition |
|---|---|---|
| `isRboxConflictArtifact(component: string): boolean` — the name grammar, on ONE path component | `src/engine/conflict-name.ts` (new; sits with `conflictName`'s grammar, re-exported from `reconcile.ts`) | conflict copies stop being minted into the workspace |
| `comparable(rel, kind, root, eq): boolean` — the oracle's single "is this path compared at all?" answer | `src/engine/apply-receipt.ts` | never: it *replaces* five hand-copied expressions |

**All four spends of `isRboxConflictArtifact`** — and nowhere else:

1. inside `comparable()` (§2.4), the only oracle-side consumer;
2. `counts.conflictCopies` in `rbox status` (§4), over `localManifest.files`;
3. the papercut-documented recovery recipe (§4) — user-facing, no code;
4. its own unit fixtures (§7).

Net expression count goes **down**: five hand-copied exclusion expressions in
`apply-receipt.ts` collapse to five `comparable()` calls, and the sixth
possible drift site (the `"other"` arm, §2.5) is decided explicitly rather
than left implicit.

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

### 2.3 Ancestor matching, SCOPED to the projection root (B1 — blocker)

r2 identified an inversion in r1's unscoped ancestor rule, confirmed here.

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
`discoverGitRepos` (`src/engine/git-discover.ts:28-60`) descends every
non-ignored directory: conflict-named directories are not ignored, so a repo
underneath one IS discovered and IS proved.

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
is one excluded object, not N extras) while making the vacuous-match shape
unreachable.

**Pin (§7): a repo whose root or ancestor matches the grammar must NOT return
`match` when its working tree diverges.**

### 2.4 ONE predicate, five sites (M5, m3)

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
`"other"` arms (`:622`, `:720`) deliberately do NOT call it; §2.5 says why.

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

### 2.5 The `"other"` arm stays fail-closed (R1)

`apply-receipt.ts:622` and `:720` today throw `unsupported-entry` for a
special file (FIFO, socket, device) unless the matcher ignores it; the throw
becomes `indeterminate` via `whyFromScanError`. `apply-receipt.test.ts:393-400`
pins exactly the ignored case ("ignored special entries are removed
symmetrically", `mkfifo` ⇒ `match`).

**Decision: do NOT route the `"other"` arm through `comparable()`.** Doing so
would turn a conflict-grammar FIFO from a fail-closed `indeterminate` into a
silent symmetric skip — a fail-closed → fail-open flip, on the exact axis B1
just showed is the dangerous direction. `conflictName` never produces a
special file (`moveAside` renames whatever was there, and only a user could
`mkfifo` a grammar-matching name), so the case is adversarial-only.

Consequence, stated: a grammar-matching special file yields
`indeterminate`/`unreadable` for its repo, not `local-edits` and not `match`.
`apply-receipt.test.ts:393` is **unchanged and must stay green** — it exercises
the *matcher*-ignored path, which this design does not touch. A new sibling
pins the conflict-grammar FIFO at `indeterminate`.

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
4. **The durable `oracleReceipt` hash.** `resolution-intent.ts:115` stores
   `oracle.receiptHash(rel)` into the resolution binding
   (`sync-state-model.ts:270`), and `resolve-command.ts:1046-1051` recomputes
   that binding at confirm time and compares it by `JSON.stringify` equality,
   setting `boundaryMismatch` when it differs. For a repo containing conflict
   copies the receipt hashes a different entry population before and after this
   change — so *client skew across the upgrade fails closed*: a `--show`
   snapshot taken by one version and confirmed by the other refuses and asks
   for a fresh `--show`, rather than applying a stale intent.
5. **Repo-scope addressing (B1).** A repo at or under a conflict-named
   component compares exactly as today — §2.3's scoping is what buys that.

## 4. Visibility and deletion ownership (M6, R3, R4)

A silent exclusion is how litter becomes permanent, so a surface is IN scope.

**`counts.conflictCopies`** joins `StatusLocalCountsBase`
(`src/cli/status-contract.ts:121-131`) beside the existing `conflictSnapshots:
{ total, prunable }` — which is the *git ref* namespace
(`src/cli/sync-git/conflict-retention.ts`, `refs/rbox-conflict/`, 90-day
prune). Different objects, adjacent surface; the rendering must not blur them
(`status-render.ts:270-271` prints "conflict snapshots"; the new line reads
"conflict copies").

Source: the local manifest the projection already holds —
`localManifest.files.filter(…)` (`status-projection.ts:371` computes
`trackedFiles` from exactly that array). Zero new scan, and the **same
predicate** as the oracle exclusion, so the count can never disagree with what
was excluded.

**Daemon branch, exactly on the `strandedIgnored` precedent (R3)** — design
224 §2.3 solved this identical problem and its shape is copied verbatim:

- `activity.ts:76-78`: `conflictCopies?: number` declared **optional**, with
  `sourceVersion` staying **`1`** (an older daemon simply omits the field; the
  version is not a feature flag).
- `activity.ts:152`: guard clause extended to
  `(local.conflictCopies === undefined || uint(local.conflictCopies))`.
- `activity.ts:166`: conditional copy —
  `if (local.conflictCopies !== undefined) decoded.conflictCopies = …`.
- `status-projection.ts:302` reads it from `trusted.local` on the daemon
  branch; `:361` from the freshly projected value; `:455`'s pattern
  (`if (x !== undefined) detail.x = x`) carries it.
- **When a v1 daemon omits it**, the value is `undefined` and the renderer
  prints **nothing** — exactly `strandedIgnoredLine`'s contract
  (`status-view.ts:927-933`: `if (!count || count <= 0) return undefined`).
  Absent and zero render identically; the line is only worth printing when
  there is something to act on. No "unknown" state is invented.

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
| `f` / `f` | 6 | regular files: two `.env` copies, three `163-…conflict.md` design-doc copies under `.claude/worktrees`, one `settings.local…conflict.json` |
| `l` / `d` | 8 | **symlinks whose targets are directories** — all eight are `node_modules.dev_<32hex>.<ts>.conflict` under `Dfinitiv/savvy-core/.claude/worktrees/*` |

Two distinct `dev_<32 hex>` tokens; **zero** `local`/`trash` tokens; **zero**
`~N` tails; **zero** user-authored files; and **zero true directories**
(`find -type d` over the same grammar returns nothing).

**Conclusion A — benefit.** 14 rbox mints, 12 of them inside git-repo
subtrees, each one an extra that holds its repo `local-edits` today. That is
the wedge, measured.

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
motivation), and B1's vacuous-match *is* the same scale in the wrong direction
(that is §2.3's scoping). Neither has been observed in the field yet. The
measured benefit today is 12 subtree extras removed; the measured
false-positive cost today is zero.

## 6. Alternative recorded and REJECTED (m10)

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
- **B1 pin (new, blocking):** a repo whose ROOT — and, separately, a repo whose
  ANCESTOR — matches the grammar must NOT return `match` when its working tree
  diverges from the applied manifest. Without §2.3's root scoping this test
  returns `match`; that is the red state it must fail from.
- **`"other"` arm (R1):** `apply-receipt.test.ts:393-400` stays green
  unchanged; a new sibling pins a conflict-grammar FIFO at `indeterminate`,
  not `match`.
- `comparable`'s seven call sites pinned so a future edit cannot reintroduce an
  eighth hand-copy.
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
   way to exercise the FM shape in CI.

**Field — sequenced, not opportunistic.** No wave on a live fleet host. After
the fleet drains, mint a deliberate wave in a **dedicated scratch workspace**
only; record `counts.conflictCopies` and `deferredRepos` before and after on
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
landing, with `counts.conflictCopies` (§4) as the meter. This design fixes the
*consequence* first because the consequence is the 20-hour outage; it does not
claim the cause is fixed.

Residual after this lands: the Mac's deferral list shrinks to the
supersession/#702 set (tracked there).
