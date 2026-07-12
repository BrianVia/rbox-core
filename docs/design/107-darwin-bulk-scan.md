# Design 107 — Darwin bulk directory scan

## 1. Scope and rollout

Add an opt-in Darwin-only discovery fast path under `RBOX_SCAN_BULK=1`. The
default path remains structurally unchanged: when the flag is absent, no FFI
module initialization, `dlopen`, directory open, or bulk syscall occurs. The
fast path applies only to non-dircache-reused directories and is disabled while
the independent directory probe is active.

The optimization replaces a directory's `readdir` plus each regular child's
initial `stat` with `getattrlistbulk`. Symlink target reads, recursive traversal,
ignore handling, cache lookup, hashing, and the cache-miss post-hash `lstat`
remain unchanged.

## 2. FFI and packed record contract

`darwin-bulk-walk.ts` lazily opens `libSystem.B.dylib` once and binds
`getattrlistbulk` and `__error`. Support is memoized and fail-closed: non-Darwin
or any binding failure reports unsupported without throwing. Calls use a
24-byte little-endian `attrlist`, a reused 256 KiB buffer, and
`FSOPT_PACK_INVAL_ATTRS`, requesting returned attrs, name, device, object type,
modify/change times, access mask, file ID, and file data length.

Each invocation keeps the `ArrayBuffer` and its `Uint8Array` view referenced as
locals for the complete native call, so Bun's `ptr()` backing storage cannot be
collected while native code uses it. Records are parsed transactionally with a
`DataView`: parse exactly the returned record count; require length at least 92
and within the buffer; require the name target (relative to the field at +24)
and length to remain inside its record; and require a trailing NUL with no
empty, dot, slash, or interior-NUL name. Unknown object types are dropped, as
the existing `readdir` flatMap drops them.
The expected packed offsets are 0 length, 4 returned set, 24 name ref, 32 dev,
36 type, 40 mtime, 56 ctime, 72 access mask, 76 file ID, and 84 data length.

The returned common guard requires every requested payload bit but does not
require `ATTR_CMN_RETURNED_ATTRS` to self-report. A missing/invalid name aborts
the whole attempt; other missing common attrs, or missing returned file-group
`ATTR_FILE_DATALENGTH` for VREG, use `lstat` and reclassify that entry. Syscall,
open/close, failed fallback-stat, or malformed-record failures discard
the entire accumulated result and return `null`. The caller then performs its
ordinary listing, so partial bulk batches can never leak or duplicate entries.
The syscall reads `__error()` immediately after `-1`. Native failures log only
`getattrlistbulk errno=N` (including numeric open errno where available), with
module-level suppression after the first log and no path or entry name.

## 3. Metadata parity

For regular files, expose a narrow `FileStatLike` structural object containing
`ino`, `dev`, `size`, `mtimeMs`, `ctimeMs`, and full `mode`, plus type predicate
methods. Times use exactly `Number(sec) * 1000 + Number(nsec) / 1e6`, without
rounding. Diagnostic raw sec/nsec fields are retained for the standalone
harness. File IDs at or below `Number.MAX_SAFE_INTEGER` convert from
`BigUint64` to `Number`, matching Bun's numeric `.ino`; larger IDs use `lstat`
rather than risking loss. Mode combines
`accessmask & 0o7777` with the object-type bits (`S_IFREG`, `S_IFDIR`, or
`S_IFLNK`). Device uses signed `getInt32` and must match Bun `lstat`.

Only regular files carry bulk stats because directory/symlink metadata is not
consumed by this walk. A missing returned attribute uses real `lstat`; if that
fallback no longer describes the listed type, the entry is reconstructed from
the real stat's current type or omitted under the same supported-type policy.

## 4. Manifest integration

In the existing non-reused branch, the exact guard is:

```ts
scanBulkEnabled() && !ctx.dirProbe && bulkWalkSupported()
```

On a successful bulk listing, derive the same `DirCacheChild[]` and a local map
from file name to `BulkStat`. On `null`, execute the existing `readdir` block.
Dircache recording and probe accounting remain on the readdir path only. In the
file branch, consume the mapped bulk stat when present; otherwise execute the
existing `fs.stat`, including its current error and timing behavior. Bulk stats
feed the existing hash-cache key, manifest fields, and pending hash record. The
post-hash `fs.lstat` and `statsStableAcrossHash` comparison remain unchanged.
`PendingHash.st` and `statsStableAcrossHash` accept the narrow file-stat
contract so real Node Stats and BulkStat both typecheck without casts.

## 5. Validation

A Darwin test tree covers empty and nested directories, regular files of varied
sizes, file/dir/dangling symlinks, Unicode, spaces/dots, special permission bits
where supported, and a 5,000-entry directory. For every directory, compare
sorted bulk names/types in both directions with `readdir` and reject duplicates; for
every file deep-compare size, floating timestamps, full mode, inode, and device
with `lstat`, compare the hash-cache tuple, and require
`statsStableAcrossHash(bulk, lstat)`. Mutating a file after bulk discovery must
make the stability check false without crashing. Linux asserts unsupported and
`null`.

`scripts/bulk-parity.ts <dir>` recursively checks every supported child against
`lstat`, reports mismatches by path and field (including raw bulk sec/nsec for
timestamps), and exits nonzero on any disagreement. Required local gates are
the focused Bun test and `bunx tsc --noEmit`; the macOS harness is the ABI and
access-mask rollout arbiter because Linux CI cannot exercise the syscall.

## Review ledger

Round 1: CHANGES REQUIRED. Resolved directory-atomic fallback, exact record and
name bounds, unknown-type dropping, common and file returned-bit checks,
name-less failure semantics, narrow stat typing, raw-time diagnostics, signed
device parsing, inode precision fallback, special-mode coverage, and immediate
errno capture with suppression. Packed offsets, access-mask parity, and Bun's
u64 call representation remain explicit Mac-harness assumptions.

## Mac-validated results (2026-07-12)

Reference host: MacBook Pro (arm64), `~/Development` = 118,384 files / 23,924
dirs on APFS, Bun 1.3.14.

- **Parity, unit:** `darwin-bulk-walk.test.ts` — 20,046 asserts, 0 fail. Bulk
  `{name,type,size,mtimeMs,ctimeMs,mode,ino,dev}` deep-equal `fs.lstat`;
  `statsStableAcrossHash(bulk, lstat)` true; mid-write false.
- **Parity, real corpus:** `scripts/bulk-parity.ts ~/Development` — recursive,
  every supported entry cross-checked against `lstat`, **0 mismatches** (~110s).
  Packed offsets, access-mask reconstruction, signed `dev_t`, and the confirmed
  Bun timestamp formula (`sec*1000 + nsec/1e6`) are thus empirically correct on
  real APFS — the FSOPT_PACK_INVAL_ATTRS record layout (dirs/symlinks omit the
  file-only DATALENGTH word) is proven by short-named subdir/symlink coverage.
- **Benchmark (warm full scan, cache primed, p50 of 5):** stock **5484 ms**
  (stat 1512 + readdir 1930) → bulk **3206 ms** (stat phase eliminated, one bulk
  syscall/dir at 1447 ms). **≈42 % faster**, −2278 ms. All 118,384 files hit the
  cache with 0 re-hashes in both modes (no cache invalidation).

## Known scoping / pre-default-on gate

- **Opt-in only.** `RBOX_SCAN_BULK=1`, darwin-only. Flag-off is byte-identical
  (no `dlopen`, no syscall). This PR does not flip the default.
- **Failure mode is deferral, never corruption.** Any FFI/parse failure falls the
  whole directory back to readdir atomically. Even a bulk attr that were to differ
  from `lstat` cannot poison the cache: `HashCache.record` always stores
  post-hash `fs.lstat` values, so a divergent field only re-defers (re-hashes)
  that file each scan — bounded, self-correcting, not fleet-wide corruption.
- **Residual parity risk to close before default-on:** attrs returned *valid but
  divergent* escape the returned-bit safety net. HFS-compressed files were tested
  and are parity-clean (DATALENGTH returns the logical size, matching `st_size`).
  Still unverified: iCloud-**dataless** (`SF_DATALESS`) placeholders and
  **non-APFS** mounts (SMB/exFAT synthesized inodes). Non-APFS that lacks
  getattrlistbulk returns `-1`→readdir fallback (safe); a mount that supports it
  but synthesizes differently is the open case. Cheap hardening if needed: request
  `ATTR_CMN_FLAGS` and route `UF_COMPRESSED`/`SF_DATALESS` records through
  `childFromLstat` (shifts fileid→80, datalength→88; re-validate offsets on Mac).
- **ScanStats semantics under the flag:** bulk-statted files count in
  `filesStatted` but with ~0 `statMs` — their cost lands in `readdirMs` (the bulk
  syscall subsumes both readdir and stat). Dashboards reading these fields on a
  bulk scan should read `readdirMs` as the combined discovery cost.
- **Dircache (Layer A) composition:** the bulk path does not call
  `dircache.record`, so with `RBOX_SCAN_PRUNE` also on, bulk-walked dirs are not
  seeded into / reused from the dircache. The two optimizations target the same
  cost; composing them (record bulk children) is a follow-up.
