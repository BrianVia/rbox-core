import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PhaseReport, encryptFileToTemp, generateKek, type FileEntry, type Manifest } from "../engine/index.js";
import type { WorkspaceConfig } from "./config.js";
import { E2eeRemote } from "./e2ee-remote.js";
import type { E2eeApi, E2eeContext, PinStore } from "./e2ee-remote-types.js";
import type { SyncRemote } from "./remote.js";
import type { ReceiptRedeemResult } from "./remote/commits.js";
import { encryptAndUpload } from "./sync-recovery.js";
import { beginFirstPublishTiming, uploadActiveOverlapMs } from "./upload-lane-timing.js";
import { enterPushSpansForTest, type FirstPublishTiming } from "./push-spans.js";

const savedEnv = {
  RBOX_REDEEM_DRAIN: process.env.RBOX_REDEEM_DRAIN,
  RBOX_PIPELINE_REDEEM_THRESHOLD: process.env.RBOX_PIPELINE_REDEEM_THRESHOLD,
  RBOX_UPLOAD_CONCURRENCY: process.env.RBOX_UPLOAD_CONCURRENCY,
  RBOX_CRYPTO_FUSE: process.env.RBOX_CRYPTO_FUSE,
  RBOX_METRICS: process.env.RBOX_METRICS,
};

let firstPublishTiming: FirstPublishTiming;
beforeEach(() => { firstPublishTiming = enterPushSpansForTest().firstPublish; });

afterEach(() => {
  beginFirstPublishTiming(false);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const emptyManifest = (): Manifest => ({ generatedAt: new Date(0).toISOString(), files: [] });
const configFor = (root: string): WorkspaceConfig => ({
  remoteWorkspaceId: "w", projectId: "root", deviceId: "d", rootPath: root,
  remoteUrl: "http://example.invalid", token: "", encrypted: true, kek: generateKek(),
  accountId: "a", accountEpoch: 1, keyEpoch: 1,
});

async function fixture(count: number) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-redeem-upload-"));
  const files: FileEntry[] = [];
  for (let i = 0; i < count; i++) {
    const body = `receipt-drain-${i}`;
    const rel = `f-${i}.txt`;
    await fs.writeFile(path.join(root, rel), body);
    const stat = await fs.stat(path.join(root, rel));
    files.push({ path: rel, sha256: hash(body), size: body.length, mode: 0o644, mtimeMs: stat.mtimeMs, type: "file" });
  }
  return { root, local: { generatedAt: new Date(0).toISOString(), files } satisfies Manifest };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(5);
  }
}

class DrainRemote {
  readonly receipts = new Map<string, string>();
  readonly blobs = new Set<string>();
  readonly entitled = new Set<string>();
  readonly granted = new Map<string, number>();
  puts = 0;
  redeems = 0;
  putHook?: (call: number) => Promise<void> | void;
  redeemHook?: (entries: Array<[string, string]>) => Promise<ReceiptRedeemResult[]>;

  async missingBlobs(shas: string[]): Promise<string[]> { return shas.filter((sha) => !this.entitled.has(sha)); }
  async putBlobFile(sha: string): Promise<void> {
    const call = ++this.puts;
    await this.putHook?.(call);
    this.blobs.add(sha);
    this.receipts.set(sha, `receipt-${call}`);
  }
  receiptPort() {
    return {
      receiptCount: () => this.receipts.size,
      redeem: async (): Promise<ReceiptRedeemResult[]> => {
        this.redeems++;
        const entries = [...this.receipts.entries()];
        const results = this.redeemHook
          ? await this.redeemHook(entries)
          : [{ granted: entries.length, alreadyEntitled: 0, rejected: 0, settled: entries.map(([sha]) => sha) }];
        const settled = new Set(results.flatMap((result) => result.settled ?? []));
        const fenced = new Set(results.flatMap((result) => result.needsUpload ?? []));
        for (const [sha, receipt] of entries) {
          if (settled.has(sha) && !this.entitled.has(sha)) {
            this.entitled.add(sha);
            this.granted.set(sha, (this.granted.get(sha) ?? 0) + 1);
          }
          if ((settled.has(sha) || fenced.has(sha)) && this.receipts.get(sha) === receipt) this.receipts.delete(sha);
        }
        return results;
      },
    };
  }
}

const wrap = (remote: DrainRemote) => new E2eeRemote(
  remote as unknown as E2eeApi,
  { accountId: "a", workspaceId: "w", secrets: {} as never, now: Date.now } as E2eeContext,
  { load: async () => undefined, save: async () => {} } satisfies PinStore,
);

async function run(
  fx: Awaited<ReturnType<typeof fixture>>,
  remote: DrainRemote,
  report: PhaseReport = PhaseReport.disabled(),
  syncRemote: SyncRemote = remote as unknown as SyncRemote,
) {
  return encryptAndUpload(
    syncRemote,
    fx.root,
    configFor(fx.root),
    fx.local,
    emptyManifest(),
    report,
    undefined,
    async () => {},
    { encryptFileToTemp },
  );
}

test("serialized upload drains before the final PUT settles and flushes before return", async () => {
  const fx = await fixture(3);
  let releaseLast!: () => void;
  const last = new Promise<void>((resolve) => { releaseLast = resolve; });
  let pending: ReturnType<typeof run> | undefined;
  try {
    process.env.RBOX_REDEEM_DRAIN = "upload";
    process.env.RBOX_PIPELINE_REDEEM_THRESHOLD = "1";
    process.env.RBOX_UPLOAD_CONCURRENCY = "1";
    const remote = new DrainRemote();
    remote.putHook = async (call) => { if (call === 3) await last; };
    pending = run(fx, remote);
    await waitFor(() => remote.puts === 3, "last PUT did not start");
    await waitFor(() => remote.redeems > 0, "redemption did not overlap upload");
    releaseLast();
    await pending;
    expect(remote.receipts.size).toBe(0);
  } finally {
    releaseLast();
    await pending?.catch(() => {});
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test("upload-time draining engages through the production E2eeRemote wrapper (field gap)", async () => {
  const fx = await fixture(3);
  let releaseLast!: () => void;
  const last = new Promise<void>((resolve) => { releaseLast = resolve; });
  let pending: ReturnType<typeof run> | undefined;
  let overlap = 0;
  try {
    delete process.env.RBOX_REDEEM_DRAIN; // default-on path
    delete process.env.RBOX_METRICS;
    process.env.RBOX_PIPELINE_REDEEM_THRESHOLD = "1";
    process.env.RBOX_UPLOAD_CONCURRENCY = "1";
    const remote = new DrainRemote();
    remote.putHook = async (call) => { if (call === 3) await last; };
    remote.redeemHook = async (entries) => {
      const t0 = performance.now();
      await Bun.sleep(10);
      overlap = Math.max(overlap, uploadActiveOverlapMs(t0, performance.now()));
      return [{ granted: entries.length, alreadyEntitled: 0, rejected: 0, settled: entries.map(([sha]) => sha) }];
    };
    pending = run(fx, remote, PhaseReport.push(), wrap(remote));
    await waitFor(() => remote.puts === 3, "last PUT did not start");
    await waitFor(() => remote.redeems > 0, "drain never engaged through E2eeRemote");
    releaseLast();
    await pending;
    expect(overlap).toBeGreaterThan(0);
    expect(remote.receipts.size).toBe(0);
  } finally {
    releaseLast();
    await pending?.catch(() => {});
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test("serialized upload leaves redemption to commit when flag is off", async () => {
  const fx = await fixture(2);
  try {
    process.env.RBOX_REDEEM_DRAIN = "off"; // kill switch (default is ON)
    const remote = new DrainRemote();
    await run(fx, remote);
    expect(remote.redeems).toBe(0);
    expect(remote.receipts.size).toBe(2);
  } finally { await fs.rm(fx.root, { recursive: true, force: true }); }
});

test("only 'off' disables draining; other values (and unset) stay ON", async () => {
  const fx = await fixture(1);
  try {
    process.env.RBOX_REDEEM_DRAIN = "true"; // not the kill switch — drain stays on
    const remote = new DrainRemote();
    await run(fx, remote);
    expect(remote.redeems).toBeGreaterThan(0);
    expect(remote.receipts.size).toBe(0);
  } finally { await fs.rm(fx.root, { recursive: true, force: true }); }
});

test("serialized final flush records its independent wall measurement", async () => {
  const fx = await fixture(1);
  try {
    process.env.RBOX_REDEEM_DRAIN = "upload";
    process.env.RBOX_PIPELINE_REDEEM_THRESHOLD = "10";
    delete process.env.RBOX_METRICS;
    const remote = new DrainRemote();
    remote.redeemHook = async (entries) => {
      await Bun.sleep(10);
      return [{ granted: entries.length, alreadyEntitled: 0, rejected: 0, settled: entries.map(([sha]) => sha) }];
    };
    await run(fx, remote, PhaseReport.push());
    expect(firstPublishTiming.stats.finalFlushMs).toBeGreaterThan(0);
  } finally { await fs.rm(fx.root, { recursive: true, force: true }); }
});

test("serialized upload surfaces fenced receipt residue", async () => {
  const fx = await fixture(1);
  let fenced = "";
  try {
    process.env.RBOX_REDEEM_DRAIN = "upload";
    process.env.RBOX_PIPELINE_REDEEM_THRESHOLD = "1";
    const remote = new DrainRemote();
    remote.redeemHook = async (entries) => {
      fenced = entries[0]![0];
      return [{ granted: 0, alreadyEntitled: 0, rejected: 1, needsUpload: [fenced] }];
    };
    expect((await run(fx, remote)).needsUpload).toEqual(new Set([fenced]));
  } finally { await fs.rm(fx.root, { recursive: true, force: true }); }
});

test("serialized upload rejects a latched drain error", async () => {
  const fx = await fixture(2);
  const failure = new Error("receipt redemption failed");
  try {
    process.env.RBOX_REDEEM_DRAIN = "upload";
    process.env.RBOX_PIPELINE_REDEEM_THRESHOLD = "1";
    process.env.RBOX_UPLOAD_CONCURRENCY = "1";
    const remote = new DrainRemote();
    remote.redeemHook = async () => { throw failure; };
    await expect(run(fx, remote)).rejects.toBe(failure);
  } finally { await fs.rm(fx.root, { recursive: true, force: true }); }
});

test("serialized upload failure settles an in-flight drain before rejecting", async () => {
  const fx = await fixture(2);
  const failure = new Error("second PUT failed");
  let releaseDrain!: () => void;
  const drain = new Promise<void>((resolve) => { releaseDrain = resolve; });
  let drainSettled = false;
  let pending: ReturnType<typeof run> | undefined;
  try {
    process.env.RBOX_REDEEM_DRAIN = "upload";
    process.env.RBOX_PIPELINE_REDEEM_THRESHOLD = "1";
    process.env.RBOX_UPLOAD_CONCURRENCY = "1";
    const remote = new DrainRemote();
    remote.putHook = (call) => { if (call === 2) throw failure; };
    remote.redeemHook = async (entries) => {
      await drain;
      drainSettled = true;
      return [{ granted: entries.length, alreadyEntitled: 0, rejected: 0, settled: entries.map(([sha]) => sha) }];
    };
    pending = run(fx, remote);
    await waitFor(() => remote.puts === 2, "second PUT did not fail");
    expect(drainSettled).toBe(false);
    releaseDrain();
    const observed = await pending.catch((error) => ({ error, settled: drainSettled }));
    expect(observed).toEqual({ error: failure, settled: true });
  } finally {
    releaseDrain();
    await pending?.catch(() => {});
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test("serialized upload backpressure waits for a pre-existing drain", async () => {
  const fx = await fixture(1);
  let releaseDrain!: () => void;
  const drain = new Promise<void>((resolve) => { releaseDrain = resolve; });
  let pending: ReturnType<typeof run> | undefined;
  try {
    process.env.RBOX_REDEEM_DRAIN = "upload";
    process.env.RBOX_PIPELINE_REDEEM_THRESHOLD = "1";
    const remote = new DrainRemote();
    for (let i = 0; i < 3; i++) remote.receipts.set(`old-${i}`, `receipt-old-${i}`);
    remote.redeemHook = async (entries) => {
      await drain;
      return [{ granted: entries.length, alreadyEntitled: 0, rejected: 0, settled: entries.map(([sha]) => sha) }];
    };
    pending = run(fx, remote);
    await waitFor(() => remote.redeems === 1, "pre-existing drain did not start");
    expect(remote.puts).toBe(0);
    releaseDrain();
    await pending;
    expect(remote.puts).toBe(1);
  } finally {
    releaseDrain();
    await pending?.catch(() => {});
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test("fresh receipts after a killed client are redeemed on resume", async () => {
  const fx = await fixture(2);
  try {
    process.env.RBOX_REDEEM_DRAIN = "off"; // first run simulates a legacy/killed client
    process.env.RBOX_PIPELINE_REDEEM_THRESHOLD = "1";
    const remote = new DrainRemote();
    await run(fx, remote);
    expect(remote.puts).toBe(2);
    expect(remote.redeems).toBe(0);
    remote.receipts.clear(); // the killed client's in-memory receipts do not survive

    process.env.RBOX_REDEEM_DRAIN = "upload";
    await run(fx, remote);
    expect(remote.puts).toBe(4);
    expect(remote.redeems).toBeGreaterThan(0);
    expect(remote.receipts.size).toBe(0);
    expect(remote.granted.size).toBe(2);
    for (const count of remote.granted.values()) expect(count).toBe(1);
  } finally { await fs.rm(fx.root, { recursive: true, force: true }); }
});
