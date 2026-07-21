# Bun ref-watch contract probe results

Date: 2026-07-20

## Outcome

**PASS.** The narrow runtime premise in `RECOMMENDATION.md` section 6 held for
all three repository-arrival/ref shapes across five attempts per case. Every
Git operation produced a Bun `node:fs.watch` callback for the exact loose-ref
target or its adjacent `.lock` within the five-second contract deadline while
an independent `@parcel/watcher` subscription was being flooded on a sibling
tree.

The harness is `scripts/probe/bun-refwatch-contract.ts`. It imports no rbox
product code and makes no runtime-version-dependent decisions.

## Environment

```text
bun --version
1.3.14

Linux 6.17.0-35-generic x86_64
git version 2.54.0
@parcel/watcher 2.5.6 (lock-selected)
```

## Command and observed result

```text
$ bun scripts/probe/bun-refwatch-contract.ts
bun --version: 1.3.14
attempts per case: 5; callback deadline: 5000ms

case                              result  attempts  callback latency  churn ops  Parcel events  callback
fast git init -> empty commit     PASS    5/5       1.9-2.2ms         7436       6              refs/heads/main.lock
atomic move-in -> empty commit    PASS    5/5       2.0-2.6ms         7144       5              refs/heads/main.lock
nested namespace refs/heads/a/b   PASS    5/5       16.6-17.3ms       10210      5              refs/heads/a/b.lock

Bun ref-watch contract PASSED (3/3 cases)
```

`churn ops` counts filesystem operations issued into the sibling Parcel tree.
`Parcel events` counts Parcel's coalesced callback entries; it is intentionally
not expected to equal the raw operation count. The lock callbacks are valid
positive pre-signals under the proposed contract. After each callback, the
harness also read the final target and verified that it contained a Git object
ID.

## Coverage notes

- The harness arms shallow `gitDir`, shallow `commonDir`, shallow
  `commonDir/refs`, and recursive `commonDir/refs/heads` plus
  `commonDir/refs/tags`. Identical shallow handles are deduplicated when a
  normal repository has `gitDir === commonDir`.
- The fast-init case starts sibling churn, performs `git init`, arms the layout,
  and makes the first empty commit.
- The move-in case builds and commits a repository outside the workspace,
  atomically renames it into the workspace during churn, arms the layout, and
  makes another empty commit.
- The nested case arms recursive `refs/heads`, creates `refs/heads/a`, waits 15
  ms, and creates branch `a/b` during churn. This exercises Bun's dynamic
  descendant-watch establishment.
- A Bun-target bundle smoke check also succeeded:
  `bun build scripts/probe/bun-refwatch-contract.ts --target=bun
  --outfile=/tmp/bun-refwatch-contract.js`.

This establishes the narrow behavior needed to proceed with the proposed
side-channel. It does not remove the recommendation's 60-second safety floor:
descriptor-add failures and queue overflow remain outside this success-path
contract.
