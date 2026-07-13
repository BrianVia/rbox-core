import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { buildCryptoWorkerBundle } from "../../scripts/build-crypto-worker.js";
import { expectExitWithinDeadline } from "./__fixtures__/exit-deadline.js";

// Generous: the healthy path is <1s, but CI runners spawn a ~100MB compiled
// binary cold; the failure mode this guards (never exits) is unambiguous anyway.
const EXIT_DEADLINE_MS = 30_000;

// Regression for the v1.4.1 init exit hang: in `bun build --compile` binaries on
// Bun 1.3.5 (the pinned CI/release toolchain), the embedded crypto-worker bundle's
// dynamic `type: "text"` import of a `.js` target was mis-bundled as a lazy JS
// chunk — the pool silently fell back to inline crypto (fixture exits 1 via its
// workerExecutions assert) AND the chunk load left a ref'd event-loop handle so
// one-shot commands never exited (deadline race below). Compiling the fixture is
// the point: the uncompiled twin in crypto-pool-exit.test.ts cannot see either bug.
test("a compiled process exits after running a crypto pool worker", async () => {
  const root = path.resolve(import.meta.dir, "../..");
  const fixture = path.join(import.meta.dir, "__fixtures__", "pool-exit-fixture.ts");
  // The outfile must live on the SAME filesystem as the build cwd: Bun 1.3.5's
  // `build --compile` emits a corrupt (ENOEXEC) binary when the outfile crosses
  // filesystems (e.g. repo on disk, /tmp on tmpfs) — observed on this exact test.
  // `.cache/` is repo-local and gitignored.
  await fs.mkdir(path.join(root, ".cache"), { recursive: true });
  const tmpdir = await fs.mkdtemp(path.join(root, ".cache", "rbox-pool-exit-compiled-"));
  const binary = path.join(tmpdir, "fixture-bin");

  try {
    buildCryptoWorkerBundle();
    const build = Bun.spawn(["bun", "build", "--compile", fixture, "--outfile", binary], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const buildCode = await build.exited;
    const buildStderr = await new Response(build.stderr).text();
    expect(buildCode, buildStderr).toBe(0);

    const child = Bun.spawn([binary], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    await expectExitWithinDeadline(child, EXIT_DEADLINE_MS, "compiled crypto-pool fixture");
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
}, 90_000);
