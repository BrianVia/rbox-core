import fs from "node:fs/promises";
import path from "node:path";
import { hashBytes } from "../engine/hash.js";
import { bootstrapAccount, parseCommit, parseRefset, type DeviceSecrets, type SignedCommit } from "../engine/e2ee/index.js";
import type { BlobStore } from "../engine/index.js";
import { E2eeRemote, type AccountKeysDTO, type E2eeApi, type E2eeContext, type HeadPin, type PinStore, type WsKeyDTO } from "./e2ee-remote.js";
import { NeedsRebaselineError } from "./remote.js";
import { DEFAULT_BATCH_RECORD_BYTES } from "./remote/blob-batch/config.js";
import { BATCH_BLOB_CONTENT_TYPE, BATCH_FRAME_HEADER_BYTES, BATCH_STATUS_BIT } from "./remote/blob-batch/wire.js";
import type { WorkspaceConfig } from "./config.js";

/**
 * Shared E2EE test harness (NOT a `.test.ts`, so it's typechecked and importable by
 * multiple suites). A faithful ZERO-KNOWLEDGE server: stores ONLY opaque blobs +
 * signed commit envelopes + opaque key material, exactly like the real Worker — it
 * never sees a KEK or any plaintext. Used by the sync transport tests and the
 * version-history/restore tests so they share one honest-server implementation.
 */

const MAX_BATCH_RECORDS = 32;
const MAX_BATCH_BODY_BYTES = 8 * 1024 * 1024;
const UPLOAD_RECEIPTS_V1 = "upload-receipts-v1";

/** In-memory content-addressed blob store (stands in for R2). */
export class MemBlobStore implements BlobStore {
  blobs = new Map<string, Uint8Array>();
  getCalls: string[] = [];
  async has(sha: string) {
    return this.blobs.has(sha);
  }
  async put(sha: string, bytes: Uint8Array) {
    this.blobs.set(sha, new Uint8Array(bytes));
  }
  async get(sha: string): Promise<Buffer> {
    this.getCalls.push(sha);
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
  batchGetCalls = 0;
  batchPutCalls = 0;
  account: AccountKeysDTO = { recoveryWrap: null, recoveryWrapId: null, rosters: [], keyStates: [], devices: [] };
  wsKeys = new Map<string, WsKeyDTO>(); // `${wsId}:${epoch}` → winner
  /** Simulated retention prune floor: commit pointers ≤ this are "dropped", so a
   *  `commitsSince(since < floor)` fails closed exactly like the real DO (409). */
  pruneFloor = 0;
  beforeCommitSigned?: () => Promise<void> | void;

  missingBlobs = async (shas: string[]) => shas.filter((s) => !this.store.blobs.has(s));
  putBlobFile = async (sha: string, abs: string) => this.store.putFile(sha, abs);
  putBlobBytes = async (sha: string, bytes: Uint8Array) => this.store.put(sha, bytes);
  blobStore = () => this.store;

  async blobBatchGet(shas: string[]): Promise<Response> {
    this.batchGetCalls++;
    const frames = shas.map((sha) => {
      const bytes = this.store.blobs.get(sha);
      return bytes ? batchFrame(sha, bytes, false) : batchFrame(sha, new TextEncoder().encode('{"status":"missing"}'), true);
    });
    const total = frames.reduce((n, f) => n + f.byteLength, 0);
    const body = new Uint8Array(total);
    let off = 0;
    for (const frame of frames) {
      body.set(frame, off);
      off += frame.byteLength;
    }
    return new Response(body, { headers: { "content-type": BATCH_BLOB_CONTENT_TYPE } });
  }

  async blobBatchPut(body: Uint8Array, headers: Record<string, string> = {}): Promise<Response> {
    this.batchPutCalls++;
    if (new Headers(headers).get("x-rbox-protocol") !== UPLOAD_RECEIPTS_V1) {
      return jsonResponse(400, { error: "receipts_required" });
    }
    if (body.byteLength > MAX_BATCH_BODY_BYTES) {
      return jsonResponse(400, { error: "bad_request", message: "request body too large" });
    }
    const records = decodeBatchPutFrames(body);
    if (!records.ok) return jsonResponse(400, { error: "bad_request", message: records.message });
    // The real server deduplicates duplicate shas; the client coalesces before the fake sees them.
    const results = records.records.map(({ sha, payload }) => {
      if (payload.byteLength > DEFAULT_BATCH_RECORD_BYTES) return { sha256: sha, ok: false, error: "too_large" };
      if (hashBytes(payload) !== sha) return { sha256: sha, ok: false, error: "sha_mismatch" };
      this.store.blobs.set(sha, new Uint8Array(payload));
      return { sha256: sha, ok: true, sizeBytes: payload.byteLength, receipt: `fake-receipt:${sha}:${payload.byteLength}` };
    });
    return jsonResponse(200, { results });
  }

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
  commitSigned = async (parentSeq: number, commit: SignedCommit, beforeManifestPost?: () => Promise<void>) => {
    const body = parseCommit(commit);
    await beforeManifestPost?.();
    await this.beforeCommitSigned?.();
    const currentEpoch = this.account.keyStates.length - 1;
    if (body.accountEpoch !== currentEpoch) return { epochStale: currentEpoch };
    let refs: string[];
    if ("blobRefs" in body) {
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
    const enc = <Value>(value: Value) => new TextEncoder().encode(JSON.stringify(value));
    return [...this.store.blobs.values(), enc(this.commits), enc(this.account), enc([...this.wsKeys])];
  }
}

function batchFrame(sha: string, payload: Uint8Array, status: boolean): Uint8Array {
  const out = new Uint8Array(BATCH_FRAME_HEADER_BYTES + payload.byteLength);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(sha.slice(i * 2, i * 2 + 2), 16);
  new DataView(out.buffer).setUint32(32, status ? (BATCH_STATUS_BIT | payload.byteLength) >>> 0 : payload.byteLength, false);
  out.set(payload, BATCH_FRAME_HEADER_BYTES);
  return out;
}

function decodeBatchPutFrames(body: Uint8Array): { ok: true; records: Array<{ sha: string; payload: Uint8Array }> } | { ok: false; message: string } {
  const out: Array<{ sha: string; payload: Uint8Array }> = [];
  for (let off = 0; off < body.byteLength;) {
    if (body.byteLength - off < BATCH_FRAME_HEADER_BYTES) return { ok: false, message: "truncated frame header" };
    const head = body.subarray(off, off + BATCH_FRAME_HEADER_BYTES);
    off += BATCH_FRAME_HEADER_BYTES;
    const sha = [...head.subarray(0, 32)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const word = new DataView(head.buffer, head.byteOffset + 32, 4).getUint32(0, false);
    if ((word & BATCH_STATUS_BIT) !== 0) return { ok: false, message: "invalid frame length" };
    if (body.byteLength - off < word) return { ok: false, message: "truncated frame payload" };
    out.push({ sha, payload: body.subarray(off, off + word) });
    off += word;
    if (out.length > MAX_BATCH_RECORDS) return { ok: false, message: "too many records" };
  }
  return out.length ? { ok: true, records: out } : { ok: false, message: "empty batch" };
}

function jsonResponse<Body>(status: number, body: Body): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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
export function remoteFor(
  server: FakeServer,
  secrets: DeviceSecrets,
  accountId: string,
  workspaceId: string,
  now: number,
  ctxOverride: Partial<E2eeContext> = {},
): E2eeRemote {
  return new E2eeRemote(server, { accountId, workspaceId, secrets, now: () => now, ...ctxOverride }, memPin());
}

/** A `WorkspaceConfig` with the blob-encryption KEK loaded from the remote (frozen
 *  write epoch), matching what `buildAuthedRemote` produces in production. */
export async function cfgFor(root: string, secrets: DeviceSecrets, remote: E2eeRemote, workspaceId: string): Promise<WorkspaceConfig> {
  const writeContext = await remote.currentKek();
  return {
    schema: "e2ee/v1",
    remoteWorkspaceId: workspaceId,
    projectId: "root",
    deviceId: secrets.deviceId,
    rootPath: root,
    remoteUrl: "mem://",
    token: "t",
    encrypted: true,
    kek: Buffer.from(writeContext.kek),
    accountId: writeContext.accountId,
    accountEpoch: writeContext.accountEpoch,
    keyEpoch: writeContext.keyEpoch,
  };
}
