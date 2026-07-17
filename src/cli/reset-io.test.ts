import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ResetCorruptionError,
  ResetMemoryAdmissionError,
  assertResetParseAdmission,
  boundedCopy,
  boundedEqualsBytes,
  boundedFilesEqual,
  boundedHash,
  boundedJsonRead,
  boundedRead,
  boundedStream,
  RESET_MATERIALIZED_BYTE_LIMIT,
  RESET_STREAM_BYTE_LIMIT,
} from "./reset-io.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-reset-io-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("design 138 bounded reset I/O", () => {
  test("boundedRead refuses symlinks and non-regular inputs", async () => {
    const file = path.join(dir, "state.json");
    const link = path.join(dir, "state-link.json");
    await fs.writeFile(file, "safe");
    await fs.symlink(file, link);
    await expect(boundedRead(link, 16)).rejects.toBeInstanceOf(ResetCorruptionError);
    await expect(boundedRead(dir, 16)).rejects.toBeInstanceOf(ResetCorruptionError);
  });

  test("the hard byte counter catches in-place growth beyond the cap", async () => {
    const file = path.join(dir, "growing");
    await fs.writeFile(file, "1234");
    let grew = false;
    await expect(boundedStream(file, 6, () => {}, {
      chunkBytes: 2,
      onChunk: async () => {
        if (grew) return;
        grew = true;
        await fs.appendFile(file, "5678");
      },
    })).rejects.toThrow("exceeded its byte limit");
  });

  test("post-read pathname identity rejects rename replacement", async () => {
    const file = path.join(dir, "replaced");
    const replacement = path.join(dir, "replacement");
    await fs.writeFile(file, "1234");
    await fs.writeFile(replacement, "abcd");
    let replaced = false;
    await expect(boundedStream(file, 16, () => {}, {
      chunkBytes: 2,
      onChunk: async () => {
        if (replaced) return;
        replaced = true;
        await fs.rename(replacement, file);
      },
    })).rejects.toThrow("changed while reading");
  });

  test("streaming hash, byte equality, file equality, and copy do not need whole-source reads", async () => {
    const source = path.join(dir, "source");
    const copy = path.join(dir, "nested", "copy");
    const bytes = Buffer.from("a".repeat(200_000));
    await fs.writeFile(source, bytes);
    expect(await boundedHash(source, bytes.length)).toBe("2287d207f24a941ff3b56c04c8a25ad56b63e3023207b3bb5b4ac0c9869d74be");
    expect(await boundedEqualsBytes(source, bytes, bytes.length)).toBe(true);
    expect(await boundedCopy(source, copy, bytes.length)).toBe(true);
    expect(await boundedFilesEqual(source, copy, bytes.length)).toBe(true);
  });

  test("parse admission uses live RSS headroom and fails before JSON allocation", () => {
    expect(() => assertResetParseAdmission(100, {
      processBudgetBytes: 1_000,
      currentRssBytes: 500,
      expansionMultiplier: 6,
    })).toThrow(ResetMemoryAdmissionError);
    expect(() => assertResetParseAdmission(100, {
      processBudgetBytes: 1_100,
      currentRssBytes: 500,
      expansionMultiplier: 6,
    })).not.toThrow();
  });

  test("materialized and streaming ceilings are enforced at their exact boundaries", async () => {
    expect(() => assertResetParseAdmission(RESET_MATERIALIZED_BYTE_LIMIT, {
      processBudgetBytes: Number.MAX_SAFE_INTEGER,
      currentRssBytes: 0,
      expansionMultiplier: 1,
    })).not.toThrow();
    expect(() => assertResetParseAdmission(RESET_MATERIALIZED_BYTE_LIMIT + 1, {
      processBudgetBytes: Number.MAX_SAFE_INTEGER,
      currentRssBytes: 0,
      expansionMultiplier: 1,
    })).toThrow("512 MiB file limit");

    const materializedTooLarge = path.join(dir, "materialized-too-large");
    const streamingTooLarge = path.join(dir, "streaming-too-large");
    await fs.writeFile(materializedTooLarge, "");
    await fs.truncate(materializedTooLarge, RESET_MATERIALIZED_BYTE_LIMIT + 1);
    await fs.writeFile(streamingTooLarge, "");
    await fs.truncate(streamingTooLarge, RESET_STREAM_BYTE_LIMIT + 1);
    await expect(boundedJsonRead(materializedTooLarge, RESET_MATERIALIZED_BYTE_LIMIT)).rejects.toThrow("oversized reset file");
    await expect(boundedStream(streamingTooLarge, RESET_STREAM_BYTE_LIMIT, () => {})).rejects.toThrow("oversized reset file");
  });

  test("deep JSON parser RangeError is normalized to typed reset corruption", async () => {
    const file = path.join(dir, "deep.json");
    await fs.writeFile(file, "{}");
    const original = JSON.parse;
    JSON.parse = (() => { throw new RangeError("stack"); }) as typeof JSON.parse;
    try {
      await expect(boundedJsonRead(file, 64, {
        processBudgetBytes: Number.MAX_SAFE_INTEGER,
        currentRssBytes: 0,
        expansionMultiplier: 1,
      })).rejects.toMatchObject({ code: "RESET_CORRUPTION" });
    } finally {
      JSON.parse = original;
    }
  });

  test("65 MiB fleet-regression state clears the former 64 MiB reset ceiling", async () => {
    const file = path.join(dir, "fleet-state.json");
    const target = 65 * 1024 * 1024;
    const prefix = Buffer.from('{"padding":"');
    const suffix = Buffer.from('"}');
    const handle = await fs.open(file, "w");
    try {
      await handle.write(prefix);
      const block = Buffer.alloc(1024 * 1024, 0x61);
      let remaining = target - prefix.byteLength - suffix.byteLength;
      while (remaining > 0) {
        const count = Math.min(remaining, block.byteLength);
        await handle.write(block, 0, count);
        remaining -= count;
      }
      await handle.write(suffix);
    } finally { await handle.close(); }
    const parsed = await boundedJsonRead<{ padding: string }>(file);
    expect(parsed?.padding.length).toBe(target - prefix.byteLength - suffix.byteLength);
  }, 30_000);
});
