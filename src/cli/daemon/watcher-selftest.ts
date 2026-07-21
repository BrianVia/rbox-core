import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIgnoreMatcher } from "../../engine/index.js";
import { lowerIoPriority, verifyIoPriority } from "../io-priority.js";
import { startWatcher, type Watcher } from "./watcher.js";
import { GitRefWatchRegistry, gitRefSideChannelEligible } from "./git-ref-watch.js";

/**
 * Hidden release self-check (design §41 §6). Run from the COMPILED release binary on the
 * matching OS/arch to prove the native `@parcel/watcher` binding actually LOADS from that
 * binary and delivers a real filesystem event — the thing `bun build` exit-0 can't prove.
 *
 * Prints machine-greppable lines (`WATCHER_SELFTEST …` and `IOPRIO_SELFTEST …`) and returns
 * a process exit code: 0 = watcher loaded + event delivered + memory bounded + IO policy
 * verified; 1 = no event; 2 = watcher failed to start; 3 = idle RSS over the ceiling (a
 * per-path-backend-class regression); 4 = IO-priority FFI didn't take on this target
 * (design 49). No account, network, or filesystem beyond a throwaway temp dir.
 */
export async function watcherSelfTest(dirArg?: string, opts: { timeoutMs?: number; maxRssMb?: number } = {}): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxRssMb = opts.maxRssMb ?? 400; // empty-dir baseline is tens of MB; nowhere near chokidar
  const createdTemp = !dirArg;
  const base = dirArg ? path.resolve(dirArg) : fs.mkdtempSync(path.join(os.tmpdir(), "rbox-selftest-"));
  fs.mkdirSync(base, { recursive: true });
  const root = fs.realpathSync(base);
  const probe = "rbox-selftest.txt";

  let watcher: Watcher | undefined;
  try {
    let delivered = false;
    try {
      // Force the NATIVE parcel backend: this smoke exists to prove @parcel/watcher loads on
      // THIS target. `RBOX_WATCHER=chokidar` (or any default) must NOT let it pass via the
      // fallback — if parcel specifically can't load here, this MUST fail (exit 2).
      watcher = await startWatcher(
        root,
        buildIgnoreMatcher(root),
        (evs) => {
          if (evs.some((e) => e.relPath === probe)) delivered = true;
        },
        { debounceMs: 30, backend: "parcel" }
      );
    } catch (e) {
      console.log(`WATCHER_SELFTEST fail=start-error platform=${process.platform}-${process.arch} err=${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }

    await sleep(300); // let the initial snapshot settle before mutating
    fs.writeFileSync(path.join(root, probe), "ping");
    const deadline = Date.now() + timeoutMs;
    while (!delivered && Date.now() < deadline) await sleep(25);

    // Measure while the watch is live — that's the daemon's idle footprint we bound.
    const rssMb = Math.round(process.memoryUsage.rss() / 1024 / 1024);
    const status = !delivered ? "fail=no-event" : rssMb > maxRssMb ? `fail=rss-over-${maxRssMb}` : "ok";
    console.log(`WATCHER_SELFTEST ${status} rss_mb=${rssMb} platform=${process.platform}-${process.arch}`);
    if (!delivered) return 1;
    if (rssMb > maxRssMb) return 3;

    // Design 49: same native gate, second duty — prove the IO-priority FFI works on
    // THIS target's compiled binary (symbols/syscall numbers are per-platform; PR CI
    // only ever runs linux-x64, so a darwin-arm64 or linux-arm64 typo would otherwise
    // ship). The getter must confirm the policy actually took, on every thread.
    const set = lowerIoPriority();
    const check = verifyIoPriority();
    console.log(`IOPRIO_SELFTEST ${check.ok ? "ok" : "fail"} set="${set}" ${check.detail} platform=${process.platform}-${process.arch}`);
    if (!check.ok) return 4;
    return 0;
  } finally {
    await watcher?.close().catch(() => {});
    if (createdTemp) fs.rmSync(base, { recursive: true, force: true });
  }
}

/** Native release assertion for the deliberately unsupported Darwin side-channel. */
export async function gitRefWatchPlatformSelfTest(): Promise<number> {
  const createdTemp = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-refwatch-platform-"));
  const eligible = gitRefSideChannelEligible();
  const registry = eligible ? new GitRefWatchRegistry({ root: fs.realpathSync(createdTemp) }) : undefined;
  const handles = registry?.state.activeHandles ?? 0;
  await registry?.close();
  fs.rmSync(createdTemp, { recursive: true, force: true });
  const ok = process.platform !== "darwin" || (!eligible && handles === 0);
  console.log(`GIT_REFWATCH_SELFTEST ${ok ? "ok" : "fail"} eligible=${eligible} handles=${handles} platform=${process.platform}-${process.arch}`);
  return ok ? 0 : 1;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
