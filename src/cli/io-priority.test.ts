import { expect, test } from "bun:test";
import path from "node:path";
import { LINUX_IOPRIO_BE7 } from "./io-priority.js";

// Design 49: verify the IO policy ACTUALLY takes (via the platform's getter), in a
// SPAWNED bun process — never in-process, or the throttle would apply to the rest
// of the test suite. CI's ubuntu runner exercises the linux leg; local runs and
// the release smoke matrix (macos-14) exercise darwin.

const SRC = path.resolve(import.meta.dir, "io-priority.ts");

function probe(code: string): string {
  const r = Bun.spawnSync(["bun", "-e", code]);
  return (r.stdout.toString() + r.stderr.toString()).trim();
}

test.skipIf(process.platform !== "darwin")("darwin: lowerIoPriority sets IOPOL_THROTTLE on the process", () => {
  const out = probe(`
    const { lowerIoPriority } = await import(${JSON.stringify(SRC)});
    const msg = lowerIoPriority();
    const { dlopen, FFIType } = await import("bun:ffi");
    const lib = dlopen("libSystem.B.dylib", {
      getiopolicy_np: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
    console.log(msg + " | policy=" + lib.symbols.getiopolicy_np(0, 0));
  `);
  expect(out).toContain("throttle tier (darwin)");
  expect(out).toContain("policy=3"); // IOPOL_THROTTLE — the getter proves it took
});

test.skipIf(process.platform !== "linux")("linux: lowerIoPriority sets best-effort level 7 on the process", () => {
  const nrGet = process.arch === "x64" ? 252 : 31; // __NR_ioprio_get
  const out = probe(`
    const { lowerIoPriority } = await import(${JSON.stringify(SRC)});
    const msg = lowerIoPriority();
    const { dlopen, FFIType } = await import("bun:ffi");
    const lib = dlopen("libc.so.6", {
      syscall: { args: [FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i64 },
    });
    console.log(msg + " | ioprio=" + lib.symbols.syscall(${nrGet}, 1, 0));
  `);
  expect(out).toContain("best-effort level 7 (linux)");
  expect(out).toContain(`ioprio=${LINUX_IOPRIO_BE7}`); // (BE<<13)|7 — the getter proves it took
});
