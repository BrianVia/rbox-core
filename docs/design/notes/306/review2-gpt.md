# 306 review 2 — aligned

The revised design and implementation are aligned. Only the accepted direct
trusted fingerprint-hit carry records `fastLookup.fingerprint.diskCtx`;
captured repos and every non-hit carry retain a fresh `repoCtxFromDisk` read.
The pre-classification memo is still cleared before capture, the state-record
fold is hoisted once, and packed-refs observation/regression behavior is
unchanged.

Independent focused execution:

- `bun test src/cli/sync-git/git-sync.test.ts -t "design 306"`: 1 pass, 0 fail.
