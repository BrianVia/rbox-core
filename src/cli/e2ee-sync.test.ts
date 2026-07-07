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
import { ENCRYPT_ADDRESS_CACHE_REL, gitSectionBlobRefs, type GitSection, type Manifest } from "../engine/index.js";
import { encryptFileNameProbe } from "../engine/e2ee/e2ee-e2e.helpers.js";
import { blobRefsForManifest, E2eeRemote, SIDECAR_THRESHOLD } from "./e2ee-remote.js";
import { bootstrapOnto, cfgFor as harnessCfg, FakeServer, remoteFor as harnessRemote } from "./e2ee-fake-server.js";
import { CommitRejectedError } from "./remote.js";
import { pull, push } from "./sync.js";
import { loadState, syncStreamId, type WorkspaceConfig } from "./config.js";

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

    await expect(remote.commit(0, secrets.deviceId, manifest, { blockedFingerprint: different })).resolves.toEqual({ sequence: 1 });
    expect(server.putBlobBytesCalls).toContain(fingerprint);
    expect(server.commitSignedCalls).toBe(1);
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

  test("RBOX_COMPRESS=1 round-trips mixed blobs and carries compressed descriptors forward", async () =>
    withCompressEnv("1", async () => {
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

      await fs.writeFile(path.join(rootA, "other.txt"), "new small file\n");
      await push(rootA, cfgA, { remote: remoteA });
      const secondManifest = (await loadState(rootA, syncStreamId(cfgA))).lastSyncedManifest;
      const secondText = secondManifest.files.find((f) => f.path === "data/notes.txt")!;
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
    }));

  test("RBOX_COMPRESS unset writes no compression fields into file manifests", async () =>
    withCompressEnv(undefined, async () => {
      const server = new FakeServer();
      const secrets = await bootstrapOnto(server, ACCT, "devA-raw-default", NOW);
      const root = await tmp();
      await fs.writeFile(path.join(root, "notes.txt"), "default raw path stays raw\n".repeat(10_000));

      const remote = await remoteFor(server, secrets);
      const cfg = await cfgFor(root, secrets, remote);
      await push(root, cfg, { remote });

      const manifest = (await loadState(root, syncStreamId(cfg))).lastSyncedManifest;
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
