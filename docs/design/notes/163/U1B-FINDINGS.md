# U1b stage/CAS seam — preserved review findings

U1a deliberately contains no stage builder, sealed-stage verifier, transition
builder, CAS writer, LOCAL-plane writer, mutation contract, or mutation test.
U1b must re-implement the seam fresh; the removed implementation is not a
template to restore.

## Required design properties

### Id-scoped locks and publication

Every building, sealing, verification, consumption, and cleanup action must be
owned by an exact stage id. Lock acquisition must be exclusive, lock lifetime
must cover the protected file-identity interval, and cleanup may remove only
artifacts proven to belong to that id. Final publication must be no-clobber.
Global directory locks and best-effort filename checks are insufficient.

### No-follow, identity-bracketed verification

Do not verify a path and later reopen it by name. Refuse symlinks and
non-regular files, open with no-follow semantics where supported, bind all
physical and logical verification to the opened file identity, and recheck
device/inode/size/mtime around hashing and SQLite reads. Publication,
verification, and consumption must fail closed on replacement or mutation.

### Private bounded cursors

Stage database handles must never escape. Expose purpose-specific cursors with
strict row and byte windows, opaque continuation tokens, deterministic order,
and explicit close/finalization. Neither accepted nor rejected CAS results may
materialize a whole stage, repository map, file set, or `SyncState`.

### Coherent snapshots

All predicates, stage bindings, transition evidence, retry projections, and
adapter output used by one operation must derive from one coherent authority
snapshot. Nested helpers must not silently open independent snapshots.
Implement either one bounded transaction/view or an optimistic token protocol
that brackets every constituent query and performs a final assertion before
publication.

### One-at-a-time stage access

Do not open every source stage concurrently. Verify, cursor, consume, and close
one stage at a time under its id-scoped lock. The CAS transaction must retain
bounded memory and bounded descriptors regardless of source-stage count.

## Regression lessons

### Proofless BASE introduction

The removed transition builder admitted a repository record that introduced
`BASE` without a validated `RepoBaseProof`. U1b must reject every BASE
introduction or change unless the exact new authority is justified by a
purpose-bound proof and bound to the transition's repository, expected
generation, source evidence, and coherent snapshot. Restore this as an
executable U1b regression test; it is not substrate behavior and therefore no
test remains in U1a.

### O(N) materialization

The removed CAS path initially used `.all()` and JavaScript `Set`
materialization for complete file/repository set-difference. Replacing those
spots with iterators and SQL anti-joins fixed examples, but did not prove the
whole seam bounded. U1b must specify and test maximum rows/bytes/descriptors
for every cursor and retry result, use indexed SQL set operations, and include
large-stage tests that fail if heap use scales with total authority size.

### Manifest-chain closure

U1b's mutation/import seam must enforce both `(chainBytes===0) ===
(chain.length===0)` and chain self-exclusion before publication. U1a only
reads already-admitted substrate rows, so these admission invariants belong
with U1b's cursor-first writer rather than being silently implied by readers.

### Ratified containment mechanism and trust boundary (round 3)

Verify-then-reopen is unrepresentable in the shipped seam. Consumption makes ONE
bounded streaming pass that simultaneously computes the physical hash and writes a
private `O_EXCL` copy inside the lock-owned private directory, so the verified
bytes and the consumed bytes are the same reads rather than two observations of a
mutable path. The copy is opened, primed with one read so SQLite materializes its
WAL index, and then unlinked together with its sidecars: from that point the
connection reads anonymous inodes that no pathname reaches, and cleanup is
automatic. There is no closing re-proof, because there is nothing left to re-prove.
Hard-linking was rejected — it shares the writable inode, so it binds a name but
not the bytes. `Database.deserialize` was rejected — a stage has no row cap, so
materializing the largest legal artifact violates the design's memory budget.

Publication is the mirror: the builder holds its own descriptor on the private
inode across fsync, hash, `link(2)`, and a post-link `fstat` dev/ino comparison
against that descriptor. A destination that is not the proven inode, or a parent
fsync that fails after a successful link, is unlinked — a destination never
survives a failed seal. Deletion pins the inode with a private hard link, proves it
through a descriptor on the private name, and unlinks the shared name only after a
fresh no-follow open of it confirms the same inode.

**Ratified trust boundary.** A same-UID actor mutating an anonymous inode behind an
open descriptor requires `/proc`-level fd introspection, which is ptrace-equivalent
and outside this design's threat model. The same boundary covers the residual
window between the identity confirmation and the unlink in the id-scoped delete,
which the id-scoped lock serializes against every legitimate writer.

## Additional round-3 constraints

- A sealed artifact must have an explicit lifecycle and exactly one active
  accessor; verification must not leak a reusable SQLite handle.
- Backup verification is a distinct artifact policy: `VACUUM INTO` produces a
  compacted `journal_mode=delete` file, so ordinary WAL-required authority
  open is not its verifier.
- Complete nested mapping and logical-digest differential fixtures remain
  necessary when U1b freezes its new stage schemas.
- Telemetry binding, legacy export, purpose-bound materializers, and mutation
  cursors must be cursor-first rather than whole-state convenience APIs.
