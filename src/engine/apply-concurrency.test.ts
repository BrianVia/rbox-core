import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { applyActions, type Action, type BlobStore, type FileEntry } from "./index.js";

const shaBytes = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let root: string | undefined;

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = undefined;
});

async function observedPeakFor(envValue: string | undefined, expectedPeak: number): Promise<number> {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-apply-conc-"));
  const previous = process.env.RBOX_DOWNLOAD_CONCURRENCY;
  if (envValue === undefined) delete process.env.RBOX_DOWNLOAD_CONCURRENCY;
  else process.env.RBOX_DOWNLOAD_CONCURRENCY = envValue;

  const content = Buffer.from("x");
  const sha256 = shaBytes(content);
  let active = 0;
  let peak = 0;
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reachedExpected = new Promise<void>((resolve) => {
    reached = resolve;
  });

  const store: BlobStore = {
    async has() {
      return true;
    },
    async put() {},
    async get() {
      return content;
    },
    async getToFile(_sha, dest) {
      active++;
      peak = Math.max(peak, active);
      if (peak >= expectedPeak) reached();
      await gate;
      await fs.writeFile(dest, content);
      active--;
    },
  };

  const entries: FileEntry[] = Array.from({ length: expectedPeak + 1 }, (_, i) => ({
    path: `f${i}.txt`,
    type: "file",
    sha256,
    size: content.length,
    mode: 0o644,
    mtimeMs: 1,
  }));
  const actions: Action[] = entries.map((entry) => ({ kind: "write", entry, expectedLocal: undefined }));
  const applyPromise = applyActions(root, actions, store);

  let waitError: unknown;
  try {
    try {
      await Promise.race([
        reachedExpected,
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`expected peak ${expectedPeak}, saw ${peak}`)), 1000)),
      ]);
    } catch (e) {
      waitError = e;
    }
  } finally {
    release();
  }

  try {
    await applyPromise;
  } finally {
    if (previous === undefined) delete process.env.RBOX_DOWNLOAD_CONCURRENCY;
    else process.env.RBOX_DOWNLOAD_CONCURRENCY = previous;
  }
  if (waitError) throw waitError;
  return peak;
}

test("download concurrency defaults to 128 when RBOX_DOWNLOAD_CONCURRENCY is unset", async () => {
  expect(await observedPeakFor(undefined, 128)).toBeGreaterThanOrEqual(128);
});

test("RBOX_DOWNLOAD_CONCURRENCY=64 preserves the old comparison behavior", async () => {
  expect(await observedPeakFor("64", 64)).toBe(64);
});
