# U3 migration machine — primitives / simplification audit

**Date:** 2026-07-31 · **Base:** `origin/2.0` at `95e11017` (5B merged) ·
**Standard:** `.agents/skills/simplify-codebase-primitives/SKILL.md`
**Authority read:** `docs/design/163-state-plane-sqlite.md` (v13),
`docs/design/222-u3-migration-implementation.md`, PR bodies #581–#612.

**This is an audit. No product code was changed.** Every anchor below was opened
and read; nothing is relayed from a summary. Refactor cycles are proposals, and
none of them is approved work — §9 states what is explicitly *not* approved.

---

## 1. Verdict and structural diagnosis

**Verdict: the machine is structurally sound and should not be restructured.**
Eight parallel lanes produced a genuinely deep core. `runMigration`
(`src/cli/state-plane/migration/authority.ts:132`) is one loop with a fresh
observation per iteration and exactly one durable transition per iteration —
that is the right primitive and it is well built. `authority-bootstrap.ts` is
135 lines that own the whole genesis/migration dispatch plus the write fence.
`classifyMigrationState` is a single authority over 14 typed rows. `locks.ts`
has exactly one `withStatePlaneLocks` and everything else threads a proof token.
The domain is not the problem.

**The drift is at the two edges, and it is the same drift twice: a taxonomy that
cannot express what the code knows, so consumers re-derive it.**

- **Downward (the halt record).** `MigrationHaltCode` is a closed 10-member
  union. Three of the ten carry 110 of ~120 producer expressions;
  `reserved-path` alone carries ~69 of them (58%), spanning eight unrelated
  condition classes. Two of the ten have **zero producers**. Because the record
  cannot say which condition occurred, the operator surface reconstructs a
  second taxonomy at render time out of a regex over a free-text field
  (`state-plane-report.ts:98-103`). The reconstruction is 1-for-69 accurate.
- **Upward (the workspace-state question).** `doctor-state-plane.ts` does not
  ask `classifyMigrationState` what state a workspace is in; it re-reads two
  files and builds a 3-bucket verdict against the domain's 14 rows. It is
  demonstrably wrong on two of them today. `upgrade-state-window.ts`
  independently re-derives the outcome taxonomy by prefix-matching rendered
  strings.

Both are the *same* failure the skill names: an Adapter reconstructing domain
orchestration because the Interface it was given is not complete. The fix is
never "split the adapter" — it is to complete the Interface so there is nothing
left to reconstruct.

A third, cheaper drift: the filesystem leaf layer has no owner. One primitive —
"create-exclusive-or-adopt this path, prove the inode, write in place, fsync" —
exists in **six** copies with four occupant policies and four refusal channels,
and four of this audit's five latent defects hide in the gaps between them. A
traced run confirms the shape: `observePath` is well designed but competes with
~29 raw `fs.open*` sites in the same directory (§3h).

**What is NOT wrong**, and where earlier suspicions were falsified:

- `markerBytes` (`finalize.ts:85-91`) is **not** a second encoder of the 58-byte
  marker. It delegates to `authorityMarkerBytes` and only converts the throw to
  a typed halt. The real second encoder is in the crash rig — see §5.
- The `-wal`/`-shm`/`-journal` sidecar list appears at 8 sites and **all eight
  are complete and consistent**. No correctness divergence. It is a tidiness
  item, not a bug.
- Observation reuse was expected to be a cycle and is **not** one. A traced
  M0→M7 run shows 11.7× read amplification, but ~5% of wall time, and the
  duplication that matters is intra-phase rather than across the phase
  boundaries where caching would delete a crash property (§3h). It folds into
  Cycle 3 instead of earning its own.
- Three of the five file splits examined (`genesis`/`genesis-intent`, lane 3A's
  four, `control-sibling`) are **real seams with executable gates**, not
  line-count artifacts. Re-merging any of them would delete a proved property.
- `whole-state-compat.ts`, `sqlite-state-save.ts`, `read-only.ts`,
  `legacy-json-publication.ts` are clean Adapters. `whole-state-compat.ts`
  imports `assertAuthorityWritable` rather than reimplementing the fence — it is
  the model the other adapters should follow.

---

## 2. Protected-functionality ledger

Real users' data and an active migration. Protect aggressively. Nothing in §7
may touch any row below except as an explicitly gated behavior-preserving slice.

### 2a. Supported functionality (never remove)

| Item | Owner | Note |
|---|---|---|
| `rbox migrate`, `--json` twin | `state-plane-cmd.ts:99` | plus the non-interactive twin for every command 222 §6 names |
| `rbox doctor --retry-state-migration` / `--abort-state-migration` | `state-plane-cmd.ts:112,121` | the only things that clear a halt (163:3461) |
| `rbox upgrade`'s stop-window migration pass | `upgrade-state-window.ts:90` | incl. its never-throw contract, tested at `upgrade-state-window.test.ts:117-153` |
| `rbox doctor`'s state + migration checks | `doctor-state-plane.ts` | including the `authority-corrupt` status 5B added |
| Exit-code contract | `state-plane-cmd.ts:46-51` | `cleanup-deferred` alone is `ok:true` → exit 0 |
| The `--json` `outcome` strings | `state-plane-report.ts:163-167` | a rig and `upgrade-state-window.ts:47-51` both consume them |

### 2b. Active migration / rollout (never call this dead compatibility)

| Item | Anchor |
|---|---|
| The whole M0–M7 phase machine and every resume row | 222 §5.2 |
| Legacy-JSON authority and the `L`↔`Q` selecting seam | `whole-state-compat.ts:59-66` |
| The durable `MigrationControl` schema — closed, strict, unknown fields reject | `control-codec.ts` |
| B0 last-writer witness | `last-writer-witness.ts` |
| Genesis intent and its §2.5.1 finishing conjunction | `genesis.ts`, `genesis-intent.ts` |
| Dual-binary compatibility with signed 1.11.0 | 222 §7.6 |

### 2c. Safety invariants (each has exactly one owner; do not add a second)

| Invariant | Owner | Evidence it is load-bearing |
|---|---|---|
| A refusal leaves `.rbox` byte-identical, sidecars included | 222 §5.1 | "the strongest promise in this document" |
| Nothing deletes an artifact it does not durably own | 222 §5.4 | |
| A failed halt publication is the final mutation of the trace | `control-publication.ts` | by type and by fault test |
| No SQLite open on the write fence (163 v13 ownership rule) | `authority-bootstrap.ts:89-96` | a read-only open creates sidecars it cannot remove; graph-gated at `authority-bootstrap.test.ts:434-450` |
| Only one module may rename onto the canonical control | `control-sibling.ts` | gate at `control.test.ts:369` |
| The driver performs no fs/crypto/SQLite syscall | `authority.ts` | import-graph gate, 222 §7.9 |
| `reserved-path` names a path only when class is `path-occupied` | `state-plane-report.ts:137` | after the flip the file list includes the user's LIVE records |
| Halt-copy exhaustiveness (`satisfies Record<MigrationHaltCode, …>`) | `state-plane-copy.ts` | the merge gate |
| Stale-witness containment | `authority.test.ts:142-233` | four gates; see §6 R-3 |

### 2d. Performance fast paths

`assertAuthorityWritable` runs on **every** SQLite save (222 §8, lane 2D
inheritance). It is file-level by construction and must stay that way.

---

## 3. Measured complexity map

Counts, not vibes. Production files only (`*.ts`, excluding `*.test.ts`,
`*.d.ts`), measured on `95e11017`.

### 3a. Size

| Scope | Files | Nonblank prod lines |
|---|---:|---:|
| Whole `state-plane/` + 6 CLI surface files | 92 | 15,821 |
| **The U3 machine** (`migration/` + `adapters/` + genesis/bootstrap/locks/marker/paths/errors + 6 CLI files) | **45** | **9,328** |
| `migration/` alone | 27 | 5,757 |
| `migration/` + `adapters/` tests | — | 6,948 |

### 3b. Concept count in the U3 machine

| Concept | Count |
|---|---:|
| Exported symbols | **319** |
| Exported union/result types | 57 |
| Distinct string-literal discriminants (`kind`/`row`/`status`/`reason`/`disposition`) | **90** |
| Error classes in `state-plane/errors.ts` | 18 |
| `halt(` raise sites | 85 |
| Sites constructing `{ kind: "halted", … }` | **20** |

### 3c. Halt taxonomy — the producer distribution

10 declared codes (`migration/health.ts:15-25`). ~120 producer expressions.

| Code | Producers | Distinct condition classes |
|---|---:|---:|
| `reserved-path` | **~69** (37 direct + ~32 via four free-text corruption factories) | **8** |
| `verification` | 35 | ~6 |
| `durability-indeterminate` | 6 | 1 |
| `filesystem-full` | 5 | 2 |
| `cleanup-deferred` | 5 (one factory) | 1 |
| `source-oversize` | 2 | 1 |
| `memory-admission` | 2 | 1 |
| `disk-preflight` | 1 | 1 |
| `record-oversize` | **0** | — |
| `source-changed` (as a halt) | **0** | — |

Three codes carry 110 of ~120 producers. Two have none.

`reserved-path`'s eight condition classes, counted:

| Class | Sites |
|---|---:|
| internal corruption free-text (4 factories) | ~32 |
| path-occupied / foreign occupant | 14 |
| recorded-identity mismatch (inode/path drift) | 11 |
| errno passthrough (EACCES/ELOOP/ENOTDIR/EIO/ENOENT) | 4 |
| protocol-state refusal (wrong phase/disposition) | 3 |
| reserve-budget / reserve-foreign | 2 |
| missing cleanup resource | 2 |
| no durable config stream | 1 |

The `~40 producers across eight modules` figure asserted in
`state-plane-detail-copy.ts:9,52` and `state-plane-report.ts:90` is an
undercount by ~1.7×.

### 3d. The 5B compensation, measured

5B could not change the durable taxonomy, so it built a *second* one at render
time keyed on `underlyingCode`:

```ts
// state-plane-report.ts:62,98-103
const looksLikeErrno = (raw) => /^[A-Z][A-Z0-9_]{2,}$/.test(raw);
function reservedPathClass(halt): ReservedPathClass {
  const raw = halt.underlyingCode;
  if (raw === null || raw.trim() === "") return "internal";
  if (looksLikeErrno(raw)) return "environment";
  return tokenCopy(raw) === undefined ? "internal" : "path-occupied";
}
```

Measured accuracy against the 69 producers:

| Rendered class | Producers reaching it | Producers that *belong* to it |
|---|---:|---:|
| `path-occupied` | **1** (`prove-staging.ts:135`) | 14 |
| `environment` | **0 — unreachable in production** | 4 |
| `internal` | ~67 | ~32 |
| `abort-after-flip` token copy | 1 (`halt-recovery.ts:156`) | 1 |

`environment` is unreachable because the four errno-passthrough producers
(`begin.ts:268,281,310`, `finalize.ts:237`) interpolate the errno into the
*detail* string, which `phase-io.ts:22-30` sends only to the exception message
and never into the durable record. `RESERVED_PATH_CLASS_COPY.environment`
(`state-plane-detail-copy.ts:81-88`) is dead copy.

And the one producer that *does* reach `path-occupied` reaches it by accident:
`prove-staging.ts:135-136` raises `reserved-path` with
`underlyingCode: "staging-inode"`, and `reservedPathClass` returns
`path-occupied` for *any* key present in `UNDERLYING_TOKEN_COPY` — a table whose
other ten entries (`semantic-digest`, `integrity-check`, `foreign-key-check`, …)
are `verification` discriminators with nothing to do with path occupancy. The
mapping "known token ⇒ something is squatting on a path, tell the user to move
it aside" is coincidental. One shared string table is serving two unrelated
discriminator roles.

**Consumer test — can anything act on `reserved-path` alone? No.** Every
consumer re-reads `underlyingCode` immediately:

- `state-plane-report.ts:108` → re-reads at `:109` and `:113`.
- `state-plane-report.ts:137` → `if (code !== "reserved-path" || reservedPathClass(halt) !== "path-occupied") return []`.
- `state-plane-report.ts:164` → a bare `reserved-path` emits `halted:reserved-path`; the file's own comment at `:161` says a script "cannot branch on it".
- `blocksSqliteWrites` (`control-codec.ts:411`) and `isFinalIntentPromotedHalt` (`:418`) never mention it.
- `classifyHaltBucket` (`halt-recovery.ts:54-60`) reads **zero** halt codes — retryability is derived from control shape, not from the taxonomy.
- All three `RESERVED_PATH_CLASS_COPY` rows carry the **same** `machine.id`
  (`state-migration/reserved-path`), so the `--json` twin cannot distinguish
  them either.

### 3e. Halt delivery channels into the driver — three, plus a fourth shape

| Channel | Who publishes the durable halt | Sites |
|---|---|---:|
| `throw MigrationPhaseHaltError` (via `phase-io.ts`) | the driver, `authority.ts:190-211` | 85 `halt(` raises |
| return `{kind:"halted", durableHalt: false}` | nobody — in-process only | `cleanup-runway.ts:227,333,353,393` |
| return `{kind:"halted", durableHalt: <publish result>}` | the body itself, `cleanup.ts:221` | 1 |
| return `{kind:"corrupt"}` | translated by the driver at `authority.ts:287,360` | `retirement.ts` |

`durableHalt` is typed `false` in two unions (`cleanup-runway.ts:40,44`) and
`boolean` in two others (`cleanup.ts:48`, `authority.ts:59`). A maintainer must
know, per body, which of four channels it uses and who owns the publication.

### 3f. Per-body outcome unions the driver hand-translates — 11

`BeginOutcome`, `FlipOutcome`, `FinalItemOutcome`, `CleanupStep`,
`PreparationStep`, `RetirementStep`, `RetirementArming`, `StagingMainClaim`,
`ReserveOutcome`, `HaltPublication`, `MigrationOutcome`. All are near-isomorphic
(`{advance-with-control} | {halted} | {terminal}`). `ReserveOutcome`
(`reserve.ts:44`) uses `status:` where all others use `kind:`. Roughly 90 lines
of `authority.ts` `dispatch`/`cleanupPhase` are shape translation, with the
identical `if (x.kind === "halted") return {kind:"halted", halt: x.halt,
durableHalt: x.durableHalt}` written four times in `cleanupPhase` alone
(`authority.ts:373-383`).

### 3g. Duplicated filesystem leaf primitives

| Primitive | Copies | Divergence |
|---|---:|---|
| create-exclusive-or-adopt-then-prove | **6** (`finalize.ts:225`, `cleanup-runway.ts:116`, `control-sibling.ts:143`, `begin.ts:259`, `import-json.ts:99`, `genesis.ts:141`) | 4 occupant policies, 4 refusal channels |
| in-place rewrite on a recorded inode | **6** (`finalize.ts:282`, `cleanup-runway.ts:160`, `control-sibling.ts:264`, `begin.ts:296`, `import-json.ts:160`, `genesis.ts:272`) | 2 omit `O_NONBLOCK`; short write encoded 2 ways |
| sha256-hex one-liner | **6 names + 5 inline** | none — identical |
| `fsyncDirectory` (sync) | **4** (`artifact-proof.ts:37`, `cleanup.ts:70`, `control-sibling.ts:52`, `backup/publish.ts:22`) | none — identical |
| `sameInode`/`sameClaim` | **3** + ~16 inline `dev`/`ino` comparisons | (2) and (3) byte-identical |
| `isOutOfSpace` | **2 fns + 3 inline** | none — identical |
| sidecar suffix list | **8** | none — all complete |
| "is this path absent" errno policy | **2 contradictory** | `ENOENT` vs `ENOENT\|\|ENOTDIR`, each defended in comments in different files |

The repo's own `duplicate-declarations.test.ts` cannot see any of this: its
`DECLARATION` regex requires `export`, and five of the six sha256 helpers, the
private `isOutOfSpace`, and `sameClaim` are file-private or renamed.

### 3h. Observation reuse — MEASURED, and partly a finding

This is the one subsection backed by a real traced run rather than by greps.

**Method.** `scripts/snapshot-replay/run.ts:93-96` already straces both children
with `trace=%file`. The harness was run unmodified against a real 81,125,444-byte
legacy `.rbox/state.json`: exit 0, 8 steps, 37 s, fidelity pass, isolation clean.
Because `%file` omits `read`, a second unmodified run was traced with
`strace -f -y -e trace=%file,read,pread64`. Resulting DB 261,824,512 B, 18 durable
control revisions. Scratchpad only; nothing written to the repo.

**Measured amplification.** Product code streams in 64 KiB chunks
(`artifact-observation.ts:23`) and SQLite in 4096 B, so passes are attributable
by chunk size.

| Path | Size | `openat` | Whole-file digest passes | Bytes read |
|---|---:|---:|---:|---:|
| `.rbox/state.json` | 81.1 MB | 61 | **26** | 2,109.5 MB |
| `state/state.db` (active) | 261.8 MB | 32 | **4** | 1,047.2 MB |
| `state.db.migrate.<id>` | 261.8 MB | 14 | **2** | 523.6 MB |
| `legacy-json/<sha>.json` | 81.1 MB | 6 | **2** | 162.3 MB |
| `legacy-json/pre-163-latest.json.bak` | 81.1 MB | 7 | **2** | 162.3 MB |

**≈4.0 GB of product-level observation reads over 343 MB of distinct bytes —
11.7× amplification.** The per-iteration motif, repeating after every control
revision, is two back-to-back full 81 MB SHA-256 passes under one lock hold:

```
open state/migration-v1.json    readCanonicalControl
open state.json                 classifyStateFormat     (classifier.ts:97)
open state.json                 observeLegacyAuthority  → READ 81.1 MB
open state/migration-v1.json
open state.json                 bracketSource           → READ 81.1 MB
```

**Two prior hypotheses are falsified by the trace:**

- **There is no directory sweep** anywhere in the migration lane. `readdir`
  appears only in `reset-lineage.ts:101` and `sqlite-contract/helpers.ts:16`,
  neither on this path. What the brief called a sweep is `observeSidecars`
  (`artifact-observation.ts:80`), a fixed 3-name probe: 8 invocations, 24
  `openat`, negligible.
- **`observePath` is well *designed* but not well *owned*.** It has 31 production
  call sites in `migration/`, but there are also **~29 raw `fs.openSync`/`fs.open`
  sites across 13 files** in that directory (`control-sibling.ts` 5,
  `cleanup-runway.ts` 4, `legacy-backup.ts`/`import-json.ts`/`finalize.ts` 3
  each). An earlier static read of this audit claimed the primitive was the
  funnel for essentially all of `migration/`; the trace shows otherwise. This
  strengthens §4 P-4 rather than weakening it.

**Required — do NOT cache across these.** The split the skill asks for:

- `authority-flip.ts:306` → `renameSync` at `:347`. The last-instant re-read with
  nothing between the comparison and the rename is the module's stated whole
  point (header lines 10-15).
- `begin.ts:78` `freshSource`. Documented at `:70-76`: admission deliberately
  waits a bounded quiet interval, so the classifier's witness is exactly as old
  as that wait. A real elapsed-time boundary.
- The classifier proof vs the flip proof on the post-rename resume row —
  separated by a durable publication and a possible restart.
- Every per-iteration re-classification. That is the crash-resume model: the
  driver holds no state across a durable transition, so a kill anywhere
  re-enters through `classify` and converges (222 §8, lane 5A inheritance).

**Waste within one phase, where nothing could have changed:**

1. **~8 duplicate 81 MB digests ≈ 650 MB** — the classifier and `bracketSource`
   (`phase-io.ts:64`, called from `begin.ts:166`, `import-json.ts:58`/`:182`,
   `prove-staging.ts:124`, `finalize.ts:146`/`:324`), same iteration, same held
   locks, zero intervening mutation. The classifier's own comment
   (`classifier.ts:89-92`) says its reads are "mutually consistent … so a later
   wave's mutators can act on this row without re-observing" — **the mutators
   re-observe anyway.** The intended reuse was designed and then not taken.
2. **4 full 262 MB DB digests ≈ 1.0 GB** (`classifier.ts:182`,
   `finalize.ts:164`/`:170`, `authority-flip.ts:108`) inside the frozen window
   whose frozenness is the stated reason the physical witness is trustworthy.
3. `observeStagingMain` twice per M2 iteration with identical arguments
   (`classifier.ts:152`, `import-json.ts:185`).
4. `observeQSibling` up to three times per M5 iteration (`classifier.ts:158`,
   `finalize.ts:327`, `authority-flip.ts:292`).
5. `proveResource` (`authority-flip.ts:137`) hand-rolls `observePath`'s
   open/fstat/digest instead of extending it — a seventh copy for §3g.
6. `revalidateBackups` (`:90`) re-digests both 81 MB backups that
   `preserveSource` already verified in the same lock hold.

**Cost: a concept-count issue, not a perf issue at current sizes.** SHA-256
measured at 2.25 GB/s on this host, so 4.0 GB of digesting is **≈1.8 s of CPU in
a 37 s migration (~5%)**, page-cache-warm, once per workspace. Two caveats worth
recording: on a cold cache or a network filesystem, 4 GB of re-reads at
~100 MB/s is ~40 s of pure re-read; and amplification is linear in document size,
so an 800 MB document turns 1.8 s into ~18 s of duplicate hashing.

**Verdict: no dedicated cycle, but two items fold into existing ones.** The
digest duplication is not worth a cycle of its own and must not be "fixed" by
caching across a phase boundary. What it does justify: item 5 folds into Cycle 3
(P-4's leaf), and the correctness smell below (D-5) folds into Cycle 3b. The
measurement itself should become 5C's duration-budget baseline (§8 P-2).

**Separate memory finding.** `parseAdmittedSource` (`import-json.ts:235`) and
`sampleStateFile` (`last-writer-witness.ts:155-170`, via `handle.readFile()`)
each pull the whole 81 MB document into a single Buffer, while `observePath`
correctly streams. Peak RSS scales with document size in two places that need
not — relevant because `memory-admission` is a halt code this machine raises.

### 3i. Adapter discipline

| File | Verdict |
|---|---|
| `doctor-state-plane.ts` | **Reconstructed orchestration.** Second authority on workspace state. |
| `upgrade-state-window.ts` | **Has policy.** String-parsed taxonomy, severity policy, remedy rewrite, ungated inline copy. |
| `state-plane-cmd.ts` | **Has policy (mild).** Exit codes and progress rendering are adapter-appropriate; the duplicated error ladder is not. |
| `state-plane-copy.ts`, `state-plane-detail-copy.ts` | Clean — words only, `satisfies`-gated. |
| `state-plane-report.ts` | Clean owner. Two leaks: it does fs I/O (`:173-181`), and its happy-path copy is inline, outside the gate. |
| `adapters/whole-state-compat.ts` | **Clean — the model.** |
| `adapters/{sqlite-state-save,read-only,legacy-json-publication}.ts` | Clean. |
| `adapters/legacy-json-store.ts` | Has policy, correctly — it *is* the legacy backend. |

Duplicated across adapters:

- **The error-translation ladder**, written twice: `state-plane-cmd.ts:68-86`
  and `upgrade-state-window.ts:95-106`. Same five arms, same order, neither
  exhaustive-checked. `state-plane-cmd.ts:85` falls through to a bare
  `throw error` — so a new typed state-plane error reaches `rbox migrate` as a
  stack trace, which is precisely what the module header at `:56-58` says the
  file exists to prevent.
- **The three-step composition**, written twice: `withStatePlaneLocks` →
  `establishStateAuthority(root, {entry, locks}, runMigration)` →
  `describeAuthorityOutcome`, plus the `held ? … : describeLockRefusal` branch
  (`state-plane-cmd.ts:66-67,99-101` vs `upgrade-state-window.ts:90-94`). There
  is no domain function meaning "run the authority pass and give me a report";
  both entry points assemble it.
- **Two classifiers of "is a migration unfinished here"**, on different
  evidence: `doctor-state-plane.ts:117-175` (raw files) vs
  `upgrade-state-window.ts:69-76` (severity + rendered strings).

**The doctor divergence is a live correctness defect, not a style note.**
`checkStateMigration` (`doctor-state-plane.ts:117-176`) has three buckets
against the classifier's 14 rows. Two provable failures:

1. **Post-flip (`m6-cleanup` / `m7` rows).** In one `rbox doctor` run,
   `checkState` (`:40-45`) reports the workspace healthy on the new format,
   while `checkStateMigration` (`:142-157`) reports "part-way through" with the
   safety line *"The records rbox is using right now are the ones it was already
   using."* That is **false after `Q`** — the flip has already elected SQLite.
   The domain's renderer would never say it.
2. **Retirement (`retirement-cursor` row).** A control with `retirement !== null`
   and no halt is a migration being *thrown away* (`classifier.ts:135`). Doctor
   reports it as `converting … part-way through — <phase>`, narrating forward
   progress through a rollback, and hints `rbox migrate`.

Both findings (`state-migration/in-progress`, `state-genesis/unfinished`) are
authored inline with problem/safety/command, and appear nowhere else in the
tree — they are outside the `satisfies` merge gate that `state-plane-copy.ts`
exists to be. **There is no compile-time gate on this file at all:** add a row
to `MigrationObservation` and `authority.ts:299`'s `assertNever`, `ROW_DISPATCH`,
and the copy tables all fail to compile — `doctor-state-plane.ts` compiles
unchanged and keeps reporting "in-progress".

---

## 4. Proposed Module / Interface / ownership map

Four changes. Everything else keeps its current owner.

### P-1 `migration/health.ts` — the halt taxonomy becomes actionable

| Field | Value |
|---|---|
| **Owns** | What a halt *is*, at the resolution a consumer can act on |
| **Must never own** | Copy, retry policy (that is `halt-recovery.ts`'s control-shape classification), phase |
| **Interface** | `MigrationHaltCode` split so `reserved-path` becomes `path-occupied`, `artifact-identity`, `environment`, and a first-class `internal-corruption`; `underlyingCode` narrowed to a closed token union |
| **Absorbs** | `ReservedPathClass` and `reservedPathClass()` — the render-time reconstruction disappears into the record |
| **Evidence** | 1-for-69 render accuracy today; one dead copy row; identical `machine.id` across three remedies; no consumer can branch on the code |
| **Validation** | `satisfies Record<MigrationHaltCode, …>` already forces copy for each new code; add a durable-record compat fixture (§8) |

Note the durable-schema consequence, which is what makes this a *cycle* and not
a patch: `control-codec.ts:41-46` validates `code` against a closed allow-list,
so a released binary that reads a control written by a newer one must be
considered. See §8 C-1.

### P-2 `migration/` — one halt channel, one publisher

| Field | Value |
|---|---|
| **Owns** | Delivery of a halt from a phase body to the driver |
| **Must never own** | Which halt; that stays with the body |
| **Interface** | One `PhaseOutcome<L>` = `{advanced: L} \| {halted: MigrationHalt} \| {terminal: …}`; bodies raise, `authority.ts:190` publishes, always |
| **Absorbs** | 11 near-isomorphic per-body unions; `cleanup.ts:221`'s self-publication; `retirement.ts`'s `{kind:"corrupt"}`; the four `durableHalt` declarations |
| **Evidence** | 20 construction sites, 3 delivery channels, ~90 lines of translation in one driver |
| **Validation** | Differential: the driver's outcome for every §5.2 row must be byte-identical before/after |

### P-3 `state-plane/` — one workspace-state query the Adapters share

| Field | Value |
|---|---|
| **Owns** | "What state is this workspace in, and what should a person be told?" |
| **Must never own** | Mutation. This query is read-only, file-level, **never a SQLite open** (163 v13) |
| **Interface** | `describeWorkspaceMigrationState(root): OperatorReport` — one lock-free, file-level projection of `classifyMigrationState`'s 14 rows; plus one `runStatePlaneAuthorityPass(root, entry)` that owns the lock→dispatch→report composition and the error ladder |
| **Absorbs** | `doctor-state-plane.ts:117-176`'s classifier and its two inline findings; `upgrade-state-window.ts:47-51`'s string taxonomy and `:109-127`'s inline report; both copies of the error ladder |
| **Evidence** | 2 provable doctor divergences; 2 ungated finding ids; a taxonomy re-derived from rendered text with zero type checking |
| **Validation** | A row×surface matrix: each of the 14 rows, asserted to produce a consistent verdict from `rbox migrate`, `rbox doctor`, and the upgrade window |

`doctor-state-plane.ts` and `upgrade-state-window.ts` then become what they
should be: `finding` and severity translation, nothing else.

### P-4 `state-plane/fs-leaf.ts` (new, small) — the claim/rewrite primitive

| Field | Value |
|---|---|
| **Owns** | Create-exclusive-or-adopt, prove-the-inode, rewrite-in-place, fsync file+parent, no-follow discipline, `dev`/`ino` equality, sha256-hex, `isOutOfSpace`, the sidecar suffix list |
| **Must never own** | Any halt code, any phase, any control record. It returns a discriminated result; callers map it to their own refusal channel |
| **Interface** | `claimPath(...) → {ok: Inode} \| {occupied: Occupant} \| {errno: string}`; `rewriteRecorded(...)`; `fsyncFileAndParent`; `sameInode`; `sha256Hex`; `SQLITE_SIDECARS` |
| **Absorbs** | 6 claim copies, 6 rewrite copies, 6 sha256 helpers, 4 sync `fsyncDirectory`, 3 `sameInode`, 5 `isOutOfSpace` sites, 8 sidecar lists |
| **Evidence** | §3g; and three latent defects that exist *because* the copies drifted (§5) |
| **Validation** | Per-copy differential + the existing crash rig; the refusal channel must be a parameter, never a mode flag |

**The 5A objection is answered, not overruled.** PR #607 declined to merge
`claimSibling`/`claimSlot` because the refusal channel differs and "a shared body
parameterized over both the refusal channel *and* the propagation policy is a
worse abstraction than two honest copies". That is correct *for two copies*.
There are **six**, plus six rewrite twins, and the divergence has already
produced defects. The resolution is not to parameterize over the refusal
channel — it is for the leaf to **return** a result and let each caller map it,
which removes the parameter entirely.

---

## 5. Reachability candidates, with proof state

Nothing here is approved for deletion. Static reachability is not proof; each
row states what proof is still missing.

| Candidate | Anchor | Proof state | Recommendation |
|---|---|---|---|
| `record-oversize` halt code | `health.ts:18`, copy `state-plane-copy.ts:125`, codec `control-codec.ts:42` | **Zero producers in `src/`.** 222:1736 assigns it to M3 as *unimplemented*. | **DO NOT DELETE — it is unbuilt, not dead.** Either implement it in M3 or record an explicit product decision to drop the requirement. Deleting it silently would remove a specified refusal. |
| `MIGRATION_HALT_COPY["source-changed"]` | `state-plane-copy.ts:151` | Nothing constructs a `MigrationHalt` with this code. It exists as a retirement *reason* rendered through `MIGRATION_DISPOSITION_COPY` (`state-plane-report.ts:208`). 222 §5.1 says it is expressible "only as a retirement-cursor halt". | **Unreachable copy, but the code is protocol-specified.** Needs a product decision on whether the retirement-cursor halt is still intended. Preserve until then. |
| `RESERVED_PATH_CLASS_COPY.environment` | `state-plane-detail-copy.ts:81-88` | **Unreachable**: no producer sets an errno-shaped `underlyingCode` on `reserved-path`. | Do not delete — it becomes reachable and correct under P-1. |
| `sameClaim` | `store/open.ts:231-233` | Byte-identical body to `genesis.ts:386-388`'s `sameInode`, same param type. | Safe to fold into P-4. Lowest-risk item in this audit. |
| `PhysicalProof` double declaration | `store/artifact-proof.ts:24` and `:66` | The repo's own gate calls it "REAL DUPLICATE, pending removal"; both declarations present and byte-identical, silently merged by TypeScript. | Already scheduled by the repo. |
| `stateReservePath` | `reserve.ts:27-28` | Re-derives `migrationPaths.reserve` (`paths.ts:42`). Confessed in `duplicate-declarations.test.ts:165`. | Already scheduled. |
| `doctor-state-plane.ts:35` | — | Computes `path.join(root, ".rbox", "state.json")` by hand and calls `statePath(root)` on the next line. | Gratuitous; folds into P-3. |

### Latent defects found (each is a bug report, not a refactor)

| # | Defect | Anchor |
|---|---|---|
| D-1 | The crash rig re-encodes the 58-byte authority marker itself (`` `${MAGIC}\n${id}\n` ``), skipping the owner's length assert and `[0-9a-f]{32}` charset check. If the format ever changes, the rig keeps producing bytes production rejects and **silently stops witnessing the real format**. | `reset/crash-rig-child.ts:33` vs `authority-marker.ts:25-31` |
| D-2 | Two of the six in-place-rewrite opens omit `O_NONBLOCK`, which the rest of the corpus treats as contract against the #556 FIFO-hang shape (`authority-marker.ts:62-66`). Not reachable today (both paths are id-scoped and locked). | `import-json.ts:161`, `genesis.ts:273` |
| D-3 | `assertNoSidecars` uses symlink-**following** `existsSync` where the two sibling predicates (`observeSidecars`, `inodeOf`) are no-follow — and it is the one guarding the `S0` seal that M4→M5→M6 resume depends on. | `artifact-proof.ts:60-64` vs `artifact-observation.ts:79-81`, `genesis.ts:249,260` |
| D-4 | `witness.active` is stale at M6/M7, but 222 §M-6's containment table says it is "**never**" stale. The code handles it correctly (`classifier.ts:264-273` branches to `proveActiveStore`) — the *design record* is wrong, and none of 5A's four gates covers this member. | `classifier.ts:221-243` vs 222:554-561 |

| D-5 | `observeLegacyAuthority` decides the format with `classifyStateFormat(statePath(root))` and then re-opens the **same pathname** with `observePath(statePath(root), true)` to digest it. Each open is individually `O_NOFOLLOW`, but the module's own header states the invariant the composition breaks: *"Every property of a path is decided from ONE no-follow descriptor […] a pathname lookup followed by a second one could be answered by a symlink swapped in between."* The composition violates the invariant its parts enforce — so the format verdict and the digest can, in principle, describe two different files. | `artifact-observation.ts:97-105` vs its header at `:5-7` |

D-4 is the most important of the five: the containment table is the artifact a
future author will trust, and it is wrong about one of its own rows. D-5 is the
only one found by the traced run rather than by reading — it is a real
double-pathname-lookup window, though reaching it requires an attacker able to
swap a symlink inside `.rbox/state` while the migration holds its lock bundle.

---

## 6. Requirement-challenge ledger

Questioned aggressively. **Nothing here is removed, and nothing may be removed
without an explicit product decision.** Until each decision is made, preserve
the behavior behind the proposed Interface.

| # | Requirement | Complexity cost | Usage / support evidence | Recommendation | Decision needed |
|---|---|---|---|---|---|
| R-1 | "U3 adds no halt code" (the closed 10-member taxonomy is frozen) | The whole of §3d: a second render-time taxonomy, a regex over free text, one dead copy row, 1-for-69 accuracy, three remedies sharing one `machine.id` | 163:3326 fixes the ten. 5B already worked around it rather than to it. No consumer branches on `reserved-path`. | **Reopen.** Split `reserved-path` by producer class and give internal corruption its own code. | Founder: is the ten-code union a wire contract, or an implementation guideline 163 can amend as it did in v13? |
| R-2 | `underlyingCode` is "the originating syscall or SQLite code, retained verbatim" (`health.ts:35`) | The field carries three incompatible things: 11 stable tokens, real errnos, and free-text developer sentences from four corruption factories. `state-plane-report.ts:86` then refuses to show the third kind at all. | 37 of ~69 `reserved-path` producers set it to `null`. | **Narrow to a closed token union.** Free-text detail moves to a separate, never-rendered `detail` field. | Founder: is any external consumer reading `underlyingCode` from a durable record? |
| R-3 | The stale-witness containment is prose + four source-text regex gates | `MigrationWitness` accumulates layers and never removes one, so `witness.staging` typechecks at M7. Protection is 4 gates that slice source text: `bodyOf` (`authority.test.ts:55-62`) truncates at the first column-0 `}`; G3's guard predicate (`:210`) exempts any body merely *mentioning* `witness.phase ===`; G2 depends on a literal string surviving verbatim in `authority-flip.ts:271`. | 222:161-164 names the realistic breaking edit ("hoists a source revalidation for symmetry … bricks every workspace killed between the rename and M6"). What breaks is a hard, never-retryable `StateAuthorityCorruptError` — a bricked workspace. | **Narrow the type at the phase boundary.** Make M5+ arms not inherit W4's `staging`, and drop `completion.sourceJsonSha256` past the flip. **3 call sites change** (`finalize.ts:164`, `retirement.ts:238`, `classifier.ts:187` — the latter two already phase-select). Adds zero concepts; **deletes G3 entirely** and shrinks G2. Durable schema unchanged except one line at `control-codec.ts:306-308`. | Founder: accept a type-level fix in place of two of the four regex gates? |
| R-4 | Per-phase witnesses restating shared members | Rejected alternative to R-3, recorded so it is not re-proposed: 222 refuses stored duplicates three times (`control-codec.ts:9-14,126-139`) because "a stored duplicate could only ever disagree". Removes 1 concept, adds 1. | — | **Do not pursue.** | None |
| R-5 | Recomputing stale witness members at use | **Impossible, not merely expensive.** `staging` describes a file M5's rename emptied; `source`/`sourceJsonSha256` describe a document the flip deleted. | — | **Do not pursue.** This is what makes R-3 the only honest option. | None |
| R-6 | The 400-line / 25 KiB hard file gate (`file-size.test.ts:34-35`, #599) | Two of five splits examined are line-count artifacts by their authors' own written admission (222:502-506, §M-8), and both pay with an oversized cross-split export surface: `finalize.ts` exports 9 symbols of which **6 exist only for `authority-flip.ts`**; `cleanup.ts` exports 18 of which **16 exist only for `cleanup-runway.ts`**. | Merged files would be **670** and **680** nonblank. | **Keep the gate; do not re-merge.** Add a review convention: a pair like this is **one Module in two files**, and symbols crossing the split are not public API. Consider an import-direction gate so nothing outside the pair may import them. | Founder: worth an enforced "internal to pair" marker, or is convention enough? |
| R-7 | `MigrationDriver` stays an *injected* function into `establishStateAuthority` | One indirection whose only production caller passes `runMigration` | 5A's stated reason (`authority-bootstrap.ts:30-36`) is that it lets the coordinator's tests drive the C8 re-inspect without a whole migration. That is a real testing seam. | **Keep.** Genuine variation, correctly justified. | None |
| R-8 | Doctor takes no lock, so it "cannot tell a live migration from an abandoned one" (`doctor-state-plane.ts:135-141`) | This is the stated justification for the hand-rolled 3-bucket classifier | The reasoning is sound and must be preserved — but it argues for a **lock-free domain query**, not for a second classifier. | **Preserve the no-lock property; move the classification into P-3.** | None — this is a design fix, not a product cut |

---

## 7. Ranked migration cycles

Five, ranked by how much they reduce what a maintainer must understand. Each is
one behavior-preserving slice. **None is approved work.**

---

### Cycle 1 — Make the halt taxonomy actionable (`reserved-path` → four codes)

**Leverage: highest.** One code owning ~69 producers across 8 condition classes
is the single largest source of "no consumer can act on this", and it has
already forced a wrong-by-construction second taxonomy into the copy layer.

**Reduces:** one code with 8 meanings → four codes with one meaning each. Deletes
`ReservedPathClass`, `reservedPathClass()`, `looksLikeErrno`'s use as a
classifier, and the coincidental `UNDERLYING_TOKEN_COPY` ⇒ `path-occupied`
coupling. Makes `RESERVED_PATH_CLASS_COPY.environment` reachable and correct.
Gives the `--json` twin three distinguishable `machine.id`s where it has one.

**Blocked on:** R-1 and R-2 product decisions. **Must wait for 5C** — it changes
a durable record schema and 5C owns the no-regression harness and the
dual-binary differential that would prove the change safe.

**Gate:** §8 C-1 (durable-record compat), D-1 (copy differential over every
producer), plus a new test asserting each producer class reaches its own remedy.

---

### Cycle 2 — One workspace-state query; doctor and the upgrade window stop re-deriving

**Leverage: highest for correctness.** This is the only cycle that fixes a
user-visible falsehood shipping today.

**Reduces:** three classifiers of "is a migration unfinished here" → one. Two
copies of the error ladder → one. Two copies of the lock→dispatch→report
composition → one. Deletes two ungated finding ids and one inline `OperatorReport`
constructor, bringing both under the `satisfies` merge gate. Removes
`upgrade-state-window.ts:47-51`'s prefix-matching of rendered strings.

**Fixes:** the post-flip false safety line; the rollback narrated as forward
progress; the remedy-discarding rewrite at `upgrade-state-window.ts:75`; the bare
`throw error` at `state-plane-cmd.ts:85`.

**Preserves:** doctor's no-lock property (R-8) and the 163 v13 no-SQLite-open
rule — the new query is file-level, exactly like `assertAuthorityWritable`.

**Can run concurrently with 5C?** **Yes, with coordination.** It touches no
durable format and no phase body. But 5C authors doctor-surface fixtures, so the
two lanes will collide in `doctor-state-plane.test.ts` — sequence it either
before 5C starts or after it lands, not alongside.

**Gate:** §8 D-2 (14-row × 3-surface matrix), plus an import-graph gate proving
the new query reaches no `bun:sqlite`, modeled on
`authority-bootstrap.test.ts:434-450`.

---

### Cycle 3 — One filesystem leaf (and the three defects it closes)

**Leverage: high, risk: low.** Six copies of one primitive, and every latent
defect in this audit lives in the gaps between them.

**Reduces:** 6 claim + 6 rewrite + 6 sha256 + 4 fsyncDir + 3 sameInode + 5
`isOutOfSpace` + 8 sidecar lists → one leaf. Closes D-1, D-2, D-3, **D-5**. Gives
"is this the recorded inode" an owner (currently ~16 inline comparisons).

**The trace sharpened this cycle's justification.** §3h found ~29 raw
`fs.openSync`/`fs.open` sites across 13 files in `migration/` alongside
`observePath`'s 31 — the primitive is well designed but not well owned, which is
the precise condition P-4 exists to fix. Two extra items fold in here:
`proveResource` (`authority-flip.ts:137`) hand-rolls `observePath`'s
open/fstat/digest and should extend it instead; and D-5's double pathname lookup
in `observeLegacyAuthority` is fixed by giving the leaf a "classify and digest
from one descriptor" operation, which is what its own header already demands.

**Answers 5A's #4 objection** by removing the parameter rather than adding one:
the leaf returns a discriminated result and each caller maps it to its own
refusal channel. The two contradictory absent-errno policies (R-6's cousin: `ENOENT`
vs `ENOENT||ENOTDIR`, each defended in comments in different files) get one owner
and an explicit per-path decision.

**Can run concurrently with 5C?** **The cheap half, yes.** Split it:

- **3a (concurrent):** sha256, `fsyncDirectory`, `sameInode`/`sameClaim`,
  `isOutOfSpace`, `SQLITE_SIDECARS`. Zero behavioral risk, purely mechanical,
  each is a byte-identical body today.
- **3b (must wait):** the claim/rewrite leaf and D-1/D-2/D-3. These touch crash
  semantics and the rig; 5C owns the crash-rig sweep.

**Gate:** §8 D-3 + CR-1. 3b additionally needs the full crash-rig sweep, which
is 5C's deliverable — which is why it waits.

---

### Cycle 4 — One phase-outcome shape; one halt publisher

**Leverage: medium-high.** Collapses 11 unions and 3 delivery channels into one
contract, deleting ~90 lines of translation from the driver and removing the
per-body question "who publishes this halt?".

**Reduces:** 11 outcome unions → 1 generic `PhaseOutcome<L>`. 3 halt channels →
1. 20 `{kind:"halted"}` construction sites → a handful. 4 `durableHalt`
declarations (two typed `false`, two `boolean`) → 1.

**Watch item:** `cleanup.ts:221` publishes its own halt, and `cleanup-runway.ts`
deliberately returns `durableHalt: false`. That asymmetry may encode a real
constraint about the M6 runway (the halt must land in the same publication that
clears — 5A debt #5). **Verify before collapsing**; if it is real, it becomes an
explicit seam rather than an implicit per-body convention.

**Can run concurrently with 5C?** **No.** It rewrites every phase body's return
type, which is exactly the surface 5C's F2/F3/F5/F6 fixtures and abort
differential are written against.

**Gate:** §8 D-4 (driver-level differential over all 14 rows) + CR-1.

---

### Cycle 5 — Narrow the witness type at the phase boundary

**Leverage: medium, and it deletes a gate rather than adding one.** The best
cost/benefit ratio in the audit: **3 call sites**, one line of schema change,
zero new concepts, and G3 (`authority.test.ts:207-218`) disappears entirely.

**Reduces:** a record with conditionally-valid-by-row members → a record whose
type says what is valid. Replaces two of four brittle source-text regex gates
with type errors. What it prevents is a bricked workspace (§5 D-4, R-3).

**Also:** correct 222 §M-6's containment table, which is wrong about
`witness.active` (D-4). That correction is a docs-only change and should land
immediately, independent of the code change.

**Can run concurrently with 5C?** **The doc correction, yes — today.** The type
change: **no**, it touches the durable witness accumulation and 5C owns the
crash/resume matrix.

**Gate:** §8 C-1 + D-5. The old and new witness must serialize identically —
this is a type-level change with a one-line schema consequence, and the durable
bytes must not move.

---

### Ranking summary

| # | Cycle | Leverage | Concurrent with 5C? |
|---|---|---|---|
| 1 | Halt taxonomy: `reserved-path` → four codes | Highest (concept count) | **No** — durable schema |
| 2 | One workspace-state query; adapters stop re-deriving | Highest (correctness) | **Yes, sequenced** — collides in doctor fixtures |
| 3a | Trivial leaf consolidation (sha256, fsync, sameInode, …) | High / zero risk | **Yes** |
| 3b | The claim/rewrite leaf + D-1/D-2/D-3/D-5 | High | **No** — crash rig |
| 4 | One phase-outcome shape, one halt publisher | Medium-high | **No** — rewrites every body |
| 5 | Narrow the witness type at the phase boundary | Medium, deletes a gate | Doc fix **yes, now**; type change **no** |

---

## 8. Gates each cycle needs

### Compatibility

- **C-1 (Cycles 1, 5).** A corpus of durable `MigrationControl` records written
  by the pre-change binary, decoded by the post-change binary and vice versa.
  `control-codec.ts` is strict — unknown/extra/missing fields REJECT — so a
  changed halt-code allow-list is a wire-format change. Must be run against the
  signed 1.11.0 dual-binary rig (222 §7.6), not only in-process.
- **C-2 (all).** The `--json` `outcome` strings are consumed by a rig and by
  `upgrade-state-window.ts`. Any change to them is a contract change and needs
  the twin updated in the same commit.
- **C-3 (Cycles 1, 2).** Copy bar is four external users, two non-technical
  (prod customer rule). Every changed message re-read against 222 §6's standard:
  every `command` is real and non-interactively twinned; never advise deleting
  `Q`; never advise restoring a backup.

### Differential

- **D-1 (Cycle 1).** For each of the ~69 `reserved-path` producers, assert the
  rendered `OperatorReport` before and after. The *intent* is that ~67 of them
  change — so this gate is a reviewed change ledger, not a no-diff assertion.
- **D-2 (Cycle 2).** 14 classifier rows × 3 surfaces (`rbox migrate`,
  `rbox doctor`, upgrade window). Every cell asserted for a consistent verdict.
  The post-flip and retirement-cursor cells are the two that fail today and are
  the regression tests for the fix.
- **D-3 (Cycle 3).** Per-copy differential: each of the 6 claim and 6 rewrite
  sites, old vs new, over occupied / absent / wrong-inode / symlink / FIFO /
  short-write / ENOSPC / EACCES / ELOOP inputs. The FIFO case is D-2's
  regression test and must be *added*, not merely preserved.
- **D-4 (Cycle 4).** Driver-level: every §5.2 row and every §5.3 non-phase row,
  asserting the identical `MigrationOutcome` before and after — including
  `durableHalt` on every path.
- **D-5 (Cycle 5).** Byte-identical serialization of every witness phase before
  and after the type narrowing.

### Crash

- **CR-1 (Cycles 3b, 4, 5).** The full crash-rig sweep (`reset/crash-rig-*`),
  plus 5A's driver kill matrix re-walked: a kill in every window between a body
  completing and the driver acting, asserting the same re-entry row converges.
- **CR-2 (Cycle 3b).** Fault injection at each new leaf boundary — short write,
  ENOSPC mid-write, inode swapped between the two opens — proving the refusal
  channel each caller maps to is unchanged.
- **CR-3 (Cycle 1).** "A failed halt publication is the final mutation of the
  trace" re-proved by fault test with the new codes.

### Performance

- **P-1 (Cycle 2).** `assertAuthorityWritable` runs on **every** SQLite save.
  Baseline it before and after; the new workspace-state query must not be
  reachable from that path. Enforce with an import-graph gate, not a benchmark.
- **P-2 (Cycles 2, 3).** Migration duration budget (222 §5C) measured on the
  snapshot-replay harness before and after. **A baseline now exists** (§3h):
  81.1 MB source → 261.8 MB DB, 8 steps, 37 s, ≈4.0 GB of product-level
  observation reads over 343 MB of distinct bytes (11.7×), ≈1.8 s of SHA-256.
  Check it in. Amplification is linear in document size, so the same run on an
  800 MB document is the case to watch; a cold cache or network filesystem turns
  the same 4 GB into ~40 s.

### Structural (all cycles)

- The existing `file-size.test.ts`, `duplicate-declarations.test.ts`,
  `authority.test.ts` gates, and the `satisfies` copy tables must all stay green.
- The `duplicate-declarations.test.ts` `DECLARATION` regex should be widened to
  see non-exported and renamed declarations, or it will keep missing exactly the
  duplication Cycle 3 exists to remove.

---

## 9. What is explicitly NOT approved for deletion or retirement

Stated plainly so no later cycle reads this audit as permission.

1. **`record-oversize`.** Zero producers, but 222:1736 records it as an
   *unimplemented* M3 refusal. It is unbuilt, not dead. Implement or make an
   explicit product decision — never delete silently.
2. **`source-changed` as a halt code, and its copy row.** 222 §5.1 specifies it
   as expressible on the retirement cursor. Unreachable today; the protocol says
   it should be reachable. Preserve pending a decision.
3. **`RESERVED_PATH_CLASS_COPY.environment`.** Unreachable only because of the
   defect Cycle 1 fixes. It becomes correct, not dead.
4. **Any halt code, refusal reason, disposition, or observation row.** The
   taxonomy may be *split* under Cycle 1; nothing may be dropped.
5. **The four stale-witness gates** (`authority.test.ts:142-233`). Cycle 5 may
   delete G3 and shrink G2 **only** after the type narrowing makes them
   redundant by construction — never before, and G1/G4 stay.
6. **`MigrationDriver` injection** (R-7). A real testing seam.
7. **Doctor's no-lock property** (R-8). The hand-rolled classifier goes; the
   reason it exists is preserved.
8. **The 400-line file gate**, and all five split pairs. No re-merges — see R-6.
   `genesis`/`genesis-intent` in particular protects an executable
   import-graph safety property (`authority-bootstrap.test.ts:434-450`); merging
   it would delete a proof.
9. **`assertAuthorityWritable`'s file-level-only rule** and its no-`bun:sqlite`
   import graph. 163 v13. Not negotiable by any cycle here.
10. **Every §2 ledger row.** Commands, `--json` twins, exit codes, the durable
    control schema, the B0 witness, genesis intent, the M0–M7 machine, and
    dual-binary compatibility with signed 1.11.0.
11. **`legacy-json-store.ts`'s policy.** It is the legacy backend, not an
    Adapter over U3. Its CAS ordering, sanitization, fsync ordering, and marker
    retirement stay where they are.

---

## Appendix — method

Five parallel read-only lanes (opus), each required to open every anchor it
reported; anchors re-verified by the author for every claim that reaches a
ruling in §5, §6, or §7. Counts in §3 were measured with scripted greps over the
45-file U3 production set on `95e11017`, not estimated. Where a lane's
hypothesis was falsified (`markerBytes`, the sidecar list, three of five file
splits), the falsification is recorded in §1 rather than dropped.
