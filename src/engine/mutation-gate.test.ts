import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyActions } from "./apply.js";
import { MutationGateClosedError, ShutdownMutationGate } from "./mutation-gate.js";

test("graceful stop aborts prepared-but-uncommitted work and rejects new boundaries", async () => {
  const gate = new ShutdownMutationGate();
  const prepared = gate.enter({ phase: "git-prepare", repository: "repo" });
  gate.close();
  expect(prepared.abortRequested).toBe(true);
  expect(prepared.beginCommit("git-commit")).toBe(false);
  expect(() => gate.enter({ phase: "file-apply" })).toThrow(MutationGateClosedError);
  prepared.finish();
  await gate.drain();
});

test("committed critical work drains and reports its active phase", async () => {
  const gate = new ShutdownMutationGate();
  const lease = gate.enter({ phase: "state-cas", repository: "repo" });
  expect(lease.beginCommit()).toBe(true);
  gate.close();
  expect(gate.snapshot()).toEqual([{ id: 1, phase: "state-cas", repository: "repo", committed: true }]);
  let drained = false;
  const drain = gate.drain().then(() => { drained = true; });
  await Promise.resolve();
  expect(drained).toBe(false);
  lease.finish();
  await drain;
  expect(drained).toBe(true);
});

test("committed drain resolves while an abortable prepared lease remains", async () => {
  const gate = new ShutdownMutationGate();
  const committed = gate.enter({ phase: "state-cas" });
  const prepared = gate.enter({ phase: "git-prepare" });
  expect(committed.beginCommit()).toBe(true);
  gate.close();
  let irreversibleDrained = false;
  const drain = gate.drainCommitted().then(() => { irreversibleDrained = true; });
  committed.finish();
  await drain;
  expect(irreversibleDrained).toBe(true);
  expect(prepared.abortRequested).toBe(true);
  expect(gate.snapshot()).toEqual([{ id: 2, phase: "git-prepare", committed: false }]);
  prepared.finish();
  await gate.drain();
});

test("ordinary open-gate lease churn does not rewrite shutdown status", () => {
  let changes = 0;
  const gate = new ShutdownMutationGate(() => { changes++; });
  const ordinary = gate.enter({ phase: "file-apply" });
  expect(ordinary.beginCommit()).toBe(true);
  ordinary.finish();
  expect(changes).toBe(0);

  const draining = gate.enter({ phase: "state-cas" });
  expect(draining.beginCommit()).toBe(true);
  gate.close();
  expect(changes).toBe(1);
  draining.finish();
  expect(changes).toBe(2);
});

test("a closed shutdown gate prevents file staging, parent creation, and publish", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-mutation-gate-"));
  try {
    const gate = new ShutdownMutationGate();
    gate.close();
    const target = path.join(root, "nested", "link");
    await expect(applyActions(root, [{
      kind: "write",
      entry: {
        path: "nested/link",
        sha256: "0".repeat(64),
        size: 6,
        mode: 0o777,
        mtimeMs: 0,
        type: "symlink",
        symlinkTarget: "target",
      },
      expectedLocal: undefined,
    }], {
      has: async () => false,
      put: async () => {},
      get: async () => Buffer.alloc(0),
    }, { mutationBoundary: gate })).rejects.toThrow(MutationGateClosedError);
    expect(await fs.lstat(target).then(() => true, () => false)).toBe(false);
    expect(await fs.lstat(path.dirname(target)).then(() => true, () => false)).toBe(false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
