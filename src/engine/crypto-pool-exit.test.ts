import { expect, test } from "bun:test";
import path from "node:path";

const EXIT_DEADLINE_MS = 10_000;

test("a process exits after shutting down a crypto pool that spawned a worker", async () => {
  const fixture = path.join(import.meta.dir, "__fixtures__", "pool-exit-fixture.ts");
  const child = Bun.spawn(["bun", "run", fixture], {
    cwd: path.resolve(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
  });

  let deadline: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    deadline = setTimeout(() => resolve("timeout"), EXIT_DEADLINE_MS);
  });

  const result = await Promise.race([
    child.exited.then((code) => ({ code })),
    timedOut,
  ]);

  if (deadline) clearTimeout(deadline);
  if (result === "timeout") {
    child.kill();
    await child.exited;
    const stderr = await new Response(child.stderr).text();
    throw new Error(`crypto-pool fixture did not exit within ${EXIT_DEADLINE_MS}ms: ${stderr}`);
  }

  const stderr = await new Response(child.stderr).text();
  expect(result.code, stderr).toBe(0);
}, EXIT_DEADLINE_MS + 2_000);

// Negative control (intentionally not run): removing shutdownCryptoPool() from
// the fixture leaves the spawned worker as a ref'd handle, so this deadline wins.
