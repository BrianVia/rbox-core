import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";

/** Files at/below this size are read whole (one syscall) instead of streamed —
 *  per-file stream setup dominates a cold scan of many small source files. */
const STREAM_THRESHOLD = 1024 * 1024; // 1 MiB

/**
 * SHA-256 of a file. Small files (the common case in source trees) are read in
 * one shot, avoiding the per-file stream-setup overhead that made a cold scan of
 * tens of thousands of files pathologically slow. Large files stream so we never
 * buffer the whole thing. `size` lets the caller skip a stat to choose the path.
 */
async function hashFileReal(absPath: string, size?: number): Promise<string> {
  if (size === undefined || size <= STREAM_THRESHOLD) {
    try {
      return hashBytes(await readFile(absPath));
    } catch {
      // Fall through to streaming (e.g. the file grew/changed under us).
    }
  }
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(absPath)
      .on("data", (chunk) => h.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

export type HashFile = typeof hashFileReal;
export const realHashFileForTests: HashFile = hashFileReal;
let hashFileGeneration = 0;

/** Test-only physical-effect seam. The reset handle is generation-safe: an old
 * fixture can never clear a newer fixture's override. */
export let hashFile: HashFile = hashFileReal;
export function overrideHashFileForTests(override: HashFile): () => void {
  const generation = ++hashFileGeneration;
  hashFile = override;
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    if (hashFileGeneration === generation) {
      hashFileGeneration++;
      hashFile = hashFileReal;
    }
  };
}

export function hashBytes(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
