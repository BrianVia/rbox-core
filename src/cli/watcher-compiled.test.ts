import { expect, test } from "bun:test";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

// Finding 5(d) + Phase-0 gate for the HOST target: prove the native @parcel/watcher
// binding survives `bun build --compile` and actually LOADS + DELIVERS an event from a
// standalone binary (run in an isolated dir with no node_modules) — not merely that the
// build exits 0. This is the property the release binary depends on; the other three
// targets are validated on native CI runners (design §41 §6).

const ROOT = path.resolve(import.meta.dir, "..", "..");
// Any `bun build --compile` whose graph reaches engine/index needs the crypto-worker
// bundle present (design 81 §3: build scripts own the pre-bundle step — this test IS
// a build script). Fresh checkouts don't have the generated artifact; create it.
const { buildCryptoWorkerBundle } = await import(path.join(ROOT, "scripts", "build-crypto-worker.ts"));
buildCryptoWorkerBundle();
const PARCEL_PKG: Record<string, string> = {
  "darwin-arm64": "@parcel/watcher-darwin-arm64",
  "linux-arm64": "@parcel/watcher-linux-arm64-glibc",
  "linux-x64": "@parcel/watcher-linux-x64-glibc",
};
const hostKey = `${process.platform}-${process.arch}`;
const hostPkgPresent = !!PARCEL_PKG[hostKey] && fs.existsSync(path.join(ROOT, "node_modules", PARCEL_PKG[hostKey]!, "watcher.node"));

// Skip ONLY when we genuinely can't exercise it: the host platform package isn't installed
// (can't compile the target), or a macOS sandbox with no FSEvents. Linux/inotify + normal
// macOS must RUN — a failure there is a real regression, not a silent skip. Probe the native
// @parcel/watcher DIRECTLY (not via the mockable `./watcher.js`) so daemon-watch-degrade's
// process-global mock can't corrupt this signal.
async function nativeParcelUnavailable(attempts = 3): Promise<boolean> {
  if (process.platform !== "darwin") return false; // Linux/inotify must run
  const req = createRequire(import.meta.url);
  let err = "";
  for (let i = 0; i < attempts; i++) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-cprobe-")));
    try {
      const parcel = req("@parcel/watcher") as { subscribe: (d: string, f: () => void, o: object) => Promise<{ unsubscribe(): Promise<void> }> };
      const sub = await parcel.subscribe(dir, () => {}, {});
      await sub.unsubscribe();
      return false;
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return /fsevents|not permitted|sandbox|eperm/i.test(err);
}
const skipCompiled = !hostPkgPresent || (await nativeParcelUnavailable());

test.skipIf(skipCompiled)(
  "compiled standalone binary loads the native watcher and delivers an event (host target)",
  async () => {
    const entry = path.join(ROOT, `.rbox-watch-smoke-${process.pid}.ts`);
    const bin = path.join(os.tmpdir(), `rbox-watch-smoke-${process.pid}`);
    fs.writeFileSync(
      entry,
      [
        `import fs from "node:fs"; import os from "node:os"; import path from "node:path";`,
        `import { buildIgnoreMatcher } from "./src/engine/index.js";`,
        `import { startWatcher } from "./src/cli/daemon/watcher.js";`,
        `const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"csmoke-")));`,
        `let got = false;`,
        `const w = await startWatcher(root, buildIgnoreMatcher(root), (e) => { for (const ev of e) if (ev.relPath === "x.txt") got = true; }, { debounceMs: 30 });`,
        `await new Promise((r) => setTimeout(r, 250));`,
        `fs.writeFileSync(path.join(root, "x.txt"), "hi");`,
        `await new Promise((r) => setTimeout(r, 1200));`,
        `await w.close(); fs.rmSync(root, { recursive: true, force: true });`,
        `console.log(got ? "SMOKE_OK" : "SMOKE_FAIL"); process.exit(got ? 0 : 1);`,
      ].join("\n")
    );

    try {
      const externals = Object.entries(PARCEL_PKG)
        .filter(([k]) => k !== hostKey)
        .flatMap(([, pkg]) => ["--external", pkg]);
      const build = Bun.spawnSync(
        [process.execPath, "build", "--compile", `--target=bun-${hostKey}`, ...externals, entry, "--outfile", bin],
        { cwd: ROOT }
      );
      expect(build.exitCode).toBe(0);

      // Run from an isolated dir so resolution can't fall back to repo node_modules —
      // the binding must come from INSIDE the binary.
      const iso = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-iso-")));
      const run = Bun.spawnSync([bin], { cwd: iso });
      fs.rmSync(iso, { recursive: true, force: true });
      const out = run.stdout.toString() + run.stderr.toString();
      expect(out).toContain("SMOKE_OK");
    } finally {
      fs.rmSync(entry, { force: true });
      fs.rmSync(bin, { force: true });
    }
  },
  60_000
);
