# Implementation spec — design 272 r9 (rbox conflict copies must not gate the git oracle)

Authority: `docs/design/272-conflict-copy-oracle.md` (ALIGNED r9, commit
`83a8f821c`) — the contract. §6 records the rejected shapes; §7 carries the
validation. Work order only; where this file and the design disagree, the
design wins EXCEPT on the anchor corrections marked **[drift]** below, which
were re-verified against the tree on 2026-08-16.

Branch: `ignored-tracked` (worktree `.claude/worktrees/ignored-tracked`).
Evidence: GH #659. Parents: designs 224, 236, 244.

---

## 0. FIRST STEP — rebase, before writing any code

PR **#760** (design 271, branch `p-settlement-fix`, head `0333c3611`) is still
**OPEN**. Do not start until it merges; then:

```
git -C <primary> fetch origin
git rebase origin/main         # from the ignored-tracked worktree
rm -rf .cache/tsbuildinfo       # stale tsbuildinfo lies after scripted edits
```

**Anchor shift the rebase causes** (measured against `0333c3611`) — re-derive
every anchor in §1 after rebasing rather than trusting the numbers here:

| File | 271's hunks | Effect on 272's anchors |
|---|---|---|
| `sync-state-model.ts` | `+3` at `:177` (`GitDeferral.detail`) | `:130-134`, `:149-153`, `:156-158`, `:165-167` **unchanged** |
| `status-view.ts` | `:339`, `:361 (+2)`, `:416`, `:431 (+3)`, `:472 (+2)`, `:476`, `:535 (+11)` | `:282-320` (presentation table, `isKnownGitDeferralReason`) **unchanged**; `:400-412` → `+2`; `:439-457` → `+2`; `:927-933` → `+~13` |
| `status-projection.ts` | `+1` at `:339` | `:288-291`, `:302` unchanged; `:352-361`, `:455` → `+1` |
| `status-render.ts` | `+1` at `:291`, `+1` at `:387` | `:148-162`, `:270-271` unchanged; `:318`, `:369` → `+1` |

**Conflicts to expect and how to resolve them.** 271 adds `GitDeferral.detail`
plus its carriers in `sync-git/status.ts`, `status-projection.ts`,
`status-view.ts` and a reason-adjacent refusal table. 272's enum member and copy
additions **slot alongside** them — they are additive on different lines:

- 272 adds a member to `GIT_DEFERRAL_REASONS`; 271 adds a field to
  `GitDeferral`. Take both.
- 272 adds a row to `DEFERRAL_REASON_PRESENTATION`; 271 changes the *renderer*
  below it. Take both.
- 272's `details.push(oracle.why)` at `follow-classify.ts:139` is **unchanged**
  by this design — only the `reasons.add(...)` argument changes. 271's detail
  work is therefore unaffected; do not rewrite it.

**Size ratchet — measured on today's tree** (`src/cli/state-plane/file-size.test.ts`,
`RATCHET_SLACK = 1.1`). The founder rule is **no re-pins**: a trip demands the
decomposition, never an edited ceiling.

| File 272 edits | now | ceiling ×1.1 | headroom |
|---|---|---|---|
| `src/engine/apply-receipt.ts` | 728 nb / 31629 B | 757 nb / 33018 B | **29 nb / 1389 B — the tight one** |
| `src/cli/status-render.ts` (**not allowlisted**) | 391 nb / 20231 B | hard 400 nb / 25 KiB | **9 nb** (≈7 after 271) |
| `src/cli/status-projection.ts` | 438 nb / 19409 B | 466 nb / 20562 B | 28 nb / 1153 B |
| `src/cli/status-view.ts` | 886 nb / 47902 B | 962 nb / 51804 B | 76 nb / 3902 B |
| `src/cli/activity.ts` | 458 nb / 21767 B | 492 nb / 23479 B | 34 nb / 1712 B |
| `src/cli/daemon/daemon.ts` | 2948 nb / 146618 B | 3545 nb / 174697 B | ample |

`sync-state-model.ts`, `telemetry/contract.ts`, `git/resolve-presentation.ts`,
`sync-git/follow-classify.ts`, `status-contract.ts`, `engine/reconcile.ts` are
not allowlisted and sit far under 400 nb / 25 KiB.

**[drift]** `src/cli/git/resolve-command.ts` post-#760 is **59105 B against a
59115 B ceiling — 10 bytes of headroom**, not the ~419 the brief carried. Any
edit trips it. 272 must not touch that file at all (see §4); §2.7's residual is
the reason it does not need to.

---

## 1. Deliverables

### D1 — `isRboxConflictArtifact`, the name grammar (design §2.1, §2.2)

New module **`src/engine/conflict-name.ts`**, sitting with `conflictName`'s
grammar (`src/engine/reconcile.ts:80-85`) and re-exported from `reconcile.ts`.
One export:

```ts
export function isRboxConflictArtifact(component: string): boolean
```

Applied to a SINGLE path component. The regex, verbatim from §2.1 (17/17
fixtures were executed against it, not eyeballed):

```
^(?<stem>.+)\.(?<token>[^./]+)\.(?<ts>[0-9]{14})\.conflict(?<ext>\.[^./]*)?(?<dup>~(?:[2-9]|[1-9][0-9]+))?$
```

Decisions baked into it, each with its reason, none negotiable:

- **`token` is loose (`[^./]+`), deliberately** (§2.2). Four producers write
  that position: `apply.ts:90` (`local`), `trash.ts:252` (`trash`),
  `init-plan.ts:123` (`dev_<8 hex>`), `init-plan.ts:126-130` (`dev_<32 hex>` —
  all 14 §5 census mints). A strict `dev_[0-9a-f]+` would silently miss the
  `local`/`trash` mints, which is the failure this design exists to end. It is
  a stated **namespace claim** over user filenames, not an unforgeable test.
- **`~N` fires only on extension-less names.** `claimUnclobberedName`
  (`src/engine/fsutil.ts:253-268`, loop starts `i = 2` at `:261`) appends `~2`,
  `~3`… to the WHOLE relative name, so the producer emits `~2`…`~9`, `~10`… and
  **never** `~`, `~0`, `~1`, or a leading-zero form. On an extension-bearing
  name `ext`'s `[^./]*` legitimately swallows the tail (`…conflict.md~3` parses
  as `ext = ".md~3"`); both parses give the same verdict.
- **`ext` must NOT be narrowed to `[^./~]`.** `conflictName` on a real emacs
  backup `foo.ts~` produces `foo.dev_x.<ts>.conflict.ts~`; excluding `~` would
  reject a genuine mint.
- **`stem` is greedy and may contain dots** (`settings.local` is a real field
  stem), so `token` is "the last dot-free run before the timestamp", never "the
  second field".

All 17 fixtures ship as the unit test (§2 below). All four spends of this
predicate, and nowhere else: `matchesConflictGrammarBelow` (D2), `rbox status`'s
`conflictCopies` (D5), the papercut recipe (no code), its own fixtures.

### D2 — `comparableFor(root, eq, armed)` and `matchesConflictGrammarBelow` (§2.3, §2.5)

Both **module-private inside `src/engine/apply-receipt.ts`**. Neither is
exported; §6 records why exporting `comparable` was rejected.

```ts
comparableFor(root: string, eq: ReceiverEquivalence, armed: { hit: boolean }):
  (rel: string, kind: ComparableKind) => boolean
```

The bound closure is `comparable(rel, kind)` — **two arguments**. It answers
"is this path compared at all?" as the conjunction of:

1. `!hardExcluded(rel, eq)` (`:227-231`);
2. `!matchesConflictGrammarBelow(rel, root)` — true iff some component of `rel`
   **strictly below** `root` satisfies `isRboxConflictArtifact`;
3. the matcher arm the `kind` selects: `"leaf"` ⇒ `!this.matcher.ignores(rel)`,
   `"dir"` ⇒ `!(this.matcher.prunes?.(rel + "/") ?? this.matcher.ignores(rel + "/"))`.
   **The `?.` is load-bearing**: `prunes` is optional on `IgnoreMatcher`
   (`src/engine/ignore.ts:302`) and a non-optional call throws where the code
   falls back today. `dirForm` construction moves INSIDE `comparable` and must
   never appear at a call site again.

**Strictly below `root`, not at-or-below** (B-r6-1). `proveRepo(rel)` addresses
the repo BY that path, so neither an ancestor's name component nor the repo's
OWN name component is evidence about the repo's contents. For `root = "."` this
is every component of every `rel` (the workspace root is not a component). Carry
the ≤4-line constraint comment from §2.3 verbatim — it is the
inexpressible-constraint case.

**`root` is bound once, in `project()`** (`:460-479`): it is the only caller of
`normalizeRel` (`:463`) and always runs before either walk. Build the closure
immediately after `:463` and before the filter at `:468-469`.

**The seven call sites replacing five hand-copied expressions** (five rows,
seven calls — different counts, both owned by §2.5):

| Anchor today | Shape today | New call |
|---|---|---|
| `:469` | manifest filter in `project()` | `comparable(entry.path, "leaf")` |
| `:619` | `inventory` child, dir arm | `comparable(childRel, "dir")` |
| `:623` | `inventory` child, leaf arm | `comparable(childRel, "leaf")` |
| `:636` | `inventory` scope-is-a-leaf | `comparable(rel, "leaf")` |
| `:716` | `scopedScan` child, dir arm | `comparable(childRel, "dir")` |
| `:718→` | `scopedScan` child, leaf arm | `comparable(childRel, "leaf")` |
| `:736` | `scopedScan` scope-is-a-leaf | `comparable(rel, "leaf")` |

**`inventory` (`:614-625`) converts by literal substitution** — its `"other"`
arm is already a SIBLING at `:621-622`, so `:622` is genuinely untouched.

**`scopedScan` (`:711-722`) requires a RESTRUCTURE, not a substitution (D1 —
blocker).** It NESTS its `"other"` throw inside the leaf guard: `:718` is the
guard, `:719` computes the type, `:720` throws. Substituting `comparable()` at
`:718` makes a conflict-grammar FIFO fail the guard and be **silently skipped** —
`:720` never runs — a fail-closed → fail-open flip. Hoist the type computation
above the guard so the child loop takes `inventory`'s shape. Replace `:714-722`
with exactly §2.5's snippet:

```ts
if (child.isDirectory()) {
  if (!comparable(childRel, "dir")) continue;   // was: prunes?.(dirForm) ?? ignores(dirForm)
  await walk(childRel);
} else {
  const type: DirCacheChild["type"] = child.isSymbolicLink() ? "symlink" : child.isFile() ? "file" : "other";
  if (type === "other") { if (!this.matcher.ignores(childRel)) throw new Error("unsupported-entry"); }
  else if (comparable(childRel, "leaf")) await scanLeaf(childRel, type);
}
```

Note this `type` has no `"dir"` value — which is exactly why the directory
decision must be made before it.

**The `"other"` arm stays fail-closed on BOTH walks (§2.6).** Neither `:622` nor
`:720` routes through `comparable()`. Each keeps its own `!ignores` test, which
is why `apply-receipt.test.ts:393-400` stays green unchanged. "Does not call
`comparable()`" is a claim about ROUTING: `:720` satisfies it only after the
restructure lifts it out from under `:718`.

**Out of scope, behavior stated, do not touch**: `scanDeferred` (`:465-467`,
returns `indeterminate("scan deferred in repo subtree")` before the filter —
correctly stays `unreadable`, not `conflict-copies`) and `touchedKeys` (`:477`,
`inProjection`-only, a membership set consulted at `:524`, never a comparison
population).

### D3 — the empty-population guard (§2.4)

**The rule: a prove that compared zero entries BECAUSE the conflict grammar
removed them is `indeterminate`, not `match`.** Never "the population is empty" —
that distinction IS the mechanism.

- **Sink allocation:** `const armed = { hit: false }` in `project()` (`:460`),
  immediately after `normalizeRel` at `:463`; it and the bound `comparable`
  ride the returned `Projected` struct alongside `expected`/`oracle`/`preScan`/
  `touchedKeys` (`:473-478`). `inventory` (called `:500`) and `scopedScan`
  (called `:659`) take the closure as a parameter — both call sites already hold
  `projected`, so nothing new is plumbed through the class.
- **Set exactly when `comparable()` returns false because of the GRAMMAR arm** —
  not `hardExcluded`, not the matcher — during THIS walk of THIS prove. Both
  walks and `project()`'s filter feed the same sink, preserving §3's symmetry
  contract.
- **Verified one `project()` per prove:** `proveFresh` projects at `:489` and
  hands the same struct to `scanAndCompareProjected` at `:493`/`:510`/`:530`;
  `scanAndCompare` (`:650-656`, reached from `reproveRepo`'s token-mismatch path
  at `:386`) projects at `:651` and hands it on at `:655`.
- **Evaluation-order dependency, preserve it:** `project()`'s filter at
  `:468-469` walks the ENTIRE prepared manifest. It survives only because the
  conjunction short-circuits — `inProjection(entry.path, normalized, eq)` is
  tested FIRST, so out-of-projection entries never reach the grammar arm. Keep
  `inProjection` leftmost or the empty-`git init` discrimination collapses.

**The verdict rule is a DOWNGRADE OF A FINAL `match`, never a veto on an
intermediate alignment (B-r4-3).** Firing at `:495` would convert a repo that
today reaches `mismatch`/`local-edits` via `:509` into a permanent
`indeterminate`.

| Final verdict | Compared pairs | `armed.hit` | Result |
|---|---|---|---|
| `match` | zero | set | `indeterminate(CONFLICT_COPY_POPULATION_WHY)` |
| `match` | zero | unset | `match` — today's behavior, unchanged |
| `match` | ≥ one | either | `match`, unchanged |
| anything else | either | either | unchanged |

**Its two sites, each counting a different population:**

| Site | Verdict stored | Population that must be zero |
|---|---|---|
| `:541` (tail of `proveFresh`) | `semantic`, from `compareEntries(projected.expected, projected.oracle, …)` at `:495` | manifest × manifest |
| `:669` (tail of `scanAndCompareProjected`) | `verdict`, from `compareEntries(scanned.files, projected.oracle, …)` at `:664` | disk × manifest |

**Compute the downgrade BEFORE `records.set`, so the record is consistent:**

```ts
const verdict = downgradeIfEmptied(semantic, projected.armed, /* pairs */ …);
this.records.set(rel, verdict.kind === "match"
  ? { verdict, receiptHash: this.receipt(…), tokens: <that site's tokens> }
  : { verdict });
return verdict;
```

**A downgraded record stores NEITHER `tokens` NOR a `receiptHash`** — it is
byte-for-byte a `settle()`-shaped record (`{ verdict }` only). `receiptHash` is
the fast-path reprove credential and the `oracleReceipt` identity field
(`src/cli/sync-git/resolution-intent.ts:115`); minting one from a
grammar-emptied population would let a later boundary re-prove or a `--confirm`
treat the emptied comparison as proven. `receiptHash(rel)` already returns
`string | undefined` (`:371-373`) and every consumer tolerates absence.

**No third site is needed.** `settle()` (`:413-415`) was verified across all
eleven call sites (`:391`, `:487`, `:491`, `:497`, `:503`, `:507`, `:516`,
`:532`, `:653`, `:662`, `:666`) — every one passes an `indeterminate`, so no
`settle()` can carry a `match`. The cached path is covered because `reproveRepo`
re-affirms `MATCH` at `:388` only when `prior.verdict.kind === "match"` (`:383`),
and a downgraded prove stores `indeterminate`.

**Second exported symbol** (`src/engine/apply-receipt.ts`, beside
`whyFromScanError`'s vocabulary at `:266-272`):

```ts
export const CONFLICT_COPY_POPULATION_WHY = "repo population emptied by conflict-copies exclusion";
```

**The plural `conflict-copies` is LOAD-BEARING, not prose** (B-r7-1) — see D4's
trace. A singular "conflict-copy" normalizes to a string that does not contain
`conflict-copies` and buckets as `conflict` regardless of declaration order.

**Costs, both bounded at zero-in-the-field today** (all 14 §5 census mints sit in
repos that also carry ordinary content, so none empties a population): a
conflict-copy-only repo is re-deferred rather than blessed, and it loses its
fast path — `reproveRepo`'s `:382-383` test fails on both clauses, so every
boundary falls to `proveFresh` and, on the state oracle, a full `scopedScan`
(`:673`). Record the bound; do not add mechanism for it.

### D4 — the `conflict-copies` deferral reason (§2.7)

**Discrimination is exact string equality against the exported constant**, never
a substring sniff (`includes("conflict")` would capture the `conflict` reason's
own details). `src/cli/sync-git/follow-classify.ts:139` becomes:

```ts
else if (oracle.kind === "indeterminate") {
  reasons.add(oracle.why === CONFLICT_COPY_POPULATION_WHY ? "conflict-copies" : "unreadable");
  details.push(oracle.why);
}
```

The `details.push` is unchanged — 271's `GitDeferral.detail` work is untouched.

**Full surface set, nine rows, anchors verified:**

| # | Surface | Anchor | Required change |
|---|---|---|---|
| 1 | Enum declaration | `sync-state-model.ts:130-134` (`GIT_DEFERRAL_REASONS`) | add `"conflict-copies"` **immediately before `"conflict"`** (today `"conflict"` is index 6, on `:132`), plus the order comment (row 10) |
| 2 | Precedence ranking | `sync-state-model.ts:149-153` | rank **immediately after `conflict`**, before `worktree-ownership` — a durable structural condition, not an environmental one. `:156-158`'s `UnrankedGitDeferralReason` alias is a compile error until ranked; `:165-167`'s load-time check compares the precedence SET size against `GIT_DEFERRAL_REASONS.length` |
| 3 | Wire/telemetry restatement | `telemetry/contract.ts:158-162` | the deliberately duplicated list (`state-plane/duplicate-declarations.test.ts:59` licenses two sites); `:163-165`'s exhaustiveness alias fails until added |
| 4 | Telemetry length pin | `telemetry/contract.test.ts:48` | `toHaveLength(18)` → `19` |
| 5 | Status-view copy | `status-view.ts:289-308` (`DEFERRAL_REASON_PRESENTATION`, `satisfies` at `:308`) | the four fields below |
| 6 | Resolve refusal copy | `git/resolve-presentation.ts:125-146` (`refusalMessage`'s `Record<GitDeferralReason, string>`) | `"rbox-made conflict copies are the only files left to compare in this repository"`; the `Record` makes omission a compile error |
| 7 | Coverage test | `status-view.test.ts:163-169` | covers the new member automatically; its second half `:170-174` (unknown-reason fallback) is untouched |
| 8 | Precedence test | `sync-git/deferral-precedence.test.ts:10-13` (set-equality) and `:15-23` (self-selection) | covers it automatically |
| 9 | Doctor reason inference | `doctor-cmd.ts:43` (`GIT_DEFERRAL_REASON_SET`), `:213-217` (`gitReasonOf`) | **no code change** — the fix is row 1's declaration ORDER plus row 10's test |
| 10 | Order comment | `sync-state-model.ts:130`, above `GIT_DEFERRAL_REASONS` | the three-line comment below — the whole comment budget for this change |

**Enforcement split, so the cost is not overstated:** one row is the declaration;
of the eight that follow, **four are compile-time** (2, 3, 5, 6), **three are
carried by existing tests** (4, 7, 8), and **one — `gitReasonOf` — is enforced by
nothing**, which is why §7 adds a test for it.

**The copy, non-developer register** (matching `local-edits`'s "Working files
changed here."):

```ts
"conflict-copies": {
  label: "conflict copies",
  text: "Backup copies rbox made of conflicting files are the only thing left to compare here.",
  repair: "Remove the conflict-copy files (or resolve them), then let sync retry.",
  transient: false,
},
```

**`label: "conflict copies"` is LOAD-BEARING (C-r8-1)** — the second channel of
the trace. Reword it only together with the declaration order and §2's second
doctor pin.

**`transient: false` is load-bearing**: it feeds `remediationClass`
(`status-view.ts:404-412`, `+2` after 271). `true` would render a permanent hold
as self-healing. With `false`, `projectGitDeferralRepos` (`:378-436`) needs **no
change at all** — that is the point of adding a reason rather than a special case.

**The trace that makes both strings load-bearing.** The reason id NEVER reaches
`gitReasonOf`; two channels do:

1. `follow-classify.ts:139` pushes `oracle.why` **verbatim** into `details`; the
   reason id it `add`s is a separate channel that never enters the log line.
2. Two caller families hand `gitReasonOf` **different strings**:
   - the **`why` half** — `doctor-cmd.ts:249` (`git-sync deferred <repo>: <detail>`,
     regex `:247`), `:255` (`git-sync WARNING`, regex `:253`), `:261` (`git-sync
     applied` held-refs arm, regex `:259`). `:249`'s producer is
     `sync-git/apply.ts:1063`'s `glog(\`git-sync deferred ${rel}: ${follow.detail}\`)`.
   - the **label half** — `doctor-cmd.ts:246` (regex `:243`) parses
     `git deferred <age>: <fragment> on <checkout> (<repo>)`, where the fragment
     is `renderGitDeferralLine`'s rendered LABEL (`status-view.ts:439-457`, the
     `gitDeferralReasonText(input.reason)` call at `:456`), written to the daemon
     log at `daemon/daemon.ts:305`.
3. `gitReasonOf` normalizes with `detail.toLowerCase().replace(/[ _]+/g, "-")`
   (`doctor-cmd.ts:214`) — folds spaces and underscores to hyphens, leaves
   existing hyphens alone — then returns the FIRST `GIT_DEFERRAL_REASON_SET`
   member the normalized string `includes(...)`. Set iteration follows
   declaration order.

Both halves are pinned in §2. The bucket is emitted as
`` `git-sync ${klass} reason=${reason} age=${age}` `` at `doctor-cmd.ts:272`.

**The general invariant (C-r6-3), and it is already shipped (C-r7-1).** Any
`GIT_DEFERRAL_REASONS` member that is a SUPERSTRING of another must precede it
in the declaration. This is not invented for `conflict-copies`:
`("ref-read-unreadable", "unreadable")` is already such a pair at indices **11
and 12** (`sync-state-model.ts:132`), superstring first, and that ordering is
load-bearing right now — swap them and a detail carrying the literal token
`ref-read-unreadable: <marker>` buckets as plain `unreadable`. (The example must
be the literal-token producer; the prose "refs could not be read" is rescued
order-independently by the fallback regex at `doctor-cmd.ts:228`.) The
`local-*` family shares only a PREFIX and is not an instance either way.

Row 10's comment, verbatim:

```ts
/** Order is load-bearing for `gitReasonOf` (doctor-cmd.ts:213): a member that is
 *  a SUPERSTRING of another must be declared before it, or the shorter one
 *  shadows it. Pinned by the invariant test; do not sort this list. */
```

Declaration order is documented as "an enumeration, not a ranking"
(`sync-state-model.ts:145-147`), so moving a member within it is free.

**Client skew is graceful and fail-closed** (§3.6) — an older CLI reading a newer
state file falls through `isKnownGitDeferralReason` (`status-view.ts:314-316`) to
`UNKNOWN_GIT_DEFERRAL_PRESENTATION` (`:282-287`), and `knownReason === false`
forces `canResolve`/`canKeepMine` false and `remediationClass` to
`"apply-unavailable"` (`:402-405`). No change needed; `status-view.test.ts:170-174`
already pins it.

### D5 — the `conflictCopies` count in `rbox status` (§4)

**TOP-LEVEL projection field, NOT inside `counts` (B-r4-4).** The JSON renderer
gates the whole `local` block on `counts.source === "daemon"`
(`status-render.ts:151-162`), so a `counts` member is invisible on the computed
branch — the branch a daemonless host reads. It rides exactly the
`strandedIgnored` carriers of the 224 precedent, whose comments apply verbatim
(`status-contract.ts:218-221`, `status-render.ts:148-149`).

Both branches source the **local manifest**, independent of the push lane —
copying `strandedIgnored`'s PUSH-lane source verbatim would leave the count
permanently undefined on FM, the pull-only host this design exists to fix.

- **Daemon branch:** computed inside `localSnapshot`
  (`daemon/daemon.ts:2259-2275`) from `this.local.manifest.files`, **exactly
  beside `trackedFiles` at `:2267`**. That manifest is maintained by scans and
  pull-applied patches (`daemon.ts:1926`, `:2015`, `:2575`) with no push
  involvement. No new daemon field, no new hook, no new lane.
- **Computed branch:** filter over `rawLocalManifest.files`
  (`status-projection.ts:352-354`, the `port.scanManifest` result), read where
  `cacheHint` already reads it at `:358`. **Not** the post-carry `localManifest`
  at `:360`: `projectLocalManifest` (`local-file-projection.ts:26-84`) carries
  matcher-ignored BASE entries forward (`:38-45`) and, on a case-fold collision,
  drops the local entries and adopts the BASE's spelling (`:68-74`) — two ways
  `:360` stops being a disk observation. `rawLocalManifest` precedes both.
- **Populate branch** (`:319-343`) has no local manifest and reports `undefined`.

Population, named: **entries of THIS device's locally observed manifest whose
path carries a grammar-matching component** — same disk observation on both
branches, deliberately no diff against any base. Neither branch's local manifest
is scope-projected (`scopeProjectionFor`, `scope/projection.ts:116`, has four
callers — `status-projection.ts:288`, `workspace-observation.ts:83`,
`sync-git/status.ts:89`, `sync-git/deferral-hygiene.ts:219` — and three of them
scope git REPO RECORDS, not files; the status path's only `projectFiles` call is
`status-projection.ts:290`, over the applied BASE). The `deleted` carve-out at
`:306-309` therefore does not transfer.

**Wire shape, copied verbatim from the precedent:**

- `activity.ts:77`: `conflictCopies?: number` **optional**, beside
  `strandedIgnored`; `sourceVersion` stays **`1`** (an older daemon omits the
  field; the version is not a feature flag).
- `activity.ts:152`: guard extended to
  `(local.conflictCopies === undefined || uint(local.conflictCopies))`.
- `activity.ts:166`: conditional copy —
  `if (local.conflictCopies !== undefined) decoded.conflictCopies = …`.
- `status-contract.ts:222`: `conflictCopies?: number` beside `strandedIgnored`.
- `status-projection.ts:302` reads it from `trusted.local` (daemon branch);
  the computed branch assigns it alongside `:361`; `:455`'s
  `if (x !== undefined) detail.x = x` pattern carries it top-level.
- `status-render.ts:150` (JSON) and `:318` (view) emit it on both branches.
- **A v1 daemon that omits it renders NOTHING** — exactly `strandedIgnoredLine`'s
  contract (`status-view.ts:927-933`: `if (!count || count <= 0) return undefined`).
  Absent and zero render identically; no "unknown" state is invented.

**Do not blur it with `counts.conflictSnapshots`** — that is the git REF
namespace (`sync-git/conflict-retention.ts`, `refs/rbox-conflict/`, 90-day
prune), printed as "conflict snapshots" at `status-render.ts:271` **and [drift]
again at `:369` (the verbose renderer, which §4 does not name)**. The new line
reads "conflict copies".

**Doctor listing is CUT (R4).** `collectRepoResidue` (`doctor-cmd.ts:567-643`)
never reads the local manifest; a per-repo listing would buy a new collector,
renderer, section pair and manifest read for information the total already
flags. Per-path recovery is the papercut one-liner
(`find <root> -regextype posix-extended -regex '.*\.[^/.]+\.[0-9]{14}\.conflict.*'`)
plus inspect/keep/`rm` guidance. **Deletion is the user's**: no GC, no expiry, no
sweep.

**CPU cost, stated per the perf rule:** the daemon-branch count adds an O(files)
pass to `localSnapshot`, which `enqueueActivityWrite` (`daemon.ts:2407-2445`,
calling `localSnapshot` at `:2419`) runs on every activity write. It rides a body
already O(files) (`diffManifests` at `:2262`, `files.length` at `:2267`,
`files.reduce` at `:2299` via `ambientStatusFrom` at `:2430`) — a constant-factor
increase, not a new order of growth. The computed branch rides the scan it
already performed. Measure both lanes before/after.

---

## 2. Tests — every §7 bullet, as a checklist

**Unit — `isRboxConflictArtifact` (D1)**

- [ ] All 17 §2.1 fixtures. Positives: `index.dev_ab12cd34.<ts>.conflict.ts`;
      `.env.dev_aaaa….20260813192500.conflict` (no ext); `node_modules.dev_3225c31.20260729231035.conflict`;
      `settings.local.dev_aaaa.<ts>.conflict.json` (dotted stem);
      `.env.dev_x.<ts>.conflict~2` and `~10` (`dup` fires);
      `notes.local.<ts>.conflict.md~3` (swallowed by `ext`);
      `x.trash.<ts>.conflict.` (trailing-dot `extname`).
      Negatives: `my.conflict.ts`; `a.b.2026081604161.conflict.ts` (13 digits);
      `a.<ts>.conflict.ts` (no token); `a.b.<ts>.conflicted.ts`;
      `a.b.<ts>.conflict.ts.bak`; `conflict-retention.ts`; and the three
      non-producer tails `…conflict~`, `…conflict~02`, `…conflict~1`.

**Unit — the oracle (D2)**

- [ ] Symmetric-drop twin: a matching path drops from BOTH the manifest side and
      the walk side.
- [ ] Below-root: a conflict-named directory **inside** a repo prunes its subtree.
      (This is the one position the predicate still tests.)
- [ ] **B1 pin, BOTH arms, blocking.** A repo whose **ROOT** matches the grammar
      and — separately — a repo whose **ANCESTOR** matches it, each with a working
      tree diverged from the applied manifest, must assert
      `expect(verdict.kind).toBe("mismatch")` at the ORACLE layer, on **both**
      `pullOracle(...).proveRepo(...)` and `oracleFromState({...}).proveRepo(...)`.
      A regression to "at or below" leaves the ancestor arm green and fails only
      the root arm — which is why both are asserted.
      **`expectNotMatch` (`apply-receipt.test.ts:70`) is explicitly BARRED here**,
      and so is any hand-rolled equivalent: with the guard shipping, deleting
      §2.3 yields `indeterminate`, which satisfies "not match" and would leave
      the pin green over a deleted §2.3.
- [ ] `comparable`'s seven call sites pinned **behaviorally, through the two
      oracles** — it is module-private, so no direct call.

**Unit — the guard (D3), blocking**

- [ ] (1) A repo whose only content directory is conflict-named (every comparable
      entry excluded by the grammar, repo root itself NOT matching) returns
      `indeterminate` with `CONFLICT_COPY_POPULATION_WHY`, never `match`. Red
      state without the guard: `match`.
- [ ] (2) **Empty-`git init` discrimination**: a genuinely empty repo (no files,
      empty applied manifest) still returns `match`. A guard written as
      "population is empty" turns this red — that is the pair's whole value.
- [ ] (3) **Both downgrade sites, separately**: fixture 1 through `pullOracle`
      exercises `:541`'s manifest×manifest population; the same shape through
      `oracleFromState({...})` takes `:493` straight to
      `scanAndCompareProjected` and exercises `:669`'s disk×manifest population.
- [ ] (4) **The downgraded record carries no credential**: after a downgraded
      prove, `oracle.receiptHash(rel)` is `undefined`, and an immediately
      following `reproveRepo(rel)` re-enters `proveFresh` and still returns
      `indeterminate` with the same why after a no-op boundary. Without the
      compute-before-`records.set` ordering the stored `tokens` make the next
      boundary return `MATCH` and the hold silently evaporates.

**Unit — the deferral reason (D4)**

- [ ] `classifyCheckout` over a guard-downgraded oracle adds `conflict-copies`,
      NOT `unreadable`; **and** an oracle `indeterminate` with any other `why`
      still adds `unreadable` — the negative half, without which an over-broad
      match test passes.
- [ ] **Doctor pins, through the exported seam `redactGitLogLines`
      (`doctor-cmd.ts:279`)** — `gitReasonOf` is module-private, and §0's
      two-exported-symbols count must not grow. Two inputs, one per channel:
      - the **`why` half**, over the **exported constant itself, never a
        hand-authored literal**:
        `expect(redactGitLogLines("git-sync deferred r: " + CONFLICT_COPY_POPULATION_WHY))
        .toBe("git-sync deferred reason=conflict-copies age=-")` (the `:247-249`
        arm; `age` stays `"-"` because only the `git deferred` arm captures a
        bucket). A literal `"…conflict-copies…"` would stay green if the constant
        drifted back to the singular — precisely the B-r7-1 defect.
      - the **label half**, pinning `DEFERRAL_REASON_PRESENTATION`'s
        `label: "conflict copies"`:
        `expect(redactGitLogLines("git deferred 1h: conflict copies on branch main (r)"))
        .toBe("git-sync deferred reason=conflict-copies age=1h")` (the `:243-246`
        arm). Without it a reworded label silently re-buckets every
        `git deferred` line for this reason as `conflict`.
- [ ] **The superstring-ordering INVARIANT itself**, not just this instance: over
      `GIT_DEFERRAL_REASONS`, for every pair `(a, b)` with `a !== b` and
      `a.includes(b)`, assert `indexOf(a) < indexOf(b)`. It goes **GREEN on
      today's `main`** (`ref-read-unreadable`/`unreadable` at 11/12) and stays
      green through the addition — it pins shipped behavior, not only the new
      member. Red state: reorder either pair.
- [ ] `telemetry/contract.test.ts:48` `toHaveLength(18)` → `19` (a deliberate
      tripwire, not an obstacle). `status-view.test.ts:163-169` and
      `deferral-precedence.test.ts` carry the rest automatically.

**Unit — the `"other"` arm (D2/§2.6), BOTH belts**

- [ ] `apply-receipt.test.ts:393-400` stays green **unchanged** (it exercises the
      MATCHER-ignored path via `pullOracle` only).
- [ ] A NEW sibling pins a conflict-grammar **FIFO** at `indeterminate` on
      **both** oracles — `pullOracle(...)` for `inventory`, `oracleFromState({...})`
      for `scopedScan`. The state-oracle half is the one that fails without the
      §2.5 restructure. Two belts, because `indeterminate` alone is satisfiable
      by the wrong mechanism:
      1. the fixture carries **≥ 1 surviving non-conflict comparable pair**, so
         the population is never empty and the guard cannot fire; AND
      2. the assertion names the **specific why** —
         `"unsupported entry type in repo subtree"` (`whyFromScanError`,
         `apply-receipt.ts:268`, over the `unsupported-entry` throw at
         `:622`/`:720`) — never the population-emptied reason.

**Rig — NEW work, verified absent today**

- [ ] Receiver-side in-repo conflict fixture: mint a conflict copy INSIDE a git
      repo subtree on the receiver, assert the repo does not enter "working tree
      differs" across N quiescent cycles.
- [ ] **Pull-only plumbing.** `startDaemons` (`scripts/rig/scenarios/preamble.ts:233-253`)
      calls `Device.daemonStart` (`scripts/rig/lib/device.ts:237-239`), which
      hard-codes `this.rbox(["start"])`. `rbox start --pull-only` exists
      (`src/cli/help-registry.ts:230-233`) but the rig cannot request it. An argv
      passthrough plus a pull-only preamble arm is IN SCOPE and is the only way
      to exercise the FM shape in CI. **That arm carries §4's non-negotiable:
      with a pull-only daemon live and never having pushed, `rbox status` must
      still report `conflictCopies`** — the assertion that the count did not
      inherit `strandedIgnored`'s push-lane dependency.
- [ ] Note: the `type-flip` rig's conflict assertions use a LOOSE glob
      (`'${FLIP}.*conflict*'` at `scripts/rig/scenarios/type-flip.ts:32`,
      `/\.conflict/` at `:86`). Those are convergence assertions and are NOT the
      grammar gate — leave them alone.

**Field — sequenced, not opportunistic**

- [ ] No wave on a live fleet host. After the fleet drains, mint a deliberate
      wave in a **dedicated scratch workspace** only; record `conflictCopies` and
      `deferredRepos` before/after there, and confirm the 609/day "working tree
      differs" lines stop. Fleet close-out is observational (FM soaks clean,
      `deferredRepos` back to the known parked set). **Both push and pull lanes
      measured per the perf-differential rule.**

---

## 3. Process

1. **Rebase onto `origin/main` after #760 merges** — §0. Nothing starts before
   this.
2. **Test-runnability preflight.** Prove the target test files EXECUTE before
   writing implementation code. Worktree agents hit the command guard on
   `bun test <path>`; wrap it in a scratchpad script. Blocked ⇒ stop and report,
   never fall back to static-only tests.
3. `bun run test:affected` per iteration where feasible; **ONE**
   `bun run test:parallel` as the final gate. The `cas-operations` heap-guard
   host flake (#757) is tolerated as the SOLE failure — verify it against clean
   `main` if it fires; any second failure is real.
4. `bun run typecheck` with `.cache/tsbuildinfo` cleared. A typecheck that fails
   then passes with no edit is a stale cache, not a transient.
5. `bun run lint:affected` — **zero new warnings**, and per the founder rule fix
   ALL anti-slop warnings in files this PR touches, not just new lines.
   Restructure; never suppress.
6. **Named exported types** (no inline anonymous shapes on exports).
   **Comments ≤ 1 line**, except the two the design explicitly budgets: §2.3's
   strictly-below-root block on `comparableFor` and §2.7's three-line order
   comment at `sync-state-model.ts:130`. That is the entire comment budget.
7. **≤ 500-line files**, and the ratchet table in §0 is the live constraint.
   `apply-receipt.ts` has ~29 nonblank lines of headroom and `status-render.ts`
   ~7 before a HARD (non-allowlisted) failure. **A trip demands the
   decomposition, never a re-pin** — if a split is deferred, it is queued with
   pin-restore as its acceptance condition.
8. Artifacts in `docs/design/notes/272/`, never the repo root. Logical commits on
   `ignored-tracked`. **Do NOT push.**
9. Append every friction finding to `docs/papercuts.md` as it happens, including
   the §4 recovery one-liner entry.

---

## 4. Do NOT touch

- **271's landed semantics.** Observed-landing authority, the base-absent typed
  hold, its refusal copy, `GitDeferral.detail` and its three projection carriers,
  the resolve typed error classes. 272 slots alongside; it never rewrites.
- **`src/cli/git/resolve-command.ts`** — 10 bytes under its byte ratchet
  post-#760. 272 has no reason to edit it: §2.7's residual is exactly the
  decision that keeps it out.
- **The priced residuals.** (a) The ordinary resolve refusal keeps its GENERIC
  proof-indeterminate copy: `proofIndeterminate` is set at
  `resolve-command.ts:269` and short-circuits at `:686-687` (`keep-mine`) and
  `:892-893` with the canned `code: "proof-indeterminate"` "retry after Git state
  settles" text. `refusalMessage`'s new sentence reaches the user only on the
  locked-boundary path (`:1070`). **Ledgered follow-up**: when
  `resolve-command.ts` is next split per its ratchet, that refusal gains
  reason-aware copy. (b) **`ref-read-unreadable`'s label mis-bucket** — its label
  `"unreadable Git refs"` normalizes to `unreadable-git-refs`, which contains
  `unreadable` but not `ref-read-unreadable`, so that family's `git deferred`
  lines already mis-bucket today. Pre-existing, noted, **not fixed here**.
- **Wire shapes.** New fields are OPTIONAL only; `activity.ts`'s `sourceVersion`
  stays **`1`**. The version is not a feature flag.
- **`apply-receipt.test.ts:393-400`** — must stay green byte-unchanged.
- **`scanDeferred` (`:465-467`) and `touchedKeys` (`:477`)** — named out of scope
  with their behavior stated.
- **Producers.** No mint-rate change, no GC/expiry of conflict copies, no
  publish-lane change, no new ignore rules, no oracle asymmetry. Conflict copies
  stay FULLY sync-eligible (224's ruling). Mint rate is booked as a named
  follow-up under design 244 / issue #683, with `conflictCopies` as the meter.
- **`counts.conflictSnapshots`** and `conflict-retention.ts` — a different
  namespace on an adjacent surface.

---

## 5. Do NOT reintroduce (design §6's rejected shapes)

1. **A singular `why`** — `"repo population emptied by conflict-copy exclusion"`.
   It reads better and silently breaks the doctor bucket: `conflict-copy` does
   not contain `conflict-copies`, so it falls through to `"conflict"` no matter
   where the member sits in the declaration. The plural is the join between two
   vocabularies.
2. **Pinning `gitReasonOf` with a hand-authored literal detail string.** A test
   written as `gitReasonOf("… conflict-copies …")` passes on a build whose
   constant drifted back to the singular — green in exactly the failure the pin
   exists to catch. Assert over the exported constant.
3. **Testing components "at or below" the projection root.** It leaves the repo's
   OWN name component in the content population, so a `moveAside`-renamed repo
   empties both populations and is misclassified by its own address. Strictly
   below root; both B1 arms assert `mismatch`.
4. **Exporting `comparable()` and pinning it directly.** Every consumer lives in
   `apply-receipt.ts`; exporting adds a public symbol whose only client is a
   test, and a direct pin cannot catch the `scopedScan`/`inventory` asymmetry D1
   found. Pin through the two oracles.
5. **Literal substitution of `comparable()` at `scopedScan:718`.** It reads as
   the smallest change and is a fail-closed → fail-open flip for grammar-matching
   special files. The §2.5 restructure is the smallest change that actually
   preserves behavior on the `"other"` axis.
6. **A prove-scoped `armed` flag as an instance field on the oracle.** `serial()`
   (`apply-receipt.ts:405-412`) de-duplicates in-flight proofs per `rel` but does
   not serialize proofs of DIFFERENT repos, so one field would be shared across
   concurrent repo proofs. The sink is allocated in `project()` and rides the
   `Projected` struct.
7. **The guard as a check on the first zero-pair alignment** (`:495`,
   `compareEntries` over expected×oracle). It fires before the walk has spoken
   and converts repos that today reach `mismatch`/`local-edits` via `:509` into
   permanent `indeterminate`. It is a downgrade of a FINAL `match`, at `:541` and
   `:669` only.
8. **`conflictCopies` as a `StatusLocalCountsBase` member** — invisible on the
   computed branch (`status-render.ts:151-162`). Top-level, per the 224
   precedent.
9. **Scope-projecting `conflictCopies`, or copying the `deleted` divergence.**
   Neither branch's local manifest is scope-projected today; adding a projection
   would introduce a divergence rather than reconcile one. This count takes no
   diff, so the `deleted` hazard does not belong to it.
10. **Letting a guard-armed hold ride `unreadable` and filing a papercut.**
    `unreadable`'s repair copy sends the user to check permissions for a
    condition whose fix is deleting a file rbox minted, and the hold is permanent.
11. **Mint relocation into `.rbox/conflicts/…`**, and any variant that ignores the
    copies in place (`*.conflict*` as an ignore rule). `.rbox` is unconditionally
    ignored (`engine/ignore.ts:350`, `ALWAYS_NATIVE_PRUNE` at `:155`,
    `hardExcluded` at `apply-receipt.ts:227-231`), so relocating **un-syncs** the
    copy — design 224's exact prohibition applied to the one artifact whose whole
    purpose is to survive.
