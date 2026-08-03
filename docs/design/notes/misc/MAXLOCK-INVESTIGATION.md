# MAXLOCK investigation: macOS `rbox setup` false "unsupported filesystem"

Date: 2026-07-20  
Scope: read-only source analysis of the setup, workspace mutex, Darwin identity, host-identity ledger, and nested ledger-lock paths. No source changes were made.

## Conclusion

The message at `src/cli/setup-cmd.ts:782` does **not** prove that the selected workspace filesystem lacks locking. On this path, it also represents any exception while resolving or durably recording the machine identity under the rbox home directory. In particular, an ordinary I/O error from the **nested** `host-identity.json.lock` acquire is turned into an outer `status: "unsupported"`.

The ranked shortlist for a healthy APFS Mac after deletion of the actual rbox home is:

1. **`kern.bootsessionuuid` is unavailable, invalid, blocked, or repeatedly times out in the rbox execution context.** It is mandatory and was not covered by the successful `kern.uuid` check.
2. **The actual ledger directory differs from `~/.rbox` or cannot complete the nested lock/durable write.** `RBOX_HOME`, `HOME`, and the test seam affect the path. The user's hardlink test in `~/src` does not necessarily test the nested lock's actual directory.
3. **The ledger's own `.lock` acquire fails or remains held for two seconds.** A still-running rbox process, foreign/malformed lock, endpoint-security interference, actual-directory hardlink denial, file/directory `fsync` failure, or write error all collapse to the same outer unsupported result.
4. **A rbox-runtime-specific subprocess policy/resource failure.** A direct shell `sysctl` success does not prove that the packaged Bun executable can repeatedly spawn the same command.
5. **A successful but malformed `kern.proc.pid.<pid>` binary response.** Command failure for rbox's own PID is safe, but malformed successful output throws.
6. **Ledger no-follow/stat race or hostile concurrent mutation.** This is very unlikely for a freshly absent ledger: the `lstat` `ENOENT` branch returns before `O_NOFOLLOW` or `sameStat` is reached.
7. **Platform UUID / `ioreg` failure alone: eliminated as causal.** `platformUuid` is optional. It can add retry delay and omit enrichment, but cannot make the mandatory lock identity unavailable.

The deletion itself is **not** a missing-`mkdir` bug. `refreshHostIdentityLedger` creates the ledger parent at `src/engine/git/lockfile.ts:455` before acquiring the ledger lock, and `writeLedger` repeats the recursive creation at `:424-427`.

## Exact control-flow collapse

1. `setup-cmd.ts:773` calls `acquireWorkspaceSyncMutex`.
2. `sync-mutex.ts:146` calls the outer `acquireLock` for `<workspace>/.rbox/state/sync.lock`.
3. `lockfile.ts:933-938` catches **every** rejection from `refreshSystemLockIdentityLedger()` and returns `status: "unsupported"`.
4. On Darwin, `refreshSystemLockIdentityLedger` resolves the current incarnation at `:433-440`, then refreshes the ledger.
5. `refreshHostIdentityLedger` acquires `host-identity.json.lock` through a nested `acquireLock` at `:456-460` with identity refresh disabled to prevent recursion.
6. Any nested result other than `acquired` or transient `held` becomes `Error("host identity ledger lock unavailable")` at `:461-465`. This includes both inner `unsupported` **and inner ordinary `error`** results.
7. Ledger read, quarantine, write, chmod, directory sync, and lock-release failures at `:466-500` also reject the outer refresh.
8. `sync-mutex.ts:152-154` turns outer `unsupported` into a degraded handle and discards the original error.
9. `setup-cmd.ts:781-784` sees that handle and prints the filesystem message.

There is an additional early refresh at `src/cli/main-dispatch.ts:107-111`; it intentionally swallows the error. A setup acquire retries after a rejected refresh because `systemLedgerRefresh` is cleared at `lockfile.ts:441-445`.

## Fastest discriminators

### 1. Inspect what the failed run left behind

Run immediately after reproducing:

```sh
if [ -n "$RBOX_HOME" ]; then d="$RBOX_HOME/.rbox"; elif [ -n "$RBOX_TEST_HOST_IDENTITY_DIR" ]; then d="$RBOX_TEST_HOST_IDENTITY_DIR"; else d="$HOME/.rbox"; fi; printf 'ledger-dir=%s\n' "$d"; /bin/ls -ldeO@ "$d" "$d/host-identity.json" "$d/host-identity.json.lock" "$d/host-identity.json.corrupt" 2>&1; /usr/sbin/lsof "$d/host-identity.json.lock" 2>/dev/null; /usr/bin/sed -n '1p' "$d/host-identity.json.lock" 2>/dev/null
```

Interpretation:

- Ledger directory absent: failure occurred before `refreshHostIdentityLedger:455`, strongly favoring mandatory Darwin identity/process-incarnation failure, or the command used a different environment/path.
- Directory exists, ledger absent: parent creation succeeded; nested lock construction/finalization or ledger writing failed, or a concurrent actor removed it.
- `.lock` remains: persistent holder, foreign/malformed marker, failed verification cleanup, or failed release is strongly implicated.
- Ledger exists but the run still degraded: suspect post-publication `chmod`/directory `fsync`, lock release, or a later retry/path race.

### 2. Exercise the same installed binary with an isolated rbox home

```sh
p=$(/usr/bin/mktemp -d /tmp/rbox-maxlock.XXXXXX) && RBOX_HOME="$p" rbox --version >/dev/null && /bin/ls -ldeO@ "$p/.rbox" "$p/.rbox/host-identity.json" "$p/.rbox/host-identity.json.lock" 2>&1
```

`main-dispatch.ts:107-111` attempts the same identity-ledger refresh even for `--version`. If this creates `$p/.rbox/host-identity.json`, the mandatory identity subprocesses, packaged runtime, nested hardlink, ledger write, and lock release all succeeded on that run; focus on the normal rbox-home path, ACL/flags, contention, or security policy. If it does not create the ledger, identity/runtime or a filesystem primitive common to `/tmp` remains implicated. The command leaves the printed temporary directory for deliberate inspection/removal.

## Ranked candidate analysis

### 1. Mandatory `kern.bootsessionuuid` exhausts its retries — highest

**Source:** `lockfile.ts:14`, `:155-193`, `:209-222`, `:317-338`.

`resolveDarwinIdentityComponents` reads `kern.uuid` and `kern.bootsessionuuid` independently. `retryComponent` makes three attempts, waiting 25 ms and 50 ms. Each of these conditions is swallowed and becomes an absent component after the third attempt:

- child spawn/exec failure such as `ENOENT`, `EACCES`, `EPERM`, `EAGAIN`, `ENOMEM`, `EMFILE`, or `ENFILE`;
- nonzero `sysctl` exit, signal termination, 2-second timeout/SIGKILL, or max-buffer rejection;
- output over 1,024 bytes at `:192`;
- empty output or output which, after trim/lowercase, does not exactly match the UUID grammar at `:14` and `:172-175`.

`currentSystemIncarnation` requires both `kernUuid` and `bootSessionUuid` and throws `compatible lock identity unavailable` at `:338`. Thus the confirmed `kern.uuid` says nothing about the other mandatory component.

**Confirm/deny:**

```sh
for i in 1 2 3; do v=$(/usr/sbin/sysctl -n kern.bootsessionuuid 2>&1); s=$?; printf 'try=%d status=%d bytes=%s value=<%s> ' "$i" "$s" "$(printf %s "$v" | /usr/bin/wc -c | /usr/bin/tr -d ' ')" "$v"; printf '%s\n' "$v" | /usr/bin/grep -Eiq '^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$' && echo VALID || echo INVALID; done
```

All three must exit zero, complete in under two seconds, remain at most 1,024 bytes, and validate as a UUID. Run under the same account and launch context used for rbox.

### 2. Actual rbox-home path, parent creation, permissions, ACLs, flags, or capacity — high

**Source:** `lockfile.ts:348-356`, `:424-430`, `:450-455`; `fsutil.ts:16-67`, `:72-78`.

The normal ledger is `$RBOX_HOME/.rbox/host-identity.json` when `RBOX_HOME` is nonempty, otherwise `$HOME/.rbox/host-identity.json`. If `RBOX_HOME` is unset and the internal `RBOX_TEST_HOST_IDENTITY_DIR` is set, that directory itself is used. Therefore `rm -rf ~/.rbox` may have removed the wrong ledger.

Recursive `mkdir` at `lockfile.ts:455` handles honest absence. It can still throw on `EACCES`, `EPERM`, `EROFS`, `ENOSPC`, `EDQUOT`, `EIO`, `ENOTDIR`, an existing non-directory, or concurrent deletion. Its `0700` mode only applies to a newly created directory; it does not repair an existing directory's mode/ACL/flags.

Later writes can fail at temp open/write/file-fsync/close/rename (`fsutil.ts:34-66`), target `chmod` (`lockfile.ts:428`), or directory open/fsync/close (`lockfile.ts:429`; `fsutil.ts:72-78`) with the same permission, capacity, read-only, descriptor-exhaustion, or I/O errors. A stale same-name atomic temp can also cause `EEXIST`, although fresh deletion makes that vanishingly unlikely.

**Confirm/deny path and metadata:**

```sh
/usr/bin/env | /usr/bin/grep -E '^(HOME|RBOX_HOME|RBOX_TEST_HOST_IDENTITY_DIR)=' || true; if [ -n "$RBOX_HOME" ]; then d="$RBOX_HOME/.rbox"; elif [ -n "$RBOX_TEST_HOST_IDENTITY_DIR" ]; then d="$RBOX_TEST_HOST_IDENTITY_DIR"; else d="$HOME/.rbox"; fi; /bin/ls -ldeO@ "$(/usr/bin/dirname "$d")" "$d" 2>&1; /bin/df -h "$d" 2>&1; /bin/df -i "$d" 2>&1
```

**Confirm/deny create/write/chmod in the exact directory:**

```sh
if [ -n "$RBOX_HOME" ]; then d="$RBOX_HOME/.rbox"; elif [ -n "$RBOX_TEST_HOST_IDENTITY_DIR" ]; then d="$RBOX_TEST_HOST_IDENTITY_DIR"; else d="$HOME/.rbox"; fi; /bin/mkdir -p "$d" && t=$(/usr/bin/mktemp "$d/.maxlock-write.XXXXXX") && /usr/bin/printf x >"$t" && /bin/chmod 600 "$t" && /bin/rm "$t" && echo ledger-dir-write-ok
```

**Confirm/deny directory `fsync` kernel support** (if `python3` is installed):

```sh
/usr/bin/python3 -c 'import os; b=os.environ.get("RBOX_HOME") or os.environ.get("HOME"); p=os.path.join(b,".rbox"); os.makedirs(p,exist_ok=True); f=os.open(p,os.O_RDONLY); os.fsync(f); os.close(f); print("ledger-dir-fsync-ok",p)'
```

Treat this as an environment probe. The source makes directory-sync failure fatal during nested-lock finalization and ledger publication; this investigation does not assume that APFS directories universally reject `fsync`.

### 3. Ledger's own `.lock` acquire fails or times out — high/moderate

**Source:** `lockfile.ts:145-147`, `:450-465`, `:709-733`, `:779-799`, `:928-979`.

The nested acquire runs in the ledger directory, not the workspace. Its already-resolved `identity.current()` at `:456` is effectively non-throwing, but these branches are fatal to the outer refresh:

- marker temp-path RNG at `:711` throws (extremely rare, and outside the inner status conversion);
- temp `open(O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW)`, write, file `fsync`, or close at `:714-718` fails: inner `status: "error"`;
- hardlink at `:721` fails with `ENOTSUP`, `EOPNOTSUPP`, `EPERM`, `EXDEV`, `EMLINK`, or `ENOSYS`: inner `status: "unsupported"`;
- hardlink fails with another errno: inner `status: "error"`;
- parent-directory `fsync` or exact-marker verification at `:784-799` fails: cleanup normally produces inner `status: "error"`, while failed cleanup can retain a held marker;
- an existing live/foreign/stale/fence marker remains a blocker through the 2-second deadline at `:457-465`.

Both inner `unsupported` and inner `error` are replaced by the same `host identity ledger lock unavailable` exception at `:462`. The successful hardlink test in `~/src` rules out workspace-link capability only if it was run in the actual workspace state directory; it does not prove the operation in the actual ledger directory under a different ACL/security policy.

**Confirm/deny the exact-directory hardlink primitive:**

```sh
if [ -n "$RBOX_HOME" ]; then d="$RBOX_HOME/.rbox"; elif [ -n "$RBOX_TEST_HOST_IDENTITY_DIR" ]; then d="$RBOX_TEST_HOST_IDENTITY_DIR"; else d="$HOME/.rbox"; fi; /bin/mkdir -p "$d" && t=$(/usr/bin/mktemp "$d/.maxlock-link.XXXXXX") && /bin/ln "$t" "$t.link" && /bin/ls -li "$t" "$t.link" && /bin/rm "$t" "$t.link" && echo ledger-dir-hardlink-ok
```

**Confirm/deny a persistent holder or concurrent recreation:**

```sh
/usr/bin/pgrep -lf rbox || true; if [ -n "$RBOX_HOME" ]; then d="$RBOX_HOME/.rbox"; elif [ -n "$RBOX_TEST_HOST_IDENTITY_DIR" ]; then d="$RBOX_TEST_HOST_IDENTITY_DIR"; else d="$HOME/.rbox"; fi; /bin/ls -lO@ "$d"/host-identity.json.lock* 2>&1; /usr/sbin/lsof "$d/host-identity.json.lock" 2>/dev/null; /usr/bin/sed -n '1p' "$d/host-identity.json.lock" 2>/dev/null
```

With the **actual** ledger directory freshly absent, a persistent blocker requires another process or external agent to recreate it. `rm -rf ~/.rbox` does not stop an already-running daemon.

### 4. Packaged-rbox subprocess policy or resource failure — moderate/low

**Source:** `lockfile.ts:155-166`, `:177-193`, `:209-221`.

The identity commands use absolute paths, so `PATH` is not involved. However, direct interactive `sysctl` success does not exclude an executable-specific sandbox, MDM/endpoint rule, transient process/descriptor exhaustion, or a Bun `child_process` runtime failure. The two mandatory component reads run concurrently. A consistent denial is swallowed on each attempt and eventually becomes the generic `:338` throw.

The isolated `RBOX_HOME=... rbox --version` discriminator above is the best no-source test of the same installed executable. A macOS policy log can additionally confirm explicit denials:

```sh
/usr/bin/log show --last 10m --style compact --predicate '(process == "sandboxd" OR process == "syspolicyd" OR process == "EndpointSecurity") AND eventMessage CONTAINS[c] "rbox"'
```

No matching log does not fully deny this candidate; resource exhaustion and runtime errors need the original exception, which the current degraded path discards.

### 5. Own-process incarnation parse — low

**Source:** `lockfile.ts:225-241`, `:339-340`.

After the UUID pair resolves, rbox runs `/usr/sbin/sysctl -b kern.proc.pid.<own-pid>`. Any rejected command for rbox's own PID is deliberately replaced with `darwinFallbackOwnStart` at `:227-231` and is **not** fatal. Only a command which exits successfully but returns fewer than 16 bytes throws `process incarnation unavailable` (`ESRCH` for zero bytes, synthetic `EIO` for 1-15 bytes) at `:233-236`; or the first two signed little-endian 64-bit values decode to negative seconds/microseconds or microseconds at least 1,000,000, throwing `invalid process incarnation` at `:238-240`.

The rejected `cachedOwnProcessStart` promise at `:339` remains cached for that process, although a later rbox process starts clean.

**Confirm/deny:**

```sh
/usr/sbin/sysctl -b "kern.proc.pid.$$" | /usr/bin/od -An -N16 -t d8 | /usr/bin/awk 'NF==2 { print "seconds=" $1, "microseconds=" $2; exit !($1>=0 && $2>=0 && $2<1000000) } { exit 1 }'; printf 'pipeline-statuses: %s\n' "${pipestatus[*]}"
```

The causal signature is `sysctl` success with validator failure. A nonzero `sysctl` status would take rbox's safe fallback instead.

### 6. Existing-ledger read, `O_NOFOLLOW`, or `sameStat` race — very low after real deletion

**Source:** `lockfile.ts:359-400`, `:469-483`, `:522-523`.

The complete read failure surface is:

- `lstat` error other than `ENOENT` at `:373-377` propagates;
- symlink, non-regular file, or size over 32 KiB at `:379` returns structurally invalid and enters quarantine;
- `open(O_RDONLY|O_NOFOLLOW)` at `:380` throws on `ENOENT` replacement race, `ELOOP` symlink race, `EACCES`, `EMFILE`, `EIO`, and similar errors;
- initial `lstat` versus opened handle differs in device, inode, size, or nanosecond mtime at `:383`;
- opened versus after-read stat differs, read exceeds 32 KiB, or bytes read differs from opened size at `:385-388`;
- JSON syntax error at `:390` or strict schema/version/keys/count/UUID/`seenAt` rejection at `:359-369` and `:391-395` returns invalid and enters quarantine.

Unclassified read exceptions are deliberately replaced with `host identity ledger unreadable` at `:469-474`. Invalid content is renamed to `.corrupt`; rename or directory-sync failure other than a disappearing source (`ENOENT`) propagates at `:475-483`.

For an absent file, `lstat` returns `[]` at `:376`; `open`, `sameStat`, JSON, and quarantine are never reached. The ledger lock serializes cooperating rbox writers, so this candidate needs the wrong actual path, a concurrent non-cooperating writer/security product, or filesystem/runtime misbehavior.

**Confirm/deny concurrent mutation while reproducing in another terminal:**

```sh
sudo /usr/bin/fs_usage -w -f filesystem 2>&1 | /usr/bin/grep -E 'host-identity\.json|\.rbox-tmp-|host-identity\.json\.lock'
```

### 7. Ledger quarantine, publication, and lock release — low but exhaustively causal

**Source:** `lockfile.ts:424-430`, `:475-500`; `fsutil.ts:16-78`; lock ownership at `lockfile.ts:741-753`, `:888-924`.

After a successful read/merge, `writeLedger` can throw from recursive mkdir, sibling-temp open/write/file-sync/close, rename, target chmod, or directory sync. Relevant errnos include `EACCES`, `EPERM`, `EROFS`, `ENOSPC`, `EDQUOT`, `EIO`, `EMFILE`, `ENFILE`, `ENOENT` after concurrent directory removal, and temp `EEXIST`. These are covered by the exact-directory write and directory-sync probes above.

The nested lock is always released in `finally` at `:497-499`. `OwnedLock.release` performs two no-follow exact-marker reads and an unlink. A missing, replaced, mutated, symlinked, or unreadable lock returns `released: false`; unlink `EACCES`/`EPERM`/I/O errors are also returned as release failure. `refreshHostIdentityLedger` then throws `host identity ledger lock release failed` at `:499`. A directory-sync error **after a successful unlink** only returns `durable: false` with `released: true` at `:918-920`, so that particular release-side durability error does not fail the refresh.

A release failure in `finally` can mask an earlier ledger-body exception.

### 8. Platform UUID and `ioreg` blocked — not causal by itself

**Source:** `lockfile.ts:195-222`, `:317-338`, `:359-368`; design contract at `docs/design/118-lock-identity-and-resolve-hardening.md:121-138`.

The platform component first tries `sysctl -n kern.iokit.platform-uuid`, then `/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice`. Spawn errors, nonzero exit, timeout, output overflow, missing `IOPlatformUUID`, and invalid UUID all exhaust to `platformUuid: undefined`. Unlike `hostId` and `bootId`, `platformUuid` is not checked at `:338`, and ledger validation explicitly permits it to be absent at `:367`.

If both platform sources are blocked while `kern.uuid` and `kern.bootsessionuuid` work, rbox should still acquire the lock. Because the cache fill condition at `:317` also tests `cachedPlatformUuid`, rbox will retry the missing optional component on later `current()` calls, but that affects latency/enrichment only.

**Informational confirmation:**

```sh
/usr/sbin/sysctl -n kern.iokit.platform-uuid 2>&1; /usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice 2>&1 | /usr/bin/grep -Ei '"IOPlatformUUID"[[:space:]]*=[[:space:]]*"[[:xdigit:]-]+"'
```

Failure of both commands does **not** explain this symptom if the two mandatory UUIDs work.

### 9. Marker formatting and RNG — vanishingly unlikely

**Source:** `lockfile.ts:503-507`, `:709-714`, `:928-945`.

The outer `formatLockMarker` throw at `:943-945` independently returns `status: "unsupported"`. With the default path it would require an invalid host/boot ID, nonpositive/unsafe PID, malformed start time, or non-32-hex token. The identity pair and process start were already validated, `process.pid` is positive, and the default token is 16 random bytes encoded as 32 hex characters, so there is no ordinary field value that reaches this branch.

The default token call at `:940` and atomic temp-name RNG at `:711` are outside their neighboring try blocks. In the **nested** ledger acquire, an OS CSPRNG failure can therefore reject the refresh and cause outer unsupported. In the outer workspace acquire, a token RNG exception would reject `acquireLock` outright and be printed by setup's `:774-776` catch rather than reach the exact degraded message under investigation.

**Confirm OS random availability:**

```sh
/bin/dd if=/dev/urandom of=/dev/null bs=16 count=1 2>&1 && echo random-ok
```

## Fresh-absence verdict on the named prime suspects

| Suspect | Verdict | Why |
|---|---|---|
| `kern.bootsessionuuid` blocked/invalid | **Leading** | Mandatory at `:212/:338`; not covered by `kern.uuid`; no boot-ID fallback remains on this path. |
| platform UUID / `ioreg` blocked | **Cannot cause alone** | Optional enrichment; omitted from the mandatory check. |
| `~/.rbox` was just deleted | **Handled** | Parent is recursively created at `:455` and again at `:426`. Wrong effective home or mkdir/write failure remains possible. |
| Ledger's own `.lock` | **Plausible** | Any inner unsupported/error is mislabeled as outer identity unsupported; actual directory differs from workspace test. |
| `sameStat` / `O_NOFOLLOW` | **Very unlikely when truly absent** | `lstat` `ENOENT` returns before those operations. Needs wrong path or concurrent mutation. |
| `retryComponent` exhaustion | **Plausible for mandatory boot ID** | Three errors, timeouts, oversized, empty, or invalid results become undefined; original errno is lost. |
| hardlink unsupported in workspace | **Ruled out as stated** | But the separate nested hardlink in the effective ledger directory should still be tested there. |

## Test coverage relevant to confidence

The targeted current tests pass on this Linux checkout (`46 pass, 1 skip` across `lockfile.test.ts` and `sync-mutex.test.ts`), but they do not settle this Mac incident.

- `src/engine/git/lockfile.test.ts:108-142` covers independent retry, optional platform fallback, oversized/missing components, and subprocess timeout.
- It does not drive three failed `kern.bootsessionuuid` attempts through real `currentSystemIncarnation` and outer `acquireLock`.
- Ledger tests at `:225-317` cover corruption quarantine, symlink rejection, unchanged rewrite, and memoization, but not faults in fresh rbox-home mkdir, nested lock status/error/timeout, directory fsync, write/chmod, stat races, or release.
- The real Darwin adapter test at `:207-222` is skipped off macOS and proves workspace-storage locality, not all identity-ledger durability steps.
- `sync-mutex.test.ts` verifies that an injected identity exception degrades, and setup tests verify refusal of an injected degraded handle; neither preserves or displays the underlying exception.

## Most efficient confirmation order for the user

1. Run the three-attempt `kern.bootsessionuuid` validator.
2. Run the isolated `RBOX_HOME=<temp> rbox --version` discriminator.
3. Reproduce normally and immediately inspect the effective ledger directory, ledger, `.lock`, holder, ACLs, and flags.
4. Test hardlink, write/chmod, and directory fsync in that exact directory.
5. Check for running rbox processes and macOS policy-denial logs.
6. Only if a ledger existed during failure, trace external mutations for `sameStat`/`O_NOFOLLOW` races.

The most valuable product-side diagnostic change in a future fix would be to preserve the original exception through the nested ledger acquire and degraded mutex result. Today `host identity ledger lock unavailable` erases the nested errno, and the setup message then erases even that classification, making identity-source failures, ledger-home I/O failures, and actual hardlink capability look identical.
