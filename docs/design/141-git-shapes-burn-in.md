# 141 — Git-shapes burn-in: exotic repository fixtures the fleet never exercises

v3 — Round-2's six open findings (f3/f4/f5/f9/f10/f11) are closed by the
NORMATIVE ANNEX `docs/design/141-cell-outcomes.md` (derived from the code
by mechanical audit, self-reviewed PASS, ratified 2026-07-17): it states
the exact expected outcome for every contested cell — the per-cell
fidelity-clause applicability matrix (refusal cells replace the
bidirectional/convergence clauses as the annex specifies), the S1/S2/S4
observable surfaces verbatim, the true bisect behavior, and
deferral-display precedence. Where this document and the annex disagree,
the ANNEX wins for cell expectations. v2 accepted all thirteen Round-1
findings. The reframe Round 1 forced:
most Tier-1 "hypotheses" are SETTLED engine contracts with pinned unit
tests; this suite's job is to pin those contracts END-TO-END in the rig
(assert the exact refusal/drop/materialization), and to precisely document
the two genuine gaps it found. No `knownFinding` suppression exists: every
cell asserts today's reality and PASSES; a future behavior change breaks
the cell loudly, which is the point of a burn-in.

## Problem

The fleet burns in one git shape (many worktrees, huge counts, ASCII, no
submodules/LFS/shallow). Real-developer shapes are unexercised END-TO-END —
unit tests pin pieces, but no two-machine rig scenario proves what a new
user's exotic repo actually experiences across sync, deferral, and
convergence. Founder-greenlit Tier 1: submodules, LFS, unicode/case,
shallow/partial, in-progress operations.

## Mechanism

### Conventions (corrected per Round-1 f2)

One scenario family in `scripts/rig/scenarios/git-shapes.ts` using the
rig's REAL model: the reused `rig-dev-a`/`rig-dev-b` guest pair with
per-scenario guest reset + fresh account (`rig.ts:106-175`) — NOT
per-scenario containers. Fixture "builders" in
`scripts/rig/lib/git-fixtures.ts` are pure DESCRIPTIONS (command/tree
lists, unit-testable) executed by the scenario through `Device.exec` —
purity lives in the description/executor split, not in avoiding the
device. `rig=1` labels and the no-global-prune rule stand.

### The fidelity contract (clause 4 pinned per Round-1 f3)

Per cell: A builds → sync → B materializes → assertions on B (and after a
B-side mutation, back on A):

1. `git status --porcelain` equals the cell's expected set.
2. `git fsck --no-dangling` exits 0 unless the cell declares the exact
   expected complaint (a valid shallow repo owes NO complaint — f8).
3. Shape-artifact assertions as each cell enumerates (byte pins via hex —
   `Device.exec` decodes stdout, so display-string comparison is never a
   byte pin; f6).
4. **Exact convergence checks** (replacing the undefined "drift silence"):
   the JSON deferral set equals the cell's expectation
   (`status-cmd.ts:486-503` surface); per-device `lastSyncedSequence`
   checkpoints bound as in git-entanglement:331-348; safe-ref
   `advertised` + `publisher-ack` provenance present where expected
   (`config.ts:260-280`); NO pending/partial/P/K artifacts remain after
   settle (`p-settlement.ts:76-157`, `pull.ts:271-305`); next cycle
   publishes nothing new.
5. Bidirectional: a B-side branch commit arrives on A with 1-4 holding.
6. Where the engine's contract is refusal/drop, the cell asserts the
   EXACT refusal (message/log/status surface) — an ordinary PASS.

**138-awareness** (f12): single-stream cells only; no manufactured
journals; at every operation timeout AND cell boundary, probe
status/health — `halted`/`recovering` state is automatically a finding
with status + health-side-file + run-log evidence attached (a halted cell
may produce no fresh daemon log line; the probe cannot rely on logs).
Design 138 rules were consumed from a reference-only draft snapshot during
review; the merged `docs/design/138-reset-path-hardening.md` is now
authoritative. POST-138 RECHECK: re-run
the suite once after 138 merges and diff cell outcomes.

### The cells (expected outcomes are TODAY'S contracts)

- **S1 submodules** (f4): (a) superproject with `.git/modules` → assert
  the EXACT structural refusal (`preflight.ts:22-28,57-62`) surfaced
  loudly in plan/log/status; plain-plane worktree files still sync;
  (b) an independently discovered nested pointer repo on B is
  materialized as a STANDALONE `git init` dir repo
  (`apply.ts:253-268,406-424`) — assert that layout, not pointer
  fidelity; (c) uninitialized entry (`.gitmodules` + gitlink only, no
  modules dir) — assert whatever preflight/plan does today, exactly.
- **S2 git-lfs** (f5): git-lfs enters the rig image (both guests — same
  image, so the "absent" arm is a PATH/filter-config cell: B gets
  `filter.lfs` unconfigured/masked, not uninstalled). Assertions:
  committed POINTER bytes via `git cat-file` (native plane); worktree
  binary bytes via the plain plane; `.git/lfs/objects` expected ABSENT on
  B (excluded by `ignore.ts:231-245`; capture ships bundle+index only —
  `capture.ts:207-221`); `filter.lfs.*` config expected NOT to travel
  (outside `config-sync.ts:13-21` allowlist). Any lfs-cache recreation is
  a git-lfs side effect, asserted only if deterministically observed.
- **S3 unicode/case** (f6/f7): TWO Linux cells now — (a) NFC/NFD pair:
  both files reach B with pathname BYTES preserved (hex-pinned via guest
  `printf | xxd`); (b) case-collision pair: assert the EXACT manifest
  refusal (`manifest-validate.ts:146-161` rejects the second
  case-insensitive duplicate on every platform) and its user-visible
  surface. **Linux↔macOS cells are REMOVED from this design** — they
  need a native-mac device backend (no such `Scenario` kind exists —
  `types.ts:11-51`; the Apple-container guest is still Ubuntu) — named
  follow-up design, not dormant code.
- **S4 shallow/partial** (f8/f9): (a) shallow: `file://`-sourced
  `--depth 1` clone (plain-path clones ignore --depth); assert the EXACT
  preflight refusal + unshallow hint (`preflight.ts:43-50`) and the
  planner's loud drop (`plan.ts:506-536`), zero post-drop divergence —
  the rig-level pin of the existing unit contract
  (`git-sync.test.ts:1882-1927`); (b) partial/promisor: origin fixture
  with `uploadpack.allowFilter=true`; PRE-assert missing objects exist;
  TWO arms — origin-available (if bundling hydrates promised blobs,
  that is classified a FINDING: capture runs without `GIT_NO_LAZY_FETCH`,
  `shared.ts:75-93`, unlike reachability's deliberate
  `reachability.ts:25-32`) and origin-unavailable with lazy-fetch
  disabled (missing objects stay evidence — assert capture/plan behavior
  exactly as observed and pin it). "Promisor config round-trips" is
  REMOVED (outside the allowlist; `file://` remotes rejected —
  `config-sync.ts:126-135`).
- **S5 in-progress ops** (f10/f11): lifecycle INVERTED per f11 — clean
  shared BASE on both machines first; the operation starts on the
  RECEIVER (B); A advances the same branch; B pulls into the op-holder.
  Cells: mid-merge, mid-rebase, mid-cherry-pick (all in the engine's
  op-state universe — `manifest-validate.ts:226-248`): assert deferral
  (`local-operation` classification), CHECKOUT/INDEX/OP-FILE bytes
  unmutated across ≥2 cycles (safe-ref/config partial progress is
  ALLOWED — it intentionally precedes checkout classification,
  `follow.ts:938-1002`), and clean convergence after the op completes.
  **Bisect cell = the suite's first documented engine gap** (f10):
  `BISECT_*` is invisible to the op-state universe and `refs/bisect/*`
  unsyncable, so NO deferral fires — the cell asserts today's actual
  behavior (sync proceeds; bisect files persist untouched as untracked
  op litter; HEAD/index semantic assertions document what CAN move) and
  the findings sidecar records it as `engine-gap: bisect-invisible`
  feeding a follow-up design.
- Also inherited from the incident review: op-state cells assert that an
  incoming `MERGE_HEAD` from BASE IS applied (pinned behavior,
  `follow.test.ts:244-261`) — receivers do not get to keep stale BASE op
  bytes; that is design intent, not a bug.

### Findings protocol (f1/f13)

No suppression mechanism. Cells assert current reality and pass. Genuine
new discoveries during implementation = failing cells → triaged: either
the fixture is wrong (fix it) or the engine surprised us (record in the
sidecar, adjust the cell to assert observed behavior WITH a
`finding:`-slug comment + follow-up design, and note it in the PR). The
sidecar is `ctx.runDir/git-shapes-findings.md` (the rig's real per-run
dir — `rig.ts:203-239` — auto-indexed by capture); `ScenarioReport` is
unchanged.

## Tests the implementation MUST write

Fixture-description units (deterministic trees; fsck-valid at build; NFD
names byte-pinned in the description). Scenario-side: the health-probe
helper (halt detection without logs); the hex byte-pin helper; sidecar
rendering. Each cell's exact-refusal strings sourced from the code, not
retyped (import or fixture-constant, so copy drift breaks the build).

## Non-goals

Engine fixes (bisect gap; the former hydration finding was removed by design
146 as an observation artifact, not an engine gap); native
macOS backend (follow-up design — prerequisite for real NFD/case-fold
cells); Tier 2/3 shapes; CI wiring; TUI-gate integration; `knownFinding`
machinery.

## Acceptance

`bun run typecheck`; `bun test scripts/rig` green (fixture units); live:
the full git-shapes scenario family runs green on this host's Docker rig,
every cell reporting PASS with its exact-contract assertions, the sidecar
generated, zero `rig=1` residue beyond the standing pair. The PR
description includes the sidecar verbatim (including the bisect
engine-gap entry).

## Rulings — Round 1 (13 findings)

f1 ACCEPT (no knownFinding; settled refusals = ordinary passing
assertions; genuine gaps documented in-cell + sidecar). f2 ACCEPT
(conventions restated: reused guests + reset; description/executor
purity). f3 ACCEPT (clause 4 = named exact checks). f4 ACCEPT (S1 asserts
structural refusal + standalone materialization). f5 ACCEPT (S2
filter-config arm, cat-file pointer pins, lfs-cache expected absent). f6
ACCEPT (case-collision = manifest-refusal cell; NFC/NFD hex-pinned). f7
ACCEPT (mac cells removed → follow-up native-mac backend design). f8
ACCEPT (shallow = exact settled refusal; file:// source; no fsck
complaint owed). f9 ACCEPT (partial-clone rebuilt: allowFilter and pre/post
missing-object assertions; the initial hydration expectation is superseded by
design 146's corrected no-hydration observation; promisor round-trip removed).
f10 ACCEPT (bisect = documented engine gap cell).
f11 ACCEPT (receiver-side op lifecycle; safe-ref progress allowed;
checkout/index/op-file pins only). f12 ACCEPT (status/health halt probe
at timeouts + boundaries). f13 ACCEPT (ctx.runDir sidecar; ScenarioReport
unchanged).
