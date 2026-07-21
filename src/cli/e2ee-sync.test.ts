import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildKeyState,
  buildPairing,
  buildSignedCommit,
  parseCommit,
  redeemPairing,
  serializeRefset,
  signPrivateFromPkcs8,
  type DeviceSecrets,
  type SignedKeyState,
  type SignedRoster,
} from "../engine/e2ee/index.js";
import { canonicalManifestHashStreaming, decodeEnvelope, encodeDeltaEnvelope, ENCRYPT_ADDRESS_CACHE_REL, gitSectionBlobRefs, ManifestChainError, MAX_MANIFEST_DELTA_CHAIN, PhaseReport, restoreEntryToPath, type GitSection, type Manifest } from "../engine/index.js";
import { encryptManifest, openManifestChainBlob, parseCommit as parseSignedCommit } from "../engine/e2ee/index.js";
import { encryptFileNameProbe } from "../engine/e2ee/e2ee-e2e.helpers.js";
import { blobRefsForManifest, E2eeRemote, SIDECAR_THRESHOLD } from "./e2ee-remote.js";
import { bootstrapOnto, cfgFor as harnessCfg, FakeServer, remoteFor as harnessRemote } from "./e2ee-fake-server.js";
import { CommitRejectedError } from "./remote.js";
import { formatLatestTimings, pull, push, pushManifest } from "./sync.js";
import { repairChain } from "./chain-repair.js";
import { loadState, manifestFromMeta, saveStateUnsafeLegacyOrTest, syncStreamId, validManifestMeta, type WorkspaceConfig } from "./config.js";
import { saveStateSource } from "./sync-state.js";

const exec = promisify(execFile);
const git = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args]).then((r) => r.stdout.toString().trim());

const NOW = 1_900_000_000_000;
const ACCT = "acct_sync";
const WS = "ws_sync";

const remoteFor = (server: FakeServer, secrets: DeviceSecrets): E2eeRemote => harnessRemote(server, secrets, ACCT, WS, NOW + 5000);
const cfgFor = (root: string, secrets: DeviceSecrets, remote: E2eeRemote): Promise<WorkspaceConfig> => harnessCfg(root, secrets, remote, WS);
const hex = (n: number) => n.toString(16).padStart(64, "0");
const shaBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const largeManifest = (): Manifest => ({
  generatedAt: "",
  files: Array.from({ length: SIDECAR_THRESHOLD }, (_, i) => ({
    path: `f-${i}.txt`,
    type: "file",
    sha256: hex(i + 1),
    encSha: hex(100_000 + i),
    size: 1,
    mode: 0o644,
    mtimeMs: 1,
  })),
});
const sidecarShaOf = (manifest: Manifest): string => {
  const refs = manifest.files.map((f) => {
    if (f.type !== "file" || !f.encSha) throw new Error("test manifest must contain encrypted file refs");
    return { encSha: f.encSha, size: f.size };
  });
  return shaBytes(serializeRefset(refs));
};

test("latest timing formatter appends the non-sensitive fold token", () => {
  expect(formatLatestTimings({ downloadMs: 1, decryptMs: 2, parseMs: 3, encBytes: 4, fold: "evidence", foldLinks: 2 })).toEndWith("4B fold=evidence f2");
  expect(formatLatestTimings({ downloadMs: 1, decryptMs: 2, parseMs: 3, encBytes: 0, fold: "evidence", foldLinks: 0 })).toEndWith("0B fold=evidence f0");
  expect(formatLatestTimings({ downloadMs: 1, decryptMs: 2, parseMs: 3, encBytes: 4 })).toBe("d0.0 x0.0 p0.0 4B");
});

test("latest timing fold token distinguishes chain-free raw and snapshot heads", async () => {
  // "0" is the force-raw kill-switch; unset means snapshot since the v1.7.1
  // default flip. Both writer modes remain supported and distinguishable.
  for (const snapshot of ["0", "1", undefined] as const) {
    const server = new FakeServer();
    const secrets = await bootstrapOnto(server, ACCT, `devA-fold-token-${snapshot ?? "default"}`, NOW);
    const writer = await remoteFor(server, secrets);
    const reader = await remoteFor(server, secrets);
    await withManifestEncodingFlags(snapshot, undefined, () => writer.commit(0, secrets.deviceId, { generatedAt: "token", files: [] }));
    let fold: string | undefined;
    await reader.latest({ onLatestTimings: (timings) => { fold = timings.fold; } });
    expect(fold).toBe(snapshot === "0" ? "raw" : "snapshot");
  }
});

async function appendKeyState(server: FakeServer, secrets: DeviceSecrets, keyEpoch: number): Promise<void> {
  const prev = JSON.parse(server.account.keyStates.at(-1)!) as SignedKeyState;
  const roster = JSON.parse(server.account.rosters[0]!) as SignedRoster;
  const accountEpoch = server.account.keyStates.length;
  const next = await buildKeyState({
    accountId: ACCT,
    accountEpoch,
    prevStateHash: prev.stateHash,
    rosterVersion: 0,
    rosterHash: roster.rosterHash,
    keyEpoch,
    mkWrapHashes: [],
    recoveryWrapId: `rec_${accountEpoch}`,
    signerDeviceId: secrets.deviceId,
    signKey: { publicKey: secrets.sigPubKey, privateKey: signPrivateFromPkcs8(secrets.sigPrivPkcs8) },
  });
  server.account.keyStates.push(JSON.stringify(next));
}

test("blobRefsForManifest includes every git packChain link", () => {
  const section: GitSection = {
    bundleSha: "a".repeat(64),
    bundleEncSha: "b".repeat(64),
    bundleCipherSize: 10,
    packChain: [
      { sha: "c".repeat(64), encSha: "d".repeat(64), cipherSize: 20, tips: ["e".repeat(40)] },
      { sha: "f".repeat(64), encSha: "0".repeat(64), cipherSize: 30, tips: ["1".repeat(40)] },
    ],
    head: "ref: refs/heads/main",
    refs: { "refs/heads/main": "2".repeat(40) },
    indexSha: "3".repeat(64),
    indexEncSha: "4".repeat(64),
    indexCipherSize: 5,
    refScope: "all",
    generatedAt: "",
  };
  const refs = blobRefsForManifest({ generatedAt: "", files: [], manifestSchema: 3, gitRepos: { repo: section } })!;
  expect(refs.map((r) => r.encSha).sort()).toEqual(["0".repeat(64), "4".repeat(64), "b".repeat(64), "d".repeat(64)].sort());
});

test("currentKek returns the verified nonzero write context without defaulting epochs", async () => {
  const server = new FakeServer();
  const secrets = await bootstrapOnto(server, ACCT, "devA-epoch", NOW);
  const s0 = JSON.parse(server.account.keyStates[0]!) as SignedKeyState;
  const roster0 = JSON.parse(server.account.rosters[0]!) as SignedRoster;
  const s1 = await buildKeyState({
    accountId: ACCT,
    accountEpoch: 1,
    prevStateHash: s0.stateHash,
    rosterVersion: 0,
    rosterHash: roster0.rosterHash,
    keyEpoch: 7,
    mkWrapHashes: [],
    recoveryWrapId: "rec_1",
    signerDeviceId: secrets.deviceId,
    signKey: { publicKey: secrets.sigPubKey, privateKey: signPrivateFromPkcs8(secrets.sigPrivPkcs8) },
  });
  server.account.keyStates.push(JSON.stringify(s1));

  const remote = await remoteFor(server, secrets);
  const writeContext = await remote.currentKek();

  expect(writeContext.accountId).toBe(ACCT);
  expect(writeContext.accountEpoch).toBe(1);
  expect(writeContext.keyEpoch).toBe(7);
  expect(server.wsKeys.has(`${WS}:7`)).toBe(true);
  expect(server.wsKeys.has(`${WS}:0`)).toBe(false);
});

test("push refreshes write context and encrypt cache after an epoch_stale commit retry", async () => {
  const server = new FakeServer();
  const secrets = await bootstrapOnto(server, ACCT, "devA-epoch-stale", NOW);
  const root = await tmp();
  const remote = await remoteFor(server, secrets);
  const cfg = await cfgFor(root, secrets, remote);
  const bytes = new TextEncoder().encode("rotating write\n");
  await fs.writeFile(path.join(root, "rotate.txt"), bytes);

  const stale = await encryptFileNameProbe(new Uint8Array(cfg.kek!), bytes);
  const cacheFile = path.join(root, ENCRYPT_ADDRESS_CACHE_REL);
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(
    cacheFile,
    JSON.stringify({
      version: 1,
      accountId: cfg.accountId,
      workspaceId: cfg.remoteWorkspaceId,
      accountEpoch: cfg.accountEpoch,
      keyEpoch: cfg.keyEpoch,
      entries: {
        [stale.plaintextSha]: { encSha: stale.encSha, cipherSize: stale.ciphertext.length, paths: ["rotate.txt"] },
      },
    })
  );

  let rotated = false;
  server.beforeCommitSigned = async () => {
    if (rotated) return;
    rotated = true;
    await appendKeyState(server, secrets, 7);
  };

  const res = await push(root, cfg, { remote });

  expect(res.sequence).toBe(1);
  expect(cfg.accountEpoch).toBe(1);
  expect(cfg.keyEpoch).toBe(7);
  const body = parseCommit(server.commits[0]!);
  expect(body.accountEpoch).toBe(1);
  expect(body.keyEpoch).toBe(7);
  const raw = JSON.parse(await fs.readFile(cacheFile, "utf8"));
  expect(raw.accountEpoch).toBe(1);
  expect(raw.keyEpoch).toBe(7);
  expect(raw.entries[stale.plaintextSha].encSha).not.toBe(stale.encSha);
});

const seedManifestRefs = (server: FakeServer, manifest: Manifest): void => {
  for (const f of manifest.files) {
    if (f.type === "file" && f.encSha) server.store.blobs.set(f.encSha, new Uint8Array([1]));
  }
};

class ObservedServer extends FakeServer {
  putBlobBytesCalls: string[] = [];
  commitSignedCalls = 0;

  constructor() {
    super();
    const basePutBlobBytes = this.putBlobBytes;
    const baseCommitSigned = this.commitSigned;
    this.putBlobBytes = async (sha, bytes) => {
      this.putBlobBytesCalls.push(sha);
      return basePutBlobBytes(sha, bytes);
    };
    this.commitSigned = async (parentSeq, commit) => {
      this.commitSignedCalls++;
      return baseCommitSigned(parentSeq, commit);
    };
  }
}

let dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-e2ee-sync-"));
  dirs.push(d);
  return d;
}
afterAll(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

const repairFixtureManifest = (label: string, count = 300): Manifest => ({
  generatedAt: label,
  files: Array.from({ length: count }, (_, i) => ({
    path: `repair-matrix/${i.toString().padStart(4, "0")}`,
    type: "symlink" as const,
    symlinkTarget: `../target-${i}`,
    sha256: hex(i + 1),
    size: 8,
    mode: 0o777,
    mtimeMs: i,
  })),
});

async function expectBrokenPull(root: string, cfg: WorkspaceConfig, remote: E2eeRemote): Promise<ManifestChainError> {
  try {
    await pull(root, cfg, { remote });
  } catch (error) {
    expect(error).toBeInstanceOf(ManifestChainError);
    return error as ManifestChainError;
  }
  throw new Error("expected broken manifest chain");
}

async function withManifestEncodingFlags<T>(snapshot: string | undefined, delta: string | undefined, fn: () => Promise<T>): Promise<T> {
  const oldSnapshot = process.env.RBOX_MDE_SNAPSHOT;
  const oldDelta = process.env.RBOX_MDE_DELTA;
  if (snapshot === undefined) delete process.env.RBOX_MDE_SNAPSHOT; else process.env.RBOX_MDE_SNAPSHOT = snapshot;
  if (delta === undefined) delete process.env.RBOX_MDE_DELTA; else process.env.RBOX_MDE_DELTA = delta;
  try { return await fn(); } finally {
    if (oldSnapshot === undefined) delete process.env.RBOX_MDE_SNAPSHOT; else process.env.RBOX_MDE_SNAPSHOT = oldSnapshot;
    if (oldDelta === undefined) delete process.env.RBOX_MDE_DELTA; else process.env.RBOX_MDE_DELTA = oldDelta;
  }
}

async function withFastPullFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const old = process.env.RBOX_MDE_FAST_PULL;
  if (value === undefined) delete process.env.RBOX_MDE_FAST_PULL; else process.env.RBOX_MDE_FAST_PULL = value;
  try { return await fn(); } finally {
    if (old === undefined) delete process.env.RBOX_MDE_FAST_PULL; else process.env.RBOX_MDE_FAST_PULL = old;
  }
}

async function wireKind(server: FakeServer, remote: E2eeRemote, index = server.commits.length - 1): Promise<string> {
  const body = parseSignedCommit(server.commits[index]!);
  const plaintext = await openManifestChainBlob({
    bytes: server.store.blobs.get(body.encManifestSha)!, expectedEncSha: body.encManifestSha,
    workspaceId: WS, accountId: ACCT, keyEpoch: body.keyEpoch, kek: new Uint8Array((await remote.currentKek()).kek),
  });
  return (await decodeEnvelope(plaintext)).kind;
}

const deltaSizedManifest = (label: string): Manifest => ({
  generatedAt: label,
  files: Array.from({ length: 300 }, (_, i) => ({
    path: `partition/${i.toString().padStart(4, "0")}`,
    type: "symlink" as const,
    symlinkTarget: `../target/${hex(i + 1)}`,
    sha256: hex(i + 10_000),
    size: 70,
    mode: 0o777,
    mtimeMs: i,
  })),
});

async function partitionPushFixture(deviceId: string) {
  const server = new FakeServer();
  const secrets = await bootstrapOnto(server, ACCT, deviceId, NOW);
  const remote = await remoteFor(server, secrets);
  const root = await tmp();
  const cfg = await cfgFor(root, secrets, remote);
  const base = deltaSizedManifest("base");
  const first = await remote.commit(0, secrets.deviceId, base);
  await pull(root, cfg, { remote });
  const target: Manifest = { ...base, generatedAt: "target", files: base.files.map((f, i) => i === 299 ? { ...f, mode: 0o755 } : f) };
  return { server, secrets, remote, root, cfg, first, target };
}

test("422 partition snapshots when the missing page names an attempted chain link", async () => {
  await withManifestEncodingFlags(undefined, "1", async () => {
    const { server, remote, root, cfg, first, target } = await partitionPushFixture("devA-422-chain");
    const attempted: string[] = [];
    const baseCommit = server.commitSigned;
    let bounced = false;
    server.commitSigned = async (parent, commit) => {
      attempted.push(commit);
      if (!bounced) { bounced = true; return { unsatisfiedBlobs: [first.manifestMeta!.encManifestSha], unsatisfiedTotal: 1 }; }
      return baseCommit(parent, commit);
    };
    await pushManifest(root, cfg, target, { remote });
    expect(attempted).toHaveLength(2);
    expect(parseSignedCommit(attempted[0]!).manifestChain).toContain(first.manifestMeta!.encManifestSha);
    expect(await wireKind(server, remote)).toBe("snapshot");
  });
});

test("422 partition keeps a data-only retry eligible for delta encoding", async () => {
  await withManifestEncodingFlags(undefined, "1", async () => {
    const { server, remote, root, cfg, first, target } = await partitionPushFixture("devA-422-data");
    const dataRef = hex(800_001);
    server.store.blobs.set(dataRef, new Uint8Array([1]));
    const attempted: string[] = [];
    const baseCommit = server.commitSigned;
    let bounced = false;
    server.commitSigned = async (parent, commit) => {
      attempted.push(commit);
      if (!bounced) { bounced = true; return { unsatisfiedBlobs: [dataRef], unsatisfiedTotal: 1 }; }
      return baseCommit(parent, commit);
    };
    await pushManifest(root, cfg, target, { remote });
    expect(attempted).toHaveLength(2);
    expect(parseSignedCommit(attempted[1]!).manifestChain).toEqual([first.manifestMeta!.encManifestSha]);
    expect(await wireKind(server, remote)).toBe("delta");
  });
});

test("422 partition snapshots on a truncated page when a chain was attempted", async () => {
  await withManifestEncodingFlags(undefined, "1", async () => {
    const { server, remote, root, cfg, target } = await partitionPushFixture("devA-422-truncated");
    const baseCommit = server.commitSigned;
    let bounced = false;
    server.commitSigned = async (parent, commit) => {
      if (!bounced) { bounced = true; return { unsatisfiedBlobs: [hex(800_002)], unsatisfiedTotal: 2 }; }
      return baseCommit(parent, commit);
    };
    await pushManifest(root, cfg, target, { remote });
    expect(await wireKind(server, remote)).toBe("snapshot");
  });
});

test("a chain link encrypted under another epoch fails closed with its sha named", async () => {
  await withManifestEncodingFlags(undefined, "1", async () => {
    const server = new FakeServer();
    const secrets = await bootstrapOnto(server, ACCT, "devA-cross-epoch-link", NOW);
    const writer = await remoteFor(server, secrets);
    const base = deltaSizedManifest("base");
    const first = await writer.commit(0, secrets.deviceId, base);
    const target: Manifest = { ...base, generatedAt: "target", files: base.files.map((f, i) => i === 1 ? { ...f, mode: 0o755 } : f) };
    await writer.commit(1, secrets.deviceId, target, { deltaBase: { manifest: base, meta: first.manifestMeta! } });
    const linkSha = first.manifestMeta!.encManifestSha;
    const wrongEpoch = await encryptManifest(new Uint8Array((await writer.currentKek()).kek), ACCT, WS, first.manifestMeta!.keyEpoch + 1, new TextEncoder().encode("wrong epoch"));
    server.store.blobs.set(linkSha, wrongEpoch.ciphertext);
    const peer = await remoteFor(server, secrets);
    try {
      await peer.latest();
      throw new Error("expected cross-epoch chain failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestChainError);
      expect((error as ManifestChainError).failingLink).toBe(linkSha);
    }
  });
});

test("R6 writer carrying a pending repo preserves evidence and emits consecutive deltas", async () => {
  const priorSupersession = process.env.RBOX_GIT_PENDING_SUPERSEDE;
  process.env.RBOX_GIT_PENDING_SUPERSEDE = "0";
  try {
    await withManifestEncodingFlags(undefined, "1", async () => {
    const server = new FakeServer();
    const secrets = await bootstrapOnto(server, ACCT, "devA-pending-snapshot", NOW);
    const root = await tmp();
    for (let i = 0; i < 300; i++) await fs.symlink(`../target/${hex(i + 1)}`, path.join(root, `link-${i.toString().padStart(4, "0")}`));
    const repo = path.join(root, "repo");
    await fs.mkdir(repo);
    await git(repo, "init", "-qb", "main");
    await fs.writeFile(path.join(repo, "tracked.txt"), "base\n");
    await git(repo, "add", "tracked.txt");
    await git(repo, "-c", "user.name=Pending Test", "-c", "user.email=pending@example.invalid", "commit", "-qm", "base");
    const remote = await remoteFor(server, secrets);
    const cfg: WorkspaceConfig = { ...(await cfgFor(root, secrets, remote)), syncGit: true };
    await push(root, cfg, { remote });
    const state = await loadState(root, syncStreamId(cfg));
    const section = state.lastSyncedManifest.gitRepos!.repo!;
    state.gitPendingRemote = { repo: section };
    state.repoRecords = { ...(state.repoRecords ?? {}), repo: { ...(state.repoRecords?.repo ?? { repoGen: 0, sourceSeq: 1 }), pending: section } };
    await saveStateUnsafeLegacyOrTest(root, state);

    await fs.unlink(path.join(root, "link-0299"));
    await fs.symlink(`../changed/${hex(299)}`, path.join(root, "link-0299"));
    await push(root, cfg, { remote });
    expect(await wireKind(server, remote)).toBe("delta");
    expect(parseSignedCommit(server.commits.at(-1)!).manifestChain.length).toBeGreaterThan(0);
    const peer = await remoteFor(server, secrets);
    const peerFold = await peer.latest();
    expect(peerFold.manifest.files.find((f) => f.path === "link-0299")?.symlinkTarget).toBe(`../changed/${hex(299)}`);
    expect(peerFold.manifest.gitRepos).toEqual({ repo: section });
    expect((await loadState(root, syncStreamId(cfg))).manifestMeta?.gitRepos.repo).toEqual(section);

    await fs.unlink(path.join(root, "link-0298"));
    await fs.symlink(`../changed/${hex(298)}`, path.join(root, "link-0298"));
    await push(root, cfg, { remote });
    expect(await wireKind(server, remote)).toBe("delta");
    expect(parseSignedCommit(server.commits.at(-1)!).manifestChain.length).toBeGreaterThan(0);
    expect((await peer.latest()).manifest.gitRepos).toEqual({ repo: section });
    });
  } finally {
    if (priorSupersession === undefined) delete process.env.RBOX_GIT_PENDING_SUPERSEDE;
    else process.env.RBOX_GIT_PENDING_SUPERSEDE = priorSupersession;
  }
});

test("context-invalid reconstructed writer evidence fails to a snapshot without throwing", async () => {
  await withManifestEncodingFlags("1", "1", async () => {
    const { server, remote, root, cfg } = await partitionPushFixture("devA-invalid-reconstruction");
    const state = await loadState(root, syncStreamId(cfg));
    const collidingPath = state.lastSyncedManifest.files[0]!.path;
    const section: GitSection = {
      bundleSha: hex(920_001), bundleEncSha: hex(920_002), bundleCipherSize: 1,
      head: "ref: refs/heads/main", refs: { "refs/heads/main": "2".repeat(40) }, refScope: "all", generatedAt: "invalid-context",
    };
    state.manifestMeta = { ...state.manifestMeta!, gitRepos: { [collidingPath]: section } };
    expect(validManifestMeta(state.manifestMeta)).toBeDefined();
    await saveStateUnsafeLegacyOrTest(root, state);
    const changed = path.join(root, "partition", "0299");
    await fs.unlink(changed);
    await fs.symlink("../context-invalid-change", changed);
    await expect(push(root, cfg, { remote })).resolves.toMatchObject({ committed: true });
    expect(await wireKind(server, remote)).toBe("snapshot");
    expect(parseSignedCommit(server.commits.at(-1)!).manifestChain).toEqual([]);
  });
});

test("wire snapshot triggers: absent meta, epoch mismatch, chain cap, and byte bound", async () => {
  await withManifestEncodingFlags("1", "1", async () => {
    const server = new FakeServer();
    const secrets = await bootstrapOnto(server, ACCT, "devA-snapshot-triggers", NOW);
    const remote = await remoteFor(server, secrets);
    const base: Manifest = { generatedAt: "base", files: [] };
    const first = await remote.commit(0, secrets.deviceId, base);
    expect(await wireKind(server, remote)).toBe("snapshot");
    const changed: Manifest = { generatedAt: "changed", files: [] };
    const meta = first.manifestMeta!;
    await remote.commit(1, secrets.deviceId, changed, { deltaBase: { manifest: base, meta: { ...meta, keyEpoch: meta.keyEpoch + 1 } } });
    expect(await wireKind(server, remote)).toBe("snapshot");
    await remote.commit(2, secrets.deviceId, { ...changed, generatedAt: "cap" }, {
      deltaBase: { manifest: changed, meta: { ...meta, chain: Array(MAX_MANIFEST_DELTA_CHAIN).fill(meta.encManifestSha) } },
    });
    expect(await wireKind(server, remote)).toBe("snapshot");
    await remote.commit(3, secrets.deviceId, { ...changed, generatedAt: "bytes" }, {
      deltaBase: { manifest: changed, meta: { ...meta, chainBytes: meta.snapshotBytes, snapshotBytes: meta.snapshotBytes } },
    });
    expect(await wireKind(server, remote)).toBe("snapshot");
  });
});

test("chainDiagnostic skips the manifest blob for a chain-free head", async () => {
  const server = new FakeServer();
  const secrets = await bootstrapOnto(server, ACCT, "devA-doctor-cheap", NOW);
  const remote = await remoteFor(server, secrets);
  await remote.commit(0, secrets.deviceId, { generatedAt: "head", files: [] });
  const body = parseSignedCommit(server.commits[0]!);
  server.store.blobs.delete(body.encManifestSha);
  await expect(remote.chainDiagnostic()).resolves.toEqual({ sequence: 1, links: 0, chainBytes: 0, snapshotBytes: 0, snapshotFetched: false });
});

test("broken delta head repairs with an unconditional snapshot and a cold peer converges", async () => {
  await withManifestEncodingFlags("1", "1", async () => {
    const server = new FakeServer();
    const secrets = await bootstrapOnto(server, ACCT, "devA-repair", NOW);
    const writer = await remoteFor(server, secrets);
    const repairRemote = await remoteFor(server, secrets);
    const coldRemote = await remoteFor(server, secrets);
    const root = await tmp();
    const cfg = await cfgFor(root, secrets, repairRemote);
    const base: Manifest = {
      generatedAt: "base",
      files: Array.from({ length: 300 }, (_, i) => ({
        path: `repair/${i}-${hex(i + 1)}`, type: "symlink" as const, symlinkTarget: `../${hex(i + 2)}`,
        sha256: hex(i + 3), size: 64, mode: 0o777, mtimeMs: i,
      })),
    };
    const first = await writer.commit(0, secrets.deviceId, base);
    await pull(root, cfg, { remote: repairRemote });
    const brokenManifest: Manifest = { ...base, generatedAt: "broken-head", files: base.files.map((f, i) => i === 299 ? { ...f, mode: 0o755 } : f) };
    await writer.commit(1, secrets.deviceId, brokenManifest, { deltaBase: { manifest: base, meta: first.manifestMeta! } });
    const brokenBody = parseSignedCommit(server.commits[1]!);
    server.store.blobs.delete(brokenBody.encManifestSha);
    let failure: ManifestChainError | undefined;
    try { await pull(root, cfg, { remote: repairRemote }); } catch (error) {
      expect(error).toBeInstanceOf(ManifestChainError);
      failure = error as ManifestChainError;
    }
    if (!failure) throw new Error("expected broken chain");
    const outcome = await repairChain(root, cfg, { remote: repairRemote, allowMassDeletePush: true }, failure, { confirmSupersede: async () => true });
    expect(outcome.kind).toBe("repaired");
    expect(outcome.kind === "repaired" && outcome.sequence).toBe(3);
    expect(parseSignedCommit(server.commits[2]!).manifestChain ?? []).toEqual([]);
    expect(await wireKind(server, repairRemote, 2)).toBe("snapshot");
    const converged = await coldRemote.latest();
    expect(converged.sequence).toBe(3);
    expect(converged.manifest.files).toHaveLength(base.files.length);
  });
});

test("repairChain applies the newest foldable ancestor before publishing at broken head plus one", async () => {
  await withManifestEncodingFlags("1", "1", async () => {
    const server = new FakeServer();
    const secrets = await bootstrapOnto(server, ACCT, "devA-best-ancestor", NOW);
    const writer = await remoteFor(server, secrets);
    const repairRemote = await remoteFor(server, secrets);
    const root = await tmp();
    const cfg = await cfgFor(root, secrets, repairRemote);
    const base = repairFixtureManifest("base");
    const first = await writer.commit(0, secrets.deviceId, base);
    await pull(root, cfg, { remote: repairRemote });
    const ancestor: Manifest = { ...base, generatedAt: "ancestor", files: base.files.map((f, i) => i === 10 ? { ...f, mode: 0o755 } : f) };
    const second = await writer.commit(1, secrets.deviceId, ancestor, { deltaBase: { manifest: base, meta: first.manifestMeta! } });
    const broken: Manifest = { ...ancestor, generatedAt: "broken", files: ancestor.files.map((f, i) => i === 20 ? { ...f, mode: 0o700 } : f) };
    await writer.commit(2, secrets.deviceId, broken, { deltaBase: { manifest: ancestor, meta: second.manifestMeta! } });
    const brokenBody = parseSignedCommit(server.commits[2]!);
    server.store.blobs.delete(brokenBody.encManifestSha);
    const failure = await expectBrokenPull(root, cfg, repairRemote);

    let stateAtRepairCommit: number | undefined;
    server.beforeCommitSigned = async () => {
      stateAtRepairCommit = (await loadState(root, syncStreamId(cfg))).lastSyncedSequence;
    };
    const outcome = await repairChain(root, cfg, { remote: repairRemote, allowMassDeletePush: true }, failure, { confirmSupersede: async () => true });

    expect(stateAtRepairCommit).toBe(2);
    expect(outcome.kind).toBe("repaired");
    expect(outcome.kind === "repaired" && outcome.sequence).toBe(4);
    expect((await loadState(root, syncStreamId(cfg))).lastSyncedSequence).toBe(4);
    expect(await wireKind(server, repairRemote, 3)).toBe("snapshot");
  });
});

test("repairChain converges on a readable racing head and re-confirms an unreadable racing suffix", async () => {
  await withManifestEncodingFlags("1", "1", async () => {
    for (const raceKind of ["readable", "unreadable"] as const) {
      const server = new FakeServer();
      const secrets = await bootstrapOnto(server, ACCT, `devA-race-${raceKind}`, NOW);
      const writer = await remoteFor(server, secrets);
      const repairRemote = await remoteFor(server, secrets);
      const root = await tmp();
      const cfg = await cfgFor(root, secrets, repairRemote);
      const base = repairFixtureManifest(`base-${raceKind}`);
      const first = await writer.commit(0, secrets.deviceId, base);
      await pull(root, cfg, { remote: repairRemote });
      await writer.commit(1, secrets.deviceId, { ...base, generatedAt: `broken-${raceKind}` }, { deltaBase: { manifest: base, meta: first.manifestMeta! } });
      server.store.blobs.delete(parseSignedCommit(server.commits[1]!).encManifestSha);
      const failure = await expectBrokenPull(root, cfg, repairRemote);
      let injected = false;
      server.beforeCommitSigned = async () => {
        if (injected) return;
        injected = true;
        server.beforeCommitSigned = undefined;
        await writer.commit(
          2,
          secrets.deviceId,
          { ...base, generatedAt: `racer-${raceKind}` },
          raceKind === "unreadable" ? { deltaBase: { manifest: base, meta: first.manifestMeta! } } : undefined
        );
        if (raceKind === "unreadable") {
          server.store.blobs.delete(parseSignedCommit(server.commits[2]!).encManifestSha);
        }
      };
      const confirmations: Array<Array<{ seq: number; deviceId: string }>> = [];
      const outcome = await repairChain(root, cfg, { remote: repairRemote, allowMassDeletePush: true }, failure, {
        confirmSupersede: async (suffix) => {
          confirmations.push(suffix.map(({ seq, deviceId }) => ({ seq, deviceId })));
          return true;
        },
      });

      if (raceKind === "readable") {
        expect(outcome.kind).toBe("converged");
        expect(outcome.kind === "converged" && outcome.sequence).toBe(3);
        expect(server.commits).toHaveLength(3);
        expect(confirmations).toHaveLength(1);
      } else {
        expect(outcome.kind).toBe("repaired");
        expect(outcome.kind === "repaired" && outcome.sequence).toBe(4);
        expect(server.commits).toHaveLength(4);
        expect(confirmations).toHaveLength(2);
        expect(confirmations[1]!.map((entry) => entry.seq)).toEqual([2, 3]);
        expect(await wireKind(server, repairRemote, 3)).toBe("snapshot");
      }
    }
  });
});

test("repair mode preserves the mass-delete guard and proceeds only with push consent", async () => {
  const priorPct = process.env.RBOX_MASS_DELETE_PCT;
  const priorMin = process.env.RBOX_MASS_DELETE_MIN;
  process.env.RBOX_MASS_DELETE_PCT = "50";
  process.env.RBOX_MASS_DELETE_MIN = "100";
  try { await withManifestEncodingFlags("1", "1", async () => {
    const server = new FakeServer();
    const secrets = await bootstrapOnto(server, ACCT, "devA-repair-mass-delete", NOW);
    const writer = await remoteFor(server, secrets);
    const repairRemote = await remoteFor(server, secrets);
    const root = await tmp();
    const cfg = await cfgFor(root, secrets, repairRemote);
    const base = repairFixtureManifest("mass-base", 200);
    const first = await writer.commit(0, secrets.deviceId, base);
    await pull(root, cfg, { remote: repairRemote });
    await writer.commit(1, secrets.deviceId, { ...base, generatedAt: "mass-broken" }, { deltaBase: { manifest: base, meta: first.manifestMeta! } });
    server.store.blobs.delete(parseSignedCommit(server.commits[1]!).encManifestSha);
    const failure = await expectBrokenPull(root, cfg, repairRemote);
    for (let i = 0; i < 120; i++) await fs.unlink(path.join(root, base.files[i]!.path));

    await expect(repairChain(root, cfg, { remote: repairRemote }, failure, { confirmSupersede: async () => true }))
      .rejects.toThrow(/push would delete 120 of 200 tracked files.*mass-delete guard/);
    expect(server.commits).toHaveLength(2);

    const outcome = await repairChain(root, cfg, { remote: repairRemote, allowMassDeletePush: true }, failure, { confirmSupersede: async () => true });
    expect(outcome.kind).toBe("repaired");
    expect(outcome.kind === "repaired" && outcome.sequence).toBe(3);
    expect(server.commits).toHaveLength(3);
    expect((await repairRemote.latest()).manifest.files).toHaveLength(80);
  }); } finally {
    if (priorPct === undefined) delete process.env.RBOX_MASS_DELETE_PCT; else process.env.RBOX_MASS_DELETE_PCT = priorPct;
    if (priorMin === undefined) delete process.env.RBOX_MASS_DELETE_MIN; else process.env.RBOX_MASS_DELETE_MIN = priorMin;
  }
});

test("C2 commit emits a chained delta and a cold peer folds it with propagated meta", async () => {
  await withManifestEncodingFlags(undefined, "1", async () => {
    const server = new FakeServer();
    const secrets = await bootstrapOnto(server, ACCT, "devA-mde-delta", NOW);
    const writer = await remoteFor(server, secrets);
    const peer = await remoteFor(server, secrets);
    const base: Manifest = {
      generatedAt: "base",
      files: Array.from({ length: 300 }, (_, i) => ({
        path: `links/${i.toString(16).padStart(4, "0")}-${hex(i * 7919 + 17)}`,
        type: "symlink" as const,
        symlinkTarget: `../targets/${hex(i * 104729 + 3)}`,
        sha256: hex(i * 65537 + 11), size: 70, mode: 0o777, mtimeMs: i,
      })),
    };
    const first = await writer.commit(0, secrets.deviceId, base);
    expect(first.manifestMeta).toBeDefined();
    const target: Manifest = { ...base, generatedAt: "next", files: base.files.map((f, i) => i === 299 ? { ...f, mode: 0o755 } : f) };
    const second = await writer.commit(1, secrets.deviceId, target, { deltaBase: { manifest: base, meta: first.manifestMeta! } });
    const body = parseSignedCommit(server.commits[1]!);
    expect(body.manifestChain).toEqual([first.manifestMeta!.encManifestSha]);
    expect(second.manifestMeta?.chain).toEqual(body.manifestChain);
    expect(second.manifestMeta?.chainBytes).toBeGreaterThan(0);
    expect(second.manifestMeta?.snapshotBytes).toBe(first.manifestMeta?.snapshotBytes);
    const plaintext = await openManifestChainBlob({
      bytes: server.store.blobs.get(body.encManifestSha)!,
      expectedEncSha: body.encManifestSha,
      workspaceId: WS,
      accountId: ACCT,
      keyEpoch: body.keyEpoch,
      kek: new Uint8Array((await writer.currentKek()).kek),
    });
    expect((await decodeEnvelope(plaintext)).kind).toBe("delta");
    const pulled = await peer.latest();
    expect(pulled.manifest).toEqual(target);
    expect(pulled.manifestMeta).toEqual(second.manifestMeta);
  });
});

test("mixed fleet reads snapshot/delta history with the raw kill-switch, restores it, then writes raw-v0 without manifest meta", async () => {
  const server = new FakeServer();
  const secrets = await bootstrapOnto(server, ACCT, "devA-mixed-fleet", NOW);
  const writer = await remoteFor(server, secrets);
  const base = deltaSizedManifest("mixed-snapshot");
  const target: Manifest = {
    ...base,
    generatedAt: "mixed-delta",
    files: base.files.map((entry, index) => index === 42
      ? { ...entry, symlinkTarget: "../target/mixed-fleet-v2", sha256: hex(999_042) }
      : entry),
  };

  await withManifestEncodingFlags("1", "1", async () => {
    const snapshot = await writer.commit(0, secrets.deviceId, base);
    expect(await wireKind(server, writer, 0)).toBe("snapshot");
    const delta = await writer.commit(1, secrets.deviceId, target, { deltaBase: { manifest: base, meta: snapshot.manifestMeta! } });
    expect(delta.manifestMeta?.chain).toEqual([snapshot.manifestMeta!.encManifestSha]);
    expect(await wireKind(server, writer, 1)).toBe("delta");
  });

  // RBOX_MDE_SNAPSHOT=0 is the legacy raw-v0 writer since the v1.7.1
  // default flip; reading snapshot/delta history is unconditional.
  await withManifestEncodingFlags("0", undefined, async () => {
    const peer = await remoteFor(server, secrets);
    const latest = await peer.latest();
    expect(latest).toEqual({ sequence: 2, manifest: target });

    expect((await peer.manifestAtSeq(1)).manifest).toEqual(base);
    expect((await peer.manifestAtSeq(2)).manifest).toEqual(target);
    expect((await peer.history(10)).map((version) => version.seq)).toEqual([2, 1]);
    const changes = await peer.pathHistory(base.files[42]!.path, 10);
    expect(changes.map((change) => change.seq)).toEqual([2, 1]);

    const restoreRoot = await tmp();
    const historical = await peer.manifestAtSeq(1);
    await restoreEntryToPath(restoreRoot, historical.manifest.files[42]!, peer.blobStore(), Buffer.from(historical.kek));
    expect(await fs.readlink(path.join(restoreRoot, historical.manifest.files[42]!.path))).toBe(base.files[42]!.symlinkTarget);

    const root = await tmp();
    const cfg = await cfgFor(root, secrets, peer);
    await pull(root, cfg, { remote: peer });
    expect((await loadState(root, syncStreamId(cfg))).manifestMeta).toBeUndefined();
    await fs.symlink("../target/raw-v0", path.join(root, "mixed-legacy-write"));
    expect((await push(root, cfg, { remote: peer })).sequence).toBe(3);

    const rawBody = parseSignedCommit(server.commits[2]!);
    expect(rawBody.manifestChain).toEqual([]);
    const rawPlaintext = await openManifestChainBlob({
      bytes: server.store.blobs.get(rawBody.encManifestSha)!, expectedEncSha: rawBody.encManifestSha,
      workspaceId: WS, accountId: ACCT, keyEpoch: rawBody.keyEpoch, kek: new Uint8Array((await peer.currentKek()).kek),
    });
    const rawLatest = await peer.latest();
    expect(new TextDecoder().decode(rawPlaintext)).toBe(JSON.stringify(rawLatest.manifest));
    expect(rawLatest.manifestMeta).toBeUndefined();
    expect((await loadState(root, syncStreamId(cfg))).manifestMeta).toBeUndefined();
  });
});

test("D fast pull folds one delta from persisted evidence with a head-only fetch", async () => {
  await withManifestEncodingFlags(undefined, "1", async () => {
    const server = new FakeServer();
    const secrets = await bootstrapOnto(server, ACCT, "devA-fast-pull", NOW);
    const writer = await remoteFor(server, secrets);
    const peer = await remoteFor(server, secrets);
    const base: Manifest = { generatedAt: "base", files: Array.from({ length: 300 }, (_, i) => ({
      path: `fast/${i.toString().padStart(4, "0")}`, type: "symlink" as const, symlinkTarget: `../${i}`, sha256: hex(i + 1), size: 8, mode: 0o777, mtimeMs: i,
    })) };
    const first = await writer.commit(0, secrets.deviceId, base);
    const target: Manifest = { ...base, generatedAt: "target", files: base.files.map((f, i) => i === 42 ? { ...f, mode: 0o755 } : f) };
    const second = await writer.commit(1, secrets.deviceId, target, { deltaBase: { manifest: base, meta: first.manifestMeta! } });
    server.store.getCalls = [];

    let fold: string | undefined;
    const pulled = await peer.latest({ fastFoldBase: { manifest: base, meta: first.manifestMeta! }, onLatestTimings: (timings) => { fold = timings.fold; } });

    expect(pulled.manifest).toEqual(target);
    expect(fold).toBe("evidence");
    expect(server.store.getCalls).toEqual([second.manifestMeta!.encManifestSha]);
    expect(pulled.manifestMeta?.snapshotBytes).toBe(first.manifestMeta!.snapshotBytes);
    expect(pulled.manifestMeta?.chainBytes).toBe(first.manifestMeta!.chainBytes + server.store.blobs.get(second.manifestMeta!.encManifestSha)!.byteLength);
    expect(pulled.manifestMeta?.chain).toEqual([...first.manifestMeta!.chain, first.manifestMeta!.encManifestSha]);
  });
});

test("D fast pull evidence mismatches fall back to the exact cold chain walk", async () => {
  await withManifestEncodingFlags(undefined, "1", async () => {
    const server = new FakeServer();
    const secrets = await bootstrapOnto(server, ACCT, "devA-fast-fallback", NOW);
    const writer = await remoteFor(server, secrets);
    const base: Manifest = { generatedAt: "base", files: Array.from({ length: 300 }, (_, i) => ({
      path: `fallback/${i.toString().padStart(4, "0")}`, type: "symlink" as const, symlinkTarget: `${i}`, sha256: hex(i + 1), size: 4, mode: 0o777, mtimeMs: i,
    })) };
    const first = await writer.commit(0, secrets.deviceId, base);
    const middle: Manifest = { ...base, generatedAt: "middle", files: base.files.map((f, i) => i === 1 ? { ...f, mode: 0o755 } : f) };
    const second = await writer.commit(1, secrets.deviceId, middle, { deltaBase: { manifest: base, meta: first.manifestMeta! } });
    const target: Manifest = { ...middle, generatedAt: "target", files: middle.files.map((f, i) => i === 2 ? { ...f, mode: 0o700 } : f) };
    const third = await writer.commit(2, secrets.deviceId, target, { deltaBase: { manifest: middle, meta: second.manifestMeta! } });
    const cases = [
      { ...second.manifestMeta!, encManifestSha: hex(900_001) },
      { ...second.manifestMeta!, manifestHash: hex(900_002) },
      { ...second.manifestMeta!, chain: [hex(900_003)] },
    ];
    const originalGet = server.store.get.bind(server.store);
    let inFlightGets = 0;
    let peakInFlightGets = 0;
    server.store.get = async (sha: string) => {
      inFlightGets++;
      peakInFlightGets = Math.max(peakInFlightGets, inFlightGets);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await originalGet(sha);
      } finally {
        inFlightGets--;
      }
    };
    for (const meta of cases) {
      const peer = await remoteFor(server, secrets);
      server.store.getCalls = [];
      peakInFlightGets = 0;
      let fold: string | undefined;
      await expect(peer.latest({ fastFoldBase: { manifest: middle, meta }, onLatestTimings: (timings) => { fold = timings.fold; } })).resolves.toMatchObject({ manifest: target });
      expect(fold).toBe("coldwalk");
      expect(server.store.getCalls).toEqual([third.manifestMeta!.encManifestSha, ...third.manifestMeta!.chain]);
      expect(peakInFlightGets).toBe(third.manifestMeta!.chain.length);
    }
  });
});

test("cold chain walk fails closed on hostile signed lists, links, and delta hashes without applying", async () => {
  await withManifestEncodingFlags("1", "1", async () => {
    const cases = ["omission", "extension", "reorder", "head-in-list", "missing", "corrupt", "base-hash", "result-hash"] as const;
    for (const hostile of cases) {
      const server = new FakeServer();
      const secrets = await bootstrapOnto(server, ACCT, `devA-hostile-${hostile}`, NOW);
      const writer = await remoteFor(server, secrets);
      const peer = await remoteFor(server, secrets);
      const base = deltaSizedManifest(`hostile-base-${hostile}`);
      const first = await writer.commit(0, secrets.deviceId, base);
      const middle: Manifest = { ...base, generatedAt: `hostile-middle-${hostile}`, files: base.files.map((f, i) => i === 0 ? { ...f, mode: 0o755 } : f) };
      const second = await writer.commit(1, secrets.deviceId, middle, { deltaBase: { manifest: base, meta: first.manifestMeta! } });
      const target: Manifest = { ...middle, generatedAt: `hostile-target-${hostile}`, files: middle.files.map((f, i) => i === 1 ? { ...f, mode: 0o700 } : f) };
      const third = await writer.commit(2, secrets.deviceId, target, { deltaBase: { manifest: middle, meta: second.manifestMeta! } });
      const original = parseSignedCommit(server.commits[2]!);
      let headEncSha = original.encManifestSha;
      const firstSha = first.manifestMeta!.encManifestSha;
      const secondSha = second.manifestMeta!.encManifestSha;
      let chain: string[] = [firstSha, secondSha];
      if (hostile === "omission") chain = [secondSha];
      if (hostile === "reorder") chain = [secondSha, firstSha];
      if (hostile === "head-in-list") chain = [firstSha, secondSha, original.encManifestSha];
      if (hostile === "missing") chain = [hex(987_654), secondSha];
      if (hostile === "extension") {
        const alternate = await encryptManifest(
          new Uint8Array((await writer.currentKek()).kek), ACCT, WS, original.keyEpoch,
          new TextEncoder().encode(JSON.stringify({ generatedAt: "unrelated", files: [] }))
        );
        server.store.blobs.set(alternate.encManifestSha, alternate.bytes);
        chain = [firstSha, secondSha, alternate.encManifestSha];
      }
      if (hostile === "corrupt") {
        const corrupt = new Uint8Array(server.store.blobs.get(firstSha)!);
        corrupt[Math.floor(corrupt.byteLength / 2)]! ^= 1;
        server.store.blobs.set(firstSha, corrupt);
      }
      if (hostile === "base-hash" || hostile === "result-hash") {
        const encoded = await encodeDeltaEnvelope(middle, target, {
          baseEncSha: secondSha,
          baseManifestHash: hostile === "base-hash" ? hex(555_001) : second.manifestMeta!.manifestHash,
          compress: false,
        });
        let bytes = encoded.bytes;
        if (hostile === "result-hash") {
          bytes = new TextEncoder().encode(new TextDecoder().decode(bytes).replace(encoded.resultHash, hex(555_002)));
        }
        const encrypted = await encryptManifest(new Uint8Array((await writer.currentKek()).kek), ACCT, WS, original.keyEpoch, bytes);
        server.store.blobs.set(encrypted.encManifestSha, encrypted.bytes);
        headEncSha = encrypted.encManifestSha;
      }
      const hostileBody = {
        accountId: original.accountId, accountEpoch: original.accountEpoch, workspaceId: original.workspaceId,
        seq: original.seq, parentSeq: original.parentSeq, parentCommitHash: original.parentCommitHash,
        rosterVersion: original.rosterVersion, keyEpoch: original.keyEpoch, deviceId: original.deviceId,
        encManifestSha: headEncSha, blobRefs: "blobRefs" in original ? original.blobRefs : [], manifestChain: chain,
      };
      const signingKey = { publicKey: secrets.sigPubKey, privateKey: signPrivateFromPkcs8(secrets.sigPrivPkcs8) };
      if (hostile === "head-in-list") {
        await expect(buildSignedCommit(hostileBody, signingKey)).rejects.toThrow(/manifestChain malformed/);
        continue;
      }
      server.commits[2] = await buildSignedCommit(hostileBody, signingKey);

      const root = await tmp();
      const cfg = await cfgFor(root, secrets, peer);
      await fs.writeFile(path.join(root, "must-survive.txt"), "local bytes");
      const before = await loadState(root, syncStreamId(cfg));
      before.manifestMeta = {
        encManifestSha: hex(700_001), manifestHash: hex(700_002), accountEpoch: 0, keyEpoch: 0,
        chain: [], chainBytes: 0, snapshotBytes: 123,
        gitRepos: {},
      };
      await saveStateUnsafeLegacyOrTest(root, before);
      await expect(pull(root, cfg, { remote: peer })).rejects.toBeInstanceOf(ManifestChainError);
      expect((await loadState(root, syncStreamId(cfg))).manifestMeta).toEqual(before.manifestMeta);
      expect(await fs.readFile(path.join(root, "must-survive.txt"), "utf8")).toBe("local bytes");
      expect(third.manifestMeta).toBeDefined();
    }
  });
});

test("D history fold LRU avoids refetching the same authenticated manifest blob", async () => {
  const server = new FakeServer();
  const secrets = await bootstrapOnto(server, ACCT, "devA-fold-lru", NOW);
  const remote = await remoteFor(server, secrets);
  await remote.commit(0, secrets.deviceId, { generatedAt: "one", files: [] });
  server.store.getCalls = [];
  await remote.manifestAtSeq(1);
  await remote.manifestAtSeq(1);
  expect(server.store.getCalls).toHaveLength(1);
});

test("D pull flag is off by default and enables the persisted-state fast base only at exactly 1", async () => {
  await withManifestEncodingFlags(undefined, "1", async () => {
    const server = new FakeServer();
    const secrets = await bootstrapOnto(server, ACCT, "devA-fast-pull-flag", NOW);
    const writer = await remoteFor(server, secrets);
    const puller = await remoteFor(server, secrets);
    const root = await tmp();
    const cfg = await cfgFor(root, secrets, puller);
    const base: Manifest = { generatedAt: "base", files: Array.from({ length: 300 }, (_, i) => ({
      path: `flag/${i.toString().padStart(4, "0")}`, type: "symlink" as const, symlinkTarget: `${i}`, sha256: hex(i + 1), size: 4, mode: 0o777, mtimeMs: i,
    })) };
    const first = await writer.commit(0, secrets.deviceId, base);
    await pull(root, cfg, { remote: puller });
    const middle: Manifest = { ...base, generatedAt: "middle", files: base.files.map((f, i) => i === 10 ? { ...f, mode: 0o755 } : f) };
    const second = await writer.commit(1, secrets.deviceId, middle, { deltaBase: { manifest: base, meta: first.manifestMeta! } });
    server.store.getCalls = [];
    await withFastPullFlag(undefined, () => pull(root, cfg, { remote: puller }));
    expect(server.store.getCalls).toEqual([second.manifestMeta!.encManifestSha, ...second.manifestMeta!.chain]);

    const target: Manifest = { ...middle, generatedAt: "target", files: middle.files.map((f, i) => i === 11 ? { ...f, mode: 0o700 } : f) };
    const third = await writer.commit(2, secrets.deviceId, target, { deltaBase: { manifest: middle, meta: second.manifestMeta! } });
    server.store.getCalls = [];
    await withFastPullFlag("1", () => pull(root, cfg, { remote: puller }));
    expect(server.store.getCalls).toEqual([third.manifestMeta!.encManifestSha]);
  });
});

test("D FAST_PULL-only receiver bootstraps evidence through real pull persistence", async () => {
  const server = new FakeServer();
  const secrets = await bootstrapOnto(server, ACCT, "devA-fast-pull-bootstrap", NOW);
  const writer = await remoteFor(server, secrets);
  const puller = await remoteFor(server, secrets);
  const root = await tmp();
  const cfg = await cfgFor(root, secrets, puller);
  const base: Manifest = { generatedAt: "bootstrap-base", files: Array.from({ length: 300 }, (_, i) => ({
    path: `bootstrap/${i.toString().padStart(4, "0")}`, type: "symlink" as const,
    symlinkTarget: `../${i}`, sha256: hex(i + 1), size: 8, mode: 0o777, mtimeMs: i + 0.25,
  })) };
  const first = await withManifestEncodingFlags(undefined, "1", () => writer.commit(0, secrets.deviceId, base));

  await withManifestEncodingFlags(undefined, undefined, () =>
    withFastPullFlag("1", () => pull(root, cfg, { remote: puller })));
  const afterFirst = await loadState(root, syncStreamId(cfg));
  expect(validManifestMeta(afterFirst.manifestMeta)).toEqual(afterFirst.manifestMeta);
  expect(afterFirst.manifestMeta).toBeDefined();
  expect(afterFirst.lastSyncedManifest).toEqual(base);

  const target: Manifest = { ...base, generatedAt: "bootstrap-target", files: base.files.map((entry, index) =>
    index === 42 ? { ...entry, mode: 0o755 } : entry) };
  const second = await withManifestEncodingFlags(undefined, "1", () =>
    writer.commit(1, secrets.deviceId, target, { deltaBase: { manifest: base, meta: first.manifestMeta! } }));
  const headEncSha = second.manifestMeta!.encManifestSha;
  server.store.getCalls = [];

  await withManifestEncodingFlags(undefined, undefined, () =>
    withFastPullFlag("1", () => pull(root, cfg, { remote: puller })));
  expect(server.store.getCalls).toEqual([headEncSha]);
  expect((await loadState(root, syncStreamId(cfg))).lastSyncedManifest).toEqual(target);
});

test("R5 chronic git deferral keeps fold evidence through advanced and same-head pulls", async () => {
  await withManifestEncodingFlags(undefined, "1", async () => {
    const server = new FakeServer();
    const secrets = await bootstrapOnto(server, ACCT, "devA-r3-chronic-deferral", NOW);
    const writer = await remoteFor(server, secrets);
    const receiver = await remoteFor(server, secrets);
    const root = await tmp();
    const repo = path.join(root, "repo");
    await fs.mkdir(repo);
    await git(repo, "init", "-qb", "main");
    await fs.writeFile(path.join(repo, ".git", "index.lock"), "busy");
    const cfg: WorkspaceConfig = { ...(await cfgFor(root, secrets, receiver)), syncGit: true };
    const section: GitSection = {
      bundleSha: hex(910_001), bundleEncSha: hex(910_002), bundleCipherSize: 1,
      head: "ref: refs/heads/main", refs: { "refs/heads/main": "1".repeat(40) },
      refScope: "all", generatedAt: "chronic",
    };
    for (const ref of gitSectionBlobRefs(section)) server.store.blobs.set(ref.encSha, new Uint8Array([1]));
    const c0: Manifest = { ...deltaSizedManifest("r5-c0"), manifestSchema: 2, gitRepos: { repo: section } };
    const first = await writer.commit(0, secrets.deviceId, c0);

    await withFastPullFlag("1", () => pull(root, cfg, { remote: receiver }));
    let state = await loadState(root, syncStreamId(cfg));
    expect(state.gitPendingRemote?.repo).toEqual(section);
    expect(state.manifestMeta?.gitRepos.repo).toEqual(section);
    expect(canonicalManifestHashStreaming(manifestFromMeta(state.lastSyncedManifest, state.manifestMeta!))).toBe(state.manifestMeta!.manifestHash);

    const c1: Manifest = { ...c0, generatedAt: "r5-c1", files: c0.files.map((f, i) => i === 7 ? { ...f, mode: 0o755 } : f) };
    const second = await writer.commit(1, secrets.deviceId, c1, { deltaBase: { manifest: c0, meta: first.manifestMeta! } });
    server.store.getCalls = [];
    const advancedReport = PhaseReport.pull();
    await withFastPullFlag("1", () => pull(root, cfg, { remote: receiver, report: advancedReport }));
    expect(server.store.getCalls).toEqual([second.manifestMeta!.encManifestSha]);
    expect((advancedReport.toJSON().phases.latest!.details as { fold?: string; foldLinks?: number })).toMatchObject({ fold: "evidence", foldLinks: 1 });
    state = await loadState(root, syncStreamId(cfg));
    expect(state.gitPendingRemote?.repo).toEqual(section);

    server.store.getCalls = [];
    const sameHeadReport = PhaseReport.pull();
    await withFastPullFlag("1", () => pull(root, cfg, { remote: receiver, report: sameHeadReport }));
    expect(server.store.getCalls).toEqual([]);
    expect((sameHeadReport.toJSON().phases.latest!.details as { fold?: string; foldLinks?: number })).toMatchObject({ fold: "evidence", foldLinks: 0 });

    const repoOnlySection = { ...section, generatedAt: "repo-only-transition" };
    state = await saveStateSource(root, await loadState(root, syncStreamId(cfg)), {
      expectedStream: syncStreamId(cfg), sourceGlobalSeq: 2, observedRepos: ["repo"], values: { bases: { repo: repoOnlySection } },
    });
    expect(state.manifestMeta).toEqual(second.manifestMeta);
    const c2: Manifest = { ...c1, generatedAt: "r7-c2", files: c1.files.map((f, i) => i === 8 ? { ...f, mode: 0o700 } : f) };
    const third = await writer.commit(2, secrets.deviceId, c2, { deltaBase: { manifest: c1, meta: second.manifestMeta! } });
    server.store.getCalls = [];
    const repoOnlyReport = PhaseReport.pull();
    await withFastPullFlag("1", () => pull(root, cfg, { remote: receiver, report: repoOnlyReport }));
    expect(server.store.getCalls).toEqual([third.manifestMeta!.encManifestSha]);
    expect((repoOnlyReport.toJSON().phases.latest!.details as { fold?: string }).fold).toBe("evidence");
  });
});

test("R9 pre-round-3 metadata cold-walks once, upgrades, and re-engages evidence", async () => {
  await withManifestEncodingFlags(undefined, "1", async () => {
    const server = new FakeServer();
    const secrets = await bootstrapOnto(server, ACCT, "devA-r3-upgrade", NOW);
    const writer = await remoteFor(server, secrets);
    const receiver = await remoteFor(server, secrets);
    const root = await tmp();
    const cfg = await cfgFor(root, secrets, receiver);
    const base = deltaSizedManifest("r9-base");
    const first = await writer.commit(0, secrets.deviceId, base);
    await withFastPullFlag("1", () => pull(root, cfg, { remote: receiver }));
    const preUpgrade = await loadState(root, syncStreamId(cfg));
    const { gitRepos: _gitRepos, ...preR3Meta } = preUpgrade.manifestMeta!;
    preUpgrade.manifestMeta = preR3Meta as typeof preUpgrade.manifestMeta;
    await saveStateUnsafeLegacyOrTest(root, preUpgrade);
    expect(validManifestMeta((await loadState(root, syncStreamId(cfg))).manifestMeta)).toBeUndefined();

    const target: Manifest = { ...base, generatedAt: "r9-target", files: base.files.map((f, i) => i === 9 ? { ...f, mode: 0o755 } : f) };
    const second = await writer.commit(1, secrets.deviceId, target, { deltaBase: { manifest: base, meta: first.manifestMeta! } });
    server.store.getCalls = [];
    const coldReport = PhaseReport.pull();
    await withFastPullFlag("1", () => pull(root, cfg, { remote: receiver, report: coldReport }));
    expect((coldReport.toJSON().phases.latest!.details as { fold?: string }).fold).toBe("coldwalk");
    expect(server.store.getCalls).toEqual([second.manifestMeta!.encManifestSha, ...second.manifestMeta!.chain]);
    expect(validManifestMeta((await loadState(root, syncStreamId(cfg))).manifestMeta)).toBeDefined();

    server.store.getCalls = [];
    const evidenceReport = PhaseReport.pull();
    await withFastPullFlag("1", () => pull(root, cfg, { remote: receiver, report: evidenceReport }));
    expect(server.store.getCalls).toEqual([]);
    expect((evidenceReport.toJSON().phases.latest!.details as { fold?: string; foldLinks?: number })).toMatchObject({ fold: "evidence", foldLinks: 0 });
  });
});

test("R2 same-head real pull reuses persisted evidence with zero blob fetches", async () => {
  await withManifestEncodingFlags("1", "1", async () => {
    const server = new FakeServer();
    const secrets = await bootstrapOnto(server, ACCT, "devA-r2-same-head", NOW);
    const writer = await remoteFor(server, secrets);
    const puller = await remoteFor(server, secrets);
    const root = await tmp();
    const cfg = await cfgFor(root, secrets, puller);
    const base = deltaSizedManifest("r2-base");
    const first = await writer.commit(0, secrets.deviceId, base);
    const target = { ...base, generatedAt: "r2-target", files: base.files.map((f, i) => i === 3 ? { ...f, mode: 0o755 } : f) };
    await writer.commit(1, secrets.deviceId, target, { deltaBase: { manifest: base, meta: first.manifestMeta! } });
    await withFastPullFlag("1", () => pull(root, cfg, { remote: puller }));
    const before = await loadState(root, syncStreamId(cfg));
    server.store.getCalls = [];
    const report = PhaseReport.pull();
    await withFastPullFlag("1", () => pull(root, cfg, { remote: puller, report }));
    expect(server.store.getCalls).toEqual([]);
    expect((report.toJSON().phases.latest!.details as { fold?: string; foldLinks?: number }).fold).toBe("evidence");
    expect((report.toJSON().phases.latest!.details as { foldLinks?: number }).foldLinks).toBe(0);
    const after = await loadState(root, syncStreamId(cfg));
    expect(after.lastSyncedManifest).toEqual(before.lastSyncedManifest);
    expect(after.manifestMeta).toEqual(before.manifestMeta);
  });
});

test("R3 same-head evidence lazily self-heals corruption and then reuses the verified fold", async () => {
  await withManifestEncodingFlags("1", "1", async () => {
    const server = new FakeServer();
    const secrets = await bootstrapOnto(server, ACCT, "devA-r3-same-head", NOW);
    const writer = await remoteFor(server, secrets);
    const puller = await remoteFor(server, secrets);
    const base = deltaSizedManifest("r3-base");
    const first = await writer.commit(0, secrets.deviceId, base);
    const target = { ...base, generatedAt: "r3-target", files: base.files.map((f, i) => i === 3 ? { ...f, mode: 0o755 } : f) };
    const second = await writer.commit(1, secrets.deviceId, target, { deltaBase: { manifest: base, meta: first.manifestMeta! } });
    const corrupted = { ...target, generatedAt: "corrupted-local-state" };

    server.store.getCalls = [];
    let firstFold: string | undefined;
    const healed = await puller.latest({
      fastFoldBase: { manifest: corrupted, meta: second.manifestMeta! },
      onLatestTimings: (timings) => { firstFold = timings.fold; },
    });
    expect(healed.manifest).toEqual(target);
    expect(firstFold).toBe("coldwalk");
    expect(server.store.getCalls).toEqual([second.manifestMeta!.encManifestSha, ...second.manifestMeta!.chain]);

    server.store.getCalls = [];
    let secondFold: string | undefined;
    const reused = await puller.latest({
      fastFoldBase: { manifest: corrupted, meta: second.manifestMeta! },
      onLatestTimings: (timings) => { secondFold = timings.fold; },
    });
    expect(reused.manifest).toEqual(target);
    expect(secondFold).toBe("evidence");
    expect(server.store.getCalls).toEqual([]);
  });
});

test("R3 consecutive valid same-head pulls are both zero-fetch", async () => {
  await withManifestEncodingFlags("1", "1", async () => {
    const server = new FakeServer();
    const secrets = await bootstrapOnto(server, ACCT, "devA-r3-zero-fetch", NOW);
    const writer = await remoteFor(server, secrets);
    const puller = await remoteFor(server, secrets);
    const manifest = deltaSizedManifest("r3-zero-fetch");
    const committed = await writer.commit(0, secrets.deviceId, manifest);

    for (let attempt = 0; attempt < 2; attempt++) {
      server.store.getCalls = [];
      await expect(puller.latest({ fastFoldBase: { manifest, meta: committed.manifestMeta! } }))
        .resolves.toMatchObject({ manifest });
      expect(server.store.getCalls).toEqual([]);
    }
  });
});

test("R1 daemon pull-push-pull cadence retains evidence for a head-only fold", async () => {
  await withManifestEncodingFlags("1", "1", async () => {
    const server = new FakeServer();
    const secrets = await bootstrapOnto(server, ACCT, "devA-r1-daemon", NOW);
    const writer = await remoteFor(server, secrets);
    const receiver = await remoteFor(server, secrets);
    const root = await tmp();
    const cfg = await cfgFor(root, secrets, receiver);
    const c0 = deltaSizedManifest("r1-c0");
    const first = await writer.commit(0, secrets.deviceId, c0);
    const c1 = { ...c0, generatedAt: "r1-c1", files: c0.files.map((f, i) => i === 1 ? { ...f, mode: 0o755 } : f) };
    await writer.commit(1, secrets.deviceId, c1, { deltaBase: { manifest: c0, meta: first.manifestMeta! } });
    await withFastPullFlag("1", () => pull(root, cfg, { remote: receiver }));
    await fs.writeFile(path.join(root, "receiver-local.txt"), "local divergence\n");
    await withFastPullFlag("1", () => push(root, cfg, { remote: receiver }));
    const pushed = await writer.latest({ recordEvidence: true });
    const target = { ...pushed.manifest, generatedAt: "r1-ambient", files: pushed.manifest.files.map((f, i) => i === 2 ? { ...f, mode: 0o700 } : f) };
    const ambient = await writer.commit(pushed.sequence, secrets.deviceId, target, { deltaBase: { manifest: pushed.manifest, meta: pushed.manifestMeta! } });
    server.store.getCalls = [];
    const report = PhaseReport.pull();
    await withFastPullFlag("1", () => pull(root, cfg, { remote: receiver, report }));
    expect(server.store.getCalls).toEqual([ambient.manifestMeta!.encManifestSha]);
    expect((report.toJSON().phases.latest!.details as { fold?: string; foldLinks?: number })).toMatchObject({ fold: "evidence", foldLinks: 1 });
    expect((await loadState(root, syncStreamId(cfg))).lastSyncedManifest).toEqual(target);
  });
});

test("R3 multi-link real pull fetches only the new suffix and head", async () => {
  for (const advance of [2, 3]) await withManifestEncodingFlags("1", "1", async () => {
    const server = new FakeServer();
    const secrets = await bootstrapOnto(server, ACCT, `devA-r3-suffix-${advance}`, NOW);
    const writer = await remoteFor(server, secrets);
    const puller = await remoteFor(server, secrets);
    const root = await tmp();
    const cfg = await cfgFor(root, secrets, puller);
    let manifest = deltaSizedManifest(`r3-base-${advance}`);
    const snapshot = await writer.commit(0, secrets.deviceId, manifest);
    manifest = { ...manifest, generatedAt: "r3-c1", files: manifest.files.map((f, i) => i === 1 ? { ...f, mode: 0o755 } : f) };
    let current = await writer.commit(1, secrets.deviceId, manifest, { deltaBase: { manifest: deltaSizedManifest(`r3-base-${advance}`), meta: snapshot.manifestMeta! } });
    await withFastPullFlag("1", () => pull(root, cfg, { remote: puller }));
    const expectedFetches: string[] = [];
    for (let n = 0; n < advance; n++) {
      const previous = manifest;
      manifest = { ...previous, generatedAt: `r3-c${n + 2}`, files: previous.files.map((f, i) => i === n + 2 ? { ...f, mode: 0o700 - n } : f) };
      current = await writer.commit(n + 2, secrets.deviceId, manifest, { deltaBase: { manifest: previous, meta: current.manifestMeta! } });
      expectedFetches.push(current.manifestMeta!.encManifestSha);
    }
    server.store.getCalls = [];
    const report = PhaseReport.pull();
    await withFastPullFlag("1", () => pull(root, cfg, { remote: puller, report }));
    expect([...server.store.getCalls].sort()).toEqual([...expectedFetches].sort());
    expect(server.store.getCalls).not.toContain(snapshot.manifestMeta!.encManifestSha);
    const after = await loadState(root, syncStreamId(cfg));
    expect(after.lastSyncedManifest).toEqual(manifest);
    expect(after.manifestMeta?.chain).toEqual(parseSignedCommit(server.commits.at(-1)!).manifestChain);
    expect((report.toJSON().phases.latest!.details as { fold?: string; foldLinks?: number })).toMatchObject({ fold: "evidence", foldLinks: advance });
  });
});

async function withCompressEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.RBOX_COMPRESS;
  if (value === undefined) delete process.env.RBOX_COMPRESS;
  else process.env.RBOX_COMPRESS = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.RBOX_COMPRESS;
    else process.env.RBOX_COMPRESS = prev;
  }
}

function hasKeyDeep(value: unknown, keys: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) return value.some((v) => hasKeyDeep(v, keys));
  if (value === null || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key)) return true;
    if (hasKeyDeep(child, keys)) return true;
  }
  return false;
}

describe("E2EE sync transport — two machines through real sync.ts", () => {
  test("blocked terminal sidecar fingerprint bails before sidecar or manifest upload", async () => {
    const server = new ObservedServer();
    const secrets = await bootstrapOnto(server, ACCT, "devA-blocked", NOW);
    const remote = await remoteFor(server, secrets);
    const manifest = largeManifest();
    const fingerprint = sidecarShaOf(manifest);

    try {
      await remote.commit(0, secrets.deviceId, manifest, { blockedFingerprint: fingerprint });
      throw new Error("expected still-blocked rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(CommitRejectedError);
      const err = e as CommitRejectedError;
      expect(err.fingerprint).toBe(fingerprint);
      expect(err.stillBlocked).toBe(true);
    }
    expect(server.putBlobBytesCalls).toEqual([]);
    expect(server.commitSignedCalls).toBe(0);
  });

  test("different blocked fingerprint performs the full sidecar commit attempt", async () => {
    const server = new ObservedServer();
    const secrets = await bootstrapOnto(server, ACCT, "devA-changed", NOW);
    const remote = await remoteFor(server, secrets);
    const manifest = largeManifest();
    const fingerprint = sidecarShaOf(manifest);
    const different = fingerprint === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
    seedManifestRefs(server, manifest);

    let timings: Record<string, number> | undefined;
    await expect(remote.commit(0, secrets.deviceId, manifest, { blockedFingerprint: different, onCommitTimings: (t) => (timings = t) })).resolves.toMatchObject({ sequence: 1 });
    expect(server.putBlobBytesCalls).toContain(fingerprint);
    expect(server.commitSignedCalls).toBe(1);
    if (!timings) throw new Error("missing commit timings");
    expect(Object.keys(timings).sort()).toEqual(["encBytes", "encodeMs", "encryptMs", "postMs", "refreshMs", "sidecarMs", "uploadMs"]);
    expect(timings.sidecarMs).toBeGreaterThanOrEqual(0);
    expect(timings.postMs).toBeGreaterThanOrEqual(0);
    expect(timings.encBytes).toBeGreaterThan(0);
  });

  test("A pushes an encrypted tree; B pairs in and pulls it byte-identically; server sees no plaintext", async () => {
    const server = new FakeServer();

    // --- Machine A: bootstrap account + workspace keys ---
    const secretsA = await bootstrapOnto(server, ACCT, "devA", NOW);

    const rootA = await tmp();
    await fs.mkdir(path.join(rootA, "src"), { recursive: true });
    await fs.writeFile(path.join(rootA, "src", "secret-name.ts"), "export const TOKEN = 'super-secret-do-not-leak';\n");
    await fs.writeFile(path.join(rootA, "README.md"), "# my private project\n");

    const remoteA = await remoteFor(server, secretsA);
    const cfgA = await cfgFor(rootA, secretsA, remoteA);
    const { sequence: seq } = await push(rootA, cfgA, { remote: remoteA });
    expect(seq).toBe(1);

    // GC-root invariant (design 13 G3): the commit's blobRefs must cover every
    // current file blob (so GC reachability never drops a current blob), the
    // encManifest is referenced separately (not in blobRefs), and every referenced
    // blob is actually stored.
    const body = JSON.parse(server.commits[0]!.body) as { blobRefs: { encSha: string }[]; encManifestSha: string };
    const refs = new Set(body.blobRefs.map((r) => r.encSha));
    expect(refs.size).toBe(2); // exactly the two files (secret-name.ts, README.md)
    expect(refs.has(body.encManifestSha)).toBe(false);
    for (const s of refs) expect(server.store.blobs.has(s)).toBe(true);

    // --- Machine B: pair in (token-derived MK wrap + self-admission) ---
    const genesisRoster = JSON.parse(server.account.rosters[0]!) as SignedRoster;
    const tokenSecret = secretsA.mk.slice(0, 32).map((b, i) => b ^ (i + 1)); // any 32 bytes; A would gen random
    const material = await buildPairing(secretsA, { accountEpoch: 0, tokenId: "tok1", tokenSecret, notAfter: NOW + 600_000 });
    const redeem = await redeemPairing({ accountId: ACCT, deviceId: "devB", tokenSecret, accountEpoch: 0, material, prevRoster: genesisRoster, now: NOW + 1000 });
    server.account.rosters.push(JSON.stringify(redeem.admissionRoster));
    server.account.devices.push({ deviceId: "devB", sigPubkey: redeem.device.sigPubKey, encPubkey: redeem.device.encPubKey, mkWrap: JSON.stringify(redeem.device.mkWrap) });

    const rootB = await tmp();
    const remoteB = await remoteFor(server, redeem.secrets);
    const cfgB = await cfgFor(rootB, redeem.secrets, remoteB);
    await pull(rootB, cfgB, { remote: remoteB });

    expect(await fs.readFile(path.join(rootB, "src", "secret-name.ts"), "utf8")).toBe("export const TOKEN = 'super-secret-do-not-leak';\n");
    expect(await fs.readFile(path.join(rootB, "README.md"), "utf8")).toBe("# my private project\n");

    // --- ZERO-KNOWLEDGE: no plaintext name/content anywhere the server holds ---
    for (const needle of ["secret-name.ts", "super-secret-do-not-leak", "my private project", "README.md", "TOKEN"]) {
      for (const bytes of server.allBytes()) {
        expect(Buffer.from(bytes).includes(Buffer.from(needle))).toBe(false);
      }
    }
  });

  test("RBOX_COMPRESS unset/default-on round-trips mixed blobs and carries compressed descriptors forward when opt-out later", async () =>
    withCompressEnv(undefined, async () => {
      const server = new FakeServer();
      const secrets = await bootstrapOnto(server, ACCT, "devA-compress", NOW);
      const rootA = await tmp();
      await fs.mkdir(path.join(rootA, "data"), { recursive: true });
      const text = Buffer.from("design 79 compressible corpus line\n".repeat(12_000));
      const binary = randomBytes(16 * 1024);
      await fs.writeFile(path.join(rootA, "data", "notes.txt"), text);
      await fs.writeFile(path.join(rootA, "data", "photo.bin"), binary);

      const remoteA = await remoteFor(server, secrets);
      const cfgA = await cfgFor(rootA, secrets, remoteA);
      await push(rootA, cfgA, { remote: remoteA });

      const firstManifest = (await loadState(rootA, syncStreamId(cfgA))).lastSyncedManifest;
      expect(firstManifest.manifestSchema).toBe(4);
      const firstText = firstManifest.files.find((f) => f.path === "data/notes.txt")!;
      const firstBinary = firstManifest.files.find((f) => f.path === "data/photo.bin")!;
      expect(firstText.comp).toBe("zstd");
      expect(firstText.payloadSha).toMatch(/^[0-9a-f]{64}$/);
      expect(firstText.cipherSize).toBeLessThan(firstText.size);
      expect(firstBinary.comp).toBeUndefined();
      expect(firstBinary.payloadSha).toBeUndefined();
      expect(firstBinary.cipherSize).toBeUndefined();

      const rootB = await tmp();
      const remoteB = await remoteFor(server, secrets);
      const cfgB = await cfgFor(rootB, secrets, remoteB);
      await pull(rootB, cfgB, { remote: remoteB });
      expect(Buffer.from(await fs.readFile(path.join(rootB, "data", "notes.txt"))).equals(text)).toBe(true);
      expect(Buffer.from(await fs.readFile(path.join(rootB, "data", "photo.bin"))).equals(binary)).toBe(true);

      await withCompressEnv("0", async () => {
        await fs.writeFile(path.join(rootA, "other.txt"), "new opt-out file\n".repeat(10_000));
        await push(rootA, cfgA, { remote: remoteA });
      });
      const secondManifest = (await loadState(rootA, syncStreamId(cfgA))).lastSyncedManifest;
      expect(secondManifest.manifestSchema).toBe(4);
      const secondText = secondManifest.files.find((f) => f.path === "data/notes.txt")!;
      const secondOther = secondManifest.files.find((f) => f.path === "other.txt")!;
      expect({
        encSha: secondText.encSha,
        comp: secondText.comp,
        payloadSha: secondText.payloadSha,
        cipherSize: secondText.cipherSize,
      }).toEqual({
        encSha: firstText.encSha,
        comp: firstText.comp,
        payloadSha: firstText.payloadSha,
        cipherSize: firstText.cipherSize,
      });
      expect(secondOther.comp).toBeUndefined();
      expect(secondOther.payloadSha).toBeUndefined();
      expect(secondOther.cipherSize).toBeUndefined();
    }));

  test("RBOX_COMPRESS=0 writes no compression fields into fresh file manifests", async () =>
    withCompressEnv("0", async () => {
      const server = new FakeServer();
      const secrets = await bootstrapOnto(server, ACCT, "devA-raw-default", NOW);
      const root = await tmp();
      await fs.writeFile(path.join(root, "notes.txt"), "default raw path stays raw\n".repeat(10_000));

      const remote = await remoteFor(server, secrets);
      const cfg = await cfgFor(root, secrets, remote);
      await push(root, cfg, { remote });

      const manifest = (await loadState(root, syncStreamId(cfg))).lastSyncedManifest;
      expect(manifest.manifestSchema).toBeUndefined();
      expect(hasKeyDeep(manifest.files, new Set(["comp", "payloadSha", "cipherSize"]))).toBe(false);
    }));

  test("round-trips edits both directions and converges", async () => {
    const server = new FakeServer();
    const secrets = await bootstrapOnto(server, ACCT, "devA", NOW);

    const root = await tmp();
    await fs.writeFile(path.join(root, "a.txt"), "one\n");
    const remote = await remoteFor(server, secrets);
    const cfg = await cfgFor(root, secrets, remote);
    await push(root, cfg, { remote });

    // second commit (edit) advances the chain; pull on a fresh clone replays both
    await fs.writeFile(path.join(root, "a.txt"), "two\n");
    await fs.writeFile(path.join(root, "b.txt"), "new\n");
    const { sequence: s2 } = await push(root, cfg, { remote });
    expect(s2).toBe(2);

    const root2 = await tmp();
    const remote2 = await remoteFor(server, secrets);
    const cfg2 = await cfgFor(root2, secrets, remote2);
    await pull(root2, cfg2, { remote: remote2 });
    expect(await fs.readFile(path.join(root2, "a.txt"), "utf8")).toBe("two\n");
    expect(await fs.readFile(path.join(root2, "b.txt"), "utf8")).toBe("new\n");
  });

  test("failed pull keeps the applied base authoritative and blocks signing from the observed head", async () => {
    const server = new ObservedServer();
    const secrets = await bootstrapOnto(server, ACCT, "dev-resurrection", NOW);
    const rootA = await tmp();
    await fs.writeFile(path.join(rootA, "a-blocker"), "base blocker\n");
    await fs.writeFile(path.join(rootA, "z-log"), "append-hot log\n");
    const remoteA = await remoteFor(server, secrets);
    const cfgA = await cfgFor(rootA, secrets, remoteA);
    await push(rootA, cfgA, { remote: remoteA });

    const seq1 = (await loadState(rootA, syncStreamId(cfgA))).lastSyncedManifest;
    const blockerBase = seq1.files.find((f) => f.path === "a-blocker")!;
    const coherentLog = seq1.files.find((f) => f.path === "z-log")!;
    const poisonLog = { ...coherentLog, size: coherentLog.size - 1 };
    await expect(remoteA.commit(1, secrets.deviceId, { generatedAt: "", files: [blockerBase, poisonLog] })).resolves.toMatchObject({ sequence: 2 });

    // Byte-identity reconcile accepts the existing bytes without a false conflict.
    const rootB = await tmp();
    await fs.writeFile(path.join(rootB, "a-blocker"), "base blocker\n");
    await fs.writeFile(path.join(rootB, "z-log"), "append-hot log\n");
    const remoteB = await remoteFor(server, secrets);
    const cfgB = await cfgFor(rootB, secrets, remoteB);
    expect(await pull(rootB, cfgB, { remote: remoteB })).toEqual([]);
    expect((await loadState(rootB, syncStreamId(cfgB))).lastSyncedSequence).toBe(2);
    await fs.rm(path.join(rootB, "a-blocker"));
    await fs.rm(path.join(rootB, "z-log"));

    const makeRawEntry = async (rel: string, plaintext: Buffer) => {
      const blob = await encryptFileNameProbe(new Uint8Array(cfgA.kek!), new Uint8Array(plaintext));
      await server.store.put(blob.encSha, blob.ciphertext);
      return {
        path: rel,
        type: "file" as const,
        sha256: blob.plaintextSha,
        encSha: blob.encSha,
        size: plaintext.length,
        mode: 0o644,
        mtimeMs: 0,
      };
    };
    const encryptedWrongBytes = await makeRawEntry("a-blocker", Buffer.from("ciphertext for another image\n"));
    const badBlocker = { ...encryptedWrongBytes, sha256: shaBytes(Buffer.from("declared blocker image\n")) };
    const healedLog = await makeRawEntry("z-log", Buffer.alloc(0));
    await expect(remoteA.commit(2, secrets.deviceId, { generatedAt: "", files: [badBlocker, healedLog] })).resolves.toMatchObject({ sequence: 3 });

    const previousConcurrency = process.env.RBOX_DOWNLOAD_CONCURRENCY;
    process.env.RBOX_DOWNLOAD_CONCURRENCY = "1";
    try {
      await expect(pull(rootB, cfgB, { remote: remoteB })).rejects.toThrow(/a-blocker/);
      const applied = await loadState(rootB, syncStreamId(cfgB));
      expect(applied.lastSyncedSequence).toBe(2);
      expect(applied.lastSyncedManifest.files.find((f) => f.path === "z-log")?.size).toBe(poisonLog.size);
      await expect(fs.stat(path.join(rootB, "z-log"))).rejects.toThrow();

      const signedBeforePush = server.commitSignedCalls;
      await expect(push(rootB, cfgB, { remote: remoteB, backoff: async () => {} })).rejects.toThrow(/a-blocker/);
      expect(server.commitSignedCalls).toBe(signedBeforePush); // no mixed parent-sequence/hash envelope
      expect(server.commits).toHaveLength(3);
      const head = await remoteA.latest();
      expect(head.sequence).toBe(3);
      expect(head.manifest.files.find((f) => f.path === "z-log")?.sha256).toBe(healedLog.sha256);
      expect(head.manifest.files.find((f) => f.path === "z-log")?.size).toBe(0);
    } finally {
      if (previousConcurrency === undefined) delete process.env.RBOX_DOWNLOAD_CONCURRENCY;
      else process.env.RBOX_DOWNLOAD_CONCURRENCY = previousConcurrency;
    }
  });

  test("design 93: initial encrypted publish carries config through fresh materialization", async () => {
    const server = new FakeServer();
    const secrets = await bootstrapOnto(server, ACCT, "devA-config-first-publish", NOW);
    const rootA = await tmp();
    const repoA = path.join(rootA, "repo");
    await fs.mkdir(repoA, { recursive: true });
    await git(repoA, "init", "-qb", "main");
    await fs.writeFile(path.join(repoA, "tracked.txt"), "initial config publish\n");
    await git(repoA, "add", "tracked.txt");
    await git(repoA, "-c", "user.name=Config Test", "-c", "user.email=config@example.com", "commit", "-qm", "initial");
    await git(repoA, "remote", "add", "origin", "https://example.test/config-first-publish.git");
    await git(repoA, "config", "branch.main.remote", "origin");
    await git(repoA, "config", "branch.main.merge", "refs/heads/main");

    const remoteA = await remoteFor(server, secrets);
    const cfgA: WorkspaceConfig = { ...(await cfgFor(rootA, secrets, remoteA)), syncGit: true };
    await push(rootA, cfgA, { remote: remoteA });

    const first = await remoteA.latest();
    expect(first.manifest.gitRepos?.repo?.config).toEqual({
      "branch.main.merge": ["refs/heads/main"],
      "branch.main.remote": ["origin"],
      "remote.origin.fetch": ["+refs/heads/*:refs/remotes/origin/*"],
      "remote.origin.url": ["https://example.test/config-first-publish.git"],
    });

    const rootB = await tmp();
    const remoteB = await remoteFor(server, secrets);
    const cfgB: WorkspaceConfig = { ...(await cfgFor(rootB, secrets, remoteB)), syncGit: true };
    await pull(rootB, cfgB, { remote: remoteB });
    const repoB = path.join(rootB, "repo");
    expect(await git(repoB, "remote", "-v")).toContain("origin\thttps://example.test/config-first-publish.git (fetch)");
    expect(await git(repoB, "config", "--local", "--get", "branch.main.remote")).toBe("origin");
    expect(await git(repoB, "config", "--local", "--get", "branch.main.merge")).toBe("refs/heads/main");
  }, 30_000);

  test("design 43: gitRepos artifact blobs join the commit blobRefs (union, deduped across repos); server sees zero git plaintext", async () => {
    const server = new FakeServer();
    const secrets = await bootstrapOnto(server, ACCT, "devA", NOW);
    const rootA = await tmp();

    // Two nested repos with IDENTICAL content + pinned dates → identical bundle bytes →
    // ONE convergent encSha referenced by BOTH sections (the §6.5 union-dedup case).
    const DATE = "2026-01-01T00:00:00 +0000";
    for (const r of ["repo1", "repo2"]) {
      const d = path.join(rootA, r);
      await fs.mkdir(d, { recursive: true });
      await git(d, "init", "-qb", "main");
      await fs.writeFile(path.join(d, "f.txt"), "git-secret-content\n");
      await git(d, "add", "f.txt");
      await exec("git", ["-C", d, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "c1"], {
        env: { ...process.env, GIT_AUTHOR_DATE: DATE, GIT_COMMITTER_DATE: DATE },
      });
      await git(d, "branch", "secret-branch");
    }

    const remoteA = await remoteFor(server, secrets);
    const cfgA: WorkspaceConfig = { ...(await cfgFor(rootA, secrets, remoteA)), syncGit: true };
    await push(rootA, cfgA, { remote: remoteA });

    const sections = (await loadState(rootA, `mem://::${WS}::root`)).lastSyncedManifest.gitRepos!;
    expect(Object.keys(sections).sort()).toEqual(["repo1", "repo2"]);
    expect(sections["repo1"]!.bundleEncSha).toBe(sections["repo2"]!.bundleEncSha); // convergent bundles

    // G3 invariant, extended by §28/§43: every git artifact encSha is a GC root via
    // blobRefs — union across repos, the shared convergent encSha counted ONCE.
    const body = JSON.parse(server.commits.at(-1)!.body) as { blobRefs: { encSha: string }[] };
    const refShas = body.blobRefs.map((r) => r.encSha);
    expect(new Set(refShas).size).toBe(refShas.length); // no duplicate refs
    for (const s of Object.values(sections)) {
      for (const ref of gitSectionBlobRefs(s)) {
        expect(refShas).toContain(ref.encSha);
        expect(server.store.blobs.has(ref.encSha)).toBe(true);
      }
    }

    // ZERO-KNOWLEDGE: no repo path, branch name, or content anywhere the server holds.
    for (const needle of ["repo1", "repo2", "secret-branch", "git-secret-content"]) {
      for (const bytes of server.allBytes()) {
        expect(Buffer.from(bytes).includes(Buffer.from(needle))).toBe(false);
      }
    }

    // A fresh machine pulls: both repos materialize fsck-clean with matching history.
    const rootB = await tmp();
    const remoteB = await remoteFor(server, secrets);
    const cfgB: WorkspaceConfig = { ...(await cfgFor(rootB, secrets, remoteB)), syncGit: true };
    await pull(rootB, cfgB, { remote: remoteB });
    for (const r of ["repo1", "repo2"]) {
      expect(await git(path.join(rootB, r), "rev-parse", "main")).toBe(await git(path.join(rootA, r), "rev-parse", "main"));
      await expect(git(path.join(rootB, r), "fsck", "--connectivity-only", "--no-dangling")).resolves.toBeDefined();
    }
  }, 120_000);
});

test("D fast pull rejects an intermediate SIGNED-chain substitution (same snapshot/length/immediate base) and the cold walk fails closed", async () => {
  await withManifestEncodingFlags("1", "1", async () => {
    const server = new FakeServer();
    const secrets = await bootstrapOnto(server, ACCT, "devA-fast-substitution", NOW);
    const writer = await remoteFor(server, secrets);
    const peer = await remoteFor(server, secrets);
    const base = deltaSizedManifest("fast-sub-base");
    const first = await writer.commit(0, secrets.deviceId, base);
    const m2: Manifest = { ...base, generatedAt: "fast-sub-2", files: base.files.map((f, i) => (i === 0 ? { ...f, mode: 0o755 } : f)) };
    const second = await writer.commit(1, secrets.deviceId, m2, { deltaBase: { manifest: base, meta: first.manifestMeta! } });
    const m3: Manifest = { ...m2, generatedAt: "fast-sub-3", files: m2.files.map((f, i) => (i === 1 ? { ...f, mode: 0o700 } : f)) };
    const third = await writer.commit(2, secrets.deviceId, m3, { deltaBase: { manifest: m2, meta: second.manifestMeta! } });
    const m4: Manifest = { ...m3, generatedAt: "fast-sub-4", files: m3.files.map((f, i) => (i === 2 ? { ...f, mode: 0o600 } : f)) };
    await writer.commit(3, secrets.deviceId, m4, { deltaBase: { manifest: m3, meta: third.manifestMeta! } });

    // Substitute the MIDDLE signed-chain element with a VALID, present encrypted
    // blob — snapshot (chain[0]), length, and immediate base (last element) all
    // preserved, exactly the §7.4 case an aggregate/endpoints-only compare passes.
    const original = parseSignedCommit(server.commits[3]!);
    const substitute = await encryptManifest(
      new Uint8Array((await writer.currentKek()).kek), ACCT, WS, original.keyEpoch,
      new TextEncoder().encode(JSON.stringify({ generatedAt: "substituted", files: [] }))
    );
    server.store.blobs.set(substitute.encManifestSha, substitute.bytes);
    const signedChain = [first.manifestMeta!.encManifestSha, substitute.encManifestSha, third.manifestMeta!.encManifestSha];
    const hostileBody = {
      accountId: original.accountId, accountEpoch: original.accountEpoch, workspaceId: original.workspaceId,
      seq: original.seq, parentSeq: original.parentSeq, parentCommitHash: original.parentCommitHash,
      rosterVersion: original.rosterVersion, keyEpoch: original.keyEpoch, deviceId: original.deviceId,
      encManifestSha: original.encManifestSha, blobRefs: "blobRefs" in original ? original.blobRefs : [], manifestChain: signedChain,
    };
    server.commits[3] = await buildSignedCommit(hostileBody, { publicKey: secrets.sigPubKey, privateKey: signPrivateFromPkcs8(secrets.sigPrivPkcs8) });

    // Fast base = the applied third commit: baseEncSha/baseManifestHash MATCH the
    // head's delta header, and the hostile chain matches meta.chain + [meta sha]
    // everywhere EXCEPT the substituted middle element — only the element-wise
    // compare catches it. The demoted cold walk then fails closed on linkage.
    server.store.getCalls = [];
    const error = await peer
      .latest({ fastFoldBase: { manifest: m3, meta: third.manifestMeta! } })
      .then(() => { throw new Error("expected chain failure"); }, (e: unknown) => e);
    expect(error).toBeInstanceOf(ManifestChainError);
    // The cold walk ran (chain blobs fetched) — the fast path did not accept.
    expect(server.store.getCalls).toContain(substitute.encManifestSha);
  });
}, 60_000);

test("R4 evidence suffix rejects bytes substituted under a signed link address without refetching the prefix", async () => {
  await withManifestEncodingFlags("1", "1", async () => {
    const server = new FakeServer();
    const secrets = await bootstrapOnto(server, ACCT, "devA-r4-suffix-address", NOW);
    const writer = await remoteFor(server, secrets);
    const peer = await remoteFor(server, secrets);
    const base = deltaSizedManifest("r4-base");
    const first = await writer.commit(0, secrets.deviceId, base);
    const m1 = { ...base, generatedAt: "r4-m1", files: base.files.map((f, i) => i === 1 ? { ...f, mode: 0o755 } : f) };
    const second = await writer.commit(1, secrets.deviceId, m1, { deltaBase: { manifest: base, meta: first.manifestMeta! } });
    const m2 = { ...m1, generatedAt: "r4-m2", files: m1.files.map((f, i) => i === 2 ? { ...f, mode: 0o700 } : f) };
    const third = await writer.commit(2, secrets.deviceId, m2, { deltaBase: { manifest: m1, meta: second.manifestMeta! } });
    const m3 = { ...m2, generatedAt: "r4-m3", files: m2.files.map((f, i) => i === 3 ? { ...f, mode: 0o600 } : f) };
    const fourth = await writer.commit(3, secrets.deviceId, m3, { deltaBase: { manifest: m2, meta: third.manifestMeta! } });
    server.store.blobs.set(third.manifestMeta!.encManifestSha, new Uint8Array(server.store.blobs.get(first.manifestMeta!.encManifestSha)!));
    server.store.getCalls = [];
    await expect(peer.latest({ fastFoldBase: { manifest: m1, meta: second.manifestMeta! } })).rejects.toBeInstanceOf(ManifestChainError);
    expect(server.store.getCalls).toEqual([fourth.manifestMeta!.encManifestSha, third.manifestMeta!.encManifestSha]);
    expect(server.store.getCalls).not.toContain(first.manifestMeta!.encManifestSha);
    expect(server.store.getCalls).not.toContain(second.manifestMeta!.encManifestSha);
  });
}, 60_000);

test("repairChain converges on a readable head that raced in BEFORE the repair started (never supersedes readable data)", async () => {
  await withManifestEncodingFlags("1", "1", async () => {
    const server = new FakeServer();
    const secrets = await bootstrapOnto(server, ACCT, "devA-race-pre", NOW);
    const writer = await remoteFor(server, secrets);
    const repairer = await remoteFor(server, secrets);
    const root = await tmp();
    const cfg = await cfgFor(root, secrets, repairer);
    const base = repairFixtureManifest("base-pre-race");
    const first = await writer.commit(0, secrets.deviceId, base);
    await pull(root, cfg, { remote: repairer });
    await writer.commit(1, secrets.deviceId, { ...base, generatedAt: "broken-pre-race" }, { deltaBase: { manifest: base, meta: first.manifestMeta! } });
    server.store.blobs.delete(parseSignedCommit(server.commits[1]!).encManifestSha);
    const failure = await expectBrokenPull(root, cfg, repairer);
    // The peer repairs FIRST — a readable snapshot child exists before repairChain runs.
    await writer.commit(2, secrets.deviceId, { ...base, generatedAt: "peer-repaired" });

    const outcome = await repairChain(root, cfg, { remote: repairer, allowMassDeletePush: true }, failure, {
      confirmSupersede: async () => {
        throw new Error("must not ask consent to supersede a readable head");
      },
    });
    expect(outcome.kind).toBe("converged");
    expect(outcome.kind === "converged" && outcome.sequence).toBe(3);
    expect(server.commits).toHaveLength(3); // no repair commit published
  });
}, 60_000);
