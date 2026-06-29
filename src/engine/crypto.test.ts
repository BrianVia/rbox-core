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
