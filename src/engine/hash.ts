import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** Streaming SHA-256 of a file — never buffers the whole file in memory. */
export function hashFile(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(absPath)
      .on("data", (chunk) => h.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

export function hashBytes(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
