import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bootstrapAccount, buildPairing, redeemPairing, toB64url, type DeviceSecrets, type SignedCommit } from "../engine/e2ee/index.js";
import type { BlobStore } from "../engine/index.js";
import { E2eeRemote, type AccountKeysDTO, type E2eeApi, type HeadPin, type PinStore, type WsKeyDTO } from "./e2ee-remote.js";
import { pull, push } from "./sync.js";
import type { WorkspaceConfig } from "./config.js";

/** In-memory content-addressed blob store (stands in for R2). */
class MemBlobStore implements BlobStore {
  blobs = new Map<string, Uint8Array>();
  async has(sha: string) {
    return this.blobs.has(sha);
  }
  async put(sha: string, bytes: Uint8Array) {
    this.blobs.set(sha, new Uint8Array(bytes));
  }
  async get(sha: string): Promise<Buffer> {
    const b = this.blobs.get(sha);
    if (!b) throw new Error(`blob ${sha} missing`);
    return Buffer.from(b);
  }
  async getToFile(sha: string, dest: string) {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, await this.get(sha));
  }
  async putFile(sha: string, src: string) {
    this.blobs.set(sha, new Uint8Array(await fs.readFile(src)));
  }
}

/** A faithful zero-knowledge server: stores ONLY opaque blobs + signed commit
 *  envelopes + opaque key material. Never sees a KEK or plaintext. */
class FakeServer implements E2eeApi {
  store = new MemBlobStore();
  commits: SignedCommit[] = [];
  account: AccountKeysDTO = { recoveryWrap: null, recoveryWrapId: null, rosters: [], keyStates: [], devices: [] };
  wsKeys = new Map<string, WsKeyDTO>(); // `${wsId}:${epoch}` → winner

  missingBlobs = async (shas: string[]) => shas.filter((s) => !this.store.blobs.has(s));
  putBlobFile = async (sha: string, abs: string) => this.store.putFile(sha, abs);
  putBlobBytes = async (sha: string, bytes: Uint8Array) => this.store.put(sha, bytes);
  blobStore = () => this.store;

  getAccountKeys = async () => (this.account.rosters.length ? this.account : null);
  getWorkspaceKeys = async (wsId: string) => [...this.wsKeys.entries()].filter(([k]) => k.startsWith(`${wsId}:`)).map(([, v]) => v);
  putWorkspaceKey = async (wsId: string, keyEpoch: number, kekWrap: string) => {
    const k = `${wsId}:${keyEpoch}`;
    if (!this.wsKeys.has(k)) this.wsKeys.set(k, { keyEpoch, kekWrap }); // immutable CAS — first writer wins
    return this.wsKeys.get(k)!;
  };

  latestCommit = async () => (this.commits.length ? { sequence: this.commits.length, commit: this.commits[this.commits.length - 1]! } : { sequence: 0, commit: null });
  commitsSince = async (since: number) => this.commits.slice(since);
  commitSigned = async (parentSeq: number, commit: SignedCommit) => {
    const body = JSON.parse(commit.body) as { encManifestSha: string; blobRefs: { encSha: string }[] };
    for (const ref of [body.encManifestSha, ...body.blobRefs.map((r) => r.encSha)]) {
      if (!this.store.blobs.has(ref)) return { unsatisfiedBlobs: [ref] };
    }
    if (parentSeq !== this.commits.length) return { conflict: true, head: this.commits.length };
    this.commits.push(commit);
    return { sequence: this.commits.length };
  };

  /** Every byte an operator could inspect. */
  allBytes(): Uint8Array[] {
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
    return [...this.store.blobs.values(), enc(this.commits), enc(this.account), enc([...this.wsKeys])];
  }
}

function memPin(): PinStore {
  let pin: HeadPin | undefined;
  return { load: async () => pin, save: async (p) => void (pin = p) };
}

const NOW = 1_900_000_000_000;
const ACCT = "acct_sync";
const WS = "ws_sync";

async function remoteFor(server: FakeServer, secrets: DeviceSecrets): Promise<E2eeRemote> {
  return new E2eeRemote(server, { accountId: ACCT, workspaceId: WS, deviceId: secrets.deviceId, secrets, now: () => NOW + 5000 }, memPin());
}

async function cfgFor(root: string, secrets: DeviceSecrets, remote: E2eeRemote): Promise<WorkspaceConfig> {
  const kek = await remote.currentKek();
  return { remoteWorkspaceId: WS, projectId: "root", deviceId: secrets.deviceId, rootPath: root, remoteUrl: "mem://", token: "t", encrypted: true, kek: Buffer.from(kek) };
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

describe("E2EE sync transport — two machines through real sync.ts", () => {
  test("A pushes an encrypted tree; B pairs in and pulls it byte-identically; server sees no plaintext", async () => {
    const server = new FakeServer();

    // --- Machine A: bootstrap account + workspace keys ---
    const bootA = await bootstrapAccount(ACCT, "devA", NOW);
    server.account.recoveryWrap = JSON.stringify(bootA.upload.recoveryWrap);
    server.account.recoveryWrapId = bootA.upload.recoveryWrapId;
    server.account.rosters.push(JSON.stringify(bootA.upload.genesisRoster));
    server.account.keyStates.push(JSON.stringify(bootA.upload.genesisKeyState));
    server.account.devices.push({ deviceId: "devA", sigPubkey: bootA.upload.device.sigPubKey, encPubkey: bootA.upload.device.encPubKey, mkWrap: JSON.stringify(bootA.upload.device.mkWrap) });

    const rootA = await tmp();
    await fs.mkdir(path.join(rootA, "src"), { recursive: true });
    await fs.writeFile(path.join(rootA, "src", "secret-name.ts"), "export const TOKEN = 'super-secret-do-not-leak';\n");
    await fs.writeFile(path.join(rootA, "README.md"), "# my private project\n");

    const remoteA = await remoteFor(server, bootA.secrets);
    const cfgA = await cfgFor(rootA, bootA.secrets, remoteA);
    const seq = await push(rootA, cfgA, { remote: remoteA });
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
    const tokenSecret = bootA.secrets.mk.slice(0, 32).map((b, i) => b ^ (i + 1)); // any 32 bytes; A would gen random
    const material = await buildPairing(bootA.secrets, { accountEpoch: 0, tokenId: "tok1", tokenSecret, notAfter: NOW + 600_000 });
    const redeem = await redeemPairing({ accountId: ACCT, deviceId: "devB", tokenSecret, accountEpoch: 0, material, prevRoster: bootA.upload.genesisRoster, now: NOW + 1000 });
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

  test("round-trips edits both directions and converges", async () => {
    const server = new FakeServer();
    const boot = await bootstrapAccount(ACCT, "devA", NOW);
    server.account.recoveryWrap = JSON.stringify(boot.upload.recoveryWrap);
    server.account.recoveryWrapId = boot.upload.recoveryWrapId;
    server.account.rosters.push(JSON.stringify(boot.upload.genesisRoster));
    server.account.keyStates.push(JSON.stringify(boot.upload.genesisKeyState));
    server.account.devices.push({ deviceId: "devA", sigPubkey: boot.upload.device.sigPubKey, encPubkey: boot.upload.device.encPubKey, mkWrap: JSON.stringify(boot.upload.device.mkWrap) });

    const root = await tmp();
    await fs.writeFile(path.join(root, "a.txt"), "one\n");
    const remote = await remoteFor(server, boot.secrets);
    const cfg = await cfgFor(root, boot.secrets, remote);
    await push(root, cfg, { remote });

    // second commit (edit) advances the chain; pull on a fresh clone replays both
    await fs.writeFile(path.join(root, "a.txt"), "two\n");
    await fs.writeFile(path.join(root, "b.txt"), "new\n");
    const s2 = await push(root, cfg, { remote });
    expect(s2).toBe(2);

    const root2 = await tmp();
    const remote2 = await remoteFor(server, boot.secrets);
    const cfg2 = await cfgFor(root2, boot.secrets, remote2);
    await pull(root2, cfg2, { remote: remote2 });
    expect(await fs.readFile(path.join(root2, "a.txt"), "utf8")).toBe("two\n");
    expect(await fs.readFile(path.join(root2, "b.txt"), "utf8")).toBe("new\n");
  });
});
