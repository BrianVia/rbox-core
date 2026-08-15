import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectResetJournalSafety } from "../../reset-halt-inspection.js";
import { inspectResetJournalForQuarantine } from "../../reset-quarantine.js";
import { sqliteResetFacade } from "./index.js";
import { sqliteResetPaths } from "./artifacts.js";

const inspectSqliteReset = sqliteResetFacade.inspect;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

test("live recovery, doctor, and quarantine preserve one exact J0 decoder result", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-u2-consumers-"));
  roots.push(root);
  await fs.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  await fs.writeFile(
    sqliteResetPaths.authorityMarker(root),
    `RBOX-SQLITE-AUTHORITY-v1\n${"1".repeat(32)}\n`,
  );
  await fs.writeFile(sqliteResetPaths.active(root), "opaque S0 DB fixture");
  await fs.writeFile(sqliteResetPaths.journal(root), '{"v":2,"\\u0076":2}');
  const before = await fs.readdir(sqliteResetPaths.stateRoot(root));

  const live = await inspectSqliteReset(root, "old");
  expect(live).toMatchObject({
    status: "halt",
    row: "J0",
    decodeError: {
      code: "DUPLICATE_MEMBER",
      byteOffset: 7,
      jsonPath: "$.v",
      limit: null,
    },
  });
  const doctor = await inspectResetJournalSafety(root, "old") as unknown as {
    status: string;
    decodeError?: unknown;
  };
  expect(doctor).toMatchObject({ status: "halt", decodeError: (live as { decodeError: unknown }).decodeError });
  expect(await inspectResetJournalForQuarantine(sqliteResetPaths.journal(root))).toMatchObject({
    ok: false,
    error: (live as { decodeError: unknown }).decodeError,
  });
  expect(await fs.readdir(sqliteResetPaths.stateRoot(root))).toEqual(before);
});

async function productionSource(relative: string): Promise<string> {
  return fs.readFile(path.resolve(import.meta.dir, relative), "utf8");
}

test("selected begin and settle are the sole production facade reset executors", async () => {
  const source = await productionSource("../../reset-journal.ts");
  expect(source.match(/sqliteResetFacade\.begin\s*\(/g)).toHaveLength(1);
  expect(source.match(/sqliteResetFacade\.recover\s*\(/g)).toHaveLength(1);
});

test("reset orchestration has two format-neutral gates and no legacy journal decision", async () => {
  const source = await productionSource("../../reset-state.ts");
  expect(source).toContain("inspectResetFenceInventory");
  expect(source).toContain("settleStandingResetUnderHeldFence");
  expect(source).not.toMatch(/readResetJournal|inspectResetJournal/);
});

test("both lock inventories use the format-neutral reset fence", async () => {
  const source = await productionSource("../locks.ts");
  expect(source.match(/inspectResetFenceInventory\s*\(/g)).toHaveLength(2);
  expect(source).not.toContain("readResetJournal");
});

test("lineage recovery delegates inventory and settlement without a journal lstat", async () => {
  const source = await productionSource("../reset-lineage.ts");
  expect(source).toContain("inspectResetFenceInventory");
  expect(source).toContain("settleStandingReset");
  expect(source).not.toMatch(/lstat\([^)]*reset/);
});
