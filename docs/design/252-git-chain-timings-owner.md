# Design 250 — Git chain timings own their accounting scheme

## Protected contract

This is a behavior-preserving extraction of design 174's `GitChainTimings`
scheme. Every timing field, timer boundary, classifier child subtraction,
exclusive-leaf attribution, and residual closure remains byte-for-byte in
meaning. Public engine exports remain compatible, Git I/O behavior is
unchanged, and the accounting additions from design 251 remain active.

## Ownership

`src/engine/git/chain-timings.ts` owns the timing record and the complete
measurement/attribution scheme behind five exports: `GitChainTimings`,
`zeroGitChainTimings`, `addTimedMs`, `addClassifyTimedMs`, and
`finalizeGitChainTimings`. Its private `GitTimedField` excludes parent and
derived fields from generic attribution. It must never own Git I/O or sync
policy.

`src/engine/git/shared.ts` keeps Git process, repository-shape, artifact, and
section primitives. It consumes the timing interface only where pack-chain
import needs attribution and does not re-export it.

## Scope and challenged requirements

No supported functionality, migration, compatibility path, or fast path is
approved for retirement. The file-size ceiling is a useful architecture
ratchet, but no new mechanism is needed: this coherent owner naturally fits
below the global gate. No new mode, flag, fallback, or durable state is added.

## Validation

- Review the moved bodies as a multiset diff; only imports and lint-required
  error-boundary typing may differ.
- Run the Git engine, sync-git, and file-size suites requested by the founder.
- Run repository typecheck and affected-file lint.
- Confirm `shared.ts` remains under its original 735 nonblank / 33479-byte
  ceiling and no ratchet entry is changed or added.

Crash, compatibility, and performance behavior are protected by move fidelity:
the extraction adds no effect, branch, allocation on an untimed path, or new
runtime boundary.
