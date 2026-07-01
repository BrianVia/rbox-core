import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { decryptFileToPath, encryptFileToTemp, generateKek } from "./crypto.js";

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
        const { createHash } = await import("node:crypto");
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
