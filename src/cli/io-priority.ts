import fs from "node:fs";
import { dlopen, FFIType } from "bun:ffi";

/**
 * Lower this process's disk-IO priority (design 49): background sync must lose
 * the disk race to the developer's own tools, the same way daemon start()
 * loses the CPU race via os.setPriority(nice 10). Called by the DAEMON only —
 * one-shot push/pull/sync are foreground commands the user is waiting on.
 *
 * Best-effort by design: every failure path returns a reason string and leaves
 * the default policy in place — never a throw, never fatal. The daemon logs
 * the outcome once at startup.
 *
 *  - darwin: setiopolicy_np(IOPOL_TYPE_DISK, IOPOL_SCOPE_PROCESS, IOPOL_THROTTLE)
 *    — the Time Machine / Spotlight-indexer background tier, genuinely
 *    process-wide (SCOPE_PROCESS). Throttling only engages under contention;
 *    an idle disk serves the daemon at full speed.
 *  - linux: ioprio_set per EXISTING kernel task — io priority is per-thread,
 *    and WHO_PROCESS with who=0 targets only the CALLING thread (kernel
 *    block/ioprio.c), which would miss Bun's already-spawned IO worker threads,
 *    the ones doing the actual disk work. So every tid in
 *    /proc/self/task is set; threads spawned later inherit from their spawner
 *    (the main thread, which is set here). Best-effort class level 7 (lowest),
 *    NOT the IDLE class — IDLE can starve indefinitely under sustained foreign
 *    IO, and pulls must still land.
 */

// Darwin <sys/resource.h>
const IOPOL_TYPE_DISK = 0;
const IOPOL_SCOPE_PROCESS = 0;
const IOPOL_THROTTLE = 3;

// Linux <linux/ioprio.h>
const IOPRIO_WHO_PROCESS = 1;
const IOPRIO_CLASS_BE = 2;
const IOPRIO_BE_LOWEST = 7;
const IOPRIO_CLASS_SHIFT = 13;
/** The packed ioprio value we set (exported for the selftest/test probes). */
export const LINUX_IOPRIO_BE7 = (IOPRIO_CLASS_BE << IOPRIO_CLASS_SHIFT) | IOPRIO_BE_LOWEST;

/** Syscall numbers per CPU architecture; absent where rbox has no number for it. */
type ArchSyscallNumbers = Partial<Record<NodeJS.Architecture, number>>;

/** __NR_ioprio_set / __NR_ioprio_get — x64 from unistd_64.h, arm64 from asm-generic/unistd.h. */
const LINUX_NR_IOPRIO_SET: ArchSyscallNumbers = { x64: 251, arm64: 30 };
const LINUX_NR_IOPRIO_GET: ArchSyscallNumbers = { x64: 252, arm64: 31 };

/** Variadic syscall(2) declared with fixed integer args — integer args ride the
 *  same registers on both SysV x64 and AAPCS64, so this arity is safe. */
function linuxSyscall3(): (nr: number, a: number, b: number, c: number) => number {
  const lib = dlopen("libc.so.6", {
    syscall: { args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i64 },
  });
  return (nr, a, b, c) => Number(lib.symbols.syscall!(nr, a, b, c));
}

/** Every existing kernel task (thread) of this process. */
const linuxTids = (): number[] => fs.readdirSync("/proc/self/task").map(Number).filter(Number.isFinite);

export function lowerIoPriority(): string {
  try {
    if (process.platform === "darwin") {
      const lib = dlopen("libSystem.B.dylib", {
        setiopolicy_np: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
      const rc = lib.symbols.setiopolicy_np!(IOPOL_TYPE_DISK, IOPOL_SCOPE_PROCESS, IOPOL_THROTTLE);
      return rc === 0 ? "throttle tier (darwin)" : `unchanged (setiopolicy_np rc=${rc})`;
    }
    if (process.platform === "linux") {
      const nr = LINUX_NR_IOPRIO_SET[process.arch];
      if (nr === undefined) return `unchanged (no ioprio_set number for ${process.arch})`;
      const syscall = linuxSyscall3();
      const tids = linuxTids();
      // A tid may exit between readdir and the call — count what actually took.
      const ok = tids.filter((tid) => syscall(nr, IOPRIO_WHO_PROCESS, tid, LINUX_IOPRIO_BE7) === 0).length;
      if (ok === 0) return `unchanged (ioprio_set failed for all ${tids.length} threads)`;
      return `best-effort level 7 (linux, ${ok}/${tids.length} threads)`;
    }
    return `unchanged (unsupported platform ${process.platform})`;
  } catch (e) {
    return `unchanged (${e instanceof Error ? e.message : String(e)})`;
  }
}

export type IoPriorityVerdict = { ok: boolean; detail: string };

/**
 * Read back the policy via the platform getter and confirm lowerIoPriority took.
 * Shared by the release smoke (`__watcher-selftest`, which runs NATIVELY on every
 * release target — PR CI only covers linux-x64) and the unit-test probes.
 * Unsupported platforms report ok (nothing was promised there).
 */
export function verifyIoPriority(): IoPriorityVerdict {
  try {
    if (process.platform === "darwin") {
      const lib = dlopen("libSystem.B.dylib", {
        getiopolicy_np: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
      const got = Number(lib.symbols.getiopolicy_np!(IOPOL_TYPE_DISK, IOPOL_SCOPE_PROCESS));
      return { ok: got === IOPOL_THROTTLE, detail: `policy=${got}` };
    }
    if (process.platform === "linux") {
      const nr = LINUX_NR_IOPRIO_GET[process.arch];
      if (nr === undefined) return { ok: true, detail: `no ioprio_get number for ${process.arch} (skipped)` };
      const syscall = linuxSyscall3();
      // EVERY live thread must report BE-7 — who=0 would only vouch for the caller.
      // -1 (ESRCH) = the tid exited between readdir and the call; not a verdict.
      const got = linuxTids()
        .map((tid) => syscall(nr, IOPRIO_WHO_PROCESS, tid, 0))
        .filter((v) => v !== -1);
      const ok = got.length > 0 && got.every((v) => v === LINUX_IOPRIO_BE7);
      return { ok, detail: `ioprio=[${[...new Set(got)].join(",")}] threads=${got.length}` };
    }
    return { ok: true, detail: `unsupported platform ${process.platform} (skipped)` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
