import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { accumulateRecoveryPage, pull, push, pushManifest, stampManifestSchemaForCommit, sync, type SyncDeps } from "./sync.js";
import { missingBlobsChunked } from "./sync-recovery.js";
import type { WorkspaceConfig } from "./config.js";
import { loadState, saveState, syncStreamId } from "./config.js";
import { BlobRetryLaterError, BlobShaMismatchError, type CommitOptions, type CommitResult, type LatestOptions, type SyncRemote } from "./remote.js";
import {
  buildIgnoreMatcher,
  ENCRYPT_ADDRESS_CACHE_REL,
  encryptFileToTemp,
  PhaseReport,
  scanManifest,
  type BlobStore,
  type EncryptedBlob,
  type EncryptFileOptions,
  type FileEntry,
  type GitSection,
  type Manifest,
} from "../engine/index.js";
import { encryptFileNameProbe } from "../engine/e2ee/e2ee-e2e.helpers.js";
import { listTrash } from "../engine/trash.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const shaBytes = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const exec = promisify(execFile);
const fakeGitSection = (): GitSection => ({
  bundleSha: sha("bundle"),
  bundleEncSha: sha("bundle-enc"),
  bundleCipherSize: 1,
  head: "ref: refs/heads/main",
  refs: { "refs/heads/main": "1".repeat(40) },
  refScope: "all",
  generatedAt: "",
});

// Fixed test workspace KEK — E2EE is the only sync mode now (design 12 D6), so the
// FakeRemote operates at the blob layer in CIPHERTEXT (by encSha) exactly as the
// real server does; manifests are the post-decryption plaintext view the transport
// hands sync.ts. `enc()` mirrors the V4-5 convergent blob derivation.
const KEK = Buffer.alloc(32, 7);
const enc = (content: string | Buffer) => encryptFileNameProbe(new Uint8Array(KEK), new Uint8Array(Buffer.from(content)));

test("stampManifestSchemaForCommit stamps schema 4 only when file or git compression descriptors are present", () => {
  const raw: Manifest = { generatedAt: "", files: [] };
  expect(stampManifestSchemaForCommit(raw).manifestSchema).toBeUndefined();
  expect(stampManifestSchemaForCommit({ ...raw, gitRepos: { repo: fakeGitSection() } }).manifestSchema).toBe(2);

  const compressedFile: FileEntry = {
    path: "a.txt",
    type: "file",
    sha256: sha("plain"),
    encSha: sha("enc"),
    size: 5,
    mode: 0o644,
    mtimeMs: 0,
    comp: "zstd",
    payloadSha: sha("payload"),
    cipherSize: 10,
  };
  expect(stampManifestSchemaForCommit({ generatedAt: "", files: [compressedFile] }).manifestSchema).toBe(4);
  expect(
    stampManifestSchemaForCommit({
      generatedAt: "",
      files: [],
      gitRepos: {
        repo: {
          ...fakeGitSection(),
          bundleComp: "zstd",
          bundlePayloadSha: sha("git-payload"),
        },
      },
    }).manifestSchema
  ).toBe(4);
});

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
  }
  async commit(parentSequence: number, _deviceId: string, manifest: Manifest, options?: CommitOptions): Promise<CommitResult> {
    this.commitCalls += 1;
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
let savedPreflightDelta: string | undefined;
let savedPreflightFull: string | undefined;
const noBackoff = async () => {};
const deps = (remote: SyncRemote): SyncDeps => ({ remote, backoff: noBackoff });

beforeEach(async () => {
  savedPreflightDelta = process.env.RBOX_PREFLIGHT_DELTA;
  savedPreflightFull = process.env.RBOX_PREFLIGHT_FULL;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-sync-test-"));
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  // E2EE is the only mode (D6): a workspace always has an encryption key.
  cfg = {
    remoteWorkspaceId: "ws_t",
    projectId: "root",
    deviceId: "devA",
    rootPath: root,
    remoteUrl: "http://x",
    token: "",
    encrypted: true,
    kek: KEK,
    accountId: "acct_t",
    accountEpoch: 0,
    keyEpoch: 0,
  };
});
afterEach(async () => {
  if (savedPreflightDelta === undefined) delete process.env.RBOX_PREFLIGHT_DELTA;
  else process.env.RBOX_PREFLIGHT_DELTA = savedPreflightDelta;
  if (savedPreflightFull === undefined) delete process.env.RBOX_PREFLIGHT_FULL;
  else process.env.RBOX_PREFLIGHT_FULL = savedPreflightFull;
  await fs.rm(root, { recursive: true, force: true });
});

const write = (rel: string, content: string) => fs.writeFile(path.join(root, rel), content);
const read = (rel: string) => fs.readFile(path.join(root, rel), "utf8");

async function writeEncryptCache(entries: Record<string, { encSha: string; cipherSize: number; paths: string[] }>): Promise<void> {
  const file = path.join(root, ENCRYPT_ADDRESS_CACHE_REL);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 1,
      accountId: cfg.accountId,
      workspaceId: cfg.remoteWorkspaceId,
      accountEpoch: cfg.accountEpoch,
      keyEpoch: cfg.keyEpoch,
      entries,
    })
  );
}

async function readEncryptCache(): Promise<{ entries: Record<string, { encSha: string; cipherSize: number; paths: string[] }> }> {
  return JSON.parse(await fs.readFile(path.join(root, ENCRYPT_ADDRESS_CACHE_REL), "utf8"));
}

function countingEncrypt() {
  let calls = 0;
  const fn: NonNullable<SyncDeps["encryptFileToTemp"]> = async (srcPath: string, kek: Buffer, tmpDir?: string, opts?: EncryptFileOptions): Promise<EncryptedBlob> => {
    calls++;
    return encryptFileToTemp(srcPath, kek, tmpDir, opts);
  };
  return { fn, calls: () => calls };
}

// ── echo-storm no-op (the guard that makes continuous sync viable) ──────────

test("no-op: pull-then-push with no local changes makes ZERO commits, sequence stable", async () => {
  const remote = new FakeRemote();
  const c = "hello\n";
  remote.injectCommit([await remote.seedEntry("a.txt", c)]);

  await pull(root, cfg, deps(remote)); // writes a.txt (decrypted), base → seq 1
  expect(await read("a.txt")).toBe(c);
  const before = remote.commitCalls;
  const { sequence: seq } = await push(root, cfg, deps(remote)); // nothing changed on disk
  expect(remote.commitCalls).toBe(before); // ZERO new commits — no echo
  expect(seq).toBe(1);
  expect(remote.headSeq()).toBe(1);
});

test("same-SHA size mismatch commits a metadata heal without re-encrypting or conflicting", async () => {
  const remote = new FakeRemote();
  const content = "coherent bytes\n";
  await write("heal.txt", content);
  const coherent = await remote.seedEntry("heal.txt", content);
  const poisoned = { ...coherent, size: coherent.size - 1 };
  remote.injectCommit([poisoned]);

  const actions = await pull(root, cfg, deps(remote));
  expect(actions).toEqual([]); // same plaintext identity: no write or conflict

  const counter = countingEncrypt();
  const res = await push(root, cfg, { ...deps(remote), encryptFileToTemp: counter.fn });
  expect(res.committed).toBe(true);
  expect(counter.calls()).toBe(0);
  const healed = (await remote.latest()).manifest.files.find((f) => f.path === "heal.txt")!;
  expect(healed.size).toBe(Buffer.byteLength(content));
  expect(healed.sha256).toBe(coherent.sha256);
  expect(healed.encSha).toBe(coherent.encSha);
});

test("pull never applies a remote entry that LOCAL rules ignore (legacy .git pointer files)", async () => {
  const remote = new FakeRemote();
  // An OLD client synced a worktree `.git` pointer file before `.git` (file form)
  // became a builtin ignore. It's still in the remote manifest.
  remote.injectCommit([
    await remote.seedEntry("ok.txt", "fine\n"),
    await remote.seedEntry("wt/.git", "gitdir: /Users/old-machine/repo/.git/worktrees/wt\n"),
  ]);
  // This machine has a REAL, machine-local pointer at that path — it must survive.
  await fs.mkdir(path.join(root, "wt"), { recursive: true });
  await write("wt/.git", "gitdir: /Users/me/repo/.git/worktrees/wt\n");

  await pull(root, cfg, deps(remote));
  expect(await read("ok.txt")).toBe("fine\n"); // non-ignored entries still apply
  expect(await read("wt/.git")).toBe("gitdir: /Users/me/repo/.git/worktrees/wt\n"); // untouched

  // The ignored remote entry stays in the recorded BASE (forward-only), so the next
  // push neither echo-deletes it from the remote nor commits anything at all.
  const st = await loadState(root, syncStreamId(cfg));
  expect(st.lastSyncedManifest.files.some((f) => f.path === "wt/.git")).toBe(true);
  const before = remote.commitCalls;
  await push(root, cfg, deps(remote));
  expect(remote.commitCalls).toBe(before); // zero commits — no echo
  expect(remote.headSeq()).toBe(1);
});

test("a pull that RELAXES ignore rules applies the newly-unignored files (two-phase matcher)", async () => {
  // Filtering every action through the PRE-pull matcher would drop foo.txt here —
  // it would never land locally and the next push would delete it from the remote
  // (codex round-3 repro). Rule-file actions must apply first, then a FRESH matcher
  // filters the rest.
  const remote = new FakeRemote();
  remote.injectCommit([await remote.seedEntry(".rboxignore", "foo.txt\n")]);
  await pull(root, cfg, deps(remote)); // base: rules ignore foo.txt

  // seq 2: the rules are relaxed (ignore file removed) AND foo.txt is added.
  remote.injectCommit([await remote.seedEntry("foo.txt", "now visible\n")]);
  await pull(root, cfg, deps(remote));
  expect(await read("foo.txt")).toBe("now visible\n"); // landed despite the old rules

  const before = remote.commitCalls;
  await push(root, cfg, deps(remote));
  expect(remote.commitCalls).toBe(before); // and no echo commit afterwards
  expect(remote.headSeq()).toBe(2);
});

// ── clean push ─────────────────────────────────────────────────────────────

test("clean push uploads the ciphertext blob, commits, advances base", async () => {
  const remote = new FakeRemote();
  await write("new.txt", "fresh content\n");
  const { sequence: seq } = await push(root, cfg, deps(remote));
  expect(seq).toBe(1);
  expect(remote.hasBlob((await enc("fresh content\n")).encSha)).toBe(true); // stored as ciphertext
  expect(remote.hasBlob(sha("fresh content\n"))).toBe(false); // never the plaintext address
  expect((await loadState(root, syncStreamId(cfg))).lastSyncedSequence).toBe(1);
});

test("binary (non-UTF8) content is encrypted + byte-verified by ciphertext address", async () => {
  const remote = new FakeRemote();
  const binary = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x7f, 0xc3, 0x28]);
  await fs.writeFile(path.join(root, "blob.bin"), binary);
  const { sequence: seq } = await push(root, cfg, deps(remote));
  expect(seq).toBe(1);
  expect(remote.hasBlob((await enc(binary)).encSha)).toBe(true); // ciphertext addressed correctly
});

test("encrypt cache hit skips encrypt when the cached blob already exists", async () => {
  const remote = new FakeRemote();
  const content = "cached content\n";
  await write("cached.txt", content);
  const cached = await enc(content);
  await remote.blobStore().put(cached.encSha, cached.ciphertext);
  await writeEncryptCache({
    [cached.plaintextSha]: { encSha: cached.encSha, cipherSize: cached.ciphertext.length, paths: ["cached.txt"] },
  });

  const counter = countingEncrypt();
  const progress: Array<{ phase: string; bytesTotal?: number }> = [];
  const res = await push(root, cfg, {
    ...deps(remote),
    encryptFileToTemp: counter.fn,
    onProgress: (_done, _total, phase, _label, bytes) => progress.push({ phase, bytesTotal: bytes?.bytesTotal }),
  });

  expect(res.sequence).toBe(1);
  expect(counter.calls()).toBe(0);
  expect((await remote.latest()).manifest.files[0]!.encSha).toBe(cached.encSha);
  expect(progress.filter((p) => p.phase === "upload" && (p.bytesTotal ?? 0) > 0)).toEqual([]);
});

test("wrong cached encSha to a missing blob re-encrypts through the upload-time !ct path and heals the cache", async () => {
  const remote = new FakeRemote();
  const content = "actual content\n";
  await write("wrong.txt", content);
  const actual = await enc(content);
  const wrongEncSha = sha("wrong cached ciphertext address");
  await writeEncryptCache({
    [actual.plaintextSha]: { encSha: wrongEncSha, cipherSize: 999, paths: ["wrong.txt"] },
  });

  const counter = countingEncrypt();
  const uploadProgress: number[] = [];
  const res = await push(root, cfg, {
    ...deps(remote),
    encryptFileToTemp: counter.fn,
    onProgress: (_done, _total, phase, _label, bytes) => {
      if (phase === "upload" && bytes) uploadProgress.push(bytes.bytesTotal);
    },
  });

  expect(res.sequence).toBe(1);
  expect(counter.calls()).toBe(1);
  expect(remote.hasBlob(actual.encSha)).toBe(true);
  const committed = (await remote.latest()).manifest.files[0]!;
  expect(committed.encSha).toBe(actual.encSha);
  expect(committed.encSha).not.toBe(wrongEncSha);
  expect(uploadProgress).toContain(actual.ciphertext.length);

  const raw = JSON.parse(await fs.readFile(path.join(root, ENCRYPT_ADDRESS_CACHE_REL), "utf8"));
  expect(raw.entries[actual.plaintextSha].encSha).toBe(actual.encSha);
  expect(raw.entries[actual.plaintextSha].cipherSize).toBe(actual.ciphertext.length);
});

test("failed first-publish commit retry reuses flushed encrypt cache entries", async () => {
  const remote = new FakeRemote();
  await write("a.txt", "A\n");
  await write("b.txt", "B\n");
  await write("c.txt", "C\n");
  remote.beforeCommit = async () => {
    throw new Error("commit response lost");
  };

  const first = countingEncrypt();
  await expect(push(root, cfg, { ...deps(remote), encryptFileToTemp: first.fn, encryptCacheFlushMs: 1 })).rejects.toThrow(/commit response lost/);
  expect(first.calls()).toBe(3);

  remote.beforeCommit = undefined;
  const second = countingEncrypt();
  const res = await push(root, cfg, { ...deps(remote), encryptFileToTemp: second.fn, encryptCacheFlushMs: 1 });

  expect(res.sequence).toBe(1);
  expect(second.calls()).toBe(0);
});

test("cache hit whose path vanished after scan is deferred without encrypting", async () => {
  const remote = new FakeRemote();
  const content = "about to vanish\n";
  await write("ghost.txt", content);
  const cached = await enc(content);
  await writeEncryptCache({
    [cached.plaintextSha]: { encSha: cached.encSha, cipherSize: cached.ciphertext.length, paths: ["ghost.txt"] },
  });
  const local = await scanManifest(root, undefined, undefined);
  await fs.rm(path.join(root, "ghost.txt"));

  const counter = countingEncrypt();
  const res = await pushManifest(root, cfg, local, { ...deps(remote), encryptFileToTemp: counter.fn });

  expect(counter.calls()).toBe(0);
  expect(res.committed).toBe(false);
  expect(res.deferred).toEqual(["ghost.txt"]);
  expect(remote.headSeq()).toBe(0);
  expect((await readEncryptCache()).entries[cached.plaintextSha]).toBeUndefined();
});

test("no-op push prunes departed encrypt-cache paths absent from the scan", async () => {
  const remote = new FakeRemote();
  const stale = await enc("departed\n");
  await writeEncryptCache({
    [stale.plaintextSha]: { encSha: stale.encSha, cipherSize: stale.ciphertext.length, paths: ["departed.txt"] },
  });

  const res = await push(root, cfg, deps(remote));

  expect(res).toEqual({ sequence: 0, committed: false });
  expect(remote.commitCalls).toBe(0);
  expect((await readEncryptCache()).entries[stale.plaintextSha]).toBeUndefined();
});

test("base-enc reuse migrates a changed path out of its old encrypt-cache entry", async () => {
  const remote = new FakeRemote();
  const old = await enc("old\n");
  const shared = await enc("shared\n");
  await write("a.txt", "old\n");
  await write("known.txt", "shared\n");
  await push(root, cfg, deps(remote));

  await write("a.txt", "shared\n");
  const counter = countingEncrypt();
  await push(root, cfg, { ...deps(remote), encryptFileToTemp: counter.fn });

  expect(counter.calls()).toBe(0);
  const raw = await readEncryptCache();
  expect(raw.entries[old.plaintextSha]).toBeUndefined();
  expect(raw.entries[shared.plaintextSha]?.paths).toContain("known.txt");
  const latest = await remote.latest();
  const a = latest.manifest.files.find((f) => f.path === "a.txt")!;
  expect(a.sha256).toBe(shared.plaintextSha);
  expect(a.encSha).toBe(shared.encSha);
});

test("cache mapping to an existing wrong blob is detected by pull integrity, not silently accepted", async () => {
  const remote = new FakeRemote();
  const actualContent = "actual bytes\n";
  const wrongContent = "different bytes\n";
  await write("poisoned.txt", actualContent);
  const actual = await enc(actualContent);
  const wrong = await enc(wrongContent);
  await remote.blobStore().put(wrong.encSha, wrong.ciphertext);
  await writeEncryptCache({
    [actual.plaintextSha]: { encSha: wrong.encSha, cipherSize: wrong.ciphertext.length, paths: ["poisoned.txt"] },
  });

  const counter = countingEncrypt();
  await push(root, cfg, { ...deps(remote), encryptFileToTemp: counter.fn });
  expect(counter.calls()).toBe(0);
  expect((await remote.latest()).manifest.files[0]!.encSha).toBe(wrong.encSha);

  const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-sync-pull-wrong-cache-"));
  try {
    await fs.mkdir(path.join(otherRoot, ".rbox", "state"), { recursive: true });
    await expect(pull(otherRoot, { ...cfg, rootPath: otherRoot, deviceId: "devB" }, deps(remote))).rejects.toThrow(/authenticate|integrity|decrypt/i);
  } finally {
    await fs.rm(otherRoot, { recursive: true, force: true });
  }
});

test("encryptAndUpload refuses to use the cache without an explicit keyEpoch", async () => {
  const remote = new FakeRemote();
  await write("x.txt", "payload\n");
  const badCfg: WorkspaceConfig = { ...cfg, keyEpoch: undefined };

  await expect(push(root, badCfg, deps(remote))).rejects.toThrow(/missing keyEpoch/);
  await expect(fs.stat(path.join(root, ENCRYPT_ADDRESS_CACHE_REL))).rejects.toThrow();
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
  const report = PhaseReport.push();
  const { sequence: seq } = await push(root, cfg, { ...deps(remote), report });
  expect(await read("theirs.txt")).toBe(theirs); // remote change not clobbered
  expect(await read("mine.txt")).toBe("mine\n"); // our change preserved
  expect(seq).toBe(remote.headSeq());
  expect(remote.commitCalls).toBeGreaterThanOrEqual(2);
  const scanDetails = report.toJSON().phases.scan!.details as Record<string, number>;
  expect(scanDetails.filesStatted).toBeGreaterThanOrEqual(4); // initial push scan + 409 pull scan + retry rescan
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
  const { sequence: seq } = await push(root, cfg, deps(remote));
  expect(seq).toBe(1);
  expect(remote.commitCalls).toBe(2); // 422 then success
});

test("delta preflight threads the unsatisfied address through a 422 retry", async () => {
  process.env.RBOX_PREFLIGHT_DELTA = "1";
  const remote = new FakeRemote();
  await write("x.txt", "payload\n");
  const address = (await enc("payload\n")).encSha;
  remote.forceUnsatisfiedOnce = true;

  const { sequence } = await push(root, cfg, deps(remote));

  expect(sequence).toBe(1);
  expect(remote.commitCalls).toBe(2);
  expect(remote.missingBlobCalls.filter((call) => call.includes(address))).toHaveLength(2);
});

test("delta preflight recovers a lost carried ref reported by full commit admission", async () => {
  process.env.RBOX_PREFLIGHT_DELTA = "1";
  const remote = new FakeRemote();
  await write("carried.txt", "base\n");
  await push(root, cfg, deps(remote));
  const carriedAddress = (await enc("base\n")).encSha;
  remote.deleteBlob(carriedAddress);
  remote.missingBlobCalls.length = 0;
  await write("changed.txt", "new\n");

  const { sequence } = await push(root, cfg, deps(remote));

  expect(sequence).toBe(2);
  expect(remote.missingBlobCalls[0]).not.toContain(carriedAddress);
  expect(remote.missingBlobCalls.slice(1).some((call) => call.includes(carriedAddress))).toBe(true);
  expect(remote.hasBlob(carriedAddress)).toBe(true);
});

test("delta preflight sends only the unique introduced address", async () => {
  process.env.RBOX_PREFLIGHT_DELTA = "1";
  const remote = new FakeRemote();
  await write("carried.txt", "base\n");
  await push(root, cfg, deps(remote));
  remote.missingBlobCalls.length = 0;
  await write("changed.txt", "new\n");

  await push(root, cfg, deps(remote));

  expect(remote.missingBlobCalls).toEqual([[(await enc("new\n")).encSha]]);
});

test("delta git-identity-only commit sends no blob-preflight request", async () => {
  process.env.RBOX_PREFLIGHT_DELTA = "1";
  const remote = new FakeRemote();
  cfg = { ...cfg, syncGit: true };
  await exec("git", ["init", "-q", "-b", "main"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await exec("git", ["config", "user.name", "Test"], { cwd: root });
  await write("tracked.txt", "unchanged\n");
  await exec("git", ["add", "tracked.txt"], { cwd: root });
  await exec("git", ["commit", "-qm", "base"], { cwd: root });
  await push(root, cfg, deps(remote));
  remote.missingBlobCalls.length = 0;
  await exec("git", ["commit", "--allow-empty", "-qm", "identity only"], { cwd: root });

  const result = await push(root, cfg, deps(remote));

  expect(result.committed).toBe(true);
  expect(result.sequence).toBe(2);
  expect(remote.missingBlobCalls).toEqual([]);
});

test("flag-off preflight preserves manifest order and duplicate addresses", async () => {
  delete process.env.RBOX_PREFLIGHT_DELTA;
  delete process.env.RBOX_PREFLIGHT_FULL;
  const remote = new FakeRemote();
  await write("a.txt", "same\n");
  await write("b.txt", "same\n");
  await write("c.txt", "different\n");
  const local = await scanManifest(root);

  await pushManifest(root, cfg, local, deps(remote));

  expect(remote.missingBlobCalls[0]).toEqual(local.files.filter((f) => f.type === "file").map((f) => f.encSha!));
  expect(remote.missingBlobCalls[0]).toEqual([(await enc("same\n")).encSha, (await enc("same\n")).encSha, (await enc("different\n")).encSha]);
});

test("full preflight without delta checks the full deduped address set", async () => {
  delete process.env.RBOX_PREFLIGHT_DELTA;
  process.env.RBOX_PREFLIGHT_FULL = "1";
  const remote = new FakeRemote();
  await write("a.txt", "same\n");
  await write("b.txt", "same\n");
  await write("c.txt", "different\n");

  const { committed } = await push(root, cfg, deps(remote));

  expect(committed).toBe(true);
  expect(remote.missingBlobCalls).toEqual([[(await enc("same\n")).encSha, (await enc("different\n")).encSha]]);
});

test("full preflight wins when both full and delta flags are enabled", async () => {
  process.env.RBOX_PREFLIGHT_DELTA = "1";
  process.env.RBOX_PREFLIGHT_FULL = "1";
  const remote = new FakeRemote();
  await write("carried.txt", "base\n");
  await push(root, cfg, deps(remote));
  remote.missingBlobCalls.length = 0;
  await write("changed.txt", "new\n");

  await push(root, cfg, deps(remote));

  expect(remote.missingBlobCalls).toEqual([[(await enc("base\n")).encSha, (await enc("new\n")).encSha]]);
});

test("delta recovery clears accumulated 422 pages after a conflict pull", async () => {
  process.env.RBOX_PREFLIGHT_DELTA = "1";
  const remote = new FakeRemote();
  await write("x.txt", "payload\n");
  const synthetic = [sha("discarded-conflict-a"), sha("discarded-conflict-b")];
  const originalCommit = remote.commit.bind(remote);
  let commit = 0;
  let callsBeforeConflict = -1;
  remote.commit = async (...args) => {
    commit++;
    if (commit === 1) return { unsatisfiedBlobs: synthetic, unsatisfiedTotal: synthetic.length };
    if (commit === 2) {
      remote.injectCommit([await remote.seedEntry("theirs.txt", "theirs\n")]);
      callsBeforeConflict = remote.missingBlobCalls.length;
      return originalCommit(...args);
    }
    return originalCommit(...args);
  };

  const { sequence, committed } = await push(root, cfg, deps(remote));

  expect(committed).toBe(true);
  expect(sequence).toBe(2);
  expect(remote.missingBlobCalls[callsBeforeConflict]).not.toContain(synthetic[0]);
  expect(remote.missingBlobCalls[callsBeforeConflict]).not.toContain(synthetic[1]);
});

test("delta recovery clears accumulated 422 pages after an epoch refresh", async () => {
  process.env.RBOX_PREFLIGHT_DELTA = "1";
  const remote = new FakeRemote() as FakeRemote & {
    currentKek: () => Promise<{ kek: Uint8Array; accountId: string; accountEpoch: number; keyEpoch: number }>;
  };
  remote.currentKek = async () => ({ kek: KEK, accountId: cfg.accountId!, accountEpoch: cfg.accountEpoch!, keyEpoch: cfg.keyEpoch! });
  await write("x.txt", "payload\n");
  const synthetic = [sha("discarded-epoch-a"), sha("discarded-epoch-b")];
  const originalCommit = remote.commit.bind(remote);
  let commit = 0;
  let callsBeforeEpochRefresh = -1;
  remote.commit = async (...args) => {
    commit++;
    if (commit === 1) return { unsatisfiedBlobs: synthetic, unsatisfiedTotal: synthetic.length };
    if (commit === 2) {
      callsBeforeEpochRefresh = remote.missingBlobCalls.length;
      return { epochStale: cfg.accountEpoch! + 1 };
    }
    return originalCommit(...args);
  };

  const { sequence, committed } = await push(root, cfg, deps(remote));

  expect(committed).toBe(true);
  expect(sequence).toBe(1);
  expect(remote.missingBlobCalls[callsBeforeEpochRefresh]).not.toContain(synthetic[0]);
  expect(remote.missingBlobCalls[callsBeforeEpochRefresh]).not.toContain(synthetic[1]);
});

test("delta recovery retries with the distinct union of sequential 422 pages", async () => {
  process.env.RBOX_PREFLIGHT_DELTA = "1";
  const remote = new FakeRemote();
  await write("x.txt", "payload\n");
  const address = (await enc("payload\n")).encSha;
  const page1 = [sha("page-1-a"), sha("page-1-b")];
  const page2 = [sha("page-2-a"), sha("page-2-b")];
  const originalCommit = remote.commit.bind(remote);
  let page = 0;
  remote.commit = async (...args) => {
    if (page === 0) {
      page++;
      return { unsatisfiedBlobs: page1, unsatisfiedTotal: 4 };
    }
    if (page === 1) {
      page++;
      return { unsatisfiedBlobs: page2, unsatisfiedTotal: 2 };
    }
    return originalCommit(...args);
  };

  const { sequence, committed } = await push(root, cfg, deps(remote));

  expect(sequence).toBe(1);
  expect(committed).toBe(true);
  const expected = new Set([address, ...page1, ...page2]);
  expect(remote.missingBlobCalls.some((call) => call.length === expected.size && call.every((sha) => expected.has(sha)))).toBe(true);
});

test("delta recovery accumulator overflow switches the retry to a full audit", async () => {
  process.env.RBOX_PREFLIGHT_DELTA = "1";
  const remote = new FakeRemote();
  await write("carried.txt", "base\n");
  await push(root, cfg, deps(remote));
  const carriedAddress = (await enc("base\n")).encSha;
  remote.missingBlobCalls.length = 0;
  await write("changed.txt", "new\n");
  const originalCommit = remote.commit.bind(remote);
  const overflowPages = Array.from({ length: 11 }, (_, page) =>
    Array.from({ length: 10_000 }, (_, index) => `recovery-p${page}-i${index}`)
  );
  const postOverflowPage = ["post-overflow-a", "post-overflow-b"];
  const pages = [...overflowPages, postOverflowPage];
  let nextPage = 0;
  remote.commit = async (...args) => {
    if (nextPage < pages.length) {
      const unsatisfiedBlobs = pages[nextPage];
      const unsatisfiedTotal = 130_000 - nextPage * 10_000;
      nextPage++;
      return { unsatisfiedBlobs, unsatisfiedTotal };
    }
    return originalCommit(...args);
  };

  const { sequence, committed } = await push(root, cfg, deps(remote));

  expect(sequence).toBe(2);
  expect(committed).toBe(true);
  const postOverflowPreflight = remote.missingBlobCalls.at(-1)!;
  expect(postOverflowPreflight).toContain(carriedAddress);
  expect(pages.flat().some((synthetic) => postOverflowPreflight.includes(synthetic))).toBe(false);
});

test("accumulateRecoveryPage clears on overflow and stays empty while latched", () => {
  const accum = new Set<string>();

  expect(accumulateRecoveryPage(accum, false, ["a", "b"])).toBe(false);
  expect(accum).toEqual(new Set(["a", "b"]));

  const overflowPage = Array.from({ length: 100_001 }, (_, index) => `recovery-${index}`);
  expect(accumulateRecoveryPage(accum, false, overflowPage)).toBe(true);
  expect(accum.size).toBe(0);

  expect(accumulateRecoveryPage(accum, true, ["post-overflow"])).toBe(true);
  expect(accum.size).toBe(0);
});

test("missingBlobsChunked splits checks at 50,000 and unions missing results", async () => {
  const shas = Array.from({ length: 50_001 }, (_, i) => `chunk-${i}`);
  const calls: string[][] = [];
  const expected = [shas[0], shas[49_999], shas[50_000]];
  const api = {
    async missingBlobs(batch: string[]) {
      calls.push([...batch]);
      return batch.filter((address) => expected.includes(address));
    },
  } as Pick<SyncRemote, "missingBlobs"> as SyncRemote;

  const missing = await missingBlobsChunked(api, shas);

  expect(calls.map((call) => call.length)).toEqual([50_000, 1]);
  expect(new Set(missing)).toEqual(new Set(expected));
});

test("422 decreasing missingTotal pages can progress beyond the fixed retry budget", async () => {
  const remote = new FakeRemote();
  await write("x.txt", "payload\n");
  remote.forceUnsatisfiedTotals = [60_000, 50_000, 40_000, 30_000, 20_000, 10_000];

  const { sequence: seq } = await push(root, cfg, deps(remote));

  expect(seq).toBe(1);
  expect(remote.commitCalls).toBe(7); // six capped 422 pages, then success
});

test("422 non-decreasing missingTotal still exhausts the existing retry budget", async () => {
  const remote = new FakeRemote();
  await write("x.txt", "payload\n");
  remote.forceUnsatisfiedTotals = Array.from({ length: 10 }, () => 10_000);

  await expect(push(root, cfg, deps(remote))).rejects.toThrow(/server keeps reporting missing blobs/);
  expect(remote.headSeq()).toBe(0);
  expect(remote.commitCalls).toBe(6);
});

// ── live-folder TOCTOU: 400 sha_mismatch → re-scan + retry (self-heal) ──────

test("sha_mismatch once: a file that changes under the push RE-SCANS + retries + commits (does NOT abort)", async () => {
  const remote = new FakeRemote();
  const content = "live edit in progress\n";
  await write("f.txt", content);
  // The server rejects the first PUT of this ciphertext (as if the source moved between
  // encrypt-time and the streamed upload); the client must not abort the whole push.
  remote.forceShaMismatchOnce = (await enc(content)).encSha;

  const { sequence: seq } = await push(root, cfg, deps(remote));

  expect(seq).toBe(1); // committed — the push self-healed
  expect(remote.headSeq()).toBe(1);
  expect(remote.hasBlob((await enc(content)).encSha)).toBe(true); // ciphertext landed on retry
  expect((await remote.latest()).manifest.files.some((f) => f.path === "f.txt")).toBe(true);
});

// ── live-folder partial progress: a churning file is DEFERRED, the rest commits ──

test("a file that NEVER settles is deferred; the push SUCCEEDS committing the OTHER (stable) files", async () => {
  const remote = new FakeRemote();
  await write("stable.txt", "stable content\n");
  await write("churner.txt", "never settles\n");
  // The churner's ciphertext is rejected on every attempt (it keeps changing under us);
  // its bounded per-file retries exhaust → it's deferred, NOT a whole-push abort.
  remote.forceShaMismatchAlways = (await enc("never settles\n")).encSha;

  const local = await scanManifest(root, undefined, undefined);
  const res = await pushManifest(root, cfg, local, deps(remote));

  expect(res.sequence).toBe(1); // committed — the push made progress (did not abort)
  expect(remote.headSeq()).toBe(1);
  expect(res.deferred).toEqual(["churner.txt"]); // the churner is reported as deferred (count/paths)

  const committed = (await remote.latest()).manifest;
  expect(committed.files.some((f) => f.path === "churner.txt")).toBe(false); // never-synced deferred → OMITTED
  expect(committed.files.some((f) => f.path === "stable.txt")).toBe(true); // the stable file committed
  expect(remote.hasBlob((await enc("stable content\n")).encSha)).toBe(true);
  // Invariant: the committed manifest references no blob that isn't present on the server.
  for (const f of committed.files) if (f.type === "file") expect(remote.hasBlob(f.encSha!)).toBe(true);
});

test("retry_later defers one file without retrying its upload or blocking stable progress", async () => {
  const remote = new FakeRemote();
  await write("stable.txt", "stable content\n");
  await write("fenced.txt", "fenced content\n");
  remote.forceRetryLater = (await enc("fenced content\n")).encSha;

  const res = await pushManifest(root, cfg, await scanManifest(root), deps(remote));

  expect(res.sequence).toBe(1);
  expect(res.deferred).toEqual(["fenced.txt"]);
  expect(res.retryLater).toEqual(["fenced.txt"]);
  const committed = (await remote.latest()).manifest;
  expect(committed.files.some((f) => f.path === "fenced.txt")).toBe(false);
  expect(committed.files.some((f) => f.path === "stable.txt")).toBe(true);
});

test("a file that VANISHES between scan and encrypt is deferred; the push commits the rest", async () => {
  const remote = new FakeRemote();
  await write("stable.txt", "stable content\n");
  await write("ghost.txt", "about to vanish\n");

  const local = await scanManifest(root, undefined, undefined);
  await fs.rm(path.join(root, "ghost.txt")); // vanished after scan, before encrypt (agent/build churn)
  const res = await pushManifest(root, cfg, local, deps(remote));

  expect(res.sequence).toBe(1); // committed — one vanished file must not abort the push
  expect(res.deferred).toEqual(["ghost.txt"]);
  const committed = (await remote.latest()).manifest;
  expect(committed.files.some((f) => f.path === "ghost.txt")).toBe(false); // never-synced → omitted
  expect(committed.files.some((f) => f.path === "stable.txt")).toBe(true);
  for (const f of committed.files) if (f.type === "file") expect(remote.hasBlob(f.encSha!)).toBe(true);
});

test("scan-to-encrypt source change defers without metadata patch, then a settled cycle commits one coherent image", async () => {
  const remote = new FakeRemote();
  await write("append.log", "before\n");
  const scanned = await scanManifest(root);
  const scannedEntry = scanned.files.find((f) => f.path === "append.log")!;
  let injected = false;
  const encrypt: NonNullable<SyncDeps["encryptFileToTemp"]> = async (srcPath, kek, tmpDir, opts) => {
    if (!injected) {
      injected = true;
      await fs.appendFile(srcPath, "after\n");
    }
    return encryptFileToTemp(srcPath, kek, tmpDir, opts);
  };

  const first = await pushManifest(root, cfg, scanned, { ...deps(remote), encryptFileToTemp: encrypt });
  expect(first.committed).toBe(false);
  expect(first.deferred).toEqual(["append.log"]);
  expect(scannedEntry.size).toBe(Buffer.byteLength("before\n"));
  expect(scannedEntry.sha256).toBe(sha("before\n"));
  expect(remote.headSeq()).toBe(0);

  const second = await push(root, cfg, deps(remote));
  expect(second.committed).toBe(true);
  const entry = (await remote.latest()).manifest.files.find((f) => f.path === "append.log")!;
  const bytes = await fs.readFile(path.join(root, "append.log"));
  expect(entry.size).toBe(bytes.length);
  expect(entry.sha256).toBe(shaBytes(bytes));

  const other = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-source-change-pull-"));
  try {
    await pull(other, { ...cfg, rootPath: other, deviceId: "settled-reader" }, deps(remote));
    expect(Buffer.from(await fs.readFile(path.join(other, "append.log"))).equals(bytes)).toBe(true);
  } finally {
    await fs.rm(other, { recursive: true, force: true });
  }
});

test("a mismatch ONCE then settles is INCLUDED (bounded per-file retry heals it, not deferred)", async () => {
  const remote = new FakeRemote();
  const content = "flickers once\n";
  await write("f.txt", content);
  remote.forceShaMismatchOnce = (await enc(content)).encSha; // 400s once, then heals

  const local = await scanManifest(root, undefined, undefined);
  const res = await pushManifest(root, cfg, local, deps(remote));

  expect(res.sequence).toBe(1);
  expect(res.deferred).toEqual([]); // healed on retry → NOT deferred
  expect((await remote.latest()).manifest.files.some((f) => f.path === "f.txt")).toBe(true);
});

test("a previously-synced file that starts churning carries its BASE version (never a deletion)", async () => {
  const remote = new FakeRemote();
  await write("doc.txt", "v1\n");
  await push(root, cfg, deps(remote)); // doc.txt synced at v1
  expect((await remote.latest()).manifest.files.some((f) => f.path === "doc.txt")).toBe(true);

  // doc.txt now churns to v2 whose ciphertext never lands; a sibling changes cleanly.
  await write("doc.txt", "v2\n");
  await write("other.txt", "fresh\n");
  remote.forceShaMismatchAlways = (await enc("v2\n")).encSha;

  const local = await scanManifest(root, undefined, undefined);
  const res = await pushManifest(root, cfg, local, deps(remote));

  expect(res.deferred).toEqual(["doc.txt"]);
  const committed = (await remote.latest()).manifest;
  const doc = committed.files.find((f) => f.path === "doc.txt");
  expect(doc).toBeDefined(); // carried forward — NOT read as a deletion on other machines
  expect(doc!.sha256).toBe(sha("v1\n")); // its BASE (v1) entry, not the un-uploadable v2
  expect(remote.hasBlob(doc!.encSha!)).toBe(true); // the carried base blob is present
  expect(committed.files.some((f) => f.path === "other.txt")).toBe(true); // sibling committed
});

test("convergent duplicates (identical content) commit under ONE shared blob, both paths present", async () => {
  const remote = new FakeRemote();
  const content = "shared bytes\n";
  await write("a.txt", content);
  await write("b.txt", content); // identical → same encSha (convergent)

  const local = await scanManifest(root, undefined, undefined);
  const res = await pushManifest(root, cfg, local, deps(remote));

  expect(res.deferred).toEqual([]);
  const committed = (await remote.latest()).manifest;
  expect(committed.files.some((f) => f.path === "a.txt")).toBe(true);
  expect(committed.files.some((f) => f.path === "b.txt")).toBe(true);
  const encSha = (await enc(content)).encSha;
  expect(committed.files.filter((f) => f.type === "file").every((f) => f.encSha === encSha)).toBe(true);
  expect(remote.hasBlob(encSha)).toBe(true);
});

test("when EVERY change is deferred and git is unchanged, the push makes NO (empty) commit", async () => {
  const remote = new FakeRemote();
  await write("churner.txt", "never\n");
  remote.forceShaMismatchAlways = (await enc("never\n")).encSha;

  const before = remote.commitCalls;
  const local = await scanManifest(root, undefined, undefined);
  const res = await pushManifest(root, cfg, local, deps(remote));

  expect(remote.commitCalls).toBe(before); // no commit attempted — nothing stable to commit
  expect(res.sequence).toBe(0); // base sequence unchanged
  expect(res.deferred).toEqual(["churner.txt"]);
});

// ── pull validation: invalid remote manifest never touches disk / base ──────

test("pull rejects an invalid remote manifest and does not advance base", async () => {
  const remote = new FakeRemote();
  // Path-traversal entry (invalid) at head — rejected by client-side validation
  // BEFORE any blob fetch/decrypt (the client is the sole validator under E2EE).
  remote.injectCommit([{ path: "../escape", type: "file", sha256: sha("x"), encSha: sha("x"), size: 1, mode: 0o644, mtimeMs: 1 }]);
  await expect(pull(root, cfg, deps(remote))).rejects.toThrow(/invalid remote manifest/);
  expect((await loadState(root, syncStreamId(cfg))).lastSyncedSequence).toBe(0); // base unchanged
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

test("design 72: enabling respectGitignore deletes nothing and stops updating newly ignored untracked files", async () => {
  const remote = new FakeRemote();
  await fs.mkdir(path.join(root, "junk"), { recursive: true });
  await write("junk/cache.txt", "v1\n");
  await push(root, cfg, deps(remote));
  const before = (await remote.latest()).manifest.files.find((f) => f.path === "junk/cache.txt")!;
  expect(before).toBeDefined();

  cfg = { ...cfg, respectGitignore: true };
  await write(".gitignore", "junk/\n");
  await write("junk/cache.txt", "v2\n");
  await push(root, cfg, deps(remote));
  const latest = await remote.latest();
  const carried = latest.manifest.files.find((f) => f.path === "junk/cache.txt");
  expect(carried?.sha256).toBe(before.sha256); // stale carry, not an update and not a delete
  expect(latest.manifest.files.some((f) => f.path === ".gitignore")).toBe(true);
});

test("design 72: explicit purgeIgnored push removes now-ignored carried entries", async () => {
  const remote = new FakeRemote();
  await fs.mkdir(path.join(root, "junk"), { recursive: true });
  await write("junk/cache.txt", "v1\n");
  await push(root, cfg, deps(remote));
  expect((await remote.latest()).manifest.files.some((f) => f.path === "junk/cache.txt")).toBe(true);

  cfg = { ...cfg, respectGitignore: true };
  await write(".gitignore", "junk/\n");
  await push(root, cfg, deps(remote), true);
  expect((await remote.latest()).manifest.files.some((f) => f.path === "junk/cache.txt")).toBe(false);
});

test("design 72: purge push refuses if a known repo becomes unevaluable after the dry-run manifest", async () => {
  const remote = new FakeRemote();
  cfg = { ...cfg, respectGitignore: true };
  const repo = path.join(root, "hidden");
  await fs.mkdir(repo, { recursive: true });
  await exec("git", ["-C", repo, "init", "-qb", "main"]);
  await write(".gitignore", "hidden/\n");
  await fs.writeFile(path.join(repo, "tracked.txt"), "tracked");
  await exec("git", ["-C", repo, "add", "-f", "tracked.txt"]);

  const stale = await remote.seedEntry("hidden/drop.txt", "stale\n");
  await saveState(root, {
    stream: syncStreamId(cfg),
    lastSyncedSequence: 0,
    lastSyncedManifest: { generatedAt: "", files: [stale], manifestSchema: 2, gitRepos: { hidden: fakeGitSection() } },
  });

  const dryRunMatcher = buildIgnoreMatcher(root, {
    respectGitignore: true,
    forceTrackedEvaluation: true,
    protectTrackedPaths: true,
    knownGitRepos: ["hidden"],
  });
  const dryRunLocal = await scanManifest(root, dryRunMatcher);
  await fs.rm(path.join(repo, ".git", "index"), { force: true });

  const before = remote.commitCalls;
  await expect(pushManifest(root, cfg, dryRunLocal, deps(remote), 0, true)).rejects.toThrow(/refusing purge: cannot evaluate tracked files/);
  expect(remote.commitCalls).toBe(before);
  expect((await loadState(root, syncStreamId(cfg))).lastSyncedSequence).toBe(0);
});

test("design 72: purge with respectGitignore off still preserves tracked files under a .rboxignore repo dir", async () => {
  const remote = new FakeRemote();
  const repo = path.join(root, "repo");
  await fs.mkdir(repo, { recursive: true });
  await exec("git", ["-C", repo, "init", "-qb", "main"]);
  await fs.writeFile(path.join(repo, "keep.txt"), "tracked");
  await fs.writeFile(path.join(repo, "drop.txt"), "untracked");
  await exec("git", ["-C", repo, "add", "-f", "keep.txt"]);
  await push(root, cfg, deps(remote));

  const st = await loadState(root, syncStreamId(cfg));
  await saveState(root, {
    ...st,
    lastSyncedManifest: { ...st.lastSyncedManifest, manifestSchema: 2, gitRepos: { repo: fakeGitSection() } },
  });
  await write(".rboxignore", "repo/\n");

  await push(root, cfg, deps(remote), true);
  const paths = (await remote.latest()).manifest.files.map((f) => f.path).sort();
  expect(paths).toContain(".rboxignore");
  expect(paths).toContain("repo/keep.txt");
  expect(paths).not.toContain("repo/drop.txt");
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
  expect(Object.keys(j.phases).sort()).toEqual(["address", "commit", "encrypt", "git-plan", "missing", "scan", "state-load", "state-save", "upload"]);
  expect(j.files).toBe(1);
  expect(j.blobs).toBe(1);
  // Bases attributed to the right phase: plaintext on scan, ciphertext/changed on
  // encrypt, wire on upload — each strictly positive for a real one-file push.
  expect(j.phases.scan!.plaintextBytes).toBe(Buffer.byteLength(content));
  expect(Object.keys(j.phases.scan!.details ?? {}).sort()).toEqual([
    "dirsWalked",
    "filesHashed",
    "filesSkippedCacheHit",
    "filesStatted",
    "hashMs",
    "matcherMs",
    "midwriteDeferred",
    "readdirMs",
    "residualMs",
    "sortMs",
    "statMs",
  ]);
  expect(j.phases.encrypt!.count).toBe(1);
  expect(j.phases.encrypt!.ciphertextBytes).toBeGreaterThan(0);
  expect(j.phases.encrypt!.changedBytes).toBe(j.phases.encrypt!.ciphertextBytes);
  expect(j.phases.upload!.wireBytes).toBeGreaterThan(0);
  expect(Object.keys(j.phases.commit!.details ?? {}).sort()).toEqual(["encBytes", "encodeMs", "encryptMs", "postMs", "refreshMs", "serverTimings", "sidecarMs", "uploadMs"]);
  expect(j.phases.commit!.details?.serverTimings).toEqual({
    totalMs: 13,
    envelopeMs: 1,
    accountingMs: 2,
    sidecarMs: 3,
    commitMs: 4,
    mirrorMs: 2,
    responseMs: 1,
  });
  // The summary line is emitted (a phase was recorded) and stays PII-free.
  const lines: string[] = [];
  report.logSummaryTo((l) => lines.push(l));
  expect(lines.length).toBe(1);
  expect(lines[0]).not.toContain("x.txt");
  expect(lines[0]).toContain("scan");
  expect(lines[0]).toContain("commit");
  expect(lines[0]).toContain("r0.0 sc0.0 e0.0 c0.0 u0.0 p0.0 7B");
});

test("§35: an enabled report times pull phases (scan + apply) with plaintext bytes", async () => {
  const remote = new FakeRemote();
  const content = "remote\n";
  remote.injectCommit([await remote.seedEntry("r.txt", content)]);

  const report = PhaseReport.pull();
  await pull(root, cfg, { remote, backoff: noBackoff, report });

  const j = report.toJSON();
  expect(Object.keys(j.phases).sort()).toEqual(["apply", "cache-save", "git-apply", "latest", "scan", "state-load", "state-save"]);
  expect(j.blobs).toBe(1); // one write action applied
  expect(Object.keys(j.phases.latest!.details ?? {}).sort()).toEqual(["decryptMs", "downloadMs", "encBytes", "parseMs"]);
  expect(Object.keys(j.phases.scan!.details ?? {}).sort()).toEqual([
    "dirsWalked",
    "filesHashed",
    "filesSkippedCacheHit",
    "filesStatted",
    "hashMs",
    "matcherMs",
    "midwriteDeferred",
    "readdirMs",
    "residualMs",
    "sortMs",
    "statMs",
  ]);
  expect(j.phases.apply!.plaintextBytes).toBe(Buffer.byteLength(content));
  expect(j.phases["git-apply"]!.count).toBe(0);
  const lines: string[] = [];
  report.logSummaryTo((l) => lines.push(l));
  expect(lines[0]).toContain("latest");
  expect(lines[0]).toContain("d0.0 x0.0 p0.0 4B");
});

test("design 74 phase 0: pull reports git-apply repo timings and commonDir group count", async () => {
  const remote = new FakeRemote();
  const gitRepos = { repoA: fakeGitSection(), repoB: fakeGitSection() };
  remote.injectCommit([], gitRepos);
  cfg = { ...cfg, syncGit: true };
  await saveState(root, {
    stream: syncStreamId(cfg),
    lastSyncedSequence: remote.headSeq(),
    lastSyncedManifest: { generatedAt: "", files: [], manifestSchema: 2, gitRepos },
  });

  const report = PhaseReport.pull();
  await pull(root, cfg, { remote, backoff: noBackoff, report });

  const phase = report.toJSON().phases["git-apply"]!;
  expect(phase.count).toBe(2);
  const details = phase.details?.gitApply as {
    runKind: string;
    repos: number;
    commonDirGroups: number;
    results: Record<string, number>;
    repoTimings: Array<{ index: number; queueMs: number; wallMs: number; result: string }>;
  };
  expect(details.runKind).toBe("steady");
  expect(details.repos).toBe(2);
  expect(details.commonDirGroups).toBe(0);
  expect(details.results.unchanged).toBe(2);
  expect(details.repoTimings).toHaveLength(2);
  expect(details.repoTimings.map((t) => t.index).sort()).toEqual([0, 1]);
  for (const t of details.repoTimings) {
    expect(t.queueMs).toBeGreaterThanOrEqual(0);
    expect(t.wallMs).toBeGreaterThanOrEqual(0);
    expect(t.result).toBe("unchanged");
  }
  const lines: string[] = [];
  report.logSummaryTo((l) => lines.push(l));
  expect(lines[0]).toContain("git-apply");
  expect(lines[0]).toContain("repos=2 commonDirs=0");
  expect(lines[0]).toContain("results=unchanged=2");
  // Pooled apply (d78): repo timings emit in completion order, so assert both
  // repos appear rather than which one prints first.
  expect(lines[0]).toMatch(/repoMs=.*i0q/);
  expect(lines[0]).toMatch(/repoMs=.*i1q/);
});

test("§35: with no report, the sync path is unaffected (disabled fallback records nothing)", async () => {
  const remote = new FakeRemote();
  await write("y.txt", "z\n");
  // No `report` in deps → sync uses PhaseReport.disabled internally; push still works.
  const { sequence: seq } = await push(root, cfg, deps(remote));
  expect(seq).toBe(1);

  const disabled = PhaseReport.disabled("push");
  await write("z.txt", "again\n");
  await push(root, cfg, { ...deps(remote), report: disabled });
  expect(disabled.toJSON().phases).toEqual({});
  const lines: string[] = [];
  disabled.logSummaryTo((l) => lines.push(l));
  expect(lines).toEqual([]);
});

// ── design 44: rebind state-poisoning + the mass-delete guard ────────────────
// Incident (2026-07-01): `rbox setup` rebound a synced root to a brand-new EMPTY
// workspace while the old 8,600-file baseline survived in state.json — the next
// pull read every baseline file as "remotely deleted" and wiped the local tree.
// These tests pin the two independent layers that each prevent a recurrence.

test("REBIND regression: a root rebound to a new EMPTY workspace pulls without deleting, then publishes the full tree", async () => {
  const remoteOld = new FakeRemote();
  await write("a.txt", "aaa\n");
  await write("b.txt", "bbb\n");
  await push(root, cfg, deps(remoteOld)); // baseline now belongs to ws_t

  // Rebind: same root + stale state.json, different workspace, empty remote —
  // exactly what `setup → create new workspace` does over an already-synced dir.
  const cfgNew: WorkspaceConfig = { ...cfg, remoteWorkspaceId: "ws_new" };
  const remoteNew = new FakeRemote();
  const actions = await pull(root, cfgNew, deps(remoteNew));
  expect(actions.filter((a) => a.kind === "delete")).toHaveLength(0); // NEVER deletes
  expect(await read("a.txt")).toBe("aaa\n");
  expect(await read("b.txt")).toBe("bbb\n");

  // And the first push to the new workspace is a REAL publish of everything.
  const { sequence, committed } = await push(root, cfgNew, deps(remoteNew));
  expect(committed).toBe(true);
  expect(sequence).toBe(1);
  const published = (await remoteNew.latest()).manifest.files.map((f) => f.path).sort();
  expect(published).toEqual(["a.txt", "b.txt"]);
});

test("state ownership: another workspace's baseline reads as fresh; same workspace kept; legacy unstamped adopted", async () => {
  const remote = new FakeRemote();
  await write("a.txt", "aaa\n");
  await push(root, cfg, deps(remote)); // stamps workspaceId: ws_t at seq 1

  expect((await loadState(root, syncStreamId(cfg))).lastSyncedSequence).toBe(1); // kept
  const foreign = await loadState(root, syncStreamId({ ...cfg, remoteWorkspaceId: "ws_other" })); // mismatch → no baseline
  expect(foreign.lastSyncedSequence).toBe(0);
  expect(foreign.lastSyncedManifest.files).toHaveLength(0);

  // Legacy state file written before the stamp existed: adopted as-is.
  const statePath = path.join(root, ".rbox", "state.json");
  const legacy = JSON.parse(await fs.readFile(statePath, "utf8"));
  delete legacy.stream;
  await fs.writeFile(statePath, JSON.stringify(legacy));
  expect((await loadState(root, syncStreamId(cfg))).lastSyncedSequence).toBe(1);
  expect((await loadState(root, syncStreamId(cfg))).stream).toBe(syncStreamId(cfg));
});

test("mass-delete guard: a pull deleting ≥half the baseline fails closed until --allow-mass-delete", async () => {
  const remote = new FakeRemote();
  for (let i = 0; i < 120; i++) await write(`f${i}.txt`, `${i}\n`);
  await push(root, cfg, deps(remote)); // baseline: 120 files

  remote.injectCommit([]); // the remote head becomes EMPTY (poisoned/reset stream)
  await expect(pull(root, cfg, deps(remote))).rejects.toThrow(/mass-delete guard/);
  await expect(pull(root, cfg, { ...deps(remote), massDeleteHint: "rbox sync --allow-mass-delete" })).rejects.toThrow(/rbox sync --allow-mass-delete/);
  expect(await read("f0.txt")).toBe("0\n"); // fails closed BEFORE touching disk
  expect(await read("f119.txt")).toBe("119\n");

  // Explicit consent applies the deletion wave once.
  await pull(root, cfg, { ...deps(remote), allowMassDelete: true });
  await expect(fs.access(path.join(root, "f0.txt"))).rejects.toThrow();
});

test("mass-delete guard: normal-scale deletions (under half the baseline) apply without consent", async () => {
  const remote = new FakeRemote();
  for (let i = 0; i < 120; i++) await write(`f${i}.txt`, `${i}\n`);
  await push(root, cfg, deps(remote));

  // Remote deletes 30 of 120 (a big-but-legit cleanup): survives the guard.
  const head = (await remote.latest()).manifest;
  remote.injectCommit(head.files.filter((f) => Number(f.path.slice(1, -4)) < 90));
  const actions = await pull(root, cfg, deps(remote));
  expect(actions.filter((a) => a.kind === "delete")).toHaveLength(30);
  await expect(fs.access(path.join(root, "f90.txt"))).rejects.toThrow();
  expect((await listTrash(root)).some((e) => e.path === "f90.txt")).toBe(true);
  expect(await read("f89.txt")).toBe("89\n");
});

test("push reports committed=false on a no-op (the setup flow must never claim a publish that didn't happen)", async () => {
  const remote = new FakeRemote();
  await write("x.txt", "x\n");
  const first = await push(root, cfg, deps(remote));
  expect(first.committed).toBe(true);
  const second = await push(root, cfg, deps(remote)); // nothing changed
  expect(second.committed).toBe(false);
  expect(second.sequence).toBe(first.sequence);
});
