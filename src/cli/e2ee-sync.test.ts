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
  parseCommit,
  redeemPairing,
  serializeRefset,
  signPrivateFromPkcs8,
  type DeviceSecrets,
  type SignedKeyState,
  type SignedRoster,
} from "../engine/e2ee/index.js";
import { decodeEnvelope, ENCRYPT_ADDRESS_CACHE_REL, gitSectionBlobRefs, ManifestChainError, MAX_MANIFEST_DELTA_CHAIN, type GitSection, type Manifest } from "../engine/index.js";
import { encryptManifest, openManifestChainBlob, parseCommit as parseSignedCommit } from "../engine/e2ee/index.js";
import { encryptFileNameProbe } from "../engine/e2ee/e2ee-e2e.helpers.js";
import { blobRefsForManifest, E2eeRemote, SIDECAR_THRESHOLD } from "./e2ee-remote.js";
import { bootstrapOnto, cfgFor as harnessCfg, FakeServer, remoteFor as harnessRemote } from "./e2ee-fake-server.js";
import { CommitRejectedError } from "./remote.js";
import { pull, push, pushManifest } from "./sync.js";
import { repairChain } from "./chain-repair.js";
import { loadState, saveState, syncStreamId, type WorkspaceConfig } from "./config.js";

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

test("a push carrying a pending repo suppresses meta so the following push snapshots", async () => {
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
    await saveState(root, state);

    await fs.unlink(path.join(root, "link-0299"));
    await fs.symlink(`../changed/${hex(299)}`, path.join(root, "link-0299"));
    await push(root, cfg, { remote });
    expect(await wireKind(server, remote)).toBe("delta");
    expect((await loadState(root, syncStreamId(cfg))).manifestMeta).toBeUndefined();

    await fs.unlink(path.join(root, "link-0298"));
    await fs.symlink(`../changed/${hex(298)}`, path.join(root, "link-0298"));
    await push(root, cfg, { remote });
    expect(await wireKind(server, remote)).toBe("snapshot");
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
  await withManifestEncodingFlags("1", "1", async () => {
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
  });
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

    const pulled = await peer.latest({ fastFoldBase: { manifest: base, meta: first.manifestMeta! } });

    expect(pulled.manifest).toEqual(target);
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
    for (const meta of cases) {
      const peer = await remoteFor(server, secrets);
      server.store.getCalls = [];
      await expect(peer.latest({ fastFoldBase: { manifest: middle, meta } })).resolves.toMatchObject({ manifest: target });
      expect(server.store.getCalls).toEqual([third.manifestMeta!.encManifestSha, ...third.manifestMeta!.chain]);
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
    await expect(remote.commit(0, secrets.deviceId, manifest, { blockedFingerprint: different, onCommitTimings: (t) => (timings = t) })).resolves.toEqual({ sequence: 1 });
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
    await expect(remoteA.commit(1, secrets.deviceId, { generatedAt: "", files: [blockerBase, poisonLog] })).resolves.toEqual({ sequence: 2 });

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
    await expect(remoteA.commit(2, secrets.deviceId, { generatedAt: "", files: [badBlocker, healedLog] })).resolves.toEqual({ sequence: 3 });

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
  }, 30_000);
});
