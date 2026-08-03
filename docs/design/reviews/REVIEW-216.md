# Review log — design 216 / 163-U1 SQLite store slice 2

The normative design is `163-state-plane-sqlite.md` v11. This file records the
bounded implementation-review loop required by `AGENTS.md`.

## Round 1

NOT ALIGNED. The reviewer ran the existing state-plane suite (39 pass, 0
fail) and identified signature-level gaps: explicit create/open separation,
byte-exact digest framing, backup no-clobber/result semantics, owner capability
semantics, adapter fixture boundaries, the disposition of two later-owned
files, full pragma policy, and the floor-Bun CI lane. The implementation note
now freezes those decisions. The existing workflow already exercises canary;
the implementation adds a focused Bun 1.3.14 contract lane.

The reviewer also required explicit golden digests, schema-column bijection,
stage tamper/oversize cases, all CAS result shapes, backup no-clobber/durability
tests, the engine import guard, and a differential runtime projection.

## Round 2

NOT ALIGNED. Empirical probes found the initial production typing absent,
reader-local pragma drift, writer configuration before foreign-file refusal,
and hostile codec inputs (`[,]`, `./a`, known `null`) incorrectly admitted.
The fold adds a narrow Bun SQLite declaration, read-only preflight, separate
reader/writer pins, checkpointing writer close, bounded schema inventory,
normative retained estimation, hostile canonical/path/null checks, explicit
digest brands/grammar/vectors, collision-safe intern lookup, genesis-domain
checks, exact proof typing, and executable slice tests.

## Round 3

NOT ALIGNED — final round; no round 4 is permitted.

The reviewer ran the store suite and typecheck successfully, then independently
reproduced two blockers: proofless repository BASE introduction and a compacted
backup whose `journal_mode=delete` conflicts with ordinary read-only authority
open. The proofless BASE path was fixed immediately after the snapshot, with a
regression test; CAS file/repository set-difference was also changed from
N-sized `.all()`/`Set` materialization to iterators plus SQL anti-join.

Residual findings are architectural rather than another patch list:

- sealed stages need id-scoped locks, no-follow identity brackets, no-clobber
  publication, one-at-a-time verification, bounded sealed cursors, and private
  database handles;
- snapshot capture/adapters need one coherent token from the first query
  through final publication;
- remaining U1 operations (telemetry binding, legacy export, purpose-bound
  materializer, stage cursors) need their cursor-first implementation;
- backup verification/open policy must distinguish closed compacted artifacts
  without weakening authority-open WAL requirements;
- nested mapping/digest differential coverage must be completed.

Per the founder cap, resolution requires a scope decision: split substrate from
the cursor-first mutation unit, rewrite the mutation seam in the current slice,
or retain a substrate-only internal checkpoint with mutation exports disabled.

## Founder resolution

Option 1 (split) was selected on 2026-07-28. U1a retains only schema/open,
codecs, authority-state and manifest digests, backup, bounded reads, read-only
adapters, and their tests. The stage/CAS/LOCAL implementation, stage-specific
digest code, mutation-only contracts/exports, and all mutation tests were
removed rather than disabled.

The proofless-BASE regression exercised transition-stage admission, not
substrate behavior, so its executable test was removed with that seam. Its
required future regression and every other round-3 mutation finding are
preserved in the worktree-root `U1B-FINDINGS.md`.

This is the scope decision required by round 3, not a fourth review round. A
bounded post-decision audit checked that the retained tree has no stage/CAS
imports or exports and that backup hashing no longer depends on stage code.

## Post-founder U1a freeze audit

This is a corrective audit of the founder-selected U1a substrate, not a fourth
design-review round. An independent Opus implementation review found 19
freeze-surface defects. All 19 were corrected in U1a; the two separately noted
manifest-chain admission invariants were recorded for the U1b writer seam.

The merge gate is now a direct-SQL differential fixture against the production
JSON loader with 513 files, 18 repository rows, 17 rows in each Git role, a
non-empty chain, complete nested recovery variants, and all extension-shape
distinctions. Two independent corrective reviewers executed code/tests. After
the staging-ownership race and AST inventory residuals were folded, both
reported ALIGNED.
