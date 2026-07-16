# §128 — `rbox git resolve show-me`: batched ownership proofs + progress

> **Status: 🚧 IN PROGRESS — 2026-07-16 (founder-ordered, "do 2 then 1 then 3", item 3).**
> Field record (STATUS, 2026-07-15): show-me ran **30 minutes with zero output** on the
> 150k-file workspace. Show-me is the inspection command the §124 fix brief tells users to
> run — the remediation path currently ends in a tool that looks hung.

## Root cause (verified 2026-07-16)

`buildResolveSnapshot` (`src/cli/git-cmd.ts:~376-398`) builds `candidates` from every ref
tip **plus every reflog entry of every ref** plus the stash reflog. For EACH candidate it
calls `tipOwnedByIncoming` (`src/engine/git/reachability.ts`), which per call runs: a
shallow probe, `peelAndVerify`, and **one `git merge-base --is-ancestor` subprocess per
ownership root** (early-exit on first owned). Unowned candidates then get a serial
`git log -1` each. A long-lived repo has thousands of reflog entries; thousands of
candidates × (1 + roots) subprocesses × tens of ms = the observed half hour — all before
the first byte of output.

## Design

### Batched partition — same semantics, ≤5 subprocesses total

New `partitionOwnedByIncoming(repoDir, tips: string[], roots: string[])` in
`src/engine/git/reachability.ts`, returning per-tip `OwnershipProof` (same statuses/markers
as `tipOwnedByIncoming` — this is a batching of the EXACT existing semantics, which is the
review target):

1. **Shallow probe once** per repo (today: once per candidate). Shallow/probe-failure →
   every tip `indeterminate` with the same marker as today.
2. **Peel + verify in one `git cat-file --batch-check`**, fed the exact legacy expressions
   `${oid}^{commit}` (round-1 F7: recursive nested-tag peel + commit-ish enforcement are
   properties of the `^{commit}` peel, not of batch-check itself); per-input `missing`
   records parsed positionally so duplicate raw OIDs and distinct tags peeling to one
   commit keep their raw→peeled mapping. Missing/non-commit TIP → that tip
   `indeterminate: missing-object`. **Missing/non-commit ROOT → every tip indeterminate**
   (round-1 F3: the legacy path validates `[tip, ...roots]` on every call, so a bad root
   poisons every proof — dropping it could falsely classify; pinned + tested both ways).
   `GIT_NO_LAZY_FETCH=1` (graphEnv) applies to EVERY batch subprocess including fallback.
3. **Graph-integrity walk (round-1 F1 — CRITICAL, reproduced)**: `peelAndVerify` also runs
   `rev-list --quiet` over every peeled commit, catching e.g. a commit whose parent object
   is missing — batch-check alone would classify it OWNED where legacy says
   `indeterminate: missing-object`. The batch runs one fail-closed
   `rev-list --quiet --stdin` over all peeled tips+roots first; on failure it falls back
   to the legacy per-tip path to recover exact per-tip markers and independence.
4. **Ownership in one streamed `git rev-list --stdin`** over the **roots' closure**
   (round-1 F4: `rev-list tips ^roots` emits receiver-only ancestry — history-sized output
   that can exceed the 16 MiB runner buffer and O(history) memory; the inverted direction
   is equivalent and bounded): a peeled tip is OWNED iff it appears in `rev-list <roots>`
   (ancestor-or-equal of some root — exact `merge-base --is-ancestor` semantics). Output
   is STREAMED; only lines matching the candidate set are retained — O(candidates) memory
   regardless of history size. A rev-list failure → whole-batch legacy fallback.
5. **Subjects in one `git log --no-walk=unsorted --format=%H%x00%s --stdin`** for **ALL
   unowned tips** (round-1 F6: subject participates in the existing sort key, so capping
   before subject retrieval cannot reproduce today's ordering); per-OID
   `"unreadable commit"` fallback preserved; sort exactly as today; the cap applies at
   presentation only.

Runner support (round-1 F8): `gitRaw`/`git` gain stdin + streaming-stdout support in the
shared runner, retaining the existing observer notification — the O(1)-subprocess test
asserts command families and counts through the observer (cleared in `finally`).

`tipOwnedByIncoming` stays for its single-tip callers (follow's HEAD proof etc.);
show-me switches to the partition. No behavior change to which commits count as local-only.

### Output bounding + progress (the "zero output" half)

- **The cap is presentation-only, and safety data is uncapped by construction** (round-1
  F2/F5): `protectedOids`, `stashDiverged`, `waivedReasons`, `proofIndeterminate`, and the
  full `localOnly` set are computed from the UNCAPPED data — a reflog-only commit beyond
  position 50 must still be protected (tested exactly so). The `--json` contract is
  **unchanged and exhaustive** (round-1 F5: truncating the existing array is not
  skew-safe — an old consumer would silently treat 50 as complete; no new field needed).
  Only the HUMAN output caps at **50 commits** with a final
  `…and N more local-only commits` line.
- Progress heartbeats to **stderr**, injected **only for the show-me path** (round-1 F9:
  `buildResolveSnapshot` also runs inside take-theirs and its pre-mutation recheck — those
  stay silent): one line per phase transition (`show-me: staging incoming bundle…`,
  `show-me: proving ownership of N candidates…`, `show-me: N local-only commits found`),
  plus a "still working (Xs)" heartbeat every 10s inside a phase, timer cleared in
  `finally`. Tests capture stdout/stderr separately (existing tests merge the channels —
  update them); `--json` stdout stays byte-identical.

### Perf target

150k-file repo, ~10k reflog candidates: ownership phase drops from thousands of
subprocesses to ≤5 (probe, batch-check, integrity walk, ownership stream, subjects); end-to-end show-me in seconds (bundle staging becomes the dominant
term). Add a coarse regression guard: unit test asserts the partition issues O(1)
subprocess invocations for N tips (spy on the git runner), not a wall-clock benchmark.

### Tests

- Equivalence: partition vs `tipOwnedByIncoming` per-tip on the same fixtures — owned /
  unowned / annotated-tag tip / missing object / shallow store / walk error (rev-list
  failure → fallback path exercised).
- Mixed batch: some owned, some unowned, some indeterminate in one call; per-TIP statuses
  independent (one missing tip must not poison the batch — while a missing ROOT poisons all,
  per F3, tested separately).
- Show-me: human cap + `…and N more` line; JSON exhaustive and byte-identical to today (no new fields); subjects batched (runner
  spy: no per-oid log calls); stderr progress lines present, stdout byte-identical to
  today's format otherwise (golden).
- Reflog-heavy fixture: N=500 synthetic reflog entries → subprocess-count assertion.

## Non-goals

- Changing what counts as a candidate or local-only (the reflog sweep is deliberate —
  §124's protectedOids depends on it).
- Progress UI beyond plain stderr lines; TTY spinners.
- Touching follow-path reachability callers.
