import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pull, push, sync, type SyncDeps } from "./sync.js";
import type { WorkspaceConfig } from "./config.js";
import { loadState } from "./config.js";
import { BlobShaMismatchError, type CommitResult, type SyncRemote } from "./remote.js";
import { PhaseReport, type BlobStore, type FileEntry, type Manifest } from "../engine/index.js";
import { encryptFileNameProbe } from "../engine/e2ee/e2ee-e2e.helpers.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const shaBytes = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// Fixed test workspace KEK — E2EE is the only sync mode now (design 12 D6), so the
// FakeRemote operates at the blob layer in CIPHERTEXT (by encSha) exactly as the
// real server does; manifests are the post-decryption plaintext view the transport
// hands sync.ts. `enc()` mirrors the V4-5 convergent blob derivation.
const KEK = Buffer.alloc(32, 7);
const enc = (content: string | Buffer) => encryptFileNameProbe(new Uint8Array(KEK), new Uint8Array(Buffer.from(content)));

/**
 * Stateful in-memory server simulator (design 09 §1) — monotonic head, 409 parent
 * conflict, 422 blob-existence. Blobs are content-addressed by `encSha` (ciphertext)
 * since the client always encrypts; manifests are plaintext (the transport decrypts
 * before sync.ts sees them).
 */
class FakeRemote implements SyncRemote {
  private head = 0;
  private readonly log = new Map<number, Manifest>(); // seq → manifest
  private readonly blobs = new Map<string, Buffer>(); // encSha → ciphertext
  commitCalls = 0;
  forceUnsatisfiedOnce = false;
  beforeCommit?: () => Promise<void>;
  // Live-folder TOCTOU simulation: reject a given encSha's PUT with a 400 sha_mismatch
  // (as R2 does when the streamed ciphertext no longer hashes to the declared encSha).
  // `…Once` clears itself after firing (heals on retry); `…Always` never clears (a file
  // that keeps changing — exercises the bounded-retry give-up).
  forceShaMismatchOnce?: string;
  forceShaMismatchAlways?: string;

  /** Encrypt + seed a blob (as the uploading client would); return its FileEntry. */
  async seedEntry(rel: string, content: string): Promise<FileEntry> {
    const p = await enc(content);
    this.blobs.set(p.encSha, Buffer.from(p.ciphertext));
    return { path: rel, type: "file", sha256: p.plaintextSha, encSha: p.encSha, size: content.length, mode: 0o644, mtimeMs: 1 };
  }
  injectCommit(files: FileEntry[]): void {
    this.head += 1;
    this.log.set(this.head, { generatedAt: "", files });
  }
  headSeq(): number {
    return this.head;
  }
  hasBlob(encSha: string): boolean {
    return this.blobs.has(encSha);
  }

  async latest(): Promise<{ sequence: number; manifest: Manifest }> {
    return { sequence: this.head, manifest: this.log.get(this.head) ?? { generatedAt: "", files: [] } };
  }
  async missingBlobs(shas: string[]): Promise<string[]> {
    return shas.filter((s) => !this.blobs.has(s));
  }
  async putBlobFile(sha256: string, absPath: string): Promise<void> {
    if (this.forceShaMismatchAlways === sha256) throw new BlobShaMismatchError(sha256);
    if (this.forceShaMismatchOnce === sha256) {
      this.forceShaMismatchOnce = undefined; // heal on the re-scan retry
      throw new BlobShaMismatchError(sha256);
    }
    const bytes = await fs.readFile(absPath); // ciphertext; encSha = sha256(ciphertext)
    if (shaBytes(bytes) !== sha256) throw new Error(`putBlobFile: content/sha mismatch for ${sha256}`);
    this.blobs.set(sha256, bytes);
  }
  async commit(parentSequence: number, _deviceId: string, manifest: Manifest): Promise<CommitResult> {
    this.commitCalls += 1;
    if (this.beforeCommit) await this.beforeCommit();
    if (parentSequence !== this.head) return { conflict: true, head: this.head };
    // Blob-existence is checked against the STORED address: encSha (ciphertext).
    const addr = (f: FileEntry) => f.encSha ?? f.sha256;
    const missing = manifest.files.filter((f) => f.type === "file").map(addr).filter((s) => !this.blobs.has(s));
    if (missing.length > 0) return { unsatisfiedBlobs: [...new Set(missing)] };
    if (this.forceUnsatisfiedOnce) {
      this.forceUnsatisfiedOnce = false;
      return { unsatisfiedBlobs: manifest.files.filter((f) => f.type === "file").map(addr) };
    }
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

let root: string;
let cfg: WorkspaceConfig;
const noBackoff = async () => {};
const deps = (remote: SyncRemote): SyncDeps => ({ remote, backoff: noBackoff });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-sync-test-"));
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  // E2EE is the only mode (D6): a workspace always has an encryption key.
  cfg = { remoteWorkspaceId: "ws_t", projectId: "root", deviceId: "devA", rootPath: root, remoteUrl: "http://x", token: "", encrypted: true, kek: KEK };
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const write = (rel: string, content: string) => fs.writeFile(path.join(root, rel), content);
const read = (rel: string) => fs.readFile(path.join(root, rel), "utf8");

// ── echo-storm no-op (the guard that makes continuous sync viable) ──────────

test("no-op: pull-then-push with no local changes makes ZERO commits, sequence stable", async () => {
  const remote = new FakeRemote();
  const c = "hello\n";
  remote.injectCommit([await remote.seedEntry("a.txt", c)]);

  await pull(root, cfg, deps(remote)); // writes a.txt (decrypted), base → seq 1
  expect(await read("a.txt")).toBe(c);
  const before = remote.commitCalls;
  const seq = await push(root, cfg, deps(remote)); // nothing changed on disk
  expect(remote.commitCalls).toBe(before); // ZERO new commits — no echo
  expect(seq).toBe(1);
  expect(remote.headSeq()).toBe(1);
});

// ── clean push ─────────────────────────────────────────────────────────────

test("clean push uploads the ciphertext blob, commits, advances base", async () => {
  const remote = new FakeRemote();
  await write("new.txt", "fresh content\n");
  const seq = await push(root, cfg, deps(remote));
  expect(seq).toBe(1);
  expect(remote.hasBlob((await enc("fresh content\n")).encSha)).toBe(true); // stored as ciphertext
  expect(remote.hasBlob(sha("fresh content\n"))).toBe(false); // never the plaintext address
  expect((await loadState(root)).lastSyncedSequence).toBe(1);
});

test("binary (non-UTF8) content is encrypted + byte-verified by ciphertext address", async () => {
  const remote = new FakeRemote();
  const binary = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x7f, 0xc3, 0x28]);
  await fs.writeFile(path.join(root, "blob.bin"), binary);
  const seq = await push(root, cfg, deps(remote));
  expect(seq).toBe(1);
  expect(remote.hasBlob((await enc(binary)).encSha)).toBe(true); // ciphertext addressed correctly
});

// ── 409 conflict-retry: the rescan is load-bearing ─────────────────────────

test("409 conflict: client pulls + RE-SCANS + retries, and does NOT lose the remote change", async () => {
  const remote = new FakeRemote();
  await write("mine.txt", "mine\n");
  const theirs = "theirs\n";
  let injected = false;
  remote.beforeCommit = async () => {
    if (!injected) {
      injected = true;
      remote.injectCommit([await remote.seedEntry("theirs.txt", theirs)]);
    }
  };
  const seq = await push(root, cfg, deps(remote));
  expect(await read("theirs.txt")).toBe(theirs); // remote change not clobbered
  expect(await read("mine.txt")).toBe("mine\n"); // our change preserved
  expect(seq).toBe(remote.headSeq());
  expect(remote.commitCalls).toBeGreaterThanOrEqual(2);
});

// ── 409 give-up leaves state untouched ─────────────────────────────────────

test("409 forever: exhausts retries, throws, never commits our change, never loses it", async () => {
  const remote = new FakeRemote();
  await write("mine.txt", "mine\n");
  let n = 0;
  remote.beforeCommit = async () => {
    n++;
    remote.injectCommit([await remote.seedEntry(`o${n}.txt`, `other${n}\n`)]);
  };
  await expect(push(root, cfg, deps(remote))).rejects.toThrow(/too many conflicts/);
  const latest = await remote.latest();
  expect(latest.manifest.files.some((f) => f.path === "mine.txt")).toBe(false); // never committed
  expect(await read("mine.txt")).toBe("mine\n"); // never lost
});

test("onCommitConflict fires once per 409 (the metric the daemon tallies)", async () => {
  const remote = new FakeRemote();
  await write("mine.txt", "mine\n");
  let injected = 0;
  remote.beforeCommit = async () => {
    if (injected < 2) {
      injected++;
      remote.injectCommit([await remote.seedEntry(`o${injected}.txt`, `o${injected}\n`)]);
    }
  };
  let conflicts = 0;
  await push(root, cfg, { remote, backoff: noBackoff, onCommitConflict: () => conflicts++ });
  expect(conflicts).toBe(2);
});

// ── 422 unsatisfied-blobs → reupload + retry ───────────────────────────────

test("422 unsatisfied blobs: client re-uploads and retries to success", async () => {
  const remote = new FakeRemote();
  await write("x.txt", "payload\n");
  remote.forceUnsatisfiedOnce = true;
  const seq = await push(root, cfg, deps(remote));
  expect(seq).toBe(1);
  expect(remote.commitCalls).toBe(2); // 422 then success
});

// ── live-folder TOCTOU: 400 sha_mismatch → re-scan + retry (self-heal) ──────

test("sha_mismatch once: a file that changes under the push RE-SCANS + retries + commits (does NOT abort)", async () => {
  const remote = new FakeRemote();
  const content = "live edit in progress\n";
  await write("f.txt", content);
  // The server rejects the first PUT of this ciphertext (as if the source moved between
  // encrypt-time and the streamed upload); the client must not abort the whole push.
  remote.forceShaMismatchOnce = (await enc(content)).encSha;

  const seq = await push(root, cfg, deps(remote));

  expect(seq).toBe(1); // committed — the push self-healed
  expect(remote.headSeq()).toBe(1);
  expect(remote.hasBlob((await enc(content)).encSha)).toBe(true); // ciphertext landed on retry
  expect((await remote.latest()).manifest.files.some((f) => f.path === "f.txt")).toBe(true);
});

test("sha_mismatch forever: a file that keeps changing → bounded retries, typed error, NO infinite loop", async () => {
  const remote = new FakeRemote();
  const content = "never settles\n";
  await write("f.txt", content);
  remote.forceShaMismatchAlways = (await enc(content)).encSha; // every attempt 400s

  // noBackoff (via deps) means this resolves immediately if the bound holds; a missing
  // bound would hang/stack-overflow instead of throwing.
  await expect(push(root, cfg, deps(remote))).rejects.toThrow(/kept changing/);
  expect((await remote.latest()).manifest.files.some((f) => f.path === "f.txt")).toBe(false); // never committed
});

// ── pull validation: invalid remote manifest never touches disk / base ──────

test("pull rejects an invalid remote manifest and does not advance base", async () => {
  const remote = new FakeRemote();
  // Path-traversal entry (invalid) at head — rejected by client-side validation
  // BEFORE any blob fetch/decrypt (the client is the sole validator under E2EE).
  remote.injectCommit([{ path: "../escape", type: "file", sha256: sha("x"), encSha: sha("x"), size: 1, mode: 0o644, mtimeMs: 1 }]);
  await expect(pull(root, cfg, deps(remote))).rejects.toThrow(/invalid remote manifest/);
  expect((await loadState(root)).lastSyncedSequence).toBe(0); // base unchanged
});

// ── forward-only ignore carry (M3b) ────────────────────────────────────────

test("a now-ignored, previously-synced file is carried forward (not seen as a deletion)", async () => {
  const remote = new FakeRemote();
  await write("keep.env", "K=V\n");
  await push(root, cfg, deps(remote));
  expect((await remote.latest()).manifest.files.some((f) => f.path === "keep.env")).toBe(true);
  await write(".rboxignore", "keep.env\n");
  await push(root, cfg, deps(remote));
  const latest = await remote.latest();
  expect(latest.manifest.files.some((f) => f.path === "keep.env")).toBe(true); // carried forward
});

// ── full sync cycle ────────────────────────────────────────────────────────

test("sync = pull then push in one call", async () => {
  const remote = new FakeRemote();
  remote.injectCommit([await remote.seedEntry("r.txt", "remote\n")]);
  await write("local.txt", "local\n");
  const { pulled, pushedSequence } = await sync(root, cfg, deps(remote));
  expect(pulled.some((a) => a.kind === "write")).toBe(true); // pulled r.txt
  expect(await read("r.txt")).toBe("remote\n");
  expect(pushedSequence).toBe(remote.headSeq()); // pushed local.txt on top
});

// ── §35 phase metrics: an enabled report is populated across the real phases ──

test("§35: an enabled report times push phases and attributes the byte bases", async () => {
  const remote = new FakeRemote();
  const content = "payload\n";
  await write("x.txt", content);

  const report = PhaseReport.push();
  await push(root, cfg, { remote, backoff: noBackoff, report });

  const j = report.toJSON();
  // Every coarse push phase was timed (scan from push(), the rest from pushManifest).
  expect(Object.keys(j.phases).sort()).toEqual(["commit", "encrypt", "scan", "upload"]);
  expect(j.files).toBe(1);
  expect(j.blobs).toBe(1);
  // Bases attributed to the right phase: plaintext on scan, ciphertext/changed on
  // encrypt, wire on upload — each strictly positive for a real one-file push.
  expect(j.phases.scan!.plaintextBytes).toBe(Buffer.byteLength(content));
  expect(j.phases.encrypt!.count).toBe(1);
  expect(j.phases.encrypt!.ciphertextBytes).toBeGreaterThan(0);
  expect(j.phases.encrypt!.changedBytes).toBe(j.phases.encrypt!.ciphertextBytes);
  expect(j.phases.upload!.wireBytes).toBeGreaterThan(0);
  // The summary line is emitted (a phase was recorded) and stays PII-free.
  const lines: string[] = [];
  report.logSummaryTo((l) => lines.push(l));
  expect(lines.length).toBe(1);
  expect(lines[0]).not.toContain("x.txt");
});

test("§35: an enabled report times pull phases (scan + apply) with plaintext bytes", async () => {
  const remote = new FakeRemote();
  const content = "remote\n";
  remote.injectCommit([await remote.seedEntry("r.txt", content)]);

  const report = PhaseReport.pull();
  await pull(root, cfg, { remote, backoff: noBackoff, report });

  const j = report.toJSON();
  expect(Object.keys(j.phases).sort()).toEqual(["apply", "scan"]);
  expect(j.blobs).toBe(1); // one write action applied
  expect(j.phases.apply!.plaintextBytes).toBe(Buffer.byteLength(content));
});

test("§35: with no report, the sync path is unaffected (disabled fallback records nothing)", async () => {
  const remote = new FakeRemote();
  await write("y.txt", "z\n");
  // No `report` in deps → sync uses PhaseReport.disabled internally; push still works.
  const seq = await push(root, cfg, deps(remote));
  expect(seq).toBe(1);
});
