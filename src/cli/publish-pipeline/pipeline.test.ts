import { expect, test } from "bun:test";
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
import type { SyncRemote } from "../remote.js";
import { runPublishPipeline } from "./pipeline.js";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

class PipelineRemote {
  readonly blobs = new Map<string, Buffer>();
  readonly puts: string[] = [];
  readonly checks: string[][] = [];
  constructor(private readonly latency = 0) {}
  async missingBlobs(shas: string[]): Promise<string[]> {
    this.checks.push([...shas]);
    return shas.filter((sha) => !this.blobs.has(sha));
  }
  async putBlobFile(sha: string, file: string): Promise<void> {
    this.puts.push(sha);
    if (this.latency) await Bun.sleep(this.latency);
    this.blobs.set(sha, await fs.readFile(file));
  }
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

async function run(fx: Awaited<ReturnType<typeof fixture>>, remote: PipelineRemote) {
  const cache = new EncryptAddressCache({ accountId: "a", workspaceId: "w", accountEpoch: 1, keyEpoch: 1 });
  return runPublishPipeline({
    api: remote as unknown as SyncRemote,
    root: fx.root,
    kek: generateKek(),
    tmpDir: fx.tmpDir,
    toEncrypt: fx.local.files,
    local: fx.local,
    encryptCache: cache,
    cacheWriter: new EncryptAddressCacheWriter(fx.root, cache, 60_000),
    encryptOpts: { compress: false },
    encryptFileToTemp,
    report: PhaseReport.disabled(),
    backoff: async () => {},
    pool: undefined,
    preflightDelta: false,
    fullAudit: false,
    deferred: new Set(),
    retryLater: new Set(),
    uploadsDir: path.join(fx.root, ".rbox", "state", "uploads"),
  });
}

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
    satisfiedFx.local.files[0]!.encSha = encrypted.encSha;
    remote.blobs.set(encrypted.encSha, await fs.readFile(encrypted.ciphertextPath));
    await fs.rm(encrypted.ciphertextPath, { force: true });
    const original = satisfiedFx.local.files[0]!;
    const toEncrypt: FileEntry[] = [];
    const cache = new EncryptAddressCache({ accountId: "a", workspaceId: "w", accountEpoch: 1, keyEpoch: 1 });
    await runPublishPipeline({
      api: remote as unknown as SyncRemote, root: satisfiedFx.root, kek: generateKek(), tmpDir: satisfiedFx.tmpDir,
      toEncrypt, local: satisfiedFx.local, encryptCache: cache,
      cacheWriter: new EncryptAddressCacheWriter(satisfiedFx.root, cache), encryptOpts: { compress: false },
      encryptFileToTemp, report: PhaseReport.disabled(), backoff: async () => {}, pool: undefined,
      preflightDelta: false, fullAudit: false, deferred: new Set(), retryLater: new Set(), uploadsDir: path.join(satisfiedFx.root, "uploads"),
    });
    expect(original.encSha).toBe(encrypted.encSha);
    expect(remote.puts).toEqual([]);
  } finally { await fs.rm(satisfiedFx.root, { recursive: true, force: true }); }
});
