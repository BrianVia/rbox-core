import { beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  EncryptAddressCache,
  EncryptAddressCacheWriter,
  PhaseReport,
  encryptFileToTemp,
  generateKek,
  type FileEntry,
  type Manifest,
} from "../../engine/index.js";
import type { WorkspaceConfig } from "../config.js";
import type { SyncRemote } from "../remote.js";
import { encryptAndUpload } from "../sync-recovery.js";
import { beginFirstPublishTiming } from "../upload-lane-timing.js";
import { enterPushSpansForTest, type FirstPublishTiming } from "../push-spans.js";
import { runPublishPipeline } from "./pipeline.js";
import { CipherDescriptorWriter } from "./shared.js";
import type { ReceiptPort } from "./receipt-drainer.js";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
let firstPublishTiming: FirstPublishTiming;

beforeEach(() => {
  firstPublishTiming = enterPushSpansForTest().firstPublish;
  delete process.env.RBOX_PREFLIGHT_DELTA;
  delete process.env.RBOX_PREFLIGHT_FULL;
});

class PipelineRemote implements SyncRemote {
  readonly blobs = new Map<string, Buffer>();
  readonly puts: string[] = [];
  readonly checks: string[][] = [];
  readonly putStarts: number[] = [];
  receipts = 0;
  redeemImpl?: () => Promise<any[]>;
  putHook?: (sha: string, file: string, call: number) => void | Promise<void>;
  checkHook?: (shas: string[]) => void | Promise<void>;
  closeHook?: () => void | Promise<void>;
  constructor(private readonly latency = 0, private readonly checkLatency = 0) {}
  async missingBlobs(shas: string[]): Promise<string[]> {
    this.checks.push([...shas]);
    await this.checkHook?.(shas);
    if (this.checkLatency) await Bun.sleep(this.checkLatency);
    return shas.filter((sha) => !this.blobs.has(sha));
  }
  async putBlobFile(sha: string, file: string): Promise<void> {
    this.putStarts.push(performance.now());
    this.puts.push(sha);
    await this.putHook?.(sha, file, this.puts.length);
    if (this.latency) await Bun.sleep(this.latency);
    this.blobs.set(sha, await fs.readFile(file));
    this.receipts++;
  }
  receiptPort(): ReceiptPort { return { receiptCount: () => this.receipts, redeem: async () => {
    const result = this.redeemImpl ? await this.redeemImpl() : [];
    this.receipts = 0;
    return result;
  } }; }
  async closeUploader(): Promise<void> { await this.closeHook?.(); }
  /** Never reached: the publish pipeline only uploads. Present so the double
   * IS a `SyncRemote` instead of being asserted into one. */
  latest(): never { throw new Error("PipelineRemote: latest is not part of the publish path"); }
  commit(): never { throw new Error("PipelineRemote: commit is not part of the publish path"); }
  blobStore(): never { throw new Error("PipelineRemote: blobStore is not part of the publish path"); }
}

async function fixture(count: number, duplicate = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-pipeline-test-"));
  const tmpDir = path.join(root, "tmp");
  await fs.mkdir(tmpDir);
  const files: FileEntry[] = [];
  for (let i = 0; i < count; i++) {
    const body = duplicate ? "same-content" : `content-${i}`;
    const rel = `f-${i}.txt`;
    const abs = path.join(root, rel);
    await fs.writeFile(abs, body);
    const stat = await fs.stat(abs);
    files.push({ path: rel, sha256: hash(body), size: Buffer.byteLength(body), mode: 0o644, mtimeMs: stat.mtimeMs, type: "file" });
  }
  return { root, tmpDir, local: { generatedAt: new Date(0).toISOString(), files } satisfies Manifest };
}

/** Entries are readonly: seed a carried ciphertext address by replacing the entry. */
function seedEncSha(files: FileEntry[], index: number, encSha: string): void {
  files[index] = { ...files[index]!, encSha };
}

/** The pipeline replaces entries in place of mutating them; it needs the containers. */
function trackEntries(files: FileEntry[], toEncrypt: FileEntry[]): CipherDescriptorWriter {
  const entries = new CipherDescriptorWriter();
  entries.track(files);
  if (toEncrypt !== files) entries.track(toEncrypt);
  return entries;
}

async function run(fx: Awaited<ReturnType<typeof fixture>>, remote: PipelineRemote, options: {
  cache?: EncryptAddressCache;
  writer?: EncryptAddressCacheWriter;
  encrypt?: typeof encryptFileToTemp;
  toEncrypt?: FileEntry[];
  preflightDelta?: boolean;
  fullAudit?: boolean;
  recoverAddresses?: ReadonlySet<string>;
} = {}) {
  const cache = options.cache ?? new EncryptAddressCache({ accountId: "a", workspaceId: "w", accountEpoch: 1, keyEpoch: 1 });
  const toEncrypt = options.toEncrypt ?? fx.local.files;
  return runPublishPipeline({
    api: remote,
    root: fx.root,
    kek: generateKek(),
    tmpDir: fx.tmpDir,
    toEncrypt,
    local: fx.local,
    entries: trackEntries(fx.local.files, toEncrypt),
    encryptCache: cache,
    cacheWriter: options.writer ?? new EncryptAddressCacheWriter(fx.root, cache, 60_000),
    encryptOpts: { compress: false },
    encryptFileToTemp: options.encrypt ?? encryptFileToTemp,
    report: PhaseReport.disabled(),
    backoff: async () => {},
    pool: undefined,
    preflightDelta: options.preflightDelta ?? false,
    fullAudit: options.fullAudit ?? false,
    recoverAddresses: options.recoverAddresses,
    deferred: new Set(),
    retryLater: new Set(),
    uploadsDir: path.join(fx.root, ".rbox", "state", "uploads"),
  });
}

const withEnv = async (values: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const old = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await fn();
  } finally {
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
};

const emptyManifest = (): Manifest => ({ generatedAt: new Date(0).toISOString(), files: [] });
const configFor = (root: string, kek: Buffer): WorkspaceConfig => ({
  remoteWorkspaceId: "w", projectId: "root", deviceId: "d", rootPath: root,
  remoteUrl: "http://example.invalid", token: "", encrypted: true, kek,
  accountId: "a", accountEpoch: 1, keyEpoch: 1,
});

test("publish pipeline overlaps encryption and upload and settles every temp", async () => {
  const fx = await fixture(80);
  try {
    const remote = new PipelineRemote(2);
    const result = await run(fx, remote);
    expect(result.needsUpload.size).toBe(0);
    expect(remote.blobs.size).toBe(80);
    expect(fx.local.files.every((file) => !!file.encSha)).toBe(true);
    expect(await fs.readdir(fx.tmpDir)).toEqual([]);
  } finally { await fs.rm(fx.root, { recursive: true, force: true }); }
});

test("publish pipeline releases duplicate and server-satisfied ciphertext temps", async () => {
  const duplicateFx = await fixture(4, true);
  try {
    const remote = new PipelineRemote();
    await run(duplicateFx, remote);
    expect(new Set(remote.puts).size).toBe(1);
    expect(await fs.readdir(duplicateFx.tmpDir)).toEqual([]);
  } finally { await fs.rm(duplicateFx.root, { recursive: true, force: true }); }

  const satisfiedFx = await fixture(1);
  try {
    const remote = new PipelineRemote();
    const encrypted = await encryptFileToTemp(path.join(satisfiedFx.root, satisfiedFx.local.files[0]!.path), generateKek(), satisfiedFx.tmpDir);
    // This seed uses a different KEK, so copy the descriptor and then run with a cache-like
    // carried reference to exercise the no-ready satisfied path deterministically.
    seedEncSha(satisfiedFx.local.files, 0, encrypted.encSha);
    remote.blobs.set(encrypted.encSha, await fs.readFile(encrypted.ciphertextPath));
    await fs.rm(encrypted.ciphertextPath, { force: true });
    const original = satisfiedFx.local.files[0]!;
    const toEncrypt: FileEntry[] = [];
    const cache = new EncryptAddressCache({ accountId: "a", workspaceId: "w", accountEpoch: 1, keyEpoch: 1 });
    await runPublishPipeline({
      api: remote, root: satisfiedFx.root, kek: generateKek(), tmpDir: satisfiedFx.tmpDir,
      toEncrypt, local: satisfiedFx.local, entries: trackEntries(satisfiedFx.local.files, toEncrypt), encryptCache: cache,
      cacheWriter: new EncryptAddressCacheWriter(satisfiedFx.root, cache), encryptOpts: { compress: false },
      encryptFileToTemp, report: PhaseReport.disabled(), backoff: async () => {}, pool: undefined,
      preflightDelta: false, fullAudit: false, deferred: new Set(), retryLater: new Set(), uploadsDir: path.join(satisfiedFx.root, "uploads"),
    });
    expect(original.encSha).toBe(encrypted.encSha);
    expect(remote.puts).toEqual([]);
  } finally { await fs.rm(satisfiedFx.root, { recursive: true, force: true }); }
});

test("pipeline applies bounded backpressure without deadlocking producers", async () => {
  const fx = await fixture(40);
  try {
    let encrypts = 0;
    let encryptsAtFirstPut = -1;
    const remote = new PipelineRemote(15);
    remote.putHook = () => { if (encryptsAtFirstPut < 0) encryptsAtFirstPut = encrypts; };
    await withEnv({ RBOX_PIPELINE_ITEMS: "2", RBOX_ENCRYPT_CONCURRENCY: "8", RBOX_UPLOAD_CONCURRENCY: "1" }, async () => {
      await run(fx, remote, { encrypt: async (...args) => { const blob = await encryptFileToTemp(...args); encrypts++; return blob; } });
    });
    expect(remote.blobs.size).toBe(40);
    expect(encryptsAtFirstPut).toBeGreaterThan(0);
    expect(encryptsAtFirstPut).toBeLessThan(40);
    expect(await fs.readdir(fx.tmpDir)).toEqual([]);
  } finally { await fs.rm(fx.root, { recursive: true, force: true }); }
});

test("drainer failure aborts with its cause and starts no post-latch PUT", async () => {
  const fx = await fixture(30);
  const quota = new Error("quota exhausted");
  let latchedAt = Infinity;
  try {
    const remote = new PipelineRemote(20);
    remote.redeemImpl = async () => { latchedAt = performance.now(); throw quota; };
    await withEnv({ RBOX_REDEEM_DRAIN: undefined, RBOX_PIPELINE_REDEEM_THRESHOLD: "1", RBOX_UPLOAD_CONCURRENCY: "1" }, async () => {
      await expect(run(fx, remote)).rejects.toBe(quota);
    });
    expect(remote.putStarts.every((started) => started <= latchedAt)).toBe(true);
    expect(await fs.readdir(fx.tmpDir)).toEqual([]);
  } finally { await fs.rm(fx.root, { recursive: true, force: true }); }
});

test("drainer returns durable needsUpload residue", async () => {
  const fx = await fixture(3);
  try {
    const remote = new PipelineRemote();
    const residue = "needs-upload-address";
    remote.redeemImpl = async () => [{ granted: 0, alreadyEntitled: 0, rejected: 0, needsUpload: [residue] }];
    await withEnv({ RBOX_REDEEM_DRAIN: undefined, RBOX_PIPELINE_REDEEM_THRESHOLD: "1" }, async () => {
      expect((await run(fx, remote)).needsUpload).toEqual(new Set([residue]));
    });
  } finally { await fs.rm(fx.root, { recursive: true, force: true }); }
});

test("pre-existing receipt backlog is drained before the first PUT", async () => {
  const fx = await fixture(3);
  try {
    const remote = new PipelineRemote();
    remote.receipts = 3;
    let redeems = 0;
    remote.redeemImpl = async () => { redeems++; return []; };
    remote.putHook = () => { expect(redeems).toBeGreaterThan(0); };
    await withEnv({ RBOX_REDEEM_DRAIN: undefined, RBOX_PIPELINE_REDEEM_THRESHOLD: "1", RBOX_UPLOAD_CONCURRENCY: "1" }, async () => {
      await run(fx, remote);
    });
    expect(redeems).toBeGreaterThan(0);
    expect(remote.blobs.size).toBe(3);
  } finally { await fs.rm(fx.root, { recursive: true, force: true }); }
});

test("RBOX_REDEEM_DRAIN=off disables pipeline upload-time draining (kill switch is global)", async () => {
  const fx = await fixture(3);
  try {
    const remote = new PipelineRemote();
    let redeems = 0;
    remote.redeemImpl = async () => { redeems++; return []; };
    await withEnv({ RBOX_REDEEM_DRAIN: "off", RBOX_PIPELINE_REDEEM_THRESHOLD: "1" }, async () => {
      await run(fx, remote);
    });
    expect(redeems).toBe(0);
    expect(remote.receipts).toBe(3);
  } finally { await fs.rm(fx.root, { recursive: true, force: true }); }
});

test("delta recovery checks mapped and address-only entries without uploading the latter", async () => {
  const fx = await fixture(1);
  try {
    const mapped = "a".repeat(64);
    const unmapped = "b".repeat(64);
    seedEncSha(fx.local.files, 0, mapped);
    let encrypts = 0;
    const remote = new PipelineRemote();
    await run(fx, remote, {
      toEncrypt: [],
      preflightDelta: true,
      recoverAddresses: new Set([mapped, unmapped]),
      encrypt: async (...args) => { encrypts++; return encryptFileToTemp(...args); },
    });
    expect(new Set(remote.checks.flat())).toEqual(new Set([mapped, unmapped, fx.local.files[0]!.encSha!]));
    expect(encrypts).toBe(1);
    expect(remote.puts).toEqual([fx.local.files[0]!.encSha!]);
    expect(remote.puts).not.toContain(unmapped);
  } finally { await fs.rm(fx.root, { recursive: true, force: true }); }
});

test("classification failure retains ready temps through uploader close barrier", async () => {
  const fx = await fixture(1);
  const failure = new Error("check failed");
  try {
    const remote = new PipelineRemote();
    remote.checkHook = async () => { throw failure; };
    let tempsAtClose: string[] = [];
    remote.closeHook = async () => { tempsAtClose = await fs.readdir(fx.tmpDir); };
    await expect(run(fx, remote)).rejects.toBe(failure);
    expect(tempsAtClose.length).toBeGreaterThan(0);
    expect(await fs.readdir(fx.tmpDir)).toEqual([]);
  } finally { await fs.rm(fx.root, { recursive: true, force: true }); }
});

test("unsatisfied cache hit re-encrypts and PUTs exactly once", async () => {
  const fx = await fixture(1);
  try {
    const file = fx.local.files[0]!;
    const cache = new EncryptAddressCache({ accountId: "a", workspaceId: "w", accountEpoch: 1, keyEpoch: 1 });
    cache.record(file.sha256, { encSha: "a".repeat(64), cipherSize: file.size, path: file.path });
    let encrypts = 0;
    const remote = new PipelineRemote();
    await run(fx, remote, { cache, encrypt: async (...args) => { encrypts++; return encryptFileToTemp(...args); } });
    expect(encrypts).toBe(1);
    expect(remote.puts).toEqual([fx.local.files[0]!.encSha!]);
  } finally { await fs.rm(fx.root, { recursive: true, force: true }); }
});

test("mutation after ready uploads the scanned snapshot", async () => {
  const fx = await fixture(1);
  try {
    const file = fx.local.files[0]!;
    const scannedSha = file.sha256;
    let snapshotSha = "";
    let snapshotBytes = Buffer.alloc(0);
    const remote = new PipelineRemote(20);
    await run(fx, remote, { encrypt: async (...args) => {
      const blob = await encryptFileToTemp(...args);
      snapshotSha = blob.encSha;
      snapshotBytes = await fs.readFile(blob.ciphertextPath);
      await fs.writeFile(path.join(fx.root, file.path), "mutated-after-ready");
      return blob;
    } });
    expect(fx.local.files[0]!.sha256).toBe(scannedSha);
    expect(fx.local.files[0]!.encSha).toBe(snapshotSha);
    expect(remote.blobs.get(snapshotSha)).toEqual(snapshotBytes);
  } finally { await fs.rm(fx.root, { recursive: true, force: true }); }
});

test("encryptAndUpload routes flag-off and small pushes to legacy, large pushes to pipeline", async () => {
  for (const [flag, count, pipeline] of [[undefined, 64, false], ["1", 63, false], ["1", 64, true]] as const) {
    const fx = await fixture(count);
    try {
      const remote = new PipelineRemote();
      let sawRunTemp = false;
      remote.checkHook = async () => {
        const parent = path.join(fx.root, ".rbox", "state", "tmp");
        const entries = await fs.readdir(parent).catch(() => []);
        sawRunTemp ||= entries.some((entry) => entry.startsWith("enc-"));
      };
      await withEnv({ RBOX_PUBLISH_PIPELINE: flag, RBOX_CRYPTO_FUSE: "0" }, async () => {
        await encryptAndUpload(remote, fx.root, configFor(fx.root, generateKek()), fx.local, emptyManifest(), PhaseReport.disabled(), undefined, async () => {});
      });
      if (pipeline) expect(remote.checks.length).toBeGreaterThanOrEqual(1);
      else expect(remote.checks.length).toBe(1);
      expect(sawRunTemp).toBe(pipeline);
    } finally { await fs.rm(fx.root, { recursive: true, force: true }); }
  }
});

test("pipeline preflight defaults to introduced-only and =0 restores the carried-address sweep", async () => {
  const carried = "a".repeat(64);
  for (const [deltaFlag, expectedCarriedChecks] of [[undefined, 0], ["0", 2]] as const) {
    const fx = await fixture(66);
    try {
      const carriedFiles = fx.local.files.slice(-2).map((file) => ({
        ...file,
        encSha: carried,
        cipherSize: file.size,
      }));
      const base: Manifest = { generatedAt: new Date(0).toISOString(), files: carriedFiles };
      const remote = new PipelineRemote();
      remote.blobs.set(carried, Buffer.from("already-present"));

      await withEnv({
        RBOX_PUBLISH_PIPELINE: "1",
        RBOX_CRYPTO_FUSE: "0",
        RBOX_PREFLIGHT_DELTA: deltaFlag,
      }, async () => {
        await encryptAndUpload(
          remote,
          fx.root,
          configFor(fx.root, generateKek()),
          fx.local,
          base,
          PhaseReport.disabled(),
          undefined,
          async () => {},
        );
      });

      expect(remote.checks.flat().filter((address) => address === carried)).toHaveLength(expectedCarriedChecks);
      if (deltaFlag === "0") {
        expect(remote.checks.some((addresses) => addresses.length === 2 && addresses.every((address) => address === carried))).toBe(true);
      }
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  }
});

test("failed pipeline PUT closes first-publish upload activity", async () => {
  const fx = await fixture(64);
  try {
    beginFirstPublishTiming(true);
    const remote = new PipelineRemote();
    const fatal = new Error("pipeline PUT failed");
    remote.putHook = () => { throw fatal; };
    await withEnv({ RBOX_PUBLISH_PIPELINE: "1", RBOX_CRYPTO_FUSE: "0" }, async () => {
      await expect(encryptAndUpload(remote as unknown as SyncRemote, fx.root, configFor(fx.root, generateKek()), fx.local, emptyManifest(), PhaseReport.disabled(), undefined, async () => {})).rejects.toBe(fatal);
    });
    expect(firstPublishTiming.uploadActive).toBe(0);
    expect(firstPublishTiming.uploadOpenAt).toBe(0);
  } finally {
    beginFirstPublishTiming(false);
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test("failed legacy PUT closes first-publish upload activity", async () => {
  const fx = await fixture(1);
  try {
    beginFirstPublishTiming(true);
    const remote = new PipelineRemote();
    const fatal = new Error("legacy PUT failed");
    remote.putHook = () => { throw fatal; };
    await withEnv({ RBOX_PUBLISH_PIPELINE: undefined, RBOX_CRYPTO_FUSE: "0" }, async () => {
      await expect(encryptAndUpload(remote as unknown as SyncRemote, fx.root, configFor(fx.root, generateKek()), fx.local, emptyManifest(), PhaseReport.disabled(), undefined, async () => {})).rejects.toBe(fatal);
    });
    expect(firstPublishTiming.uploadActive).toBe(0);
    expect(firstPublishTiming.uploadOpenAt).toBe(0);
  } finally {
    beginFirstPublishTiming(false);
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test("interrupted run resumes from persisted satisfied cache hits", async () => {
  const fx = await fixture(100);
  const context = { accountId: "a", workspaceId: "w", accountEpoch: 1, keyEpoch: 1 };
  try {
    const remote = new PipelineRemote();
    const fatal = new Error("injected consumer failure");
    const landedBeforeFailure = 12;
    remote.putHook = (_sha, _file, call) => { if (call === landedBeforeFailure + 1) throw fatal; };
    const cache1 = new EncryptAddressCache(context);
    const writer1 = new EncryptAddressCacheWriter(fx.root, cache1, 60_000);
    let run1Error: unknown;
    await withEnv({ RBOX_UPLOAD_CONCURRENCY: "1" }, async () => {
      try { await run(fx, remote, { cache: cache1, writer: writer1 }); }
      catch (error) { run1Error = error; }
    });
    expect(run1Error).toBe(fatal);
    await writer1.flush();
    const landed = new Set(remote.blobs.keys());
    expect(landed.size).toBe(landedBeforeFailure);

    const resumed = await fixture(0);
    await fs.rm(resumed.root, { recursive: true, force: true });
    const files: FileEntry[] = [];
    for (const original of fx.local.files) {
      const stat = await fs.stat(path.join(fx.root, original.path));
      files.push({ path: original.path, sha256: original.sha256, size: original.size, mode: original.mode, mtimeMs: stat.mtimeMs, type: "file" });
    }
    const resumeFx = { root: fx.root, tmpDir: fx.tmpDir, local: { generatedAt: new Date(0).toISOString(), files } satisfies Manifest };
    const cache2 = await EncryptAddressCache.load(fx.root, context);
    let reencryptionCount = 0;
    remote.putHook = undefined;
    remote.puts.length = 0;
    await run(resumeFx, remote, { cache: cache2, encrypt: async (...args) => { reencryptionCount++; return encryptFileToTemp(...args); } });
    expect(reencryptionCount).toBe(100 - landed.size);
    expect(remote.puts.length).toBe(100 - landed.size);
    expect(remote.puts.some((sha) => landed.has(sha))).toBe(false);
    expect(remote.blobs.size).toBe(100);
  } finally { await fs.rm(fx.root, { recursive: true, force: true }); }
});

test("pipeline run reclaims repeated-kill temp directories", async () => {
  const fx = await fixture(64);
  try {
    const parent = path.join(fx.root, ".rbox", "state", "tmp");
    for (const name of [`enc-111-old`, `enc-${process.pid}-live`, `enc-333-old`]) {
      await fs.mkdir(path.join(parent, name), { recursive: true });
      await fs.writeFile(path.join(parent, name, "junk"), "junk");
    }
    let during = -1;
    const remote = new PipelineRemote();
    remote.checkHook = async () => { during = (await fs.readdir(parent)).filter((name) => name.startsWith("enc-")).length; };
    await withEnv({ RBOX_PUBLISH_PIPELINE: "1", RBOX_CRYPTO_FUSE: "0" }, async () => {
      await encryptAndUpload(remote, fx.root, configFor(fx.root, generateKek()), fx.local, emptyManifest(), PhaseReport.disabled(), undefined, async () => {});
    });
    expect(during).toBe(1);
    expect((await fs.readdir(parent)).filter((name) => name.startsWith("enc-"))).toEqual([]);
  } finally { await fs.rm(fx.root, { recursive: true, force: true }); }
});

test("tiny disk budget admits oversized files one at a time", async () => {
  const fx = await fixture(4);
  try {
    for (const file of fx.local.files) {
      const body = Buffer.alloc(4096, Number(file.path.match(/\d+/)?.[0] ?? 0));
      await fs.writeFile(path.join(fx.root, file.path), body);
      const stat = await fs.stat(path.join(fx.root, file.path));
      file.sha256 = hash(body); file.size = body.length; file.mtimeMs = stat.mtimeMs;
    }
    await withEnv({ RBOX_PIPELINE_QUEUE_BYTES: "1024", RBOX_ENCRYPT_CONCURRENCY: "4" }, async () => {
      await run(fx, new PipelineRemote());
    });
    expect(await fs.readdir(fx.tmpDir)).toEqual([]);
  } finally { await fs.rm(fx.root, { recursive: true, force: true }); }
});
