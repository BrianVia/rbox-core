import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIgnoreMatcher } from "../engine/index.js";
import { startWatcher, type Watcher } from "./watcher.js";

/**
 * Hidden release self-check (design §41 §6). Run from the COMPILED release binary on the
 * matching OS/arch to prove the native `@parcel/watcher` binding actually LOADS from that
 * binary and delivers a real filesystem event — the thing `bun build` exit-0 can't prove.
 *
 * Prints one machine-greppable line (`WATCHER_SELFTEST ok|fail=… rss_mb=… platform=…`) and
 * returns a process exit code: 0 = watcher loaded + event delivered + memory bounded; 1 = no
 * event; 2 = watcher failed to start; 3 = idle RSS over the ceiling (a per-path-backend-class
 * regression). No account, network, or filesystem beyond a throwaway temp dir.
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
    return 0;
  } finally {
    await watcher?.close().catch(() => {});
    if (createdTemp) fs.rmSync(base, { recursive: true, force: true });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
