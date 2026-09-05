# 291 — Tracked-index cache freshness

Status: **IMPLEMENTED; focused validation passed; final independent review ALIGNED; final compiled DEV integration passed (111 assertions).** Scope is F1a in `src/engine/tracked-repo.ts`, integrated by `src/engine/ignore.ts`, plus matcher regression tests. Parent worktree: `codex/astra-sync-git`. The selected deliverable caches only positively observed ordinary indexes; split indexes retain fresh native tracked-name enumeration without caching. Full split-cache performance is explicitly deferred. No G1 changes or new wire format. Integration evidence: `notes/287/integration-validation.md`.

## Protected behavior and ownership

`loadTrackedRepoSet` in `tracked-repo.ts` remains the only owner of tracked-name cache admission. `buildIgnoreMatcher` callers receive the current `available` semantics. Unknown/corrupt/unreadable trackedness remains “possibly tracked”: do not prune or purge through uncertainty. A genuinely absent index plus the existing unborn-HEAD check yields empty trackedness; absent index with commits remains unavailable. Preserve existing native Git name parsing and linked-worktree index resolution. This work must run against a readable but non-writable Git directory: no index normalization or private file under the live Git directory is a prerequisite.

The off-the-shelf primitive is filesystem identity plus Git's own tracked-name/dependency enumeration, not a new index parser or CLI identity orchestration dependency. Keep existing cache location/transport for this slice; changing its storage to SQLite is F4 and not a prerequisite. No module or supported format is approved for deletion.

## Original fault and red regression

In the base revision, `loadTrackedRepoSet` resolves the index using `git rev-parse --git-path index`. `safeStat` and cache v1 retain only path, mtime and size. A different inode with identical size/restored mtime returns stale tracked names without enumeration.

Two red tests distinguish the required identity witnesses:

- `tracked cache rejects a same-size index replacement with restored mtime` sets the old timestamp **before warming** and restores the identical whole-second value on replacement. Bigint stat assertions prove equal `mtimeNs`, size and device, with different inode/ctimeNs; fresh Git reports `b.secret` while the cached matcher incorrectly ignores it. Nanosecond mtime alone cannot pass this test.
- `tracked cache rejects an in-place index rewrite with restored nanosecond mtime` generates a valid replacement index separately, overwrites the live bytes without replacing its inode, and restores the timestamp. Bigint assertions prove equal device/inode/size/mtimeNs and different ctimeNs. Among the proposed identity fields, ctime is the sole change witness.

Before implementation, both failed on supported Bun1.4.0 at the expected matcher result, with 18 assertions reached. Both now pass with the strengthened identity; the historical RED evidence is retained below.

## Minimal cache shape

Use a new disposable cache version with:

- Resolved absolute main-index path and lossless identity `{dev, ino, size, mtimeNs, ctimeNs}`.
- A required dependency field whose only cacheable value is positively observed `none`. No shared-index identity or referenced-dependency cache record is introduced. Absence of this field is not evidence of no dependency.
- Existing tracked names.

Use bigint stat fields serialized as canonical decimal strings, including `mtimeNs` and `ctimeNs`; never round inode/dev through an unsafe number or truncate timestamps. If the supported runtime cannot return the required identity fields, **trackedness is unavailable for that observation**: do not accept a hit or publish fresh names under an unprovable stable token. This is a source-observation failure, not a cache miss. Cache records are data, not authority: validate required fields and types before equality.

### Exact cache outcomes and overwrite policy

`cache miss` means discard cached names, proceed with fresh native discovery/enumeration and serve its result if stable. `trackedness unavailable` means return the existing `available:false` result: paths remain possibly tracked and protected from ignore-driven pruning/purge; do not enumerate or overwrite the cache in that call. It never means an empty tracked set.

| Cache condition | Outcome | Overwrite policy |
|---|---|---|
| Missing file (ENOENT) | Cache miss | May write validated ordinary v2 after stable fresh enumeration |
| Valid v1 record | Cache miss; never trust its weak identity | May replace with v2 after stable fresh ordinary enumeration |
| Valid v2 with changed identity | Cache miss | May replace after stable fresh ordinary enumeration |
| Valid matching v2, dependency none | Hit | No write needed |
| Malformed JSON/required fields, non-ENOENT read error | Trackedness unavailable for this call | Preserve file; no automatic rewrite/delete |
| Unsupported future version | Trackedness unavailable for this call | Preserve newer record; no downgrade overwrite |
| Cache write failure after valid fresh observation | Serve fresh trackedness; cache remains disposable | Remove only this invocation's owned temporary file |

A supported ordinary v2 writer may overwrite a previously observed valid v1 record after fresh enumeration. An observed unsupported future record is never overwritten by this call. This policy does not introduce a cross-version lock protocol: immutable protection against a foreign writer replacing the disposable cache after the initial read is not claimed. Such a race can at worst lose a cache record; unsupported readers still apply their own fail-open refusal.

### Round-one contract disposition

The proposal that **every cache problem must become a miss** is not accepted for F1a: it would change protected behavior rather than clarify terminology. At the base revision c4aa22bbb, `ignore.ts:809` distinguishes ENOENT miss from other read-error corruption; :813 treats unknown versions as corrupt; :815 rejects malformed paths. `loadTrackedRepoSet` at :745 maps corruption directly to `indexUnreadable()` before native enumeration. The regression `ignore.test.ts:705`, “corrupt tracked-set cache fails closed instead of falling back to an empty set,” requires an unevaluated repo, no parent pruning, and inclusion of both tracked and untracked paths after corrupt JSON. Two existing index-unreadable tests preserve the same conservative behavior.

Thus a downgrade encountering a future record does deliberately withhold ignore-driven pruning/purge for that affected repo; it does not disable sync globally or erase data. This already exists when the current v1 binary sees another version. F1a explicitly preserves it while adding the narrow known-v1 migration miss. Changing corruption/future-version handling to fresh enumeration may be separately reviewed with updated safety/compatibility tests; no such product-policy change is assumed here. No durable source/state file is deleted to recover a cache.

## Selected cache admission and enumeration algorithm

1. Retain one native index-path resolver per call, exactly as the current warm path. Do not add five-command `indexIdentityV2` orchestration or an upward engine→CLI dependency.
2. Stat the resolved main index. Preserve existing absent/committed/unborn classification before considering a cache hit. Non-regular/unreadable/error is unavailable.
3. Read/validate the cache using the existing `src/json.ts` boundary predicates, including all required fields before considering any freshness miss. Compare individual main identity fields, independent of JSON key order, and require dependency `none`. Re-stat after reading a candidate hit; use it only if the main identity is unchanged. Otherwise retry the complete observation once. A hit is usable only with the exact main identity that established no shared dependency. A stale pointer or changed main index goes through fresh discovery. Never serve names from a referenced-dependency record: this version does not produce one, and unsupported/malformed records retain the conservative cache-read contract.
4. On a miss, retain the main-index identity captured before cache reading; ask Git `rev-parse --shared-index-path`. Pin native calls with `-c core.splitIndex=true -c core.fsmonitor=false -c core.untrackedCache=keep`: repository `core.splitIndex=false` can otherwise hide an actual dependency during the native read, and a configured monitor hook must not execute. With split reads enabled, an ordinary index can return the null-OID path `sharedindex.` followed by 40 or 64 zeroes; accept this exact basename or successful empty output as none. Require every other successful nonempty output to have basename `sharedindex.` plus exactly 40 or 64 lowercase hexadecimal digits before selecting uncached split enumeration. Unexpected output is unavailable and cannot authorize a cache write. Command failure is unavailable, never an ordinary-index assumption. This uses Git to interpret the index and recognizes only its ordinary-index sentinel; no shared-file identity or index-byte parser is introduced.
5. For either successful discovery result, run read-only `ls-files -z --cached`, then stat the same main index. Accept fresh trackedness only when before/after main identities agree and enumeration succeeded. Persist a cache record only if discovery positively reported no shared dependency. For split indexes return fresh native tracked names without any cache write; do not require shared mtime/ctime equality. On main-identity drift retry the complete observation once, including resolver/dependency discovery; a second instability yields unavailable with no cache publication. Native discovery/enumeration failure retains fail-open unavailable behavior.
6. Cache writes remain best effort: create an exclusive private temporary file beside the cache, close it, and atomically rename it. On any write/close/rename failure, clean only the temporary file successfully created by this invocation and return the valid fresh observation. Never delete the source index or replace an observed malformed/unsupported cache.
7. Warm ordinary hits remain one resolver Git call plus cache/stat I/O. A cold ordinary miss adds one dependency-discovery call and one `ls-files`. Every split evaluation pays those three calls and returns fresh names; this bounded correctness cost is accepted for F1a. No split-bypass marker or new persistent mode is added. In-flight source change after return is still governed by existing observer/matcher lifetime; F3 is not authorized to extend that lifetime without its own freshness proof.

Missing-dependency case: never reuse a prior split tracked set. Native Git resolves and reads the current shared dependency on every split evaluation. If it still references a removed/corrupt shared file, discovery or enumeration failure returns unavailable. A new stable ordinary index may establish dependency `none` and cache fresh names. A missing shared file never becomes empty trackedness.

## Why split caching is deferred

A temporary real-Git probe showed `ls-files --cached` refreshes sharedindex mtime and ctime on every read, including immediately after `rev-parse --shared-index-path`. Setting `GIT_OPTIONAL_LOCKS=0` did not prevent the refresh. Strict shared before/after timestamp equality would therefore cause persistent refusals on healthy split indexes.

F1a avoids that additional witness requirement entirely: retain existing native split enumeration and strengthen main-index stability, but do not cache split names. This preserves supported trackedness without assuming shared-byte immutability, implementing a new index parser, hashing shared contents or introducing a snapshot owner. It does not claim a stronger exact-consumed-byte guarantee for split enumeration than the existing native Git behavior. Full split-cache performance requires separate measured justification and a proven dependency witness before any cache activation; it is not a prerequisite to F1a.

A local acceptance probe used a split repository with `.git` mode0555 and metadata files0444. Discovery and `ls-files` returned the expected tracked name, main-index identity stayed stable and no Git-directory names were added. Git may attempt its own best-effort shared timestamp refresh; rbox must not require write access or create any live-Git-directory temp. No normalization or five-command identity projection is part of this design.

## Validation and release gates

Ordinary regression plus in-place restamped edits, deletion/recreation, index corruption, v1 migration miss, malformed cache fail-open, write-temp cleanup and committed/unborn absence tests. Split fixtures need fresh enumeration on every evaluation, no cache writes, changed/removed dependency, pointer change, ordinary→split→ordinary transitions, linked siblings with private indexes, shared timestamp refresh, main-index churn at each read boundary and readable/non-writable Git directories. All accepted results match fresh native Git truth; refusal preserves tracked/purge safety.

Assert warm-hit subprocess count remains one resolver, cold counts are bounded, no private normalization commands, no new authoritative state and no write access to Git metadata required. Large-repository and 100-repository latency measurements remain rollout work; this slice establishes the required warm subprocess budget, not a measured speedup claim. Use existing `ignore.test.ts`, relevant manifest/purge suites, supported-runtime typecheck/oxlint and appropriate compiled rig before release. Rollback of cache freshness must disable weak hits while retaining the corruption/unsupported-version refusal table; a known supported miss can derive fresh names. An older binary seeing v2 may conservatively report trackedness unavailable rather than overwrite it. Never restore v1's weak equality as authoritative behavior. No deletion/retirement approved.

## Executed evidence

- Before implementation: `PATH=/private/tmp/rbox-bun140/node_modules/.bin:$PATH bun test src/engine/ignore.test.ts -t 'tracked cache rejects'`: expected RED,2 fail,46 filtered,18 assertions; Bun1.4.0. Both timestamp/identity preconditions passed before the intended matcher failure.
- Same supported runtime, `bun test src/engine/ignore.test.ts -t 'corrupt tracked-set cache|indexUnreadable:'`:3 pass,0 fail,11 assertions, confirming the protected refusal behavior.
- Current implementation: supported Bun1.4.0 full ignore suite passes, including both historical RED fixtures, nanosecond identity serialization, key-order-independent warm hits, v1 migration, eight malformed/future-record refusals, split transitions, missing dependency, bounded enumeration retry, cache-write failure cleanup and readable0555 Git metadata. Final focused command: `PATH=/private/tmp/rbox-bun140/node_modules/.bin:$PATH bun test src/engine/ignore.test.ts src/engine/manifest.test.ts` — **70 pass, 0 fail, 1,102 assertions**, including 68 ignore tests and two parent-owned manifest tests.
- Native call-count assertions: ordinary cold = 3, ordinary warm = 1; split = 3 each evaluation; continuous main-index drift stops after 2 attempts. A warm-cache read race retries before returning any names.
- Configured split fixture has a real shared file with `core.splitIndex=false` and an executable monitor hook; pinned reads return correct trackedness without cache creation, source-byte changes or hook invocation.
- `PATH=/private/tmp/rbox-bun140/node_modules/.bin:$PATH bun run typecheck`: clean across root, API and scripts.
- `./node_modules/.bin/oxlint src/engine/ignore.ts src/engine/ignore.test.ts`: clean, without new suppressions or JSON casts.
- Temporary native-Git split probes: main worktree untouched; shared mtime/ctime changed on `ls-files`, including with optional locks disabled. Readable0555 Git-directory probe returned fresh tracked names with stable main identity and unchanged Git-directory names. Probe repositories were temporary and isolated from the working source tree.

## Accepted identity limits

The observation token is a practical normal-writer filesystem witness, not a cryptographic proof against arbitrary metadata-forging actors. Filesystems with coarse ctime can theoretically reuse an inode and return identical size/mtime/ctime despite a delete/recreate; nanosecond fields preserve available precision but do not manufacture filesystem precision. Record this residual and include supported-filesystem fixtures. Device-number changes across reboot cause safe extra misses; distinguish those cold rebuilds from warm-path regressions. Dependency discovery preserves empty/null-OID success versus command-failure semantics; local split/missing-dependency fixtures, rather than an unverified upstream line citation, are the implementation gate.

## Round 3 owner-boundary addendum

The module-size gate prompted a complete trackedness/cache owner extraction, proposed before implementation in [the structural addendum](notes/291/owner-boundary-addendum.md). The existing `loadTrackedRepoSet` operation and typed result move intact to `src/engine/tracked-repo.ts`; ignore-rule policy and repository discovery remain in `ignore.ts`. This preserves round-2 behavior and introduces no public protocol phases. Final structural review and validation are recorded with the addendum.

Final structural review is [ALIGNED in round 3](reviews/REVIEW-291-3.md), with the root source review also aligned. The remaining compiled integration rerun is tracked by the parent task separately.
