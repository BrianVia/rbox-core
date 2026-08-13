# Design 237: Attribution differential canonical projection

## Problem

The pull-attribution differential runs observation disabled and enabled against
two physical copies of the same logical workspace. It must prove that receiver
attribution changes observation only: both runs choose the same actions, expose
the same error, and leave the same durable bytes. The copies necessarily have
different filesystem identities and may be scanned in different scheduler and
directory-enumeration orders. Masking one field in `snapshot()` did not model
that boundary and has flaked repeatedly.

## Protected contract

- Action kind, order, path, remote entry (including its `mtimeMs`), expected
  content identity, mode, size, and hashes remain equal. Only
  `expectedLocal.mtimeMs` is excluded because the production `FileEntry`
  contract defines that local scan observation as a fast-path hint, not content
  identity.
- Error absence/presence, constructor name, message, and semantic own fields
  remain exactly equal; only the location-specific stack is not captured.
- Every ordinary file's mode and exact bytes remain equal.
- State bytes and all non-volatile cache/witness fields remain exactly equal.
- The enabled-only attribution report and adoption phase timings retain their
  existing dedicated assertions outside the differential.

## One projection

`canonicalOutcome()` will be the sole normalization boundary, called once for
each complete run result. Raw snapshots retain exact mode and bytes. The
projection normalizes only:

- action `expectedLocal.mtimeMs`: root-local observation hint (the action's
  remote `entry.mtimeMs` is shared input and remains exact);
- last-writer `writtenAtMs`, `stateMtimeMs`, `stateDev`, and `stateIno`: physical
  publication time and inode identity of two separate state files;
- hashcache entry `mtimeMs` and `ctimeMs`: root-local stat fingerprints;
- dircache scan timestamps, entry/rule-file `mtimeMs` and `ctimeMs`: root-local
  scan and stat fingerprints;
- hashcache/dircache entry-map key order plus dircache rule/child inventory
  order: those specific maps and filesystem inventories can be produced in
  different enumeration/completion orders.

No other JSON is parsed, no other array (especially actions) is sorted, and no
error field, hash, size, mode, path, or ordinary file byte is removed. The test
no longer needs a global `Date.now` override.

## Ownership and scope

The test-local projection owns only equivalence between two independent test
runs. Production pull, state, cache, and attribution modules do not change.
There are no commands, compatibility paths, migrations, performance paths, or
supported behavior approved for deletion. No CODEMAP ownership changes.

## Requirement challenge

Comparing raw physical metadata across two separately copied roots is an
incidental requirement that contradicts the logical observation-only claim.
Comparing exact ordinary bytes and semantic durable fields remains required.

## Validation

- Target file 20 times normally, including a CPU-constrained `taskset -c 0,1`
  run.
- `bun test src/cli/sync/`
- `bun run typecheck`
- `bun run lint:affected`

Crash and released-binary compatibility validation are not applicable because
production code and formats are unchanged. The differential itself is the
compatibility gate; the repeated and constrained runs are the performance/
scheduling stress gate.
