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
 *    — the Time Machine / Spotlight-indexer background tier. Throttling only
 *    engages under contention; an idle disk serves the daemon at full speed.
 *  - linux: ioprio_set(IOPRIO_WHO_PROCESS, self, best-effort level 7) — the
 *    lowest best-effort level, NOT the IDLE class (IDLE can starve
 *    indefinitely under sustained foreign IO, and pulls must still land).
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
/** The packed ioprio value we set (exported for the spawned test probe). */
export const LINUX_IOPRIO_BE7 = (IOPRIO_CLASS_BE << IOPRIO_CLASS_SHIFT) | IOPRIO_BE_LOWEST;

/** __NR_ioprio_set — x64 from unistd_64.h, arm64 from asm-generic/unistd.h. */
const LINUX_NR_IOPRIO_SET: Partial<Record<string, number>> = { x64: 251, arm64: 30 };

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
      // Variadic syscall(2) declared with fixed integer args — integer args ride
      // the same registers on both SysV x64 and AAPCS64, so this arity is safe.
      const lib = dlopen("libc.so.6", {
        syscall: { args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i64 },
      });
      const rc = lib.symbols.syscall!(nr, IOPRIO_WHO_PROCESS, 0, LINUX_IOPRIO_BE7);
      return rc === 0 || rc === 0n ? "best-effort level 7 (linux)" : `unchanged (ioprio_set rc=${rc})`;
    }
    return `unchanged (unsupported platform ${process.platform})`;
  } catch (e) {
    return `unchanged (${e instanceof Error ? e.message : String(e)})`;
  }
}
