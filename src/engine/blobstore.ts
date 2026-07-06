import fs from "node:fs/promises";
import path from "node:path";
import { hashBytes } from "./hash.js";

/**
 * Content-addressed blob store on the local filesystem. In Phase 1 this stands
 * in for R2 — the engine talks to this interface, so swapping in a real remote
 * later is a driver change, not an engine change. Blobs are immutable and keyed
 * by SHA-256: `blobs/<ab>/<full-sha>`.
 */
export interface BlobStore {
  has(sha256: string): Promise<boolean>;
  put(sha256: string, bytes: Uint8Array): Promise<void>;
  get(sha256: string): Promise<Buffer>;
  /** Optional streaming download into a file — used by apply for large blobs so
   *  they never materialize in memory. Falls back to get()+write when absent. */
  getToFile?(sha256: string, destPath: string): Promise<void>;
  /** Optional streaming upload from a file (e.g. a git bundle) by content address.
   *  `uploadsDir` lets remote multipart implementations persist resumable tokens. */
  putFile?(sha256: string, srcPath: string, size: number, uploadsDir?: string): Promise<void>;
}

export class LocalBlobStore implements BlobStore {
  constructor(private readonly dir: string) {}

  private keyPath(sha256: string): string {
    return path.join(this.dir, "blobs", sha256.slice(0, 2), sha256);
  }

  async has(sha256: string): Promise<boolean> {
    try {
      await fs.access(this.keyPath(sha256));
      return true;
    } catch {
      return false;
    }
  }

  async put(sha256: string, bytes: Uint8Array): Promise<void> {
    const dest = this.keyPath(sha256);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    // Atomic publish: write a temp sibling, then rename over. A crash mid-write
    // never leaves a half-written blob at its content address.
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, dest);
  }

  async get(sha256: string): Promise<Buffer> {
    const bytes = await fs.readFile(this.keyPath(sha256));
    // Integrity is cheap and catches store corruption / bugs early.
    const actual = hashBytes(bytes);
    if (actual !== sha256) {
      throw new Error(`blob integrity mismatch: wanted ${sha256}, got ${actual}`);
    }
    return bytes;
  }

  async getToFile(sha256: string, destPath: string): Promise<void> {
    await fs.copyFile(this.keyPath(sha256), destPath);
  }

  async putFile(sha256: string, srcPath: string, _size = 0, _uploadsDir?: string): Promise<void> {
    const dest = this.keyPath(sha256);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(srcPath, dest);
  }
}
