import { expect, test } from "bun:test";
import path from "node:path";

// Design 49: verify the IO policy ACTUALLY takes (via the platform's getter), in a
// SPAWNED bun process — never in-process, or the throttle would apply to the rest
// of the test suite. CI's ubuntu runner exercises the linux leg; local runs and
// the release smoke (`__watcher-selftest` exit code 4, all 3 targets natively)
// exercise darwin and the arm64 syscall numbers.

const SRC = path.resolve(import.meta.dir, "io-priority.ts");

function probe(code: string): string {
  const r = Bun.spawnSync(["bun", "-e", code]);
  return (r.stdout.toString() + r.stderr.toString()).trim();
}

test.skipIf(process.platform !== "darwin")("darwin: lowerIoPriority sets IOPOL_THROTTLE and the getter confirms it", () => {
  const out = probe(`
    const { lowerIoPriority, verifyIoPriority } = await import(${JSON.stringify(SRC)});
    const msg = lowerIoPriority();
    const v = verifyIoPriority();
    console.log(msg + " | ok=" + v.ok + " " + v.detail);
  `);
  expect(out).toContain("throttle tier (darwin)");
  expect(out).toContain("ok=true");
  expect(out).toContain("policy=3"); // IOPOL_THROTTLE, read back from the OS
});

test.skipIf(process.platform !== "linux")("linux: lowerIoPriority sets BE-7 on EVERY thread, incl. pre-spawned IO workers", () => {
  const out = probe(`
    // Force Bun's IO worker threads to exist BEFORE the set — the codex R1 repro:
    // who=0 would set only the calling thread and leave these at default priority.
    const fs = await import("node:fs/promises");
    await fs.readFile(${JSON.stringify(SRC)});
    const threads = (await import("node:fs")).readdirSync("/proc/self/task").length;
    const { lowerIoPriority, verifyIoPriority } = await import(${JSON.stringify(SRC)});
    const msg = lowerIoPriority();
    const v = verifyIoPriority();
    console.log(msg + " | preThreads=" + threads + " ok=" + v.ok + " " + v.detail);
  `);
  expect(out).toContain("best-effort level 7 (linux");
  expect(out).toContain("ok=true"); // verify walks /proc/self/task: every tid must read back BE-7
  expect(out).toMatch(/ioprio=\[16391\]/); // (2<<13)|7 — a single uniform value across threads
});
