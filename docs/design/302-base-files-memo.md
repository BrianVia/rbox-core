# 302 — Base file rows follow the design-277 memo, keyed by store truth

Status: implemented; supersedes the caller-claim reuse from design 301.

## Why 301 was not enough

301 let `saveStateSource` offer its snapshot's file rows and bound the reuse to
`token.stateRevision === snapshot.stateRevision + 1`. In the daemon a push's snapshot is
routinely one revision behind (a pull saved in between), so the guard refused and the
2.4s read-back returned (`state-save slow: apply=2360 repos=2 global=none` on the first
desktop push after the 301 build). The binding was on the wrong axis: what makes the rows
reusable is not "who last saved" but "did the base plane move".

## Owner and rule

`state-memo.ts` (design 277) already retains one whole state per root under a token read
from the live lineage row. The base plane's file rows change only when a global section
lands, which is the one thing that advances `active_base_generation` (`write-packet.ts`).
So:

- `StateFreshnessToken` gains `baseGeneration` (one more column from the same row).
- `memoizedBaseFiles(root, token)` returns the retained state's `lastSyncedManifest.files`
  while lineage, stream and base generation still match, even if `state_revision` moved.
- `loadState` passes that on a memo miss; the post-save read-back passes it for a
  global-free packet after reading the post-CAS token. `loadRawStateFromStore` skips only
  the file cursor; records, meta, git projections and every token still come from the
  store and `finishProjection()` still asserts the token.
- `loadRawState` never reuses (the drift audit's fresh view is preserved; test pinned).
- Same kill switch (`RBOX_STATE_LOAD_CACHE=0`) and deletion condition as 277. Known edge
  shared with 277: a manual backup restore to the same lineage and generation with
  different rows is not detected until the next global save.

## Evidence

Copied-store profile: empty apply 96 / 80 / 75 ms (was 2.4s), independent of snapshot
staleness. Tests (`state-memo.test.ts`): repo-only save pages no file rows and equals
`loadRawState`; a foreign revision bump re-reads records but not rows; a global save pages
fresh rows; `loadRawState` always pages; kill switch pages. Corrupted-row audit test
(`save-delta.test.ts`) unchanged and green. 567 state/sync-state/push tests pass.
