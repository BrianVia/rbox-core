# Copied-store profile — empty state-save apply (2026-09-05, via-desktop)

Store: `sqlite3 .backup` of `~/Development/.rbox/state/state.db` (488 MB, 198,544 entries,
seq 5737) into a scratch root; copied `sync.lock` removed. Bun 1.4.0, Linux x86_64.
Script: opens the root through the production adapter (`loadState`, `openStateStore`,
`applyStateSavePacket` with `{repos: [], no global}` and the snapshot as projection).

| step | before | after |
|---|---:|---:|
| loadState (memo cold) | 2,544 ms | unchanged |
| open writer + close | 1 ms | 1 ms |
| open reader + close | 1 ms | 1 ms |
| apply empty packet ×3 (state chained) | 2,519 / 2,338 / 2,366 ms | 104 / 83 / 83 ms |

`bun --cpu-prof` on the "before" run, top frames by total time (3 applies + 1 load):
`loadRawStateFromStore` 9.9s, `materializeManifest` 9.6s, `saveThroughStore` 7.5s,
`translateCasResult` 7.4s, `decodeFileEntry` 6.5s, `admitFileEntry` 5.8s. The three
applies were spending their entire time re-materializing the manifest after acceptance.

The "after" column reads the repo records, manifest meta and git projections back from the
store and reuses only the base file rows. An earlier draft that trusted the composer's whole
projection measured 17 / 8 / 8 ms but was withdrawn: `applyTransitions` recomposes bases
against stored provenance, so projected records are not trustworthy. Passing a stale snapshot
(one whose `stateRevision` is not exactly one behind the CAS token) falls back to the full
2.4s read-back by design; the profiler chains the returned state like `saveStateSource` does.
