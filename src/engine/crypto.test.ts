import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { decryptFileToPath, encryptFileToTemp, generateKek, isSourceChangedError } from "./crypto.js";

/** Regression for the concurrency race: blob upload now encrypts files through a
 *  worker-pool, so two identical-content files (same plaintextSha) encrypt at the
 *  same time INTO THE SAME tmpDir. The temp name must be unique per call — keying
 *  it by content let the interleaved writes corrupt the ciphertext (sha mismatch
 *  on upload). This proves concurrent identical-content encryption is correct. */
describe("encryptFileToTemp / decryptFileToPath edge cases", () => {
  test("empty (0-byte) files round-trip — .gitkeep / __init__.py / py.typed", async () => {
    const kek = generateKek();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-empty-rt-"));
    try {
      const src = path.join(root, "empty.txt");
      await fs.writeFile(src, "");
      const blob = await encryptFileToTemp(src, kek);
      const out = path.join(root, "out.txt");
      await decryptFileToPath(blob.ciphertextPath, kek, blob.plaintextSha, out); // used to throw on the [0,-1] range
      expect((await fs.stat(out)).size).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("compress-before-encrypt prototype", () => {
  test("compressible payload encrypts compressed bytes and round-trips", async () => {
    const kek = generateKek();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-zstd-rt-"));
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-zstd-ct-"));
    try {
      const src = path.join(root, "story.txt");
      const content = Buffer.from("compress me please\n".repeat(10_000));
      await fs.writeFile(src, content);

      const blob = await encryptFileToTemp(src, kek, tmpDir, { compress: true });

      expect(blob.comp).toBe("zstd");
      expect(blob.payloadSha).toMatch(/^[0-9a-f]{64}$/);
      expect(blob.payloadSha).not.toBe(blob.plaintextSha);
      expect(blob.cipherSize).toBeLessThan(content.length);

      const out = path.join(root, "out.txt");
      await decryptFileToPath(blob.ciphertextPath, kek, blob.plaintextSha, out, { comp: blob.comp, payloadSha: blob.payloadSha });
      expect(fsSync.readFileSync(out).equals(content)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("incompressible payload falls back to byte-identical raw encryption", async () => {
    const kek = generateKek();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-zstd-rand-"));
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-zstd-rand-ct-"));
    try {
      const src = path.join(root, "random.bin");
      await fs.writeFile(src, randomBytes(8192));

      const compressedAttempt = await encryptFileToTemp(src, kek, tmpDir, { compress: true });
      const raw = await encryptFileToTemp(src, kek, tmpDir, { compress: false });

      expect(compressedAttempt.comp).toBeUndefined();
      expect(compressedAttempt.payloadSha).toBeUndefined();
      expect(compressedAttempt.encSha).toBe(raw.encSha);
      expect(fsSync.readFileSync(compressedAttempt.ciphertextPath).equals(fsSync.readFileSync(raw.ciphertextPath))).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("same plaintext raw and compressed use different derivation inputs", async () => {
    const kek = generateKek();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-zstd-nonce-"));
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-zstd-nonce-ct-"));
    try {
      const src = path.join(root, "text.txt");
      const content = Buffer.from("same plaintext, different encrypted payload\n".repeat(8000));
      await fs.writeFile(src, content);

      const raw = await encryptFileToTemp(src, kek, tmpDir, { compress: false });
      const compressed = await encryptFileToTemp(src, kek, tmpDir, { compress: true });

      expect(compressed.comp).toBe("zstd");
      expect(compressed.payloadSha).not.toBe(raw.plaintextSha);
      expect(compressed.encSha).not.toBe(raw.encSha);
      expect(fsSync.readFileSync(compressed.ciphertextPath).equals(fsSync.readFileSync(raw.ciphertextPath))).toBe(false);

      const rawOut = path.join(root, "raw.out");
      const compressedOut = path.join(root, "compressed.out");
      await decryptFileToPath(raw.ciphertextPath, kek, raw.plaintextSha, rawOut);
      await decryptFileToPath(compressed.ciphertextPath, kek, compressed.plaintextSha, compressedOut, { comp: compressed.comp, payloadSha: compressed.payloadSha });
      expect(fsSync.readFileSync(rawOut).equals(content)).toBe(true);
      expect(fsSync.readFileSync(compressedOut).equals(content)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("compressed decrypt requires the right payloadSha and removes partial output", async () => {
    const kek = generateKek();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-zstd-bad-sha-"));
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-zstd-bad-sha-ct-"));
    try {
      const src = path.join(root, "text.txt");
      await fs.writeFile(src, Buffer.from("payloadSha guard\n".repeat(10_000)));
      const blob = await encryptFileToTemp(src, kek, tmpDir, { compress: true });
      expect(blob.comp).toBe("zstd");

      const missingOut = path.join(root, "missing.out");
      await expect(decryptFileToPath(blob.ciphertextPath, kek, blob.plaintextSha, missingOut, { comp: "zstd" })).rejects.toThrow(/payloadSha/);
      expect(fsSync.existsSync(missingOut)).toBe(false);

      const wrongOut = path.join(root, "wrong.out");
      const wrongPayloadSha = blob.payloadSha === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
      await expect(decryptFileToPath(blob.ciphertextPath, kek, blob.plaintextSha, wrongOut, { comp: "zstd", payloadSha: wrongPayloadSha })).rejects.toThrow();
      expect(fsSync.existsSync(wrongOut)).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("tampered compressed ciphertext fails authentication", async () => {
    const kek = generateKek();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-zstd-tamper-"));
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-zstd-tamper-ct-"));
    try {
      const src = path.join(root, "text.txt");
      await fs.writeFile(src, Buffer.from("tamper me\n".repeat(10_000)));
      const blob = await encryptFileToTemp(src, kek, tmpDir, { compress: true });
      expect(blob.comp).toBe("zstd");

      const tampered = path.join(root, "tampered.ct");
      const bytes = await fs.readFile(blob.ciphertextPath);
      bytes[0] = bytes[0]! ^ 0xff;
      await fs.writeFile(tampered, bytes);

      const out = path.join(root, "out.txt");
      await expect(decryptFileToPath(tampered, kek, blob.plaintextSha, out, { comp: blob.comp, payloadSha: blob.payloadSha })).rejects.toThrow();
      expect(fsSync.existsSync(out)).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("compressed decrypt enforces the declared plaintext cap and removes partial output", async () => {
    const kek = generateKek();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-zstd-cap-"));
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-zstd-cap-ct-"));
    try {
      const src = path.join(root, "text.txt");
      const content = Buffer.from("cap me\n".repeat(50_000));
      await fs.writeFile(src, content);
      const blob = await encryptFileToTemp(src, kek, tmpDir, { compress: true });
      expect(blob.comp).toBe("zstd");

      const out = path.join(root, "out.txt");
      await expect(
        decryptFileToPath(blob.ciphertextPath, kek, blob.plaintextSha, out, {
          comp: blob.comp,
          payloadSha: blob.payloadSha,
          maxPlaintextBytes: content.length - 1,
        })
      ).rejects.toThrow(/decompressed plaintext exceeds declared size/);
      expect(fsSync.existsSync(out)).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("small compressed files avoid a compressed temp and remain deterministic against the stream path", async () => {
    const kek = generateKek();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-zstd-buffer-"));
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-zstd-buffer-ct-"));
    try {
      const src = path.join(root, "small.txt");
      await fs.writeFile(src, Buffer.from("buffered frame\n".repeat(20_000)));

      const buffered = await encryptFileToTemp(src, kek, tmpDir, { compress: true });
      const forcedStream = await encryptFileToTemp(src, kek, tmpDir, { compress: true, bufferedCompressionMaxBytes: 0 });

      expect(buffered.comp).toBe("zstd");
      expect(forcedStream.comp).toBe("zstd");
      expect(buffered.payloadSha).toBe(forcedStream.payloadSha);
      expect(buffered.encSha).toBe(forcedStream.encSha);
      expect(fsSync.readFileSync(buffered.ciphertextPath).equals(fsSync.readFileSync(forcedStream.ciphertextPath))).toBe(true);
      expect((await fs.readdir(tmpDir)).some((entry) => entry.endsWith(".zst"))).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test(">4MiB compressed files use the streaming path and match the same-frame buffered path", async () => {
    const kek = generateKek();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-zstd-large-"));
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-zstd-large-ct-"));
    try {
      const src = path.join(root, "large.txt");
      const content = Buffer.alloc(4 * 1024 * 1024 + 1024, 0x61);
      await fs.writeFile(src, content);

      const streamed = await encryptFileToTemp(src, kek, tmpDir, { compress: true });
      const forcedBuffered = await encryptFileToTemp(src, kek, tmpDir, { compress: true, bufferedCompressionMaxBytes: Number.MAX_SAFE_INTEGER });

      expect(streamed.comp).toBe("zstd");
      expect(forcedBuffered.comp).toBe("zstd");
      expect(streamed.payloadSha).toBe(forcedBuffered.payloadSha);
      expect(streamed.encSha).toBe(forcedBuffered.encSha);
      expect(fsSync.readFileSync(streamed.ciphertextPath).equals(fsSync.readFileSync(forcedBuffered.ciphertextPath))).toBe(true);

      const out = path.join(root, "large.out");
      await decryptFileToPath(streamed.ciphertextPath, kek, streamed.plaintextSha, out, { comp: streamed.comp, payloadSha: streamed.payloadSha, maxPlaintextBytes: content.length });
      expect(fsSync.readFileSync(out).equals(content)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

/** Snapshot-first integrity: `encryptFileToTemp` copies the source to an immutable
 *  snapshot ONCE, so `plaintextSha`, the ciphertext, and `encSha` all describe the
 *  same point-in-time bytes. If the live file is edited AFTER encrypt returns, the
 *  produced blob must still decrypt to the ORIGINAL bytes and pass its integrity
 *  check — proving it captured a snapshot, not a live reference. Before this fix a
 *  file edited between the key-deriving hash and the encrypting read produced a blob
 *  whose recorded plaintextSha didn't match its plaintext → permanently un-pullable. */
describe("encryptFileToTemp snapshot isolation (concurrent-write safety)", () => {
  test("editing the source after encrypt still decrypts to the original bytes + passes integrity", async () => {
    const kek = generateKek();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-snap-iso-"));
    try {
      const src = path.join(root, "live.txt");
      const original = Buffer.from("ORIGINAL point-in-time content\n".repeat(500));
      await fs.writeFile(src, original);

      const blob = await encryptFileToTemp(src, kek);

      // Simulate a live dev workspace: the file is rewritten AFTER encrypt returns
      // (and even truncated to a different length), the way an agent/build would.
      await fs.writeFile(src, Buffer.from("TOTALLY DIFFERENT bytes now\n"));

      // The blob must decrypt to the ORIGINAL snapshot bytes and pass the integrity
      // assertion against the recorded plaintextSha — not the live file's new bytes.
      const out = path.join(root, "recovered.txt");
      await decryptFileToPath(blob.ciphertextPath, kek, blob.plaintextSha, out);
      expect(fsSync.readFileSync(out).equals(original)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("no snapshot temp leaks in the ciphertext tmpDir after a successful encrypt", async () => {
    const kek = generateKek();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-snap-leak-"));
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-snap-ct-"));
    try {
      const src = path.join(root, "f.txt");
      await fs.writeFile(src, Buffer.from("some bytes\n".repeat(64)));
      const blob = await encryptFileToTemp(src, kek, tmpDir);
      const entries = await fs.readdir(tmpDir);
      // Only the ciphertext temp should remain; the .snap file must be cleaned up.
      expect(entries.some((e) => e.endsWith(".snap"))).toBe(false);
      expect(entries).toContain(path.basename(blob.ciphertextPath));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("no temp (snapshot or ciphertext) leaks when the source doesn't exist", async () => {
    const kek = generateKek();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-snap-err-"));
    try {
      await expect(encryptFileToTemp(path.join(tmpDir, "does-not-exist.txt"), kek, tmpDir)).rejects.toThrow();
      expect(await fs.readdir(tmpDir)).toEqual([]); // nothing left behind on the error path
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  /** The KEY regression guard: exercise the actual hash-vs-encrypt race. A background
   *  writer rewrites the source (between two DIFFERENT-length contents) WHILE we
   *  encrypt it, over and over. The single guarantee that must hold on EVERY blob:
   *  it decrypts to bytes matching its recorded plaintextSha (the integrity check in
   *  decryptFileToPath throws otherwise). Pre-fix, the two separate reads of the live
   *  file (hash, then encrypt) could see different bytes when a write landed between
   *  them → the committed plaintextSha wouldn't match the ciphertext → un-pullable.
   *  A torn snapshot is fine: it's self-consistent, so it still round-trips. */
  test("concurrent writes DURING encryption never corrupt the blob (hash-vs-encrypt race)", async () => {
    const kek = generateKek();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-snap-race-"));
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-snap-race-ct-"));
    try {
      const src = path.join(root, "live.txt");
      // Different lengths so a torn/late read is detectably inconsistent, not a
      // coincidental match. Kept under the 1 MiB whole-read hash threshold on purpose
      // (that's the path the old two-read code took for typical source files).
      const a = Buffer.from("A".repeat(200_000));
      const b = Buffer.from("B".repeat(120_000) + "tail\n");
      await fs.writeFile(src, a);

      let stop = false;
      const writer = (async () => {
        let flip = false;
        while (!stop) {
          await fs.writeFile(src, flip ? a : b).catch(() => {}); // in-place rewrite
          flip = !flip;
        }
      })();

      try {
        for (let i = 0; i < 40; i++) {
          const blob = await encryptFileToTemp(src, kek, tmpDir);
          const out = path.join(root, `out-${i}.bin`);
          // Throws on integrity mismatch — the assertion IS that this never throws.
          await decryptFileToPath(blob.ciphertextPath, kek, blob.plaintextSha, out);
          await fs.rm(out, { force: true });
          await fs.rm(blob.ciphertextPath, { force: true });
        }
      } finally {
        stop = true;
        await writer; // stop the writer BEFORE root cleanup so it can't ENOENT-mask the failure
      }
      // Snapshot temps must not have accumulated across all those iterations.
      expect((await fs.readdir(tmpDir)).some((e) => e.endsWith(".snap"))).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("encryptFileToTemp under concurrency", () => {
  test("identical-content files encrypted concurrently don't collide or corrupt", async () => {
    const kek = generateKek();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-crypto-test-"));
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-crypto-ct-"));
    try {
      // 20 files, ALL the same bytes ⇒ same plaintextSha ⇒ would collide on a
      // content-keyed temp path. Plus a couple of empties (the classic dup case).
      const content = Buffer.from("the same content in every file\n".repeat(100));
      const srcs = await Promise.all(
        Array.from({ length: 20 }, async (_, i) => {
          const p = path.join(root, `dup-${i}.txt`);
          await fs.writeFile(p, content);
          return p;
        })
      );

      // Encrypt them all concurrently into the SAME tmpDir (what the pool does).
      const blobs = await Promise.all(srcs.map((s) => encryptFileToTemp(s, kek, tmpDir)));

      // All share one plaintextSha + encSha (convergent), but DISTINCT temp paths.
      const encShas = new Set(blobs.map((b) => b.encSha));
      const paths = new Set(blobs.map((b) => b.ciphertextPath));
      expect(encShas.size).toBe(1); // convergent: identical content → identical address
      expect(paths.size).toBe(blobs.length); // but every call wrote its own file

      // Every ciphertext on disk actually hashes to the claimed encSha (no torn
      // writes) AND decrypts back to the original bytes.
      for (const b of blobs) {
        const onDisk = await fs.readFile(b.ciphertextPath);
        expect(createHash("sha256").update(onDisk).digest("hex")).toBe(b.encSha);
        const out = path.join(root, `out-${path.basename(b.ciphertextPath)}`);
        await decryptFileToPath(b.ciphertextPath, kek, b.plaintextSha, out);
        expect(fsSync.readFileSync(out).equals(content)).toBe(true);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("encryptFileToTemp expected-size snapshot cap", () => {
  test("rejects a source that grew past the scanned size and cleans the snapshot", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-snapshot-cap-"));
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-snapshot-cap-ct-"));
    try {
      const src = path.join(root, "grown.bin");
      const scanned = Buffer.from("scanned bytes");
      await fs.writeFile(src, Buffer.concat([scanned, Buffer.alloc(128 * 1024, 1)]));
      const expected = { sha256: createHash("sha256").update(scanned).digest("hex"), size: scanned.length };
      let caught: unknown;
      try { await encryptFileToTemp(src, generateKek(), tmpDir, { expected }); } catch (error) { caught = error; }
      expect(isSourceChangedError(caught)).toBe(true);
      expect(await fs.readdir(tmpDir)).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("expected-size encryption is byte-identical for an unchanged source", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-snapshot-exact-"));
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-snapshot-exact-ct-"));
    try {
      const src = path.join(root, "exact.bin");
      const content = Buffer.from("unchanged expected content\n".repeat(100));
      await fs.writeFile(src, content);
      const kek = generateKek();
      const legacy = await encryptFileToTemp(src, kek, tmpDir);
      const expected = { sha256: createHash("sha256").update(content).digest("hex"), size: content.length };
      const bounded = await encryptFileToTemp(src, kek, tmpDir, { expected });
      expect(bounded.encSha).toBe(legacy.encSha);
      expect((await fs.readFile(bounded.ciphertextPath)).equals(await fs.readFile(legacy.ciphertextPath))).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
