import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listTrash } from "../engine/trash.js";
import { trashCmd } from "./trash-cmd.js";

// Design 50 §2: the `rbox trash` surface over the local trash tier. Batches are seeded
// directly on disk in trash.ts's on-disk layout (`.rbox/trash/<batchName>/<relPath>`,
// batchName = the pull ISO with `:`/`.` → `-`), so these test the CLI wrapper against
// the real engine, not a mock.

let root: string;

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
/** batchName(new Date(iso)) — the filesystem-safe batch dir name trash.ts writes. */
const batchDirName = (iso: string) => iso.replace(/[:.]/g, "-");

/** Seed a settled (no `.active` marker) batch stamped at `iso`. Old stamps make the
 *  batch eligible for `empty` (the engine protects anything younger than 15 minutes). */
async function seedTrash(iso: string, files: Record<string, string>): Promise<void> {
  const base = path.join(root, ".rbox", "trash", batchDirName(iso));
  await fs.mkdir(base, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(base, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
}

/** Run a command capturing its stdout/stderr and the exit code it sets (then reset). */
async function capture(fn: () => Promise<void>): Promise<{ out: string; err: string; code: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origWrite = process.stderr.write.bind(process.stderr);
  process.exitCode = 0; // NOT `undefined`: in Bun that assignment is a no-op — a prior 1 would leak into the suite's exit code
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  process.stderr.write = ((s: string | Uint8Array) => {
    err.push(String(s));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    console.log = origLog;
    process.stderr.write = origWrite;
  }
  const code = process.exitCode;
  process.exitCode = 0; // same no-op trap as above — 0 is the only real reset
  return { out: stripAnsi(out.join("\n")), err: stripAnsi(err.join("")), code: code === 0 ? undefined : code };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-trash-cmd-"));
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test("trash list shows batch, path, and size for each trashed file", async () => {
  await seedTrash("2020-01-01T00:00:00.000Z", { "src/a.txt": "aaaa", "docs/b.md": "bb" });
  const { out } = await capture(() => trashCmd(root, ["list"], {}));
  expect(out).toContain("2 files in trash");
  expect(out).toContain("src/a.txt");
  expect(out).toContain("docs/b.md");
  expect(out).toContain("2020-01-01T00-00-00-000Z"); // the batch stamp
});

test("trash list on an empty trash prints a friendly line", async () => {
  const { out } = await capture(() => trashCmd(root, ["list"], {}));
  expect(out).toContain("trash is empty");
});

test("trash restore renames a trashed file back into the workspace", async () => {
  await seedTrash("2020-01-01T00:00:00.000Z", { "src/a.txt": "hello" });
  const { code, out } = await capture(() => trashCmd(root, ["restore", "src/a.txt"], {}));
  expect(code).toBeUndefined();
  expect(out).toContain("restored");
  expect(await fs.readFile(path.join(root, "src/a.txt"), "utf8")).toBe("hello");
  // and it left the trash
  expect((await listTrash(root)).find((e) => e.path === "src/a.txt")).toBeUndefined();
});

test("trash restore diverts to a conflict copy when the target already exists (never overwrites)", async () => {
  await seedTrash("2020-01-01T00:00:00.000Z", { "a.txt": "from-trash" });
  await fs.writeFile(path.join(root, "a.txt"), "current"); // occupy the target
  const { out } = await capture(() => trashCmd(root, ["restore", "a.txt"], {}));

  // The occupying file is untouched.
  expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("current");
  // The trashed bytes landed at a DIFFERENT (conflict) name.
  let diverted = "";
  for (const f of await fs.readdir(root)) {
    if (f === "a.txt" || f === ".rbox") continue;
    const st = await fs.lstat(path.join(root, f));
    if (st.isFile() && (await fs.readFile(path.join(root, f), "utf8")) === "from-trash") diverted = f;
  }
  expect(diverted).not.toBe("");
  expect(diverted).toContain("conflict");
  expect(out).toContain("kept both");
});

test("trash restore --batch pins the source batch", async () => {
  await seedTrash("2020-01-01T00:00:00.000Z", { "a.txt": "old" });
  await seedTrash("2021-01-01T00:00:00.000Z", { "a.txt": "new" });
  // Newest-first default would take "new"; pin the older batch instead.
  await capture(() => trashCmd(root, ["restore", "a.txt"], { batch: batchDirName("2020-01-01T00:00:00.000Z") }));
  expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("old");
});

test("trash restore of an unknown path reports on stderr and exits non-zero", async () => {
  await seedTrash("2020-01-01T00:00:00.000Z", { "a.txt": "x" });
  const { err, code } = await capture(() => trashCmd(root, ["restore", "does/not/exist.txt"], {}));
  expect(code).toBe(1);
  expect(err).toMatch(/not found in trash/);
});

test("trash empty removes eligible batches and reports bytes freed", async () => {
  await seedTrash("2020-01-01T00:00:00.000Z", { "a.txt": "1234567890" });
  await seedTrash("2020-02-01T00:00:00.000Z", { "nested/b.txt": "xyz" });
  const { out } = await capture(() => trashCmd(root, ["empty"], {}));
  expect(out).toMatch(/emptied 2 batches/);
  expect(await listTrash(root)).toHaveLength(0);
});

test("unknown trash subcommand prints usage and exits non-zero", async () => {
  const { out, code } = await capture(() => trashCmd(root, ["bogus"], {}));
  expect(code).toBe(1);
  expect(out).toContain("usage: rbox trash");
});
