import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearResetHaltHealth,
  readResetHaltHealth,
  resetHaltHealthPath,
  writeResetHaltHealth,
} from "./reset-health.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-reset-health-"));
  roots.push(root);
  return root;
}

describe("reset halt health side-file", () => {
  test("daemon writer round-trips and clears idempotently", async () => {
    const root = await tempRoot();
    const health = {
      reason: "legacy reset journal has no authorization witness",
      journalIdentity: "a".repeat(64),
      haltedAt: "2026-07-17T12:00:00.000Z",
    };
    await writeResetHaltHealth(root, health);
    expect(await readResetHaltHealth(root)).toEqual({ v: 1, ...health });
    expect((await fs.stat(resetHaltHealthPath(root))).mode & 0o777).toBe(0o600);
    expect(await clearResetHaltHealth(root)).toBe(true);
    expect(await clearResetHaltHealth(root)).toBe(false);
    expect(await readResetHaltHealth(root)).toBeUndefined();
  });

  test("read-only consumer ignores malformed, oversized, and symlink records", async () => {
    const root = await tempRoot();
    const file = resetHaltHealthPath(root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "not json");
    expect(await readResetHaltHealth(root)).toBeUndefined();
    await fs.writeFile(file, "x".repeat(16 * 1024 + 1));
    expect(await readResetHaltHealth(root)).toBeUndefined();
    await fs.rm(file);
    const outside = path.join(root, "outside");
    await fs.writeFile(outside, JSON.stringify({ v: 1, reason: "x", journalIdentity: "b".repeat(64), haltedAt: "2026-07-17T12:00:00.000Z" }));
    await fs.symlink(outside, file);
    expect(await readResetHaltHealth(root)).toBeUndefined();
  });

  test("direct CLI reads race daemon atomic replacements without observing torn health", async () => {
    const root = await tempRoot();
    await writeResetHaltHealth(root, {
      reason: "episode-0", journalIdentity: "0".repeat(64), haltedAt: "2026-07-17T12:00:00.000Z",
    });
    const writer = Promise.all(Array.from({ length: 40 }, (_, index) => writeResetHaltHealth(root, {
      reason: `episode-${index + 1}`,
      journalIdentity: (index % 16).toString(16).repeat(64),
      haltedAt: new Date(Date.parse("2026-07-17T12:00:00.000Z") + index + 1).toISOString(),
    })));
    const reads = await Promise.all(Array.from({ length: 80 }, () => readResetHaltHealth(root)));
    await writer;
    expect(reads.every((value) => value === undefined || (value.v === 1 && value.reason.startsWith("episode-")))).toBe(true);
    expect((await readResetHaltHealth(root))?.reason).toStartWith("episode-");
  });
});
