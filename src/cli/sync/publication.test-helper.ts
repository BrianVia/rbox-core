import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import type { BlobStore, FileEntry, GitSection, Manifest } from "../../engine/index.js";
import { encryptFileNameProbe } from "../../engine/e2ee/e2ee-e2e.helpers.js";
import { BlobRetryLaterError, BlobShaMismatchError, type CommitOptions, type CommitResult, type LatestOptions, type SyncRemote } from "../remote.js";
import { currentPushSpans, recordLaneSettlement } from "../push-spans.js";
import type { SyncDeps } from "./deps.js";

export const shaBytes = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// Fixed test workspace KEK — E2EE is the only sync mode now (design 12 D6), so the
// FakeRemote operates at the blob layer in CIPHERTEXT (by encSha) exactly as the
// real server does; manifests are the post-decryption plaintext view the transport
// hands sync.ts. `enc()` mirrors the V4-5 convergent blob derivation.
export const KEK = Buffer.alloc(32, 7);
export const enc = (content: string | Buffer) => encryptFileNameProbe(new Uint8Array(KEK), new Uint8Array(Buffer.from(content)));

/**
 * Stateful in-memory server simulator (design 09 §1) — monotonic head, 409 parent
 * conflict, 422 blob-existence. Blobs are content-addressed by `encSha` (ciphertext)
 * since the client always encrypts; manifests are plaintext (the transport decrypts
 * before sync.ts sees them).
 */
export class FakeRemote implements SyncRemote {
  private head = 0;
  private readonly log = new Map<number, Manifest>(); // seq → manifest
  private readonly blobs = new Map<string, Buffer>(); // encSha → ciphertext
  commitCalls = 0;
  successfulCommits: Array<{ manifest: Manifest; options?: CommitOptions }> = [];
  forceUnsatisfiedOnce = false;
  forceUnsatisfiedTotals: number[] = [];
  forceUnsatisfiedPageSize = 1;
  missingBlobCalls: string[][] = [];
  beforeCommit?: () => Promise<void>;
  // Live-folder TOCTOU simulation: reject a given encSha's PUT with a 400 sha_mismatch
  // (as R2 does when the streamed ciphertext no longer hashes to the declared encSha).
  // `…Once` clears itself after firing (heals on retry); `…Always` never clears (a file
  // that keeps changing — exercises the bounded-retry give-up).
  forceShaMismatchOnce?: string;
  forceShaMismatchAlways?: string;
  forceRetryLater?: string;
  instrumentPushSpans = false;

  /** Encrypt + seed a blob (as the uploading client would); return its FileEntry. */
  async seedEntry(rel: string, content: string): Promise<FileEntry> {
    const p = await enc(content);
    this.blobs.set(p.encSha, Buffer.from(p.ciphertext));
    return { path: rel, type: "file", sha256: p.plaintextSha, encSha: p.encSha, size: content.length, mode: 0o644, mtimeMs: 1 };
  }
  injectCommit(files: FileEntry[], gitRepos?: Record<string, GitSection>): void {
    this.head += 1;
    const manifest: Manifest = { generatedAt: "", files };
    if (gitRepos) {
      manifest.manifestSchema = 2;
      manifest.gitRepos = gitRepos;
    }
    this.log.set(this.head, manifest);
  }
  headSeq(): number {
    return this.head;
  }
  hasBlob(encSha: string): boolean {
    return this.blobs.has(encSha);
  }
  deleteBlob(encSha: string): void {
    this.blobs.delete(encSha);
  }

  async latest(options?: LatestOptions): Promise<{ sequence: number; manifest: Manifest }> {
    options?.onLatestTimings?.({ downloadMs: 1, decryptMs: 2, parseMs: 3, encBytes: 4 });
    return { sequence: this.head, manifest: this.log.get(this.head) ?? { generatedAt: "", files: [] } };
  }
  async missingBlobs(shas: string[]): Promise<string[]> {
    if (shas.length === 0) return [];
    this.missingBlobCalls.push([...shas]);
    return shas.filter((s) => !this.blobs.has(s));
  }
  async putBlobFile(sha256: string, absPath: string): Promise<void> {
    if (this.forceRetryLater === sha256) throw new BlobRetryLaterError();
    if (this.forceShaMismatchAlways === sha256) throw new BlobShaMismatchError(sha256);
    if (this.forceShaMismatchOnce === sha256) {
      this.forceShaMismatchOnce = undefined; // heal on the re-scan retry
      throw new BlobShaMismatchError(sha256);
    }
    const bytes = await fs.readFile(absPath); // ciphertext; encSha = sha256(ciphertext)
    if (shaBytes(bytes) !== sha256) throw new Error(`putBlobFile: content/sha mismatch for ${sha256}`);
    this.blobs.set(sha256, bytes);
    if (this.instrumentPushSpans) recordLaneSettlement("single", bytes.byteLength, 1);
  }
  async commit(parentSequence: number, _deviceId: string, manifest: Manifest, options?: CommitOptions): Promise<CommitResult> {
    this.commitCalls += 1;
    if (this.instrumentPushSpans) currentPushSpans()?.recordTail("commit", 1, 17);
    if (this.beforeCommit) await this.beforeCommit();
    if (parentSequence !== this.head) return { conflict: true, head: this.head };
    // Blob-existence is checked against the STORED address: encSha (ciphertext).
    const addr = (f: FileEntry) => f.encSha ?? f.sha256;
    const missing = manifest.files.filter((f) => f.type === "file").map(addr).filter((s) => !this.blobs.has(s));
    if (missing.length > 0) return { unsatisfiedBlobs: [...new Set(missing)] };
    if (this.forceUnsatisfiedTotals.length > 0) {
      const total = this.forceUnsatisfiedTotals.shift()!;
      const page = [...new Set(manifest.files.filter((f) => f.type === "file").map(addr))].slice(0, this.forceUnsatisfiedPageSize);
      return { unsatisfiedBlobs: page, unsatisfiedTotal: total };
    }
    if (this.forceUnsatisfiedOnce) {
      this.forceUnsatisfiedOnce = false;
      const unsatisfiedBlobs = manifest.files.filter((f) => f.type === "file").map(addr);
      for (const sha of unsatisfiedBlobs) this.blobs.delete(sha);
      return { unsatisfiedBlobs };
    }
    options?.onCommitTimings?.({
      refreshMs: 1,
      sidecarMs: 2,
      encodeMs: 3,
      encryptMs: 4,
      uploadMs: 5,
      postMs: 6,
      encBytes: 7,
      serverTimings: { totalMs: 13, envelopeMs: 1, accountingMs: 2, sidecarMs: 3, commitMs: 4, mirrorMs: 2, responseMs: 1 },
    });
    this.successfulCommits.push({ manifest, ...(options ? { options } : {}) });
    this.head += 1;
    this.log.set(this.head, manifest);
    return { sequence: this.head };
  }
  blobStore(): BlobStore {
    const blobs = this.blobs;
    return {
      async has(s) {
        return blobs.has(s);
      },
      async put(s, bytes) {
        blobs.set(s, Buffer.from(bytes));
      },
      async get(s) {
        const b = blobs.get(s);
        if (!b) throw new Error(`blob missing: ${s}`);
        return b;
      },
      async getToFile(s, dest) {
        const b = blobs.get(s);
        if (!b) throw new Error(`blob missing: ${s}`);
        await fs.writeFile(dest, b);
      },
      async putFile(s, src) {
        blobs.set(s, await fs.readFile(src));
      },
    };
  }
}

export const noBackoff = async () => {};
export const deps = (remote: SyncRemote): SyncDeps => ({ remote, backoff: noBackoff });
