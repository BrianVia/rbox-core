# Review log: Design 186

## Round 1 — adversarial review

**Verdict:** NEEDS REVISION

1. **BLOCKER:** collision observations were returned only after successful
   pushes, so later network/safety errors could hide them.
2. **BLOCKER:** status still diffed the raw manifest and would report a skipped
   collision as permanently pending.
3. **MAJOR:** a 422 retry replaced raw disk-path evidence with the safe commit
   candidate.
4. **MAJOR:** watcher recovery did not cover ancestor directory events.
5. **MAJOR:** setup/init, ignore, repair, mutex ownership, and writer ordering
   were not explicit.
6. **MINOR:** persisted/JSON warning bounds and count semantics were unspecified.

### Revision

- Added a mutex-held, non-throwing observation point before failure-capable push
  work.
- Made safe projection a shared pure operation for push and scan-based status.
- Split loop-carried safe candidate, raw path evidence, and collision metadata.
- Defined subtree-aware watcher invalidation.
- Added an explicit production-caller authority contract.
- Bounded persistence to 100 groups, 8 stored paths per group, and 64 KiB while
  retaining full counts and a full-observation fingerprint.

**Next:** re-dispatch the revised design.

## Implementation review — final

**Verdict:** PASS

The implementation review found and closed four additional correctness edges:

1. Deferred scans in foreground push, conflict recovery, ignore purge, and the
   daemon now preserve warning authority instead of clearing from incomplete
   evidence.
2. Warning reads and clears reject a symlinked `.rbox/state` parent, and daemon
   write deduplication compares against durable truth so foreground writers
   cannot leave a stale sidecar behind.
3. Final observation authority rides every `PushResult`, preventing a daemon
   from upgrading an incomplete scan merely because it found no known group.
4. Observation callbacks downgrade completeness before failure-capable work,
   so a failed post-409 attempt cannot make the next retry authoritative over a
   stale manifest.

The reviewer confirmed the final callback ordering, completeness transitions,
cross-writer behavior, and parent-symlink protections. No findings remain.

## Round 4 — adversarial review

**Verdict:** PASS

The reviewer confirmed that incomplete candidates preserve existing episodes,
new collision discovery forces an authoritative scan, and the combined
observation retains automatic resolution for every group. No findings remain.

## Round 3 — adversarial review

**Verdict:** NEEDS REVISION

1. **MAJOR:** an incomplete retained manifest could discover a new independent
   collision but preserve only the prior episode, leaving the new group
   invisible and outside automatic resolution.

### Revision

- An incomplete incremental candidate that discovers any new collision now
  forces a complete scan before push. The authoritative scan records both the
  preserved and newly discovered groups.
- Added multi-episode discovery and resolution coverage.

**Next:** re-dispatch the revised design.

## Round 2 — adversarial review

**Verdict:** NEEDS REVISION

1. **BLOCKER:** after a collision push filters the daemon manifest, an unrelated
   incremental event could yield zero observed groups and falsely clear the
   still-present warning.
2. **MAJOR:** scan-based status did not include forward-ignore carry before
   projection, so ignore-exposed collisions disagreed with push.

### Revision

- Added explicit daemon manifest-completeness state. Unrelated incremental
  pushes preserve an active collision observation; only a complete scan may
  clear or revise it.
- Made forward-ignore carry part of the shared local-file projection used by
  both push and scan-based status.
- Added the unrelated-edit retention and ignore-carry status tests.

**Next:** re-dispatch the revised design.
