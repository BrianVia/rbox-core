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
