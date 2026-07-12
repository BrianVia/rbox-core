import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bulkWalkDir, bulkWalkSupported } from "./darwin-bulk-walk.js";
import { scanManifest, statsStableAcrossHash } from "./manifest.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

test("bulk walk is safely unavailable off Darwin", () => {
  if (process.platform === "darwin") return;
  expect(bulkWalkSupported()).toBe(false);
  expect(() => bulkWalkDir(".")).not.toThrow();
  expect(bulkWalkDir(".")).toBeNull();
});

const darwinTest = process.platform === "darwin" ? test : test.skip;

darwinTest("getattrlistbulk inventory and file metadata exactly match Bun lstat", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-bulk-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "nested/empty"), { recursive: true });
  // Short-named subdir + symlink: dir/symlink records omit the file-only
  // ATTR_FILE_DATALENGTH word, so a 1-char name yields a record shorter than a
  // file's fixed size. Guards the record-length floor against rejecting them
  // (which pre-fix fell the WHOLE parent directory back to readdir).
  await fs.mkdir(path.join(root, "d"));
  await fs.symlink("d", path.join(root, "s"));
  const files: Array<[string, string]> = [
    ["zero", ""], ["small.txt", "abc"], ["name with spaces.and.dots", "dots"],
    ["é", "accent"], ["日本語", "nihongo"], ["emoji-😀", "emoji"], ["nested/file", "nested"],
  ];
  await Promise.all(files.map(([name, body]) => fs.writeFile(path.join(root, name), body)));
  await fs.mkdir(path.join(root, "large"));
  await Promise.all(Array.from({ length: 5_000 }, (_, i) => fs.writeFile(path.join(root, "large", `f-${i}`), i % 9 === 0 ? "" : String(i))));
  await fs.symlink("small.txt", path.join(root, "link-file"));
  await fs.symlink("nested", path.join(root, "link-dir"));
  await fs.symlink("missing", path.join(root, "link-dangling"));
  await fs.chmod(path.join(root, "small.txt"), 0o6755).catch(() => undefined);

  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    const bulk = bulkWalkDir(dir);
    expect(bulk).not.toBeNull();
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const expected = entries.flatMap((entry) => entry.isDirectory() ? [[entry.name, "dir"]]
      : entry.isSymbolicLink() ? [[entry.name, "symlink"]]
      : entry.isFile() ? [[entry.name, "file"]] : []).sort();
    const actual = bulk!.map((entry) => [entry.name, entry.type]).sort();
    expect(new Set(bulk!.map((entry) => entry.name)).size).toBe(bulk!.length);
    expect(actual).toEqual(expected);
    for (const child of bulk!) {
      const abs = path.join(dir, child.name);
      if (child.type === "dir") pending.push(abs);
      if (child.type !== "file") continue;
      const st = await fs.lstat(abs);
      expect(child.stat).toBeDefined();
      expect({ size: child.stat!.size, mtimeMs: child.stat!.mtimeMs, ctimeMs: child.stat!.ctimeMs,
        mode: child.stat!.mode, ino: child.stat!.ino, dev: child.stat!.dev }).toEqual({
        size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, mode: st.mode, ino: st.ino, dev: st.dev,
      });
      expect([child.stat!.mtimeMs, child.stat!.size, child.stat!.ctimeMs]).toEqual([st.mtimeMs, st.size, st.ctimeMs]);
      expect(statsStableAcrossHash(child.stat!, st)).toBe(true);
    }
  }

  const before = bulkWalkDir(root)!.find((entry) => entry.name === "small.txt")!.stat!;
  await fs.appendFile(path.join(root, "small.txt"), "changed");
  const after = await fs.lstat(path.join(root, "small.txt"));
  expect(statsStableAcrossHash(before, after)).toBe(false);

  const changing = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-bulk-changing-"));
  roots.push(changing);
  const changingFile = path.join(changing, "changing.bin");
  await fs.writeFile(changingFile, Buffer.alloc(32 * 1024 * 1024, 1));
  const deferred = new Set<string>();
  let mutating = true;
  const mutation = (async () => { while (mutating) await fs.appendFile(changingFile, "x"); })();
  const priorFlag = process.env.RBOX_SCAN_BULK;
  process.env.RBOX_SCAN_BULK = "1";
  try {
    const manifest = await scanManifest(changing, undefined, undefined, undefined, undefined, undefined, deferred);
    expect(manifest.files.some((entry) => entry.path === "changing.bin")).toBe(false);
    expect(deferred.has("changing.bin")).toBe(true);
  } finally {
    mutating = false;
    await mutation;
    if (priorFlag === undefined) delete process.env.RBOX_SCAN_BULK;
    else process.env.RBOX_SCAN_BULK = priorFlag;
  }
});
