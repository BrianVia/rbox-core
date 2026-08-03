# Review 223 — U3 Wave 1B

## Round 1 — NOT ALIGNED

The reviewer found that the request's four-observation sentence cannot describe
`adoptClaimedStateStore`: design 222 assigns those observations to
`claimStagingMain` in lane 3A and gives the adopter a `StateStoreHandle` return.
It also found that `ClaimedInode` has no merged definition.

Resolution: design 223 records the conflict, keeps migration classification out
of lane 1B, and defines the narrow `{dev,ino}` adopter input.

## Round 2 — ALIGNED

The reviewer executed the focused adopter/differential suite and typecheck. Its
first run exposed that a raw observed transition token converted stale
stream/nonce packets into `StageChangedError` before CAS. Review also found a
post-claim pathname race, overbroad caught cleanup, dangling-sidecar detection,
and exact-mode issues.

Resolution:

- transition stages bind to packet-expected stream/nonce plus observed counters;
- adopter rechecks the named inode after SQLite open and before its first write;
- caught cleanup is gated on the claimed inode still owning the main path;
- sidecars use `lstat`, and permissions compare all four mode octal digits;
- tests cover stale stream/nonce, construction/unsupported cleanup, and a
  replacement inode.

Final evidence: focused tests 13/13, typecheck pass, `git diff --check` pass.
Verdict: **ALIGNED**.
