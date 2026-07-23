import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resetSyncState } from "./config.js";
import {
  buildPathWarnings,
  clearPathWarnings,
  PATH_WARNINGS_MAX_BYTES,
  PATH_WARNINGS_MAX_GROUPS,
  PATH_WARNINGS_MAX_PATHS_PER_GROUP,
  pathWarningsPath,
  readPathWarnings,
  savePathWarnings,
  writePathWarnings,
  type PathCollisionGroup,
} from "./path-warnings.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-path-warnings-"));
  roots.push(root);
  return root;
}

const pair = (stem: string): PathCollisionGroup => ({ paths: [`${stem}/Readme.md`, `${stem}/README.md`] });

describe("path warning sidecar", () => {
  test("round trips with exact permissions and clears idempotently", async () => {
    const root = await tempRoot();
    const written = await savePathWarnings(root, [pair("docs")]);
    expect(await readPathWarnings(root)).toEqual(written);
    expect((await fs.stat(pathWarningsPath(root))).mode & 0o777).toBe(0o600);
    expect(await clearPathWarnings(root)).toBe(true);
    expect(await clearPathWarnings(root)).toBe(false);
    expect(await readPathWarnings(root)).toBeUndefined();
  });

  test("canonicalizes input and preserves complete counts and fingerprint while bounding display data", async () => {
    const longTail = "x".repeat(880);
    const groups = Array.from({ length: 150 }, (_, group): PathCollisionGroup => {
      const prefix = `group-${String(group).padStart(3, "0")}-`;
      const alphabet = "abcdefghij";
      return {
        paths: Array.from({ length: 10 }, (_, variant) => {
          const letters = [...alphabet].map((char, index) => index === variant ? char.toUpperCase() : char).join("");
          return `${prefix}${letters}-${longTail}.txt`;
        }).reverse(),
      };
    }).reverse();
    const built = buildPathWarnings(groups)!;
    const reordered = buildPathWarnings([...groups].reverse().map((group) => ({ paths: [...group.paths].reverse() })))!;
    expect(built.fingerprint).toBe(reordered.fingerprint);
    expect(built.groupCount).toBe(150);
    expect(built.pathCount).toBe(1_500);
    expect(built.collisions.length).toBeLessThanOrEqual(PATH_WARNINGS_MAX_GROUPS);
    expect(built.collisions.every((group) => group.paths.length >= 2 && group.paths.length <= PATH_WARNINGS_MAX_PATHS_PER_GROUP)).toBe(true);
    const root = await tempRoot();
    await writePathWarnings(root, built);
    expect((await fs.stat(pathWarningsPath(root))).size).toBeLessThanOrEqual(PATH_WARNINGS_MAX_BYTES);
    expect(await readPathWarnings(root)).toEqual(built);
  });

  test("rejects invalid producer input instead of persisting misleading counts", () => {
    expect(() => buildPathWarnings([{ paths: ["only.txt"] }])).toThrow("at least two");
    expect(() => buildPathWarnings([{ paths: ["A.txt", "b.txt"] }])).toThrow("not case-equivalent");
    expect(() => buildPathWarnings([{ paths: ["../A.txt", "../a.txt"] }])).toThrow("unsafe path");
    expect(() => buildPathWarnings([pair("a"), pair("A")])).toThrow("duplicate path collision group");
  });

  test("reader ignores malformed, extra-key, oversized, symlink, and noncanonical records", async () => {
    const root = await tempRoot();
    const file = pathWarningsPath(root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "not json");
    expect(await readPathWarnings(root)).toBeUndefined();
    await fs.writeFile(file, "x".repeat(PATH_WARNINGS_MAX_BYTES + 1));
    expect(await readPathWarnings(root)).toBeUndefined();
    await fs.writeFile(file, JSON.stringify({ ...buildPathWarnings([pair("docs")]), extra: true }));
    expect(await readPathWarnings(root)).toBeUndefined();
    await fs.writeFile(file, JSON.stringify({
      ...buildPathWarnings([pair("docs")]),
      collisions: [{ paths: ["docs/Readme.md", "docs/README.md"] }],
    }));
    expect(await readPathWarnings(root)).toBeUndefined();
    await fs.rm(file);
    const outside = path.join(root, "outside");
    await fs.writeFile(outside, JSON.stringify(buildPathWarnings([pair("docs")])));
    await fs.symlink(outside, file);
    expect(await readPathWarnings(root)).toBeUndefined();
  });

  test("reader and clearer refuse a symlinked warning directory", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    const outsideFile = path.join(outside, "path-warnings.json");
    await fs.writeFile(outsideFile, JSON.stringify(buildPathWarnings([pair("outside")])), { mode: 0o600 });
    await fs.mkdir(path.join(root, ".rbox"));
    await fs.symlink(outside, path.join(root, ".rbox", "state"));

    expect(await readPathWarnings(root)).toBeUndefined();
    await expect(clearPathWarnings(root)).rejects.toThrow("unsafe path warning directory");
    expect(await fs.readFile(outsideFile, "utf8")).toContain("outside");
  });

  test("atomic racing replacements are never observed torn", async () => {
    const root = await tempRoot();
    await savePathWarnings(root, [pair("seed")]);
    const writer = Promise.all(Array.from({ length: 40 }, (_, index) =>
      savePathWarnings(root, [pair(`group-${String(index).padStart(2, "0")}`)])));
    const reads = await Promise.all(Array.from({ length: 80 }, () => readPathWarnings(root)));
    await writer;
    expect(reads.every((value) => value === undefined || (value.v === 1 && value.groupCount === 1 && value.pathCount === 2))).toBe(true);
    expect((await readPathWarnings(root))?.groupCount).toBe(1);
  });

  test("workspace reset removes warnings from the old binding", async () => {
    const root = await tempRoot();
    await savePathWarnings(root, [pair("docs")]);
    await resetSyncState(root, "path-warning-test-stream");
    expect(await readPathWarnings(root)).toBeUndefined();
  });
});
