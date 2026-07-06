import fs from "node:fs/promises";
import path from "node:path";
import { bootstrapAccount, parseRefset, type DeviceSecrets, type SignedCommit } from "../engine/e2ee/index.js";
import type { BlobStore } from "../engine/index.js";
import { E2eeRemote, type AccountKeysDTO, type E2eeApi, type HeadPin, type PinStore, type WsKeyDTO } from "./e2ee-remote.js";
import { NeedsRebaselineError } from "./remote.js";
import type { WorkspaceConfig } from "./config.js";

/**
 * Shared E2EE test harness (NOT a `.test.ts`, so it's typechecked and importable by
 * multiple suites). A faithful ZERO-KNOWLEDGE server: stores ONLY opaque blobs +
 * signed commit envelopes + opaque key material, exactly like the real Worker — it
 * never sees a KEK or any plaintext. Used by the sync transport tests and the
 * version-history/restore tests so they share one honest-server implementation.
 */

/** In-memory content-addressed blob store (stands in for R2). */
export class MemBlobStore implements BlobStore {
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

export class FakeServer implements E2eeApi {
  store = new MemBlobStore();
  commits: SignedCommit[] = [];
  account: AccountKeysDTO = { recoveryWrap: null, recoveryWrapId: null, rosters: [], keyStates: [], devices: [] };
  wsKeys = new Map<string, WsKeyDTO>(); // `${wsId}:${epoch}` → winner
  /** Simulated retention prune floor: commit pointers ≤ this are "dropped", so a
   *  `commitsSince(since < floor)` fails closed exactly like the real DO (409). */
  pruneFloor = 0;

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

  commitTimes = async () => new Map<number, number>(); // no D1 mirror in tests — advisory only
  latestCommit = async () => (this.commits.length ? { sequence: this.commits.length, commit: this.commits[this.commits.length - 1]! } : { sequence: 0, commit: null });
  commitsSince = async (since: number) => {
    if (since < this.pruneFloor) throw new NeedsRebaselineError(this.commits.length); // pruned past retention
    return this.commits.slice(since);
  };
  commitSigned = async (parentSeq: number, commit: SignedCommit) => {
    const body = JSON.parse(commit.body) as {
      encManifestSha: string;
      blobRefs?: { encSha: string }[];
      blobRefset?: { sidecarSha: string; count: number; totalBytes: number };
    };
    let refs: string[];
    if (body.blobRefs) {
      refs = [body.encManifestSha, ...body.blobRefs.map((r) => r.encSha)];
    } else {
      const sidecar = body.blobRefset;
      if (!sidecar || !this.store.blobs.has(sidecar.sidecarSha)) return { unsatisfiedBlobs: [sidecar?.sidecarSha ?? body.encManifestSha] };
      refs = [body.encManifestSha, sidecar.sidecarSha, ...parseRefset(await this.store.get(sidecar.sidecarSha)).map((r) => r.encSha)];
    }
    for (const ref of refs) {
      if (!this.store.blobs.has(ref)) return { unsatisfiedBlobs: [ref] };
    }
    if (parentSeq !== this.commits.length) return { conflict: true, head: this.commits.length };
    this.commits.push(commit);
    return { sequence: this.commits.length };
  };

  /** Every byte an operator could inspect (for the zero-knowledge assertion). */
  allBytes(): Uint8Array[] {
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
    return [...this.store.blobs.values(), enc(this.commits), enc(this.account), enc([...this.wsKeys])];
  }
}

/** An in-memory `PinStore` (stands in for the keystore-backed pin). */
export function memPin(): PinStore {
  let pin: HeadPin | undefined;
  return { load: async () => pin, save: async (p) => void (pin = p) };
}

/** Bootstrap a brand-new account (genesis roster + key-state + device wrap) onto a
 *  FakeServer and return device A's secrets — the starting point for every test. */
export async function bootstrapOnto(server: FakeServer, accountId: string, deviceId: string, now: number): Promise<DeviceSecrets> {
  const boot = await bootstrapAccount(accountId, deviceId, now);
  server.account.recoveryWrap = JSON.stringify(boot.upload.recoveryWrap);
  server.account.recoveryWrapId = boot.upload.recoveryWrapId;
  server.account.rosters.push(JSON.stringify(boot.upload.genesisRoster));
  server.account.keyStates.push(JSON.stringify(boot.upload.genesisKeyState));
  server.account.devices.push({ deviceId, sigPubkey: boot.upload.device.sigPubKey, encPubkey: boot.upload.device.encPubKey, mkWrap: JSON.stringify(boot.upload.device.mkWrap) });
  return boot.secrets;
}

/** Construct an `E2eeRemote` bound to a FakeServer for a device's secrets. */
export function remoteFor(server: FakeServer, secrets: DeviceSecrets, accountId: string, workspaceId: string, now: number): E2eeRemote {
  return new E2eeRemote(server, { accountId, workspaceId, secrets, now: () => now }, memPin());
}

/** A `WorkspaceConfig` with the blob-encryption KEK loaded from the remote (frozen
 *  write epoch), matching what `buildAuthedRemote` produces in production. */
export async function cfgFor(root: string, secrets: DeviceSecrets, remote: E2eeRemote, workspaceId: string): Promise<WorkspaceConfig> {
  const kek = await remote.currentKek();
  return { schema: "e2ee/v1", remoteWorkspaceId: workspaceId, projectId: "root", deviceId: secrets.deviceId, rootPath: root, remoteUrl: "mem://", token: "t", encrypted: true, kek: Buffer.from(kek) };
}
