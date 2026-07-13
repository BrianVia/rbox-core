import { test } from "bun:test";
import path from "node:path";
import { expectExitWithinDeadline } from "./__fixtures__/exit-deadline.js";

const EXIT_DEADLINE_MS = 10_000;

test("a process exits after shutting down a crypto pool that spawned a worker", async () => {
  const fixture = path.join(import.meta.dir, "__fixtures__", "pool-exit-fixture.ts");
  const child = Bun.spawn(["bun", "run", fixture], {
    cwd: path.resolve(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
  });
  await expectExitWithinDeadline(child, EXIT_DEADLINE_MS, "crypto-pool fixture");
}, EXIT_DEADLINE_MS + 2_000);

// Negative control (intentionally not run): removing shutdownCryptoPool() from
// the fixture leaves the spawned worker as a ref'd handle, so this deadline wins.
