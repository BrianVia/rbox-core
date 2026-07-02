import fs from "node:fs";
import fsp from "node:fs/promises";
import { Readable } from "node:stream";

// ---- streaming helpers ----------------------------------------------------

/** A web ReadableStream over a file (optionally a byte range, end inclusive). */
export function fileStream(absPath: string, start?: number, endInclusive?: number): ReadableStream {
  const opts = start !== undefined ? { start, end: endInclusive } : {};
  return Readable.toWeb(fs.createReadStream(absPath, opts)) as unknown as ReadableStream;
}

export async function readJson<T>(p: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fsp.readFile(p, "utf8")) as T;
  } catch {
    return undefined;
  }
}
