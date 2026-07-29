# 224 — review provenance (rounds 1–3)

Extracted from the design doc so the spec stays the spec. Repo convention:
see `docs/design/notes/221/`, `docs/design/notes/223/`.


### Rounds 0–2 (prose; the mechanisms these rulings governed no longer exist)

**Founder rulings, binding.** F1 — builtin ignores must work on symlinks across
EVERY ecosystem (§2.2 satisfies it for every pattern at once, with no per-pattern
list). F2 — bill on active bytes only; 224 must not claim byte recovery (§0, §4;
the detector reports counts). F3 — 224's value is prevention, not recovery (§0).

**Round 1** demoted round 0's symlink-escape headline (178 bytes, not the quota
story — R13/R14), corrected round 0's factual errors about `isHardExcluded`
(R4 → §2.2), `rbox status --all` routing (R8 → §2.3), the "21,323 entries
cleaned" claim (R5, removed), and the byte basis (R7 → counts only). It then
proposed two mechanisms that did not survive: a second tracked-path predicate
split by safety direction, and a forward-carry de-scoping that exempted builtin
matches from the carry.

**Round 2 (CHANGES-REQUIRED)** killed both. The split predicate was the wrong
shape — an index-less repo has ZERO tracked files, not unknown ones — so §2.1
became a taxonomy fix in `loadTrackedRepoSet` instead (S1). The de-carry was a
destructive operation routed around every safety ceremony (S2), on three verified
grounds: `assertNoUnevaluatedPurgeDeletes` is gated on `policy.purgeIgnored`
(`src/cli/sync/publish-candidate.ts:242`) so it never fires on an ordinary push
and the delete would be silent; under 1000 deletes the mass-delete breaker never
trips (`src/cli/sync/policy.ts:23`), so every FUTURE `BUILTIN_IGNORE` addition
becomes a quiet fleet-wide mass-delete against base manifests written under older
lists, with 4 external users on mixed client versions; and `BUILTIN_IGNORE`
includes `.env`, `*.pem`, `id_rsa`, `*.sqlite` (`src/engine/ignore.ts:77-85`)
with 2 real `.env` files already in the founder's base manifest — by construction
not in git either, so de-carrying could destroy the last copy. **Excluding a path
from sync is not consent to delete it from other machines.** Round 2 also proved
R11's "zero existing tests break" false (S6 → §3.1 test 4), caught that round 1's
type-aware matcher would not exist on any daemon host (S5) and that its
"callers have `entry.type` in hand" claim was wrong at 2 of 3 sites (S7), demanded
a measurement of the then-proposed O(base) sweep (S8), and fixed a batch of stale
anchors (S9 — one of whose "corrections" was itself wrong; see T6).

**Three rulings an implementer must NOT re-litigate:**

1. **Dropping trailing slashes from `BUILTIN_IGNORE` is overruled** (R1, proven by
   execution). Ordinary user *files* named `build`, `dist`, `target`, `coverage`
   sync today and would silently stop. §2.2 never widens the rule set; test 5 is
   the negative twin.
2. **Source-based scoping of the carry is impossible.** `fullDecision`
   (`src/engine/ignore.ts:489-500`) restamps a builtin match as `".gitignore"` at
   `:496` whenever a nested `.gitignore` also names it — the common case — so
   `decision.source` cannot distinguish a builtin strand from a user-rule one.
3. **A builtin-name prefilter for the detector is unsound** — see T1 below.

### Round 3 — FINAL (folded; design self-certified)

| # | Finding | Ruling |
|---|---|---|
| T1 | Can a cheap builtin-name prefilter make round 2's sweep affordable enough to ship default-ON? | **NO — the prefilter is UNSOUND, and the question is moot because the sweep is deleted.** Benchmarked: a bare-name prefilter produces **13 false negatives**, missing `.env`, `.env.local`, `*.pem`, `id_rsa`, `*.sqlite`, `*.db`, `.DS_Store`, and `.rbox-tmp-*` — exactly the secrets class §1.1 leads with. A repaired prefilter (basename literals + suffix/prefix + a `cmake-build-*` regex + `vendor/bundle`) reaches FN=0 **only with no user rule files**: a root `.gitignore` gives FN=3, a root `.rboxignore` FN=2. The structural reason is that `buildIgnoreMatcher` loads the root `.gitignore` and `.rboxignore` into `legacyIg` UNCONDITIONALLY (`src/engine/ignore.ts:357-364`), independent of `respectGitignore` — so even the trusted branch's matcher carries arbitrary user globs, and any prefilter keyed on the builtin list is unsound wherever a rule file exists. **Recorded so nobody retries it** (§4). The real answer is better than either option: `src/cli/local-file-projection.ts:22` already computes the exact set §2.3 defines, and §2.3's own premise (the scanner never emits an ignored path) proved the sweep redundant on the same page. §2.3 rewritten around the existing computation; `RBOX_STATUS_STRANDED` deleted; ships default-ON; test 14's skew hedge became an equality assertion |
| T2 | `indexAbsent` as specified conflates "never committed" with "index deleted from a repo that HAS commits" — a purge-plane data-loss hole in §2.1 | **Accept.** `git ls-files --cached` reads the index, so both yield ∅, but the second has a genuinely non-empty tracked set. Under round 2's two-signal `indexAbsent` it becomes `available: true, paths: ∅`, `unevaluatedGitRepoForPath` (`src/engine/ignore.ts:539-547`, skip at `:543`) passes over it, the purge refusal never fires, and `rbox ignore --purge` deletes committed files fleet-wide. Ordinary push stays benign (§1.3's carry); purge does not, and un-blocking purge for these subtrees is an explicit §2.1 goal. Remedy: a THIRD positive signal — `git rev-parse --quiet --verify HEAD` must FAIL. One extra spawn per index-less repo (6 of 328). Field evidence supports it directly: all six founder subtrees measured `HEAD: NONE` alongside `index: MISSING` (verified 2026-07-29 — `git -C <dir> rev-parse --short HEAD` returns `fatal: Needed a single revision`). §3.1 test 3(c) is the fixture |
| T3 | Round 2's cost measurement was itself wrong | **Corrected claim, no live number.** The "790 ms cold / 214 ms warm" figure understated the cold path: re-measured at **1051–1174 ms cold**, and `rbox status` is one-shot so production only ever pays cold. For the record only — the sweep is deleted, so no cost figure or wall-clock bound remains in the design |
| T4 | Round-2 rulings say "§2.3 deleted" while a live §2.3 exists later in the doc | **Accept.** The §5 prose now distinguishes round 1's de-carry (deleted) from the live §2.3 detector (survives), so an implementer cannot conclude the detector was cut |
| T5 | §2.2's `BUILTIN_IGNORE` recomposition silently drops `vendor/bundle/` | **Accept.** A bare-name list has no slot for the multi-segment `vendor/bundle` (`src/engine/ignore.ts:35`). After T8 `BUILTIN_IGNORE` is left unsplit, so the hazard is dormant; §2.2 records the requirement for anyone who splits it later, and test 15 asserts it survives |
| T6 | Anchor errors, including one the round-2 ruling introduced | **Accept, all fixed.** `ALWAYS_NATIVE_PRUNE` is `src/engine/ignore.ts:150`, NOT `:149` — round 2's S9 "corrected" a correct anchor and broke it; restored. `HARD_PRUNE_DIRS` is documented at `:95-108`, declared at `:109`. The `src/cli/sync/policy.ts` 1000-delete floor is at `:23` (`:27-35` is the predicate, which was right). §1.3's daemon claim now cites `src/cli/daemon/daemon.ts:1401` and `:2288` |
| T7 | Two test-coverage claims overstate what exists | **Accept both.** (a) Test 7 cited `src/engine/ignore.test.ts:222` as covering the deliberate exclusions; it covers `Pods`, `vendor`, `.vscode`, `wandb` — `.idea`, `mlruns`, `.yarn` appear NOWHERE in that file. Claim narrowed; the test adds the missing three. (b) Test 13 called `src/cli/sync/sync.test.ts:66-85` "indirect coverage" of `projectLocalManifest`; it is a DIRECT call passing an empty base and a stub `{ ignores: () => false }`, so the forward-carry branch (`src/cli/local-file-projection.ts:20-27`) has ZERO coverage. Corrected — which strengthens the case for a dedicated test file |
| T8 | §2.2's type-aware matcher API pays an API change, a daemon-facade change, three watcher call sites, an unknown-type default, a `FileEntry` thread through two more callers, and a facade-identity test — to answer a question the producers already know the answer to | **Accept — the entire `entryType` parameter is DELETED.** `src/engine/manifest.ts:595-596` already branches on `child.type === "symlink"` and consults the matcher at that same site; the replacement is `ignores(childRel) \|\| ignores(`${childRel}/`)`, which is F1 exactly. `IgnoreMatcher` keeps its signature. This RETIRES rather than answers R3 (negations are free — same matcher, same rule set, same string), S5 (`src/cli/daemon/daemon.ts:2916-2924` is a fixed-arity whitelist that drops extra arguments — with no extra argument there is nothing to drop, and `src/cli/daemon/watcher.ts:364`, `:377`, `:434` are untouched) and S7 (no caller asked for a type). **One qualification, found while verifying this ruling:** there is a SECOND producer. `statHashEntry` (`src/engine/manifest.ts:415-430`, emitting at `:430`) is reached from the incremental watcher path, where the ignore check at `:373` (and the `unlink` re-derive at `:288-299`) runs BEFORE the type is known. So the fix is two lines, not one: a post-stat drop when `res.entry.type === "symlink" && matcher.ignores(`${rel}/`)`. Still zero API surface, still local to the producers; test 10 pins full-scan/incremental agreement. Every other `type: "symlink"` construction site is pull-side or diagnostic, not local ingress (`src/engine/apply.ts:479`, `src/engine/apply-receipt.ts:645`, `src/cli/daemon/drift-audit.ts:168`), plus one bench fixture (`src/engine/manifest-delta.bench-helper.ts:9`). Accepted cost, stated in §2.2: purge cannot remove an already-stranded symlink entry — 3 entries, 178 bytes |
