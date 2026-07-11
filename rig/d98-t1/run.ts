import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateKek, PhaseReport, type FileEntry, type Manifest } from "../../src/engine/index.js";
import type { WorkspaceConfig } from "../../src/cli/config.js";
import type { SyncRemote } from "../../src/cli/remote.js";
import { encryptAndUpload } from "../../src/cli/sync-recovery.js";
import type { ReceiptPort } from "../../src/cli/publish-pipeline/receipt-drainer.js";

const argv = process.argv.slice(2);
function option(name: string, fallback: number): number {
  const index = argv.indexOf(name);
  const value = index < 0 ? fallback : Number(argv[index + 1]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}

const fileCount = option("--files", 500);
const runs = option("--runs", 5);
const putMs = option("--put-ms", 15);
const missingMs = option("--missing-ms", 30);
const usePool = argv.includes("--pool");
const uploadConc = option("--upload-conc", 0); // 0 = unconstrained (production default); N caps BOTH arms
if (!Number.isInteger(fileCount) || fileCount < 64) throw new Error("--files must be an integer >= 64 so Arm B reaches the production pipeline");
if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");

const sleep = (ms: number) => ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 2 ** 32; };
}

const histogram = [
  { max: 511, share: 25 },
  { max: 2_047, share: 35 },
  { max: 8_191, share: 25 },
  { max: 32_767, share: 10 },
  { max: 65_536, share: 5 },
] as const;

function corpusBytes(count: number, seed: number): Buffer[] {
  const random = rng(seed);
  return Array.from({ length: count }, (_, index) => {
    const pick = random() * 100;
    let cumulative = 0;
    const bucket = histogram.find((item) => (cumulative += item.share) > pick)!;
    const priorMax = histogram[histogram.indexOf(bucket) - 1]?.max ?? 255;
    const size = priorMax + 1 + Math.floor(random() * (bucket.max - priorMax));
    const bytes = Buffer.alloc(size);
    if (random() < 0.6) {
      const token = Buffer.from(`synthetic-${index}-aaaaaaaaaaaaaaaa\n`);
      for (let offset = 0; offset < size; offset += token.length) token.copy(bytes, offset, 0, Math.min(token.length, size - offset));
    } else {
      for (let offset = 0; offset < size; offset++) bytes[offset] = Math.floor(random() * 256);
    }
    return bytes;
  });
}

class MemoryRemote {
  readonly blobs = new Map<string, Buffer>();
  putCount = 0;
  checkCalls = 0;
  activePuts = 0;
  maxConcurrentPuts = 0;
  private receipts = 0;

  async missingBlobs(shas: string[]): Promise<string[]> {
    this.checkCalls++;
    await sleep(missingMs);
    return shas.filter((sha) => !this.blobs.has(sha));
  }

  async putBlobFile(sha: string, file: string, size: number, _uploadsDir?: string, onBytes?: (absolute: number) => void): Promise<void> {
    this.putCount++;
    this.activePuts++;
    this.maxConcurrentPuts = Math.max(this.maxConcurrentPuts, this.activePuts);
    try {
      await sleep(putMs);
      const bytes = await fs.readFile(file);
      if (bytes.length !== size || sha256(bytes) !== sha) throw new Error("fake PUT integrity failure");
      this.blobs.set(sha, Buffer.from(bytes));
      this.receipts++;
      onBytes?.(size);
    } finally {
      this.activePuts--;
    }
  }

  receiptPort(): ReceiptPort {
    return {
      receiptCount: () => this.receipts,
      redeem: async () => { await sleep(5); this.receipts = 0; return []; },
    };
  }
  async closeUploader(_error: Error): Promise<void> {}
  uploaderDispatchCount(): number { return this.putCount; }
}

type Arm = "A" | "B";
type Sample = {
  arm: Arm; run: number; wallMs: number; putCount: number; checkCalls: number;
  maxConcurrentPuts: number; storedCount: number; storedBytes: number;
};
type ArmResult = { sample: Sample; blobShas: string[]; descriptors: string };

async function fixture(parent: string, arm: Arm, bodies: Buffer[]): Promise<{ root: string; local: Manifest }> {
  const root = await fs.mkdtemp(path.join(parent, `arm-${arm.toLowerCase()}-`));
  const files: FileEntry[] = [];
  for (let index = 0; index < bodies.length; index++) {
    const body = bodies[index]!;
    const relative = `synthetic/${String(index).padStart(6, "0")}.bin`;
    const absolute = path.join(root, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, body);
    const stat = await fs.stat(absolute);
    files.push({ path: relative, sha256: sha256(body), size: body.length, mode: 0o644, mtimeMs: stat.mtimeMs, type: "file" });
  }
  return { root, local: { generatedAt: new Date(0).toISOString(), files } };
}

function descriptorSignature(manifest: Manifest): string {
  return JSON.stringify(manifest.files.map((file) => ({
    encSha: file.encSha,
    ...(file.comp ? { comp: file.comp, payloadSha: file.payloadSha, cipherSize: file.cipherSize } : {}),
  })));
}

async function runArm(arm: Arm, run: number, parent: string, bodies: Buffer[], kek: Buffer): Promise<ArmResult> {
  const { root, local } = await fixture(parent, arm, bodies);
  const remote = new MemoryRemote();
  const cfg: WorkspaceConfig = {
    remoteWorkspaceId: "synthetic-workspace", projectId: "root", deviceId: "synthetic-device",
    rootPath: root, remoteUrl: "http://example.invalid", token: "", encrypted: true, kek,
    accountId: "synthetic-account", accountEpoch: 1, keyEpoch: 1,
  };
  if (arm === "A") delete process.env.RBOX_PUBLISH_PIPELINE;
  else process.env.RBOX_PUBLISH_PIPELINE = "1";
  const start = performance.now();
  const outcome = await encryptAndUpload(remote as unknown as SyncRemote, root, cfg, local,
    { generatedAt: new Date(0).toISOString(), files: [] }, PhaseReport.disabled(), undefined, async () => {});
  const wallMs = performance.now() - start;
  if (outcome.deferred.size || outcome.retryLater.size || outcome.needsUpload?.size) throw new Error(`${arm} did not settle every synthetic blob`);
  const storedBytes = [...remote.blobs.values()].reduce((total, bytes) => total + bytes.length, 0);
  return {
    sample: { arm, run, wallMs, putCount: remote.putCount, checkCalls: remote.checkCalls,
      maxConcurrentPuts: remote.maxConcurrentPuts, storedCount: remote.blobs.size, storedBytes },
    blobShas: [...remote.blobs.keys()].sort(), descriptors: descriptorSignature(local),
  };
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const summarize = (samples: Sample[]) => ({
  samples: samples.length,
  wallMs: { p50: median(samples.map((sample) => sample.wallMs)), min: Math.min(...samples.map((sample) => sample.wallMs)), max: Math.max(...samples.map((sample) => sample.wallMs)) },
  putCount: { p50: median(samples.map((sample) => sample.putCount)), min: Math.min(...samples.map((sample) => sample.putCount)), max: Math.max(...samples.map((sample) => sample.putCount)) },
  checkCalls: { p50: median(samples.map((sample) => sample.checkCalls)), min: Math.min(...samples.map((sample) => sample.checkCalls)), max: Math.max(...samples.map((sample) => sample.checkCalls)) },
  maxConcurrentPuts: { p50: median(samples.map((sample) => sample.maxConcurrentPuts)), min: Math.min(...samples.map((sample) => sample.maxConcurrentPuts)), max: Math.max(...samples.map((sample) => sample.maxConcurrentPuts)) },
  storedCount: { p50: median(samples.map((sample) => sample.storedCount)) },
  storedBytes: { p50: median(samples.map((sample) => sample.storedBytes)) },
});

const envKeys = [
  "RBOX_PUBLISH_PIPELINE", "RBOX_CRYPTO_WORKERS", "RBOX_CRYPTO_FUSE",
  "RBOX_UPLOAD_CONCURRENCY", "RBOX_ENCRYPT_CONCURRENCY", "RBOX_BATCH_BLOBS", "RBOX_COMPRESS",
  "RBOX_PIPELINE_ITEMS", "RBOX_PIPELINE_QUEUE_BYTES", "RBOX_PIPELINE_REDEEM_THRESHOLD",
];
const priorEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const samples: Sample[] = [];
const corpus = corpusBytes(fileCount, 98_001);
const plaintextBytes = corpus.reduce((total, bytes) => total + bytes.length, 0);
const kek = generateKek();
try {
  for (const key of envKeys) delete process.env[key];
  process.env.RBOX_CRYPTO_FUSE = "0";
  if (usePool) delete process.env.RBOX_CRYPTO_WORKERS;
  else process.env.RBOX_CRYPTO_WORKERS = "0";
  if (uploadConc > 0) process.env.RBOX_UPLOAD_CONCURRENCY = String(uploadConc); // applied to BOTH arms — fair A/B
  for (let run = 1; run <= runs; run++) {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-d98-t1-"));
    try {
      const order: Arm[] = run % 2 ? ["A", "B"] : ["B", "A"];
      const pair = new Map<Arm, ArmResult>();
      for (const arm of order) {
        const result = await runArm(arm, run, parent, corpus, kek);
        pair.set(arm, result); samples.push(result.sample);
      }
      const a = pair.get("A")!; const b = pair.get("B")!;
      if (a.descriptors !== b.descriptors || JSON.stringify(a.blobShas) !== JSON.stringify(b.blobShas)) {
        throw new Error(`run ${run} correctness guard failed`);
      }
    } finally { await fs.rm(parent, { recursive: true, force: true }); }
  }
} finally {
  for (const key of envKeys) priorEnv[key] === undefined ? delete process.env[key] : process.env[key] = priorEnv[key];
}

const a = summarize(samples.filter((sample) => sample.arm === "A"));
const b = summarize(samples.filter((sample) => sample.arm === "B"));
const speedup = a.wallMs.p50 / b.wallMs.p50;
const overlapHeadroomMs = a.wallMs.p50 - b.wallMs.p50;
const finding = overlapHeadroomMs > 0
  ? "Arm B recovered positive overlap headroom on this small synthetic workload."
  : `Arm B did not recover overlap on this small synthetic workload. Its ${b.checkCalls.p50} p50 rolling checks exceeded Arm A's ${a.checkCalls.p50}; this is behavior of the production pipeline reached through the real entry point.`;
const result = {
  schemaVersion: 1,
  configuration: { files: fileCount, runs, putLatencyMs: putMs, missingLatencyMs: missingMs, receiptLatencyMs: 5, cryptoPoolEnabled: usePool },
  corpus: { fileCount, plaintextBytes, minFileBytes: Math.min(...corpus.map((bytes) => bytes.length)), maxFileBytes: Math.max(...corpus.map((bytes) => bytes.length)) },
  arms: { A: a, B: b },
  overlap: { factor: speedup, headroomMs: overlapHeadroomMs },
  samples,
};
const resultsDir = new URL("./results/", import.meta.url);
await fs.mkdir(resultsDir, { recursive: true });
await fs.writeFile(new URL("results.json", resultsDir), JSON.stringify(result, null, 2) + "\n");
const report = `# Design 98 Tier 1 A/B overlap report

**THROWAWAY / MEASUREMENT-ONLY.** Seeded synthetic data only. Correctness guard passed for every paired run.

Configuration: ${fileCount} files, ${plaintextBytes} plaintext bytes, ${runs} runs per arm, PUT latency ${putMs.toFixed(1)} ms, missing-check latency ${missingMs.toFixed(1)} ms, receipt latency 5.0 ms, crypto ${usePool ? "pool" : "inline"}.

| Arm | Wall p50 ms | Wall range ms | PUT count p50 | Check calls p50 | Max concurrent PUTs p50 | Stored bytes p50 |
|---|---:|---:|---:|---:|---:|---:|
| A (serialized) | ${a.wallMs.p50.toFixed(1)} | ${a.wallMs.min.toFixed(1)}–${a.wallMs.max.toFixed(1)} | ${a.putCount.p50} | ${a.checkCalls.p50} | ${a.maxConcurrentPuts.p50} | ${a.storedBytes.p50} |
| B (pipeline) | ${b.wallMs.p50.toFixed(1)} | ${b.wallMs.min.toFixed(1)}–${b.wallMs.max.toFixed(1)} | ${b.putCount.p50} | ${b.checkCalls.p50} | ${b.maxConcurrentPuts.p50} | ${b.storedBytes.p50} |

Overlap factor: **${speedup.toFixed(3)}×**  
Overlap headroom: **${overlapHeadroomMs.toFixed(1)} ms**

Finding: ${finding}
`;
await fs.writeFile(new URL("REPORT.md", resultsDir), report);
console.log(`OVERLAP: A_p50=${a.wallMs.p50.toFixed(1)}ms B_p50=${b.wallMs.p50.toFixed(1)}ms speedup=${speedup.toFixed(2)}x`);
