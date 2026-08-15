import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ResetCorruptionError,
  ResetMemoryAdmissionError,
  assertResetParseAdmission,
  defaultResetParseBudgetBytes,
  linuxCgroupMemoryLimitBytes,
  RESET_PARSE_BUDGET_CEILING_BYTES,
  RESET_PARSE_BUDGET_FLOOR_BYTES,
  RESET_PARSE_EXPANSION_MULTIPLIER,
  boundedCopy,
  boundedEqualsBytes,
  boundedFilesEqual,
  boundedHash,
  boundedJsonRead,
  boundedRead,
  boundedStream,
  retryOnIdentityRace,
  RESET_MATERIALIZED_BYTE_LIMIT,
  RESET_STREAM_BYTE_LIMIT,
} from "./reset-io.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-reset-io-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("design 138 bounded reset I/O", () => {
  for (const lossPoint of ["temp-written", "before-rename"] as const) {
    test(`boundedCopy refuses authority loss at the ${lossPoint} adjacency`, async () => {
      const source = path.join(dir, "source-adjacent");
      const destination = path.join(dir, "destination-adjacent");
      await fs.writeFile(source, "new-bytes\n");
      await fs.writeFile(destination, "accepted-bytes\n");
      let owner = true;
      await expect(boundedCopy(source, destination, 64, {
        onStep(point) { if (point === lossPoint) owner = false; },
        beforeRenameSync() { if (!owner) throw new Error("owner lost at boundedCopy rename"); },
      })).rejects.toThrow("owner lost at boundedCopy rename");
      expect(await fs.readFile(destination, "utf8")).toBe("accepted-bytes\n");
    });
  }

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
    const read = boundedStream(file, 16, () => {}, {
      chunkBytes: 2,
      onChunk: async () => {
        if (replaced) return;
        replaced = true;
        await fs.rename(replacement, file);
      },
    });
    await expect(read).rejects.toMatchObject({
      kind: "identity-race",
      message: expect.stringContaining("changed while reading"),
    });
  });

  test("retryOnIdentityRace re-reads through one rename replacement and keeps every other failure", async () => {
    const file = path.join(dir, "republished");
    const replacement = path.join(dir, "successor");
    await fs.writeFile(file, "1234");
    await fs.writeFile(replacement, "abcd");
    let replaced = false;
    const seen: string[] = [];
    const hash = await retryOnIdentityRace(() => boundedHashWitness(file, seen, async () => {
      if (replaced) return;
      replaced = true;
      await fs.rename(replacement, file);
    }));
    expect(replaced).toBe(true);
    expect(seen).toEqual(["1234", "abcd"]);
    expect(hash).toBe(await boundedHash(file, 16));

    let attempts = 0;
    await expect(retryOnIdentityRace(async () => {
      attempts++;
      throw new ResetCorruptionError("torn state", { kind: "corruption" });
    })).rejects.toThrow("torn state");
    expect(attempts).toBe(1);

    let races = 0;
    await expect(retryOnIdentityRace(async () => {
      races++;
      throw new ResetCorruptionError("still moving", { kind: "identity-race" });
    })).rejects.toThrow("still moving");
    expect(races).toBe(3);
  });

  /** Hash `file` whole, recording the bytes each attempt saw, with a hook that can
   *  replace the file mid-read the way an atomic republish does. */
  async function boundedHashWitness(file: string, seen: string[], onChunk: () => Promise<void>): Promise<string> {
    let body = "";
    try {
      const result = await boundedStream(file, 16, (chunk) => { body += Buffer.from(chunk).toString(); }, {
        chunkBytes: 2,
        onChunk,
      });
      if (!result) throw new Error("witness file disappeared");
      return crypto.createHash("sha256").update(body).digest("hex");
    } finally {
      seen.push(body);
    }
  }

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

  test("default parse budget scales with machine memory: 4 GiB floor, totalmem/4, 32 GiB cap", () => {
    const GiB = 1024 ** 3;
    expect(defaultResetParseBudgetBytes(8 * GiB)).toBe(RESET_PARSE_BUDGET_FLOOR_BYTES);
    expect(defaultResetParseBudgetBytes(16 * GiB)).toBe(RESET_PARSE_BUDGET_FLOOR_BYTES);
    expect(defaultResetParseBudgetBytes(32 * GiB)).toBe(8 * GiB);
    expect(defaultResetParseBudgetBytes(96 * GiB)).toBe(24 * GiB);
    expect(defaultResetParseBudgetBytes(1024 * GiB)).toBe(RESET_PARSE_BUDGET_CEILING_BYTES);
  });

  test("cgroup hard limits cap the budget; unknown limits fall back to host scaling", () => {
    const GiB = 1024 ** 3;
    expect(defaultResetParseBudgetBytes(96 * GiB, 4 * GiB)).toBe(4 * GiB);
    expect(defaultResetParseBudgetBytes(96 * GiB, 2 * GiB)).toBe(2 * GiB);
    expect(defaultResetParseBudgetBytes(96 * GiB, 64 * GiB)).toBe(16 * GiB);
    expect(defaultResetParseBudgetBytes(96 * GiB, undefined)).toBe(24 * GiB);
    expect(linuxCgroupMemoryLimitBytes(() => undefined)).toBeUndefined();
    expect(linuxCgroupMemoryLimitBytes((f) => (f.endsWith("memory.max") ? "max\n" : undefined))).toBeUndefined();
    expect(linuxCgroupMemoryLimitBytes((f) => (f.endsWith("memory.max") ? `${4 * GiB}\n` : undefined))).toBe(4 * GiB);
    expect(linuxCgroupMemoryLimitBytes((f) => (f.endsWith("limit_in_bytes") ? "9223372036854771712" : undefined))).toBeUndefined();
    expect(linuxCgroupMemoryLimitBytes((f) => (f.endsWith("limit_in_bytes") ? `${2 * GiB}` : undefined))).toBe(2 * GiB);
    expect(linuxCgroupMemoryLimitBytes(() => "garbage")).toBeUndefined();
  });

  test("admission boundary is exact around the field threshold RSS", () => {
    const fileSize = 59_220_693;
    const budget = 4 * 1024 ** 3;
    const thresholdRss = budget - fileSize * RESET_PARSE_EXPANSION_MULTIPLIER; // 1,215,491,260
    expect(() => assertResetParseAdmission(fileSize, {
      processBudgetBytes: budget, currentRssBytes: thresholdRss, expansionMultiplier: RESET_PARSE_EXPANSION_MULTIPLIER,
    })).not.toThrow();
    expect(() => assertResetParseAdmission(fileSize, {
      processBudgetBytes: budget, currentRssBytes: thresholdRss + 1, expansionMultiplier: RESET_PARSE_EXPANSION_MULTIPLIER,
    })).toThrow(ResetMemoryAdmissionError);
  });

  test("env override: absolute when valid (unclamped both directions), machine-scaled fallback when absent/invalid", () => {
    const GiB = 1024 ** 3;
    const MiB = 1024 ** 2;
    const prior = process.env.RBOX_RESET_PARSE_BUDGET_BYTES;
    const admits = (fileSize: number) => {
      try {
        assertResetParseAdmission(fileSize, { currentRssBytes: 0 });
        return true;
      } catch {
        return false;
      }
    };
    try {
      // 50 MiB file: required ~2.55 GiB.
      // Below-default override (2 GiB) must be used VERBATIM → refuses what the 4 GiB floor would admit.
      process.env.RBOX_RESET_PARSE_BUDGET_BYTES = String(2 * GiB);
      expect(admits(50 * MiB)).toBe(false);
      // 500 MiB file: required ~25.4 GiB. Above-ceiling override (64 GiB) is not clamped → admits.
      process.env.RBOX_RESET_PARSE_BUDGET_BYTES = String(64 * GiB);
      expect(admits(500 * MiB)).toBe(true);
      // Absent and invalid values fall back to the machine-scaled default (≥ 4 GiB floor): 50 MiB admits.
      for (const raw of [undefined, "0", "-5", "abc", "1.5", "9007199254740992"]) {
        if (raw === undefined) delete process.env.RBOX_RESET_PARSE_BUDGET_BYTES;
        else process.env.RBOX_RESET_PARSE_BUDGET_BYTES = raw;
        expect(admits(50 * MiB)).toBe(true);
      }
    } finally {
      if (prior === undefined) delete process.env.RBOX_RESET_PARSE_BUDGET_BYTES;
      else process.env.RBOX_RESET_PARSE_BUDGET_BYTES = prior;
    }
  });

  test("2026-07-19 field regression: 59 MB state admits on a 96 GB machine, still fails closed on an 8 GB one", () => {
    const GiB = 1024 ** 3;
    const fileSize = 59_220_693;
    const rss = 1_300_000_000; // field: available was 2.99e9 = 4GiB − ~1.3GB
    expect(() => assertResetParseAdmission(fileSize, {
      processBudgetBytes: defaultResetParseBudgetBytes(96 * GiB),
      currentRssBytes: rss,
      expansionMultiplier: RESET_PARSE_EXPANSION_MULTIPLIER,
    })).not.toThrow();
    expect(() => assertResetParseAdmission(fileSize, {
      processBudgetBytes: defaultResetParseBudgetBytes(8 * GiB),
      currentRssBytes: rss,
      expansionMultiplier: RESET_PARSE_EXPANSION_MULTIPLIER,
    })).toThrow(ResetMemoryAdmissionError);
    try {
      assertResetParseAdmission(fileSize, {
        processBudgetBytes: defaultResetParseBudgetBytes(8 * GiB),
        currentRssBytes: rss,
        expansionMultiplier: RESET_PARSE_EXPANSION_MULTIPLIER,
      });
    } catch (error) {
      expect((error as Error).message).toContain("RBOX_RESET_PARSE_BUDGET_BYTES");
    }
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
