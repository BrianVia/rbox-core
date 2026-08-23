import { expect, test } from "bun:test";
import path from "node:path";

// The fixture body runs only under RBOX_RESET_BUSY_FIXTURE=1 in its own
// process: its top-level mock.module on reset-namespace-inventory would swap
// the module for every later file sharing a shard process (35 downstream
// failures when it ran inline in CI shard 4).
test("RESET_NAMESPACE_BUSY defer fixture passes in an isolated subprocess", () => {
  const result = Bun.spawnSync([process.execPath, "test", path.join(import.meta.dir, "reset-namespace-busy-defer.fixture.test.ts")], {
    env: { ...process.env, RBOX_RESET_BUSY_FIXTURE: "1" },
  });
  const output = `${result.stdout}\n${result.stderr}`;
  expect(output).toContain("5 pass");
  expect(result.exitCode).toBe(0);
}, 60_000);
